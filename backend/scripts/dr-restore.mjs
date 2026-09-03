#!/usr/bin/env node
/**
 * DR ATKŪRIMO KOORDINATORIUS — OPERATORIAUS ĮĖJIMAS (#155, 7.6c / #250).
 *
 * ⚠️ ŠIS FAILAS LOGIKOS NETURI IR NETURI TURĖTI.
 *
 * Visa procedūra gyvena `utils/drCoordinator.js`, `utils/erasureExport.js` ir
 * `utils/erasureReplay.js`; čia tik argumentai, saugyklų gyvavimo ciklas, failų
 * įvestis/išvestis ir exit kodai. Ta pati taisyklė kaip 7.6a `pg-backup.mjs` ir
 * 7.6b `post-restore-reconcile.mjs`.
 *
 * NAUDOJIMAS
 *   node scripts/dr-restore.mjs export --out zurnalas.json --actor "$USER"
 *   node scripts/dr-restore.mjs run    --in  zurnalas.json --target <url> --actor "$USER"
 *   node scripts/dr-restore.mjs verify --target <url>
 *
 * Pasenusio žurnalo priėmimas (išimtis, ne žingsnis sekoje):
 *   ... run --allow-stale
 *   ... run --allow-stale --confirm-deployment <id> --confirm-checksum <sum> --confirm-stale-hours <n>
 *
 * Exit kodai:
 *   0 sėkmė · 1 naudojimo klaida · 2 procedūros klaida (fail-closed)
 *   3 `verify`: dar NESUDERINTA — cutover negalimas
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const drCoordinator = require("../utils/drCoordinator");
const erasureExport = require("../utils/erasureExport");
const deploymentIdentity = require("../utils/deploymentIdentity");
const tombstones = require("../utils/deletionTombstones");
const auditStore = require("../utils/auditStore");
const { pgJungtiesNustatymai } = require("../utils/pgConnection");

/**
 * ⚠️ SAUGYKLOS INICIJUOJAMOS IR UŽDAROMOS (7.6b D7b, `erasure-marks.js:160-175`).
 *
 * Be `auditStore.init()` su `AUDIT_BACKEND=postgres` `ERASURE_REPLAYED` — BLOKUOJANTIS
 * įvykis apie asmens duomenų šalinimą — rašytų į numatytąjį ATMINTIES fasadą ir
 * dingtų procesui pasibaigus. Žymų saugykla inicijuojama, nes `tombstones.listAll()`
 * ir `complete()` eina per fasadą.
 */
async function isvalyti(pool) {
  if (pool) await pool.end().catch(() => {});
  await tombstones.shutdown().catch(() => {});
  await auditStore.shutdown().catch(() => {});
}

function argumentas(vardas, numatytas = undefined) {
  const i = process.argv.indexOf(`--${vardas}`);
  if (i === -1 || i + 1 >= process.argv.length) return numatytas;
  return process.argv[i + 1];
}

function veliava(vardas) {
  return process.argv.includes(`--${vardas}`);
}

function mirti(zinute, kodas) {
  console.error(`KLAIDA: ${zinute}`);
  process.exit(kodas);
}

const komanda = process.argv[2];
const actor = argumentas("actor");
let pool = null;

try {
  if (komanda === "export") {
    const out = argumentas("out");
    if (!out) mirti("`export` reikalauja `--out <failas>`.", 1);
    if (!actor) mirti("`export` reikalauja `--actor <kas>`.", 1);

    await auditStore.init();
    await tombstones.init(process.env);

    pool = new Pool(pgJungtiesNustatymai(process.env));
    const deployment = await deploymentIdentity.skaitytiTapatybe(pool);

    const zymos = await tombstones.listAll();
    const horizontas = await tombstones.refreshBackupHorizon();

    const artefaktas = erasureExport.sudarytiArtefakta({
      zymos,
      horizontas,
      saltinis: erasureExport.saltinioTapatybe(),
      deploymentId: deployment,
    });

    await writeFile(out, JSON.stringify({ manifest: artefaktas.manifest, envelope: artefaktas.envelope }, null, 2), "utf8");

    console.log(
      `Žurnalas eksportuotas: ${out} (žymų ${artefaktas.zymuSkaicius}, ` +
        `horizontas ${horizontas === null ? "nėra" : new Date(horizontas).toISOString()}, šifruota).`
    );
  } else if (komanda === "run") {
    const inFile = argumentas("in");
    const target = argumentas("target");
    if (!inFile || !target) mirti("`run` reikalauja `--in <failas>` ir `--target <url>`.", 1);
    if (!actor) mirti("`run` reikalauja `--actor <kas>` (evidencijai).", 1);

    await auditStore.init();
    await tombstones.init(process.env);

    pool = new Pool(pgJungtiesNustatymai(process.env));
    const artefaktas = JSON.parse(await readFile(inFile, "utf8"));

    /**
     * ⚠️ PATVIRTINIMAS REIKŠMĖMIS, NE `--yes`. Privatumo režime audito įrašas
     * slopinamas, tad pėdsakas yra šis patvirtinimas; jo reikšmės privalo sutapti
     * su tuo, ką koordinatorius apskaičiavo.
     */
    const patvirtinimas = veliava("allow-stale")
      ? {
          deploymentId: argumentas("confirm-deployment"),
          zurnaloChecksum: argumentas("confirm-checksum"),
          pasenimoValandos: Number(argumentas("confirm-stale-hours")),
        }
      : null;

    const rezultatas = await drCoordinator.paleisti({
      targetUrl: target,
      artefaktas,
      vykdytojas: pool,
      actor,
      leistiPasenusi: veliava("allow-stale"),
      patvirtinimas,
    });

    console.log(
      `DR atkūrimas baigtas (${rezultatas.merge.tapatybe}): sulietos ${rezultatas.merge.sulietos.length}, ` +
        `praleistos ${rezultatas.merge.praleistos.length}, nukirpti claim'ai ${rezultatas.merge.nukirptiClaimai.length}; ` +
        `ištrinta ${rezultatas.replay.istrinta.length}, jau nebuvo ${rezultatas.replay.jauNebuvo.length}, ` +
        `uždarytos žymos ${rezultatas.replay.uzdarytosZymos.length}; sesijų revokuota ${rezultatas.reconcile.sesijos}.`
    );
    console.log("Verifikacija: OK — startas ir cutover leidžiami.");
  } else if (komanda === "verify") {
    const target = argumentas("target");
    if (!target) mirti("`verify` reikalauja `--target <url>`.", 1);

    await tombstones.init(process.env);

    const zymos = await tombstones.listAll();
    const neuzdarytos = zymos.filter((z) => z.status !== tombstones.TOMBSTONE_STATUS.DELETED);

    const postRestoreReconcile = require("../utils/postRestoreReconcile");
    const b76 = await postRestoreReconcile.patikrinti({ targetUrl: target });

    console.log(`Žymos: ${zymos.length}, neuždarytos: ${neuzdarytos.length}.`);

    if (!b76.suderinta || neuzdarytos.length > 0) {
      console.error(
        `NESUDERINTA: neuždarytų žymų ${neuzdarytos.length}; 7.6b verdiktas ${b76.suderinta}. ` +
          "Cutover negalimas."
      );
      await isvalyti(pool);
      process.exit(3);
    }

    console.log("Suderinta: žymos uždarytos, sesijos ir job'ai sutvarkyti — cutover leidžiamas.");
  } else {
    mirti("Nežinoma komanda. Naudokite `export`, `run` arba `verify`.", 1);
  }
} catch (klaida) {
  /**
   * ⚠️ PASENUSIO ŽURNALO ATVEJU IŠVEDAMAS MAŠININIS BLOKAS.
   *
   * Operatoriui reikia TIKSLIŲ reikšmių, kurias vėliau perduos kaip patvirtinimą —
   * kitaip „patvirtink reikšmėmis" virstų spėliojimu.
   */
  if (klaida.code === "DR_STALE_OVERRIDE_UNCONFIRMED" || klaida.code === "DR_LEDGER_STALE") {
    console.error("--- PASENUSIO ŽURNALO PATVIRTINIMAS ---");
    console.error(klaida.message);
    console.error(
      "Pakartokite su: --allow-stale --confirm-deployment <id> --confirm-checksum <sum> --confirm-stale-hours <n>"
    );
  }

  await isvalyti(pool);
  mirti(`${klaida.code || klaida.name}: ${klaida.message}`, 2);
}

await isvalyti(pool);
