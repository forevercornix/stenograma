const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
delete process.env.REDIS_URL;

const fs = require("node:fs");
const path = require("node:path");
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

test("#216 READY: nepasiekiamas ištrynimo barjeras → 503 su ATSKIRA priežastimi", async () => {
  /**
   * ⚠️ BARJERAS SKAITO `erasure_marks` PER AUDITO JUNGTĮ.
   *
   * `deletionTombstones.probe()` tikrina lentelę per SAVO pool'ą, o
   * `auditStore.probe()` - `audit_log` teises. Jei audito DB `erasure_marks`
   * neturi (arba turi be vėlesnių migracijų), ABU esami zondai lieka teigiami,
   * o pirmas audito rašymas duoda `42P01`/`42703` → CHECK FAILED → fail-closed:
   * prisijungimas nustoja veikti VYKDYMO metu, jau praėjus sveikatos patikras.
   *
   * ⚠️ PRIEŽASTIS PRIVALO BŪTI ATSKIRIAMA. Sujungus su `auditStoreReachable`,
   * readiness sakytų „auditas neveikia" ten, kur auditas veikia puikiai, o
   * trūksta tik barjero migracijos - ir operatorius ieškotų ne ten.
   */
  const originalus = auditStore.probeBarrier;
  auditStore.probeBarrier = async () => false;

  try {
    const ready = await request(app).get("/api/ready");
    const health = await request(app).get("/api/health");

    assert.equal(ready.status, 503, "be pasiekiamo barjero instancija NĖRA paruošta");
    assert.equal(ready.body.ready, false);
    assert.equal(ready.body.components.auditBarrierReachable, false);
    assert.equal(
      ready.body.components.auditStoreReachable,
      true,
      "audito saugykla veikia - priežastis privalo būti ATSKIRIAMA"
    );

    /** Liveness nepaliestas: perkrovimas migracijos nepritaikytų. */
    assert.equal(health.status, 200);
  } finally {
    auditStore.probeBarrier = originalus;
  }
});

test("#216 READY: ATMINTINIS auditas duoda `auditBarrierReachable: true` - demo diegimai lieka paruošti", async () => {
  /**
   * ⚠️ TYLI REGRESIJA, KURIOS KITAS TESTAS NEPAGAUTŲ.
   *
   * Testas „nepasiekiamas barjeras → 503" tikrina `false` KARTU su
   * `auditStoreReachable: true`. Jei naujas komponentas atmintiniame režime
   * grąžintų `false`, tas testas liktų žalias, o `/api/ready` taptų 503
   * KIEKVIENAM diegimui be DB - `docker-compose.demo.yml`, `quickstart`, visi
   * mock profiliai.
   *
   * Atmintiniame režime `erasure_marks` lentelės nėra IR NEREIKIA: barjerą ten
   * vykdo `deletionTombstones` atmintinis backend'as. Tad teisingas atsakymas
   * yra `true`, ir jis tikrinamas, o ne prielaidžiamas.
   *
   * Grandinė, kurią tai pina: `isReady()` turi eksplicitinę `memory` šaką
   * (`resolveAuditBackend(env) === "memory" ? true : paruosta`), o
   * `memoryStore.probeBarrier()` grąžina `true` dėl kontrakto pariteto.
   */
  const { resolveAuditBackend } = require("../utils/auditStore/backendSelection");
  assert.equal(resolveAuditBackend({}), "memory", "prielaida: be konfigūracijos - atmintis");

  assert.equal(
    await auditStore.probeBarrier({}),
    true,
    "atmintiniame režime barjeras pasiekiamas pagal apibrėžimą"
  );

  /** Ir per HTTP: šis rinkinys sukasi be DB, tad tai TAS PATS kelias. */
  const ready = await request(app).get("/api/ready");

  assert.equal(ready.status, 200, "diegimas be DB privalo likti paruoštas");
  assert.equal(ready.body.components.auditBarrierReachable, true);
});

test("#216 READY: barjero zondas tikrina STULPELIUS, ne vien lentelę, ir ima juos iš ŽYMŲ autoriteto", async () => {
  /**
   * ⚠️ BE TIKROS DB - SUKLASTOTU POOL'U, kaip ir kiti šio failo zondų testai.
   *
   * ⚠️ TIKRINAMAS SĄRAŠO ŠALTINIS, NE TIK FAKTAS, KAD UŽKLAUSA VYKSTA.
   * `SELECT 1 FROM erasure_marks` pavyksta ir tada, kai diegimas nutrūko po
   * lentelės sukūrimo, bet PRIEŠ vėlesnę migraciją - tą priežastį
   * `deletionTombstones.init()` jau užrašė. Ketvirta stulpelių sąrašo kopija
   * neišvengiamai išsiskirtų, todėl imamas TAS PATS eksportas.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");
  const { STULPELIAI: ZYMU_STULPELIAI } = require("../utils/deletionTombstones/postgresStore");

  const uzklausos = [];
  const pool = (mesti) => ({
    query: async (sql) => {
      uzklausos.push(String(sql));
      if (mesti && /erasure_marks/.test(String(sql))) {
        const e = new Error('relation "erasure_marks" does not exist');
        e.code = "42P01";
        throw e;
      }
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  });

  const bloga = createPostgresStore(pool(true), { hashKeyId: "k", readinessBudgetMs: 1000 });
  assert.equal(await bloga.probeBarrier(), false, "trūkstama lentelė = NEPASIEKIAMA");

  uzklausos.length = 0;
  const gera = createPostgresStore(pool(false), { hashKeyId: "k", readinessBudgetMs: 1000 });
  assert.equal(await gera.probeBarrier(), true);

  const barjeroUzklausa = uzklausos.find((u) => u.includes("erasure_marks"));
  assert.ok(barjeroUzklausa, "zondas privalo realiai kreiptis į `erasure_marks`");
  assert.ok(
    barjeroUzklausa.includes(ZYMU_STULPELIAI),
    "stulpelių sąrašas privalo ateiti iš `deletionTombstones`, ne būti perrašytas čia"
  );
  assert.match(barjeroUzklausa, /WHERE false/, "planavimo, ne skaitymo operacija");
});

test("READY: kabantis audito zondas NEPAKABINA `/api/ready`", () => {
  /**
   * Readiness privalo atsakyti VISADA - net kai priklausomybė kabo. Be ribos
   * orkestruotojas vietoj aiškaus 503 gautų timeout, o konteineris liktų
   * „tikrinamas" būsenoje.
   *
   * ⚠️ ATSKIRAS PROCESAS, IR TAI NE PATOGUMAS (#233 Codex raundas 3, #2).
   *
   * `server.js` `READINESS_TIMEOUT_MS` užfiksuoja modulio ĮKĖLIMO metu. Šio
   * failo 13 eilutė serverį jau įkėlė, tad ankstesnė versija, nustačiusi
   * `process.env.READINESS_TIMEOUT_MS = "150"` teste, nekeitė NIEKO: maršrutas
   * laukdavo numatytų 2000 ms, o riba `trukme < 5000` praeidavo. Testas buvo
   * žalias ir neįrodinėjo nieko - nei ribos veikimo, nei jos reikšmės.
   *
   * Todėl aplinka nustatoma PRIEŠ įkėlimą, atskirame procese, o tikrinama riba
   * artima 150 ms. Su numatytais 2000 ms šis testas krinta - kaip ir turi.
   */
  const os = require("node:os");
  const { execFileSync } = require("node:child_process");

  const backend = path.join(__dirname, "..");
  const katalogas = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-readiness-"));
  const skriptas = path.join(katalogas, "zondas.js");

  const RIBA_MS = 150;

  try {
    fs.writeFileSync(
      skriptas,
      [
        'process.env.NODE_ENV = "test";',
        'process.env.LLM_PROVIDER = "mock";',
        'process.env.TRANSCRIPTION_PROVIDER = "mock";',
        'process.env.API_KEY = "";',
        'process.env.LOG_LEVEL = "error";',
        "delete process.env.REDIS_URL;",
        /** ⚠️ PRIEŠ bet kokį `require` - kitaip konstanta jau užfiksuota. */
        `process.env.READINESS_TIMEOUT_MS = "${RIBA_MS}";`,
        "",
        `const request = require(${JSON.stringify(path.join(backend, "node_modules", "supertest"))});`,
        `const auditStore = require(${JSON.stringify(path.join(backend, "utils", "auditStore"))});`,
        `const app = require(${JSON.stringify(path.join(backend, "server"))});`,
        "",
        "app._setReadyForTests(true);",
        "auditStore.probe = () => new Promise(() => {});",
        "",
        "const pradzia = Date.now();",
        'request(app).get("/api/ready").then((res) => {',
        "  console.log(JSON.stringify({",
        "    status: res.status,",
        "    reachable: res.body.components.auditStoreReachable,",
        "    trukme: Date.now() - pradzia,",
        "  }));",
        "  process.exit(0);",
        "}).catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exit(1); });",
      ].join("\n"),
      "utf8"
    );

    const isvestis = execFileSync("node", [skriptas], {
      encoding: "utf8",
      cwd: backend,
      timeout: 30_000,
    });

    const rezultatas = JSON.parse(isvestis.trim().split("\n").pop());

    assert.equal(rezultatas.status, 503, "kabantis zondas privalo duoti 503, ne timeout");
    assert.equal(rezultatas.reachable, false);

    /**
     * ⚠️ TIKRINAMOS ABI PUSĖS. Viršutinė riba įrodo, kad laukta būtent
     * nustatytos, o ne numatytosios reikšmės; apatinė - kad atsakymas negrįžo
     * iškart dėl kokios nors kitos priežasties, o riba realiai suveikė.
     */
    assert.ok(
      rezultatas.trukme >= RIBA_MS,
      `readiness privalo laukti ribos, o grįžo per ${rezultatas.trukme} ms`
    );
    assert.ok(
      rezultatas.trukme < RIBA_MS * 5,
      `readiness laukė ${rezultatas.trukme} ms - panašu, kad galioja numatytieji 2000 ms, ` +
        "t. y. `READINESS_TIMEOUT_MS` nustatytas per vėlai"
    );
  } finally {
    fs.rmSync(katalogas, { recursive: true, force: true });
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

test("PRODUKCIJA: `/api/health` NEATSKLEIDŽIA backend'ų detalių pagal nutylėjimą", async () => {
  /**
   * ⚠️ ĮVYKDYTAS ĮRODYMAS, NE „by construction" (#231, punktas 8).
   *
   * Teiginys „mes nieko nepridėjome, tad neatskleidžia" yra argumentas.
   * Argumentas nėra įrodymas: `HEALTH_DETAILS` logika sudėtinga (trys šakos plius
   * `x-audit-key` išimtis), ir bet kuris būsimas laukas gali į ją įkristi.
   *
   * Tikrinama, kad produkcijos režimu atsakymas yra MINIMALUS - ne kad jame
   * nėra konkretaus žodžio. Naujas laukas, pridėtas neapgalvotai, krinta čia.
   */
  const savedEnv = process.env.NODE_ENV;
  const savedMode = process.env.HEALTH_DETAILS;
  const savedKey = process.env.AUDIT_API_KEY;

  process.env.NODE_ENV = "production";
  delete process.env.HEALTH_DETAILS;
  delete process.env.AUDIT_API_KEY;

  try {
    const res = await request(app).get("/api/health");

    assert.equal(res.status, 200, "liveness lieka");
    assert.deepEqual(
      Object.keys(res.body),
      ["status"],
      "produkcijoje atsakymas privalo būti TIK `status` - joks backend'o, DB ar audito laukas"
    );

    const serializuota = JSON.stringify(res.body);
    for (const nutekejimas of ["postgres", "memory", "audit", "redis", "Provider"]) {
      assert.ok(
        !serializuota.toLowerCase().includes(nutekejimas.toLowerCase()),
        `"${nutekejimas}" negali patekti į produkcinį health atsakymą`
      );
    }
  } finally {
    process.env.NODE_ENV = savedEnv;
    if (savedMode === undefined) delete process.env.HEALTH_DETAILS;
    else process.env.HEALTH_DETAILS = savedMode;
    if (savedKey === undefined) delete process.env.AUDIT_API_KEY;
    else process.env.AUDIT_API_KEY = savedKey;
  }
});

test("PRODUKCIJA: `/api/ready` komponentai yra BŪSENOS, ne infrastruktūros vardai", async () => {
  /**
   * Readiness produkcijoje detalių neslepia sąmoningai - orkestruotojui reikia
   * žinoti, KURI priklausomybė krito. Bet komponentai privalo likti loginėmis
   * būsenomis (`true`/`false`), ne backend'ų pavadinimais ar generacijų ID.
   */
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await request(app).get("/api/ready");
    const komponentai = res.body.components;

    for (const [raktas, reiksme] of Object.entries(komponentai)) {
      if (raktas === "workers") continue; // objektas su boolean laukais
      assert.equal(
        typeof reiksme,
        "boolean",
        `komponentas "${raktas}" yra ${typeof reiksme} - readiness atsako BŪSENOMIS, ne vardais`
      );
    }

    const serializuota = JSON.stringify(res.body);
    assert.ok(!/postgres|audit_log|hash_key/i.test(serializuota), "jokių infrastruktūros detalių");
  } finally {
    process.env.NODE_ENV = savedEnv;
  }
});
