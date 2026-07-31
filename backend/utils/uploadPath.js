const os = require("os");
const path = require("path");

/**
 * ĮKELTŲ FAILŲ KELIO SUVALDYMAS (GDPR #13; CodeQL js/path-injection).
 *
 * `req.file.path` sudaro multer iš mūsų pačių `destination` + `filename`, tad
 * praktinė rizika maža. Bet dvi prielaidos čia lieka neužrašytos kode:
 *
 *   1. kad `filename` generatorius niekada neįsileis vartotojo teksto - o jis
 *      JAU įsileidžia `path.extname(file.originalname)`;
 *   2. kad niekas ateityje nepakeis `destination` į konfigūruojamą reikšmę.
 *
 * Vietoj pasitikėjimo abiem prielaidomis kelias tikrinamas prieš KIEKVIENĄ
 * failo operaciją. Tai pigu ir paverčia numanomą invariantą patikrinamu.
 */

/** Vienintelis katalogas, kuriame teisėtai gyvena įkelti failai. */
function uploadDir() {
  return path.resolve(process.env.UPLOAD_TMP_DIR || os.tmpdir());
}

/**
 * Plėtinys imamas iš vartotojo failo vardo, tad ribojamas whitelist'u.
 * Nežinomas ar įtartinas plėtinys nėra klaida - failas tiesiog lieka be jo.
 */
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;

function safeExtension(originalName) {
  const ext = path.extname(String(originalName || ""));
  return SAFE_EXTENSION.test(ext) ? ext.toLowerCase() : "";
}

/**
 * Ar kelias tikrai yra įkėlimų kataloge?
 *
 * `startsWith(dir)` vieno neužtenka: `/tmp/stenograma-evil` prasideda `/tmp/stenograma`.
 * Todėl lyginama su katalogu IR skiriamuoju simboliu.
 */
function isInsideUploadDir(filePath) {
  const dir = uploadDir();
  const resolved = path.resolve(String(filePath || ""));
  return resolved.startsWith(dir + path.sep) && resolved !== dir;
}

class UploadPathError extends Error {
  constructor(filePath) {
    super("Įkelto failo kelias yra už leidžiamo katalogo ribų.");
    this.name = "UploadPathError";
    this.code = "UPLOAD_PATH_FORBIDDEN";
    this.statusCode = 400;
    // Pats kelias NĖRA įrašomas į pranešimą - jis keliautų į klientą ir logus.
    this.resolved = path.resolve(String(filePath || ""));
  }
}

function assertInsideUploadDir(filePath) {
  if (!isInsideUploadDir(filePath)) throw new UploadPathError(filePath);
  return path.resolve(String(filePath));
}

module.exports = {
  uploadDir,
  safeExtension,
  isInsideUploadDir,
  assertInsideUploadDir,
  UploadPathError,
};
