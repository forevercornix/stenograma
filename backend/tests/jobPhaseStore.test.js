const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const { STATUS, JOB_TYPES, OWNER_KIND } = require("../utils/jobStore/common");
const { PHASE } = require("../utils/jobPhase");

/**
 * #154, 2 žingsnis: FAZIŲ KONTRAKTAS PER STORE.
 *
 * `jobPhase` vienetiniai testai įrodo SPRENDIMUS. Šie įrodo, kad sprendimai
 * realiai pasiekia įrašą ir kad neapdorotų kelių aplink helperį nebėra.
 *
 * ⚠️ Memory store atveju `get` ir `update` vyksta be `await` tarp jų, tad
 * lenktynių lango nėra. Redis atveju to NEPAKANKA — ten reikia atominės
 * operacijos (3 žingsnis).
 */

async function naujas(type = JOB_TYPES.TRANSCRIPTION) {
  return jobStore.create({ type, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
}

/* ── pradinė būsena ───────────────────────────────────────────────────── */

test("#154 STORE: naujas job'as turi pilną fazės kontraktą", async () => {
  const job = await naujas();

  assert.equal(job.status, STATUS.QUEUED);
  assert.equal(job.phase, null);
  assert.equal(job.progress, null);
  assert.equal(job.progressKnown, false);
});

/* ── neapdorotų rašytojų draudimas ────────────────────────────────────── */

test("#154 STORE: neapdorotas status/phase/progress rašymas ATMETAMAS", async () => {
  /**
   * Be šio draudimo bet kuris worker'is galėtų sukonstruoti patch'ą, kuris
   * nežino nė vienos taisyklės: fazės perėjimas neresetintų progreso,
   * terminalus jo neišvalytų, pavėlavęs įvykis nebūtų atmestas.
   */
  const job = await naujas();

  for (const laukas of ["status", "phase", "progress", "progressKnown"]) {
    await assert.rejects(
      () => jobStore.system.update(job.id, { [laukas]: "bet kas" }),
      (e) => e instanceof TypeError && /valdomi per jobPhase/.test(e.message),
      `${laukas} turi būti atmestas`
    );
  }

  // Kiti laukai per `update()` toliau leidžiami.
  const po = await jobStore.system.update(job.id, { attempt_count: 2 });
  assert.equal(po.attempt_count, 2);
});

/* ── fazių srautas ────────────────────────────────────────────────────── */

test("#154 STORE: pilnas transcription srautas su diarizacija", async () => {
  const job = await naujas();

  let po = await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  assert.equal(po.status, STATUS.PROCESSING);
  assert.equal(po.phase, PHASE.VALIDATING);

  po = await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 0, total: 4420 },
  });
  assert.equal(po.progressKnown, true);
  assert.deepEqual(po.progress, { current: 0, total: 4420 });

  po = await jobStore.system.startPhase(job.id, PHASE.DIARIZING);
  assert.equal(po.progress, null, "fazės perėjimas resetina progresą");
  assert.equal(po.progressKnown, false);

  po = await jobStore.system.startPhase(job.id, PHASE.MERGING);
  po = await jobStore.system.finish(job.id, STATUS.COMPLETED);

  assert.equal(po.status, STATUS.COMPLETED);
  assert.equal(po.phase, null);
  assert.equal(po.progressKnown, false);
});

test("#154 STORE: protocol job'as negali pradėti transkripcijos fazės", async () => {
  const job = await naujas(JOB_TYPES.PROTOCOL);

  await assert.rejects(
    () => jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING),
    (e) => e.code === "PHASE_NOT_ALLOWED_FOR_TYPE"
  );

  const po = await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  assert.equal(po.phase, PHASE.VALIDATING);
});

/* ── progresas ir pavėlavę įvykiai ────────────────────────────────────── */

test("#154 STORE: progresas priimamas tik TOJE PAČIOJE fazėje", async () => {
  const job = await naujas();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 0, total: 4420 },
  });

  let po = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 1000, total: 4420 },
  });
  assert.equal(po.progress.current, 1000);

  // Fazė keičiasi.
  await jobStore.system.startPhase(job.id, PHASE.DIARIZING);

  // PAVĖLAVĘS transcribing įvykis.
  po = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 4200, total: 4420 },
  });

  assert.equal(po.phase, PHASE.DIARIZING, "job'as lieka diarizing");
  assert.equal(po.progress, null, "pavėlavęs įvykis nepakeitė progreso");
  assert.equal(po.progressKnown, false);
});

test("#154 STORE: regresija ir kitas total atmetami, įrašas nepakinta", async () => {
  const job = await naujas();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 50, total: 100 },
  });

  const atgal = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 20, total: 100 },
  });
  assert.equal(atgal.progress.current, 50, "regresija ignoruojama");

  const kitasTotal = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 60, total: 200 },
  });
  assert.equal(kitasTotal.progress.total, 100, "kitas total ignoruojamas");
  assert.equal(kitasTotal.progress.current, 50);
});

/* ── terminalūs perėjimai ─────────────────────────────────────────────── */

test("#154 STORE: terminalus perėjimas iš BET KURIOS fazės išvalo būseną", async () => {
  for (const status of [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]) {
    const job = await naujas();
    await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
    await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
      progress: { current: 3900, total: 4400 },
    });

    const po = await jobStore.system.finish(job.id, status, { error_code: "x" });

    assert.equal(po.status, status);
    assert.equal(po.phase, null, `${status}: fazė turi būti išvalyta`);
    assert.equal(po.progress, null);
    assert.equal(po.progressKnown, false);
  }
});

test("#154 STORE: queued → completed atmetamas, queued → failed leidžiamas", async () => {
  const a = await naujas();
  await assert.rejects(
    () => jobStore.system.finish(a.id, STATUS.COMPLETED),
    (e) => e.code === "ILLEGAL_TERMINAL_TRANSITION"
  );

  const b = await naujas();
  const po = await jobStore.system.finish(b.id, STATUS.FAILED, { error_code: "enqueue_failed" });
  assert.equal(po.status, STATUS.FAILED);
});

test("#154 STORE: nesantis job'as grąžina null, ne klaidą", async () => {
  const nera = "00000000-0000-4000-8000-000000000000";

  assert.equal(await jobStore.system.startPhase(nera, PHASE.VALIDATING), null);
  assert.equal(await jobStore.system.reportProgress(nera, { phase: PHASE.VALIDATING, progress: { current: 1, total: 2 } }), null);
  assert.equal(await jobStore.system.finish(nera, STATUS.FAILED), null);
});

test("#154 STORE: terminalaus statuso NEGALIMA įrašyti apeinant finish()", async () => {
  /**
   * ESMINIS testas: #154 invariantas nėra vien `phase`/`progress` invariantas,
   * o `status × phase × progress × progressKnown`.
   *
   * Saugant tik tris laukus liktų atviras kelias:
   *
   *   update(id, { status: "completed" })
   *
   * kuris sukurtų `completed + phase=transcribing + progress=50/100` – būtent
   * tą būseną, kurią `finish()` turėjo padaryti neįmanomą. Dokumentacija sakytų
   * „klaidos keliai privalo eiti per finish()", bet store to neužtikrintų.
   */
  const job = await naujas();

  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 50, total: 100 },
  });

  await assert.rejects(
    () => jobStore.system.update(job.id, { status: STATUS.COMPLETED }),
    TypeError
  );

  const po = await jobStore.system.get(job.id);
  assert.equal(po.status, STATUS.PROCESSING, "būsena nepakito");
  assert.equal(po.phase, PHASE.TRANSCRIBING);
  assert.deepEqual(po.progress, { current: 50, total: 100 });
});

test("#154 STORE: create() NEGALI nustatyti fazės būsenos", async () => {
  /**
   * Antras writer'io apėjimas – per `create()`, ne per `update()`. Priimant
   * `fields.phase` būtų galima sukurti `queued + phase=transcribing`, kurį
   * `startPhase()` draudžia.
   */
  const job = await jobStore.create({
    type: JOB_TYPES.TRANSCRIPTION,
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
    phase: PHASE.TRANSCRIBING,
    progress: { current: 50, total: 100 },
    progressKnown: true,
  });

  assert.equal(job.status, STATUS.QUEUED);
  assert.equal(job.phase, null, "caller'io phase ignoruojamas");
  assert.equal(job.progress, null);
  assert.equal(job.progressKnown, false);
});

test("#154 STORE: restart() grąžina job'ą į grafo pradžią (BullMQ retry)", async () => {
  /**
   * Worker'is retry metu paleidžia processor'ių iš naujo, o job'as gali būti
   * bet kurioje fazėje. Grįžimas `transcribing → validating` grafe nelegalus,
   * tad perpaleidimas yra ATSKIRA operacija.
   */
  const job = await naujas();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 3000, total: 4420 },
  });

  const po = await jobStore.system.restart(job.id, { attempt_count: 2 });

  assert.equal(po.status, STATUS.PROCESSING);
  assert.equal(po.phase, PHASE.VALIDATING, "grįžta į grafo pradžią");
  assert.equal(po.progress, null, "progresas resetinamas");
  assert.equal(po.attempt_count, 2, "extra laukai išsaugomi");
});

test("#154 STORE: fazių metodai gerbia IŠTRYNIMO ŽYMĄ", async () => {
  /**
   * ⚠️ Fazių metodai kviečia `store.update()` TIESIOGIAI, tad `update()` fasado
   * apsauga jų nedengia automatiškai. Be atskiros patikros vėluojanti eilės
   * žinutė galėtų „atgaivinti" ištrintą job'ą per `startPhase()` ar `finish()`.
   */
  const tombstones = require("../utils/deletionTombstones");
  const job = await naujas();
  tombstones.mark(job.id, { actor: "testas" });

  try {
    assert.equal(await jobStore.system.startPhase(job.id, PHASE.VALIDATING), null);
    assert.equal(await jobStore.system.restart(job.id), null);
    assert.equal(await jobStore.system.finish(job.id, STATUS.FAILED), null);
    assert.equal(
      await jobStore.system.reportProgress(job.id, {
        phase: PHASE.VALIDATING,
        progress: { current: 1, total: 2 },
      }),
      null
    );
  } finally {
    await tombstones._clearForTests();
  }
});
