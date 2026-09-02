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

/**
 * ⚠️ ANKSČIAU ČIA BUVO DU TESTAI, KURIE NIEKO NEPRIDĖJO.
 *
 * „VISOS fazės aprašytos" ir „VISI statusai aprašyti" tikrino
 * `doc.includes(reikšmė)`. Bet duomenų modelio blokas dokumento pradžioje
 * išvardija visas fazes ir statusus tipų sąjungoje, tad sąlyga tenkinama
 * VISADA – net pašalinus fazę iš grafo, UI lentelės ir viso aprašymo.
 *
 * Patikrinta: pašalinus `merging` iš UI lentelės krito TIK „UI tekstai susieti
 * su FAZĖS RAKTU". Šie du niekada nekrenta, kai kiti praeina.
 *
 * Jų pavadinimai žadėjo pilnumo garantiją, kurios nebuvo – tai `AGENTS.md`
 * §12.1 atvejis pačiuose sarguose. Pilnumą realiai tikrina grafų, UI tekstų ir
 * terminalių perėjimų testai, kurie lygina POROMIS ir BRIAUNOMIS.
 *
 * Vietoj jų – viena patikra, kurios kiti testai NEDENGIA: kad duomenų modelio
 * blokas atitiktų enum'us.
 */
/**
 * Ištraukia VIENO tipo perėjimų BRIAUNAS iš pažymėto bloko.
 *
 * ⚠️ Grąžinamos briaunos, ne fazių aibė: `validating → diarizing →
 * transcribing → merging` turi tas pačias fazes kaip teisingas kelias, bet
 * state machine tokį gyvavimo ciklą atmeta.
 */
function grafoBriaunos(type) {
  const blokas = new RegExp(
    `<!-- PHASE-GRAPH:${type} -->([\\s\\S]*?)<!-- /PHASE-GRAPH -->`
  ).exec(tekstas());

  assert.ok(blokas, `nerastas PHASE-GRAPH blokas tipui "${type}"`);

  const briaunos = new Set();

  for (const eilute of blokas[1].split("\n")) {
    if (!eilute.includes("→")) continue;

    const grandine = eilute.split("(")[0].trim().replace(/^```.*/, "");
    const mazgai = grandine
      .split("→")
      .map((x) => x.trim())
      .filter(Boolean);

    if (mazgai.length < 2) continue;

    briaunos.add(JSON.stringify([null, mazgai[0]]));

    for (let i = 0; i + 1 < mazgai.length; i += 1) {
      if (Object.values(STATUS).includes(mazgai[i + 1])) continue;
      briaunos.add(JSON.stringify([mazgai[i], mazgai[i + 1]]));
    }
  }

  return briaunos;
}

test("#154 DOKUMENTAS: duomenų modelio blokas atitinka enum'us", () => {
  /**
   * ⚠️ `status` IR `phase` PARSINAMI ATSKIRAI.
   *
   * Ankstesnė versija sudėdavo VISAS kabutėse esančias reikšmes į vieną aibę.
   * Tad sukeitus deklaracijas vietomis — visi statusai į `phase` sąjungą, visos
   * fazės į `status` — aibė nepakisdavo, ir testas praeidavo su visiškai
   * neteisinga dokumentuota schema.
   */
  const t = tekstas();

  const blokas = /<!-- DATA-MODEL -->([\s\S]*?)<!-- \/DATA-MODEL -->/.exec(t);
  assert.ok(blokas, "nerastas DATA-MODEL blokas");

  /** Ištraukia vieno lauko tipų sąjungą: `laukas: "a" | "b" | null,` */
  function saJunga(laukas) {
    const m = new RegExp(`^\\s*${laukas}:\\s*([^,]+(?:\\n[^,]+)*),`, "m").exec(blokas[1]);
    assert.ok(m, `nerasta "${laukas}" deklaracija DATA-MODEL bloke`);
    return new Set([...m[1].matchAll(/"([\w_]+)"/g)].map((x) => x[1]));
  }

  for (const [laukas, enumas] of [
    ["status", Object.values(STATUS)],
    ["phase", Object.values(PHASE)],
  ]) {
    const dokumente = saJunga(laukas);

    const trūksta = enumas.filter((v) => !dokumente.has(v));
    const pertekliniai = [...dokumente].filter((v) => !enumas.includes(v));

    assert.deepEqual(trūksta, [], `"${laukas}" sąjungoje TRŪKSTA: ${trūksta.join(", ")}`);
    assert.deepEqual(
      pertekliniai,
      [],
      `"${laukas}" sąjungoje SVETIMOS reikšmės: ${pertekliniai.join(", ")}`
    );
  }
});

test("#154 DOKUMENTAS: KIEKVIENO tipo PERĖJIMAI atitinka state machine", () => {
  /**
   * Tikrinamos BRIAUNOS, ne fazių aibė: dokumentuota tvarka turi būti legali
   * pagal `transitionsForType()`.
   *
   * Dokumentas deklaruoja PILNĄ grafą, todėl tikrinamos ABI kryptys: dokumente
   * negali būti nelegalios briaunos IR negali trūkti legalios.
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

  /**
   * ⚠️ TIKRINAMAS PAAIŠKINIMO BLOKAS, ne žodžio buvimas.
   *
   * Ankstesnė versija ieškojo `/sinchronin/i` visame dokumente — o jis
   * randamas žodyje „aSINCHRONINį", PRIEŠINGOS reikšmės. Tad visą sinchroninio
   * kvietėjo paaiškinimą buvo galima išbraukti, ir sargas praeidavo.
   *
   * Dabar reikalaujama, kad `routes/generate.js` būtų paminėtas KARTU su
   * paaiškinimu, kad tas kelias fazių neturi.
   */
  const blokas = t
    .split("\n")
    .filter((eil) => eil.includes("routes/generate.js"))
    .join(" ");

  assert.ok(blokas, "dokumentas turi paminėti sinchroninį kvietėją");

  /**
   * ⚠️ PASTRAIPA, ne fiksuoto dydžio langas.
   *
   * 400 simbolių riba yra savavališka: išplėtus paaiškinimą reikalinga frazė
   * iškristų iš pjūvio, ir CI kristų nors kvietėjas bei jo semantika liktų
   * teisingai aprašyti. Tai ta pati klaida, kurią šis failas taiso kitur.
   */
  const eilutes = t.split("\n");
  const eilNr = eilutes.findIndex((e) => e.includes("routes/generate.js"));
  assert.ok(eilNr >= 0, "kelias turi būti dokumente");

  let pradzia = eilNr;
  while (pradzia > 0 && eilutes[pradzia - 1].trim() !== "") pradzia -= 1;

  let pabaiga = eilNr;
  while (pabaiga < eilutes.length - 1 && eilutes[pabaiga + 1].trim() !== "") pabaiga += 1;

  const kontekstas = eilutes.slice(pradzia, pabaiga + 1).join(" ");

  /**
   * ⚠️ ALTERNATYVA BUVO PER PLATI.
   *
   * `sinchronin|be job'o|fazių neturi` tenkinama, jei bloke yra BENT VIENAS
   * variantas — o jame yra ir „SINCHRONINĮ", ir „be job'o". Tad paaiškinimą,
   * kad tas kelias FAZIŲ NETURI, buvo galima išbraukti, ir testas praeidavo.
   *
   * Dabar reikalaujama BŪTENT fazių semantikos, atskirai nuo kvietėjo
   * aprašymo.
   */
  assert.match(
    kontekstas,
    /(?<!a)sinchronin/i,
    "greta kelio turi būti įvardyta, kad kelias sinchroninis"
  );
  assert.match(
    kontekstas,
    /fazių\s+(?:apskritai\s+)?neturi|neturi\s+fazių|be\s+fazių/i,
    "PLIUS atskirai — kad tas kelias fazių neturi"
  );
});

test("#154 DOKUMENTAS: VISOS diarizacijos praleidimo sąlygos aprašytos", () => {
  /**
   * Trumpasis kelias (`validating → transcribing → completed`) galioja TRIMIS
   * atvejais, ne vienu. Operatorius su `inline` provideriu, matydamas tik
   * `DIARIZATION_PROVIDER=none`, gautų neteisingą paaiškinimą, kodėl fazių nėra.
   *
   * ⚠️ SĄLYGOS IŠVARDYTOS ČIA, NE PARSINAMOS IŠ ŠALTINIO.
   *
   * Ankstesnė versija regex'u ištraukdavo sąlygą iš `transcriptionService.js`.
   * Tai tikrino SINTAKSĘ, ne kontraktą: lygiavertis refactoringas
   *
   *     const shouldDiarize = diarize && mode !== "none" && mode !== "inline";
   *     if (shouldDiarize) { ... }
   *
   * sulaužytų testą nepakeitęs nei elgesio, nei dokumentacijos. Tai ta pati
   * klaida, kurią šis failas taiso kitose vietose.
   *
   * Autoritetingas sąrašas gyvena ČIA. Produkcinį elgesį saugo
   * `jobPhasePipeline` testai, kurie tikrina realų fazių srautą.
   *
   * ⚠️ Jei ateityje reikės automatinio kodo↔dokumentacijos ryšio, teisingas
   * sprendimas būtų iškelti `shouldRunExternalDiarization()` kaip testuojamą
   * domeno helperį. Tai produkcinio kodo pakeitimas ir priklauso KODO PR, ne
   * dokumentacijos.
   */
  const t = tekstas();

  /**
   * Trys atvejai, kuriais diarizacijos ir sujungimo fazių nėra.
   *
   * ⚠️ ŠABLONAI TIKRINA SEMANTIKĄ, ne raktažodžius. Ankstesnė versija priimdavo
   * PRIEŠINGĄ prasmę: celė „`mode != "inline"`" turi žodį „inline", o
   * „`diarize` prašyta" turi „diarize". Neigimas tenkindavo tą patį šabloną.
   */
  const ATVEJAI = [
    {
      šablonas: /`diarize`\s+neprašyta|be\s+`diarize`/i,
      draudžiama: /`diarize`\s+prašyta(?!\s*ne)/i,
      kodel: "`diarize` neprašyta užklausoje",
    },
    {
      šablonas: /DIARIZATION_PROVIDER\s*=\s*none/i,
      draudžiama: /DIARIZATION_PROVIDER\s*(!=|≠)\s*none/i,
      kodel: "`DIARIZATION_PROVIDER=none`",
    },
    {
      šablonas: /mode\s*=\s*"inline"/i,
      draudžiama: /mode\s*(!==?|≠)\s*"inline"/i,
      kodel: "natyvi (`inline`) providerio diarizacija",
    },
  ];

  const lentele = [...t.matchAll(/^\| ([^|]+?) \| ([^|]*) \|$/gm)].map((m) => m[1].trim());
  assert.ok(lentele.length > 0, "nerasta atvejų lentelė");

  for (const { šablonas, draudžiama, kodel } of ATVEJAI) {
    const eil = lentele.find((e) => šablonas.test(e));
    assert.ok(eil, `diarizacijos praleidimo atvejis neaprašytas LENTELĖJE: ${kodel}`);

    assert.equal(
      draudžiama.test(eil),
      false,
      `${kodel}: celė aprašo PRIEŠINGĄ sąlygą (neigimą)`
    );
  }
});

test("#154 DOKUMENTAS: nelegalios fazės įvardytos eksplicitiškai", () => {
  const t = tekstas();

  /**
   * ⚠️ DRAUDŽIAMOS FAZĖS IŠVEDAMOS IŠ KODO, ne tikrinama viena.
   *
   * Ankstesnė versija tikrino tik, ar po „Nelegalios fazės:" seka
   * `transcribing`. Tad `diarizing` ir `merging` iš to sąrašo buvo galima
   * ištrinti, ir testas likdavo žalias — nors dokumentuotas draudimas taptų
   * nepilnas.
   */
  const visos = Object.values(PHASE);

  for (const type of [JOB_TYPES.TRANSCRIPTION, JOB_TYPES.PROTOCOL]) {
    const leistinos = phasesForType(type);
    const draudžiamos = visos.filter((f) => !leistinos.includes(f));

    assert.ok(draudžiamos.length > 0, `${type}: prielaida — yra draudžiamų fazių`);

    /** Skyrius nuo tipo antraštės iki kitos `###`. */
    const i = t.indexOf(`### \`${type}\``);
    assert.ok(i > 0, `nerastas skyrius tipui "${type}"`);
    const kitas = t.indexOf("\n### ", i + 1);
    const skyrius = t.slice(i, kitas === -1 ? undefined : kitas);

    for (const faze of draudžiamos) {
      assert.ok(
        new RegExp(`Nelegali(?:os)? fazė(?:s)?:[^\\n]*\`${faze}\``).test(skyrius) ||
          new RegExp(`\`${faze}\``).test(
            (/Nelegali(?:os)? fazė(?:s)?:([\s\S]*?)\n\n/.exec(skyrius) || [, ""])[1]
          ),
        `${type}: draudžiama fazė "${faze}" neįvardyta`
      );
    }
  }
});

test("#154 DOKUMENTAS: griežtumo lentelė atitinka realų elgesį", () => {
  /**
   * ⚠️ Lentelė teigia, KIEK kiekviena operacija tikrina šaltinį. Anksčiau ji
   * sakė, kad `finish()` netikrina „jokios" — bet jis tikrina statuso perėjimo
   * legalumą (`queued → completed` draudžiamas). Teiginys buvo per stiprus, ir
   * niekas jo netikrino.
   *
   * Čia lentelė lyginama su REALIU elgesiu, ne su tekstu.
   */
  const t = tekstas();
  const { finish, restart, startPhase } = require("../utils/jobPhase");

  /** Nenuosekli, bet ne terminali būsena. */
  const sugadintas = { type: JOB_TYPES.PROTOCOL, status: STATUS.PROCESSING, phase: PHASE.TRANSCRIBING };

  const elgesys = {};
  for (const [vardas, fn] of [
    ["finish", () => finish(sugadintas, STATUS.FAILED)],
    ["restart", () => restart(sugadintas)],
    ["startPhase", () => startPhase(sugadintas, PHASE.MERGING)],
  ]) {
    try {
      fn();
      elgesys[vardas] = "toleruoja";
    } catch {
      elgesys[vardas] = "atmeta";
    }
  }

  assert.equal(elgesys.finish, "toleruoja", "prielaida: finish terminalizuoja sugadintą įrašą");
  assert.equal(elgesys.restart, "atmeta");
  assert.equal(elgesys.startPhase, "atmeta");

  /**
   * ⚠️ LYGINAMOS VISOS EILUTĖS, ne tik `finish()`.
   *
   * Ankstesnė versija tikrino tik `finish()` celę, tad `restart()` ar
   * `startPhase()` eilutėse buvo galima parašyti „jokios", ir testas likdavo
   * žalias — nors lentelė teigtų priešingai nei elgesys.
   */
  const LAUKIAMA = {
    "startPhase()": { toleruoja: false, celė: /griežta/i },
    "restart()": { toleruoja: false, celė: /tipas ir fazė/i },
    "finish()": { toleruoja: true, celė: /tik statuso perėjimo/i },
  };

  for (const [op, { toleruoja, celė }] of Object.entries(LAUKIAMA)) {
    const raktas = op.replace("()", "");
    assert.equal(
      elgesys[raktas],
      toleruoja ? "toleruoja" : "atmeta",
      `${op}: elgesys nesutampa su lūkesčiu`
    );

    const eil = t
      .split("\n")
      .find((e) => e.startsWith("|") && e.includes(`\`${op}\``));
    assert.ok(eil, `griežtumo lentelėje nerasta eilutė "${op}"`);

    assert.match(eil, celė, `${op}: lentelės celė neatitinka realaus elgesio`);
    assert.equal(
      /\*\*jokios\*\*/.test(eil),
      false,
      `${op}: „jokios" per stipru — šaltinio patikra egzistuoja`
    );
  }
  assert.match(
    t,
    /queued → completed.*draudžiam|draudžiam.*queued → completed/s,
    "draudimas turi būti įvardytas"
  );
});

test("#154 DOKUMENTAS: terminalūs PERĖJIMAI atitinka finish() semantiką", () => {
  /**
   * ⚠️ Lyginamos POROMIS (šaltinis → tikslas), ne statusų žodžiai.
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
    /**
     * ⚠️ NEŽINOMI TIKSLAI ATMETAMI, ne tyliai išfiltruojami.
     *
     * Ankstesnė versija darė `.filter(x => TERMINAL.includes(x))`, tad
     * dokumentavus neteisėtą tikslą (`processing → completed | failed | queued`)
     * masyvas nepakisdavo ir testas praeidavo — praleisdamas būtent tą
     * papildomą briauną, kurią turėjo atmesti.
     */
    const tikslai = desine
      .split("(")[0]
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);

    const nezinomi = tikslai.filter((x) => !TERMINAL.includes(x));
    assert.deepEqual(
      nezinomi,
      [],
      `terminalių perėjimų bloke NEŽINOMI tikslai: ${nezinomi.join(", ")}`
    );

    dokumente[saltinis] = tikslai;
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
        /**
         * ⚠️ REZULTATAS PERDUODAMAS `completed` ATVEJU (#184, C11).
         *
         * Nuo 7.5b `finish(COMPLETED)` be rezultato metama — bet tai NĖRA
         * perėjimo grafo briauna, o rezultato pilnumo reikalavimas. Šis testas
         * lygina dokumentuotą GRAFĄ su kodu, tad rezultatas paduodamas, kad
         * pilnumo patikra neapsimestų neegzistuojančiu grafo apribojimu.
         */
        finish(job, tikslas, tikslas === STATUS.COMPLETED ? { result: { text: "ok" } } : {});
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

  /**
   * ⚠️ Parsinama TAISYKLIŲ LENTELĖ, ne visas dokumentas.
   *
   * `t.includes(raiska)` praeitų ir tada, kai eilutė iš lentelės pašalinta, bet
   * tas pats tekstas lieka paaiškinime ar kodo pavyzdyje – dokumentuotas
   * kontraktas taptų nepilnas, o testas žalias.
   */
  const blokas = /<!-- PROGRESS-INVARIANTS -->([\s\S]*?)<!-- \/PROGRESS-INVARIANTS -->/.exec(t);
  assert.ok(blokas, "nerastas PROGRESS-INVARIANTS blokas");

  const lentele = [...blokas[1].matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);

  const kode = PROGRESS_INVARIANTS.map(({ raiska }) => raiska);
  const trūksta = kode.filter((r) => !lentele.includes(r));
  const pertekliniai = lentele.filter((r) => !kode.includes(r));

  assert.deepEqual(trūksta, [], `lentelėje TRŪKSTA sąlygų: ${trūksta.join(", ")}`);
  assert.deepEqual(pertekliniai, [], `lentelėje PERTEKLINĖS sąlygos: ${pertekliniai.join(", ")}`);
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
   * ⚠️ SĄRAŠAS RANKINIS, IR TAI YRA APRIBOJIMAS.
   *
   * Ankstesnis komentaras teigė, kad jis „negali tyliai pasenti". Tai per
   * stipru: lyginama tik su dokumentacijos lentele ir failų egzistavimu, tad
   * pridėjus NAUJĄ produkcinį sluoksnį, įgyvendinantį fazių kontraktą, nei
   * viena, nei kita pusė nepasikeičia — inventorius lieka žalias ir nepilnas.
   *
   * Ką sargas realiai garantuoja:
   *   – žinomas sluoksnis negali dingti iš lentelės;
   *   – lentelėje negali būti nesančių failų.
   *
   * Ko NEgarantuoja: kad lentelė apima visus esamus sluoksnius. Tai #154
   * žemėlapis, palaikomas rankiniu būdu.
   */
  const t = tekstas();
  const šaknis = path.resolve(__dirname, "..", "..");

  /** Sluoksniai, kuriuos #154 palietė ir kurie PRIVALO būti lentelėje. */
  const PRIVALOMI = [
    "backend/utils/jobPhase.js",
    "backend/utils/jobStore/index.js",
    "backend/utils/jobStore/memoryStore.js",
    "backend/utils/jobStore/redisStore.js",
    "backend/queues/processors.js",
    "backend/utils/jobResponse.js",
    /**
     * ⚠️ SERVISŲ KELIAI KONKRETŪS, ne katalogas.
     *
     * Lentelėje anksčiau buvo `backend/services/` — o parseris priima tik
     * eksplicitinius `.js` kelius. Tad eilutę su servisais buvo galima
     * ištrinti, ir sargas to nematydavo: `PRIVALOMI` sąraše servisų kelio
     * apskritai nebuvo.
     */
    "backend/services/transcriptionService.js",
    "backend/services/protocolService.js",
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

  /**
   * ⚠️ STRUKTŪRINĖ ŽYMĖ, ne teigiamas šablonas.
   *
   * `/reikalinga IR memory backend/i` tenkinama ir sakinio „Tai NĖRA reikalinga
   * IR memory backend'ui" — o neigiamas šablonas jo nepagauna, nes ieško kitos
   * žodžių tvarkos. Testas praeidavo su PRIEŠINGU kontraktu.
   *
   * `<!-- MEMORY-CAS:required -->` neigimo neturi: reikšmė yra žymėje, ne
   * sakinyje.
   */
  const blokas = /<!-- MEMORY-CAS:required -->([\s\S]*?)<!-- \/MEMORY-CAS -->/.exec(t);
  assert.ok(blokas, "nerasta MEMORY-CAS:required žymė — kontraktas nedeklaruotas");

  assert.equal(
    /\bNĖRA\b|nereikaling/i.test(blokas[1]),
    false,
    "MEMORY-CAS blokas neigia savo paties žymę"
  );

  assert.equal(
    /memory\s+backend'?[ue]\s+CAS\s+nereikalingas/i.test(t),
    false,
    "dokumentas neturi teigti, kad memory backend'ui CAS nereikalingas"
  );
});
