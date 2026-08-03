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

process.env.AUTH_USERS = `sysadmin:administrator:${hashPassword("admin-slaptas-1")},darbuotojas:operator:${hashPassword(
  "operator-slaptas-2"
)}`;
// API_KEY IŠJUNGTAS šiame faile - tikrinam GRYNAI sesijų RBAC, be atsarginio
// rakto kelio, kuris pagal nutylėjimą turi administrator rolę.
process.env.API_KEY = "";

const request = require("supertest");
const { PERMISSIONS, hasPermission, permissionsForRole } = require("../utils/permissions");
const app = require("../server");
app._setReadyForTests();

/**
 * #18 PR2: ROLĖMIS GRĮSTA AUTORIZACIJA.
 *
 * Testuojama ELGSENA per tikrą HTTP, ne vien leidimų lentelė - lentelė gali
 * būti teisinga, o maršrutas vis tiek nepatikrinti leidimo.
 */

async function loginAs(username, password) {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  assert.equal(res.status, 200, `nepavyko prisijungti kaip ${username}`);
  return res.headers["set-cookie"][0];
}

const TRANSCRIPT = "Jonas: Sveiki, pradedam susitikimą. Reikia parengti ataskaitą iki penktadienio.";
const PROTOCOL = { pavadinimas: "Testas", dalyviai: [], darbotvarke: [], aptarti_klausimai: [], nutarimai: [], veiksmai: [] };

test("REGISTRAS: deny-by-default - nežinoma rolė ir nežinomas leidimas atmetami", () => {
  assert.equal(hasPermission("superuser", PERMISSIONS.JOB_READ), false);
  assert.equal(hasPermission("administrator", "kazkas:naujo"), false);
  assert.equal(hasPermission(null, null), false);
  assert.equal(hasPermission("", PERMISSIONS.JOB_READ), false);
});

test("REGISTRAS: administratorius turi VISUS operatoriaus leidimus (nėra praradimo)", () => {
  const operator = permissionsForRole("operator");
  const admin = permissionsForRole("administrator");

  for (const permission of operator) {
    assert.ok(admin.includes(permission), `administratorius prarado operatoriaus leidimą: ${permission}`);
  }
  assert.ok(admin.length > operator.length, "administratorius turi turėti DAUGIAU leidimų");
});

test("OPERATORIUS: gali kurti ir skaityti darbus", async () => {
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const created = await request(app).post("/api/jobs").set("Cookie", cookie).send({ transcript: TRANSCRIPT });
  assert.equal(created.status, 202, "operatorius turi galėti kurti darbą");

  const read = await request(app).get(`/api/jobs/${created.body.jobId}`).set("Cookie", cookie);
  assert.equal(read.status, 200, "operatorius turi galėti skaityti darbo būseną");
});

test("OPERATORIUS: NEGALI ištrinti darbo (403, ne 401)", async () => {
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const created = await request(app).post("/api/jobs").set("Cookie", cookie).send({ transcript: TRANSCRIPT });
  const deleted = await request(app).delete(`/api/jobs/${created.body.jobId}`).set("Cookie", cookie);

  /**
   * 403, NE 401 - vartotojas ŽINOMAS, tik neturi teisės. 401 reikštų
   * „prisijunk", ir frontend rodytų prisijungimo formą jau prisijungusiam
   * vartotojui.
   */
  assert.equal(deleted.status, 403);
  assert.equal(deleted.body.code, "PERMISSION_DENIED");
  assert.equal(deleted.body.requiredPermission, "job:delete");
});

test("ADMINISTRATORIUS: gali ištrinti darbą", async () => {
  const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");

  const created = await request(app).post("/api/jobs").set("Cookie", adminCookie).send({ transcript: TRANSCRIPT });
  const deleted = await request(app).delete(`/api/jobs/${created.body.jobId}`).set("Cookie", adminCookie);

  assert.ok(
    [200, 204, 404].includes(deleted.status),
    `laukta 200/204/404, gauta ${deleted.status}`
  );
  assert.notEqual(deleted.status, 403, "administratorius neturi būti blokuojamas");
});

test("EKSPORTAS: leidimas priklauso nuo VARIANTO, ne nuo maršruto", async () => {
  const operatorCookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const redacted = await request(app)
    .post("/api/exports")
    .set("Cookie", operatorCookie)
    .send({ variant: "redacted", format: "txt", protocol: PROTOCOL });

  assert.notEqual(redacted.status, 403, "operatorius turi galėti eksportuoti REDAGUOTĄ variantą");

  const original = await request(app)
    .post("/api/exports")
    .set("Cookie", operatorCookie)
    .send({ variant: "original", format: "txt", protocol: PROTOCOL });

  /**
   * Originalus eksportas grąžina NEREDAGUOTUS asmens duomenis - tą patį
   * turinį, kurio apsaugai skirta visa redakcijos sistema.
   */
  assert.equal(original.status, 403, "operatorius NETURI gauti neredaguoto originalo");
  assert.equal(original.body.requiredPermission, "export:original");
});

test("EKSPORTAS: administratorius gali gauti originalą", async () => {
  const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");

  const original = await request(app)
    .post("/api/exports")
    .set("Cookie", adminCookie)
    .send({ variant: "original", format: "txt", protocol: PROTOCOL });

  assert.notEqual(original.status, 403, "administratorius neturi būti blokuojamas");
});

test("AUDITAS: operatorius negauna prieigos, administratorius - gauna", async () => {
  const saved = process.env.AUDIT_API_KEY;
  process.env.AUDIT_API_KEY = "atskiras-audito-raktas";

  try {
    const operatorCookie = await loginAs("darbuotojas", "operator-slaptas-2");
    const operatorRes = await request(app).get("/api/audit").set("Cookie", operatorCookie);

    // Operatorius neturi audit:read, tad krenta į x-audit-key kelią, kurio
    // rakto jis irgi neturi -> 401 iš auditAuth.
    assert.ok(operatorRes.status === 401 || operatorRes.status === 403, `operatorius neturi matyti audito, gauta ${operatorRes.status}`);

    const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");
    const adminRes = await request(app).get("/api/audit").set("Cookie", adminCookie);

    assert.equal(adminRes.status, 200, "administratorius su sesija turi matyti auditą BE atskiro rakto");
  } finally {
    if (saved === undefined) delete process.env.AUDIT_API_KEY;
    else process.env.AUDIT_API_KEY = saved;
  }
});

test("AUDITAS: esamas x-audit-key kelias VEIKIA ir be sesijos (atgalinis suderinamumas)", async () => {
  const saved = process.env.AUDIT_API_KEY;
  process.env.AUDIT_API_KEY = "atskiras-audito-raktas";

  try {
    const res = await request(app).get("/api/audit").set("x-audit-key", "atskiras-audito-raktas");
    assert.equal(res.status, 200, "esami skriptai su x-audit-key neturi sulūžti");
  } finally {
    if (saved === undefined) delete process.env.AUDIT_API_KEY;
    else process.env.AUDIT_API_KEY = saved;
  }
});

test("BE TAPATYBĖS: kai autentifikacija SUKONFIGŪRUOTA, gaunam 401, NE 403", async () => {
  /**
   * Skirtumas svarbus klientui: 401 -> prisijunk; 403 -> prisijungimas
   * nepadės. Sumaišius juos, frontend rodytų „neturite teisės" ten, kur
   * realiai tereikia prisijungti.
   *
   * SVARBU dėl aplinkos: šiame faile `API_KEY=""`, tad be papildomos
   * konfigūracijos `authenticate` kristų į DEV režimą ir praleistų užklausą
   * (žr. middleware/authenticate.js 3 punktą). Tai sąmoningas lokalaus
   * kūrimo patogumas, bet reiškia, kad 401 galima tikrinti TIK kai
   * autentifikacija realiai sukonfigūruota - todėl čia keliam atskirą app.
   */
  delete require.cache[require.resolve("../server")];
  delete require.cache[require.resolve("../middleware/authenticate")];

  const savedKey = process.env.API_KEY;
  process.env.API_KEY = "sukonfiguruotas-raktas";

  try {
    const request2 = require("supertest");
    const freshApp = require("../server");
    freshApp._setReadyForTests();

    const res = await request2(freshApp).post("/api/jobs").send({ transcript: TRANSCRIPT });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, "SESSION_REQUIRED");
  } finally {
    if (savedKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = savedKey;
    delete require.cache[require.resolve("../server")];
    delete require.cache[require.resolve("../middleware/authenticate")];
  }
});

test("DEV REŽIMAS: be jokios sukonfigūruotos autentifikacijos užklausa PRALEIDŽIAMA", async () => {
  /**
   * Šis testas fiksuoja SĄMONINGĄ sprendimą, ne defektą.
   *
   * Kai nėra nei `API_KEY`, nei sesijos, ir `NODE_ENV != production`,
   * `authenticate` praleidžia su `administrator` role - kitaip lokalus
   * kūrėjas negalėtų naudotis puse funkcijų be jokios saugumo naudos
   * (apsaugos vis tiek nėra).
   *
   * Produkcijoje tas pats kelias grąžina 503, ne praleidžia - tai patikrinta
   * atskirai `securityBaseline.route` testuose.
   */
  const res = await request(app).post("/api/jobs").send({ transcript: TRANSCRIPT });

  assert.equal(res.status, 202, "dev režime be konfigūracijos užklausa turi praeiti");
});

test("ESKALACIJA: operatorius NEGALI pasikelti teisių pridėdamas API raktą", async () => {
  /**
   * Sesija turi PIRMENYBĘ prieš bendrą raktą. Priešingu atveju bet kuris
   * operatorius, kuriam kada nors buvo duotas `API_KEY` (pvz. seno skripto
   * konfigūracijoje), galėtų apeiti savo rolę vienu papildomu antraštės lauku.
   */
  delete require.cache[require.resolve("../server")];
  delete require.cache[require.resolve("../middleware/authenticate")];

  const savedKey = process.env.API_KEY;
  process.env.API_KEY = "bendras-raktas-su-admin-role";
  process.env.API_KEY_ROLE = "administrator";

  try {
    const request2 = require("supertest");
    const freshApp = require("../server");
    freshApp._setReadyForTests();

    const login = await request2(freshApp)
      .post("/api/auth/login")
      .send({ username: "darbuotojas", password: "operator-slaptas-2" });
    const cookie = login.headers["set-cookie"][0];

    const created = await request2(freshApp)
      .post("/api/jobs")
      .set("Cookie", cookie)
      .set("x-api-key", "bendras-raktas-su-admin-role")
      .send({ transcript: TRANSCRIPT });

    const deleted = await request2(freshApp)
      .delete(`/api/jobs/${created.body.jobId}`)
      .set("Cookie", cookie)
      .set("x-api-key", "bendras-raktas-su-admin-role")
      .send();

    assert.equal(deleted.status, 403, "sesijos rolė turi nugalėti bendro rakto rolę");
  } finally {
    if (savedKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = savedKey;
    delete process.env.API_KEY_ROLE;
    delete require.cache[require.resolve("../server")];
    delete require.cache[require.resolve("../middleware/authenticate")];
  }
});
