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
const auditStore = require("../utils/auditStore");
const tombstones = require("../utils/deletionTombstones");

/**
 * ⚠️ SAUGYKLOS INICIJUOJAMOS IR UŽDAROMOS (Codex P2, #262) - TAS PATS SPRENDIMAS
 * KAIP `scripts/erasure-marks.js:160-175`.
 *
 * Be `auditStore.init()` su `AUDIT_BACKEND=postgres` `rasytiAudita()` rašo į
 * numatytąjį ATMINTIES fasadą (`auditStore/index.js:126`): komanda praneša
 * sėkmę, o `PG_DUMP_BACKUP_CREATED` dingsta procesui pasibaigus. Runbook'o §11
 * garantija liktų be įrašo.
 *
 * ⚠️ REPO ATSAKYMĄ JAU TURĖJO. `erasure-marks.js` tą pačią klaidą užrašė kaip
 * „vieno entrypoint'o dvi saugyklos, ir inicijuota buvo tik viena"; šis kelias
 * jo nepaėmė. Tai antras kartas šiame darbe, kai atsakymas repo jau buvo
 * (pirmas - `checkRestoreCompatibility`).
 *
 * ⚠️ UŽDAROMA ABIEM KELIAIS. Neuždarius pool'o `process.exit()` nutraukia
 * jungtis nelaukdamas `COMMIT` patvirtinimo; uždarymo klaidos nutylimos, nes
 * rezultatas jau yra, o triukšmas paslėptų tikrąjį atsakymą.
 */
async function isvalyti() {
  await auditStore.shutdown().catch(() => {});
  await tombstones.shutdown().catch(() => {});
}

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

    /**
     * ⚠️ AUDITO SAUGYKLA INICIJUOJAMA TIK `dump` ŠAKOJE (#262 peržiūra, P1).
     *
     * Pirmoji redakcija tai darė PRIEŠ komandų šakojimą, ir `restore` krisdavo
     * ties audito baze, nepasiekęs `atkurtiSifruotaKopija()`. Išmatuota:
     *
     *   su AUDIT_BACKEND=postgres, nepasiekiama audito baze:
     *     KLAIDA: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1
     *   ta pati komanda be AUDIT_BACKEND:
     *     KLAIDA: BACKUP_MANIFEST_INVALID: ...
     *
     * T. y. avarinis atkūrimas ėmė priklausyti nuo audito prieinamumo - būtent
     * ta priklausomybė, kurios runbook'o §10 atsisako ir dėl kurios atkūrimo
     * pusė sąmoningai neaudituojama. Blogiau: `DATABASE_URL`, rodantis į NAUJĄ
     * TUŠČIĄ tikslą, `audit_log` lentelės dar neturi, o tai yra NUMATYTAS 7.6a
     * scenarijus, ne kraštinis - procedūra nepraeidavo savo pačios dokumentuotu
     * keliu.
     */
    await auditStore.init();

    /**
     * ⚠️ NUMATYTAS `AUDIT_BACKEND=memory` — MATOMAS ĮSPĖJIMAS, NE ATSISAKYMAS
     * (#262 IV raundas).
     *
     * Atmintinėje saugykloje `PG_DUMP_BACKUP_CREATED` gula į proceso masyvą ir
     * dingsta komandai pasibaigus, tad §11 teiginys be sąlygos būtų netiesa.
     *
     * ⚠️ KODĖL NE FAIL-CLOSED, KITAIP NEI HORIZONTAS. Nuo horizonto priklauso
     * #250 ištrynimų replay — jo praradimas yra GDPR pasekmė. Auditas yra
     * atskaitomybės įrodymas, ir reikalavimas turėti persistentinę audito
     * saugyklą reikštų, kad diegimas su numatytu `memory` APSKRITAI negali
     * pasidaryti kopijos — ta pati priklausomybė, kurios atsisakėme atkūrimo
     * pusėje. Todėl runbook'o teiginys sąlyginis, o operatorius įspėjamas.
     */
    if (auditStore.backend() === "memory") {
      console.error(
        "ĮSPĖJIMAS: audito saugykla yra `memory` — `PG_DUMP_BACKUP_CREATED` liks " +
          "proceso atmintyje ir dings pasibaigus komandai. Patvariam pėdsakui " +
          "nustatykite `AUDIT_BACKEND=postgres`."
      );
    }

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
  await isvalyti();
  mirti(`${klaida.code || klaida.name}: ${pgDumpBackup.bePaslapciu(klaida.message)}`, 2);
}

await isvalyti();
