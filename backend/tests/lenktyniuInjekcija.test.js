const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { INJEKCIJOS_RIBA_MS } = require("./helpers/raceInjection");

/**
 * `raceInjection` RIBOS ELGSENOS ĮRODYMAS (#412).
 *
 * ⚠️ KĄ ŠIS SARGAS GINA. `postgresStore.integration` CAS lenktynių testai (9
 * kvietimai) įterpia konkurentinę mutaciją ANTRA jungtimi, kol store transakcija
 * dar atidaryta. Tai veikia tik todėl, kad store prieš CAS neužrakina eilutės
 * (#180 P2-3). Grąžinus pesimistinį užraktą, injekcija užsiblokuotų, store lauktų
 * injekcijos, ir testas kabotų iki CI laikmačio — CI parodytų tik „timeout", be
 * nuorodos į regresijos vietą. `raceInjection` tam turi savo ribą.
 *
 * ⚠️ IKI #412 PATS SARGAS ĮRODYMO NETURĖJO, ir jo gedimas yra TYLUS PAGAL
 * KONSTRUKCIJĄ: su `unref()`, su per ilga riba arba su kabančiu valymu visos trys
 * būsenos atrodo vienodai — testai žali, kol regresijos nėra.
 *
 * ⚠️ TRYS SAVYBĖS, TRYS PARAŠAI. Kiekviena mutacija privalo duoti SKIRTINGĄ
 * parašą; jei dvi duotų tą patį, testas jų neatskirtų ir vienos gedimą priskirtų
 * kitai. Parašai išmatuoti (2026-09-26, `8cb203f`):
 *
 *     mutacija                     baigtis      įvykiai                  exit  gyveno
 *     — (bazė)                     ERR:riba     uzklausa,cancel,release(true)  0  ≈ribaMs
 *     M1 `Promise.race` → `darbas` NEBAIGTA     uzklausa                       1  ≈ribaMs
 *     M2 laikmačiui `unref()`      NEBAIGTA     uzklausa                       0  ≈0
 *     M3 valyme `await darbas`     NEBAIGTA     uzklausa,cancel                0  ≈ribaMs
 *
 * M1 nuo M3 skiria `exit` ir `stderr`; M2 nuo abiejų — `gyveno`; M3 nuo M1 —
 * `cancel` įvykis. Nė vienas parašas nesikartoja.
 */

const MODULIS = path.join(__dirname, "helpers", "raceInjection.js");

/**
 * ⚠️ NETIKRAS POOL'AS GYVENA ČIA, NE `tests/helpers/` (D4). Naujas bendras
 * mechanizmas pats liktų be įrodymo — tai atkartotų problemą, kurią #412 uždaro.
 *
 * ⚠️ JOKIO `require("pg")` (D5). `suiteDerivation.test.js:272–288` reikalauja, kad
 * `pg` importuojantis testas priklausytų `postgres` rinkiniui; netikras pool'as yra
 * grynas objektas, tad šis failas lieka `functional` ir vykdomas be DB.
 */
const VAIKO_KODAS = `
  const t0 = Date.now();
  const { sukurtiInjektoriu } = require(process.argv[1]);
  const rezimas = process.argv[2];
  const ribaMs = Number(process.argv[3]);

  const ivykiai = [];
  let baigtis = "NEBAIGTA";

  /** ⚠️ Išvestis per \`exit\`, ne per \`then\`: mutacijos, kuriose pažadas NIEKADA
   *  neišsisprendžia, kitaip neduotų jokio parašo, ir M1/M2/M3 susilietų. */
  process.on("exit", () => {
    process.stdout.write(JSON.stringify({ baigtis, ivykiai, gyveno: Date.now() - t0 }));
  });

  const klientas = {
    async query(sql) {
      if (/pg_backend_pid/.test(sql)) return { rows: [{ pid: 4242 }] };
      ivykiai.push("uzklausa");
      if (rezimas === "kabo") return new Promise(() => {});
      if (rezimas === "klaida") throw Object.assign(new Error("syntax error"), { code: "42601" });
      return { rows: [{ ok: 1 }] };
    },
    release(sunaikinti) { ivykiai.push(sunaikinti === true ? "release(true)" : "release()"); },
  };

  const pool = {
    async connect() { return klientas; },
    async query(sql, p) { ivykiai.push("cancel:" + p[0]); return { rows: [] }; },
  };

  sukurtiInjektoriu(() => pool, ribaMs)("UPDATE x", [], "zondas").then(
    () => { baigtis = "OK"; },
    (e) => { baigtis = "ERR:" + e.message; }
  );
`;

/**
 * ⚠️ DVIEJŲ RIBŲ PRINCIPAS. Vidinė `ribaMs` yra TESTUOJAMAS objektas ir paduodama
 * per esamą produkcinės funkcijos parametrą — testas negali savo `Promise.race`
 * kopija įrodinėti produkcinio. Išorinė riba yra tik fail-safe: 16× ilgesnė už
 * vidinę ir 24× trumpesnė už `FAILO_RIBA_MS` (120 s, #382), tad jos suveikimas
 * niekada nebūtų painiojamas su produkcinės ribos suveikimu.
 */
const VIDINE_RIBA_MS = 300;
const ISORINE_RIBA_MS = 5000;

/**
 * ⚠️ HARNESS NETURI KITO `ref`'UOTO HANDLE'O: `stdin` išjungtas, jokių laikmačių,
 * o `raceInjection.js` neturi nė vieno `require`. Tai ne deklaracija — tai
 * tikrinama M2 mutacija: jei kas nors kitas laikytų event loop'ą, vaikas ir su
 * `unref()` gyvuotų iki ribos, ir mutacija taptų nejautri.
 */
function paleistiVaika(rezimas, ribaMs = VIDINE_RIBA_MS) {
  const r = spawnSync(
    process.execPath,
    ["-e", VAIKO_KODAS, MODULIS, rezimas, String(ribaMs)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ISORINE_RIBA_MS,
      env: { PATH: process.env.PATH },
    }
  );

  assert.notEqual(
    r.signal,
    "SIGTERM",
    `vaikas pasiekė IŠORINĘ ${ISORINE_RIBA_MS} ms ribą - vidinė riba nesuveikė`
  );

  let isvestis = null;
  try {
    isvestis = JSON.parse(r.stdout);
  } catch {
    assert.fail(`vaikas negrąžino parašo. stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
  }

  return { ...isvestis, kodas: r.status, stderrIlgis: (r.stderr || "").length, stderr: r.stderr || "" };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. RIBA SUVEIKIA (M1)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ KRITERIJUS NEGALI REMTIS `exit ≠ 0` AR `stderr` TEKSTU. Pašalinus
 * `Promise.race`, `riba` lieka be klausytojo ir po `ribaMs` Node išspausdina TĄ
 * PATĮ pranešimą bei baigia kodu 1 — testas, tikrinantis tekstą, praeitų, nors
 * sargas nebeveikia. Išmatuota: eilutės `UnhandledPromiseRejection` Node 22
 * NESPAUSDINA, tad ir jos nebuvimas neatskiria. Todėl tvirtinama, kad atmetimą
 * apdorojo PATI funkcija (struktūruota žymė) ir kad `stderr` yra TUŠČIAS.
 */
test("#412 RIBA: atmetimą apdoroja pati funkcija, `stderr` lieka tuščias", () => {
  const v = paleistiVaika("kabo");

  assert.match(v.baigtis, /^ERR:race injection blocked before CAS/, "(a) struktūruota žymė");
  assert.equal(v.stderrIlgis, 0, `(b) \`stderr\` privalo būti tuščias, gauta: ${v.stderr}`);
  assert.equal(v.kodas, 0, "neapdorotas atmetimas duotų kodą 1");
  assert.deepEqual(v.ivykiai, ["uzklausa", "cancel:4242", "release(true)"], "(c) valymas įvykdytas");
});

test("#412 DIAGNOSTIKA: pranešimas turi kontekstą, ribą ir nuorodą į #180", () => {
  const v = paleistiVaika("kabo");

  assert.match(v.baigtis, /\[zondas\]/, "kontekstas privalo įvardyti KURIS kvietimas");
  assert.match(v.baigtis, new RegExp(`after ${VIDINE_RIBA_MS} ms`), "riba privalo būti pranešime");
  assert.match(v.baigtis, /#180 P2-3\/P3-10/, "be nuorodos operatorius neras regresijos vietos");
  assert.match(v.baigtis, /pessimistic row lock/, "privalo įvardyti ĮTARIAMĄ priežastį");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. LAIKMATIS BE `unref()` (M2)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ ŠI SAVYBĖ MATUOJAMA VAIKO GYVAVIMO TRUKME, NE JO IŠVESTIMI. Su `unref()`
 * niekas viduje nekrenta — procesas tiesiog baigiasi anksčiau, nei riba suveikia,
 * ir sargas tyliai nesuveikia. Trukmė skaičiuojama VAIKO viduje, tad Node starto
 * kaina į matavimą nepatenka ir lėtas runner'is rezultato neiškreipia.
 */
test("#412 `unref()` NĖRA: procesas išgyvena iki ribos, nors užklausa loop'o nelaiko", () => {
  const v = paleistiVaika("kabo");

  /**
   * ⚠️ TVIRTINAMA TIK GYVAVIMO TRUKMĖ, SĄMONINGAI. Pridėjus čia dar ir žymės
   * patikrą, testas kristų ir nuo M1 (riba pašalinta), ir nuo M3 (valymas laukia) —
   * t. y. vienos savybės gedimą priskirtų kitai. Žymę tikrina 1-as testas; čia
   * lieka vienintelis dalykas, kurį nukauna BŪTENT `unref()`.
   */
  assert.ok(
    v.gyveno >= VIDINE_RIBA_MS - 20,
    `vaikas gyveno ${v.gyveno} ms < ${VIDINE_RIBA_MS} ms - laikmatis nebelaiko event loop'o`
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. VALYMAS NELAUKIA UŽSTRIGUSIOS UŽKLAUSOS (M3)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ `await darbas` valyme reikštų, kad pats valymas gali kaboti amžinai — t. y.
 * tiksliai tas gedimas, kurio riba turi išvengti. Išmatuota, kad tokia mutacija
 * NEKABO: išvalius laikmatį niekas loop'o nebelaiko ir procesas tyliai baigiasi.
 * Todėl parašas yra `release(true)` NEBUVIMAS po `cancel`, ne kabėjimas.
 */
test("#412 VALYMAS: po `pg_cancel_backend` jungtis sunaikinama NELAUKIANT užklausos", () => {
  const v = paleistiVaika("kabo");

  const cancelVieta = v.ivykiai.indexOf("cancel:4242");
  const releaseVieta = v.ivykiai.indexOf("release(true)");

  assert.notEqual(cancelVieta, -1, "užstrigęs backend'as privalo būti nutrauktas");
  assert.notEqual(releaseVieta, -1, "jungtis privalo būti sunaikinta, o ne grąžinta į pool'ą");
  assert.ok(releaseVieta > cancelVieta, "naikinama PO nutraukimo");
  assert.match(v.baigtis, /^ERR:/, "valymas privalo baigtis, ne praryti atmetimą");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. TEIGIAMOS KONTROLĖS
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ ŠIOS KONTROLĖS MUTACIJA — `clearTimeout` PAŠALINIMAS, NE `baigta = true`
 * PAŠALINIMAS SĖKMĖS ŠAKOJE. Išmatuota: `baigta` sėkmės kelyje niekas neskaito
 * (`catch` nevykdomas), tad ta mutacija rezultato nekeičia ir kontrolė būtų
 * dekoracija. `clearTimeout` pašalinimas matomas per `gyveno`.
 */
test("#412 KONTROLĖ sėkmė: rezultatas grąžintas, švelnus `release()`, riba neprailgina", () => {
  const v = paleistiVaika("sekme");

  assert.equal(v.baigtis, "OK");
  assert.deepEqual(v.ivykiai, ["uzklausa", "release()"], "jokio `cancel`, jokio `release(true)`");
  assert.ok(
    v.gyveno < VIDINE_RIBA_MS,
    `sėkmingas kelias truko ${v.gyveno} ms ≥ ${VIDINE_RIBA_MS} ms - \`clearTimeout\` nesuveikė`
  );
});

/**
 * ⚠️ KLAIDOS KELIAS SKIRIASI ELGSENA, NE TIK REZULTATU. Jei `baigta` logika
 * sugestų (`:50`), įprasta SQL klaida imtų kviesti `pg_cancel_backend` ir naikinti
 * jungtį — to šiandien niekas nepastebėtų.
 */
test("#412 KONTROLĖ greita SQL klaida: ta pati švelni šaka, be `pg_cancel_backend`", () => {
  const v = paleistiVaika("klaida");

  assert.equal(v.baigtis, "ERR:syntax error");
  assert.deepEqual(v.ivykiai, ["uzklausa", "release()"]);
  assert.ok(v.gyveno < VIDINE_RIBA_MS, "klaidos kelias neturi laukti ribos");
});

/**
 * ⚠️ PILNAS PARAŠAS VIENOJE VIETOJE.
 *
 * Kiekviena iš trijų mutacijų pajudina SKIRTINGĄ šio parašo lauką, tad kritimo
 * išvestis iškart parodo, KURI savybė sugedo:
 *
 *     M1  kodas 0→1, `stderr` tuščias→ne, `cancel` dingsta
 *     M2  `gyveno` ≈ribaMs→≈0
 *     M3  `release(true)` dingsta, `cancel` lieka
 *
 * Be šio testo M1 ir M3 skirtųsi tik pavienių asercijų tekstais, ir vienos
 * savybės gedimą būtų lengva priskirti kitai.
 */
test("#412 PARAŠAS: ribos kelio baigtis, įvykiai, kodas ir `stderr` — tikslūs", () => {
  const v = paleistiVaika("kabo");

  assert.deepEqual(
    {
      zyme: v.baigtis.slice(0, 40),
      ivykiai: v.ivykiai,
      kodas: v.kodas,
      stderrIlgis: v.stderrIlgis,
      pasiekeRiba: v.gyveno >= VIDINE_RIBA_MS - 20,
    },
    {
      zyme: "ERR:race injection blocked before CAS af",
      ivykiai: ["uzklausa", "cancel:4242", "release(true)"],
      kodas: 0,
      stderrIlgis: 0,
      pasiekeRiba: true,
    }
  );
});

test("#412 numatytoji riba nepakitusi", () => {
  assert.equal(INJEKCIJOS_RIBA_MS, 5000);
});
