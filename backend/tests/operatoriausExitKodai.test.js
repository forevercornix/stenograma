const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * OPERATORIAUS SKRIPTŲ EXIT KODŲ AUTORITETAS IR SARGAS (#423, D0–D7).
 *
 * ⚠️ AUTORITETO GRANDINĖ, KURIĄ ŠIS SARGAS ĮGYVENDINA:
 *
 *   vykdomas elgesys = AUTORITETAS
 *     → statinė analizė arba vykdymo testai = ĮRODYMAS
 *       → `Exit kodai:` antraštė = DEKLARACIJA
 *         → dokumentas = neprivalomas dublis SU SARGU
 *
 * Exit kodas yra operatoriaus sąsajos dalis. #417 metu pridėtas kodas `4` atsirado
 * `docs/migrations.md`, bet ne skripto antraštėje — du autoritetai, sinchronizuojami
 * rankomis, ir klaidos kaina tyli: operatorius remiasi dokumentu, kuris nebeatitinka
 * elgesio.
 *
 * ⚠️ KELIAI. Repo turi DU `scripts/` katalogus: šakninį (shell skriptai, `Makefile`
 * taikiniai) ir `backend/scripts/`. Čia — TIK antrasis.
 */

const SAKNIS = path.join(__dirname, "..", "..");
const SKRIPTAI = path.join(SAKNIS, "backend", "scripts");

/* ══════════════════════════════════════════════════════════════════════════
 * ATRADIMAS — IŠ EXIT MECHANIZMO, NE IŠ ANTRAŠTĖS (D4)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ AIBĖ PRADEDAMA NUO `process.exit*`, NE NUO `Exit kodai:` BUVIMO.
 *
 * Antraštė yra TIKRINAMAS ARTEFAKTAS, ne atradimo šaltinis. Ieškant pagal antraštę,
 * skriptas, kurio autorius ją pamiršo, iškristų iš aibės — o būtent nuo to sargas ir
 * gina. Išmatuota rašant: `erasure-marks.js` ir `hash-password.js` yra dokumentuoti
 * operatoriaus įrankiai BE antraštės, t. y. tas atvejis jau buvo repo, ne hipotezė.
 *
 * ❌ Rankinis skriptų sąrašas: jis gintų tik tuos, kuriuos kas nors atsiminė įrašyti.
 */
const EXIT_MECHANIZMAS = /process\.exit(?:Code)?\s*[=(]/;

function skriptai() {
  return fs
    .readdirSync(SKRIPTAI)
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => ({ vardas: f, tekstas: fs.readFileSync(path.join(SKRIPTAI, f), "utf8") }))
    .filter((s) => EXIT_MECHANIZMAS.test(s.tekstas));
}

/* ══════════════════════════════════════════════════════════════════════════
 * OPERATORIAUS RIBA — DU SIGNALAI, IR JŲ IŠSISKYRIMAS YRA PAŽEIDIMAS (D0)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ RIBĄ NUSTATO DU NEPRIKLAUSOMI, JAU EGZISTUOJANTYS SIGNALAI — ne vardų šablonas.
 *
 *   1. SAVIDEKLARACIJA: skriptas savo antraštėje sako, kad jis operatoriaus įrankis;
 *   2. DOKUMENTUOTAS IŠKVIETIMAS: `docs/` nurodo jį leisti kaip `node …scripts/X`.
 *
 * Išmatuota `b04b463`: abu duoda TUOS PAČIUS 7 skriptus ir 0 iš 8 CI/pagalbinių.
 * Antrasis signalas naudoja tą patį šabloną, kurį #410 sargas jau laiko autoritetu.
 *
 * ⚠️ SARGAS NESIRENKA VIENO, KAI JIE NESUTAMPA. Išsiskyrimas reiškia, kad riba
 * nebeapibrėžta — tai pažeidimas, ne pasirinkimas. Priešingu atveju signalai galėtų
 * tyliai išeiti vienas iš kito, ir aibė taptų atsitiktine.
 *
 * ⚠️ SIGNALAS 1 YRA DEKLARACIJA, NE MATAVIMAS — IR TAI PATAISYTA PO SARGO RADINIO.
 *
 * Pirmoji šio sargo redakcija signalą skaitė iš PIRMŲ 25 FAILO EILUČIŲ ir ieškojo vien
 * žodžio „operatoriaus". Toks langas klaidingas PAGAL KONSTRUKCIJĄ: jis gaudo bet kurią
 * prozą, atsitiktinai pataikiusią į rėmą, ir dokumentacijos PRIDĖJIMAS gali skriptą iš
 * ribos tyliai IŠIMTI.
 *
 * Abu gedimai buvo reali būsena, ne hipotezė:
 *
 *   `hash-password.js`         žodis buvo :25 — vėlesniame komentare apie `--user-id`,
 *                              ne antraštėje. Pridėjus `Exit kodai:` bloką jis iš lango
 *                              iškrito, ir sargas ribą paskelbė NEAPIBRĖŽTA.
 *   `cutover-terminalize.mjs`  atitiko tik per „Operatoriui liktų rašyti ad hoc kodą" —
 *                              formuluotę, kurią bet kuris perrašymas pašalintų.
 *
 * ⚠️ TODĖL SKAITOMA IŠ PIRMO `/** … *​/` BLOKO IR REIKALAUJAMA DEKLARACIJOS FORMOS
 * (`OPERATORIAUS ĮĖJIMAS` arba `OPERATORIAUS ĮRANKIS`), ne bet kurio žodžio paminėjimo.
 * Blokas yra struktūrinis vienetas — jo ribos nekinta nuo to, kiek eilučių kas pridėjo.
 * Išmatuota po pataisymo: 7/7 operatoriaus, 0/8 ne-operatoriaus.
 *
 * ⚠️ DEKLARACIJA GALI BŪTI NETEISINGA, IR BŪTENT TĄ GINA M5. Skriptas, deklaruojantis
 * save operatoriaus įėjimu, bet niekur nedokumentuotas (ar atvirkščiai), duoda
 * pažeidimą — tad deklaracija negali tyliai išsiskirti su tikrove.
 *
 * ❌ Alternatyva „`Naudojimas:` blokas antraštėje" ATMESTA MATAVIMU, ne nuojauta:
 * pirmame bloke jį turi 3 iš 7 operatoriaus ir 4 iš 8 ne-operatoriaus skriptų
 * (`check-security-matrix`, `run-tests`, `verify-clean`, `verify-postgres-suite-ran`).
 *
 * ⚠️ `doctor.js` IR `smoke.js` YRA UŽ RIBOS, IR TAI NE PRALEIDIMAS.
 *
 * Abu kviečiami per `npm run` / `make`, ne `node backend/scripts/X`, tad nė vieno
 * signalo neturi. Jų įtraukimas reikštų TREČIĄ autoritetą (`Makefile` taikinius), t. y.
 * naują CLI taksonomiją.
 *
 * ⚠️ PRIEŠINGAS SIGNALAS UŽRAŠOMAS, NE NUTYLIMAS: `backend/server.js:478` sako „Deep
 * health ir `doctor` yra operatoriaus paviršius". Tai teisinga apie DIAGNOSTIKOS
 * paviršių, bet `doctor` exit kodo reikšmių niekas nedokumentuoja ir neskaito — `make`
 * skiria tik 0/ne-0. Riba čia brėžiama pagal tai, kas turi KODŲ KONTRAKTĄ.
 */
const SAVIDEKLARACIJA = /OPERATORIAUS (ĮĖJIMAS|ĮRANKIS)/;

/** Pirmas `/** … *​/` blokas — struktūrinis vienetas, ne eilučių langas. */
function pirmasBlokas(tekstas) {
  const i = tekstas.indexOf("/**");
  if (i === -1) return "";
  const j = tekstas.indexOf("*/", i);
  return j === -1 ? tekstas.slice(i) : tekstas.slice(i, j + 2);
}

function arSavideklaracija(tekstas) {
  return SAVIDEKLARACIJA.test(pirmasBlokas(tekstas));
}

/** Tas pats šablonas, kurį naudoja #410 `node-script`: abu prefiksai priimami. */
const IŠKVIETIMAS = (vardas) =>
  new RegExp(`node\\s+(?:[A-Za-z0-9_$."'/-]*\\s+)?(?:backend/|frontend/)?scripts/${vardas.replace(".", "\\.")}\\b`);

function dokumentai() {
  const failai = [];
  const eiti = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) eiti(p);
      else if (e.name.endsWith(".md")) failai.push({ kelias: path.relative(SAKNIS, p), tekstas: fs.readFileSync(p, "utf8") });
    }
  };
  eiti(path.join(SAKNIS, "docs"));
  failai.push({ kelias: "README.md", tekstas: fs.readFileSync(path.join(SAKNIS, "README.md"), "utf8") });
  return failai;
}

function arDokumentuotas(dok, vardas) {
  const re = IŠKVIETIMAS(vardas);
  return dok.some((d) => re.test(d.tekstas));
}

function riba() {
  const dok = dokumentai();
  return skriptai().map((s) => ({
    ...s,
    savideklaracija: arSavideklaracija(s.tekstas),
    dokumentuotas: arDokumentuotas(dok, s.vardas),
  }));
}


/* ══════════════════════════════════════════════════════════════════════════
 * DEKLARACIJA — `Exit kodai:` ANTRAŠTĖS SKAITYMAS
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ BLOKAS BAIGIASI TUŠČIA KOMENTARO EILUTE, NE FIKSUOTU EILUČIŲ SKAIČIUMI.
 *
 * Antraštės skiriasi forma: dvi vienoje eilutėje (`pg-backup`, `cutover-terminalize`),
 * trys su įtraukomis ir vyniojimu (`post-restore-reconcile` kodo `4` aprašymas tęsiasi
 * kitoje eilutėje). Fiksuotas `slice(0, N)` arba „iki komentaro galo" vienu atveju
 * nupjautų kodą, kitu — įtrauktų po jo esančią ⚠️ prozą, kurioje skaičiai reiškia
 * issue numerius.
 */
const VIENAS_SKAITMUO = /(?<![\d#])\b(\d)\b(?!\d)/g;

function antrastesKodai(tekstas) {
  /**
   * ⚠️ ŽYMA PRIKABINTA PRIE KOMENTARO EILUTĖS PRADŽIOS, NE „bet kur tekste".
   *
   * Pirmoji redakcija ieškojo `/Exit kodai:/` bet kurioje eilutėje — ir SULŪŽO nuo
   * savo paties dokumentacijos: `hash-password.js` antraštėje yra paaiškinimas,
   * minintis `` `Exit kodai:` `` kaip tekstą. `findIndex` pagavo jį, blokas baigėsi
   * tuščia eilute, ir kodų aibė grįžo tuščia — t. y. skriptas su TEISINGA antraište
   * atrodė kaip be jos.
   *
   * Todėl reikalaujama, kad žyma būtų komentaro eilutės PRADŽIOJE. Minėjimas tekste
   * (`` `Exit kodai:` ``) tokios formos neturi, o tikra antraštė visada turi.
   */
  const eilutes = tekstas.split("\n");
  const pradzia = eilutes.findIndex((e) => /^\s*\*\s*Exit kodai:/.test(e));
  if (pradzia === -1) return null;

  const blokas = [];
  for (let i = pradzia; i < eilutes.length; i += 1) {
    const e = eilutes[i];
    if (i > pradzia && (/^\s*\*\s*$/.test(e) || /\*\//.test(e) || /^\s*\*\s*⚠️/.test(e))) break;
    blokas.push(e);
  }

  const kodai = new Set();
  for (const m of blokas.join("\n").matchAll(VIENAS_SKAITMUO)) kodai.add(Number(m[1]));
  return kodai;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ĮRODYMAS — STATINIS IŠVEDIMAS IŠ KODO (D7)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ UŽRAŠOMA TAISYKLĖ IR JOS RIBA, NE SKRIPTŲ SĄRAŠAS.
 *
 * Sąrašas („šie šeši statiškai, tas vienas vykdymu") pasentų tyliai: pridėjus aštuntą
 * skriptą niekas neprimintų jo priskirti. Taisyklė sena netampa.
 *
 * TAISYKLĖ — renkami sveikųjų skaičių LITERALAI iš keturių formų:
 *
 *   1. `process.exit(N)` ir `process.exitCode = N`      tiesioginis
 *   2. `return N;`                                       grąžinimas į `process.exitCode`
 *   3. `? N : M`                                         ternaras (`erasure-marks.js:141`)
 *   4. `mirti(zinutė, N)`                                vieno lygio apvalkalas —
 *      funkcija, kurios PARAMETRAS eina į `process.exit(param)`; literalai imami
 *      iš jos kvietimo vietų
 *
 * ⚠️ TAISYKLĖS RIBA, IR JI TIKRINAMA, NE TIKIMA: literalas, gaunamas per RUNTIME
 * reikšmę, statiškai nepasiekiamas. Išmatuota — vienintelis toks kelias repo yra
 * `migrate-artifacts.mjs`: `process.exitCode = await vykdyti(pool)` ir
 * `= e instanceof NaudojimoKlaida ? e.kodas : 2`, kur `kodas` ateina iš numatytojo
 * parametro (`klaida(zinute, kodas = 1)`).
 *
 * ⚠️ TODĖL LYGINAMA `išvesti ⊆ antraštė`, NE LYGYBĖ. Lygybė reikštų, kad taisyklė
 * pilna — o ji nėra, ir teigti kitaip būtų tas pats per didelis teiginys, kurį šis
 * sargas gaudo. Įtraukimas vis tiek pagauna abi svarbias klaidas: naują kodą be
 * antraštės įrašo (jis atsiras išvestuose) ir antraštėje pakeistą numerį (senasis
 * išvestas, bet nebedeklaruotas).
 *
 * ⚠️ DEKLARUOTI, BET NEIŠVESTI kodai SPAUSDINAMI. Tyliai augantis jų skaičius būtų
 * būdas sargą išjungti nieko nekeičiant — tas pats mechanizmas, kurį #410 sargas
 * užrašė apie praleidimų skaičių.
 */
function apvalkalai(tekstas) {
  const rasti = [];
  for (const m of tekstas.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    const [, vardas, params] = m;
    const vardai = params.split(",").map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean);
    const kunas = tekstas.slice(m.index, m.index + 400);
    for (let i = 0; i < vardai.length; i += 1) {
      if (new RegExp(`process\\.exit(?:Code)?\\s*(?:=\\s*|\\(\\s*)${vardai[i]}\\b`).test(kunas)) {
        rasti.push({ vardas, indeksas: i });
      }
    }
  }
  return rasti;
}

/**
 * Argumentų dalijimas, atsparus eilutėms ir skliaustams.
 *
 * ⚠️ EILUTĖS SEKAMOS ATSKIRAI, IR TAI IŠMATUOTA KLAIDA, NE ATSARGUMAS. Pirmoji šios
 * funkcijos redakcija backtick'ą laikė skliaustu, bet niekada jo neuždarydavo — o
 * `pg-backup.mjs` kviečia `mirti("`dump` reikalauja …", 1)`, t. y. backtick'ą DVIGUBOSE
 * kabutėse. Gylis niekada negrįždavo į 1, argumentai nesuskildavo, ir kodai `1`/`2`
 * tyliai iškrisdavo iš išvestos aibės.
 */
function argumentai(tekstas, nuo) {
  let gylis = 1;
  let dabar = "";
  let eiluteje = null;
  const argai = [];

  for (let i = nuo; i < tekstas.length; i += 1) {
    const c = tekstas[i];

    if (eiluteje) {
      if (c === "\\") {
        dabar += c + (tekstas[i + 1] || "");
        i += 1;
        continue;
      }
      if (c === eiluteje) eiluteje = null;
      dabar += c;
      continue;
    }

    if (c === "\"" || c === "'" || c === "`") {
      eiluteje = c;
      dabar += c;
      continue;
    }

    if ("([{".includes(c)) gylis += 1;
    else if (")]}".includes(c)) {
      gylis -= 1;
      if (gylis === 0) break;
    }

    if (c === "," && gylis === 1) {
      argai.push(dabar);
      dabar = "";
      continue;
    }
    dabar += c;
  }

  argai.push(dabar);
  return argai;
}

function isvestiKodai(tekstas) {
  const kodai = new Set();

  for (const m of tekstas.matchAll(/process\.exit(?:Code)?\s*(?:=\s*|\(\s*)(\d)\b/g)) kodai.add(Number(m[1]));
  for (const m of tekstas.matchAll(/\breturn\s+(\d)\s*;/g)) kodai.add(Number(m[1]));
  /**
   * ⚠️ TERNARO PUSĖS VERTINAMOS ATSKIRAI. `? N : M` forma pagautų
   * `erasure-marks.js:141` (`? 0 : 1`), bet praleistų `migrate-artifacts.mjs:260`
   * (`? e.kodas : 2`), kur literalas yra tik vienoje pusėje — o būtent jis ir yra
   * deklaruotas kodas `2`.
   */
  for (const m of tekstas.matchAll(/\?\s*([^?:]+?)\s*:\s*([^;,)\n]+)/g)) {
    for (const puse of [m[1], m[2]]) {
      if (/^\d$/.test(puse.trim())) kodai.add(Number(puse.trim()));
    }
  }

  for (const w of apvalkalai(tekstas)) {
    const re = new RegExp(`\\b${w.vardas}\\s*\\(`, "g");
    for (const m of tekstas.matchAll(re)) {
      const a = argumentai(tekstas, m.index + m[0].length)[w.indeksas];
      if (a !== undefined && /^\s*(\d)\s*$/.test(a)) kodai.add(Number(a.trim()));
    }
  }

  return kodai;
}


/**
 * ⚠️ KODAS `0` YRA STRUKTŪRINIS, NE IŠVEDAMAS.
 *
 * Sėkmė yra kodo NENUSTATYMAS: `process.exitCode` numatytai `0`, tad literalo, kurį
 * būtų galima surinkti, dažnai nėra (keturi iš penkių skriptų jo neturi). Laikyti tai
 * „neišvestu kodu" reikštų keturias netikras spragas ir paslėptų vienintelę tikrą.
 */
const isvestiSuSekme = (tekstas) => new Set([0, ...isvestiKodai(tekstas)]);

/* ══════════════════════════════════════════════════════════════════════════
 * DUBLIS — DOKUMENTO KODAI IR JŲ PRISKYRIMAS SKRIPTUI
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ DUBLIS PRISKIRIAMAS ARTIMIAUSIU AUKŠČIAU ESANČIU IŠKVIETIMU, NE ŽEMĖLAPIU.
 *
 * Rankinis „dokumentas → skriptas" žemėlapis gintų tik tuos dublius, kuriuos kas nors
 * atsiminė įrašyti — o trys iš keturių esamų dublių (`backup-runbook.md`) buvo
 * praleisti net rašant patį issue. Priskyrimas iš teksto tokios atminties nereikalauja.
 *
 * Išmatuota: visi keturi dubliai turi `node …scripts/X` iškvietimą 3–29 eilutėmis
 * aukščiau, ir tai vienintelis skriptas tarp jų.
 */
function dokumentuDubliai(dok) {
  const dubliai = [];
  const iskvietimas = /node\s+(?:[A-Za-z0-9_$."'/=-]*\s+)?(?:backend\/|frontend\/)?scripts\/([A-Za-z0-9._-]+\.(?:mjs|js))\b/;

  for (const { kelias, tekstas } of dok) {
    const eilutes = tekstas.split("\n");
    for (let i = 0; i < eilutes.length; i += 1) {
      if (!/Exit kodai/.test(eilutes[i])) continue;

      let skriptas = null;
      for (let j = i; j >= 0 && j > i - 60; j -= 1) {
        const m = eilutes[j].match(iskvietimas);
        if (m) {
          skriptas = m[1];
          break;
        }
      }

      /** Blokas: nuo `Exit kodai` iki tuščios eilutės — dubliai rašomi pastraipa. */
      const blokas = [];
      for (let j = i; j < eilutes.length; j += 1) {
        if (j > i && /^\s*$/.test(eilutes[j])) break;
        blokas.push(eilutes[j]);
      }

      const kodai = new Set();
      for (const m of blokas.join("\n").matchAll(VIENAS_SKAITMUO)) kodai.add(Number(m[1]));
      dubliai.push({ kelias, eilute: i + 1, skriptas, kodai });
    }
  }
  return dubliai;
}


/* ══════════════════════════════════════════════════════════════════════════
 * PAŽEIDIMAI — VIENA FUNKCIJA, KAD SAVIPATIKRA MATUOTŲ TĄ PATĮ KELIĄ (D3)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ SAVIPATIKRA KVIEČIA TĄ PAČIĄ FUNKCIJĄ, NE JOS KOPIJĄ.
 *
 * Forma pagal `vykdymoPlanas` / `servisuManifestas`: jei įterptą nesutapimą tikrintų
 * atskira logika, savipatikra įrodytų savo pačios kopijos elgesį — o ne to sargo,
 * kuris veikia CI'e.
 */
function pazeidimai({ skriptai: sk = skriptai(), dok = dokumentai() } = {}) {
  const p = [];
  const dubliai = dokumentuDubliai(dok);

  for (const s of sk) {
    const savideklaracija = arSavideklaracija(s.tekstas);
    const dokumentuotas = arDokumentuotas(dok, s.vardas);

    /** D0/M5: riba apibrėžta tik tada, kai abu signalai sutampa. */
    if (savideklaracija !== dokumentuotas) {
      p.push(
        `${s.vardas}: ribos signalai IŠSISKYRĖ (savideklaracija=${savideklaracija}, ` +
          `dokumentuotas iškvietimas=${dokumentuotas}) — riba nebeapibrėžta (#423 D0)`
      );
      continue;
    }

    if (!savideklaracija) continue; // ne operatoriaus skriptas — kodų kontrakto neturi

    const antraste = antrastesKodai(s.tekstas);
    if (!antraste) {
      p.push(`${s.vardas}: operatoriaus skriptas nustato exit kodą, bet \`Exit kodai:\` antraštės NETURI (#423 D4)`);
      continue;
    }

    /** M1/M4: kiekvienas išvestas kodas privalo būti deklaruotas. */
    const isvesti = isvestiSuSekme(s.tekstas);
    const nedeklaruoti = [...isvesti].filter((k) => !antraste.has(k)).sort();
    if (nedeklaruoti.length) {
      p.push(
        `${s.vardas}: kodai {${nedeklaruoti.join(",")}} nustatomi KODE, bet antraštėje jų nėra ` +
          `(antraštė: {${[...antraste].sort().join(",")}})`
      );
    }

    /** M2: dublis lyginamas ABIPUSE lygybe. */
    for (const d of dubliai.filter((x) => x.skriptas === s.vardas)) {
      const tik_dok = [...d.kodai].filter((k) => !antraste.has(k)).sort();
      const tik_antr = [...antraste].filter((k) => !d.kodai.has(k)).sort();
      if (tik_dok.length || tik_antr.length) {
        p.push(
          `${d.kelias}:${d.eilute} (${s.vardas}): dublis NESUTAMPA su antrašte — ` +
            `tik dokumente {${tik_dok.join(",")}}, tik antraštėje {${tik_antr.join(",")}}`
        );
      }
    }
  }
  return p;
}

/* ══════════════════════════════════════════════════════════════════════════
 * TESTAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#423: operatoriaus skriptų exit kodų kontraktas — 0 pažeidimų", () => {
  const p = pazeidimai();
  assert.deepEqual(p, [], `pažeidimai:\n  ${p.join("\n  ")}`);
});

test("#423 D0: abu ribos signalai duoda TĄ PAČIĄ aibę (7 iš 15)", () => {
  const visi = riba();
  const operatoriaus = visi.filter((s) => s.savideklaracija && s.dokumentuotas);
  const kiti = visi.filter((s) => !s.savideklaracija && !s.dokumentuotas);

  assert.equal(visi.length, 15, "paviršius pagal exit mechanizmą (ne pagal antraštę)");
  assert.equal(operatoriaus.length, 7, "operatoriaus riba");
  assert.equal(kiti.length, 8, "CI/pagalbiniai");
  assert.equal(
    operatoriaus.length + kiti.length,
    visi.length,
    "nė vieno su vienu signalu — kitaip riba nebeapibrėžta"
  );
});

test("#423 M3 antroji pusė: aštuoni NE-operatoriaus skriptai duoda 0 pažeidimų", () => {
  /**
   * ⚠️ BE ŠIOS PUSĖS M3 PRAEITŲ DĖL KLAIDINGOS PRIEŽASTIES. Sargas, krentantis ant
   * visko, kas neturi antraštės, „aptiktų" naują operatoriaus skriptą — bet kartu
   * reikalautų antraštės iš `run-tests.mjs` ir `check-*`, kuriems kodų kontrakto nėra.
   */
  const kiti = skriptai().filter((s) => !arSavideklaracija(s.tekstas));
  assert.equal(kiti.length, 8);
  assert.deepEqual(pazeidimai({ skriptai: kiti }), []);
});

test("#423 D3 SAVIPATIKRA: įterptas nesutapimas duoda LYGIAI 1 pažeidimą", () => {
  /** Antraštėje pakeičiamas kodo numeris — M1 forma, prieš KODĄ (dublio čia nėra). */
  const sk = skriptai();
  const cutover = sk.find((s) => s.vardas === "cutover-terminalize.mjs");
  const sugadintas = sk.map((s) =>
    s === cutover ? { ...s, tekstas: s.tekstas.replace("3 dalis job'ų neapdorota", "9 dalis job'ų neapdorota") } : s
  );

  const p = pazeidimai({ skriptai: sugadintas });
  assert.equal(p.length, 1, `laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`);
  assert.match(p[0], /cutover-terminalize\.mjs: kodai \{3\}/);

  /** Ir atvirkščiai: nepakeista būsena → 0. Be šios pusės savipatikra nieko neriboja. */
  assert.deepEqual(pazeidimai({ skriptai: sk }), []);
});

test("#423 D3 SAVIPATIKRA: dublio nesutapimas gaudomas VISOMIS trimis kryptimis", () => {
  /**
   * ⚠️ `Set(dokumentas) === Set(antraštė)`, ne įtraukimas. Vien „dokumento kodai ⊆
   * antraštės" praleistų du iš trijų: trūkstamą ir perteklinį.
   */
  const bazinis = dokumentai();
  const runbook = bazinis.find((d) => d.kelias === "docs/backup-runbook.md");
  const pakeisti = (nuo, kur) =>
    bazinis.map((d) => (d === runbook ? { ...d, tekstas: d.tekstas.replace(nuo, kur) } : d));

  const atvejai = [
    ["pakeistas", "`2` procedūros klaida.", "`9` procedūros klaida."],
    ["trūkstamas", " · `2` procedūros klaida.", "."],
    ["perteklinis", "`2` procedūros klaida.", "`2` procedūros klaida · `7` naujas."],
  ];

  for (const [vardas, nuo, kur] of atvejai) {
    const p = pazeidimai({ dok: pakeisti(nuo, kur) });
    assert.equal(p.length, 1, `${vardas}: laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`);
    assert.match(p[0], /backup-runbook\.md:448 \(pg-backup\.mjs\): dublis NESUTAMPA/, vardas);
  }
});

test("#423 D0 SAVIPATIKRA: vienas ribos signalas be kito — pažeidimas (M5)", () => {
  /**
   * ⚠️ TIKRINAMA KRYPTIS, KURIOS NEGALIMA GAUTI PAKEITUS TIK DOKUMENTUS: skriptas
   * praranda savideklaraciją, bet lieka dokumentuotas. Be M5 sargas pasirinktų vieną
   * signalą ir tęstų — t. y. riba tyliai nustotų būti apibrėžta.
   */
  const sk = skriptai();
  const pg = sk.find((s) => s.vardas === "pg-backup.mjs");
  const bePirmo = sk.map((s) =>
    s === pg ? { ...s, tekstas: s.tekstas.replace("OPERATORIAUS ĮĖJIMAS", "NAUDOTOJO ĮĖJIMAS") } : s
  );

  const p = pazeidimai({ skriptai: bePirmo });
  assert.equal(p.length, 1, `laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`);
  assert.match(p[0], /pg-backup\.mjs: ribos signalai IŠSISKYRĖ/);
});
