const test = require("node:test");
const assert = require("node:assert/strict");

const jobStore = require("../utils/jobStore");

/**
 * BACKEND'O PARINKIMAS IR AKTYVAVIMO BARJERAS (#155, 7.2a).
 *
 * ⚠️ ŠIEMS TESTAMS DB NEREIKIA SĄMONINGAI. Tikrinama POLITIKA - kuris
 * backend'as būtų parinktas kuriam env deriniui - o ne saugyklos elgesys.
 * Prijungus tikrą DB testas taptų priklausomas nuo infrastruktūros ir
 * nebeveiktų būtent tuo atveju, kurį svarbiausia patikrinti: kad
 * `DATABASE_URL` NIEKO neperjungia.
 */

const { resolveBackendChoice, applyActivationBarrier } = jobStore;

const REDIS = "redis://localhost:6379";
const PG = "postgres://localhost:5432/steno";

test("parinkimas: DATABASE_URL > REDIS_URL > memory", () => {
  assert.equal(resolveBackendChoice({}).norimas, "memory");
  assert.equal(resolveBackendChoice({ REDIS_URL: REDIS }).norimas, "redis");
  assert.equal(resolveBackendChoice({ DATABASE_URL: PG }).norimas, "postgres");
  assert.equal(
    resolveBackendChoice({ DATABASE_URL: PG, REDIS_URL: REDIS }).norimas,
    "postgres",
    "DATABASE_URL turi turėti pirmenybę"
  );
});

test("parinkimas: JOB_STORE_BACKEND perrašo išvedimą", () => {
  assert.equal(
    resolveBackendChoice({ JOB_STORE_BACKEND: "memory", DATABASE_URL: PG, REDIS_URL: REDIS }).norimas,
    "memory"
  );
  assert.equal(
    resolveBackendChoice({ JOB_STORE_BACKEND: "redis", DATABASE_URL: PG }).norimas,
    "redis"
  );
});

test("parinkimas: nežinomas JOB_STORE_BACKEND yra klaida, ne tylus fallback", () => {
  /**
   * ⚠️ Rašybos klaida (`postgress`) neturi tyliai virsti in-memory režimu:
   * operatorius manytų, kad job'ai išgyvena restartą, o jie neišgyventų.
   */
  assert.throws(
    () => resolveBackendChoice({ JOB_STORE_BACKEND: "postgress" }),
    /JOB_STORE_BACKEND/
  );
});

test("BARJERAS: DATABASE_URL vienas NEPERJUNGIA srauto į PostgreSQL", () => {
  /**
   * ⚠️ ESMINIS 7.2a TESTAS. `postgresStore` yra įgyvendintas, bet ADR
   * aktyvavimo barjeras reikalauja patikrinto restore (7.6), persistentinių
   * ištrynimo žymų (7.5a) ir sąlyginio transakcinio užbaigimo (7.5b). Iki tol
   * `DATABASE_URL` (kurio gali prireikti 7.3 sesijoms ar 7.4 auditui) neturi
   * perjungti job metaduomenų į negrįžtamą režimą.
   */
  const env = { DATABASE_URL: PG };
  const rezultatas = applyActivationBarrier(resolveBackendChoice(env), env);
  assert.equal(rezultatas.norimas, "memory");
});

test("BARJERAS: DATABASE_URL + REDIS_URL palieka esamą Redis elgesį NEPAKITUSĮ", () => {
  const env = { DATABASE_URL: PG, REDIS_URL: REDIS };
  const rezultatas = applyActivationBarrier(resolveBackendChoice(env), env);
  assert.equal(rezultatas.norimas, "redis");
});

test("BARJERAS: eksplicitinis JOB_STORE_BACKEND=postgres yra KLAIDA, ne įspėjimas", () => {
  /**
   * Numanomas `DATABASE_URL` gali reikšti „reikia DB sesijoms"; eksplicitinis
   * nurodymas reiškia tik viena. Jį ignoruoti tyliai būtų blogiau nei kristi.
   */
  assert.throws(
    () => applyActivationBarrier(resolveBackendChoice({ JOB_STORE_BACKEND: "postgres" }), {}),
    /aktyvavimo barjeras|barjeras/i
  );
});

test("BARJERAS: memory ir redis pasirinkimai praeina nepakitę", () => {
  for (const env of [{}, { REDIS_URL: REDIS }, { JOB_STORE_BACKEND: "memory" }]) {
    const pries = resolveBackendChoice(env);
    assert.equal(applyActivationBarrier(pries, env).norimas, pries.norimas);
  }
});

test("EILĖ: hasQueueBackend() eksportuojamas ir nepriklauso nuo getBackend()", () => {
  /**
   * ⚠️ `server.js` anksčiau įjungdavo BullMQ tik kai
   * `jobStore.getBackend() === "redis"`. Pasirinkus PostgreSQL metaduomenims,
   * vykdymas nukristų į inline režimą NORS REDIS VEIKIA: sukurti eilės job'ai
   * liktų nesuvartoti, o naujas darbas taptų nepatvarus.
   */
  assert.equal(typeof jobStore.hasQueueBackend, "function");

  const be = { ...process.env };
  delete process.env.REDIS_URL;
  try {
    assert.equal(jobStore.hasQueueBackend(), false, "be REDIS_URL eilės nėra");
  } finally {
    Object.assign(process.env, be);
  }
});
