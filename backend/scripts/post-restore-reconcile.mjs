#!/usr/bin/env node
/**
 * POST-RESTORE SUDERINIMAS — OPERATORIAUS ĮĖJIMAS (#155, 7.6b / #249).
 *
 * ⚠️ ŠIS FAILAS LOGIKOS NETURI IR NETURI TURĖTI.
 *
 * Visa procedūra gyvena `utils/postRestoreReconcile.js`; čia tik argumentai,
 * saugyklų gyvavimo ciklas ir exit kodai. Ta pati taisyklė kaip 7.6a
 * `pg-backup.mjs` (D2 ten, D1 čia): jei procedūra atsidurtų dviejose vietose,
 * integracinis testas įrodinėtų savo imitaciją, ne operatoriaus kelią.
 *
 * NAUDOJIMAS
 *   node scripts/post-restore-reconcile.mjs run    --target <url> --actor <kas>
 *   node scripts/post-restore-reconcile.mjs verify --target <url>
 *
 * Exit kodai:
 *   0 — suderinta (arba nieko nereikėjo; išvestis tai pasako eksplicitiškai)
 *   1 — naudojimo klaida
 *   2 — procedūros klaida (fail-closed: atkūrimo laikyti baigtu negalima)
 *   3 — `verify`: bazė NĖRA suderinta (ne klaida, o atsakymas „dar ne")
 *
 * ⚠️ „NIEKO NEREIKĖJO" NIEKADA NEATRODO KAIP NESĖKMĖ ir atvirkščiai: 0 ir 2
 * skiria būtent tuos du atvejus, o 3 atskiria „procedūra lūžo" nuo „procedūra
 * suveikė ir atsakymas neigiamas".
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const reconcile = require("../utils/postRestoreReconcile");
const auditStore = require("../utils/auditStore");

/**
 * ⚠️ SAUGYKLŲ GYVAVIMO CIKLAS (D7b) — `scripts/erasure-marks.js:160-175` forma.
 *
 * Be `auditStore.init()` su `AUDIT_BACKEND=postgres` `rasytiAudita()` rašo į
 * numatytąjį ATMINTIES fasadą, procesas baigiasi, ir evidencija dingsta, nors
 * komanda praneša sėkmę. 7.6a nuo šio precedento nukrypo ir gavo P2; čia jis
 * paimtas iš karto.
 *
 * ⚠️ KODĖL TIK VIENA SAUGYKLA, O NE TRYS. `jobStore`, `sessionStore` ir
 * ištrynimo žymos šiame kelyje NENAUDOJA savo fasadų: visos trys operacijos
 * vykdomos per suderinimo modulio klientą (`*WithClient`), nes D4 reikalauja
 * vienos transakcijos. Fasadų inicijavimas čia būtų teatras — jie neturėtų ką
 * veikti, o `deletionTombstones/index.js:443` tokį kelią eksplicitiškai
 * atkalbinėja: jo `ensureInit()` jungiasi pagal `process.env` ir gali rodyti į
 * kitą bazę nei kviečiančiojo klientas.
 */
async function isvalyti() {
  await auditStore.shutdown().catch(() => {});
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
const target = argumentas("target");

try {
  if (komanda === "run") {
    const actor = argumentas("actor");
    if (!target) mirti("`run` reikalauja `--target <url>`.", 1);
    if (!actor) mirti("`run` reikalauja `--actor <kas>` (evidencijai).", 1);

    /**
     * ⚠️ SARGAI PRIEŠ ŠALUTINIUS EFEKTUS. Jie gryni (skaito tik aplinką), tad
     * krenta anksčiau nei atveriama audito saugykla: sprendimas prieš darbą, ta
     * pati tvarka kaip 7.6a `pg-backup.mjs`.
     */
    reconcile.patikrintiSargus(target, process.env);

    await auditStore.init();

    if (auditStore.backend() === "memory") {
      /**
       * ⚠️ ĮSPĖJIMAS, NE ATSISAKYMAS — tas pats sprendimas kaip 7.6a.
       * Evidencija yra atskaitomybės įrodymas; reikalavimas turėti patvarią
       * audito saugyklą reikštų, kad diegimas su numatytu backend'u negali
       * užbaigti atkūrimo procedūros.
       */
      console.error(
        "ĮSPĖJIMAS: audito saugykla yra `memory` — `POST_RESTORE_RECONCILED` liks " +
          "proceso atmintyje ir dings pasibaigus komandai. Patvariai evidencijai " +
          "nustatykite `AUDIT_BACKEND=postgres`."
      );
    }

    const r = await reconcile.suderinti({ targetUrl: target, actor });

    console.log(
      `Suderinta (${r.tapatybe}): sesijų revokuota ${r.sesijos}; ` +
        `job'ų terminalizuota ${r.jobai.terminalizuota} iš ${r.jobai.rasta}` +
        (r.jobai.praleista.length
          ? `; praleista dėl ištrynimo žymų ${r.jobai.praleista.length} (7.6c): ${r.jobai.praleista.join(", ")}`
          : "")
    );

    if (r.nieko) console.log("Nieko nereikėjo: aktyvių sesijų ir ne terminalinių job'ų nebuvo.");
  } else if (komanda === "verify") {
    if (!target) mirti("`verify` reikalauja `--target <url>`.", 1);

    const v = await reconcile.patikrinti({ targetUrl: target });

    if (v.suderinta) {
      console.log(
        `Suderinta (${v.tapatybe}): aktyvių sesijų nėra, ne terminalinių job'ų nėra` +
          (v.uzbarjeruoti.length ? `; ${v.uzbarjeruoti.length} paliktas (-i) 7.6c dėl ištrynimo žymų` : "") +
          "."
      );
    } else {
      console.error(
        `NESUDERINTA (${v.tapatybe}): aktyvių sesijų ${v.aktyviosSesijos}; ` +
          `ne terminalinių job'ų ${v.nesuderinti.length}. Serverio paleisti negalima.`
      );
      await isvalyti();
      process.exit(3);
    }
  } else {
    mirti("Nežinoma komanda. Naudokite `run` arba `verify`.", 1);
  }
} catch (klaida) {
  await isvalyti();
  mirti(`${klaida.code || klaida.name}: ${klaida.message}`, 2);
}

await isvalyti();
