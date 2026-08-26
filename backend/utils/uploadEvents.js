const { rasytiAudita } = require("./auditWrite");
const { createLogger } = require("./logger");

const log = createLogger("upload");

/**
 * ATMESTŲ ĮKĖLIMŲ ĮVYKIAI (GDPR #17: „Rate-limit and rejected-upload events
 * contain no sensitive payload").
 *
 * Atmetimas yra saugumo signalas: pakartotiniai bandymai su neteisingu formatu
 * arba per dideliais failais atrodo kaip zondavimas. Iki šiol jie dingdavo be
 * pėdsako - klientas gaudavo 400, o serveryje nelikdavo nieko.
 *
 * KAS NEĮRAŠOMA IR KODĖL:
 *  - failo vardas: jį pateikia vartotojas ir jame gali būti asmenvardis
 *    („Jono Jonaičio pokalbis.mp3") - tai PII, patenkanti į ilgaamžį žurnalą;
 *  - turinys ar jo fragmentai: akivaizdu;
 *  - kelias diske: vidinė informacija, kurios klientui ir žurnalui nereikia.
 *
 * KAS ĮRAŠOMA: priežastis (enum), deklaruotas MIME tipas ir dydis. Jų pakanka
 * atsakyti „ar kas nors sistemingai bando kišti ne audio failus", bet nepakanka
 * atkurti, KĄ konkrečiai jis kišo.
 */

const REASONS = {
  FORMAT: "format_rejected",
  TOO_LARGE: "too_large",
  SIGNATURE: "signature_mismatch",
  MISSING: "missing_file",
};

/** MIME rodomas tik jei atitinka MIME formą - kitaip tai laisvas kliento tekstas. */
const MIME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,30}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,30}$/;

function _safeMime(value) {
  const mime = String(value || "").toLowerCase();
  return MIME_SHAPE.test(mime) ? mime : "unknown";
}

/**
 * @param {string} reason - viena iš REASONS reikšmių
 * @param {{route?: string, mimetype?: string, size?: number}} [details]
 */
/**
 * ⚠️ ASYNC NUO 7.4a (#210). `UPLOAD_REJECTED` yra NEBLOKUOJANTIS - audito
 * gedimas atmetimo nepakeičia, bet Promise vis tiek laukiamas, kad
 * `rasytiAudita()` spėtų jį suloginti ir suskaičiuoti.
 */
async function recordRejectedUpload(reason, details = {}) {
  // `jobId` perduodamas, kai jis jau egzistuoja: kitaip įvykis liktų nesusietas
  // su subjektu ir jo NEPASIEKTŲ GDPR ištrynimas. PII jame nėra, bet
  // „neištrinamas įrašas apie asmens veiksmą" yra pati problema, kurios vengiam.
  const payload = {
    reason,
    route: details.route || "unknown",
    mimetype: _safeMime(details.mimetype),
    // Dydis yra skaičius, ne turinys - naudingas atskiriant „per didelis failas"
    // nuo „zondavimas mažais failais".
    sizeBytes: Number.isFinite(details.size) ? details.size : null,
    /**
     * Dydžio limito atveju REALAUS failo dydžio multer nežino - jis nutraukia
     * skaitymą peržengęs ribą. Sąžiningiau fiksuoti sukonfigūruotą limitą nei
     * apsimesti, kad žinom faktinį dydį.
     */
    limitBytes: Number.isFinite(details.limitBytes) ? details.limitBytes : null,
  };

  log.warn("Įkėlimas atmestas", payload);

  await rasytiAudita({
    event: "UPLOAD_REJECTED",
    success: false,
    jobId: details.jobId || null,
    outcome: reason,
    // STRUKTŪRIZUOTI laukai, ne laisva eilutė - dėl tos pačios priežasties, dėl
    // kurios `format`/`variant` iškelti iš eksporto `details`: auditą reikia
    // filtruoti, ne skaityti akimis.
    route: payload.route,
    mime: payload.mimetype,
    sizeBytes: payload.sizeBytes,
    limitBytes: payload.limitBytes,
  });
}

/** Multer klaidą paverčia į priežastį; nežinoma klaida lieka „format_rejected". */
function reasonFromMulterError(err) {
  if (err && err.code === "LIMIT_FILE_SIZE") return REASONS.TOO_LARGE;
  return REASONS.FORMAT;
}

module.exports = { REASONS, recordRejectedUpload, reasonFromMulterError };
