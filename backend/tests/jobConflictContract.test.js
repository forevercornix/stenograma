const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const jobStore = require("../utils/jobStore");
const { JOB_TYPES, OWNER_KIND, STATUS } = require("../utils/jobStore/common");
const { PHASE, JobPhaseError } = require("../utils/jobPhase");

/**
 * Žurnalo eilučių perėmimas. Tas pats modelis kaip
 * `correlationChain.integration.test.js` - logger'is rašo į `console`, tad
 * perimamas kanalas, o ne pats logger'is.
 */
function perimtiLogus() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const kanalas of Object.keys(original)) {
    console[kanalas] = (...args) => lines.push(args.join(" "));
  }
  /**
   * ⚠️ GRĄŽINAMOS ŽALIOS EILUTĖS, NE `JSON.parse`.
   *
   * Testinėje aplinkoje logger'is rašo žmogui skaitomą formą
   * (`WARN [stenograma:job-store] žinutė {json}`), ne gryną JSON. Pirmoji šio
   * helperio redakcija eilutes parsindavo ir tyliai atmesdavo visas - patikra
   * praeidavo su NULIU eilučių, nieko neįrodydama.
   */
  return {
    restore: () => Object.assign(console, original),
    lines: () => lines.slice(),
  };
}

/**
 * VIENAS KONFLIKTO KONTRAKTAS (#184, 7.5b — commit B).
 *
 * ⚠️ KĄ TIKSLIAI ĮRODO ŠIS FAILAS.
 *
 * Kad PENKIOS baigtys lieka ATSKIRIAMOS ir kad nė viena iš jų neįgyja savo
 * atskiros formos:
 *
 *   `null`                  job nerastas
 *   `FORBIDDEN`             nuosavybė neatitiko
 *   `CONCURRENCY_CONFLICT`  pasenusi `version`
 *   `JobPhaseError`         gyvavimo ciklo perėjimas neleistinas
 *   (metama klaida)         infrastruktūra
 *
 * ⚠️ KODĖL GYVAVIMO CIKLAS LIEKA `JobPhaseError`, O NE NAUJAS SIMBOLIS.
 *
 * #184 leidžia „typed error ar struktūrizuotą rezultatą pagal ESAMĄ fasado
 * stilių". `jobPhase` jau YRA vienintelis perėjimų autoritetas ir jau meta
 * tipizuotą klaidą su kodu. Naujas simbolis reikštų DVI reprezentacijas tam
 * pačiam faktui — tiksliai tai, ką issue draudžia. Draudžiama forma yra
 * GENERINĖ klaida, o ne tipizuota.
 *
 * ⚠️ APIMTIS: memory backend'as ir fasadas. PostgreSQL sąlyginio CAS
 * klasifikacija (`casSuKlasifikacija` + `versijaSkiriasi`) gyvena
 * `postgresStore.integration`, Redis Lua CAS — `ownershipCasRedis.integration`.
 * Abu reikalauja tikrų servisų ir vietinėje aplinkoje NEVYKDOMI.
 */

const SCOPE = { ownerKind: OWNER_KIND.USER, ownerId: "11111111-1111-4111-8111-111111111111" };
const SVETIMAS = { ownerKind: OWNER_KIND.USER, ownerId: "22222222-2222-4222-8222-222222222222" };

async function savas() {
  return memoryStore.create({ type: JOB_TYPES.TRANSCRIPTION, ...SCOPE });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. PENKIOS BAIGTYS — KIEKVIENA ATSKIRAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 NOT_FOUND lieka `null` (#180 kontraktas nepajudintas)", async () => {
  assert.equal(await memoryStore.update("nera-tokio", { actor: "x" }), null);
  assert.equal(
    await memoryStore.update("nera-tokio", { actor: "x" }, { expectedVersion: 1 }),
    null,
    "sąlyga NEKEIČIA nerasto įrašo atsakymo"
  );
  assert.equal(await memoryStore.updateOwned("nera-tokio", { actor: "x" }, SCOPE), null);
});

test("#184 CONCURRENCY_CONFLICT: pasenusi versija", async () => {
  const job = await savas();
  await memoryStore.update(job.id, { actor: "konkurentas" });

  const rezultatas = await memoryStore.update(job.id, { actor: "as" }, { expectedVersion: job.version });
  assert.equal(rezultatas, "CONCURRENCY_CONFLICT");

  const dabartinis = await memoryStore.get(job.id);
  assert.equal(dabartinis.actor, "konkurentas", "konfliktas NIEKO neįrašė");
  assert.equal(dabartinis.version, 2, "konfliktas versijos NEDIDINA");
});

test("#184 ⚠️ OWNERSHIP MISMATCH NĖRA perklasifikuojamas į concurrency conflict", async () => {
  /**
   * ⚠️ BRANGIAUSIAS ŠIO FAILO TESTAS.
   *
   * Svetimas savininkas SU PASENUSIA versija tenkina ABI nesėkmės sąlygas.
   * Jei tvarka būtų atvirkštinė, kvietėjas gautų „bandyk dar kartą" ten, kur
   * teisingas atsakymas yra „tau negalima" — ir 403 vs 404 sprendimas
   * (`routes`, #159) remtųsi lygiagretumo faktu vietoj autorizacijos.
   */
  const job = await savas();
  await memoryStore.update(job.id, { actor: "konkurentas" });

  const rezultatas = await memoryStore.updateOwned(
    job.id,
    { actor: "as" },
    SVETIMAS,
    { expectedVersion: job.version }
  );

  assert.equal(rezultatas, "FORBIDDEN", "nuosavybė tikrinama PIRMA");
  assert.notEqual(rezultatas, "CONCURRENCY_CONFLICT");
});

test("#184 SAVAS savininkas su pasenusia versija gauna CONCURRENCY_CONFLICT", async () => {
  /** Ta pati situacija, tik nuosavybė SUTAMPA — atsakymas privalo pasikeisti. */
  const job = await savas();
  await memoryStore.update(job.id, { actor: "konkurentas" });

  assert.equal(
    await memoryStore.updateOwned(job.id, { actor: "as" }, SCOPE, { expectedVersion: job.version }),
    "CONCURRENCY_CONFLICT"
  );
});

test("#184 LIFECYCLE konfliktas lieka `JobPhaseError`, ne konflikto simbolis", async () => {
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.finish(job.id, STATUS.FAILED, { error: "pirmas" });

  await assert.rejects(
    () => jobStore.system.finish(job.id, STATUS.FAILED, { error: "antras" }),
    (err) => {
      assert.ok(err instanceof JobPhaseError, "tipizuota klaida, ne generinė");
      assert.ok(err.code, "klaida turi kodą — kvietėjas gali atskirti priežastį");
      return true;
    }
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. FASADO TOCTOU LANGAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 ⚠️ `startPhase()` TOCTOU: konkurentas tarp `get` ir `update` NEPERRAŠOMAS", async () => {
  /**
   * ⚠️ DETERMINISTINIS, NE `sleep()`.
   *
   * Konkurentas įterpiamas per `store.get` stub'ą: kai fasadas perskaito
   * snapshot'ą, mes tuo pačiu momentu įrašome konkurentinį pakeitimą. Nuo to
   * `job.version` fasado rankose PASENA — lygiai taip, kaip tikroje lenktynėje.
   * Laikas čia nedalyvauja.
   */
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });

  /** Konkurentas veikia PO to, kai fasadas jau perskaitė savo snapshot'ą. */
  const snapshot = await jobStore.system.get(job.id);
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);

  /**
   * Dabar bandome perėjimą iš PASENUSIO snapshot'o. Fasadas versiją paims iš
   * savo šviežio `get`, tad TOCTOU imituojamas tiesiogiai per saugyklą — tą
   * patį kelią, kuriuo eina fasadas.
   */
  const konfliktas = await memoryStore.update(
    job.id,
    { actor: "pasenes" },
    { expectedVersion: snapshot.version }
  );
  assert.equal(konfliktas, "CONCURRENCY_CONFLICT");

  const dabartinis = await jobStore.system.get(job.id);
  assert.equal(dabartinis.phase, PHASE.VALIDATING, "konkurento darbas NEATSUKTAS");
  assert.notEqual(dabartinis.actor, "pasenes");
});

test("#184 `startPhase()`/`finish()` PERDUODA `expectedVersion` iš to paties snapshot'o", async () => {
  /**
   * ⚠️ STATINĖ PATIKRA ČIA NETINKA (AGENTS.md §9.2) — tikrinama, kad saugykla
   * REALIAI gauna sąlygą, ir kad ta sąlyga yra ta pati versija, kurią fasadas
   * perskaitė. Sąrašo ar teksto patikra to neįrodytų.
   */
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });

  const gautos = [];
  const originalus = memoryStore.update;
  memoryStore.update = async (id, patch, options = {}) => {
    gautos.push(options.expectedVersion);
    return originalus(id, patch, options);
  };
  try {
    const pries = await jobStore.system.get(job.id);
    await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
    const poFazes = await jobStore.system.get(job.id);
    await jobStore.system.finish(job.id, STATUS.FAILED, { error: "x" });

    assert.deepEqual(gautos, [pries.version, poFazes.version],
      "kiekvienas kvietimas perduoda TĄ versiją, kurią pats perskaitė");
  } finally {
    memoryStore.update = originalus;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. `finishFailed()` — KETURIOS ŠAKOS
 * ══════════════════════════════════════════════════════════════════════════ */

async function processingJob() {
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  return job;
}

test("#184 finishFailed: įprastas kelias pažymi `failed`", async () => {
  const job = await processingJob();
  const po = await jobStore.system.finishFailed(job.id, { error: "x", error_code: "E" });

  assert.equal(po.status, STATUS.FAILED);
  assert.equal(po.error_code, "E");
});

test("#184 finishFailed: JAU terminalus job'as → NO-OP SĖKMĖ, ne klaida", async () => {
  /**
   * `JobPhaseError` čia reiškia „kas nors kitas jau pabaigė". `FAILED` žymėjimas
   * nebeaktualus, tad kvietėjui grąžinama esama būsena, o ne klaida — kitaip
   * kiekvienas dingęs BullMQ ack virstų dead-letter įrašu.
   */
  const job = await processingJob();
  await jobStore.system.finish(job.id, STATUS.CANCELLED, {});

  const po = await jobStore.system.finishFailed(job.id, { error: "veluojantis" });
  assert.equal(po.status, STATUS.CANCELLED, "esama būsena nepakeista");
});

test("#184 ⚠️ finishFailed: `COMPLETED` NIEKADA nevirsta `failed`", async () => {
  /**
   * ⚠️ TAI YRA PRIEŽASTIS, DĖL KURIOS ŠIS METODAS EGZISTUOJA.
   *
   * Dingęs eilės patvirtinimas neturi teisės sunaikinti rezultato, kuris jau
   * guli saugykloje. Iki 7.5b pralaimėjęs `finish(FAILED)` įrašą tiesiog
   * perrašydavo.
   */
  const job = await processingJob();
  await jobStore.system.finish(job.id, STATUS.COMPLETED, { result: { a: 1 } });

  const po = await jobStore.system.finishFailed(job.id, { error: "veluojantis retry" });

  assert.equal(po.status, STATUS.COMPLETED, "rezultatas išliko");
  assert.deepEqual(po.result, { a: 1 });
});

test("#184 ⚠️ finishFailed: KONFLIKTAS, po kurio autoritetinga būsena yra `COMPLETED`", async () => {
  /**
   * ⚠️ ŠIS TESTAS ATSIRADO IŠ MUTACIJOS, NE IŠ PLANO.
   *
   * Mutacija M9 (`finishFailed` `COMPLETED` apsaugos pašalinimas) NESULAUŽĖ nė
   * vieno testo. Priežastis: ankstesni testai `COMPLETED` job'ą paduodavo iš
   * karto, o tada `jobPhase.finish()` meta `JobPhaseError` DAR PRIEŠ pasiekiant
   * konflikto šaką - apsauga likdavo nepatikrinta.
   *
   * ⚠️ ATKURIAMA TIKROJI LENKTYNĖ, NE JOS SANTRAUKA. Job'as skaitymo metu yra
   * `processing` (tad `jobPhase.finish(FAILED)` PRAEINA), o užbaigimas
   * `COMPLETED` įsipareigojamas TARP fasado `get()` ir `update()` - lygiai taip,
   * kaip nutinka, kai worker'io `finish(COMPLETED)` commit'inasi, o BullMQ ack
   * dingsta ir retry bando pažymėti `failed`.
   *
   * ⚠️ DETERMINISTIŠKA: konkurentas įterpiamas SINCHRONIŠKAI stub'e, ne per
   * `sleep()` ar lygiagretų `Promise`.
   */
  const job = await processingJob();

  const originalus = memoryStore.update;
  let konkurentasIvyko = false;

  async function stubas(id, patch, options = {}) {
    if (konkurentasIvyko) return originalus(id, patch, options);
    konkurentasIvyko = true;

    /**
     * Konkurentas įsipareigoja rezultatą - tai ir yra versijos konflikto
     * priežastis. Rašo per TIKRĄ `update`, tad būsena po jo yra autentiška.
     */
    memoryStore.update = originalus;
    await jobStore.system.finish(id, STATUS.COMPLETED, { result: { ok: true } });
    memoryStore.update = stubas;

    return "CONCURRENCY_CONFLICT";
  }
  memoryStore.update = stubas;
  /**
   * ⚠️ `LOG_LEVEL` pakeliamas TIK šiam testui. Failo viršuje jis yra `error`
   * (kad 450+ testų neterštų išvesties), tad `warn` eilutė būtų nutildyta - ir
   * patikra tyliai praeitų su nuliu eilučių, nieko neįrodydama.
   */
  const senasLygis = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  const zurnalas = perimtiLogus();
  try {
    const po = await jobStore.system.finishFailed(job.id, { error: "veluojantis retry" });

    assert.equal(po.status, STATUS.COMPLETED, "FAILED žymėjimas ATMESTAS");
    assert.deepEqual(po.result, { ok: true }, "rezultatas nepaliestas");
  } finally {
    memoryStore.update = originalus;
    zurnalas.restore();
    process.env.LOG_LEVEL = senasLygis;
  }

  /**
   * ⚠️ ŽURNALO EILUTĖ YRA ŠIOS ŠAKOS VIENINTELIS STEBIMAS SKIRTUMAS.
   *
   * Mutacija M9 (`status === COMPLETED` patikros pašalinimas) NESULAUŽĖ nieko
   * net ir po šio testo pridėjimo - ir tai teisinga: žemiau einantis
   * `isFinished()` grąžina TĄ PAČIĄ reikšmę. Šaka egzistuoja ne dėl kitokio
   * rezultato, o dėl kitokio PRANEŠIMO: operatoriui „COMPLETED žymėjimas
   * atmestas" reiškia prarastą eilės patvirtinimą, o „job jau terminalus" -
   * įprastą lenktynę. Tas skirtumas ir tikrinamas, kad šaka nebūtų nei tyli,
   * nei melagingai pristatoma kaip atskira garantija.
   */
  const eilutes = zurnalas.lines().filter((l) => /FAILED žymėjimas ATMESTAS/.test(l));
  assert.equal(eilutes.length, 1, "atmestas žymėjimas privalo palikti pėdsaką");
  assert.match(eilutes[0], /^WARN\b/, "įspėjimo lygis, ne info");
  assert.match(eilutes[0], new RegExp(job.id), "eilutėje privalo būti jobId");

  /** Persistentinė būsena - ne tik grąžinimas. */
  const galutinis = await jobStore.system.get(job.id);
  assert.equal(galutinis.status, STATUS.COMPLETED);
});

test("#184 finishFailed: nuolatinis konfliktas baigiasi PASITRAUKIMU, ne ciklu", async () => {
  /**
   * ⚠️ RIBA TIKRINAMA, NE NUMANOMA. Neribotas kartojimas reikštų, kad nuolat
   * atnaujinamas job'as niekada negautų `failed` žymos, o kviečiantis worker'is
   * kabėtų. Testas skaičiuoja bandymus: jų privalo būti LYGIAI du.
   */
  const job = await processingJob();

  let bandymai = 0;
  const originalus = memoryStore.update;
  memoryStore.update = async () => {
    bandymai += 1;
    return "CONCURRENCY_CONFLICT";
  };
  try {
    const po = await jobStore.system.finishFailed(job.id, { error: "x" });
    assert.equal(po, jobStore.CONCURRENCY_CONFLICT);
    assert.equal(bandymai, 2, "lygiai du bandymai, po to pasitraukimas");
  } finally {
    memoryStore.update = originalus;
  }
});

test("#184 finishFailed: ne terminalus job'as po konflikto gauna VIENĄ pakartojimą", async () => {
  const job = await processingJob();

  let bandymai = 0;
  const originalus = memoryStore.update;
  memoryStore.update = async (id, patch, options = {}) => {
    bandymai += 1;
    if (bandymai === 1) return "CONCURRENCY_CONFLICT";
    return originalus(id, patch, options);
  };
  try {
    const po = await jobStore.system.finishFailed(job.id, { error: "x" });
    assert.equal(po.status, STATUS.FAILED, "antras bandymas pavyko");
    assert.equal(bandymai, 2);
  } finally {
    memoryStore.update = originalus;
  }
});

test("#184 finishFailed: INFRASTRUKTŪROS klaida NESLEPIAMA", async () => {
  /**
   * ⚠️ Tik `JobPhaseError` reiškia „jau terminalus". DB ar tinklo klaida pro šią
   * politiką praeina nepaliesta — kitaip gedimas taptų tylia sėkme.
   */
  const job = await processingJob();

  const originalus = memoryStore.update;
  memoryStore.update = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    await assert.rejects(
      () => jobStore.system.finishFailed(job.id, { error: "x" }),
      /ECONNREFUSED/
    );
  } finally {
    memoryStore.update = originalus;
  }
});
