const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { sukurtiResursuKruva, poolKlaidos } = require("./helpers/resourceStack");

/**
 * `pg` GYVAVIMO CIKLO AUTORITETAS (#380 R2).
 *
 * ⚠️ BE TIKROS DB, IR TAI SĄMONINGA. Tikrinami ne SQL rezultatai, o krūvos elgesys:
 * ar uždarymas ribotas, ar nutekėjimas pastebimas, ar jungties klaida registruojama.
 * Visi trys klausimai atsakomi dubliu, ir tik tada jie tikrinami DETERMINISTIŠKAI —
 * su tikra baze „pool.end() kabo" scenarijų tektų gaminti lenktynėmis.
 */

/** Pool'o dublis: dokumentuoti skaitikliai plius valdomas `end()`. */
function poolDublis({ kabo = false, paimta = 0 } = {}) {
  const e = new EventEmitter();
  e.totalCount = 1 + paimta;
  e.idleCount = 1;
  e.waitingCount = 0;
  e.klientai = [];
  e.end = () => (kabo ? new Promise(() => {}) : Promise.resolve());
  /** `pg` pool'o paviršius, kurio reikia checkout ribai: `options` ir `connect`. */
  e.options = { max: 10 };
  e.connectKlaida = null;
  e.connect = () =>
    e.connectKlaida ? Promise.reject(e.connectKlaida) : Promise.resolve({ release() {} });
  /** Imituoja `pool.connect()`: klientas gauna krūvos prikabintą klausytoją. */
  e.prijungti = () => {
    const c = new EventEmitter();
    e.klientai.push(c);
    e.emit("connect", c);
    return c;
  };
  return e;
}

test("#380 R2: sveikas `pool.end()` uždaromas iš karto, be ribos triukšmo", async () => {
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis();
  kruva.registruotiPoola(pool, { vardas: "darbinis" });

  const pradzia = Date.now();
  await kruva.isvalyti();
  assert.ok(Date.now() - pradzia < 1_000, "sveikas uždarymas neturi laukti ribos");
  assert.equal(kruva.kiek(), 0, "krūva išvyniota");
});

test("#380 R2: KABANTIS `pool.end()` nutrūksta per ribą ir virsta ĮVARDYTA valymo klaida", async () => {
  /**
   * ⚠️ TAI VISO #380 ŠERDIS. `pg-pool` `end()` išsisprendžia tik kai `_clients`
   * tuščias (`index.js:140`), o negrąžinto kliento ten niekas nepašalina — laukimas
   * neribotas PAGAL KONSTRUKCIJĄ, ne dėl lėto tinklo.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis({ kabo: true, paimta: 2 });
  kruva.registruotiPoola(pool, { vardas: "kabantis" });

  const pradzia = Date.now();
  await assert.rejects(
    () => kruva.isvalyti(),
    (e) => /POOL_CLOSE_TIMEOUT kabantis/.test(e.message) && /paimta klientų: 2/.test(e.message),
    "riba privalo virsti įvardyta klaida, ne tyliu praėjimu"
  );
  assert.ok(Date.now() - pradzia < 30_000, `nutrūko per ${Date.now() - pradzia} ms`);
});

test("#380 R2: nutekėjimas matuojamas SKIRTUMU, ne absoliučia lygybe", async () => {
  /**
   * ⚠️ ABSOLIUTI `totalCount === idleCount` NETEISINGA. Testas gali teisėtai pats
   * laikyti klientą paimtą (#351 precedentas: `isipareigojimoTvora` 8 (a) laiko
   * rašytoją) — tada lygybė kristų be jokios regresijos.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis({ paimta: 1 });

  /** Kontrolė: testo laikomas klientas NĖRA nutekėjimas. */
  const tikrinti = kruva.matuotiNutekejima(pool, "kontrolė");
  tikrinti(assert);

  /** O naujas, negrąžintas — yra. */
  const tikrinti2 = kruva.matuotiNutekejima(pool, "šlavėjas");
  pool.totalCount += 1;
  assert.throws(
    () => tikrinti2(assert),
    (e) => /POOL_LEAK šlavėjas/.test(e.message) && /prieš=1, po=2/.test(e.message)
  );
});

test("#380 D7: jungties klaida NE valymo metu — REGISTRUOJAMA ir virsta gedimu", async () => {
  /**
   * ⚠️ KLAUSYTOJAS REGISTRUOJA, NE PRARYJA. Jis reikalingas ir techniškai — `pg-pool`
   * paimtam klientui savo klausytoją nuima (`index.js:344`), tad be mūsų klausytojo
   * `'error'` verstų procesą kristi, — bet jo TURINYS yra duomuo: jungtis, nutrūkusi
   * ne per mūsų valymą, yra tikras gedimas.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis();
  kruva.registruotiPoola(pool, { vardas: "darbinis" });

  const klientas = pool.prijungti();
  const klaida = new Error("terminating connection due to administrator command");
  klaida.code = "57P01";
  klientas.emit("error", klaida);

  assert.deepEqual(poolKlaidos(pool).tikros, ["darbinis: 57P01"], "klaida privalo būti UŽRAŠYTA");
  assert.deepEqual(poolKlaidos(pool).valymo, [], "tai NĖRA valymo sukelta klaida");

  await assert.rejects(
    () => kruva.isvalyti(),
    (e) => /CONNECTION_ERROR \(ne valymo\)/.test(e.message) && /darbinis: 57P01/.test(e.message),
    "tikra jungties klaida privalo nuversti valymą, ne likti fone"
  );
});

test("#380 D7 KONTROLĖ: klausytojas neleidžia procesui kristi dėl be-klausytojo `'error'`", () => {
  /**
   * ⚠️ BE ŠITO ankstesnis testas suderinamas su realizacija, kuri klaidą užrašo, bet
   * klausytojo neprikabina — ir tada tikras `pg` klientas kristų `EventEmitter`
   * lygyje dar prieš pasiekiant apskaitą.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis();
  kruva.registruotiPoola(pool, { vardas: "darbinis" });

  const klientas = pool.prijungti();
  assert.equal(klientas.listenerCount("error"), 1, "klientas PRIVALO turėti `error` klausytoją");
});

test("#380 R2: `registruoti()` kontraktas jo 6 vartotojams NEPAKITĘS", async () => {
  /**
   * ⚠️ TAI RIBOS TESTAS, NE FUNKCIJOS. #380 sujungė du mechanizmus į vieną, ir vienintelė
   * priežastis, kodėl tai NĖRA kontrakto laužymas, yra ta, kad senasis paviršius liko
   * identiškas: registracija grąžina rankeną, `vienaKarta` neleidžia dvigubo uždarymo,
   * o valymo nesėkmės kaupiasi `klaida.valymoKlaidos`.
   */
  const kruva = sukurtiResursuKruva();
  const veiksmai = [];

  const anksti = kruva.registruoti("admin", async () => veiksmai.push("admin"));
  kruva.registruoti("darbinis", async () => veiksmai.push("darbinis"));
  assert.equal(kruva.kiek(), 2);

  assert.equal(await anksti(), true, "pirmas kvietimas uždaro");
  assert.equal(await anksti(), false, "antras — ne");

  await kruva.isvalyti();
  assert.deepEqual(veiksmai, ["admin", "darbinis"], "išvyniojama ATVIRKŠTINE tvarka, be dublių");

  const kruva2 = sukurtiResursuKruva();
  kruva2.registruoti("blogas", async () => {
    throw new Error("nepavyko");
  });
  const pirmine = new Error("setup krito");
  await kruva2.isvalyti(pirmine);
  assert.deepEqual(pirmine.valymoKlaidos, ["blogas: nepavyko"], "valymas NEUŽDENGIA pirminės");
});

test("#380: pool'o IŠSEKIMAS virsta `POOL_EXHAUSTED` su pool'u, failu ir skaitikliais", async () => {
  /**
   * ⚠️ TAI M1 DIAGNOZĖS TAISYMAS. Be `connectionTimeoutMillis` pilname pool'e užklausa
   * dedama į `_pendingQueue` BE laikmačio (`pg-pool@3.14.0`, `index.js:206–208`), tad
   * `pool.query()` TESTO KŪNE laukia amžinai — ir failas krenta ne 10 s uždarymo ribą,
   * o 120 s runner'io ribą, be jokios nuorodos į priežastį. Išmatuota: run
   * `35663397047`, `registryErasure.integration` → `FILE_TIMEOUT`.
   *
   * ⚠️ VERČIAMA, NE PRIDEDAMA. `pg` pranešimas nesako nei kuris pool'as, nei kuriame
   * faile, nei kiek klientų paimta — o būtent to operatoriui ir reikia.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis({ paimta: 9 });
  kruva.registruotiPoola(pool, { vardas: "išsekęs" });

  assert.equal(
    pool.options.connectionTimeoutMillis,
    5_000,
    "stebimas pool'as PRIVALO gauti checkout ribą — kitaip išsekimas yra amžinas laukimas"
  );

  pool.connectKlaida = new Error("timeout exceeded when trying to connect");
  await assert.rejects(
    () => pool.connect(),
    (e) =>
      e.code === "POOL_EXHAUSTED" &&
      /POOL_EXHAUSTED išsekęs/.test(e.message) &&
      /max=10/.test(e.message) &&
      /paimta=9/.test(e.message),
    "diagnostika privalo įvardyti pool'ą, ribą ir skaitiklius"
  );

  await kruva.isvalyti().catch(() => {});
});

test("#380 KONTROLĖ: kvietėjo nurodyta checkout riba NEPERRAŠOMA", async () => {
  /**
   * ⚠️ BE ŠITO „riba nustatoma" suderinama su realizacija, kuri perrašo VISKĄ — ir
   * testas, matuojantis būtent savo ribą, tyliai matuotų mūsų.
   */
  const pool = poolDublis();
  pool.options.connectionTimeoutMillis = 250;
  const { stebetiPoola } = require("./helpers/resourceStack");
  stebetiPoola(pool, { vardas: "savas" });
  assert.equal(pool.options.connectionTimeoutMillis, 250);
});

test("#380 KONTROLĖ: kita `connect()` klaida NEVIRSTA `POOL_EXHAUSTED`", async () => {
  /**
   * ⚠️ Vertimas pagal pranešimą yra siauras SĄMONINGAI: jis apima tik tą vieną eilutę,
   * kurią `pg-pool` generuoja pats (`index.js:223`). Bet kokia kita klaida privalo eiti
   * nepaliesta — antraip tinklo gedimas atrodytų kaip nutekėjęs klientas.
   */
  const kruva = sukurtiResursuKruva();
  const pool = poolDublis();
  kruva.registruotiPoola(pool, { vardas: "kitas" });

  pool.connectKlaida = Object.assign(new Error("ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  await assert.rejects(
    () => pool.connect(),
    (e) => e.code === "ECONNREFUSED" && !/POOL_EXHAUSTED/.test(e.message)
  );

  await kruva.isvalyti().catch(() => {});
});
