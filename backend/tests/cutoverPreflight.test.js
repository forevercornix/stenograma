const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * CUTOVER 5b PREFLIGHT — ELGSENOS LIUDYTOJAS (#155, #342 Codex P1).
 *
 * ⚠️ ANTRAS KARTAS TAI PAČIAI PATIKRAI, IR KIEKVIENĄ KARTĄ KITA MECHANIKA.
 *
 *   #338: `grep -q true && echo` — tik PRANEŠDAVO, o `DEL` ėjo besąlygiškai.
 *   #342: klaidos statusas dingdavo `if` SĄLYGOJE ir PROCESO PAKAITOJE,
 *         nepaisant `set -euo pipefail`.
 *
 * Abu kartus yda buvo TEKSTE, kurio niekas nevykdė. Blokas yra destruktyvus
 * (`DEL` visiems `job:*` plius indeksui), tad jo teisingumas negali remtis
 * perskaitymu — juolab kad `set -e` sklaida per subshell'us ir sąlygas nėra
 * akivaizdi net atidžiam skaitytojui.
 *
 * ⚠️ VYKDOMAS TAS PATS TEKSTAS, KURĮ SKAITO OPERATORIUS. Blokas ištraukiamas iš
 * `docs/migrations.md`; nukopijuota kopija testo faile išsiskirtų su dokumentu, o
 * skirtumas pasimatytų tik tada, kai vienas iš dviejų nustotų ginti.
 *
 * ⚠️ TIKRO REDIS NEREIKIA. `redis-cli` pakeičiamas stub'u `PATH` pradžioje; jis
 * įrašo kiekvieną kvietimą, tad matoma ne tik baigtis, bet ir ar `DEL` apskritai
 * buvo pasiektas.
 */

const DOKUMENTAS = path.join(__dirname, "..", "..", "docs", "migrations.md");

/** Ištraukia 5b bash bloką iš dokumento — nuo `set -euo pipefail` iki indekso trynimo. */
function istrauktiBloka() {
  const tekstas = fs.readFileSync(DOKUMENTAS, "utf8");

  const blokai = [...tekstas.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const blokas = blokai.find((b) => b.includes("jobs:index") && b.includes("HMGET"));

  assert.ok(blokas, "`docs/migrations.md` privalo turėti 5b bash bloką su `HMGET` ir `jobs:index`");
  return blokas;
}

/**
 * Paleidžia bloką su stub'intu `redis-cli`.
 *
 * @param {object} p
 * @param {string} p.scan `--scan` išvestis
 * @param {number} [p.scanKodas] `--scan` išėjimo kodas (0 = pavyko)
 * @param {string} [p.hmget] `HMGET` išvestis kiekvienam raktui
 * @param {number} [p.hmgetKodas]
 */
function paleisti({ scan = "", scanKodas = 0, hmget = "\n", hmgetKodas = 0, pirmasScanKrenta = false }) {
  const darbinis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-cutover-"));

  try {
    const zurnalas = path.join(darbinis, "kvietimai.log");

    /**
     * Stub'as skiria `--scan` nuo `HMGET` nuo `DEL`. Kiekvienas kvietimas
     * įrašomas PRIEŠ galimą kritimą — kitaip nematytume, kad `DEL` buvo pasiektas.
     */
    fs.writeFileSync(
      path.join(darbinis, "redis-cli"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> ${JSON.stringify(zurnalas)}`,
        'if [[ "$*" == *"--scan"* ]]; then',
        /**
         * ⚠️ PERTRAUKIAMAS GEDIMAS. `pirmasScanKrenta` atkuria būtent tą atvejį,
         * dėl kurio radinys egzistuoja: PIRMAS `scan` krenta, VĖLESNIS pavyksta.
         * Jei kristų abu, senoji forma nutrūktų ties antruoju ir atrodytų saugi.
         */
        `  if [ "${pirmasScanKrenta ? 1 : 0}" = "1" ] && [ ! -f ${JSON.stringify(path.join(darbinis, "scan.marker"))} ]; then`,
        `    touch ${JSON.stringify(path.join(darbinis, "scan.marker"))}`,
        "    exit 1",
        "  fi",
        // ⚠️ `%b`, ne `%s`: bash dvigubose kabutėse `\n` yra PAŽODINIS.
        `  printf '%b' ${JSON.stringify(scan)}`,
        `  exit ${scanKodas}`,
        "fi",
        'if [[ "$*" == *"HMGET"* ]]; then',
        `  printf '%b' ${JSON.stringify(hmget)}`,
        `  exit ${hmgetKodas}`,
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );

    const skriptas = path.join(darbinis, "blokas.sh");
    fs.writeFileSync(skriptas, istrauktiBloka(), "utf8");

    let kodas = 0;
    try {
      execFileSync("bash", [skriptas], {
        env: {
          ...process.env,
          PATH: `${darbinis}:${process.env.PATH}`,
          REDIS_URL: "redis://testas:6379/0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      kodas = e.status === undefined ? 1 : e.status;
    }

    const kvietimai = fs.existsSync(zurnalas) ? fs.readFileSync(zurnalas, "utf8") : "";
    return { kodas, kvietimai, arTrine: /\bDEL\b/.test(kvietimai) };
  } finally {
    fs.rmSync(darbinis, { recursive: true, force: true });
  }
}

test("5b: nepavykęs `--scan` NUTRAUKIA — `DEL` nepasiekiamas", () => {
  /**
   * ⚠️ ŠIS SCENARIJUS IR BUVO #342 RADINYS.
   *
   * Kai `scan` ėjo proceso pakaitoje (`done < <(rc --scan …)`), jo gedimas
   * apimančio shell'o statuso nekeisdavo: ciklas perskaitydavo nieko, `laukia`
   * likdavo tuščias, patikra „praeidavo", o vėlesnis `DEL` ištrindavo viską.
   */
  const r = paleisti({ scan: "", scanKodas: 1 });

  assert.notEqual(r.kodas, 0, "nepavykęs `scan` privalo nutraukti bloką");
  assert.equal(r.arTrine, false, `\`DEL\` NEGALI būti pasiektas:\n${r.kvietimai}`);
});

test("5b: PIRMAS `scan` krenta, VĖLESNIS pavyksta — `DEL` NEPASIEKIAMAS", () => {
  /**
   * ⚠️ TIKSLUS #342 RADINIO SCENARIJUS, IR VIENINTELIS, KURIS SKIRIA DVI FORMAS.
   *
   * Jei krenta ABU `scan`'ai, senoji forma nutrūksta ties antruoju (pipeline +
   * `pipefail`) ir atrodo saugi. Yda matoma tik tada, kai gedimas PERTRAUKIAMAS:
   *
   *   senoji forma: pirmas `scan` proceso pakaitoje krenta TYLIAI → ciklas
   *                 perskaito nieko → `laukia` tuščias → patikra „praeina" →
   *                 antras `scan` pavyksta → `DEL` ištrina VISKĄ, nors laukiantis
   *                 valymas nebuvo patikrintas nė karto;
   *
   *   naujoji:      pirmas `scan` gaudomas `if ! raktai=$(…)` → nutraukiama.
   */
  const r = paleisti({ scan: "job:a\n", pirmasScanKrenta: true, hmget: "true\n\n" });

  assert.notEqual(r.kodas, 0, "pirmo `scan` gedimas privalo nutraukti bloką");
  assert.equal(
    r.arTrine,
    false,
    `\`DEL\` NEGALI būti pasiektas po nepatikrintos būsenos:\n${r.kvietimai}`
  );
});

test("5b: nepavykęs `HMGET` NUTRAUKIA — nelaikomas „nėra laukiančio valymo\"", () => {
  /**
   * `if rc HMGET … | grep -qx true` paslėpdavo `HMGET` gedimą: `set -e` `if`
   * sąlygoje nutildytas, o `grep`, nieko neradęs, duoda tą patį rezultatą kaip
   * „raktas švarus". Ryšiui nutrūkus vidury ciklo blokas tęsdavo į `DEL`.
   */
  const r = paleisti({ scan: "job:a\n", hmget: "", hmgetKodas: 1 });

  assert.notEqual(r.kodas, 0, "nepavykęs `HMGET` privalo nutraukti bloką");
  assert.equal(r.arTrine, false, `\`DEL\` NEGALI būti pasiektas:\n${r.kvietimai}`);
});

test("5b: rastas laukiantis valymas NUTRAUKIA — tai #338 scenarijus", () => {
  /** Pirmoji yda: patikra pranešdavo ir tęsdavo. Ji privalo likti uždaryta. */
  const r = paleisti({ scan: "job:a\njob:b\n", hmget: "true\n\n" });

  assert.notEqual(r.kodas, 0, "laukiantis valymas privalo nutraukti bloką");
  assert.equal(r.arTrine, false, `\`DEL\` NEGALI būti pasiektas:\n${r.kvietimai}`);
});

test("5b: švari bazė — `DEL` įvyksta IR indeksui, ne tik hash'ams", () => {
  /**
   * ⚠️ PRIEŠINGA KRYPTIS. Be jos „viskas nutraukiama" praeitų kaip sėkmė, ir
   * procedūra, kuri niekada nieko neištrina, atrodytų teisinga.
   *
   * `jobs:index` tikrinamas atskirai: šablonas `job:*` jo NEATITINKA (nėra
   * dvitaškio po `job`), ir būtent to praleidimo 6 žingsnio patikra nepagautų.
   */
  const r = paleisti({ scan: "job:a\njob:b\n", hmget: "\n\n" });

  assert.equal(r.kodas, 0, `švari bazė privalo praeiti:\n${r.kvietimai}`);
  assert.ok(r.arTrine, "hash'ai privalo būti ištrinti");
  assert.match(r.kvietimai, /DEL jobs:index/, "indeksas privalo būti ištrintas ATSKIRAI");
});

test("5b: be `REDIS_URL` blokas atsisako dirbti", () => {
  /**
   * `redis-cli` be `-u` rodo į 127.0.0.1:6379 DB 0 — Compose diegime tai NE TA
   * instancija. Blogiausias derinys: patikra praneša „švaru", o duomenys liko
   * kitur.
   */
  const darbinis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-cutover-"));

  try {
    const skriptas = path.join(darbinis, "blokas.sh");
    fs.writeFileSync(skriptas, istrauktiBloka(), "utf8");

    const env = { ...process.env };
    delete env.REDIS_URL;

    assert.throws(
      () => execFileSync("bash", [skriptas], { env, stdio: ["ignore", "pipe", "pipe"] }),
      /REDIS_URL/,
      "be `REDIS_URL` blokas privalo nutrūkti su aiškia priežastimi"
    );
  } finally {
    fs.rmSync(darbinis, { recursive: true, force: true });
  }
});
