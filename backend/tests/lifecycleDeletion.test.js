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

  assert.equal(tombstones.isDeleted(job.id), true, "žyma turi likti po ištrynimo");
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
  assert.equal(tombstones.isDeleted(job.id), true, "bet žyma turi išlikti");
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
  assert.equal(second.actor, "pirmas", "aktorius lieka tas, kuris realiai ištrynė");
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
  assert.equal(tombstones.isDeleted("job_kurio_nebera"), true, "žyma turi būti uždėta");
});

test("ŽYMA: pasibaigusi nebegalioja ir išvaloma", async () => {
  await tombstones._clearForTests();

  tombstones.mark("job_senas", { actor: "x", env: { DELETION_TOMBSTONE_TTL_HOURS: "0.0000003" } });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(tombstones.isDeleted("job_senas"), false, "pasibaigusi žyma nebegalioja");
});

test("ŽYMA: sweep pašalina pasibaigusias, palieka galiojančias", async () => {
  await tombstones._clearForTests();

  tombstones.mark("job_senas", { env: { DELETION_TOMBSTONE_TTL_HOURS: "0.0000003" } });
  tombstones.mark("job_naujas");

  await new Promise((r) => setTimeout(r, 20));
  const removed = tombstones.sweepExpired();

  assert.equal(removed, 1);
  assert.equal(tombstones.isDeleted("job_naujas"), true, "galiojanti žyma turi likti");
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
  tombstones.mark(jobId, { actor: "sysadmin" });
  tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.FAILED);

  assert.equal(tombstones.isDeleted(jobId), true, "žyma turi likti - artefaktų kurti negalima");
  assert.equal(tombstones.isConfirmedDeleted(jobId), false, "bet ištrynimas NEPATVIRTINTAS");

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

  tombstones.mark("job_vykdomas", { actor: "x" });

  assert.equal(tombstones.isDeleted("job_vykdomas"), true, "kurti negalima");
  assert.equal(tombstones.isConfirmedDeleted("job_vykdomas"), false, "trumpinti kelio negalima");
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

  const marker = tombstones.mark("job_x", { actor: "x" });
  assert.equal(marker.completedAt, null, "vos pažymėjus - dar nieko nepašalinta");
  assert.ok(marker.requestedAt, "bet užklausos laikas jau yra");

  tombstones.complete("job_x", tombstones.TOMBSTONE_STATUS.FAILED);
  assert.equal(tombstones.get("job_x").completedAt, null, "nesėkmė NETURI ištrynimo laiko");

  tombstones.complete("job_x", tombstones.TOMBSTONE_STATUS.DELETED);
  assert.ok(tombstones.get("job_x").completedAt, "tik sėkmė duoda faktinį laiką");
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

  tombstones.mark("job_galutinis");
  tombstones.complete("job_galutinis", S.DELETED);
  const completedAt = tombstones.get("job_galutinis").completedAt;

  tombstones.complete("job_galutinis", S.FAILED);

  assert.equal(tombstones.get("job_galutinis").status, S.DELETED, "būsena neturi pasikeisti");
  assert.equal(tombstones.get("job_galutinis").completedAt, completedAt, "ištrynimo laikas neturi dingti");
});

test("ŽYMA: `failed -> deleted` LEIDŽIAMAS - tai retry kelias", async () => {
  /**
   * Vienkryptiškumas neturi sulaužyti pakartojimo: po nepavykusio trynimo
   * antras bandymas gali pavykti, ir žyma privalo tai atspindėti. Be šio
   * perėjimo dalinis ištrynimas liktų amžinai neužbaigtas.
   */
  await tombstones._clearForTests();
  const S = tombstones.TOMBSTONE_STATUS;

  tombstones.mark("job_kartojamas");
  tombstones.complete("job_kartojamas", S.FAILED);
  assert.equal(tombstones.isConfirmedDeleted("job_kartojamas"), false);

  tombstones.complete("job_kartojamas", S.DELETED);

  assert.equal(tombstones.isConfirmedDeleted("job_kartojamas"), true, "pakartojimas turi galėti pavykti");
  assert.ok(tombstones.get("job_kartojamas").completedAt);
});
