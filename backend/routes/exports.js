const express = require("express");
const rateLimiter = require("../middleware/rateLimiter");
const authenticate = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/authorize");
const { PERMISSIONS } = require("../utils/permissions");
const auditLog = require("../utils/auditLog");
const { rasytiAudita } = require("../utils/auditWrite");
const jobStore = require("../utils/jobStore");
const {
  ACCESS_DECISION,
  OPERATION,
  resolveJobAccess,
} = require("../utils/jobAccessTransport");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { buildExport } = require("../services/exportService");
const { createLogger } = require("../utils/logger");
const { validate, schemas } = require("../middleware/validate");
const log = createLogger("route:exports");

const router = express.Router();


/**
 * POST /api/exports - protokolo eksportas (txt / csv / docx).
 *
 * KODĖL SERVERYJE: eksporto įvykių auditas (GDPR #6 DoD) neįmanomas, kai failas
 * generuojamas naršyklėje - serveris apie tai nieko nežino. Klientu paremtas
 * "pranešiau, kad eksportavau" audito įrašas nebūtų patikimas.
 *
 * Į auditą rašomas TIK: įvykio tipas, formatas, baitų kiekis, pseudonimizuotas
 * jobId (jei paduotas) ir rezultatas. Protokolo turinys, pavadinimas, dalyvių
 * vardai ar failo vardas NErašomi.
 *
 * body: { format: "txt"|"csv"|"docx", protocol: {...}, jobId?: string }
 *
 * DĖL `jobId` PATIKROS: klientas negali savavališkai pasirinkti audito ryšio.
 * `jobId` naudojamas TIK jei toks jobas realiai egzistuoja IR yra transkribavimo
 * tipo. Kitaip įvykis rašomas BE ryšio, o ne su išgalvotu ar svetimo tipo
 * subjektu - antraip vėliau to jobo ištrynimas pašalintų ir jam nepriklausančius
 * eksporto įrašus.
 *
 * `link=` reikšmė audite rodo TIKSLIĄ priežastį, o ne bendrą "unresolved":
 * infrastruktūros problema (neveikiantis Redis) neturi atrodyti taip pat kaip
 * išgalvotas ID, nes kitaip auditas ją paslėptų.
 *
 * Sąmoningai NEgrąžinama 400: jobo įrašas gali būti teisėtai išnykęs pagal
 * JOB_TTL_MINUTES (numatytai 60 min), kol vartotojas dar redaguoja protokolą
 * naršyklėje. Eksportas neturi nutrūkti dėl to, kad audito ryšio nebėra - tai
 * audito, ne vartotojo veiksmo problema. Nepatikrintas `jobId` niekur nesaugomas
 * jokia forma.
 */
/**
 * LEIDIMAS PRIKLAUSO NUO VARIANTO, ne nuo maršruto (#18 PR2).
 *
 * `original` grąžina NEREDAGUOTUS asmens duomenis - tą patį turinį, kurio
 * apsaugai skirta visa #4/#5/#8 redakcijos sistema. `redacted` yra saugus
 * kasdienis kelias. Vienas bendras leidimas abiem reikštų, kad redakcija tampa
 * numatytąja parinktimi, o ne apsauga.
 *
 * Tikrinama PO validacijos, nes iki jos `variant` dar nėra patvirtintas - o
 * spręsti apie leidimą pagal nevaliduotą įvestį reikštų pasitikėti tuo, ką
 * klientas atsiuntė.
 */
function authorizeExportVariant(req, res, next) {
  const variant = req.validated.body.variant;
  const permission =
    variant === "original" ? PERMISSIONS.EXPORT_ORIGINAL : PERMISSIONS.EXPORT_REDACTED;

  return requirePermission(permission)(req, res, next);
}

router.post(
  "/exports",
  rateLimiter,
  authenticate,
  validate({ body: schemas.exportBody }),
  authorizeExportVariant,
  async (req, res) => {

  /**
   * VARIANTAS PRIVALOMAS (GDPR #8: „Require an explicit variant parameter and
   * never infer or silently substitute it").
   *
   * Numatytosios reikšmės nėra sąmoningai. Jei numatytasis būtų `redacted`,
   * senas klientas tyliai gautų kitą turinį nei tikėjosi; jei `original` -
   * tyliai gautų neredaguotą. Abu atvejai blogesni už aiškią klaidą.
   */
  /**
   * Reikšmės ateina iš `req.validated` - jos jau patikrintos schema, tad čia
   * nebereikia nei `String()`, nei tipo patikros. `parseRequestedVariant` lieka
   * naudojamas servise, kur schemos konteksto nėra.
   */
  const { variant, format, protocol, jobId } = req.validated.body;

  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
    return res.status(400).json({ error: "Trūksta `protocol` objekto." });
  }

  // Ryšys naudojamas tik patikrintas (žr. komentarą aukščiau).
  //
  // link reikšmės: none (nepaduota) | job (patvirtinta) | missing (jobo nėra) |
  // invalid_type (yra, bet ne transkribavimo) | store_error (saugyklos klaida).
  let linkedJobId;
  let linkState = "none";

  if (jobId) {
    let job;
    let storeFailed = false;

    try {
      /**
       * #160: eksportas naudoja TĄ PATĮ politikos kelią kaip `GET` ir `DELETE`.
       *
       * Čia sprendimas nevirsta HTTP statusu – eksportas tęsiasi ir be job
       * ryšio (`linkState`). Bet įėjimas turi būti tas pats, kad politika
       * nesiskirtų: `FORBIDDEN` ir `null` abu duoda `missing`, tad svetimo
       * job'o egzistavimas nenuteka net per audito lauką.
       */
      const { decision, job: owned } = await resolveJobAccess(req, jobId, OPERATION.EXPORT);
      job = decision === ACCESS_DECISION.OWNER_ACCESS ? owned : null;
    } catch (e) {
      storeFailed = true;

      // Saugyklos klaida NĖRA tas pats kas neegzistuojantis jobas - ją reikia
      // matyti. Pranešimas sanitizuojamas, nes jame gali būti prisijungimo
      // duomenų (pvz. redis://user:pass@host).
      const { sanitizeForLogging } = auditLog;
      log.warn(
        "Eksporto audito ryšio patikra nepavyko (saugyklos klaida) - " +
          "įvykis rašomas be ryšio. Patikrinkite job saugyklą (Redis):",
        sanitizeForLogging(e)
      );
    }

    if (storeFailed) {
      linkState = "store_error";
    } else if (!job) {
      /**
       * Svetimas job'as jau paverstas `null` aukščiau (#160 politikos kelias),
       * tad čia lieka viena šaka.
       *
       * ⚠️ Anksčiau `FORBIDDEN` (Symbol, taigi truthy) nukrisdavo į `job.type`
       * patikrą, `Symbol.type` būdavo `undefined`, ir auditas užfiksuodavo
       * `invalid_type` – tai atskleisdavo, kad job'as EGZISTUOJA, tik netinkamo
       * tipo. Egzistavimas nutekėdavo per audito lauką.
       */
      linkState = "missing";
    } else if (job.type !== jobStore.JOB_TYPES.TRANSCRIPTION) {
      linkState = "invalid_type";
    } else {
      linkedJobId = jobId;
      linkState = "job";
    }
  }

  const started = Date.now();

  /**
   * Kokį VARIANTĄ realiai gaus vartotojas.
   *
   * Šiame etape jį lemia politika (`EXPORT_ALLOW_ORIGINAL`), ne užklausa -
   * eksplicitinis `variant` parametras ateis su #8. Bet audito laukas
   * reikalingas jau dabar: be jo klausimas „kas eksportavo NEREDAGUOTĄ
   * variantą" lieka neatsakomas net turint žurnalą.
   */
  // Auditui fiksuojam TIKRAI PRAŠYTĄ variantą - jis nėra išvedamas iš politikos.
  const exportVariant = variant;

  await rasytiAudita({
    event: "EXPORT_STARTED",
    success: true,
    jobId: linkedJobId,
    format,
    variant: exportVariant,
    outcome: "started",
    details: `link=${linkState}`,
  });

  try {
    const result = await buildExport(protocol, format, variant);

    await rasytiAudita({
      event: "EXPORT_COMPLETED",
      success: true,
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      format,
      variant: exportVariant,
      outcome: "delivered",
      // Baitų skaičius yra dydis, ne turinys - jis lieka naudingas diagnostikai.
      details: `link=${linkState} bytes=${result.buffer.length}`,
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("Content-Length", String(result.buffer.length));
    // Eksportas gali turėti asmens duomenų - jokio tarpinio kešavimo.
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(result.buffer);
  } catch (error) {
    // Politikos atmetimas nėra serverio klaida - klientas turi matyti, kad
    // variantas neleidžiamas, o ne „kažkas sulūžo".
    // Statusas imamas iš pačios klaidos: politikos draudimas (403), laikinas
    // nepasiekiamumas (503) ir netinkama užklausa (400) yra skirtingi dalykai,
    // o vidinės klaidos lieka 500 ir sanitizuojamos.
    const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 500;

    await rasytiAudita({
      event: "EXPORT_FAILED",
      success: false,
      format,
      variant: exportVariant,
      outcome: "failed",
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      details: `format=${format} link=${linkState}`,
      error: error.message,
    });

    // sanitizeServerError logguoja pilną klaidą serveryje ir grąžina saugų tekstą.
    // Politikos atmetimo pranešimas yra saugus ir naudingas (jame nurodyta, kaip
    // gauti leidžiamą variantą); tik tikros vidinės klaidos sanitizuojamos.
    return status === 500
      ? res.status(500).json({ error: sanitizeServerError(error, "eksportas") })
      : res.status(status).json({ error: error.message });
    }
  }
);

module.exports = router;
