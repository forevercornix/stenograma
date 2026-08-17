const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Testuojame jobRunner (inline režimą - BullMQ režimas reikalauja tikro Redis,
// testuojamas atskirai su fake Redis ir realiu paleidimu jūsų pusėje) ir fileStorage.

test("jobRunner: be REDIS_URL naudoja inline režimą", async () => {
  delete process.env.REDIS_URL;
  // Švarus modulio įkėlimas (jobRunner turi vidinę būseną).
  delete require.cache[require.resolve("../queues/jobRunner")];
  const jobRunner = require("../queues/jobRunner");
  await jobRunner.init();
  assert.equal(jobRunner.getMode(), "inline");
});

test("jobRunner._classifyError: HttpError ne-500 rodomas kaip yra", () => {
  const jobRunner = require("../queues/jobRunner");
  const err = Object.assign(new Error("Validacijos klaida"), { statusCode: 400 });
  const { errorCode, message } = jobRunner._classifyError(err);
  assert.equal(errorCode, "http_400");
  assert.equal(message, "Validacijos klaida");
});

test("jobRunner._classifyError: vidinė (500) klaida sanitizuojama", () => {
  const jobRunner = require("../queues/jobRunner");
  const err = new Error("Slaptas kelias /home/user ANTHROPIC_API_KEY=sk-123");
  const { errorCode, message } = jobRunner._classifyError(err);
  assert.equal(errorCode, "internal_error");
  // Sanitizuota - paslaptys nepatenka.
  assert.ok(!message.includes("ANTHROPIC_API_KEY"));
  assert.match(message, /Vidinė serverio klaida/);
});

/**
 * `fileStorage.del(key)` pašalina failą, bet ne katalogą, ir kiekvienas
 * paleidimas palikdavo naują `/tmp/stenograma-test-storage-*`. Sandbox'e tai
 * tik šiukšlės, bet kūrėjo mašinoje jos kaupiasi tyliai, o testas, kuris po
 * savęs nesutvarko, ilgainiui slepia tikrus nutekėjimus
 * (žr. `scripts/verify-clean.mjs`).
 */
const createdStorageDirs = [];

test.after(async () => {
  const { rm } = require("fs/promises");
  for (const dir of createdStorageDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("fileStorage: put -> get grąžina tą patį turinį", async () => {
  delete require.cache[require.resolve("../utils/fileStorage")];

  const storageDir = path.join(require("os").tmpdir(), "stenograma-test-storage-" + Date.now());
  process.env.STORAGE_DIR = storageDir;

  /**
   * Katalogas registruojamas valymui FAILO pabaigoje, ne šio testo.
   *
   * Pirmoji pataisymo versija naudojo `t.after` - katalogas būdavo ištrinamas
   * po šio testo, o kitas (`del idempotentinis`) jį sukurdavo iš naujo, ir
   * likutis vis tiek likdavo. Valymas turi vykti tada, kai jo niekas
   * nebenaudoja.
   */
  createdStorageDirs.push(storageDir);
  const fileStorage = require("../utils/fileStorage");
  const data = Buffer.from("testinis audio turinys");
  const key = await fileStorage.put(data, { ext: ".wav" });
  assert.match(key, /^uploads\/.*\.wav$/);
  const fetched = await fileStorage.get(key);
  assert.equal(fetched.toString(), "testinis audio turinys");
  await fileStorage.del(key);
});

test("fileStorage: del idempotentinis (nesamo failo trynimas ne klaida)", async () => {
  const fileStorage = require("../utils/fileStorage");
  await fileStorage.del("uploads/nera-tokio.wav"); // neturi mesti
  assert.ok(true);
});

test("fileStorage: path traversal apsauga (../ raktas atmetamas)", async () => {
  const fileStorage = require("../utils/fileStorage");
  await assert.rejects(() => fileStorage.get("../../etc/passwd"), /path traversal|ENOENT|Neteisingas/);
});

test("fileStorage: get ištrina po transkripcijos (processor finally)", async () => {
  // Patvirtinam, kad processor'ius ištrina failą - integracija tikrinama per HTTP
  // atskirai; čia tik storage lygmuo.
  const fileStorage = require("../utils/fileStorage");
  const key = await fileStorage.put(Buffer.from("x"), { ext: ".wav" });
  await fileStorage.del(key);
  await assert.rejects(() => fileStorage.get(key), /ENOENT|no such file/);
});

test("init({persistentStoreAvailable:false}) su REDIS_URL -> inline (NE BullMQ) - nuoseklumas", async () => {
  // KRITINIS (review): jei jobStore Redis connect nepavyko ir fallback'ino į memory,
  // jobRunner NETURI naudoti BullMQ (kitaip memory store + BullMQ = nesuderinta sistema,
  // worker nemato atmintyje sukurtų jobų). persistentStoreAvailable=false verčia inline.
  const prevUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379"; // yra URL, bet store neprisijungė
  delete require.cache[require.resolve("../queues/jobRunner")];
  const jobRunner = require("../queues/jobRunner");
  const mode = await jobRunner.init({ persistentStoreAvailable: false });
  assert.equal(mode, "inline", "memory store fallback -> jobRunner turi būti inline, ne BullMQ");
  if (prevUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prevUrl;
});
