const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
/**
 * ⚠️ POOL'AI PER `stebetiPoola()`, DDL PER `fikturosDdl()` (#380, #380 D8).
 *
 * Neapgaubtas pool'o konstruktorius, nutekėjus klientui, pakabintų failą be
 * diagnostikos; lentelės valymas be `lock_timeout` lauktų už kiekvienos atviros
 * transakcijos NERIBOTAI. Abu sargai pagavo pirmąją šio failo redakciją CI, ne
 * lokaliai.
 *
 * ⚠️ FORMULUOTĖ SĄMONINGAI BE LITERALŲ. Tie sargai tekstiniai, tad komentaras,
 * CITUOJANTIS draudžiamą šabloną, pats tampa pažeidimu — pirmoji šio komentaro
 * redakcija būtent taip ir nukrito (ta pati klasė kaip #423, kur parseris lūžo
 * ant savo dokumentacijos).
 */
const {
  sukurtiResursuKruva,
  stebetiPoola,
  uzdarytiPoola,
  fikturosDdl,
} = require("./helpers/resourceStack");
const { hashPassword, loadUsers } = require("../utils/credentials");

/**
 * #246 — RAW INVARIANTAS: ASMENS IDENTIFIKATORIAI NEPERSISTINAMI.
 *
 * ⚠️ TAI GALUTINĖ GARANTIJA, NE SARGAS. `identityAuditSargas.test.js` yra
 * ankstyvas sintaksinis signalas, kuris pagal konstrukciją nedengia
 * tarpprocedūrinio srauto. Čia tikrinama FAKTINĖ `audit_log` eilutė per
 * `SELECT to_jsonb(a)::text` — be `getAll()`, be serializacijos sluoksnio, be
 * jokios aplikacijos pagalbos.
 *
 * ⚠️⚠️ KO ŠIS TESTAS NEDENGIA — SKAITYK PRIEŠ LAIKANT JĮ PILNA GARANTIJA:
 *
 *   **CLI `--actor` KELIO (E kanalo) ČIA NĖRA.** `erasure-marks.js --actor
 *   "$OPERATOR"` ir `pgDumpBackup --actor "$USER"` neina per sesiją, tad šis
 *   testas lieka ŽALIAS net kai operatoriaus vardas realiai įrašomas į
 *   `audit_log.meta.actor`. Tai sąmoningai paliktas kelias (#246 §0.4, E-out):
 *   reikšmę operatorius deklaruoja pats, žinodamas, kad pasirašo audito įrašą
 *   (`docs/backup-runbook.md`). ⚠️ Vadinasi #246 pažadas yra
 *   „identifikacija nepersistinama iš SESIJOS ir PRISIJUNGIMO kelių", ❌ NE
 *   „vartotojo identifikacija audite nebepersistinama". Žalias šis testas
 *   antrojo teiginio neįrodo.
 */

const SKIP = skipWithoutPostgres();

const SLAPTAS = "teisingas-slaptas-1";
const OPERATORIUS = {
  username: "rawoperatorius",
  userId: "55555555-5555-4555-8555-555555555555",
};

process.env.AUTH_USERS = `${OPERATORIUS.username}:operator:${hashPassword(SLAPTAS)}:${OPERATORIUS.userId}`;
process.env.API_KEY = "raw-testinis-api-raktas-pakankamai-ilgas";
process.env.AUDIT_ID_SALT = "raw-testine-druska-nera-produkcine";
process.env.AUDIT_ID_SALT_ID = "raw-2026-10";
process.env.PRIVACY_MODE = "false";
/**
 * ⚠️ PRIEŠ `require("../server")`. `routes/backup` montuojamas SĄLYGIŠKAI
 * (`server.js`: `if (backupPolicy.isEnabled())`), tad be šio jungiklio (3) ir
 * (4) keliai gautų 404, o testas tikrintų ne tą dalyką.
 */
process.env.BACKUP_ENABLED = "true";

/**
 * ⚠️ `operator`, NE NUTYLIMASIS `administrator` — KITAIP (4) KELIAS NIEKO NEĮRAŠO.
 *
 * `resolveApiKeyRole()` nutylimai grąžina `administrator`, kuris TURI
 * `backup:restore`. Tada užklausa praeina autorizaciją ir krenta vėliau ties
 * dalių patikra — audito eilutės neatsiranda, ir „identifikuojančių reikšmių
 * nerasta" būtų tuščias žalias. CI tai ir parodė: (4) kelias grąžino nulį
 * eilučių.
 *
 * Su `operator` role leidimas ATMETAMAS, o `middleware/authorize.js` atmetimą
 * audituoja API RAKTO kontekste — t. y. būtent toje šakoje, kurioje `actor`
 * privalo likti atspaudu (D2).
 */
process.env.API_KEY_ROLE = "operator";

/**
 * ⚠️ PG REIKIA TIK AUDITUI — `jobStore` IR ŽYMOS LIEKA ATMINTYJE.
 *
 * RAW invariantas tikrina `audit_log` turinį, tad autoritetingas Postgres čia
 * reikalingas tik audito saugyklai. Pirmoji redakcija sukūrė migruotą bazę ir
 * nukreipė į ją TIK `auditStore`, o `jobStore` su `deletionTombstones` liko
 * rodyti į `DATABASE_URL` be migracijų — ir fail-closed žymų barjeras teisingai
 * krito su „relation \"erasure_marks\" does not exist".
 *
 * ⚠️ TVARKA SVARBI: `postgresGuard` `DATABASE_URL` nusiskaito modulio įkėlimo
 * metu (jo `const DATABASE_URL`), tad jį pašalinti galima TIK po `require`.
 * Priešingu atveju testas pats save praleistų.
 */
delete process.env.DATABASE_URL;
process.env.JOB_STORE_BACKEND = "memory";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests();
const auditStore = require("../utils/auditStore");
const { actorFingerprint } = require("../utils/requestContext");

/**
 * UŽDRAUSTOS REIKŠMĖS — IŠVEDAMOS IŠ AUTORITETO (#246 §0.2).
 *
 * Autoritetas yra `utils/credentials.js` vartotojo schema. ⚠️ `role`
 * IŠSKIRIAMAS sąmoningai: `KNOWN_ROLES` yra uždara enum'a, ir jos įtraukimas
 * duotų klaidingus kritimus (`role=operator` audite yra LEISTINA ir reikalinga).
 * ❌ Literalų sąrašo čia nėra, ❌ ir „visos tekstinės reikšmės" taisyklės irgi.
 */
function uzdraustosReiksmes() {
  const [vartotojas] = [...loadUsers(process.env).values()];
  const reiksmes = Object.entries(vartotojas)
    .filter(([laukas]) => laukas !== "role")
    .map(([, reiksme]) => reiksme)
    .filter((r) => typeof r === "string" && r.length > 0);

  assert.ok(reiksmes.includes(OPERATORIUS.username), "fikstūros vardas privalo būti aibėje");
  assert.ok(reiksmes.includes(OPERATORIUS.userId), "fikstūros userId privalo būti aibėje");
  assert.ok(
    !reiksmes.includes("operator"),
    "rolė NETURI būti aibėje — kitaip testas kristų dėl leistino `role=operator`"
  );
  return reiksmes;
}

async function paruostiDb(suffix) {
  const resursai = sukurtiResursuKruva();
  const url = testDatabaseUrl(suffix);
  const dbName = new URL(url).pathname.slice(1);

  const admin = stebetiPoola(new Pool({ connectionString: adminDatabaseUrl() }), {
    vardas: "admin",
    dsn: adminDatabaseUrl(),
  });
  try {
    /**
     * ⚠️ BAZĖS DDL — NE PER `fikturosDdl()`, IR TAI NE PRALEIDIMAS.
     *
     * `fikturosDdl()` vynioja sakinius į `BEGIN`/`COMMIT`, kad `SET LOCAL
     * lock_timeout` galiotų, o bazės kūrimas/šalinimas transakcijos bloke
     * krenta („cannot run inside a transaction block"). Riba ten ir
     * nereikalinga: užraktas imamas ne ant lentelės. #380 D8 sargo šablonas
     * bazės sakinių neapima sąmoningai — jis vardija `DROP INDEX`,
     * `CREATE INDEX`, `ALTER TABLE`, lentelės valymą ir `LOCK TABLE`.
     *
     * Pool'as vis tiek apgaubtas: nutekėjęs klientas liktų stebimas.
     */
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await uzdarytiPoola(admin);
  }

  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = stebetiPoola(new Pool({ connectionString: url }), { vardas: "darbinis", dsn: url });
  resursai.registruotiPoola(pool, { vardas: "darbinis pool" });

  return { url, pool, resursai };
}

/** Lentelės valymas per autoritetą — žr. importo komentarą (#380 D8). */
async function isvalytiAudita(pool) {
  await fikturosDdl(pool, "audit_log", "TRUNCATE audit_log");
}

/**
 * RIBOTAS LAUKIMAS.
 *
 * ⚠️ KODĖL JO REIKIA. Audito rašymas yra `await`intas, bet `_runInline()`
 * grąžinto Promise nelaiko niekas kitas, o `rasytiAudita` neblokuojančiame
 * kelyje gedimą paverčia stebimu, ne lemtingu. Todėl eilutės gali atsirasti
 * šiek tiek vėliau nei grįžta kvietimas.
 *
 * ⚠️ RIBA YRA DALIS SUTARTIES: pasibaigus laikui grąžinamas `null`, ir kvietėjas
 * privalo tai paversti KRITIMU — tyli `null` reikšmė reikštų testą, kuris
 * nieko netikrina.
 */
async function palaukti(kolKas, ribaMs = 15000, zingsnis = 250) {
  const terminas = Date.now() + ribaMs;
  for (;;) {
    const r = await kolKas();
    if (r) return r;
    if (Date.now() > terminas) return null;
    await new Promise((x) => setTimeout(x, zingsnis));
  }
}

/** Visos `audit_log` eilutės kaip neapdorotas tekstas — jokio aplikacijos sluoksnio. */
async function visosEilutes(pool) {
  const { rows } = await pool.query("SELECT to_jsonb(a)::text AS visa FROM audit_log a ORDER BY a.id");
  return rows.map((r) => r.visa);
}

function patvirtintiBeIdentity(eilutes, reiksmes, kelias) {
  assert.ok(eilutes.length > 0, `${kelias}: eilučių turi būti — kitaip testas nieko netikrina`);
  for (const eilute of eilutes) {
    for (const reiksme of reiksmes) {
      assert.ok(
        !eilute.includes(reiksme),
        `${kelias}: RAW eilutėje rasta fikstūros identifikuojanti reikšmė "${reiksme}"\n${eilute}`
      );
    }
  }
}

test("#246 RAW: keturi keliai atskirai, be identifikuojančių reikšmių", { skip: SKIP }, async (t) => {
  const { url, pool, resursai } = await paruostiDb("identity_raw");
  t.after(async () => {
    await auditStore.shutdown();
    await resursai.isvalyti();
  });

  await auditStore.shutdown();
  await auditStore.init({ ...process.env, AUDIT_BACKEND: "postgres", DATABASE_URL: url });

  const reiksmes = uzdraustosReiksmes();

  await t.test("(1) SĖKMINGAS prisijungimas", async () => {
    await isvalytiAudita(pool);
    const atsakymas = await request(app)
      .post("/api/auth/login")
      .send({ username: OPERATORIUS.username, password: SLAPTAS });
    assert.equal(atsakymas.status, 200, "prisijungimas turi pavykti — kitaip tikrinam ne tą kelią");

    const eilutes = await visosEilutes(pool);
    patvirtintiBeIdentity(eilutes, reiksmes, "LOGIN_SUCCESS");
    assert.ok(
      eilutes.some((e) => e.includes("role=operator")),
      "rolė PRIVALO išlikti — diagnostika neprarandama (#246 §0.3)"
    );
  });

  await t.test("(2) NESĖKMINGAS prisijungimas", async () => {
    await isvalytiAudita(pool);
    const atsakymas = await request(app)
      .post("/api/auth/login")
      .send({ username: OPERATORIUS.username, password: "neteisingas-slaptas-9" });
    assert.equal(atsakymas.status, 401);

    const eilutes = await visosEilutes(pool);
    patvirtintiBeIdentity(eilutes, reiksmes, "LOGIN_FAILED");
    assert.ok(
      eilutes.some((e) => e.includes("invalid_credentials")),
      "`outcome` privalo išlikti — jis nešioja diagnostiką vietoj `details`"
    );
    /** ⚠️ `:60` ŠAKOJE `details` NETURI BŪTI VISAI (#246 §0.3). */
    assert.ok(
      !eilutes.some((e) => e.includes('"details"')),
      "neteisingų kredencialų šakoje `details` neturi būti: `identity` neegzistuoja, tad rolė būtų fabrikuota"
    );
  });

  await t.test("(3) SESIJA autentifikuotas veiksmas", async () => {
    const prisijungimas = await request(app)
      .post("/api/auth/login")
      .send({ username: OPERATORIUS.username, password: SLAPTAS });
    const cookie = prisijungimas.headers["set-cookie"];
    assert.ok(cookie, "sesijos cookie privalo būti");

    await isvalytiAudita(pool);

    /**
     * Pasirinktas kelias — leidimo ATMETIMAS: `operator` rolė neturi
     * `backup:restore`, tad `middleware/authorize.js` rašo audito eilutę
     * SESIJOS kontekste. Būtent tas kelias (`resolveIdentity` → `req.authz`)
     * ir buvo antrasis propagacijos kanalas.
     */
    const atsakymas = await request(app).post("/api/admin/backups/restore").set("Cookie", cookie);
    assert.ok([400, 403].includes(atsakymas.status), `laukta 403/400, gauta ${atsakymas.status}`);

    const eilutes = await visosEilutes(pool);
    patvirtintiBeIdentity(eilutes, reiksmes, "sesijos veiksmas");
  });

  await t.test("(4) API RAKTO veiksmas, FALLBACK kelias — kontrolė dviem kryptimis (D2)", async () => {
    /**
     * ⚠️ ŠIS KELIAS ĮRODO TIK FALLBACK'Ą. Atmesta užklausa audituojama
     * `middleware/authorize.js` BE aiškaus `actor`, tad `auditLog.js`
     * `?? getActor()` paima atspaudą. Leidžiamuose maršrutuose taip NĖRA —
     * žr. (5).
     */
    await isvalytiAudita(pool);

    const atsakymas = await request(app)
      .post("/api/admin/backups/restore")
      .set("X-API-Key", process.env.API_KEY);
    assert.ok([400, 403, 503].includes(atsakymas.status), `gauta ${atsakymas.status}`);

    const eilutes = await visosEilutes(pool);

    /** Kryptis A: asmens identifikatorių nėra. */
    patvirtintiBeIdentity(eilutes, reiksmes, "API rakto veiksmas");

    /**
     * ⚠️ Kryptis B: rakto ATSPAUDAS turi išlikti NEPAKITĘS (D2).
     *
     * Be šios pusės testas praeitų ir tada, kai #246 pakeitimas tyliai
     * sulaužytų API rakto kelią — t. y. „nieko nėra" atrodytų kaip sėkmė.
     */
    const atspaudas = actorFingerprint(process.env.API_KEY);
    assert.match(atspaudas, /^key_[0-9a-f]{12}$/, "atspaudo forma pakito");
    assert.ok(
      eilutes.some((e) => e.includes(atspaudas)),
      `API rakto fallback kelyje atspaudas ${atspaudas} PRIVALO būti audite (D2) — rasta eilučių: ${eilutes.length}`
    );
  });

  await t.test("(5) API RAKTO LEIDŽIAMAS maršrutas — `actor` yra literalas, NE atspaudas", async () => {
    /**
     * ⚠️ ŠIS KELIAS EGZISTUOJA DĖL CODEX P2.
     *
     * Dokumentacijos eilutė „API raktas → `actorFingerprint`" buvo NEĮRODYTA ir
     * leidžiamuose maršrutuose NETEISINGA: `middleware/authorize.js`
     * `resolveIdentity()` API raktui grąžina LITERALĄ `"api-key"`, o
     * `routes/jobs.js`, `transcribeJobs.js` ir `backup.js` perduoda
     * `req.authz.actor` EKSPLICITIŠKAI — tad `?? getActor()` fallback'o, kuriame
     * gyvena atspaudas, jie nepasiekia.
     *
     * ⚠️ IR TAI PRIIMTA SĄMONINGAI, NE PRALEIDIMAS. Sistema turi VIENĄ
     * `API_KEY` (ankstesnio rakto mechanizmas yra kopijų šifravimui,
     * `backupEncryption.js`), tad `actorFingerprint(configuredKey)` yra
     * KONSTANTA: leidžiamuose maršrutuose jis neatskirtų nieko, ko neatskiria
     * `"api-key"`. D2 reikalauja, kad `actor` nebūtų neapdorotas raktas —
     * literalas tą tenkina net stipriau, nes iš paslapties apskritai neišvestas.
     * ❌ Atspaudo propagavimas per `resolveIdentity()` būtų DAUGIAU duomenų
     * audite be išmatuotos naudos, o #246 kryptis yra mažiausias identifikatorių
     * skaičius.
     */
    const senaRole = process.env.API_KEY_ROLE;
    try {
      /** `operator` neturi `job:delete`; leidžiamam maršrutui reikia aukštesnės rolės. */
      process.env.API_KEY_ROLE = "administrator";

      const sukurtas = await request(app)
        .post("/api/jobs")
        .set("X-API-Key", process.env.API_KEY)
        .send({ transcript: "pakankamai ilgas testinis tekstas protokolui generuoti" });
      assert.ok([200, 201, 202].includes(sukurtas.status), `job'o sukūrimas: gauta ${sukurtas.status}`);
      const jobId = sukurtas.body && (sukurtas.body.jobId || sukurtas.body.id);
      assert.ok(jobId, "job ID privalo būti — kitaip tikrinam ne tą kelią");

      /**
       * ⚠️ TERMINALI BŪSENA NUSTATOMA PER SAUGYKLĄ, NE PER VYKDYMĄ.
       *
       * Vykdomo jobo trynimas grąžina `409`, o `jobRunner.init()` šiame testų
       * procese nekviečiamas, tad maršruto `setImmediate` vykdymas iki galo
       * neįvyksta ir jobas savaime terminalios būsenos nepasiekia. Abi
       * ankstesnės redakcijos dėl to krito (`409`, paskui „privalo pasiekti
       * terminalią būseną").
       *
       * Šiam keliui vykdymas NEREIKALINGAS: tikrinama, kas atsiranda audite,
       * kai LEIDŽIAMAS API rakto maršrutas perduoda `req.authz.actor`
       * eksplicitiškai. Būsena yra tik prielaida, kad trynimas būtų priimtas.
       */
      const jobStore = require("../utils/jobStore");
      await jobStore.system.finishFailed(jobId, { error: "testinė terminali būsena", error_code: "TEST" });
      const baigtas = await jobStore.system.get(jobId, { hydrate: false });
      assert.equal(baigtas.status, "failed", "prielaida: jobas terminalus");

      await isvalytiAudita(pool);

      const istrintas = await request(app)
        .delete(`/api/jobs/${jobId}`)
        .set("X-API-Key", process.env.API_KEY);
      assert.ok([200, 202, 204].includes(istrintas.status), `ištrynimas: gauta ${istrintas.status}`);

      const eilutes = await visosEilutes(pool);

      /** Kryptis A: asmens identifikatorių nėra. */
      patvirtintiBeIdentity(eilutes, uzdraustosReiksmes(), "API rakto leidžiamas maršrutas");

      /** Kryptis B: `actor` yra būtent literalas — tai ir yra įrodoma garantija. */
      /**
       * ⚠️ TARPUI TOLERANTIŠKAS ŠABLONAS. PostgreSQL `jsonb` tekstinė forma
       * rašo `"actor": "api-key"` SU tarpu po dvitaškio, tad pažodinis
       * `"actor":"api-key"` neatitinka. Pirmoji redakcija dėl to krito su
       * „rasta eilučių: 2" — eilutės BUVO, tik šablonas netiko.
       */
      assert.ok(
        eilutes.some((e) => /"actor"\s*:\s*"api-key"/.test(e)),
        `leidžiamame maršrute \`actor\` privalo būti literalas "api-key" — rasta eilučių: ${eilutes.length}`
      );

      /**
       * ⚠️ ATSPAUDAS ČIA IRGI YRA — IR TAI IŠTAISO MANO P2 ATSAKYMĄ.
       *
       * Pirmoji šio testo redakcija tvirtino, kad leidžiamame maršrute atspaudo
       * NĖRA. CI parodė, kad yra: vienoje užklausoje atsiranda ABI formos, nes
       * `lifecycleService` rašo `LIFECYCLE_DELETION` su EKSPLICITINIU
       * `actor: "api-key"`, o `jobErasure` kvito ir audio eilutės `actor`
       * neperduoda ir pataiko į `?? getActor()` fallback'ą.
       *
       * ⚠️ VADINASI SKIRSTYMAS NE PAGAL MARŠRUTO LEIDIMĄ, O PAGAL KVIETIMO
       * VIETĄ: eilutė, kurios `rasytiAudita()` kvietimas perduoda `actor`
       * eksplicitiškai, gauna literalą; eilutė, kuri neperduoda, gauna
       * atspaudą. Dokumentacija pataisyta pagal tai.
       *
       * Abi reikšmės nėra asmens duomenys, ir abi tenkina D2 — bet teiginys
       * privalo atitikti tai, kas realiai įrašoma.
       */
      const atspaudasLeidziamame = actorFingerprint(process.env.API_KEY);
      assert.ok(
        eilutes.some((e) => e.includes(atspaudasLeidziamame)),
        "fallback eilutės atspaudą TURI — jei nebeturi, dokumentacijos eilutę reikia perrašyti"
      );
    } finally {
      if (senaRole === undefined) delete process.env.API_KEY_ROLE;
      else process.env.API_KEY_ROLE = senaRole;
    }
  });

});
