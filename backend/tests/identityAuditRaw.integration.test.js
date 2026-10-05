const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
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

const request = require("supertest");
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
  const url = testDatabaseUrl(suffix);
  const dbName = new URL(url).pathname.slice(1);

  const admin = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { url, pool: new Pool({ connectionString: url }) };
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
  const { url, pool } = await paruostiDb("identity_raw");
  t.after(async () => {
    await auditStore.shutdown();
    await pool.end();
  });

  await auditStore.shutdown();
  await auditStore.init({ ...process.env, AUDIT_BACKEND: "postgres", DATABASE_URL: url });

  const app = require("../server");
  app._setReadyForTests();
  const reiksmes = uzdraustosReiksmes();

  await t.test("(1) SĖKMINGAS prisijungimas", async () => {
    await pool.query("TRUNCATE audit_log");
    const atsakymas = await request(app)
      .post("/auth/login")
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
    await pool.query("TRUNCATE audit_log");
    const atsakymas = await request(app)
      .post("/auth/login")
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
      .post("/auth/login")
      .send({ username: OPERATORIUS.username, password: SLAPTAS });
    const cookie = prisijungimas.headers["set-cookie"];
    assert.ok(cookie, "sesijos cookie privalo būti");

    await pool.query("TRUNCATE audit_log");

    /**
     * Pasirinktas kelias — leidimo ATMETIMAS: `operator` rolė neturi
     * `backup:restore`, tad `middleware/authorize.js` rašo audito eilutę
     * SESIJOS kontekste. Būtent tas kelias (`resolveIdentity` → `req.authz`)
     * ir buvo antrasis propagacijos kanalas.
     */
    const atsakymas = await request(app).post("/admin/backups/restore").set("Cookie", cookie);
    assert.ok([400, 403].includes(atsakymas.status), `laukta 403/400, gauta ${atsakymas.status}`);

    const eilutes = await visosEilutes(pool);
    patvirtintiBeIdentity(eilutes, reiksmes, "sesijos veiksmas");
  });

  await t.test("(4) API RAKTO veiksmas — kontrolė DVIEM kryptimis (D2)", async () => {
    await pool.query("TRUNCATE audit_log");

    const atsakymas = await request(app)
      .post("/admin/backups/restore")
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
      `API rakto kelyje atspaudas ${atspaudas} PRIVALO būti audite (D2) — rasta eilučių: ${eilutes.length}`
    );
  });
});
