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
/**
 * ⚠️ BARJERO ATMETIMAS NĖRA LAIKINAS GEDIMAS (#155, 7.4e / #216).
 *
 * `AUDIT_WRITE_BLOCKED` reiškia, kad subjektas pažymėtas ištrynimui - t. y.
 * jobo nebėra. 503 („bandykite vėliau") čia būtų MELAGINGAS signalas:
 * pakartojimas niekada nepavyks.
 *
 * ⚠️ TAS PATS ATSAKYMAS KAIP ESAMAME KELYJE (AGENTS.md §16). Tą pačią faktinę
 * būseną `routes/jobs.js` jau atvaizduoja kaip `404 { error: "Jobas nerastas." }`.
 * Antras žodynas (410 arba savas `code`) reikštų, kad atsakymas priklauso nuo to,
 * KURIS sluoksnis būseną pastebėjo pirmas.
 *
 * ⚠️ KŪNAS IDENTIŠKAS, BE `code`. 410 arba `code: "SUBJECT_ERASED"` leistų
 * kvietėjui, spėliojančiam job ID, atskirti „niekada nebuvo" nuo „buvo ir
 * ištrintas" - teigiamą patvirtinimą apie ištrintą subjektą. Vidinė priežastis
 * lieka serverio loge ir `AuditWriteBlockedError.code`, kuris iš proceso neišeina.
 */
function auditoGedimas(res, error, kontekstas) {
  if (error && error.code === "AUDIT_WRITE_BLOCKED") {
    return res.status(404).json({ error: "Jobas nerastas." });
  }

  return res.status(503).json({
    error: sanitizeServerError(error, kontekstas),
    code: "AUDIT_WRITE_FAILED",
  });
}

module.exports = { auditoGedimas };
