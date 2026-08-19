const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { PHASE, TERMINAL, phasesForType, transitionsForType } = require("../utils/jobPhase");
const { STATUS, JOB_TYPES } = require("../utils/jobStore/common");

/**
 * #154, 9 žingsnis: DOKUMENTACIJA, KURI NEGALI IŠSISKIRTI SU KODU.
 *
 * `docs/job-lifecycle.md` aprašo state machine. Dokumentas, kuris tyliai
 * pasensta, yra blogesnis nei jo nebuvimas: skaitytojas juo pasitiki.
 *
 * Šie testai tikrina SUTAPIMĄ su realiu kodu, ne teksto egzistavimą.
 */

const DOC = path.resolve(__dirname, "..", "..", "docs", "job-lifecycle.md");

function tekstas() {
  return fs.readFileSync(DOC, "utf8");
}

test("#154 DOKUMENTAS: egzistuoja ir yra susietas su matrica", () => {
  assert.ok(fs.existsSync(DOC), "docs/job-lifecycle.md turi egzistuoti");

  const t = tekstas();
  assert.match(t, /security-test-matrix\.md/, "nuoroda į testų garantijas");
});

test("#154 DOKUMENTAS: VISOS fazės aprašytos", () => {
  /**
   * Pridėjus naują fazę į `jobPhase.js`, bet pamiršus dokumentą, skaitytojas
   * matytų nepilną grafą – ir nežinotų, kad jis nepilnas.
   */
  const t = tekstas();

  for (const faze of Object.values(PHASE)) {
    assert.ok(t.includes(faze), `fazė "${faze}" neaprašyta dokumente`);
  }
});

test("#154 DOKUMENTAS: VISI statusai aprašyti", () => {
  const t = tekstas();

  for (const status of Object.values(STATUS)) {
    assert.ok(t.includes(status), `statusas "${status}" neaprašytas`);
  }
});

/**
 * Ištraukia VIENO tipo perėjimų BRIAUNAS iš pažymėto bloko.
 *
 * ⚠️ Grąžinamos briaunos, ne fazių aibė.
 *
 * Ankstesnė versija sudėdavo fazes į `Set` ir lygindavo su `phasesForType()`.
 * Tai praleisdavo NETEISINGĄ TVARKĄ: `validating → diarizing → transcribing →
 * merging` turi tas pačias fazes kaip teisingas kelias, bet state machine tokį
 * gyvavimo ciklą atmeta. Dokumentuotų perėjimų DoD punktas liko nepatikrintas.
 */
function grafoBriaunos(type) {
  const blokas = new RegExp(
    `<!-- PHASE-GRAPH:${type} -->([\\s\\S]*?)<!-- /PHASE-GRAPH -->`
  ).exec(tekstas());

  assert.ok(blokas, `nerastas PHASE-GRAPH blokas tipui "${type}"`);

  const briaunos = new Set();

  for (const eilute of blokas[1].split("\n")) {
    if (!eilute.includes("→")) continue;

    // Nuimam paaiškinimą skliaustuose („(DIARIZATION_PROVIDER=none)").
    const grandine = eilute.split("(")[0].trim().replace(/^```.*/, "");
    const mazgai = grandine
      .split("→")
      .map((x) => x.trim())
      .filter(Boolean);

    if (mazgai.length < 2) continue;

    // Pirmas mazgas – įėjimas iš pradžios (`null`).
    briaunos.add(JSON.stringify([null, mazgai[0]]));

    for (let i = 0; i + 1 < mazgai.length; i += 1) {
      // Terminalūs statusai grafe nėra fazės – jie aprašyti atskirai.
      if (Object.values(STATUS).includes(mazgai[i + 1])) continue;
      briaunos.add(JSON.stringify([mazgai[i], mazgai[i + 1]]));
    }
  }

  return briaunos;
}

test("#154 DOKUMENTAS: KIEKVIENO tipo PERĖJIMAI atitinka state machine", () => {
  /**
   * Tikrinamos BRIAUNOS, ne fazių aibė: dokumentuota tvarka turi būti legali
   * pagal `transitionsForType()`.
   *
   * Dokumentas gali rodyti PAOAIBĮ (pvz. trumpesnį kelią be diarizacijos), bet
   * negali rodyti perėjimo, kurio kodas neleidžia.
   */
  for (const type of [JOB_TYPES.TRANSCRIPTION, JOB_TYPES.PROTOCOL]) {
    const legalios = new Set(transitionsForType(type).map((b) => JSON.stringify(b)));
    const dokumente = grafoBriaunos(type);

    const neteisetos = [...dokumente].filter((b) => !legalios.has(b));
    assert.deepEqual(
      neteisetos.map((b) => JSON.parse(b).join(" → ")),
      [],
      `${type}: dokumente perėjimai, kurių state machine NELEIDŽIA`
    );

    /**
     * ⚠️ ATVIRKŠTINĖ KRYPTIS – BRIAUNOMIS, ne fazėmis.
     *
     * Ankstesnė versija tikrino tik, ar kiekviena FAZĖ kur nors kelyje
     * pasirodo. Pridėjus `GRAPHS` naują legalią briauną tarp jau
     * dokumentuotų fazių (pvz. `validating → diarizing` kaip nuorodą), testas
     * liktų žalias, nors dokumentas praleistų realų perėjimą.
     *
     * Dokumentas skelbiamas PILNU, tad ir tikrinamas kaip pilnas.
     */
    const praleistos = [...legalios].filter((b) => !dokumente.has(b));
    assert.deepEqual(
      praleistos.map((b) => {
        const [from, to] = JSON.parse(b);
        return `${from ?? "START"} → ${to}`;
      }),
      [],
      `${type}: dokumente TRŪKSTA perėjimų, kuriuos state machine leidžia`
    );
  }
});

test("#154 DOKUMENTAS: sinchroninis generateProtocol kvietėjas paminėtas", () => {
  /**
   * `generateProtocol()` turi DU kvietėjus: `protocolProcessor` (asinchroninis,
   * su `onPhase`) ir `routes/generate.js` (sinchroninis, be job'o).
   *
   * Dokumentas anksčiau teigė, kad jis kviečiamas TIK iš processor'iaus. Pagal
   * tokį aprašymą palaikytojas galėtų padaryti servisą priklausomą nuo eilės ar
   * job būsenos ir sulaužyti `POST /api/generate`.
   */
  const t = tekstas();
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "routes", "generate.js"),
    "utf8"
  );

  assert.match(src, /generateProtocol\(/, "prielaida: routes/generate.js kviečia servisą");

  assert.ok(
    t.includes("routes/generate.js"),
    "dokumentas turi paminėti sinchroninį kvietėją"
  );
  assert.match(
    t,
    /sinchronin/i,
    "turi būti paaiškinta, kad tas kelias fazių neturi"
  );
});

test("#154 DOKUMENTAS: VISOS diarizacijos praleidimo sąlygos aprašytos", () => {
  /**
   * `transcriptionService.js` sąlyga yra
   * `diarize && mode !== "none" && mode !== "inline"` – tad trumpasis kelias
   * galioja TRIMIS atvejais, ne vienu.
   *
   * Dokumentas anksčiau minėjo tik `DIARIZATION_PROVIDER=none`, tad operatorius
   * su `inline` provideriu matytų neteisingą paaiškinimą, kodėl fazių nėra.
   */
  const t = tekstas();
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "services", "transcriptionService.js"),
    "utf8"
  );

  const salyga = /if \(diarize && diarizationMode !== "([^"]+)" && diarizationMode !== "([^"]+)"\)/.exec(src);
  assert.ok(salyga, "nerasta diarizacijos sąlyga transcriptionService.js");

  /**
   * ⚠️ Tikrinama ATVEJŲ LENTELĖ, ne visas dokumentas.
   *
   * Sąlyga `diarize && mode !== "none" && mode !== "inline"` cituojama tekste
   * aukščiau, tad paieška visame dokumente rastų „inline" net pašalinus jo
   * eilutę iš lentelės — o būtent lentelė paaiškina operatoriui, kodėl fazių
   * nėra.
   */
  const lentele = [...t.matchAll(/^\| ([^|]+?) \| ([^|]*) \|$/gm)].map((m) => m[1].trim());

  for (const rezimas of [salyga[1], salyga[2]]) {
    assert.ok(
      lentele.some((eil) => eil.includes(`"${rezimas}"`) || eil.includes(`=${rezimas}`)),
      `diarizacijos praleidimo atvejis "${rezimas}" nėra atvejų LENTELĖJE`
    );
  }

  assert.ok(
    lentele.some((eil) => /diarize/.test(eil)),
    "`diarize` neprašymo atvejis turi būti atvejų lentelėje"
  );
});

test("#154 DOKUMENTAS: nelegalios fazės įvardytos eksplicitiškai", () => {
  const t = tekstas();

  assert.match(
    t,
    /Nelegali fazė:\s*\*\*`generating_protocol`\*\*/,
    "transcription: `generating_protocol` draudimas turi būti įvardytas"
  );
  assert.match(
    t,
    /Nelegalios fazės:\s*\*\*`transcribing`\*\*/,
    "protocol: transkripcijos fazių draudimas turi būti įvardytas"
  );
});

test("#154 DOKUMENTAS: terminalūs PERĖJIMAI atitinka finish() semantiką", () => {
  /**
   * ⚠️ Lyginamos PORO S (šaltinis → tikslas), ne statusų žodžiai.
   *
   * Ankstesnė versija tikrino `t.includes(status)` – tad pašalinus visą
   * perėjimų bloką testas liktų žalias, nes tie patys žodžiai minimi duomenų
   * modelio lentelėje. Matrica tuo tarpu teigia, kad visi terminalūs perėjimai
   * saugomi.
   */
  const t = tekstas();
  const { finish } = require("../utils/jobPhase");

  const blokas = /<!-- TERMINAL-TRANSITIONS -->([\s\S]*?)<!-- \/TERMINAL-TRANSITIONS -->/.exec(t);
  assert.ok(blokas, "nerastas TERMINAL-TRANSITIONS blokas");

  /** `{ šaltinis: [tikslai] }` iš dokumento. */
  const dokumente = {};
  for (const eilute of blokas[1].split("\n")) {
    if (!eilute.includes("→")) continue;
    const [kaire, desine] = eilute.split("→");

    const saltinis = kaire.trim().startsWith("processing") ? STATUS.PROCESSING : kaire.trim();
    dokumente[saltinis] = desine
      .split("(")[0]
      .split("|")
      .map((x) => x.trim())
      .filter((x) => TERMINAL.includes(x));
  }

  assert.deepEqual(
    Object.keys(dokumente).sort(),
    [STATUS.PROCESSING, STATUS.QUEUED].sort(),
    "dokumente turi būti aprašyti abu leistini šaltiniai"
  );

  /** Tikrinama prieš REALŲ `finish()` elgesį, ne prieš tekstą. */
  for (const saltinis of [STATUS.QUEUED, STATUS.PROCESSING]) {
    for (const tikslas of TERMINAL) {
      const job = {
        type: JOB_TYPES.PROTOCOL,
        status: saltinis,
        phase: saltinis === STATUS.PROCESSING ? PHASE.VALIDATING : null,
      };

      let leidžia = true;
      try {
        finish(job, tikslas);
      } catch {
        leidžia = false;
      }

      assert.equal(
        dokumente[saltinis].includes(tikslas),
        leidžia,
        `${saltinis} → ${tikslas}: dokumentas ir finish() nesutampa`
      );
    }
  }
});

test("#154 DOKUMENTAS: progreso validacijos taisyklės sutampa su kodu", () => {
  /**
   * ⚠️ SĄLYGOS IMAMOS IŠ EKSPORTUOTO KONTRAKTO, ne iš šaltinio teksto.
   *
   * Buvo dvi silpnesnės versijos:
   *
   *   1. Rankinis keturių sąlygų sąrašas testo viduje – kodas turėjo penkias,
   *      tad `current >= 0` buvo galima pašalinti iš dokumento nepastebimai.
   *   2. `assertValidProgress()` ŠALTINIO parsinimas regex'u – priklausė nuo
   *      sintaksės, ne kontrakto: daugiaeilis `if (`, `&&` sujungimas ar
   *      sąlygos iškėlimas į helperį būtų sulaužę parserį nepakeitę elgesio.
   *      Pakeliui jis dar pagaudavo fragmentus iš lietuviškų komentarų ir
   *      klaidų pranešimų.
   *
   * `PROGRESS_INVARIANTS` deklaruoja kontraktą, o `jobPhase` testai tikrina,
   * kad deklaracija neišsiskirtų su vykdymu.
   */
  const t = tekstas();
  const { PROGRESS_INVARIANTS } = require("../utils/jobPhase");

  assert.ok(PROGRESS_INVARIANTS.length >= 5, "kontraktas turi turėti bent 5 invariantus");

  for (const { raiska } of PROGRESS_INVARIANTS) {
    assert.ok(t.includes(raiska), `progreso sąlyga "${raiska}" neaprašyta dokumente`);
  }
});

test("#154 DOKUMENTAS: NEPERŽADA media-level resume", () => {
  /**
   * ⚠️ Svarbiausias sąžiningumo invariantas. Persistintas `1872/4420` atrodo
   * kaip resume taškas, ir be eksplicitinio paneigimo kas nors #154 supras
   * kaip resumable transcription funkcionalumą.
   */
  const t = tekstas();

  assert.match(t, /NĖRA media-level resume/i, "resume paneigimas turi būti antraštėje");
  assert.match(
    t,
    /nereiškia.*Whisper tęs nuo/s,
    "turi būti paaiškinta, ką persistintas progresas NEreiškia"
  );
});

test("#154 DOKUMENTAS: įgyvendinimo lentelė PILNA, ne tik neklaidinga", () => {
  /**
   * ⚠️ Tikrinamas AUTORITETINIS sąrašas, ne „bent penki keliai".
   *
   * Ankstesnė versija tikrino `keliai.length >= 5` ir kad failai egzistuoja.
   * Tad pašalinus eilutę su `backend/utils/jobResponse.js` liktų penki
   * galiojantys keliai, testas praeitų, o dokumentuotas inventorius būtų
   * NEPILNAS – nors lentelė skelbiama kaip „Kur tai įgyvendinta".
   *
   * Sąrašas rankinis SĄMONINGAI: tai #154 sluoksnių žemėlapis, ne visų failų
   * paieška. Bet jis tikrinamas abiem kryptim, tad negali tyliai pasenti.
   */
  const t = tekstas();
  const šaknis = path.resolve(__dirname, "..", "..");

  /** Sluoksniai, kuriuos #154 palietė ir kurie PRIVALO būti lentelėje. */
  const PRIVALOMI = [
    "backend/utils/jobPhase.js",
    "backend/utils/jobStore/index.js",
    "backend/utils/jobStore/redisStore.js",
    "backend/queues/processors.js",
    "backend/utils/jobResponse.js",
    "frontend/src/utils.js",
  ];

  /**
   * ⚠️ Keliai imami TIK iš „Kur tai įgyvendinta" skyriaus.
   *
   * Ankstesnė versija skenavo VISĄ dokumentą, tad pašalinus eilutę iš lentelės
   * testas vis tiek praeitų, jei tas pats kelias minimas kur nors kitur
   * (pvz. `redisStore.js` paminėtas ir skyriuje apie pavėlavusius įvykius).
   * Codex pastaba buvo būtent apie LENTELĖS pilnumą.
   */
  const pradzia = t.indexOf("## Kur tai įgyvendinta");
  assert.ok(pradzia > 0, "nerastas „Kur tai įgyvendinta“ skyrius");

  const kitasSkyrius = t.indexOf("\n## ", pradzia + 1);
  const lentele = t.slice(pradzia, kitasSkyrius === -1 ? undefined : kitasSkyrius);

  const paminėti = new Set(
    [...lentele.matchAll(/`((?:backend|frontend)\/[\w/.-]+\.js)`/g)].map((m) => m[1])
  );

  const trūksta = PRIVALOMI.filter((k) => !paminėti.has(k));
  assert.deepEqual(
    trūksta,
    [],
    `įgyvendinimo lentelėje trūksta sluoksnių: ${trūksta.join(", ")}`
  );

  // Ir kiekvienas paminėtas kelias turi realiai egzistuoti.
  const nesantys = [...paminėti].filter((k) => !fs.existsSync(path.join(šaknis, k)));
  assert.deepEqual(nesantys, [], `dokumente nurodyti nesantys failai: ${nesantys.join(", ")}`);

  // Privalomi failai turi egzistuoti ir repo – kitaip sąrašas pats pasenęs.
  const dingę = PRIVALOMI.filter((k) => !fs.existsSync(path.join(šaknis, k)));
  assert.deepEqual(dingę, [], `PRIVALOMI sąrašas pasenęs – nėra: ${dingę.join(", ")}`);
});

test("#154 DOKUMENTAS: UI tekstai susieti su FAZĖS RAKTU, ne tik paminėti", () => {
  /**
   * ⚠️ Lyginamos PORŲ (fazė → tekstas), ne tekstų aibės.
   *
   * Ankstesnė versija tikrino `t.includes(tekstas)` – tad sukeitus dviejų
   * fazių tekstus lentelėje testas liktų žalias, nors dokumentas rodytų
   * NETEISINGĄ vartotojui matomą tekstą. Būtent tai ir yra deklaruojama
   * garantija („UI tekstai sutampa su frontend kodu").
   */
  const t = tekstas();
  const utils = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "frontend", "src", "utils.js"),
    "utf8"
  );

  const blokas = utils.slice(
    utils.indexOf("const PHASE_TEKSTAI"),
    utils.indexOf("const APDOROJAMA")
  );
  assert.ok(blokas, "nerastas PHASE_TEKSTAI blokas frontend'e");

  /** `{ faze: tekstas }` iš frontend kodo. */
  const poros = Object.fromEntries(
    [...blokas.matchAll(/^\s*(\w+):\s*"([^"]+)",$/gm)].map((m) => [m[1], m[2]])
  );

  const fazes = Object.values(PHASE);
  assert.deepEqual(
    Object.keys(poros).sort(),
    [...fazes].sort(),
    "frontend PHASE_TEKSTAI turi apimti TIKSLIAI visas fazes"
  );

  /** `{ faze: tekstas }` iš dokumento lentelės. */
  const lentele = Object.fromEntries(
    [...t.matchAll(/^\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|$/gm)]
      .filter(([, faze]) => fazes.includes(faze))
      .map((m) => [m[1], m[2]])
  );

  for (const faze of fazes) {
    assert.ok(lentele[faze], `fazė "${faze}" neaprašyta UI lentelėje`);
    assert.ok(
      lentele[faze].includes(poros[faze]),
      `fazė "${faze}": dokumente „${lentele[faze]}", frontend'e „${poros[faze]}"`
    );
  }
});

test("#154 DOKUMENTAS: neteigia, kad memory backend'ui CAS nereikalingas", () => {
  /**
   * ⚠️ Pasenęs teiginys, kuris PRIEŠTARAUJA kodui.
   *
   * `memoryStore.reportProgressAtomic()` egzistuoja būtent todėl, kad
   * lygiagretūs progreso callback'ai laužydavo monotoniškumą (50 → 60/55 = 55).
   * Dokumentas, teigiantis, kad CAS ten nereikalingas, skatintų tą metodą
   * pašalinti ir grąžinti regresiją.
   *
   * Tikrinama abiem kryptim: teiginio nėra IR metodas realiai egzistuoja.
   */
  const t = tekstas();
  const memory = require("../utils/jobStore/memoryStore");

  assert.equal(
    typeof memory.reportProgressAtomic,
    "function",
    "prielaida: memory backend'as turi atominį kelią"
  );

  assert.equal(
    /memory\s+backend'?ui\s+CAS\s+nereikalingas/i.test(t),
    false,
    "dokumentas neturi teigti, kad memory backend'ui CAS nereikalingas"
  );
  assert.match(t, /reikalinga IR memory backend/i, "turi būti pasakyta atvirkščiai");
});
