const test = require("node:test");
const assert = require("node:assert/strict");

const jobStore = require("../utils/jobStore");
const {
  SHARED_BACKENDS,
  selectBackend,
  canUseQueue,
  isPersistentBackend,
} = require("../utils/jobStore/backendSelection");

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
    resolveBackendChoice({ JOB_STORE_BACKEND: "redis", DATABASE_URL: PG, REDIS_URL: REDIS }).norimas,
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
   * aktyvavimo barjeras dar galioja.
   *
   * Prielaidų sąrašas gyvena TIK ADR'e - dubliuota kopija komentare
   * neišvengiamai pasensta (taip ir nutiko: ADR pridėjo eilės preflight, o
   * kopijos čia ir `backendSelection.js` liko be jo).
   *
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
    () =>
      applyActivationBarrier(
        resolveBackendChoice({ JOB_STORE_BACKEND: "postgres", DATABASE_URL: PG }),
        {}
      ),
    /aktyvavimo barjeras|barjeras/i
  );
});

test("BARJERAS: memory ir redis pasirinkimai praeina nepakitę", () => {
  for (const env of [{}, { REDIS_URL: REDIS }, { JOB_STORE_BACKEND: "memory" }]) {
    const pries = resolveBackendChoice(env);
    assert.equal(applyActivationBarrier(pries, env).norimas, pries.norimas);
  }
});

/* ── EILĖS ATSIEJIMAS ─────────────────────────────────────────────────────── */

/**
 * ⚠️ TIKRINAMA GRYNOJI `canUseQueue()`, ne jos apvalkalas.
 *
 * Ankstesnė šio bloko versija turėjo testinį helperį, kartojantį tą pačią
 * sąlygą, ir `toString()` patikrą, ieškančią dviejų žodžių funkcijos tekste.
 * Abu buvo blogi: helperis yra ANTRA taisyklės kopija (testai liktų žali
 * realizacijai apsivertus), o `toString()` tikrina formą, ne elgesį —
 * `return !SHARED_BACKENDS.includes(...)` turėtų abu terminus ir praeitų.
 *
 * Visi šeši deriniai tikrinami tiesiogiai prieš tikrą funkciją.
 */

const REDIS_YRA = { REDIS_URL: REDIS };
const REDIS_NĖRA = {};

test("EILĖ: DATABASE_URL + REDIS_URL → BullMQ ĮJUNGTAS", () => {
  /**
   * ⚠️ ESMINIS DoD SCENARIJUS, dėl kurio visas atsiejimas ir daromas.
   *
   * Anksčiau `server.js` klausė `getBackend() === "redis"`. Pasirinkus
   * PostgreSQL metaduomenims vykdymas nukristų į inline režimą NORS REDIS
   * VEIKIA: sukurti BullMQ job'ai liktų nesuvartoti, o naujas darbas taptų
   * nepatvarus.
   */
  const env = { DATABASE_URL: PG, REDIS_URL: REDIS };

  // Barjeras šiandien palieka metaduomenis Redis'e...
  assert.equal(selectBackend(env).norimas, "redis");
  assert.equal(canUseQueue(env, "redis"), true);

  // ...o barjerą atidarius jie taps postgres - eilė privalo LIKTI įjungta.
  assert.equal(canUseQueue(env, "postgres"), true, "postgres metaduomenys neturi išjungti eilės");
});

test("EILĖ: su REDIS_URL bendras metaduomenų backend'as duoda true", () => {
  assert.equal(canUseQueue(REDIS_YRA, "redis"), true);
  assert.equal(canUseQueue(REDIS_YRA, "postgres"), true);
});

test("EILĖ: be REDIS_URL visada false, nepriklausomai nuo metaduomenų", () => {
  /** BullMQ gyvena Redis'e - bendra metaduomenų saugykla jo nepakeičia. */
  assert.equal(canUseQueue(REDIS_NĖRA, "redis"), false);
  assert.equal(canUseQueue(REDIS_NĖRA, "postgres"), false);
  assert.equal(canUseQueue(REDIS_NĖRA, "memory"), false);
  assert.equal(canUseQueue({ DATABASE_URL: PG }, "postgres"), false);
});

test("EILĖ: REDIS_URL + memory metaduomenys → false (SĄMONINGA IŠIMTIS)", () => {
  /**
   * ⚠️ TAI NĖRA NENUOSEKLUMAS SU „eilė nereikalauja BŪTENT Redis".
   *
   * BullMQ vykdo darbą ATSKIRAME worker procese. Su `memory` metaduomenimis
   * tas procesas atnaujintų savo atminties kopiją, o HTTP procesas jos
   * nematytų: klientas amžinai apklausinėtų `queued` job'ą, kuris kitame
   * procese jau baigtas. Reikalavimas yra „BENDRAS backend'as" - ir `memory`
   * bendras nėra.
   */
  assert.equal(canUseQueue(REDIS_YRA, "memory"), false);
  assert.equal(SHARED_BACKENDS.includes("memory"), false);

  const env = { REDIS_URL: REDIS, JOB_STORE_BACKEND: "memory" };
  assert.equal(selectBackend(env).norimas, "memory");
});

test("EILĖ: hasQueueBackend() deleguoja į canUseQueue be savo sąlygos", () => {
  /**
   * Apvalkalas skaito `process.env` ir aktyvaus store backend'ą. Čia
   * tikrinama, kad jis grąžina TĄ PATĮ atsakymą kaip gryna funkcija tomis
   * pačiomis įvestimis - kitaip apvalkale galėtų atsirasti antra sąlyga.
   */
  const be = { ...process.env };
  delete process.env.REDIS_URL;
  try {
    assert.equal(
      jobStore.hasQueueBackend(),
      canUseQueue(process.env, jobStore.getBackend()),
      "apvalkalas nukrypo nuo grynosios funkcijos"
    );
    assert.equal(jobStore.hasQueueBackend(), false);
  } finally {
    Object.assign(process.env, be);
  }
});


/* ── FAIL-CLOSED ──────────────────────────────────────────────────────────── */

/**
 * ⚠️ ŠIŲ TESTŲ APIMTIS RIBOTA SĄMONINGAI.
 *
 * DoD reikalauja, kad pasirinkus PostgreSQL prisijungimo klaida nutrauktų
 * startą arba readiness, o ne pereitų į memory. Aktyvavimo barjeras
 * PostgreSQL dar neparenka, tad PILNO produkcinio kelio
 * (`DATABASE_URL` → startas nutrūksta) šiame PR NĖRA - jo galutinis
 * acceptance priklauso aktyvavimo etapui.
 *
 * Ką ŠIE testai vis dėlto įrodo: kad gedimo kelias egzistuoja, kad jis META
 * klaidą ir kad jis NEGRĮŽTA į memory. Be jų kriterijus neturėtų jokio
 * įrodymo, o neišbandytas gedimo kelias, įsijungiantis 7.2b momentu, yra
 * blogesnis nei neparašytas - jis atrodo padengtas.
 */
test("FAIL-CLOSED: neprieinamas PostgreSQL meta klaidą, o ne grįžta į memory", async () => {
  const buves = process.env.DATABASE_URL;
  // Rezervuotas TEST-NET-1 adresas (RFC 5737) - garantuotai neatsakys.
  process.env.DATABASE_URL = "postgres://n:n@192.0.2.1:5432/nera?connect_timeout=1";

  try {
    await assert.rejects(
      () => jobStore._initializePostgresForTests(),
      (err) => /PostgreSQL neprieinamas/.test(err.message) && /split-brain/.test(err.message),
      "prisijungimo klaida privalo nutraukti, ne pereiti kitur"
    );

    assert.notEqual(
      jobStore.getBackend(),
      "postgres",
      "nepavykęs prisijungimas neturi palikti aktyvaus PostgreSQL store'o"
    );
  } finally {
    if (buves === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = buves;
  }
});

test("FAIL-CLOSED: Redis kelias fallback'ą IŠLAIKO (elgesys skiriasi sąmoningai)", () => {
  /**
   * Skirtumas nėra nenuoseklumas: Redis fallback praranda tik NAUJUS job'us,
   * o esami įrašai lieka Redis'e. Su PostgreSQL tas pats elgesys reikštų, kad
   * nauji job'ai rašomi į atmintį, o autoritetingi lieka DB - split-brain,
   * kuris „išnyksta" DB atsistačius, palikdamas dvi tikroves.
   */
  const env = { REDIS_URL: REDIS };
  assert.equal(applyActivationBarrier(resolveBackendChoice(env), env).norimas, "redis");
});

/* ── EKSPLICITINIS BACKEND'AS BE PRIKLAUSOMYBĖS ───────────────────────────── */

test("PARINKIMAS: JOB_STORE_BACKEND=redis be REDIS_URL yra KLAIDA", () => {
  /**
   * ⚠️ Be šios patikros eksplicitinis pasirinkimas tyliai virstų atmintimi:
   * operatorius paprašytų Redis, servisas sėkmingai pakiltų, ir kiekvienas
   * job'as dingtų po restarto - net be prisijungimo įspėjimo, nes jungtis
   * nė nebandoma.
   */
  assert.throws(
    () => resolveBackendChoice({ JOB_STORE_BACKEND: "redis" }),
    /REDIS_URL nenustatytas/
  );
});

test("PARINKIMAS: JOB_STORE_BACKEND=postgres be DATABASE_URL yra KLAIDA", () => {
  assert.throws(
    () => resolveBackendChoice({ JOB_STORE_BACKEND: "postgres" }),
    /DATABASE_URL nenustatytas/
  );
});

test("PARINKIMAS: eksplicitinis redis SU REDIS_URL praeina", () => {
  assert.equal(resolveBackendChoice({ JOB_STORE_BACKEND: "redis", REDIS_URL: REDIS }).norimas, "redis");
});

test("PERSISTENCIJA: JOB_STORE_BACKEND=memory + DATABASE_URL nėra persistentinis", () => {
  /**
   * ⚠️ Antras kelias į tą patį melą kaip vien `DATABASE_URL`: eksplicitiškai
   * pasirinkta atmintis, o `Boolean(DATABASE_URL)` skelbtų persistenciją.
   */
  assert.equal(
    isPersistentBackend({ JOB_STORE_BACKEND: "memory", DATABASE_URL: PG, REDIS_URL: REDIS }),
    false
  );
});

test("EILĖ: jobRunner be argumento klausia hasQueueBackend(), ne REDIS_URL", async () => {
  /**
   * ⚠️ REGRESIJOS TESTAS, ELGESIO (ne teksto) lygmeniu.
   *
   * `jobRunner.init()` atsarginis kelias anksčiau buvo
   * `!!process.env.REDIS_URL`. Kelias negyvas TIK netiesiogiai - `server.js`
   * visada perduoda `persistentStoreAvailable`. Pirmas kvietėjas, praleidęs
   * argumentą, būtų gavęs `true` VIEN dėl `REDIS_URL`, net jei metaduomenys
   * atmintyje: HTTP procesas kurtų job'ą atmintyje, siųstų į BullMQ, o
   * worker'is jo nerastų.
   *
   * Scenarijus: `REDIS_URL` YRA, bet job store liko `memory`. Teisingas
   * atsakymas - `inline`.
   */
  const buves = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379";

  delete require.cache[require.resolve("../queues/jobRunner")];
  const jobStorePath = require.resolve("../utils/jobStore");
  const tikras = require("../utils/jobStore");
  require.cache[jobStorePath].exports = {
    ...tikras,
    init: async () => {},
    getBackend: () => "memory",
    hasQueueBackend: () => false,
  };

  try {
    const jobRunner = require("../queues/jobRunner");
    assert.equal(
      await jobRunner.init(),
      "inline",
      "su REDIS_URL, bet memory saugykla, BullMQ būtų nesuderinta sistema"
    );
  } finally {
    delete require.cache[jobStorePath];
    delete require.cache[require.resolve("../queues/jobRunner")];
    if (buves === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = buves;
  }
});

/* ── PRIEŠTARINGOS KONFIGŪRACIJOS ─────────────────────────────────────────── */

test("PARINKIMAS: JOB_STORE_BACKEND=memory + REDIS_REQUIRED=true yra KLAIDA", () => {
  /**
   * ⚠️ `REDIS_REQUIRED=true` (`jobStore/index.js:128`) reiškia „fallback į
   * atmintį yra kritinė klaida". Eksplicitinis `memory` atmintį parenka PRIEŠ
   * bandant Redis, tad garantija būtų apeita nė karto nesuveikusi: servisas
   * pakiltų inline režimu ir prarastų job'us - būtent tai, ką konfigūracija
   * draudžia.
   */
  assert.throws(
    () => resolveBackendChoice({ JOB_STORE_BACKEND: "memory", REDIS_URL: REDIS, REDIS_REQUIRED: "true" }),
    /prieštaringa konfigūracija/
  );
});

test("PARINKIMAS: memory be REDIS_REQUIRED praeina", () => {
  assert.equal(
    resolveBackendChoice({ JOB_STORE_BACKEND: "memory", REDIS_URL: REDIS }).norimas,
    "memory"
  );
});

test("FAIL-CLOSED: PostgreSQL startas turi BAIGTINĘ prisijungimo ribą", async () => {
  /**
   * ⚠️ `pg` numatytasis `connectionTimeoutMillis` yra 0 = BE RIBOS.
   *
   * KODĖL NEPAKANKA NEPASIEKIAMO ADRESO. Nemaršrutizuojamas IP krinta GREITAI
   * (`EHOSTUNREACH`), tad ribos neišbando visai - testas praeitų ir be jos.
   * Pavojingas scenarijus kitoks: endpoint'as PRIIMA TCP jungtį, bet niekada
   * neatsako. Tada `pg` laukia handshake'o, o be ribos - amžinai, ir
   * NIEKADA nepasiekia `catch` bloko su aiškia fail-closed klaida.
   *
   * Čia toks endpoint'as sukuriamas realiai: lizdas, kuris priima jungtį ir
   * tyli.
   */
  const net = require("net");
  /**
   * Jungtys sekamos, kad `close()` galėtų realiai užsibaigti: `pg` savo lizdo
   * nepaleidžia, o serveris su atvira jungtimi laikytų event loop'ą gyvą ir
   * testas niekada nesibaigtų.
   */
  const jungtys = new Set();
  const server = net.createServer((socket) => {
    /* priimam jungtį ir NIEKO nedarom - būtent tai ir tikrinama */
    jungtys.add(socket);
    socket.on("close", () => jungtys.delete(socket));
  });

  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();

  const buves = { url: process.env.DATABASE_URL, riba: process.env.DB_CONNECT_TIMEOUT_MS };
  process.env.DATABASE_URL = `postgres://n:n@127.0.0.1:${port}/nera`;
  process.env.DB_CONNECT_TIMEOUT_MS = "300";

  const pradzia = Date.now();
  try {
    await assert.rejects(
      () => jobStore._initializePostgresForTests(),
      "tylintis endpoint'as privalo nutraukti startą, ne kabinti jį"
    );

    const truko = Date.now() - pradzia;
    assert.ok(
      truko < 5000,
      `startas nutrūko per ${truko} ms - be connectionTimeoutMillis jis kabotų neribotai`
    );
  } finally {
    if (buves.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = buves.url;
    if (buves.riba === undefined) delete process.env.DB_CONNECT_TIMEOUT_MS;
    else process.env.DB_CONNECT_TIMEOUT_MS = buves.riba;
    for (const socket of jungtys) socket.destroy();
    await new Promise((res) => server.close(res));
  }
});
