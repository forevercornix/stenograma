const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  revivalHorizonsMs,
  NegaliojantisHorizontasKlaida,
} = require("../queues/config");

/**
 * HORIZONTO VALIDACIJA PRIE ŠALTINIO (#419, D1–D4).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NEĮRODO.
 *
 * Įrodo: `revivalHorizonsMs()` nebegrąžina `NaN` ar `Infinity` NĖ VIENO iš
 * aštuonių dydžių; trys §0.6 paleidimo taškai su tokia konfigūracija nepakyla;
 * pranešime yra ir negaliojantis dydis, ir VISAS įėjimas; vartotojų sargai
 * tebeveikia, jei validacija apeinama.
 *
 * ❌ NEĮRODO, kad horizontas „validuotas". BAIGTINĖ, bet absurdiška reikšmė
 * praeina SĄMONINGAI (§0.2 STOP: viršutinės ribos autoriteto repo neturi), ir
 * tai tikrina atskiras testas žemiau bei du seni testai, kurie po #419 privalėjo
 * likti žali BE PAKEITIMŲ: `auditRetention.test.js:1221` ir
 * `isipareigojimoTvora.integration.test.js:714`.
 */

const SAKNIS = path.resolve(__dirname, "..");

/** ⚠️ `parseInt` nepriima `1e308` - reikia tikros skaitmenų eilutės. */
const skaitmenys = (eile) => "1" + "0".repeat(eile);

/**
 * ⚠️ `assert.throws` NEGRĄŽINA klaidos, o kiekvienas testas žemiau tikrina jos
 * TURINĮ (D4). Todėl klaida gaudoma rankomis; be `assert.fail` praleidimas
 * virstų tyliai žaliu testu.
 */
function atmesta(env) {
  let klaida;

  try {
    const h = revivalHorizonsMs(env);
    assert.fail(`privalėjo mesti, o grąžino horizonMs=${h.horizonMs}`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    klaida = e;
  }

  assert.ok(
    klaida instanceof NegaliojantisHorizontasKlaida,
    `ne ta klaidos klasė: ${klaida.name} / ${klaida.message}`
  );

  return klaida;
}

// ---------------------------------------------------------------------------
// D1: NaN ir Infinity
// ---------------------------------------------------------------------------

test("#419 D1: `NaN` horizontas ATMETAMAS prie šaltinio", () => {
  /**
   * `retry += baze * 2 ** i`: kai `i >= 1024`, `2 ** i === Infinity`, o
   * `baze === 0` duoda `0 * Infinity === NaN`. Abi įvestys yra teisėti teigiami
   * skaičiai, tad `teigiamas()` jų nesustabdo - gedimas gimsta PO jo.
   */
  const klaida = atmesta({ QUEUE_MAX_ATTEMPTS: "1026", QUEUE_BACKOFF_MS: "0" });

  assert.equal(klaida.code, "QUEUE_HORIZON_INVALID");
  assert.ok(klaida.negalioja.includes("retry"), `sprogo turėjo retry: ${klaida.negalioja}`);
  assert.match(klaida.message, /retry=NaN/);
});

test("#419 D1: `Infinity` horizontas ATMETAMAS prie šaltinio", () => {
  /** Ta pati aritmetika su `baze > 0` duoda `Infinity`, ne `NaN`. */
  const klaida = atmesta({ QUEUE_MAX_ATTEMPTS: "1026", QUEUE_BACKOFF_MS: "1" });

  assert.match(klaida.message, /retry=Infinity/);
});

test("#419 D1: tikrinamas NE VIEN `retry` - `stalled` sprogimas irgi atmetamas", () => {
  /**
   * ⚠️ BE ŠITO patikra, uždėta tik ant `retry`/`horizonMs`, praeitų visus testus
   * aukščiau. `stalled` skaičiuojamas iš KITŲ dviejų įvesčių ir sprogsta savo
   * keliu: `stalledInterval * maxStalledCount`.
   */
  const klaida = atmesta({
        QUEUE_STALLED_INTERVAL_MS: skaitmenys(308),
        QUEUE_MAX_STALLED: "2",
      });

  assert.ok(klaida.negalioja.includes("stalled"), `laukta stalled: ${klaida.negalioja}`);
  assert.ok(!klaida.negalioja.includes("retry"), "`retry` čia yra tvarkingas");
});

test("#419 D1: tikrinamas ir `removeOnComplete` (vienetų konversija sprogsta)", () => {
  /**
   * `age` yra SEKUNDĖS, dauginamos iš 1000. Baigtinė `age` reikšmė gali duoti
   * begalinę milisekundžių reikšmę - t. y. sprogimas gimsta pačioje
   * konversijoje, ne įvestyje.
   */
  const klaida = atmesta({ QUEUE_TTL_SECONDS: skaitmenys(306) });

  assert.ok(
    klaida.negalioja.includes("removeOnComplete") && klaida.negalioja.includes("terminalus"),
    `laukta removeOnComplete ir terminalus: ${klaida.negalioja}`
  );
});

test("#419 D1 RIBA: BAIGTINĖ, bet absurdiška reikšmė PRAEINA - ir tai sprendimas", () => {
  /**
   * ⚠️ TAI NĖRA SPRAGA, IR TESTAS ČIA TAM, KAD NIEKAS JOS TYLIAI „NEPATAISYTŲ".
   *
   * Viršutinės ribos šis repo niekur nefiksuoja (§0.2 STOP), o išgalvota riba
   * atrodytų kaip išvesta. Ši šaka yra fail-closed KITU mechanizmu: PostgreSQL
   * `interval` tokio dydžio nepriima, sakinys meta, kvietėjas gaudo, ir
   * nešalinama nieko. Tą tikrina `isipareigojimoTvora.integration.test.js:714`.
   */
  const h = revivalHorizonsMs({ QUEUE_MAX_ATTEMPTS: "60" });

  assert.ok(Number.isFinite(h.horizonMs) && h.horizonMs > 0);
  assert.ok(h.horizonMs > 1e21, `absurdiška, bet baigtinė: ${h.horizonMs}`);
});

test("#419 KONTROLĖ: numatytoji konfigūracija nepakitusi", () => {
  /**
   * ⚠️ BE ŠITO validacija, atmetanti VISKĄ, praeitų kiekvieną testą aukščiau.
   */
  assert.equal(revivalHorizonsMs({}).horizonMs, 90675000);
});

// ---------------------------------------------------------------------------
// D4: pranešimas
// ---------------------------------------------------------------------------

const IVESTYS = [
  "QUEUE_MAX_ATTEMPTS",
  "QUEUE_BACKOFF_MS",
  "QUEUE_TTL_SECONDS",
  "QUEUE_STALLED_INTERVAL_MS",
  "QUEUE_MAX_STALLED",
  "QUEUE_LOCK_DURATION_MS",
];

test("#419 D4: pranešime VISAS įėjimas su efektyviomis reikšmėmis, ne vienas kaltininkas", () => {
  /**
   * ⚠️ „KALTAS `QUEUE_MAX_ATTEMPTS`" būtų IŠVEDIMAS: `retry` sprogsta nuo
   * DVIEJŲ reikšmių sandaugos. Operatorius turi matyti visą įėjimą ir spręsti
   * pats - todėl tikrinama, kad pranešime yra kiekvienas kintamasis, įskaitant
   * nenustatytus (su numatytąja efektyvia reikšme).
   */
  const klaida = atmesta({ QUEUE_MAX_ATTEMPTS: "1026", QUEUE_BACKOFF_MS: "0" });

  for (const vardas of IVESTYS) {
    assert.ok(klaida.message.includes(vardas), `pranešime trūksta ${vardas}: ${klaida.message}`);
  }

  /** Nustatyta reikšmė rodoma su efektyvia; nenustatyta - įvardijama kaip tokia. */
  assert.match(klaida.message, /QUEUE_MAX_ATTEMPTS=1026 → 1026/);
  assert.match(klaida.message, /QUEUE_TTL_SECONDS=\(nenustatyta\) → 3600/);
  assert.match(klaida.message, /QUEUE_LOCK_DURATION_MS=\(nenustatyta\) → 600000/);
});

// ---------------------------------------------------------------------------
// D2: trys paleidimo taškai
// ---------------------------------------------------------------------------

const BLOGA = { QUEUE_MAX_ATTEMPTS: "1026", QUEUE_BACKOFF_MS: "0" };

function paleisti(argv, papildoma = {}) {
  return spawnSync(process.execPath, argv, {
    cwd: SAKNIS,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      REDIS_URL: "",
      ...papildoma,
    },
  });
}

test("#419 D2: `server.js` su blogu horizontu NEPAKYLA", () => {
  const r = paleisti(["-e", "require('./server.js')"], BLOGA);

  assert.notEqual(r.status, 0, "procesas privalo kristi");
  assert.match(r.stderr, /Neapskaičiuojami eilės prikėlimo horizontai/);
  assert.match(r.stderr, /retry=NaN/);
});

test("#419 D2: `SKIP_CONFIG_VALIDATION=true` šito NEAPEINA", () => {
  /**
   * ⚠️ Ta vėliava egzistuoja provider'ių/raktų patikroms apeiti diegiant.
   * Horizontas nėra tos klasės dalykas: `NaN` riba reiškia, kad kiekvienas
   * retencijos palyginimas nusprendžia tyliai ir priešingai, nei ketinta.
   * Apeinamas fail-closed nėra fail-closed.
   */
  const r = paleisti(["-e", "require('./server.js')"], {
    ...BLOGA,
    SKIP_CONFIG_VALIDATION: "true",
  });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Neapskaičiuojami eilės prikėlimo horizontai/);
});

test("#419 D2 KONTROLĖ: `server.js` su tvarkinga konfigūracija pakyla", () => {
  const r = paleisti(["-e", "require('./server.js')"]);

  assert.equal(r.status, 0, `neturėjo kristi: ${r.stderr}`);
});

test("#419 D2: `workers/index.js` krenta PRIEŠ `REDIS_URL` patikrą", () => {
  /**
   * ⚠️ `REDIS_URL` čia TYČIA tuščias. Jei horizonto patikra stovėtų po jos,
   * testas gautų „reikia REDIS_URL" - t. y. teisingą kritimą dėl NETEISINGOS
   * priežasties, ir perkėlimas į vėlesnę vietą liktų nepastebėtas.
   */
  const r = paleisti([
    "-e",
    "require('./workers/index.js').initializeWorkerOrFail('t')" +
      ".then(() => process.exit(0))" +
      ".catch((e) => { console.error(e.message); process.exit(1); })",
  ], BLOGA);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /Neapskaičiuojami eilės prikėlimo horizontai/);
  assert.ok(!/REDIS_URL/.test(r.stderr), `kritimas dėl ne tos priežasties: ${r.stderr}`);
});

test("#419 D2: `scripts/erasure-marks.js` krenta PRIEŠ PIRMĄ VEIKSMĄ", () => {
  /**
   * ⚠️ SKRIPTUI „FAIL-CLOSED" REIŠKIA KITKĄ. Readiness patikros čia nėra, o
   * pirmas veiksmas - `auditStore.init()` - jau atidaro jungtį. Todėl
   * tikrinama ne tik baigtis, bet ir tai, kad audito saugykla NEBUVO inicijuota:
   * incidento įrankis, tyliai suskaičiavęs barjerą pagal neapibrėžtą ribą,
   * atsakytų klaidingai būtent tada, kai atsakymas brangiausias.
   */
  const r = paleisti(["scripts/erasure-marks.js", "list"], { ...BLOGA, LOG_LEVEL: "info" });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /Neapskaičiuojami eilės prikėlimo horizontai/);
  assert.ok(
    !/Audito saugykla/.test(r.stdout + r.stderr),
    `veiksmas įvyko prieš kritimą: ${r.stdout}`
  );
  assert.ok(!/Backend'as:/.test(r.stdout), "komanda NEGALĖJO nieko išvesti");
});

// ---------------------------------------------------------------------------
// D3: vartotojų sargai lieka
// ---------------------------------------------------------------------------

test("#419 D3: `retentionSweeper` sargas tebeveikia, kai šaltinio validacija APEINAMA", () => {
  /**
   * ⚠️ KODĖL DUBLIS, O NE APLINKA. Po D1 aplinka su `NaN` iki šio sargo
   * NEBEATEINA - funkcija meta anksčiau. Tai ir yra tikslas, bet sargas nuo to
   * netampa nereikalingas: šis modulis `require`-inamas tiesiogiai, o gynyba,
   * priklausanti nuo to, kad kiekvienas būsimas kvietėjas eina per paleidimo
   * taškų sąrašą, yra prielaida, kurios niekas nevykdo. Dublis atkuria būtent
   * tą pasaulį - validacija apeita, sargas privalo suveikti.
   */
  const config = require("../queues/config");
  const retentionSweeper = require("../utils/retentionSweeper");
  const jobStore = require("../utils/jobStore");
  const tombstones = require("../utils/deletionTombstones");

  const TAPATYBE = { host: "db", port: 5432, database: "stenograma" };
  /** ⚠️ Be `warn` lygio sargo pėdsakas neišvedamas, ir testas tikrintų tylą. */
  const tikrasLygis = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";

  const tikras = {
    horizonai: config.revivalHorizonsMs,
    zymuTapatybe: tombstones.jungtiesTapatybe,
    valytini: jobStore.system.valytiniBandymai,
    tapatybe: jobStore.system.jungtiesTapatybe,
    listExpired: jobStore.listExpired,
    nuorodos: jobStore.system.listReferencedStorageKeys,
    warn: console.warn,
  };

  let kviesta = 0;
  const warnai = [];

  config.revivalHorizonsMs = () => ({ horizonMs: NaN });
  tombstones.jungtiesTapatybe = () => TAPATYBE;
  jobStore.system.jungtiesTapatybe = async () => TAPATYBE;
  jobStore.system.valytiniBandymai = async () => {
    kviesta += 1;
    return { kandidatai: [], praleista: 0, uzimti: 0 };
  };
  jobStore.listExpired = async () => [];
  jobStore.system.listReferencedStorageKeys = async () => null;
  console.warn = (...a) => warnai.push(a.map(String).join(" "));

  return retentionSweeper
    .runRetentionSweep({ now: Date.now() })
    .then((summary) => {
      assert.equal(kviesta, 0, "kandidatų užklausa NEGALI būti pasiekta su `NaN` riba");
      assert.equal(summary.resultAttempts, null, "neįvykęs žingsnis pranešamas `null`");
      assert.ok(
        warnai.some((e) => e.includes("attempt_sweep_skipped")),
        `sargas privalo palikti pėdsaką: ${JSON.stringify(warnai)}`
      );
    })
    .finally(() => {
      process.env.LOG_LEVEL = tikrasLygis;
      config.revivalHorizonsMs = tikras.horizonai;
      tombstones.jungtiesTapatybe = tikras.zymuTapatybe;
      jobStore.listExpired = tikras.listExpired;
      console.warn = tikras.warn;
      Object.assign(jobStore.system, {
        valytiniBandymai: tikras.valytini,
        jungtiesTapatybe: tikras.tapatybe,
        listReferencedStorageKeys: tikras.nuorodos,
      });
    });
});
