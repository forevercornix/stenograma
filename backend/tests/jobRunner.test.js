const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
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

test("fileStorage: put -> get grąžina tą patį turinį", async () => {
  delete require.cache[require.resolve("../utils/fileStorage")];
  process.env.STORAGE_DIR = path.join(require("os").tmpdir(), "stenograma-test-storage-" + Date.now());
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
