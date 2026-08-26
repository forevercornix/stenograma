const { sanitizeServerError } = require("./sanitizeError");

/**
 * BLOKUOJANČIO AUDITO GEDIMO HTTP ATSAKYMAS (#155, 7.4a / #210).
 *
 * ⚠️ KLAIDOS OBJEKTAS NEPATENKA Į ATSAKYMĄ.
 *
 * Repo neturi globalaus Express klaidų handlerio - kiekvienas maršrutas
 * sanitizuoja pats. Neapdorotas `AuditWriteError` nukristų į Express numatytąjį
 * kelią, kuris gali grąžinti klaidos tekstą ar stack trace. Pilna diagnostika
 * lieka serverio loge per `sanitizeServerError()`, klientas gauna neutralų
 * pranešimą.
 *
 * ⚠️ VIENA VIETA, NE KIEKVIENAME MARŠRUTE. Sanitizacija, kartojama call
 * site'uose, ilgainiui išsiskirtų - vienas maršrutas praleistų `sanitizeServerError`
 * ir grąžintų `error.message`, kuriame yra backend'o sentinel tekstas.
 *
 * ⚠️ 503, NE 500: gedimas laikinas (audito saugykla), tad klientui teisinga
 * pasakyti „bandykite vėliau", o ne „jūsų užklausa neteisinga".
 */
function auditoGedimas(res, error, kontekstas) {
  return res.status(503).json({
    error: sanitizeServerError(error, kontekstas),
    code: "AUDIT_WRITE_FAILED",
  });
}

module.exports = { auditoGedimas };
