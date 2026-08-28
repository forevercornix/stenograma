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
  const { limit, cursor, action, requestId, jobId, from, to } = req.validated.query;

  /**
   * ⚠️ SUGADINTAS KURSORIUS - 400, NE 500 (#212).
   *
   * `CursorError` yra kliento klaida: tokenas sugadintas, nepilnas arba
   * priklauso kitai filtrų aibei. Be atskiro apdorojimo jis nukristų į bendrą
   * `catch` ir virstų 500 - serverio gedimu, kurio nėra.
   *
   * ⚠️ Rotavus aktyvų raktą anksčiau išduoti kursoriai irgi tampa negaliojantys
   * (atspaudas nebesutampa). Tai sąmoninga #212 pasekmė; klientas pradeda
   * puslapiavimą iš naujo.
   */
  let rezultatas;
  try {
    rezultatas = await auditLog.query({ limit, cursor, action, requestId, jobId, from, to });
  } catch (error) {
    if (error && error.code === "AUDIT_CURSOR_INVALID") {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: sanitizeServerError(error, "GET /api/audit") });
  }

  /**
   * ⚠️ `total` PAŠALINTAS kartu su `offset`. Keyset puslapiavime jis reikštų
   * `COUNT` per visą filtruotą aibę KIEKVIENAM puslapiui, o `next_cursor` tą
   * patį klausimą („ar yra daugiau") atsako pigiai ir tiksliai.
   */
  res.json({
    entries: rezultatas.entries,
    next_cursor: rezultatas.nextCursor,
    limit,
  });
});

module.exports = router;
