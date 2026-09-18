/**
 * MATRICOS EILUČIŲ PATIKRA (#197).
 *
 * ⚠️ KĄ ŠI PATIKRA GAUDO IR KO NEGAUDO — SKAITYTI PRIEŠ PASITIKINT.
 *
 *   GAUDO:    rašybos klaidas testo varde ir eilutes, rodančias į IŠTRINTĄ
 *             testų failą; tuščią mutacijų stulpelį.
 *
 *   NEGAUDO:  eilutės, rodančios į EGZISTUOJANTĮ failą, kuriame to konkretaus
 *             testo NĖRA. Tai G5 klasė — būtent tokia buvo #197 rasta spraga:
 *             eilutė „Pavykus įrašymui atsarginis skaitiklis išvalomas" rodė į
 *             `deletionRetryPersistence`, failą, kuris egzistuoja, o testo
 *             jame nebuvo. Ši patikra tokią eilutę praleidžia.
 *
 * ⚠️ TODĖL JI TIKRINA EILUTĖS FORMĄ, NE TURINĮ. Matricos eilutę gina tik
 * PATIKRINTA mutacija; visa kita gina jos formą. Žr. `docs/security-test-matrix.md`
 * mutacijų stulpelį ir #197 ataskaitą.
 *
 * ── Kodėl atpažįstama pagal antraštę, o ne pagal `^|` ──────────────────────
 *
 * Tame pačiame faile yra ir kitokių dviejų stulpelių lentelių (CI nuorodos,
 * limitų sąrašai). Skenuojant visas `|` eilutes, jos duotų dešimtis „tuščių
 * mutacijų stulpelių", kurių niekas netaiso — ir patikra taptų triukšmu.
 *
 * ── Kodėl imamas TIK pirmas kiekvieno `·` segmento vardas ──────────────────
 *
 * Griežtesnis variantas (kiekvienas backtick antrame stulpelyje) buvo
 * išbandytas ir duoda KLAIDINGUS TEIGINIUS. Trys atskiros priežastys, visos
 * patikrintos prieš esamą matricą:
 *
 *   1. Antrame stulpelyje kabutėse rašomi ir kodo identifikatoriai
 *      patikslinimuose: `` `deletionEnforcement` (`_runInline` su procesoriumi) ``
 *      — `_runInline` nėra testų failas.
 *   2. Skaidant pagal kablelį, sakinio vidurio kablelis („abi pusės: praleidžia
 *      žymėtą, kartoja nežymėtą") padaro pirmu vardu atsitiktinį žodį.
 *   3. Testai gyvena trijuose kataloguose su trimis priesagomis; praleidus bent
 *      vieną (`frontend/src/utils.test.js` yra `.test.js`, ne `.test.jsx`),
 *      septynios teisingos eilutės pasirodo kaip pažeidimai.
 *
 * Kaina: kableliu atskirtos ANTROS nuorodos netikrinamos. Geriau nepatikrinti,
 * nei pranešti melagingą pažeidimą — patikra, kurios išvestį įprasta ignoruoti,
 * negina nieko.
 *
 * Paleidimas: `npm run test:matrix-rows` · savipatikra: `--self-test`.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const MATRIX = join(repoRoot, "docs", "security-test-matrix.md");

const ANTRASTE = /^\|\s*Garantija\s*\|\s*Testai\s*\|\s*Mutacijos įrodymas\s*\|\s*$/;
const SKIRTUKAS = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*$/;
const NEZINOMA = /\[PG NOT RUN\]|\[PG CI\]/;

const KATALOGAI = [
  { dir: join("backend", "tests"), pried: ".test.js" },
  { dir: join("frontend", "src"), pried: ".test.jsx" },
  { dir: join("frontend", "src"), pried: ".test.js" },
  { dir: join("frontend", "e2e"), pried: ".spec.js" },
  /**
   * ⚠️ STATINIAI SARGAI YRA TEISĖTAS ĮRODYMO TAIKINYS.
   *
   * Dalis garantijų remiasi ne testu, o tripwire'u (`AGENTS.md` §9.2). Jie
   * gyvena `backend/scripts/`, tad eilutė, rodanti į tokį skriptą, nėra
   * pažeidimas - kitaip patikra pažymėtų pati save.
   */
  { dir: join("backend", "scripts"), pried: ".mjs" },
];

function surinktiTestus() {
  const rinkinys = new Set();

  for (const { dir, pried } of KATALOGAI) {
    const kelias = join(repoRoot, dir);
    if (!existsSync(kelias)) continue;

    for (const f of readdirSync(kelias)) {
      if (!f.endsWith(pried)) continue;
      rinkinys.add(f);
      rinkinys.add(f.slice(0, -pried.length));
      rinkinys.add(`${dir.replace(/\\/g, "/")}/${f}`);
    }
  }

  return rinkinys;
}

/** Ar tai apskritai panašu į failo vardą, o ne į kodo identifikatorių sakinyje? */
function panasuIFaila(v) {
  if (!v || /\s|=|\(|\)|\\|\//.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  if (/^[A-Z0-9_]+$/.test(v)) return false;
  if (v.startsWith("#") || v.startsWith("_")) return false;
  return true;
}

/** Grąžina `{ nesami, tuscios, lentelių, eilučių }`. */
export function tikrinti(tekstas, testai) {
  const eilutes = tekstas.split("\n");

  let lentelėje = false;
  let lentelių = 0;
  let eilučių = 0;
  const nesami = [];
  const tuscios = [];

  for (let i = 0; i < eilutes.length; i += 1) {
    const e = eilutes[i];

    if (ANTRASTE.test(e)) {
      lentelėje = true;
      lentelių += 1;
      continue;
    }
    if (!lentelėje) continue;
    if (SKIRTUKAS.test(e)) continue;
    if (!e.trimStart().startsWith("|")) {
      lentelėje = false;
      continue;
    }

    const st = e.split("|").slice(1, -1);
    if (st.length < 3) continue;

    eilučių += 1;
    const garantija = st[0].replace(/\*\*/g, "").trim();
    const stulpelisTestai = st[1].trim();
    const mutacija = st.slice(2).join("|").trim();

    for (const segmentas of stulpelisTestai.split("·")) {
      const m = segmentas.match(/`([^`]+)`/);
      if (!m) continue;

      const vardas = m[1].trim();
      if (!panasuIFaila(vardas)) continue;
      if (testai.has(vardas)) continue;

      nesami.push({ eil: i + 1, vardas, garantija: garantija.slice(0, 70) });
    }

    if (!mutacija && !NEZINOMA.test(stulpelisTestai)) {
      tuscios.push({ eil: i + 1, garantija: garantija.slice(0, 70) });
    }
  }

  return { nesami, tuscios, lentelių, eilučių };
}

/**
 * SAVIPATIKRA.
 *
 * ⚠️ Ta pati priežastis kaip `erasure_marks` SQL tripwire: patikra, kuri
 * niekada nieko nerado, neatskiriama nuo patikros, kuri neveikia. Tikrinamos
 * ABI pusės — kad pažeidimą randa IR kad teisingos eilutės jo neduoda.
 */
function savipatikra() {
  const testai = new Set(["esamasTestas"]);

  const bloga = [
    "| Garantija | Testai | Mutacijos įrodymas |",
    "|---|---|---|",
    "| Sugalvota garantija | `nesamasTestas` | mutacija |",
  ].join("\n");

  const gera = [
    "| Garantija | Testai | Mutacijos įrodymas |",
    "|---|---|---|",
    "| Tikra garantija | `esamasTestas` (patikslinimas) | mutacija |",
  ].join("\n");

  const tuscia = [
    "| Garantija | Testai | Mutacijos įrodymas |",
    "|---|---|---|",
    "| Be mutacijos | `esamasTestas` |  |",
  ].join("\n");

  /** Kita lentelė TAME PAČIAME faile - jos taisyklė neliečia. */
  const svetima = ["| Žingsnis | Trukmė |", "|---|---|", "| `kažkas` | 24 s |"].join("\n");

  const klaidos = [];
  const r1 = tikrinti(bloga, testai);
  if (r1.nesami.length !== 1) klaidos.push("nesamas testas NEBUVO aptiktas");

  const r2 = tikrinti(gera, testai);
  if (r2.nesami.length !== 0) klaidos.push("teisinga eilutė pažymėta pažeidimu");

  const r3 = tikrinti(tuscia, testai);
  if (r3.tuscios.length !== 1) klaidos.push("tuščias mutacijų stulpelis NEBUVO aptiktas");

  const r4 = tikrinti(svetima, testai);
  if (r4.eilučių !== 0) klaidos.push("svetima lentelė neturi būti tikrinama");

  if (klaidos.length) {
    console.error("SAVIPATIKRA NEPAVYKO:\n  - " + klaidos.join("\n  - "));
    process.exit(1);
  }

  console.log("Savipatikra: detektorius randa pažeidimą, neduoda klaidingo teigiamo ir nelipa į svetimas lenteles.");
}

savipatikra();

if (process.argv.includes("--self-test")) process.exit(0);

if (!existsSync(MATRIX)) {
  console.error(`Nėra ${MATRIX}.`);
  process.exit(1);
}

const testai = surinktiTestus();
const { nesami, tuscios, lentelių, eilučių } = tikrinti(readFileSync(MATRIX, "utf8"), testai);

console.log(`Garantijų lentelių: ${lentelių} · eilučių jose: ${eilučių}`);

if (!nesami.length && !tuscios.length) {
  console.log("Matricos eilutės: visi minimi testų failai egzistuoja, mutacijų stulpelis užpildytas.");
  console.log("⚠️  Tai eilutės FORMOS patikra. Ji NEGAUDO eilutės, rodančios į esamą failą BE to testo (G5 klasė).");
  process.exit(0);
}

for (const n of nesami) {
  console.error(`:${n.eil}  rodo į nesamą testų failą \`${n.vardas}\`  ← ${n.garantija}`);
}
for (const t of tuscios) {
  console.error(`:${t.eil}  tuščias mutacijų stulpelis  ← ${t.garantija}`);
}

console.error(
  "\nEilutė be įrodymo yra dengimo teiginys, kurio niekas nepatikrino - " +
    "peržiūrėtojas ja pasitiki VIETOJ to, kad pats išvestų įrodymą."
);
process.exit(1);
