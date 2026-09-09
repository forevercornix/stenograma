#!/usr/bin/env node
/**
 * `inline` → external MIGRACIJA — OPERATORIAUS ĮĖJIMAS (#157, PR-6).
 *
 * ⚠️ ŠIS FAILAS LOGIKOS NETURI IR NETURI TURĖTI.
 *
 * Visa procedūra gyvena `utils/artifactMigration.js`; čia tik argumentai,
 * saugyklos gyvavimo ciklas, išvestis ir exit kodai. Ta pati taisyklė kaip
 * `dr-restore.mjs`, `pg-backup.mjs` ir `post-restore-reconcile.mjs`: antras
 * orkestracijos egzempliorius operatoriaus kelyje reikštų, kad procedūra turi
 * dvi versijas, ir testuojama tik viena.
 *
 * NAUDOJIMAS
 *   node scripts/migrate-artifacts.mjs dry-run [--limit N]
 *   node scripts/migrate-artifacts.mjs run     [--limit N] [--retry-failed]
 *   node scripts/migrate-artifacts.mjs status
 *
 * APLINKA
 *   DATABASE_URL              privaloma
 *   ARTIFACT_STORE_BACKEND    privaloma `run` režimui: `fs` arba `s3`
 *
 * ⚠️ `inline` BACKEND'AS `run` REŽIME ATMETAMAS. Migracija į `inline` reikštų
 * perkėlimą į tą pačią vietą — tyliai nieko nedarantis paleidimas, po kurio
 * operatorius manytų, kad darbas atliktas.
 *
 * Exit kodai:
 *   0 sėkmė · 1 naudojimo klaida · 2 procedūros klaida (fail-closed)
 *   3 `run`: dalis eilučių NEPERKELTA — reikia operatoriaus peržiūros
 */
import pg from "pg";

import artifactMigration from "../utils/artifactMigration.js";
import artifactStore from "../utils/artifactStore/index.js";

const { Pool } = pg;
const { migruoti, sausasPaleidimas } = artifactMigration;
const { parinktiBackenda, sukurtiSaugykla } = artifactStore;

/**
 * ⚠️ METAMA, NE `process.exit()` — DVI SKIRTINGOS PRIEŽASTYS.
 *
 * 1. `process.exit()` nutraukia procesą NELAUKDAMAS, kol išsipils stdout. Kai
 *    išvestis nukreipta į failą ar pipe (t. y. kiekvienoje automatikoje), didelis
 *    `console.log` gali būti NUKIRSTAS: skaitytojas gauna nepilną JSON ir to
 *    nepastebi, nes exit kodas sako „sėkmė".
 *
 * 2. Iš `try` bloko vidaus jis dar ir aplenkia `finally`, tad `pool.end()`
 *    neįvyksta. Antroji problema tylesnė už pirmą ir buvo ten pat.
 *
 * Metimas + `process.exitCode` abi uždaro: Node baigia darbą pats, kai srautai
 * išsipylę ir `finally` įvykdytas.
 */
class NaudojimoKlaida extends Error {
  constructor(zinute, kodas = 1) {
    super(zinute);
    this.kodas = kodas;
  }
}

function klaida(zinute, kodas = 1) {
  throw new NaudojimoKlaida(zinute, kodas);
}

function skaicius(argv, vardas, numatytas) {
  const i = argv.indexOf(vardas);
  if (i === -1) return numatytas;

  const reiksme = Number(argv[i + 1]);
  if (!Number.isInteger(reiksme) || reiksme <= 0) {
    klaida(`${vardas} reikalauja teigiamo sveiko skaičiaus.`);
  }
  return reiksme;
}

const argv = process.argv.slice(2);
const komanda = argv[0];

/**
 * Grąžina exit kodą. NĖ VIENA šaka nekviečia `process.exit()` — žr. `klaida()`.
 */
async function vykdyti(pool) {
  if (komanda === "status") {
    const { rows } = await pool.query(
      `SELECT busena, priezastis, count(*)::int AS kiek
         FROM artifact_migration_progress
        GROUP BY busena, priezastis
        ORDER BY busena, priezastis`
    );
    const { rows: likę } = await pool.query(
      "SELECT count(*)::int AS kiek FROM job_results WHERE storage_type = 'inline' AND payload IS NOT NULL"
    );

    console.log(JSON.stringify({ likęInline: likę[0].kiek, progresas: rows }, null, 2));
    return 0;
  }

  const limit = skaicius(argv, "--limit", 1000);
  const retryFailed = argv.includes("--retry-failed");

  if (komanda === "dry-run") {
    /**
     * ⚠️ SAUGYKLA ČIA NEKURIAMA SĄMONINGAI. Sausas paleidimas neturi net
     * PRISIJUNGTI prie saugyklos: prisijungimas yra šalutinis efektas, o jo
     * reikalavimas verstų operatorių konfigūruoti tai, ko šis režimas nenaudoja.
     */
    const suvestine = await sausasPaleidimas(pool, { limit, retryFailed });
    console.log(JSON.stringify(suvestine, null, 2));
    return 0;
  }

  const { backend, eksplicitinis } = parinktiBackenda();
  if (!eksplicitinis || backend === "inline") {
    klaida(
      "ARTIFACT_STORE_BACKEND privalo būti eksplicitiškai `fs` arba `s3`. " +
        "Migracija į `inline` nieko neperkeltų, o tylus numatytasis paverstų tai nepastebima."
    );
  }

  const saugykla = await sukurtiSaugykla({ backend });
  const suvestine = await migruoti(pool, saugykla, { limit, retryFailed });

  console.log(JSON.stringify(suvestine, null, 2));

  /**
   * ⚠️ NESĖKMĖS TURI SAVO EXIT KODĄ. Su `0` masinis paleidimas, palikęs šimtą
   * neperkeltų eilučių, atrodytų sėkmingas kiekvienoje automatikoje, kuri žiūri
   * tik į exit kodą — o būtent tos eilutės ir reikalauja žmogaus.
   *
   * ⚠️ `praleista` į šį kodą NEĮEINA: praleista eilutė reiškia, kad darbą atliko
   * kas nors kitas, o ne kad jo reikia.
   */
  const nepavyko = Object.values(suvestine.nepavyko).reduce((a, b) => a + b, 0);
  return nepavyko > 0 ? 3 : 0;
}

let pool = null;

try {
  if (!["dry-run", "run", "status"].includes(komanda)) {
    klaida("Naudojimas: migrate-artifacts.mjs <dry-run|run|status> [--limit N] [--retry-failed]");
  }
  if (!process.env.DATABASE_URL) klaida("DATABASE_URL nenustatytas.");

  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  process.exitCode = await vykdyti(pool);
} catch (e) {
  console.error(
    e instanceof NaudojimoKlaida ? e.message : `Migracija nutraukta: ${e && e.message ? e.message : e}`
  );
  process.exitCode = e instanceof NaudojimoKlaida ? e.kodas : 2;
} finally {
  if (pool) await pool.end().catch(() => {});
}
