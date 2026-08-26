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

process.env.AUTH_USERS = `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}:11111111-1111-4111-8111-111111111111,darbuotojas:operator:${hashPassword(
  OPERATOR_PASSWORD
)}:33333333-3333-4333-8333-333333333333`;
process.env.API_KEY = "";

/** #158: stabilūs ID iš AUTH_USERS – jie tampa job'ų `actor` reikšme. */
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "33333333-3333-4333-8333-333333333333";

const request = require("supertest");
const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const { PERMISSIONS } = require("../utils/permissions");
const { beKomentaru } = require("../utils/auditEvents");
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

  const job = await jobStore.system.get(created.body.jobId);

  /**
   * #158: `actor` yra STABILUS `userId`, ne vardas – todėl pervadinimas
   * nebenutraukia eilėje laukiančio darbo.
   */
  assert.equal(job.actor, OPERATOR_ID, "stabilus aktoriaus ID turi keliauti su jobu");
  assert.equal(job.schemaVersion, 2, "naujas jobas turi būti pažymėtas kaip v2 era");
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
  const job = await jobStore.system.get(created.body.jobId);

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
  const envBezJo = { AUTH_USERS: `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}:11111111-1111-4111-8111-111111111111` };
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

  const job = await jobStore.system.get(created.body.jobId);
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
  const before = (await auditLog.getAll()).length;

  const job = { actor: "dinges-vartotojas", actorSource: "session", actorRole: "operator" };
  await authorizeJobOrAudit(job, "job_testinis", PERMISSIONS.JOB_CREATE);

  const nauji = (await auditLog.getAll()).slice(before);
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
      /**
       * ⚠️ `await` YRA DALIS REIKALAVIMO NUO 7.4a (#210).
       *
       * ⚠️ `const` NEPRIVALOMAS, `await` - PRIVALOMAS. `queues/jobRunner.js`
       * naudoja `let decision;` + `try/catch`, nes blokuojantis auditas gali
       * atmesti, ir inline kelias privalo job'ą perkelti į terminalią būseną
       * (`AUDIT_UNAVAILABLE`). Deklaracijos forma nesvarbi; svarbu, kad
       * kvietimas būtų su argumentais IR laukiamas.
       *
       * `authorizeJobOrAudit()` tapo async, nes `JOB_EXECUTION_DENIED` yra
       * BLOKUOJANTIS audito įvykis. Be `await` kvietimas grąžintų Promise,
       * `decision.allowed` būtų `undefined`, ir job'as būtų nutrauktas kaip
       * neautorizuotas - arba, blogiau, praeitų. Šablonas sugriežtintas, ne
       * susilpnintas: dabar reikalaujama IR kvietimo su argumentais, IR laukimo.
       */
      /(?:const\s+)?decision\s*=\s*await\s+authorizeJobOrAudit\(/,
      `${file} turi REALIAI iškviesti IR palaukti autorizacijos vykdymo metu`
    );
    assert.match(source, /AUTHORIZATION_REVOKED/, `${file} turi pažymėti jobą kaip nutrauktą`);

    /**
     * ⚠️ TRIPWIRE, NE ELGSENOS ĮRODYMAS (AGENTS.md §9.2).
     *
     * Nutraukto vykdymo šakos grįžta anksčiau nei bendras `finally`, tad
     * šaltinio audio jos privalo atlaisvinti PAČIOS - kitaip įkeltas failas
     * lieka saugykloje neribotai (retencijos valytojas jo neliečia, kol raktą
     * nurodo gyvas job'o įrašas).
     *
     * ELGSENĄ dengia `auditAsyncCutover` testai, bet TIK inline kelyje: BullMQ
     * šakai reikia Redis, tad šioje aplinkoje ji lieka nepatikrinta elgsena.
     * Ši patikra saugo nuo to, kad du keliai vėl išsiskirtų tyliai.
     *
     * ⚠️ Tikrinamas ne `_cleanupStorage` KIEKIS faile - pirmoji versija taip ir
     * darė, ir mutacija, pašalinusi valymą iš atšauktų teisių šakos, PRAĖJO:
     * įprasti sėkmės ir nesėkmės keliai valymą kviečia savaime. Anksčiuojamės
     * prie KONKREČIOS šakos: nuo jos `error_code` iki jos `return`.
     */
    const svarus = beKomentaru(source);

    for (const sakosZyme of ["AUTHORIZATION_REVOKED", "AUDIT_UNAVAILABLE"]) {
      const pradzia = svarus.indexOf(`"${sakosZyme}"`);
      assert.notEqual(pradzia, -1, `${file}: nerasta ${sakosZyme} šaka`);

      const pabaiga = svarus.indexOf("return;", pradzia);
      assert.notEqual(pabaiga, -1, `${file}: ${sakosZyme} šaka neturi ankstyvo return`);

      assert.match(
        svarus.slice(pradzia, pabaiga),
        /(?:_cleanupStorage|_atlaisvintiSaltini)\(/,
        `${file}: ${sakosZyme} šaka grįžta neatlaisvinusi šaltinio audio`
      );
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #158: TRYS ERAS MARŠRUTIZAVIMAS
 *
 * Repo turi tris skirtingas job įrašų eras, ir jos skiriasi NE aktoriaus
 * eilutės forma, o `schemaVersion`. Šis atskyrimas nėra teorinis: #17 laikų
 * job'ai turėjo `actor` be `actorSource`, ir dėl to 0 iš 6 job'ų pasiekė
 * procesorių (žr. jobAuthorization.js komentarą). Klaida praslydo pro
 * vienetinius testus, nes jie tikrino derinį, kurio realiai beveik nebūna.
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#158 ERA #17: jobas be actorSource praleidžiamas (NO_ACTOR passthrough)", () => {
  const job = { id: "j17", actor: "darbuotojas" };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true, "#17 laikų jobai neturi tyliai mirti po atnaujinimo");
  assert.equal(decision.reason, DENY_REASON.NO_ACTOR);
});

test("#158 ERA #18: jobas be schemaVersion sprendžiamas pagal VARDĄ", () => {
  const job = { id: "j18", actor: "darbuotojas", actorSource: "session", actorRole: "operator" };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true, "legacy vardo paieška turi veikti");
  assert.equal(decision.role, "operator");
});

test("#158 ERA #18: legacy jobas su UUID aktoriumi NERANDAMAS (vardo paieška)", () => {
  /**
   * Kraštinis atvejis, kurį formos heuristika būtų aiškinusi atvirkščiai:
   * pre-v2 įrašas su UUID formos aktoriumi yra vardo paieška, ir ji turi
   * nepavykti – nes tokio VARDO nėra. Era, ne forma.
   */
  const job = { id: "j18u", actor: OPERATOR_ID, actorSource: "session" };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, DENY_REASON.ACTOR_UNKNOWN);
});

test("#158 ERA v2: jobas su schemaVersion=2 sprendžiamas pagal ID", () => {
  const job = { id: "jv2", schemaVersion: 2, actor: OPERATOR_ID, actorSource: "session" };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true);
  assert.equal(decision.role, "operator");
});

test("#158 ERA v2: PERVADINIMAS nebenutraukia jobo (esminis šio PR pokytis)", () => {
  /**
   * Iki #158 aktorius buvo ieškomas pagal vardą, tad pervadinus vartotoją
   * eilėje laukiantis darbas gaudavo ACTOR_UNKNOWN, nors tapatybė nepasikeitė.
   */
  const job = { id: "jv2r", schemaVersion: 2, actor: OPERATOR_ID, actorSource: "session" };

  const poPervadinimo = {
    AUTH_USERS: `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}:${ADMIN_ID},` +
      `visai-kitas-vardas:operator:${hashPassword(OPERATOR_PASSWORD)}:${OPERATOR_ID}`,
  };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE, poPervadinimo);

  assert.equal(decision.allowed, true, "tas pats ID – tas pats žmogus");
  assert.equal(decision.role, "operator");
});

test("#158 ERA v2: ištrintas vartotojas duoda ACTOR_UNKNOWN, BE legacy fallback", () => {
  /**
   * Jei nerastas ID kristų į vardo paiešką, ištrinto vartotojo įvykiai
   * užterštų legacy WARN signalą, pagal kurį sprendžiama, kada legacy šaką
   * galima šalinti.
   */
  const job = { id: "jv2d", schemaVersion: 2, actor: OPERATOR_ID, actorSource: "session" };
  const envBezJo = {
    AUTH_USERS: `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}:${ADMIN_ID}`,
  };

  const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE, envBezJo);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, DENY_REASON.ACTOR_UNKNOWN);
});

test("#158 ERA v2: nežinomas actorSource meta kontroliuojamą klaidą", () => {
  /**
   * Tylus `null` atrodytų kaip „vartotojas ištrintas" ir paslėptų kodo klaidą.
   * Pre-v2 įrašams tai negalioja – jų reikšmių rinkinys užfiksuotas istorijoje.
   */
  const v2 = { id: "jv2x", schemaVersion: 2, actor: "x", actorSource: "session_v2" };
  assert.throws(() => authorizeJobExecution(v2, PERMISSIONS.JOB_CREATE), /Nežinomas actorSource/);

  const preV2 = { id: "jpre", actor: "x", actorSource: "session_v2" };
  const decision = authorizeJobExecution(preV2, PERMISSIONS.JOB_CREATE);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, DENY_REASON.ACTOR_UNKNOWN);
});

test("#158 ERA: schemaVersion immutable – applyPatch jo nekeičia", () => {
  const { newJob, applyPatch } = require("../utils/jobStore/common");

  const job = newJob({ type: "protocol" });
  assert.equal(job.schemaVersion, 2);

  const patched = applyPatch(job, { schemaVersion: 99, status: "processing" });
  assert.equal(patched.schemaVersion, 2, "era yra faktas apie sukūrimą, ne keičiamas laukas");

  const legacy = { id: "l", status: "queued" };
  const patchedLegacy = applyPatch(legacy, { schemaVersion: 2 });
  assert.equal("schemaVersion" in patchedLegacy, false, "legacy jobas negali tapti v2 per patch");
});

test("#158 ERA: nepalaikoma schemaVersion meta klaidą, o NE tyliai tampa legacy", () => {
  /**
   * Regresijos apsauga. Ankstesnėje versijoje versijos patikra buvo PO
   * `actorSource` maršrutizavimo, tad `schemaVersion: 3` + `session` nukrisdavo
   * į legacy šaką: naujos eros `actor` (kad ir kokia būtų jo semantika) būdavo
   * aiškinamas kaip VARDAS, ir dar užterštas legacy WARN signalas.
   *
   * Nauja era turi gauti savo šaką, ne paveldėti senąją.
   */
  for (const version of [1, 3, 99]) {
    const job = { id: `jv${version}`, schemaVersion: version, actor: OPERATOR_ID, actorSource: "session" };
    assert.throws(
      () => authorizeJobExecution(job, PERMISSIONS.JOB_CREATE),
      /Nepalaikoma job schemaVersion/,
      `schemaVersion ${version} turi kristi, ne būti aiškinamas kaip legacy`
    );
  }
});

test("#158 ERA: nepalaikoma versija krinta ir api-key kelyje", () => {
  const job = { id: "jak", schemaVersion: 3, actor: "key_abc123", actorSource: "api-key" };
  assert.throws(() => authorizeJobExecution(job, PERMISSIONS.JOB_CREATE), /Nepalaikoma job schemaVersion/);
});

test("#158 ERA: nežinoma era NEGALI apsimesti #17 įrašu (be actorSource)", () => {
  /**
   * SIAURIAUSIAS ir PAVOJINGIAUSIAS atvejis.
   *
   * `authorizeJobExecution()` turi #17 suderinamumo short-circuit'ą: įrašas be
   * `actorSource` praleidžiamas su `allowed: true` ir `resolveCurrentRole()`
   * NIEKADA nekviečiamas. Kol eros invariantas buvo tik `resolveCurrentRole()`
   * viduje, įrašas `{schemaVersion: 3, actorSource: null}` jį apeidavo ir buvo
   * PALEIDŽIAMAS kaip legacy.
   *
   * Tai blogiau nei klaidingas atmetimas: nežinomos eros darbas realiai įvyktų.
   */
  const nezinomaEra = { id: "j3ns", schemaVersion: 3, actor: "bet-kas", actorSource: null };
  assert.throws(
    () => authorizeJobExecution(nezinomaEra, PERMISSIONS.JOB_CREATE),
    /Nepalaikoma job schemaVersion/,
    "nežinoma era be actorSource turi kristi, ne būti paleista kaip #17"
  );
});

test("#158 ERA: tikras #17 įrašas (be eros, be actorSource) toliau praleidžiamas", () => {
  /**
   * Antra invarianto pusė: apsauga nuo naujos eros neturi sulaužyti senosios.
   * Tikrinamos ABI „eros nėra" reprezentacijos – `undefined` atmintyje ir
   * `null` po Redis round-trip.
   */
  for (const era of [undefined, null]) {
    const job = { id: "j17", schemaVersion: era, actor: "darbuotojas", actorSource: null };
    const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

    assert.equal(decision.allowed, true, `#17 įrašas (${era}) turi likti praleidžiamas`);
    assert.equal(decision.reason, DENY_REASON.NO_ACTOR);
  }
});

test("#158 ERA: undefined IR null schemaVersion lieka teisėti (pre-v2 eros)", () => {
  /**
   * `null` nėra teorinis: Redis lauko nebuvimą grąžina kaip tuščią string'ą,
   * kuris deserializacijoje tampa `null`. Griežta `!== undefined` patikra būtų
   * metusi klaidą KIEKVIENAM legacy job'ui iš Redis - apsauga nuo naujos eros
   * būtų sunaikinusi senąją.
   */
  for (const era of [undefined, null]) {
    const job = { id: "j18ok", schemaVersion: era, actor: "darbuotojas", actorSource: "session" };
    const decision = authorizeJobExecution(job, PERMISSIONS.JOB_CREATE);

    assert.equal(decision.allowed, true, `pre-v2 įrašas (${era}) turi veikti be pakeitimų`);
    assert.equal(decision.role, "operator");
  }
});

test("#158 ERA: null jobas lieka teisėtas įėjimas (NO_ACTOR, ne klaida)", () => {
  /**
   * `authorizeJobExecution()` priima `null` ir grąžina passthrough. Eros
   * invariantas įterptas VIRŠ tos patikros, tad be atskiro `!job` atvejo jis
   * būtų metęs `TypeError` – apsauga nuo nežinomos eros būtų sulaužiusi
   * trūkstamo įrašo kelią. Pagavo esamas `audioCleanup` testas.
   */
  const decision = authorizeJobExecution(null, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, DENY_REASON.NO_ACTOR);
});
