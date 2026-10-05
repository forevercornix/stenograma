const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const maintenanceLock = require("../utils/maintenanceLock");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const { analize, eiti } = require("./helpers/astAnalize");

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

/** `jobStore.create(...)` — job'o SUKŪRIMAS. */
function arSukurimas(mazgas) {
  if (mazgas.type !== "CallExpression") return false;
  const k = mazgas.callee;
  return (
    k.type === "MemberExpression" &&
    k.property.type === "Identifier" &&
    k.property.name === "create" &&
    k.object.type === "Identifier" &&
    k.object.name === "jobStore"
  );
}

/** `jobRunner.enqueueTranscription/Protocol(...)` — ĮKĖLIMAS į eilę. */
function arIkelimas(mazgas) {
  if (mazgas.type !== "CallExpression") return false;
  const k = mazgas.callee;
  return (
    k.type === "MemberExpression" &&
    k.property.type === "Identifier" &&
    /^enqueue(Transcription|Protocol)$/.test(k.property.name)
  );
}

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

function vietos(predikatas, failai = produkciniaiFailai()) {
  const rasta = [];
  for (const failas of failai) {
    const tekstas = fs.readFileSync(failas, "utf8");
    const { programa } = analize(tekstas);
    for (const mazgas of eiti(programa)) {
      if (predikatas(mazgas)) {
        rasta.push({ failas: path.relative(SAKNIS, failas), eilute: mazgas.loc.start.line });
      }
    }
  }
  return rasta;
}

test("#440 M1 SAVIKONTROLĖ: detektoriai randa įterptą gamintoją", () => {
  /**
   * ⚠️ BE ŠIOS PATIKROS M1 GALI PRAEITI TUŠČIAI.
   *
   * Jei AST predikatas nustotų atitikti (pakeistas callee formatas, kitas
   * kvietimo stilius), visi „⊆ routes/" tvirtinimai praeitų todėl, kad
   * nerasta NIEKO. Tada sargas rodytų žalią būtent tada, kai apsaugos nebėra.
   */
  const imituotas = `
    const jobStore = require("x");
    async function blogaiWorkeryje() {
      const j = await jobStore.create({ ownerKind: "unowned" });
      await jobRunner.enqueueProtocol(j.id, {});
      await addProtocolJob(j.id, {});
    }
  `;
  const { programa } = analize(imituotas);
  const mazgai = [...eiti(programa)];
  assert.equal(mazgai.filter(arSukurimas).length, 1, "sukūrimo detektorius aklas");
  assert.equal(mazgai.filter(arIkelimas).length, 1, "įkėlimo detektorius aklas");
  assert.equal(mazgai.filter(arProducerVidus).length, 1, "vidinio producer'io detektorius aklas");
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

test("#440 M2: pratęsimas IŠLAIKO garantiją po pradinės nuomos pabaigos", async () => {
  /**
   * ⚠️ PAGRINDINIS §0.2 ATVEJIS.
   *
   * Be pratęsimo ilgesnis nei nuoma atkūrimas tęsdavosi BE užrakto: `create()`
   * vėl priimdavo darbus, o `restoreService` tuo metu vis dar rašydavo.
   *
   * ⚠️ MUTACIJA: pašalinus `setInterval`/`renew()` iš `withLock()` šis testas
   * krenta ties `isLocked()` — garantija nustoja galioti operacijai tebevykstant.
   */
  maintenanceLock._resetForTests();

  let matytaViduje = null;
  const rezultatas = await maintenanceLock.withLock(
    "test_ilgas_atkurimas",
    async () => {
      /** Laukiam ILGIAU nei pradinė nuoma — pratęsimas turi ją pernešti. */
      await new Promise((r) => setTimeout(r, NUOMA_MS * 2.5));
      matytaViduje = maintenanceLock.isLocked();
      return "baigta";
    },
    { maxHoldMs: NUOMA_MS }
  );

  assert.equal(rezultatas.locked, true);
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
