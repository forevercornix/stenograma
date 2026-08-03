const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "500";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";

const { hashPassword } = require("../utils/credentials");

const ADMIN_PASSWORD = "admin-slaptas-labai-1";
const OPERATOR_PASSWORD = "operator-slaptas-labai-2";

process.env.AUTH_USERS = `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)},darbuotojas:operator:${hashPassword(
  OPERATOR_PASSWORD
)}`;
process.env.API_KEY = "";

const request = require("supertest");
const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const { PERMISSIONS } = require("../utils/permissions");
const { authorizeJobExecution, resolveCurrentRole, DENY_REASON } = require("../utils/jobAuthorization");
const app = require("../server");
app._setReadyForTests();

/**
 * #18 PR3: KONTEKSTO PROPAGAVIMAS, AUDITAS IR REVOKACIJA.
 */

async function loginAs(username, password) {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  assert.equal(res.status, 200, `nepavyko prisijungti kaip ${username}`);
  return res.headers["set-cookie"][0];
}

const TRANSCRIPT = "Jonas: Sveiki, pradedam susitikimą. Reikia parengti ataskaitą iki penktadienio.";

test("PROPAGAVIMAS: jobas neša aktoriaus ID, rolę ir šaltinį", async () => {
  const cookie = await loginAs("darbuotojas", OPERATOR_PASSWORD);

  const created = await request(app).post("/api/jobs").set("Cookie", cookie).send({ transcript: TRANSCRIPT });
  assert.equal(created.status, 202);

  const job = await jobStore.get(created.body.jobId);

  assert.equal(job.actor, "darbuotojas", "aktoriaus ID turi keliauti su jobu");
  assert.equal(job.actorRole, "operator", "rolė turi keliauti su jobu");
  assert.equal(job.actorSource, "session", "mechanizmas turi keliauti su jobu");
  assert.ok(job.requestId, "koreliacijos ID turi likti (#17)");
});

test("KREDENCIALAI: jobo įraše NĖRA nei slaptažodžio, nei sesijos ID, nei cookie", async () => {
  /**
   * Svarbiausias šio failo testas.
   *
   * Jobas gyvena Redis'e, BullMQ eilėse ir logų kontekste – ten paslaptis
   * išgyventų kur kas ilgiau nei pati užklausa, o revokacija jos nepasiektų.
   * Tikrinam VISĄ serializuotą įrašą, ne atskirus laukus: naujas laukas su
   * paslaptimi būtų pridėtas nepastebėtas, jei tikrintume tik žinomus vardus.
   */
  const login = await request(app).post("/api/auth/login").send({ username: "sysadmin", password: ADMIN_PASSWORD });
  const cookie = login.headers["set-cookie"][0];
  const sessionId = cookie.split(";")[0].split("=")[1];

  const created = await request(app).post("/api/jobs").set("Cookie", cookie).send({ transcript: TRANSCRIPT });
  const job = await jobStore.get(created.body.jobId);

  const serialized = JSON.stringify(job);

  assert.ok(!serialized.includes(ADMIN_PASSWORD), "slaptažodis NEGALI patekti į jobą");
  assert.ok(!serialized.includes(sessionId), "sesijos ID NEGALI patekti į jobą");
  assert.ok(!/cookie/i.test(serialized), "jokių cookie laukų jobe");
  assert.ok(!/authorization|bearer|x-api-key/i.test(serialized), "jokių autentifikacijos antraščių jobe");
});

test("REVOKACIJA: pašalintas vartotojas nebegali įvykdyti eilėje laukiančio jobo", async () => {
  /**
   * Būtent tai, ko nebūtų, jei teisės būtų UŽŠALDYTOS kūrimo metu: jobas
   * laukia eilėje, vartotojas per tą laiką pašalinamas iš AUTH_USERS
   * (kompromituota paskyra, išėjęs darbuotojas), ir darbas vis tiek įvyktų.
   */
  const job = { actor: "darbuotojas", actorSource: "session", actorRole: "operator" };

  const before = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);
  assert.equal(before.allowed, true, "prieš revokaciją jobas turi būti leidžiamas");

  // Vartotojas PAŠALINAMAS - imituojam AUTH_USERS pakeitimą.
  const envBezJo = { AUTH_USERS: `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}` };
  const after = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE, envBezJo);

  assert.equal(after.allowed, false, "pašalintas vartotojas neturi vykdyti jobo");
  assert.equal(after.reason, DENY_REASON.ACTOR_UNKNOWN);
});

test("REVOKACIJA: sumažinta rolė atima teisę, NORS jobo įraše rašo senoji", async () => {
  /**
   * Jobo `actorRole` yra MOMENTINĖ NUOTRAUKA, ne teisių šaltinis. Jei ja
   * pasitikėtume, rolės sumažinimas neturėtų jokio poveikio jau sukurtiems
   * darbams.
   */
  const job = { actor: "darbuotojas", actorSource: "session", actorRole: "administrator" };

  // Įraše rašo `administrator`, bet AUTH_USERS sako `operator`.
  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_DELETE);

  assert.equal(decision.allowed, false, "sena rolė įraše neturi suteikti teisės");
  assert.equal(decision.reason, DENY_REASON.PERMISSION_REVOKED);
  assert.equal(decision.role, "operator", "turi būti naudojama DABARTINĖ rolė");
});

test("REVOKACIJA: atsijungimas (logout) NENUTRAUKIA jobo", async () => {
  /**
   * Sąmoningas apribojimas: sesija yra prisijungimo, ne teisės, mechanizmas.
   * Vartotojas teisėtai pradėjo darbą; uždaręs naršyklę jo neatšaukė.
   * Nutraukiama tik tada, kai dingsta PATI TAPATYBĖ ar teisė.
   */
  const cookie = await loginAs("darbuotojas", OPERATOR_PASSWORD);
  const created = await request(app).post("/api/jobs").set("Cookie", cookie).send({ transcript: TRANSCRIPT });

  await request(app).post("/api/auth/logout").set("Cookie", cookie);

  const job = await jobStore.get(created.body.jobId);
  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true, "logout neturi nutraukti jau pradėto darbo");
});

test("SUDERINAMUMAS: #17 laikų jobas (actor BE actorSource) vis tiek vykdomas", async () => {
  /**
   * REGRESIJA, kurią pagavo CI su tikru Redis, o ne šie testai.
   *
   * `actor` egzistuoja nuo #17 (koreliacijai), `actorSource` – tik nuo #18.
   * Taigi KIEKVIENAS senas jobas turi `actor` be `actorSource`. Pirmoji
   * versija reikalavo, kad trūktų ABIEJŲ laukų, tad visi tokie darbai buvo
   * atmesti kaip `actor_unknown` – 0 iš 6 jobų pasiekė procesorių.
   *
   * Mano testai to nepagavo, nes tikrino tik `{ actor: null, actorSource:
   * null }` – derinį, kurio realiai beveik nebūna. Tikrasis senas jobas
   * atrodo kitaip.
   */
  const senasJobas = { requestId: "req_senas", actor: "key_abc123def456", actorSource: null };

  const decision = authorizeJobExecution(senasJobas, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true, "#17 laikų jobas privalo būti vykdomas");
  assert.equal(decision.reason, DENY_REASON.NO_ACTOR);

  // Ir visiškai tuščias jobas taip pat.
  const tuscias = { requestId: "req_x", actor: null, actorSource: null };
  assert.equal(authorizeJobExecution(tuscias, PERMISSIONS.JOB_CREATE).allowed, true);
});

test("API RAKTAS: rolė perskaičiuojama iš DABARTINĖS konfigūracijos", async () => {
  const job = { actor: "api-key", actorSource: "api-key", actorRole: "administrator" };

  assert.equal(resolveCurrentRole(job, { API_KEY_ROLE: "administrator" }), "administrator");
  assert.equal(resolveCurrentRole(job, { API_KEY_ROLE: "operator" }), "operator", "sumažinus API_KEY_ROLE turi galioti nauja reikšmė");

  // Sumažinus rolę, DELETE teisė dingsta net jei jobe rašo administrator.
  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_DELETE, { API_KEY_ROLE: "operator" });
  assert.equal(decision.allowed, false);
});

test("API RAKTAS: netinkama API_KEY_ROLE reikšmė yra FAIL-CLOSED", () => {
  /**
   * Gynyba gyliu. Startup validacija tokios reikšmės neįleidžia, bet ši
   * funkcija naudoja TĄ PAČIĄ `resolveApiKeyRole()` kaip HTTP sluoksnis, o ne
   * savo kopiją.
   *
   * Pirmoji versija darė tik `.trim().toLowerCase()` ir grąžindavo bet ką -
   * `API_KEY_ROLE=manager` būtų davusi `"manager"`, o `hasPermission()` tada
   * tyliai atmestų viską, atrodydama kaip revokacija, ne kaip konfigūracijos
   * klaida. Dvi kopijos tos pačios logikos ilgainiui išsiskiria.
   */
  const job = { actor: "api-key", actorSource: "api-key", actorRole: "administrator" };

  for (const bad of ["manager", "root", "ADMIN", "operator "]) {
    const resolved = resolveCurrentRole(job, { API_KEY_ROLE: bad });
    const expected = bad.trim().toLowerCase() === "operator" ? "operator" : null;
    assert.equal(resolved, expected, `API_KEY_ROLE="${bad}" turėjo duoti ${expected}`);
  }

  // Numatytoji reikšmė nepakito.
  assert.equal(resolveCurrentRole(job, {}), "administrator");
});

test("AUDITAS: atmestas vykdymas fiksuojamas BE kredencialų", async () => {
  const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
  const before = auditLog.getAll().length;

  const job = { actor: "dinges-vartotojas", actorSource: "session", actorRole: "operator" };
  authorizeJobOrAudit(job, "job_testinis", PERMISSIONS.JOB_CREATE);

  const nauji = auditLog.getAll().slice(before);
  const denied = nauji.find((e) => e.event === "JOB_EXECUTION_DENIED");

  assert.ok(denied, "atmestas vykdymas turi būti audituojamas - kitaip jis atrodo kaip techninis gedimas");
  assert.equal(denied.result, "failure", "audito įrašas naudoja `result`, ne `success`");
  assert.equal(denied.outcome, DENY_REASON.ACTOR_UNKNOWN);

  const serialized = JSON.stringify(nauji);
  assert.ok(!serialized.includes(ADMIN_PASSWORD), "jokių slaptažodžių audite");
  assert.ok(!/bearer|cookie|x-api-key/i.test(serialized), "jokių kredencialų audite");
});

test("STRUKTŪRA: abu vykdymo keliai naudoja TĄ PAČIĄ autorizacijos funkciją", () => {
  /**
   * Inline ir BullMQ keliai istoriškai išsiskirdavo (žr. #17 grandinės įvykių
   * pataisymus). Jei tik vienas jų tikrintų teises, revokacija veiktų
   * priklausomai nuo to, ar sukonfigūruotas Redis – t. y. nenuspėjamai.
   */
  const fs = require("fs");
  const path = require("path");

  for (const file of ["../queues/jobRunner.js", "../workers/index.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");

    /**
     * Ieškom KVIETIMO su argumentais, ne vien identifikatoriaus.
     *
     * Pirmoji versija tikrino `/authorizeJobOrAudit/` - ir mutacija, kuri
     * pakeitė kvietimą į `{ allowed: true }`, PRAĖJO, nes importo eilutė liko
     * faile. Testas tikrino, ar žodis parašytas, ne ar funkcija iškviesta.
     */
    assert.match(
      source,
      /const\s+decision\s*=\s*authorizeJobOrAudit\(/,
      `${file} turi REALIAI iškviesti autorizaciją vykdymo metu`
    );
    assert.match(source, /AUTHORIZATION_REVOKED/, `${file} turi pažymėti jobą kaip nutrauktą`);
  }
});
