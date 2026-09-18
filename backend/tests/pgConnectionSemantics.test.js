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
    /**
     * ⚠️ BUVO `true` IKI PENKTO RAUNDO. `client_encoding` perkeltas į
     * `NEREIKSMINGI`: grandinė `Client` → `Connection` → `pg-protocol` reikšmės
     * NEVARTOJA, tad startas dėl jos krisdavo be priežasties. Žr. `NEREIKSMINGI`
     * komentarą ir testą „D2: NEREIKSMINGI — TRYS priežastys".
     */
    ["pilnas DSN + `PGCLIENT_ENCODING` (be vartotojo)", PILNAS, { PGCLIENT_ENCODING: "LATIN1" }, false],
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
  /** ⚠️ `PGCLIENT_ENCODING` čia nebėra — jis `NEREIKSMINGI`, žr. penktą raundą. */
  assert.deepEqual(klases({ PGREPLICATION: "true" }), ["sesija"], "kitas TIKRAS sesijos laukas");
  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: "postgres://db.prod/stenograma", PGPORT: "6543", PGUSER: "kitas" }),
    ["kredencialai", "taikinys"],
    "kelios klasės vienu metu privalo būti matomos VISOS"
  );
});

test("D2: `NEREIKSMINGI` — TRYS skirtingos priežastys, visos išmatuotos", () => {
  /**
   * ⚠️ BE ANTROSIOS PUSĖS ŠIS SĄRAŠAS BŪTŲ NEATSKIRIAMAS NUO PRALEIDIMO.
   *
   * „`PGAPPNAME` netikrinamas" gali reikšti du dalykus: sąmoningai toleruojamas
   * arba tiesiog nepastebėtas. Todėl kiekvienam įrašui tikrinama PRIEŽASTIS, ir
   * jos yra dvi skirtingos:
   *
   *   1. `application_name`, `connect_timeout` — `pg` juos REALIAI perrašo, bet
   *      jie nekeičia taikinio, kredencialų, saugumo ar sesijos namespace;
   *   2. `binary` — `pg` jį perskaito, bet `Client` jo NESKAITO IŠ VISO;
   *   3. `client_encoding` — `Client` jį PERDUODA `Connection`'ui, o tas jo
   *      neskaito, ir `pg-protocol` dekodavimas fiksuotas `utf-8`.
   *
   * Antroji priežastis rasta Codex peržiūroje ir yra „reikšmė be vartotojo"
   * klasė MŪSŲ PAČIŲ kode: ankstesnė redakcija `binary` klasifikavo kaip
   * `sesija` su pagrindimu, kuris buvo teiginys, ne matavimas.
   */
  const ConnectionParameters = require("pg/lib/connection-parameters");
  const { Client } = require("pg");
  const tikroji = process.env;

  const su = (aplinka, fn) => {
    try {
      process.env = aplinka;
      return fn();
    } finally {
      process.env = tikroji;
    }
  };

  assert.deepEqual(
    [...NEREIKSMINGI].sort(),
    ["application_name", "binary", "client_encoding", "connect_timeout"]
  );

  /** 1 priežastis: `pg` juos perrašo — tad jų buvimas sąraše yra APSISPRENDIMAS. */
  const cp = (aplinka) => su(aplinka, () => new ConnectionParameters({ connectionString: PILNAS }));

  assert.notEqual(
    cp({ PGAPPNAME: "doctor" }).application_name,
    cp({}).application_name,
    "`PGAPPNAME` privalo realiai keisti `pg` konfigūraciją - kitaip įrašas nieko nereiškia"
  );
  assert.notEqual(
    String(cp({ PGCONNECT_TIMEOUT: "9" }).connect_timeout),
    String(cp({}).connect_timeout),
    "`PGCONNECT_TIMEOUT` irgi realiai keičia"
  );

  /**
   * 2 priežastis: `binary` PERSKAITOMAS, bet NEVARTOJAMAS.
   *
   * ⚠️ TIKRINAMAS `Client`, NE `ConnectionParameters`. Pastarajame laukas YRA
   * (`connection-parameters.js:82`) — būtent todėl jis ir atrodė reikšmingas.
   * `Client` jį ima iš ŽALIOS konfigūracijos (`client.js:102`:
   * `c.binary || defaults.binary`), tad `PGBINARY` iki jo nepasiekia.
   *
   * ⚠️ KLIENTAS TIK KONSTRUOJAMAS. Jokio prisijungimo, jokios DB.
   */
  assert.notEqual(
    cp({ PGBINARY: "true" }).binary,
    cp({}).binary,
    "prielaida: `pg` `PGBINARY` į `ConnectionParameters` PERSKAITO"
  );

  assert.equal(
    su({ PGBINARY: "true" }, () => new Client({ connectionString: PILNAS }).binary),
    su({}, () => new Client({ connectionString: PILNAS }).binary),
    "`Client.binary` NEGALI priklausyti nuo `PGBINARY` - jei ims priklausyti, " +
      "`binary` privalo grįžti į `LAUKU_KLASES`, o ne likti `NEREIKSMINGI`"
  );

  /**
   * 3 priežastis: `client_encoding` PERDUODAMAS, bet GAVĖJAS jo nevartoja.
   *
   * ⚠️ SUBTILESNIS PAVIDALAS, IR AŠ JĮ PRALEIDAU. Trečiame raunde radau
   * `client.js:97` (`encoding: client_encoding || "utf8"`) ir sustojau, padaręs
   * išvadą „turi vartotoją". Skaitytojas reikšmę PERDUODA, o ne VARTOJA.
   *
   * Tikrinama pati grandinė, ne mano išvada apie ją.
   */
  const fs = require("node:fs");
  const kelias = (m) => require.resolve(m);

  const connectionJs = fs.readFileSync(kelias("pg/lib/connection.js"), "utf8");
  assert.ok(
    !/encoding/.test(connectionJs),
    "`Connection` NETURI skaityti `encoding` - jei ims, `client_encoding` privalo grįžti į klases"
  );

  const bufferReader = fs.readFileSync(kelias("pg-protocol/dist/buffer-reader.js"), "utf8");
  assert.match(
    bufferReader,
    /this\.encoding = ['"]utf-8['"]/,
    "`pg-protocol` dekodavimas privalo likti FIKSUOTAS - kitaip reikšmė vėl imtų veikti"
  );

  /** ⚠️ IR SARGO PUSĖ: nė vienas iš trijų su pilnu DSN starto NESTABDO. */
  for (const aplinka of [
    { PGBINARY: "true" },
    { PGCLIENT_ENCODING: "LATIN1" },
    { PGAPPNAME: "doctor" },
  ]) {
    assert.deepEqual(
      jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS, ...aplinka }),
      [],
      `klaidingas teigiamas fail-closed sarge yra blogiausia jo kryptis: ${JSON.stringify(aplinka)}`
    );
  }
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
  /**
   * ⚠️ `\b`, NE LITERALUS `0x08` (Codex, antras raundas).
   *
   * Pirmoji šio testo redakcija buvo parašyta per Python heredoc'ą, kur `\b`
   * yra BACKSPACE simbolis, ne žodžio riba. Regexas ieškojo `<0x08>env` — ko
   * jokiame faile nėra, tad asercija NEGALĖJO kristi. Sargas, kuris negali
   * kristi, yra blogesnis už sargo nebuvimą: jis yra vienintelis R3 sprendimo
   * („tripwire vietoj ribos pašalinimo") pagrindas.
   */
  const kvietimas = marsrutas.slice(marsrutas.indexOf("restoreService.restoreBackup({"));
  assert.ok(
    !/^[^}]*\benv\s*:/m.test(kvietimas.slice(0, kvietimas.indexOf("});"))),
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

/* ──────────────────────────────────────────────────────────────────────────
 * ANTRAS PERŽIŪROS RAUNDAS (R6, R8)
 * ────────────────────────────────────────────────────────────────────────── */

test("R8: `process.env` sukeitimas ATMETA asinchroninį callback'ą (fail-closed)", () => {
  /**
   * ⚠️ PO P1 ŠIS KELIAS TAPO PLATESNIS.
   *
   * Globalus `process.env` sukeitimas dabar vyksta KIEKVIENAME
   * `pgJungtiesNustatymai()` kvietime — t. y. kiekvieno pool'o statyme. Saugu
   * tai TIK tol, kol `fn()` sinchroninis: `finally` atstato globalą, kai `fn`
   * grįžta, o `Promise` grįžta IŠKART, palikdamas tikrąjį darbą vykti vėliau.
   *
   * ⚠️ IR TAI BŪTŲ TYLU. Kryžminė tarša pasireiškia tik lygiagretumo lange, tad
   * jokia dabartinė asercija jos nepagautų — testai matytų teisingas reikšmes,
   * o produkcija kartkartėmis jungtųsi ne ten.
   *
   * ⚠️ KVIETIMO DAŽNIS IŠMATUOTAS, NE NUSPĖTAS: `pgJungtiesNustatymai()`
   * kviečiamas iš `*PoolNustatymai(env)` `initializePostgres()` metu — VIENĄ
   * kartą pool'ui, ne kiekvienai jungčiai ar užklausai (`initPromise` daro
   * `init()` idempotentišką). Likę kvietėjai — DR keliai ir diagnostinis
   * klientas — irgi vienkartiniai.
   */
  const kelias = require.resolve("pg/lib/connection-parameters");
  const pgKelias = require.resolve("../utils/pgConnection");
  const senasEksportas = require.cache[kelias].exports;

  /** `new Thenable()` grąžina objektą su `.then` — tiksliai tai, ką duotų `async fn`. */
  function Thenable() {
    this.then = (resolve) => resolve({ host: "h", port: 5432, database: "db" });
  }

  const tikrojiAplinka = process.env;

  try {
    require.cache[kelias].exports = Thenable;
    delete require.cache[pgKelias];
    const sviezias = require(pgKelias);

    assert.throws(
      () => sviezias.arDviprasmiskaKonfiguracija({ DATABASE_URL: PILNAS, PGSSLMODE: "require" }),
      (err) => {
        assert.equal(err.code, "PG_ENV_SWAP_ASYNC", "sargas privalo turėti savo kodą");
        return true;
      },
      "asinchroninis callback privalo NUTRAUKTI, o ne tyliai grąžinti `null`"
    );

    /**
     * ⚠️ IR GLOBALAS PRIVALO BŪTI ATSTATYTAS. Sargas, paliekantis svetimą
     * `process.env`, būtų blogesnis už jo nebuvimą.
     */
    assert.equal(process.env, tikrojiAplinka, "po metimo globalas privalo būti atstatytas");
  } finally {
    require.cache[kelias].exports = senasEksportas;
    delete require.cache[pgKelias];
    require(pgKelias);
  }
});

test("R6 TRIPWIRE: nė vienas produkcinis `new Pool`/`new Client` neapeina autoriteto", () => {
  /**
   * ⚠️ TAI INVENTORIAUS TRIPWIRE (§9.2), NE ELGSENOS ĮRODYMAS — IR RIBA ČIA
   * UŽRAŠOMA SĄMONINGAI.
   *
   * Teiginys „chokepoint apeiti nėra kaip" pirmoje ataskaitos redakcijoje rėmėsi
   * VIENKARTINIU `grep`. Tai tiksliai ta §14.1 eilutė, kurią šis darbas kitur
   * taiko griežtai: paieška pagal vardą randa tiesiogines nuorodas, bet ne
   * konstravimą per alias'ą (`const P = pg.Pool; new P()`), factory, wrapper'į
   * ar dinaminį `require`.
   *
   * ⚠️ KO ŠIS TESTAS NEGAUDO: būtent to paties. Jis paverčia vienkartinį `grep`
   * NUOLATINIU, tad naujas produkcinis failas su savo pool'u krinta čia, o ne
   * diegime. Alias'as jį apeitų — ir tai užrašyta, o ne nutylėta.
   *
   * ⚠️ FAILAI ATRANDAMI, NE SURAŠOMI. Kietas sąrašas (kaip
   * `auditStoreFields.test.js` `error` klausytojų tripwire) naujo failo
   * nepastebėtų — ta pati tyliai senstančio sąrašo yda, kurią #245 uždaro.
   *
   * Elgsenos pusę — kad dviprasmybė realiai stabdo — tikrina
   * „STARTAS FAILINA…" testai visiems keturiems pool'ams.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");

  const saknis = path.join(__dirname, "..");
  const PRALEISTI = new Set(["node_modules", "tests", "coverage", ".git"]);

  const failai = [];
  (function eiti(katalogas) {
    for (const irasas of fs.readdirSync(katalogas, { withFileTypes: true })) {
      if (PRALEISTI.has(irasas.name)) continue;
      const pilnas = path.join(katalogas, irasas.name);
      if (irasas.isDirectory()) eiti(pilnas);
      else if (/\.(js|mjs|cjs)$/.test(irasas.name)) failai.push(pilnas);
    }
  })(saknis);

  assert.ok(failai.length > 50, `prielaida: atrasta per mažai failų (${failai.length})`);

  const pazeidejai = [];
  for (const failas of failai) {
    const svarus = beKomentaru(fs.readFileSync(failas, "utf8"));
    if (!/new\s+(Pool|Client)\s*\(/.test(svarus)) continue;
    if (svarus.includes("pgJungtiesNustatymai")) continue;
    pazeidejai.push(path.relative(saknis, failas));
  }

  assert.deepEqual(
    pazeidejai,
    [],
    "PostgreSQL pool'as ar klientas statomas apeinant `pgJungtiesNustatymai()`. " +
      "Tada jungties formos ir dviprasmybės sargo jam NEGALIOJA: aplinka su " +
      "`PGOPTIONS` nuvestų jį į kitą schemą, o startas nekristų. " +
      `Pažeidėjai: ${pazeidejai.join(", ")}`
  );
});

test("R7 DOKUMENTACIJA: upgrade note įvardija NUMATYTĄJĄ konfigūraciją, ne tik mišrias", () => {
  /**
   * ⚠️ ĮRODYMAS BUVO SENESNIS UŽ KODĄ (§12.1).
   *
   * Upgrade note rašytas, kai sargas gyveno tik audito, DR ir diagnostikos
   * keliuose — tada „laužantis pokytis mišrioms konfigūracijoms" buvo tiesa.
   * Po chokepoint'o perkėlimo paliečiamas KIEKVIENAS diegimas, kuriame
   * PostgreSQL nurodytas, nes ištrynimo žymos jį renkasi automatiškai. Operatorius,
   * neturintis nė vieno `*_BACKEND=postgres`, iš senojo teksto pagrįstai
   * spręstų, kad jam tai negalioja — ir startas kristų be įspėjimo.
   *
   * ⚠️ Tikrinamas TURINYS, ne buvimas: „yra `## Unreleased` sekcija" praeitų ir
   * su senuoju tekstu.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const saknis = path.join(__dirname, "..", "..");

  const changelog = fs.readFileSync(path.join(saknis, "CHANGELOG.md"), "utf8");
  const nesirasytas = changelog.slice(changelog.indexOf("## Unreleased"));

  assert.match(
    nesirasytas,
    /\*\*NUMATYTOJI konfigūracija\*\*|NUMATYTOJI konfigūracija/,
    "upgrade note privalo pasakyti, kad paliečiama ir numatytoji konfigūracija"
  );
  assert.match(
    nesirasytas,
    /jokio `\*_BACKEND=postgres` nėra nustatyta|be jokio `\*_BACKEND=postgres`/,
    "privalo būti įvardyta, kad eksplicitinio backend'o nereikia"
  );
  assert.match(nesirasytas, /workers\//, "privalo būti įvardytas ir worker'io procesas");

  /**
   * ⚠️ IR RUNBOOK'O IŠLYGA. #245 padarė ją NETEISINGĄ: `PG*`-only diegimas
   * suderinimą dabar įvykdyti gali. Dokumentas, teigiantis priešingai, nukreiptų
   * operatorių nuo DR procedūros būtent tada, kai ji reikalinga.
   */
  const runbook = fs.readFileSync(path.join(saknis, "docs", "backup-runbook.md"), "utf8");

  assert.ok(
    !/ŠIANDIEN `PG\*`-only diegimas suderinimo įvykdyti NEGALI/.test(runbook),
    "runbook'o išlyga privalo būti PAŠALINTA - po #245 ji melaginga"
  );
  assert.match(runbook, /IŠLYGA PAŠALINTA \(#245\)/, "pašalinimas privalo būti įvardytas, ne tylus");
});

/* ──────────────────────────────────────────────────────────────────────────
 * TREČIAS PERŽIŪROS RAUNDAS — KLAIDINGI TEIGIAMI FAIL-CLOSED SARGE
 * ────────────────────────────────────────────────────────────────────────── */

test("KLAIDINGI TEIGIAMI: registras ir kodavimo vardas NESTABDO starto", () => {
  /**
   * ⚠️ BLOGIAUSIA FAIL-CLOSED SARGO KRYPTIS — STABDYTI TEISĖTĄ KONFIGŪRACIJĄ.
   *
   * Du atvejai, rasti Codex peržiūroje, abu tos pačios formos: lyginamos ŽALIOS
   * reikšmės ten, kur lygybė nėra simbolių lygybė.
   *
   *   C: `PGHOST=LOCALHOST` su DSN be host'o davė `LOCALHOST` prieš `localhost`.
   *      DNS vardai registrui NEJAUTRŪS, o modulyje `normalizuotiHosta()` jau
   *      buvo — tik taikomas rodomai tapatybei, ne šiam palyginimui. Dvi tiesos
   *      apie host'ų lygybę tame pačiame faile.
   *
   *   A: `PGCLIENT_ENCODING=UTF8` su pilnu DSN davė `""` prieš `"UTF8"`. Bet
   *      `Client` naudoja `client_encoding || "utf8"` (`client.js:97`), ir tai
   *      Node srauto kodavimo vardas — registrui nejautrus. Abu reiškia tą patį.
   */
  const ATVEJAI = [
    ["C: `PGHOST` kitu registru", "postgres://u:p@/stenograma", { PGHOST: "LOCALHOST" }, []],
    ["C: `PGHOST` tas pats", "postgres://u:p@/stenograma", { PGHOST: "localhost" }, []],
    ["A: `PGCLIENT_ENCODING=UTF8`", PILNAS, { PGCLIENT_ENCODING: "UTF8" }, []],
    /**
     * ⚠️ `LATIN1` IRGI — IR TAI PASIKEITĖ PO PENKTO RAUNDO. Iki jo čia buvo
     * laukiamas `["sesija"]`, nes maniau, kad `Client` reikšmę vartoja. Grandinė
     * `Connection` → `pg-protocol` jos nevartoja; žr. `NEREIKSMINGI`.
     */
    ["C: `PGCLIENT_ENCODING=LATIN1`", PILNAS, { PGCLIENT_ENCODING: "LATIN1" }, []],
  ];

  for (const [vardas, dsn, aplinka, laukiama] of ATVEJAI) {
    assert.deepEqual(
      jungtiesSemantikosSkirtumai({ DATABASE_URL: dsn, ...aplinka }),
      laukiama,
      `${vardas}: teisėta konfigūracija NEGALI stabdyti starto`
    );
  }

  /**
   * ⚠️ IR PRIEŠINGA KRYPTIS — BE JOS TAISYMAS BŪTŲ NEATSKIRIAMAS NUO APSAUGOS
   * PANAIKINIMO. Tikras skirtumas privalo likti konfliktu.
   */
  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: "postgres://u:p@/stenograma", PGHOST: "kitas.host" }),
    ["taikinys"],
    "kitas host'as - vis dar konfliktas"
  );
  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS, PGOPTIONS: "-csearch_path=kita" }),
    ["sesija"],
    "tikras sesijos semantikos pokytis - vis dar konfliktas"
  );

  /**
   * ⚠️ IR VIENA TIESA APIE HOST'Ų LYGYBĘ: palyginimas bei rodoma tapatybė
   * privalo naudoti TĄ PATĮ `normalizuotiHosta()`. Iki #245 peržiūros jos
   * išsiskirdavo būtent registro atveju.
   */
  const { efektyvusJungtiesParametrai, normalizuotiHosta } = require("../utils/pgConnection");

  assert.equal(
    efektyvusJungtiesParametrai({ connectionString: "postgres://u:p@DB.PROD:5432/s" }, {}).host,
    normalizuotiHosta("DB.PROD"),
    "rodoma tapatybė privalo eiti per tą patį normalizatorių"
  );
  assert.equal(
    normalizuotiHosta("/Prod"),
    "/Prod",
    "⚠️ unix socket KELIAS registro NEKEIČIA - failų sistema gali skirti raides"
  );
});

/* ──────────────────────────────────────────────────────────────────────────
 * KETVIRTAS PERŽIŪROS RAUNDAS (A2, B)
 * ────────────────────────────────────────────────────────────────────────── */

test("A2: privatumo validacija naudoja BENDRĄ detektorių ir įvardija TIKRĄJĮ selektorių", () => {
  /**
   * ⚠️ „PATAISA ĮĖJIME, NE VISAME KELYJE" — TAS PATS ŠABLONAS.
   *
   * `arNurodytaPostgres()` buvo pritaikytas `resolveBackendChoice()`, bet
   * `validatePrivacyConfig()` liko su `Boolean(env.DATABASE_URL)`. `PGHOST`-only
   * diegime tai davė DU melus vienu metu, ir abu — diagnostikoje, t. y. ten, kur
   * operatorius ateina ieškoti atsakymo.
   */
  const { validatePrivacyConfig } = require("../utils/privacyConfig");
  const PG_RINKINYS = { PGHOST: "db.compose", PGPORT: "5432", PGUSER: "u", PGPASSWORD: "p", PGDATABASE: "s" };

  /** 1 melas: „nei REDIS_URL, nei DATABASE_URL nenustatytas" — nors PostgreSQL yra. */
  const pirmas = validatePrivacyConfig({ ...PG_RINKINYS, PERSISTENT_STORAGE: "true" }).errors;

  assert.equal(pirmas.length, 1, `laukiama vienos klaidos, gauta: ${JSON.stringify(pirmas)}`);
  assert.ok(
    !/nei REDIS_URL, nei DATABASE_URL nenustatytas/.test(pirmas[0]),
    `NEGALI teigti, kad PostgreSQL nenurodytas: ${pirmas[0]}`
  );
  assert.match(
    pirmas[0],
    /JOB_STORE_BACKEND=postgres/,
    "privalo nurodyti VEIKIANTĮ veiksmą - eksplicitinį selektorių"
  );

  /**
   * 2 melas: prieštaros pranešime kintamojo vardas likdavo TUŠČIAS
   * („bet nustatytas  -"), nes `postgresConfigured` buvo `false`.
   */
  const antras = validatePrivacyConfig({
    ...PG_RINKINYS,
    PERSISTENT_STORAGE: "false",
    JOB_STORE_BACKEND: "postgres",
  }).errors;

  assert.equal(antras.length, 1);
  assert.ok(!/renka\s+-/.test(antras[0]), `tuščias selektoriaus vardas: ${antras[0]}`);
  assert.match(
    antras[0],
    /JOB_STORE_BACKEND=postgres/,
    "⚠️ `DATABASE_URL` pašalinimas čia NEVEIKTŲ - persistenciją renka `JOB_STORE_BACKEND`"
  );

  /** ⚠️ KONTROLĖ: Redis kelias nepasikeitė - kitaip taisymas būtų perrašęs kitą atsakymą. */
  const redis = validatePrivacyConfig({ REDIS_URL: "redis://r:6379", PERSISTENT_STORAGE: "false" }).errors;
  assert.equal(redis.length, 1);
  assert.match(redis[0], /REDIS_URL/);
});

test("B: `PGPASSFILE` yra RUNTIME kredencialų paviršius, kurio modelis nemato", () => {
  /**
   * ⚠️ ANTRA S2 SPRENDIMO RIBA, IR JI KITOKIA NEI PIRMOJI.
   *
   * Pirmoji buvo SVETIMA BIBLIOTEKA (libpq `pg_dump`/`psql`). Ši yra `pg`
   * RUNTIME: `ConnectionParameters` yra tik konstravimo momentas, o `Client` po
   * jo kviečia `pgpass` (`client.js:299`), kuris skaito `PGPASSFILE`
   * (`pgpass/lib/helper.js:58`). Modelis to nemato, tad palyginimas rodė NULĮ
   * skirtumų, nors aplinka realiai duoda kredencialus — ir tai kirtosi su
   * EKSPLICITINIU sargo pažadu atmesti kredencialų skirtumus.
   */
  const BE_SLAPTAZODZIO = "postgres://vartotojas@db.prod:5432/stenograma";

  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: BE_SLAPTAZODZIO, PGPASSFILE: "/tmp/kitas.pgpass" }),
    ["kredencialai"],
    "aplinka duoda slaptažodį, kurio DSN neturi - tai kredencialų skirtumas"
  );

  /**
   * ⚠️ IR TIK KAI REALIAI BŪTŲ PANAUDOTAS. `Client` `pgpass` kviečia tik
   * slaptažodžiui esant tuščiam; su pilnu DSN `PGPASSFILE` įtakos neturi, ir
   * stabdyti startą dėl jo būtų tas pats klaidingas teigiamas, kurį uždarė
   * `PGBINARY` ir `PGHOST` registro atvejai.
   */
  assert.deepEqual(
    jungtiesSemantikosSkirtumai({ DATABASE_URL: PILNAS, PGPASSFILE: "/tmp/kitas.pgpass" }),
    [],
    "su slaptažodžiu DSN'e `PGPASSFILE` nieko nekeičia"
  );

  /** ⚠️ KONTROLĖ: DSN be slaptažodžio BE `PGPASSFILE` dviprasmybės NEKELIA. */
  assert.deepEqual(jungtiesSemantikosSkirtumai({ DATABASE_URL: BE_SLAPTAZODZIO }), []);

  /**
   * ⚠️ RIBA UŽRAŠOMA, NE UŽGLAISTOMA: `~/.pgpass` skaitomas ir BE aplinkos
   * kintamojo, tad šis sąrašas jos neuždaro. Tikrinama, kad sąrašas būtų
   * ĮVARDYTAS ir minimalus — jei kas nors į jį įrašys spėjimą, testas parodys.
   */
  const { RUNTIME_KREDENCIALAI } = require("../utils/pgConnection");
  assert.deepEqual([...RUNTIME_KREDENCIALAI], ["PGPASSFILE"]);
});

/* ──────────────────────────────────────────────────────────────────────────
 * PENKTAS PERŽIŪROS RAUNDAS (B, A)
 * ────────────────────────────────────────────────────────────────────────── */

test("B: tapatybė sprendžiama TA PAČIA aplinka, kurią gaus vykdytojas", () => {
  /**
   * ⚠️ PATAISOS ŠALUTINIS POVEIKIS, NE RECIDYVAS.
   *
   * Iki `libpqSvariAplinka()` vaikinis procesas paveldėdavo `PG*`, tad modelis ir
   * vykdymas SUTAPDAVO (abu su aplinka). Uždarius paveldėjimą, jie IŠSISKYRĖ:
   * patikra `--url` papildydavo `PG*` reikšmėmis, kurių `pg_dump` nebegauna.
   *
   * ⚠️ IR TAI KLAUSIMAS, KURĮ REIKIA UŽDUOTI PO KIEKVIENO RIBOS UŽDARYMO:
   * kas dabar mato kitokią tikrovę nei anksčiau?
   *
   * ⚠️ CODEX SCENARIJUS (`DATABASE_URL` + `PGPORT`) YRA UŽBLOKUOTAS — jį pagauna
   * #245 dviprasmybės sargas. Pasiekiamas kelias yra `PG*`-only diegimas, kur
   * `DATABASE_URL` nėra, tad dviprasmybės pagal apibrėžimą nėra.
   */
  const { arTaPatiBaze, tapatybesTekstas, PgConnectionError } = require("../utils/pgConnection");

  const PG_ONLY = { PGHOST: "db.prod", PGPORT: "6543", PGUSER: "u", PGDATABASE: "prod" };
  const svari = Object.fromEntries(
    Object.entries(PG_ONLY).filter(([k]) => !k.toUpperCase().startsWith("PG"))
  );

  assert.deepEqual(
    jungtiesSemantikosSkirtumai(PG_ONLY),
    [],
    "prielaida: be `DATABASE_URL` dviprasmybės sargas tyli - todėl kelias pasiekiamas"
  );

  /** ⚠️ NEPILNAS `--url`: patikra ir vykdymas rodo į SKIRTINGUS portus → KRINTA. */
  const nepilnas = arTaPatiBaze("postgres://u@db.prod/prod", PG_ONLY, svari);
  assert.equal(nepilnas.sutampa, false, "nepilnas URL su `PGPORT` NEGALI būti patvirtintas");
  assert.match(tapatybesTekstas(nepilnas.nurodyta), /:5432\//, "vykdytojas eitų į 5432");
  assert.match(tapatybesTekstas(nepilnas.konfiguracija), /:6543\//, "o pool'ai naudoja 6543");

  /**
   * ⚠️ IŠMATUOTA KONTROLĖ, KURI PAGRINDĖ SPRENDIMĄ.
   *
   * Runbook'o `PG*` komanda nurodo portą eksplicitiškai
   * (`postgres://$PGUSER@$PGHOST:$PGPORT/$PGDATABASE`), tad ji privalo PRAEITI.
   * Griežtesnis variantas („URL turi turėti VISUS komponentus") ją sulaužytų:
   * slaptažodžio joje NĖRA.
   */
  const pilnas = arTaPatiBaze("postgres://u@db.prod:6543/prod", PG_ONLY, svari);
  assert.equal(pilnas.sutampa, true, "dokumentuota komanda privalo veikti");

  /** ⚠️ Numatytoji reikšmė nesikeičia: be trečio argumento elgesys toks pat kaip anksčiau. */
  assert.equal(arTaPatiBaze("postgres://u@db.prod/prod", PG_ONLY).sutampa, true);

  assert.ok(PgConnectionError, "tipas eksportuojamas");
});

test("A: `PG` prefikso filtras registrui NEJAUTRUS", () => {
  /**
   * ⚠️ TAISYKLĖ BUVO TEISINGA, REALIZACIJA — NE.
   *
   * `startsWith("PG")` yra registrui jautri, o Windows aplinkos kintamųjų vardai
   * — ne. `pghostaddr` filtrą praeidavo, o libpq jį išsprendžia kaip
   * `PGHOSTADDR`. Repo Windows palaiko eksplicitiškai (`README`).
   *
   * ⚠️ KODĖL `Object.entries` O NE `env.PGHOST`: Node Windows'e `process.env`
   * SKAITYMĄ daro registrui nejautrų, tad `env.PGHOST` veikia ir tada, kai
   * kintamasis nustatytas kaip `pghost`. Bet `Object.entries()` grąžina
   * ORIGINALŲ registrą — būtent todėl pro filtrą ir prasprūsdavo.
   */
  const { libpqSvariAplinka } = require("../utils/pgDumpBackup");

  const aplinka = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    PGHOSTADDR: "10.0.0.1",
    pghostaddr: "10.0.0.2",
    PgHostAddr: "10.0.0.3",
    pgpassword: "slaptas",
    PGSERVICE: "tarnyba",
    APPLE: "ne-pg",
  };

  const svari = libpqSvariAplinka(aplinka);

  assert.deepEqual(
    Object.keys(svari).sort(),
    ["APPLE", "HOME", "PATH"],
    `nė vienas \`PG*\` variantas negali likti, gauta: ${JSON.stringify(Object.keys(svari))}`
  );

  /** ⚠️ KONTROLĖ: ne-`PG` kintamieji privalo IŠLIKTI - kitaip vaikas netektų `PATH`. */
  assert.equal(svari.PATH, "/usr/bin");
  assert.equal(svari.APPLE, "ne-pg", "`APPLE` prasideda `A`, ne `PG` - jo šalinti negalima");
});
