#!/usr/bin/env node
/**
 * IŠTRYNIMO ŽYMŲ OPERATORIAUS ĮRANKIS (#155, 7.5a / #183).
 *
 * Užstrigusi žyma yra INCIDENTAS, ne kasdienis darbas. Todėl įėjimas yra
 * skriptas, ne HTTP maršrutas: maršrutas pridėtų autentikacijos, autorizacijos
 * ir rate-limit paviršių tam, kas daroma retai ir turint DB prieigą.
 *
 * Naudojimas:
 *
 *   node scripts/erasure-marks.js list [--hours N] [--limit N]
 *   node scripts/erasure-marks.js retry <jobId> --actor <kas>
 *   node scripts/erasure-marks.js force-resolve <jobId> --actor <kas>
 *
 * ⚠️ `retry` NEVYKDO ištrynimo - jis grąžina žymą į `deletion_pending`, iš kur
 * įprastas ištrynimo kelias gali ją užbaigti. `force-resolve` NĖRA ištrynimas:
 * operatorius patvirtina, kad duomenų nebėra, ir prisiima tai auditu. Barjeras
 * abiem atvejais LIEKA - žyma niekur nedingsta.
 *
 * ⚠️ `--actor` privalomas keičiantiems veiksmams: audito įrašas be aktoriaus
 * neatsako į vienintelį klausimą, dėl kurio jis rašomas.
 */

/**
 * ⚠️ `.env` ĮKELIAMAS PIRMA, IR ABSOLIUČIU KELIU (#183 Codex, P1 kontekste).
 *
 * Be šito įrankis tyliai pasirinkdavo ATMINTIES backend'ą: įprastame ne-Compose
 * diegime `DATABASE_URL` gyvena `backend/.env`, o ne shell aplinkoje. `list`
 * praneštų, kad persistentinių incidentų nėra, o mutacijos komandos grąžintų
 * `no_mark`, nepalietusios PostgreSQL - ir operatorius padarytų neteisingą
 * išvadą būtent tada, kai atsakymas svarbiausias.
 *
 * Q3 sprendimu šis skriptas yra VIENINTELIS operatoriaus kelias užstrigusiai
 * žymai išspręsti (admin maršruto sąmoningai nėra), tad tyli klaida čia yra
 * brangiausia.
 *
 * ⚠️ KELIAS NUO `__dirname`, ne nuo darbinio katalogo: komanda dokumentuota kaip
 * `node backend/scripts/erasure-marks.js …`, tad `cwd` paprastai yra repo
 * šaknis. `dotenv` neperrašo jau nustatytų kintamųjų, tad shell aplinka lieka
 * viršesnė.
 */
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const erasureMarks = require("../services/erasureMarkService");
const tombstones = require("../utils/deletionTombstones");
const auditStore = require("../utils/auditStore");

function arg(vardas, numatytas = null) {
  const i = process.argv.indexOf(`--${vardas}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : numatytas;
}

function lentele(zymos) {
  if (!zymos.length) {
    console.log("Neterminalių žymų, senesnių už nurodytą ribą, nėra.");
    return;
  }

  console.log(
    ["JOB_ID", "BŪSENA", "PRIEŽASTIS", "AKTORIUS", "BANDYMAI", "PASKUTINĖ KLAIDA", "AMŽIUS (h)"].join("\t")
  );

  for (const z of zymos) {
    console.log(
      [
        z.jobId,
        z.status,
        z.reason,
        z.actorKind || "-",
        z.attempts,
        z.lastFailureKind || "-",
        z.ageHours,
      ].join("\t")
    );
  }

  console.log(`\nIš viso: ${zymos.length}`);
}

async function main() {
  const komanda = process.argv[2];

  if (!komanda || komanda === "list") {
    const valandos = Number(arg("hours", "24"));
    const limit = Number(arg("limit", "100"));

    lentele(
      await erasureMarks.listStuck({
        olderThanMs: Number.isFinite(valandos) ? valandos * 3600000 : erasureMarks.UZSTRIGUSI_PO_MS,
        limit: Number.isFinite(limit) ? limit : 100,
      })
    );

    console.log(`\nBackend'as: ${tombstones.backend}`);

    if (tombstones.backend === "memory") {
      console.warn(`\n⚠️  ${tombstones.ATMINTIES_ISPEJIMAS}`);
    }

    return 0;
  }

  const jobId = process.argv[3];
  const actor = arg("actor");

  if (!jobId) {
    console.error("Trūksta `jobId`.");
    return 2;
  }

  if (!actor) {
    console.error("Trūksta `--actor`. Barjero pakeitimas be aktoriaus nefiksuojamas.");
    return 2;
  }

  if (komanda === "retry") {
    const r = await erasureMarks.retryMark(jobId, { actor });
    console.log(JSON.stringify(r));
    return r.changed ? 0 : 1;
  }

  if (komanda === "force-resolve") {
    const r = await erasureMarks.forceResolveMark(jobId, { actor, note: arg("note") });
    console.log(JSON.stringify(r));
    return r.changed ? 0 : 1;
  }

  console.error(`Nežinoma komanda: ${komanda}. Žr. failo viršų.`);
  return 2;
}

/**
 * ⚠️ AUDITO SAUGYKLA INICIJUOJAMA IR UŽDAROMA (#183 Codex, P1).
 *
 * Be `auditStore.init()` su `AUDIT_BACKEND=postgres` `rasytiAudita()` rašytų į
 * numatytąjį ATMINTIES fasadą, procesas baigtųsi, ir kiekvienas
 * `ERASURE_MARK_RETRIED` / `ERASURE_MARK_FORCE_RESOLVED` dingtų. Operatoriaus
 * veiksmai liktų neaudituoti, nors dokumentacija žada patvarų pėdsaką.
 *
 * ⚠️ TAI ANTRA TOS PAČIOS KLAIDOS PUSĖ. `.env` pataisa sutvarkė DUOMENIS -
 * žyma keliauja į PostgreSQL. Auditas keliavo į niekur. Vieno entrypoint'o dvi
 * saugyklos, ir inicijuota buvo tik viena.
 *
 * ⚠️ UŽDAROMA ABIEM KELIAIS. Neuždarius pool'o `process.exit()` nutraukia
 * jungtis be `COMMIT` patvirtinimo laukimo; `shutdown()` klaidos nutylimos, nes
 * skriptas jau turi rezultatą, o uždarymo triukšmas paslėptų tikrąjį atsakymą.
 */
async function isvalyti() {
  await auditStore.shutdown().catch(() => {});
  await tombstones.shutdown().catch(() => {});
}

/** ⚠️ Skriptas vykdomas TIK paleistas tiesiogiai - testai importuoja `main`. */
if (require.main === module) {
  auditStore
    .init()
    .then(main)
    .then(async (kodas) => {
      await isvalyti();
      process.exit(kodas);
    })
    .catch(async (klaida) => {
      console.error(`Klaida: ${klaida.message}`);
      await isvalyti();
      process.exit(1);
    });
}

module.exports = { main };
