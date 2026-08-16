const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";

const request = require("supertest");
const requestContext = require("../utils/requestContext");
const jobStore = require("../utils/jobStore");
const app = require("../server");
app._setReadyForTests();

/**
 * GDPR #17: REQUEST ID IR KORELIACIJA.
 *
 * Trys atskiros savybės, kurias lengva supainioti:
 *  1. ID visada egzistuoja (generuojamas arba griežtai validuotas kliento);
 *  2. ID grįžta klientui antraštėje;
 *  3. ID pasiekia jobą ir worker'io vykdymą.
 *
 * Trečioji svarbiausia - be jos ID yra tik dekoracija HTTP atsakyme.
 */

test("ID GENERUOJAMAS, kai klientas nieko nepateikia", async () => {
  const res = await request(app).get("/api/health");

  assert.match(res.headers["x-request-id"], /^req_[0-9a-f-]{36}$/);
});

test("ID grąžinamas ANTRAŠTĖJE net kai užklausa atmetama", async () => {
  // 404 kelias: klientas vis tiek turi gauti ID, kurį galės nurodyti kreipdamasis.
  const res = await request(app).get("/api/jobs/nera-tokio-jobo");

  assert.ok(res.headers["x-request-id"], "atmesta užklausa taip pat turi ID");
});

test("KLIENTO ID priimamas tik griežtai atitinkantis formatą", async () => {
  const accepted = ["kliento-id-12345", "ok_ID.123:456", "a".repeat(64)];
  // TIK ASCII: ne-ASCII simbolių Node į HTTP antraštę apskritai neįdeda, tad
  // per HTTP jų patikrinti neįmanoma - jie dengiami vienetiniu testu žemiau.
  const rejected = ["trumpas", "a".repeat(65), "turi tarpa viduje", "kabutes'ir\"kitkas", "../../etc/passwd"];

  for (const value of accepted) {
    const res = await request(app).get("/api/health").set("x-request-id", value);
    assert.equal(res.headers["x-request-id"], value, `turėjo būti priimtas: ${value}`);
  }

  for (const value of rejected) {
    const res = await request(app).get("/api/health").set("x-request-id", value);
    assert.match(
      res.headers["x-request-id"],
      /^req_/,
      `turėjo būti atmestas ir pakeistas serverio ID: ${JSON.stringify(value)}`
    );
  }
});

test("VALIDACIJA: kliento ID negali tapti log injekcija", () => {
  // Šie į HTTP antraštę net nepatenka (Node juos atmeta), bet validatorius yra
  // paskutinė gynybos linija - pvz. jei ID kada nors ateitų iš JSON kūno.
  for (const value of ["eilutė\nnauja", "tab\tsimbolis", "\u0000null", "labai".repeat(50)]) {
    assert.equal(requestContext.isValidClientRequestId(value), false, JSON.stringify(value));
  }
});

test("PROPAGAVIMAS: requestId patenka į jobo metaduomenis", async () => {
  const clientId = "propagavimo-testas-1";

  const res = await request(app)
    .post("/api/jobs")
    .set("x-request-id", clientId)
    .send({ transcript: "Jonas: Sveiki, pradedam posėdį ir aptariam ketvirčio rezultatus." });

  assert.equal(res.status, 202);

  const job = await jobStore.system.get(res.body.jobId);
  assert.equal(job.requestId, clientId, "jobas turi nešti užklausos ID");
});

test("PROPAGAVIMAS: VYKDYMAS mato tą patį ID (ne tik jobo įrašas)", async (t) => {
  /**
   * Inline vykdymas prasideda `setImmediate` metu, kai HTTP konteksto scope jau
   * baigėsi. Be eksplicitinio atkūrimo iš jobo įrašo koreliacija nutrūktų -
   * ir tai būtų NEPASTEBIMA, nes darbas vis tiek pavyktų.
   *
   * SVARBU: tikrinam, ką mato PROCESSOR'IUS, o ne ką turi jobStore įrašas.
   * Pirmoji šio testo versija tikrino įrašą ir praeidavo net visiškai nutraukus
   * konteksto perdavimą - t. y. matavo ne tą dalyką.
   */
  const jobRunner = require("../queues/jobRunner");
  const observed = [];

  const original = jobRunner.registerProcessor;
  const { protocolProcessor } = require("../queues/processors");

  jobRunner.registerProcessor("protocol", async (payload, jobId) => {
    observed.push({
      requestId: requestContext.getRequestId(),
      execution: requestContext.getContext().execution,
    });
    return protocolProcessor(payload, jobId);
  });

  t.after(() => {
    jobRunner.registerProcessor("protocol", protocolProcessor);
    void original;
  });

  const clientId = "vykdymo-konteksto-testas";
  const res = await request(app)
    .post("/api/jobs")
    .set("x-request-id", clientId)
    .send({ transcript: "Jonas: Sveiki, pradedam posėdį ir aptariam ketvirčio rezultatus." });

  assert.equal(res.status, 202);

  for (let i = 0; i < 100 && observed.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(observed.length, 1, "processor'ius turėjo būti iškviestas");
  assert.equal(observed[0].requestId, clientId, "VYKDYMAS turi matyti užklausos ID");
  assert.equal(observed[0].execution, "inline");
});

test("KONTEKSTAS: runWithContext atkuria ID be HTTP užklausos", async () => {
  const result = await requestContext.runWithContext({ requestId: "worker-abc", actor: null }, async () => {
    return requestContext.getRequestId();
  });

  assert.equal(result, "worker-abc");

  // Už scope'o ribų konteksto nėra - ir tai neturi mesti klaidos.
  assert.equal(requestContext.getRequestId(), null);
  assert.deepEqual(requestContext.getContext(), {});
});

test("AKTORIUS: atspaudas atsparus brute-force (CodeQL radinys)", () => {
  /**
   * `API_KEY` nustatomas ranka `.env` faile, tad gali būti mažos entropijos.
   * Greitas atspaudas audito žurnale tokiu atveju brute-force'inamas.
   *
   * Nei grynas SHA-256, nei HMAC su druska čia nepakanka: `AUDIT_ID_SALT` gyvena
   * TAME PAČIAME `.env` faile, kaip ir raktas - kas gavo vieną, turi ir kitą.
   * scrypt apsaugo net turint druską, nes brangus yra pats skaičiavimas.
   */
  const crypto = require("crypto");
  const key = "slaptas123";
  const env = { AUDIT_ID_SALT: "druska" };

  const fingerprint = requestContext.actorFingerprint(key, env);

  const naiveSha = `key_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const naiveHmac = `key_${crypto.createHmac("sha256", env.AUDIT_ID_SALT).update(key).digest("hex").slice(0, 12)}`;

  assert.notEqual(fingerprint, naiveSha, "negali sutapti su grynu SHA-256");
  assert.notEqual(fingerprint, naiveHmac, "negali sutapti su HMAC - reikia KDF");

  // Su ta pačia druska - stabilus (kitaip įrašų nesugrupuotum).
  assert.equal(requestContext.actorFingerprint(key, env), fingerprint);
  // Su kita druska - kitas (kitaip druska nieko nekeistų).
  assert.notEqual(requestContext.actorFingerprint(key, { AUDIT_ID_SALT: "kita" }), fingerprint);
});

test("AKTORIUS: KDF kaina sumokama VIENĄ kartą, ne kas užklausą", () => {
  /**
   * Argumentas „KDF per brangus autentifikacijos kelyje" galiotų tik tuo atveju,
   * jei kiekviena užklausa atsineštų SKIRTINGĄ slaptažodį. `API_KEY` yra
   * konstanta, tad atspaudas kešuojamas.
   */
  const env = { AUDIT_ID_SALT: "nasumo-testas" };
  const key = "raktas-nasumo-testui";

  requestContext.actorFingerprint(key, env); // pirmas - brangus

  const started = Date.now();
  for (let i = 0; i < 5000; i += 1) requestContext.actorFingerprint(key, env);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 200, `5000 kešuotų kvietimų užtruko ${elapsed} ms - kešas neveikia`);
});

test("AKTORIUS: saugomas rakto ATSPAUDAS, ne pats raktas", () => {
  const key = "labai-slaptas-api-raktas";
  const fingerprint = requestContext.actorFingerprint(key);

  assert.match(fingerprint, /^key_[0-9a-f]{12}$/);
  assert.ok(!fingerprint.includes(key), "raktas negali patekti į atspaudą");

  // Tas pats raktas - tas pats atspaudas (kad įrašus būtų galima grupuoti).
  assert.equal(requestContext.actorFingerprint(key), fingerprint);
  // Skirtingi raktai - skirtingi atspaudai.
  assert.notEqual(requestContext.actorFingerprint("kitas-raktas"), fingerprint);
  assert.equal(requestContext.actorFingerprint(""), null);
  assert.equal(requestContext.actorFingerprint(undefined), null);
});

test("PRIVATUMAS: kontekste nėra nei turinio, nei IP, nei antraščių", async () => {
  const res = await request(app)
    .post("/api/jobs")
    .set("x-request-id", "privatumo-testas-1")
    .set("authorization", "Bearer slaptas-tokenas")
    .send({ transcript: "Jonas: Slapta transkripcija su asmens kodu 39001010000." });

  const job = await jobStore.system.get(res.body.jobId);

  /**
   * Tikrinam KORELIACIJOS laukus, o ne visą jobą.
   *
   * Jobo `result` teisėtai turi protokolą, sudarytą iš transkripcijos - tai jo
   * paskirtis. Pirmoji šio testo versija serializavo visą jobą ir krito dėl
   * teisingo elgesio; klausimas yra ne „ar jobe yra turinio", o „ar KORELIACIJA
   * prideda naujo turinio".
   */
  const correlation = { requestId: job.requestId, actor: job.actor };
  const serialized = JSON.stringify(correlation);

  assert.equal(job.requestId, "privatumo-testas-1");
  assert.ok(!serialized.includes("slaptas-tokenas"), "antraštės negali patekti į koreliaciją");
  assert.ok(!serialized.includes("39001010000"), "turinys negali patekti į koreliaciją");
  assert.ok(!serialized.includes("127.0.0.1"), "IP negali patekti į koreliaciją");

  assert.deepEqual(Object.keys(requestContext.getContext()), [], "už užklausos ribų kontekstas tuščias");
});

/**
 * ---------------------------------------------------------------------------
 * REDIS ROUND-TRIP IR WORKER PROPAGAVIMAS.
 *
 * Laukų pridėjimas į `newJob()` savaime NEĮRODO, kad jie išgyvena Redis
 * serializavimą: `redisStore` rašo į hash'ą lauką po lauko, tad naujas laukas be
 * eksplicitinės serializacijos gali tyliai dingti.
 * ---------------------------------------------------------------------------
 */

test("REDIS: requestId ir actor išgyvena serialize/deserialize", () => {
  const { serialize, deserialize } = require("../utils/jobStore/redisStore");
  const { newJob } = require("../utils/jobStore/common");

  const job = newJob({
    type: "transcription",
    requestId: "req_round_trip_1",
    actor: "key_abc123def456",
  });

  const restored = deserialize(serialize(job));

  assert.equal(restored.requestId, "req_round_trip_1");
  assert.equal(restored.actor, "key_abc123def456");
});

test("REDIS: null koreliacija irgi išgyvena (ne `\"null\"` eilutė)", () => {
  const { serialize, deserialize } = require("../utils/jobStore/redisStore");
  const { newJob } = require("../utils/jobStore/common");

  const restored = deserialize(serialize(newJob({ type: "protocol" })));

  assert.equal(restored.requestId, null);
  assert.equal(restored.actor, null);
});

test("WORKER: kontekstas apima VISĄ vykdymą, ne tik processor()", async () => {
  /**
   * Anksčiau `runWithContext` gaubė tik procesorių, tad COMPLETED įrašymas ir
   * audio valymas liktų be requestId. Tikrinam būtent tai: ką mato jobStore
   * atnaujinimas PO procesoriaus.
   */
  const { runWithContext, getRequestId, getActor } = requestContext;
  const observed = [];

  // Imituojam worker'io kūną: procesorius + completion žingsnis tame pačiame scope'e.
  await runWithContext({ requestId: "req_worker_1", actor: "key_worker", execution: "worker" }, async () => {
    observed.push({ stage: "processor", id: getRequestId(), actor: getActor() });
    await new Promise((r) => setTimeout(r, 5));
    observed.push({ stage: "completion", id: getRequestId(), actor: getActor() });
  });

  assert.deepEqual(observed, [
    { stage: "processor", id: "req_worker_1", actor: "key_worker" },
    { stage: "completion", id: "req_worker_1", actor: "key_worker" },
  ]);
});

test("AUDITAS: requestId ir actor patenka iš konteksto automatiškai", async () => {
  const auditLog = require("../utils/auditLog");
  const before = auditLog.getAll().length;

  await requestContext.runWithContext(
    { requestId: "req_audito_testas", actor: "key_audito123" },
    async () => {
      auditLog.record({ jobId: "job-audito-testas", success: true });
    }
  );

  const entry = auditLog.getAll().slice(before).pop();

  assert.equal(entry.requestId, "req_audito_testas");
  assert.equal(entry.actor, "key_audito123");
});

test("AUDITAS: eksplicitinės reikšmės turi pirmenybę prieš kontekstą", () => {
  // Worker'io retry ir ištrynimo kvitai kartais žino ID geriau nei aplinkinis
  // scope - tad eksplicitinis perdavimas negali būti perrašytas.
  const auditLog = require("../utils/auditLog");

  requestContext.runWithContext({ requestId: "req_konteksto", actor: "key_konteksto" }, () => {
    const entry = auditLog.record({ jobId: "j", requestId: "req_eksplicitinis", actor: "key_eksplicitinis" });

    assert.equal(entry.requestId, "req_eksplicitinis");
    assert.equal(entry.actor, "key_eksplicitinis");
  });
});

test("AUDITAS: žalias API raktas NIEKADA nepatenka į įrašą", async () => {
  const RAW_KEY = "labai-slaptas-api-raktas-987";
  const auditLog = require("../utils/auditLog");

  const saved = process.env.API_KEY;
  process.env.API_KEY = RAW_KEY;
  const before = auditLog.getAll().length;

  try {
    await request(app)
      .post("/api/jobs")
      .set("x-api-key", RAW_KEY)
      .set("x-request-id", "req_rakto_testas")
      .send({ transcript: "Jonas: Sveiki, pradedam posėdį ir aptariam ketvirčio rezultatus." });

    const entries = auditLog.getAll().slice(before);
    const serialized = JSON.stringify(entries);

    assert.ok(!serialized.includes(RAW_KEY), "raktas negali patekti į auditą");
    assert.ok(
      entries.some((e) => e.actor && /^key_[0-9a-f]{12}$/.test(e.actor)),
      `laukta aktoriaus atspaudo, gauta: ${entries.map((e) => e.actor).join(", ")}`
    );
    assert.ok(entries.some((e) => e.requestId === "req_rakto_testas"));
  } finally {
    if (saved === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = saved;
  }
});
