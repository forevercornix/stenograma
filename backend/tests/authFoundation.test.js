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
  const env = { AUTH_USERS: `admin:administrator:${h1},petras:operator:${h2}` };

  const users = loadUsers(env);
  assert.equal(users.size, 2);
  assert.equal(users.get("admin").role, "administrator");
  assert.equal(users.get("petras").role, "operator");
});

test("CREDENTIALS: netinkamas AUTH_USERS formatas meta klaidą su aiškia priežastimi", () => {
  const cases = [
    ["be_dvitaskiu", /netinkamas/],
    ["admin:superrole:scrypt$1$1$1$a$b", /rolė "superrole" nežinoma/],
    ["Admin:operator:scrypt$1$1$1$a$b", /vardas "Admin" netinkamas/],
    ["admin:operator:plaintext123", /neatitinka scrypt formato/],
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
    () => loadUsers({ AUTH_USERS: `admin:operator:${h},admin:administrator:${h}` }),
    (e) => e instanceof CredentialConfigError && /daugiau nei kartą/.test(e.message)
  );
});

test("CREDENTIALS: verifyCredentials grąžina null vienodai nežinomam vardui ir blogam slaptažodžiui", () => {
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("teisingas")}` };

  assert.equal(verifyCredentials("admin", "blogas", env), null);
  assert.equal(verifyCredentials("nera_tokio", "bet-kas", env), null);
  assert.deepEqual(verifyCredentials("admin", "teisingas", env), {
    username: "admin",
    role: "administrator",
  });
});

test("CREDENTIALS: atsako laikas panašus egzistuojančiam ir neegzistuojančiam vartotojui", () => {
  /**
   * Laiko atakų apsauga: jei nežinomam vartotojui scrypt neskaičiuotume,
   * atsakymo laikas išduotų, kad vardo nėra duomenų bazėje.
   */
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("teisingas")}` };

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
  const { errors } = validateConfig({ AUTH_USERS: `admin:administrator:${dangerous}` });

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

  const { errors } = validateConfig({ AUTH_USERS: "admin:superrole:scrypt$1$1$1$a$b" });
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
