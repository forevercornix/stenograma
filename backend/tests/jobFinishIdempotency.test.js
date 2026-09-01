const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const jobStore = require("../utils/jobStore");
const {
  kanoninisRezultatas,
  idempotentiskasAtsakymas,
  JOB_TYPES,
  OWNER_KIND,
  STATUS,
} = require("../utils/jobStore/common");
const { PHASE, JobPhaseError } = require("../utils/jobPhase");

/**
 * ATOMINIS IR IDEMPOTENTIŠKAS `finish(COMPLETED)` (#184, 7.5b — commit C).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Įrodo: kanoninę lygybės taisyklę, tris `completed` baigtis (no-op, rezultatų
 * konfliktas, `completed` be rezultato), `finish(FAILED)` elgesį su rezultatu ir
 * audio valymo barjero SPRENDIMĄ.
 *
 * NEĮRODO: `jobs` + `job_results` transakcijos atomiškumo, `jsonb`
 * normalizavimo ir `created_at` išsaugojimo — tam reikia tikros DB. Tie
 * scenarijai gyvena `postgresStore.integration` ir vietinėje aplinkoje
 * NEVYKDOMI. Worker'io įėjimo kelias reikalauja tikro BullMQ —
 * `workerIdempotency.integration`.
 */

async function baigtas(store, result) {
  const job = await store.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await store.update(job.id, { status: STATUS.PROCESSING, phase: PHASE.VALIDATING });
  return store.finishAtomic(job.id, STATUS.COMPLETED, { result });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. KANONINĖ LYGYBĖ — VIENAS AUTORITETAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 kanoninė lygybė: raktų tvarka NEREIKŠMINGA, masyvų tvarka REIKŠMINGA", () => {
  /**
   * ⚠️ ABI PUSĖS YRA KONTRAKTAS, NE VIENA.
   *
   * Raktų tvarka: `jsonb` jos nesaugo, tad be normalizavimo PostgreSQL kelyje
   * palyginimas lūžtų VISADA, o memory kelyje veiktų — idempotentiškumas taptų
   * backend-priklausomas.
   *
   * Masyvų tvarka: ji yra SEMANTIKA. Transkripcijos segmentų eilė nėra aibė;
   * surūšiavus, du skirtingi rezultatai taptų „tuo pačiu", ir antrasis
   * vykdytojas tyliai priimtų svetimą darbą kaip savo.
   */
  assert.equal(
    kanoninisRezultatas({ b: 1, a: 2 }),
    kanoninisRezultatas({ a: 2, b: 1 }),
    "raktų tvarka nereikšminga"
  );
  assert.notEqual(
    kanoninisRezultatas([1, 2]),
    kanoninisRezultatas([2, 1]),
    "masyvo tvarka REIKŠMINGA"
  );
});

test("#184 kanoninė lygybė yra REKURSYVI", () => {
  const a = { meta: { z: 1, a: 2 }, segments: [{ t: 1, s: "x" }, { s: "y", t: 2 }] };
  const b = { segments: [{ s: "x", t: 1 }, { t: 2, s: "y" }], meta: { a: 2, z: 1 } };
  assert.equal(kanoninisRezultatas(a), kanoninisRezultatas(b));

  /** Vienas skirtumas GILIAI privalo būti pastebėtas. */
  const c = { segments: [{ s: "x", t: 1 }, { t: 2, s: "KITAS" }], meta: { a: 2, z: 1 } };
  assert.notEqual(kanoninisRezultatas(a), kanoninisRezultatas(c));
});

test("#184 ⚠️ tai NĖRA `backupEncryption` ar `evaluationManifest` kanonizavimas", () => {
  /**
   * ⚠️ SARGAS PRIEŠ ANTRĄ AUTORITETĄ. Tie kanonizavimai tarnauja AES-GCM AAD
   * susiejimui ir manifesto hash ID. Pernaudojus juos čia, kriptografinis AAD
   * taptų priklausomas nuo job lygybės taisyklės, ir jos pakeitimas ateityje
   * sulaužytų IŠŠIFRAVIMĄ — gedimas pasirodytų ne ten, kur atsirado.
   */
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "utils", "jobStore", "common.js"),
    "utf8"
  );
  assert.equal(/backupEncryption|evaluationManifest/.test(src.replace(/⚠️[^\n]*/g, "")), false,
    "`common.js` neturi importuoti svetimo kanonizavimo");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. TRYS `completed` BAIGTYS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 ⚠️ pakartotinis `finish(COMPLETED)` su TUO PAČIU rezultatu yra TIKRAS no-op", async () => {
  /**
   * ⚠️ „SĖKMĖ" ČIA NEPAKANKA. Kontraktas reikalauja, kad `version` NEDIDĖTŲ ir
   * rezultatas nebūtų perrašytas. Be to punkto „idempotentiška sėkmė" tyliai
   * liktų RAŠYMU: AS-IS `upsertResult()` darė `DO UPDATE SET payload =
   * EXCLUDED.payload`, t. y. perrašydavo besąlygiškai.
   */
  const rezultatas = { protocol: { a: 1 }, meta: { b: 2 } };
  const pirmas = await baigtas(memoryStore, rezultatas);
  assert.equal(pirmas.status, STATUS.COMPLETED);

  /** Kitas raktų eiliškumas — semantiškai TAS PATS rezultatas. */
  const antras = await memoryStore.finishAtomic(pirmas.id, STATUS.COMPLETED, {
    result: { meta: { b: 2 }, protocol: { a: 1 } },
  });

  assert.equal(antras.version, pirmas.version, "⚠️ `version` NEDIDĖJA");
  assert.deepEqual(antras.result, rezultatas, "rezultatas nepakeistas");
  assert.equal(antras.updatedAt, pirmas.updatedAt, "įrašas apskritai neperrašytas");
});

test("#184 pakartotinis `finish(COMPLETED)` su KITU rezultatu → RESULT_CONFLICT", async () => {
  const pirmas = await baigtas(memoryStore, { a: 1 });

  const antras = await memoryStore.finishAtomic(pirmas.id, STATUS.COMPLETED, { result: { a: 2 } });
  assert.equal(antras, "RESULT_CONFLICT");

  const dabartinis = await memoryStore.get(pirmas.id);
  assert.deepEqual(dabartinis.result, { a: 1 }, "⚠️ ESAMAS rezultatas NEPERRAŠYTAS");
  assert.equal(dabartinis.version, pirmas.version, "konfliktas versijos nedidina");
});

test("#184 ⚠️ `completed` BE rezultato → COMPLETED_WITHOUT_RESULT, ne sėkmė", async () => {
  /**
   * ⚠️ KODĖL ATSKIRA BAIGTIS, O NE „gyvavimo ciklo konfliktas".
   *
   * Audio valymo sprendimas priimamas iš šios reikšmės. Su bendra baigtimi
   * kvietėjas negalėtų atskirti „tas pats rezultatas, audio galima" nuo
   * „rezultato nėra, audio LIEKA" — ir vienas iš dviejų atvejų neišvengiamai
   * elgtųsi neteisingai. Šaltinio audio yra vienintelė medžiaga, iš kurios
   * būseną dar galima suremontuoti.
   */
  const job = await memoryStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await memoryStore.update(job.id, { status: STATUS.PROCESSING, phase: PHASE.VALIDATING });
  await memoryStore.finishAtomic(job.id, STATUS.COMPLETED, { result: { a: 1 } });

  /** Rezultatas dingsta (nutrūkusi transakcija, ranka redaguota eilutė). */
  await memoryStore.update(job.id, { result: null });

  assert.equal(
    await memoryStore.finishAtomic(job.id, STATUS.COMPLETED, { result: { a: 1 } }),
    "COMPLETED_WITHOUT_RESULT"
  );
});

test("#184 lygybės taisyklė NEDUBLIUOJAMA: visi trys backend'ai kviečia TĄ PAČIĄ funkciją", () => {
  /**
   * ⚠️ KODĖL ČIA NĖRA REDIS ELGESIO PATIKROS.
   *
   * `redisStore.finishAtomic()` rašo per `CAS_VERSIJA_LUA`, o `FakeRedis`
   * `eval` NETURI — per jį Lua kelias apskritai nevykdomas. Redis idempotentinis
   * elgesys tikrinamas su TIKRU serveriu (`ownershipCasRedis.integration`);
   * apsimesti, kad `FakeRedis` jį įrodo, būtų blogiau nei jo neturėti.
   *
   * Tai, ką galima įrodyti be servisų: sprendimo taisyklė yra VIENA. Visi trys
   * saugyklos moduliai importuoja `idempotentiskasAtsakymas` iš `common.js` ir
   * savo lygybės neturi.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "utils", "jobStore");

  for (const failas of ["memoryStore.js", "redisStore.js", "postgresStore.js"]) {
    const src = fs.readFileSync(path.join(dir, failas), "utf8");
    assert.match(src, /idempotentiskasAtsakymas/, `${failas}: privalo naudoti bendrą taisyklę`);
    assert.equal(
      /RESULT_CONFLICT/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
      false,
      `${failas}: sprendimo NEGALI priimti pats — antra taisyklė išsiskirtų`
    );
  }
});

test("#184 masyvo tvarka reikšminga IR per fasadą (memory)", async () => {
  const mem = await baigtas(memoryStore, { x: [1, 2] });
  assert.equal(
    await memoryStore.finishAtomic(mem.id, STATUS.COMPLETED, { result: { x: [2, 1] } }),
    "RESULT_CONFLICT"
  );
});

test("#184 `finish(FAILED)` ant `completed` lieka `JobPhaseError`, NE RESULT_CONFLICT", () => {
  /**
   * ⚠️ RIBA TARP DVIEJŲ AUTORITETŲ. `RESULT_CONFLICT` yra apie REZULTATĄ;
   * `completed → failed` yra apie PERĖJIMĄ, ir jį sprendžia `jobPhase`.
   * Suplakus, gyvavimo ciklo pažeidimas atrodytų kaip duomenų nesutapimas.
   */
  const job = { status: STATUS.COMPLETED, result: { a: 1 } };
  assert.equal(
    idempotentiskasAtsakymas(job, STATUS.FAILED, { error: "x" }),
    undefined,
    "sprendimas paliekamas `jobPhase`"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. `finish(FAILED)` IR `job_results`
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 `finish(FAILED)` rezultato NERAŠO ir esamo NETRINA", async () => {
  /**
   * ⚠️ ELGESYS APIBRĖŽIAMAS, NE KEIČIAMAS.
   *
   * `jobPhase.finish()` grąžina `{ ...extra, status, phase, progress,
   * progressKnown }`; FAILED keliai `extra` neduoda `result`, tad
   * `patch.result === undefined`, ir `upsertResult()` iškart grįžta.
   * Neapibrėžtas šis kelias taptų antra, netyčine semantika — todėl
   * užfiksuojamas testu.
   */
  const job = await memoryStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await memoryStore.update(job.id, { status: STATUS.PROCESSING, phase: PHASE.VALIDATING });

  const po = await memoryStore.finishAtomic(job.id, STATUS.FAILED, { error: "x", error_code: "E" });
  assert.equal(po.status, STATUS.FAILED);
  assert.equal(po.result, null, "rezultato neatsirado");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. AUDIO VALYMO BARJERAS — SPRENDIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 ⚠️ audio valymo barjeras: `completed` be rezultato NEDUODA sėkmės", async () => {
  /**
   * ⚠️ VIEN `status = 'completed'` NEPAKANKA — ir būtent tai tikrinama.
   *
   * Šis testas dengia SPRENDIMĄ (kokią reikšmę gauna kvietėjas). Kad audio
   * failas realiai išlieka, tikrina `workerIdempotency.integration` per tikrą
   * BullMQ ir tikrą storage — čia to įrodyti neįmanoma.
   */
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.finish(job.id, STATUS.COMPLETED, { result: { a: 1 } });
  await jobStore.update(
    { jobId: job.id, ownerKind: OWNER_KIND.UNOWNED, ownerId: null },
    { result: null }
  );

  const rezultatas = await jobStore.system.finish(job.id, STATUS.COMPLETED, { result: { a: 1 } });
  assert.equal(rezultatas, jobStore.COMPLETED_WITHOUT_RESULT);
  assert.notEqual(rezultatas, jobStore.RESULT_CONFLICT, "trys baigtys lieka atskiriamos");
});

test("#184 fasadas verčia VISAS saugyklos baigtis į simbolius", async () => {
  /**
   * ⚠️ Nė viena baigtis negali prasprūsti kaip EILUTĖ: kvietėjai tikrina
   * `=== jobStore.X`, ir eilutė tokį palyginimą praeitų kaip „job objektas".
   */
  const pirmas = await baigtas(memoryStore, { a: 1 });
  const rezultatas = await jobStore.system.finish(pirmas.id, STATUS.COMPLETED, { result: { a: 2 } });

  assert.equal(typeof rezultatas, "symbol");
  assert.equal(rezultatas, jobStore.RESULT_CONFLICT);
});

test("#184 tombstone barjeras lieka PIRMAS — `finishAtomic` jo neapeina", async () => {
  /**
   * ⚠️ NAUJA ATOMINĖ SAUGYKLOS OPERACIJA YRA TIKSLIAI TAS KELIAS, KURIS
   * TYLIAI APEITŲ 7.5a. Saugyklos metodas apie tombstone'us nieko nežino, tad
   * fasadas yra vienintelis įėjimas — ir barjeras privalo likti prieš jį.
   */
  const job = await jobStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);

  const tombstones = require("../utils/deletionTombstones");
  await tombstones.mark(job.id, { reason: tombstones.ERASURE_REASON.USER_REQUEST });
  try {
    assert.equal(
      await jobStore.system.finish(job.id, STATUS.COMPLETED, { result: { a: 1 } }),
      null,
      "ištrintas job'as NEGALI būti užbaigtas"
    );
    const dabartinis = await require("../utils/jobStore/memoryStore").get(job.id);
    assert.notEqual(dabartinis.status, STATUS.COMPLETED, "įrašas nepaliestas");
  } finally {
    await tombstones._clearForTests();
  }
});

test("#184 gyvavimo ciklo pažeidimas tebemeta `JobPhaseError` per `finishAtomic`", async () => {
  const job = await memoryStore.create({ type: JOB_TYPES.TRANSCRIPTION, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });

  /** `queued → completed` nelegalus: darbas, kuris nebuvo vykdomas, negali būti baigtas. */
  await assert.rejects(
    () => memoryStore.finishAtomic(job.id, STATUS.COMPLETED, { result: { a: 1 } }),
    (err) => err instanceof JobPhaseError
  );
});
