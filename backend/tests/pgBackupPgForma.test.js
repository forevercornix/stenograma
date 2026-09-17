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

/** Aplinka be jokių `PG*` - kad testo tarpusavio nutekėjimo nebūtų. */
function svariProcesoAplinka() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("PG")) e[k] = v;
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
async function suStubu(pgKintamieji, { url = undefined } = {}) {
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
  };

  const senosProceso = {};
  for (const k of Object.keys(PG_BAZE)) senosProceso[k] = process.env[k];
  /** Žymų pusė skaitoma iš `process.env` - tad ji turi atitikti taikinį. */
  for (const [k, v] of Object.entries(pgKintamieji)) {
    if (k.toUpperCase().startsWith("PG")) process.env[k] = v;
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
    for (const [k, v] of Object.entries(senosProceso)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(pgKintamieji)) if (!(k in senosProceso)) delete process.env[k];
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
