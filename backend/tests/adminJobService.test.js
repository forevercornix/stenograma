const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const { OWNER_KIND } = require("../utils/jobStore/common");
const {
  adminDeleteJob,
  adminCleanupOrphan,
  desktopCleanupOrphan,
  AdminOverrideDenied,
  ADMIN_EVENT,
} = require("../services/adminJobService");
const tombstones = require("../utils/deletionTombstones");
const {
  ERASURE_REASON,
  ACTOR_KIND,
  TOMBSTONE_STATUS,
} = require("../utils/deletionTombstones/states");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";

const sessionAdmin = { ownerId: ADMIN_ID, ownerKind: OWNER_KIND.USER, role: "administrator" };
const sessionUser = { ownerId: USER_ID, ownerKind: OWNER_KIND.USER, role: "operator" };
/**
 * VARDŲ KONVENCIJA (CodeQL `js/clear-text-logging`).
 *
 * Šiuose testuose bendro rakto principalas vadinamas `sharedPrincipal*`, NE
 * `apiKey*`. CodeQL laiko `*Key*` identifikatorius jautriais ir pažymi bet kokį
 * jų kelią į logerį – nors objektas jokios paslapties neturi
 * (`{ ownerId, ownerKind, role }`), o loginami tik `ownerId` ir `ownerKind`.
 *
 * Klaidingo signalo pigiau išvengti nei jį kaskart atmetinėti: atmestas
 * įspėjimas nuslopintų ir TIKRĄ radinį, jei jis kada atsirastų tame pačiame
 * kelyje. Tai jau antras atvejis (#159 buvo `apiKeyScope`).
 */
const sharedPrincipalAdmin = { ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL, role: "administrator" };
const desktopAdmin = { ownerId: null, ownerKind: OWNER_KIND.UNOWNED, role: "administrator" };

async function svetimasJob() {
  return jobStore.create({ ownerId: USER_ID, ownerKind: OWNER_KIND.USER, type: "protocol" });
}

/* ══════════════════════════════════════════════════════════════════════════
 * DEFENSE-IN-DEPTH: servisas nepasitiki maršrutu
 * ══════════════════════════════════════════════════════════════════════════ */

test('#160 SERVISAS: suklastotas maršruto teiginys „čia admin" atmetamas', async () => {
  /**
   * ESMINIS testas.
   *
   * Servisas turi teisėtą prieigą prie `jobStore.system`, tad yra PASKUTINĖ
   * riba prieš privilegijuotą kelią. Jei jis aklai pasitikėtų maršruto
   * sprendimu, viena klaida maršrute atidarytų visą override'ą.
   *
   * `sharedPrincipalAdmin` turi `role: "administrator"` – tiksliai tai, ką grąžina
   * `resolveApiKeyRole()` su NUMATYTUOJU `API_KEY_ROLE`.
   */
  const job = await svetimasJob();

  await assert.rejects(() => adminDeleteJob(job.id, sharedPrincipalAdmin), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, desktopAdmin), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, sessionUser), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, null), AdminOverrideDenied);

  const still = await jobStore.system.get(job.id);
  assert.ok(still, "nė vienas atmestas bandymas neturi nieko ištrinti");
});

test("#160 SERVISAS: našlaičių valymas taip pat tikrina invariantą", async () => {
  await assert.rejects(() => adminCleanupOrphan("nera-tokio", sharedPrincipalAdmin), AdminOverrideDenied);
  await assert.rejects(() => adminCleanupOrphan("nera-tokio", sessionUser), AdminOverrideDenied);
});

/* ══════════════════════════════════════════════════════════════════════════
 * VEIKIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#160 SERVISAS: session-admin ištrina svetimą job'ą", async () => {
  const job = await svetimasJob();

  const result = await adminDeleteJob(job.id, sessionAdmin);

  assert.equal(result.deleted, true);
  assert.equal(await jobStore.system.get(job.id), null, "job'as realiai ištrintas");
});

test("#160 SERVISAS: legacy job'as (be ownerKind) taip pat trinamas", async () => {
  const { newJob } = require("../utils/jobStore/common");
  const raw = newJob({ ownerKind: "unowned", type: "protocol" });
  delete raw.ownerKind;
  const legacy = await jobStore.restoreRecord(raw);

  const result = await adminDeleteJob(legacy.id, sessionAdmin);
  assert.equal(result.deleted, true);
});

test("#160 SERVISAS: job'as dingęs tarp sprendimo ir trynimo – FAIL-CLOSED", async () => {
  /**
   * LENKTYNĖS. Politika nusprendė `ADMIN_DELETE_OVERRIDE`, bet iki serviso
   * kvietimo job'as dingo (TTL, kitas trynimas).
   *
   * NEGALIMA tyliai pereiti į našlaičių valymą: tai KITA operacija su kita
   * politika (ir kitu audito įvykiu). Servisas grąžina `vanished`, o sprendimą
   * priima politika iš naujo.
   */
  const result = await adminDeleteJob("visai-nera-tokio-id", sessionAdmin);

  assert.equal(result.deleted, false);
  assert.equal(result.reason, "vanished");
});

/* ══════════════════════════════════════════════════════════════════════════
 * AUDITAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#160 AUDITAS: override atskiriamas nuo įprasto savininko trynimo", async () => {
  const job = await svetimasJob();
  const pries = (await auditLog.getAll()).length;

  await adminDeleteJob(job.id, sessionAdmin);

  const nauji = (await auditLog.getAll()).slice(pries);
  const override = nauji.find((e) => e.event === ADMIN_EVENT.DELETE_OVERRIDE);

  assert.ok(override, "override turi turėti SAVO įvykio tipą");
  assert.equal(override.result, "success");
});

test("#160 AUDITAS: NEPAVYKĘS bandymas irgi audituojamas", async () => {
  /**
   * Be šito incidento analizė matytų tik sėkmingus override'us, o bandymai
   * juos gauti liktų visiškai nematomi.
   */
  const job = await svetimasJob();
  const pries = (await auditLog.getAll()).length;

  await assert.rejects(() => adminDeleteJob(job.id, sharedPrincipalAdmin), AdminOverrideDenied);

  const nauji = (await auditLog.getAll()).slice(pries);
  const denied = nauji.find((e) => e.event === ADMIN_EVENT.ACCESS_DENIED);

  assert.ok(denied, "atmestas bandymas turi palikti pėdsaką");
  assert.equal(denied.result, "failure");
});

test("#160 AUDITAS: įrašuose NĖRA job turinio", async () => {
  const job = await jobStore.create({
    ownerId: USER_ID,
    ownerKind: OWNER_KIND.USER,
    type: "protocol",
    transcript: "Jonas: slaptas posėdžio turinys apie biudžetą.",
  });
  const pries = (await auditLog.getAll()).length;

  await adminDeleteJob(job.id, sessionAdmin);
  await assert.rejects(() => adminDeleteJob(job.id, sessionUser), AdminOverrideDenied);

  const serialized = JSON.stringify((await auditLog.getAll()).slice(pries));
  assert.equal(/slaptas posėdžio turinys/.test(serialized), false, "jokio turinio audite");
  assert.equal(serialized.includes(job.id), false, "ir jokio neapdoroto job ID");
});

/* ══════════════════════════════════════════════════════════════════════════
 * SĖKMĖ IŠ REZULTATO, NE IŠ PROMISE
 * ══════════════════════════════════════════════════════════════════════════ */

/** Paleidžia servisą su pakeistu `fileStorage`, kad trynimas realiai nepavyktų. */
async function suSugedusiaSaugykla(fn) {
  const storagePath = require.resolve("../utils/fileStorage");
  const original = require.cache[storagePath];

  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: {
      ...(original ? original.exports : {}),
      del: async () => {
        throw new Error("saugykla neprieinama");
      },
    },
  };

  // Servisai laiko nuorodą į modulį – perkraunam grandinę.
  for (const p of [
    require.resolve("../utils/jobErasure"),
    require.resolve("../services/lifecycleService"),
    require.resolve("../services/adminJobService"),
  ]) {
    delete require.cache[p];
  }

  try {
    return await fn(require("../services/adminJobService"));
  } finally {
    if (original) require.cache[storagePath] = original;
    else delete require.cache[storagePath];
    for (const p of [
      require.resolve("../utils/jobErasure"),
      require.resolve("../services/lifecycleService"),
      require.resolve("../services/adminJobService"),
    ]) {
      delete require.cache[p];
    }
  }
}

test("#160 SĖKMĖ: kritinė trynimo nesėkmė NEGALI atrodyti kaip sėkmingas override", async () => {
  /**
   * REGRESIJA.
   *
   * `eraseJob()` gali grąžinti `criticalFailure` ir vis tiek sėkmingai
   * resolve'intis. Ankstesnėje versijoje servisas rašė `success: true`
   * besąlygiškai – auditas rodytų sėkmingą override, nors duomenys liko, o
   * maršrutas pagal `deleted: true` grąžintų 204.
   *
   * Sėkmė turi būti išvedama iš REZULTATO.
   */
  const job = await jobStore.create({
    ownerId: USER_ID,
    ownerKind: OWNER_KIND.USER,
    type: "transcription",
    storageKey: "audio/neistrinamas.wav",
  });
  const pries = (await auditLog.getAll()).length;

  const result = await suSugedusiaSaugykla((svc) => svc.adminDeleteJob(job.id, sessionAdmin));

  assert.equal(result.deleted, false, "nepilnas trynimas nėra sėkmė");
  assert.equal(result.reason, "erasure_incomplete");

  const nauji = (await auditLog.getAll()).slice(pries);
  const override = nauji.find((e) => e.event === ADMIN_EVENT.DELETE_OVERRIDE);
  assert.ok(override, "įvykis vis tiek registruojamas");
  assert.equal(override.result, "failure", "bet pažymėtas kaip NESĖKMĖ");
});

test("#160 SĖKMĖ: našlaičių valymas laikosi tos pačios taisyklės", async () => {
  const pries = (await auditLog.getAll()).length;

  const result = await suSugedusiaSaugykla((svc) =>
    svc.adminCleanupOrphan("nera-tokio-jobo", sessionAdmin)
  );

  // Našlaitis be artefaktų išsivalo sėkmingai – tikrinamas kontrakto FORMATAS.
  assert.ok("cleaned" in result, "grąžinamas eksplicitinis sėkmės požymis");
  assert.ok("reason" in result);

  const nauji = (await auditLog.getAll()).slice(pries);
  const cleanup = nauji.find((e) => e.event === ADMIN_EVENT.ORPHAN_CLEANUP);
  assert.ok(cleanup);
  assert.equal(
    cleanup.result,
    result.cleaned ? "success" : "failure",
    "audito rezultatas turi atitikti grąžintą sėkmę"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * #183 IŠTRYNIMO ŽYMA NAŠLAIČIŲ KELYJE - FAIL-CLOSED
 * ══════════════════════════════════════════════════════════════════════════ */

test("#183 NAŠLAITIS: sėkmingas valymas palieka barjerą (abu keliai)", async () => {
  /**
   * Iki #183 abu našlaičių keliai trynė pėdsakus NEPALIKDAMI žymos: ištrynimas
   * pavykdavo, barjero neatsirasdavo, ir atkūrimas iš senesnės kopijos tą patį
   * `jobId` vėl priimdavo.
   *
   * Tikrinama ne tik žymos egzistavimas, bet ir `reason` bei `actorKind`:
   * `orphan_cleanup` skiria šį kelią nuo savininko `user_request`, o aktorius
   * skiriasi TARP kelių - admin naudoja privilegiją, desktop režimas jos neturi.
   */
  const adminJob = await svetimasJob();
  const desktopJob = await svetimasJob();

  const a = await adminCleanupOrphan(adminJob.id, sessionAdmin);
  assert.equal(a.cleaned, true);

  const zymaA = await tombstones.get(adminJob.id);
  assert.ok(zymaA, "admin kelias privalo palikti žymą");
  assert.equal(zymaA.status, TOMBSTONE_STATUS.DELETED);
  assert.equal(zymaA.reason, ERASURE_REASON.ORPHAN_CLEANUP);
  assert.equal(zymaA.actorKind, ACTOR_KIND.OPERATOR);
  assert.equal(await tombstones.isDeleted(adminJob.id), true, "barjeras veikia");

  const d = await desktopCleanupOrphan(desktopJob.id, desktopAdmin);
  assert.equal(d.cleaned, true);

  const zymaD = await tombstones.get(desktopJob.id);
  assert.ok(zymaD, "desktop kelias privalo palikti žymą");
  assert.equal(zymaD.reason, ERASURE_REASON.ORPHAN_CLEANUP);
  assert.equal(
    zymaD.actorKind,
    ACTOR_KIND.USER,
    "desktop režime privilegijos nėra - `operator` nurodytų aktorių, kurio nebuvo"
  );
});

test("#183 FAIL-CLOSED: žymos įrašymo klaida SUSTABDO valymą, o ne praleidžiama", async () => {
  /**
   * ⚠️ ĮRODYMAS YRA PRODUKCINĖ BŪSENA, NE KVIETIMŲ SKAITIKLIS.
   *
   * Tikrinama ne „ar `eraseOrphanedJobData` buvo kviestas", o ar duomenys LIKO.
   * Skaitiklį būtų galima patenkinti ir tada, kai valymas įvyko dalinai; likęs
   * `jobs` įrašas yra tiesioginis atsakymas į klausimą, ar ištrynimas be
   * barjero įvyko.
   *
   * Abu keliai tikrinami atskirai: `desktopCleanupOrphan` yra SAVARANKIŠKAS
   * įėjimas, ne `adminCleanupOrphan` su atlaisvinta patikra, tad vieno kelio
   * įrodymas apie kitą nesako nieko.
   */
  const adminJob = await svetimasJob();
  const desktopJob = await svetimasJob();

  /**
   * ⚠️ STUB'INAMAS `claimForDeletion`, NE `mark`.
   *
   * Nuo #183 pretenzijos taisyklė gyvena fasade: `claimForDeletion` yra taškas,
   * kuriame barjeras įrengiamas. `mark` stub'inimas nieko neduotų - fasadas jį
   * kviečia vidiniu vardu, ne per eksportą.
   */
  const originalus = tombstones.claimForDeletion;
  tombstones.claimForDeletion = async () => {
    throw new Error("žymų saugykla nepasiekiama");
  };

  try {
    await assert.rejects(
      () => adminCleanupOrphan(adminJob.id, sessionAdmin),
      /žymų saugykla nepasiekiama/,
      "klaida turi propaguotis kvietėjui, o ne būti nutylėta"
    );
    await assert.rejects(
      () => desktopCleanupOrphan(desktopJob.id, desktopAdmin),
      /žymų saugykla nepasiekiama/
    );
  } finally {
    tombstones.claimForDeletion = originalus;
  }

  assert.ok(
    await jobStore.system.get(adminJob.id),
    "be žymos valymas negali įvykti - įrašas privalo likti (admin kelias)"
  );
  assert.ok(
    await jobStore.system.get(desktopJob.id),
    "be žymos valymas negali įvykti - įrašas privalo likti (desktop kelias)"
  );
});

test("#183 NAŠLAITIS: svetima žyma sustabdo valymą (202), sava - ne", async () => {
  /**
   * Codex P1: `mark()` idempotentinis, tad abi replikos matydavo tą patį
   * `deletion_pending` įrašą ir abi pradėdavo tą patį eilės, saugyklos ir audito
   * trynimą - viena dar ir grąžindavo 404 ten, kur kita grąžino 204.
   *
   * ⚠️ Įrodymas - likęs įrašas, ne `barjeras` reikšmė.
   */
  const job = await svetimasJob();

  // Kita replika jau pasiėmė šį jobą.
  await tombstones.mark(job.id, { reason: ERASURE_REASON.ORPHAN_CLEANUP, actorKind: ACTOR_KIND.OPERATOR });

  const r = await adminCleanupOrphan(job.id, sessionAdmin);

  assert.equal(r.cleaned, false);
  assert.equal(r.barjeras, "in_progress");
  assert.ok(await jobStore.system.get(job.id), "destruktyvus darbas NEPRADĖTAS");
});

test("#183 NAŠLAITIS: `deletion_failed` grąžina `tombstone_unresolved`, be pakartojimo", async () => {
  const job = await svetimasJob();

  await tombstones.mark(job.id, { reason: ERASURE_REASON.ORPHAN_CLEANUP, actorKind: ACTOR_KIND.OPERATOR });
  await tombstones.complete(job.id, TOMBSTONE_STATUS.FAILED, { failureKind: "retryable" });

  const r = await adminCleanupOrphan(job.id, sessionAdmin);

  assert.equal(r.cleaned, false);
  assert.equal(r.barjeras, "tombstone_unresolved");
  assert.ok(await jobStore.system.get(job.id), "automatinio pakartojimo nėra - jį autorizuoja operatorius");
  assert.equal((await tombstones.get(job.id)).status, TOMBSTONE_STATUS.FAILED);
});

test("#183 NAŠLAITIS: jau patvirtinta žyma - sėkmė be jokio darbo", async () => {
  const job = await svetimasJob();

  await tombstones.mark(job.id, { reason: ERASURE_REASON.ORPHAN_CLEANUP, actorKind: ACTOR_KIND.OPERATOR });
  await tombstones.complete(job.id, TOMBSTONE_STATUS.DELETED);

  const r = await adminCleanupOrphan(job.id, sessionAdmin);

  assert.equal(r.cleaned, true);
  assert.equal(r.barjeras, "already_deleted");
});

test("#183 NAŠLAITIS: sėkmė NEskelbiama, jei `complete()` grąžina ne `deleted`", async () => {
  /**
   * ⚠️ GYNYBINIS SLUOKSNIS, KURĮ REIKIA PASIEKTI SĄMONINGAI.
   *
   * Išankstinė `deletion_failed` patikra uždaro pagrindinį kelią, tad natūraliai
   * čia nepatenkama - o netestuotas gynybinis sluoksnis yra tas pats, kas jo
   * nebuvimas. `complete()` neleidžiamo perėjimo NEMETA: jis grąžina esamą
   * būseną, ir būtent to grąžinimo ignoravimas buvo Codex radinys.
   */
  const job = await svetimasJob();

  const originalus = tombstones.complete;
  tombstones.complete = async () => ({
    jobId: job.id,
    status: TOMBSTONE_STATUS.FAILED,
    attempts: 1,
  });

  let r;
  try {
    r = await adminCleanupOrphan(job.id, sessionAdmin);
  } finally {
    tombstones.complete = originalus;
  }

  assert.equal(r.cleaned, false, "žyma neužtikrinta - sėkmės skelbti negalima");
  assert.equal(r.barjeras, "tombstone_unresolved");
  assert.ok(r.outcome, "valymo rezultatas vis tiek grąžinamas - darbas įvyko");
});
