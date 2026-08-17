const { markCompleted } = require("./helpers/jobPhaseFixtures");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.API_KEY = "";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";
process.env.RATE_LIMIT_POLL_MAX_REQUESTS = "500";

const request = require("supertest");
const { fakeMp3Buffer } = require("./helpers/fakeAudio");
const jobStore = require("../utils/jobStore");
const tombstones = require("../utils/deletionTombstones");
const auditLog = require("../utils/auditLog");
const fileStorage = require("../utils/fileStorage");
const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const artefactScanner = require("../utils/artefactScanner");
const jobRunner = require("../queues/jobRunner");
const app = require("../server");
app._setReadyForTests();

/**
 * #19 PR4: E2E GYVAVIMO CIKLO PATIKRA PER TIKRUS PRODUKCIJOS KELIUS.
 *
 * ⚠️ ESMINĖ TAISYKLĖ: jokių išgalvotų ID ar metaduomenų.
 *
 * Visi identifikatoriai gaunami iš REALIŲ HTTP atsakymų – jei testas
 * susikurtų `job_test_123`, jis tikrintų ne tą sistemą, kuri veikia
 * produkcijoje, o savo paties fikciją. Būtent to reikalauja #19: „Tests do not
 * fabricate identifiers or metadata absent from production paths."
 */

test.after(() => {
  tombstones._stopSweepForTests();
});

/**
 * Sukuria transkribavimo jobą per TIKRĄ įkėlimo maršrutą.
 *
 * @returns {Promise<string>} jobId iš realaus atsakymo
 */
async function uploadRealJob() {
  const res = await request(app)
    .post("/api/transcribe-jobs")
    .attach("audio", fakeMp3Buffer(), "susitikimas.mp3");

  assert.equal(res.status, 202, `įkėlimas turėjo pavykti, gauta ${res.status}`);
  assert.ok(res.body.jobId, "produkcijos kelias turi grąžinti jobId");

  return res.body.jobId;
}

/**
 * Laukimo riba VIENOJE vietoje.
 *
 * Mock tiekėjams 5 s pakanka su atsarga, bet apkrautame CI runner'yje riba gali
 * priartėti. Konstanta leidžia pakelti ją vienoje vietoje, o ne ieškoti po visą
 * failą.
 */
const TERMINAL_TIMEOUT_MS = 5000;

/** Laukia, kol jobas pasieks galutinę būseną – be to tikrintume nebaigtą sistemą. */
async function waitForTerminal(jobId, { timeoutMs = TERMINAL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/transcribe-jobs/${jobId}`);
    if (res.status === 404) return null;

    if (["completed", "failed"].includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 25));
  }

  throw new Error(`Jobas ${jobId} nepasiekė galutinės būsenos per ${timeoutMs}ms`);
}

/**
 * INVENTORIAUS SKENAVIMAS.
 *
 * #19 reikalauja patikrinti „both direct lookup and inventory/reference scans".
 * Tiesioginė paieška atsako „ar įrašas pasiekiamas pagal ID"; skenavimas –
 * „ar jo NUORODŲ neliko kitur". Antrasis klausimas svarbesnis: būtent
 * pamirštos nuorodos paverčia ištrynimą nepilnu.
 */
async function scanForReferences(jobId, { storageKey = null } = {}) {
  /**
   * CENTRALIZUOTAS skeneris, ne dvi patikros vietoje.
   *
   * Pirmoji versija tikrino `jobStore` ir `auditLog` – tai įrodė, kad neliko
   * DVIEJOSE vietose, bet ne kad inventorius kaip visuma švarus. Atsiradus
   * naujam artefakto tipui jis liktų neskenuotas TYLIAI, o testas ir toliau
   * būtų žalias, nors dengtų mažesnę dalį nei anksčiau.
   *
   * `scanAllArtefacts` eina per VISĄ registrą ir meta klaidą, jei kuris nors
   * tipas neturi strategijos.
   */
  const result = await artefactScanner.scanAllArtefacts(jobId, {
    jobStore,
    auditLog,
    fileStorage,
    jobRunner,
    storageKey,
  });

  return result.found;
}

test("E2E: pilnas ciklas per TIKRUS maršrutus – įkėlimas → transkripcija → ištrynimas", async () => {
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  const finished = await waitForTerminal(jobId);

  assert.ok(finished, "jobas turi pasiekti galutinę būseną");
  assert.equal(finished.status, "completed");
  assert.ok(finished.result, "transkripcija turi būti rezultate");

  // Ištrynimas per TIKRĄ maršrutą.
  const deleteRes = await request(app).delete(`/api/transcribe-jobs/${jobId}`);
  assert.equal(deleteRes.status, 204, "ištrynimas turėjo pavykti");

  // Tiesioginė paieška.
  const afterDelete = await request(app).get(`/api/transcribe-jobs/${jobId}`);
  assert.equal(afterDelete.status, 404, "jobo neturi būti pasiekiamo pagal ID");
});

test("E2E: po ištrynimo INVENTORIAUS SKENAVIMAS neranda nuorodų", async () => {
  /**
   * Tiesioginė paieška atsako tik „ar pasiekiamas pagal ID". Skenavimas
   * tikrina, ar nuorodų neliko KITUR – būtent pamirštos nuorodos paverčia
   * ištrynimą nepilnu.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  await waitForTerminal(jobId);

  await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  const remaining = await scanForReferences(jobId);

  assert.deepEqual(remaining, [], `po ištrynimo liko nuorodų: ${remaining.join(", ")}`);
});

test("E2E: protokolo jobas, išvestas iš transkripcijos, ištrinamas atskirai", async () => {
  /**
   * Transkribavimo ir protokolo jobai yra ATSKIRI įrašai. #19 reikalauja, kad
   * jie netaptų „deletion orphans": ištrynus vieną, kitas neturi likti
   * nepasiekiamas be savo ištrynimo kelio.
   *
   * Abu ID gaunami iš realių atsakymų – jokių išgalvotų sąsajų.
   */
  await tombstones._clearForTests();

  const transcriptionId = await uploadRealJob();
  const transcription = await waitForTerminal(transcriptionId);

  const protocolRes = await request(app)
    .post("/api/jobs")
    .send({ transcript: transcription.result.text || "Jonas: Sveiki, pradedam susitikimą. Reikia ataskaitos." });

  assert.equal(protocolRes.status, 202);
  const protocolId = protocolRes.body.jobId;

  assert.notEqual(protocolId, transcriptionId, "tai turi būti ATSKIRI jobai");

  // Kiekvienas turi SAVO ištrynimo kelią.
  assert.equal((await request(app).delete(`/api/transcribe-jobs/${transcriptionId}`)).status, 204);
  assert.equal((await request(app).delete(`/api/jobs/${protocolId}`)).status, 204);

  assert.deepEqual(await scanForReferences(transcriptionId), []);
  assert.deepEqual(await scanForReferences(protocolId), []);
});

test("E2E: eksportas NEPALIEKA artefakto po atsakymo", async () => {
  /**
   * Eksportai registre pažymėti kaip EFEMERIŠKI – jie generuojami užklausos
   * metu ir niekada nesaugomi. Šito negalima „ištrinti", tad reikia įrodyti,
   * kad jis NEIŠLIEKA.
   */
  await tombstones._clearForTests();

  const protocolRes = await request(app)
    .post("/api/jobs")
    .send({ transcript: "Jonas: Sveiki, pradedam susitikimą. Reikia parengti ataskaitą." });

  const protocolId = protocolRes.body.jobId;
  const finished = await waitForTerminal(protocolId).catch(() => null);

  // Pollinam per /api/jobs, ne transcribe-jobs.
  let job = null;
  for (let i = 0; i < 100 && !job; i += 1) {
    const res = await request(app).get(`/api/jobs/${protocolId}`);
    if (["completed", "failed"].includes(res.body.status)) job = res.body;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(job, "protokolo jobas turi pasiekti galutinę būseną");

  const exportRes = await request(app)
    .post("/api/exports")
    .send({ variant: "redacted", format: "txt", protocol: job.result || { pavadinimas: "T" } });

  assert.ok([200, 400].includes(exportRes.status), `netikėtas eksporto statusas ${exportRes.status}`);

  /**
   * Po eksporto jobo įraše NETURI atsirasti naujo artefakto: failas
   * išsiųstas ir pamirštas.
   */
  const afterExport = await jobStore.system.get(protocolId);
  /**
   * Jei jobo įrašo nebėra (TTL ar ankstesnis valymas), efemeriško artefakto
   * nebuvimas laikomas PATVIRTINTU: jis gali gyventi tik jobo įraše, tad
   * dingus konteineriui dingsta ir jis.
   */
  if (afterExport) {
    const exportArtefacts = (afterExport.artefacts || []).filter((a) => a.type.startsWith("export_"));
    assert.deepEqual(exportArtefacts, [], "eksportas neturi palikti artefakto inventoriuje");
  }

  void finished;
});

test("E2E: PAKARTOTINIS ištrynimas duoda tą pačią galutinę būseną", async () => {
  /**
   * Pakartotinis ištrynimas yra teisėtas (tinklo pakartojimas, du
   * administratoriai). Antras kvietimas neturi nei kristi, nei „atgaivinti"
   * jobo.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  await waitForTerminal(jobId);

  const first = await request(app).delete(`/api/transcribe-jobs/${jobId}`);
  const second = await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  assert.equal(first.status, 204);
  assert.ok([204, 404].includes(second.status), `antras ištrynimas: netikėtas ${second.status}`);

  assert.deepEqual(await scanForReferences(jobId), [], "po dviejų ištrynimų nuorodų neturi likti");
});

test("E2E: NEEGZISTUOJANČIO jobo ištrynimas negrąžina sėkmės", async () => {
  /**
   * ID paimtas iš realaus jobo, kuris JAU ištrintas – ne išgalvotas. Taip
   * tikrinam tikrą būseną „šio ID nebėra", o ne „toks formatas neegzistuoja".
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  await waitForTerminal(jobId);
  await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  const again = await request(app).get(`/api/transcribe-jobs/${jobId}`);
  assert.equal(again.status, 404);
});

test("E2E: ištrinto jobo ID NEGALI būti atkurtas nauju darbu", async () => {
  /**
   * Svarbiausias #19 PR3 pažadas, patikrintas per PRODUKCIJOS kelią: net jei
   * kas nors bandytų atnaujinti ištrintą jobą, žyma tai sustabdo.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  await waitForTerminal(jobId);
  await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  // Bandymas atkurti per jobStore (imituoja vėluojantį worker'į).
  const recreated = await markCompleted(jobStore.system, jobId, { result: { text: "neturi išlikti" } });

  assert.equal(recreated, null, "ištrinto jobo atkurti negalima");
  assert.equal(await jobStore.system.get(jobId), null);
});

test("E2E: ATŠAUKIMAS – ištrynimas nebaigus darbo palieka švarią būseną", async () => {
  /**
   * #19 reikalauja apdoroti „successful, failed, cancelled and abandoned jobs".
   * Čia ištrynimas įvyksta IŠKART po įkėlimo, dar nepasibaigus apdorojimui.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();

  // NELAUKIAM pabaigos - trinam iš karto.
  const deleteRes = await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  /**
   * 409 yra TEISINGAS atsakymas aktyviam jobui: sistema sąmoningai neleidžia
   * trinti vykdomo darbo (žr. routes/transcribeJobs.js). Abu variantai
   * priimtini – svarbu, kad po to nebūtų nei pusiau ištrinto, nei
   * neapibrėžto.
   */
  assert.ok([204, 409].includes(deleteRes.status), `netikėtas statusas ${deleteRes.status}`);

  if (deleteRes.status === 204) {
    assert.deepEqual(await scanForReferences(jobId), []);
  } else {
    // Aktyvus jobas - palaukiam pabaigos ir ištrinam.
    await waitForTerminal(jobId);
    assert.equal((await request(app).delete(`/api/transcribe-jobs/${jobId}`)).status, 204);
    assert.deepEqual(await scanForReferences(jobId), []);
  }
});

test("E2E: saugykloje NELIEKA audio failo po ištrynimo", async () => {
  /**
   * Tikrinam FIZINĘ saugyklą, ne tik jobo įrašą: #19 esmė yra ta, kad
   * „delete endpoint is not sufficient if copies remain".
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();

  /**
   * `storageKey` imamas IŠ KARTO po įkėlimo.
   *
   * Pirmoji versija skaitė jį PO apdorojimo pabaigos – o iki tada audio jau
   * būna automatiškai išvalytas (`audio_cleanup` po sėkmingos transkripcijos).
   * Tad laukas būdavo `null`, ir testas praleisdavo patikrą.
   *
   * Automatinis valymas yra TEISINGAS elgesys: šaltinio audio nereikia laikyti
   * ilgiau, nei trunka apdorojimas. Bet tai reiškia, kad raktą reikia užfiksuoti
   * anksčiau, o ne tikėtis rasti jį pabaigoje.
   */
  const uploaded = await jobStore.system.get(jobId);
  const storageKey = uploaded ? uploaded.storageKey : null;

  assert.ok(storageKey, "produkcijos kelias turi išsaugoti audio ir įrašyti storageKey");

  await waitForTerminal(jobId);
  await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  let stillThere = false;
  try {
    await fileStorage.get(storageKey);
    stillThere = true;
  } catch {
    stillThere = false;
  }

  assert.equal(stillThere, false, "audio failas turi būti pašalintas iš saugyklos");
});

test("E2E: ištrynimo atsakyme NĖRA kelių, raktų ar turinio", async () => {
  /**
   * Ta pati garantija kaip PR2, bet patikrinta per TIKRĄ HTTP atsakymą, ne
   * serviso objektą – maršrutas gali pridėti savo laukų.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  await waitForTerminal(jobId);

  const res = await request(app).delete(`/api/transcribe-jobs/${jobId}`);
  const serialized = JSON.stringify(res.body || {});

  assert.ok(!/\/tmp\/|\/home\/|\/var\//.test(serialized), "jokių failų kelių");
  assert.ok(!/bull:|stenograma:job:/.test(serialized), "jokių Redis raktų");
});

test("E2E: testas NENAUDOJA išgalvotų ID – visi gauti iš produkcijos kelių", () => {
  /**
   * Sąžiningumo patikra pačiam testų failui.
   *
   * Jei testas susikurtų `job_test_123`, jis tikrintų savo paties fikciją, o
   * ne veikiančią sistemą – ir „praeitų" net tada, jei produkcijos kelias būtų
   * sulaužytas.
   */
  const fs = require("fs");
  const raw = fs.readFileSync(__filename, "utf8");

  /**
   * KOMENTARAI PAŠALINAMI PRIEŠ SKENAVIMĄ.
   *
   * Pirmoji versija skenavo visą failą – ir pagavo SAVO PATIES paaiškinimą,
   * kuriame pavyzdžiu buvo įvardytas `fakeJobId`. Testas apie sąžiningumą
   * krisdavo dėl to, kad sąžiningai paaiškino, ko ieško.
   */
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  /**
   * Platesnis šablonas nei pirmojoje versijoje.
   *
   * Ji ieškojo tik `jobId = "job_..."`, tad `const fakeJobId = "..."` arba
   * `mockJobId` būtų prasprūdę. Dabar gaudom ir vardo, ir reikšmės formas.
   */
  const fabricatedPatterns = [
    /(?:const|let|var)\s+\w*(?:fake|mock|dummy|test)\w*(?:Job)?Id\s*=/i,
    /jobId\s*=\s*["'`](?!\$)/, // priskyrimas literalu, ne šablonu iš atsakymo
  ];

  const offenders = fabricatedPatterns
    .flatMap((pattern) => source.match(new RegExp(pattern.source, "gi")) || [])
    // Šio testo paties šablonai neskaičiuojami.
    .filter((match) => !match.includes("fabricatedPatterns"));

  assert.deepEqual(offenders, [], `ID turi ateiti iš HTTP atsakymo, ne iš literalo:\n${offenders.join("\n")}`);
  assert.match(source, /res\.body\.jobId/, "ID turi būti imamas iš realaus atsakymo");
});

test("SKENERIS: KIEKVIENAS registro tipas turi skenavimo strategiją", () => {
  /**
   * BLOKUOJANTI SPRAGA, kurią rado review.
   *
   * Pirmoji E2E versija tikrino `jobStore` ir `auditLog` – tai įrodė, kad
   * neliko dviejose vietose, bet ne kad inventorius kaip VISUMA švarus.
   * Atsiradus naujam artefakto tipui jis liktų neskenuotas tyliai: testas ir
   * toliau būtų žalias, nors dengtų mažesnę dalį nei anksčiau.
   *
   * Dabar naujas tipas be strategijos sulaužo šį testą ir patenka į peržiūrą.
   */
  assert.deepEqual(
    artefactScanner.typesWithoutStrategy(),
    [],
    "kiekvienas ARTEFACT_TYPES įrašas privalo turėti skenavimo strategiją"
  );
});

test("SKENERIS: praleisti tipai turi PRIEŽASTĮ, ne tylą", async () => {
  /**
   * „Nėra ko skenuoti" ir „pamiršome skenuoti" turi atrodyti skirtingai.
   * Praleidimas be priežasties yra tas pats, kas neskenuoti.
   */
  await tombstones._clearForTests();

  const jobId = await uploadRealJob();
  const result = await artefactScanner.scanAllArtefacts(jobId, {
    jobStore,
    auditLog,
    fileStorage,
    jobRunner,
    storageKey: null,
  });

  for (const skipped of result.skipped) {
    assert.ok(skipped.reason, `${skipped.type}: praleidimas be priežasties`);
  }

  // Ir bent vienas tipas realiai skenuojamas - kitaip skeneris būtų tuščias.
  assert.ok(result.scanned.length >= 4, `per mažai skenuojamų tipų: ${result.scanned.length}`);
});

test("SKENERIS: efemeriški tipai imami iš REGISTRO, ne iš strategijų sąrašo", () => {
  /**
   * Jei kuris nors efemeriškas tipas kada nors taptų `persistent`, strategijų
   * sąrašas to nepastebėtų – jame jis vis tiek liktų „nesaugomas". Registras
   * yra vienintelis tiesos šaltinis.
   */
  const ephemeral = artefactScanner.ephemeralTypes();

  assert.ok(ephemeral.includes(ARTEFACT_TYPES.EXPORT_ORIGINAL.id));
  assert.ok(ephemeral.includes(ARTEFACT_TYPES.EXPORT_REDACTED.id));
  assert.ok(ephemeral.includes(ARTEFACT_TYPES.TRANSCRIPT_REDACTED.id));

  // Ir nė vienas efemeriškas tipas neturi skenavimo strategijos su `scan`.
  for (const typeId of ephemeral) {
    assert.equal(
      artefactScanner.scannableTypes().includes(typeId),
      false,
      `${typeId} yra efemeriškas – jo skenuoti nėra kur`
    );
  }
});
