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

class RedactingLLMProvider {
  /**
   * @param {object} inner - tikras tiekėjas (ClaudeProvider, GPTProvider, ...)
   * @param {(text: string) => string|Promise<string>} redact - #4 komponento funkcija
   */
  constructor(inner, redact) {
    if (!inner || typeof inner.generateProtocol !== "function") {
      throw new Error("RedactingLLMProvider: netinkamas vidinis tiekėjas.");
    }
    if (typeof redact !== "function") {
      throw new Error("RedactingLLMProvider: `redact` privalo būti funkcija.");
    }
    this.inner = inner;
    this._redact = redact;
    this.redactionEnforced = true;
  }

  // Proxy: protocolService naudoja šiuos laukus audito įrašui.
  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  async generateProtocol(payload) {
    const redacted = await this._applyRedaction(payload);
    return this.inner.generateProtocol(redacted);
  }

  async _applyRedaction(payload) {
    let result;

    try {
      result = await this._redact(payload);
    } catch (e) {
      throw new RedactionError(
        `PII redakcija nepavyko, todėl užklausa į išorinį tiekėją "${this.name}" NEBUVO išsiųsta ` +
          `(REQUIRE_REDACTION_BEFORE_EXTERNAL=true).`,
        e
      );
    }

    // Netinkamas rezultatas prilyginamas klaidai. Kitaip `redact()`, grąžinęs
    // undefined, taptų "išsiųsk ką nors" - t. y. tyliu apėjimu.
    if (typeof result !== "string" || result.trim().length === 0) {
      throw new RedactionError(
        `PII redakcija grąžino netinkamą rezultatą (${typeof result}), todėl užklausa į išorinį ` +
          `tiekėją "${this.name}" NEBUVO išsiųsta.`
      );
    }

    return result;
  }
}

module.exports = { RedactingLLMProvider, RedactionError };
