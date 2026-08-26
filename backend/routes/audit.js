const express = require("express");
const auditLog = require("../utils/auditLog");
const auditAuth = require("../middleware/auditAuth");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const { validate, schemas } = require("../middleware/validate");
const sessionStore = require("../utils/sessionStore");
const { readCookie, COOKIE_NAME, sessionStoreUnavailable } = require("../middleware/sessionAuth");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");

const router = express.Router();

/**
 * AUDITO PRIEIGA: sesija SU `audit:read` ARBA esamas `x-audit-key` (#18 PR2).
 *
 * `AUDIT_API_KEY` liko atskiras nuo `API_KEY` sąmoningai - audito žurnalas yra
 * jautresnis nei kasdienis darbas, tad jam buvo skirtas savas raktas. Tas
 * modelis IŠSAUGOMAS: esami diegimai ir skriptai su `x-audit-key` veikia be
 * pakeitimų.
 *
 * Kas pridėta: administratorius su galiojančia sesija nebeprivalo turėti ANTRO
 * rakto vien tam, kad pamatytų auditą. Be to rolės būtų beprasmės - vartotojas
 * su `audit:read` leidimu vis tiek negalėtų juo pasinaudoti.
 *
 * `operator` čia nepraeis nė vienu keliu: jis neturi `audit:read`, o
 * `x-audit-key` yra atskira paslaptis, kurios jam neturi būti duota.
 */
async function auditAccess(req, res, next) {
  const token = readCookie(req, COOKIE_NAME);

  if (token) {
    /**
     * ⚠️ SESIJŲ SAUGYKLOS GEDIMAS NEKRENTA Į `x-audit-key` ŠAKĄ (#155, 7.3).
     *
     * Fallback žemiau reiškia „sesijos nėra arba ji neturi teisės". DB gedimo
     * atveju to nežinome, tad kritimas toliau paverstų nepatikrinamą sesiją
     * kitokia autorizacijos šaka.
     */
    if (!sessionStore.isReady()) return sessionStoreUnavailable(res);

    let session;
    try {
      session = await sessionStore.touch(token);
    } catch {
      return sessionStoreUnavailable(res);
    }

    if (session && hasPermission(session.role, PERMISSIONS.AUDIT_READ)) {
      req.user = { username: session.username, role: session.role };
      return next();
    }
  }

  // Sesijos nėra arba ji neturi teisės - krentam į esamą rakto patikrą.
  return auditAuth(req, res, next);
}

/**
 * Auditas turi TĄ PATĮ apsaugos rinkinį kaip kiti maršrutai (#14).
 *
 * Iki šiol jis turėjo tik autentifikaciją: be rate limito jį buvo galima
 * apklausinėti neribotai, o be puslapiavimo kiekvienas atsakymas augo kartu su
 * žurnalu. Audito endpointas yra būtent tas, kurį užpuolikas norėtų nuskaityti
 * daug kartų.
 */
router.get("/audit", pollRateLimiter, auditAccess, validate({ query: schemas.auditQuery }), async (req, res) => {
  const { limit, offset, event, requestId } = req.validated.query;

  /**
   * ⚠️ `getAll()` YRA ASYNC NUO 7.4a (#210), TAD JIS GALI ATMESTI.
   *
   * Repo neturi globalaus Express klaidų handlerio. Neapdorotas rejection
   * nukristų į Express numatytąjį kelią, kuris ne produkcijoje grąžina klaidos
   * tekstą ir stack trace - o čia tai būtų audito saugyklos vidinė
   * diagnostika. `getAll()` šiandien yra atmintyje ir nekrenta, bet 7.4b
   * pakeis realizaciją į DB; sargas turi egzistuoti PRIEŠ tai, ne po.
   */
  /**
   * ⚠️ RIBA IR FILTRAI TAIKOMI SAUGYKLOJE, NE ČIA (#155, 7.4b / #211).
   *
   * Iki 7.4b maršrutas atsiimdavo VISĄ žurnalą, filtruodavo Node'e ir tik tada
   * `slice()`-indavo. Persistentiniame režime tai reikštų pilną lentelės
   * perkėlimą kiekvienai užklausai.
   *
   * ⚠️ FILTRAI PERKELTI KARTU SU RIBA, NE ATSKIRAI. Palikus juos Node'e, o ribą
   * perkėlus į SQL, būtų filtruojamas PUSLAPIS, ne aibė - ir filtruotas
   * atsakymas taptų tyliai neteisingas. `event` ir `request_id` turi savo
   * indeksus būtent todėl. NAUJI filtrai (`from`, `to`, `action`, `job_id`)
   * lieka 7.4c.
   */
  let rezultatas;
  try {
    rezultatas = await auditLog.query({ limit, offset, event, requestId });
  } catch (error) {
    return res.status(500).json({ error: sanitizeServerError(error, "GET /api/audit") });
  }

  res.json({
    entries: rezultatas.entries,
    // Bendras skaičius leidžia klientui suprasti, ar yra daugiau - be jo
    // puslapiavimas būtų aklas.
    total: rezultatas.total,
    limit,
    offset,
  });
});

module.exports = router;
