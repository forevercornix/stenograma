/**
 * REDAKCIJOS VYKDYMAS PRIEŠ IŠORINĮ TIEKĖJĄ (GDPR #5).
 *
 * Kodėl dekoratorius, o ne pagalbinė funkcija protocolService viduje:
 *
 * 1. NEAPEINAMUMAS. Įjungiamas `providers/llm/index.js` fabrikoje, pro kurią
 *    praeina VISI keliai (inline `routes/generate.js` ir BullMQ
 *    `queues/processors.js` - abu per `services/protocolService`). Naujas
 *    kvietimo kelias gauna redakciją automatiškai; apeiti galima tik sąmoningai
 *    keičiant fabriką, o ne pamiršus vieną kvietimą.
 *
 * 2. REPAIR RETRY. `protocolService` siunčia ANTRĄ payload'ą, kai LLM grąžina
 *    netinkamą JSON (repair prompt su ta pačia transkripcija). Redakcija prompt'o
 *    sudarymo metu šį antrą kvietimą praleistų; dekoratorius dengia abu, nes
 *    sėdi ties pačiu tinklo kvietimu.
 *
 * Redaguojamas visas payload'as, o ne vien transkripcijos laukas: garantija turi
 * būti "provideris negavo NIEKO neredaguoto", ne "neredaguota buvo tik ta dalis,
 * apie kurią pagalvojom".
 *
 * FAIL-CLOSED: bet kokia redakcijos klaida ar netinkamas rezultatas reiškia, kad
 * tiekėjas NEKVIEČIAMAS. Tyliai persiųsti originalą būtų blogiausias variantas -
 * konfigūracija žadėtų apsaugą, o duomenys iškeliautų.
 */

/** Tik kodo pavidalo identifikatorius: raidės, skaitmenys, `_`, `.`, `-`, iki 40 simbolių. */
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

function _asSafeCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

class RedactionError extends Error {
  /**
   * SĄMONINGAI NESAUGOM `cause` objekto ir jo `message`.
   *
   * Redakcijos komponentas (#4) dirba su payload'u, kuriame YRA asmens duomenų.
   * Jei jis kada nors įtrauktų jų fragmentą į klaidos tekstą, `this.cause = e`
   * nuneštų tuos duomenis į logus, auditą ir galimai į HTTP atsakymą - t. y.
   * redakcijos klaida taptų PII nutekėjimu.
   *
   * Bet ir `cause.code` nėra savaime saugus: niekas netrukdo būsimam komponentui
   * įrašyti į jį laisvą tekstą. Todėl reikšmės ne tik imamos, bet ir
   * NORMALIZUOJAMOS - praleidžiamas tik trumpas kodo pavidalo identifikatorius.
   * Viskas, kas į jį nepanašu, virsta `null`, nes diagnostinė nauda iš tokios
   * reikšmės mažesnė nei rizika.
   */
  constructor(message, cause) {
    super(message);
    this.name = "RedactionError";
    this.code = "REDACTION_FAILED";
    this.causeCode = _asSafeCode(cause && cause.code);
    this.causeName = _asSafeCode(cause && cause.name);
  }
}

/**
 * Artefaktų modulis - PRIVALOMA priklausomybė, importuojama įprastai.
 *
 * Pirmoji versija krovė jį per try/catch su `return null` fallback'u. Tai buvo
 * FAIL-OPEN spraga: sugadintas `redactedArtefact.js` (SyntaxError, pervadinimas,
 * sulūžęs eksportas) tyliai grąžindavo kodą į seną kelią - tiekėjas vis tiek
 * būdavo kviečiamas, tik be `assertRedacted()`, be varianto patikros ir be
 * audito. Garantija „guard'ai tikrina faktą" tada galiotų tik tol, kol niekas
 * nesulūžta.
 *
 * Įprastas `require` reiškia, kad modulio gedimas nuverčia patį dekoratorių, o
 * fabrika (providers/llm/index.js) tokį atvejį paverčia į RedactionError -
 * tiekėjas nekviečiamas.
 */
const artefacts = require("../../utils/redactedArtefact");

class RedactingLLMProvider {
  /**
   * @param {object} inner - tikras tiekėjas (ClaudeProvider, GPTProvider, ...)
   * @param {(text: string) => string|Promise<string>} redact - #4 komponento funkcija
   */
  constructor(inner, redact, redactionModule = null) {
    if (!inner || typeof inner.generateProtocol !== "function") {
      throw new Error("RedactingLLMProvider: netinkamas vidinis tiekėjas.");
    }
    if (typeof redact !== "function") {
      throw new Error("RedactingLLMProvider: `redact` privalo būti funkcija.");
    }
    this.inner = inner;
    this._redact = redact;
    // Minimalus kontraktas garantuoja tik `redact`; jei komponentas turi daugiau
    // (statistika, segmentai), artefaktas tuo pasinaudos.
    this._redactionModule = redactionModule || { redact };

    /**
     * VISI redakcijos įvykiai, ne tik paskutinis.
     *
     * `protocolService` tam pačiam objektui gali kviesti DU kartus: pradinis
     * promptas ir repair promptas (kai LLM grąžina netinkamą JSON). Vienas
     * `lastRedactionAudit` laukas antrą kartą perrašydavo pirmąjį, tad API ir
     * auditas gaudavo REPAIR prompto metaduomenis vietoj šaltinio transkripcijos:
     * `redactionStats: {}` net tada, kai originale asmens kodas buvo rastas ir
     * pašalintas. Metaduomenys tada melavo apie tai, kas realiai buvo redaguota.
     */
    this.redactionAudits = [];
    this.redactionEnforced = true;
  }

  // Proxy: protocolService naudoja šiuos laukus audito įrašui.
  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  /**
   * @param {string} payload
   * @param {{redactionPurpose?: string}} [options] - kam skirtas šis kvietimas
   *   (`source_transcript` arba `repair_prompt`). Naudojama tik metaduomenims;
   *   redakcija taikoma vienodai.
   */
  async generateProtocol(payload, options = {}) {
    const redacted = await this._applyRedaction(payload, options.redactionPurpose || "source_transcript");
    return this.inner.generateProtocol(redacted);
  }

  /** Pirmojo (šaltinio transkripcijos) kvietimo metaduomenys. */
  get sourceRedactionAudit() {
    return this.redactionAudits.find((a) => a.purpose === "source_transcript") || null;
  }

  async _applyRedaction(payload, purpose) {
    try {
      // Artefakto kelias yra VIENINTELIS kelias (žr. `artefacts` komentarą):
      // tikrinamas FAKTAS (`variant`), o ne prielaida „iškviečiau redact(),
      // vadinasi redaguota". Eilutė apie save nieko nepasako - `redact()`,
      // grąžinęs įvestį nepakeistą, atrodo lygiai taip pat kaip tikra redakcija.
      const original = artefacts.createOriginalArtefact({ text: payload });

      // Paduodam AKTYVŲ redaktorių (tą, kurį rado utils/redactionComponent.js),
      // o ne leidžiam artefaktui pačiam ką nors importuoti.
      const redacted = artefacts.createRedactedArtefact(original, this._redactionModule);
      artefacts.assertRedacted(redacted, `išorinis tiekėjas "${this.name}"`);

      if (typeof redacted.text !== "string" || redacted.text.trim().length === 0) {
        throw new RedactionError(
          `PII redakcija grąžino tuščią rezultatą, todėl užklausa į išorinį tiekėją ` +
            `"${this.name}" NEBUVO išsiųsta.`
        );
      }

      // `sent` čia yra teisinga baigtis: iškart po šio grąžinimo tekstas
      // keliauja tiekėjui. Jei redakcija būtų kritusi, atsidurtume catch bloke.
      const record = { purpose, ...artefacts.toAuditRecord(redacted, artefacts.OUTCOME.SENT) };
      this.redactionAudits.push(record);
      // Paliekamas dėl atgalinio suderinamumo, bet metaduomenims naudojamas
      // `sourceRedactionAudit` - žr. `redactionAudits` komentarą.
      this.lastRedactionAudit = record;
      return redacted.text;
    } catch (e) {
      // Varianto neatitikimas ir jau suformuota redakcijos klaida keliauja kaip
      // yra - jos tikslesnės už bendrą pranešimą.
      if (e && (e.code === "ARTEFACT_VARIANT_MISMATCH" || e.code === "REDACTION_FAILED")) throw e;

      throw new RedactionError(
        `PII redakcija nepavyko, todėl užklausa į išorinį tiekėją "${this.name}" NEBUVO išsiųsta ` +
          `(REQUIRE_REDACTION_BEFORE_EXTERNAL=true).`,
        e
      );
    }
  }
}

module.exports = { RedactingLLMProvider, RedactionError };
