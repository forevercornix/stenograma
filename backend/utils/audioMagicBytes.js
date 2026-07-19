/**
 * Failo pavadinimą/plėtinį lengva pakeisti (pvz. `virus.exe` -> `irasas.mp3`),
 * todėl vien MIME/plėtinio patikra (routes/transcribe.js fileFilter) yra
 * apeinama. Ši funkcija papildomai tikrina failo TURINIO pradžią (magic bytes /
 * file signature) prieš siunčiant jį bet kuriam išoriniam tiekėjui.
 *
 * SĄŽININGAS APRIBOJIMAS: tai signatures-based sniffing, NE pilnas antivirusinis
 * turinio skenavimas (ClamAV ir pan.) ir NE garantija, kad failas yra tvarkingas/
 * dekoduojamas audio įrašas - tik kad jo pradžia atitinka žinomą audio formato
 * signature. Piktybinis turinys, įterptas TOLIAU faile po teisingos antraštės,
 * šitaip nebūtų aptiktas - tam reikėtų realaus antivirus/sandbox skenavimo.
 */
function detectAudioMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // MP3: "ID3" žyma arba MPEG frame sync (11 vienetukų bitų)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return "mp3";
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "mp3";

  // WAV: "RIFF"...."WAVE"
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return "wav";
  }

  // OGG
  if (buffer.toString("ascii", 0, 4) === "OggS") return "ogg";

  // FLAC
  if (buffer.toString("ascii", 0, 4) === "fLaC") return "flac";

  // MP4/M4A (ISO base media file format): bitai 4-8 == "ftyp"
  if (buffer.length >= 8 && buffer.toString("ascii", 4, 8) === "ftyp") return "mp4";

  // WebM/Matroska (EBML header)
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "webm";

  // AAC (ADTS sync word)
  if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return "aac";

  return null;
}

module.exports = { detectAudioMagic };
