#!/usr/bin/env node
/**
 * IŠTRINTŲ TESTŲ SARGAS (#237).
 *
 * ⚠️ KODĖL JIS EGZISTUOJA.
 *
 * Uždarant #213 per platus pakeitimo intervalas redagavimo skripte TYLIAI
 * pašalino tris integracinius testus iš `auditPersistence.integration.test.js`.
 * Visos patikros liko žalios. Pagavo nenaudojamo importo lint klaida - t. y.
 * SĖKMĖ, ne sistema: ištrinti testai atsitiktinai buvo vieninteliai
 * `auditoPoolNustatymai` vartotojai.
 *
 * `verifyManifest()` (`scripts/run-tests.mjs`) gina FAILO lygį: dingęs failas
 * krinta iš abiejų pusių. Testo lygį negynė niekas. Žalia suitė su 11 testų
 * vietoj 13 atrodo lygiai taip pat, kaip žalia suitė su 13.
 *
 * ── KĄ ŠIS SARGAS DARO ────────────────────────────────────────────────────
 *
 * Lygina DEKLARUOTŲ testų IDENTITETUS tarp tikros PR bazės (`git merge-base`)
 * ir head'o. Dingęs identitetas be eksplicitinio override sulaužo CI.
 *
 * ── KO ŠIS SARGAS NEDARO (skaityti PRIEŠ pasitikint) ──────────────────────
 *
 *   NETIKRINA asertų kokybės. Testas, paverstas į `assert.ok(true)`,
 *   identitetą išsaugo ir šiam sargui atrodo nepakitęs.
 *
 *   NETIKRINA padengimo. Jokių slenksčių, jokių metrikų.
 *
 *   ⚠️ NETIKRINA SCENARIJŲ MASYVŲ NARYSTĖS. `auditStoreBackendContract.integration`
 *   generuoja 27 parity scenarijus iš masyvo VIENAME `test()` kvietime.
 *   Pašalinus masyvo elementą, deklaruotų `test()` blokų aibė NEPAKINTA, ir šis
 *   sargas to NEPAMATYS. Tai sąmoninga #237 riba: bendras parametrizuotų testų
 *   formų parseris yra kitos apimties uždavinys, o bandymas jį įsprausti čia
 *   rizikuotų visu sargu. Dalinį dengimą duoda tik `neatpažintų deklaracijų`
 *   skaitiklis - jis pagauna dingusį KVIETIMĄ, bet ne dingusį masyvo ELEMENTĄ.
 *
 *   NEDARO fuzzy pervadinimo spėjimo. Pavadinimo pakeitimas = šalinimas +
 *   pridėjimas.
 *
 *   NEAUDITUOJA istorijos. Gina tik būsimus PR.
 *
 * ── SKENUOJAMŲ KELIŲ AIBĖ (eksplicitiškai; #237 reikalavimas) ─────────────
 *
 * Aibė imama iš `git ls-files` / `git ls-tree`, tad `.gitignore` gerbiamas
 * pagal konstrukciją. Klasifikacija - `grupuoti()` funkcijoje žemiau:
 *
 *   node --test   ·  backend/     ... *.test.js|jsx|ts|tsx|mjs|cjs, *.spec.*
 *   Vitest        ·  frontend/    ... *.test.js|jsx|ts|tsx|mjs|cjs, *.spec.*
 *   Playwright    ·  frontend/e2e ... *.spec.js|jsx|ts|tsx
 *   pytest        ·  bet kur      ... test_*.py, *_test.py
 *
 * ⚠️ REKURSYVIAI. `frontend/src/api/stenogramaApi.test.js` gyvena POKATALOGYJE;
 * nerekursyvus skenavimas jį praleistų - būtent tokia buvo #197 spraga
 * (`frontend/src/utils.test.js` praleistas, nes indeksuota tik `.test.jsx`, ir
 * visas `frontend/e2e/` praleistas). `check-matrix-rows.mjs` tą apribojimą
 * tebeturi - žr. jo `KATALOGAI` (`readdirSync` be rekursijos). Ten jis kol kas
 * nekenkia, nes nė viena matricos eilutė į pokatalogio failą nerodo; bet tai
 * galioja tik tol, kol taip yra. Čia jis kartojamas SĄMONINGAI nebuvo.
 *
 * `.ts`/`.tsx` įtraukti, nors šiandien tokių failų NĖRA (0) - kad TypeScript
 * pridėjimas ateityje neiškristų iš sargo tyliai.
 *
 * Sargas VISADA praneša, kiek failų indeksavo kiekvienoje grupėje. Tylus
 * dalinis skenavimas yra tas pats defektas, kurį šis sargas ir taiso.
 *
 * ── KODĖL NENAUDOJAMAS `beKomentaru()` ────────────────────────────────────
 *
 * Jis registruotas kaip žinomas defektas (`rizika10`): blokinius komentarus
 * šalina reguliariuoju reiškiniu, tad `/*` eilutės literale nuryja kodą.
 * Vienuoliktas vartotojas apsunkintų jo pašalinimą, o sargas gautų TYLIĄ
 * gedimo kryptį būtent ten, kur jo ir reikia. Repozitorijoje tokenizatoriaus
 * nėra, tad čia parašytas MINIMALUS - tik tiek, kiek šiam sargui reikia.
 *
 * ── PALEIDIMAS ────────────────────────────────────────────────────────────
 *
 *   node backend/scripts/check-deleted-tests.mjs                # PR CI
 *   node backend/scripts/check-deleted-tests.mjs --base origin/main
 *   node backend/scripts/check-deleted-tests.mjs --self-test    # tik savipatikra
 *
 * Išėjimo kodai:  0 - gerai arba override;  1 - testai pašalinti;
 *                 2 - sargas negali dirbti (fail-closed).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const NUMATYTAS_REPO = join(here, "..", "..");

export const OVERRIDE_ZYME = "TESTŲ ŠALINIMAS:";

/* ══════════════════════════════════════════════════════════════════════════
 * 1. FAILŲ KLASIFIKACIJA
 * ══════════════════════════════════════════════════════════════════════════ */

const JS_TESTAS = /\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs)$/;
const PY_TESTAS = /(?:^|\/)test_[^/]*\.py$|_test\.py$/;

/**
 * Grąžina `{ grupe, kalba }` arba `null`.
 *
 * ⚠️ NĖRA „nežinomo katalogo" skylės. Bet kuris `*.test.js` BET KUR repo yra
 * indeksuojamas; katalogas lemia tik grupės VARDĄ ataskaitoje. Priešingas
 * variantas (katalogų allow-list'as) reikštų, kad naujas testų katalogas tyliai
 * lieka už sargo - o tai #197 klaida.
 */
export function grupuoti(kelias) {
  const p = String(kelias).replace(/\\/g, "/");

  if (PY_TESTAS.test(p)) {
    if (p.startsWith("pyannote-server/")) return { grupe: "pytest · pyannote-server", kalba: "py" };
    if (p.startsWith("whisper-server/")) return { grupe: "pytest · whisper-server", kalba: "py" };
    return { grupe: "pytest · kita", kalba: "py" };
  }

  if (!JS_TESTAS.test(p)) return null;

  if (p.startsWith("frontend/e2e/")) return { grupe: "Playwright · frontend/e2e", kalba: "js" };
  if (p.startsWith("frontend/")) return { grupe: "Vitest · frontend", kalba: "js" };
  if (p.startsWith("backend/")) return { grupe: "node --test · backend", kalba: "js" };
  return { grupe: "kita (JS)", kalba: "js" };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. MINIMALUS JS LEKSERIS
 *
 * ⚠️ REGEX LITERALŲ TVARKYMAS YRA BŪTINAS, NE PERTEKLIUS.
 *
 * Repozitorijoje realiai yra (startupChecks.test.js):
 *     /process\.on\(["']SIGTERM["']/.test(serverSource)
 * Lekseris be regex būsenos ties tuo `"` atidarytų „eilutę" ir
 * DESINCHRONIZUOTŲSI visam likusiam failui - t. y. duotų tylią, pasitikinčią,
 * neteisingą išvestį. Būtent to šis sargas ir vengia.
 *
 * ⚠️ ŽINOMA RIBA: `/` po `)`, `]` ar `}` laikoma DALYBA. Forma
 * `if (a) /re/.test(b)` (be riestinių skliaustų) būtų išanalizuota neteisingai.
 * Repozitorijoje tokios formos nėra; atsiradusi ji duotų arba klaidą (garsią),
 * arba praleistą deklaraciją - todėl veikia ir kryžminė patikra su žaliu
 * eilutiniu šablonu žemiau.
 * ══════════════════════════════════════════════════════════════════════════ */

const EKRANAI = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** Po šių žodžių `/` yra regex pradžia, ne dalyba. */
const REGEX_PO_ZODZIO = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

const TARPAS_NE_EILUTE = /[^\S\n]/;
/**
 * ⚠️ NE-ASCII IDENTIFIKATORIAI BŪTINI.
 *
 * Repozitorijos kodas rašomas lietuviškai (`žingsniai`, `pažeidimai`,
 * `vėliava`). Be `\\u0080-\\uFFFF` diapazono tokie vardai suskiltų į `punc`
 * žetonus, o tai iškreiptų regex/dalybos euristiką kaip tik ten, kur ji
 * jautriausia.
 */
const IDENT_PRADZIA = /[A-Za-z_$\u0080-\uFFFF]/;
const IDENT_TESINYS = /[A-Za-z0-9_$\u0080-\uFFFF]/;

function ekranuotas(src, j) {
  const c = src[j + 1];
  if (c === undefined) return { simbolis: "", pabaiga: j + 1 };
  if (c === "\n") return { simbolis: "", pabaiga: j + 2 };

  if (c === "u") {
    if (src[j + 2] === "{") {
      const e = src.indexOf("}", j + 3);
      if (e === -1) return { simbolis: "u", pabaiga: j + 2 };
      const kodas = Number.parseInt(src.slice(j + 3, e), 16);
      return { simbolis: Number.isNaN(kodas) ? "" : String.fromCodePoint(kodas), pabaiga: e + 1 };
    }
    const kodas = Number.parseInt(src.slice(j + 2, j + 6), 16);
    return { simbolis: Number.isNaN(kodas) ? "u" : String.fromCharCode(kodas), pabaiga: j + 6 };
  }

  if (c === "x") {
    const kodas = Number.parseInt(src.slice(j + 2, j + 4), 16);
    return { simbolis: Number.isNaN(kodas) ? "x" : String.fromCharCode(kodas), pabaiga: j + 4 };
  }

  return { simbolis: EKRANAI[c] ?? c, pabaiga: j + 2 };
}

function skaitytiEilute(src, i) {
  const kabute = src[i];
  let j = i + 1;
  let reiksme = "";

  while (j < src.length) {
    const c = src[j];

    if (c === "\\") {
      const e = ekranuotas(src, j);
      reiksme += e.simbolis;
      j = e.pabaiga;
      continue;
    }
    if (c === kabute) return { reiksme, pabaiga: j + 1 };
    if (c === "\n") return { klaida: "neuždarytas eilutės literalas" };

    reiksme += c;
    j += 1;
  }

  return { klaida: "neuždarytas eilutės literalas" };
}

function skaitytiRegex(src, i) {
  let j = i + 1;
  let klaseje = false;

  while (j < src.length) {
    const c = src[j];

    if (c === "\\") { j += 2; continue; }
    if (c === "[") klaseje = true;
    else if (c === "]") klaseje = false;
    else if (c === "/" && !klaseje) {
      j += 1;
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      return { pabaiga: j };
    } else if (c === "\n") return { klaida: "neuždarytas regex literalas" };

    j += 1;
  }

  return { klaida: "neuždarytas regex literalas" };
}

/**
 * Praleidžia `${ ... }` interpoliaciją iki ATITINKAMO `}`.
 *
 * Viduje gerbiami komentarai, eilučių literalai, įdėti šablonai ir regex -
 * kitaip `${x.replace(/["']/g, "")}` sulaužytų sekimą.
 */
function praleistiInterpoliacija(src, i) {
  let gylis = 0;
  let j = i;
  let pries = null;

  while (j < src.length) {
    const c = src[j];

    if (c === "/" && src[j + 1] === "/") {
      while (j < src.length && src[j] !== "\n") j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const e = src.indexOf("*/", j + 2);
      if (e === -1) return -1;
      j = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const r = skaitytiEilute(src, j);
      if (r.klaida) return -1;
      j = r.pabaiga;
      pries = "s";
      continue;
    }
    if (c === "`") {
      const r = skaitytiSablona(src, j);
      if (r.klaida) return -1;
      j = r.pabaiga;
      pries = "s";
      continue;
    }
    if (c === "/" && (pries === null || !/[A-Za-z0-9_$)\]}]/.test(pries))) {
      const r = skaitytiRegex(src, j);
      if (r.klaida) return -1;
      j = r.pabaiga;
      pries = "r";
      continue;
    }
    if (c === "{") { gylis += 1; j += 1; pries = "{"; continue; }
    if (c === "}") {
      if (gylis === 0) return j + 1;
      gylis -= 1;
      j += 1;
      pries = "}";
      continue;
    }

    if (!/\s/.test(c)) pries = c;
    j += 1;
  }

  return -1;
}

function skaitytiSablona(src, i) {
  let j = i + 1;
  let reiksme = "";
  let dinamine = false;

  while (j < src.length) {
    const c = src[j];

    if (c === "\\") {
      const e = ekranuotas(src, j);
      reiksme += e.simbolis;
      j = e.pabaiga;
      continue;
    }
    if (c === "`") return { reiksme, dinamine, pabaiga: j + 1 };
    if (c === "$" && src[j + 1] === "{") {
      dinamine = true;
      const k = praleistiInterpoliacija(src, j + 2);
      if (k === -1) return { klaida: "neuždaryta `${` interpoliacija šablone" };
      j = k;
      continue;
    }

    reiksme += c;
    j += 1;
  }

  return { klaida: "neuždarytas šablono literalas" };
}

/**
 * Grąžina `{ zetonai }` arba `{ klaida }`.
 *
 * Žetonas: `{ tipas: "ident"|"num"|"str"|"regex"|"punc", reiksme, eil, dinamine }`.
 */
export function zetonuoti(src) {
  const zet = [];
  let i = 0;
  let eil = 1;

  const arRegexPozicija = () => {
    const p = zet[zet.length - 1];
    if (!p) return true;
    if (p.tipas === "ident") return REGEX_PO_ZODZIO.has(p.reiksme);
    if (p.tipas === "num" || p.tipas === "str" || p.tipas === "regex") return false;
    return !(p.reiksme === ")" || p.reiksme === "]" || p.reiksme === "}");
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "\n") { eil += 1; i += 1; continue; }
    if (TARPAS_NE_EILUTE.test(c)) { i += 1; continue; }

    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e === -1) return { klaida: `neuždarytas blokinis komentaras (eil. ${eil})` };
      for (let k = i; k < e; k += 1) if (src[k] === "\n") eil += 1;
      i = e + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const r = skaitytiEilute(src, i);
      if (r.klaida) return { klaida: `${r.klaida} (eil. ${eil})` };
      zet.push({ tipas: "str", reiksme: r.reiksme, dinamine: false, eil });
      i = r.pabaiga;
      continue;
    }

    if (c === "`") {
      const pradzia = eil;
      const r = skaitytiSablona(src, i);
      if (r.klaida) return { klaida: `${r.klaida} (eil. ${eil})` };
      for (let k = i; k < r.pabaiga; k += 1) if (src[k] === "\n") eil += 1;
      zet.push({ tipas: "str", reiksme: r.reiksme, dinamine: r.dinamine, eil: pradzia });
      i = r.pabaiga;
      continue;
    }

    if (c === "/" && arRegexPozicija()) {
      const r = skaitytiRegex(src, i);
      if (r.klaida) return { klaida: `${r.klaida} (eil. ${eil})` };
      zet.push({ tipas: "regex", reiksme: "", eil });
      i = r.pabaiga;
      continue;
    }

    if (IDENT_PRADZIA.test(c)) {
      let j = i;
      while (j < src.length && IDENT_TESINYS.test(src[j])) j += 1;
      zet.push({ tipas: "ident", reiksme: src.slice(i, j), eil });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObBn._]/.test(src[j])) j += 1;
      zet.push({ tipas: "num", reiksme: src.slice(i, j), eil });
      i = j;
      continue;
    }

    zet.push({ tipas: "punc", reiksme: c, eil });
    i += 1;
  }

  return { zetonai: zet };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. DEKLARACIJŲ IŠTRAUKIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

const DEKLARATORIAI = new Set(["test", "it"]);

/**
 * ⚠️ ALLOW-LIST, NE „bet kokia priesaga".
 *
 * `frontend/e2e/*.spec.js` naudoja `test.describe(...)` - tai GRUPĖ, ne testas.
 * Priėmus bet kokią priesagą, kiekvienas `describe` virstų „testu", o jo
 * pervadinimas - klaidingu pašalinimu.
 *
 * ⚠️ PRIESAGOS SKIRSTOMOS Į DVI RŪŠIS.
 *
 *   `.only`  - testas VYKDOMAS, identitetas išlieka.
 *   `.skip`  - testas NEVYKDOMAS. #237: „konvertavimas į `test.skip(...)`
 *              praranda garantiją lygiai taip pat kaip trynimas, ir peržiūroje
 *              yra SUNKIAU pastebimas". Todėl identitetas DINGSTA.
 *   `.todo`  - taip pat nevykdomas (`node:test` jį rodo kaip TODO), tad ta pati
 *              taisyklė. Repozitorijoje šiandien nė vieno nėra.
 */
const PRIESAGOS = new Set(["skip", "only", "todo"]);
const PRIESAGOS_NEVYKDOMOS = new Set(["skip", "todo"]);

/** Žalias eilutinis šablonas - naudojamas TIK kryžminei patikrai. */
const ZALIAS_JS = /^[ \t]*(?:test|it)(?:\.(?:skip|only|todo))?[ \t]*\(/gm;
const ZALIAS_PY = /^[ \t]*(?:async[ \t]+)?def[ \t]+test_/gm;

function zaliasKiekis(src, sablonas) {
  sablonas.lastIndex = 0;
  let n = 0;
  while (sablonas.exec(src) !== null) n += 1;
  return n;
}

/**
 * `{ deklaracijos: [{ identitetas, eil }], neatpazinti }` arba `{ klaida }`.
 *
 * `neatpazinti` - deklaracijos, kurių pavadinimas sudaromas VYKDYMO METU
 * (šablonas su `${}`) arba apskritai nėra literalas. Jos NEIŠMETAMOS tyliai.
 */
export function skenuotiJs(src) {
  const { zetonai: zet, klaida } = zetonuoti(src);
  if (klaida) return { klaida };

  const deklaracijos = [];
  let neatpazinti = 0;
  let nevykdomos = 0;

  for (let k = 0; k < zet.length; k += 1) {
    const z = zet[k];
    if (z.tipas !== "ident" || !DEKLARATORIAI.has(z.reiksme)) continue;

    /** `foo.test(...)` ir `/re/.test(...)` - NE deklaracijos. */
    const pries = zet[k - 1];
    if (pries && pries.tipas === "punc" && pries.reiksme === ".") continue;

    let j = k + 1;
    let nevykdoma = false;

    if (zet[j] && zet[j].tipas === "punc" && zet[j].reiksme === ".") {
      const priesaga = zet[j + 1];
      if (!priesaga || priesaga.tipas !== "ident" || !PRIESAGOS.has(priesaga.reiksme)) continue;
      nevykdoma = PRIESAGOS_NEVYKDOMOS.has(priesaga.reiksme);
      j += 2;
    }

    if (!zet[j] || zet[j].tipas !== "punc" || zet[j].reiksme !== "(") continue;

    /**
     * ⚠️ `test.skip` / `test.todo` NEDIDINA nei `deklaracijos`, nei
     * `neatpazinti` - identiteto nebėra, ir tai yra visas taškas. Skaičiuojama
     * atskirai TIK tam, kad kryžminė patikra žemiau neapsigautų.
     */
    if (nevykdoma) { nevykdomos += 1; continue; }

    const arg = zet[j + 1];
    if (arg && arg.tipas === "str" && !arg.dinamine) {
      deklaracijos.push({ identitetas: `js:${arg.reiksme}`, eil: z.eil });
    } else {
      neatpazinti += 1;
    }
  }

  /**
   * ⚠️ KRYŽMINĖ PATIKRA - FAIL-CLOSED.
   *
   * Tyliai indeksuoti nulį iš failo, kuriame testų akivaizdžiai yra, yra ta
   * pati defektų klasė kaip pats #237. Žalias šablonas naudojamas TIK kaip
   * antra nuomonė; jis gali duoti daugiau (pvz. `test(` šablono literalo
   * viduje), tad lyginama tik su nuliu.
   */
  if (
    deklaracijos.length === 0 &&
    neatpazinti === 0 &&
    nevykdomos === 0 &&
    zaliasKiekis(src, ZALIAS_JS) > 0
  ) {
    return {
      klaida:
        "lekseris neindeksavo nė vienos deklaracijos, nors žalias eilutinis šablonas jų randa",
    };
  }

  return { deklaracijos, neatpazinti };
}

/**
 * Python: `def test_*(`. Forma paprastesnė nei JS, bet docstring'ai privalo
 * būti nuimti - `"""def test_x(): ..."""` NĖRA deklaracija.
 *
 * Literalai keičiami TARPAIS, o ne šalinami: eilučių numeriai turi išlikti.
 */
export function skenuotiPy(src) {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === "#") {
      while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }

    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const kabutes = src.slice(i, i + 3);
      const e = src.indexOf(kabutes, i + 3);
      if (e === -1) return { klaida: "neuždarytas trigubų kabučių literalas" };
      for (let k = i; k < e + 3; k += 1) out += src[k] === "\n" ? "\n" : " ";
      i = e + 3;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      out += " ";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { out += "  "; j += 2; continue; }
        if (src[j] === "\n") return { klaida: "neuždarytas eilutės literalas" };
        out += " ";
        j += 1;
      }
      if (j >= src.length) return { klaida: "neuždarytas eilutės literalas" };
      out += " ";
      i = j + 1;
      continue;
    }

    out += c;
    i += 1;
  }

  const deklaracijos = [];
  const eilutes = out.split("\n");

  for (let n = 0; n < eilutes.length; n += 1) {
    const m = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test_\w*)[ \t]*\(/.exec(eilutes[n]);
    if (m) deklaracijos.push({ identitetas: `py:${m[1]}`, eil: n + 1 });
  }

  if (deklaracijos.length === 0 && zaliasKiekis(src, ZALIAS_PY) > 0) {
    return {
      klaida: "skeneris neindeksavo nė vienos `def test_*` deklaracijos, nors žalias šablonas jų randa",
    };
  }

  return { deklaracijos, neatpazinti: 0 };
}

export function skenuoti(kelias, src) {
  const g = grupuoti(kelias);
  if (!g) return { deklaracijos: [], neatpazinti: 0 };
  return g.kalba === "py" ? skenuotiPy(src) : skenuotiJs(src);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. INDEKSAVIMAS IR PALYGINIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `failai` - `Map<kelias, turinys>`.
 *
 * Grąžina `{ kiekiai, saltiniai, neatpazintiPerFaila, neatpazintiViso,
 *            grupes, klaidos }`.
 */
export function indeksuoti(failai) {
  const kiekiai = new Map();
  const saltiniai = new Map();
  const neatpazintiPerFaila = new Map();
  const grupes = new Map();
  const klaidos = [];
  let neatpazintiViso = 0;

  for (const kelias of [...failai.keys()].sort()) {
    const g = grupuoti(kelias);
    if (!g) continue;

    grupes.set(g.grupe, (grupes.get(g.grupe) ?? 0) + 1);

    const r = skenuoti(kelias, failai.get(kelias));
    if (r.klaida) {
      klaidos.push(`${kelias}: ${r.klaida}`);
      continue;
    }

    for (const d of r.deklaracijos) {
      kiekiai.set(d.identitetas, (kiekiai.get(d.identitetas) ?? 0) + 1);
      if (!saltiniai.has(d.identitetas)) saltiniai.set(d.identitetas, new Set());
      saltiniai.get(d.identitetas).add(kelias);
    }

    if (r.neatpazinti > 0) {
      neatpazintiPerFaila.set(kelias, r.neatpazinti);
      neatpazintiViso += r.neatpazinti;
    }
  }

  return { kiekiai, saltiniai, neatpazintiPerFaila, neatpazintiViso, grupes, klaidos };
}

/**
 * GLOBALI MULTIAIBĖ, ne palyginimas per failą.
 *
 * ⚠️ KODĖL GLOBALI. Palyginimas per failą kiekvieną failo pervadinimą praneštų
 * kaip VISŲ jo testų ištrynimą. Kiekvienas rename PR reikalautų override, o
 * įprastai naudojamas override nieko nebegina - override nuovargis yra būdas,
 * kuriuo toks sargas miršta. Failai naudojami TIK ataskaitai.
 *
 * ⚠️ PRIIMTAS KOMPROMISAS. Du vienodo pavadinimo testai SKIRTINGUOSE failuose
 * gali užmaskuoti vieno pašalinimą. Priimta sąmoningai: alternatyva sulaužo
 * kiekvieną pervadinimą.
 */
export function palyginti(baze, head) {
  const pasalinti = [];
  const prideti = [];

  for (const [id, kiekis] of baze.kiekiai) {
    const dabar = head.kiekiai.get(id) ?? 0;
    if (dabar < kiekis) {
      pasalinti.push({
        identitetas: id,
        kiek: kiekis - dabar,
        bazesFailai: [...(baze.saltiniai.get(id) ?? [])].sort(),
      });
    }
  }

  for (const [id, kiekis] of head.kiekiai) {
    const anksciau = baze.kiekiai.get(id) ?? 0;
    if (kiekis > anksciau) prideti.push({ identitetas: id, kiek: kiekis - anksciau });
  }

  pasalinti.sort((a, b) => a.identitetas.localeCompare(b.identitetas));

  /**
   * NEATPAŽINTOS DEKLARACIJOS - ATSKIRA KLAIDOS RŪŠIS.
   *
   * ⚠️ NE tas pats, kas įvardytas pašalinimas, ir pranešimas privalo skirtis:
   * recenzentas, gavęs tokį patį tekstą, ieškos PAVADINIMO, kurio nėra - jis
   * sudaromas vykdymo metu.
   *
   * Palikus tai vien įspėjimu, sargas turėtų skylę būtent scenarijų failuose -
   * t. y. ten, kur #237 jau pripažįsta silpniausią vietą.
   *
   * Sprendimas dėl praėjimo - pagal GLOBALŲ skaičių (atsparu pervadinimams);
   * ataskaitai rodomas per-failo pjūvis.
   */
  const neatpazintuDelta = baze.neatpazintiViso - head.neatpazintiViso;
  const neatpazintiFailai = [];

  const visiFailai = new Set([
    ...baze.neatpazintiPerFaila.keys(),
    ...head.neatpazintiPerFaila.keys(),
  ]);

  for (const f of [...visiFailai].sort()) {
    const b = baze.neatpazintiPerFaila.get(f) ?? 0;
    const h = head.neatpazintiPerFaila.get(f) ?? 0;
    if (b !== h) neatpazintiFailai.push({ failas: f, baze: b, head: h });
  }

  return {
    pasalinti,
    prideti,
    neatpazintuDelta: Math.max(0, neatpazintuDelta),
    neatpazintiFailai,
    arPazeidimas: pasalinti.length > 0 || neatpazintuDelta > 0,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. OVERRIDE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ PRIEŽASTIS TURI BŪTI TURININGA, NE VIEN NETUŠČIA.
 *
 * Override, priimantis `TESTŲ ŠALINIMAS: ...`, sunaikina būtent tą
 * atskaitomybę, dėl kurios jis ir egzistuoja.
 */
export function tikrintiPriezasti(tekstas) {
  const p = String(tekstas ?? "").trim();

  if (p === "") return { tinka: false, kodel: "priežastis tuščia" };
  if (p === "<priežastis>" || p === "<priezastis>") {
    return { tinka: false, kodel: "palikta literalinė vietaženklio reikšmė `<priežastis>`" };
  }

  const prasmingi = [...p].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  if (prasmingi < 3) {
    return { tinka: false, kodel: `tik ${prasmingi} raidė(-ės)/skaitmuo - reikia bent 3` };
  }
  if (!/\p{L}/u.test(p)) return { tinka: false, kodel: "priežastyje nėra nė vienos raidės" };

  return { tinka: true, priezastis: p };
}

/** `commitai` - `[{ sha, zinute }]`. Grąžina pirmą GALIOJANTĮ override. */
export function rastiOverride(commitai) {
  const atmesti = [];

  for (const { sha, zinute } of commitai) {
    for (const e of String(zinute ?? "").split("\n")) {
      const idx = e.indexOf(OVERRIDE_ZYME);
      if (idx === -1) continue;

      const r = tikrintiPriezasti(e.slice(idx + OVERRIDE_ZYME.length));
      if (r.tinka) return { rastas: true, sha, priezastis: r.priezastis, atmesti };
      atmesti.push({ sha, kodel: r.kodel, eilute: e.trim() });
    }
  }

  return { rastas: false, atmesti };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. SAVIPATIKRA
 *
 * ⚠️ Ta pati priežastis kaip `check-matrix-rows.mjs` ir `erasure_marks` SQL
 * tripwire: patikra, kuri niekada nieko nerado, neatskiriama nuo patikros,
 * kuri neveikia.
 *
 * ⚠️ FIXTURES HERMETIŠKOS - jokio git, jokios failų sistemos, jokios
 * priklausomybės nuo hosto (#202 pamoka: ten sargo testai paveldėjo `python3`
 * iš mašinos ir krisdavo visur, kur jo nėra).
 * ══════════════════════════════════════════════════════════════════════════ */

function indeksasIs(irasai) {
  return indeksuoti(new Map(irasai));
}

export function savipatikra() {
  const klaidos = [];
  const tikrinti = (salyga, pranesimas) => { if (!salyga) klaidos.push(pranesimas); };

  const A = "backend/tests/a.test.js";
  const B = "backend/tests/b.test.js";

  const trysTestai = [
    'test("pirmas", () => {});',
    'test("antras", () => {});',
    'test("trecias", () => {});',
  ].join("\n");

  /* 1. Pašalinimas PRIVALO būti pagautas ir susietas su bazės failu. */
  {
    const r = palyginti(
      indeksasIs([[A, trysTestai]]),
      indeksasIs([[A, 'test("pirmas", () => {});\ntest("trecias", () => {});']])
    );
    tikrinti(
      r.pasalinti.length === 1 && r.pasalinti[0].identitetas === "js:antras",
      "1. pašalintas testas NEBUVO pagautas"
    );
    tikrinti(r.pasalinti[0]?.bazesFailai?.[0] === A, "1. pašalinimas nesusietas su bazės failu");
  }

  /* 2. Nepakitusi aibė NEGALI būti pažeidimas. */
  {
    const r = palyginti(indeksasIs([[A, trysTestai]]), indeksasIs([[A, trysTestai]]));
    tikrinti(!r.arPazeidimas, "2. nepakitusi aibė pažymėta pažeidimu");
  }

  /* 3. Failo pervadinimas / testo perkėlimas NĖRA masinis trynimas. */
  {
    const r = palyginti(indeksasIs([[A, trysTestai]]), indeksasIs([[B, trysTestai]]));
    tikrinti(!r.arPazeidimas, "3. failo pervadinimas duoda klaidingą masinį trynimą");
  }

  /* 4. `.skip` konversija = pašalinimas. */
  {
    const head = indeksasIs([
      [A, 'test("pirmas", () => {});\ntest.skip("antras", () => {});\ntest("trecias", () => {});'],
    ]);
    const r = palyginti(indeksasIs([[A, trysTestai]]), head);
    tikrinti(
      r.pasalinti.length === 1 && r.pasalinti[0].identitetas === "js:antras",
      "4. `.skip` konversija NEBUVO pagauta kaip pašalinimas"
    );
  }

  /* 5. Dublikatai nesuplakami (multiaibė, ne aibė). */
  {
    const baze = indeksasIs([[A, 'test("tas pats", () => {});'], [B, 'test("tas pats", () => {});']]);
    const head = indeksasIs([[A, 'test("tas pats", () => {});']]);
    const r = palyginti(baze, head);
    tikrinti(
      r.pasalinti.length === 1 && r.pasalinti[0].kiek === 1,
      "5. vienas iš dviejų vienodo pavadinimo testų dingo NEPASTEBĖTAS"
    );
  }

  /* 6. Override su turininga priežastimi - leidžiamas. */
  {
    const r = rastiOverride([
      { sha: "abc1234", zinute: `fix: kažkas\n\n${OVERRIDE_ZYME} testas dubliavo naują kontraktinį testą` },
    ]);
    tikrinti(r.rastas && /dubliavo/.test(r.priezastis), "6. galiojantis override nebuvo atpažintas");
  }

  /* 7. Override be turinio - ATMETAMAS (visos keturios formos). */
  {
    for (const bloga of ["", "   ", "...", "<priežastis>"]) {
      const r = rastiOverride([{ sha: "abc1234", zinute: `${OVERRIDE_ZYME} ${bloga}` }]);
      tikrinti(!r.rastas, `7. override su priežastimi "${bloga}" NETURI būti priimtas`);
    }
  }

  /* 8. Daugiaeilis kvietimas (pavadinimas kitoje eilutėje) - repo turi 25 tokius. */
  {
    const r = skenuotiJs('test(\n  "daugiaeilis pavadinimas",\n  { skip: false },\n  () => {}\n);');
    tikrinti(
      r.deklaracijos?.[0]?.identitetas === "js:daugiaeilis pavadinimas",
      "8. daugiaeilis kvietimas neišanalizuotas"
    );
  }

  /* 9. Ekranuota vidinė kabutė - repo turi 8 tokius. */
  {
    const r = skenuotiJs('test("turi \\"kabutes\\" viduje", () => {});');
    tikrinti(
      r.deklaracijos?.[0]?.identitetas === 'js:turi "kabutes" viduje',
      "9. ekranuota vidinė kabutė išanalizuota neteisingai"
    );
  }

  /* 10. Komentaras ir eilutės literalas NESKAIČIUOJAMI. */
  {
    const src = [
      '// test("uzkomentuotas", () => {});',
      '/* test("blokiniame komentare", () => {}); */',
      "const s = 'test(\"eilutes literale\", () => {});';",
      'test("tikras", () => {});',
    ].join("\n");
    const r = skenuotiJs(src);
    tikrinti(
      r.deklaracijos?.length === 1 && r.deklaracijos[0].identitetas === "js:tikras",
      `10. suskaičiuota ${r.deklaracijos?.length} vietoj 1 (komentaras ar literalas praslydo)`
    );
  }

  /* 11. `.test(` ir `test.describe(` NĖRA deklaracijos. */
  {
    const src = [
      "const ok = /process\\.on\\([\"']SIGTERM[\"']/.test(saltinis);",
      'test.describe("grupė", () => {',
      '  test("viduje", () => {});',
      "});",
    ].join("\n");
    const r = skenuotiJs(src);
    tikrinti(
      r.deklaracijos?.length === 1 && r.deklaracijos[0].identitetas === "js:viduje",
      `11. \`.test(\` arba \`test.describe(\` suskaičiuoti kaip testai (rasta ${r.deklaracijos?.length})`
    );
  }

  /* 12. Runtime sudarytas pavadinimas - NEATPAŽINTAS, ne tyliai numestas. */
  {
    const r = skenuotiJs("test(`KONTRAKTAS: ${adapteris.vardas} vykdo rinkinį`, () => {});");
    tikrinti(
      r.neatpazinti === 1 && r.deklaracijos.length === 0,
      "12. šablonu sudarytas pavadinimas nebuvo pažymėtas kaip neatpažintas"
    );
  }

  /* 13. Neatpažintų SUMAŽĖJIMAS yra pažeidimas (scenarijų failų skylė). */
  {
    const baze = indeksasIs([[A, "test(`a ${x}`, () => {});\ntest(`b ${y}`, () => {});"]]);
    const head = indeksasIs([[A, "test(`a ${x}`, () => {});"]]);
    const r = palyginti(baze, head);
    tikrinti(
      r.neatpazintuDelta === 1 && r.arPazeidimas,
      "13. dingusi neatpažinta deklaracija praslydo"
    );
    tikrinti(
      r.neatpazintiFailai.some((f) => f.failas === A && f.baze === 2 && f.head === 1),
      "13. neatpažintų pjūvis per failą neparodytas"
    );
  }

  /**
   * 14. TEISĖTAS ATVEJIS, ATRODANTIS TAIP PAT: šabloninis pavadinimas paverstas
   *     statiniu. Neatpažintų mažėja, o įvardytų daugėja tiek pat.
   *
   * ⚠️ Sargas VIS TIEK praneša - fail-closed, sprendimas paliekamas žmogui.
   * Fixture pina TIKSLIAI šitą elgesį, kad pirmas toks PR neatrodytų kaip
   * sargo gedimas: `prideti` privalo padengti `neatpazintuDelta`.
   */
  {
    const baze = indeksasIs([[A, "test(`X ${a}`, () => {});"]]);
    const head = indeksasIs([[A, 'test("X a", () => {});']]);
    const r = palyginti(baze, head);
    tikrinti(r.neatpazintuDelta === 1, "14. konversija į statinį pavadinimą neužfiksuota");
    tikrinti(r.pasalinti.length === 0, "14. konversija neteisingai pranešta kaip įvardytas trynimas");
    tikrinti(
      r.prideti.length === r.neatpazintuDelta,
      "14. pridėtų identitetų skaičius neatitinka - recenzentas negalės atskirti konversijos"
    );
  }

  /* 15. Python: `def test_*`, docstring'as ir komentaras neskaičiuojami. */
  {
    const src = [
      '"""',
      "def test_docstringe(): pass",
      '"""',
      "# def test_komentare(): pass",
      "def test_tikras(client):",
      "    assert True",
      "async def test_async(client):",
      "    assert True",
    ].join("\n");
    const r = skenuotiPy(src);
    tikrinti(
      r.deklaracijos?.length === 2 && r.deklaracijos[0].identitetas === "py:test_tikras",
      `15. Python skeneris rado ${r.deklaracijos?.length} vietoj 2`
    );
  }

  /* 16. Neišanalizuojamas failas - FAIL-CLOSED, ne tylus nulis. */
  {
    const r = skenuotiJs('test("nebaigtas", () => {});\n/* niekada neuždarytas komentaras');
    tikrinti(Boolean(r.klaida), "16. neuždarytas komentaras NEDAVĖ klaidos (fail-closed neveikia)");
  }

  if (klaidos.length > 0) {
    console.error("SAVIPATIKRA NEPAVYKO - sargas neleidžiamas prie repozitorijos:\n");
    for (const k of klaidos) console.error(`  - ${k}`);
    return false;
  }

  console.log(
    "Savipatikra: 16 scenarijų - trynimas randamas, nepakitusi aibė ir pervadinimas ne, " +
      "`.skip` gaudomas, dublikatai nesuplakami, override reikalauja priežasties, parseris atsparus."
  );
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. GIT SLUOKSNIS
 * ══════════════════════════════════════════════════════════════════════════ */

class SargoKlaida extends Error {}

function bandytiGit(repo, args) {
  try {
    return {
      ok: true,
      isvestis: execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    };
  } catch (e) {
    return { ok: false, klaida: String(e.stderr || e.message || "").trim() };
  }
}

/**
 * ⚠️ FAIL-CLOSED. Neišspręsta bazė NIEKADA nevirsta praėjimu.
 *
 * `git merge-base`, NE `HEAD^`: `HEAD^` yra ankstesnis PR commit'as, o ne šakos
 * atsišakojimo taškas - sargas tada matytų tik paskutinį commit'ą.
 */
function nustatytiBaze(repo, taikinys) {
  const r = bandytiGit(repo, ["merge-base", taikinys, "HEAD"]);
  if (!r.ok) {
    throw new SargoKlaida(
      `nepavyko nustatyti bazės: \`git merge-base ${taikinys} HEAD\` krito.\n` +
        `  git: ${r.klaida}\n\n` +
        "  Dažniausia priežastis CI'e - SEKLUS checkout. `actions/checkout` be\n" +
        "  `fetch-depth: 0` neturi nei taikinio šakos, nei merge-base commit'o.\n" +
        "  Lokaliai: `git fetch origin` arba nurodykite `--base <ref>`."
    );
  }
  return r.isvestis.trim();
}

function nuliaisAtskirti(isvestis) {
  return isvestis.split("\0").filter(Boolean);
}

function bazesFailai(repo, baze) {
  const r = bandytiGit(repo, ["ls-tree", "-r", "--name-only", "-z", baze]);
  if (!r.ok) throw new SargoKlaida(`nepavyko nuskaityti bazės failų sąrašo: ${r.klaida}`);
  return nuliaisAtskirti(r.isvestis);
}

function headFailai(repo) {
  const r = bandytiGit(repo, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (!r.ok) throw new SargoKlaida(`nepavyko nuskaityti head failų sąrašo: ${r.klaida}`);
  return [...new Set(nuliaisAtskirti(r.isvestis))];
}

function pakeistiFailai(repo, baze) {
  const r = bandytiGit(repo, ["diff", "--name-only", "-z", baze]);
  if (!r.ok) throw new SargoKlaida(`nepavyko nuskaityti pakeitimų sąrašo: ${r.klaida}`);
  return new Set(nuliaisAtskirti(r.isvestis));
}

function commitaiRuoze(repo, baze) {
  const r = bandytiGit(repo, ["log", "-z", "--format=%H%n%B", `${baze}..HEAD`]);
  if (!r.ok) throw new SargoKlaida(`nepavyko nuskaityti commit'ų žinučių: ${r.klaida}`);

  return nuliaisAtskirti(r.isvestis)
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const nl = b.indexOf("\n");
      return nl === -1
        ? { sha: b.trim(), zinute: "" }
        : { sha: b.slice(0, nl).trim(), zinute: b.slice(nl + 1) };
    });
}

/**
 * Bazės pusė skaitoma IŠ GIT OBJEKTŲ, ne iš checkout'o - dviejų revizijų tame
 * pačiame darbo medyje išsiimti neįmanoma.
 *
 * Optimizacija: failui, kurio `git diff <baze>` neliečia, turinys sutampa su
 * darbo medžiu, tad `git show` nekviečiamas. PR'ai paprastai keičia kelis
 * failus, o `git show` kiekvienam iš 146 kainuotų šimtus procesų.
 */
function surinktiBazesTurini(repo, baze, keliai, pakeisti) {
  const failai = new Map();

  for (const kelias of keliai) {
    if (!grupuoti(kelias)) continue;

    if (!pakeisti.has(kelias)) {
      const pilnas = join(repo, kelias);
      if (existsSync(pilnas) && statSync(pilnas).isFile()) {
        failai.set(kelias, readFileSync(pilnas, "utf8"));
        continue;
      }
    }

    const r = bandytiGit(repo, ["show", `${baze}:${kelias}`]);
    if (!r.ok) throw new SargoKlaida(`nepavyko nuskaityti \`${kelias}\` iš bazės ${baze}: ${r.klaida}`);
    failai.set(kelias, r.isvestis);
  }

  return failai;
}

function surinktiHeadTurini(repo, keliai) {
  const failai = new Map();

  for (const kelias of keliai) {
    if (!grupuoti(kelias)) continue;
    const pilnas = join(repo, kelias);
    if (!existsSync(pilnas) || !statSync(pilnas).isFile()) continue;
    failai.set(kelias, readFileSync(pilnas, "utf8"));
  }

  return failai;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. CLI
 * ══════════════════════════════════════════════════════════════════════════ */

function argReiksme(argv, vardas) {
  const suLygybe = argv.find((a) => a.startsWith(`${vardas}=`));
  if (suLygybe) return suLygybe.slice(vardas.length + 1);

  const i = argv.indexOf(vardas);
  if (i === -1) return null;

  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new SargoKlaida(`\`${vardas}\` reikalauja reikšmės`);
  return v;
}

/** ⚠️ Per-grupę skaičiai - tylus dalinis skenavimas privalo būti MATOMAS. */
function grupiuSuvestine(pavadinimas, indeksas) {
  const eilutes = [];
  let viso = 0;

  for (const [g, n] of [...indeksas.grupes].sort()) {
    eilutes.push(`    ${g.padEnd(28)} ${String(n).padStart(4)}`);
    viso += n;
  }

  return [`${pavadinimas}: ${viso} failų`, ...eilutes].join("\n");
}

function main() {
  const argv = process.argv.slice(2);

  if (!savipatikra()) process.exit(2);
  if (argv.includes("--self-test")) process.exit(0);

  const repo = resolve(argReiksme(argv, "--repo") ?? NUMATYTAS_REPO);

  /**
   * Taikinys: eksplicitinis `--base`, tada PR bazė iš GitHub aplinkos, tada
   * `origin/main`. `GITHUB_BASE_REF` nustatytas TIK `pull_request` įvykiuose;
   * `push: main` paleidime merge-base sutampa su HEAD, tad sargas praeina
   * trivialiai - jis yra PR vartai.
   */
  const taikinys =
    argReiksme(argv, "--base") ??
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");

  const baze = nustatytiBaze(repo, taikinys);
  const head = bandytiGit(repo, ["rev-parse", "HEAD"]);

  console.log("=".repeat(78));
  console.log("IŠTRINTŲ TESTŲ SARGAS (#237)");
  console.log("=".repeat(78));
  console.log(`Taikinys:   ${taikinys}`);
  console.log(`Bazė:       ${baze} (git merge-base)`);
  console.log(`Head:       ${head.ok ? head.isvestis.trim() : "?"}`);
  console.log();

  const pakeisti = pakeistiFailai(repo, baze);
  const bazesIdx = indeksuoti(surinktiBazesTurini(repo, baze, bazesFailai(repo, baze), pakeisti));
  const headIdx = indeksuoti(surinktiHeadTurini(repo, headFailai(repo)));

  console.log(grupiuSuvestine("BAZĖ", bazesIdx));
  console.log(grupiuSuvestine("HEAD", headIdx));
  console.log();

  const sudėti = (m) => [...m.values()].reduce((a, b) => a + b, 0);

  console.log(
    `Deklaracijų:  bazė ${sudėti(bazesIdx.kiekiai)} · head ${sudėti(headIdx.kiekiai)}   ` +
      `(neatpažintų: bazė ${bazesIdx.neatpazintiViso} · head ${headIdx.neatpazintiViso})`
  );
  console.log();

  /* ⚠️ FAIL-CLOSED: neišanalizuotas failas stabdo sargą, o ne tyliai indeksuojamas kaip tuščias. */
  const klaidos = [
    ...bazesIdx.klaidos.map((k) => `bazė  ${k}`),
    ...headIdx.klaidos.map((k) => `head  ${k}`),
  ];

  if (klaidos.length > 0) {
    console.error("SARGAS NEGALI DIRBTI - failai, kurių nepavyko patikimai išanalizuoti:\n");
    for (const k of klaidos) console.error(`  - ${k}`);
    console.error(
      "\nTylus nulis iš tokio failo reikštų, kad jame ištrinti testai NEPASTEBIMI - " +
        "t. y. tiksliai ta spraga, dėl kurios šis sargas ir egzistuoja."
    );
    process.exit(2);
  }

  const r = palyginti(bazesIdx, headIdx);

  if (!r.arPazeidimas) {
    console.log(`Testų nepašalinta. Pridėta naujų identitetų: ${r.prideti.length}.`);
    console.log();
    console.log("⚠️  Sargas tikrina DEKLARUOTŲ testų identitetus. Jis NEGAUDO scenarijų masyvo");
    console.log("    elemento pašalinimo (`auditStoreBackendContract.integration`), asertų");
    console.log("    kokybės ar padengimo - žr. šio skripto antraštę.");
    process.exit(0);
  }

  /* ── Pažeidimas: surenkam ataskaitą ─────────────────────────────────────── */

  const ataskaita = [];

  if (r.pasalinti.length > 0) {
    const kiek = r.pasalinti.reduce((a, p) => a + p.kiek, 0);
    ataskaita.push(`PAŠALINTA ĮVARDYTŲ TESTŲ: ${kiek} (${r.pasalinti.length} identitetai)`);
    ataskaita.push("");

    for (const p of r.pasalinti) {
      ataskaita.push(`  - ${p.identitetas}${p.kiek > 1 ? ` (x${p.kiek})` : ""}`);
      ataskaita.push(`      bazėje: ${p.bazesFailai.join(", ")}`);
    }
    ataskaita.push("");
  }

  if (r.neatpazintuDelta > 0) {
    ataskaita.push(`DINGO NEATPAŽINTŲ DEKLARACIJŲ: ${r.neatpazintuDelta}`);
    ataskaita.push("");
    ataskaita.push("  Šių testų pavadinimas sudaromas VYKDYMO METU (šablonas su interpoliacija),");
    ataskaita.push("  tad stabilaus identiteto jie neturi ir TIKSLESNIO pranešimo nėra - vardo,");
    ataskaita.push("  kurio būtų galima ieškoti, tiesiog neegzistuoja. Per-failo pjūvis:");
    ataskaita.push("");

    for (const f of r.neatpazintiFailai) {
      ataskaita.push(
        `  - ${f.failas}: bazė ${f.baze} -> head ${f.head}${f.head < f.baze ? "   <- sumažėjo" : ""}`
      );
    }

    ataskaita.push("");
    ataskaita.push("  TEISĖTAS ATVEJIS, ATRODANTIS TAIP PAT: šabloninio pavadinimo pavertimas");
    ataskaita.push("  statiniu. Tada neatpažintų mažėja, o ĮVARDYTŲ daugėja tiek pat.");
    ataskaita.push(`  Šiame PR pridėta naujų įvardytų identitetų: ${r.prideti.length}.`);
    ataskaita.push("  Jei skaičiai sutampa - tai konversija, ne trynimas; naudokite override.");
    ataskaita.push("");
  }

  const override = rastiOverride(commitaiRuoze(repo, baze));

  for (const a of override.atmesti) {
    console.log(`INFO ${a.sha.slice(0, 8)}: override ATMESTAS - ${a.kodel}`);
    console.log(`     ${a.eilute}`);
  }
  if (override.atmesti.length > 0) console.log();

  if (override.rastas) {
    const juosta = "!".repeat(78);
    console.log(juosta);
    console.log("SARGAS PERRAŠYTAS (TESTŲ ŠALINIMAS override)");
    console.log(juosta);
    console.log();
    console.log(`Commit:     ${override.sha}`);
    console.log(`Priežastis: ${override.priezastis}`);
    console.log();
    for (const e of ataskaita) console.log(e);
    console.log(
      "Override yra SĄMONINGAS sprendimas, matomas šioje išvestyje. Jei jis tampa\n" +
        "įprastas, sargas išsigimsta į formalumą - tai priemonės kaina, ne defektas."
    );
    process.exit(0);
  }

  console.error("=".repeat(78));
  console.error("TESTAI PAŠALINTI BE OVERRIDE");
  console.error("=".repeat(78));
  console.error();
  for (const e of ataskaita) console.error(e);
  console.error("Jei šalinimas SĄMONINGAS, įrašykite į commit'o žinutę PR ruože:");
  console.error();
  console.error(`    ${OVERRIDE_ZYME} <turininga priežastis>`);
  console.error();
  console.error("Priežastis privalo turėti bent 3 raides/skaitmenis; tarpai, skyryba ir");
  console.error("literalinis `<priežastis>` atmetami - kitaip override negina atskaitomybės,");
  console.error("dėl kurios jis ir egzistuoja.");
  process.exit(1);
}

/** Paleidžiama TIK kaip skriptas - kad testai galėtų importuoti grynas funkcijas. */
const paleistasTiesiogiai =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (paleistasTiesiogiai) {
  try {
    main();
  } catch (e) {
    if (e instanceof SargoKlaida) {
      console.error(`SARGAS SUSTOJO (fail-closed): ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
