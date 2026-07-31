const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";

const {
  uploadDir,
  safeExtension,
  isInsideUploadDir,
  assertInsideUploadDir,
} = require("../utils/uploadPath");

/**
 * GDPR #13 / CodeQL js/path-injection.
 *
 * `req.file.path` sudaro multer, tad tiesioginė rizika maža - bet vienintelė
 * VARTOTOJO valdoma kelio dalis (`path.extname(originalname)`) iki šiol keliavo
 * į failo vardą be jokios patikros. Testai fiksuoja abi puses: kad plėtinys
 * ribojamas, ir kad kiekviena failo operacija reikalauja kelio kataloge.
 */

test("plėtinys iš vartotojo failo vardo praleidžiamas pro whitelist", () => {
  assert.equal(safeExtension("posedis.mp3"), ".mp3");
  assert.equal(safeExtension("POSEDIS.WAV"), ".wav");
  assert.equal(safeExtension("archyvas.tar.gz"), ".gz");

  // Nieko panašaus į plėtinį - failas lieka be jo, o ne su šiukšlėmis varde.
  assert.equal(safeExtension("be-pletinio"), "");
  assert.equal(safeExtension(""), "");
  assert.equal(safeExtension(null), "");
  assert.equal(safeExtension("kenkejas.eee/../../etc/passwd"), "");
  assert.equal(safeExtension("x." + "a".repeat(50)), "", "per ilgas plėtinys atmetamas");
});

test("plėtinyje niekada nelieka skirtukų ar valdymo simbolių", () => {
  // Null baitas gyvena STEM'e, ne plėtinyje: path.extname("failas.mp3\0.exe")
  // grąžina ".exe", o stem'as išmetamas - failas gula kaip stenograma-<uuid>.exe.
  // Todėl tikrinam ne "ar atmesta", o TIKRĄJĄ savybę: kas lieka varde.
  const hostile = [
    "failas.mp3\u0000.exe",
    "a/b/c.mp3",
    "..%2f..%2fetc.mp3",
    "failas.mp3;rm -rf /",
    "failas.\u0000",
  ];

  for (const name of hostile) {
    const ext = safeExtension(name);
    assert.ok(!ext.includes("\u0000"), `${JSON.stringify(name)} -> null baitas varde`);
    assert.ok(!ext.includes("/") && !ext.includes("\\"), `${JSON.stringify(name)} -> skirtukas varde`);
    assert.ok(/^(\.[a-z0-9]{1,8})?$/.test(ext), `${JSON.stringify(name)} -> netinkamas plėtinys: ${ext}`);
  }
});

test("kelias UŽ įkėlimų katalogo ribų atmetamas", () => {
  const outside = [
    "/etc/passwd",
    path.join(uploadDir(), "..", "pabegimas.mp3"),
    path.join(uploadDir(), "..", "..", "etc", "shadow"),
  ];

  for (const candidate of outside) {
    assert.equal(isInsideUploadDir(candidate), false, `${candidate} turėjo būti atmestas`);
    assert.throws(() => assertInsideUploadDir(candidate), (e) => e.code === "UPLOAD_PATH_FORBIDDEN");
  }
});

test("kaimyninis katalogas su TUO PAČIU prefiksu neapgauna patikros", () => {
  // Klasikinė klaida: startsWith(dir) vieno neužtenka, nes "/tmp/uploads-evil"
  // prasideda "/tmp/uploads".
  const sibling = uploadDir() + "-evil/failas.mp3";

  assert.equal(isInsideUploadDir(sibling), false);
  assert.throws(() => assertInsideUploadDir(sibling), (e) => e.code === "UPLOAD_PATH_FORBIDDEN");
});

test("pats katalogas nėra leistinas kelias (tik failai jo viduje)", () => {
  assert.equal(isInsideUploadDir(uploadDir()), false);
});

test("teisėtas multer sugeneruotas kelias praeina", () => {
  const legit = path.join(uploadDir(), "stenograma-3f2b1a.mp3");

  assert.equal(isInsideUploadDir(legit), true);
  assert.equal(assertInsideUploadDir(legit), legit);
});

test("klaida NEATSKLEIDŽIA paties kelio pranešime", () => {
  const secret = path.join(os.tmpdir(), "..", "slaptas-kelias-xyz");

  try {
    assertInsideUploadDir(secret);
    assert.fail("turėjo mesti");
  } catch (e) {
    assert.ok(!e.message.includes("slaptas-kelias-xyz"), "kelias keliautų į klientą ir logus");
  }
});

test("UPLOAD_TMP_DIR keičia leidžiamą katalogą", () => {
  const saved = process.env.UPLOAD_TMP_DIR;
  process.env.UPLOAD_TMP_DIR = path.join(os.tmpdir(), "stenograma-custom");

  try {
    assert.equal(isInsideUploadDir(path.join(os.tmpdir(), "stenograma-custom", "a.mp3")), true);
    assert.equal(isInsideUploadDir(path.join(os.tmpdir(), "a.mp3")), false);
  } finally {
    if (saved === undefined) delete process.env.UPLOAD_TMP_DIR;
    else process.env.UPLOAD_TMP_DIR = saved;
  }
});

/**
 * SYMLINK ESCAPE (#13: "Symlink-based escape is prevented").
 *
 * Tekstinė patikra čia bejėgė: kelias `<upload>/stenograma-x.mp3` YRA įkėlimų
 * kataloge, tad `path.resolve` jį praleidžia - net jei tai nuoroda į /etc/passwd.
 */

const fsp = require("fs/promises");
const { resolveExistingUploadPath, UploadPathError } = require("../utils/uploadPath");

async function withUploadDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-upload-test-"));
  const saved = process.env.UPLOAD_TMP_DIR;
  process.env.UPLOAD_TMP_DIR = dir;

  try {
    return await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.UPLOAD_TMP_DIR;
    else process.env.UPLOAD_TMP_DIR = saved;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("simbolinė nuoroda IŠ įkėlimų katalogo į išorę atmetama", async () => {
  await withUploadDir(async (dir) => {
    const secret = path.join(os.tmpdir(), `stenograma-slaptas-${Date.now()}.txt`);
    await fsp.writeFile(secret, "paslaptis");

    const link = path.join(dir, "stenograma-atrodo-nekaltai.mp3");
    await fsp.symlink(secret, link);

    // Tekstinė patikra nuorodą praleidžia - būtent todėl jos neužtenka.
    assert.equal(isInsideUploadDir(link), true);

    await assert.rejects(
      () => resolveExistingUploadPath(link),
      (e) => e instanceof UploadPathError && e.code === "UPLOAD_PATH_FORBIDDEN"
    );

    await fsp.rm(secret, { force: true });
  });
});

test("tikras failas įkėlimų kataloge praeina realpath patikrą", async () => {
  await withUploadDir(async (dir) => {
    const real = path.join(dir, "stenograma-tikras.mp3");
    await fsp.writeFile(real, "audio");

    const resolved = await resolveExistingUploadPath(real);
    assert.equal(resolved, await fsp.realpath(real));
  });
});

test("nesamas failas grąžina null, ne klaidą (cleanup jau įvyko)", async () => {
  await withUploadDir(async (dir) => {
    assert.equal(await resolveExistingUploadPath(path.join(dir, "nera.mp3")), null);
  });
});

test("nuoroda į failą TO PATIES katalogo viduje lieka leistina", async () => {
  await withUploadDir(async (dir) => {
    const target = path.join(dir, "stenograma-tikslas.mp3");
    await fsp.writeFile(target, "audio");

    const link = path.join(dir, "stenograma-nuoroda.mp3");
    await fsp.symlink(target, link);

    // Apsauga skirta PABĖGIMUI, ne nuorodoms apskritai - kitaip ji būtų
    // platesnė nei problema.
    assert.equal(await resolveExistingUploadPath(link), await fsp.realpath(target));
  });
});
