const express = require("express");
const auditLog = require("../utils/auditLog");
const auditAuth = require("../middleware/auditAuth");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const { validate, schemas } = require("../middleware/validate");
const sessionStore = require("../utils/sessionStore");
const { readCookie, COOKIE_NAME } = require("../middleware/sessionAuth");
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
  const sessionId = readCookie(req, COOKIE_NAME);

  if (sessionId) {
    const session = await sessionStore.touch(sessionId);
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
router.get("/audit", pollRateLimiter, auditAccess, validate({ query: schemas.auditQuery }), (req, res) => {
  const { limit, offset, event, requestId } = req.validated.query;

  let entries = auditLog.getAll();

  // Filtrai taikomi PRIEŠ puslapiavimą - kitaip `limit` reikštų skirtingus
  // dalykus su filtru ir be jo.
  if (event) entries = entries.filter((entry) => entry.event === event);
  if (requestId) entries = entries.filter((entry) => entry.requestId === requestId);

  res.json({
    entries: entries.slice(offset, offset + limit),
    // Bendras skaičius leidžia klientui suprasti, ar yra daugiau - be jo
    // puslapiavimas būtų aklas.
    total: entries.length,
    limit,
    offset,
  });
});

module.exports = router;
