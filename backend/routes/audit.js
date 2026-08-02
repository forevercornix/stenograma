const express = require("express");
const auditLog = require("../utils/auditLog");
const auditAuth = require("../middleware/auditAuth");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const { validate, schemas } = require("../middleware/validate");

const router = express.Router();

/**
 * Auditas turi TĄ PATĮ apsaugos rinkinį kaip kiti maršrutai (#14).
 *
 * Iki šiol jis turėjo tik autentifikaciją: be rate limito jį buvo galima
 * apklausinėti neribotai, o be puslapiavimo kiekvienas atsakymas augo kartu su
 * žurnalu. Audito endpointas yra būtent tas, kurį užpuolikas norėtų nuskaityti
 * daug kartų.
 */
router.get("/audit", pollRateLimiter, auditAuth, validate({ query: schemas.auditQuery }), (req, res) => {
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
