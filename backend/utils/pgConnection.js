const { parse: parseDsn } = require("pg-connection-string");

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
 * JUNGTIES TAPATYBĖ IŠ NUSTATYMŲ: `{ host, port, database }` arba `null`.
 *
 * ⚠️ VIENAS AUTORITETAS DVIEM KELIAMS (#249, 7.6b). 7.6a `pgDumpBackup.js`
 * turėjo savo kopiją šios logikos; antras darbas, kuriam reikia to paties
 * klausimo („ar tai TA PATI bazė?"), reikštų dvi tiesas apie tapatumą, ir jos
 * ilgainiui išsiskirtų. Palyginimo semantika gyvena ČIA - ten pat, kur jau
 * užrašyta jos riba (žr. `tapatiBaze()`): du klasteriai tame pačiame hoste su
 * vienodu bazės vardu palyginime SUTAMPA.
 */
function jungtiesTapatybe(nustatymai, env = process.env) {
  if (!nustatymai) return null;

  if (nustatymai.connectionString) {
    /**
     * ⚠️ DSN PARSINAMAS TA PAČIA BIBLIOTEKA, KURIĄ NAUDOJA `pg` (#280 peržiūra).
     *
     * `new URL()` mato tik autoritetą, o `pg-connection-string` query parametrams
     * (`?host=`, `?port=`) suteikia PIRMENYBĘ prieš jį:
     *
     *   postgres://u:x@db.prod:5432/s?host=/restore  ->  host = "/restore"
     *
     * Vadinasi du DSN, besiskiriantys TIK `?host=`, `new URL()` palyginime
     * SUTAMPA, o `pg` jungiasi į skirtingus endpoint'us. 7.6b atveju pasekmė yra
     * blogiausia įmanoma: sutampantis verdiktas ir jungtis į produkcinę bazę
     * reiškia revokuotas sesijas ir terminalizuotus job'us NE atkurtoje kopijoje.
     *
     * ⚠️ DRAUDIMŲ SĄRAŠAS („atmesti DSN su endpoint keičiančiais parametrais")
     * ATMESTAS: jį reikėtų laikyti sinchroniškai su tuo, ką palaiko `pg`, ir
     * pirmas naujas parametras vėl atvertų plyšį TYLIAI. Tas pats parseris duoda
     * tapatumą pagal konstrukciją, ne pagal sąrašo priežiūrą.
     */
    /**
     * ⚠️ TRŪKSTAMI LAUKAI IMAMI IŠ `PG*`, NE IŠ SAVO NUMATYTŲJŲ (#280, II raundas).
     *
     * `pg` prie DSN pritaiko aplinkos fallback'ą. Išmatuota
     * (`pg/lib/connection-parameters`):
     *
     *   postgres://u@host/db      + PGPORT=6543  ->  host:6543/db
     *   postgres://u@host:5432/db + PGPORT=6543  ->  host:5432/db   (eksplicitinis laimi)
     *   postgres:///db            + PGHOST=env-h ->  env-h:5432/db
     *   postgres://vartotojas@host/               ->  host:5432/vartotojas
     *
     * Savarankiškas `|| "5432"` reiškė, kad `--target …:5432/db` ir
     * `DATABASE_URL=…/db` su `PGPORT=6543` palyginime SUTAMPA, o `_pool()`
     * jungiasi į 6543 — vėl dvi DSN interpretacijos, tik per aplinką.
     *
     * ⚠️ EILIŠKUMAS ATKARTOTAS SĄMONINGAI, IR JIS TIKRINAMAS. Vykdymo metu
     * nesiremiama `pg` vidiniu moduliu (`pg/lib/…` yra ne viešas kelias), bet
     * `pgConnectionIdentity` testas lygina ŠIĄ funkciją su tikru
     * `connection-parameters` rezultatu — jei `pg` eiliškumą pakeis, testas
     * krinta garsiai, o ne tapatumas ima tylėti.
     */
    try {
      const parsed = parseDsn(nustatymai.connectionString);

      const host = String(parsed.host || env.PGHOST || "localhost").trim();
      const port = String(parsed.port || env.PGPORT || "5432");
      const database = String(parsed.database || env.PGDATABASE || parsed.user || env.PGUSER || "");

      if (!host || !database) return null;

      return { host: host.toLowerCase(), port, database };
    } catch {
      return null;
    }
  }

  if (!nustatymai.host && !nustatymai.database) return null;

  return {
    host: String(nustatymai.host || "").toLowerCase(),
    port: String(nustatymai.port || "5432"),
    database: String(nustatymai.database || ""),
  };
}

/** Skaitoma forma klaidos žinutėje - BE kredencialų. */
function tapatybesTekstas(tapatybe) {
  return tapatybe ? `${tapatybe.host}:${tapatybe.port}/${tapatybe.database}` : "<neatpažinta>";
}

/**
 * Ar nurodytas URL rodo į TĄ PAČIĄ bazę, kurią naudotų šios aplinkos saugyklos?
 *
 * ⚠️ PALYGINIMAS PAGAL KONSTRUKCIJĄ, ne per vykdymo meto zondą - tai ta pati
 * riba, kurią aprašo šio failo antraštė. Neatpažinta forma reiškia NESUTAPIMĄ
 * (fail-closed), o ne „tikriausiai gerai".
 */
function arTaPatiBaze(url, env = process.env) {
  /**
   * ⚠️ TA PATI APLINKA ABIEM PUSĖM. Operatorius `--target` rašo tame pačiame
   * shell'e, kuriame gyvena `PG*`, tad ir jo DSN `pg` interpretuotų su tais
   * pačiais fallback'ais. Skirtingas eiliškumas dviem pusėms būtų trečia
   * interpretacija.
   */
  const konfiguracija = jungtiesTapatybe(pgJungtiesNustatymai(env), env);
  const nurodyta = jungtiesTapatybe({ connectionString: url }, env);

  const sutampa =
    konfiguracija !== null &&
    nurodyta !== null &&
    konfiguracija.host === nurodyta.host &&
    konfiguracija.port === nurodyta.port &&
    konfiguracija.database === nurodyta.database;

  return { sutampa, nurodyta, konfiguracija };
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

module.exports = {
  pgJungtiesNustatymai,
  arNurodytaPostgres,
  tapatiBaze,
  jungtiesTapatybe,
  tapatybesTekstas,
  arTaPatiBaze,
  PG_ATITIKMENYS,
};
