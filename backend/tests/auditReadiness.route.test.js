const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
delete process.env.REDIS_URL;

const request = require("supertest");
const auditStore = require("../utils/auditStore");
const app = require("../server");

/**
 * AUDITO READINESS IR LIVENESS (#155, 7.4f / #231).
 *
 * ⚠️ SKIRTUMAS TARP READY IR LIVE ČIA NĖRA DETALĖ.
 *
 * `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` egzistuoja tam, kad
 * operatorius galėtų PALEISTI sistemą, kurios raktų medžiaga prarasta, ir
 * išvalyti paveiktas eilutes. Jei kartu kristų ir liveness, orkestruotojas
 * perkraudinėtų podą cikle, tas atsistatymo langas niekada neatsivertų, ir
 * vėliavėlė būtų PANEIGTA.
 */

test.beforeEach(() => app._setReadyForTests(true));
test.afterEach(() => app._setReadyForTests(true));

test("READY: `auditStore` starto vėliava įtraukta - be jos 503", async () => {
  /**
   * Iki 7.4f `/api/ready` tikrino tik `jobStore && jobRunner &&
   * sessionReconcile`. Kritus `auditStore.init()` serveris grąžindavo 200 ir
   * priimdavo srautą - fail-closed audito apsauga būdavo apeinama būtent
   * readiness lygyje.
   */
  const geras = await request(app).get("/api/ready");
  assert.equal(geras.status, 200, "prielaida: viskas paruošta");
  assert.equal(geras.body.components.auditStore, true, "komponentas privalo būti matomas");

  app._setReadyForTests(true);
  app._setAuditReadyForTests(false);

  const blogas = await request(app).get("/api/ready");

  assert.equal(blogas.status, 503, "be audito saugyklos instancija NĖRA paruošta");
  assert.equal(blogas.body.ready, false);
  assert.equal(blogas.body.components.auditStore, false);
});

test("LIVENESS: `/api/health` LIEKA 200, kai readiness krinta dėl audito", async () => {
  /**
   * ⚠️ TIKRINAMA TAME PAČIAME SCENARIJUJE, ne atskirai.
   *
   * Du testai skirtingose būsenose praeitų ir tada, kai liveness krinta kartu -
   * tiesiog jie to nepamatytų. Būtent vienalaikiškumas ir yra reikalavimas.
   */
  app._setAuditReadyForTests(false);

  const ready = await request(app).get("/api/ready");
  const health = await request(app).get("/api/health");

  assert.equal(ready.status, 503, "readiness privalo kristi");
  assert.equal(health.status, 200, "liveness privalo LIKTI - kitaip podas perkraunamas cikle");
  assert.equal(health.body.status, "ok");
});

test("READY: neišsprendžiamos generacijos → 503, nors procesas pakilo", async () => {
  /**
   * ⚠️ VĖLIAVĖLĖ LEIDŽIA STARTUOTI, NE DEKLARUOTI SVEIKATĄ.
   *
   * Su `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` `init()` pavyksta, bet
   * dalies įrašų `removeBySubjectIdentifier()` nebepasiekia. Instancija negali
   * būti laikoma paruošta srautui, kuris generuoja dar daugiau audito.
   */
  const originalus = auditStore.nasliaitesGeneracijos;
  auditStore.nasliaitesGeneracijos = () => ["2026-05"];

  try {
    const ready = await request(app).get("/api/ready");
    const health = await request(app).get("/api/health");

    assert.equal(ready.status, 503, "neišsprendžiamos generacijos reiškia NEPARUOŠTA");
    assert.equal(ready.body.components.auditKeysResolvable, false);

    /** ⚠️ IR TUO PAČIU METU liveness lieka - žr. failo antraštę. */
    assert.equal(health.status, 200, "liveness negali kristi kartu");
  } finally {
    auditStore.nasliaitesGeneracijos = originalus;
  }
});

test("READY: sugedęs audito zondas → 503, o liveness nepaliestas", async () => {
  /**
   * Starto vėliava yra vienkartinė. DB kritimas ar teisių atėmimas PO starto ja
   * nesimato, tad readiness privalo turėti GYVĄ zondą.
   */
  const originalus = auditStore.probe;
  auditStore.probe = async () => false;

  try {
    const ready = await request(app).get("/api/ready");
    const health = await request(app).get("/api/health");

    assert.equal(ready.status, 503, "zondas, grąžinęs `false`, reiškia NEPARUOŠTA");
    assert.equal(ready.body.components.auditStoreReachable, false);
    assert.equal(health.status, 200);
  } finally {
    auditStore.probe = originalus;
  }
});

test("READY: kabantis audito zondas NEPAKABINA `/api/ready`", async () => {
  /**
   * Readiness privalo atsakyti VISADA - net kai priklausomybė kabo. Be ribos
   * orkestruotojas vietoj aiškaus 503 gautų timeout, o konteineris liktų
   * „tikrinamas" būsenoje.
   */
  const originalus = auditStore.probe;
  auditStore.probe = () => new Promise(() => {});

  const savedRiba = process.env.READINESS_TIMEOUT_MS;
  process.env.READINESS_TIMEOUT_MS = "150";

  try {
    const pradzia = Date.now();
    const res = await request(app).get("/api/ready");
    const trukme = Date.now() - pradzia;

    assert.equal(res.status, 503);
    assert.equal(res.body.components.auditStoreReachable, false);
    assert.ok(trukme < 5000, `readiness turi grįžti per ribą, o užtruko ${trukme} ms`);
  } finally {
    auditStore.probe = originalus;
    if (savedRiba === undefined) delete process.env.READINESS_TIMEOUT_MS;
    else process.env.READINESS_TIMEOUT_MS = savedRiba;
  }
});

test("PRIVATUMAS: nei readiness, nei health neatskleidžia raktų ar generacijų", async () => {
  /**
   * ⚠️ READINESS ATSAKYMAS YRA VIEŠESNIS UŽ LOGUS.
   *
   * Jį skaito orkestruotojas, monitoringas ir dažnai load balanceris. Nei
   * secret'ai, nei `hash_key_id` etikečių sąrašas ten patekti negali - pirmi
   * dėl akivaizdžių priežasčių, antri todėl, kad atskleistų raktų rotacijos
   * istoriją ir generacijų vardus.
   */
  const SECRET = "labai-slaptas-audito-raktas-SENTINEL";
  const GENERACIJA = "generacija-SENTINEL-2026-05";

  const savedSalt = process.env.AUDIT_ID_SALT;
  process.env.AUDIT_ID_SALT = SECRET;

  const originalus = auditStore.nasliaitesGeneracijos;
  auditStore.nasliaitesGeneracijos = () => [GENERACIJA];

  try {
    const ready = await request(app).get("/api/ready");
    const health = await request(app).get("/api/health");

    const viskas = JSON.stringify(ready.body) + JSON.stringify(health.body);

    assert.ok(!viskas.includes(SECRET), "secret'as negali patekti į readiness ar health");
    assert.ok(!viskas.includes(GENERACIJA), "generacijų vardai negali patekti į atsakymą");

    /** Bet FAKTAS, kad kažkas negerai, privalo būti matomas. */
    assert.equal(ready.body.components.auditKeysResolvable, false);
  } finally {
    auditStore.nasliaitesGeneracijos = originalus;
    if (savedSalt === undefined) delete process.env.AUDIT_ID_SALT;
    else process.env.AUDIT_ID_SALT = savedSalt;
  }
});
