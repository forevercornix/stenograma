const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pgDumpBackup = require("../utils/pgDumpBackup");
const { vaikinioProcesoKliutys } = require("../utils/pgConnection");

/**
 * `PG*` FORMA `pg-backup.mjs dump` KELYJE (#264).
 *
 * ⚠️ KĄ ŠIS FAILAS UŽDARO: iki #264 `dump` priimdavo TIK `DATABASE_URL`, nors
 * dokumentuotas Compose diegimas naudoja `PG*`. Bet naivus prijungimas būtų
 * blogesnis už neveikimą — matavimas parodė, kodėl.
 *
 * ⚠️ MATAVIMAS, KURIS PAKEITĖ SPRENDIMĄ. Iš tos pačios `pgJungtiesNustatymai()`
 * išvesties `{host, user, password, database}` Node `pg` gauna DAR `ssl=true`,
 * `options=-csearch_path=prod` ir `connect_timeout=9` — jis pats skaito aplinką.
 * `pg_dump` to kanalo neturi: `libpqSvariAplinka()` šalina VISĄ `PG` prefiksą.
 *
 * Vadinasi DSN iš nustatymų TYLIAI prarastų `sslmode` ir `options`. Kopija per
 * nešifruotą jungtį arba iš kitos schemos atrodytų kaip sėkmė.
 *
 * Todėl garantija SĄLYGINĖ: `PG*` palaikoma, KAI jungtis aprašoma tik
 * `PG_ATITIKMENYS` kintamaisiais; kitaip atsisakoma GARSIAI.
 *
 * ⚠️ TIKRO PostgreSQL NEREIKIA. `pg_dump` pakeičiamas `PATH` stub'u, kuris įrašo
 * savo `argv` ir aplinką - tad matoma ne „ar praėjo", o KĄ VAIKINIS PROCESAS
 * REALIAI GAVO.
 */

const PG_BAZE = { PGHOST: "db.vidinis", PGPORT: "6543", PGUSER: "kopijuotojas", PGDATABASE: "stenograma" };

/**
 * ⚠️ ŠVARI APLINKA APIMA IR `DATABASE_URL` (Codex II, C2).
 *
 * Pirmoji redakcija šalino tik `PG*`, ir `DATABASE_URL` likdavo. Paleidus rinkinį
 * shell'e su nustatytu `DATABASE_URL`, TRYS iš dešimties testų krisdavo -
 * įskaitant centrinę vėliavų aserciją, nes taikinys nukrypdavo į URL formą.
 *
 * ⚠️ TAI NUVERTINO NE VIENĄ TESTĄ, O VISĄ ŠIO PR ĮRODYMŲ BAZĘ: „10/10" reiškė
 * „10/10 ten, kur `DATABASE_URL` nenustatytas". Operatoriaus mašinoje jis
 * nustatytas beveik visada.
 */
const JUNGTIES_KINTAMIEJI = (raktas) => raktas.toUpperCase().startsWith("PG") || raktas === "DATABASE_URL";

function svariProcesoAplinka() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!JUNGTIES_KINTAMIEJI(k)) e[k] = v;
  }
  return e;
}

/**
 * Paleidžia `sukurtiSifruotaKopija()` su stub'intu `pg_dump`.
 *
 * ⚠️ EINAMA TIKRU KELIU, ne testo surinkta kompozicija: `vykdytiLibpq()`
 * neeksportuojamas sąmoningai, ir kviesti jį apeinant `sukurtiSifruotaKopija()`
 * reikštų tikrinti savo pačios surinkimą, ne produkcinį.
 */
async function suStubu(pgKintamieji, { url = undefined, papildoma = {} } = {}) {
  const darbinis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-264-"));
  const zurnalas = path.join(darbinis, "argv.json");

  fs.writeFileSync(
    path.join(darbinis, "pg_dump"),
    [
      "#!/usr/bin/env node",
      `const fs=require("fs");`,
      `fs.writeFileSync(${JSON.stringify(zurnalas)}, JSON.stringify({`,
      `  argv: process.argv.slice(2),`,
      `  pgKintamieji: Object.keys(process.env).filter(k=>k.toUpperCase().startsWith("PG")),`,
      `}));`,
      `process.stdout.write("-- stub dump\\n");`,
    ].join("\n"),
    { mode: 0o755 }
  );

  const env = {
    ...svariProcesoAplinka(),
    ...pgKintamieji,
    PATH: `${darbinis}:${process.env.PATH}`,
    BACKUP_ENABLED: "true",
    BACKUP_ENCRYPTION_KEY: "a".repeat(64),
    ...papildoma,
  };

  /**
   * ⚠️ VISŲ jungties kintamųjų snapshot'as ir IŠVALYMAS, ne tik `PG_BAZE` raktų.
   *
   * Žymų pusė skaitoma iš `process.env`, tad paveldėtas `DATABASE_URL` ar senas
   * `PGSSLMODE` keistų būtent tą pusę, kurios testas netikrina eksplicitiškai -
   * ir gedimas atrodytų kaip logikos klaida.
   */
  const senosProceso = {};
  for (const k of Object.keys(process.env)) {
    if (JUNGTIES_KINTAMIEJI(k)) {
      senosProceso[k] = process.env[k];
      delete process.env[k];
    }
  }

  /**
   * ⚠️ Į `process.env` atspindimi IR `PG*`, IR `DATABASE_URL`: žymų pusė
   * (`patikrintiZymuTapatuma`) skaito GLOBALIĄ aplinką, ne injektuotą. Be to
   * taikinys ir žymos rodytų į skirtingas vietas, ir testas kristų dėl tapatybės,
   * o ne dėl to, ką tikrina.
   */
  for (const [k, v] of Object.entries({ ...pgKintamieji, ...papildoma })) {
    if (JUNGTIES_KINTAMIEJI(k)) process.env[k] = v;
  }

  try {
    let klaida = null;
    try {
      await pgDumpBackup.sukurtiSifruotaKopija({ databaseUrl: url, actor: "testas", env });
    } catch (e) {
      klaida = e;
    }

    const irasyta = fs.existsSync(zurnalas) ? JSON.parse(fs.readFileSync(zurnalas, "utf8")) : null;
    return { klaida, irasyta };
  } finally {
    for (const k of Object.keys(process.env)) if (JUNGTIES_KINTAMIEJI(k)) delete process.env[k];
    for (const [k, v] of Object.entries(senosProceso)) process.env[k] = v;
    fs.rmSync(darbinis, { recursive: true, force: true });
  }
}

test("#264 RIBA: švari `PG*` aibė kliūčių NETURI", () => {
  assert.deepEqual(vaikinioProcesoKliutys({ HOME: "/h", ...PG_BAZE }), []);
});

test("#264 RIBA: kiekvienas neperduodamas kintamasis duoda GARSŲ atsisakymą", () => {
  /**
   * ⚠️ `PGPASSWORD` čia yra ne dėl simetrijos. Jis `PG_ATITIKMENYS` YRA, bet į
   * vaikinį procesą nepereina: aplinka valoma, o slaptažodžio vėliavos libpq CLI
   * neturi. Įdėti jį į DSN reikštų URI kodavimą ir slaptažodį `argv` eilutėje.
   */
  for (const kintamasis of ["PGSSLMODE", "PGOPTIONS", "PGCONNECT_TIMEOUT", "PGPASSFILE", "PGPASSWORD"]) {
    const kliutys = vaikinioProcesoKliutys({ HOME: "/h", ...PG_BAZE, [kintamasis]: "x" });
    assert.deepEqual(kliutys, [kintamasis], `${kintamasis} privalo būti kliūtis`);
  }
});

test("#264 RIBA: IŠVEDIMO SAVIPATIKRA - nežinomas `PGNAUJAS` irgi blokuoja", () => {
  /**
   * ⚠️ BE ŠIO TESTO TIKRINTUME PENKIS PAVYZDŽIUS, NE TAISYKLĘ.
   *
   * Sąlyga išvedama iš `PG_ATITIKMENYS`, o ne surašyta. Rankinis sąrašas būtų ta
   * pati klasė, kurią #245 atmetė: senstantis tyliai. Šis testas yra vienintelis,
   * kuris skiria išvedimą nuo sąrašo - fiktyvus kintamasis jokiame sąraše
   * neatsirastų, bet taisyklę pažeidžia.
   */
  assert.deepEqual(vaikinioProcesoKliutys({ HOME: "/h", ...PG_BAZE, PGNAUJAS: "x" }), ["PGNAUJAS"]);

  /** Registras: `libpqSvariAplinka()` irgi nejautrus, tad riba privalo sutapti. */
  assert.deepEqual(vaikinioProcesoKliutys({ HOME: "/h", ...PG_BAZE, pgsslmode: "require" }), ["pgsslmode"]);

  /** Tuščia reikšmė jungties nekeičia - kitaip atsisakytume be priežasties. */
  assert.deepEqual(vaikinioProcesoKliutys({ HOME: "/h", ...PG_BAZE, PGSSLMODE: "" }), []);
});

test("#264 VĖLIAVOS: `PG*` taikinys virsta `-h/-p/-U/-d`, be pozicinio URL", () => {
  const argumentai = pgDumpBackup.PG_DUMP_ARGUMENTAI({
    host: "db.vidinis",
    port: 6543,
    user: "kopijuotojas",
    database: "stenograma",
  });

  assert.deepEqual(argumentai.slice(3), ["-h", "db.vidinis", "-p", "6543", "-U", "kopijuotojas", "-d", "stenograma"]);
  assert.ok(argumentai.includes("--exclude-table-data=audit_log"), "7.4d taisyklė lieka");
});

test("#264 REGRESIJA: URL kelias lieka POZICINIS ir nepakitęs", () => {
  /**
   * ⚠️ URL NEARDOMAS Į VĖLIAVAS SĄMONINGAI. Query eilutė (`sslmode`, `options`)
   * į vėliavas nepersikelia, tad ardymas įneštų tylų praradimą ten, kur jo
   * šiandien NĖRA.
   */
  const argumentai = pgDumpBackup.PG_DUMP_ARGUMENTAI("postgres://u@h/d");
  assert.equal(argumentai.at(-1), "postgres://u@h/d");
  assert.equal(argumentai.some((a) => a === "-h"), false, "URL kelias vėliavų neturi");
});

test("#264 VAIKINIS PROCESAS: `PG*` režime gauna vėliavas, o `argv` NETURI slaptažodžio", async () => {
  /**
   * ⚠️ ŠIS TESTAS YRA SVARBIAUSIAS, IR JIS MATUOJA, NE TEIGIA.
   *
   * Stub'as įrašo savo `argv` ir `PG*` kintamųjų vardus. Tikrinama trys dalykys:
   * ką vaikinis procesas gavo, kad aplinka tikrai išvalyta, ir kad slaptažodžio
   * nėra NIEKUR argumentuose - net jei riba kada nors susilpnėtų.
   */
  const { irasyta } = await suStubu({ ...PG_BAZE });

  assert.ok(irasyta, "stub'as privalo būti paleistas - kitaip matuojame nieką");
  assert.deepEqual(
    irasyta.argv.slice(3),
    ["-h", "db.vidinis", "-p", "6543", "-U", "kopijuotojas", "-d", "stenograma"],
    "vaikinis procesas privalo gauti TAIKINĮ, ne numatytuosius"
  );

  assert.deepEqual(irasyta.pgKintamieji, [], "`libpqSvariAplinka()`: nė vieno `PG*` vaikiniame procese");

  const argvTekstas = irasyta.argv.join(" ");
  assert.equal(/slaptas|password=/i.test(argvTekstas), false, `slaptažodis \`argv\` eilutėje: ${argvTekstas}`);
});

test("#264 ATSISAKYMAS: `PGOPTIONS` sustabdo PRIEŠ `pg_dump`, ne po jo", async () => {
  const { klaida, irasyta } = await suStubu({ ...PG_BAZE, PGOPTIONS: "-csearch_path=prod" });

  assert.equal(klaida?.code, "PG_DUMP_ENV_NOT_PORTABLE");
  assert.equal(irasyta, null, "⚠️ `pg_dump` NEGALI būti paleistas - kitaip kopija jau būtų iš ne tos schemos");
  assert.match(klaida.message, /PGOPTIONS/, "tekstas privalo įvardyti KURĮ kintamąjį šalinti");
  assert.match(klaida.message, /pgpass/i, "tekstas privalo nurodyti IŠEITĮ");
});

test("#264 ATSISAKYMAS: `PGPASSWORD` neleidžia slaptažodžiui pasiekti `argv`", async () => {
  const { klaida, irasyta } = await suStubu({ ...PG_BAZE, PGPASSWORD: "slaptas" });

  assert.equal(klaida?.code, "PG_DUMP_ENV_NOT_PORTABLE");
  assert.equal(irasyta, null);
  /** ⚠️ Reikšmės klaidos tekste būti NEGALI - tik klasė (#245). */
  assert.equal(klaida.message.includes("slaptas"), false, "slaptažodžio REIKŠMĖ klaidos tekste");
});

test("#264 NĖ VIENOS FORMOS: klaida mini ABI", async () => {
  const { klaida } = await suStubu({});

  assert.equal(klaida?.code, "PG_DUMP_NO_URL");
  assert.match(klaida.message, /DATABASE_URL/, "privalo minėti URL formą");
  assert.match(klaida.message, /PG\*|PGHOST/, "privalo minėti `PG*` formą");
});

test("#264 PRIORITETAS: eksplicitinis `--url` perrašo `PG*` ir ribos NEGAUNA", async () => {
  /**
   * ⚠️ RIBA `--url` KELIUI NETAIKOMA SĄMONINGAI. Ten operatorius PATS įvardijo
   * taikinį, ir „URL yra vienintelis šaltinis" yra `libpqSvariAplinka()` jau
   * užrašyta ir priimta kaina. `PG*` atveju operatorius URL nerašė - jo
   * konfigūracija YRA `PG*` aibė.
   *
   * Todėl `PGSSLMODE`, blokuojantis `PG*` kelią, `--url` kelio neblokuoja.
   */
  const url = "postgres://kopijuotojas@db.vidinis:6543/stenograma";
  const { irasyta } = await suStubu({ ...PG_BAZE, PGSSLMODE: "require" }, { url });

  assert.ok(irasyta, "su `--url` riba netaikoma, `pg_dump` privalo pasileisti");
  assert.equal(irasyta.argv.at(-1), url, "taikinys - pozicinis URL");
});

/* ══════════════════════════════════════════════════════════════════════════
 * ANTRAS CODEX RAUNDAS — A1, A2, B1, B2, C1
 * ══════════════════════════════════════════════════════════════════════════ */

const { arConninfoReiksme, PG_ATITIKMENYS } = require("../utils/pgConnection");

test("#264 A1: `PGDATABASE` su conninfo ATMETAMAS, ne escape'inamas", async () => {
  /**
   * ⚠️ TA PATI KLASĖ, KURIĄ ŠIS PR UŽDARO — JO PACIO VIDUJE.
   *
   * `pg_dump -d` priima connection string, ir jo parametrai PERRAŠO `-h`/`-p`/`-U`.
   * Node `pg` tą pačią reikšmę laiko literaliu vardu. Išmatuota: tapatybė grąžina
   * `host=safe.invalid`, o vaikinis procesas eitų į `other.invalid`.
   *
   * Forma identiška `PGHOSTADDR` (#245 P1): modelis ir vaikinis procesas tą PAČIĄ
   * įvestį interpretuoja skirtingai.
   */
  const { klaida, irasyta } = await suStubu({
    PGHOST: "safe.invalid",
    PGUSER: "u",
    PGDATABASE: "host=other.invalid dbname=x",
  });

  assert.equal(klaida?.code, "PG_DUMP_CONNINFO_IN_NAME");
  assert.equal(irasyta, null, "⚠️ `pg_dump` NEGALI būti paleistas su conninfo vardo vietoje");
  assert.match(klaida.message, /PERRAŠO|perrašo/, "tekstas privalo sakyti KODĖL, ne „netinkamas vardas\"");
  /** ⚠️ Reikšmės tekste nėra: conninfo gali turėti `password=…`. */
  assert.equal(klaida.message.includes("other.invalid"), false, "reikšmė klaidos tekste");
});

test("#264 A1: aptikimas IŠVESTAS — `=` arba URI prefiksas, ne sąrašas", () => {
  for (const v of ["host=other dbname=x", "postgres://k/x", "postgresql://k/x", " dbname=x "]) {
    assert.equal(arConninfoReiksme(v), true, `${v} yra conninfo`);
  }
  for (const v of ["stenograma", "my-db", "db_1", ""]) {
    assert.equal(arConninfoReiksme(v), false, `${v} yra vardas`);
  }
});

test("#264 A2: `DATABASE_URL` be `--url` — `pg_dump` GAUNA taikinį", async () => {
  /**
   * ⚠️ REGRESIJA ESAMAME KELYJE, ne naujo kelio trūkumas.
   *
   * `pgJungtiesNustatymai()` su `DATABASE_URL` grąžina `{connectionString}`, o
   * vėliavų konstruktorius moka tik `host`/`port`/`user`/`database` — tad
   * `pg_dump` negaudavo taikinio IŠ VISO ir jungdavosi prie numatytosios lokalios
   * bazės, o tapatybės patikra tuo metu patvirtindavo nurodytą URL.
   */
  const url = "postgres://kopijuotojas@db.vidinis:6543/stenograma";
  const { irasyta } = await suStubu({}, { papildoma: { DATABASE_URL: url } });

  assert.ok(irasyta, "stub'as privalo būti paleistas");
  assert.equal(irasyta.argv.at(-1), url, "⚠️ taikinys privalo pasiekti vaikinį procesą");
  assert.equal(irasyta.argv.length, 4, `taikinys yra POZICINIS, be vėliavų: ${irasyta.argv.join(" ")}`);
});

test("#264 B1: `PGPORT=\"\"` — vėliavos BE `-p`, ta pati semantika kaip `pg`", async () => {
  /**
   * ⚠️ DVI „NENUSTATYTA" SEMANTIKOS TAME PAČIAME KELYJE.
   *
   * `pgJungtiesNustatymai()` tuščią reikšmę verčia SKAITINIU `0`, o Node `pg`
   * falsy laiko nesančia ir sprendžia `5432`. Be patikros vėliavose atsirasdavo
   * `-p 0`, kurį `pg_dump` atmeta — ir preflight tapatybė to NEPAGAUDAVO, nes abi
   * jos pusės naudoja tą pačią falsy taisyklę.
   */
  const { irasyta } = await suStubu({ PGHOST: "db.vidinis", PGUSER: "u", PGDATABASE: "d", PGPORT: "" });

  assert.ok(irasyta, "tuščias `PGPORT` neturi stabdyti - jis reiškia „nenurodyta\"");
  assert.equal(irasyta.argv.includes("-p"), false, `⚠️ \`-p\` negali atsirasti: ${irasyta.argv.join(" ")}`);
  assert.equal(irasyta.argv.includes("0"), false, "`-p 0` yra reikšmė, kurios `pg_dump` nepriima");
});

test("#264 B2: repo savas `PG_CONNECT_TIMEOUT_MS` dump'o NESTABDO", async () => {
  /**
   * ⚠️ KLAIDINGAS TEIGIAMAS, KURIS BŪTŲ SULAUŽĘS KIEKVIENĄ DUMP'Ą.
   *
   * `deletionTombstones/index.js:126` atgalinio suderinamumo atsarga prasideda
   * `PG`, `PG_ATITIKMENYS` jos nėra — tad riba laikė ją libpq kintamuoju.
   */
  const { irasyta, klaida } = await suStubu({
    PGHOST: "db.vidinis",
    PGUSER: "u",
    PGDATABASE: "d",
    PG_CONNECT_TIMEOUT_MS: "5000",
  });

  /**
   * ⚠️ TIKRINAMA RIBA, NE VISA PROCEDŪRA. Be tikros DB kelias vis tiek baigsis
   * `PG_BACKUP_HORIZON_UNRECORDED` - tai laukiama ir NEsusiję su portabilumu.
   * Svarbu, kad `pg_dump` BUVO pasiektas.
   */
  assert.notEqual(klaida?.code, "PG_DUMP_ENV_NOT_PORTABLE", "aplikacijos kintamasis neturi blokuoti");
  assert.ok(irasyta, "`pg_dump` privalo būti pasiektas");
});

test("#264 B2 LIUDYTOJAS: vardų konvencija `PG` + raidė = libpq, `PG_` = aplikacija", () => {
  /**
   * ⚠️ PRIELAIDA SU LIUDYTOJU, NE GARANTIJA.
   *
   * Skirtumas tarp libpq ir aplikacijos kintamųjų remiasi STEBĖJIMU, kad libpq
   * vardų erdvėje po `PG` visada eina raidė. Tai ne specifikacijos garantija.
   *
   * ⚠️ Šis testas yra tos prielaidos liudytojas: atsiradus libpq kintamajam su
   * `PG_`, jis KRIS, ir taisyklė bus peržiūrėta — o ne tyliai praleis kintamąjį,
   * kurį vaikinis procesas skaito.
   */
  const ZINOMI_LIBPQ = [
    "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE",
    "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGAPPNAME", "PGSSLMODE", "PGSSLCERT",
    "PGSSLKEY", "PGSSLROOTCERT", "PGSSLCRL", "PGSSLNEGOTIATION", "PGREQUIREPEER",
    "PGREQUIRESSL", "PGGSSENCMODE", "PGKRBSRVNAME", "PGGSSLIB", "PGCONNECT_TIMEOUT",
    "PGCLIENTENCODING", "PGTARGETSESSIONATTRS", "PGTZ", "PGDATESTYLE", "PGGEQO",
  ];

  for (const vardas of ZINOMI_LIBPQ) {
    assert.equal(
      vardas.startsWith("PG_"),
      false,
      `⚠️ ${vardas} laužo prielaidą: libpq kintamasis su \`PG_\` reikštų, kad riba jį praleidžia`
    );
  }

  for (const raktas of Object.keys(PG_ATITIKMENYS)) {
    assert.equal(raktas.startsWith("PG_"), false, `${raktas} laužo tą pačią prielaidą`);
  }
});

test("#264 C1: išjungtos kopijos duoda `BACKUP_DISABLED`, ne aplinkos klaidą", async () => {
  /**
   * ⚠️ TVARKA YRA OPERATORIAUS KLAUSIMAS, NE STILIAUS.
   *
   * Sprendus taikinį pirma, operatorius su išjungtomis kopijomis IR nepernešama
   * `PG*` konfigūracija gaudavo `PG_DUMP_ENV_NOT_PORTABLE` ir imdavo taisyti
   * kredencialus — nors jokia aplinkos pataisa nebūtų padėjusi.
   */
  const { klaida } = await suStubu(
    { PGHOST: "db.vidinis", PGUSER: "u", PGDATABASE: "d", PGSSLMODE: "require" },
    { papildoma: { BACKUP_ENABLED: "false" } }
  );

  assert.equal(klaida?.code, "BACKUP_DISABLED", "sprendimas turi pirmenybę prieš konfigūraciją");
});
