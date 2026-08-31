const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * CI workflow struktūros patikra.
 *
 * ⚠️ KODĖL ŠIS TESTAS EGZISTUOJA.
 *
 * Pridedant PostgreSQL žingsnį, `run: npm run test:redis` nuslinko į kitą
 * step'ą. Rezultatas: Redis step'as liko BE `run` (nieko nevykdė), o Postgres
 * step'as gavo DU `run` raktus — YAML pasilieka paskutinį, tad
 * `npm run test:postgres` NIEKADA nebūtų paleistas.
 *
 * Abu žingsniai būtų likę žali. Įprastas parsinimas to nepagauna: YAML 1.2
 * dublikuotus raktus DRAUDŽIA, bet `js-yaml` ir PyYAML numatytai jų neatmeta —
 * tyliai pasilieka paskutinę reikšmę. Todėl tikrinama TEKSTU, ne parseriu.
 */

const CI = path.resolve(__dirname, "..", "..", ".github", "workflows");

function workflowFailai() {
  return fs
    .readdirSync(CI)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(CI, f));
}

test("CI: nė viename workflow nėra DUBLIUOTŲ raktų tame pačiame bloke", () => {
  /**
   * Parsinama tekstu, ne YAML biblioteka: būtent parseris ir yra tas, kuris
   * dublikatą praryja. Lyginami raktai vienodo įtraukos lygio bloke, kol jį
   * nutraukia mažesnė įtrauka arba naujas sąrašo elementas (`- `).
   */
  const problemos = [];

  for (const failas of workflowFailai()) {
    const eilutės = fs.readFileSync(failas, "utf8").split("\n");
    /** įtrauka → paskutinio bloko raktai */
    const blokai = new Map();

    eilutės.forEach((eilutė, i) => {
      if (!eilutė.trim() || eilutė.trim().startsWith("#")) return;

      const įtrauka = eilutė.length - eilutė.trimStart().length;

      // Naujas sąrašo elementas pradeda naują bloką šiame lygyje ir giliau.
      const naujasElementas = /^\s*- /.test(eilutė);
      for (const lygis of [...blokai.keys()]) {
        if (lygis > įtrauka || (naujasElementas && lygis >= įtrauka)) blokai.delete(lygis);
      }

      const m = /^\s*(?:- )?([A-Za-z_][\w.-]*):(\s|$)/.exec(eilutė);
      if (!m) return;

      // `- name:` pradeda naują elementą, tad raktai skaičiuojami nuo jo.
      const raktoĮtrauka = naujasElementas ? įtrauka + 2 : įtrauka;
      if (!blokai.has(raktoĮtrauka)) blokai.set(raktoĮtrauka, new Map());

      const bloke = blokai.get(raktoĮtrauka);
      if (bloke.has(m[1])) {
        problemos.push(
          `${path.basename(failas)}:${i + 1} raktas "${m[1]}" jau buvo eilutėje ${bloke.get(m[1])}`
        );
      }
      bloke.set(m[1], i + 1);
    });
  }

  assert.deepEqual(problemos, [], `Dubliuoti YAML raktai:\n  ${problemos.join("\n  ")}`);
});

test("CI: kiekvienas įvardytas step'as turi `run` arba `uses`", () => {
  /**
   * Step'as be abiejų nieko nedaro, bet job'as lieka žalias — tiksliai tai,
   * kas nutiko Redis žingsniui.
   */
  const problemos = [];

  for (const failas of workflowFailai()) {
    const eilutės = fs.readFileSync(failas, "utf8").split("\n");

    /**
     * ⚠️ `steps:` blokai, ne bet koks `- name:`.
     *
     * `strategy.matrix.include` įrašai irgi turi `- name:`, bet `run`/`uses`
     * jiems netaikomi. Tikrinama tik tai, kas realiai yra po `steps:`.
     */
    const stepsBlokai = [];
    eilutės.forEach((e, i) => {
      const m = /^(\s*)steps:\s*$/.exec(e);
      if (m) stepsBlokai.push({ nuo: i, įtrauka: m[1].length });
    });

    function stepsBloke(eilNr, įtrauka) {
      return stepsBlokai.some((b) => {
        if (eilNr <= b.nuo || įtrauka <= b.įtrauka) return false;
        // Blokas baigiasi ties pirma eilute su įtrauka <= steps: lygio.
        for (let j = b.nuo + 1; j < eilNr; j += 1) {
          const e = eilutės[j];
          if (!e.trim() || e.trim().startsWith("#")) continue;
          if (e.length - e.trimStart().length <= b.įtrauka) return false;
        }
        return true;
      });
    }

    eilutės.forEach((eilutė, i) => {
      const m = /^(\s*)- name: (.+)$/.exec(eilutė);
      if (!m) return;
      if (!stepsBloke(i, m[1].length)) return;

      const įtrauka = m[1].length;
      let turi = false;

      for (let j = i + 1; j < eilutės.length; j += 1) {
        const kita = eilutės[j];
        if (!kita.trim()) continue;

        const kitosĮtrauka = kita.length - kita.trimStart().length;
        // Kitas elementas arba mažesnė įtrauka = step'o pabaiga.
        if (kitosĮtrauka <= įtrauka) break;

        if (/^\s*(run|uses):/.test(kita)) {
          turi = true;
          break;
        }
      }

      if (!turi) {
        problemos.push(`${path.basename(failas)}:${i + 1} step'as "${m[2]}" be run/uses`);
      }
    });
  }

  assert.deepEqual(problemos, [], `Step'ai, kurie nieko nevykdo:\n  ${problemos.join("\n  ")}`);
});

test("CI: kiekvienas `docker compose config` žingsnis turi PRIVALOMUS kintamuosius", () => {
  /**
   * ⚠️ REALI KLAIDA, KURIĄ TAI PAGAVO (#155, 7.1).
   *
   * `docker-compose.gpu.yml` naudoja `${POSTGRES_PASSWORD:?...}` — be
   * numatytosios reikšmės, kad tuščias slaptažodis niekada nepatektų į
   * produkciją. Pasekmė: net `docker compose config` be jo KRINTA.
   *
   * `compose-config-validate` job'as jo nenustatė, ir visas job'as krito CI'e.
   *
   * Tikrinama tekstu, nes klausimas yra apie workflow struktūrą: ar žingsnis,
   * kviečiantis compose, turi tai, ko compose reikalauja.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..", "..");

  /** Kintamieji be numatytosios reikšmės visuose compose failuose. */
  const privalomi = new Set();
  for (const failas of fs.readdirSync(šaknis).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))) {
    const turinys = fs.readFileSync(path.join(šaknis, failas), "utf8");
    for (const m of turinys.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)) privalomi.add(m[1]);
  }

  assert.ok(privalomi.size > 0, "prielaida: bent vienas `:?` kintamasis egzistuoja");

  const ci = fs.readFileSync(path.join(šaknis, ".github", "workflows", "ci.yml"), "utf8");
  const eilutės = ci.split("\n");
  const problemos = [];

  eilutės.forEach((eilutė, i) => {
    if (!/docker compose .*config/.test(eilutė)) return;

    /** Step'o blokas: atgal iki `- name:`, pirmyn iki kito `- name:`. */
    let nuo = i;
    while (nuo > 0 && !/^\s*- name:/.test(eilutės[nuo])) nuo -= 1;
    let iki = i;
    while (iki < eilutės.length - 1 && !/^\s*- name:/.test(eilutės[iki + 1])) iki += 1;

    const blokas = eilutės.slice(nuo, iki + 1).join("\n");
    const vardas = (/- name: (.+)/.exec(eilutės[nuo]) || [, `eil. ${i + 1}`])[1];

    for (const kintamasis of privalomi) {
      if (!blokas.includes(kintamasis)) {
        problemos.push(`"${vardas}" kviečia compose, bet neturi ${kintamasis}`);
      }
    }
  });

  assert.deepEqual(problemos, [], `Compose žingsniai be privalomų kintamųjų:\n  ${problemos.join("\n  ")}`);
});

test("DOKUMENTACIJA: sprendimų įrašai (ADR) egzistuoja ir nuorodos galioja", () => {
  /**
   * ⚠️ REALI KLAIDA, KURIĄ TAI PAGAVO.
   *
   * Generuojant ADR pataisą buvo daromas `rm -rf docs/decisions` — o tame
   * kataloge yra SEKAMI failai (#158 stabilios tapatybės ADR ir indeksas).
   * Kito paketo `git add -A` tą trynimą užfiksavo, ir 7.1 pataisa būtų
   * pašalinusi galiojantį sprendimų įrašą kartu su nuoroda iš
   * `docs/auth-deployment.md`.
   *
   * Tikrinama, kad katalogas nebūtų tuščias ir kad kiekviena `docs/decisions/`
   * nuoroda rodytų į esantį failą.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..", "..");
  const katalogas = path.join(šaknis, "docs", "decisions");

  assert.ok(fs.existsSync(katalogas), "docs/decisions/ katalogas privalo egzistuoti");

  const įrašai = fs.readdirSync(katalogas).filter((f) => f.endsWith(".md"));
  assert.ok(įrašai.length > 0, "docs/decisions/ neturi būti tuščias");
  assert.ok(
    įrašai.some((f) => /^\d{4}-/.test(f)),
    "bent vienas numeruotas ADR (0001-...) privalo likti"
  );

  /** Nuorodos iš viso `docs/` ir README. */
  const problemos = [];
  /**
   * ⚠️ NE TIK `README.md` IR `docs/*.md`.
   *
   * Pirmoji šio sargo versija skenavo tik juos, tad nutrūkusi nuoroda
   * `.env.example` faile praėjo nepastebėta — o būtent ten vartotojas ją
   * pamato pirmiausia. Skenuojami VISI failai, kuriuose realiai gali atsirasti
   * `docs/decisions/` nuoroda.
   */
  const failai = [
    path.join(šaknis, "README.md"),
    path.join(šaknis, ".env.example"),
    ...fs
      .readdirSync(šaknis)
      .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
      .map((f) => path.join(šaknis, f)),
    ...fs
      .readdirSync(path.join(šaknis, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(šaknis, "docs", f)),
  ].filter((f) => fs.existsSync(f));

  for (const failas of failai) {
    const turinys = fs.readFileSync(failas, "utf8");
    for (const m of turinys.matchAll(/docs\/decisions\/([\w.-]+\.md)/g)) {
      if (!fs.existsSync(path.join(katalogas, m[1]))) {
        problemos.push(`${path.basename(failas)} rodo į nesantį docs/decisions/${m[1]}`);
      }
    }
  }

  assert.deepEqual(problemos, [], `Nutrūkusios ADR nuorodos:\n  ${problemos.join("\n  ")}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * #202 `REQUIRE_*` SARGAI CI'e
 * ══════════════════════════════════════════════════════════════════════════ */

/** `backend` job'o tekstas - nuo jo antraštės iki kito job'o. */
function backendJob() {
  const ci = fs.readFileSync(path.join(CI, "ci.yml"), "utf8");
  return ci.slice(ci.indexOf("\n  backend:"), ci.indexOf("\n  frontend:"));
}

/** Job'o žingsniai atskirai: `      - ` yra žingsnio pradžios įtrauka. */
function zingsniai(jobas) {
  return jobas.split(/\n      - /).slice(1);
}

test("CI: kiekvienas `REQUIRE_*` sargas nustatytas TAME žingsnyje, kurį jis gina", () => {
  /**
   * ⚠️ VĖLIAVA, KURIOS NIEKAS NETIKRINA, YRA VĖLIAVA, KURIĄ GALIMA PAŠALINTI.
   *
   * Trys sargai (`REQUIRE_REDIS` #15, `REQUIRE_POSTGRES` #155/7.1,
   * `REQUIRE_PYTHON` #202) egzistuoja tam, kad tylus praleidimas taptų klaida.
   * Iki #202 nė vieno netikrino niekas: pašalinus eilutę iš `ci.yml`, visi
   * testai liktų žali, o CI grįžtų prie tos pačios spragos.
   *
   * ⚠️ TIKRINAMA ŽINGSNIO APIMTIMI, NE VISO FAILO TEKSTE.
   *
   * Pirmoji šio testo versija sujungdavo visus workflow failus ir ieškojo
   * žetono bet kur. Tai reiškė, kad `REQUIRE_PYTHON: "1"`, perkelta į visiškai
   * nesusijusį `frontend` job'ą, testą palikdavo ŽALIĄ - nors ten ji negina
   * nieko. „Yra kažkur" nėra įrodymas, kad „veikia ten, kur reikia".
   *
   * Todėl vėliava siejama su KOMANDA: ji privalo būti tame pačiame žingsnyje,
   * kuris paleidžia jos ginamą rinkinį.
   */
  const SARGAI = [
    { vėliava: "REQUIRE_REDIS", komanda: "npm run test:redis", issue: "#15" },
    { vėliava: "REQUIRE_POSTGRES", komanda: "npm run test:postgres", issue: "#155, 7.1" },
    { vėliava: "REQUIRE_PYTHON", komanda: "npm run test:functional", issue: "#202" },
  ];

  const žingsniai = zingsniai(backendJob());

  const pažeidimai = SARGAI.filter(({ vėliava, komanda }) => {
    const vėliavosŠablonas = new RegExp(`${vėliava}:\\s*["']?1["']?`);

    return !žingsniai.some((z) => z.includes(komanda) && vėliavosŠablonas.test(z));
  });

  assert.deepEqual(
    pažeidimai.map((s) => `${s.vėliava} (${s.issue}) → ${s.komanda}`),
    [],
    "sargas privalo būti TAME žingsnyje, kurį gina - kitame job'e jis nieko nedaro"
  );
});

test("CI: `backend` job'as paruošia Python EKSPLICITIŠKAI, ne per runner'io prielaidą", () => {
  /**
   * ⚠️ `REQUIRE_PYTHON=1` BE `setup-python` PAVERSTŲ CI RAUDONU.
   *
   * Abi pusės būtinos ir viena be kitos yra klaida: vėliava be Python paruošimo
   * duotų nuolat krentantį job'ą, o Python paruošimas be vėliavos grąžintų
   * tylų praleidimą. Todėl tikrinamos KARTU.
   *
   * Versija lyginama su kitais job'ais: trečia Python versija repo be
   * priežasties neįvedama (#202).
   */
  const ciTekstas = fs.readFileSync(path.join(CI, "ci.yml"), "utf8");

  const backendJob = ciTekstas.slice(
    ciTekstas.indexOf("\n  backend:"),
    ciTekstas.indexOf("\n  frontend:")
  );

  assert.ok(
    /uses:\s*actions\/setup-python/.test(backendJob),
    "`backend` job'as privalo turėti `actions/setup-python` - kitaip `REQUIRE_PYTHON=1` remiasi runner'io image prielaida"
  );

  const versijos = [...ciTekstas.matchAll(/python-version:\s*["']?([\d.]+)["']?/g)].map(
    (m) => m[1]
  );

  assert.ok(versijos.length >= 2, "tikimasi kelių `setup-python` naudojimų");
  assert.equal(
    new Set(versijos).size,
    1,
    `visi job'ai turi naudoti TĄ PAČIĄ Python versiją, rasta: ${[...new Set(versijos)].join(", ")}`
  );
});
