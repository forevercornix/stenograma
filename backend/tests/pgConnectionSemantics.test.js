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
    tapatybe: tapatybesTekstas(efektyvusJungtiesParametrai(pgJungtiesNustatymai(env), env)),
  };

  for (const [vardas, turinys] of Object.entries(kanalai)) {
    assert.ok(!String(turinys).includes(SLAPTAS), `slaptažodis NEGALI patekti į \`${vardas}\``);
  }

  assert.match(pagauta.message, /kredencialai/, "klasė privalo būti įvardyta - kitaip klaida nepataisoma");

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

  /** ⚠️ AKTYVAVIMO BARJERAS NEPALIESTAS - jis ne #245 klausimas. */
  assert.equal(
    jobs.POSTGRES_AKTYVAVIMAS_LEISTAS,
    require("../utils/jobStore/backendSelection").POSTGRES_AKTYVAVIMAS_LEISTAS
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
