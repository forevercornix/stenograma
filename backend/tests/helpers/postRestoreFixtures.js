const jobPhase = require("../../utils/jobPhase");

/**
 * 7.6b SĖJIMO SEKA — VIENA, DVIEM BACKEND'AMS (#249).
 *
 * ⚠️ KODĖL ATSKIRAS HELPERIS, O NE EILUTĖS INTEGRACINIAME TESTE.
 *
 * Pirmosios dvi šio fixture'o redakcijos krito CI'uje ties SĖJIMU, ne ties
 * tikrinamu elgesiu:
 *
 *   1. `startPhase(job, "transcribing")` → `ILLEGAL_TRANSITION`
 *      (grafas: `null → validating → transcribing → …`);
 *   2. `finishAtomic(job, "completed")` iš `queued` → `ILLEGAL_TERMINAL_TRANSITION`
 *      („nevykdytas darbas negali būti baigtas sėkmingai").
 *
 * Abi taisyklės yra `jobPhase` autoriteto, ne PostgreSQL. Vadinasi jas galima ir
 * PRIVALOMA tikrinti VIETOJE, prieš atiduodant CI'ui: du raundai buvo sugaišti
 * klausimui, į kurį atsako atminties backend'as per sekundę.
 *
 * Todėl seka gyvena čia ir naudojama DVIEM keliais:
 *   · `postRestoreReconcileContract` — prieš `memoryStore`, vietoje;
 *   · `postRestoreReconcile.integration` — prieš tikrą PostgreSQL, CI'uje.
 *
 * Dvi kopijos ilgainiui išsiskirtų, ir vietinė patikra imtų ginti nebe tą seką,
 * kurią vykdo integracinis testas.
 */

/** Vienodas job'o karkasas — skiriasi tik `storageKey`. */
function baseFields(ownerId, storageKey) {
  return {
    type: "transcription",
    ownerId,
    ownerKind: "user",
    actor: "admin",
    actorRole: "administrator",
    actorSource: "session",
    storageKey,
  };
}

/**
 * Keturi statusai VIENU METU + vienas kandidatas ištrynimo žymai.
 *
 * ⚠️ `failed` daromas IŠ `queued` sąmoningai: tai legalus perėjimas (#249 AS-IS),
 * ir jis skiriasi nuo `completed`, kuriam `processing` yra būtinas. Fixture,
 * abiem naudojantis tą patį kelią, paslėptų būtent tą skirtumą.
 */
async function pasetiKeturisStatusus(store, { ownerId, storageKey }) {
  const queued = await store.create(baseFields(ownerId, storageKey("queued")));
  const processing = await store.create(baseFields(ownerId, storageKey("processing")));
  const failed = await store.create(baseFields(ownerId, storageKey("failed")));
  const completed = await store.create(baseFields(ownerId, storageKey("completed")));
  const zymetas = await store.create(baseFields(ownerId, storageKey("zymetas")));

  /** ⚠️ Per grafą: `processing` sėdi GILESNĖJE fazėje, tad jos nuvalymas įrodo daugiau. */
  const validuojantis = await store.update(processing.id, jobPhase.startPhase(processing, "validating"));
  await store.update(processing.id, jobPhase.startPhase(validuojantis, "transcribing"));

  await store.finishAtomic(failed.id, "failed", { error: "ankstesnė klaida", error_code: "SENAS" });

  const baigiamas = await store.update(completed.id, jobPhase.startPhase(completed, "validating"));
  await store.finishAtomic(baigiamas.id, "completed", {
    result: { text: "reprezentatyvi transkripcija", segments: [1, 2] },
  });

  return { queued, processing, failed, completed, zymetas };
}

module.exports = { pasetiKeturisStatusus };
