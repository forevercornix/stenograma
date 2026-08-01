/**
 * Šis projektas yra MVP skirtas LOKALIAM/VIDINIAM naudojimui, ne viešas SaaS su
 * vartotojų valdymu. /api/generate ir /api/transcribe kviečia apmokamus išorinius
 * API (LLM, ASR) - be jokios apsaugos jie būtų atviri bet kam internete.
 *
 * Šis middleware suteikia MINIMALIĄ apsaugą: bendras API_KEY visiems klientams
 * (ne per-user autentifikacija). Jei diegiate viešai su realiais vartotojais,
 * pakeiskite tai tinkama auth sistema (sesijos, OAuth, JWT su per-user limitais).
 *
 * - Jei API_KEY nustatytas: reikalauja tikslaus 'x-api-key' header'io.
 * - Jei API_KEY nenustatytas IR NODE_ENV=production: endpoint'as uždarytas (503).
 * - Jei API_KEY nenustatytas IR ne production: praleidžiama su įspėjimu konsolėje
 *   (patogu lokaliam kūrimui su savo backend'u).
 */
const { setActor, actorFingerprint } = require("../utils/requestContext");

function apiKeyAuth(req, res, next) {
  const configuredKey = process.env.API_KEY;

  if (configuredKey) {
    const provided = req.header("x-api-key");
    if (provided !== configuredKey) {
      return res.status(401).json({ error: "Neteisingas arba trūkstamas x-api-key." });
    }
    // AKTORIUS audito įrašams (GDPR #17). Saugom rakto HASH, ne patį raktą -
    // audito įrašai gyvena ilgiau nei raktas.
    setActor(actorFingerprint(configuredKey));
    return next();
  }

  if (process.env.NODE_ENV === "production") {
    return res.status(503).json({
      error: "Šis endpoint'as uždarytas produkcijoje, kol nenustatytas API_KEY aplinkos kintamasis.",
    });
  }

  console.warn(
    `[stenograma] API_KEY nenustatytas - ${req.path} atviras be autentifikacijos (leidžiama tik NODE_ENV != production). Nediekite taip viešai.`
  );
  return next();
}

module.exports = apiKeyAuth;
