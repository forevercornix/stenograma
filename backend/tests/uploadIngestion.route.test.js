const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

/**
 * #13 DoD: priėmimo kelio testai.
 *
 * Dengia punktus, kurių unit lygio `uploadPath.test.js` nepasiekia:
 * per didelis failas, MIME neatitikimas, nesaugus failo vardas, ir - svarbiausia -
 * kad laikinas failas dingsta IR po sėkmės, IR po klaidos.
 *
 * Katalogas izoliuotas (`UPLOAD_TMP_DIR`), tad tuštumą galima tikrinti tiesiogiai,
 * nesivaržant su lygiagrečiai veikiančiais testais bendrame /tmp.
 */

const UPLOAD_DIR = path.join(os.tmpdir(), `stenograma-ingest-${process.pid}`);

process.env.NODE_ENV = "test";
process.env.UPLOAD_TMP_DIR = UPLOAD_DIR;
process.env.MAX_UPLOAD_MB = "1";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.API_KEY = "";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests();

/** Minimalus WAV su teisinga RIFF/WAVE antrašte - praeina magic bytes patikrą. */
function wavBuffer(bytes = 2048) {
  const buf = Buffer.alloc(bytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  return buf;
}

async function uploadDirEntries() {
  try {
    return await fs.readdir(UPLOAD_DIR);
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Cleanup vyksta `finally` bloke - PO to, kai atsakymas jau išsiųstas (taip
 * klientas nelaukia trynimo). Todėl tikrinama "galiausiai tuščias", o ne
 * "tuščias tą pačią milisekundę": pirmoji šio testo versija tikrino iš karto ir
 * krito dėl lenktynių, ne dėl klaidos kode.
 */
async function assertUploadDirEmpty(message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let entries = await uploadDirEntries();

  while (entries.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    entries = await uploadDirEntries();
  }

  assert.deepEqual(entries, [], message);
}

test.before(async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
});

test.after(async () => {
  await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
});

test("per didelis failas atmetamas (MAX_UPLOAD_MB centralizuotai)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", wavBuffer(2 * 1024 * 1024), { filename: "didelis.wav", contentType: "audio/wav" });

  assert.equal(res.status, 400);
  await assertUploadDirEmpty("atmestas įkėlimas neturi palikti failo");
});

test("MIME sako audio, turinys - ne: atmetama (naršyklės MIME nėra vienintelis mechanizmas)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.from("Tai paprastas tekstas, o ne garso failas."), {
      filename: "apsimeta.wav",
      contentType: "audio/wav",
    });

  assert.equal(res.status, 400);
  await assertUploadDirEmpty("cleanup turi įvykti IR po validacijos klaidos");
});

test("nesaugus failo vardas nepatenka į saugojimo kelią", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", wavBuffer(), {
      filename: "../../../etc/passwd.wav",
      contentType: "audio/wav",
    });

  assert.equal(res.status, 200);

  // Vardas serveryje generuojamas (UUID), originalus - tik metaduomuo.
  await assertUploadDirEmpty("po sėkmės failas irgi pašalinamas");
});

test("koduotas traversal failo varde nepakeičia katalogo", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", wavBuffer(), {
      filename: "..%2f..%2fetc%2fpasswd.wav",
      contentType: "audio/wav",
    });

  assert.equal(res.status, 200);
  await assertUploadDirEmpty("koduotas vardas nekeičia cleanup elgsenos");
});

test("sėkmingas įkėlimas nepalieka laikino failo", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", wavBuffer(), { filename: "posedis.wav", contentType: "audio/wav" });

  assert.equal(res.status, 200);
  assert.ok(res.body.text || res.body.segments, "mock provideris turi grąžinti rezultatą");
  await assertUploadDirEmpty("no-persistence: po gyvavimo ciklo nelieka artefaktų");
});

test("klaidos pranešime nėra vietinės failų sistemos kelio", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.from("ne audio"), { filename: "blogas.wav", contentType: "audio/wav" });

  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(UPLOAD_DIR), "įkėlimų katalogas negali nutekėti į atsakymą");
  assert.ok(!body.includes(os.tmpdir()), "joks vietinis kelias negali patekti į atsakymą");
});

test("asinchroninis maršrutas elgiasi VIENODAI (tas pats cleanup)", async (t) => {
  /**
   * SVARBU: vien "katalogas tuščias" NEĮRODO nieko - jei maršrutas rašo į KITĄ
   * katalogą, šis irgi bus tuščias. Būtent taip ankstesnė šio testo versija
   * praėjo tuščiai, kol /api/transcribe-jobs rašė į os.tmpdir().
   *
   * Todėl papildomai perimamas console.warn: nepavykęs cleanup dabar palieka
   * įspėjimą (utils/uploadPath.js safeUnlinkUpload), o jo nebuvimas reiškia,
   * kad failas REALIAI buvo rastas ir pašalintas.
   */
  const warnings = [];
  // t.mock.method, o NE rankinis priskyrimas: node:test atstato jį automatiškai
  // net jei testas nutrūksta anksčiau. Rankinis `console.warn = originalWarn`
  // testo gale po klaidos taip ir neįvyktų, o globalus console liktų pakeistas
  // kitiems testams tame pačiame procese.
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));

  const ok = await request(app)
    .post("/api/transcribe-jobs")
    .attach("audio", wavBuffer(), { filename: "posedis.wav", contentType: "audio/wav" });

  assert.equal(ok.status, 202);
  await assertUploadDirEmpty("transcribe-jobs irgi neturi palikti laikino failo");

  const rejected = await request(app)
    .post("/api/transcribe-jobs")
    .attach("audio", Buffer.from("ne audio"), { filename: "blogas.wav", contentType: "audio/wav" });

  assert.equal(rejected.status, 400);
  await assertUploadDirEmpty("atmestas asinchroninis įkėlimas irgi valomas");

  assert.deepEqual(
    warnings.filter((w) => w.includes("Nepavyko pašalinti laikino įkėlimo failo")),
    [],
    "cleanup neturi tyliai nepavykti - tai buvo ankstesnės regresijos slėptuvė"
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LAUKŲ VARDŲ RIBOS (`multer` 2.3.0, `GHSA-wc9g-mqfw-jrwm` ir kt.)
 *
 * ⚠️ KODĖL TESTAS, O NE VIEN ATNAUJINIMAS.
 *
 * `multer` 2.3.0 uždarė patį crash'ą, bet trys ištekliaus ribos liko OPT-IN:
 * `make-middleware.js` jas tikrina tik `hasOwnProperty` sąlygoje, o `index.js`
 * numatytųjų nesudeda. Vadinasi konfigūracija ir sauga čia yra tas pats daiktas,
 * ir be testo `AUDIO_LIMITS` galėtų būti tyliai pašalintas ar perrašytas —
 * `npm audit` liktų žalias, nes biblioteka atnaujinta.
 *
 * Tikrinama per TIKRĄ maršrutą, ne per `multer()` objektą: klausimas yra, ar
 * ribos pasiekia produkcinį kelią, o ne ar objektas turi lauką.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { AUDIO_LIMITS } = require("../utils/uploadStorage");

test("per ilgas lauko vardas ATMETAMAS, procesas nekrenta", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .field("a".repeat(AUDIO_LIMITS.fieldNameSize + 1), "x")
    .attach("audio", wavBuffer(), { filename: "posedis.wav", contentType: "audio/wav" });

  /**
   * ⚠️ TIKRINAMAS PRANEŠIMAS, NE VIEN `400` (rasta mutacija).
   *
   * Pirma šio testo redakcija tvirtino tik statusą — ir mutacijos raunde
   * (`AUDIO_LIMITS` pašalintas) brolinis testas su `a[0][0][0]` VIS TIEK
   * praeidavo: nežinomą lauką atmesdavo schemos sluoksnis su
   * `VALIDATION_FAILED`, visai kitoje vietoje ir dėl visai kitos priežasties.
   * Testas žaliavo be jokios multer ribos. Pranešimas atskiria sluoksnius.
   */
  assert.equal(res.status, 400, "riba privalo suveikti maršrute, ne tik konfigūracijoje");
  assert.equal(res.body.error, "Field name too long", "atmesta ne multer riba, o kažkas kitas");
  await assertUploadDirEmpty("atmestas įkėlimas irgi valomas");
});

test("laužtiniai skliaustai lauko varde ATMETAMI (`fieldNestingDepth: 0`)", async () => {
  /**
   * ⚠️ BŪTENT ŠIS VEKTORIUS KELDAVO `RangeError`. 2.3.0 jį paverčia klaida, o ne
   * proceso nutraukimu; riba padaro, kad iki `appendField` apskritai nebūtų
   * einama. Tikrinamos ABI dalys, nes atnaujinimas be ribos praeitų vien pirmą.
   */
  const res = await request(app)
    .post("/api/transcribe")
    .field("a[0][0][0]", "x")
    .attach("audio", wavBuffer(), { filename: "posedis.wav", contentType: "audio/wav" });

  assert.equal(res.status, 400);
  assert.equal(
    res.body.error,
    "Field name nesting too deep",
    "be šito tvirtinimo testas praeina ir BE ribos — atmeta schemos sluoksnis"
  );
});

test("KONTROLĖ: teisėti laukai (`language`, `diarize`) ir toliau PRAEINA", async () => {
  /**
   * ⚠️ Be jos visos ribos galėtų būti „atmesk viską", ir du testai aukščiau
   * praeitų nieko neįrodę. Šie du laukai yra tiksliai tai, ką siunčia frontend'as
   * (`stenogramaApi.js`), tad kontrolė matuoja realų kelią, ne sugalvotą.
   */
  const res = await request(app)
    .post("/api/transcribe")
    .field("language", "lt")
    .field("diarize", "false")
    .attach("audio", wavBuffer(), { filename: "posedis.wav", contentType: "audio/wav" });

  assert.equal(res.status, 200, "įprasta forma privalo veikti — kitaip riba sulaužė produktą");
});

test("KONTROLĖ: ribos TIKRAI perduodamos multer'iui, ne tik apibrėžtos", () => {
  /**
   * ⚠️ TRYS OPT-IN RIBOS IŠVARDIJAMOS EKSPLICITIŠKAI. Bendras „limits nėra
   * tuščias" praeitų ir tada, jei liktų vien `fileSize` — t. y. tiksliai
   * ankstesnė būsena, kurios ši eilutė ir netenkina.
   */
  const { createAudioUpload } = require("../utils/uploadStorage");
  const limits = createAudioUpload().limits;

  for (const raktas of ["fieldNameSize", "fieldNestingDepth", "fieldArrayIndexLimit", "fields", "files", "parts"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(limits, raktas),
      `\`${raktas}\` neperduota — multer patikros be jos NEVYKDO`
    );
  }

  assert.ok(limits.fileSize > 0, "`fileSize` negali dingti pridedant naujas ribas");
});
