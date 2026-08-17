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
  AdminOverrideDenied,
  ADMIN_EVENT,
} = require("../services/adminJobService");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";

const sessionAdmin = { ownerId: ADMIN_ID, ownerKind: OWNER_KIND.USER, role: "administrator" };
const sessionUser = { ownerId: USER_ID, ownerKind: OWNER_KIND.USER, role: "operator" };
const apiKeyAdmin = { ownerId: null, ownerKind: OWNER_KIND.API_KEY, role: "administrator" };
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
   * `apiKeyAdmin` turi `role: "administrator"` – tiksliai tai, ką grąžina
   * `resolveApiKeyRole()` su NUMATYTUOJU `API_KEY_ROLE`.
   */
  const job = await svetimasJob();

  await assert.rejects(() => adminDeleteJob(job.id, apiKeyAdmin), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, desktopAdmin), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, sessionUser), AdminOverrideDenied);
  await assert.rejects(() => adminDeleteJob(job.id, null), AdminOverrideDenied);

  const still = await jobStore.system.get(job.id);
  assert.ok(still, "nė vienas atmestas bandymas neturi nieko ištrinti");
});

test("#160 SERVISAS: našlaičių valymas taip pat tikrina invariantą", async () => {
  await assert.rejects(() => adminCleanupOrphan("nera-tokio", apiKeyAdmin), AdminOverrideDenied);
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
  const pries = auditLog.getAll().length;

  await adminDeleteJob(job.id, sessionAdmin);

  const nauji = auditLog.getAll().slice(pries);
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
  const pries = auditLog.getAll().length;

  await assert.rejects(() => adminDeleteJob(job.id, apiKeyAdmin), AdminOverrideDenied);

  const nauji = auditLog.getAll().slice(pries);
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
  const pries = auditLog.getAll().length;

  await adminDeleteJob(job.id, sessionAdmin);
  await assert.rejects(() => adminDeleteJob(job.id, sessionUser), AdminOverrideDenied);

  const serialized = JSON.stringify(auditLog.getAll().slice(pries));
  assert.equal(/slaptas posėdžio turinys/.test(serialized), false, "jokio turinio audite");
  assert.equal(serialized.includes(job.id), false, "ir jokio neapdoroto job ID");
});

/* ══════════════════════════════════════════════════════════════════════════
 * SĖKMĖ IŠ REZULTATO, NE IŠ PROMISE
 * ══════════════════════════════════════════════════════════════════════════ */

/** Paleidžia servisą su pakeistu `fileStorage`, kad trynimas realiai nepavyktų. */
async function suSugedusiaSaugykla(fn) {
  const { resolve } = require("node:path");
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
  const pries = auditLog.getAll().length;

  const result = await suSugedusiaSaugykla((svc) => svc.adminDeleteJob(job.id, sessionAdmin));

  assert.equal(result.deleted, false, "nepilnas trynimas nėra sėkmė");
  assert.equal(result.reason, "erasure_incomplete");

  const nauji = auditLog.getAll().slice(pries);
  const override = nauji.find((e) => e.event === ADMIN_EVENT.DELETE_OVERRIDE);
  assert.ok(override, "įvykis vis tiek registruojamas");
  assert.equal(override.result, "failure", "bet pažymėtas kaip NESĖKMĖ");
});

test("#160 SĖKMĖ: našlaičių valymas laikosi tos pačios taisyklės", async () => {
  const pries = auditLog.getAll().length;

  const result = await suSugedusiaSaugykla((svc) =>
    svc.adminCleanupOrphan("nera-tokio-jobo", sessionAdmin)
  );

  // Našlaitis be artefaktų išsivalo sėkmingai – tikrinamas kontrakto FORMATAS.
  assert.ok("cleaned" in result, "grąžinamas eksplicitinis sėkmės požymis");
  assert.ok("reason" in result);

  const nauji = auditLog.getAll().slice(pries);
  const cleanup = nauji.find((e) => e.event === ADMIN_EVENT.ORPHAN_CLEANUP);
  assert.ok(cleanup);
  assert.equal(
    cleanup.result,
    result.cleaned ? "success" : "failure",
    "audito rezultatas turi atitikti grąžintą sėkmę"
  );
});
