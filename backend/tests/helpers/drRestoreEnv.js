const crypto = require("node:crypto");
const auditoLaukai = require("../../utils/auditStore/fields");

/**
 * 7.6c E2E APLINKA — VIENA, DVIEM KELIAMS (#155, #250).
 *
 * ⚠️ KODĖL ATSKIRAS HELPERIS, O NE EILUTĖS INTEGRACINIAME TESTE.
 *
 * Trys iš eilės CI raundai krito ne ties tikrinamu elgesiu, o ties APLINKA:
 *
 *   1. `AUDIT_ID_SALT` nenustatytas → `AUDIT_BACKEND=postgres` atsisako startuoti;
 *   2. sesijos kuriamos `{ id, role, username }`, ne `{ userId, ... }`;
 *   3. `BACKUP_ENCRYPTION_KEY` base64 formatu → `BACKUP_KEY_INVALID`
 *      (raktas privalo būti 64 hex simboliai — ta pati klaida kaip 7.6a).
 *
 * Kiekvienas raundas kainavo ~4 minutes CI ir atsakė į klausimą, kurį galima
 * užduoti VIETOJE per sekundes. Todėl aplinka gyvena čia ir naudojama DVIEM
 * keliais:
 *
 *   · `drRestorePreconditions` — vietoje, prieš NEPASIEKIAMĄ bazę: kiekvienas
 *     sargas privalo kristi dėl RYŠIO, ne dėl konfigūracijos;
 *   · `drRestore.integration`  — CI'uje, prieš tikrą PostgreSQL.
 *
 * Dvi kopijos ilgainiui išsiskirtų, ir vietinė patikra imtų ginti nebe tą
 * aplinką, kurią naudoja integracinis testas. Ta pati pamoka kaip
 * `postRestoreFixtures.js` (7.6b), tik apie aplinką, ne apie sėjimą.
 */

/**
 * ⚠️ `JOB_STORE_BACKEND=postgres` ČIA NENUSTATOMAS, IR TAI NE PRALEIDIMAS.
 *
 * 7.2a aktyvavimo barjeras jį verčia KLAIDA (`selectBackend` meta „dar
 * neleidžiamas"), o vien `DATABASE_URL` grąžina `memory | barjeras: true`.
 * Job'ai sėjami per tiesioginį `createPostgresStore(pool)`, o replay — per
 * koordinatoriaus nukreiptą saugyklą (#250, C sprendimas).
 */
function testoAplinka(url, papildomi = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: url,
    SESSION_STORE_BACKEND: "postgres",
    AUDIT_BACKEND: "postgres",
    /** Be jos pseudonimai skirtųsi tarp restartų, ir GDPR ištrynimas senų įrašų nerastų. */
    AUDIT_ID_SALT: crypto.randomBytes(32).toString("hex"),
    AUDIT_ID_SALT_ID: "2026-09",
    BACKUP_ENABLED: "true",
    /** ⚠️ HEX, NE base64: `BACKUP_KEY_INVALID` reikalauja 64 hex simbolių (7.6a). */
    BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    ...papildomi,
  };
}

/**
 * AUDITO LAUKO SQL IŠRAIŠKA — IŠVEDAMA IŠ AUTORITETO, NE SPĖJAMA.
 *
 * ⚠️ `outcome` NĖRA `audit_log` stulpelis: filtruojami laukai yra stulpeliai, o
 * visa kita gyvena `meta` JSONB (`auditStore/fields.js`). Tiesioginis
 * `SELECT outcome` CI'uje krito su `42703: column "outcome" does not exist` —
 * ta pati „prielaida apie `audit_log` schemą", kuri jau kainavo 7.6a raundą.
 *
 * Todėl išraiška imama iš TO PATIES sąrašo, kurį naudoja saugykla: sąrašui
 * pasikeitus, pasikeis ir užklausa, o nežinomas laukas KRENTA, ne tyliai virsta
 * neegzistuojančiu stulpeliu.
 */
function auditoLaukas(vardas) {
  if (auditoLaukai.STULPELIAI[vardas]) return auditoLaukai.STULPELIAI[vardas];
  if (auditoLaukai.META_LAUKAI.includes(vardas)) return `meta->>'${vardas}'`;

  throw new Error(
    `Nežinomas audito laukas "${vardas}": jo nėra nei stulpeliuose, nei \`META_LAUKAI\`. ` +
      "Sąrašas pasikeitė — užklausa privalo kristi, ne kreiptis į neegzistuojantį stulpelį."
  );
}

module.exports = { testoAplinka, auditoLaukas };
