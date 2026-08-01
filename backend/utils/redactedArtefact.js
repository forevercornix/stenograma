const crypto = require("crypto");

/**
 * TRANSKRIPCIJOS ARTEFAKTAS (GDPR #4).
 *
 * Kodėl objektas, o ne eilutė. Iki šiol redakcijos vykdymas atrodė taip:
 * „iškviečiau redact(), vadinasi tekstas redaguotas". Bet eilutė nieko apie save
 * nepasako - `redact()`, grąžinęs įvestį nepakeistą, ir tikra redakcija atrodo
 * identiškai. Guard'as negalėjo atskirti, ar prieš jį originalas, ar rezultatas.
 *
 * Artefaktas neša `variant`, tad guard'as tikrina FAKTĄ (DoD: „External-provider
 * guards verify the artefact variant before sending content"), o ne prielaidą.
 *
 * `sourceArtefactId` sieja redaguotą versiją su originalu - be jo GDPR ištrynimas
 * negalėtų rasti visų vieno subjekto kopijų.
 *
 * SVARBU: artefakte NĖRA aptiktų PII reikšmių. `stats` turi tik skaičius pagal
 * kategoriją, tad visą objektą saugu rašyti į auditą.
 */

const VARIANT = {
  ORIGINAL: "original",
  REDACTED: "redacted",
  /**
   * IŠVESTINIS turinys (protokolas, santrauka), sukurtas LLM iš kurio nors
   * varianto. NĖRA „redaguotas": modelis gali įrašyti PII, kurios įėjime nebuvo.
   * Kad tai matytųsi, greta visada nurodomas ir šaltinio variantas.
   */
  GENERATED: "generated",
};

const STATUS = {
  REDACTED: "redacted",
  NOT_REQUIRED: "not_required",
  FAILED: "failed",
};

/**
 * BAIGTIS - atskirai nuo statuso.
 *
 * `redactionStatus` sako, kas nutiko REDAKCIJAI; `outcome` - kas nutiko
 * DUOMENIMS. Redakcija gali pavykti, o duomenys vis tiek nebūti išsiųsti (kita
 * klaida vėliau), tad du laukai nėra perteklius.
 */
const OUTCOME = {
  SENT: "sent",
  BLOCKED: "blocked",
};

/**
 * Varianto reikšmės, kurias gali PRAŠYTI klientas.
 *
 * `GENERATED` čia sąmoningai nėra: jis apibūdina tai, ką sistema PAGAMINO
 * (protokolą iš transkripcijos), ir prašyti jo kaip eksporto varianto neturi
 * prasmės. Rinkinys atskiras nuo `VARIANT`, kad ta riba būtų matoma kode, o ne
 * tik komentare.
 */
const REQUESTABLE_VARIANTS = Object.freeze([VARIANT.ORIGINAL, VARIANT.REDACTED]);

/**
 * Vienintelė vieta, kur kliento pateiktas variantas paverčiamas reikšme.
 *
 * Kol maršrutas vienas, atskiras helperis atrodo perteklinis. Bet variantų
 * logika jau dabar yra dviejose vietose (maršrutas ir eksporto servisas), o
 * pridėjus dar vieną endpointą trečia kopija atsirastų tyliai - ir skirtųsi.
 *
 * NIEKO NENUMANO: nežinoma reikšmė grąžina `null`, o ne artimiausią panašią.
 * „Priartinimas prie panašiausios" reikštų, kad `originalas` (lietuviškai)
 * tyliai virstų `original` - ir klientas net nesužinotų, kad rašė klaidingai.
 *
 * @returns {"original"|"redacted"|null}
 */
function parseRequestedVariant(value) {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return REQUESTABLE_VARIANTS.includes(normalized) ? normalized : null;
}

class ArtefactVariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtefactVariantError";
    this.code = "ARTEFACT_VARIANT_MISMATCH";
    this.statusCode = 500;
  }
}

function _newId() {
  return crypto.randomUUID();
}

/**
 * Dirba su BET KURIUO redaktoriumi: turtingu (`redactDetailed` su statistika)
 * arba minimaliu (`redact`, grąžinantis eilutę). Minimalus kontraktas yra tas,
 * kurio reikalauja `utils/redactionComponent.js`, tad jį būtina palaikyti.
 */
function _applyText(mod, text) {
  if (typeof mod.redactDetailed === "function") {
    const result = mod.redactDetailed(text);
    return { text: result.text, stats: result.stats || {} };
  }

  const redacted = mod.redact(text);
  if (typeof redacted !== "string") {
    throw new ArtefactVariantError(
      `Redakcijos komponentas grąžino ${typeof redacted}, o ne tekstą - artefaktas nekuriamas.`
    );
  }
  return { text: redacted, stats: {} };
}

/**
 * Rekursyvi redakcija struktūrizuotam objektui, IŠSAUGANT formą.
 *
 * Redaguojamas objektas, ne galutinis tekstas: DOCX yra dvejetainis, tad teksto
 * lygio redagavimas jį tyliai praleistų (rasta įgyvendinant eksporto politiką).
 */
function _applyData(mod, data) {
  if (data === null || data === undefined) return { data, stats: {} };

  const stats = {};
  const merge = (partial) => {
    for (const [key, value] of Object.entries(partial)) stats[key] = (stats[key] || 0) + value;
  };

  const walk = (value) => {
    if (typeof value === "string") {
      const result = _applyText(mod, value);
      merge(result.stats);
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return { data: walk(data), stats };
}

function _applySegments(mod, segments) {
  if (!Array.isArray(segments)) return { segments, stats: {} };

  if (typeof mod.redactSegments === "function") return mod.redactSegments(segments);

  // Fallback: redaguojam tik `text`, likusius laukus paliekam - struktūra
  // (kalbėtojas, laiko žymės) turi išlikti nepriklausomai nuo komponento.
  return {
    segments: segments.map((seg) =>
      seg && typeof seg.text === "string" ? { ...seg, text: _applyText(mod, seg.text).text } : seg
    ),
    stats: {},
  };
}

/** Originalus (neredaguotas) artefaktas - atskaitos taškas ir ištrynimo sąsaja. */
function createOriginalArtefact({ text, segments = null, data = null, id = null } = {}) {
  return Object.freeze({
    artefactId: id || _newId(),
    sourceArtefactId: null,
    variant: VARIANT.ORIGINAL,
    redactionStatus: STATUS.NOT_REQUIRED,
    policyVersion: null,
    createdAt: new Date().toISOString(),
    text: typeof text === "string" ? text : "",
    segments,
    // STRUKTŪRIZUOTAS turinys (pvz. protokolo objektas eksportui). Reikalingas,
    // kad eksportas eitų per TĄ PATĮ artefakto guard'ą kaip LLM kelias, o ne
    // pasitikėtų `redact()` grąžinta reikšme.
    data,
    stats: null,
  });
}

/**
 * Sukuria REDAGUOTĄ artefaktą iš originalo.
 *
 * Fail-closed: jei redakcija meta klaidą, artefaktas NEKURIAMAS - vietoj jo
 * klaida keliauja aukštyn. Grąžinti artefaktą su `status: failed` ir originaliu
 * tekstu būtų blogiausias variantas: objektas atrodytų apdorotas, o viduje būtų
 * neliesti duomenys.
 */
function createRedactedArtefact(source, redactionModule = null) {
  if (!source || source.variant !== VARIANT.ORIGINAL) {
    throw new ArtefactVariantError(
      "Redaguotas artefaktas kuriamas TIK iš originalo - kitaip redakcija būtų taikoma du kartus " +
        "arba nežinomam turiniui."
    );
  }

  /**
   * Redaktorius PADUODAMAS, o ne importuojamas kietai.
   *
   * Pirmoji versija importavo `piiRedaction` tiesiogiai - ir tyliai apėjo
   * `utils/redactionComponent.js` aptikimą. Rezultatas: guard'as būtų tikrinęs
   * artefaktą, sukurtą visai kitu redaktoriumi, nei tas, kurį sistema laiko
   * aktyviu. Testai tai pagavo iškart, bet produkcijoje tai būtų buvusi tyli
   * neatitiktis tarp „kas sukonfigūruota" ir „kas realiai vykdoma".
   */
  const mod = redactionModule || require("./piiRedaction");

  const textResult = _applyText(mod, source.text);
  const segmentResult = _applySegments(mod, source.segments);
  const dataResult = _applyData(mod, source.data);

  const stats = { ...textResult.stats };
  for (const source of [segmentResult.stats, dataResult.stats]) {
    for (const [key, value] of Object.entries(source)) {
      stats[key] = (stats[key] || 0) + value;
    }
  }

  return Object.freeze({
    artefactId: _newId(),
    sourceArtefactId: source.artefactId,
    variant: VARIANT.REDACTED,
    redactionStatus: STATUS.REDACTED,
    // Minimalus kontraktas (tik `redact`) politikos versijos neturi - tada
    // pažymim aiškiai, o ne apsimetam, kad žinom.
    policyVersion: mod.POLICY_VERSION || "custom",
    createdAt: new Date().toISOString(),
    text: textResult.text,
    segments: segmentResult.segments,
    data: dataResult.data,
    stats: Object.freeze(stats),
  });
}

/**
 * Guard'as: „ar šis artefaktas tikrai redaguotas?"
 *
 * Naudojamas prieš KIEKVIENĄ išsiuntimą išoriniam tiekėjui ir prieš eksportą,
 * kai politika to reikalauja. Tikrinamas ne tik `variant`, bet ir statusas su
 * politikos versija - artefaktas be politikos versijos reiškia, kad kažkas jį
 * sukonstravo ranka apeidamas komponentą.
 */
function assertRedacted(artefact, context = "") {
  const where = context ? ` (${context})` : "";

  if (!artefact || typeof artefact !== "object") {
    throw new ArtefactVariantError(`Tikėtasi redaguoto artefakto, gauta ${typeof artefact}${where}.`);
  }

  if (artefact.variant !== VARIANT.REDACTED) {
    throw new ArtefactVariantError(
      `Artefakto variantas yra "${artefact.variant}", o reikalaujama "${VARIANT.REDACTED}"${where}. ` +
        "Neredaguotas turinys neišsiunčiamas."
    );
  }

  if (artefact.redactionStatus !== STATUS.REDACTED || !artefact.policyVersion) {
    throw new ArtefactVariantError(
      `Artefaktas pažymėtas kaip redaguotas, bet neturi galiojančio statuso ar politikos versijos${where}.`
    );
  }

  return artefact;
}

/** Auditui/logams: metaduomenys BE teksto ir be aptiktų reikšmių. */
function toAuditRecord(artefact, outcome = OUTCOME.SENT) {
  return {
    outcome,
    artefactId: artefact.artefactId,
    sourceArtefactId: artefact.sourceArtefactId,
    variant: artefact.variant,
    redactionStatus: artefact.redactionStatus,
    policyVersion: artefact.policyVersion,
    createdAt: artefact.createdAt,
    redactionStats: artefact.stats,
  };
}

module.exports = {
  VARIANT,
  REQUESTABLE_VARIANTS,
  parseRequestedVariant,
  STATUS,
  OUTCOME,
  ArtefactVariantError,
  createOriginalArtefact,
  createRedactedArtefact,
  assertRedacted,
  toAuditRecord,
};
