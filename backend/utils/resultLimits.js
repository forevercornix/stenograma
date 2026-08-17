/**
 * REZULTATŲ IR ARTEFAKTŲ DYDŽIO RIBOS (#153).
 *
 * Apsauga iki šiol buvo TIK įėjime (`MAX_UPLOAD_MB`, magic bytes,
 * `MAX_AUDIO_DURATION_MIN`). Išėjime jos nebuvo: vienas patologinis tiekėjo
 * atsakymas – haliucinuojantis modelis, sugedęs segmentavimas, cloud ASR su
 * dešimtimis tūkstančių segmentų – tampa dideliu objektu atmintyje, o po #155
 * ir dideliu DB write'u.
 *
 * Ne teorinė rizika: `tiny` modelis lietuvių kalbai jau realiai haliucinavo
 * (README „Realaus audio testas").
 *
 * ⚠️ RIBOS NĖRA VIENODAI „STREAM-SAFE".
 *
 *   `STREAM_BUFFER_BYTES`    – INKREMENTINĖ, RAM apsauga (nebaigtas įvykis)
 *   `STREAM_TOTAL_BYTES`    – INKREMENTINĖ, transporto kvota (NE RAM)
 *   `TRANSCRIPT_BYTES`      – post-response
 *   `TRANSCRIPTION_SEGMENTS`– post-response
 *   `RESULT_BYTES`          – prieš rašymą į store
 *   `DIARIZATION_TURNS`     – post-response
 *
 * Turinio semantinės ribos veikia po pilno payload gavimo, nes nei
 * `/transcribe-stream`, nei `pyannote` HTTP kontraktas turinio inkrementiškai
 * neatiduoda. Serverio pusės inkrementinės ribos – atskiras darbas.
 */

/** Ribos rūšis. Naudojama vietoj klaidos teksto atpažinimo. */
const LIMIT_KIND = Object.freeze({
  /**
   * ✅ RAM APSAUGA: SSE PARSE BUFERIO dydis.
   *
   * Riba taikoma sukauptam SSE parse buferiui IŠKART po kiekvieno dekoduoto
   * chunk'o pridėjimo, dar PRIEŠ išimant pilnus įvykius.
   *
   * ⚠️ MATAVIMAS SĄMONINGAI KONSERVATYVUS: buferyje tuo momentu gali laikinai
   * būti nebaigtas įvykis PLIUS vienas ar keli pilni įvykiai iš to paties
   * chunk'o. Tad riba nėra „vieno įvykio dydis" – ji yra buferio dydis.
   *
   * Ši tvarka pasirinkta tyčia: tikrinti PO pilnų įvykių išėmimo būtų
   * semantiškai grynesnė, bet saugumo prasme silpnesnė – didelis chunk'as jau
   * būtų pilnai sukauptas atmintyje. Tai ankstyviausias realiai įmanomas
   * kontrolės taškas kliento pusėje, tad konservatyvumas čia yra NORIMA
   * savybė, ne netikslumas.
   *
   * Būtent čia RAM auga nekontroliuojamai: patologinis `done` įvykis su
   * 50 000 segmentų vienu JSON būtų sukauptas visas, ir tik po to atsitrenktų
   * į `JSON.parse`.
   *
   * ⚠️ Tai NĖRA transkripcijos dydžio riba. Ji NEPADARO `MAX_SEGMENTS` ar
   * turinio ribų inkrementinėmis – jos lieka post-response.
   */
  STREAM_BUFFER_BYTES: "stream_buffer_bytes",
  /**
   * TRANSPORTO KVOTA, NE RAM apsauga.
   *
   * Kaupiami baitai nuo ryšio pradžios. Neapsaugo atminties (pilni įvykiai
   * pašalinami), bet riboja begalinį srautą – pvz. serverį, kuris siunčia
   * `progress` įvykius amžinai ir niekada nebaigia.
   *
   * ⚠️ Numatyta reikšmė turi būti DOSNI: sveikas 4 val. įrašas su tankiu
   * progresu gali perduoti daug megabaitų vien metaduomenimis. Per griežta
   * kvota nutrauktų normalų darbą.
   */
  STREAM_TOTAL_BYTES: "stream_total_bytes",
  /**
   * ⚠️ POST-RESPONSE. Transkripcijos tekstas.
   *
   * Dabartinis `/transcribe-stream` protokolas segmentus ir tekstą siunčia TIK
   * terminaliame `done` įvykyje (`whisper-server/server.py` kaupia juos
   * serverio pusėje). Tad kliente kaupimo, kurį būtų galima stabdyti, nėra.
   */
  TRANSCRIPT_BYTES: "transcript_bytes",
  /** ⚠️ POST-RESPONSE dėl tos pačios priežasties kaip `TRANSCRIPT_BYTES`. */
  TRANSCRIPTION_SEGMENTS: "transcription_segments",
  /**
   * Serializuoto REZULTATO dydis prieš rašymą į store.
   *
   * Matuojamas TIK `result` payload'as, NE visas job objektas: kitaip riba
   * imtų priklausyti nuo laiko žymų, statuso ir audito laukų, t. y. nuo
   * dalykų, neturinčių nieko bendra su tiekėjo atsakymo dydžiu.
   */
  RESULT_BYTES: "result_bytes",
  /**
   * ⚠️ POST-RESPONSE GUARD, NE ATMINTIES APSAUGA.
   *
   * `pyannote` atsakymas ateina vienu HTTP POST, tad pilnas kūnas jau būna
   * priimtas į RAM, kol turns apskritai galima suskaičiuoti. Ši riba saugo
   * DOWNSTREAM: store, protokolo generavimą ir tolesnį apdorojimą – bet
   * NEapsaugo nuo per didelio HTTP atsakymo atmintyje.
   *
   * Inkrementiniam vykdymui reikėtų streaming diarizacijos protokolo; tai už
   * #153 ribų.
   */
  DIARIZATION_TURNS: "diarization_turns",
});

/**
 * Viena klaidų šeima visiems ribų viršijimams.
 *
 * Struktūrizuota SĄMONINGAI: worker'iui, HTTP sluoksniui ir testams nereikia
 * atpažinti klaidos iš teksto. `kind` leidžia atskirti priežastį nekeičiant
 * `code`, o `limit`/`actual` patenka į logus ir klaidos pranešimą.
 */
class ResultLimitError extends Error {
  constructor({ kind, limit, actual, message }) {
    super(message || `Riba viršyta (${kind}): ${actual} > ${limit}.`);
    this.name = "ResultLimitError";
    this.code = "RESULT_TOO_LARGE";
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
  }
}

/**
 * Sveikas skaičius iš env, arba `fallback`.
 *
 * ⚠️ VALIDUOJAMA VISA EILUTĖ, ne prefiksas. `Number.parseInt` priimtų
 * `"10abc"` → 10, `"1.5"` → 1, `"64MB"` → 64, `"1e6"` → 1. Tai reikštų, kad
 * konfigūracijos klaida tyliai duoda VISIŠKAI kitą ribą nei operatorius
 * manė nustatęs – `MAX_RESULT_BYTES=20MB` taptų 20 baitų.
 *
 * `.env.example` teigia, kad netinkama reikšmė grįžta prie numatytosios;
 * `parseInt` semantika tam neprilygo.
 *
 * SPRENDIMO PAGRINDIMAS (kad vėliau niekas „nepataisytų"):
 * netinkama ribos konfigūracija **fails safe į įmontuotą lubą**, o NE:
 *   – į `0`/`Infinity` (riba dingtų arba viskas viršytų),
 *   – į startup klaidą (tipografinė klaida env faile sustabdytų visą servisą).
 * Pasirinktas prieinamumas su galiojančia luba, ne griežtas fail-fast.
 */
function intFromEnv(name, fallback, env) {
  const raw = (env[name] || "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Numatytos reikšmės yra SAFETY CEILING, ne verslo ribos.
 *
 * Jos turi atmesti patologinius atsakymus, o ne normalius. Realus 4 val.
 * lietuviškas įrašas turi praeiti su atsarga – tai tikrinama regresijos testu.
 * Skaičiai yra pradinis spėjimas, ne galutinė tiesa.
 */
function getLimits(env = process.env) {
  return {
    [LIMIT_KIND.STREAM_BUFFER_BYTES]: intFromEnv("MAX_STREAM_BUFFER_BYTES", 32 * 1024 * 1024, env),
    [LIMIT_KIND.STREAM_TOTAL_BYTES]: intFromEnv("MAX_STREAM_TOTAL_BYTES", 512 * 1024 * 1024, env),
    [LIMIT_KIND.TRANSCRIPT_BYTES]: intFromEnv("MAX_TRANSCRIPT_BYTES", 10 * 1024 * 1024, env),
    [LIMIT_KIND.TRANSCRIPTION_SEGMENTS]: intFromEnv("MAX_SEGMENTS", 100_000, env),
    [LIMIT_KIND.RESULT_BYTES]: intFromEnv("MAX_RESULT_BYTES", 20 * 1024 * 1024, env),
    [LIMIT_KIND.DIARIZATION_TURNS]: intFromEnv("MAX_DIARIZATION_TURNS", 50_000, env),
  };
}

/**
 * TEKSTO dydis UTF-8 baitais.
 *
 * ⚠️ `Buffer.byteLength(..., "utf8")`, NE `String.length`: JS `length` skaičiuoja
 * UTF-16 code unit'us, ne baitus. Lietuviškam tekstui skirtumas realus –
 * `ą`, `ė`, `ž` UTF-8 užima po 2 baitus. Naudojant `.length` riba būtų
 * maždaug dvigubai laisvesnė nei deklaruota, ir tai priklausytų nuo kalbos.
 */
function utf8ByteSize(text) {
  if (text == null) return 0;
  return Buffer.byteLength(String(text), "utf8");
}

/**
 * SERIALIZUOTO objekto dydis UTF-8 baitais.
 *
 * ⚠️ ATSKIRA nuo `utf8ByteSize()` SĄMONINGAI. Bendras helperis, priimantis ir
 * string'ą, ir objektą, matuotų juos SKIRTINGA semantika: `"abc"` kaip tekstas
 * yra 3 baitai, o kaip JSON – 5 (`"abc"` su kabutėmis). Vienas pavadinimas
 * dviem matams anksčiau ar vėliau supainiotų `MAX_TRANSCRIPT_BYTES`
 * (tekstas) su `MAX_RESULT_BYTES` (JSON payload).
 *
 * Ta pati semantika galioja ir memory, ir Redis backend'ams – matuojama
 * serializacija, ne saugyklos vidinis formatas.
 */
function jsonByteSize(value) {
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Meta `ResultLimitError`, jei `actual` viršija ribą. */
function assertWithinLimit(kind, actual, env = process.env) {
  const limit = getLimits(env)[kind];
  if (limit === undefined) {
    throw new TypeError(`assertWithinLimit: nežinoma ribos rūšis: ${String(kind)}`);
  }
  if (actual > limit) {
    throw new ResultLimitError({ kind, limit, actual });
  }
}

/**
 * Rezultato payload'o patikra PRIEŠ rašymą į store.
 *
 * Tikrinamas TIK `result`, ne visas job įrašas – žr. `LIMIT_KIND.RESULT_BYTES`.
 */
function assertResultWithinLimits(result, env = process.env) {
  assertWithinLimit(LIMIT_KIND.RESULT_BYTES, jsonByteSize(result), env);
}

/**
 * Transkripcijos rezultato ribos – NEPRIKLAUSOMAI nuo transporto režimo.
 *
 * ⚠️ Kviečiama IR streaming, IR įprastame `/transcribe` kelyje. Anksčiau
 * patikros buvo tik streaming šakoje, tad su `WHISPER_STREAM_PROGRESS=false`
 * `MAX_TRANSCRIPT_BYTES` ir `MAX_SEGMENTS` neveikdavo visai – ribos elgesys
 * priklausė nuo transporto pasirinkimo, nors dokumentuotos jos kaip bendros
 * rezultatų ribos.
 */
function assertTranscriptionWithinLimits(result, env = process.env) {
  if (!result) return;
  assertWithinLimit(LIMIT_KIND.TRANSCRIPTION_SEGMENTS, (result.segments || []).length, env);
  // TEKSTAS, ne JSON: `MAX_TRANSCRIPT_BYTES` riboja transkripcijos turinį.
  assertWithinLimit(LIMIT_KIND.TRANSCRIPT_BYTES, utf8ByteSize(result.text), env);
}

module.exports = {
  LIMIT_KIND,
  ResultLimitError,
  getLimits,
  utf8ByteSize,
  jsonByteSize,
  assertWithinLimit,
  assertResultWithinLimits,
  assertTranscriptionWithinLimits,
};
