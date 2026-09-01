/**
 * PostgreSQL JUNGTIES NUSTATYMAI — VIENAS IŠSPRĘSTAS ŠALTINIS (#155, 7.4e / #216).
 *
 * ⚠️ KODĖL ATSKIRAS, NEUTRALUS MODULIS.
 *
 * 7.4e barjeras skaito `erasure_marks` audito jungtimi (`assertNotBarredWithClient`),
 * o žymas rašo `deletionTombstones` savo pool'u. Jei tie du pool'ai atsidurtų
 * SKIRTINGOSE bazėse, barjeras skaitytų tuščią lentelę ir VISADA praleistų — tyliai.
 *
 * Tai nebuvo teorija. Iki 7.4e atranka skyrėsi:
 *
 *   `auditStore/backendSelection.js`  - `AUDIT_BACKEND=postgres` priima `DATABASE_URL`
 *                                       ARBA `PGHOST` (abu kartu - startas krinta);
 *   `deletionTombstones/index.js`     - postgres TIK su `DATABASE_URL`.
 *
 * Dokumentuotame Compose diegime (`PG*`, be `DATABASE_URL`) tai reiškė auditą
 * PostgreSQL'e ir žymas ATMINTYJE. Suderinamumo patikra to neišspręstų: ji
 * reikalautų `DATABASE_URL`, o jį pridėjus kristų `PGHOST` konfliktas — aklavietė.
 *
 * ⚠️ TAPATUMAS PAGAL KONSTRUKCIJĄ, NE PAGAL PALYGINIMĄ. Abu pool'ai statomi iš
 * ŠIOS funkcijos, tad jie negali rodyti į skirtingas bazes. Vykdymo meto zondas
 * (`current_database()`) lieka TRIPWIRE (AGENTS.md §9.2), ne mechanizmas:
 * `inet_server_addr()` per unix socket grąžina `NULL`, tad du klasteriai tame
 * pačiame hoste su vienodu bazės vardu palyginime sutaptų.
 */

/**
 * ⚠️ `connectionString` TIK KAI `DATABASE_URL` REALIAI YRA.
 *
 * Dokumentuotas Compose diegimas perduoda `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/
 * `PGDATABASE`, o ne URL — sąmoningai, nes slaptažodis su URI simboliais
 * (`/`, `?`, `#`, `@`) URL'e reikštų kitką.
 *
 * ⚠️ `PG*` PERSIUNČIAMI EKSPLICITIŠKAI, NE PALIEKAMI `pg` NUOŽIŪRAI.
 *
 * `pg` juos skaito iš `process.env`, o `init(env)` priima konfigūraciją kaip
 * OBJEKTĄ. Įterptinis kvietėjas, perdavęs `PGHOST` tik objekte, atranką praeitų
 * (ji žiūri į tą patį objektą), o pool'as jungtųsi prie GLOBALIOS aplinkos
 * nurodytos — arba numatytosios — bazės. Antrasis skaitytojas čia yra ne mūsų
 * kodas, o pati biblioteka, tad `process.env` tripwire jos nepagauna.
 */
const PG_ATITIKMENYS = Object.freeze({
  PGHOST: "host",
  PGPORT: "port",
  PGUSER: "user",
  PGPASSWORD: "password",
  PGDATABASE: "database",
});

/** Ar ši konfigūracija apskritai nurodo PostgreSQL? */
function arNurodytaPostgres(env = process.env) {
  return Boolean(env.DATABASE_URL || env.PGHOST);
}

/**
 * `{ connectionString }` arba `{ host, port, user, password, database }`.
 *
 * Persiunčiama TIK viena forma: kartu su `connectionString` `pg` taikytų abi, ir
 * pirmenybė taptų neakivaizdi.
 */
function pgJungtiesNustatymai(env = process.env) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };

  const nustatymai = {};
  for (const [envRaktas, poolRaktas] of Object.entries(PG_ATITIKMENYS)) {
    if (env[envRaktas] !== undefined) {
      nustatymai[poolRaktas] = poolRaktas === "port" ? Number(env[envRaktas]) : env[envRaktas];
    }
  }
  return nustatymai;
}

/**
 * TRIPWIRE: ar dvi jungtys realiai rodo į tą pačią bazę?
 *
 * ⚠️ NE KOREKTIŠKUMO MECHANIZMAS — žr. failo viršų. Grąžina `{ sutampa, a, b }`,
 * kad kvietėjas galėtų pranešti KONKREČIAI, kas nesutapo.
 */
async function tapatiBaze(klientasA, klientasB) {
  const uzklausa = "SELECT current_database() AS db, inet_server_port() AS port";

  const [a, b] = await Promise.all([klientasA.query(uzklausa), klientasB.query(uzklausa)]);
  const x = a.rows[0];
  const y = b.rows[0];

  return {
    sutampa: x.db === y.db && String(x.port) === String(y.port),
    a: `${x.db}:${x.port}`,
    b: `${y.db}:${y.port}`,
  };
}

module.exports = { pgJungtiesNustatymai, arNurodytaPostgres, tapatiBaze, PG_ATITIKMENYS };
