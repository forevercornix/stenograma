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

function arSavideklaracija(komentarai) {
  return SAVIDEKLARACIJA.test(antrastesBlokas(komentarai));
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
    savideklaracija: arSavideklaracija(analize(s.tekstas).komentarai),
    dokumentuotas: arDokumentuotas(dok, s.vardas),
  }));
}


/* ══════════════════════════════════════════════════════════════════════════
 * AST — VIENAS ĮRANKIS PENKIEMS RADINIAMS (#423 Codex P2)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ PIRMOJI ŠIO SARGO REDAKCIJA AIBĘ VEDĖ IŠ NEAPDOROTO TEKSTO, IR TAI BUVO VIENA
 * ŠAKNIS PENKIEMS GEDIMAMS.
 *
 * Codex P2 rado penkis, ir keturi turėjo atkūrimą — sargas likdavo ŽALIAS tuo atveju,
 * kurį skelbė gaudantis:
 *
 *   komentaras `process.exitCode = 9`   sargas KRISDAVO be jokio elgesio pakeitimo
 *   tikras `process.exitCode = 10`      PRAEIDAVO: `\d` priima vieną skaitmenį
 *   apvalkalas su >400 simbolių kūnu    visi jo kodai IŠKRISDAVO iš aibės
 *   `Exit kodai:` bet kur faile         antraštės gale pakanka, nors D4 reikalauja jos
 *
 * ⚠️ TAI NE PENKI LOPAI, O VIENAS PAKEITIMAS. Fiksuotas langas (400 simbolių, `\d`,
 * visas failas) yra ta pati klaida penkiose vietose: tekstas neturi struktūros, tad
 * riba visada yra spėjimas. AST ją turi.
 *
 * ⚠️ NE NAUJA PRIKLAUSOMYBĖ — IŠMATUOTA. `eslint` yra DEKLARUOTA `devDependency`
 * (`^10.10.0`, lock'e 10.10.0), o jo viešas `Linter` API per in-memory taisyklę
 * atiduoda `Program` mazgą ir komentarus. `acorn`/`espree` NENAUDOJAMI: repo juos
 * turi tik tranzityviai per `eslint`, o iš repo šaknies `acorn` apskritai
 * išsisprendžia į SISTEMINĮ `/usr/share/nodejs/acorn`. Tranzityvi priklausomybė gali
 * išnykti atnaujinus `eslint`; deklaruota — ne.
 *
 * ⚠️ PATIKRINTA SU LOCK'E FIKSUOTA VERSIJA, NE SU LOKALIU `node_modules`. Lokalus
 * įdiegimas buvo pasenęs (10.8.1, netenkina `^10.10.0`), o CI per `npm ci` gauna
 * 10.10.0. AST kelias patikrintas abiem: septyni rinkiniai ir visi keturi Codex
 * atkūrimai duoda tą patį.
 */
/**
 * ⚠️ AST MECHANIZMAS IŠKELTAS Į `tests/helpers/astAnalize.js` (#253).
 *
 * Kai to paties kelio prireikė ANTRAM sargui (`#253` savininko `finish()` aprėptis),
 * kopijavimas būtų reiškęs dvi versijas, kurios ilgainiui išsiskirtų — ir viena iš jų
 * liktų su senuoju langu. Helper'is turi SAVO elgsenos testą (`astAnalize.test.js`,
 * #410 D3a), nes bendra logika be savo patikros yra tas pats mechanizmas, kurį
 * sprendžia #412.
 */
const { analize, eiti } = require("./helpers/astAnalize");

const sveikas = (n) => (n && n.type === "Literal" && Number.isInteger(n.value) ? n.value : null);

const exitTaikinys = (n) =>
  Boolean(
    n &&
      n.type === "MemberExpression" &&
      n.object.type === "Identifier" &&
      n.object.name === "process" &&
      n.property.type === "Identifier" &&
      (n.property.name === "exit" || n.property.name === "exitCode")
  );

const beAwait = (n) => (n && n.type === "AwaitExpression" ? n.argument : n);

/* ══════════════════════════════════════════════════════════════════════════
 * DEKLARACIJA — `Exit kodai:` TIK PIRMAME ANTRAŠTĖS BLOKE (Codex P2, 5 radinys)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ BLOKAS IMAMAS IŠ `getAllComments()`, NE PAIEŠKA TEKSTE.
 *
 * Ankstesnė redakcija `Exit kodai:` ieškojo VISAME faile, tad antraštės blokas,
 * perkeltas į failo galą, sargą tenkindavo — nors D4 ir matrica teigia, kad
 * reikalaujama BŪTENT antraštės. Codex tai atkūrė: perkėlus bloką visi testai liko
 * žali.
 *
 * Pirmas `Block` tipo komentaras yra struktūrinis vienetas: jo ribų nekeičia nei
 * pridėtos eilutės, nei tas pats tekstas kitoje vietoje.
 */
function antrastesBlokas(komentarai) {
  const pirmas = komentarai.find((c) => c.type === "Block");
  return pirmas ? pirmas.value : "";
}

const VISI_SVEIKIEJI = /(?<![\d#.])(\d+)(?![\d.])/g;

function antrastesKodai(komentarai) {
  const blokas = antrastesBlokas(komentarai);
  const eilutes = blokas.split("\n");
  const pradzia = eilutes.findIndex((e) => /^\s*\*?\s*Exit kodai:/.test(e));
  if (pradzia === -1) return null;

  const imti = [];
  for (let i = pradzia; i < eilutes.length; i += 1) {
    const e = eilutes[i];
    if (i > pradzia && (/^\s*\*?\s*$/.test(e) || /^\s*\*?\s*⚠️/.test(e))) break;
    imti.push(e);
  }

  const kodai = new Set();
  for (const m of imti.join("\n").matchAll(VISI_SVEIKIEJI)) kodai.add(Number(m[1]));
  return kodai;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ĮRODYMAS — TAISYKLĖ IR JOS RIBA (D7)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * TAISYKLĖ — sveikųjų literalai iš AST, keturiose pozicijose:
 *
 *   1. `process.exit(N)` ir `process.exitCode = N`        tiesioginis
 *   2. ternaras TIESIOGIAI exit pozicijoje                `process.exitCode = x ? 1 : 2`
 *   3. apvalkalas: funkcija, kurios PARAMETRAS eina į exit — literalai iš jos
 *      kvietimo vietų (`mirti(zinutė, 2)`)
 *   4. `return N` ir `return x ? N : M` — ⚠️ TIK EXIT GAMINTOJUOSE
 *
 * ⚠️ 4 PUNKTO SIAURINIMAS YRA PATS SVARBIAUSIAS, IR JIS ATSIRADO IŠ IŠMATUOTOS
 * KLAIDOS. Perėjus į AST, „kiekvienas `return N`" pradėjo duoti `erasure-marks.js`
 * kodą `100` — iš `:130` `limit: Number.isFinite(limit) ? limit : 100`, ternaro
 * OBJEKTO LITERALE, visai ne exit kelyje. Senasis `\d` jį praleido ATSITIKTINAI,
 * nes `100` yra trys skaitmenys: dvi klaidos vienas kitą kompensavo. Pataisius tik
 * „pilnus sveikuosius" be šio siaurinimo, sargas būtų pradėjęs kristi be priežasties.
 *
 * EXIT GAMINTOJAS atpažįstamas struktūriškai — funkcija, kurios grąžinimas realiai
 * eina į exit:
 *
 *   `process.exitCode = await vykdyti(pool)`   → `vykdyti`
 *   `.then(main)` grandinėje, kurios vėlesnio handler'io parametras eina į exit → `main`
 *
 * ⚠️ RIBA, IR JI TIKRINAMA DVIEM MUTACIJOMIS, NE TEIGIAMA. Siaurinimas įveda SAVO
 * prielaidą: kad visi kodų šaltiniai pasiekiami iš `process.exit*` per grąžinimų
 * grandinę. Jei grandinė praleistų gamintoją, aibė TYLIAI susitrauktų — tas pats
 * gedimas kaip `100`, tik priešinga kryptimi. Todėl:
 *
 *   (a) naujas exit gamintojas su nedeklaruotu kodu → sargas KRENTA;
 *   (b) ternaro literalas NE exit kelyje            → į aibę NEPATENKA.
 *
 * ⚠️ IR KODAS `0` LIEKA STRUKTŪRINIS: sėkmė yra kodo NENUSTATYMAS, tad literalo
 * dažnai nėra. Žr. `isvestiSuSekme`.
 */
function exitGamintojai(programa) {
  const gamintojai = new Set();
  let thenGrandineGamina = false;

  for (const n of eiti(programa)) {
    if (n.type === "AssignmentExpression" && exitTaikinys(n.left)) {
      const e = beAwait(n.right);
      if (e && e.type === "CallExpression" && e.callee.type === "Identifier") gamintojai.add(e.callee.name);
    }
    if (n.type === "CallExpression" && exitTaikinys(n.callee)) {
      const e = beAwait(n.arguments[0]);
      if (e && e.type === "CallExpression" && e.callee.type === "Identifier") gamintojai.add(e.callee.name);
    }
    /** `.then(h)`, kurio parametras eina į exit → visa grandinė gamina exit kodą. */
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "then") {
      for (const a of n.arguments) {
        if (a.type !== "ArrowFunctionExpression" && a.type !== "FunctionExpression") continue;
        const p0 = a.params[0] && a.params[0].type === "Identifier" ? a.params[0].name : null;
        if (!p0) continue;
        for (const v of eiti(a.body)) {
          const eina =
            (v.type === "CallExpression" && exitTaikinys(v.callee) && v.arguments[0] && v.arguments[0].type === "Identifier" && v.arguments[0].name === p0) ||
            (v.type === "AssignmentExpression" && exitTaikinys(v.left) && v.right.type === "Identifier" && v.right.name === p0);
          if (eina) thenGrandineGamina = true;
        }
      }
    }
  }

  if (thenGrandineGamina) {
    for (const n of eiti(programa)) {
      if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.property.name !== "then") continue;
      for (const a of n.arguments) if (a.type === "Identifier") gamintojai.add(a.name);
    }
  }

  return gamintojai;
}

function apvalkalai(programa) {
  const rasti = [];
  for (const n of eiti(programa)) {
    if (n.type !== "FunctionDeclaration" || !n.id) continue;
    const params = n.params.map((p) => (p.type === "Identifier" ? p.name : null));
    for (const v of eiti(n.body)) {
      const vardas =
        v.type === "CallExpression" && exitTaikinys(v.callee) && v.arguments[0] && v.arguments[0].type === "Identifier"
          ? v.arguments[0].name
          : v.type === "AssignmentExpression" && exitTaikinys(v.left) && v.right.type === "Identifier"
            ? v.right.name
            : null;
      if (vardas === null) continue;
      const i = params.indexOf(vardas);
      if (i >= 0) rasti.push({ vardas: n.id.name, indeksas: i });
    }
  }
  return rasti;
}

function isvestiKodai(programa) {
  const kodai = new Set();
  const pridek = (n) => {
    const v = sveikas(n);
    if (v !== null) kodai.add(v);
  };
  const pridekTernara = (n) => {
    if (n && n.type === "ConditionalExpression") {
      pridek(n.consequent);
      pridek(n.alternate);
    }
  };

  for (const n of eiti(programa)) {
    if (n.type === "AssignmentExpression" && exitTaikinys(n.left)) {
      pridek(n.right);
      pridekTernara(n.right);
    }
    if (n.type === "CallExpression" && exitTaikinys(n.callee)) {
      pridek(n.arguments[0]);
      pridekTernara(n.arguments[0]);
    }
  }

  for (const w of apvalkalai(programa)) {
    for (const n of eiti(programa)) {
      if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== w.vardas) continue;
      pridek(n.arguments[w.indeksas]);
    }
  }

  const gamintojai = exitGamintojai(programa);
  for (const n of eiti(programa)) {
    const vardas =
      n.type === "FunctionDeclaration" && n.id
        ? n.id.name
        : n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && /Function/.test(n.init.type)
          ? n.id.name
          : null;
    if (!vardas || !gamintojai.has(vardas)) continue;
    for (const v of eiti(n)) {
      if (v.type !== "ReturnStatement" || !v.argument) continue;
      pridek(v.argument);
      pridekTernara(v.argument);
    }
  }

  return kodai;
}

/**
 * ⚠️ KODAS `0` YRA STRUKTŪRINIS, NE IŠVEDAMAS.
 *
 * Sėkmė yra kodo NENUSTATYMAS: `process.exitCode` numatytai `0`, tad literalo, kurį
 * būtų galima surinkti, dažnai nėra. Laikyti tai „neišvestu kodu" reikštų keturias
 * netikras spragas ir paslėptų vienintelę tikrą (`migrate-artifacts` kodas `1`).
 */
const isvestiSuSekme = (programa) => new Set([0, ...isvestiKodai(programa)]);

/* ══════════════════════════════════════════════════════════════════════════
 * DUBLIS — SEKCIJOS RIBA, NE EILUČIŲ LANGAS (Codex P2, 4 radinys)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 60 EILUČIŲ LANGAS BUVO TA PATI KLAIDA KAIP 400 SIMBOLIŲ.
 *
 * Codex atkūrė: prozai tarp iškvietimo ir `Exit kodai` pastraipos išaugus iki 60
 * eilučių, `skriptas` likdavo `null`, ir dublis TYLIAI iškrisdavo iš tikrinimo. Jis
 * tai išmatavo ANTRAJAME `backup-runbook.md` dublyje kartu pakeisdamas kodą — visi
 * testai liko žali.
 *
 * ⚠️ MARKDOWN AST ČIA NEREIKIA: dokumentas jau turi struktūrą — ANTRAŠTES. Dublis
 * siejamas su skriptu, iškviestu TOJE PAČIOJE sekcijoje: skenuojama atgal iki
 * artimiausios ankstesnės antraštės, ir iškvietimas privalo būti tarp jos ir dublio.
 * ❌ Jokio naujo skaičiaus.
 *
 * Išmatuota — visi keturi dubliai tenkina taisyklę, ir iškvietimas visada eina iškart
 * po antraštės:
 *
 *   backup-runbook.md:448   antraštė :444   iškvietimas :445
 *   backup-runbook.md:776   antraštė :746   iškvietimas :747
 *   backup-runbook.md:883   antraštė :879   iškvietimas :880
 *   migrations.md:313       antraštė :301   iškvietimas :310
 */
const ANTRASTE = /^#{1,6}\s/;
const DOK_ISKVIETIMAS = /node\s+(?:[A-Za-z0-9_$."'/=-]*\s+)?(?:backend\/|frontend\/)?scripts\/([A-Za-z0-9._-]+\.(?:mjs|js))\b/;

function dokumentuDubliai(dok) {
  const dubliai = [];

  for (const { kelias, tekstas } of dok) {
    const eilutes = tekstas.split("\n");

    for (let i = 0; i < eilutes.length; i += 1) {
      if (!/Exit kodai/.test(eilutes[i])) continue;

      /** Sekcijos pradžia: artimiausia ankstesnė antraštė (arba failo pradžia). */
      let sekcija = 0;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (ANTRASTE.test(eilutes[j])) {
          sekcija = j;
          break;
        }
      }

      let skriptas = null;
      for (let j = i; j > sekcija; j -= 1) {
        const m = eilutes[j].match(DOK_ISKVIETIMAS);
        if (m) {
          skriptas = m[1];
          break;
        }
      }

      const blokas = [];
      for (let j = i; j < eilutes.length; j += 1) {
        if (j > i && /^\s*$/.test(eilutes[j])) break;
        blokas.push(eilutes[j]);
      }

      const kodai = new Set();
      for (const m of blokas.join("\n").matchAll(VISI_SVEIKIEJI)) kodai.add(Number(m[1]));
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
    const { programa, komentarai } = analize(s.tekstas);
    const savideklaracija = arSavideklaracija(komentarai);
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

    const antraste = antrastesKodai(komentarai);
    if (!antraste) {
      p.push(`${s.vardas}: operatoriaus skriptas nustato exit kodą, bet \`Exit kodai:\` antraštės NETURI (#423 D4)`);
      continue;
    }

    /** M1/M4: kiekvienas išvestas kodas privalo būti deklaruotas. */
    const isvesti = isvestiSuSekme(programa);
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
  const kiti = skriptai().filter((s) => !arSavideklaracija(analize(s.tekstas).komentarai));
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

test("#423 D3 SAVIPATIKRA: KIEKVIENO iš keturių dublių nesutapimas gaudomas", () => {
  /**
   * ⚠️ SPRAGA, KURIĄ ATSKLEIDĖ CODEX 4 RADINYS: ankstesnė redakcija mutuodavo TIK
   * PIRMĄ dublį (`backup-runbook.md:448`). Trys likusieji sargo neturėjo — ir būtent
   * antrajame Codex atkūrė tylų praleidimą.
   *
   * ⚠️ AIBĖ IŠVEDAMA, NE SURAŠOMA: dubliai imami iš `dokumentuDubliai()`, tad
   * pridėjus penktą jis į savipatikrą pakliūva savaime. Rankinis sąrašas gintų tik
   * tuos, kuriuos kas nors atsiminė įrašyti.
   */
  const bazinis = dokumentai();
  const dubliai = dokumentuDubliai(bazinis).filter((d) => d.skriptas);

  assert.equal(dubliai.length, 4, `laukta keturių dublių, rasta ${dubliai.length}`);

  for (const d of dubliai) {
    const kodas = [...d.kodai].sort((a, b) => b - a)[0];

    /**
     * ⚠️ MUTUOJAMAS VISAS TO DUBLIO BLOKAS, NE PIRMA JO EILUTĖ.
     *
     * Išmatuota: `backup-runbook.md:776` dublis yra DAUGELIO eilučių — kodai `3` ir `4`
     * gyvena tęsinyje. Pirmoji redakcija keitė tik `d.eilute`, tad tam dubliui mutacija
     * nieko nepadarydavo, savipatikra gaudavo 0 pažeidimų ir KRISDAVO — t. y. spraga
     * būtų buvusi ta pati, kurią šis testas ir uždaro, tik kitoje vietoje.
     */
    const sugadinti = bazinis.map((f) => {
      if (f.kelias !== d.kelias) return f;
      const eilutes = f.tekstas.split("\n");
      const re = new RegExp(`(?<![\\d.])${kodas}(?![\\d.])`);
      for (let i = d.eilute - 1; i < eilutes.length; i += 1) {
        if (i > d.eilute - 1 && /^\s*$/.test(eilutes[i])) break;
        if (re.test(eilutes[i])) {
          eilutes[i] = eilutes[i].replace(re, "9");
          break;
        }
      }
      return { ...f, tekstas: eilutes.join("\n") };
    });

    const p = pazeidimai({ dok: sugadinti });
    assert.equal(
      p.length,
      1,
      `${d.kelias}:${d.eilute} (${d.skriptas}): laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`
    );
    assert.match(p[0], new RegExp(`${d.skriptas.replace(".", "\\.")}\\): dublis NESUTAMPA`), `${d.kelias}:${d.eilute}`);
  }
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

  /**
   * ⚠️ EILUTĖS NUMERIS IŠVEDAMAS, NE ĮRAŠYTAS.
   *
   * Pirmoji redakcija tikrino `backup-runbook.md:448`, ir tai lūžo vos dokumente
   * atsirado eilučių aukščiau — t. y. tas pats fiksuotas langas, kurį Codex rado
   * sarge, tik mano paties teste. Išmatuota: įterpus 70 eilučių prozos, sargas dublį
   * PRISKYRĖ teisingai, o krito būtent ši asercija.
   */
  const pgDublis = dokumentuDubliai(bazinis).find((d) => d.skriptas === "pg-backup.mjs");
  assert.ok(pgDublis, "prielaida: `pg-backup` dublis randamas");

  for (const [vardas, nuo, kur] of atvejai) {
    const p = pazeidimai({ dok: pakeisti(nuo, kur) });
    assert.equal(p.length, 1, `${vardas}: laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`);
    assert.match(
      p[0],
      new RegExp(`backup-runbook\\.md:${pgDublis.eilute} \\(pg-backup\\.mjs\\): dublis NESUTAMPA`),
      vardas
    );
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

/* ══════════════════════════════════════════════════════════════════════════
 * REGRESIJOS INKARAS — AIBĖS UŽFIKSUOTOS PRIEŠ AST PERĖJIMĄ
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ BE ŠIO INKARO AST PERRAŠYMAS GALĖTŲ TYLIAI SUMAŽINTI AIBĘ, IR VISKAS LIKTŲ ŽALIA.
 *
 * `išvesti ⊆ antraštė` yra ĮTRAUKIMAS: aibei susitraukus iki tuščios, sąlyga galioja
 * TOBULAI, o sargas nebegina nieko. Tai tiksliai ta klasė, kurią gaudo visas #423 —
 * patikra, kuri praeina dėl to, kad nustojo matuoti.
 *
 * ⚠️ REIKŠMĖS IŠMATUOTOS PRIEŠ PERĖJIMĄ, teksto (regex) keliu, ir užrašytos čia kaip
 * ETALONAS. AST kelias privalo duoti TĄ PAČIĄ aibę kiekvienam iš septynių — nei
 * daugiau (klaidingi teigiami, kaip `erasure-marks` `100`), nei mažiau (tyli spraga).
 *
 * ⚠️ `0` ČIA NEĮTRAUKTAS: inkaras fiksuoja IŠVESTUS kodus, o `0` pridedamas atskirai
 * (`isvestiSuSekme`) kaip struktūrinis. Sumaišius juos, inkaras nustotų matuoti
 * būtent išvedimą.
 */
const ETALONAS = Object.freeze({
  "cutover-terminalize.mjs": [1, 2, 3],
  "dr-restore.mjs": [1, 2, 3],
  "erasure-marks.js": [0, 1, 2],
  "hash-password.js": [1],
  "migrate-artifacts.mjs": [0, 2, 3, 4],
  "pg-backup.mjs": [1, 2],
  "post-restore-reconcile.mjs": [1, 2, 3, 4],
});

test("#423 INKARAS: AST duoda TAS PAČIAS aibes kaip teksto kelias prieš perėjimą", () => {
  const sk = skriptai();

  for (const [vardas, tiketa] of Object.entries(ETALONAS)) {
    const s = sk.find((x) => x.vardas === vardas);
    assert.ok(s, `${vardas}: skriptas privalo būti aibėje`);
    const gauta = [...isvestiKodai(analize(s.tekstas).programa)].sort((a, b) => a - b);
    assert.deepEqual(gauta, tiketa, `${vardas}: išvesta {${gauta}}, etalonas {${tiketa}}`);
  }

  assert.equal(Object.keys(ETALONAS).length, 7, "etalonas privalo apimti visus septynis");
});

test("#423 RIBA (b): ternaro literalas NE exit kelyje į aibę NEPATENKA", () => {
  /**
   * ⚠️ IŠMATUOTA KLAIDA, NE ATSARGUMAS. Perėjus į AST, „kiekvienas ternaras" pradėjo
   * duoti `erasure-marks.js` kodą `100` — iš `:130`
   * `limit: Number.isFinite(limit) ? limit : 100`, ternaro OBJEKTO LITERALE.
   *
   * Senasis `\d` jį praleido ATSITIKTINAI (trys skaitmenys), tad dvi klaidos vienas
   * kitą kompensavo. Pataisius tik „pilnus sveikuosius", sargas būtų pradėjęs kristi
   * be jokio elgesio pakeitimo.
   */
  const s = skriptai().find((x) => x.vardas === "erasure-marks.js");
  const kodai = isvestiKodai(analize(s.tekstas).programa);

  assert.equal(kodai.has(100), false, "`limit ? … : 100` nėra exit kodas");
  assert.deepEqual([...kodai].sort((a, b) => a - b), [0, 1, 2]);
});

test("#423 RIBA (a): NAUJAS exit gamintojas su nedeklaruotu kodu — sargas KRENTA", () => {
  /**
   * ⚠️ SIAURINIMAS IKI „EXIT GAMINTOJŲ" ĮVEDA SAVO PRIELAIDĄ: kad visi kodų šaltiniai
   * pasiekiami iš `process.exit*` per grąžinimų grandinę. Jei grandinė praleistų
   * gamintoją, aibė TYLIAI susitrauktų — tas pats gedimas kaip `100`, tik priešinga
   * kryptimi.
   *
   * GINA: pridėjus NAUJĄ gamintoją (funkciją, kurios grąžinimas eina į
   * `process.exitCode`) su kodu, kurio antraštėje nėra, sargas privalo kristi.
   */
  const sk = skriptai();
  const pg = sk.find((x) => x.vardas === "pg-backup.mjs");

  const suGamintoju = sk.map((x) =>
    x === pg
      ? {
          ...x,
          tekstas:
            x.tekstas +
            "\nfunction naujasKelias() {\n  if (process.env.NIEKADA_NENUSTATYTA) return 9;\n  return 0;\n}\nprocess.exitCode = naujasKelias();\n",
        }
      : x
  );

  const p = pazeidimai({ skriptai: suGamintoju });
  assert.equal(p.length, 1, `laukta 1, gauta ${p.length}:\n  ${p.join("\n  ")}`);
  assert.match(p[0], /pg-backup\.mjs: kodai \{9\}/, "naujo gamintojo kodas privalo būti pastebėtas");
});
