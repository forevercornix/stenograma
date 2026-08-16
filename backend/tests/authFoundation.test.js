const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_LOGIN_MAX = "500";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";

const { hashPassword, verifyCredentials, verifyPassword, loadUsers, CredentialConfigError } = require("../utils/credentials");
const sessionStore = require("../utils/sessionStore");

/**
 * #18 PR1: AUTENTIFIKACIJOS PAMATAS.
 *
 * Šis PR tikslingai NETURI RBAC vykdymo (tai PR2). Testai tikrina TIK: ar
 * galima patikimai nustatyti, kas yra vartotojas, ar sesija baigiasi laiku,
 * ir ar paslaptys niekada nenutekina.
 */

test("CREDENTIALS: scrypt maiša patikrinama teisingai ir neteisingai", () => {
  const hash = hashPassword("teisingas-slaptazodis-123");

  assert.equal(verifyPassword("teisingas-slaptazodis-123", hash), true);
  assert.equal(verifyPassword("neteisingas", hash), false);
  assert.equal(verifyPassword("", hash), false);
});

test("CREDENTIALS: maiša niekada nesutampa tarp dviejų generavimų (atsitiktinė druska)", () => {
  const h1 = hashPassword("tas-pats-slaptazodis");
  const h2 = hashPassword("tas-pats-slaptazodis");

  assert.notEqual(h1, h2, "druska turi būti atsitiktinė");
  assert.equal(verifyPassword("tas-pats-slaptazodis", h1), true);
  assert.equal(verifyPassword("tas-pats-slaptazodis", h2), true);
});

test("CREDENTIALS: AUTH_USERS parsinamas teisingai", () => {
  const h1 = hashPassword("a1");
  const h2 = hashPassword("b2");
  const env = { AUTH_USERS: `admin:administrator:${h1}:11111111-1111-4111-8111-111111111111,petras:operator:${h2}:44444444-4444-4444-8444-444444444444` };

  const users = loadUsers(env);
  assert.equal(users.size, 2);
  assert.equal(users.get("admin").role, "administrator");
  assert.equal(users.get("petras").role, "operator");
});

test("CREDENTIALS: netinkamas AUTH_USERS formatas meta klaidą su aiškia priežastimi", () => {
  const H = hashPassword("x");
  const cases = [
    ["be_dvitaskiu", /4 laukai/],
    [`admin:superrole:${H}:11111111-1111-4111-8111-111111111111`, /rolė "superrole" nežinoma/],
    [`Admin:operator:${H}:11111111-1111-4111-8111-111111111111`, /vardas "Admin" netinkamas/],
    [`admin:operator:plaintext123:11111111-1111-4111-8111-111111111111`, /neatitinka scrypt formato/],
  ];

  for (const [entry, pattern] of cases) {
    assert.throws(
      () => loadUsers({ AUTH_USERS: entry }),
      (e) => e instanceof CredentialConfigError && pattern.test(e.message),
      `turėjo mesti klaidą: ${entry}`
    );
  }
});

test("CREDENTIALS: dublikuotas vardas AUTH_USERS meta klaidą", () => {
  const h = hashPassword("x");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${h}:11111111-1111-4111-8111-111111111111,admin:administrator:${h}:44444444-4444-4444-8444-444444444444` }),
    (e) => e instanceof CredentialConfigError && /daugiau nei kartą/.test(e.message)
  );
});

test("CREDENTIALS: verifyCredentials grąžina null vienodai nežinomam vardui ir blogam slaptažodžiui", () => {
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("teisingas")}:22222222-2222-4222-8222-222222222222` };

  assert.equal(verifyCredentials("admin", "blogas", env), null);
  assert.equal(verifyCredentials("nera_tokio", "bet-kas", env), null);
  /**
   * #158: grąžinama ir `id` – stabili tapatybė. Vardas ir rolė lieka, nes juos
   * naudoja auditas, logai ir sesijos cookie srautas.
   */
  assert.deepEqual(verifyCredentials("admin", "teisingas", env), {
    id: "22222222-2222-4222-8222-222222222222",
    username: "admin",
    role: "administrator",
  });
});

test("CREDENTIALS: atsako laikas panašus egzistuojančiam ir neegzistuojančiam vartotojui", () => {
  /**
   * Laiko atakų apsauga: jei nežinomam vartotojui scrypt neskaičiuotume,
   * atsakymo laikas išduotų, kad vardo nėra duomenų bazėje.
   */
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("teisingas")}:22222222-2222-4222-8222-222222222222` };

  const measure = (fn) => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  // Kelios iteracijos, kad sumažintume atsitiktinį triukšmą.
  const knownTimes = Array.from({ length: 5 }, () => measure(() => verifyCredentials("admin", "x", env)));
  const unknownTimes = Array.from({ length: 5 }, () => measure(() => verifyCredentials("nera", "x", env)));

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ratio = avg(knownTimes) / avg(unknownTimes);

  // Griežtos ribos čia nestatom (CI laikas kintantis) - tik apsauga nuo
  // ORDER-OF-MAGNITUDE skirtumo, koks būtų be atrama-maišos.
  assert.ok(ratio > 0.3 && ratio < 3, `laikai per daug skiriasi (santykis ${ratio.toFixed(2)}) - atrama-maiša neveikia?`);
});

test("CREDENTIALS: verifyPassword NIEKADA nemeta klaidos - net su pavojingais parametrais", () => {
  /**
   * `crypto.scryptSync` su per dideliais N/r/p meta neišgautą `RangeError` -
   * jei toks įrašas kada nors pasiektų verifyPassword (pvz. per rankomis
   * pataisytą duomenų šaltinį, ne AUTH_USERS), login endpointas gautų 500
   * vietoj 401. Patikrinta: aiškiai per didelis N meta `RangeError: Invalid
   * scrypt params`.
   */
  const dangerous = [
    "scrypt$999999999$999999$1$aabbccddeeff00112233445566778899$" + "0".repeat(128),
    "scrypt$16384$999999999$1$aabbccddeeff00112233445566778899$" + "0".repeat(128),
    "scrypt$16384$8$999999999$aabbccddeeff00112233445566778899$" + "0".repeat(128),
  ];

  for (const hash of dangerous) {
    assert.doesNotThrow(() => verifyPassword("bet-koks-slaptazodis", hash), `neturėjo mesti: ${hash.slice(0, 40)}`);
    assert.equal(verifyPassword("bet-koks-slaptazodis", hash), false);
  }
});

test("CREDENTIALS: verifyPassword atmeta netikslų N/r/p (ne tik nesveikus skaičius)", () => {
  // Ankstesnė versija tikrino tik Number.isInteger - bet 999999999 IRGI yra
  // sveikas skaičius. Tikrinama TIKSLI reikšmė, ne vien tipas.
  const validHash = hashPassword("x");
  const [, , r, p, salt, hex] = validHash.split("$");

  for (const badN of ["1", "16385", "999999999", "0", "-16384"]) {
    assert.equal(verifyPassword("x", `scrypt$${badN}$${r}$${p}$${salt}$${hex}`), false, `N=${badN} turėjo būti atmestas`);
  }
});

test("CREDENTIALS: verifyPassword atmeta netinkamą druskos formatą", () => {
  const validHash = hashPassword("x");
  const [, n, r, p, , hex] = validHash.split("$");

  for (const badSalt of ["ne-hex-simboliai-cia", "per-trumpa", "A".repeat(32), "0".repeat(31), "0".repeat(33)]) {
    assert.equal(verifyPassword("x", `scrypt$${n}$${r}$${p}$${badSalt}$${hex}`), false, `druska "${badSalt}" turėjo būti atmesta`);
  }
});

test("CREDENTIALS: verifyPassword atmeta netinkamą maišos ilgį ar formatą", () => {
  const validHash = hashPassword("x");
  const [, n, r, p, salt] = validHash.split("$");

  for (const badHex of ["ne-hex-tekstas-cia-ir-cia-papildomai-ilgesnis-uz-riba-kad-butu-panasu", "0".repeat(127), "0".repeat(129), ""]) {
    assert.equal(verifyPassword("x", `scrypt$${n}$${r}$${p}$${salt}$${badHex}`), false, `maiša "${badHex.slice(0, 20)}…" turėjo būti atmesta`);
  }
});

test("CREDENTIALS: teisingu prefiksu prasidedantis, bet trūkstamas įrašas atmetamas", () => {
  for (const truncated of ["scrypt$16384$8$1$", "scrypt$16384$8$1$aabb", "scrypt$16384", "scrypt$"]) {
    assert.equal(verifyPassword("x", truncated), false, `turėjo būti atmesta: ${truncated}`);
  }
});

test("STARTUP: AUTH_USERS su pavojingais scrypt parametrais stabdo paleidimą", () => {
  const { validateConfig } = require("../utils/startupChecks");

  const dangerous = "scrypt$999999999$999999$1$aabbccddeeff00112233445566778899$" + "0".repeat(128);
  const { errors } = validateConfig({ AUTH_USERS: `admin:administrator:${dangerous}:11111111-1111-4111-8111-111111111111` });

  assert.ok(
    errors.some((e) => /neatitinka scrypt formato/.test(e)),
    "startup turėjo atmesti pavojingus scrypt parametrus, o ne priimti juos kaip 'atrodo kaip scrypt'"
  );
});

test("SESSION STORE: sukurta sesija patvirtinama ir neša teisingus laukus", async () => {
  await sessionStore._clearForTests();
  const session = await sessionStore.create({ username: "admin", role: "administrator" });

  assert.ok(session.id.length > 20);
  const touched = await sessionStore.touch(session.id);
  assert.equal(touched.username, "admin");
  assert.equal(touched.role, "administrator");
});

test("SESSION STORE: idle timeout baigia sesiją ir ji NEATGYJA", async () => {
  await sessionStore._clearForTests();
  const env = { SESSION_IDLE_TIMEOUT_MINUTES: "0.001" }; // ~60ms

  const session = await sessionStore.create({ username: "a", role: "operator" }, env);
  assert.ok(await sessionStore.touch(session.id, env));

  await new Promise((r) => setTimeout(r, 100));

  assert.equal(await sessionStore.touch(session.id, env), null, "sesija turėjo pasibaigti");
  assert.equal(await sessionStore.touch(session.id, env), null, "pasibaigusi sesija negali atgyti pakartotinai");
});

test("SESSION STORE: absoliutus timeout galioja NEPRIKLAUSOMAI nuo aktyvumo", async () => {
  /**
   * Skirtingai nuo idle timeout, absoliutus limitas baigia sesiją, net jei
   * vartotojas ją nuolat naudoja - kitaip sesija galėtų gyventi amžinai vien
   * dažnai atnaujinant.
   */
  await sessionStore._clearForTests();
  const env = { SESSION_IDLE_TIMEOUT_MINUTES: "60", SESSION_ABSOLUTE_TIMEOUT_HOURS: "0.00003" }; // ~100ms

  const session = await sessionStore.create({ username: "a", role: "operator" }, env);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(await sessionStore.touch(session.id, env), null, "absoliutus limitas turėjo baigti sesiją");
});

test("SESSION STORE: destroyAllForUser revokuoja tik nurodyto vartotojo sesijas", async () => {
  await sessionStore._clearForTests();
  const s1 = await sessionStore.create({ username: "a", role: "operator" });
  const s2 = await sessionStore.create({ username: "a", role: "operator" });
  const s3 = await sessionStore.create({ username: "b", role: "operator" });

  const removed = await sessionStore.destroyAllForUser("a");

  assert.equal(removed, 2);
  assert.equal(await sessionStore.touch(s1.id), null);
  assert.equal(await sessionStore.touch(s2.id), null);
  assert.ok(await sessionStore.touch(s3.id), "kito vartotojo sesija neturėjo būti paliesta");
});

test("STARTUP: netinkamas AUTH_USERS formatas stabdo paleidimą", () => {
  const { validateConfig } = require("../utils/startupChecks");

  const { errors } = validateConfig({ AUTH_USERS: `admin:superrole:${hashPassword("x")}:11111111-1111-4111-8111-111111111111` });
  assert.ok(errors.some((e) => /rolė "superrole"/.test(e)));
});

test("STARTUP: netinkamas sesijos laiko limitas stabdo paleidimą", () => {
  const { validateConfig } = require("../utils/startupChecks");

  for (const bad of ["abc", "-1", "0", "999999"]) {
    const { errors } = validateConfig({ SESSION_IDLE_TIMEOUT_MINUTES: bad });
    assert.ok(errors.some((e) => /SESSION_IDLE_TIMEOUT_MINUTES/.test(e)), `turėjo atmesti: ${bad}`);
  }
});

test("STARTUP: be AUTH_USERS paleidimas praeina (šis PR jo dar nereikalauja)", () => {
  const { validateConfig } = require("../utils/startupChecks");
  const { errors } = validateConfig({});
  assert.deepEqual(
    errors.filter((e) => /AUTH_USERS|SESSION/.test(e)),
    []
  );
});

test("SESSION STORE: pasibaigusi sesija, kurios niekas nebeliečia, GALIAUSIAI pašalinama", async () => {
  /**
   * `touch()` ištrina pasibaigusią sesiją TIK kai kas nors ją dar kartą
   * panaudoja. Sesija, kurios klientas daugiau niekada neatsiunčia, liktų
   * `sessions` žemėlapyje neribotą laiką - atminties nutekėjimas ilgai
   * veikiančiame procese.
   */
  await sessionStore._clearForTests();
  const env = { SESSION_IDLE_TIMEOUT_MINUTES: "0.001" }; // ~60ms

  const session = await sessionStore.create({ username: "a", role: "operator" }, env);
  await new Promise((r) => setTimeout(r, 100));

  // Niekas NEIŠKVIEČIA touch() - imituojam klientą, kuris niekada nebegrįžta.
  assert.equal(await sessionStore.size(), 1, "sesija dar žemėlapyje prieš sweep");

  const removed = sessionStore._sweepForTests(env);

  assert.equal(removed, 1);
  assert.equal(await sessionStore.size(), 0, "pasibaigusi sesija turėjo būti pašalinta be touch()");
});

test("SESSION STORE: create() atlieka 'gratis' sweep - nauja sesija neaugina senų likučių", async () => {
  await sessionStore._clearForTests();
  const env = { SESSION_IDLE_TIMEOUT_MINUTES: "0.001" };

  await sessionStore.create({ username: "senas", role: "operator" }, env);
  await new Promise((r) => setTimeout(r, 100));

  await sessionStore.create({ username: "naujas", role: "operator" }, env);

  assert.equal(await sessionStore.size(), 1, "senos sesijos kūrimo metu turėjo būti išvalytos");
});

test("STARTUP: netinkami login rate-limit kintamieji stabdo paleidimą", () => {
  const { validateConfig } = require("../utils/startupChecks");

  for (const name of ["RATE_LIMIT_LOGIN_IP_MAX", "RATE_LIMIT_LOGIN_ACCOUNT_MAX"]) {
    for (const bad of ["abc", "0", "-1", "10xyz", "99999999"]) {
      const { errors } = validateConfig({ [name]: bad });
      assert.ok(
        errors.some((e) => e.includes(name)),
        `${name}="${bad}" turėjo stabdyti paleidimą, bet praėjo`
      );
    }
  }
});

test("STARTUP: geros login rate-limit reikšmės nemeta klaidos", () => {
  const { validateConfig } = require("../utils/startupChecks");

  const { errors } = validateConfig({ RATE_LIMIT_LOGIN_IP_MAX: "30", RATE_LIMIT_LOGIN_ACCOUNT_MAX: "10" });
  assert.deepEqual(
    errors.filter((e) => /RATE_LIMIT_LOGIN/.test(e)),
    []
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #158: STABILUS TAPATYBĖS ŠALTINIS
 *
 * `AUTH_USERS` pereina prie TIKSLAUS 4 laukų kontrakto
 * (`vardas:rolė:maiša:userId`). Šie testai saugo patį kontraktą, ne tik
 * kraštinius atvejus – žr. komentarą prie „maiša su dvitaškiu".
 * ═══════════════════════════════════════════════════════════════════════════ */

const { loadUsersById, USER_ID_PATTERN, UUID_LIKE_PATTERN, USERNAME_PATTERN } = require("../utils/credentials");

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "44444444-4444-4444-8444-444444444444";

test("#158 PARSERIS: 3 laukai (senas formatas) meta startup klaidą", () => {
  const h = hashPassword("x");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${h}` }),
    (e) => e instanceof CredentialConfigError && /4 laukai/.test(e.message),
    "senas 3 laukų formatas turi kristi, ne būti tyliai priimtas"
  );
});

test("#158 PARSERIS: 5+ laukų meta startup klaidą", () => {
  const h = hashPassword("x");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${h}:${UID_A}:papildomas` }),
    (e) => e instanceof CredentialConfigError && /4 laukai/.test(e.message)
  );
});

test("#158 PARSERIS: netinkamas userId meta startup klaidą", () => {
  const h = hashPassword("x");
  const blogi = [
    "ne-uuid",
    "11111111-1111-1111-8111-111111111111", // versija 1, ne 4
    "11111111-1111-4111-c111-111111111111", // blogas variantas
    "11111111111141118111111111111111",     // be brūkšnelių
  ];
  for (const uid of blogi) {
    assert.throws(
      () => loadUsers({ AUTH_USERS: `admin:operator:${h}:${uid}` }),
      (e) => e instanceof CredentialConfigError && /UUIDv4/.test(e.message),
      `turėjo kristi: ${uid}`
    );
  }
});

test("#158 PARSERIS: teisingi 4 laukai praeina ir grąžina userId", () => {
  const h = hashPassword("x");
  const users = loadUsers({ AUTH_USERS: `admin:administrator:${h}:${UID_A}` });

  assert.equal(users.size, 1);
  assert.equal(users.get("admin").userId, UID_A);
  assert.equal(users.get("admin").role, "administrator");
});

/**
 * KONTRAKTO TESTAS, ne kraštinio atvejo testas.
 *
 * Anksčiau maiša buvo renkama godžiai (`hashParts.join(":")`). Godumas dabar
 * pašalintas, bet be šio testo kas nors ateityje galėtų jį grąžinti
 * „patogumo dėlei" – ir ketvirtas laukas vėl tyliai priliptų prie maišos.
 */
test("#158 PARSERIS: maiša su dvitaškiu meta klaidą (godumas nebegrąžinamas)", () => {
  const h = hashPassword("x");
  const suDvitaskiu = h.replace(/\$/g, ":");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${suDvitaskiu}:${UID_A}` }),
    (e) => e instanceof CredentialConfigError,
    "maiša su dvitaškiu turi kristi, o ne būti sudėliota atgal"
  );
});

test("#158 PARSERIS: UUID formos vardas draudžiamas (defense-in-depth)", () => {
  const h = hashPassword("x");
  /**
   * `USERNAME_PATTERN` tokį vardą įleistų: prasideda raide, tik [a-z0-9-],
   * 36 simboliai. Maršrutizavimas nuo formos nepriklauso, bet vardas,
   * neatskiriamas nuo ID, klaidintų logus ir auditą.
   */
  const uuidVardas = "a1b2c3d4-e29b-41d4-a716-446655440000";
  assert.ok(USERNAME_PATTERN.test(uuidVardas), "prielaida: toks vardas atitiktų vardo šabloną");

  assert.throws(
    () => loadUsers({ AUTH_USERS: `${uuidVardas}:operator:${h}:${UID_A}` }),
    (e) => e instanceof CredentialConfigError && /UUID formos/.test(e.message)
  );
});

test("#158 PARSERIS: dublikuotas userId meta klaidą", () => {
  const h = hashPassword("x");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${h}:${UID_A},petras:operator:${h}:${UID_A}` }),
    (e) => e instanceof CredentialConfigError && /userId .* daugiau nei kartą/.test(e.message),
    "du vardai su tuo pačiu ID reikštų, kad nuosavybė nurodo į dvi paskyras"
  );
});

test("#158 TAPATYBĖ: userId nederivuojamas iš vardo – pervadinimas ID nekeičia", () => {
  const h = hashPassword("x");
  const pries = loadUsers({ AUTH_USERS: `senas-vardas:operator:${h}:${UID_A}` });
  const po = loadUsers({ AUTH_USERS: `naujas-vardas:operator:${h}:${UID_A}` });

  assert.equal(pries.get("senas-vardas").userId, po.get("naujas-vardas").userId);
});

test("#158 TAPATYBĖ: identity persists, session does not", () => {
  const h = hashPassword("slaptas");
  const env = { AUTH_USERS: `admin:administrator:${h}:${UID_A}` };

  /**
   * „Restartas" čia yra pakartotinis `AUTH_USERS` nuskaitymas iš tos pačios
   * konfigūracijos. Sesijos NĖRA persistentinės (tai #155 / 7.3) – testuojama
   * būtent tai, kad TAPATYBĖ ateina iš konfigūracijos, ne iš sesijos.
   */
  const pirmas = verifyCredentials("admin", "slaptas", env);
  const antras = verifyCredentials("admin", "slaptas", env);

  assert.equal(pirmas.id, UID_A);
  assert.equal(antras.id, pirmas.id, "po pakartotinio nuskaitymo ID turi sutapti");
});

test("#158 TAPATYBĖ: verifyCredentials grąžina id kartu su vardu ir role", () => {
  const h = hashPassword("slaptas");
  const identity = verifyCredentials("admin", "slaptas", {
    AUTH_USERS: `admin:administrator:${h}:${UID_A}`,
  });

  assert.deepEqual(identity, { id: UID_A, username: "admin", role: "administrator" });
});

test("#158 loadUsersById: indeksuoja pagal userId, ne pagal vardą", () => {
  const h = hashPassword("x");
  const env = { AUTH_USERS: `admin:administrator:${h}:${UID_A},petras:operator:${h}:${UID_B}` };

  const byId = loadUsersById(env);
  assert.equal(byId.size, 2);
  assert.equal(byId.get(UID_A).username, "admin");
  assert.equal(byId.get(UID_B).role, "operator");
  assert.equal(byId.get("admin"), undefined, "vardas neturi būti raktas");
});

test("#158 loadUsersById: tuščias AUTH_USERS grąžina tuščią žemėlapį (desktop režimas)", () => {
  assert.equal(loadUsersById({ AUTH_USERS: "" }).size, 0);
  assert.equal(loadUsersById({}).size, 0);
});

test("#158 USER_ID_PATTERN: priima crypto.randomUUID() išvestį", () => {
  for (let i = 0; i < 20; i++) {
    assert.ok(USER_ID_PATTERN.test(require("node:crypto").randomUUID()));
  }
});

test("#158 PARSERIS: UUIDv1/v7 formos vardas irgi draudžiamas (ne tik v4)", () => {
  const h = hashPassword("x");
  /**
   * Vardo draudimas naudoja `UUID_LIKE_PATTERN` (bet kuri versija), o ne
   * `USER_ID_PATTERN` (griežtai v4). Kitaip draudimas tyliai apimtų tik vieną
   * versiją, nors loguose klaidintų bet kuri UUID forma.
   */
  const kitosVersijos = [
    "a1b2c3d4-e29b-11d4-a716-446655440000", // v1
    "a1b2c3d4-e29b-71d4-a716-446655440000", // v7
  ];
  for (const vardas of kitosVersijos) {
    assert.equal(USER_ID_PATTERN.test(vardas), false, "prielaida: ne v4");
    assert.ok(UUID_LIKE_PATTERN.test(vardas), "prielaida: UUID forma");
    assert.throws(
      () => loadUsers({ AUTH_USERS: `${vardas}:operator:${h}:${UID_A}` }),
      (e) => e instanceof CredentialConfigError && /UUID formos/.test(e.message),
      `turėjo kristi: ${vardas}`
    );
  }
});

test("#158 PARSERIS: userId privalo būti būtent v4, ne bet kuri UUID versija", () => {
  const h = hashPassword("x");
  assert.throws(
    () => loadUsers({ AUTH_USERS: `admin:operator:${h}:a1b2c3d4-e29b-11d4-a716-446655440000` }),
    (e) => e instanceof CredentialConfigError && /UUIDv4/.test(e.message),
    "userId validacija lieka griežta, net kai vardo draudimas platesnis"
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #158 (3–4 žingsniai): TAPATYBĖS PROPAGAVIMAS Į SESIJĄ IR `req.user`
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#158 SESIJA: create() išsaugo stabilų userId kartu su vardu", async () => {
  const session = await sessionStore.create({
    id: UID_A,
    username: "admin",
    role: "administrator",
  });

  assert.equal(session.userId, UID_A);
  assert.equal(session.username, "admin", "vardas lieka – jį naudoja auditas ir logai");
  await sessionStore._clearForTests();
});

test("#158 SESIJA: tapatybė be id duoda userId=null, o ne undefined", async () => {
  const session = await sessionStore.create({ username: "senas", role: "operator" });

  assert.equal(session.userId, null, "aiškus null, ne undefined – kad JSON srautuose nedingtų laukas");
  await sessionStore._clearForTests();
});

test("#158 SESIJA: touch() grąžina userId (jį skaito req.user)", async () => {
  const created = await sessionStore.create({ id: UID_A, username: "admin", role: "administrator" });
  const touched = await sessionStore.touch(created.id);

  assert.equal(touched.userId, UID_A);
  await sessionStore._clearForTests();
});

test("#158 REVOKACIJA: destroyAllForUserId ištrina visas to paties ID sesijas", async () => {
  await sessionStore.create({ id: UID_A, username: "admin", role: "administrator" });
  await sessionStore.create({ id: UID_A, username: "admin", role: "administrator" });
  await sessionStore.create({ id: UID_B, username: "petras", role: "operator" });

  const removed = await sessionStore.destroyAllForUserId(UID_A);

  assert.equal(removed, 2);
  assert.equal(await sessionStore.size(), 1, "kito vartotojo sesija nepaliesta");
  await sessionStore._clearForTests();
});

test("#158 REVOKACIJA: destroyAllForUserId veikia PO pervadinimo (vardu paremta – ne)", async () => {
  /**
   * Esminis skirtumas tarp dviejų revokacijos raktų. Sesija sukurta senu vardu;
   * vartotojas pervadintas. Revokacija pagal NAUJĄ vardą nieko neranda, nors
   * sesija priklauso tam pačiam žmogui. Revokacija pagal ID – randa.
   */
  await sessionStore.create({ id: UID_A, username: "senas-vardas", role: "operator" });

  assert.equal(await sessionStore.destroyAllForUser("naujas-vardas"), 0);
  assert.equal(await sessionStore.destroyAllForUserId(UID_A), 1);
  await sessionStore._clearForTests();
});

test("#158 REVOKACIJA: destroyAllForUserId neliečia sesijų be userId", async () => {
  /**
   * Be šios apsaugos `null === null` sutaptų ir vienas kvietimas iškirstų
   * VISAS senas sesijas iš karto.
   */
  await sessionStore.create({ username: "senas", role: "operator" });
  await sessionStore.create({ username: "kitas", role: "operator" });

  assert.equal(await sessionStore.destroyAllForUserId(null), 0);
  assert.equal(await sessionStore.destroyAllForUserId(undefined), 0);
  assert.equal(await sessionStore.size(), 2);
  await sessionStore._clearForTests();
});

test("#158 REVOKACIJA: destroyAllForUser lieka suderinamas (vardu paremtas kelias)", async () => {
  await sessionStore.create({ id: UID_A, username: "admin", role: "administrator" });
  await sessionStore.create({ id: UID_B, username: "petras", role: "operator" });

  assert.equal(await sessionStore.destroyAllForUser("admin"), 1);
  assert.equal(await sessionStore.size(), 1);
  await sessionStore._clearForTests();
});
