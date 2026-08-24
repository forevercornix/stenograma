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

/**
 * ANTRAS ADMINISTRATORIUS (#160).
 *
 * `JOB_DELETE` turi TIK `administrator` rolė (`utils/permissions.js`), tad
 * operatorius trynimo apskritai nepasiekia - jį sustabdo `requirePermission`
 * PRIEŠ nuosavybės politiką.
 *
 * Vadinasi „svetimas DELETE" scenarijų galima patikrinti tik tarp DVIEJŲ
 * administratorių. Be antro admin'o testas praeitų dėl rolės, o ne dėl
 * nuosavybės - ir apie #159/#160 neįrodytų nieko.
 */
process.env.AUTH_USERS = `sysadmin:administrator:${hashPassword("admin-slaptas-1")}:11111111-1111-4111-8111-111111111111,darbuotojas:operator:${hashPassword(
  "operator-slaptas-2"
)}:33333333-3333-4333-8333-333333333333,antrasadmin:administrator:${hashPassword(
  "antras-slaptas-3"
)}:55555555-5555-4555-8555-555555555555`;
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

test("SUKONFIGŪRUOTI VARTOTOJAI uždaro dev praleidimą", async () => {
  /**
   * ⚠️ DEFEKTAS, RASTAS #20 PR4: `authenticate` tikrindavo tik `API_KEY`, tad
   * sistema su SUKONFIGŪRUOTAIS vartotojais (`AUTH_USERS`), bet be rakto, dev
   * režime likdavo ATVIRA – anoniminė užklausa gaudavo `administrator` teises.
   *
   * Tai nebuvo teorinis atvejis: būtent tokia konfigūracija natūrali diegimui,
   * pereinančiam nuo bendro rakto prie sesijų (#18).
   *
   * Šiame faile `AUTH_USERS` nustatytas, tad anoniminė užklausa privalo gauti
   * 401 – ne praleidimą.
   */
  const res = await request(app).post("/api/jobs").send({ transcript: TRANSCRIPT });

  assert.equal(res.status, 401, "su sukonfigūruotais vartotojais anonimas neturi praeiti");
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("DEV REŽIMAS: be JOKIOS konfigūracijos užklausa vis dar praleidžiama", async () => {
  /**
   * Sąmoningas sprendimas lieka galioti: kai nėra NEI `API_KEY`, NEI
   * `AUTH_USERS`, ir `NODE_ENV != production`, lokalus kūrėjas turi matyti
   * viską – apsaugos vis tiek nėra.
   *
   * Produkcijoje tas pats kelias grąžina 503.
   */
  const savedUsers = process.env.AUTH_USERS;
  process.env.AUTH_USERS = "";

  try {
    const res = await request(app).post("/api/jobs").send({ transcript: TRANSCRIPT });
    assert.equal(res.status, 202, "be jokios konfigūracijos užklausa turi praeiti");
  } finally {
    process.env.AUTH_USERS = savedUsers;
  }
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

/* ═══════════════════════════════════════════════════════════════════════════
 * #158: STABILI TAPATYBĖ PER TIKRĄ HTTP SRAUTĄ
 *
 * Vienetiniai testai tikrina grandies galus atskirai. Šie – visą kelią:
 * login → verifyCredentials → sessionStore → cookie → middleware → req.user.
 * Būtent tokio pobūdžio spraga (#17 laikų `actor` be `actorSource`) anksčiau
 * praslydo pro vienetinius testus ir buvo rasta tik pilname sraute.
 * ═══════════════════════════════════════════════════════════════════════════ */

const sessionStoreForIdentity = require("../utils/sessionStore");

const SYSADMIN_ID = "11111111-1111-4111-8111-111111111111";

test("#158 SRAUTAS: login sukuria sesiją su stabiliu userId iš AUTH_USERS", async () => {
  const login = await request(app)
    .post("/api/auth/login")
    .send({ username: "sysadmin", password: "admin-slaptas-1" });

  assert.equal(login.status, 200);

  const cookie = login.headers["set-cookie"][0].split(";")[0];
  /** #155 / 7.3: cookie reikšmė yra BEARER TOKEN'AS, ne `session.id`. */
  const token = decodeURIComponent(cookie.split("=")[1]);
  const session = await sessionStoreForIdentity.touch(token);

  assert.equal(session.userId, SYSADMIN_ID, "userId turi ateiti iš AUTH_USERS ketvirto lauko");
  assert.equal(session.username, "sysadmin");
});

test("#158 SRAUTAS: /api/auth/me neatskleidžia userId klientui", async () => {
  /**
   * SĄMONINGAS sprendimas: `userId` yra vidinis stabilus identifikatorius.
   * Jo atskleidimas naršyklei būtų API kontrakto pakeitimas be poreikio –
   * nė vienas klientas jo nenaudoja. Jei kada prireiks, tai atskiras sprendimas.
   */
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ username: "sysadmin", password: "admin-slaptas-1" });

  const me = await agent.get("/api/auth/me");

  assert.equal(me.status, 200);
  assert.equal(me.body.username, "sysadmin");
  assert.equal(me.body.userId, undefined, "vidinis ID neturi nutekėti į atsakymą");
  assert.equal(me.body.id, undefined);
});

test("#158 SRAUTAS: sesija be stabilaus userId NEKURIA job'o (fail-fast)", async () => {
  /**
   * ANOMALIJA, ne normalus kelias: po #158 `verifyCredentials()` visada
   * grąžina `id`. Bet jei taip nutiktų, `newJob()` vis tiek pažymėtų įrašą
   * kaip `schemaVersion: 2`, ir `jobAuthorization` aiškintų įrašytą VARDĄ kaip
   * `userId` – job'as žūtų `ACTOR_UNKNOWN` jau suvartojęs eilės vietą ir
   * vartotojo laukimą.
   *
   * Iš anksto pasmerktas job'as blogesnis už atmestą užklausą, tad anomalija
   * sustabdoma PRIEŠ enqueue.
   */
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ username: "sysadmin", password: "admin-slaptas-1" });

  // Imituojam anomaliją: sesijos įraše dingsta userId.
  const sessions = sessionStoreForIdentity;
  const before = await sessions.size();
  assert.ok(before > 0, "prielaida: sesija sukurta");

  const login2 = await request(app)
    .post("/api/auth/login")
    .send({ username: "sysadmin", password: "admin-slaptas-1" });
  const cookie = login2.headers["set-cookie"][0].split(";")[0];
  const token = decodeURIComponent(cookie.split("=")[1]);

  const session = await sessions.touch(token);
  session.userId = null; // in-memory įrašas - keičiam tiesiogiai

  const res = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookie)
    .send({ transcript: "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita." });

  assert.equal(res.status, 500, "anomalija turi būti atmesta, o ne sukurti pasmerktą job'ą");
  assert.equal(res.body.code, "IDENTITY_UNAVAILABLE");
  assert.equal(res.body.jobId, undefined, "job'as neturi būti sukurtas");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #159: NUOSAVYBĖ PER TIKRĄ HTTP SRAUTĄ
 *
 * Store lygio testai įrodo, kad `FORBIDDEN` grąžinamas. Šie įrodo, kad
 * maršrutai jį APDOROJA. Skirtumas kritinis: `FORBIDDEN` yra `Symbol`, o
 * `Symbol` yra TRUTHY – įprasta `if (!job)` patikra jo nepagauna, ir svetimas
 * įrašas praeitų toliau kaip savas, grąžindamas 200.
 * ═══════════════════════════════════════════════════════════════════════════ */

const jobStoreForOwnership = require("../utils/jobStore");

test("#159 HTTP: A negauna B job'o (GET) ir neatskleidžiama, kad jis egzistuoja", async () => {
  // Savininkas B = sysadmin; „vagis" A = eilinis operatorius.
  const cookieB = await loginAs("sysadmin", "admin-slaptas-1");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookieB)
    .send({ transcript: "Jonas: Sveiki, pradedam susitikima del ataskaitos." });
  assert.equal(created.status, 202);
  const jobId = created.body.jobId;

  /**
   * „Svetimas" vartotojas čia turi būti EILINIS (operator), ne administratorius:
   * po #160 admin svetimam `GET` gauna 403, ne 404. Admin elgesys tikrinamas
   * atskirai žemiau.
   */
  const cookieA = await loginAs("darbuotojas", "operator-slaptas-2");
  const stolen = await request(app).get(`/api/jobs/${jobId}`).set("Cookie", cookieA);

  assert.notEqual(stolen.status, 200, "svetimas jobas NIEKADA neturi grįžti su 200");
  assert.equal(stolen.status, 404, "eiliniam vartotojui - 404, jokio egzistavimo orakulo");
  assert.equal(stolen.body.transcript, undefined);
  assert.equal(stolen.body.result, undefined, "jokio turinio nutekėjimo");
});

test("#160 HTTP: admin B ištrina admin A job'ą TIK per override, ne kaip savininkas", async () => {
  /**
   * Abu vartotojai yra `administrator` – skiriasi TIK nuosavybė.
   *
   * ⚠️ Be antro admin'o šis testas praeitų dėl rolės: `JOB_DELETE` turi tik
   * `administrator`, tad operatorių sustabdytų `requirePermission` dar prieš
   * nuosavybės politiką, ir apie nuosavybę nebūtų įrodyta nieko.
   */
  const cookieB = await loginAs("antrasadmin", "antras-slaptas-3");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookieB)
    .send({ transcript: "Petras: Aptariame biudzeta kitiems metams." });
  const jobId = created.body.jobId;

  const cookieA = await loginAs("sysadmin", "admin-slaptas-1");
  const attempt = await request(app).delete(`/api/jobs/${jobId}`).set("Cookie", cookieA);

  // Session-admin GAUNA override – bet tai turi būti override, ne savininko kelias.
  assert.equal(attempt.status, 204, "session-admin trynimo override leidžiamas");

  /**
   * ESMINĖ patikra: ne tik atsakymo kodas, bet ir tai, kad įrašas TIKRAI liko.
   * `FORBIDDEN` neturi patekti į `eraseJob()` kaip tariamas job objektas –
   * ten jis būtų aiškinamas kaip įrašas su `undefined` laukais ir galėtų
   * paleisti valymą.
   */
  assert.equal(await jobStoreForOwnership.system.get(jobId), null, "realiai ištrinta");

  // Bet SKAITYTI to paties job'o admin A negalėjo – override tik trynimui.
  const kitas = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookieB)
    .send({ transcript: "Ona: Antras posedis del to paties klausimo." });
  const read = await request(app).get(`/api/jobs/${kitas.body.jobId}`).set("Cookie", cookieA);
  assert.equal(read.status, 403, "skaitymo override NELEIDŽIAMAS");
});

test("#159 HTTP: savininkas savo job'ą gauna normaliai (regresija)", async () => {
  const cookieB = await loginAs("darbuotojas", "operator-slaptas-2");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookieB)
    .send({ transcript: "Ona: Reikia parengti protokola iki penktadienio." });

  const own = await request(app).get(`/api/jobs/${created.body.jobId}`).set("Cookie", cookieB);
  assert.equal(own.status, 200, "nuosavybės filtras neturi blokuoti tikrojo savininko");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #160: POLITIKA PER TIKRĄ HTTP SRAUTĄ
 *
 * `jobAccessPolicy` matrica įrodo, kad SPRENDIMAI teisingi. Šie testai įrodo,
 * kad sprendimai realiai PASIEKIA atsaką — kad graži 18 ląstelių matrica
 * išliko transporto sluoksnyje, o ne liko izoliuotame vienete.
 * ═══════════════════════════════════════════════════════════════════════════ */

async function operatoriausJobas() {
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookie)
    .send({ transcript: "Ona: Aptariame projekto eiga ir terminus." });
  assert.equal(created.status, 202);
  return { cookie, jobId: created.body.jobId };
}

test("#160 HTTP: eilinis vartotojas svetimam GET gauna 404", async () => {
  const { jobId } = await operatoriausJobas();
  const kitas = await loginAs("sysadmin", "admin-slaptas-1");

  // Sukuriam job'ą admin'ui ir bandom eiliniu - kad „svetimas" būtų tikras.
  const adminJob = await request(app)
    .post("/api/jobs")
    .set("Cookie", kitas)
    .send({ transcript: "Petras: Vidinis pasitarimas del biudzeto." });

  const operatorCookie = await loginAs("darbuotojas", "operator-slaptas-2");
  const res = await request(app)
    .get(`/api/jobs/${adminJob.body.jobId}`)
    .set("Cookie", operatorCookie);

  assert.equal(res.status, 404, "jokio egzistavimo orakulo eiliniam vartotojui");
  assert.equal(res.body.code, undefined, "ir jokio 403 kodo");
  assert.ok(jobId, "savas jobas liko nepaliestas");
});

test("#160 HTTP: session-admin svetimam GET gauna 403, NE turinį", async () => {
  /**
   * Override yra OPERACIJOS savybė: admin gali IŠTRINTI, bet negali SKAITYTI.
   * 403 čia teisingas — administraciniame kontekste egzistavimo slėpimas nėra
   * prioritetas, o skirtumas tarp „nėra" ir „yra, bet neleidžiama" vertingas.
   */
  const { jobId } = await operatoriausJobas();
  const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");

  const res = await request(app).get(`/api/jobs/${jobId}`).set("Cookie", adminCookie);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "ADMIN_READ_NOT_ALLOWED");
  assert.equal(res.body.transcript, undefined, "jokio turinio");
  assert.equal(res.body.result, undefined);
});

test("#160 HTTP: session-admin svetimą job'ą IŠTRINA (override)", async () => {
  const { jobId } = await operatoriausJobas();
  const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");

  const res = await request(app).delete(`/api/jobs/${jobId}`).set("Cookie", adminCookie);

  assert.equal(res.status, 204, "trynimo override leidžiamas");
  assert.equal(await jobStoreForOwnership.system.get(jobId), null, "realiai ištrinta");
});

test("#160 HTTP: eilinis vartotojas NEVALO našlaičio", async () => {
  /**
   * ELGESIO PAKEITIMAS. Anksčiau `null` atveju našlaičių valymas vykdavo bet
   * kuriam vartotojui — o kai store įrašo nebėra, nuosavybės patikrinti
   * neįmanoma. Eilinis vartotojas, žinantis ID, galėjo ištrinti svetimus
   * BullMQ ir audito pėdsakus.
   */
  const operatorCookie = await loginAs("darbuotojas", "operator-slaptas-2");

  const res = await request(app)
    .delete("/api/jobs/00000000-0000-4000-8000-000000000000")
    .set("Cookie", operatorCookie);

  /**
   * Operatorius sustabdomas jau `requirePermission` (`JOB_DELETE` turi tik
   * administratorius), tad iki našlaičių politikos jis nepasiekia. Svarbu
   * REZULTATAS: jokio valymo neįvyko.
   */
  assert.ok([403, 404].includes(res.status), `netikėtas statusas: ${res.status}`);
  assert.equal(res.body.deletion, undefined, "jokio valymo rezultato - valymas nevyko");
});

test("#160 HTTP: savininkas savo job'ą ir mato, ir ištrina (regresija)", async () => {
  /**
   * Savininkas turi būti `administrator`: `JOB_DELETE` operatoriui neprieinamas
   * apskritai, tad su juo šis testas tikrintų tik `GET`.
   */
  const cookie = await loginAs("antrasadmin", "antras-slaptas-3");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookie)
    .send({ transcript: "Rūta: Reikia suderinti kitos savaites darbotvarke." });

  const get = await request(app).get(`/api/jobs/${created.body.jobId}`).set("Cookie", cookie);
  assert.equal(get.status, 200, "politika neturi blokuoti tikrojo savininko");

  const del = await request(app).delete(`/api/jobs/${created.body.jobId}`).set("Cookie", cookie);
  assert.equal(del.status, 204, "savininko trynimas eina ĮPRASTU keliu, ne override");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #160: EKSPORTO POLITIKA
 *
 * KODĖL ATSKIRAI NUO `GET`.
 *
 * Eksportas SĄMONINGAI nenaudoja `respondToDenial()` – jo transporto semantika
 * kitokia: `DENIED` ir `NOT_FOUND` abu virsta `linkState = "missing"`, o pats
 * eksportas tęsiasi (protokolas ateina užklausos kūne, ne iš job'o).
 *
 * Todėl `GET` testai eksporto elgesio NEĮRODO. Svarbu, kad svetimas job'as ir
 * TIKRAI neegzistuojantis būtų NEATSKIRIAMI – kitaip audito `link=` laukas
 * taptų egzistavimo orakulu.
 * ═══════════════════════════════════════════════════════════════════════════ */

const auditLogForExport = require("../utils/auditLog");

const PROTOKOLAS = {
  title: "Testinis posėdis",
  date: "2026-08-17",
  participants: ["Jonas"],
  agenda: ["Klausimas"],
  discussion: ["Aptarta"],
  decisions: ["Nuspręsta"],
  actions: [],
};

/** Grąžina `link=` reikšmę iš paskutinio eksporto audito įrašo. */
function paskutinisLink(nuo) {
  const įrašai = auditLogForExport
    .getAll()
    .slice(nuo)
    .filter((e) => typeof e.details === "string" && e.details.includes("link="));
  assert.ok(įrašai.length > 0, "eksportas turi palikti audito įrašą");
  return /link=(\w+)/.exec(įrašai[įrašai.length - 1].details)[1];
}

test("#160 EXPORT: eilinis vartotojas svetimo job'o egzistavimo neatskleidžia", async () => {
  const savininkas = await loginAs("sysadmin", "admin-slaptas-1");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", savininkas)
    .send({ transcript: "Petras: Vidinis pasitarimas del strategijos." });
  const svetimasId = created.body.jobId;

  const operatorius = await loginAs("darbuotojas", "operator-slaptas-2");

  const priesSvetimo = auditLogForExport.getAll().length;
  const svetimas = await request(app)
    .post("/api/exports")
    .set("Cookie", operatorius)
    .send({ variant: "redacted", format: "txt", protocol: PROTOKOLAS, jobId: svetimasId });
  assert.equal(svetimas.status, 200, `eksportas turi pavykti: ${JSON.stringify(svetimas.body)}`);
  const svetimoLink = paskutinisLink(priesSvetimo);

  const priesNesamo = auditLogForExport.getAll().length;
  const nesamas = await request(app)
    .post("/api/exports")
    .set("Cookie", operatorius)
    .send({
      variant: "redacted",
      format: "txt",
      protocol: PROTOKOLAS,
      jobId: "00000000-0000-4000-8000-000000000000",
    });
  const nesamoLink = paskutinisLink(priesNesamo);

  assert.equal(svetimas.status, nesamas.status, "statusas turi sutapti");
  assert.equal(
    svetimoLink,
    nesamoLink,
    "svetimas ir neegzistuojantis job'as turi būti NEATSKIRIAMI audite"
  );
  assert.equal(svetimoLink, "missing", "abu – missing, ne invalid_type ar job");
});

test("#160 EXPORT: session-admin svetimo job'o irgi nesusieja", async () => {
  /**
   * Admin `GET` gauna 403 (diagnostika), bet EKSPORTAS yra skaitymo operacija:
   * override jai neleidžiamas. Susiejus job'ą, audito įrašas patvirtintų, kad
   * svetimas job'as egzistuoja IR yra tinkamo tipo.
   */
  const operatorius = await loginAs("darbuotojas", "operator-slaptas-2");
  const created = await request(app)
    .post("/api/jobs")
    .set("Cookie", operatorius)
    .send({ transcript: "Ona: Operatoriaus posedis del terminu." });

  const adminCookie = await loginAs("sysadmin", "admin-slaptas-1");
  const pries = auditLogForExport.getAll().length;

  await request(app)
    .post("/api/exports")
    .set("Cookie", adminCookie)
    .send({ variant: "redacted", format: "txt", protocol: PROTOKOLAS, jobId: created.body.jobId });

  assert.equal(
    paskutinisLink(pries),
    "missing",
    "admin neturi susieti svetimo job'o – skaitymo override neleidžiamas"
  );
});

test("#160 EXPORT: savininkas savo job'ą susieja normaliai (regresija)", async () => {
  const cookie = await loginAs("darbuotojas", "operator-slaptas-2");

  /**
   * Užtenka PROTOKOLO job'o: eksportui jo tipas netinka, tad savas job'as duoda
   * `invalid_type`, o svetimas ar nesantis – `missing`. Būtent tas skirtumas ir
   * įrodo, kad nuosavybės filtras savo savininko neblokuoja.
   */
  const protokolo = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookie)
    .send({ transcript: "Rūta: Savas posedis." });

  const pries = auditLogForExport.getAll().length;
  await request(app)
    .post("/api/exports")
    .set("Cookie", cookie)
    .send({ variant: "redacted", format: "txt", protocol: PROTOKOLAS, jobId: protokolo.body.jobId });

  assert.equal(
    paskutinisLink(pries),
    "invalid_type",
    "SAVAS job'as pasiekiamas – matomas tikras tipo neatitikimas, ne missing"
  );
});
