const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const tombstones = require("../utils/deletionTombstones");
const auditLog = require("../utils/auditLog");
const lifecycleService = require("../services/lifecycleService");
const erasureReplay = require("../utils/erasureReplay");

/**
 * 7.6c REPLAY KONTRAKTAS ATMINTIES SAUGYKLOSE (#155, #250).
 *
 * ⚠️ KODĖL ŠIS FAILAS APSIEINA BE POSTGRESQL.
 *
 * Klausimas, į kurį jis atsako, yra ELGESIO, ne persistavimo: ar replay pašalina
 * job'ą TEN, kur `lifecycleService.deleteJobArtefacts()` jo nepašalina. Abu keliai
 * čia vykdomi TIKRI (ne mock'ai), tik jų saugyklos yra atmintinės. Tas pats
 * kodas su `postgresStore` tikrinamas `drRestore.integration` rinkinyje.
 *
 * ⚠️ KIEKVIENAS TRUMPASIS KELIAS TIKRINAMAS ATSKIRAI IR SU KONTROLE.
 *
 * Bendras testas „replay apeina trumpuosius kelius" praeitų padengęs vieną iš
 * trijų, o ataskaitos lentelėje atrodytų kaip trys. Todėl kiekvienas atvejis
 * pirma ĮRODO, kad esamas kelias job'ą PALIEKA (kontrolė — be jos testas
 * tvirtintų skirtumą, kurio gali ir nebūti), ir tik tada tikrina replay.
 */

let seka = 0;
function naujasId() {
  seka += 1;
  return `00000000-0000-4000-8000-${String(seka).padStart(12, "0")}`;
}

/**
 * ⚠️ IZOLIACIJA PER SAUGYKLŲ VALYMĄ (AGENTS.md §9.3).
 *
 * Be jo `tombstones.listAll()` grąžina ir ankstesnių testų žymas, tad kvitų
 * skaičiai matuotų rinkinio istoriją, ne kelią. Pirmoji šio failo versija būtent
 * taip ir krito — trys testai rodė 2-3 kvitus vietoj vieno.
 */
async function paruosti() {
  await jobStore.init({});
  await tombstones.init({ NODE_ENV: "test" });
  await jobStore._resetForTests();
  await tombstones._clearForTests();
  await auditLog.clear();
}

async function sukurtiJoba() {
  return jobStore.create({
    type: "transcription",
    ownerId: "u1",
    ownerKind: "user",
    actor: "u1",
    actorRole: "user",
    actorSource: "session",
    storageKey: "audio/kontraktas.wav",
  });
}

async function irasai(event) {
  const { entries } = await auditLog.query({ limit: 200 });
  return (entries || []).filter((e) => e.event === event);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. TRYS TRUMPIEJI KELIAI — KIEKVIENAS ATSKIRAI
 * ═══════════════════════════════════════════════════════════════════════════ */

test("TRUMPASIS KELIAS `already_deleted`: lifecycle palieka job'ą, replay jį pašalina", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

  /** KONTROLĖ: be jos nežinotume, ar skirtumas apskritai egzistuoja. */
  const kontrole = await lifecycleService.deleteJobArtefacts(job, job.id, {});
  assert.equal(kontrole.status, "already_deleted");
  assert.ok(await jobStore.system.get(job.id), "kontrolė: lifecycle job'o NEPAŠALINO");

  const rez = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(rez.istrinta, [job.id]);
  assert.equal(await jobStore.system.get(job.id), null, "replay job'ą pašalino");
});

test("TRUMPASIS KELIAS `in_progress`: pending be claim'o — dažniausias atvejis po nukirpimo", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  /** Po #250 D1 sulietos žymos claim'o NETURI, tad lifecycle mato svetimą pretenziją. */
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const kontrole = await lifecycleService.deleteJobArtefacts(job, job.id, {});
  assert.equal(kontrole.status, "in_progress");
  assert.ok(await jobStore.system.get(job.id), "kontrolė: lifecycle job'o NEPAŠALINO");

  const zymos = (await tombstones.listAll()).filter((z) => z.jobId === job.id);
  const rez = await erasureReplay.replay({ zymos, actor: "op" });

  assert.deepEqual(rez.istrinta, [job.id]);
  assert.equal(await jobStore.system.get(job.id), null);
  assert.equal((await tombstones.get(job.id)).status, tombstones.TOMBSTONE_STATUS.DELETED);
});

test("TRUMPASIS KELIAS `tombstone_unresolved`: `deletion_failed` žyma", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.FAILED, { failureKind: "storage" });

  const kontrole = await lifecycleService.deleteJobArtefacts(job, job.id, {});
  assert.equal(kontrole.status, "tombstone_unresolved");
  assert.ok(await jobStore.system.get(job.id), "kontrolė: lifecycle job'o NEPAŠALINO");

  const zymos = (await tombstones.listAll()).filter((z) => z.jobId === job.id);
  const rez = await erasureReplay.replay({ zymos, actor: "op" });

  assert.deepEqual(rez.istrinta, [job.id], "`failed` žyma taip pat replay'inama");
  assert.equal(await jobStore.system.get(job.id), null);

  /**
   * ⚠️ ŠI EILUTĖ RADO DEFEKTĄ. Grafe nėra `FAILED → DELETED`, tad be perėjimo per
   * `retry()` duomenys būdavo ištrinami, o žyma likdavo `deletion_failed` amžinai
   * ir `verify` blokuotų cutover'į. `istrinta` tikrinimo vieno NEUŽTEKO.
   */
  assert.equal(
    (await tombstones.get(job.id)).status,
    tombstones.TOMBSTONE_STATUS.DELETED,
    "`failed` žyma UŽDARYTA einant grafu (`failed → pending → deleted`)"
  );
});

test("ANTRASIS LANGAS su `failed` žyma: uždaroma taip pat, nors duomenų nebėra", async () => {
  await paruosti();
  const jobId = naujasId();
  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.FAILED, { failureKind: "storage" });

  const rez = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(rez.uzdarytosZymos, [jobId]);
  assert.equal((await tombstones.get(jobId)).status, tombstones.TOMBSTONE_STATUS.DELETED);
  assert.deepEqual(rez.nesekmes, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. ANTRASIS LANGAS — ATSTATYMAS, NE APTIKIMAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("ANTRASIS LANGAS: job'o nebėra, žyma neuždaryta → paleidimas ją uždaro ir fiksuoja `erasure_confirmed`", async () => {
  await paruosti();
  /**
   * Būsena po kritimo TARP `eraseJob()` ir `complete()`: duomenų nebėra, žyma
   * liko `deletion_pending`. Jokia kita šio raundo garantija jos nedengia.
   */
  const jobId = naujasId();
  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });
  assert.equal((await tombstones.get(jobId)).status, tombstones.TOMBSTONE_STATUS.PENDING);

  const rez = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(rez.jauNebuvo, [jobId]);
  assert.deepEqual(rez.uzdarytosZymos, [jobId], "žyma UŽDARYTA, ne tik praneštas faktas");
  assert.equal((await tombstones.get(jobId)).status, tombstones.TOMBSTONE_STATUS.DELETED);

  const kvitai = await irasai(erasureReplay.AUDITO_IVYKIS);
  assert.equal(kvitai.length, 1);
  assert.equal(kvitai[0].outcome, "erasure_confirmed", "kitas `outcome` nei realus šalinimas");
});

test("ANTRASIS LANGAS: jau uždaryta žyma antro kvito NEDUODA", async () => {
  await paruosti();
  const jobId = naujasId();
  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });

  await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });
  const poPirmo = (await irasai(erasureReplay.AUDITO_IVYKIS)).length;

  const antras = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.equal(antras.uzdarytosZymos.length, 0);
  assert.equal((await irasai(erasureReplay.AUDITO_IVYKIS)).length, poPirmo, "kvitas nesidubliuoja");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. KVITAS IR IDEMPOTENTIŠKUMAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("KVITAS: vienas `ERASURE_REPLAYED` vienam ištrynimui, ir antras paleidimas antro nerašo", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

  await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  const kvitai = await irasai(erasureReplay.AUDITO_IVYKIS);
  assert.equal(kvitai.length, 1);
  assert.equal(kvitai[0].outcome, "erasure_replayed");

  /** Per-subjekto įrodymą rašo AUTORITETAS — `eraseJob()`, ne šis modulis. */
  assert.equal((await irasai("DATA_ERASED")).length, 1, "`DATA_ERASED` kvitas nuo `eraseJob()`");

  const antras = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(antras.istrinta, []);
  assert.deepEqual(antras.jauNebuvo, [job.id]);
  assert.equal((await irasai(erasureReplay.AUDITO_IVYKIS)).length, 1, "antro kvito nėra");
});

test("KVITAS RAŠOMAS BE SUBJEKTO SĄSAJOS — ir barjeras įrodo, kad kitaip neįmanoma", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

  await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  const kvitai = await irasai(erasureReplay.AUDITO_IVYKIS);
  assert.equal(kvitai.length, 1);
  assert.equal(kvitai[0].subjectId, null, "kvitas NĖRA asmens įrašas");

  /**
   * ⚠️ KONTROLĖ, KURI PAAIŠKINA „KODĖL BE `jobId`".
   *
   * Be jos eilutė `subjectId === null` atrodytų kaip praleidimas. Tas pats
   * įvykis SU `jobId` atmetamas 7.4e barjero — tad sprendimas yra vienintelis
   * galimas, ne stilius.
   */
  const auditWrite = require("../utils/auditWrite");
  await assert.rejects(
    () =>
      auditWrite.rasytiAudita({
        event: erasureReplay.AUDITO_IVYKIS,
        jobId: job.id,
        success: true,
        outcome: "erasure_replayed",
      }),
    (klaida) => klaida.code === "AUDIT_WRITE_BLOCKED",
    "subjektui susietas kvitas apie užbarjeruotą job'ą neįmanomas"
  );
});

test("APSKAITA: tas pats `jobId` negali būti ir `istrinta`, ir `nesekmes`", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

  const rez = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  const persidengia = rez.istrinta.filter((id) => rez.nesekmes.some((n) => n.jobId === id));
  assert.deepEqual(persidengia, [], "ataskaita neprieštarauja pati sau");
  assert.deepEqual(rez.nesekmes, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. GEDIMAI NEPALIEKA UŽDARYTOS ŽYMOS
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Seamas gyvena bendrame helperyje — dvi kopijos ilgainiui išsiskirtų. */
const { suSugadintuAuditu } = require("./helpers/auditStoreSeam");

test("KRITINĖ NESĖKMĖ: `eraseJob()` grįžta be išimties — žyma NEUŽDAROMA", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  /**
   * Sugadinta audito saugykla nutraukia `eraseJob()` TREČIAME žingsnyje (audito
   * eilučių šalinimas). Jis grąžina `criticalFailure`, NEMESDAMAS — būtent tas
   * atvejis, kurį replay anksčiau laikė sėkme.
   */
  const rez = await suSugadintuAuditu(() =>
    erasureReplay.replay({ zymos: [{ jobId: job.id, status: tombstones.TOMBSTONE_STATUS.PENDING }], actor: "op" })
  );

  assert.deepEqual(rez.istrinta, [], "neįvykęs ištrynimas nedeklaruojamas");
  assert.equal(rez.nesekmes.length, 1);
  assert.match(rez.nesekmes[0].priezastis, /ištrynimas nepavyko/);

  assert.ok(await jobStore.system.get(job.id), "job'as paliktas pakartojimui");
  assert.notEqual(
    (await tombstones.get(job.id)).status,
    tombstones.TOMBSTONE_STATUS.DELETED,
    "žyma LIEKA atvira — kitaip pakartoti nebūtų kaip"
  );

  /** KONTROLĖ: sveika saugykla tą patį job'ą ištrina ir žymą uždaro. */
  const antras = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });
  assert.deepEqual(antras.istrinta, [job.id]);
  assert.equal((await tombstones.get(job.id)).status, tombstones.TOMBSTONE_STATUS.DELETED);
});

test("TVARKA: kvitas rašomas PRIEŠ žymos uždarymą — jo gedimas palieka žymą atvirą", async () => {
  await paruosti();
  const job = await sukurtiJoba();
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const zymos = await tombstones.listAll();
  const pirmas = await suSugadintuAuditu(() => erasureReplay.replay({ zymos, actor: "op" }), {
    tikIvykiui: erasureReplay.AUDITO_IVYKIS,
  });

  assert.deepEqual(pirmas.istrinta, [], "sėkmė nedeklaruojama be patvirtinto kvito");
  assert.equal(pirmas.nesekmes.length, 1);
  assert.equal(await jobStore.system.get(job.id), null, "duomenų PAŠALINIMAS jau įvyko");

  /**
   * ⚠️ ŠERDIS: žyma NEUŽDARYTA. Uždarius ją prieš kvitą, ši būsena būtų
   * neatstatoma — kitas paleidimas praeitų pro šalį, o kvito nebūtų niekada.
   */
  assert.notEqual((await tombstones.get(job.id)).status, tombstones.TOMBSTONE_STATUS.DELETED);

  const antras = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(antras.uzdarytosZymos, [job.id], "kitas paleidimas žymą uždarė");
  assert.equal((await tombstones.get(job.id)).status, tombstones.TOMBSTONE_STATUS.DELETED);
  assert.equal((await irasai(erasureReplay.AUDITO_IVYKIS)).length, 1, "kvitas atsirado, ir tik vienas");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. NUKREIPTA SAUGYKLA (#250, C sprendimas)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ KĄ ĮRODO ŠI DALIS IR KO NE.
 *
 * Įrodo MARŠRUTIZAVIMĄ: `store` parametras sprendžia, KUR įrašas šalinamas, ir
 * nepilna saugykla atmetama PRIEŠ pirmą šalinimą. Tam duomenų bazės nereikia.
 *
 * NEĮRODO, kad replay per fasadą prieš ATKURTĄ bazę yra vakuumas — tam reikia
 * tikros PostgreSQL, ir ta kontrolė gyvena `drRestore.integration` (žingsnis 6a).
 */
function saugyklaSuAibe(irasai) {
  return {
    system: {
      get: async (id) => irasai.get(id) || null,
      update: async (id, patch) => {
        const esamas = irasai.get(id);
        if (esamas) irasai.set(id, { ...esamas, ...patch });
        return irasai.get(id) || null;
      },
      remove: async (id) => irasai.delete(id),
    },
  };
}

test("NUKREIPIMAS: `store` sprendžia, kur įrašas šalinamas", async () => {
  await paruosti();

  /** Tas pats job'as GYVENA nukreiptoje saugykloje, o fasadas jo neturi. */
  const jobId = naujasId();
  const kitur = new Map([[jobId, { id: jobId, type: "transcription", storageKey: null }]]);

  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });

  const rez = await erasureReplay.replay({
    zymos: await tombstones.listAll(),
    actor: "op",
    store: saugyklaSuAibe(kitur),
  });

  assert.deepEqual(rez.istrinta, [jobId], "šalinta iš NUKREIPTOS saugyklos");
  assert.equal(kitur.has(jobId), false);
});

test("KONTROLĖ: be nukreipimo tas pats job'as lieka NEPALIESTAS", async () => {
  await paruosti();

  /**
   * ⚠️ BE ŠIOS PUSĖS ANKSTESNIS TESTAS ĮRODYTŲ TIK TIEK, KAD NAUJAS KELIAS VEIKIA.
   *
   * Čia matoma, kodėl nukreipimas apskritai reikalingas: fasadas job'o nemato,
   * tad replay jo NEŠALINA — ir vis tiek UŽDARO žymą bei rašo kvitą. Būtent
   * toks derinys („sėkmė paskelbta, duomenys liko") ir yra vakuumas, dėl kurio
   * DR kelyje saugykla yra privaloma, o ne pasirenkama.
   */
  const jobId = naujasId();
  const kitur = new Map([[jobId, { id: jobId, type: "transcription", storageKey: null }]]);

  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });

  const rez = await erasureReplay.replay({ zymos: await tombstones.listAll(), actor: "op" });

  assert.deepEqual(rez.istrinta, [], "fasadas šio job'o nemato");
  assert.deepEqual(rez.jauNebuvo, [jobId]);
  assert.equal(kitur.has(jobId), true, "įrašas LIKO ten, kur iš tikrųjų gyvena");

  const kvitai = await irasai(erasureReplay.AUDITO_IVYKIS);
  assert.equal(kvitai[0].outcome, "erasure_confirmed", "⚠️ ir kvitas skelbia galutinumą");
});

test("FAIL-CLOSED: nepilna saugykla atmetama PRIEŠ pirmą šalinimą", async () => {
  await paruosti();
  const { eraseJob } = require("../utils/jobErasure");

  const nepilnos = [
    {},
    { system: {} },
    { system: { get: async () => null, remove: async () => true } },
    { system: { get: async () => null, update: async () => null } },
  ];

  for (const store of nepilnos) {
    await assert.rejects(
      () => eraseJob({ id: naujasId(), type: "transcription" }, { store }),
      (k) => k instanceof TypeError && /neteikia/.test(k.message),
      `nepilna saugykla praėjo: ${JSON.stringify(Object.keys(store.system || {}))}`
    );
  }

  /** KONTROLĖ: pilna saugykla PRAEINA — kitaip patikra būtų visada „ne". */
  const job = await sukurtiJoba();
  const pilna = saugyklaSuAibe(new Map([[job.id, job]]));
  const outcome = await eraseJob(job, { store: pilna });
  assert.equal(outcome.criticalFailure, false);
  assert.equal(outcome.jobRemoved, true);
});

test("AUDIO: atidėto valymo skola registruojama, bet nėra nei nesėkmė, nei revive", async () => {
  await paruosti();

  /**
   * ⚠️ SIGNALAS IMAMAS IŠ `audio_cleanup_pending`, NE IŠ `del()` REZULTATO.
   *
   * Nesant objekto `fileStorage.del()` grąžina `false` be klaidos — tai ĮPRASTAS
   * pakartotinio trynimo atvejis, ne likutis. Signalas, degantis normaliu atveju,
   * nustoja būti signalu; tikra skola yra atidėtas valymas atkurtoje eilutėje.
   */
  const jobId = naujasId();
  const kitur = new Map([
    [jobId, { id: jobId, type: "transcription", storageKey: null, audio_cleanup_pending: true }],
  ]);

  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });

  const rez = await erasureReplay.replay({
    zymos: await tombstones.listAll(),
    actor: "op",
    store: saugyklaSuAibe(kitur),
  });

  assert.deepEqual(rez.istrinta, [jobId], "job'as IŠTRINTAS — tai ne revive");
  assert.deepEqual(rez.nesekmes, [], "ir ne nesėkmė");
  assert.deepEqual(rez.audioValymoSkola, [jobId], "skola UŽREGISTRUOTA");
  assert.equal((await tombstones.get(jobId)).status, tombstones.TOMBSTONE_STATUS.DELETED);
});

test("KONTROLĖ: job'as be atidėto valymo į skolos sąrašą NEPATENKA", async () => {
  await paruosti();

  /**
   * Be šios pusės patikra galėtų virsti visada-„taip". Job'as TURI `storageKey`,
   * kurio objekto nėra — būtent tas atvejis, kurį ankstesnė redakcija klaidingai
   * skaitė kaip likutį.
   */
  const jobId = naujasId();
  const kitur = new Map([
    [jobId, { id: jobId, type: "transcription", storageKey: "audio/nera-tokio.wav" }],
  ]);

  await tombstones.mark(jobId, { reason: "user_request", actorKind: "user" });

  const rez = await erasureReplay.replay({
    zymos: await tombstones.listAll(),
    actor: "op",
    store: saugyklaSuAibe(kitur),
  });

  assert.deepEqual(rez.istrinta, [jobId]);
  assert.deepEqual(rez.audioValymoSkola, [], "nėra atidėto valymo — nėra ir skolos");
});
