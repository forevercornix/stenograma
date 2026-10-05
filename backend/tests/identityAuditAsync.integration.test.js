const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { sukurtiResursuKruva, stebetiPoola, uzdarytiPoola } = require("./helpers/resourceStack");
const { hashPassword, loadUsers } = require("../utils/credentials");

/**
 * #246 Codex P1 — ASINCHRONINIS SESIJOS DARBAS: AUDITO AKTORIAUS NĖRA.
 *
 * ⚠️ ATSKIRAS FAILAS, IR TAI NE PATOGUMAS. Bandžiau tai kaip
 * `identityAuditRaw.integration` subtestą; (1)–(5) praeidavo, o šis krisdavo su
 * „relation `audit_log` does not exist" — bendra proceso būsena (audito
 * saugyklos singleton, `process.env` mutacijos tarp subtestų, maršruto
 * automatinis vykdymas) susikirsdavo. Atskiras procesas tą pašalina iš
 * principo, o ne euristika.
 *
 * ⚠️ KĄ TIKRINA. `routes/jobs.js` `jobActor()` įrašo `jobs.actor = req.user.id`
 * (#158 userId), o `queues/jobRunner.js` tą reikšmę įdėdavo į užklausos
 * kontekstą — iš kur `auditLog.js` `?? getActor()` ją persistindavo KIEKVIENU
 * vykdymo metu įvykusiu rašymu. Sinchroniniai testai to nepagaudavo, nes
 * vykdymas vyksta po atsakymo. Būtent todėl spraga ir praėjo.
 *
 * ⚠️ GRANDINĖ TIKRINAMA DVIEM PUSĖMIS, IR ANTROJI YRA SEAM'AS, NE END-TO-END.
 *
 * (A) MARŠRUTAS — pilnas produkcinis kelias: sesijos keliu sukurtas jobas
 *     realiai turi `actor = userId` ir `actorSource = "session"`. Tai defekto
 *     ĮVESTIS, ir ji tikrinama be jokių dublių.
 * (B) KONTEKSTAS — RAW įrašas, parašytas `runWithContext()` viduje su
 *     `auditoAktoriusIsJobo(job)` iš TO PAČIO jobo įrašo, tada nuskaitytas per
 *     `SELECT to_jsonb(a)::text`. Tikrinama, kad į `audit_log` nepateko nei
 *     `userId`, nei vardas.
 *
 * ⚠️ KODĖL (B) YRA SEAM'AS — IR KODĖL ANKSTESNIS PAAIŠKINIMAS BUVO KLAIDINGAS.
 *
 * Aštuoni CI raundai rodė „nulis audito eilučių po vykdymo", ir buvau užrašęs,
 * kad šis CI žingsnis vykdymo audito duoti NEGALI. Tai buvo neteisinga.
 * Tikroji priežastis: testinis procesorius rašė įvykį `PROTOCOL_GENERATED`,
 * kurio `utils/auditEvents.js` NEKLASIFIKUOJA, tad `rasytiAudita()` teisingai
 * metė `MalformedAuditEventError`, o `_paleistiInline()` jį logguodavo (ne
 * nurijo) — ir testas matydavo tik simptomą.
 *
 * ⚠️ Pamoka tiksli: aštuonis kartus taisiau PRIEŽASTIS to paties simptomo,
 * nė karto nepatikrinęs savo paties įvesties. Įvykio vardas yra prielaida, ir
 * ji buvo falsifikuojama pirmą minutę.
 *
 * (B) lieka seam'u sąmoningai: jis naudoja TĄ PAČIĄ išraišką, kurią naudoja
 * visi trys produkciniai keliai, ir yra deterministinis — be `setImmediate`
 * lenktynių ir be priklausomybės nuo to, kuris procesorius užregistruotas.
 *
 * ⚠️ APIMTIS: INLINE kelias. Worker ir nesėkmės tvarkymo keliai naudoja TĄ PATĮ
 * `auditoAktoriusIsJobo()` sprendimą, bet jiems reikėtų BullMQ, tad jų įrodymas
 * yra struktūrinis (`identityAuditSargas` I4) plius to pagalbininko elgsenos
 * testai. Žalias šis failas NĖRA visų trijų kelių garantija.
 */

const SKIP = skipWithoutPostgres();

const SLAPTAS = "teisingas-slaptas-1";
const OPERATORIUS = {
  username: "asyncoperatorius",
  userId: "66666666-6666-4666-8666-666666666666",
};

process.env.AUTH_USERS = `${OPERATORIUS.username}:operator:${hashPassword(SLAPTAS)}:${OPERATORIUS.userId}`;
process.env.AUDIT_ID_SALT = "async-testine-druska-nera-produkcine";
process.env.AUDIT_ID_SALT_ID = "async-2026-10";
process.env.PRIVACY_MODE = "false";

/**
 * ⚠️ PG REIKIA TIK AUDITUI. `jobStore` ir ištrynimo žymos lieka atmintyje:
 * priešingu atveju jų fail-closed barjerai teisingai krenta nemigruotoje bazėje
 * („relation `erasure_marks` does not exist"). Tvarka svarbi — `postgresGuard`
 * `DATABASE_URL` nusiskaito modulio įkėlimo metu, tad šalinti galima tik po jo.
 */
delete process.env.DATABASE_URL;
process.env.JOB_STORE_BACKEND = "memory";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests();
const auditStore = require("../utils/auditStore");
const jobStore = require("../utils/jobStore");
const { rasytiAudita } = require("../utils/auditWrite");

/** Uždraustos reikšmės — išvedamos iš `credentials.js` schemos; `role` išskirtas. */
function uzdraustosReiksmes() {
  const [vartotojas] = [...loadUsers(process.env).values()];
  const reiksmes = Object.entries(vartotojas)
    .filter(([laukas]) => laukas !== "role")
    .map(([, reiksme]) => reiksme)
    .filter((r) => typeof r === "string" && r.length > 0);
  assert.ok(reiksmes.includes(OPERATORIUS.userId), "fikstūros userId privalo būti aibėje");
  assert.ok(!reiksmes.includes("operator"), "rolė NETURI būti aibėje");
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
    /** Bazės DDL — ne transakcijoje; žr. `identityAuditRaw.integration` paaiškinimą. */
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

/** Visos `audit_log` eilutės kaip neapdorotas tekstas — be aplikacijos sluoksnio. */
async function visosEilutes(pool) {
  const { rows } = await pool.query("SELECT to_jsonb(a)::text AS visa FROM audit_log a ORDER BY a.id");
  return rows.map((r) => r.visa);
}

/**
 * RIBOTAS LAUKIMAS. Pasibaigus laikui grąžinamas `null`, ir kvietėjas PRIVALO
 * tai paversti kritimu — tyli `null` reikšmė reikštų testą, kuris nieko
 * netikrina.
 */
async function palaukti(kolKas, ribaMs = 20000, zingsnis = 250) {
  const terminas = Date.now() + ribaMs;
  for (;;) {
    const r = await kolKas();
    if (r) return r;
    if (Date.now() > terminas) return null;
    await new Promise((x) => setTimeout(x, zingsnis));
  }
}

test("#246 P1: sesijos keliu sukurto jobo VYKDYMAS audite neatspaudžia identity", { skip: SKIP }, async (t) => {
  const { url, pool, resursai } = await paruostiDb("identity_async");
  t.after(async () => {
    await auditStore.shutdown();
    await resursai.isvalyti();
  });

  await auditStore.shutdown();
  await auditStore.init({ ...process.env, AUDIT_BACKEND: "postgres", DATABASE_URL: url });

  const prisijungimas = await request(app)
    .post("/api/auth/login")
    .send({ username: OPERATORIUS.username, password: SLAPTAS });
  assert.equal(prisijungimas.status, 200, "prisijungimas turi pavykti");
  const cookie = prisijungimas.headers["set-cookie"];
  assert.ok(cookie, "sesijos cookie privalo būti");

  const sukurtas = await request(app)
    .post("/api/jobs")
    .set("Cookie", cookie)
    .send({ transcript: "pakankamai ilgas testinis tekstas protokolui generuoti" });
  assert.ok([200, 201, 202].includes(sukurtas.status), `job'o sukūrimas: gauta ${sukurtas.status}`);
  const jobId = sukurtas.body && (sukurtas.body.jobId || sukurtas.body.id);
  assert.ok(jobId, "job ID privalo būti");

  /** ⚠️ PRIELAIDA, KURIĄ TIKRINAM: įrašas TURI sesijos tapatybę, ir ji LIEKA. */
  const jobas = await jobStore.system.get(jobId, { hydrate: false });
  assert.equal(jobas.actorSource, "session", "prielaida: jobas sukurtas sesijos keliu");
  assert.equal(jobas.actor, OPERATORIUS.userId, "`jobs.actor` yra userId — jis LIEKA autorizacijai (#18 PR3)");

  /**
   * (B) RAW ĮRAŠAS PRODUKCINIAME KONTEKSTE.
   *
   * ⚠️ `runWithContext` kviečiamas su TA PAČIA išraiška, kurią naudoja visi
   * trys produkciniai keliai — `auditoAktoriusIsJobo(job)` iš tikro jobo
   * įrašo. Jei ta išraiška grąžintų `userId`, `auditLog.js` `?? getActor()`
   * jį čia ir persistintų, o žemiau esantis tvirtinimas kristų.
   *
   * ⚠️ Kad šito susiejimo su realiais kvietimais neliktų tik komentare, jį
   * atskirai vykdo `identityAuditSargas` I4 sargas.
   */
  const { runWithContext, auditoAktoriusIsJobo } = require("../utils/requestContext");

  const poSukurimo = (await visosEilutes(pool)).length;

  await runWithContext({ requestId: jobas.requestId || null, actor: auditoAktoriusIsJobo(jobas), execution: "inline" }, () =>
    rasytiAudita({ event: "PROTOCOL_COMPLETED", success: true, outcome: "test_seam" })
  );

  const eilutes = await palaukti(async () => {
    const visos = await visosEilutes(pool);
    return visos.length > poSukurimo ? visos : null;
  });
  assert.ok(eilutes, `RAW eilutė privalo atsirasti (po sukūrimo buvo ${poSukurimo})`);

  /** ⚠️ KONTROLĖ: tikrinam, kad tikrai skaitom TĄ įrašą, o ne tik senas eilutes. */
  assert.ok(
    eilutes.some((e) => e.includes("PROTOCOL_COMPLETED")),
    "parašyta eilutė privalo būti tarp nuskaitytų"
  );

  const reiksmes = uzdraustosReiksmes();
  for (const eilute of eilutes) {
    for (const reiksme of reiksmes) {
      assert.ok(
        !eilute.includes(reiksme),
        `RAW eilutėje rasta identifikuojanti reikšmė "${reiksme}"\n${eilute}`
      );
    }
  }
});
