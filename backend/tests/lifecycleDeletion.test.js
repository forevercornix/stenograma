const { markCompleted } = require("./helpers/jobPhaseFixtures");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";

const tombstones = require("../utils/deletionTombstones");
const lifecycleService = require("../services/lifecycleService");
const { DELETION_STATUS, classifyFailure } = lifecycleService;
const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");

/**
 * #19 PR2: KOORDINUOTAS GYVAVIMO CIKLO IŠTRYNIMAS.
 */

test.after(() => {
  tombstones._stopSweepForTests();
});

async function createJob(overrides = {}) {
  await jobStore.init();
  return jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL, ...overrides });
}

test("ŽYMA: uždedama PRIEŠ šalinimą", async () => {
  /**
   * Tvarka svarbi. Jei žyma atsirastų PO šalinimo, tarp jų liktų langas, kuriame
   * worker'is dar nematytų žymos, o duomenų jau nebūtų – ir jis juos atkurtų.
   *
   * Tikrinam netiesiogiai, bet patikimai: net kai `eraseJob` nepavyksta,
   * žyma jau turi egzistuoti.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  assert.equal(await tombstones.isDeleted(job.id), true, "žyma turi likti po ištrynimo");
});

test("ŽYMA: išgyvena jobo įrašo pašalinimą", async () => {
  /**
   * Būtent dėl to žyma laikoma ATSKIRAI, o ne jobo įraše: ji turi atsakyti į
   * klausimą „ar šis ID buvo ištrintas?" TADA, kai įrašo jau nebėra.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  assert.equal(await jobStore.system.get(job.id), null, "jobo įrašo neturi likti");
  assert.equal(await tombstones.isDeleted(job.id), true, "bet žyma turi išlikti");
});

test("IDEMPOTENTIŠKUMAS: pakartotinis ištrynimas NĖRA klaida", async () => {
  /**
   * Pakartotinis ištrynimas yra teisėtas veiksmas: tinklo pakartojimas, du
   * administratoriai, retry politika. Klaida čia verstų klientą aiškintis, ar
   * duomenys ištrinti, ar ne.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const first = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });
  const second = await lifecycleService.deleteJobArtefacts(null, job.id, { actor: "sysadmin" });

  assert.equal(first.complete, true);
  assert.equal(second.complete, true, "antras kvietimas irgi turi būti sėkmingas");
  assert.equal(second.status, DELETION_STATUS.ALREADY_DELETED);
});

test("IDEMPOTENTIŠKUMAS: lygiagretūs kvietimai konverguoja į VIENĄ būseną", async () => {
  /**
   * #19: „Concurrent deletion requests for the same job converge on one final
   * state." Du administratoriai gali paspausti tuo pačiu metu.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const [a, b, c] = await Promise.all([
    lifecycleService.deleteJobArtefacts(job, job.id, { actor: "a" }),
    lifecycleService.deleteJobArtefacts(job, job.id, { actor: "b" }),
    lifecycleService.deleteJobArtefacts(job, job.id, { actor: "c" }),
  ]);

  for (const result of [a, b, c]) {
    assert.equal(result.complete, true, `visi kvietimai turi baigtis sėkmingai: ${result.status}`);
  }

  // Visi gauna TĄ PATĮ faktinį rezultatą, ne savo atskirą.
  assert.equal(a.status, b.status);
  assert.equal(b.status, c.status);
  assert.equal(a.requestedAt, b.requestedAt, "visi turi matyti tą pačią operaciją");
});

test("IDEMPOTENTIŠKUMAS: pirmojo ištrynimo laikas NEPERRAŠOMAS", async () => {
  await tombstones._clearForTests();
  const job = await createJob();

  const first = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "pirmas" });
  await new Promise((r) => setTimeout(r, 20));
  const second = await lifecycleService.deleteJobArtefacts(null, job.id, { actor: "antras" });

  assert.equal(second.requestedAt, first.requestedAt, "pakartotinis ištrynimas neturi pastumti laiko");
  assert.equal(second.completedAt, first.completedAt, "faktinio ištrynimo laikas nekinta");

  /**
   * ⚠️ IDEMPOTENTIŠKUMO KETINIMAS NEPAKITO, PAKITO GRANULIARUMAS (#155, 7.5a).
   *
   * Iki 7.5a čia buvo tikrinama, kad `second.actor === "pirmas"` - t. y. kad
   * antras kvietėjas nepakeičia pirmojo įrašo. Nuo 7.5a `erasure_marks` saugo
   * tik aktoriaus KATEGORIJĄ: lentelė pergyvena jobą ir nėra išbraukiama iš
   * kopijų, tad plikas identifikatorius joje taptų asmens duomenimis lentelėje,
   * kurios paskirtis - įrodyti, kad asmens duomenys pašalinti.
   *
   * Tikslus aktorius NEDINGO - jis yra `LIFECYCLE_DELETION` audito kvite; tai
   * tikrina atskiras testas šiame pat faile („AUDITAS: ... aktorius").
   */
  assert.equal(second.actor, null, "identifikatoriaus žymoje NETURI būti");
  assert.equal(second.actorKind, first.actorKind, "kategorija lieka pirmojo kvietėjo");
  assert.equal(second.actorKind, "user", "savininko kelias yra `user`");
});

test("REZULTATAS: stabilus formatas VISIEMS atvejams", async () => {
  /**
   * Kintantis formatas verstų klientą spėlioti, ką jis gavo. Laukai turi būti
   * tie patys ir sėkmei, ir daliniam, ir pakartotiniam ištrynimui.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const results = [
    await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" }),
    await lifecycleService.deleteJobArtefacts(null, job.id, { actor: "x" }),
    await lifecycleService.deleteJobArtefacts(null, "niekada-neegzistaves", { actor: "x" }),
  ];

  for (const result of results) {
    assert.ok("jobId" in result);
    assert.ok("status" in result);
    assert.ok("actor" in result);
    assert.ok("requestedAt" in result);
    assert.ok("completedAt" in result);
    assert.ok("complete" in result);

    for (const key of ["deleted", "remaining", "retryable", "nonRetryable", "ephemeral", "unverified"]) {
      assert.ok(Array.isArray(result.categories[key]), `trūksta kategorijos: ${key}`);
    }
  }
});

test("REZULTATAS: efemeriškos kategorijos rodomos ATSKIRAI", async () => {
  /**
   * „Nėra ko trinti" ir „pamiršome ištrinti" turi atrodyti SKIRTINGAI. Jei
   * eksportai tiesiog nebūtų minimi, atsakymas atrodytų, tarsi jie praleisti.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const result = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" });

  assert.ok(result.categories.ephemeral.includes(ARTEFACT_TYPES.EXPORT_ORIGINAL.id));
  assert.ok(result.categories.ephemeral.includes(ARTEFACT_TYPES.EXPORT_REDACTED.id));
  assert.ok(result.categories.ephemeral.includes(ARTEFACT_TYPES.TRANSCRIPT_REDACTED.id));
});

test("GEDIMAI: kartotini ir galutiniai atskiriami", () => {
  /**
   * Sumaišius juos, arba kartojam amžinai, arba tyliai nurašom tai, kas dar
   * pataisoma.
   */
  for (const retryable of [
    "connect ECONNREFUSED 127.0.0.1:6379",
    "Connection is closed.",
    "EBUSY: resource busy",
    "ETIMEDOUT",
  ]) {
    assert.equal(classifyFailure(retryable), "retryable", `turėjo būti kartotinas: ${retryable}`);
  }

  // ⚠️ ENOENT čia SĄMONINGAI nėra - ištrynimo kontekste jis reiškia sėkmę
  // (žr. atskirą testą žemiau).
  for (const permanent of ["Permission denied", "Invalid argument", "EACCES"]) {
    assert.equal(classifyFailure(permanent), "permanent", `turėjo būti galutinis: ${permanent}`);
  }
});

test("SAUGUMAS: rezultate NĖRA kelių, raktų ar klaidų tekstų", async () => {
  /**
   * #19: „Deletion responses and logs expose no filesystem paths, storage keys,
   * Redis keys, provider payloads or deleted content."
   *
   * Rastas rašant: abu DELETE maršrutai grąžindavo `outcome.errors` TIESIAI
   * klientui, o juose būna failų kelių ir Redis raktų.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const result = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" });
  const serialized = JSON.stringify(result);

  assert.ok(!/\/tmp\/|\/home\/|\/var\//.test(serialized), "jokių failų kelių");
  assert.ok(!/bull:|stenograma:job:/.test(serialized), "jokių Redis raktų");
  assert.ok(!serialized.includes("Error"), "jokių klaidų tekstų");
});

test("AUDITAS: fiksuojamas aktorius, rezultatas ir laikas BE turinio", async () => {
  await tombstones._clearForTests();
  const before = (await auditLog.getAll()).length;
  const job = await createJob();

  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  const nauji = (await auditLog.getAll()).slice(before);
  const entry = nauji.find((e) => e.event === "LIFECYCLE_DELETION");

  assert.ok(entry, "ištrynimas turi būti audituojamas");
  assert.ok(entry.timestamp, "laikas privalomas");
  assert.ok(/status=/.test(entry.details), "rezultatas privalomas");

  const serialized = JSON.stringify(nauji);
  assert.ok(!/\/tmp\/|\/home\//.test(serialized), "audite jokių kelių");
});

test("NEEGZISTUOJANTIS jobas: žyma vis tiek uždedama", async () => {
  /**
   * Jobo įrašo gali nebūti (TTL, ankstesnis ištrynimas), bet ID vis tiek gali
   * atkeliauti su vėluojančia eilės žinute. Žyma turi atsirasti, kad tokia
   * žinutė nesukurtų artefaktų.
   */
  await tombstones._clearForTests();

  const result = await lifecycleService.deleteJobArtefacts(null, "job_kurio_nebera", { actor: "x" });

  assert.equal(result.complete, true, "trinti nebuvo ko – tai ne klaida");
  assert.equal(await tombstones.isDeleted("job_kurio_nebera"), true, "žyma turi būti uždėta");
});

test("ŽYMA: `pending` ir `failed` NESENSTA - jokios TTL išeities nėra", async () => {
  /**
   * ⚠️ APVERSTAS KONTRAKTAS (#155, 7.5a / #183).
   *
   * Iki 7.5a žyma turėdavo `expiresAt`, ir pasibaigusi ji NUSTODAVO blokuoti.
   * Tai reiškė, kad nuolat nepavykstantis ištrynimas pats save „išspręsdavo":
   * praėjus TTL barjeras dingdavo, o jautrūs duomenys, dėl kurių jis ir buvo
   * uždėtas, galėjo tebeegzistuoti.
   *
   * Nuo 7.5a neterminalės žymos nesensta NIEKADA. Išeitis iš užstrigusios
   * būsenos yra eksplicitinė (`retry` arba auditu fiksuotas `forceResolve`), ne
   * laikrodis.
   */
  await tombstones._clearForTests();

  await tombstones.mark("job_pending", { reason: "user_request" });
  await tombstones.mark("job_failed", { reason: "user_request" });
  await tombstones.complete("job_failed", tombstones.TOMBSTONE_STATUS.FAILED);

  /** Riba ateityje: net „viską, kas senesnio nei rytoj" valymas jų neliečia. */
  const rytoj = Date.now() + 24 * 60 * 60 * 1000;
  const { removed } = await tombstones.purgeExpired(rytoj, {});

  assert.equal(removed, 0, "neterminalės žymos NEŠALINAMOS jokiu terminu");
  assert.equal(await tombstones.isDeleted("job_pending"), true, "`pending` barjeras lieka");
  assert.equal(await tombstones.isDeleted("job_failed"), true, "`failed` barjeras lieka");
});

test("RETENCIJA: šalinamos TIK `deleted` žymos, ir tik už termino ribos", async () => {
  await tombstones._clearForTests();

  await tombstones.mark("job_istrintas", { reason: "user_request" });
  await tombstones.complete("job_istrintas", tombstones.TOMBSTONE_STATUS.DELETED);
  await tombstones.mark("job_naujas", { reason: "user_request" });

  /** Dabartis: terminas dar nepraėjęs nė vienai žymai. */
  const dabar = await tombstones.purgeExpired(Date.now(), {});
  assert.equal(dabar.removed, 0, "šviežios `deleted` žymos dar saugo prikėlimo horizontą");

  /** Praėjus terminui + atsargai - terminalė dingsta, neterminalė lieka. */
  const veliau = Date.now() + tombstones.retentionMs({}) + 1000;
  const { removed } = await tombstones.purgeExpired(veliau, {});

  assert.equal(removed, 1, "pašalinama tik `deleted`");
  assert.equal(await tombstones.isDeleted("job_naujas"), true, "`pending` lieka nepaliesta");
  assert.equal(await tombstones.isDeleted("job_istrintas"), false, "terminalė po termino išnyksta");
});

test("RETENCIJA: FAIL-SAFE - neapskaičiavus horizonto žymos NEŠALINAMOS", async () => {
  /**
   * ⚠️ ABEJOJANT - NETRINAM. Mažesnio TTL pasirinkimas reikštų, kad neaiškioje
   * situacijoje šalinam BARJERĄ, t. y. renkamės blogiausią įmanomą pusę.
   */
  await tombstones._clearForTests();

  await tombstones.mark("job_x", { reason: "user_request" });
  await tombstones.complete("job_x", tombstones.TOMBSTONE_STATUS.DELETED);

  /**
   * `QUEUE_TTL_SECONDS` šiukšlė → prikėlimo horizonto apskaičiuoti neįmanoma.
   *
   * ⚠️ Pastaba, kuri saugo šio testo prasmę: `BACKUP_RETENTION_DAYS` čia
   * NETIKTŲ - `backupPolicy.retentionDays()` neteisingą reikšmę pakeičia
   * numatytąja (7 d.), tad skaičiavimas liktų sėkmingas ir fail-safe šaka
   * nebūtų pasiekta. Testas turi pataikyti į tikrai neapskaičiuojamą dedamąją.
   */
  const bloga = { QUEUE_TTL_SECONDS: "nežinia" };

  assert.equal(tombstones.retentionMs(bloga), null, "neapskaičiuojamas terminas duoda `null`");

  const { removed, skipped } = await tombstones.purgeExpired(Date.now() + 10 ** 12, bloga);

  assert.equal(skipped, true, "valymas praleidžiamas, o ne vykdomas su spėjimu");
  assert.equal(removed, 0);
  assert.equal(await tombstones.isDeleted("job_x"), true, "žyma privalo likti");
});

test("STRUKTŪRA: abu DELETE maršrutai kviečia TĄ PATĮ servisą", () => {
  /**
   * Anksčiau `/api/jobs` ir `/api/transcribe-jobs` turėjo IDENTIŠKAS kopijas to
   * paties ištrynimo kodo, ir jos galėjo išsiskirti. Būtent tai #19 vadina
   * „single lifecycle service".
   */
  const fs = require("fs");
  const path = require("path");

  for (const file of ["../routes/jobs.js", "../routes/transcribeJobs.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");

    assert.match(source, /lifecycleService\.deleteJobArtefacts\(/, `${file} turi kviesti gyvavimo ciklo servisą`);
    assert.ok(
      !/const outcome = await eraseJob\(/.test(source),
      `${file}: tiesioginis eraseJob kvietimas ištrynimo kelyje – tai apeitų žymą ir klasifikaciją`
    );

    /**
     * KLAIDŲ TEKSTAI NEGRĄŽINAMI KLIENTUI.
     *
     * Serviso rezultate jų nėra, bet MARŠRUTAS gali pridėti savo laukų – ir
     * būtent taip buvo iki #19 PR2 (`errors: outcome.errors`).
     *
     * Mano pirmoji testų versija to nepagavo: ji tikrino tik serviso grąžinamą
     * objektą, tad mutacija, pridedanti kelią į HTTP atsakymą, praėjo. Tikrinam
     * atsakymo konstrukciją tiesiogiai.
     */
    const deletionResponses = source.match(/deletion:\s*\{[\s\S]{0,300}?\}/g) || [];

    for (const block of deletionResponses) {
      assert.ok(
        !/errors/.test(block),
        `${file}: ištrynimo atsakyme yra \`errors\` – klaidų tekstuose būna failų kelių ir Redis raktų`
      );
    }
  }
});

/**
 * ---------------------------------------------------------------------------
 * REVIEW PATAISYMAI: retry po dalinio, lygiagretumo koordinavimas, laikai.
 * ---------------------------------------------------------------------------
 */

test("RETRY: po DALINIO ištrynimo pakartojimas REALIAI kviečia trynimą", async () => {
  /**
   * REGRESIJA, kurią sukūrė pirmoji žymos versija.
   *
   * Žyma buvo uždedama prieš trynimą ir reiškė „ištrinta". Todėl po dalinės
   * nesėkmės antras `DELETE` sustodavo ties žyma ir grąžindavo
   * `already_deleted, complete: true` – nors artefaktai liko. Maršruto
   * pažadas „jobas paliktas, kad užklausą būtų galima pakartoti" buvo
   * neįvykdomas.
   *
   * Dabar tik `deleted` būsena leidžia trumpinti kelią.
   */
  await tombstones._clearForTests();
  const jobId = "job_dalinis";

  // Imituojam pirmą bandymą, kuris baigėsi nesėkme.
  await tombstones.mark(jobId, { reason: "user_request" });
  await tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.FAILED);

  assert.equal(await tombstones.isDeleted(jobId), true, "žyma turi likti - artefaktų kurti negalima");
  assert.equal(await tombstones.isConfirmedDeleted(jobId), false, "bet ištrynimas NEPATVIRTINTAS");

  // Antras kvietimas NETURI trumpinti kelio.
  const job = await createJob();
  const retry = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  assert.notEqual(retry.status, DELETION_STATUS.ALREADY_DELETED, "pakartojimas turi realiai trinti");
});

test("RETRY: `pending` žyma blokuoja artefaktų kūrimą, bet leidžia kartoti", async () => {
  /**
   * Du skirtingi klausimai, kuriuos pirmoji versija suplakė:
   *   „ar galima kurti artefaktus?"  -> ne, jei yra BET KOKIA žyma
   *   „ar galima trumpinti kelią?"   -> tik jei ištrynimas PATVIRTINTAS
   */
  await tombstones._clearForTests();

  await tombstones.mark("job_vykdomas", { reason: "user_request" });

  assert.equal(await tombstones.isDeleted("job_vykdomas"), true, "kurti negalima");
  assert.equal(await tombstones.isConfirmedDeleted("job_vykdomas"), false, "trumpinti kelio negalima");
});

test("LYGIAGRETUMAS: antras kvietimas LAUKIA pirmojo, o ne grąžina sėkmę iš karto", async () => {
  /**
   * REGRESIJA, kurią senasis testas UŽMASKAVO.
   *
   * Jis tikrino, kad visi trys rezultatai yra `complete` – ir jie buvo, bet
   * antrasis su trečiuoju „pavykdavo" vien dėl jau egzistuojančios žymos, dar
   * nepasibaigus pirmajam trynimui. Klientas gaudavo patvirtinimą, kurio
   * niekas nedavė.
   *
   * Čia trynimas dirbtinai pristabdomas, ir tikrinama, kad antras kvietimas
   * NEGRĮŽTA anksčiau už pirmą.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const jobErasure = require("../utils/jobErasure");
  const original = jobErasure.eraseJob;

  let eraseCalls = 0;
  jobErasure.eraseJob = async (j) => {
    eraseCalls += 1;
    await new Promise((r) => setTimeout(r, 120));
    return original(j);
  };

  try {
    delete require.cache[require.resolve("../services/lifecycleService")];
    const service = require("../services/lifecycleService");

    /**
     * EILIŠKUMAS, NE LAIKAS.
     *
     * Pirmoji versija tikrino `elapsed >= 110ms`. Toks testas tampa trapus
     * apkrautoje CI aplinkoje: lėtas runner'is jį praleistų, o greitas galėtų
     * netyčia praeiti ir su sulaužyta logika.
     *
     * Fiksuojam, KURIS pažadas išsisprendė pirmas – tai deterministiška ir
     * tiesiogiai atsako į klausimą „ar antras laukė?".
     */
    const resolutionOrder = [];

    const [first, second] = await Promise.all([
      service.deleteJobArtefacts(job, job.id, { actor: "a" }).then((r) => {
        resolutionOrder.push("first");
        return r;
      }),
      // Antras startuoja truputį vėliau - kad pirmasis tikrai spėtų užimti operaciją.
      new Promise((r) => setTimeout(r, 20))
        .then(() => service.deleteJobArtefacts(job, job.id, { actor: "b" }))
        .then((r) => {
          resolutionOrder.push("second");
          return r;
        }),
    ]);

    assert.equal(
      resolutionOrder[0],
      "first",
      "antras kvietimas NEGALI išsispręsti anksčiau už pirmą - tai reikštų, kad jis nelaukė"
    );
    assert.equal(eraseCalls, 1, "trynimas turi įvykti VIENĄ kartą, ne du");
    assert.equal(first.status, second.status, "abu turi gauti TĄ PATĮ faktinį rezultatą");
    assert.equal(first.complete, second.complete);
  } finally {
    jobErasure.eraseJob = original;
    delete require.cache[require.resolve("../services/lifecycleService")];
  }
});

test("LAIKAI: `completedAt` yra `null`, kol ištrynimas nepatvirtintas", async () => {
  /**
   * Pirmoji versija turėjo vieną `deletedAt`, nustatomą PRIEŠ trynimą, ir
   * vadino jį „kada duomenys pašalinti". Tuo momentu trynimas dar nebuvo
   * prasidėjęs ir galėjo visai nepavykti.
   */
  await tombstones._clearForTests();

  const marker = await tombstones.mark("job_x", { reason: "user_request" });
  assert.equal(marker.completedAt, null, "vos pažymėjus - dar nieko nepašalinta");
  assert.ok(marker.requestedAt, "bet užklausos laikas jau yra");

  await tombstones.complete("job_x", tombstones.TOMBSTONE_STATUS.FAILED);
  assert.equal((await tombstones.get("job_x")).completedAt, null, "nesėkmė NETURI ištrynimo laiko");

  /** ⚠️ Nuo 7.5a užbaigti galima tik per eksplicitinį retry (žr. atskirą testą). */
  await tombstones.retry("job_x");
  await tombstones.complete("job_x", tombstones.TOMBSTONE_STATUS.DELETED);
  assert.ok((await tombstones.get("job_x")).completedAt, "tik sėkmė duoda faktinį laiką");
});

test("LAIKAI: sėkmingas ištrynimas turi IR requestedAt, IR completedAt", async () => {
  await tombstones._clearForTests();
  const job = await createJob();

  const result = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" });

  assert.ok(result.requestedAt, "užklausos laikas privalomas");
  assert.ok(result.completedAt, "sėkmės atveju faktinis laikas privalomas");
  assert.ok(result.completedAt >= result.requestedAt, "pabaiga negali būti anksčiau už pradžią");
});

test("AUDITAS: aktorius REALIAI patenka į įrašą, net be HTTP konteksto", async () => {
  /**
   * `auditLog.record` turi fallback į užklausos kontekstą, bet servisą galima
   * kviesti IR BE jo – retencijos valymo, worker'io ar skripto keliais. Tada
   * aktorius tyliai taptų `null`, ir įrašas neatsakytų „kas ištrynė".
   *
   * Ankstesnis testas to netikrino visai.
   */
  await tombstones._clearForTests();
  const before = (await auditLog.getAll()).length;
  const job = await createJob();

  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  const entry = (await auditLog.getAll()).slice(before).find((e) => e.event === "LIFECYCLE_DELETION");

  assert.ok(entry, "ištrynimas turi būti audituojamas");
  assert.equal(entry.actor, "sysadmin", "aktorius privalo patekti į įrašą");
});

test("KATEGORIJOS: transkripcija ir protokolas seka savo konteinerį", async () => {
  /**
   * Jie neturi atskiro fizinio saugojimo vieneto – gyvena `job.result` viduje.
   * Bet rezultate juos reikia ĮVARDYTI: nutylėti artefaktai neatskiriami nuo
   * pamirštų, o #19 tikslas yra patvirtinti KIEKVIENĄ kategoriją.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const result = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" });

  assert.ok(result.categories.deleted.includes(ARTEFACT_TYPES.JOB_RECORD.id));
  assert.ok(
    result.categories.deleted.includes(ARTEFACT_TYPES.TRANSCRIPT.id),
    "transkripcija pašalinta kartu su konteineriu"
  );
  assert.ok(result.categories.deleted.includes(ARTEFACT_TYPES.PROTOCOL.id));
});

test("KATEGORIJOS: laikini artefaktai pažymėti kaip DAR NEPATIKRINTI", async () => {
  /**
   * „Dar nepatikrinta" ir „patikrinta ir švaru" turi atrodyti skirtingai.
   * Nutylėjus juos, rezultatas atrodytų pilnesnis, nei yra.
   */
  await tombstones._clearForTests();
  const job = await createJob();

  const result = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "x" });

  assert.ok(result.categories.unverified.includes(ARTEFACT_TYPES.UPLOAD_TEMP.id));
  assert.ok(result.categories.unverified.includes(ARTEFACT_TYPES.CONVERSION_TEMP.id));
});

test("GEDIMAI: `ENOENT` ištrynime reiškia SĖKMĘ, ne gedimą", async () => {
  /**
   * „Failo nebėra" trinant reiškia, kad tikslas jau pasiektas. Klasifikavus jį
   * kaip `permanent`, sėkmingas ištrynimas atrodytų kaip gedimas,
   * reikalaujantis žmogaus įsikišimo – ir operatorius gaudytų aliarmus dėl
   * to, kas veikia.
   *
   * ⚠️ Taisyklė KONTEKSTINĖ: tas pats `ENOENT` skaitant failą būtų tikras
   * gedimas.
   */
  for (const absent of ["ENOENT: no such file or directory", "File not found", "key does not exist"]) {
    assert.equal(classifyFailure(absent), "already_absent", `turėjo būti already_absent: ${absent}`);
  }

  // Ir jis NEPATENKA nei į retryable, nei į nonRetryable.
  assert.notEqual(classifyFailure("ENOENT"), "retryable");
  assert.notEqual(classifyFailure("ENOENT"), "permanent");
});

test("STARTUP: netinkamas žymos TTL stabdo paleidimą", () => {
  /**
   * `parseInt("10xyz")` tyliai duotų 10, o `abc` – NaN, ir žyma galiotų
   * neapibrėžtą laiką. Ištrynimo garantijai tai reikštų, kad vėluojanti eilės
   * žinutė vėl galėtų kurti artefaktus.
   */
  const { validateConfig } = require("../utils/startupChecks");

  for (const bad of ["abc", "0", "-1", "10xyz", "999999"]) {
    const { errors } = validateConfig({ DELETION_TOMBSTONE_TTL_HOURS: bad });
    assert.ok(
      errors.some((e) => e.includes("DELETION_TOMBSTONE_TTL_HOURS")),
      `"${bad}" turėjo stabdyti paleidimą`
    );
  }

  assert.deepEqual(
    validateConfig({ DELETION_TOMBSTONE_TTL_HOURS: "72" }).errors.filter((e) => /TOMBSTONE/.test(e)),
    []
  );
});

test("ŽYMA: `deleted` yra GALUTINĖ - jos negalima atšaukti", async () => {
  /**
   * Apsauga nuo būsimų programavimo klaidų: patvirtintą ištrynimą „atšaukus"
   * į nesėkmę, jau įrodytas ištrynimas taptų neapibrėžtu, o `completedAt`
   * dingtų.
   */
  await tombstones._clearForTests();
  const S = tombstones.TOMBSTONE_STATUS;

  await tombstones.mark("job_galutinis");
  await tombstones.complete("job_galutinis", S.DELETED);
  const completedAt = (await tombstones.get("job_galutinis")).completedAt;

  await tombstones.complete("job_galutinis", S.FAILED);

  assert.equal((await tombstones.get("job_galutinis")).status, S.DELETED, "būsena neturi pasikeisti");
  assert.equal((await tombstones.get("job_galutinis")).completedAt, completedAt, "ištrynimo laikas neturi dingti");
});

test("ŽYMA: po nesėkmės retry PRIVALO galėti pavykti - bet TIK per eksplicitinį `pending`", async () => {
  /**
   * ⚠️ KETINIMAS NEPAKITO, PAKITO KELIAS (#155, 7.5a / #183).
   *
   * Pakartojimas ir toliau privalo galėti pavykti - kitaip dalinis ištrynimas
   * liktų amžinai neužbaigtas. Bet `failed -> deleted` uždarytas: jis leido
   * pasiekti `deleted` BE jokio įrodymo, kad antras bandymas apskritai vyko,
   * ir dviem skirtingiems kvietėjams - iš tos pačios būsenos.
   *
   * Retry dabar yra EKSPLICITINIS veiksmas, ne šalutinis `complete()` poveikis,
   * tad kiekvienas patvirtintas ištrynimas turi prieš save `pending` būseną.
   */
  await tombstones._clearForTests();
  const S = tombstones.TOMBSTONE_STATUS;

  await tombstones.mark("job_kartojamas", { reason: "user_request" });
  await tombstones.complete("job_kartojamas", S.FAILED);
  assert.equal(await tombstones.isConfirmedDeleted("job_kartojamas"), false);

  /** ⚠️ NEIGIAMA PUSĖ: tiesioginis kelias privalo būti ATMESTAS. */
  await tombstones.complete("job_kartojamas", S.DELETED);
  assert.equal(
    (await tombstones.get("job_kartojamas")).status,
    S.FAILED,
    "`failed -> deleted` be eksplicitinio retry privalo būti atmestas"
  );
  assert.equal(await tombstones.isConfirmedDeleted("job_kartojamas"), false, "ir NEPATVIRTINTAS");

  /** Teigiama pusė: per `pending` pakartojimas pavyksta. */
  await tombstones.retry("job_kartojamas");
  assert.equal((await tombstones.get("job_kartojamas")).status, S.PENDING, "retry grąžina į `pending`");

  await tombstones.complete("job_kartojamas", S.DELETED);

  assert.equal(await tombstones.isConfirmedDeleted("job_kartojamas"), true, "pakartojimas turi galėti pavykti");
  assert.ok((await tombstones.get("job_kartojamas")).completedAt);
});

/** Žymų būsenos šiam skyriui. */
const S183 = tombstones.TOMBSTONE_STATUS;

/* ══════════════════════════════════════════════════════════════════════════
 * #183 PRETENZIJA IR BARJERO NULEMTI ATSAKYMAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#183 PRETENZIJA: `mark()` pasako, ar žymą įrašė ŠIS kvietėjas", async () => {
  /**
   * Be `claimed` abi replikos matytų tą patį `deletion_pending` įrašą ir negalėtų
   * atskirti savo žymos nuo svetimos - tad abi pradėtų tą patį destruktyvų I/O.
   * Postgres pusėje tai `ON CONFLICT DO NOTHING RETURNING` rezultatas, atmintyje -
   * ar rakto dar nebuvo. Abu atominiai savo saugykloje.
   */
  const pirma = await tombstones.mark("claim_a", { reason: "user_request", actorKind: "user" });
  const antra = await tombstones.mark("claim_a", { reason: "user_request", actorKind: "user" });

  assert.equal(pirma.claimed, true, "įrašiusysis yra vykdytojas");
  assert.equal(antra.claimed, false, "pamatęs svetimą žymą vykdytoju netampa");
  assert.equal(antra.status, pirma.status, "autoritetinga būsena ta pati");
});

test("#183 202: svetima `deletion_pending` žyma sustabdo darbą, o ne dubliuoja jį", async () => {
  /**
   * ⚠️ ĮRODYMAS YRA NEPALIESTI DUOMENYS, NE STATUSO EILUTĖ.
   *
   * DoD reikalauja `jokio papildomo I/O nepradedama`, tad tikrinam, kad jobStore
   * įrašas LIKO. Vien `status === in_progress` tai patenkintų ir tada, kai eilė
   * su saugykla jau būtų išvalytos.
   */
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  // Kita replika jau pasiėmė šį jobą.
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const rezultatas = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "kitas" });

  assert.equal(rezultatas.status, DELETION_STATUS.IN_PROGRESS);
  assert.equal(rezultatas.complete, false, "`jau vykdoma` nėra sėkmė");
  assert.ok(await jobStore.system.get(job.id), "destruktyvus darbas NEPRADĖTAS");
});

test("#183 PRETENZIJA: autorizuotą pakartojimą pasiima VIENAS", async () => {
  /**
   * ⚠️ ANKSTESNĖ TAISYKLĖ ČIA TURĖJO IŠIMTĮ, IR JI PAŽEIDĖ DoD.
   *
   * `attempts === 0` sąlyga autorizuotam pakartojimui pretenzijos NETAIKĖ: visos
   * replikos, gavusios tą patį operatoriaus `retry`, vykdydavo lygiagrečiai. DoD
   * reikalauja vieno vykdytojo besąlygiškai.
   *
   * Dabar `retry` palieka `claimToken = null` - autorizuota, bet nepaimta - ir
   * pirmas pretendentas ją pasiima.
   */
  await tombstones.mark("claim_retry", { reason: "user_request", actorKind: "user" });
  await tombstones.complete("claim_retry", S183.FAILED, { failureKind: "retryable" });
  await tombstones.retry("claim_retry", { actorKind: "operator" });

  assert.equal(
    (await tombstones.get("claim_retry")).claimToken,
    null,
    "`retry` palieka žymą NEPAIMTĄ"
  );

  const pirmas = await tombstones.claimForDeletion("claim_retry", {
    reason: "user_request",
    actorKind: "user",
  });
  const antras = await tombstones.claimForDeletion("claim_retry", {
    reason: "user_request",
    actorKind: "user",
  });

  assert.equal(pirmas.vykdytojas, true, "pirmas pretendentas laimi");
  assert.equal(antras.vykdytojas, false, "antras pretenzijos NEGAUNA");
  assert.ok(pirmas.zyma.claimToken, "žetonas nustatytas");
});

test("#183 PRETENZIJA: VĖLIAU atėjusi replika negauna pretenzijos", async () => {
  /**
   * ⚠️ TAI SCENARIJUS, KURIS PANEIGĖ `updated_at` COMPARE-AND-SWAP SPRENDIMĄ.
   *
   * CAS atskiria tik tuos, kurie perskaitė TĄ PAČIĄ reikšmę. Vėliau atėjusi
   * replika perskaito jau PO-PRETENZIJOS `updated_at` ir ja sėkmingai pasiremtų:
   *
   *   t1  A: CAS(T0) ✓ → updated_at = T1
   *   t2  B: skaito T1, CAS(T1) ✓ → B taip pat vykdo
   *
   * Testas tai ir tikrina: `updatedAt` po pretenzijos PASIKEITĖ (tad CAS su ta
   * reikšme pavyktų), o pretenzija vis tiek atmetama - nes ji yra BŪSENA, ne
   * akimirka.
   */
  await tombstones.mark("velyva", { reason: "user_request", actorKind: "user" });
  await tombstones.complete("velyva", S183.FAILED, { failureKind: "retryable" });
  await tombstones.retry("velyva", { actorKind: "operator" });

  const priesPretenzija = await tombstones.get("velyva");
  const a = await tombstones.claimForDeletion("velyva", { reason: "user_request" });
  assert.equal(a.vykdytojas, true);

  const poPretenzijos = await tombstones.get("velyva");

  /**
   * ⚠️ ANTRA PRIEŽASTIS, KODĖL CAS BŪTŲ NEVEIKĘS - IR JĄ ATRADO ŠIS TESTAS.
   *
   * Atmintiniame režime `updatedAt` yra milisekundės, tad `retry` ir pretenzija
   * dažnai pataiko į TĄ PAČIĄ reikšmę. CAS tada praleistų net vienu metu
   * atėjusius - t. y. nesuveiktų būtent tuo vieninteliu atveju, kuriam jis buvo
   * skirtas, ir suveiktų tyliai.
   *
   * Todėl tikrinamas ne laikas, o pretenzijos BŪSENA.
   */
  assert.ok(poPretenzijos.updatedAt >= priesPretenzija.updatedAt);
  assert.ok(poPretenzijos.claimToken, "pretenzija yra būsena, ir ji nustatyta");

  // B ateina vėliau ir mato jau po-pretenzijos būseną.
  const b = await tombstones.claimForDeletion("velyva", { reason: "user_request" });

  assert.equal(b.vykdytojas, false, "vėliau atėjusi replika pretenzijos NEGAUNA");
  assert.equal(
    b.zyma.claimToken,
    poPretenzijos.claimToken,
    "žetonas nepasikeitė - pretenzija tebepriklauso pirmajam"
  );
});

test("#183 PRETENZIJA: žetonas nuvalomas KIEKVIENU perėjimu", async () => {
  /**
   * Viena valymo vieta - `_perkelti`. Terminalioje būsenoje žetonas nieko
   * nebegintų, o paliktas keltų klausimą, ar pretenzija dar aktyvi.
   */
  await tombstones.mark("valymas_d", { reason: "user_request", actorKind: "user" });
  assert.ok((await tombstones.get("valymas_d")).claimToken, "kūrėjas turi žetoną");

  await tombstones.complete("valymas_d", S183.DELETED);
  assert.equal(
    (await tombstones.get("valymas_d")).claimToken,
    null,
    "terminalizacija žetoną nuvalo"
  );

  await tombstones.mark("valymas_f", { reason: "user_request", actorKind: "user" });
  await tombstones.complete("valymas_f", S183.FAILED, { failureKind: "retryable" });
  assert.equal(
    (await tombstones.get("valymas_f")).claimToken,
    null,
    "`pending -> failed` žetoną nuvalo - įskaitant `release`"
  );
});

test("#183 NEIŠSPRĘSTA ŽYMA: `deletion_failed` NEKARTOJAMAS automatiškai", async () => {
  /**
   * Anksčiau šis kelias pakartodavo visą destruktyvų darbą, o `complete()`
   * perėjimą `failed -> deleted` atmesdavo tyliai - atsakymas skelbdavo sėkmę,
   * kurios žyma neliudija.
   */
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, S183.FAILED, { failureKind: "retryable" });

  const rezultatas = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sav" });

  assert.equal(rezultatas.status, DELETION_STATUS.TOMBSTONE_UNRESOLVED);
  assert.equal(rezultatas.complete, false, "neužtikrintas barjeras negali atrodyti kaip sėkmė");
  assert.equal(
    (await tombstones.get(job.id)).status,
    S183.FAILED,
    "būsena nepakitusi - ją keičia tik operatorius"
  );

  /**
   * ⚠️ BE ŠIOS EILUTĖS TESTAS NEATSKIRIA DVIEJŲ SKIRTINGŲ ELGSENŲ.
   *
   * Pašalinus išankstinę `failed` patikrą, kelias vis tiek grąžina
   * `tombstone_unresolved` (jį pagauna vėlesnis sėkmės išvedimas iš žymos), bet
   * PRIEŠ TAI pakartoja visą destruktyvų darbą. Statusas atrodo teisingas, o
   * elgsena - ne. Skirtumą mato tik likęs įrašas.
   */
  assert.ok(
    await jobStore.system.get(job.id),
    "automatinio pakartojimo nėra - destruktyvus darbas NEPRADĖTAS"
  );
});

test("#183 RELEASE: užstrigusi `pending` žyma atkuriama iki baigto ištrynimo", async () => {
  /**
   * ⚠️ PILNAS KELIAS, NE ATSKIRAS PERĖJIMAS.
   *
   * Po 202 įvedimo `deletion_pending` žyma be vykdytojo reiškia, kad ištrynimas
   * nebeįvyks NIEKADA - kiekvienas vėlesnis kvietimas atsako „jau vykdoma".
   * Nei `retry` (reikalauja `deletion_failed`), nei `force-resolve` (tvirtina,
   * kad duomenų nebėra) šiam atvejui netinka.
   *
   * Tikrinama visa grandinė: užstrigimas → release → retry → įvykdytas
   * ištrynimas. Vien perėjimo patikra neįrodytų, kad išeitis tikrai veda iki
   * galo - o būtent to ir trūko.
   */
  const { releaseMark, retryMark } = require("../services/erasureMarkService");

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  // Procesas nužudytas tarp žymėjimo ir užbaigimo: pretenzija yra, vykdytojo nėra.
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const uzstrige = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sav" });
  assert.equal(uzstrige.status, DELETION_STATUS.IN_PROGRESS, "be release kelias uždarytas");
  assert.ok(await jobStore.system.get(job.id), "duomenys nepaliesti");

  // Operatorius konstatuoja, kad vykdytojo nebėra. Jokio teiginio apie duomenis.
  const atlaisvinta = await releaseMark(job.id, { actor: "sysadmin" });
  assert.equal(atlaisvinta.changed, true);
  assert.equal(atlaisvinta.status, S183.FAILED);
  assert.equal(
    (await tombstones.get(job.id)).lastFailureKind,
    "executor_lost",
    "įrašoma TIK tai, kas žinoma - ne `retryable`, kuris teigtų įvykusį bandymą"
  );
  assert.equal(await tombstones.isDeleted(job.id), true, "barjeras nenuimtas nė akimirkai");

  // Esamas retry veikia toliau - nauja išeitis jo nedubliuoja.
  assert.equal((await retryMark(job.id, { actor: "sysadmin" })).changed, true);
  assert.equal((await tombstones.get(job.id)).status, S183.PENDING);

  const baigta = await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sav" });
  assert.equal(baigta.complete, true, "ištrynimas užbaigiamas");
  assert.equal(await tombstones.isConfirmedDeleted(job.id), true);
});

test("#183 RELEASE: NEGALIMAS iš `deleted` ir iš `deletion_failed`", async () => {
  /**
   * Leidus juos, `release` taptų būdu perrašyti nesėkmės kategoriją - t. y.
   * suklastoti įrašą apie tai, KAS nutiko. Iš `deleted` atlaisvinti nėra ko
   * (terminali), iš `deletion_failed` - jau yra `retry`.
   */
  const { releaseMark } = require("../services/erasureMarkService");

  await tombstones.mark("rel_deleted", { reason: "user_request", actorKind: "user" });
  await tombstones.complete("rel_deleted", S183.DELETED);

  const a = await releaseMark("rel_deleted", { actor: "sysadmin" });
  assert.equal(a.changed, false);
  assert.equal(a.reason, "not_pending");
  assert.equal((await tombstones.get("rel_deleted")).status, S183.DELETED, "terminali nepajudinta");

  await tombstones.mark("rel_failed", { reason: "user_request", actorKind: "user" });
  await tombstones.complete("rel_failed", S183.FAILED, { failureKind: "permanent" });

  const b = await releaseMark("rel_failed", { actor: "sysadmin" });
  assert.equal(b.changed, false);
  assert.equal(b.reason, "not_pending");
  assert.equal(
    (await tombstones.get("rel_failed")).lastFailureKind,
    "permanent",
    "esama nesėkmės kategorija NEPERRAŠOMA"
  );

  assert.equal((await releaseMark("nera_zymos", { actor: "sysadmin" })).reason, "no_mark");
});

/* ══════════════════════════════════════════════════════════════════════════
 * #183 CODEX 8 RAUNDAS - BARJERO SKYLĖS UŽ 7.5a RIBŲ
 * ══════════════════════════════════════════════════════════════════════════ */

test("#183 RETENCIJA: pasenusio jobo šalinimas PALIEKA žymą", async () => {
  /**
   * ⚠️ ŠEŠTA „mechanizmas yra, bet kelias jo nekviečia" instancija.
   *
   * `ERASURE_REASON.RETENTION_POLICY` buvo apibrėžta ir NENAUDOJAMA: retencija
   * trynė pasenusius job'us bendru `sweepExpired()` be jokios žymos, tad
   * `restoreRecord()` po to tą ID iš senesnės kopijos priimdavo. Tai paneigė ir
   * `docs/deletion-guarantees.md` teiginį „barjerą palieka VISI ištrynimo
   * keliai".
   */
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });

  // Terminas praėjo: TTL + atsarga.
  const ateitis = Date.now() + jobStore.TTL_MS + 60_000;
  await runRetentionSweep({ now: ateitis });

  assert.equal(await jobStore.system.get(job.id), null, "pasenęs jobas pašalintas");

  const zyma = await tombstones.get(job.id);
  assert.ok(zyma, "retencija PRIVALO palikti barjerą");
  assert.equal(zyma.reason, "retention_policy");
  assert.equal(zyma.actorKind, "system");
  assert.equal(zyma.status, S183.DELETED);
  assert.equal(await tombstones.isDeleted(job.id), true, "atkūrimas iš kopijos bus atmestas");
});

test("#183 RETENCIJA: svetimos pretenzijos jobo NELIEČIA", async () => {
  /**
   * Jei jobą jau trina kita replika ar vartotojo `DELETE`, retencija privalo
   * pasitraukti - antraip dubliuotų destruktyvų darbą ir lenktyniautų dėl to
   * paties įrašo.
   */
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });

  // Kita replika pasiėmė pretenziją.
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const r = await runRetentionSweep({ now: Date.now() + jobStore.TTL_MS + 60_000 });

  assert.ok(await jobStore.system.get(job.id), "svetimos pretenzijos jobas NEPAŠALINTAS");
  assert.ok(r.jobsSkipped >= 1, "praleidimas matomas suvestinėje, ne tylus");
});

test("#183 KOPIJŲ HORIZONTAS: sumažintas nustatymas NESUTRUMPINA barjero", async () => {
  /**
   * ⚠️ JAU IŠLEISTA KOPIJA GALIOJIMO NEPRARANDA.
   *
   * Terminas anksčiau imdavo tik dabartinę `BACKUP_RETENTION_DAYS` reikšmę, tad
   * ją sumažinus žyma būdavo pašalinama anksčiau, nei nustoja galioti senesnė
   * kopija - ir atkūrimas iš jos ištrynimą atstatydavo.
   */
  const tolimas = Date.now() + 90 * 24 * 60 * 60 * 1000;
  await tombstones.recordBackupHorizon(tolimas);

  const suHorizontu = tombstones.retentionMs({
    ...process.env,
    BACKUP_RETENTION_DAYS: "1",
  });

  assert.ok(
    suHorizontu >= tolimas - Date.now(),
    "terminas privalo dengti jau išleistos kopijos galiojimą"
  );

  // Aukščiausias vanduo tik kyla.
  await tombstones.recordBackupHorizon(Date.now() + 1000);
  assert.equal(
    await tombstones.refreshBackupHorizon(),
    tolimas,
    "žemesnė reikšmė horizonto NESUMAŽINA"
  );
});
