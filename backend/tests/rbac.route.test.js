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
   * `API_KEY` nustatomas LAIKINAI, be šviežio serverio: `authenticate` skaito
   * `process.env.API_KEY` KIEKVIENOS UŽKLAUSOS metu, tad naujo egzemplioriaus
   * kelti nereikia.
   *
   * Ankstesnė versija kūlė šviežią serverį per `delete require.cache` – ir tie
   * papildomi egzemplioriai su savais laikmačiais periodiškai sulaužydavo Node
   * testų vykdyklę FAILO lygiu („Unable to deserialize cloned data"), kas
   * atrodė kaip atsitiktinis nestabilumas.
   */
  const saved = process.env.API_KEY;
  process.env.API_KEY = "sukonfiguruotas-raktas";

  try {
    const res = await request(app).post("/api/jobs").send({ transcript: TRANSCRIPT });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, "SESSION_REQUIRED");
  } finally {
    process.env.API_KEY = saved;
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
  const savedKey = process.env.API_KEY;
  const savedRole = process.env.API_KEY_ROLE;

  process.env.API_KEY = "bendras-raktas-su-admin-role";
  process.env.API_KEY_ROLE = "administrator";

  try {
    const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

    const created = await request(app)
      .post("/api/jobs")
      .set("Cookie", cookie)
      .set("x-api-key", "bendras-raktas-su-admin-role")
      .send({ transcript: TRANSCRIPT });

    const deleted = await request(app)
      .delete(`/api/jobs/${created.body.jobId}`)
      .set("Cookie", cookie)
      .set("x-api-key", "bendras-raktas-su-admin-role")
      .send();

    assert.equal(deleted.status, 403, "sesijos rolė turi nugalėti bendro rakto rolę");
  } finally {
    if (savedKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = savedKey;
    if (savedRole === undefined) delete process.env.API_KEY_ROLE;
    else process.env.API_KEY_ROLE = savedRole;
  }
});

/**
 * ---------------------------------------------------------------------------
 * #18 PR4: TIESIOGINIŲ API KVIETIMŲ REGRESIJA.
 *
 * Frontend slepia veiksmus, kurių vartotojas neturi. Šie testai įrodo, kad
 * slėpimas NĖRA apsauga: kiekvienas kelias tikrinamas serveryje, nepaisant to,
 * ką rodo ar nerodo naršyklė.
 * ---------------------------------------------------------------------------
 */

test("APĖJIMAS: operatorius, kviečiantis API TIESIOGIAI, gauna 403", async () => {
  /**
   * Imituojam klientą, kuris apeina UI visiškai – curl, Postman, pakeistas JS
   * arba senas skirtukas su pasenusiu leidimų sąrašu.
   */
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const forbidden = [
    { method: "post", path: "/api/exports", body: { variant: "original", format: "txt", protocol: PROTOCOL } },
  ];

  for (const route of forbidden) {
    const res = await request(app)[route.method](route.path).set("Cookie", cookie).send(route.body);

    assert.equal(res.status, 403, `${route.path} turėjo grąžinti 403`);
    assert.equal(res.body.code, "PERMISSION_DENIED");
  }
});

test("APĖJIMAS: pakeistas kliento leidimų sąrašas NIEKO nekeičia serveryje", async () => {
  /**
   * Frontend gauna `permissions` per `/api/auth/me` ir pagal juos rodo UI.
   * Bet tas sąrašas yra TIK ATVAIZDAVIMUI: klientas gali jį pakeisti
   * naršyklės konsolėje ir pamatyti paslėptus mygtukus – serveris apie tai
   * nieko nežino ir savo sprendimo nekeičia.
   *
   * Šis testas tai fiksuoja: ta pati sesija, tas pats vartotojas, o serverio
   * atsakymas nepriklauso nuo to, ką klientas mano turintis.
   */
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.ok(!me.body.permissions.includes("export:original"), "operatorius neturi šio leidimo");

  // Klientas "pasikeičia" savo leidimus - serveriui tai nematoma ir nesvarbu.
  const res = await request(app)
    .post("/api/exports")
    .set("Cookie", cookie)
    .set("x-permissions", "export:original") // išgalvota antraštė - serveris jos neskaito
    .send({ variant: "original", format: "txt", protocol: PROTOCOL });

  assert.equal(res.status, 403, "serveris sprendžia pagal SESIJĄ, ne pagal kliento teiginius");
});

test("APĖJIMAS: /api/auth/me leidimai SUTAMPA su tuo, ką serveris realiai vykdo", async () => {
  /**
   * Jei UI rodo veiksmą, kurio serveris neleidžia, vartotojas gauna 403 po
   * paspaudimo – bloga patirtis. Jei UI slepia veiksmą, kurį serveris leistų,
   * funkcija tampa nepasiekiama.
   *
   * Abi kryptys yra klaidos, todėl tikrinam SUTAPIMĄ, ne vien atmetimą.
   */
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);

  // Leidimas YRA -> veiksmas turi praeiti (ne 403).
  assert.ok(me.body.permissions.includes("export:redacted"));
  const allowed = await request(app)
    .post("/api/exports")
    .set("Cookie", cookie)
    .send({ variant: "redacted", format: "txt", protocol: PROTOCOL });
  assert.notEqual(allowed.status, 403, "deklaruotas leidimas turi realiai veikti");

  // Leidimo NĖRA -> veiksmas turi būti atmestas.
  assert.ok(!me.body.permissions.includes("export:original"));
  const denied = await request(app)
    .post("/api/exports")
    .set("Cookie", cookie)
    .send({ variant: "original", format: "txt", protocol: PROTOCOL });
  assert.equal(denied.status, 403, "nedeklaruotas leidimas turi būti atmestas");
});

/**
 * BAIGIAMASIS VALYMAS.
 *
 * Sesijų saugykla paleidžia periodinį laikmatį, o job store gali laikyti
 * atvirą ryšį. Be valymo vaikinis procesas kartais nespėdavo tvarkingai
 * baigtis, ir Node testų vykdyklė krisdavo FAILO lygiu su „Unable to
 * deserialize cloned data" – klaida, kuri neturi nieko bendro su testų turiniu
 * ir todėl atrodo kaip atsitiktinis nestabilumas.
 */
test.after(async () => {
  const sessionStore = require("../utils/sessionStore");
  sessionStore._stopPeriodicSweepForTests();
  await sessionStore._clearForTests();

  const jobStore = require("../utils/jobStore");
  if (typeof jobStore.close === "function") await jobStore.close().catch(() => {});
});

test("DEV NUOSEKLUMAS: be konfigūracijos /auth/me grąžina tapatybę, ne 401", async () => {
  /**
   * NEATITIKIMAS, kurį pagavo E2E (3 min timeout'ai, ne testų klaida).
   *
   * `authenticate` dev režime praleidžia VISAS užklausas su `administrator`
   * role, bet `/auth/me` grąžindavo 401 – ir frontend rodydavo prisijungimo
   * formą sistemai, kuri realiai leidžia viską. Vartotojas būdavo užblokuotas,
   * o prisijungti nebūdavo kaip: vartotojų juk nesukonfigūruota.
   *
   * Toks neatitikimas blogesnis nei bet kuris vienas sprendimas atskirai.
   */
  const savedUsers = process.env.AUTH_USERS;
  const savedKey = process.env.API_KEY;

  process.env.AUTH_USERS = "";
  process.env.API_KEY = "";

  try {
    const res = await request(app).get("/api/auth/me");

    assert.equal(res.status, 200, "dev režime /auth/me turi grąžinti tapatybę");
    assert.equal(res.body.role, "administrator");
    assert.equal(res.body.authConfigured, false, "UI turi žinoti, kad tai NĖRA tikras prisijungimas");
    assert.ok(res.body.permissions.includes("job:delete"));
  } finally {
    process.env.AUTH_USERS = savedUsers;
    process.env.API_KEY = savedKey;
  }
});

test("DEV NUOSEKLUMAS: SUKONFIGŪRAVUS autentifikaciją /auth/me vėl reikalauja sesijos", async () => {
  // AUTH_USERS šiame faile nustatytas, tad dev nuolaida negalioja.
  const res = await request(app).get("/api/auth/me");

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "SESSION_REQUIRED");
});
