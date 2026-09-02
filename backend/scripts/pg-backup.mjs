#!/usr/bin/env node
/**
 * ŠIFRUOTA PostgreSQL KOPIJA — OPERATORIAUS ĮĖJIMAS (#155, 7.6a / #248).
 *
 * ⚠️ ŠIS FAILAS LOGIKOS NETURI IR NETURI TURĖTI.
 *
 * Visa orkestracija gyvena `utils/pgDumpBackup.js`; čia tik argumentų
 * nuskaitymas, failų įvestis/išvestis ir exit kodai. Priežastis yra D2: procedūra
 * privalo būti VIENA, o integracinis testas kviečia tą patį modulį. Jei čia
 * atsirastų `pg_dump` ar `psql` iškvietimas, operatoriaus kelias ir testuojamas
 * kelias imtų skirtis — ir testas įrodinėtų savo imitaciją.
 *
 * Sargas: `tests/pgDumpBackupContract.test.js` tikrina, kad šiame faile nebūtų
 * `pg_dump`/`psql`/`spawn`.
 *
 * NAUDOJIMAS
 *   node scripts/pg-backup.mjs dump    --out kopija.json --actor <kas> [--url $DATABASE_URL]
 *   node scripts/pg-backup.mjs restore --in  kopija.json --target <url>
 *
 * ⚠️ `--actor` PRIVALOMAS `dump` komandai: runbook'o §11 teigia, kad kopijų
 * kūrimas audituojamas SU AKTORIUMI. Neprivalomas laukas tą teiginį vėl
 * susilpnintų iki „kartais".
 *
 * ⚠️ JOKIŲ JUNGTIES EILUČIŲ IŠVESTYJE. Ir sėkmės pranešimas, ir klaida eina per
 * `redaguotasUrl()`/`bePaslapciu()`: `pg_dump` klaidos tekstas turi visą argumentų
 * eilutę su slaptažodžiu (išmatuota, #262 peržiūra).
 *
 * Exit kodai: 0 sėkmė · 1 naudojimo klaida · 2 procedūros klaida.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pgDumpBackup = require("../utils/pgDumpBackup");

function argumentas(vardas, numatytas = undefined) {
  const i = process.argv.indexOf(`--${vardas}`);
  if (i === -1 || i + 1 >= process.argv.length) return numatytas;
  return process.argv[i + 1];
}

function mirti(zinute, kodas) {
  console.error(`KLAIDA: ${zinute}`);
  process.exit(kodas);
}

const komanda = process.argv[2];

try {
  if (komanda === "dump") {
    const out = argumentas("out");
    if (!out) mirti("`dump` reikalauja `--out <failas>`.", 1);

    const actor = argumentas("actor");
    if (!actor) mirti("`dump` reikalauja `--actor <kas>` (auditui).", 1);

    const { manifest, envelope, dumpBytes } = await pgDumpBackup.sukurtiSifruotaKopija({
      databaseUrl: argumentas("url", process.env.DATABASE_URL),
      actor,
    });

    await writeFile(out, JSON.stringify({ manifest, envelope }, null, 2), "utf8");
    console.log(`Kopija sukurta: ${out} (dump ${dumpBytes} B, šifruota).`);
  } else if (komanda === "restore") {
    const inFile = argumentas("in");
    const target = argumentas("target");
    if (!inFile || !target) mirti("`restore` reikalauja `--in <failas>` ir `--target <url>`.", 1);

    const { manifest, envelope } = JSON.parse(await readFile(inFile, "utf8"));
    const { restoredBytes } = await pgDumpBackup.atkurtiSifruotaKopija({
      manifest,
      envelope,
      targetUrl: target,
    });

    console.log(`Kopija atkurta į ${pgDumpBackup.redaguotasUrl(target)} (${restoredBytes} B SQL).`);
  } else {
    mirti("Nežinoma komanda. Naudokite `dump` arba `restore`.", 1);
  }
} catch (klaida) {
  mirti(`${klaida.code || klaida.name}: ${pgDumpBackup.bePaslapciu(klaida.message)}`, 2);
}
