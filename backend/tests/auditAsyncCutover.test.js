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
  producerIvykiai,
  POST_HOC_IVYKIAI,
  arPostHoc,
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

test("POST-HOC: visi po-veiksmo įvykiai įvardyti eksplicitiškai ir LIEKA blokuojantys", () => {
  /**
   * ⚠️ ŠIS TESTAS SAUGO TERMINŲ ATSKYRIMĄ, NE ELGESĮ.
   *
   * `BLOKUOJANTIS` ir `fail-closed` anksčiau buvo sulipę viename komentare, ir
   * skaitytojas pagrįstai suprasdavo, kad audito gedimas apsaugo DUOMENIS.
   * Šiuose keliuose auditas rašomas JAU PO veiksmo, tad apsaugo tik ataskaitą:
   * keturi ištrynimo keliai, `LOGOUT` (sesija atšaukta ir cookie išvalytas dar
   * prieš įrašą) ir `ADMIN_DELETE_OVERRIDE` (artefaktai jau pašalinti).
   *
   * Rinkinys laikomas kode (ne vien prozoje), kad jį būtų galima tikrinti:
   *  - kiekvienas jo narys PRIVALO likti blokuojantis (kitaip prarastume ir
   *    tai, ką `9af1690` laimėjo - 503 vietoj tylaus 204);
   *  - naujas post-hoc kelias be įrašo čia liktų nepažymėtas, tad sąrašas
   *    lyginamas su tikslia aibe.
   */
  assert.deepEqual(
    [...POST_HOC_IVYKIAI].sort(),
    [
      "ADMIN_DELETE_OVERRIDE",
      "ADMIN_ORPHAN_CLEANUP",
      "DATA_ERASED",
      /**
       * ⚠️ PRIDĖTA #183 PERŽIŪROJE. Iki tol abu žymų keliai rašė auditą PRIEŠ
       * perėjimą; dabar perėjimas commit'inasi pirmas, tad audito gedimas jo
       * nebeatšaukia. Klasifikacija privalo sekti realizaciją - kitaip ji
       * tvirtintų apsaugą, kurios nebėra.
       */
      "ERASURE_MARK_FORCE_RESOLVED",
      /**
       * ⚠️ `release` seka tą pačią tvarką: perėjimas `pending → deletion_failed`
       * commit'inasi PRIEŠ auditą, tad audito gedimas jo neatšaukia.
       * Operatorius gauna 503 (sėkmė nedeklaruojama), bet pretenzija jau
       * atlaisvinta - post-hoc, ne fail-closed.
       */
      "ERASURE_MARK_RELEASED",
      "ERASURE_MARK_RETRIED",
      "LIFECYCLE_DELETION",
      "LOGOUT",
      "RETENTION_PURGE",
    ],
    "post-hoc aibė pasikeitė - patikrink, ar naujas kelias tikrai rašo auditą po veiksmo"
  );

  for (const įvykis of POST_HOC_IVYKIAI) {
    assert.equal(
      kategorija(įvykis),
      KATEGORIJA.BLOKUOJANTIS,
      `${įvykis} privalo likti blokuojantis: sėkmė nedeklaruojama be patvirtinto įrašo`
    );
    assert.ok(arPostHoc(įvykis));
  }

  /** Autentikacijos ir autorizacijos keliai NĖRA post-hoc - jiems fail-closed galioja pilnai. */
  for (const įvykis of ["LOGIN_SUCCESS", "AUTHORIZATION_DENIED", "JOB_EXECUTION_DENIED"]) {
    assert.ok(
      !arPostHoc(įvykis),
      `${įvykis} rašomas PRIEŠ veiksmą - jo negalima žymėti post-hoc`
    );
  }
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
  /**
   * ⚠️ NAUDOJAMAS TAS PATS SKENERIS, KURĮ VYKDO STARTAS.
   *
   * Antras, testui skirtas skeneris ilgainiui išsiskirtų su produkciniu - ir
   * testas tikrintų ne tą, ką realiai tikrina `startupChecks`. Be to
   * `producerIvykiai()` nuvalo komentarus; be to patikra pagauna savo pačios
   * dokumentacijos pavyzdžius (AGENTS.md §9.2) - taip ir nutiko rašant šį testą.
   */
  const { rasti: literalai, nezinomiSaltiniai } = producerIvykiai();

  assert.ok(literalai.size >= 15, `paieška turi rasti realius call site'us (rado ${literalai.size})`);
  assert.deepEqual(
    [...nezinomiSaltiniai],
    [],
    "neišspręstas konstantos šaltinis reiškia, kad pilnumo patikrinti neįmanoma"
  );

  /** ⚠️ Per KONSTANTĄ nurodomi `ADMIN_*` irgi privalo patekti į šią aibę. */
  assert.ok(
    [...literalai].filter((e) => e.startsWith("ADMIN_")).length >= 3,
    "startinis skeneris privalo išspręsti ADMIN_EVENT konstantas"
  );

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

  /**
   * ⚠️ PILNA KVIETIMO IŠRAIŠKA, NE FIKSUOTAS EILUČIŲ LANGAS.
   *
   * Ankstesnė versija žiūrėjo 12 eilučių nuo `rasytiAudita(`. Konstanta,
   * atsidūrusi toliau (pridėjus komentarą ar laukų), iškristų iš lango, ir
   * testas praeitų nepastebėjęs neklasifikuoto šaltinio. Dabar skaitomi
   * SUBALANSUOTI skliaustai - kvietimo pabaiga nustatoma struktūriškai.
   */
  const kvietimoTurinys = (turinys, nuo) => {
    let gylis = 0;
    for (let i = nuo; i < turinys.length; i++) {
      if (turinys[i] === "(") gylis++;
      else if (turinys[i] === ")") {
        gylis--;
        if (gylis === 0) return turinys.slice(nuo, i + 1);
      }
    }
    return turinys.slice(nuo);
  };

  for (const { turinys } of produkciniaiFailai()) {
    let nuo = 0;
    for (;;) {
      const idx = turinys.indexOf("rasytiAudita(", nuo);
      if (idx === -1) break;
      const kvietimas = kvietimoTurinys(turinys, idx + "rasytiAudita".length);
      const m = /event:\s*([A-Za-z_][A-Za-z_.]*)/.exec(kvietimas);
      if (m && m[1].includes(".")) šaltiniai.add(m[1]);
      nuo = idx + 1;
    }
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
 * 2b. BLOKUOJANTYS HELPERIAI NEIŠSISPRENDŽIA ANKSČIAU UŽ AUDITĄ
 *
 * ⚠️ SPRAGA, KURIĄ ŠIE TESTAI UŽDARO.
 *
 * `authorizeJobOrAudit()` ir `lifecycleService.writeAudit()` yra tos dvi
 * vietos, kurias #210 įvardija atskirai. Jų VIDINIS `await` iki šiol nebuvo
 * ginamas: mutacija `await rasytiAudita(...)` → `rasytiAudita(...)` PRAEIDAVO
 * visą 1396 testų suitą. Praktiškai tai reiškia, kad kas nors ateityje gali
 * „optimizuoti" tą eilutę, ir atmesti job'ai liktų be audito įrašo - tyliai,
 * be jokio kritimo. Tai ta pati fire-and-forget klasė, tik viena eilute giliau
 * nei call site'as.
 *
 * `workerAuthorization` regex gina KVIETĖJO `await`; šie testai gina VIDINĮ.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Audito backend'as, kurio įrašymą atlaisvina testas - leidžia tikrinti TVARKĄ. */
function atidedamasBackendas() {
  let atlaisvinti;
  const laukiantis = new Promise((r) => {
    atlaisvinti = r;
  });
  const originalus = auditLog.record;
  auditLog.record = async (entry) => {
    await laukiantis;
    return originalus.call(auditLog, entry);
  };
  return {
    atlaisvinti,
    grazinti: () => {
      auditLog.record = originalus;
    },
  };
}

/**
 * Audito backend'as, kuris krinta - per TIKRĄ modulio objektą, be injekcijos.
 *
 * ⚠️ `tikTiemsIvykiams` YRA BŪTINAS IZOLIACIJAI, ne patogumas.
 *
 * Ištrynimo kelias rašo DU blokuojančius įvykius: `DATA_ERASED`
 * (`utils/jobErasure.js`) ir `LIFECYCLE_DELETION` (`services/lifecycleService.js`).
 * Jei kristų abu, testas praeitų net pašalinus `await` iš `writeAudit()` -
 * atmetimą duotų pirmasis kelias, ir mutacija liktų nepastebėta. Patikrinta:
 * taip ir buvo, kol filtras neegzistavo.
 */
function suKrentanciuRecord(veiksmas, tikTiemsIvykiams = null) {
  const originalus = auditLog.record;
  auditLog.record = async (entry) => {
    const event = auditLog.normalizeEvent(entry);
    if (!tikTiemsIvykiams || tikTiemsIvykiams.includes(event)) {
      throw new Error(SENTINEL);
    }
    return originalus.call(auditLog, entry);
  };
  return Promise.resolve(veiksmas()).finally(() => {
    auditLog.record = originalus;
  });
}

test("BLOKUOJANTIS: `authorizeJobOrAudit()` NEIŠSISPRENDŽIA prieš patvirtintą auditą", async () => {
  /**
   * ⚠️ TIKRINAMA TVARKA, NE REZULTATAS.
   *
   * Su in-memory backend'u įrašas atsiranda taip greitai, kad turinio patikra
   * praeitų ir be `await`. Todėl rašymas dirbtinai atidedamas: jei `await`
   * pašalintas, funkcija išsisprendžia iš karto, ir `isspresta` tampa `true`
   * dar prieš atlaisvinant auditą.
   */
  const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
  const { PERMISSIONS } = require("../utils/permissions");

  await auditLog.clear();
  const { atlaisvinti, grazinti } = atidedamasBackendas();

  try {
    const job = { actor: "dinges-vartotojas", actorSource: "session", actorRole: "operator" };

    let isspresta = false;
    const vykdymas = authorizeJobOrAudit(job, "job_tvarkos_testas", PERMISSIONS.JOB_CREATE).then(
      (v) => {
        isspresta = true;
        return v;
      }
    );

    /** Kelios mikrouždavinių eilės - pakanka, kad be `await` funkcija jau būtų baigusi. */
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    assert.equal(
      isspresta,
      false,
      "autorizacija negali deklaruoti sprendimo, kol audito įrašas nepatvirtintas"
    );

    atlaisvinti();
    const decision = await vykdymas;

    assert.equal(isspresta, true);
    assert.equal(decision.allowed, false, "prielaida: nežinomas aktorius atmetamas");

    const įrašai = await auditLog.getAll();
    assert.ok(
      įrašai.some((e) => e.event === "JOB_EXECUTION_DENIED"),
      "atmetimas privalo palikti audito įrašą"
    );
  } finally {
    grazinti();
  }
});

test("BLOKUOJANTIS: `authorizeJobOrAudit()` ATMETA, kai auditas krinta (fail-closed)", async () => {
  /**
   * Antra to paties `await` pusė: be jo `rasytiAudita()` atmetimas taptų
   * `unhandledRejection`, o funkcija grąžintų sprendimą taip, tarsi auditas
   * būtų pavykęs.
   */
  const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
  const { PERMISSIONS } = require("../utils/permissions");

  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    await suKrentanciuRecord(async () => {
      const job = { actor: "dinges-vartotojas", actorSource: "session", actorRole: "operator" };
      await assert.rejects(
        () => authorizeJobOrAudit(job, "job_fail_closed", PERMISSIONS.JOB_CREATE),
        (e) => e instanceof AuditWriteError
      );
    });

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(pagauti, [], "be `await` atmetimas taptų unhandledRejection");
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("BLOKUOJANTIS: `lifecycleService` ištrynimas ATMETA, kai auditas krinta", async () => {
  /**
   * `lifecycleService.writeAudit()` neeksportuojamas, tad tikrinama per VIEŠĄ
   * `deleteJobArtefacts()` kelią - tai stipresnis įrodymas nei vidinės
   * funkcijos kvietimas, nes dengia ir tai, kad produkcinis kelias ja naudojasi.
   *
   * `LIFECYCLE_DELETION` yra BLOKUOJANTIS: asmens duomenų šalinimas be
   * patvirtinto audito reikštų ištrynimą be pėdsako.
   */
  const lifecycleService = require("../services/lifecycleService");
  const jobStore = require("../utils/jobStore");

  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    await suKrentanciuRecord(
      async () => {
        await assert.rejects(
          () => lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" }),
          (e) => e instanceof AuditWriteError,
          "ištrynimas negali būti paskelbtas sėkmingu be patvirtinto audito"
        );
      },
      /** TIK `LIFECYCLE_DELETION` - kad atmetimą duotų būtent `writeAudit()`. */
      ["LIFECYCLE_DELETION"]
    );

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(pagauti, [], "be `await` atmetimas taptų unhandledRejection");
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("INLINE: audito gedimas autorizacijoje perkelia job'ą į TERMINALIĄ būseną", async () => {
  /**
   * ⚠️ REGRESIJA, KURIĄ ŠIS TESTAS UŽDARO.
   *
   * `_runInline` paleidžiamas per `setImmediate(() => ...)`, tad jo Promise
   * niekas nelaiko. Kai `authorizeJobOrAudit()` po 7.4a ėmė laukti BLOKUOJANČIO
   * `JOB_EXECUTION_DENIED` įrašo, audito gedimas čia taptų
   * `unhandledRejection`, job'as liktų NETERMINALUS (vartotojas amžinai
   * apklausinėtų `processing`), o naujesnės Node nuostatos procesą nutrauktų.
   *
   * Fail-closed reiškia „nevykdom", bet job'as PRIVALO pasiekti terminalią
   * būseną - todėl tikrinama ir tai, kad `_runInline` NEATMETA, ir konkretus
   * `error_code`.
   */
  const jobRunner = require("../queues/jobRunner");
  const jobStore = require("../utils/jobStore");

  await jobStore.init();

  /** Aktorius, kurio `AUTH_USERS` nepažįsta → `JOB_EXECUTION_DENIED`. */
  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    ownerKind: "unowned",
    actor: "dinges-vartotojas",
    actorSource: "session",
    actorRole: "operator",
  });

  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    await suKrentanciuRecord(
      async () => {
        await jobRunner._runInline("protocol", job.id, {});
      },
      /** TIK autorizacijos įvykis - kad gedimas ateitų būtent iš šio kelio. */
      ["JOB_EXECUTION_DENIED"]
    );

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(pagauti, [], "inline kelias negali palikti nesuvaldyto Promise");

    const poVykdymo = await jobStore.system.get(job.id);
    assert.equal(poVykdymo.status, jobStore.STATUS.FAILED, "job'as privalo tapti terminalus");
    assert.equal(
      poVykdymo.errorCode || poVykdymo.error_code,
      "AUDIT_UNAVAILABLE",
      "priežastis atskiriama nuo AUTHORIZATION_REVOKED - ten teisės atimtos, čia sprendimo neužfiksavom"
    );
  } finally {
    process.off("unhandledRejection", handler);
  }
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

test("SKAITIKLIS: viena klaida per TIKRUS produkcinius helperius NEDVIGUBINAMA", async () => {
  /**
   * ⚠️ ANKSTESNĖ VERSIJA NIEKO NEĮRODĖ.
   *
   * Ji kūrė du LOKALIUS pass-through helperius ir per juos kvietė
   * `rasytiAudita()`. Tokie sluoksniai savo klaidų apdorojimo neturi, tad
   * pridėjus antrą inkrementą į `recordRejectedUpload()` ar bet kurį kitą
   * PRODUKCINĮ helperį, testas - ir jį remianti saugumo matricos garantija -
   * liktų žali.
   *
   * Dabar naudojamas tikras `utils/uploadEvents.js recordRejectedUpload()`,
   * kuris produkcijoje kviečiamas iš maršrutų ir `transcriptionService`.
   */
  const { recordRejectedUpload, REASONS } = require("../utils/uploadEvents");

  _resetAuditCountersForTests();

  await suKrentanciuRecord(async () => {
    await recordRejectedUpload(REASONS.SIGNATURE, {
      route: "/api/transcribe",
      jobId: "job_skaitiklio_testas",
    });
  });

  assert.equal(
    getAuditCounters().auditWriteFailures,
    1,
    "vienas gedimas per tikrą helperį = vienas inkrementas"
  );
});

test("SKAITIKLIS: BLOKUOJANTIS gedimas jo NEDIDINA (skaitiklis - neblokuojančių signalas)", async () => {
  /**
   * ⚠️ KOMPLEMENTARI PUSĖ, IR JI GINA TĄ PATĮ NEDVIGUBINIMĄ.
   *
   * #210 skaitiklį sieja su NEBLOKUOJANČIAIS gedimais: blokuojantis jau
   * praneštas kvietėjui klaida, tad papildomas skaičiavimas signalą iškreiptų.
   * Testas naudoja TIKRĄ `authorizeJobOrAudit()` - jei kas nors pridėtų
   * inkrementą jame ar `rasytiAudita()` blokuojančioje šakoje, čia kristų.
   */
  const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
  const { PERMISSIONS } = require("../utils/permissions");

  _resetAuditCountersForTests();

  await suKrentanciuRecord(
    async () => {
      const job = { actor: "dinges-vartotojas", actorSource: "session", actorRole: "operator" };
      await assert.rejects(
        () => authorizeJobOrAudit(job, "job_skaitiklio_blok", PERMISSIONS.JOB_CREATE),
        AuditWriteError
      );
    },
    ["JOB_EXECUTION_DENIED"]
  );

  assert.equal(
    getAuditCounters().auditWriteFailures,
    0,
    "blokuojantis gedimas jau grąžintas klaida - skaitiklio jis nedidina"
  );
});

test("PRIVACY_MODE: blokuojantis įvykis NEĮRAŠOMAS, bet tai EKSPLICITINĖ išimtis", async () => {
  /**
   * ⚠️ ČIA FIKSUOJAMAS SĄMONINGAS KOMPROMISAS, NE PRAĖJIMAS PRO ŠALĮ.
   *
   * Įjungus `PRIVACY_MODE=true`, `record()` nieko neįrašo ir grąžina `null`.
   * Blokuojančiam įvykiui tai reiškia, kad garantija „sėkmė tik po patvirtinto
   * įrašo" tokiu režimu NEGALIOJA - patvirtinti nėra ko.
   *
   * Veiksmas NEATMETAMAS sąmoningai: kitaip `PRIVACY_MODE` sulaužytų
   * prisijungimą, autorizaciją ir ištrynimą, t. y. paverstų privatumo režimą
   * neveikiančia sistema. Bet tylėti negalima - režimas fiksuojamas `warn`
   * lygiu, o skaitiklis NEDIDINAMAS, nes tai konfigūracija, ne gedimas.
   *
   * Testas egzistuoja tam, kad šis kompromisas būtų MATOMAS ir negalėtų būti
   * netyčia pakeistas - ne tam, kad jį pateisintų.
   */
  const senas = process.env.PRIVACY_MODE;
  const senasLygis = process.env.LOG_LEVEL;
  const eilutės = [];
  const originalusWarn = console.warn;

  process.env.PRIVACY_MODE = "true";
  process.env.LOG_LEVEL = "warn";
  console.warn = (...args) => eilutės.push(args.map(String).join(" "));
  _resetAuditCountersForTests();

  let rezultatas;
  try {
    rezultatas = await rasytiAudita({ event: "LOGIN_SUCCESS", success: true });
  } finally {
    console.warn = originalusWarn;
    if (senas === undefined) delete process.env.PRIVACY_MODE;
    else process.env.PRIVACY_MODE = senas;
    if (senasLygis === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = senasLygis;
  }

  assert.equal(rezultatas, null, "privatumo režimu įrašo nėra");
  assert.equal(
    getAuditCounters().auditWriteFailures,
    0,
    "tai konfigūracija, ne gedimas - skaitiklis nedidinamas"
  );
  assert.ok(
    eilutės.join("\n").includes("PRIVACY_MODE"),
    "režimas privalo būti matomas loge, kad nebūtų painiojamas su veikiančiu auditu"
  );
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

test("TIMEOUT: vėluojanti SĖKMĖ po timeout tampa MATOMA, ne tyliai įrašyta", async () => {
  /**
   * ⚠️ `Promise.race` NENUTRAUKIA rašymo.
   *
   * Blokuojančiu atveju kvietėjui jau pasakyta, kad nepavyko, o veiksmas
   * atšauktas (`LOGIN_SUCCESS` → sesija revokuota, 503). Jei įrašas vis tiek
   * įsirašo, audito pėdsakas tvirtina įvykus tai, kas buvo atsukta - ir be šio
   * sargo tas neatitikimas liktų nematomas.
   *
   * Ištrinti įrašo negalim, tad tikrinama, kad jis bent tampa RANDAMAS:
   * `error` logas + skaitiklis.
   */
  const eilutės = [];
  const originalusError = console.error;
  const senasLygis = process.env.LOG_LEVEL;
  console.error = (...args) => eilutės.push(args.map(String).join(" "));
  process.env.LOG_LEVEL = "error";
  _resetAuditCountersForTests();

  /** Backend'as, kuris SĖKMINGAI įsirašo, bet per vėlai. */
  const veluojantisSekmingas = {
    normalizeEvent: auditLog.normalizeEvent,
    record: (entry) =>
      new Promise((resolve) => setTimeout(() => resolve({ id: "velyvas", ...entry }), 60)),
  };

  try {
    await suTrumpaRiba(15, async () => {
      await assert.rejects(
        () => rasytiAudita({ event: "LOGIN_SUCCESS", success: true }, { auditLog: veluojantisSekmingas }),
        /timeout/
      );
    });

    /** Laukiam, kol vėluojantis rašymas realiai baigsis. */
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    console.error = originalusError;
    if (senasLygis === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = senasLygis;
  }

  assert.match(
    eilutės.join("\n"),
    /JAU PO timeout/,
    "po timeout įsirašęs blokuojantis įvykis privalo palikti `error` pėdsaką"
  );
  assert.equal(
    getAuditCounters().auditWriteFailures,
    1,
    "neatitikimas privalo būti randamas ir per skaitiklį"
  );
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

/* ───────────────────────────────────────────────────────────────────────────
 * #210 peržiūros pataisos: siauras catch, post-hoc pilnumas, vardų kontraktas,
 * žymos tvarka.
 * ─────────────────────────────────────────────────────────────────────────── */

test("VARDŲ KONTRAKTAS: netaisyklingas eksplicitinis įvykis ATMETAMAS, o ne išvedamas", async () => {
  /**
   * ⚠️ KODĖL TAI SAUGOS TESTAS, O NE RAŠYBOS.
   *
   * `normalizeEvent()` neatitinkantį `entry.event` ignoruoja ir įvykį išveda iš
   * kitų laukų. Rašybos klaida autentikacijos įvykyje („login_success") taip
   * virsdavo `PROCESSING_COMPLETED` - NEBLOKUOJANČIU. Blokuojanti garantija
   * dingdavo tyliai, be jokio signalo.
   *
   * Pirma parodom, kad išvedimas realiai duotų neblokuojantį įvykį - kitaip
   * testas gintų nuo nieko.
   */
  assert.equal(
    auditLog.normalizeEvent({ event: "login_success", success: true }),
    "PROCESSING_COMPLETED",
    "prielaida: netaisyklingas vardas išvedamas į neblokuojantį įvykį"
  );
  assert.equal(arBlokuojantis("PROCESSING_COMPLETED"), false);

  await assert.rejects(
    () => rasytiAudita({ event: "login_success", success: true }),
    (e) => e.code === "AUDIT_EVENT_MALFORMED",
    "netaisyklingas vardas turi būti kontroliuojama klaida"
  );

  // NE `AuditWriteError`: programavimo klaida neturi virsti 503 „laikinas
  // audito gedimas" ir būti kartojama kaip infrastruktūros problema.
  await assert.rejects(
    () => rasytiAudita({ event: "login_success", success: true }),
    (e) => !(e instanceof AuditWriteError)
  );

  // Taisyklingas vardas nepaliečiamas.
  await rasytiAudita({ event: "LOGIN_SUCCESS", success: true, actor: "x" });
});

test("VARDŲ KONTRAKTAS: atmetama KIEKVIENA netinkama reikšmė, ne tik eilutė", async () => {
  /**
   * ⚠️ #210 recenzija (P2): sargyba tikrino `typeof === "string"`.
   *
   * Producer'is, kurio `event` ateina iš parsintos konfigūracijos ar kito
   * dinaminio šaltinio, gali perduoti `null`, skaičių ar objektą. Tokia reikšmė
   * eilutės patikros neatitikdavo, sargybą apeidavo, ir `normalizeEvent()` vėl
   * tyliai išvesdavo `PROCESSING_COMPLETED`/`PROCESSING_FAILED` - t. y. tas pats
   * nutekėjimas, tik kitu tipu.
   *
   * Nepateiktu vardas laikomas TIK tada, kai realiai praleistas.
   */
  const ciklinis = { pavadinimas: "LOGIN_SUCCESS" };
  ciklinis.pats = ciklinis;

  const netinkamos = [
    ["null", null],
    ["skaičius", 42],
    ["objektas", { event: "LOGIN_SUCCESS" }],
    ["masyvas", ["LOGIN_SUCCESS"]],
    ["loginė", true],
    /** Ciklinis: `JSON.stringify()` mestų, ir klaidos konstruktorius kristų. */
    ["ciklinis objektas", ciklinis],
  ];

  for (const [pavadinimas, reiksme] of netinkamos) {
    await assert.rejects(
      () => rasytiAudita({ event: reiksme, success: true }),
      (e) => e.code === "AUDIT_EVENT_MALFORMED",
      `${pavadinimas} turi būti atmestas, o ne tyliai išvestas`
    );
  }

  /**
   * PRALEISTAS vardas lieka teisėtas: išvedimas iš kitų laukų yra sąmoningas
   * mechanizmas, ir sugriežtinimas jo neuždaro.
   */
  assert.ok(await rasytiAudita({ success: true, jobId: "praleistas-vardas" }));
  assert.ok(await rasytiAudita({ event: undefined, success: true, jobId: "aiskus-undefined" }));
});

test("POST-HOC AUTORITETAS: apima VISUS įvykius, rašomus po negrįžtamo veiksmo", async () => {
  /**
   * ⚠️ TIKRINAMA PRIEŠ KODĄ, NE PRIEŠ SĄRAŠĄ.
   *
   * `LOGOUT` rašomas po `destroy()` + cookie valymo, `ADMIN_DELETE_OVERRIDE` -
   * po `deleteJobArtefacts()`. Jei jų nėra `POST_HOC_IVYKIAI`, dokumentacija ir
   * matrica teigia „fail-closed" ten, kur veiksmas jau negrįžtamai įvykęs.
   */
  for (const event of ["LOGOUT", "ADMIN_DELETE_OVERRIDE"]) {
    assert.ok(arBlokuojantis(event), `${event} turi likti blokuojantis`);
    assert.ok(arPostHoc(event), `${event} rašomas PO veiksmo - turi būti post-hoc`);
  }
});

test("ŽYMOS TVARKA: kritęs auditas NEPALIEKA patvirtintos ištrynimo žymos", async () => {
  /**
   * ⚠️ P1 REGRESIJA (#210 peržiūra).
   *
   * `deleted` yra GALUTINĖ žymos būsena. Jei žymą užbaigtume PRIEŠ auditą, po
   * kritusio audito liktų `deleted`, ir kitas to paties jobo kvietimas
   * `isConfirmedDeleted()` trumpuoju keliu grąžintų `already_deleted` su
   * `complete: true`. Kvietėjas gautų SĖKMĘ, o gyvavimo ciklo įvykis dingtų
   * negrįžtamai - tyliai.
   *
   * Testas tikrina abi puses: (a) žyma neužfiksuota, (b) pakartojimas realiai
   * atlieka trynimą ir PARAŠO auditą, o ne trumpina kelią.
   */
  const lifecycleService = require("../services/lifecycleService");
  const tombstones = require("../utils/deletionTombstones");
  const jobStore = require("../utils/jobStore");

  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  await suKrentanciuRecord(
    async () => {
      await assert.rejects(
        () => lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" }),
        (e) => e instanceof AuditWriteError
      );
    },
    ["LIFECYCLE_DELETION"]
  );

  assert.equal(
    await tombstones.isConfirmedDeleted(job.id),
    false,
    "be patvirtinto audito žyma NEGALI būti `deleted` - kitaip pėdsakas prarandamas negrįžtamai"
  );

  // Artefaktų kūrimas vis tiek užblokuotas.
  assert.ok(await tombstones.isDeleted(job.id), "žyma privalo likti - trynimas jau vyko");

  /**
   * ⚠️ KONTRAKTAS PASIKEITĖ SU 7.5a (#183) - IR TAI TIKRINAMA, NE APEINAMA.
   *
   * #210 versijoje žyma likdavo `deletion_pending`, o kitas kvietimas ją
   * išgydydavo savaime. Nuo tada, kai antras kvietėjas gauna 202 pagal
   * `deletion_pending`, savaiminis gijimas nebeįmanomas: pakartojimas matytų
   * „jau vykdoma" ir nedarytų nieko AMŽINAI.
   *
   * Todėl mesta klaida palieka `deletion_failed`. Prarastas įvykis vis tiek
   * užfiksuojamas - bet per dokumentuotą operatoriaus kelią, ne tyliai.
   */
  assert.equal(
    (await tombstones.get(job.id)).status,
    tombstones.TOMBSTONE_STATUS.FAILED,
    "mesta klaida negali palikti `pending` - antras kvietėjas amžinai gautų 202"
  );

  // Pakartojimas BE operatoriaus: sėkmė NESKELBIAMA, darbas nekartojamas.
  const priesBeRetry = (await auditLog.getAll()).length;
  const beRetry = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  assert.equal(beRetry.status, "tombstone_unresolved");
  assert.equal(beRetry.complete, false, "neužtikrintas barjeras negali atrodyti kaip sėkmė");
  assert.equal(
    (await auditLog.getAll()).length,
    priesBeRetry,
    "be operatoriaus pakartojimo naujo įvykio nėra - darbas nekartojamas"
  );

  // Operatorius eksplicitiškai autorizuoja naują bandymą.
  const { retryMark } = require("../services/erasureMarkService");
  const perkelta = await retryMark(job.id, { actor: "sysadmin" });
  assert.equal(perkelta.changed, true, "`failed → pending` yra operatoriaus veiksmas");

  // Dabar pakartojimas realiai trina ir PARAŠO prarastą įvykį.
  const priesTai = (await auditLog.getAll()).length;
  const antras = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  const nauji = (await auditLog.getAll()).slice(priesTai);
  assert.ok(
    nauji.some((e) => e.event === "LIFECYCLE_DELETION"),
    "po autorizuoto pakartojimo prarastas įvykis privalo būti užfiksuotas"
  );
  assert.notEqual(antras.status, "already_deleted");
  assert.equal(await tombstones.isConfirmedDeleted(job.id), true, "dabar žyma patvirtinta");
});

test("SIAURAS CATCH: NE audito klaida NEVADINAMA `AUDIT_UNAVAILABLE`", async () => {
  /**
   * ⚠️ #210 peržiūra (P2).
   *
   * `authorizeJobOrAudit()` meta ir dėl nesuderinamos PERSISTUOTOS būsenos
   * (nepalaikoma `schemaVersion`, nežinomas `actorSource`) - dar PRIEŠ bet kokį
   * audito rašymą. Platus `catch (error)` tokį gedimą pažymėtų
   * `AUDIT_UNAVAILABLE`: operatorius ieškotų audito infrastruktūros problemos,
   * kurios nėra, o tikroji priežastis (duomenų migracijos skola) liktų
   * nematoma.
   *
   * Auditas čia NEKRENTA - klaidą duoda pati autorizacija.
   */
  const jobRunner = require("../queues/jobRunner");
  const jobStore = require("../utils/jobStore");

  await jobStore.init();

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    ownerKind: "unowned",
    actor: "kazkas",
    actorSource: "session",
    actorRole: "operator",
  });

  /**
   * `schemaVersion` nustatomas TIESIOGIAI saugykloje: `create()` jo nepriima,
   * o mus domina būtent PERSISTUOTAS nesuderinamas įrašas.
   */
  const issaugotas = await jobStore.system.get(job.id);
  issaugotas.schemaVersion = 99;

  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    await jobRunner._runInline("protocol", job.id, {});
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(pagauti, [], "inline kelias vis tiek negali palikti nesuvaldyto Promise");

    const poVykdymo = await jobStore.system.get(job.id);
    assert.equal(poVykdymo.status, jobStore.STATUS.FAILED, "job'as privalo tapti terminalus");
    assert.notEqual(
      poVykdymo.errorCode || poVykdymo.error_code,
      "AUDIT_UNAVAILABLE",
      "schemos nesuderinamumas NĖRA audito gedimas - platus catch klaidingai jį taip pavadintų"
    );
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("ŠALTINIO AUDIO: terminalus audito gedimas ATLAISVINA įkeltą failą", async () => {
  /**
   * ⚠️ #210 peržiūra (P2).
   *
   * Audito gedimo šaka `return`-ina anksčiau nei `_executeInline()` su savo
   * `finally { releaseAudio }`. Be atskiro valymo įkeltas audio failas liktų
   * saugykloje neribotam laikui: retencijos valytojas jo neliestų, nes raktą
   * vis dar nurodo gyvas job'o įrašas (`listReferencedStorageKeys`). Sąmoningai
   * atmestas vykdymas neturi palikti asmens duomenų.
   */
  const jobRunner = require("../queues/jobRunner");
  const jobStore = require("../utils/jobStore");
  const fileStorage = require("../utils/fileStorage");

  await jobStore.init();

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    ownerKind: "unowned",
    actor: "dinges-vartotojas",
    actorSource: "session",
    actorRole: "operator",
  });

  const storageKey = "uploads/audito-gedimas-testas.wav";
  const istrinti = [];
  const originalusDel = fileStorage.del;
  fileStorage.del = async (key) => {
    istrinti.push(key);
    return true;
  };

  try {
    await suKrentanciuRecord(
      async () => {
        await jobRunner._runInline("protocol", job.id, { storageKey });
      },
      ["JOB_EXECUTION_DENIED"]
    );

    const poVykdymo = await jobStore.system.get(job.id);
    assert.equal(poVykdymo.status, jobStore.STATUS.FAILED);
    assert.equal(poVykdymo.errorCode || poVykdymo.error_code, "AUDIT_UNAVAILABLE");

    assert.ok(
      istrinti.includes(storageKey),
      "atmetus vykdymą šaltinio audio privalo būti atlaisvintas, o ne paliktas saugykloje"
    );
  } finally {
    fileStorage.del = originalusDel;
  }
});

test("ŠALTINIO AUDIO: ATŠAUKTOS TEISĖS irgi atlaisvina įkeltą failą", async () => {
  /**
   * ⚠️ GRETIMA PATAISA, RASTA #210 RECENZIJOS METU.
   *
   * Ši šaka (`AUTHORIZATION_REVOKED`, `workers/index.js:180` ir jos inline
   * atitikmuo) NĖRA 7.4a dalis - ji egzistavo iki async perėjimo ir turėjo TĄ
   * PATĮ nutekėjimą kaip gretima audito gedimo šaka: grįždavo be `releaseAudio`,
   * palikdama įkeltą audio saugykloje neribotam laikui (retencijos valytojas jo
   * neliečia, kol raktą nurodo gyvas job'o įrašas).
   *
   * Iš išorės matoma baigtis NESIKEIČIA - job'as ir taip baigdavosi ta pačia
   * galutine nesėkme. Suvienodinamas tik resursų valymas, kad dvi gretimos
   * šakos nesielgtų skirtingai be priežasties.
   *
   * ⚠️ Auditas ČIA NEKRENTA - kitaip testas tikrintų audito gedimo šaką ir
   * gretimos pataisos neapsaugotų.
   */
  const jobRunner = require("../queues/jobRunner");
  const jobStore = require("../utils/jobStore");
  const fileStorage = require("../utils/fileStorage");

  await jobStore.init();

  /** Aktorius, kurio `AUTH_USERS` nepažįsta → sprendimas `allowed: false`. */
  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    ownerKind: "unowned",
    actor: "dinges-vartotojas",
    actorSource: "session",
    actorRole: "operator",
  });

  const storageKey = "uploads/atsauktos-teises-testas.wav";
  const istrinti = [];
  const originalusDel = fileStorage.del;
  fileStorage.del = async (key) => {
    istrinti.push(key);
    return true;
  };

  try {
    await jobRunner._runInline("protocol", job.id, { storageKey });

    const poVykdymo = await jobStore.system.get(job.id);
    assert.equal(poVykdymo.status, jobStore.STATUS.FAILED);
    assert.equal(
      poVykdymo.errorCode || poVykdymo.error_code,
      "AUTHORIZATION_REVOKED",
      "prielaida: tikrinama BŪTENT atšauktų teisių šaka, ne audito gedimo"
    );

    assert.ok(
      istrinti.includes(storageKey),
      "nutraukus vykdymą dėl atšauktų teisių šaltinio audio privalo būti atlaisvintas"
    );
  } finally {
    fileStorage.del = originalusDel;
  }
});

test("SKAITIKLIS: VIENAS lėtas rašymas duoda VIENĄ didinimą (abiejose kategorijose)", async () => {
  /**
   * ⚠️ #210 recenzija (P2): DVIGUBAS SKAIČIAVIMAS.
   *
   * `Promise.race` rašymo nenutraukia. Kai neblokuojantis rašymas peržengia
   * ribą, o VĖLIAU vis tiek įsirašo, suveikia du keliai: timeout politika
   * (`rasytiAudita`) ir vėluojančios sėkmės apdorojimas (`suRiba`). Anksčiau
   * abu didino skaitiklį, tad vienas lėtas `EXPORT_*` ar `UPLOAD_REJECTED`
   * rašymas praneštų DU gedimus ir iškreiptų stebėjimą.
   *
   * Invariantas: vienas rašymo bandymas → ne daugiau kaip vienas didinimas.
   * Tikrinamos ABI kategorijos, nes jos didina SKIRTINGUOSE taškuose.
   */
  const veluojantisBackend = (vėlavimasMs) => ({
    normalizeEvent: auditLog.normalizeEvent,
    record: (entry) =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: "velyvas", event: auditLog.normalizeEvent(entry) }), vėlavimasMs);
      }),
  });

  /** Kad vėluojanti sėkmė spėtų suveikti dar testo metu. */
  const palauk = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
  };

  // ── (a) NEBLOKUOJANTIS: didina timeout politika, vėluojanti sėkmė - ne.
  _resetAuditCountersForTests();
  await suTrumpaRiba(40, async () => {
    assert.equal(
      await rasytiAudita({ event: "EXPORT_FAILED", success: false }, { auditLog: veluojantisBackend(90) }),
      null,
      "neblokuojantis timeout NENUMUŠA operacijos"
    );
  });
  await palauk();
  assert.equal(
    getAuditCounters().auditWriteFailures,
    1,
    "vienas lėtas neblokuojantis rašymas negali būti suskaičiuotas du kartus"
  );

  // ── (b) BLOKUOJANTIS: timeout NEDIDINA, tad vėluojanti sėkmė lieka
  //        vienintelis didinimas - neatitikimas privalo likti matomas.
  _resetAuditCountersForTests();
  await suTrumpaRiba(40, async () => {
    await assert.rejects(
      () => rasytiAudita({ event: "LOGIN_SUCCESS", success: true }, { auditLog: veluojantisBackend(90) }),
      AuditWriteError
    );
  });
  await palauk();
  assert.equal(
    getAuditCounters().auditWriteFailures,
    1,
    "blokuojantis vėlyvas įrašas privalo likti MATOMAS: kvietėjui pasakyta 503, o pėdsakas atsirado"
  );
});
