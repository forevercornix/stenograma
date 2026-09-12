/**
 * CUTOVER 3–3b ŽINGSNIAI: terminalizuoti likusius job'us ir išlaisvinti audio.
 *
 * ⚠️ KODĖL SKRIPTAS, O NE INSTRUKCIJA DOKUMENTE.
 *
 * Procedūra vardijo VIDINES JS funkcijas (`finish()`, `releaseAudio()`), o repo
 * neturėjo komandos, kuri jas iškviestų. Operatoriui liktų rašyti ad hoc kodą
 * PRODUKCIJOJE, per vienintelį veiksmą, kurio klaida negrįžtama.
 *
 * ⚠️ NUMATYTAI — SAUSAS PALEIDIMAS. Rašo tik su `--vykdyti`. Dokumentuota
 * procedūra, kurios pirmas paleidimas jau keičia būseną, neturi repeticijos.
 *
 * ⚠️ FAIL-CLOSED: prielaidos tikrinamos PRIEŠ pirmą pakeitimą, ir netenkinamos
 * reiškia ATSISAKYMĄ, ne įspėjimą.
 *
 * Naudojimas:
 *   node scripts/cutover-terminalize.mjs             # sausas: tik parodo
 *   node scripts/cutover-terminalize.mjs --vykdyti   # realiai keičia
 *
 * Exit kodai: 0 sėkmė · 1 naudojimo klaida · 2 prielaidos netenkinamos ·
 * 3 dalis job'ų neapdorota.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jobStore = require("../utils/jobStore");
const { releaseAudio } = require("../utils/audioCleanup");
const { getTranscriptionQueue, closeTranscriptionQueue } = require("../queues/transcriptionQueue");

/**
 * ⚠️ NETERMINALIOS BullMQ BŪSENOS — VARDIJAMOS PAŽODŽIUI, NE `active + waiting`.
 *
 * Su numatytuoju `attempts: 3` ir eksponentiniu backoff nepavykęs job'as sėdi
 * `delayed`. Tikrinant tik `active + waiting`, nulis pasiekiamas, kai darbas dar
 * SUPLANUOTAS: worker'iai sustabdomi, Redis metaduomenys ištrinami, o vėliau
 * `delayed` job'as pakyla ir krinta ties „nėra įrašo".
 *
 * Retry konfigūracija yra NUMATYTOJI, tad tai įprastas kelias, ne kraštutinis.
 */
const NETERMINALIOS = Object.freeze([
  "active",
  "waiting",
  "waiting-children",
  "delayed",
  "paused",
  "prioritized",
]);

/** jobStore būsenos, kurias 3 žingsnis terminalizuoja. */
const NETERMINALŪS_JOBAI = Object.freeze(["queued", "processing"]);

const vykdyti = process.argv.includes("--vykdyti");

/**
 * ⚠️ NEŽINOMI ARGUMENTAI ATMETAMI. `--vykdyty` rašybos klaida tyliai duotų sausą
 * paleidimą, o operatorius manytų atlikęs žingsnį (#157, PR-6 pamoka).
 */
const nezinomi = process.argv.slice(2).filter((a) => a !== "--vykdyti");
if (nezinomi.length > 0) {
  console.error(`Nežinomi argumentai: ${nezinomi.join(", ")}. Galimas tik \`--vykdyti\`.`);
  process.exitCode = 1;
} else {
  await pagrindinis();
}

async function pagrindinis() {
  const problemos = [];

  await jobStore.init();

  /**
   * ⚠️ PIRMA PRIELAIDA: BACKEND'AS TURI BŪTI `redis`.
   *
   * Skriptas skirtas cutover'iui IŠ Redis. Paleistas prieš PostgreSQL ar atmintį,
   * jis terminalizuotų job'us saugykloje, kurios niekas nemigruoja — t. y. atliktų
   * destruktyvų veiksmą ne toje vietoje.
   */
  const backend = jobStore.getBackend();
  if (backend !== "redis") {
    /**
     * ⚠️ GRĮŽTAMA IŠ KARTO, NE KAUPIAMA Į `problemos`.
     *
     * Eilės skaitikliai reikalauja Redis JUNGTIES. Ne-Redis diegime ji arba
     * nukristų su `ECONNREFUSED`, arba — blogiau — pakiltų prie SVETIMOS
     * instancijos. Patikra, kuri tam, kad atsisakytų, pirma prisijungia, yra
     * blogesnė už jos nebuvimą.
     */
    console.error("PRIELAIDOS NETENKINAMOS — nieko nekeičiama:");
    console.error(`  - job store backend'as yra '${backend}', o ne 'redis' — ne ta saugykla`);
    process.exitCode = 2;
    await jobStore.close().catch(() => {});
    return;
  }

  /**
   * ⚠️ ANTRA PRIELAIDA: EILĖJE NEBĖRA NETERMINALIŲ DARBŲ.
   *
   * Tai patvirtina, kad 1, 2 ir 2b žingsniai atlikti. Be jos veikiantis worker'is
   * po terminalizavimo parašytų NAUJĄ įrašą, ir 5b jį ištrintų.
   */
  let skaitikliai = null;
  try {
    skaitikliai = await getTranscriptionQueue().getJobCounts(...NETERMINALIOS);
  } catch (klaida) {
    problemos.push(`eilės skaitiklių nepavyko perskaityti: ${klaida.message}`);
  }

  if (skaitikliai) {
    for (const busena of NETERMINALIOS) {
      const n = Number(skaitikliai[busena] || 0);
      if (n > 0) problemos.push(`eilėje liko ${n} job'ų būsenoje '${busena}'`);
    }
  }

  if (problemos.length > 0) {
    console.error("PRIELAIDOS NETENKINAMOS — nieko nekeičiama:");
    for (const p of problemos) console.error(`  - ${p}`);
    console.error("\nAtlikite 1, 2 ir 2b žingsnius (žr. `docs/migrations.md`, cutover procedūra).");
    process.exitCode = 2;
    await uzdaryti();
    return;
  }

  const visi = await jobStore.system.listAll({ hydrate: false });
  const terminalizuotini = visi.filter((j) => NETERMINALŪS_JOBAI.includes(j.status));

  console.log(
    `Backend: ${backend}; job'ų iš viso ${visi.length}; terminalizuotinų ` +
      `${terminalizuotini.length} (${NETERMINALŪS_JOBAI.join(", ")}).`
  );

  if (!vykdyti) {
    for (const j of terminalizuotini) {
      console.log(`  [sausas] ${j.id} (${j.status}) storageKey=${j.storageKey ? "yra" : "nėra"}`);
    }
    console.log("\nSAUSAS PALEIDIMAS — niekas nepakeista. Kartokite su `--vykdyti`.");
    await uzdaryti();
    return;
  }

  let terminalizuota = 0;
  let audioIslaisvinta = 0;
  const nesekmes = [];

  for (const j of terminalizuotini) {
    try {
      await jobStore.system.finishFailed(j.id, {
        error: "Nutraukta per cutover į PostgreSQL",
        error_code: "CUTOVER",
      });
      terminalizuota += 1;
    } catch (klaida) {
      nesekmes.push({ id: j.id, zingsnis: "finishFailed", priezastis: klaida.message });
      continue;
    }

    /**
     * ⚠️ AUDIO IŠLAISVINAMAS PO TERMINALIZAVIMO, NE VIETOJ JO. Be šito liktų
     * pakibęs jautrus failas be jokio įrašo, kuris apie jį žinotų.
     */
    if (j.storageKey) {
      try {
        if (await releaseAudio(j.id, j.storageKey)) audioIslaisvinta += 1;
      } catch (klaida) {
        nesekmes.push({ id: j.id, zingsnis: "releaseAudio", priezastis: klaida.message });
      }
    }
  }

  console.log(`Terminalizuota: ${terminalizuota}; audio išlaisvinta: ${audioIslaisvinta}.`);

  if (nesekmes.length > 0) {
    console.error(`\nNEAPDOROTA ${nesekmes.length}:`);
    for (const n of nesekmes) console.error(`  - ${n.id} (${n.zingsnis}): ${n.priezastis}`);
    console.error("\n⚠️ 5b žingsnio NEVYKDYKITE, kol šie neišspręsti — jų hash'ai yra vienintelis šaltinis.");
    process.exitCode = 3;
  }

  await uzdaryti();
}

async function uzdaryti() {
  await closeTranscriptionQueue().catch(() => {});
  await jobStore.close().catch(() => {});
}
