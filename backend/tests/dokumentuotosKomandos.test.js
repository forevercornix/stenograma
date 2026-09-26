const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * DOKUMENTUOTA KOMANDA PRIVALO TURĖTI EGZISTUOJANTĮ TAIKINĮ (#410, D1/D2/D4).
 *
 * ⚠️ KODĖL ŠIS SARGAS EGZISTUOJA, NORS ŠIANDIEN RANDA 0 PAŽEIDIMŲ.
 *
 * #405 (PR #408) rasta, kad `docs/plans/157-implementation-plan.md` dokumentavo
 * `docker compose -f docker-compose.minio.yml up -d && … npm run test:s3`, o tokio
 * failo repo NIEKADA neturėjo (0 commit'ų visoje istorijoje). Komanda neveikė ne
 * nuo tada, kai dingo MinIO atvaizdas, o nuo parašymo: `docker compose` būtų kritęs,
 * o `&&` antrosios dalies nė nepaleidęs.
 *
 * Tai dokumentuotas patikros kelias BE NĖ VIENO VARTOTOJO. Toks gedimas tylus pagal
 * konstrukciją: neegzistuojanti komanda ir praleistas rinkinys abu baigiasi sėkme.
 *
 * ⚠️ SARGAS PREVENCINIS, NE KOREKCINIS, IR TAI UŽRAŠOMA. Išmatuota (#410 §0.1):
 * 99 komandų minėjimai 43 dokumentuose, o gyvų instrukcijų su dingusiais taikiniais
 * ŠIANDIEN NĖRA. Vertė yra regresijos gaudymas, ne esamų radinių taisymas — ir
 * teigti kitaip reikštų tą patį per didelį teiginį, kurį sargas gaudo (§12.1).
 *
 * ⚠️ AIBĖ IŠVEDAMA IŠ DOKUMENTŲ TEKSTO. Rankinis „tikrinamų komandų" sąrašas gintų
 * tik tas komandas, kurias kas nors atsiminė įrašyti — t. y. praleistų būtent naują
 * dokumentą, dėl kurio sargas ir reikalingas.
 */

const SAKNIS = path.join(__dirname, "..", "..");

/* ══════════════════════════════════════════════════════════════════════════
 * AUTORITETO RIBA
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ ISTORIJA ATSKIRIAMA SEGMENTO, NE RINKMENOS LYGIU (#410 §0.2).
 *
 * ADR 155 (`docs/decisions/155-postgres-authority.md:1109–1113`) jau išmatavo, kad
 * kategorinis failų atmetimas („planiniai dokumentai, jų teiginiai istoriniai")
 * peržiūroje sugriūva, ir nustatė: sprendimas „šis teiginys istorinis" priimamas
 * EILUTEI, ne rinkmenai. Filtras, teisingas 27 kartus iš 29, tyliai paslėpė likusius.
 *
 * Žyma — perbraukimas `~~…~~`: jis jau yra repo žodyne ir reiškia „nebegalioja".
 * Svarbiausia — jį MATO IR ŽMOGUS: nematoma metažyma reikštų, kad skaitytojas ir
 * sargas mato skirtingus dokumentus.
 *
 * ⚠️ PRALEIDŽIAMAS TIK IŠBRAUKTAS SEGMENTAS, NE EILUTĖ AR LĄSTELĖ. Motyvuojantis
 * atvejis (`157-implementation-plan.md:1853`) turi GYVĄ komandą ir ISTORINĘ citatą
 * TOJE PAČIOJE lentelės ląstelėje. Ląstelės lygio sprendimas nustotų tikrinti gyvą
 * instrukciją — tai būtų spraga, ne tikslumas.
 *
 * ⚠️ `~~` SEMANTIKA REPO PERKRAUTA: `README` roadmap'e jis reiškia „padaryta"
 * (`- [x] ~~Tikras OOXML eksportas~~`). Todėl praleidimų skaičius SPAUSDINAMAS —
 * tyliai augantis praleidimų skaičius būtų būdas sargą išjungti nieko nekeičiant.
 */
function isbrauktiRuozai(eil) {
  const ruozai = [];
  const re = /~~([\s\S]*?)~~/g;
  let m;
  while ((m = re.exec(eil)) !== null) ruozai.push([m.index, m.index + m[0].length]);
  return ruozai;
}

const ruozeYra = (ruozai, i) => ruozai.some(([a, b]) => i >= a && i < b);

/* ══════════════════════════════════════════════════════════════════════════
 * KOMANDŲ IŠTRAUKIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ TIKRINAMI IR ```` ```bash ```` BLOKAI, IR INLINE KODAS (#410, atviras kl. 1).
 *
 * Išmatuota: 49 minėjimai blokuose, 50 inline. Motyvuojantis atvejis yra INLINE
 * lentelės ląstelėje, tad „tik blokai" praleistų būtent jį; o „bet koks inline" be
 * segmento žymos kristų ant istorinės citatos. Todėl abu, su segmento sprendimu.
 */
const SABLONAI = [
  { tipas: "docker-compose", re: /-f\s+([A-Za-z0-9._/-]*compose[A-Za-z0-9._/-]*\.ya?ml)/g },
  { tipas: "node-script", re: /node\s+((?:backend\/|frontend\/)?scripts\/[A-Za-z0-9._/-]+)/g },
  { tipas: "npm-run", re: /npm\s+run\s+([A-Za-z0-9:_-]+)/g },
  { tipas: "sh", re: /(?:^|[\s`(])(\.\/[A-Za-z0-9._/-]+\.sh|scripts\/[A-Za-z0-9._/-]+\.sh)/g },
];

/**
 * @param {Array<{kelias: string, tekstas: string}>} dokumentai
 * @param {{yra: (p: string) => boolean, npmTaikiniai: Set<string>}} aplinka
 */
function surinkti(dokumentai, aplinka) {
  const radiniai = [];
  let praleistaSegmentu = 0;

  for (const { kelias, tekstas } of dokumentai) {
    const eilutes = tekstas.split("\n");
    let cdBaze = null;

    for (let i = 0; i < eilutes.length; i += 1) {
      const eil = eilutes[i];

      /** `cd <katalogas>` dokumente keičia išrišimo bazę (D1). */
      const cd = /\bcd\s+([A-Za-z0-9._/-]+)/.exec(eil);
      if (cd) cdBaze = cd[1].replace(/^\.\//, "");

      const ruozai = isbrauktiRuozai(eil);

      for (const { tipas, re } of SABLONAI) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(eil)) !== null) {
          const taikinysIndeksas = m.index + m[0].indexOf(m[1]);

          if (ruozeYra(ruozai, taikinysIndeksas)) {
            praleistaSegmentu += 1;
            continue;
          }

          radiniai.push({
            kelias,
            eilute: i + 1,
            tipas,
            taikinys: m[1],
            ...isristi(tipas, m[1], cdBaze, aplinka),
          });
        }
      }
    }
  }

  return { radiniai, praleistaSegmentu };
}

/** D1 išrišimo taisyklės. ⚠️ Šakninio `package.json` repo NĖRA — išmatuota. */
function isristi(tipas, taikinys, cdBaze, { yra, npmTaikiniai }) {
  if (tipas === "npm-run") {
    return {
      egzistuoja: npmTaikiniai.has(taikinys),
      kandidatai: "backend/package.json | frontend/package.json",
    };
  }

  const grynas = taikinys.replace(/^\.\//, "");
  const kandidatai =
    tipas === "node-script" && !/^(backend|frontend)\//.test(grynas)
      ? [`backend/${grynas}`, grynas, ...(cdBaze ? [`${cdBaze}/${grynas}`] : [])]
      : [grynas, ...(cdBaze ? [`${cdBaze}/${grynas}`] : [])];

  const rastas = kandidatai.find(yra);
  return { egzistuoja: Boolean(rastas), kandidatai: rastas || kandidatai.join(" | ") };
}

const pazeidimai = (radiniai) => radiniai.filter((r) => !r.egzistuoja);

/* ══════════════════════════════════════════════════════════════════════════
 * TIKROJI APLINKA
 * ══════════════════════════════════════════════════════════════════════════ */

function repoAplinka() {
  const skriptai = (p) =>
    Object.keys(JSON.parse(fs.readFileSync(path.join(SAKNIS, p), "utf8")).scripts || {});

  return {
    yra: (p) => fs.existsSync(path.join(SAKNIS, p)),
    npmTaikiniai: new Set([
      ...skriptai("backend/package.json"),
      ...skriptai("frontend/package.json"),
    ]),
  };
}

function repoDokumentai() {
  const sarasas = execFileSync("git", ["ls-files", "*.md"], { cwd: SAKNIS, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.ok(sarasas.length > 10, `dokumentų rasta per mažai (${sarasas.length}) - paieška sugedo`);

  return sarasas.map((kelias) => ({
    kelias,
    tekstas: fs.readFileSync(path.join(SAKNIS, kelias), "utf8"),
  }));
}

/* ══════════════════════════════════════════════════════════════════════════
 * TESTAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("D1: kiekviena dokumentuota komanda turi EGZISTUOJANTĮ taikinį", () => {
  const { radiniai, praleistaSegmentu } = surinkti(repoDokumentai(), repoAplinka());

  console.log(
    `[#410] komandų: ${radiniai.length} · praleista išbrauktų segmentų: ${praleistaSegmentu}`
  );

  const blogi = pazeidimai(radiniai);
  assert.deepEqual(
    blogi.map((r) => `${r.kelias}:${r.eilute} [${r.tipas}] ${r.taikinys} → ${r.kandidatai}`),
    [],
    "dokumentuota komanda rodo į neegzistuojantį taikinį"
  );
});

/**
 * ⚠️ SARGAS, KURIS NIEKO NERANDA, GALI BŪTI IR SUGEDĘS. Be šio testo tuščias
 * pažeidimų sąrašas reikštų arba švarų repo, arba sulūžusį parserį — o skirti jų
 * būtų neįmanoma.
 */
test("SARGAS NĖRA TUŠČIAS: aibė tikrai išvesta iš teksto", () => {
  const { radiniai } = surinkti(repoDokumentai(), repoAplinka());

  assert.ok(radiniai.length > 50, `rasta per mažai komandų: ${radiniai.length}`);
  for (const t of ["npm-run", "node-script", "docker-compose", "sh"]) {
    assert.ok(
      radiniai.some((r) => r.tipas === t),
      `nerasta nė vienos \`${t}\` komandos - šablonas sugedęs`
    );
  }
});

test("⚠️ `~~` praleidimų skaičius MATOMAS ir šiandien yra tikslus", () => {
  const { praleistaSegmentu } = surinkti(repoDokumentai(), repoAplinka());

  /**
   * ⚠️ TIKSLUS SKAIČIUS, NE „≥ 0". `~~` repo reiškia ir „padaryta" (README
   * roadmap'as), tad perkrauta semantika gali tyliai praryti gyvą komandą.
   * Skaičiaus pokytis privalo būti SĄMONINGAS redagavimas, ne fonas.
   */
  assert.equal(
    praleistaSegmentu,
    1,
    "pasikeitė išbrauktų komandų skaičius - patikrinkite, ar `~~` neprarijo gyvos instrukcijos"
  );
});

/* ── SAVIPATIKROS (D4) ─────────────────────────────────────────────────── */

const APLINKA = {
  yra: (p) => p === "yra.sh" || p === "backend/scripts/yra.mjs",
  npmTaikiniai: new Set(["test", "lint"]),
};

const dok = (tekstas) => [{ kelias: "sinteze.md", tekstas }];

test("SAVIPATIKRA: įterptas pažeidimas randamas (1), švari būsena — 0", () => {
  const svarus = dok("Paleisti: `./yra.sh`\n");
  assert.equal(pazeidimai(surinkti(svarus, APLINKA).radiniai).length, 0);

  const sugadintas = dok("Paleisti: `./yra.sh`\nIr dar: `./nera.sh`\n");
  const blogi = pazeidimai(surinkti(sugadintas, APLINKA).radiniai);
  assert.equal(blogi.length, 1);
  assert.equal(blogi[0].taikinys, "./nera.sh");
  assert.equal(blogi[0].eilute, 2);
});

test("SAVIPATIKRA (M2 forma): `npm run` taikinys, kurio nėra nė viename `package.json`", () => {
  assert.equal(pazeidimai(surinkti(dok("`npm run test`"), APLINKA).radiniai).length, 0);

  const blogi = pazeidimai(surinkti(dok("`npm run nera-tokio`"), APLINKA).radiniai);
  assert.equal(blogi.length, 1);
  assert.match(blogi[0].kandidatai, /backend\/package\.json \| frontend\/package\.json/);
});

/**
 * ⚠️ TAS PATS ATVEJIS, KAIP `157-implementation-plan.md:1853`: gyva komanda ir
 * istorinė citata VIENOJE ląstelėje. Jei sprendimas būtų priimamas ląstelei ar
 * eilutei, gyva instrukcija nustotų būti tikrinama — sargas taptų tylesnis būtent
 * ten, kur problema buvo rasta.
 */
test("SEGMENTO LYGIS: vienoje ląstelėje gyva komanda TIKRINAMA, išbraukta PRALEISTA", () => {
  const lastele =
    "| `S3` | Reikia saugyklos | `npm run nera-tokio` ⚠️ *anksčiau rodė ~~`./nera.sh`~~* |\n";

  const { radiniai, praleistaSegmentu } = surinkti(dok(lastele), APLINKA);

  assert.equal(praleistaSegmentu, 1, "išbraukta komanda privalo būti praleista");
  assert.equal(radiniai.length, 1, "gyva komanda privalo likti tikrinama");
  assert.equal(radiniai[0].taikinys, "nera-tokio");
  assert.equal(pazeidimai(radiniai).length, 1, "gyvos komandos pažeidimas privalo likti matomas");
});

test("KONTROLĖ: išbraukta komanda su GERU taikiniu irgi tik praleidžiama, ne skaičiuojama", () => {
  const { radiniai, praleistaSegmentu } = surinkti(dok("~~`./yra.sh`~~"), APLINKA);

  assert.equal(praleistaSegmentu, 1);
  assert.equal(radiniai.length, 0);
});

test("D1: `cd <katalogas>` dokumente keičia išrišimo bazę", () => {
  const aplinka = { yra: (p) => p === "pakatalogis/vietinis.sh", npmTaikiniai: new Set() };

  assert.equal(pazeidimai(surinkti(dok("`./vietinis.sh`"), aplinka).radiniai).length, 1);
  assert.equal(
    pazeidimai(surinkti(dok("```bash\ncd pakatalogis\n./vietinis.sh\n```"), aplinka).radiniai).length,
    0
  );
});

test("D1: `node scripts/X` išrišamas ir į `backend/scripts/`, ir į šaknies `scripts/`", () => {
  const aplinka = { yra: (p) => p === "backend/scripts/yra.mjs" || p === "scripts/saknis.mjs", npmTaikiniai: new Set() };

  assert.equal(pazeidimai(surinkti(dok("`node scripts/yra.mjs`"), aplinka).radiniai).length, 0);
  assert.equal(pazeidimai(surinkti(dok("`node scripts/saknis.mjs`"), aplinka).radiniai).length, 0);
  assert.equal(pazeidimai(surinkti(dok("`node scripts/nera.mjs`"), aplinka).radiniai).length, 1);
});
