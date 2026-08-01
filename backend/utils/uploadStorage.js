const multer = require("multer");
const crypto = require("crypto");
const { uploadDir, safeExtension } = require("./uploadPath");

/**
 * BENDRA ĮKĖLIMŲ KONFIGŪRACIJA (#13).
 *
 * Kodėl atskiras modulis, o ne kopija kiekviename maršrute: taip jau buvo, ir
 * tai baigėsi tyliai. `/api/transcribe` gavo `uploadDir()`, `safeExtension()` ir
 * naują vardų schemą, o `/api/transcribe-jobs` liko su `os.tmpdir()`,
 * `path.extname()` ir `stenograma-job-<uuid>` - nors abu maršrutai daro tą patį
 * dalyką. Rezultatas: su nustatytu `UPLOAD_TMP_DIR` asinchroninis kelias rašė
 * kitur, cleanup jį atmesdavo kaip esantį "už katalogo ribų", klaida būdavo
 * praryjama, o failas likdavo diske.
 *
 * Dabar konfigūracija fiziškai viena. Maršrutai jos nebegali išskirti
 * nepakeitę šio failo.
 */

const MAX_UPLOAD_MB = () => parseInt(process.env.MAX_UPLOAD_MB || "500", 10);

const ALLOWED_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
  // MP4/WebM konteineriai su vaizdo takeliu - audio ištraukiamas, vaizdas
  // ignoruojamas (žr. routes/transcribe.js paaiškinimą).
  "video/mp4",
  "video/webm",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".webm",
  ".ogg",
  ".aac",
  ".flac",
]);

/** Vardų šablonas, kurį generuoja `storage` (naudoja ir stale valymas). */
const UPLOAD_NAME_PREFIX = "stenograma-";

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir()),
  // Vienintelė vartotojo valdoma vardo dalis - plėtinys - eina pro whitelist'ą.
  filename: (req, file, cb) =>
    cb(null, `${UPLOAD_NAME_PREFIX}${crypto.randomUUID()}${safeExtension(file.originalname)}`),
});

function isAllowedAudio(file) {
  const mime = (file.mimetype || "").toLowerCase();
  // safeExtension(), o ne path.extname(): čia rezultatas tik lyginamas su
  // whitelist'u, tad rizikos nėra, bet vienas plėtinio šaltinis visame faile
  // reiškia, kad filtras ir failo vardas negali nesutapti.
  const ext = safeExtension(file.originalname);
  // Naršyklės kartais siunčia application/octet-stream, tad užtenka vieno iš
  // dviejų. Turinio parašas tikrinamas atskirai (utils/audioMagicBytes.js).
  return ALLOWED_MIME.has(mime) || ALLOWED_EXTENSIONS.has(ext);
}

/**
 * MIME tipo pavidalas pagal RFC 6838 (susiaurintas): `tipas/potipis`.
 * Ilgis ribotas sąmoningai - klaidos tekstas keliauja į HTTP atsakymą ir logą.
 */
const MIME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,30}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,30}$/;

/**
 * Vartotojo pateiktas MIME, saugus rodyti klaidos pranešime.
 *
 * `file.mimetype` ateina iš kliento - tai laisvai suklastota `Content-Type`
 * reikšmė, ne serverio išvada.
 *
 * Tikrinama FORMA, o ne valomi simboliai. Valymas iš
 * `application/x-evil<script>AAAA...` pagamintų `application/x-evilscriptAAAA...`:
 * nekenksminga, bet klaidinanti - administratorius loge matytų MIME tipą, kurio
 * klientas niekada nesiuntė. Neatpažįstama reikšmė geriau nerodoma visai.
 */
function _displaySafeMime(value) {
  const mime = String(value || "").toLowerCase();
  return MIME_SHAPE.test(mime) ? mime : "[neatpažintas]";
}

function createAudioUpload() {
  return multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_MB() * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      /**
       * Saugūs metaduomenys išsaugomi PRIEŠ sprendimą.
       *
       * Multer klaidos objekte (`LIMIT_FILE_SIZE`) MIME tipo nėra, tad be šito
       * atmetimo įvykis liktų be jokios techninės informacijos - kaip ir buvo
       * pirmoje versijoje, kur perduodavom `undefined`.
       *
       * Įrašom TIK MIME: failo vardo ir kelio čia sąmoningai neliečiam.
       */
      req.uploadObservation = { mimetype: file.mimetype };

      if (!isAllowedAudio(file)) {
        return cb(
          new Error(
            `Neleidžiamas failo formatas "${_displaySafeMime(file.mimetype)}" ` +
              `(${safeExtension(file.originalname) || "[neatpažintas]"}). ` +
              "Leidžiami formatai: mp3, wav, m4a, mp4, webm, ogg, aac, flac."
          )
        );
      }
      cb(null, true);
    },
  });
}

module.exports = {
  storage,
  createAudioUpload,
  isAllowedAudio,
  ALLOWED_MIME,
  ALLOWED_EXTENSIONS,
  UPLOAD_NAME_PREFIX,
  MAX_UPLOAD_MB,
};
