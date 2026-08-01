const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";

const {
  PROFILES,
  RETENTION_LIMITS,
  getPrivacyConfig,
  validatePrivacyConfig,
  describeForDiagnostics,
} = require("../utils/privacyConfig");
const { validateConfig } = require("../utils/startupChecks");

/**
 * GDPR #5 (konfigūruojamas privatumo režimas) ir #2 (automatinė retencija).
 */

const LOCAL_ENV = {
  TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
  DIARIZATION_PROVIDER: "pyannote",
  LLM_PROVIDER: "mock",
};

test("numatytoji konfigūracija yra pilnai lokali (privacy by default)", () => {
  const selection = describeForDiagnostics({});

  assert.equal(selection.externalProviders, false, "be jokių ENV niekas neišeina iš mašinos");
  assert.equal(selection.profile, PROFILES.STANDARD);
  assert.equal(validatePrivacyConfig({}).errors.length, 0);
});

test("local_only + išorinis LLM = startup KLAIDA, ne įspėjimas", () => {
  const { errors } = validatePrivacyConfig({
    PRIVACY_PROFILE: "local_only",
    ...LOCAL_ENV,
    LLM_PROVIDER: "claude",
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /local_only/);
  assert.match(errors[0], /claude/);
});

test("local_only + išorinis transkribavimas = klaida", () => {
  const { errors } = validatePrivacyConfig({
    PRIVACY_PROFILE: "local_only",
    TRANSCRIPTION_PROVIDER: "deepgram",
    LLM_PROVIDER: "mock",
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /deepgram/);
});

test("local_only su lokaliais tiekėjais praeina", () => {
  const { errors } = validatePrivacyConfig({ PRIVACY_PROFILE: "local_only", ...LOCAL_ENV });

  assert.deepEqual(errors, []);
});

test("ALLOW_EXTERNAL_PROVIDERS=false veikia ir be local_only profilio", () => {
  const { errors } = validatePrivacyConfig({
    ALLOW_EXTERNAL_PROVIDERS: "false",
    LLM_PROVIDER: "gemini",
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /ALLOW_EXTERNAL_PROVIDERS=false/);
});

test("local_only IMPLIKUOJA išorinių tiekėjų draudimą", () => {
  const config = getPrivacyConfig({
    PRIVACY_PROFILE: "local_only",
    ALLOW_EXTERNAL_PROVIDERS: "true", // sąmoningai prieštaringai
  });

  assert.equal(config.allowExternalProviders, false, "profilis nugali atskirą vėliavą");
});

test("nežinomas profilis atmetamas", () => {
  const { errors } = validatePrivacyConfig({ PRIVACY_PROFILE: "paranoid" });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /Nežinomas PRIVACY_PROFILE/);
});

test("retencija už dokumentuotų ribų atmetama", () => {
  assert.match(
    validatePrivacyConfig({ AUDIT_RETENTION_DAYS: "0" }).errors[0] || "",
    /už leistinų ribų/
  );
  assert.match(
    validatePrivacyConfig({ AUDIT_RETENTION_DAYS: String(RETENTION_LIMITS.maxDays + 1) }).errors[0] || "",
    /už leistinų ribų/
  );
  assert.deepEqual(validatePrivacyConfig({ AUDIT_RETENTION_DAYS: "30" }).errors, []);
});

test("išorinis tiekėjas su standard profiliu duoda ĮSPĖJIMĄ (ne klaidą)", () => {
  const { errors, warnings } = validatePrivacyConfig({ LLM_PROVIDER: "claude" });

  assert.deepEqual(errors, []);

  // Po #4 čia yra DU įspėjimai: apie išorinį tiekėją ir apie tai, kad redakcija
  // prieinama, bet neįjungta. Tikrinam turinį, o ne kiekį - kiekio tikrinimas
  // laužtųsi kaskart pridėjus naują teisėtą įspėjimą.
  const external = warnings.find((w) => /IŠORINIS/.test(w));
  assert.ok(external, `laukta įspėjimo apie išorinį tiekėją, gauta: ${warnings.join(" | ")}`);
  assert.match(external, /Anthropic/);
  assert.match(external, /priklauso nuo jūsų sutarties/);
});

test("startupChecks perima privatumo klaidas (serveris nestartuoja)", () => {
  const { errors } = validateConfig({
    PRIVACY_PROFILE: "local_only",
    LLM_PROVIDER: "claude",
    TRANSCRIPTION_PROVIDER: "mock",
  });

  assert.ok(errors.some((error) => error.includes("local_only")));
});

test("diagnostika rodo efektyvias nuostatas be paslapčių", () => {
  const diagnostics = describeForDiagnostics({
    PRIVACY_PROFILE: "local_only",
    ...LOCAL_ENV,
    AUDIT_RETENTION_DAYS: "7",
    JOB_TTL_MINUTES: "30",
    AUDIO_RETENTION_HOURS: "6",
    ANTHROPIC_API_KEY: "sk-ant-slaptas",
    AUDIT_ID_SALT: "labai-slapta-druska",
  });

  assert.deepEqual(diagnostics, {
    profile: "local_only",
    localOnly: true,
    externalProviders: false,
    auditEnabled: true,
    persistentStorage: false,
    redaction: { requiredBeforeExternal: false, componentDetected: true, configuredForEnforcement: false },
    export: { allowOriginal: true, artifactsPersisted: false },
    storage: {
      jobState: "memory",
      audit: "memory",
      audio: "disk (trinamas po jobo pabaigos)",
    },
    retention: { audit: "7d", jobs: "30m", audio: "6h" },
  });

  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes("sk-ant"), "raktai negali patekti į diagnostiką");
  assert.ok(!serialized.includes("slapta-druska"));
});

test("PRIVACY_MODE=true su local_only duoda įspėjimą apie audito nebuvimą", () => {
  const { warnings } = validatePrivacyConfig({
    PRIVACY_PROFILE: "local_only",
    PRIVACY_MODE: "true",
    ...LOCAL_ENV,
  });

  assert.ok(warnings.some((warning) => warning.includes("auditas išjungtas")));
});

// ─────────────────────────── GDPR #2: retencija ───────────────────────────

test("retencijos ciklas šalina nuskendusius audio failus ir rašo audito įvykį", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-retention-"));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;

  // Politika užšaldyta - po AUDIO_RETENTION_HOURS pakeitimo ją reikia perkurti.
  require("../utils/privacyPolicy")._resetForTests();

  delete require.cache[require.resolve("../utils/fileStorage")];
  delete require.cache[require.resolve("../utils/retentionSweeper")];

  const fileStorage = require("../utils/fileStorage");
  const { runRetentionSweep, purgeOrphanedAudio } = require("../utils/retentionSweeper");
  const auditLog = require("../utils/auditLog");
  const jobStore = require("../utils/jobStore");

  auditLog.clear();

  try {
    // (a) senas nuskendęs failas - turi būti pašalintas
    const orphan = await fileStorage.put(Buffer.from("senas"), { ext: ".wav" });
    const orphanPath = path.join(storageDir, orphan);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(orphanPath, old, old);

    // (b) šviežias failas - NETURI būti šalinamas (jobas gal dar tik kuriamas)
    const fresh = await fileStorage.put(Buffer.from("sviezias"), { ext: ".wav" });

    // (c) senas, bet dar naudojamas jobo su nebaigtu valymu - NETURI būti šalinamas
    const referenced = await fileStorage.put(Buffer.from("naudojamas"), { ext: ".wav" });
    await fs.utimes(path.join(storageDir, referenced), old, old);
    const job = await jobStore.create({
      type: jobStore.JOB_TYPES.TRANSCRIPTION,
      storageKey: referenced,
    });
    await jobStore.update(job.id, {
      status: jobStore.STATUS.COMPLETED,
      audio_cleanup_pending: true,
    });

    const result = await purgeOrphanedAudio();
    assert.equal(result.removed, 1, "pašalintas turi būti tik nuskendęs senas failas");

    await assert.rejects(() => fileStorage.get(orphan));
    assert.ok(await fileStorage.get(fresh), "šviežias failas turi likti");
    assert.ok(await fileStorage.get(referenced), "naudojamas failas turi likti");

    // Audito įvykis su kiekiais, be identifikatorių.
    auditLog.clear();
    const another = await fileStorage.put(Buffer.from("dar vienas"), { ext: ".wav" });
    await fs.utimes(path.join(storageDir, another), old, old);

    const summary = await runRetentionSweep();
    assert.ok(summary.audio >= 1);

    const purgeEvents = auditLog.getAll().filter((entry) => entry.event === "RETENTION_PURGE");
    assert.equal(purgeEvents.length, 1);
    assert.equal(purgeEvents[0].subjectId, null, "šalinimo įvykis nesiejamas su subjektu");
    assert.match(purgeEvents[0].details, /audio=\d+/);
    assert.ok(!JSON.stringify(purgeEvents).includes(another), "failo raktas negali būti audite");

    await jobStore.update(job.id, { audio_cleanup_pending: false });
    await jobStore.remove(job.id);
  } finally {
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;

    delete require.cache[require.resolve("../utils/fileStorage")];
    delete require.cache[require.resolve("../utils/retentionSweeper")];
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("retencijos ciklas be pašalinimų NERAŠO audito įvykio", async () => {
  const auditLog = require("../utils/auditLog");
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  auditLog.clear();
  await runRetentionSweep();

  assert.equal(
    auditLog.getAll().filter((entry) => entry.event === "RETENTION_PURGE").length,
    0,
    "kas valandą rašomas tuščias įvykis išstumtų naudingus per AUDIT_MAX_ENTRIES"
  );
});

test("REGRESIJA: apdorojamo jobo audio NEšalinamas kaip nuskendęs", async () => {
  // Iki pataisos sweeper'is rinko raktus TIK iš deletion_pending/audio_cleanup_pending
  // jobų, tad paprastas queued/processing jobas su senesniu nei AUDIO_RETENTION_HOURS
  // audio (4 val. įrašas, užstrigusi eilė, GPU trūkumas) buvo palaikomas orphan ir jo
  // failas ištrinamas DAR APDOROJANT. Patikrinta: su senuoju kodu šis testas krenta.
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-inuse-"));
  const previousDir = process.env.STORAGE_DIR;
  const previousHours = process.env.AUDIO_RETENTION_HOURS;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUDIO_RETENTION_HOURS = "1";

  // Politika užšaldyta - po AUDIO_RETENTION_HOURS pakeitimo ją reikia perkurti.
  require("../utils/privacyPolicy")._resetForTests();

  delete require.cache[require.resolve("../utils/fileStorage")];
  delete require.cache[require.resolve("../utils/retentionSweeper")];

  const fileStorage = require("../utils/fileStorage");
  const { purgeOrphanedAudio } = require("../utils/retentionSweeper");
  const jobStore = require("../utils/jobStore");

  const created = [];

  try {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000);

    // Kiekvienam statusui - senas failas ir jobas, kuris jį naudoja.
    for (const status of [jobStore.STATUS.QUEUED, jobStore.STATUS.PROCESSING, jobStore.STATUS.COMPLETED]) {
      const key = await fileStorage.put(Buffer.from(`irasas-${status}`), { ext: ".wav" });
      await fs.utimes(path.join(storageDir, key), old, old);

      const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION, storageKey: key });
      await jobStore.update(job.id, { status });
      created.push({ job, key, status });
    }

    // Ir vienas TIKRAS orphan - senas failas be jokio jobo.
    const orphanKey = await fileStorage.put(Buffer.from("tikras orphan"), { ext: ".wav" });
    await fs.utimes(path.join(storageDir, orphanKey), old, old);

    const result = await purgeOrphanedAudio();

    assert.equal(result.removed, 1, "pašalintas turi būti TIK failas be jokio jobo");

    for (const { key, status } of created) {
      assert.ok(
        await fileStorage.get(key),
        `jobo su statusu "${status}" audio failas turi likti`
      );
    }

    await assert.rejects(() => fileStorage.get(orphanKey), "tikras orphan turi būti pašalintas");
  } finally {
    for (const { job } of created) await jobStore.remove(job.id).catch(() => {});

    if (previousDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousDir;
    if (previousHours === undefined) delete process.env.AUDIO_RETENTION_HOURS;
    else process.env.AUDIO_RETENTION_HOURS = previousHours;

    delete require.cache[require.resolve("../utils/fileStorage")];
    delete require.cache[require.resolve("../utils/retentionSweeper")];
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("fail-safe: saugykla be listReferencedStorageKeys() nieko netrina", async () => {
  // TESTO DEFEKTAS, kurį tai taiso: anksčiau šis testas nesukurdavo STORAGE_DIR,
  // tad purgeOrphanedAudio() nukrisdavo dar ties `fs.readdir` (katalogo nėra) ir
  // grąžindavo {removed: 0} NEPASIEKĘS fail-safe šakos. Švariame klone testas
  // krisdavo, o kūrimo kataloge "praeidavo" tik todėl, kad backend/storage/uploads
  // jau buvo sukurtas ankstesnių paleidimų - t. y. rezultatas priklausė nuo aplinkos.
  //
  // Dabar tikrinamas TIKRAS scenarijus: yra katalogas, yra senas failas, o saugykla
  // negali išvardyti jobų -> failas turi LIKTI.
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-failsafe-"));
  const previousDir = process.env.STORAGE_DIR;
  const previousHours = process.env.AUDIO_RETENTION_HOURS;
  process.env.STORAGE_DIR = storageDir;
  process.env.AUDIO_RETENTION_HOURS = "1";

  const fileStoragePath = require.resolve("../utils/fileStorage");
  const jobStorePath = require.resolve("../utils/jobStore");
  const sweeperPath = require.resolve("../utils/retentionSweeper");

  const originalJobStore = require.cache[jobStorePath];
  for (const modulePath of [fileStoragePath, jobStorePath, sweeperPath]) {
    delete require.cache[modulePath];
  }

  const fileStorage = require(fileStoragePath);

  // Senas failas, kurį BE fail-safe sweeper'is palaikytų nuskendusiu ir ištrintų.
  const key = await fileStorage.put(Buffer.from("nezinomos saugyklos audio"), { ext: ".wav" });
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
  await fs.utimes(path.join(storageDir, key), old, old);

  // Saugykla be naujo metodo -> fasadas grąžina null.
  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: { listReferencedStorageKeys: async () => null },
  };

  try {
    const { purgeOrphanedAudio } = require(sweeperPath);
    const result = await purgeOrphanedAudio();

    assert.equal(result.removed, 0);
    assert.equal(result.skippedReason, "unsupported-store");

    // Svarbiausia: failas turi realiai likti diske.
    assert.ok(
      await fileStorage.get(key),
      "nežinant naudojamų raktų, failo trinti negalima (geriau likęs nei ištrintas naudojamas)"
    );
  } finally {
    if (previousDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousDir;
    if (previousHours === undefined) delete process.env.AUDIO_RETENTION_HOURS;
    else process.env.AUDIO_RETENTION_HOURS = previousHours;

    for (const modulePath of [fileStoragePath, jobStorePath, sweeperPath]) {
      delete require.cache[modulePath];
    }
    if (originalJobStore) require.cache[jobStorePath] = originalJobStore;

    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("purgeOrphanedAudio: nėra storage katalogo - grąžina nulius be klaidos", async () => {
  // Atskiras testas TAM, ką senasis fail-safe testas netyčia tikrino: kai
  // uploads katalogo dar nėra (šviežias diegimas), tai NE klaida ir ne fail-safe -
  // tiesiog nėra ko trinti.
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-empty-"));
  const previousDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = path.join(emptyDir, "nera-tokio");

  const fileStoragePath = require.resolve("../utils/fileStorage");
  const sweeperPath = require.resolve("../utils/retentionSweeper");
  for (const modulePath of [fileStoragePath, sweeperPath]) delete require.cache[modulePath];

  try {
    const { purgeOrphanedAudio } = require(sweeperPath);
    const result = await purgeOrphanedAudio();

    assert.equal(result.removed, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.skippedReason, undefined);
  } finally {
    if (previousDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousDir;
    for (const modulePath of [fileStoragePath, sweeperPath]) delete require.cache[modulePath];
    await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("centralizuotas retencijos ciklas išvalo ir pasenusius JOBUS", async () => {
  // Iš server.js pašalintas atskiras sweepTimer (kas 5 min kvietė tą patį
  // jobStore.sweepExpired()). Todėl būtina, kad jobų valymą realiai padarytų
  // retentionSweeper - kitaip jobai apskritai nebebūtų šalinami.
  const jobStore = require("../utils/jobStore");
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED });

  const farFuture = Date.now() + 10 * 24 * 60 * 60 * 1000;
  const summary = await runRetentionSweep({ now: farFuture });

  assert.ok(summary.jobs >= 1, "retencijos ciklas turi šalinti pasenusius jobus");
  assert.equal(await jobStore.get(job.id), null);
});

test("numatytasis retencijos intervalas nesumažina jobų valymo tankumo", () => {
  // Senasis sweepTimer veikė kas 5 min. Pašalinus jį, numatytasis retencijos
  // intervalas turi likti toks pat tankus, kitaip JOB_TTL_MINUTES faktinis
  // vykdymas nusitęstų iki TTL + 60 min.
  assert.equal(getPrivacyConfig({}).retentionSweepMinutes, 5);
  assert.equal(getPrivacyConfig({ RETENTION_SWEEP_INTERVAL_MINUTES: "30" }).retentionSweepMinutes, 30);
});

test("NODE_ENV=production be AUDIT_ID_SALT NEBLOKUOJA starto (tik įspėjimas)", () => {
  // Tiksliai CI `docker` job'o scenarijus: backend image'e ENV NODE_ENV=production,
  // o AUDIT_ID_SALT ten niekas nenustato. Kieta klaida čia buvo sulaužiusi
  // dokumentuotą `docker compose up` kelią - konteineris nebepasileisdavo.
  const { errors, warnings } = validateConfig({
    NODE_ENV: "production",
    LLM_PROVIDER: "mock",
    TRANSCRIPTION_PROVIDER: "mock",
    DIARIZATION_PROVIDER: "none",
  });

  assert.deepEqual(errors, [], "serveris turi startuoti");
  assert.ok(
    warnings.some((w) => w.includes("AUDIT_ID_SALT")),
    "bet administratorius turi būti įspėtas"
  );
});

/* ------------------------------------------------------------------ *
 * GDPR #5: persistentinės saugyklos išjungimas (PERSISTENT_STORAGE)
 * ------------------------------------------------------------------ */

test("PERSISTENT_STORAGE nenustatyta - išvedama iš REDIS_URL", () => {
  assert.equal(getPrivacyConfig({ ...LOCAL_ENV }).persistentStorage, false);
  assert.equal(
    getPrivacyConfig({ ...LOCAL_ENV, REDIS_URL: "redis://localhost:6379" }).persistentStorage,
    true
  );

  // Išvedimas NĖRA prieštaravimas - esami diegimai su REDIS_URL turi startuoti.
  const { errors } = validatePrivacyConfig({ ...LOCAL_ENV, REDIS_URL: "redis://localhost:6379" });
  assert.deepEqual(errors, []);
});

test("PERSISTENT_STORAGE=false su REDIS_URL = startup KLAIDA (ne tylus ignoravimas)", () => {
  const { errors } = validatePrivacyConfig({
    ...LOCAL_ENV,
    PERSISTENT_STORAGE: "false",
    REDIS_URL: "redis://localhost:6379",
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /PERSISTENT_STORAGE=false/);
  assert.match(errors[0], /REDIS_URL/);
});

test("PERSISTENT_STORAGE=false su REDIS_REQUIRED=true = klaida", () => {
  const { errors } = validatePrivacyConfig({
    ...LOCAL_ENV,
    PERSISTENT_STORAGE: "false",
    REDIS_REQUIRED: "true",
  });

  assert.ok(errors.some((e) => /REDIS_REQUIRED/.test(e)));
});

test("PERSISTENT_STORAGE=true be REDIS_URL = klaida (persistencija atmintyje būtų melas)", () => {
  const { errors } = validatePrivacyConfig({ ...LOCAL_ENV, PERSISTENT_STORAGE: "true" });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /REDIS_URL nenustatytas/);
});

test("PERSISTENT_STORAGE=false praeina ir įspėja apie duomenų praradimą po restarto", () => {
  const { errors, warnings } = validatePrivacyConfig({
    ...LOCAL_ENV,
    PERSISTENT_STORAGE: "false",
  });

  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /tik atmintyje/.test(w)));
});

test("efemeriškame režime AUDIO_RETENTION_HOURS ribojama, o riba - matoma", () => {
  const env = { ...LOCAL_ENV, PERSISTENT_STORAGE: "false", AUDIO_RETENTION_HOURS: "24" };
  const config = getPrivacyConfig(env);

  assert.equal(config.audioRetentionHours, 1, "efektyvi reikšmė apribota");
  assert.equal(config.audioRetentionHoursConfigured, 24, "konfigūruota reikšmė išsaugota");

  // Tyli neatitiktis būtų blogiau nei apribojimas - administratorius turi ją pamatyti.
  const { warnings } = validatePrivacyConfig(env);
  assert.ok(warnings.some((w) => /sumažinta iki 1/.test(w)));
});

test("PERSISTENT_STORAGE=maybe atmetama kaip netaisyklinga reikšmė", () => {
  const { errors } = validatePrivacyConfig({ ...LOCAL_ENV, PERSISTENT_STORAGE: "maybe" });
  assert.ok(errors.some((e) => /PERSISTENT_STORAGE/.test(e)));
});

test("diagnostika rodo, KUR konkrečiai duomenys gyvena", () => {
  const ephemeral = describeForDiagnostics({ ...LOCAL_ENV, PERSISTENT_STORAGE: "false" });
  assert.equal(ephemeral.persistentStorage, false);
  assert.equal(ephemeral.storage.jobState, "memory");
  assert.equal(ephemeral.storage.audit, "memory");

  const persistent = describeForDiagnostics({ ...LOCAL_ENV, REDIS_URL: "redis://localhost:6379" });
  assert.equal(persistent.storage.jobState, "redis");

  // Paslapčių diagnostikoje būti negali.
  assert.ok(!JSON.stringify(persistent).includes("redis://"));
});

test("startupChecks perima persistencijos prieštaravimą (serveris nestartuoja)", () => {
  const { errors } = validateConfig({
    ...LOCAL_ENV,
    NODE_ENV: "development",
    PERSISTENT_STORAGE: "false",
    REDIS_URL: "redis://localhost:6379",
  });

  assert.ok(errors.some((e) => /PERSISTENT_STORAGE=false/.test(e)));
});

/**
 * ---------------------------------------------------------------------------
 * GDPR #5: redakcija prieš išorinį apdorojimą (REQUIRE_REDACTION_BEFORE_EXTERNAL)
 *
 * Nuostata konfigūruojama ČIA, bet realų redagavimą atlieka #4 komponentas.
 * Todėl svarbiausias testas yra pirmasis: kol #4 nėra, vėliava NEGALI tyliai
 * praeiti - kitaip ji būtų neįvykdomas saugumo pažadas.
 * ---------------------------------------------------------------------------
 */

const privacyConfig = require("../utils/privacyConfig");
const redactionComponent = require("../utils/redactionComponent");

function _missingModuleLoader() {
  const error = new Error("Cannot find module './piiRedaction'");
  error.code = "MODULE_NOT_FOUND";
  throw error;
}

/**
 * Suvaidina, ar #4 komponentas prieinamas.
 *
 * SVARBU: `available=false` dabar reikalauja EKSPLICITINĖS simuliacijos, nes
 * utils/piiRedaction.js realiai egzistuoja. Anksčiau užteko `null` (reali
 * patikra nieko nerasdavo) - ta prielaida nebegalioja, ir būtent ji sulaužė 12
 * testų, kai #4 nusileido. Tai teisingas testų elgesys: jie fiksavo laikiną
 * būseną ir garsiai pranešė, kai ji pasikeitė.
 */
function withRedaction(available, fn) {
  redactionComponent._setLoaderForTests(
    available ? () => ({ redact: (text) => text }) : _missingModuleLoader
  );
  try {
    return fn();
  } finally {
    redactionComponent._setLoaderForTests(null);
  }
}

test("redakcijos komponentas (#4) YRA įgyvendintas", () => {
  assert.equal(privacyConfig.isRedactionAvailable(), true);

  // Kontraktas, kurio tikisi utils/redactionComponent.js.
  const mod = require("../utils/piiRedaction");
  assert.equal(typeof mod.redact, "function");
  assert.equal(typeof mod.POLICY_VERSION, "string");
});

test("REQUIRE_REDACTION_BEFORE_EXTERNAL=true be komponento = startup KLAIDA", () => {
  // Komponentas dabar yra, tad „jo nėra" simuliuojama eksplicitiškai.
  withRedaction(false, () => {
    const { errors } = validatePrivacyConfig({
      LLM_PROVIDER: "claude",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /issue #4/);
    assert.match(errors[0], /piiRedaction/);
  });
});

test("REQUIRE_REDACTION_BEFORE_EXTERNAL=true su REALIU komponentu praeina", () => {
  const { errors } = validatePrivacyConfig({
    LLM_PROVIDER: "claude",
    REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
  });

  assert.deepEqual(errors, [], "įgyvendinus #4 nuostata nebeblokuoja starto");
});

test("startupChecks perima redakcijos prieštaravimą (serveris nestartuoja)", () => {
  withRedaction(false, () => {
    const { errors } = validateConfig({
      LLM_PROVIDER: "claude",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.ok(errors.some((error) => /REQUIRE_REDACTION_BEFORE_EXTERNAL/.test(error)));
  });
});

test("su įgyvendintu #4 ta pati konfigūracija praeina be klaidų", () => {
  withRedaction(true, () => {
    const { errors } = validatePrivacyConfig({
      LLM_PROVIDER: "claude",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.deepEqual(errors, []);
  });
});

test("reikalaujama redakcija be išorinių tiekėjų - įspėjimas apie nulinį efektą", () => {
  withRedaction(true, () => {
    const { errors, warnings } = validatePrivacyConfig({
      ...LOCAL_ENV,
      PRIVACY_PROFILE: "local_only",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => /neturi jokio efekto/.test(w)));
  });
});

test("#4 prieinamas, bet nuostata neįjungta - įspėjimas apie NEREDAGUOTUS duomenis", () => {
  withRedaction(true, () => {
    const { warnings } = validatePrivacyConfig({ LLM_PROVIDER: "claude" });

    assert.ok(warnings.some((w) => /NEREDAGUOTA/.test(w)));
  });
});

test("be komponento ir be nuostatos jokio redakcijos triukšmo nėra", () => {
  withRedaction(false, () => {
    const { errors, warnings } = validatePrivacyConfig({ LLM_PROVIDER: "claude" });

    assert.deepEqual(errors, []);
    assert.ok(!warnings.some((w) => /NEREDAGUOTA/.test(w)));
  });
});

test("SU komponentu, bet be nuostatos - ĮSPĖJIMAS apie neredaguotus duomenis", () => {
  // Naujas numatytasis elgesys po #4: komponentas yra, tad tyla būtų klaidinanti.
  const { warnings } = validatePrivacyConfig({ LLM_PROVIDER: "claude" });

  assert.ok(warnings.some((w) => /NEREDAGUOTA/.test(w)));
});

test("REQUIRE_REDACTION_BEFORE_EXTERNAL=maybe atmetama kaip netaisyklinga reikšmė", () => {
  const { errors } = validatePrivacyConfig({
    ...LOCAL_ENV,
    REQUIRE_REDACTION_BEFORE_EXTERNAL: "maybe",
  });

  assert.ok(errors.some((e) => /REQUIRE_REDACTION_BEFORE_EXTERNAL/.test(e)));
});

test("diagnostika rodo IR reikalavimą, IR realų prieinamumą", () => {
  withRedaction(false, () => {
    assert.deepEqual(describeForDiagnostics({ ...LOCAL_ENV }).redaction, {
      requiredBeforeExternal: false,
      componentDetected: false,
      configuredForEnforcement: false,
    });
  });

  // Su įgyvendintu #4 komponentas aptinkamas be jokio perjungimo.
  assert.equal(describeForDiagnostics({ ...LOCAL_ENV }).redaction.componentDetected, true);

  withRedaction(true, () => {
    const withModule = describeForDiagnostics({
      ...LOCAL_ENV,
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    // LOCAL_ENV naudoja LLM_PROVIDER=mock (lokalus) - reikalavimas yra, komponentas
    // yra, bet apvynioti nėra ko: todėl tai atskiras laukas.
    assert.deepEqual(withModule.redaction, {
      requiredBeforeExternal: true,
      componentDetected: true,
      configuredForEnforcement: false,
    });

    const external = describeForDiagnostics({
      LLM_PROVIDER: "claude",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });
    assert.equal(external.redaction.configuredForEnforcement, true);
  });
});

test("trys komponento būsenos duoda TRIS skirtingus pranešimus (ne vieną 'nėra')", () => {
  const cases = [
    [_missingModuleLoader, /issue #4/],
    [
      () => {
        throw new SyntaxError("netikėtas simbolis");
      },
      /neįsikelia: netikėtas simbolis/,
    ],
    [() => ({}), /neeksportuoja redact\(\)/],
  ];

  for (const [loader, expected] of cases) {
    redactionComponent._setLoaderForTests(loader);
    try {
      const { errors } = validatePrivacyConfig({
        LLM_PROVIDER: "claude",
        REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
      });
      assert.ok(errors.some((e) => expected.test(e)), `laukta ${expected}, gauta: ${errors.join(" | ")}`);
    } finally {
      redactionComponent._setLoaderForTests(null);
    }
  }
});

test("reikalaujama redakcija + IŠORINIS transkribavimas = klaida (garso redaguoti negalima)", () => {
  withRedaction(true, () => {
    const { errors } = validatePrivacyConfig({
      LLM_PROVIDER: "claude",
      TRANSCRIPTION_PROVIDER: "whisper",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.ok(errors.some((e) => /transcription/.test(e) && /garso dengti negali/.test(e)));
  });
});

test("reikalaujama redakcija + debesų diarizacija = klaida", () => {
  withRedaction(true, () => {
    const { errors } = validatePrivacyConfig({
      LLM_PROVIDER: "claude",
      TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
      DIARIZATION_PROVIDER: "pyannote-cloud",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.ok(errors.some((e) => /diarization/.test(e)));
  });
});

test("reikalaujama redakcija + LOKALUS audio kelias = praeina", () => {
  withRedaction(true, () => {
    const { errors } = validatePrivacyConfig({
      LLM_PROVIDER: "claude",
      TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
      DIARIZATION_PROVIDER: "pyannote",
      REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
    });

    assert.deepEqual(errors, []);
  });
});

test("įspėjimas apie NEREDAGUOTUS duomenis netaikomas, kai išorinis tik transkribavimas", () => {
  withRedaction(true, () => {
    const { warnings } = validatePrivacyConfig({
      LLM_PROVIDER: "mock",
      TRANSCRIPTION_PROVIDER: "whisper",
    });

    // `anyExternal` čia true (Whisper), bet LLM lokalus - pranešimas apie
    // transkripcijos siuntimą LLM tiekėjui būtų klaidingas.
    assert.ok(!warnings.some((w) => /NEREDAGUOTA/.test(w)));
  });
});

test("STARTUP: nežinoma PII_REDACTION_CATEGORIES reikšmė stabdo startą", () => {
  // README ir .env.example tai žada; iki šio pataisymo pažadas negaliojo -
  // klaida iškildavo tik pirmos realios redakcijos metu, jau priiminėjant
  // užklausas.
  const { errors } = validatePrivacyConfig({ PII_REDACTION_CATEGORIES: "persnal_code" });

  assert.ok(errors.some((e) => /PII_REDACTION_CATEGORIES/.test(e)));
  assert.ok(errors.some((e) => /personal_code, email, phone, iban/.test(e)), "klaida turi rodyti galimas reikšmes");
});

test("STARTUP: startupChecks perima kategorijų klaidą (serveris nestartuoja)", () => {
  const { errors } = validateConfig({ PII_REDACTION_CATEGORIES: "email,nesamas" });

  assert.ok(errors.some((e) => /PII_REDACTION_CATEGORIES/.test(e)));
});

test("STARTUP: teisingos kategorijos praeina ir patenka į politiką", () => {
  const { errors } = validatePrivacyConfig({ PII_REDACTION_CATEGORIES: "personal_code,email" });
  assert.deepEqual(errors, []);

  const { getPrivacyConfig } = require("../utils/privacyConfig");
  assert.deepEqual(getPrivacyConfig({ PII_REDACTION_CATEGORIES: "personal_code,email" }).redactionCategories, [
    "PERSONAL_CODE",
    "EMAIL",
  ]);
});

test("POLITIKA: kategorijos yra UŽŠALDYTOS, kaip ir likusi privatumo politika", () => {
  const { getPrivacyConfig } = require("../utils/privacyConfig");
  const categories = getPrivacyConfig({}).redactionCategories;

  assert.equal(Object.isFrozen(categories), true);
  assert.deepEqual(categories, ["PERSONAL_CODE", "EMAIL", "PHONE", "IBAN"]);
});
