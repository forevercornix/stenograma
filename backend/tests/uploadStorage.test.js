const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";

const { storage, isAllowedAudio, UPLOAD_NAME_PREFIX } = require("../utils/uploadStorage");
const { uploadDir } = require("../utils/uploadPath");

/**
 * #13: ĮKĖLIMŲ KONFIGŪRACIJA TURI BŪTI VIENA ABIEM MARŠRUTAMS.
 *
 * Šie testai egzistuoja dėl konkrečios praleistos regresijos: `/api/transcribe`
 * buvo perkeltas ant `uploadDir()` ir `safeExtension()`, o
 * `/api/transcribe-jobs` liko su `os.tmpdir()` ir `path.extname()`. Su nustatytu
 * `UPLOAD_TMP_DIR` asinchroninis kelias rašė kitur, cleanup jį atmesdavo kaip
 * esantį už katalogo ribų, klaida būdavo praryjama, o failas likdavo diske.
 *
 * Maršrutų lygio testai to NEPAGAVO, nes tikrino `UPLOAD_TMP_DIR` tuštumą - o
 * failas ten iš viso nepatekdavo. Tuščias katalogas atrodė kaip sėkmingas
 * valymas. Todėl čia tikrinama pati konfigūracija, o ne jos pasekmė.
 */

function callDestination(env) {
  const saved = process.env.UPLOAD_TMP_DIR;
  if (env === undefined) delete process.env.UPLOAD_TMP_DIR;
  else process.env.UPLOAD_TMP_DIR = env;

  try {
    return new Promise((resolve, reject) => {
      storage.getDestination({}, { originalname: "a.mp3" }, (err, dest) =>
        err ? reject(err) : resolve(dest)
      );
    });
  } finally {
    if (saved === undefined) delete process.env.UPLOAD_TMP_DIR;
    else process.env.UPLOAD_TMP_DIR = saved;
  }
}

function callFilename(originalname) {
  return new Promise((resolve, reject) => {
    storage.getFilename({}, { originalname }, (err, name) => (err ? reject(err) : resolve(name)));
  });
}

test("destination PAISO UPLOAD_TMP_DIR, o ne visada os.tmpdir()", async () => {
  const custom = path.join(os.tmpdir(), "stenograma-custom-dir");

  assert.equal(await callDestination(custom), path.resolve(custom));
  assert.equal(await callDestination(undefined), path.resolve(os.tmpdir()));

  // Sutampa su tuo, ką mato cleanup ir stale valymas - būtent šio sutapimo
  // nebuvo, kai asinchroninis maršrutas rašė į os.tmpdir().
  process.env.UPLOAD_TMP_DIR = custom;
  try {
    assert.equal(await callDestination(custom), uploadDir());
  } finally {
    delete process.env.UPLOAD_TMP_DIR;
  }
});

test("failo vardas generuojamas serveryje ir atitinka valymo šabloną", async () => {
  const name = await callFilename("posedis.mp3");

  assert.ok(name.startsWith(UPLOAD_NAME_PREFIX));
  assert.match(name, /^stenograma-[0-9a-f-]{36}\.mp3$/i);
});

test("plėtinys iš vartotojo vardo praleidžiamas pro whitelist, ne per path.extname", async () => {
  // path.extname() čia grąžintų ".mp3'; rm -rf" pavidalo šiukšles - whitelist ne.
  assert.match(await callFilename("failas.mp3"), /\.mp3$/);
  assert.match(await callFilename("failas.MP3"), /\.mp3$/);
  assert.match(await callFilename("be-pletinio"), /^stenograma-[0-9a-f-]{36}$/i);
  assert.match(await callFilename("x." + "a".repeat(50)), /^stenograma-[0-9a-f-]{36}$/i);
});

test("formato filtras priima audio ir video konteinerius, atmeta kita", () => {
  assert.equal(isAllowedAudio({ mimetype: "audio/mpeg", originalname: "a.mp3" }), true);
  assert.equal(isAllowedAudio({ mimetype: "video/mp4", originalname: "a.mp4" }), true);
  // Bendrinis MIME iš naršyklės - sprendžia plėtinys.
  assert.equal(isAllowedAudio({ mimetype: "application/octet-stream", originalname: "a.wav" }), true);
  assert.equal(isAllowedAudio({ mimetype: "application/pdf", originalname: "a.pdf" }), false);
});

test("STRUKTŪRINĖ SARGYBA: maršrutai nebeturi savo multer.diskStorage", () => {
  /**
   * Grubu, bet tiksliai dengia tai, kas nutiko: abu maršrutai turėjo po atskirą
   * `multer.diskStorage`, ir vienas iš jų nepasivijo pakeitimų. Jei kas nors vėl
   * pridės lokalią konfigūraciją, šis testas kris anksčiau, nei skirtumas taps
   * tylia saugumo spraga.
   */
  for (const route of ["../routes/transcribe.js", "../routes/transcribeJobs.js"]) {
    const source = fs.readFileSync(path.join(__dirname, route), "utf8");

    assert.ok(
      !source.includes("multer.diskStorage"),
      `${route} turi savo diskStorage - naudokite utils/uploadStorage.js`
    );
    assert.ok(
      source.includes("createAudioUpload"),
      `${route} turi naudoti bendrą createAudioUpload()`
    );
  }
});

test("klaidos pranešime NĖRA neapdorotų vartotojo reikšmių", async () => {
  const { createAudioUpload } = require("../utils/uploadStorage");
  const upload = createAudioUpload();

  // IR originalname, IR mimetype ateina iš kliento. Antrasis - laisvai
  // suklastota Content-Type reikšmė, tad jis toks pat nepatikimas kaip vardas.
  const hostile = {
    mimetype: "application/x-evil<script>alert(1)</script>" + "A".repeat(500),
    originalname: "failas." + "B".repeat(300) + "\u0000<img onerror=1>",
  };

  assert.equal(typeof upload.fileFilter, "function", "fileFilter turi būti pasiekiamas");

  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fileFilter neiškvietė callback")), 1000);
    upload.fileFilter({}, hostile, (err) => {
      clearTimeout(timer);
      resolve(err ? err.message : "");
    });
  });

  assert.ok(message, "netinkamas formatas turi duoti klaidą");
  assert.ok(!message.includes("<script>"), "HTML negali patekti į pranešimą");
  assert.ok(!message.includes("<img"), "HTML negali patekti į pranešimą");
  assert.ok(!message.includes("\u0000"), "valdymo simboliai negali patekti į pranešimą");
  assert.ok(!message.includes("B".repeat(50)), "ilgas vartotojo vardas negali patekti į pranešimą");
  assert.ok(message.length < 300, `pranešimas per ilgas: ${message.length}`);
});

test("teisėtas MIME rodomas, neatpažįstamas - pakeičiamas žymeniu", async () => {
  const { createAudioUpload } = require("../utils/uploadStorage");
  const upload = createAudioUpload();

  const shown = (mimetype) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("callback nebuvo")), 1000);
      upload.fileFilter({}, { mimetype, originalname: "x.pdf" }, (err) => {
        clearTimeout(timer);
        const m = err && err.message.match(/formatas "([^"]*)"/);
        resolve(m ? m[1] : null);
      });
    });

  // Teisėtas MIME lieka matomas - be to klaida nebūtų informatyvi.
  assert.equal(await shown("application/pdf"), "application/pdf");
  assert.equal(await shown("APPLICATION/PDF"), "application/pdf");

  // Neatpažįstamas NErodomas iškreiptas: valymas iš
  // "application/x-evil<script>" pagamintų "application/x-evilscript", t. y.
  // MIME tipą, kurio klientas niekada nesiuntė.
  assert.equal(await shown("application/x-evil<script>alert(1)</script>"), "[neatpažintas]");
  assert.equal(await shown("audio/mpeg; boundary=../../etc"), "[neatpažintas]");
  assert.equal(await shown(""), "[neatpažintas]");
  assert.equal(await shown("a".repeat(200) + "/" + "b".repeat(200)), "[neatpažintas]");
});
