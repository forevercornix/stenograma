const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { suites } = require("./suites");

/**
 * TAP LIUDYTOJO ELGSENA VISOMS SEPTYNIOMS KONFIGŪRACIJOMS (#402).
 *
 * ⚠️ KODĖL FIXTURE'AI, O NE TIKRI RINKINIAI. Fixture'ai atsirado #402 metu, kai
 * `s3` ir `postgresS3` žingsniai CI'e buvo nepasiekiami (prieš juos krisdavo MinIO,
 * `quay.io … unauthorized`). ⚠️ NUO #405 TA PRIEŽASTIS DINGO — rinkiniai vėl
 * vykdomi prieš seaweedfs — BET FIXTURE'AI LIEKA, ir tai ne inercija: jie tikrina
 * LIUDYTOJĄ, ne rinkinius, tad turi veikti ir tada, kai saugyklos nėra.
 *
 * ⚠️ TAI TIKRINA LIUDYTOJĄ, NE RINKINIUS. TAP katalogai gaminami sintetiškai, tad
 * atsakymas nepriklauso nuo to, ar konkretus testas šiandien praleidžiamas.
 */

const SAKNIS = path.resolve(__dirname, "..");
const SKRIPTAS = path.join(SAKNIS, "scripts", "verify-postgres-suite-ran.mjs");

/** Visos SEPTYNIOS CI konfigūracijos — rinkinys ir jo praleidimo žyma. */
const KONFIGURACIJOS = Object.freeze([
  { rinkinys: "privacy", zyma: "-" },
  { rinkinys: "security", zyma: "-" },
  { rinkinys: "functional", zyma: "-" },
  { rinkinys: "redis", zyma: "-" },
  { rinkinys: "postgres", zyma: "DATABASE_URL" },
  { rinkinys: "s3", zyma: "S3_ENDPOINT" },
  { rinkinys: "postgresS3", zyma: "DATABASE_URL" },
]);

function tapSuVykdytu(pavadinimas) {
  return `TAP version 13\n# Subtest: ${pavadinimas}\nok 1 - ${pavadinimas}\n  ---\n  duration_ms: 1\n  ...\n1..1\n`;
}

function tapVisiPraleisti(zyma) {
  return `TAP version 13\nok 1 - kazkas # SKIP reikia ${zyma}\n1..1\n`;
}

/** Paruošia katalogą, kuriame KIEKVIENAS rinkinio failas turi `ok`. */
function paruostiKataloga(t, rinkinys, kurti = (testas) => tapSuVykdytu(testas)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stenograma-liud-${rinkinys}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const testas of suites[rinkinys]) {
    const turinys = kurti(testas);
    if (turinys !== null) fs.writeFileSync(path.join(dir, `${testas}.tap`), turinys, "utf8");
  }
  return dir;
}

function paleisti(dir, rinkinys, zyma) {
  /** ⚠️ `undefined` NEPERDUODAMAS: `spawnSync` jį paverstų eilute "undefined". */
  const argv = [SKRIPTAS, dir];
  if (rinkinys !== undefined) argv.push(rinkinys);
  if (zyma !== undefined) argv.push(zyma);
  const r = spawnSync("node", argv, { cwd: SAKNIS, encoding: "utf8" });
  return { status: r.status, isvestis: `${r.stdout}${r.stderr}` };
}

test("#402 M4a: visos SEPTYNIOS konfigūracijos priima pilną TAP katalogą", (t) => {
  /**
   * ⚠️ TAI KONTROLĖ, BE KURIOS „KRENTA, KAI TRŪKSTA" NIEKO NEREIŠKIA. Liudytojas,
   * atmetantis viską, praeitų kiekvieną neigiamą testą ir nuverstų visą CI.
   */
  for (const { rinkinys, zyma } of KONFIGURACIJOS) {
    const dir = paruostiKataloga(t, rinkinys);
    const { status, isvestis } = paleisti(dir, rinkinys, zyma);
    assert.equal(status, 0, `${rinkinys} (${zyma}) turėjo praeiti: ${isvestis}`);
    assert.match(isvestis, new RegExp(`Rinkinys "${rinkinys}": visi ${suites[rinkinys].length} failai`), isvestis);
  }
});

test("#402 M4a: `-` ir env žyma pranešime sako SKIRTINGUS dalykus", () => {
  /**
   * ⚠️ TEIGINYS APIE NE TĄ DALYKĄ YRA #342 KLASĖ. Su `-` pranešimas „nė vieno
   * praleidimo dėl `-`" būtų taisyklinga eilutė apie neegzistuojantį kintamąjį.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-liud-zyma-"));
  try {
    for (const testas of suites.s3) fs.writeFileSync(path.join(dir, `${testas}.tap`), tapSuVykdytu(testas));

    const beZymos = paleisti(dir, "s3", "-");
    assert.equal(beZymos.status, 0, beZymos.isvestis);
    assert.match(beZymos.isvestis, /privalomo env šis rinkinys neturi/, beZymos.isvestis);

    const suZyma = paleisti(dir, "s3", "S3_ENDPOINT");
    assert.equal(suZyma.status, 0, suZyma.isvestis);
    assert.match(suZyma.isvestis, /nė vieno praleidimo dėl `S3_ENDPOINT`/, suZyma.isvestis);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#402: env žyma KRENTA ties praleidimu, o `-` tokio praleidimo nepriskiria", (t) => {
  /**
   * ⚠️ ČIA MATOSI, KODĖL KETURIEMS RINKINIAMS `DATABASE_URL` NETIKTŲ. Tas pats TAP su
   * praleidimu dėl `DATABASE_URL`: `postgres` semantikoje tai GEDIMAS (env privalomas),
   * o `privacy` semantikoje — projektinis praleidimas (kontraktinis failas leidžia
   * atminties adapterį). Skirtumą daro žyma, ne failas.
   */
  const suPraleidimu = (testas) =>
    `TAP version 13\nok 1 - veikia - ${testas}\nok 2 - pg adapteris # SKIP reikia DATABASE_URL\n1..2\n`;

  const pgDir = paruostiKataloga(t, "postgres", suPraleidimu);
  const pg = paleisti(pgDir, "postgres", "DATABASE_URL");
  assert.equal(pg.status, 1, "su `DATABASE_URL` praleidimas privalo būti GEDIMAS");
  assert.match(pg.isvestis, /praleista dėl trūkstamo `DATABASE_URL`/, pg.isvestis);

  const privDir = paruostiKataloga(t, "privacy", suPraleidimu);
  const priv = paleisti(privDir, "privacy", "-");
  assert.equal(priv.status, 0, `su \`-\` tas pats praleidimas NĖRA gedimas: ${priv.isvestis}`);
});

test("#402 D5: trūkstamas `.tap` krenta su FAILO vardu", (t) => {
  const dir = paruostiKataloga(t, "functional", (testas) =>
    testas === suites.functional[0] ? null : tapSuVykdytu(testas)
  );
  const { status, isvestis } = paleisti(dir, "functional", "-");
  assert.equal(status, 1);
  assert.match(isvestis, new RegExp(`${suites.functional[0]}: TAP failo nėra`), isvestis);
});

test("#402: TYLIAI NUTILĘS failas (visi testai praleisti) krenta ir su `-`", (t) => {
  /**
   * ⚠️ TAI #231 KRITERIJAUS ESMĖ, IR JI NEPRIKLAUSO NUO ŽYMOS. `-` išjungia praleidimų
   * PRISKYRIMĄ, bet ne reikalavimą turėti bent vieną NEPRALEISTĄ `ok`. Priešingu atveju
   * `-` būtų tylus būdas išjungti visą patikrą.
   */
  const dir = paruostiKataloga(t, "functional", (testas) =>
    testas === suites.functional[0] ? tapVisiPraleisti("KAŽKO") : tapSuVykdytu(testas)
  );
  const { status, isvestis } = paleisti(dir, "functional", "-");
  assert.equal(status, 1);
  assert.match(isvestis, new RegExp(`${suites.functional[0]}: nė vieno nepraleisto`), isvestis);
});

test("#402 M4b: netikėta žymos reikšmė atmetama FAIL-CLOSED, ne priimama tyliai", (t) => {
  /**
   * ⚠️ ŽYMA, KURI NIEKO NEATITINKA, PATIKRĄ PRALEISTŲ ATRODYDAMA GRIEŽTA. `DATABASE_URl`
   * (mažoji `l`) yra tiksliai toks atvejis: taisyklingai atrodanti eilutė, kuri
   * niekada nesutaps su tikruoju praleidimo tekstu.
   */
  const dir = paruostiKataloga(t, "s3");
  for (const bloga of ["--", "", "DATABASE_URl", "database_url", "-x"]) {
    const { status, isvestis } = paleisti(dir, "s3", bloga);
    assert.equal(status, 2, `žyma "${bloga}" turėjo būti atmesta: ${isvestis}`);
    assert.match(isvestis, /Netinkama praleidimo žyma/, isvestis);
  }

  /** Kontrolė: abi teisėtos formos priimamos. */
  for (const gera of ["-", "S3_ENDPOINT"]) {
    assert.notEqual(paleisti(dir, "s3", gera).status, 2, `žyma "${gera}" turėjo būti priimta`);
  }
});

test("#402 M4b: nežinomas rinkinys atmetamas, ne tyliai praleidžiamas", (t) => {
  const dir = paruostiKataloga(t, "s3");
  const { status, isvestis } = paleisti(dir, "nesamas", "-");
  assert.equal(status, 2, isvestis);
  assert.match(isvestis, /Nežinomas rinkinys "nesamas"/, isvestis);
});

test("#402: numatytieji argumentai NEPAKITĘ — `postgres` + `DATABASE_URL`", (t) => {
  /**
   * ⚠️ RIBOS TESTAS. `ci.yml:317` kviečia skriptą BE rinkinio ir BE žymos. Jei
   * numatytosios reikšmės pasikeistų, tas žingsnis tyliai imtų tikrinti ne tą.
   */
  const dir = paruostiKataloga(t, "postgres");
  const { status, isvestis } = paleisti(dir, undefined, undefined);
  assert.equal(status, 0, isvestis);
  assert.match(isvestis, /Rinkinys "postgres"/, isvestis);
  assert.match(isvestis, /nė vieno praleidimo dėl `DATABASE_URL`/, isvestis);
});
