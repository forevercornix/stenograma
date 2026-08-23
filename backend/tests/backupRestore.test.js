const { markCompleted } = require("./helpers/jobPhaseFixtures");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.BACKUP_ENABLED = "true";

const jobStore = require("../utils/jobStore");
const fileStorage = require("../utils/fileStorage");
const tombstones = require("../utils/deletionTombstones");
const auditLog = require("../utils/auditLog");
const backupService = require("../services/backupService");
const restoreService = require("../services/restoreService");
const backupManifest = require("../utils/backupManifest");
const { STEPS } = restoreService;

/**
 * #20 PR2: KOPIJAVIMAS IR ATKŪRIMAS.
 */

test.after(() => {
  tombstones._stopSweepForTests();
});

async function completedJob(overrides = {}) {
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL, ...overrides });
  await markCompleted(jobStore.system, job.id, { result: { pavadinimas: "Testas" } });
  return jobStore.system.get(job.id);
}

test("KOPIJA: išjungta pagal nutylėjimą – reikia sąmoningo įjungimo", async () => {
  await assert.rejects(
    () => backupService.createBackup({ env: {} }),
    (e) => e.code === "BACKUP_DISABLED"
  );
});

test("MOMENTINIS VAIZDAS: vykdomi darbai PRALEIDŽIAMI ir užfiksuojami", async () => {
  /**
   * Kopija su `excludedInFlightJobs: 3` nėra sugadinta – ji sąmoningai neapima
   * trijų tuo metu vykdytų darbų. Be šio įrašo ta pati kopija atrodytų kaip
   * nepilna dėl nežinomos priežasties, ir operatorius negalėtų atskirti
   * sąmoningo praleidimo nuo gedimo.
   */
  await jobStore.init();
  await completedJob();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION }); // lieka `queued`

  const { manifest } = await backupService.createBackup({ actor: "sysadmin" });

  assert.ok(manifest.snapshotTime, "momentinio vaizdo laikas privalomas");
  assert.ok(manifest.excludedInFlightJobs >= 1, "vykdomas darbas turi būti praleistas");
  assert.equal(manifest.excludedReason, "in_progress");
});

test("MOMENTINIS VAIZDAS: kai viskas stabilu, priežasties NĖRA", async () => {
  /**
   * `excludedReason: null` ir `excludedReason: "in_progress"` turi reikšti
   * skirtingus dalykus. Visada užpildyta priežastis nieko nesakytų.
   */
  await jobStore.init();
  for (const job of await jobStore.system.listAll()) await jobStore.system.remove(job.id);

  await completedJob();

  const { manifest } = await backupService.createBackup({ actor: "sysadmin" });

  assert.equal(manifest.excludedInFlightJobs, 0);
  assert.equal(manifest.excludedReason, null);
});

test("KOPIJA: apima `source_audio` – vienas režimas, be pasirinkimų", async () => {
  /**
   * Dviejų režimų (su audio / be audio) sąmoningai nėra: riba yra **kopija
   * atkuria sistemą, eksportas išneša rezultatus**.
   */
  await jobStore.init();
  const key = await fileStorage.put(Buffer.from("audio-turinys"), { ext: ".mp3" });
  await completedJob({ storageKey: key });

  const { manifest, data } = await backupService.createBackup({ actor: "sysadmin" });

  const audioEntry = manifest.contents.find((c) => c.type === "source_audio");
  assert.ok(audioEntry.count >= 1, "audio turi patekti į kopiją");

  const parsed = JSON.parse(data.toString("utf8"));
  assert.ok(parsed.audio.some((a) => a.key === key), "audio failas turi būti turinyje");
});

test("KOPIJA: dingęs audio failas NĖRA gedimas", async () => {
  /**
   * Audio galėjo būti teisėtai išvalytas po apdorojimo (`audio_cleanup`).
   * Kopija tada tiesiog jo neturi.
   */
  await jobStore.init();
  await completedJob({ storageKey: "uploads/nebeegzistuoja.mp3" });

  const { manifest } = await backupService.createBackup({ actor: "sysadmin" });

  assert.ok(manifest, "kopija turi būti sukurta nepaisant dingusio failo");
});

test("ATKŪRIMAS: pilnas ciklas grąžina jobą", async () => {
  await jobStore.init();
  const job = await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  await jobStore.system.remove(job.id);
  assert.equal(await jobStore.system.get(job.id), null);

  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  assert.equal(result.ok, true, `atkūrimas nepavyko: ${result.reason}`);
  assert.ok(await jobStore.system.get(job.id), "jobas turi grįžti");
});

test("ATKŪRIMAS: grandinė vykdoma NUOSEKLIAI ir fiksuoja žingsnius", async () => {
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  assert.deepEqual(result.completedSteps, [
    STEPS.MANIFEST,
    STEPS.FORMAT,
    STEPS.APPLICATION,
    STEPS.CHECKSUM,
    STEPS.DECRYPTED,
    STEPS.CONTENT,
    STEPS.SECRETS,
    STEPS.CONFIGURATION,
    STEPS.PRIVACY,
    STEPS.APPLIED,
  ]);
});

test("FAIL-CLOSED: SUGADINTAS turinys sustabdo atkūrimą", async () => {
  /**
   * Sugadinta ar nepilna kopija NIEKADA neatkuriama tyliai. Priešingu atveju
   * atkūrimas bandytų „kiek pavyks", ir rezultatas atrodytų kaip sėkmė.
   */
  await jobStore.init();
  const job = await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  await jobStore.system.remove(job.id);

  const corrupted = Buffer.from(backup.data.toString("utf8").replace("completed", "corrupt!!"));
  const result = await restoreService.restoreBackup({ manifest: backup.manifest, data: corrupted });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.CHECKSUM);
  assert.equal(await jobStore.system.get(job.id), null, "sugadinta kopija NEGALI nieko atkurti");
});

test("FAIL-CLOSED: sustojus grandinei sistema LIEKA NEPALIESTA", async () => {
  /**
   * ATOMIŠKUMAS. Visos patikros atliekamos su duomenimis atmintyje; iki
   * pritaikymo momento veikianti sistema nepaliečiama nė karto.
   *
   * Priešingu atveju nutrūkęs atkūrimas paliktų sistemą pusiau senos, pusiau
   * naujos būsenos mišinyje.
   */
  await jobStore.init();
  const survivor = await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });

  // Sugadinam manifestą – grandinė sustos pirmame žingsnyje.
  const broken = { ...backup.manifest };
  delete broken.checksum;

  const before = (await jobStore.system.listAll()).length;
  const result = await restoreService.restoreBackup({ manifest: broken, data: backup.data });
  const after = (await jobStore.system.listAll()).length;

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.MANIFEST);
  assert.equal(after, before, "nepavykęs atkūrimas neturi keisti sistemos būklės");
  assert.ok(await jobStore.system.get(survivor.id), "esami jobai turi likti");
});

test("FAIL-CLOSED: NAUJESNIS formatas atmetamas", async () => {
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const future = { ...backup.manifest, formatVersion: backup.manifest.formatVersion + 1 };

  const result = await restoreService.restoreBackup({ manifest: future, data: backup.data });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.FORMAT);
});

test("FAIL-CLOSED: nesuderinama PROGRAMOS versija atmetama", async () => {
  /**
   * Tikrinama MAJOR dalis: skirtingas major reiškia nesuderinamus pakeitimus
   * pagal semver, tad atkurti tokią kopiją būtų spėlionė.
   */
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const old = { ...backup.manifest, applicationVersion: "0.9.0" };

  const result = await restoreService.restoreBackup({ manifest: old, data: backup.data });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.APPLICATION);
  assert.match(result.reason, /nesuderinama/i);
});

test("SUDERINAMUMAS: MINOR ir PATCH skirtumai LEIDŽIAMI", async () => {
  /**
   * Priešingu atveju kiekvienas pataisymų leidimas padarytų vakarykštes
   * kopijas neatkuriamas, ir kopijų prasmė dingtų.
   */
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const current = require("../package.json").version;
  const major = current.split(".")[0];

  const result = await restoreService.restoreBackup({
    manifest: { ...backup.manifest, applicationVersion: `${major}.0.0` },
    data: backup.data,
  });

  assert.equal(result.ok, true, `minor skirtumas turi būti leidžiamas: ${result.reason}`);
});

test("SUDERINAMUMAS: `unknown` versija praleidžiama su įspėjimu", async () => {
  /**
   * `unknown` atsiranda, kai `package.json` nepasiekiamas supakuotoje
   * aplinkoje. Atmetus tokią kopiją, atkūrimas taptų neįmanomas būtent ten,
   * kur jo labiausiai reikia.
   */
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const result = await restoreService.restoreBackup({
    manifest: { ...backup.manifest, applicationVersion: "unknown" },
    data: backup.data,
  });

  assert.equal(result.ok, true);
});

test("ŽYMOS: ištrintas jobas NEGRĮŽTA iš kopijos", async () => {
  /**
   * SVARBIAUSIA šio failo garantija.
   *
   * Be jos atsarginė kopija taptų būdu APEITI GDPR ištrynimą, ir visos #19
   * garantijos taptų laikinos: pakaktų atkurti kopiją, kad ištrinti duomenys
   * grįžtų.
   *
   * Kopija atkuria BŪKLĘ, bet negali atšaukti sprendimo ištrinti.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  // Ištrynimas su žyma.
  await jobStore.system.remove(job.id);
  tombstones.mark(job.id, { actor: "sysadmin" });
  tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED);

  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  assert.equal(result.ok, true, "atkūrimas pats pavyksta");
  assert.equal(await jobStore.system.get(job.id), null, "bet ištrintas jobas NEGRĮŽTA");
});

test("ŽYMOS: `pending` žyma irgi blokuoja atkūrimą", async () => {
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  await jobStore.system.remove(job.id);
  tombstones.mark(job.id, { actor: "sysadmin" }); // dar `deletion_pending`

  await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  assert.equal(await jobStore.system.get(job.id), null, "vykstant ištrynimui atkūrimas irgi blokuojamas");
});

test("SAUGYKLA: raktas iš kopijos VALIDUOJAMAS (kelio apėjimas)", async () => {
  /**
   * Raktas ateina IŠ KOPIJOS FAILO, tad negali būti pasitikimas. Be patikros
   * `../../etc/passwd` tipo raktas leistų rašyti už saugyklos ribų.
   */
  for (const bad of ["../../etc/passwd", "uploads/../../evil", "/etc/passwd", "kitas/failas.mp3"]) {
    await assert.rejects(
      () => fileStorage.putAtKey(bad, Buffer.from("x")),
      (e) => e.code === "INVALID_STORAGE_KEY",
      `raktas "${bad}" turėjo būti atmestas`
    );
  }

  const ok = await fileStorage.putAtKey("uploads/teisetas-123.mp3", Buffer.from("x"));
  assert.equal(ok, "uploads/teisetas-123.mp3");
});

test("AUDITAS: kopijavimas ir atkūrimas fiksuojami su aktoriumi", async () => {
  await jobStore.init();
  await completedJob();

  const before = auditLog.getAll().length;

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  const nauji = auditLog.getAll().slice(before);

  const created = nauji.find((e) => e.event === "BACKUP_CREATED");
  const restored = nauji.find((e) => e.event === "BACKUP_RESTORED");

  assert.ok(created, "kopijavimas turi būti audituojamas");
  assert.ok(restored, "atkūrimas turi būti audituojamas");
  assert.equal(created.actor, "sysadmin");
  assert.equal(restored.actor, "sysadmin");
});

test("AUDITAS: nepavykęs atkūrimas fiksuojamas su ŽINGSNIU", async () => {
  /**
   * Be žingsnio nepavykęs atkūrimas atrodo vienodai nepaisant priežasties, ir
   * operatorius nežino, ar problema kopijoje, ar sistemoje.
   */
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const before = auditLog.getAll().length;

  await restoreService.restoreBackup({
    manifest: { ...backup.manifest, formatVersion: 999 },
    data: backup.data,
    actor: "sysadmin",
  });

  const failed = auditLog
    .getAll()
    .slice(before)
    .find((e) => e.event === "BACKUP_RESTORE_FAILED");

  assert.ok(failed, "nesėkmė turi būti audituojama");
  assert.equal(failed.outcome, STEPS.FORMAT);
  // Audito įrašas naudoja `result`, ne `success` (ta pati forma kaip #19).
  assert.equal(failed.result, "failure");
});

test("SAUGUMAS: audite ir rezultate NĖRA kelių, raktų ar turinio", async () => {
  await jobStore.init();
  const key = await fileStorage.put(Buffer.from("slaptas audio"), { ext: ".mp3" });
  await completedJob({ storageKey: key });

  const before = auditLog.getAll().length;
  const backup = await backupService.createBackup({ actor: "sysadmin" });
  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  const auditSerialized = JSON.stringify(auditLog.getAll().slice(before));
  const resultSerialized = JSON.stringify(result);

  for (const [name, serialized] of [
    ["auditas", auditSerialized],
    ["rezultatas", resultSerialized],
  ]) {
    assert.ok(!/\/tmp\/|\/home\/|\/var\//.test(serialized), `${name}: jokių failų kelių`);
    assert.ok(!serialized.includes("slaptas audio"), `${name}: jokio turinio`);
    assert.ok(!serialized.includes(key), `${name}: jokių saugyklos raktų`);
  }
});

test("MANIFESTAS: kopijos manifestas praeina savo paties validaciją", () => {
  /**
   * Skamba savaime suprantamai, bet būtent čia pasimato neatitikimas tarp
   * kūrimo ir tikrinimo: jei `createManifest` pamirštų lauką, kurio reikalauja
   * `validateManifest`, kopijos būtų kuriamos neatkuriamos.
   */
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 10 }],
    checksum: "abc",
  });

  const check = backupManifest.validateManifest(manifest);
  assert.equal(check.valid, true, `savas manifestas neturi kristi: ${check.errors.join("; ")}`);
});

test("RIBA: pritaikymas NĖRA transakcinis – užrašyta kode", () => {
  /**
   * Sąžiningumo patikra.
   *
   * Patikros iki pritaikymo pašalina PRIEŽASTIS, dėl kurių atkūrimas nutrūktų
   * (netinkamas formatas, sugadintas turinys), bet infrastruktūros gedimo
   * (procesas nukrenta rašant) jos neapima.
   *
   * Be aiškaus įrašo ši riba taptų nematoma, o dokumentacija tvirtintų
   * daugiau, nei sistema daro.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "services", "restoreService.js"), "utf8");

  assert.match(source, /NĖRA transakcinis|nėra transakcinis/i, "riba turi būti įvardyta kode");
  assert.match(source, /rollback|duomenų bazės/i, "turi būti nurodyta, ko reikėtų tikram atomiškumui");
});

test("AUDITAS: į kopiją NEPATENKA", async () => {
  /**
   * SPRENDIMAS, priimtas po review: auditas nekopijuojamas.
   *
   * Pirmoji versija jį surinkdavo, bet atkūrimas neatstatydavo – tarpinė
   * būsena, kurioje kopija turėjo duomenų, kurių niekas nenaudojo.
   *
   * Priežastis, dėl kurios pasirinkta NEKOPIJUOTI (o ne atkurti): #19
   * ištrynimas ŠALINA audito įrašus, o žymų apsauga dengia jobus pagal ID –
   * audito įrašai saugo pseudonimizuotą subjektą, tad ta patikra jų neapima.
   * Atkūrus auditą, GDPR ištrinti įrašai grįžtų.
   */
  await jobStore.init();
  await completedJob();

  const { manifest, data } = await backupService.createBackup({ actor: "sysadmin" });

  assert.ok(
    !manifest.contents.some((c) => c.type === "audit_entry"),
    "auditas neturi būti manifeste"
  );

  const parsed = JSON.parse(data.toString("utf8"));
  assert.equal(parsed.audit, undefined, "audito neturi būti turinyje");
});

test("AUDITAS: SENA kopija su auditu praleidžiama, ne atkuriama", async () => {
  /**
   * Ankstyvos kopijos galėjo turėti `audit` lauką. Atkūrus jį, GDPR ištrinti
   * audito įrašai grįžtų. Kopija dėl to netampa netinkama – ta jos dalis
   * tiesiog ignoruojama.
   */
  await jobStore.init();
  const job = await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  // Imituojam SENĄ kopiją: pridedam `audit` lauką ir perskaičiuojam sumą.
  const parsed = JSON.parse(backup.data.toString("utf8"));
  parsed.audit = [{ event: "SENAS_ISTRINTAS_IRASAS", subjectId: "pseudonimas123" }];

  const legacyData = Buffer.from(JSON.stringify(parsed), "utf8");
  const legacyManifest = {
    ...backup.manifest,
    checksum: backupManifest.computeChecksum(legacyData),
  };

  await jobStore.system.remove(job.id);
  const before = auditLog.getAll().length;

  const result = await restoreService.restoreBackup({ manifest: legacyManifest, data: legacyData });

  assert.equal(result.ok, true, "sena kopija turi būti atkuriama");
  assert.ok(await jobStore.system.get(job.id), "jobai atkuriami kaip įprasta");

  const restored = auditLog.getAll().slice(before);
  assert.ok(
    !restored.some((e) => e.event === "SENAS_ISTRINTAS_IRASAS"),
    "senas audito įrašas NEGALI grįžti"
  );
});

test("POLITIKA: auditas turi EKSPLICITINĘ neįtraukimo priežastį", () => {
  /**
   * „Neįtraukta" ir „pamiršta įtraukti" turi atrodyti skirtingai – ypač
   * artefaktui, kuris registre yra `persistent`.
   */
  const backupPolicy = require("../utils/backupPolicy");
  const excluded = backupPolicy.excludedTypes().find((e) => e.type === "audit_entry");

  assert.ok(excluded, "auditas turi būti neįtrauktų sąraše");
  assert.match(excluded.reason, /atskaitomybės|GDPR/i, "priežastis turi paaiškinti KODĖL");
});

test("#180 P2-E: neatstovaujamas įrašas atmetamas PRIEŠ bet kokią atkūrimo mutaciją", async () => {
  /**
   * ⚠️ DALINIS ATKŪRIMAS BUVO REALUS.
   *
   * `_apply()` pirma įrašo VISĄ audio, paskui job'us po vieną. Kol
   * atstovaujamumas buvo tikrinamas tik `restoreRecord()` viduje, sugadintas
   * TREČIAS įrašas nutraukdavo atkūrimą jau PO to, kai audio ir pirmi du job'ai
   * buvo pritaikyti - deterministinė turinio klaida virsdavo daline mutacija.
   *
   * Dabar visi įrašai tikrinami „dar NIEKO nekeičiam" fazėje. Testas tikrina
   * būtent EILIŠKUMĄ: nė vienas ankstesnis elementas neturi būti pritaikytas.
   */
  await jobStore.init();

  const a = await completedJob();
  const b = await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  /** Gyva būsena, kuri privalo likti nepaliesta. */
  await jobStore.system.remove(a.id);
  await jobStore.system.remove(b.id);
  const gyvas = await completedJob();
  const gyvasPries = await jobStore.system.get(gyvas.id);

  const tikriVeiksmai = {
    assertRestorable: jobStore.assertRestorable,
    restoreRecord: jobStore.restoreRecord,
    putAtKey: fileStorage.putAtKey,
  };
  let atkurta = 0;
  let irasytaAudio = 0;
  let tikrinta = 0;

  try {
    /**
     * Seamas, per kurį backend'as praneša „šio įrašo atstovauti negaliu".
     * Krenta TIK ties PASKUTINIU job'u, tad ankstesni jau būtų pritaikyti, jei
     * patikra vyktų mutacijos metu.
     */
    /**
     * Nesėkmė ties `b`, kuris kopijoje eina PO `a`. Jei patikra vyktų mutacijos
     * metu, `a` jau būtų atkurtas - būtent tai ir tikrinama žemiau.
     */
    const neatstovaujamas = b.id;
    jobStore.assertRestorable = async (job) => {
      tikrinta += 1;
      if (job.id === neatstovaujamas) {
        const e = new Error("progress.current = \"8\" nėra baigtinis SKAIČIUS");
        e.code = "UNSUPPORTED_PROGRESS_REPRESENTATION";
        throw e;
      }
    };
    jobStore.restoreRecord = async (...args) => {
      atkurta += 1;
      return tikriVeiksmai.restoreRecord(...args);
    };
    fileStorage.putAtKey = async (...args) => {
      irasytaAudio += 1;
      return tikriVeiksmai.putAtKey(...args);
    };

    const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

    assert.equal(result.ok, false, "neatstovaujamas įrašas privalo nutraukti atkūrimą");
    assert.equal(result.failedStep, STEPS.CONTENT,
      "klaida privalo kilti TURINIO patikros fazėje, ne pritaikymo metu");
    assert.match(result.reason, /neatstovaujamas aktyvioje saugykloje/);
    /**
     * ⚠️ LITERALUS PALYGINIMAS, NE `new RegExp(kintamasis)`.
     *
     * Anksčiau čia buvo `assert.match(result.reason, new RegExp(neatstovaujamas))`.
     * Dinamiškai kuriamas reguliarusis reiškinys iš kintamojo yra regex
     * injekcijos šablonas: reikšmei kada nors turint metaženklų, tikrinimas
     * arba mestų `SyntaxError`, arba TYLIAI imtų reikšti ką kita. `includes()`
     * lygina tiksliai ir metaženklų neinterpretuoja.
     */
    assert.ok(result.reason.includes(neatstovaujamas),
      `priežastis privalo įvardyti neatstovaujamą įrašą: ${result.reason}`);

    /** ⚠️ ESMĖ: patikrinti VISI, pritaikyta NIEKO. */
    assert.ok(tikrinta >= 2,
      "preflight privalo pasiekti bent `a` ir `b` PRIEŠ bet kokią mutaciją");
    assert.equal(atkurta, 0, "nė vienas ankstesnis job'as negali būti atkurtas");
    assert.equal(irasytaAudio, 0, "audio negali būti įrašytas prieš patikrą");

    /** Gyva būsena nepakitusi; kopijos job'ai neatsirado. */
    assert.deepEqual(await jobStore.system.get(gyvas.id), gyvasPries,
      "gyvas įrašas privalo likti nepakitęs");
    assert.equal(await jobStore.system.get(a.id), null, "A negalėjo būti atkurtas");
    assert.equal(await jobStore.system.get(b.id), null, "B negalėjo būti atkurtas");
  } finally {
    jobStore.assertRestorable = tikriVeiksmai.assertRestorable;
    jobStore.restoreRecord = tikriVeiksmai.restoreRecord;
    fileStorage.putAtKey = tikriVeiksmai.putAtKey;
  }

  /** Perimti veiksmai privalo būti realiai atstatyti (AGENTS.md §9.3). */
  assert.equal(jobStore.assertRestorable, tikriVeiksmai.assertRestorable);
  assert.equal(jobStore.restoreRecord, tikriVeiksmai.restoreRecord);
  assert.equal(fileStorage.putAtKey, tikriVeiksmai.putAtKey);
});

test("SAUGUMAS: manifesto laukas su regex metaženklais NEPAVERČIAMAS reguliariuoju reiškiniu", async () => {
  /**
   * ⚠️ CodeQL „Regular expression injection" HIGH radinys (PR #208).
   *
   * Užpuoliko valdomas `manifest` ateina tiesiai iš `req.files.manifest[0]`
   * (`routes/backup.js`) ir nefiltruotas pasiekia `restoreService`. Šis testas
   * fiksuoja PRODUKCINĘ ribą: nė vienas manifesto laukas neturi patekti į
   * reguliariojo reiškinio SINTAKSĘ.
   *
   * ⚠️ NAUDOJAMAS SĄMONINGAI NEGALIOJANTIS ŠABLONAS. `(a+)+$|[` turi
   * neuždarytą simbolių klasę, tad `new RegExp()` jam mestų `SyntaxError`.
   * Jei kuris nors kelias jį kompiliuotų, testas kristų su išimtimi - o
   * `(a+)+` dar ir sukeltų katastrofinį grįžimą atgal (ReDoS), kurį pagautų
   * laiko riba. Tai, kad atkūrimas ramiai grąžina klaidą, įrodo LITERALŲ
   * apdorojimą (`String.prototype.replace()` su eilute, ne su regex).
   */
  await jobStore.init();
  await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  const kenksmingas = "aes-256-gcm-(a+)+$|[";
  const suklastotas = {
    ...backup.manifest,
    encrypted: true,
    encryptionAlgorithm: kenksmingas,
  };

  const pradzia = Date.now();
  const result = await restoreService.restoreBackup({
    manifest: suklastotas,
    data: backup.data,
    actor: "sysadmin",
  });
  const truko = Date.now() - pradzia;

  /** 1) Atmetama kontroliuojamai, be išimties. */
  assert.equal(result.ok, false, "suklastotas algoritmas privalo būti atmestas");
  assert.equal(result.failedStep, STEPS.DECRYPTED,
    "atmetimas privalo įvykti šifravimo patikros žingsnyje");

  /**
   * 2) ⚠️ ESMĖ: reikšmė grąžinama PAŽODŽIUI. Jei ji būtų buvusi kompiliuota ar
   * interpretuota kaip šablonas, čia matytume arba išimtį, arba pakeistą tekstą.
   */
  assert.ok(result.reason.includes(kenksmingas),
    `metaženklai privalo išlikti nepakeisti: ${result.reason}`);

  /** 3) Jokio katastrofinio grįžimo atgal - `(a+)+` niekada nebuvo vykdomas. */
  assert.ok(truko < 2000, `atkūrimas užtruko ${truko} ms - įtartina dėl ReDoS`);

  /** 4) Gyva būsena nepaliesta. */
  assert.equal(result.completedSteps.includes(STEPS.APPLIED), false,
    "atmestas atkūrimas negali nieko pritaikyti");
});

test("SAUGUMAS: kopija su suklastotu job identifikatoriumi atmetama PRIEŠ bet kokią mutaciją", async () => {
  /**
   * ⚠️ CodeQL taint pėdsakas ėjo per BENDRĄ `memoryStore` `Map`.
   *
   * `restoreRecord()` priima kopijos turinį pažodžiui: `jobs.set(job.id, {...job})`
   * be jokios `id` patikros (fasadas tikrino tik truthiness). Ranka redaguota
   * kopija galėjo įrašyti bet kokią eilutę kaip identifikatorių, ir ji gyventų
   * saugykloje - ją grąžintų `get()`, `listAll()`, ji patektų į atsakymus,
   * žurnalus ir vėlesnes kopijas. Būtent taip užpuoliko valdoma reikšmė
   * pasiekdavo `job.id` skaitytojus.
   *
   * Šiandien nė vienas produkcinis kelias iš `job.id` nekuria reguliariojo
   * reiškinio, tad tai gynyba į gylį. Bet riba privalo būti uždara.
   */
  await jobStore.init();
  await completedJob();

  const backup = await backupService.createBackup({ actor: "sysadmin" });

  /** Suklastojam PIRMO job'o id ir perskaičiuojam kontrolinę sumą. */
  const turinys = JSON.parse(backup.data.toString("utf8"));
  assert.ok(turinys.jobs.length > 0, "prielaida: kopijoje yra bent vienas job'as");
  const kenksmingasId = "(a+)+$|[";
  turinys.jobs[0].id = kenksmingasId;

  const naujiDuomenys = Buffer.from(JSON.stringify(turinys), "utf8");
  const suklastotas = {
    ...backup.manifest,
    checksum: backupManifest.computeChecksum(naujiDuomenys),
  };

  const kiekPries = await jobStore.size();

  const result = await restoreService.restoreBackup({
    manifest: suklastotas,
    data: naujiDuomenys,
    actor: "sysadmin",
  });

  /** 1) Atmetama turinio patikros fazėje - PRIEŠ `_apply()`. */
  assert.equal(result.ok, false, "suklastotas identifikatorius privalo nutraukti atkūrimą");
  assert.equal(result.failedStep, STEPS.CONTENT,
    "atmetimas privalo įvykti turinio patikros fazėje, kai dar niekas nepakeista");
  assert.equal(result.completedSteps.includes(STEPS.APPLIED), false,
    "atmestas atkūrimas negali nieko pritaikyti");

  /** 2) ⚠️ ESMĖ: kenksminga reikšmė NEPATEKO į saugyklą. */
  assert.equal(await jobStore.system.get(kenksmingasId), null,
    "suklastotas identifikatorius negali atsidurti saugykloje");
  assert.equal(await jobStore.size(), kiekPries,
    "saugyklos dydis privalo likti nepakitęs - nė vienas įrašas nepritaikytas");
});

test("SAUGUMAS: teisėtas UUID identifikatorius atkuriamas be pakitimų (regresija)", async () => {
  /** Riba negali atmesti nė vienos TEISĖTOS formos. */
  await jobStore.init();
  const job = await completedJob();
  const backup = await backupService.createBackup({ actor: "sysadmin" });

  await jobStore.system.remove(job.id);
  assert.equal(await jobStore.system.get(job.id), null, "prielaida: job'as pašalintas");

  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin" });

  assert.equal(result.ok, true, `atkūrimas nepavyko: ${result.reason}`);
  assert.ok(await jobStore.system.get(job.id), "teisėtas UUID job'as privalo grįžti");
});
