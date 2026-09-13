const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * VIENA JUNGTIES FORMOS SEMANTIKA KETURIEMS POOL'AMS (#155, 7.x / #245).
 *
 * ⚠️ KLAUSIMAS, KURĮ ŠIS FAILAS UŽDARO: ar TA PATI aplinka visiems keturiems
 * komponentams reiškia TĄ PAČIĄ duomenų bazę?
 *
 * Iki #245 neatsakydavo. Dokumentuotas Compose diegimas backend'ui perduoda
 * `PG*` be `DATABASE_URL`, o `jobStore` ir `sessionStore` persistenciją siedavo
 * būtent su `DATABASE_URL`. Pasekmė buvo ne „nepatogu", o NEĮMANOMA: tame
 * diegime įjungti persistenciją nebuvo kaip, nes pridėjus `DATABASE_URL`
 * krisdavo `auditStore` `PGHOST` konfliktas.
 *
 * ⚠️ TIKROS DB ČIA NĖRA IR NEREIKIA. Jungties SEMANTIKA yra grynas
 * skaičiavimas: ką `pg` darytų su šia konfigūracija. Vienintelis testas, kuriam
 * reikia laido, naudoja `helpers/fakePostgres.js`.
 */

const {
  arNurodytaPostgres,
  arDviprasmiskaKonfiguracija,
  jungtiesSemantikosSkirtumai,
  pgJungtiesNustatymai,
  efektyvusJungtiesParametrai,
  tapatybesTekstas,
  NEREIKSMINGI,
} = require("../utils/pgConnection");

/** Pilnas DSN: visi `val()` laukai turi reikšmę, tad aplinka jų nebepapildo. */
const PILNAS = "postgres://vartotojas:slaptas@db.prod:5432/stenograma";

const PG_TIK = Object.freeze({
  PGHOST: "db.compose",
  PGPORT: "5432",
  PGUSER: "vartotojas",
  PGPASSWORD: "slaptas",
  PGDATABASE: "stenograma",
});

/* ──────────────────────────────────────────────────────────────────────────
 * D1 — „PostgreSQL nurodytas" yra viena semantika
 * ────────────────────────────────────────────────────────────────────────── */

test("D1: abi formos reiškia „PostgreSQL nurodytas“, jokia forma - „nenurodytas“", () => {
  assert.equal(arNurodytaPostgres({ DATABASE_URL: PILNAS }), true, "tik DSN");
  assert.equal(arNurodytaPostgres(PG_TIK), true, "tik PG*");
  assert.equal(arNurodytaPostgres({}), false, "nei viena");

  /**
   * ⚠️ PAVIENIS `PG*` NEAKTYVUOJA. Kitaip `PGPORT`, likęs shell'e nuo kito
   * projekto, imtų reikšti „Postgres sukonfigūruotas", ir komponentas bandytų
   * jungtis prie `localhost` numatytosios bazės.
   */
  assert.equal(arNurodytaPostgres({ PGPORT: "5432" }), false, "vien `PGPORT` nėra nuoroda");
  assert.equal(arNurodytaPostgres({ PGDATABASE: "x" }), false, "vien `PGDATABASE` nėra nuoroda");
});

test("D1: visi KETURI pool'ai iš to paties `env` gauna TĄ PATĮ taikinį", () => {
  /**
   * ⚠️ TIKRINAMA PER TAPATYBĘ, NE PER OBJEKTŲ LYGYBĘ. Kiekvienas pool'as prideda
   * savo timeout'us — reikšminga tai, ar jie jungtųsi į tą pačią vietą, o ne ar
   * objektai vienodi.
   *
   * ⚠️ IR PER `env` OBJEKTĄ, NE `process.env`. Būtent tas skirtumas #245 iki
   * šiol ir buvo: funkcija priima `env`, o viduje skaito globalą.
   */
  const pools = {
    jobStore: require("../utils/jobStore").jobPoolNustatymai,
    sessionStore: require("../utils/sessionStore").sesijuPoolNustatymai,
    auditStore: require("../utils/auditStore").auditoPoolNustatymai,
    deletionTombstones: require("../utils/deletionTombstones").zymuPoolNustatymai,
  };

  for (const [forma, env] of [["DSN", { DATABASE_URL: PILNAS }], ["PG*", PG_TIK]]) {
    const tapatybes = Object.entries(pools).map(([vardas, f]) => [
      vardas,
      tapatybesTekstas(efektyvusJungtiesParametrai(f(env), env)),
    ]);

    const unikalios = new Set(tapatybes.map(([, t]) => t));
    assert.equal(
      unikalios.size,
      1,
      `${forma}: keturi komponentai privalo rodyti į vieną bazę, gauta ${JSON.stringify(tapatybes)}`
    );

    /** ⚠️ KONTROLĖ: „viena tapatybė" neturi būti `<neatpažinta>` visiems keturiems. */
    assert.notEqual([...unikalios][0], "<neatpažinta>", `${forma}: tapatybė privalo būti atpažinta`);
  }
});

test("D1: `PG*` forma pasiekia pool'ą kaip diskretūs laukai, ne kaip `undefined` DSN", () => {
  /**
   * ⚠️ TIKSLIAI TA YDA, KURIĄ #245 TAISO. `{ connectionString: undefined }` `pg`
   * nėra klaida: `val()` tada ima `PG*` iš GLOBALIOS aplinkos arba
   * `defaults` — t. y. `localhost:5432`. Pool'as pakiltų ir jungtųsi TYLIAI ne
   * ten, kur nurodė kvietėjas.
   */
  for (const [vardas, f] of [
    ["jobStore", require("../utils/jobStore").jobPoolNustatymai],
    ["sessionStore", require("../utils/sessionStore").sesijuPoolNustatymai],
    /**
     * ⚠️ AUDITAS IR ŽYMOS ĮTRAUKTI, NORS JIE `pgJungtiesNustatymai()` NAUDOJO IR
     * IKI #245. Be jų testas tikrintų du iš keturių, o teiginys yra apie
     * KETURIS — ir regresija viename iš neįtrauktų liktų nepastebėta.
     */
    ["auditStore", require("../utils/auditStore").auditoPoolNustatymai],
    ["deletionTombstones", require("../utils/deletionTombstones").zymuPoolNustatymai],
  ]) {
    const n = f(PG_TIK);
    assert.equal(n.host, "db.compose", `${vardas}: host privalo ateiti iš perduoto \`env\``);
    assert.equal(n.database, "stenograma", `${vardas}: database`);
    assert.ok(!("connectionString" in n), `${vardas}: \`connectionString\` neperduodamas be DSN`);

    /** ⚠️ KONTROLĖ: savos ribos nedingo — jos ir yra priežastis, kodėl šios funkcijos egzistuoja. */
    assert.ok(n.query_timeout > 0, `${vardas}: \`query_timeout\` išlieka`);
    assert.ok(n.connectionTimeoutMillis > 0, `${vardas}: \`connectionTimeoutMillis\` išlieka`);
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * D2 — dviprasmybė pagal EFEKTĄ
 * ────────────────────────────────────────────────────────────────────────── */

test("D2: konfliktas sprendžiamas pagal EFEKTYVIĄ semantiką, ne pagal env vardo buvimą", () => {
  /**
   * ⚠️ MATRICA IŠMATUOTA SU `pg@8.23.0`, NE NUSPĖTA. `val()` taisyklė
   * (`connection-parameters.js:9-23`): DSN'e PRALEISTAS parametras imamas iš
   * aplinkos; nurodytas — ne. `ssl` yra išimtis: `readSSLConfigFromEnvironment()`
   * taikomas net pilnam DSN (`:85`).
   *
   * Todėl vardų sąrašas būtų klaidingas ABIEM kryptimis, ir žemiau esančios
   * eilutės yra būtent tos dvi kryptys greta viena kitos.
   */
  const atvejai = [
    // [aprašas, DSN, aplinka, ar konfliktas]
    ["pilnas DSN + `PGUSER` (neveiksnus)", PILNAS, { PGUSER: "kitas" }, false],
    ["pilnas DSN + `PGHOST` (neveiksnus)", PILNAS, { PGHOST: "kitas.host" }, false],
    ["pilnas DSN + `PGPASSWORD` (neveiksnus)", PILNAS, { PGPASSWORD: "kitas" }, false],
    ["DSN be user + `PGUSER`", "postgres://db.prod:5432/stenograma", { PGUSER: "kitas" }, true],
    ["DSN be porto + `PGPORT`", "postgres://vartotojas@db.prod/stenograma", { PGPORT: "6543" }, true],
    ["pilnas DSN + `PGSSLMODE=require`", PILNAS, { PGSSLMODE: "require" }, true],
    ["pilnas DSN + `PGOPTIONS` (`search_path`)", PILNAS, { PGOPTIONS: "-csearch_path=kita" }, true],
    ["pilnas DSN + `PGCLIENT_ENCODING`", PILNAS, { PGCLIENT_ENCODING: "LATIN1" }, true],
    ["pilnas DSN + `PGAPPNAME`", PILNAS, { PGAPPNAME: "doctor" }, false],
    ["pilnas DSN + `PGCONNECT_TIMEOUT`", PILNAS, { PGCONNECT_TIMEOUT: "9" }, false],
    ["pilnas DSN be aplinkos", PILNAS, {}, false],
  ];

  for (const [aprasas, dsn, aplinka, laukiama] of atvejai) {
    assert.equal(
      arDviprasmiskaKonfiguracija({ DATABASE_URL: dsn, ...aplinka }),
      laukiama,
      `${aprasas}: laukta ${laukiama ? "KONFLIKTO" : "praėjimo"}`
    );
  }

  /** ⚠️ Be `DATABASE_URL` antros interpretacijos nėra - `PG*` yra vienintelė forma. */
  assert.equal(arDviprasmiskaKonfiguracija(PG_TIK), false, "vien `PG*` niekada nėra dviprasmybė");
  assert.equal(arDviprasmiskaKonfiguracija({}), false);
});

test("D2: skirtumas pranešamas KLASE - `PGSSLMODE` yra saugumas, `PGOPTIONS` sesija", () => {
  /**
   * ⚠️ KLASĖ, NE VARDŲ SĄRAŠAS. Be šito testas praeitų ir tada, jei visi
   * skirtumai būtų suplakti į vieną „konfliktas" - o operatoriui klasė ir yra
   * vienintelė nuoroda, KĄ taisyti.
   */
  const klases = (aplinka) => jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS, ...aplinka });

  assert.deepEqual(klases({ PGSSLMODE: "require" }), ["saugumas"]);
  assert.deepEqual(klases({ PGOPTIONS: "-csearch_path=kita" }), ["sesija"]);
  assert.deepEqual(klases({ PGCLIENT_ENCODING: "LATIN1" }), ["sesija"]);
  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: "postgres://db.prod/stenograma", PGPORT: "6543", PGUSER: "kitas" }),
    ["kredencialai", "taikinys"],
    "kelios klasės vienu metu privalo būti matomos VISOS"
  );
});

test("D2: `NEREIKSMINGI` yra ĮVARDYTAS sprendimas, ir jie realiai keičia `pg` konfigūraciją", () => {
  /**
   * ⚠️ BE ANTROSIOS PUSĖS ŠIS SĄRAŠAS BŪTŲ NEATSKIRIAMAS NUO PRALEIDIMO.
   *
   * „`PGAPPNAME` netikrinamas" gali reikšti du dalykus: sąmoningai toleruojamas
   * arba tiesiog nepastebėtas. Tikrinama, kad `pg` juos IŠ TIESŲ perrašo - tad
   * jų buvimas sąraše yra apsisprendimas, ne spraga.
   */
  const ConnectionParameters = require("pg/lib/connection-parameters");
  const tikroji = process.env;

  const su = (aplinka) => {
    try {
      process.env = aplinka;
      return new ConnectionParameters({ connectionString: PILNAS });
    } finally {
      process.env = tikroji;
    }
  };

  assert.deepEqual([...NEREIKSMINGI].sort(), ["application_name", "connect_timeout"]);

  assert.notEqual(
    su({ PGAPPNAME: "doctor" }).application_name,
    su({}).application_name,
    "`PGAPPNAME` privalo realiai keisti `pg` konfigūraciją - kitaip sąrašo įrašas nieko nereiškia"
  );
  assert.notEqual(
    String(su({ PGCONNECT_TIMEOUT: "9" }).connect_timeout),
    String(su({}).connect_timeout),
    "`PGCONNECT_TIMEOUT` irgi realiai keičia"
  );
});

test("D2: KREDENCIALŲ konfliktas failina, bet slaptažodis niekur nepatenka", () => {
  /**
   * ⚠️ RIBA IŠ #245: efektyvaus `password` skirtumas gali būti naudojamas TIK
   * konflikto FAKTUI nustatyti.
   *
   * Rizika konkreti ir struktūrinė: `jungtiesTapatybe()` istoriškai suka apie
   * `host`/`port`/`database`/`options`, o #245 reikšmingas klases praplėtė iki
   * `user`/`password`. Natūralus „expected vs actual" objektas slaptažodį
   * įtrauktų SAVAIME - todėl rodoma tapatybė ir palyginimo rinkinys yra du
   * skirtingi objektai.
   */
  const SLAPTAS = "Sl4pt4-Fr4z3-NeRodyk";
  const env = { DATABASE_URL: "postgres://vartotojas@db.prod:5432/stenograma", PGPASSWORD: SLAPTAS };

  assert.equal(arDviprasmiskaKonfiguracija(env), true, "praleistas DSN slaptažodis + `PGPASSWORD` = konfliktas");
  assert.deepEqual(jungtiesSemantikosSkirtumai(env), ["kredencialai"]);

  const { PgConnectionError, arTaPatiBaze, dviprasmybesTekstas } = require("../utils/pgConnection");

  let pagauta = null;
  try {
    arTaPatiBaze("postgres://vartotojas@db.prod:5432/stenograma", env);
  } catch (e) {
    pagauta = e;
  }

  assert.ok(pagauta instanceof PgConnectionError, "fail-closed: dviprasmybė metama, ne apeinama");
  assert.equal(pagauta.code, "PG_CONNECTION_AMBIGUOUS");

  /**
   * ⚠️ TIKRINAMI VISI KANALAI, NE VIEN `message`. Slaptažodis, pateko į `stack`
   * ar į kurį nors klaidos lauką, atsidurtų loguose taip pat tikrai.
   */
  const kanalai = {
    message: pagauta.message,
    stack: String(pagauta.stack),
    serializuota: JSON.stringify(pagauta, Object.getOwnPropertyNames(pagauta)),
    tekstas: dviprasmybesTekstas(jungtiesSemantikosSkirtumai(env)),
    tapatybe: tapatybesTekstas(efektyvusJungtiesParametrai({ connectionString: env.DATABASE_URL }, env)),
  };

  for (const [vardas, turinys] of Object.entries(kanalai)) {
    assert.ok(!String(turinys).includes(SLAPTAS), `slaptažodis NEGALI patekti į \`${vardas}\``);
  }

  assert.match(pagauta.message, /kredencialai/, "klasė privalo būti įvardyta - kitaip klaida nepataisoma");

  /**
   * ⚠️ IR PATS CHOKEPOINT'AS. `pgJungtiesNustatymai()` nuo #245 peržiūros meta
   * pats (žr. „STARTAS FAILINA" testus žemiau), tad jo pranešimas yra dar vienas
   * kanalas, kuriuo slaptažodis galėtų iškeliauti.
   */
  let isChokepoint = null;
  try {
    pgJungtiesNustatymai(env);
  } catch (e) {
    isChokepoint = e;
  }
  assert.ok(isChokepoint, "chokepoint privalo mesti");
  assert.ok(!isChokepoint.message.includes(SLAPTAS), "slaptažodis NEGALI patekti į chokepoint klaidą");

  /** ⚠️ IR DSN SLAPTAŽODIS - jis eina per kitą kelią (`parseDsn`), tad tikrinamas atskirai. */
  const dsnSlaptas = "DSN-Sl4pt4-NeRodyk";
  const suDsn = { DATABASE_URL: `postgres://vartotojas:${dsnSlaptas}@db.prod:5432/stenograma`, PGOPTIONS: "-csearch_path=x" };

  let antra = null;
  try {
    arTaPatiBaze("postgres://vartotojas@db.prod:5432/stenograma", suDsn);
  } catch (e) {
    antra = e;
  }

  assert.ok(antra, "fail-closed");
  assert.ok(!antra.message.includes(dsnSlaptas), "DSN slaptažodis NEGALI patekti į klaidos tekstą");
  assert.ok(
    !tapatybesTekstas(efektyvusJungtiesParametrai({ connectionString: suDsn.DATABASE_URL }, {})).includes(dsnSlaptas),
    "nei į rodomą tapatybę"
  );
});

test("D2: DR kelias NESUSILPNĖJA - atlaisvintas tik EFEKTYVIAI sutampantis atvejis", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO DARBO TESTAS.
   *
   * #245 atšaukia ankstesnį sprendimą (`DATABASE_URL && PGHOST` = klaida
   * savaime). Atšaukimas be šio liudytojo būtų neatskiriamas nuo apsaugos
   * praradimo: abiem atvejais senas `assert` apsiverčia.
   *
   * Garantiją laiko ne sargas, o PALYGINIMAS: su pilnu DSN efektyvus taikinys
   * yra DSN taikinys, tad kitur rodantis `--target` krinta kaip NESUTAPIMAS.
   */
  const { arTaPatiBaze } = require("../utils/pgConnection");
  const env = { DATABASE_URL: PILNAS, PGHOST: "visai-kitas.host" };

  const sutampantis = arTaPatiBaze(PILNAS, env);
  assert.equal(sutampantis.sutampa, true, "neveiksnus `PGHOST` nebeblokuoja teisėto DR kelio");

  const kitas = arTaPatiBaze("postgres://vartotojas:slaptas@kita.baze:5432/stenograma", env);
  assert.equal(kitas.sutampa, false, "kita bazė lieka NESUTAPIMU - būtent tai `PGHOST` sargas ir gynė");

  /** ⚠️ IR `PGHOST`, RODANTIS KITUR, NETAMPA TAIKINIU: DSN pilnas, tad jis inertiškas. */
  assert.equal(
    arTaPatiBaze("postgres://vartotojas:slaptas@visai-kitas.host:5432/stenograma", env).sutampa,
    false,
    "`PGHOST` reikšmė NEGALI tapti galiojančiu taikiniu, kol DSN pilnas"
  );
});

/* ──────────────────────────────────────────────────────────────────────────
 * D3 / D4 — backend politika NEKEIČIAMA
 * ────────────────────────────────────────────────────────────────────────── */

test("D3: `PG*`-only leidžia EKSPLICITINĮ postgres, bet pats savaime nieko neperjungia", () => {
  const jobs = require("../utils/jobStore/backendSelection");

  /**
   * ⚠️ RIBA, KURIOS #245 NELIEČIA: `PG*` buvimas NĖRA prašymas persijungti.
   * `jobStore` norimą backend'ą renkasi tik eksplicitiškai, ir tai lieka taip.
   */
  const automatinis = jobs.selectBackend({ ...PG_TIK, REDIS_URL: "redis://r:6379" });
  assert.notEqual(automatinis.norimas, "postgres", "`PG*` savaime neperjungia job saugyklos");

  const eksplicitinis = jobs.selectBackend({ ...PG_TIK, JOB_STORE_BACKEND: "postgres" });
  assert.equal(eksplicitinis.norimas, "postgres", "`PG*`-only diegime persistencija privalo būti ĮMANOMA");

  /**
   * ⚠️ AKTYVAVIMO BARJERAS NEPALIESTAS — IR ANKSTESNĖ ŠIO PATIKRINIMO REDAKCIJA
   * BUVO TAUTOLOGIJA.
   *
   * Buvo lyginama `jobs.POSTGRES_AKTYVAVIMAS_LEISTAS` su
   * `require("…/backendSelection").POSTGRES_AKTYVAVIMAS_LEISTAS` — TAS PATS
   * modulis, tad palyginimas praeidavo esant BET KOKIAI reikšmei. Klasika:
   * asercija, teisinga dėl kitos priežasties nei ta, kurią teigia.
   *
   * Dabar fiksuojama reikšmė IR jos pasekmė: su atidarytu barjeru kiekvienas
   * kelias grąžina `barjeras: false`. Jei kas nors barjerą uždarytų, kristų ne
   * tik konstanta, bet ir elgsena.
   */
  assert.equal(jobs.POSTGRES_AKTYVAVIMAS_LEISTAS, true, "barjeras atidarytas - #245 jo NEGRĄŽINA");
  assert.equal(
    jobs.selectBackend({ DATABASE_URL: "postgres://u:p@h:5432/db", JOB_STORE_BACKEND: "postgres" }).barjeras,
    false,
    "atidarytas barjeras privalo reikšti `barjeras: false`, ne vien konstantą"
  );

  assert.throws(
    () => jobs.selectBackend({ JOB_STORE_BACKEND: "postgres" }),
    /DATABASE_URL, arba PGHOST/,
    "be jokios PostgreSQL nuorodos eksplicitinis pasirinkimas lieka KIETA klaida"
  );
});

test("D4: `sessionStore` - `PG*`-only veikia, be nuorodos krinta, be pasirinkimo lieka atmintyje", () => {
  const { resolveSessionBackend } = require("../utils/sessionStore/backendSelection");

  assert.equal(resolveSessionBackend({ SESSION_STORE_BACKEND: "postgres", ...PG_TIK }), "postgres");

  assert.throws(
    () => resolveSessionBackend({ SESSION_STORE_BACKEND: "postgres" }),
    /DATABASE_URL, arba PGHOST/,
    "eksplicitinis prašymas be nuorodos negali tyliai virsti atmintimi"
  );

  /**
   * ⚠️ SĄMONINGAS REŽIMAS LIEKA SĄMONINGAS. `PG*` be `SESSION_STORE_BACKEND`
   * palieka sesijas atmintyje - tai NE tylus persistencijos praradimas, o
   * komponento politika, kurios #245 nekeičia.
   */
  assert.equal(resolveSessionBackend(PG_TIK), "memory");
});

/* ──────────────────────────────────────────────────────────────────────────
 * Diagnostika zonduoja TĄ PATĮ taikinį
 * ────────────────────────────────────────────────────────────────────────── */

test("DIAGNOSTIKA: `postgresReachability` jungiasi prie `env` taikinio, NE prie `process.env`", async () => {
  /**
   * ⚠️ STRUKTŪRINĖ PATIKRA ČIA NEPAKANKA (AGENTS.md §9.2). „Kviečia
   * `pgJungtiesNustatymai`" ir „jungiasi ten, kur nurodė kvietėjas" yra du
   * skirtingi teiginiai: `pg` numatytai skaito `process.env`, tad klaidingas
   * kelias baigtųsi TA PAČIA timeout klaida ir testas praeitų.
   *
   * Todėl paleidžiami DU laido protokolo serveriai: vienas nurodomas per
   * `process.env`, kitas per perduotą `env`. Liudytojas yra tai, KURIS iš jų
   * priėmė jungtį.
   *
   * ⚠️ TIKROS DB NĖRA. Serveris užbaigia rankos paspaudimą ir nutyla; užklausa
   * krinta per diagnostikos `query_timeout`. Rezultatas mums nesvarbus - svarbu
   * ADRESAS.
   */
  const { startSilentAfterHandshake } = require("./helpers/fakePostgres");
  const startupChecks = require("../utils/startupChecks");

  const klaidingas = await startSilentAfterHandshake();
  const teisingas = await startSilentAfterHandshake();

  const senasHost = process.env.PGHOST;
  const senasPort = process.env.PGPORT;

  process.env.PGHOST = klaidingas.host;
  process.env.PGPORT = klaidingas.port;

  try {
    /**
     * ⚠️ VAROMA PER `runSelfChecks()`, NE PER VIDINĘ FUNKCIJĄ. Eksportuoti
     * `postgresReachability()` vien testui reikštų tikrinti kelią, kurio
     * produkcija nekviečia; klausimas yra apie `make doctor` ir
     * `/api/health/deep`, o jie eina būtent čia.
     */
    await startupChecks.runSelfChecks({
      PGHOST: teisingas.host,
      PGPORT: teisingas.port,
      PGUSER: "testas",
      PGPASSWORD: "testas",
      PGDATABASE: "testas",
    });

    assert.equal(teisingas.priimtaJungciu(), 1, "diagnostika privalo jungtis prie PERDUOTO taikinio");
    assert.equal(
      klaidingas.priimtaJungciu(),
      0,
      "`process.env` taikinys NEGALI būti zonduojamas - žalia varnelė rodytų ne tą bazę"
    );
  } finally {
    if (senasHost === undefined) delete process.env.PGHOST;
    else process.env.PGHOST = senasHost;
    if (senasPort === undefined) delete process.env.PGPORT;
    else process.env.PGPORT = senasPort;
    await klaidingas.close();
    await teisingas.close();
  }
});

test("DIAGNOSTIKA: konflikto tekstas ATITINKA startą, o ne atpasakoja jį savais žodžiais", async () => {
  /**
   * ⚠️ TRYS KOPIJOS TO PATIES SPRENDIMO IR BUVO #245 PRIEŽASTIS. Diagnostika,
   * sakanti „KONFLIKTAS" ten, kur startas praeina (arba atvirkščiai), yra
   * blogesnė už diagnostikos nebuvimą: operatorius taiso ne tą dalyką.
   */
  const startupChecks = require("../utils/startupChecks");
  const { dviprasmybesTekstas } = require("../utils/pgConnection");

  const env = { DATABASE_URL: PILNAS, PGOPTIONS: "-csearch_path=kita" };
  const rezultatai = await startupChecks.runSelfChecks(env);
  const pg = rezultatai.find((c) => c.name.startsWith("PostgreSQL"));

  assert.ok(pg, "PostgreSQL eilutė privalo egzistuoti");
  assert.equal(pg.ok, false, "efektyvus skirtumas privalo būti raudonas");
  assert.ok(
    pg.detail.includes(dviprasmybesTekstas(["sesija"])),
    `diagnostika privalo naudoti TĄ PATĮ tekstą kaip startas, gauta: ${pg.detail}`
  );

  /**
   * ⚠️ KONTROLĖ: neveiksnus `PGHOST` NEBĖRA konfliktas nė diagnostikoje. Be jos
   * atlaisvinimas galėtų likti neįgyvendintas būtent čia - toje vietoje, kur
   * operatorius jį pamatytų pirmiausia.
   */
  const svarus = await startupChecks.runSelfChecks({ DATABASE_URL: PILNAS, PGHOST: "kitas.host" });
  const pgSvarus = svarus.find((c) => c.name.startsWith("PostgreSQL"));
  assert.ok(
    !pgSvarus || !String(pgSvarus.detail).includes("KONFLIKTAS"),
    `neveiksnus \`PGHOST\` neturi būti skelbiamas konfliktu: ${pgSvarus && pgSvarus.detail}`
  );
});

/* ──────────────────────────────────────────────────────────────────────────
 * PERŽIŪROS RAUNDAS — STARTAS FAILINA VISUOSE KELIUOSE
 * ────────────────────────────────────────────────────────────────────────── */

test("STARTAS FAILINA: dviprasmybė sustabdo pool'ą NEPRIKLAUSOMAI nuo backend'ų", () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL IŠMATUOTO DEFEKTO, NE DĖL SIMETRIJOS.
   *
   * Pirmoji #245 redakcija sargą pastatė tik `arTaPatiBaze()`,
   * `resolveAuditBackend()` ir diagnostikoje. Išmatuota:
   *
   *   `{ DATABASE_URL, PGOPTIONS }` be `AUDIT_BACKEND=postgres` → 0 klaidų,
   *   o `deletionTombstones` pasirinkdavo `postgres` ir kildavo.
   *
   * Tai NUMATYTOJI konfigūracija: žymos PostgreSQL renkasi automatiškai. DoD
   * reikalauja „skirtumas bent vienoje klasėje → startas FAILINA".
   *
   * ⚠️ TIKRINAMAS CHOKEPOINT, NE KIEKVIENAS KVIETĖJAS. Sąrašas, kurį reikia
   * prisiminti pridedant pool'ą, jau kartą sugedo — trys tos pačios taisyklės
   * kopijos ir yra #245 priežastis.
   */
  const { PgConnectionError } = require("../utils/pgConnection");
  const DVIPRASMISKA = { DATABASE_URL: PILNAS, PGOPTIONS: "-csearch_path=kita" };

  const poolai = {
    jobStore: require("../utils/jobStore").jobPoolNustatymai,
    sessionStore: require("../utils/sessionStore").sesijuPoolNustatymai,
    auditStore: require("../utils/auditStore").auditoPoolNustatymai,
    deletionTombstones: require("../utils/deletionTombstones").zymuPoolNustatymai,
  };

  for (const [vardas, f] of Object.entries(poolai)) {
    assert.throws(
      () => f(DVIPRASMISKA),
      (err) => {
        assert.ok(err instanceof PgConnectionError, `${vardas}: tipuota klaida`);
        assert.equal(err.code, "PG_CONNECTION_AMBIGUOUS", `${vardas}: kodas`);
        return true;
      },
      `${vardas}: dviprasmiška aplinka NEGALI duoti veikiančių pool nustatymų`
    );
  }

  /** ⚠️ KONTROLĖ: vienareikšmė aplinka privalo praeiti visiems keturiems. */
  for (const [vardas, f] of Object.entries(poolai)) {
    assert.ok(f({ DATABASE_URL: PILNAS }), `${vardas}: švari DSN privalo veikti`);
    assert.ok(f(PG_TIK), `${vardas}: švari \`PG*\` forma privalo veikti`);
  }
});

test("STARTAS FAILINA: `validateConfig` praneša dviprasmybę BE eksplicitinio backend'o", () => {
  /**
   * ⚠️ CHOKEPOINT YRA MECHANIZMAS, ŠI EILUTĖ — PRANEŠIMAS.
   *
   * `pgJungtiesNustatymai()` sustabdo bet kurį procesą, įskaitant
   * `workers/index.js`, kuris `validateConfig()` NEKVIEČIA. Bet operatoriui
   * klaida turi pasirodyti konfigūracijos sąraše PRIEŠ pakylant bet kuriai
   * daliai, o ne kaip viena išmesta klaida iš pirmo `init()`.
   */
  const startupChecks = require("../utils/startupChecks");
  const DVIPRASMISKA = { DATABASE_URL: PILNAS, PGOPTIONS: "-csearch_path=kita" };

  const dviprasmybes = (env) =>
    startupChecks.validateConfig(env).errors.filter((e) => /SKIRTINGĄ efektyvią/.test(e));

  assert.equal(dviprasmybes(DVIPRASMISKA).length, 1, "be jokio `*_BACKEND` - viena klaida");
  assert.equal(
    dviprasmybes({ ...DVIPRASMISKA, JOB_STORE_BACKEND: "postgres" }).length,
    1,
    "eksplicitinis jobStore nieko nekeičia - klaida ta pati"
  );

  /**
   * ⚠️ BE DUBLIKATO. `resolveAuditBackend()` tą pačią dviprasmybę meta savo
   * keliu; be dedupe operatorius matytų dvi klaidas vienai priežasčiai ir
   * ieškotų dviejų problemų.
   */
  assert.equal(
    dviprasmybes({ ...DVIPRASMISKA, AUDIT_BACKEND: "postgres", AUDIT_ID_SALT: "s", AUDIT_ID_SALT_ID: "i" }).length,
    1,
    "audito kelias NEGALI pridėti antros identiškos priežasties"
  );

  /** ⚠️ KONTROLĖ: švari aplinka klaidų neduoda - kitaip sargas draustų viską. */
  assert.equal(dviprasmybes({ DATABASE_URL: PILNAS }).length, 0);
  assert.equal(dviprasmybes(PG_TIK).length, 0);
  assert.equal(dviprasmybes({}).length, 0, "be PostgreSQL nuorodos patikra netaikoma");
});

/* ──────────────────────────────────────────────────────────────────────────
 * PERŽIŪROS RAUNDAS — `process.env` ATSTATYMAS
 * ────────────────────────────────────────────────────────────────────────── */

test("APLINKA: `process.env` atstatoma BITAS Į BITĄ, įskaitant klaidos kelią", () => {
  /**
   * ⚠️ SAVYBĖ BE LIUDYTOJO YRA PRIELAIDA (§9.1).
   *
   * `suAplinka()` `process.env` keičia NUORODA (`process.env = env`), tad
   * atstatymas yra vienas priskyrimas ir raktų klausimo nekyla. Bet tai galioja
   * TIK dėl tos realizacijos. Perrašius ją į „įsimenam ir grąžinam po raktą",
   * atsirastų klasika: raktui, kurio NEBUVO, `= undefined` įrašo eilutę
   * `"undefined"`, ir kita `pg` interpretacija būtų kitokia — tyliai.
   *
   * Todėl tikrinama ne realizacija, o REZULTATAS: ta pati raktų aibė, tos
   * pačios reikšmės, ir nė vieno rakto su tekstine reikšme `"undefined"`.
   */
  const { arDviprasmiskaKonfiguracija } = require("../utils/pgConnection");

  /** Zondai: raktas, kurio NĖRA, ir raktas, kuris yra TUŠČIA EILUTĖ. */
  const NEBUVO = ["PGSSLMODE", "PGOPTIONS", "PGCLIENT_ENCODING", "PGSSLNEGOTIATION"];
  const senos = Object.fromEntries(NEBUVO.map((k) => [k, process.env[k]]));
  for (const k of NEBUVO) delete process.env[k];
  process.env.PGZONDAS_TUSCIAS = "";

  try {
    const pries = { ...process.env };
    const identitetas = process.env;

    arDviprasmiskaKonfiguracija({ DATABASE_URL: PILNAS, PGSSLMODE: "require", PGOPTIONS: "-csearch_path=x" });

    assert.equal(process.env, identitetas, "atstatytas privalo būti TAS PATS objektas");
    assert.deepEqual(
      Object.keys(process.env).sort(),
      Object.keys(pries).sort(),
      "raktų aibė privalo sutapti - joks zondo raktas negali likti"
    );
    assert.deepEqual({ ...process.env }, pries, "reikšmės privalo sutapti bitas į bitą");
    assert.equal(process.env.PGZONDAS_TUSCIAS, "", "tuščia eilutė privalo likti tuščia eilute");

    for (const k of NEBUVO) {
      assert.ok(!(k in process.env), `\`${k}\` neegzistavo - jis NEGALI atsirasti`);
      assert.notEqual(process.env[k], "undefined", `\`${k}\` NEGALI virsti eilute "undefined"`);
    }

    /**
     * ⚠️ KLAIDOS KELIAS. Be jo `finally` liktų neišbandytas, o būtent metanti
     * `fn` ir yra atvejis, kai globalas liktų pakeistas visam procesui.
     */
    const ConnectionParameters = require("pg/lib/connection-parameters");
    const kelias = require.resolve("pg/lib/connection-parameters");
    const senasEksportas = require.cache[kelias].exports;

    require.cache[kelias].exports = function Sprogsta() {
      throw new Error("tyčinis sprogimas semantikos skaičiavime");
    };

    try {
      delete require.cache[require.resolve("../utils/pgConnection")];
      const sviezias = require("../utils/pgConnection");

      /**
       * `pgParametrai()` klaidą gaudo, tad kvietimas nemeta — svarbu, kad
       * `finally` suveikė ir globalas atstatytas.
       */
      sviezias.arDviprasmiskaKonfiguracija({ DATABASE_URL: PILNAS, PGSSLMODE: "require" });

      assert.equal(process.env, identitetas, "po metančio kelio globalas privalo būti atstatytas");
      assert.deepEqual({ ...process.env }, pries, "po metančio kelio reikšmės privalo sutapti");
    } finally {
      require.cache[kelias].exports = senasEksportas;
      delete require.cache[require.resolve("../utils/pgConnection")];
      require("../utils/pgConnection");
      assert.ok(ConnectionParameters, "originalas atstatytas");
    }
  } finally {
    delete process.env.PGZONDAS_TUSCIAS;
    for (const [k, v] of Object.entries(senos)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * PERŽIŪROS RAUNDAS — `pg` APLINKOS PAVIRŠIAUS TRIPWIRE
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * DVI DSN FORMOS, NES `val()` TRUMPINA KELIĄ.
 *
 * ⚠️ Pilnas DSN vienas NEPAKANKA: `val()` pirma tikrina `config[key]` ir, radęs
 * reikšmę, aplinkos NEPALIEČIA. Zondas su pilnu DSN todėl nemato `PGHOST`,
 * `PGUSER`, `PGPORT`, `PGPASSWORD`, `PGDATABASE`. Pirmoji šio testo redakcija
 * būtent tą ir padarė — ir sąrašas išėjo trumpesnis nei tikrovė.
 */
const ZONDO_FORMOS = Object.freeze([{}, { connectionString: "postgres://u:p@h:5432/db" }]);

/** Kokius `PG*` raktus `pg` REALIAI skaito — išvedama iš jo paties, ne surašoma. */
function pgSkaitomiRaktai() {
  const ConnectionParameters = require("pg/lib/connection-parameters");
  const skaityti = new Set();
  const tikroji = process.env;

  const seklys = new Proxy(
    {},
    {
      get(_, raktas) {
        if (typeof raktas === "string" && raktas.startsWith("PG")) skaityti.add(raktas);
        return undefined;
      },
      has: () => false,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    }
  );

  try {
    process.env = seklys;
    for (const forma of ZONDO_FORMOS) new ConnectionParameters(forma);
  } finally {
    process.env = tikroji;
  }

  return [...skaityti].sort();
}

test("TRIPWIRE: `pg` aplinkos paviršius nepasikeitė - kiekvienas raktas KLASIFIKUOTAS", () => {
  /**
   * ⚠️ ŠIS TESTAS YRA TRIPWIRE (AGENTS.md §9.2), IR JO PASKIRTIS - CI, NE DIEGIMAS.
   *
   * `pg` priklausomybė yra `^8.x`, o `pg/lib/connection-parameters` forma
   * semver'io nedengia. Numatytoji #245 kryptis yra fail-closed: nežinomas
   * laukas patenka į `kita:<laukas>` ir STABDO startą. Be šio testo `pg`
   * minoras, pridėjęs naują iš aplinkos skaitomą kintamąjį, sulaužytų startą
   * DIEGIME, ne CI'e.
   *
   * ⚠️ SĄRAŠAS IŠVEDAMAS IŠ `pg`, NE SURAŠOMAS RANKA. Ranka surašytas sąrašas
   * yra tiksliai ta §12.1 yda, kurią #245 uždaro — ir kurią šio darbo pirmoji
   * redakcija padarė, praleisdama `PGSSLNEGOTIATION` ir `PGREPLICATION`.
   * Skaitymus fiksuoja `Proxy` ant `process.env`.
   */
  const raktai = pgSkaitomiRaktai();

  assert.ok(raktai.length > 5, `paviršius įtartinai mažas: ${JSON.stringify(raktai)}`);

  /**
   * ⚠️ ELGSENOS PADENGIMAS, NE VARDŲ ŽEMĖLAPIS. Kiekvienam `pg` skaitomam raktui
   * klausiama: ar jis arba NEVEIKSNUS pilnam DSN, arba duoda ĮVARDYTĄ klasę?
   * `kita:` reikštų neklasifikuotą kintamąjį — būtent tai, ką tripwire gaudo.
   */
  /**
   * ⚠️ IR ČIA DVI DSN FORMOS. Su pilnu DSN naujas laukas, kurį `pg` skaito tik
   * praleistiems parametrams, duotų `[]` ir pasislėptų — testas „praeitų"
   * nieko nepatikrinęs.
   */
  const NEPILNAS = "postgres://db.prod/stenograma";
  const neklasifikuoti = [];

  for (const raktas of raktai) {
    for (const dsn of [PILNAS, NEPILNAS]) {
      const klases = jungtiesSemantikosSkirtumai({ DATABASE_URL: dsn, [raktas]: "zondas-245" });
      if (klases.some((k) => k.startsWith("kita:"))) {
        neklasifikuoti.push(`${raktas} (${dsn === PILNAS ? "pilnas" : "nepilnas"} DSN) → ${klases.join(",")}`);
      }
    }
  }

  assert.deepEqual(
    neklasifikuoti,
    [],
    "NAUJAS `pg` APLINKOS KINTAMASIS. Priskirkite jį klasei `LAUKU_KLASES` " +
      "(taikinys / kredencialai / saugumas / sesija) ARBA eksplicitiškai įrašykite " +
      "į `NEREIKSMINGI` su paaiškinimu, kodėl jis semantikos nekeičia. " +
      `Neklasifikuoti: ${neklasifikuoti.join("; ")}`
  );

  /** Fiksuojama ir pati aibė - kad pasikeitimas būtų MATOMAS, ne tik saugus. */
  assert.deepEqual(
    raktai,
    [
      "PGAPPNAME",
      /** ⚠️ `PGBINARY` — būtent tas, kurį rankinis sąrašas praleido. Žr. `LAUKU_KLASES`. */
      "PGBINARY",
      "PGCLIENT_ENCODING",
      "PGCONNECT_TIMEOUT",
      "PGDATABASE",
      "PGHOST",
      "PGOPTIONS",
      "PGPASSWORD",
      "PGPORT",
      "PGREPLICATION",
      "PGSSLMODE",
      "PGSSLNEGOTIATION",
      "PGUSER",
    ],
    "pasikeitė `pg` skaitomų aplinkos kintamųjų aibė - žr. pranešimą aukščiau"
  );
});

test("FAIL-CLOSED: nežinomas `pg` laukas REALIAI patenka į `kita:` ir stabdo startą", () => {
  /**
   * ⚠️ NEPASIEKIAMA ŠAKA NIEKO NEĮRODO (§9.1).
   *
   * `kita:<laukas>` yra atsarga ateities `pg` minorui, tad šiandien natūraliai
   * nepasiekiama. Tol, kol jos niekas nevykdė, „fail-closed" yra teiginys, ne
   * savybė: lygiai taip pat galėtų būti `continue` arba tyli klaida.
   *
   * Todėl `pg` klasė laikinai pakeičiama palikuone, pridedančia lauką, kurio
   * `LAUKU_KLASES` nepažįsta, ir skaitomą iš NAUJO aplinkos kintamojo.
   */
  const kelias = require.resolve("pg/lib/connection-parameters");
  const Originalas = require(kelias);
  const pgKelias = require.resolve("../utils/pgConnection");
  const senasEksportas = require.cache[kelias].exports;

  class SuNaujuLauku extends Originalas {
    constructor(cfg) {
      super(cfg);
      this.busimas_pg_laukas = process.env.PGBUSIMAS || "numatyta";
    }
  }

  try {
    require.cache[kelias].exports = SuNaujuLauku;
    delete require.cache[pgKelias];
    const sviezias = require(pgKelias);

    const klases = sviezias.jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS, PGBUSIMAS: "kita" });

    assert.deepEqual(
      klases,
      ["kita:busimas_pg_laukas"],
      "nežinomas laukas privalo pasirodyti VARDU, ne dingti ir ne būti suplaktas"
    );

    assert.equal(
      sviezias.arDviprasmiskaKonfiguracija({ DATABASE_URL: PILNAS, PGBUSIMAS: "kita" }),
      true,
      "ir privalo reikšti dviprasmybę - kitaip numatytoji kryptis yra fail-open"
    );

    assert.throws(
      () => sviezias.pgJungtiesNustatymai({ DATABASE_URL: PILNAS, PGBUSIMAS: "kita" }),
      /kita:busimas_pg_laukas/,
      "chokepoint privalo STABDYTI, o ne tik pranešti"
    );

    /** ⚠️ KONTROLĖ: tas pats laukas be aplinkos kintamojo dviprasmybės NEKELIA. */
    assert.deepEqual(sviezias.jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS }), []);
  } finally {
    require.cache[kelias].exports = senasEksportas;
    delete require.cache[pgKelias];
    require(pgKelias);
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * PERŽIŪROS RAUNDAS — RIBOS, KURIŲ NEUŽDARĖM
 * ────────────────────────────────────────────────────────────────────────── */

test("TRIPWIRE: produkciniai kvietimo taškai `env` objekto NEPERDUODA", () => {
  /**
   * ⚠️ TAI TRIPWIRE (§9.2), NE ELGSENOS ĮRODYMAS — IR RIBA ČIA UŽRAŠOMA
   * SĄMONINGAI SIAURIAU NEI ANKSTESNĖJE ATASKAITOJE.
   *
   * `pg` praleistiems laukams skaito GLOBALŲ `process.env`, o sargas tikrina tą
   * objektą, kurį gavo. Kol abu yra tas pats objektas, garantija galioja.
   *
   * ⚠️ ANKSTESNIS TEIGINYS BUVO PER STIPRUS. Ataskaita sakė „produkcijoje visi
   * keliai kviečiami be argumentų". Tai netiesa: `services/restoreService.js`
   * turi `env` PARAMETRĄ (`restoreBackup({ env = process.env })`) ir perduoda jį
   * `startupChecks.validateConfig(env)`, o šis — `resolveAuditBackend(env)`.
   * Šiandien vienintelis kvietėjas (`routes/backup.js`) `env` NEPERDUODA, tad
   * numatytoji reikšmė yra `process.env` — bet parametras egzistuoja, ir
   * teiginys „visi keliai" jo nedengė.
   *
   * Šis testas fiksuoja būtent tai: kad numatytoji reikšmė tebėra `process.env`.
   * Jis NEĮRODO, kad joks būsimas kvietėjas nepaduos svetimo objekto.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const saknis = path.join(__dirname, "..");

  const restore = fs.readFileSync(path.join(saknis, "services", "restoreService.js"), "utf8");
  assert.match(
    restore,
    /restoreBackup\(\{[^)]*env = process\.env/s,
    "`restoreService` numatytoji `env` reikšmė privalo likti `process.env`"
  );

  const marsrutas = fs.readFileSync(path.join(saknis, "routes", "backup.js"), "utf8");
  const kvietimas = marsrutas.slice(marsrutas.indexOf("restoreService.restoreBackup({"));
  assert.ok(
    !/^[^}]*env\s*:/m.test(kvietimas.slice(0, kvietimas.indexOf("});"))),
    "maršrutas NEGALI pradėti perduoti savo `env` - sargas jo neatitiktų"
  );
});

test("TEKSTAI: įspėjimai įvardija ABI formas, ne vien `DATABASE_URL`", () => {
  /**
   * ⚠️ DoD PUNKTAS BE LIUDYTOJO. „Įspėjimų tekstai atnaujinti" buvo padaryta, bet
   * niekas jo nesaugojo: grąžinus seną formuluotę nekristų nė vienas testas.
   *
   * Tekstas svarbus todėl, kad jis yra vienintelis dalykas, kurį operatorius
   * mato Compose diegime: „nėra DATABASE_URL" ten reiškia „persistencija tau
   * neprieinama", nors ji prieinama per `PG*`.
   */
  const tombstones = require("../utils/deletionTombstones");
  const i = tombstones.ATMINTIES_ISPEJIMAS;

  assert.match(i, /PGHOST/, "antra forma privalo būti įvardyta");
  assert.ok(
    !/nėra DATABASE_URL\)/.test(i),
    "senoji formuluotė teigė, kad trūksta būtent `DATABASE_URL`"
  );

  const fs = require("node:fs");
  const path = require("node:path");
  const jobStore = fs.readFileSync(path.join(__dirname, "..", "utils", "jobStore", "index.js"), "utf8");

  assert.ok(
    !/`⚠️  DATABASE_URL nustatytas, bet job metaduomenys/.test(jobStore),
    "barjero įspėjimas nebegali teigti, kad reikšmingas yra būtent `DATABASE_URL`"
  );
  assert.match(
    jobStore,
    /PostgreSQL nurodytas, bet job metaduomenys/,
    "jis privalo kalbėti apie NURODYTĄ PostgreSQL - abi formos lygiavertės"
  );
});

test("DOKUMENTACIJA: `migrations.md` nebesiūlo laikinai konstruoti `DATABASE_URL`", () => {
  /**
   * ⚠️ AGENTS.md §12.1: dokumentacija negali teigti kitaip nei kodas.
   *
   * Rekomendacija „nurodykite `DATABASE_URL` laikinai, tik migracijoms" po #245
   * yra ne tik nereikalinga (`node-pg-migrate` `PG*` moka pats), bet ir
   * PAVOJINGA: laikinas URL greta `PG*` gali pats tapti dviprasmybės klaida.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "migrations.md"), "utf8");

  assert.ok(
    !/nurodykite jį \*\*laikinai, tik migracijoms\*\*/.test(doc),
    "laikino `DATABASE_URL` konstravimo rekomendacija privalo būti PAŠALINTA"
  );

  assert.match(
    doc,
    /PGHOST=\.\.\. PGPORT=\.\.\. PGUSER=\.\.\. PGPASSWORD=\.\.\. PGDATABASE=\.\.\. npm run migrate:up/,
    "`PG*`-only komanda privalo būti parodyta, o ne tik paminėta"
  );

  assert.match(
    doc,
    /node-pg-migrate@9\.0\.0/,
    "teiginys apie `PG*` palaikymą privalo nurodyti PATIKRINTĄ versiją (§14)"
  );
});
