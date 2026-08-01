const { getTranscriptionProvider, REGISTRY: TRANSCRIPTION_REGISTRY } = require("../providers/transcription");
const { getDiarizationProvider, isKnownDiarizationMode } = require("../providers/diarization");
const { mergeDiarization } = require("../utils/mergeDiarization");
const { filterHallucinations } = require("../utils/filterHallucinations");
const { detectAudioMagic } = require("../utils/audioMagicBytes");
const auditLog = require("../utils/auditLog");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { createLogger } = require("../utils/logger");
const { recordRejectedUpload, REASONS } = require("../utils/uploadEvents");
const log = createLogger("transcription");

const ALLOW_PROVIDER_OVERRIDE = process.env.ALLOW_PROVIDER_OVERRIDE === "true";

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Vienintelė vieta su realia "audio -> transkripcija (+ diarizacija)" logika.
 * Naudojama IR sinchroniniame routes/transcribe.js, IR asinchroniniame
 * routes/transcribeJobs.js - kad abu keliai elgtųsi identiškai.
 *
 * SVARBU (rasta praktiškai, ne teoriškai): kai backend'as diegiamas UŽ HTTP proxy,
 * kuris pats riboja užklausos trukmę (pvz. RunPod HTTP proxy turi KIETĄ 100s limitą,
 * nepriklausomą nuo šio serverio nustatymų), sinchroninis kelias (routes/transcribe.js)
 * NEVEIKS ilgesniems nei ~100s transkribavimams, NEPRIKLAUSOMAI nuo
 * FASTER_WHISPER_EMBEDDED_TIMEOUT_MS. Tokiu atveju BŪTINA naudoti asinchroninį
 * kelią (routes/transcribeJobs.js) arba TCP prievado eksponavimą vietoj HTTP proxy.
 *
 * @throws {HttpError} su statusCode (400/403/500) ir žmogui skaitomu pranešimu.
 */
async function transcribeAudio({
  buffer,
  filename,
  mimeType,
  language,
  diarize,
  audioUrl,
  numSpeakers,
  transcriptionProviderOverride,
  diarizationModeOverride,
  meetingId,
  jobId,
  onProgress,
}) {
  const start = Date.now();

  if ((transcriptionProviderOverride || diarizationModeOverride) && !ALLOW_PROVIDER_OVERRIDE) {
    throw new HttpError(
      403,
      "Tiekėjo keitimas per užklausą išjungtas (ALLOW_PROVIDER_OVERRIDE=false). Tiekėjai nustatomi tik per serverio TRANSCRIPTION_PROVIDER / DIARIZATION_PROVIDER."
    );
  }
  if (transcriptionProviderOverride && !(transcriptionProviderOverride in TRANSCRIPTION_REGISTRY)) {
    throw new HttpError(
      400,
      `Nežinomas transkribavimo provideris "${transcriptionProviderOverride}". Galimi: ${Object.keys(TRANSCRIPTION_REGISTRY).join(", ")}`
    );
  }
  if (diarizationModeOverride && !isKnownDiarizationMode(diarizationModeOverride)) {
    throw new HttpError(400, `Nežinomas diarizationProvider "${diarizationModeOverride}".`);
  }

  const diarizationMode = (
    ALLOW_PROVIDER_OVERRIDE && diarizationModeOverride ? diarizationModeOverride : process.env.DIARIZATION_PROVIDER || "none"
  ).toLowerCase();

  let transcriptionProvider;
  try {
    transcriptionProvider = getTranscriptionProvider(ALLOW_PROVIDER_OVERRIDE ? transcriptionProviderOverride : undefined);
  } catch (e) {
    const safeMessage = sanitizeServerError(e, "transcribeAudio - provider init");
    throw new HttpError(500, safeMessage);
  }

  if (!detectAudioMagic(buffer)) {
    recordRejectedUpload(REASONS.SIGNATURE, { route: "/api/transcribe", size: buffer.length, jobId });
    auditLog.record({
      jobId,
      meetingId,
      transcriptionProvider: null,
      processingTimeMs: Date.now() - start,
      success: false,
      error: "Failo turinys neatitinka jokio žinomo audio formato signature (magic bytes).",
    });
    throw new HttpError(400, "Failo turinys neatitinka jokio žinomo audio formato (patikrinta pagal failo signature, ne tik pavadinimą).");
  }

  try {
    const requestNativeDiarization = diarize && diarizationMode === "inline";
    /**
     * GRANDINĖS ĮVYKIS transkripcijos kelyje (GDPR #17).
     *
     * DoD reikalauja koreliacijos request → queue → worker → provider →
     * completion, ir tai galioja ABIEM darbo tipams. Anksčiau `provider` etapas
     * buvo tik protokolo (LLM) kelyje, tad transkripcijos grandinėje liko skylė
     * būtent ten, kur laikas praleidžiamas ilgiausiai.
     */
    log.info("Tiekėjo kvietimas", {
      stage: "provider",
      providerType: "transcription",
      provider: transcriptionProvider.name || null,
      model: transcriptionProvider.model || null,
      jobId,
    });

    const transcription = await transcriptionProvider.transcribe(buffer, {
      filename,
      mimeType,
      language: language || "lt",
      diarize: requestNativeDiarization,
      audioUrl,
      onProgress,
    });

    let diarizationProviderUsed = requestNativeDiarization ? `${transcriptionProvider.name} (inline)` : null;
    if (diarize && diarizationMode !== "none" && diarizationMode !== "inline") {
      const diarizationProvider = getDiarizationProvider(diarizationMode);

      log.info("Tiekėjo kvietimas", {
        stage: "provider",
        providerType: "diarization",
        provider: diarizationProvider.name || null,
        jobId,
      });

      const diarizationResult = await diarizationProvider.diarize(buffer, {
        filename,
        mimeType,
        language: language || "lt",
        audioUrl,
        numSpeakers,
      });
      transcription.segments = mergeDiarization(transcription.segments, diarizationResult.turns);
      transcription.diarization = true;
      diarizationProviderUsed = diarizationProvider.name;
    }

    // Halucinacijų filtras (žr. utils/filterHallucinations.js). Šalina Whisper
    // "prasimanytus" YouTube-titrų segmentus tyloje. Konservatyvus: su diarizacija
    // liečia tik segmentus be kalbėtojo. Išjungiama per FILTER_HALLUCINATIONS=false.
    if (Array.isArray(transcription.segments)) {
      const before = transcription.segments.length;
      const filtered = filterHallucinations(transcription.segments, {
        diarized: !!transcription.diarization,
      });
      transcription.segments = filtered.segments;
      if (filtered.removed > 0) {
        transcription.text = filtered.text;
        transcription.hallucinationsRemoved = filtered.removed;
        log.info(`Halucinacijų filtras: pašalinta ${filtered.removed}/${before} segmentų.`);
      }
    }

    auditLog.record({
      jobId,
      meetingId,
      transcriptionProvider: transcriptionProvider.name,
      diarizationProvider: diarizationProviderUsed,
      processingTimeMs: Date.now() - start,
      success: true,
    });

    return { ...transcription, diarizationProvider: diarizationProviderUsed };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    auditLog.record({
      jobId,
      meetingId,
      transcriptionProvider: transcriptionProvider.name,
      processingTimeMs: Date.now() - start,
      success: false,
      error: e.message,
    });
    const safeMessage = sanitizeServerError(e, "transcribeAudio");
    throw new HttpError(500, safeMessage);
  }
}

module.exports = { transcribeAudio, HttpError };
