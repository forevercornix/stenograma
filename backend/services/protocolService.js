const { getLLMProvider, REGISTRY } = require("../providers/llm");
const { buildPrompt, PROMPTS } = require("../prompts");
const { tryParse, buildRepairPrompt } = require("../schema/protocolSchema");
const auditLog = require("../utils/auditLog");
const { estimateCost } = require("../utils/costEstimate");
const { groundingCheck } = require("../utils/groundingCheck");
const { dedupTranscriptText, dedupSegments } = require("../utils/transcriptDedup");
const { createLogger } = require("../utils/logger");
const log = createLogger("protocol");

const ALLOW_PROVIDER_OVERRIDE = process.env.ALLOW_PROVIDER_OVERRIDE === "true";

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Vienintelė vieta su realia "transkripcija -> protokolas" logika (LLM kvietimas,
 * JSON validacija + repair, audit log). Naudojama IR sinchroniniame
 * routes/generate.js, IR asinchroniniame routes/jobs.js - kad abu keliai
 * elgtųsi identiškai ir nereikėtų palaikyti dviejų kopijų.
 *
 * Meta ("Ateityje reikia job queue" - dabar jau yra, žr. routes/jobs.js):
 * ilgiems susitikimams (>~30s LLM apdorojimo) rekomenduojama naudoti
 * POST /api/jobs + GET /api/jobs/:id vietoj sinchroninio POST /api/generate,
 * kad klientas negaišuotų HTTP ryšio atsakymo laukdamas.
 *
 * @throws {HttpError} su statusCode (400/403/500/502) ir žmogui skaitomu pranešimu.
 */
async function generateProtocol({ title, date, participants, transcript, segments, meetingId, jobId, llmProviderOverride, promptVersionOverride }) {
  const start = Date.now();

  if (!transcript || transcript.trim().length < 10) {
    throw new HttpError(400, "Transkripcija per trumpa arba tuščia.");
  }

  if ((llmProviderOverride || promptVersionOverride) && !ALLOW_PROVIDER_OVERRIDE) {
    throw new HttpError(
      403,
      "Tiekėjo/prompt versijos keitimas per užklausą išjungtas (ALLOW_PROVIDER_OVERRIDE=false). Nustatoma tik per serverio LLM_PROVIDER/PROMPT_VERSION."
    );
  }
  // `in` tikrina IR prototipą, tad "constructor" praeidavo whitelist'ą.
  if (llmProviderOverride && !Object.prototype.hasOwnProperty.call(REGISTRY, llmProviderOverride)) {
    throw new HttpError(400, `Nežinomas LLM tiekėjas "${llmProviderOverride}". Galimi: ${Object.keys(REGISTRY).join(", ")}`);
  }
  if (promptVersionOverride && !(promptVersionOverride in PROMPTS)) {
    throw new HttpError(400, `Nežinoma prompt versija "${promptVersionOverride}". Galimos: ${Object.keys(PROMPTS).join(", ")}`);
  }

  let llm;
  try {
    llm = getLLMProvider(ALLOW_PROVIDER_OVERRIDE ? llmProviderOverride : undefined);
  } catch (e) {
    throw new HttpError(500, e.message);
  }

  // DEDUPLIKACIJA (rasta su realiu 4 val. įrašu - žr. utils/transcriptDedup.js):
  // Whisper haliucinacinės kilpos (ta pati frazė šimtus kartų iš eilės) išpučia
  // promptą ir kainą. Įjungta pagal nutylėjimą; TRANSCRIPT_DEDUP=false išjungia.
  let effectiveTranscript = transcript;
  let effectiveSegments = segments;
  let dedupInfo = null;
  if ((process.env.TRANSCRIPT_DEDUP || "true").toLowerCase() !== "false") {
    const textResult = dedupTranscriptText(transcript);
    effectiveTranscript = textResult.text;
    if (Array.isArray(segments) && segments.length > 0) {
      const segResult = dedupSegments(segments);
      effectiveSegments = segResult.segments;
    }
    if (textResult.collapsedRuns > 0) {
      dedupInfo = { collapsedRuns: textResult.collapsedRuns, removedItems: textResult.removedItems };
      log.info(
        `Transkripcijos dedup: sutraukta ${textResult.collapsedRuns} pasikartojimų serijų ` +
          `(${textResult.removedItems} fragmentų, ${textResult.originalLength} -> ${textResult.dedupedLength} simbolių). ` +
          `Išjungti: TRANSCRIPT_DEDUP=false.`
      );
    }
  }

  const { prompt, promptVersion } = buildPrompt(
    { title, date, participants, transcript: effectiveTranscript, segments: effectiveSegments },
    promptVersionOverride
  );

  let repairAttempts = 0;
  let lastRaw = "";
  let usage = null;

  try {
    const first = await llm.generateProtocol(prompt, { redactionPurpose: "source_transcript" });
    lastRaw = first.rawText;
    usage = first.usage;

    // NUKIRPIMO APTIKIMAS (rasta realiai - 4 val. protokolas žlugdavo su kriptiniu
    // "Nepavyko gauti validaus protokolo"): jei LLM atsakymas nutrūko pasiekus
    // max_tokens limitą, repair retry BEPRASMIS (nutrūktų lygiai taip pat) -
    // vietoj to iškart grąžiname aiškią, veiksmingą klaidą.
    if (first.truncated) {
      throw new HttpError(
        502,
        `LLM atsakymas NUKIRPTAS pasiekus max_tokens limitą (${first.maxTokensUsed}). ` +
          `Ilgo susitikimo protokolui padidinkite limitą per env (pvz. ANTHROPIC_MAX_TOKENS=16000) ir bandykite dar kartą.`
      );
    }

    let result = tryParse(lastRaw);

    if (!result.success) {
      repairAttempts = 1;
      const repairPrompt = buildRepairPrompt(lastRaw, result.errors);
      const repaired = await llm.generateProtocol(repairPrompt, { redactionPurpose: "repair_prompt" });
      lastRaw = repaired.rawText;
      if (repaired.usage) {
        usage = {
          inputTokens: (usage?.inputTokens || 0) + repaired.usage.inputTokens,
          outputTokens: (usage?.outputTokens || 0) + repaired.usage.outputTokens,
        };
      }
      if (repaired.truncated) {
        throw new HttpError(
          502,
          `LLM atsakymas NUKIRPTAS pasiekus max_tokens limitą (${repaired.maxTokensUsed}) net repair bandyme. ` +
            `Padidinkite limitą per env (pvz. ANTHROPIC_MAX_TOKENS=16000).`
        );
      }
      result = tryParse(lastRaw);
    }

    if (!result.success) {
      auditLog.record({
        jobId,
        meetingId,
        promptVersion,
        llmProvider: llm.name,
        processingTimeMs: Date.now() - start,
        usage,
        jsonRepairAttempts: repairAttempts,
        success: false,
        error: "JSON validacija nepavyko net po repair bandymo: " + result.errors.join("; "),
      });
      throw new HttpError(502, "Nepavyko gauti validaus protokolo iš LLM po pakartotinio bandymo.", result.errors);
    }

    const effectiveOverride = ALLOW_PROVIDER_OVERRIDE ? llmProviderOverride : null;
    const providerKey = (effectiveOverride || process.env.LLM_PROVIDER || "mock").toLowerCase();
    const costUsd = estimateCost(providerKey, usage);

    // Papildomas, nuo LLM nepriklausomas patikrinimas: ar "veiksmai" realiai
    // paremti transkripcijos tekstu (žr. utils/groundingCheck.js - sąžiningai
    // dokumentuoti apribojimai ten pačiame faile - tai LEKSINIS grounding check,
    // ne pilnas semantinis fact-checking).
    const checkedProtocol = groundingCheck(result.data, transcript);
    const unverifiedCount = (checkedProtocol.veiksmai || []).filter((v) => v._grounding && !v._grounding.verified).length;

    const redactionAuditMeta = llm.sourceRedactionAudit || llm.lastRedactionAudit || null;

    if (redactionAuditMeta) {
      // Application log ir auditas - skirtingi kanalai skirtingiems skaitytojams.
      // Nesėkmė jau logguojama; be sėkmės įrašo operatorius negali patvirtinti,
      // kad apsauga apskritai veikia (tyla atrodytų identiškai kaip išjungta
      // redakcija). Rašom TIK politikos versiją ir baigtį - jokio turinio.
      const categories = Object.keys(redactionAuditMeta.redactionStats || {}).length;
      log.info(
        `Redakcija atlikta: policy=${redactionAuditMeta.policyVersion}, ` +
          `outcome=sent, categories=${categories}`
      );
    }

    auditLog.record({
      jobId,
      meetingId,
      promptVersion,
      llmProvider: providerKey,
      llmModel: llm.model || null,
      processingTimeMs: Date.now() - start,
      usage,
      estimatedCostUsd: costUsd,
      jsonRepairAttempts: repairAttempts,
      success: true,
      // REDAKCIJOS BŪSENA AUDITE (GDPR #4). Įrašomas artefakto metaduomuo -
      // variantas, politikos versija ir kategorijų SKAIČIAI. Aptiktų reikšmių
      // čia nėra ir negali būti: `stats` konstruojamas tik iš skaitliukų
      // (žr. utils/piiRedaction.js), tad auditas lieka saugus skaityti.
      ...(redactionAuditMeta ? { redaction: redactionAuditMeta } : {}),
    });

    // Tie patys metaduomenys keliauja ir į API atsakymą - klientas turi žinoti,
    // ar prieš jį originalo, ar redaguoto turinio pagrindu sudarytas protokolas.
    /**
     * ŠALTINIO transkripcijos metaduomenys, ne paskutinio kvietimo.
     *
     * Repair retry siunčia antrą payload'ą tam pačiam provideriui; jei imtume
     * `lastRedactionAudit`, gautume repair prompto statistiką ir jo artefakto ID.
     */
    const redactionMeta = llm.sourceRedactionAudit || llm.lastRedactionAudit || null;

    return {
      protocol: checkedProtocol,
      meta: {
        promptVersion,
        llmProvider: providerKey,
        jsonRepairAttempts: repairAttempts,
        usage,
        estimatedCostUsd: costUsd,
        processingTimeMs: Date.now() - start,
        grounding: { unverifiedActionsCount: unverifiedCount, totalActionsCount: (checkedProtocol.veiksmai || []).length },
      },
      ...(redactionMeta ? { redaction: redactionMeta } : {}),
    };
  } catch (e) {
    /**
     * REDAKCIJOS BAIGTIS IR NESĖKMĖS ATVEJU (GDPR #4: „logs record redaction
     * status and outcome").
     *
     * Iki šiol redakcijos kritimas audite atrodė kaip bendra generavimo klaida -
     * neįmanoma buvo atskirti „modelis neatsakė" nuo „duomenys sąmoningai
     * neišsiųsti". Auditui tai skirtingi įvykiai: antrasis yra apsaugos
     * suveikimas, ir jį reikia matyti.
     *
     * `error` čia eina pro auditLog sanitizaciją, o pati RedactionError savo
     * pranešime originalaus teksto neturi (žr. RedactingLLMProvider).
     */
    const isRedactionFailure = e && (e.code === "REDACTION_FAILED" || e.code === "ARTEFACT_VARIANT_MISMATCH");

    if (isRedactionFailure) {
      // Application log atskirai nuo audito: jie skirti skirtingiems skaitytojams.
      log.warn(
        `Redakcija NEPAVYKO (${e.code}) - išorinis tiekėjas nekviestas, duomenys neišsiųsti.`
      );
    }

    if (e instanceof HttpError && !isRedactionFailure) throw e;

    auditLog.record({
      jobId,
      meetingId,
      promptVersion,
      llmProvider: llm.name,
      processingTimeMs: Date.now() - start,
      success: false,
      error: e.message,
      ...(isRedactionFailure
        ? {
            redaction: {
              variant: null,
              redactionStatus: "failed",
              policyVersion: (llm.lastRedactionAudit && llm.lastRedactionAudit.policyVersion) || null,
              outcome: require("../utils/redactedArtefact").OUTCOME.BLOCKED,
            },
          }
        : {}),
    });

    if (e instanceof HttpError) throw e;
    throw new HttpError(500, e.message);
  }
}

module.exports = { generateProtocol, HttpError };
