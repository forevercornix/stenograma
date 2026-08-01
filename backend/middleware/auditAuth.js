const { createLogger } = require("../utils/logger");
const log = createLogger("auth:audit");
/**
 * Apsaugo /api/audit nuo viešo pasiekiamumo be jokio patikrinimo.
 *
 * - Jei AUDIT_API_KEY nustatytas: reikalauja tikslaus 'x-audit-key' header'io.
 * - Jei AUDIT_API_KEY nenustatytas IR NODE_ENV=production: endpoint uždarytas (503).
 * - Jei AUDIT_API_KEY nenustatytas IR ne production (dev/test): praleidžiama,
 *   bet konsolėje parodomas įspėjimas - patogu lokaliam kūrimui, nepavojinga.
 */
function auditAuth(req, res, next) {
  const configuredKey = process.env.AUDIT_API_KEY;

  if (configuredKey) {
    const provided = req.header("x-audit-key");
    if (provided !== configuredKey) {
      return res.status(401).json({ error: "Neteisingas arba trūkstamas x-audit-key." });
    }
    return next();
  }

  if (process.env.NODE_ENV === "production") {
    return res.status(503).json({
      error: "/api/audit uždarytas produkcijoje, kol nenustatytas AUDIT_API_KEY aplinkos kintamasis.",
    });
  }

  log.warn(
    "AUDIT_API_KEY nenustatytas - /api/audit atviras be autentifikacijos (leidžiama tik NODE_ENV != production)."
  );
  return next();
}

module.exports = auditAuth;
