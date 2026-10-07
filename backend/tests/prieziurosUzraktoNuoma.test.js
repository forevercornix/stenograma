const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const maintenanceLock = require("../utils/maintenanceLock");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const restoreService = require("../services/restoreService");
const { analize, eiti, irisimai, arNarioKvietimas } = require("./helpers/astAnalize");

/**
 * #440 — PRIEŽIŪROS UŽRAKTO NUOMA IR GAMINTOJŲ AIBĖ.
 *
 * Du nepriklausomi dalykai, abu iš §0:
 *
 *   §0.1 — langą uždaro tai, kad job'ų GAMINTOJAI gyvena tik API procese.
 *          Čia ta priežastis tampa vykdomu sargu (M1), nes anksčiau ji buvo
 *          tik prozos teiginys komentare.
 *   §0.2 — nuoma pratęsiama, kol operacija gyva (M2), nuimama tik su savo
 *          token'u (grandinė B), o miręs savininkas sistemos neužblokuoja (M3).
 */

/* ───────────────────────── M1: gamintojų aibė ───────────────────────── */

const SAKNIS = path.join(__dirname, "..");

/**
 * PRODUKCINIAI FAILAI — AIBĖ IŠVEDAMA, NE SURAŠOMA (#253 pamoka).
 *
 * Inventorius šioje sekoje klydo penkis kartus (`head`, šablonas, vardų
 * kolizija, nefetch'inta šaka, pozicinis langas), ir visus kartus dėl to, kad
 * filtras buvo „beveik" teisingas. Todėl einama per visą medį, o išskiriami
 * tik `node_modules` ir patys testai.
 */
function produkciniaiFailai(saknis = SAKNIS) {
  const rasti = [];
  (function eitiKatalogu(katalogas) {
    for (const irasas of fs.readdirSync(katalogas, { withFileTypes: true })) {
      if (irasas.name === "node_modules" || irasas.name === "tests") continue;
      const pilnas = path.join(katalogas, irasas.name);
      if (irasas.isDirectory()) eitiKatalogu(pilnas);
      else if (/\.(js|mjs)$/.test(irasas.name)) rasti.push(pilnas);
    }
  })(saknis);
  return rasti;
}

/** Vardai, kuriuos predikatai apskritai gali atitikti. */
const ZENKLAI = Object.freeze(["create", "enqueue", "addTranscriptionJob", "addProtocolJob"]);

/**
 * ⚠️ PIRMINIS FILTRAS — SAUGI VIRŠUTINĖ APROKSIMACIJA, NE ŠABLONO GRĄŽINIMAS.
 *
 * AST lieka VIENINTELIS atitikimo autoritetas (#424 pamoka: tekstas neturi
 * struktūros, tad riba visada yra spėjimas). Filtras nieko neatitikinėja — jis
 * tik atmeta failus, kuriuose atitikties BŪTI NEGALI: visi trys predikatai
 * reikalauja `Identifier` tipo vardo, o identifikatorius šaltinyje visada
 * parašytas pažodžiu. Skaičiuojamoji forma (`x["create"](...)`) predikatų
 * netenkina PAGAL APIBRĖŽIMĄ (reikalaujama `property.type === "Identifier"`),
 * tad jos praleidimas nieko nepaslepia.
 *
 * KAINA: be filtro ir be įsiminimo M1a–M1c darė ~2,3 pilnus medžio parsinimus.
 * Lokaliai tai 7,5 s -> 4,4 s.
 *
 * ⚠️ ŠIS FILTRAS NĖRA PAGRĮSTAS IŠMATUOTA CI DELTA — ir pirmoji šio komentaro
 * redakcija klaidingai tvirtino, kad yra. Palyginimas „kontrolė 466 s prieš
 * `main` 344 s = +122 s" buvo sudarytas prieš VIENĄ sparčiausią `main` matavimą.
 * Keturi `main` matavimai duoda 344/419/438/495 s (diapazonas 151 s), o šios
 * šakos — 466 ir 497 s, t. y. ABU to diapazono vidų. Optimizacija CI laiko
 * nepakeitė.
 *
 * Filtras laikomas todėl, kad mažiau parsinimų prie TO PATIES verdikto yra
 * griežtai geriau, o ne todėl, kad būtų išmatuota CI nauda.
 */
function galiTuretiGamintoja(tekstas) {
  return ZENKLAI.some((zenklas) => tekstas.includes(zenklas));
}

/**
 * Suparsintas medis — ĮSIMENAMAS.
 *
 * Trys M1 testai anksčiau parsindavo tą patį medį iš naujo. Vienas parsinimas,
 * dalijamas tarp jų, duoda tą patį verdiktą be tos kainos.
 */
let _medis = null;
function medis() {
  if (_medis) return _medis;
  _medis = [];
  for (const failas of produkciniaiFailai()) {
    const tekstas = fs.readFileSync(failas, "utf8");
    if (!galiTuretiGamintoja(tekstas)) continue;
    const { programa } = analize(tekstas);
    const mazgai = [...eiti(programa)];
    _medis.push({ failas: path.relative(SAKNIS, failas), mazgai, rista: irisimai(mazgai, KONFIG) });
  }
  return _medis;
}

/**
 * ⚠️ GAMINTOJO PAVIRŠIUS VEDAMAS IŠ MODULIO RIBOS, NE IŠ PAŽODINIO VARDO (#440 P3).
 *
 * Pirmoji šio sargo redakcija atpažino tik `jobStore.create(...)` — pažodinį
 * objekto vardą. Praslystų `const store = jobStore; store.create(...)`,
 * destruktūrizacija `const { create } = jobStore` ir bet koks pervardijimas, o
 * tai griauna būtent tą §0.1 prielaidą, kurią sargas turi vykdyti.
 *
 * ⚠️ Tai ta pati klasė, kurią uždarė #424: riba, vedama iš atsitiktinio
 * paviršiaus vardo, o ne iš mechanizmo. Autoritetinga riba čia yra tai, KAIP
 * modulis gaunamas — `require()` kelias — tad įrišimai išrišami iš jo.
 */
const MODULIO_KELIAI = Object.freeze({
  /** ⚠️ TIK FASADAS. `jobStore/postgresStore` ir kiti backend'ai turi savo `create()`, kurį fasadas teisėtai kviečia. */
  jobStore: /(^|\/)jobStore$/,
  jobRunner: /(^|\/)jobRunner$/,
});

const GAMINTOJO_VARDAI = Object.freeze({
  jobStore: /^create$/,
  jobRunner: /^enqueue(Transcription|Protocol)$/,
});

/**
 * ⚠️ ĮRIŠIMŲ IŠRIŠIMAS IŠKELTAS Į `helpers/astAnalize.js` (#246, #253 taisyklė).
 *
 * Kai to paties kelio prireikė #246 identity sargui, vietinė kopija būtų buvusi
 * antra — o dvi kopijos ilgainiui išsiskiria. Čia lieka tik ŠIO sargo
 * konfigūracija: kurie moduliai ir kurie jų nariai yra gamintojai.
 */
const KONFIG = Object.freeze({
  moduliai: {
    /** ⚠️ TIK FASADAS. `jobStore/postgresStore` ir kiti backend'ai turi savo `create()`, kurį fasadas teisėtai kviečia. */
    jobStore: /(^|\/)jobStore$/,
    jobRunner: /(^|\/)jobRunner$/,
  },
  vardai: {
    jobStore: /^create$/,
    jobRunner: /^enqueue(Transcription|Protocol)$/,
  },
});

const arSukurimas = (mazgas, rista) => arNarioKvietimas(mazgas, "jobStore", rista, KONFIG.vardai);
const arIkelimas = (mazgas, rista) => arNarioKvietimas(mazgas, "jobRunner", rista, KONFIG.vardai);

/** Žemesnio lygio producer'iai — `enqueue()` ir abu `add*Job`. */
function arProducerVidus(mazgas) {
  if (mazgas.type !== "CallExpression") return false;
  const k = mazgas.callee;
  if (k.type === "Identifier") return /^(enqueue|addTranscriptionJob|addProtocolJob)$/.test(k.name);
  if (k.type === "MemberExpression" && k.property.type === "Identifier") {
    return /^(enqueue|addTranscriptionJob|addProtocolJob)$/.test(k.property.name);
  }
  return false;
}

function vietos(predikatas, failai = null) {
  const rasta = [];
  if (failai) {
    /** Aiškiai nurodytas rinkinys parsinamas BE pirminio filtro — žr. M1c. */
    for (const failas of failai) {
      const { programa } = analize(fs.readFileSync(failas, "utf8"));
      const mazgai = [...eiti(programa)];
      const rista = irisimai(mazgai, KONFIG);
      for (const mazgas of mazgai) {
        if (predikatas(mazgas, rista)) rasta.push({ failas: path.relative(SAKNIS, failas), eilute: mazgas.loc.start.line });
      }
    }
    return rasta;
  }
  for (const { failas, mazgai, rista } of medis()) {
    for (const mazgas of mazgai) {
      if (predikatas(mazgas, rista)) rasta.push({ failas, eilute: mazgas.loc.start.line });
    }
  }
  return rasta;
}

test("#440 M1 SAVIKONTROLĖ: pirminis filtras nepaslepia nė vieno gamintojo", () => {
  /**
   * ⚠️ FILTRAS YRA FALSIFIKUOJAMA PRIELAIDA, NE DUOTYBĖ.
   *
   * Jei iš `ZENKLAI` iškristų vardas, atitinkami failai nebebūtų net
   * parsinami, ir M1a–M1b praeitų todėl, kad gamintojo nebepamatė. Todėl
   * tikrinama, kad kiekvienas IŠMATUOTAS gamintojo failas filtrą pereina.
   */
  const gamintojai = ["routes/jobs.js", "routes/transcribeJobs.js", "queues/jobRunner.js"];
  for (const rel of gamintojai) {
    const tekstas = fs.readFileSync(path.join(SAKNIS, rel), "utf8");
    assert.ok(galiTuretiGamintoja(tekstas), `pirminis filtras atmestų gamintoją: ${rel}`);
  }

  /** Ir pats medis privalo būti netuščias — kitaip visi „⊆ routes/" yra tušti. */
  assert.ok(medis().length >= 20, `medyje ${medis().length} failų — filtras per agresyvus`);
});

test("#440 M1 SAVIKONTROLĖ: detektoriai randa gamintoją per ĮRIŠIMUS, ne pažodinį vardą", () => {
  /**
   * ⚠️ BE ŠIOS PATIKROS M1 GALI PRAEITI TUŠČIAI.
   *
   * Jei AST predikatas nustotų atitikti, visi „⊆ routes/" tvirtinimai praeitų
   * todėl, kad nerasta NIEKO — sargas rodytų žalią būtent tada, kai apsaugos
   * nebėra.
   *
   * ⚠️ Tikrinamos VISOS formos, kuriomis gamintojas gali būti pasiekiamas. Tris
   * iš jų pirmoji redakcija praleisdavo (#440 P3).
   */
  const formos = [
    ["pažodinis", 'const jobStore = require("../utils/jobStore"); jobStore.create({});', 1],
    ["alias", 'const jobStore = require("../utils/jobStore"); const store = jobStore; store.create({});', 1],
    ["alias per du žingsnius", 'const jobStore = require("../utils/jobStore"); const a = jobStore; const b = a; b.create({});', 1],
    ["destruktūrizacija", 'const { create } = require("../utils/jobStore"); create({});', 1],
    ["destruktūrizacija su pervardijimu", 'const { create: mk } = require("../utils/jobStore"); mk({});', 1],
    ["tiesiogiai iš require", 'const mk = require("../utils/jobStore").create; mk({});', 1],
    ["⚠️ SVETIMAS `create` NESKAIČIUOJAMAS", 'const kitas = require("./kazkas"); kitas.create({});', 0],
    ["⚠️ BACKEND'O `create` NESKAIČIUOJAMAS", 'const s = require("../utils/jobStore/postgresStore"); s.create({});', 0],
  ];

  for (const [vardas, kodas, laukta] of formos) {
    const { programa } = analize(kodas);
    const mazgai = [...eiti(programa)];
    const rista = irisimai(mazgai, KONFIG);
    const rasta = mazgai.filter((m) => arSukurimas(m, rista)).length;
    assert.equal(rasta, laukta, `forma „${vardas}": rasta ${rasta}, laukta ${laukta}`);
  }

  /** Ta pati garantija įkėlimo pusėje. */
  const ikelimas = 'const jr = require("../queues/jobRunner"); const r = jr; r.enqueueProtocol("id", {});';
  const { programa } = analize(ikelimas);
  const mazgai = [...eiti(programa)];
  assert.equal(mazgai.filter((m) => arIkelimas(m, irisimai(mazgai, KONFIG))).length, 1, "įkėlimo alias praslydo");

  /** Vidinio producer'io detektorius įrišimų nereikalauja — vardinis, mažam rinkiniui. */
  const vidus = "await addProtocolJob(id, {});";
  const vp = analize(vidus);
  assert.equal([...eiti(vp.programa)].filter(arProducerVidus).length, 1, "vidinio producer'io detektorius aklas");
});

test("#440 M1a: `jobStore.create()` produkcijoje kviečiamas TIK iš `routes/`", () => {
  /**
   * ŠIS SARGAS YRA §0.1 IŠVADOS VYKDYMAS.
   *
   * Vietinio užrakto pakanka ne todėl, kad jis bendras, o todėl, kad gamyba
   * yra vienaprocesė: `create()` patikra (`jobStore/index.js`) gyvena tame
   * pačiame procese, kuris laiko užraktą. Gamintojui atsiradus bet kur už
   * `routes/` — pvz. worker'yje ar sweeper'yje — ta prielaida nustotų galioti
   * TYLIAI. Dabar ji nustos galioti su krentančiu testu.
   */
  const rasta = vietos(arSukurimas);
  assert.ok(rasta.length >= 2, `rasta ${rasta.length} vietų — detektorius turi matyti bent du maršrutus`);
  const uzRoutes = rasta.filter((v) => !v.failas.startsWith("routes/"));
  assert.deepEqual(uzRoutes, [], `job'ą kuria ne API procesas:\n${uzRoutes.map((v) => `${v.failas}:${v.eilute}`).join("\n")}`);
});

test("#440 M1b: `jobRunner.enqueue*()` produkcijoje kviečiamas TIK iš `routes/`", () => {
  const rasta = vietos(arIkelimas);
  assert.ok(rasta.length >= 2, `rasta ${rasta.length} vietų — turi būti bent du maršrutai`);
  const uzRoutes = rasta.filter((v) => !v.failas.startsWith("routes/"));
  assert.deepEqual(uzRoutes, [], `į eilę įkelia ne API procesas:\n${uzRoutes.map((v) => `${v.failas}:${v.eilute}`).join("\n")}`);
});

test("#440 M1c ⚠️ WORKER'IŲ PROCESAI NEGAMINA — nulis gamintojų", () => {
  /**
   * TIESIOGINIS §0.1 TEIGINYS: `--scale transcription-worker=3` saugus, nes
   * worker'iai tik vartoja eilę. Šis testas yra vienintelė vieta, kur tas
   * teiginys tikrinamas, o ne tik užrašomas.
   *
   * ⚠️ Aibė IŠVEDAMA iš produkcinių failų sąrašo pagal kelią, ne surašoma.
   */
  const vartotojai = produkciniaiFailai().filter((f) => {
    const rel = path.relative(SAKNIS, f);
    return rel.startsWith("workers/") || rel === path.join("queues", "processors.js");
  });
  assert.ok(vartotojai.length >= 4, `rasta ${vartotojai.length} vartotojų failų — aibė per maža, filtras sugedo`);

  for (const predikatas of [arSukurimas, arIkelimas, arProducerVidus]) {
    const rasta = vietos(predikatas, vartotojai);
    assert.deepEqual(rasta, [], `vartotojo failas gamina darbą:\n${rasta.map((v) => `${v.failas}:${v.eilute}`).join("\n")}`);
  }
});

/* ───────────────────── §0.2: nuoma, pratęsimas, fencing ───────────────────── */

const NUOMA_MS = 120;

test("#440 M2a MECHANIZMAS: `renew()` perneša nuomą už PRADINĖS pabaigos", async () => {
  /**
   * ⚠️ DETERMINISTINĖ M2 pusė.
   *
   * Tikrinamas pats pratęsimo mechanizmas, be laikmačių sutapimo: nuoma
   * paimama trumpa, pratęsiama ilga, ir po to palaukiama gerokai už PRADINĖS
   * pabaigos.
   *
   * ⚠️ PRADINĖ NUOMA 400 ms, NE 40 ms. Su 40 ms testas krisdavo atsitiktinai:
   * badavimas tarp `acquire()` ir `renew()` nuomą perkirsdavo, `renew()`
   * teisėtai grąžindavo `renewed: false` (fail-closed), ir testas rodydavo
   * gedimą ten, kur elgsena teisinga. Pratęsta nuoma — 60 s, tad verdiktas
   * po 700 ms nepriklauso nuo tvarkaraščio.
   */
  maintenanceLock._resetForTests();

  const nuoma = maintenanceLock.acquire("test_mechanizmas", { maxHoldMs: 400 });
  assert.equal(maintenanceLock.renew(nuoma.token, { maxHoldMs: 60_000 }).renewed, true);

  await new Promise((r) => setTimeout(r, 700));

  assert.equal(maintenanceLock.isLocked(), true, "pratęsta nuoma privalo galioti už pradinės pabaigos");
  assert.equal(maintenanceLock.release(nuoma.token).released, true);
});

test("#440 M2b: `withLock()` pratęsinėja PATS, be kvietėjo pagalbos", async () => {
  /**
   * ⚠️ PAGRINDINIS §0.2 ATVEJIS, INTEGRACINIS.
   *
   * Be pratęsimo ilgesnis nei nuoma atkūrimas tęsdavosi BE užrakto: `create()`
   * vėl priimdavo darbus, o `restoreService` tuo metu vis dar rašydavo.
   *
   * ⚠️ MUTACIJA: pašalinus `setInterval`/`renew()` iš `withLock()` nuoma
   * pasibaigia po `NUOMA_MS`, o operacija vykdoma ilgiau — testas krenta ties
   * `matytaViduje` DETERMINISTIŠKAI (pratęsimo nebėra visai).
   *
   * ⚠️ Nuoma sąmoningai DIDELĖ (1 s), o pratęsimo periodas — trečdalis. Su
   * trumpesne nuoma testas krisdavo atsitiktinai: vienos branduolio mašinoje
   * laikmačiai gali būti atidėti ilgiau nei visa nuoma, ir garantija teisėtai
   * nutrūkdavo. Čia tikrinama pratęsimo LOGIKA, ne runner'io tvarkaraštis.
   */
  maintenanceLock._resetForTests();

  let matytaViduje = null;
  const rezultatas = await maintenanceLock.withLock(
    "test_ilgas_atkurimas",
    async () => {
      await new Promise((r) => setTimeout(r, 1400));
      matytaViduje = maintenanceLock.isLocked();
      return "baigta";
    },
    { maxHoldMs: 1000 }
  );

  assert.equal(rezultatas.locked, true);
  assert.notEqual(rezultatas.leaseLost, true, "pratęsimas turėjo išlaikyti nuomą");
  assert.equal(rezultatas.value, "baigta");
  assert.equal(matytaViduje, true, "nuoma turi galioti VISĄ operacijos laiką");
  assert.equal(maintenanceLock.isLocked(), false, "po operacijos nuoma nuimama");
});

test("#440 GRANDINĖ B: pasenęs savininkas NEGALI nuimti naujos nuomos", () => {
  /**
   * ⚠️ ATSKIRA MUTACIJA, NE M2 DALIS.
   *
   * M2 tikrina PRATĘSIMĄ, o ši — SAVININKĄ. Be fencing'o grandinė B išlieka
   * net su pratęsimu: `release()` be token'o patikros nuimdavo svetimą nuomą.
   *
   * ⚠️ MUTACIJA: pašalinus `_lock.token !== token` patikrą iš `release()`
   * krenta būtent šis testas.
   */
  maintenanceLock._resetForTests();

  const pirmas = maintenanceLock.acquire("pirmas", { maxHoldMs: 1 });
  assert.equal(pirmas.acquired, true);
  assert.ok(Number.isInteger(pirmas.token), "nuoma turi turėti token'ą");

  /** Pirmoji nuoma pasibaigia; antras savininkas ją teisėtai perima. */
  const laukti = Date.now() + 5;
  while (Date.now() < laukti) { /* trumpas sinchroninis laukimas */ }
  const antras = maintenanceLock.acquire("antras", { maxHoldMs: 60_000 });
  assert.equal(antras.acquired, true);
  assert.notEqual(antras.token, pirmas.token, "token'ai negali sutapti");

  /** PIRMOJO `finally release()` — svetimos nuomos atlaisvinimas. */
  const atmesta = maintenanceLock.release(pirmas.token);
  assert.equal(atmesta.released, false, "svetimos nuomos atlaisvinimas turi būti ATMESTAS");
  assert.equal(maintenanceLock.isLocked(), true, "antrojo savininko nuoma privalo IŠLIKTI");

  /** Ir pratęsti svetimos irgi negalima. */
  assert.equal(maintenanceLock.renew(pirmas.token).renewed, false);

  /** O savo — galima. */
  assert.equal(maintenanceLock.release(antras.token).released, true);
  assert.equal(maintenanceLock.isLocked(), false);
});

test("#440 M3 TEIGIAMA KONTROLĖ: miręs savininkas sistemos neužblokuoja (D4)", () => {
  /**
   * ⚠️ BE ŠIOS KONTROLĖS M2 PATAISA GALĖTŲ PANAIKINTI PRIEŽASTĮ, DĖL KURIOS
   * NUOMA APSKRITAI EGZISTUOJA.
   *
   * Pratęsimą daro tik gyvas procesas. Čia imituojamas miręs savininkas:
   * nuoma paimta be `withLock()`, tad niekas jos nepratęsia — ir sistema
   * privalo atsilaisvinti be restarto.
   */
  maintenanceLock._resetForTests();

  const mires = maintenanceLock.acquire("mires_savininkas", { maxHoldMs: 1 });
  assert.equal(mires.acquired, true);

  const laukti = Date.now() + 5;
  while (Date.now() < laukti) { /* trumpas sinchroninis laukimas */ }

  assert.equal(maintenanceLock.isLocked(), false, "pasibaigusi nuoma NEBEGALIOJA");
  assert.equal(maintenanceLock.renew(mires.token).renewed, false, "pasibaigusios nuomos pratęsti negalima (fail-closed)");

  const naujas = maintenanceLock.acquire("po_atsigavimo");
  assert.equal(naujas.acquired, true, "sistema privalo atsigauti be restarto");
  maintenanceLock.release(naujas.token);
});

test("#440 atviras kl. 2: `status()` ir `isLocked()` būsenos NEMUTUOJA", () => {
  /**
   * Anksčiau nurašymas buvo `isLocked()` šalutinis poveikis, o `status()` jį
   * kviesdavo — tad diagnostinis skaitymas sunaikindavo nuomą.
   *
   * STEBIMAS SKIRTUMAS: po pasibaigimo savininkas dar gali nuimti SAVO nuomą.
   * Su senuoju elgesiu `status()` būtų ją jau nurašęs, ir `release()` grąžintų
   * „nuomos nėra" — t. y. skaitymas pakeistų kito kvietėjo rezultatą.
   */
  maintenanceLock._resetForTests();

  const savininkas = maintenanceLock.acquire("diagnostika", { maxHoldMs: 1 });
  const laukti = Date.now() + 5;
  while (Date.now() < laukti) { /* trumpas sinchroninis laukimas */ }

  for (let i = 0; i < 5; i += 1) {
    assert.equal(maintenanceLock.status().locked, false);
    assert.equal(maintenanceLock.isLocked(), false);
  }

  assert.equal(
    maintenanceLock.release(savininkas.token).released,
    true,
    "skaitymas neturi nurašyti nuomos už savininką"
  );
});

/* ─────────────── M4 / D3: worker'io priėmimo savybė nepakitusi ─────────────── */

test("#440 M4 (D3): užrakto metu darbas NEPRADEDAMAS ir NEPAŽYMIMAS `failed`", async () => {
  /**
   * D3 saugo SAVYBĘ, ne realizaciją: užrakto metu naujas procesoriaus darbas
   * nepradedamas, ir vien dėl priežiūros job'as nepažymimas nesėkme (kitaip
   * BullMQ rodytų galutinę klaidą ten, kur nieko nepavyko tik dėl laiko).
   *
   * ⚠️ MUTACIJA: pavertus praleidimą klaida (`throw` vietoj `return`)
   * `queues/jobRunner.js` užrakto šakoje — krenta šis testas.
   */
  maintenanceLock._resetForTests();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  let kviestas = 0;
  jobRunner.registerProcessor("protocol", async () => {
    kviestas += 1;
    return { protocol: "neturėjo būti vykdoma" };
  });

  const nuoma = maintenanceLock.acquire("test_worker_praleidimas");
  try {
    await jobRunner._runInline("protocol", job.id, { transcript: "tekstas" });
  } finally {
    maintenanceLock.release(nuoma.token);
  }

  assert.equal(kviestas, 0, "užrakto metu procesorius neturi būti kviečiamas");
  const po = await jobStore.system.get(job.id, { hydrate: false });
  assert.notEqual(po.status, "failed", "⚠️ priežiūra NĖRA nesėkmė — job'as privalo likti vykdomas vėliau");
});

/* ─────────── P1: prarasta nuoma STABDO operaciją, ne tik žurnaluoja ─────────── */

test("#440 P1a: nuomos praradimas PERDUODAMAS į operaciją kaip signalas", async () => {
  /**
   * ⚠️ `withLock()` VIENAS NEGALI SUSTABDYTI RAŠYMO.
   *
   * Jis reaguoja tik po to, kai `operation()` išsisprendžia — o tada kiekvienas
   * atkūrimo rašymas jau įvykęs. Todėl operacija gauna `AbortSignal`.
   *
   * ⚠️ PRARADIMAS PRIVERČIAMAS, NE IŠGAUNAMAS IŠ LAIKMAČIŲ SUTAPIMO.
   * Pirmoji šio testo redakcija rėmėsi trumpa nuoma, bet su pratęsimu nuoma
   * tiesiog nesibaigdavo (pratęsimo periodas < nuomos), ir testas praeidavo
   * atsitiktinai. Dabar nuoma PERIMAMA operacijos viduje: nuo to momento
   * `renew(token)` grąžina `renewed: false` deterministiškai — tiksliai ta
   * baigtis, kurią reikia patikrinti.
   *
   * ⚠️ MUTACIJA: pašalinus `stabdymas.abort(...)` iš pratęsimo laikmačio
   * signalas nesuveikia niekada ir testas krenta ties `signalasSuveike`.
   */
  maintenanceLock._resetForTests();

  let signalasSuveike = false;
  let priezastisKodas = null;

  const rezultatas = await maintenanceLock.withLock(
    "test_prarasta_nuoma",
    async (signal) => {
      signal.addEventListener("abort", () => {
        signalasSuveike = true;
        priezastisKodas = signal.reason && signal.reason.code;
      });

      /** Nuomą perima kitas savininkas — mūsų token'as nebegalioja. */
      maintenanceLock._resetForTests();
      maintenanceLock.acquire("kitas_atkurimas", { maxHoldMs: 60_000 });

      /** Laukiam bent kelių pratęsimo ciklų. */
      for (let i = 0; i < 50 && !signalasSuveike; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return "operacija_nepaklausė";
    },
    { maxHoldMs: 30 }
  );

  assert.equal(signalasSuveike, true, "operacija privalo GAUTI nuomos praradimo signalą");
  assert.equal(priezastisKodas, "MAINTENANCE_LEASE_LOST", "priežastis turi būti atpažįstama, ne bendras Error");

  /**
   * ⚠️ ATSARGINIS SLUOKSNIS: operacija signalo nepaklausė ir grąžino reikšmę.
   * Baigtis vis tiek NĖRA sėkmė — prielaida, kuria operacija rėmėsi, negaliojo.
   */
  assert.equal(rezultatas.leaseLost, true, "prarasta nuoma negali būti grąžinta kaip sėkmė");

  maintenanceLock._resetForTests();
});

test("#440 P1b ⚠️ RAŠYMAS SUSTOJA: `_apply()` barjeras nutraukia atkūrimą vidury", async () => {
  /**
   * ⚠️ TAI PAGRINDINIS P1 ĮRODYMAS.
   *
   * Nepakanka, kad baigtis būtų pažymėta nepatikima: tuo metu KITAS atkūrimas
   * jau gali teisėtai laikyti nuomą ir rašyti tuos pačius `id`. Todėl
   * tikrinamas MUTACIJŲ granuliarumas — kad po nuomos praradimo nebeįvyksta
   * nė vienas tolesnis rašymas.
   *
   * ⚠️ MUTACIJA: pašalinus `_patikrintiNuoma()` kvietimą iš `_apply()` job'ų
   * ciklo atkūrimas pabaigia visus tris įrašus ir testas krenta ties `rasyta`.
   */
  const stabdymas = new AbortController();
  const rasyta = [];

  const tikrasRestore = jobStore.restoreRecord;
  jobStore.restoreRecord = async (job) => {
    rasyta.push(job.id);
    /** Nuoma prarandama PO pirmo rašymo — tiksliai tas atvejis, kurį saugom. */
    if (rasyta.length === 1) {
      stabdymas.abort(new maintenanceLock.LeaseLostError("test", 1, "pratęsimas nepavyko"));
    }
    return job;
  };

  try {
    await assert.rejects(
      () =>
        restoreService._apply(
          { jobs: [{ id: "a" }, { id: "b" }, { id: "c" }], audio: [] },
          { env: {}, signal: stabdymas.signal }
        ),
      (e) => e.code === "MAINTENANCE_LEASE_LOST",
      "atkūrimas privalo NUTRŪKTI, ne tęstis"
    );
  } finally {
    jobStore.restoreRecord = tikrasRestore;
  }

  assert.deepEqual(rasyta, ["a"], `po nuomos praradimo rašymas tęsėsi: ${rasyta.join(",")}`);
});

test("#440 P1c: be signalo `_apply()` elgiasi kaip anksčiau (neigiama kontrolė)", async () => {
  /**
   * ⚠️ BE ŠIOS KONTROLĖS P1b galėtų praeiti dėl to, kad barjeras meta VISADA.
   * Tada atkūrimas niekada nebeveiktų, o testas vis tiek būtų žalias.
   */
  const rasyta = [];
  const tikrasRestore = jobStore.restoreRecord;
  jobStore.restoreRecord = async (job) => {
    rasyta.push(job.id);
    return job;
  };
  try {
    const rezultatas = await restoreService._apply(
      { jobs: [{ id: "a" }, { id: "b" }], audio: [] },
      { env: {} }
    );
    assert.equal(rezultatas.jobs, 2);
  } finally {
    jobStore.restoreRecord = tikrasRestore;
  }
  assert.deepEqual(rasyta, ["a", "b"], "be signalo visi įrašai turi būti atkurti");
});
