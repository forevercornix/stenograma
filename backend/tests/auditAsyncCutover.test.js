const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const auditLog = require("../utils/auditLog");
const {
  AUDIT_EVENTS,
  KATEGORIJA,
  IŠVEDAMI_ĮVYKIAI,
  kategorija,
  arBlokuojantis,
  validateAuditEvents,
  UnclassifiedAuditEventError,
} = require("../utils/auditEvents");
const {
  rasytiAudita,
  AuditWriteError,
  auditWriteTimeoutMs,
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  getAuditCounters,
  _resetAuditCountersForTests,
} = require("../utils/auditWrite");

/**
 * AUDITO FASADO ASYNC CUTOVER (#155, 7.4a / #210).
 *
 * ⚠️ KODĖL ŠIE TESTAI EGZISTUOJA.
 *
 * `record()` tapus async, KIEKVIENAS iš 28 produkcinių kvietimų gali tapti
 * fire-and-forget nepakeitus nė vienos matomos elgsenos: job'as pavyks, HTTP
 * atsakymas bus tas pats, o audito įrašo tiesiog nebus. Regresija nematoma be
 * testų, kurie tikrina būtent Promise likimą.
 */

/** Backend'as, kuris VISADA krinta - sentinel tekstas seka kelią iki atsakymo. */
const SENTINEL = "SENTINEL_DB_SLAPTAZODIS_neturi_nutekėti";

function krentantisBackend() {
  return {
    normalizeEvent: auditLog.normalizeEvent,
    record: async () => {
      throw new Error(SENTINEL);
    },
  };
}

/** Backend'as, kuris niekada neišsisprendžia - timeout testams. */
function kabantisBackend() {
  return {
    normalizeEvent: auditLog.normalizeEvent,
    record: () => new Promise(() => {}),
  };
}

/** Trumpa riba - deterministiškai, be realaus 2 s laukimo. */
function suTrumpaRiba(ms, veiksmas) {
  const senas = process.env.AUDIT_WRITE_TIMEOUT_MS;
  process.env.AUDIT_WRITE_TIMEOUT_MS = String(ms);
  const grazinti = () => {
    if (senas === undefined) delete process.env.AUDIT_WRITE_TIMEOUT_MS;
    else process.env.AUDIT_WRITE_TIMEOUT_MS = senas;
  };
  return Promise.resolve(veiksmas()).finally(grazinti);
}

/**
 * Produkciniai `.js` failai - BE SHELL'O.
 *
 * ⚠️ ANKSČIAU ČIA BUVO `execFileSync("sh", ["-c", `cd ${...} && find ...`])`.
 *
 * CodeQL `js/shell-command-injection-from-environment` tai pagavo teisingai:
 * absoliutus repo kelias buvo interpoliuojamas į shell eilutę, tad kelias su
 * tarpu ar shell metasimboliu būtų pakeitęs komandos prasmę. Sprendimas -
 * ne ekranavimas, o shell'o pašalinimas: Node `fs` apėjimas to klausimo
 * apskritai neturi ir nepriklauso nuo `sh`, `find`, `xargs` ar `grep` buvimo.
 */
const PRODUKCINIAI_KATALOGAI = ["utils", "services", "middleware", "routes", "workers", "queues"];

function produkciniaiFailai() {
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..");
  const failai = [];

  for (const katalogas of PRODUKCINIAI_KATALOGAI) {
    const dir = path.join(šaknis, katalogas);
    if (!fs.existsSync(dir)) continue;
    for (const įrašas of fs.readdirSync(dir, { recursive: true })) {
      const kelias = path.join(dir, String(įrašas));
      if (!String(įrašas).endsWith(".js")) continue;
      if (!fs.statSync(kelias).isFile()) continue;
      failai.push({ kelias, turinys: fs.readFileSync(kelias, "utf8") });
    }
  }
  return failai;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. KLASIFIKACIJOS PILNUMAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("KLASIFIKACIJA: kiekvienas žinomas įvykis turi vieną iš DVIEJŲ kategorijų", () => {
  const kategorijos = new Set(Object.values(AUDIT_EVENTS));
  assert.deepEqual(
    [...kategorijos].sort(),
    [KATEGORIJA.BLOKUOJANTIS, KATEGORIJA.NEBLOKUOJANTIS].sort(),
    "trečios kategorijos nėra (#210)"
  );
  assert.ok(Object.keys(AUDIT_EVENTS).length >= 20, "klasifikacija negali tyliai susitraukti");
});

test("KLASIFIKACIJA: neklasifikuotas įvykis yra KONTROLIUOJAMA klaida, ne numatytoji kategorija", () => {
  /**
   * ⚠️ `default: "non-blocking"` būtų tyli saugumo regresija: naujas
   * security įvykis paveldėtų silpnesnę semantiką ir niekas to nepastebėtų.
   */
  assert.throws(() => kategorija("VISAI_NAUJAS_EVENT"), UnclassifiedAuditEventError);
  assert.throws(() => arBlokuojantis("VISAI_NAUJAS_EVENT"), /neturi klasifikacijos/);

  /** Prototipo laukai negali praeiti kaip „klasifikuoti". */
  assert.throws(() => kategorija("constructor"), UnclassifiedAuditEventError);
  assert.throws(() => kategorija("toString"), UnclassifiedAuditEventError);
});

test("KLASIFIKACIJA: `normalizeEvent()` IŠVEDAMI įvykiai klasifikuoti", () => {
  /**
   * ⚠️ IŠVESTA IŠ AUTORITETO, NE IŠ ANTRO SĄRAŠO.
   *
   * Šie įvykiai neturi literalo nė viename call site'e - juos sukuria
   * `normalizeEvent()` fallback šakos. Testas kviečia TIKRĄ funkciją su
   * kiekviena šaka ir reikalauja, kad rezultatas būtų klasifikuotas: naujos
   * šakos pridėjimas be įrašo `AUDIT_EVENTS` sulaužo šį testą.
   */
  const šakos = [
    { transcriptionProvider: "whisper", success: true },
    { transcriptionProvider: "whisper", success: false },
    { llmProvider: "openai", success: true },
    { llmProvider: "openai", success: false },
    { success: true },
    { success: false },
  ];

  const gauti = new Set(šakos.map((e) => auditLog.normalizeEvent(e)));
  for (const įvykis of gauti) {
    assert.doesNotThrow(
      () => kategorija(įvykis),
      `normalizeEvent() grąžina "${įvykis}", bet jis neklasifikuotas`
    );
  }

  assert.deepEqual(
    [...gauti].sort(),
    [...IŠVEDAMI_ĮVYKIAI].sort(),
    "IŠVEDAMI_ĮVYKIAI turi atitikti TIKRĄ normalizeEvent() išvestį"
  );
});

test("KLASIFIKACIJA: visi produkciniai `event:` literalai klasifikuoti (tripwire)", () => {
  /**
   * ⚠️ TAI TRIPWIRE, NE ELGSENOS ĮRODYMAS (AGENTS.md §9.2).
   *
   * Statinė paieška negali įrodyti, kad kelias vykdomas - bet ji pagauna NAUJĄ
   * call site'ą su neklasifikuotu įvykiu PRIEŠ jam pirmą kartą suveikiant
   * produkcijoje. Elgsenos pusę dengia `rasytiAudita()` testai žemiau.
   */
  const literalai = new Set();
  for (const { turinys } of produkciniaiFailai()) {
    for (const m of turinys.matchAll(/event:\s*"([A-Z_0-9]+)"/g)) literalai.add(m[1]);
  }

  assert.ok(literalai.size >= 15, `paieška turi rasti realius call site'us (rado ${literalai.size})`);

  for (const įvykis of literalai) {
    assert.doesNotThrow(
      () => kategorija(įvykis),
      `produkcinis call site'as rašo "${įvykis}", bet jis neklasifikuotas utils/auditEvents.js`
    );
  }
});

test("KLASIFIKACIJA: įvykiai, nurodomi per KONSTANTĄ, taip pat klasifikuoti", () => {
  /**
   * ⚠️ SPRAGA, KURIĄ ŠIS TESTAS UŽDARO.
   *
   * Aukščiau esantis tripwire ieško `event: "LITERALAS"`. Bet
   * `services/adminJobService.js` rašo `event: ADMIN_EVENT.ACCESS_DENIED` -
   * literalo call site'e NĖRA, tad paieška tų trijų įvykių nematė. Patikrinta
   * mutacija: pašalinus `ADMIN_ACCESS_DENIED` iš klasifikacijos, VISI testai
   * praeidavo.
   *
   * Sąrašas imamas iš PAČIOS konstantos (`Object.values`), ne perrašomas ranka -
   * naujas `ADMIN_EVENT` įrašas be klasifikacijos krinta automatiškai.
   */
  const { ADMIN_EVENT } = require("../services/adminJobService");

  const reikšmės = Object.values(ADMIN_EVENT);
  assert.ok(reikšmės.length >= 3, "ADMIN_EVENT negali tyliai susitraukti");

  for (const įvykis of reikšmės) {
    assert.doesNotThrow(
      () => kategorija(įvykis),
      `ADMIN_EVENT reikšmė "${įvykis}" neklasifikuota utils/auditEvents.js`
    );
  }
});

test("KLASIFIKACIJA: NAUJAS konstantos šaltinis negali praslysti nepastebėtas", () => {
  /**
   * ⚠️ KODĖL NEPAKANKA TIESIOG PATIKRINTI `ADMIN_EVENT`.
   *
   * Jei rytoj kas nors pridės `event: KITAS_MODULIS.NAUJAS`, nei literalų
   * paieška, nei `ADMIN_EVENT` patikra jo nepamatys - ir įvykis vėl liktų be
   * klasifikacijos sargo.
   *
   * ⚠️ SKENUOJAMI TIK `rasytiAudita(` BLOKAI, ne visas failas: `event:` kaip
   * lauko vardas pasitaiko ir Zod schemose (`middleware/validate.js` audito
   * užklausos filtre), o tai NĖRA audito įvykio šaltinis.
   */
  const šaltiniai = new Set();

  for (const { turinys } of produkciniaiFailai()) {
    const eilutės = turinys.split("\n");
    eilutės.forEach((eilutė, idx) => {
      if (!eilutė.includes("rasytiAudita(")) return;
      const blokas = eilutės.slice(idx, idx + 12).join("\n");
      const m = /event:\s*([A-Za-z_][A-Za-z_.]*)/.exec(blokas);
      if (m && m[1].includes(".")) šaltiniai.add(m[1]);
    });
  }

  assert.deepEqual(
    [...šaltiniai].sort(),
    ["ADMIN_EVENT.ACCESS_DENIED", "ADMIN_EVENT.DELETE_OVERRIDE", "ADMIN_EVENT.ORPHAN_CLEANUP"],
    "atsirado naujas ne literalus `event:` šaltinis - jį reikia padengti klasifikacijos patikra"
  );
});

test("KLASIFIKACIJA: neklasifikuotas įvykis aptinkamas PALEIDIMO metu", () => {
  /**
   * #210: „neklasifikuotas → klaida starto metu". `record()` metimas gedimą
   * atskleistų tik tada, kai tas įvykis realiai įvyksta - pvz. per pirmą GDPR
   * ištrynimą.
   */
  assert.deepEqual(validateAuditEvents(), [], "dabartinė klasifikacija pilna");

  const { validateConfig } = require("../utils/startupChecks");
  const { errors } = validateConfig({});
  assert.deepEqual(
    errors.filter((e) => /[Aa]udito įvykis/.test(e)),
    [],
    "startas neturi rodyti audito klasifikacijos klaidų"
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. BLOKUOJANTIS KELIAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("BLOKUOJANTIS: patvirtintas įrašas leidžia veiksmui pavykti", async () => {
  await auditLog.clear();
  const row = await rasytiAudita({ event: "LOGIN_SUCCESS", success: true });

  assert.ok(row, "sėkmingas rašymas grąžina eilutę");
  assert.equal(row.event, "LOGIN_SUCCESS");
  assert.equal((await auditLog.getAll()).length, 1);
});

test("BLOKUOJANTIS: backend'o klaida ATMETA veiksmą (fail-closed)", async () => {
  /**
   * MUTACIJA: pakeitus `LOGIN_SUCCESS` kategoriją į neblokuojančią, šis testas
   * krinta - `rasytiAudita()` grąžintų `null` vietoj metimo.
   */
  await assert.rejects(
    () => rasytiAudita({ event: "LOGIN_SUCCESS", success: true }, { auditLog: krentantisBackend() }),
    (e) => e instanceof AuditWriteError && e.code === "AUDIT_WRITE_FAILED"
  );
});

test("BLOKUOJANTIS: timeout ATMETA veiksmą per RIBOTĄ laiką", async () => {
  const pradzia = Date.now();

  await suTrumpaRiba(80, async () => {
    await assert.rejects(
      () => rasytiAudita({ event: "DATA_ERASED", success: true }, { auditLog: kabantisBackend() }),
      /timeout po 80 ms/
    );
  });

  const trukmeMs = Date.now() - pradzia;
  assert.ok(trukmeMs < 3000, `blokuojantis kelias privalo grįžti su riba (truko ${trukmeMs} ms)`);
});

test("BLOKUOJANTIS: neklasifikuotas įvykis irgi atmeta veiksmą", async () => {
  await assert.rejects(
    () => rasytiAudita({ event: "NEZINOMAS_SAUGUMO_EVENT", success: true }),
    UnclassifiedAuditEventError
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. NEBLOKUOJANTIS KELIAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("NEBLOKUOJANTIS: backend'o klaida NENUMUŠA operacijos, bet DIDINA skaitiklį", async () => {
  _resetAuditCountersForTests();

  const rezultatas = await rasytiAudita(
    { event: "TRANSCRIPTION_COMPLETED", success: true },
    { auditLog: krentantisBackend() }
  );

  assert.equal(rezultatas, null, "neblokuojantis gedimas grąžina null, o ne meta");
  assert.equal(getAuditCounters().auditWriteFailures, 1, "gedimas privalo būti matomas skaitikliu");
});

test("NEBLOKUOJANTIS: timeout turi TĄ PAČIĄ semantiką", async () => {
  _resetAuditCountersForTests();

  await suTrumpaRiba(80, async () => {
    const rezultatas = await rasytiAudita(
      { event: "PROTOCOL_COMPLETED", success: true },
      { auditLog: kabantisBackend() }
    );
    assert.equal(rezultatas, null);
  });

  assert.equal(getAuditCounters().auditWriteFailures, 1);
});

test("NEBLOKUOJANTIS: gedimas RAŠOMAS `error` lygiu su `request_id`", async () => {
  /**
   * ⚠️ SKAITIKLIO VIENO NEPAKANKA.
   *
   * #210 reikalauja TRIJŲ dalykų kartu: operacija tęsiasi, gedimas logginamas
   * `error` lygiu, ir loge yra `request_id`. Realizacija, kuri tik didintų
   * skaitiklį, paliktų operatorių su skaičiumi be konteksto - nebūtų kaip
   * susieti gedimo su konkrečia užklausa.
   *
   * ⚠️ `request_id` NEPERDUODAMAS RANKOMIS. `utils/logger.js` jį prideda
   * automatiškai iš request konteksto (`runWithContext`), tad testas naudoja tą
   * patį produkcinį modelį - jei kas nors išjungtų konteksto perdavimą, testas
   * kristų.
   */
  const requestContext = require("../utils/requestContext");

  const eilutės = [];
  const originalusError = console.error;
  console.error = (...args) => eilutės.push(args.map(String).join(" "));

  const senasLygis = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  _resetAuditCountersForTests();

  const REQ_ID = "req-7-4a-testinis";
  let rezultatas;
  try {
    await requestContext.runWithContext({ requestId: REQ_ID }, async () => {
      rezultatas = await rasytiAudita(
        { event: "PROCESSING_COMPLETED", success: true },
        { auditLog: krentantisBackend() }
      );
    });
  } finally {
    console.error = originalusError;
    if (senasLygis === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = senasLygis;
  }

  /** 1. Operacija NEKRINTA. */
  assert.equal(rezultatas, null, "neblokuojantis gedimas negali mesti kvietėjui");

  /** 2. Gedimas užfiksuotas `error` lygiu. */
  const logas = eilutės.join("\n");
  assert.ok(eilutės.length > 0, "gedimas privalo palikti logo įrašą, ne būti nutylėtas");
  assert.match(logas, /"level":"error"|error/i, "logas privalo būti `error` lygio");
  assert.match(logas, /Neblokuojantis audito rašymas nepavyko/, "logas privalo įvardyti gedimą");

  /** 3. `request_id` loge - kitaip gedimo nesusieti su užklausa. */
  assert.ok(logas.includes(REQ_ID), `loge privalo būti request_id (${REQ_ID})`);

  /** 4. Skaitiklis padidintas. */
  assert.equal(getAuditCounters().auditWriteFailures, 1);
});

test("SKAITIKLIS: sėkmingas rašymas jo NEDIDINA", async () => {
  await auditLog.clear();
  _resetAuditCountersForTests();

  await rasytiAudita({ event: "EXPORT_COMPLETED", success: true });

  assert.equal(getAuditCounters().auditWriteFailures, 0);
});

test("SKAITIKLIS: viena klaida per kelis helperių sluoksnius NEDVIGUBINAMA", async () => {
  /**
   * ⚠️ `lifecycleService.writeAudit()` ir `authorizeJobOrAudit()` yra helperiai
   * VIRŠ `rasytiAudita()`. Jei kiekvienas sluoksnis skaičiuotų pats, vienas
   * gedimas atrodytų kaip keli, ir signalas prarastų prasmę.
   */
  _resetAuditCountersForTests();

  const helperis = () =>
    rasytiAudita({ event: "UPLOAD_REJECTED", success: false }, { auditLog: krentantisBackend() });
  const perDuSluoksnius = () => helperis();

  await perDuSluoksnius();

  assert.equal(getAuditCounters().auditWriteFailures, 1, "vienas gedimas = vienas inkrementas");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. TIMEOUT KONFIGŪRACIJA
 * ═══════════════════════════════════════════════════════════════════════════ */

test("TIMEOUT: `AUDIT_WRITE_TIMEOUT_MS` numatyta 2000 ir konfigūruojama", () => {
  assert.equal(DEFAULT_AUDIT_WRITE_TIMEOUT_MS, 2000, "#210 užfiksuota reikšmė");
  assert.equal(auditWriteTimeoutMs({}), 2000);
  assert.equal(auditWriteTimeoutMs({ AUDIT_WRITE_TIMEOUT_MS: "150" }), 150);

  /** Šiukšlė NEGALI virsti neribotu laukimu. */
  assert.equal(auditWriteTimeoutMs({ AUDIT_WRITE_TIMEOUT_MS: "abc" }), 2000);
  assert.equal(auditWriteTimeoutMs({ AUDIT_WRITE_TIMEOUT_MS: "0" }), 2000);
  assert.equal(auditWriteTimeoutMs({ AUDIT_WRITE_TIMEOUT_MS: "-5" }), 2000);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. `unhandledRejection` REGRESIJA (#210 privalomas)
 * ═══════════════════════════════════════════════════════════════════════════ */

test("unhandledRejection: NĖ VIENAS audito kelias nepalieka nesuvaldyto Promise", async () => {
  /**
   * ⚠️ TAI PAGRINDINIS FIRE-AND-FORGET DETEKTORIUS.
   *
   * Fire-and-forget kvietimas (`auditLog.record(...)` be `await`) su krentančiu
   * backend'u sukelia būtent `unhandledRejection`. Testas paleidžia VISUS tris
   * gedimo režimus ir reikalauja, kad handleris nesuveiktų nė karto.
   *
   * ⚠️ Listener'is BŪTINAI pašalinamas `finally` - kitaip jis liktų kaboti ir
   * gaudytų kitų testų failų rejection'us.
   */
  const pagauti = [];
  const handler = (priezastis) => pagauti.push(priezastis);
  process.on("unhandledRejection", handler);

  try {
    // (a) blokuojantis + backend klaida → veiksmas atmestas
    await assert.rejects(
      () => rasytiAudita({ event: "AUTHORIZATION_DENIED", success: false }, { auditLog: krentantisBackend() }),
      AuditWriteError
    );

    // (b) neblokuojantis + backend klaida → operacija tęsiasi
    const nebl = await rasytiAudita(
      { event: "PROCESSING_FAILED", success: false },
      { auditLog: krentantisBackend() }
    );
    assert.equal(nebl, null);

    // (c) timeout abiejuose keliuose
    await suTrumpaRiba(60, async () => {
      await assert.rejects(
        () => rasytiAudita({ event: "LOGOUT", success: true }, { auditLog: kabantisBackend() }),
        AuditWriteError
      );
      assert.equal(
        await rasytiAudita({ event: "EXPORT_FAILED", success: false }, { auditLog: kabantisBackend() }),
        null
      );
    });

    /** Vėluojančiai atmestam Promise duodam laiko nukristi, jei jis nesuvaldytas. */
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(pagauti, [], `unhandledRejection suveikė ${pagauti.length} kartus`);
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("unhandledRejection: VĖLUOJANTI backend klaida po timeout nesukelia rejection", async () => {
  /**
   * Po timeout originalus Promise lieka gyvas. Be handlerio jo vėlesnis
   * `reject` nukristų į procesą jau PO to, kai kvietėjas gavo atsakymą - t. y.
   * gedimas atrodytų kaip nesusijęs crash.
   */
  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    const veluojantis = {
      normalizeEvent: auditLog.normalizeEvent,
      record: () =>
        /**
         * ⚠️ BE `.unref()`: laikmatis privalo laikyti event loop gyvą, kitaip
         * procesas išsektų dar prieš vėluojančiai klaidai suveikiant, ir
         * testas tikrintų būtent tai, ko netikrina.
         */
        new Promise((_, reject) => setTimeout(() => reject(new Error(SENTINEL)), 40)),
    };

    await suTrumpaRiba(15, async () => {
      await assert.rejects(
        () => rasytiAudita({ event: "LOGIN_FAILED", success: false }, { auditLog: veluojantis }),
        /timeout/
      );
    });

    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(pagauti, [], "vėluojanti klaida privalo būti suvaldyta");
  } finally {
    process.off("unhandledRejection", handler);
  }
});
