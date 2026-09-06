const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const backupService = require("../services/backupService");
const jobStore = require("../utils/jobStore");

/**
 * HIDRATACIJOS VĖLIAVA — KELIAS, KURIS JĄ PERDUODA (#157, PR-3).
 *
 * ⚠️ KODĖL ATSKIRAI NUO INTEGRACINIO TESTO.
 *
 * `jobStoreHydration.integration` įrodo, kad `hydrate: false` REALIAI neskaito
 * turinio, bet jam reikia tikros PostgreSQL. Čia tikrinama kita pusė, vykdoma
 * kiekvienam commit'ui: (1) projekcijos FORMA vienoda visuose backend'uose ir
 * (2) `countActiveJobs()` tą vėliavą tikrai perduoda.
 *
 * ⚠️ ANTROJI DALIS YRA SAITAS SU KVIETIMO VIETA, ne „niekas nekviečia" tvirtinimas:
 * pašalinus `{ hydrate: false }` iš `countActiveJobs()`, testas krenta.
 */

test("nehidratuota projekcija: `result` lauko NĖRA (atminties backend'as)", async () => {
  /**
   * ⚠️ `null` reikštų „rezultato nėra" (`common.js` `rezultatoNera()`) — melas apie
   * job'ą, kurio rezultatas yra. Lauko nebuvimas yra tas pats mechanizmas, kurį jau
   * naudoja `schemaVersion`.
   */
  const job = await memoryStore.create({
    type: "transcription",
    ownerId: "u1",
    ownerKind: "user",
  });
  await memoryStore.update(job.id, { status: "completed", result: { text: "yra" } });

  const hidratuotas = await memoryStore.get(job.id);
  assert.deepEqual(hidratuotas.result, { text: "yra" }, "numatytas kelias nepakitęs");

  const metaduomenys = await memoryStore.get(job.id, { hydrate: false });
  assert.equal("result" in metaduomenys, false, "nehidratuotas job'as `result` neturi");
  assert.equal(metaduomenys.status, "completed", "bet metaduomenys pilni");

  const sarasas = await memoryStore.listAll({ hydrate: false });
  assert.ok(sarasas.every((j) => !("result" in j)), "sąrašas elgiasi taip pat");

  /** ⚠️ KONTROLĖ: originalas saugykloje NEPRARADO rezultato. */
  assert.deepEqual((await memoryStore.get(job.id)).result, { text: "yra" });
});

test("`countActiveJobs()` prašo METADUOMENŲ, ne turinio", async (t) => {
  const originalus = jobStore.system.listAll;
  const kvietimai = [];

  jobStore.system.listAll = async (nustatymai) => {
    kvietimai.push(nustatymai);
    return [
      { id: "a", status: "processing" },
      { id: "b", status: "completed" },
    ];
  };
  t.after(() => {
    jobStore.system.listAll = originalus;
  });

  const skaicius = await backupService.countActiveJobs();

  assert.equal(skaicius, 1, "skaičiuojamos BŪSENOS — elgesys nepakitęs");
  assert.deepEqual(
    kvietimai,
    [{ hydrate: false }],
    "priežiūros kelias privalo eksplicitiškai atsisakyti hidratacijos"
  );
});

test("#157 PR-4: `system.get()` REIKALAUJA eksplicitinio `hydrate`", async () => {
  /**
   * ⚠️ AIBĖ NUSTOJA BŪTI SURAŠOMA.
   *
   * PR-3 metu keturios paieškos davė keturis nepilnus sąrašus, ir visos rėmėsi
   * SINTAKSINIU raktu (store metodas → maršrutas → `jobStore.get()` vardas →
   * adapteris). Adapteris `store` perpakuoja nauju vardu, tad paieška pagal vardą
   * dingsta kartu su vardu; penktas grep duotų penktą nepilną sąrašą.
   *
   * Apvertus numatytąją reikšmę, praleistus kvietėjus parodo TESTAI, ne atmintis.
   *
   * ⚠️ IŠMATUOTAS REZULTATAS: apvertimas atskleidė NULĮ naujų GAMYBOS kvietėjų — visi
   * septyni jau buvo PR-3 lentelėje. Tai reiškia, kad keturios paieškos galiausiai buvo
   * pilnos gamybos kodui; bet tai žinoma tik DABAR, po struktūrinės patikros, o ne
   * tada, kai sąrašas buvo skelbiamas baigtu. Skirtumas tarp „buvo teisinga" ir
   * „buvo įrodyta".
   */
  const jobStore = require("../utils/jobStore");

  await assert.rejects(
    () => jobStore.system.get("11111111-1111-1111-1111-111111111111"),
    (klaida) => klaida instanceof TypeError && /hydrate` privalomas/.test(klaida.message),
    "be vėliavos kvietimas privalo kristi, o ne tyliai grąžinti turinį"
  );

  for (const bloga of [{}, { hydrate: "taip" }, { hydrate: null }, null]) {
    await assert.rejects(
      () => jobStore.system.get("11111111-1111-1111-1111-111111111111", bloga),
      (klaida) => klaida instanceof TypeError,
      `${JSON.stringify(bloga)}: netinkama reikšmė nėra pasirinkimas`
    );
  }

  /** KONTROLĖ: abi teisėtos reikšmės praeina — kitaip tai būtų neveikiantis metodas. */
  for (const hydrate of [true, false]) {
    assert.equal(
      await jobStore.system.get("11111111-1111-1111-1111-111111111111", { hydrate }),
      null,
      `hydrate: ${hydrate} privalo veikti (job'o nėra, tad \`null\`)`
    );
  }

  /**
   * ⚠️ VIEŠAS KELIAS NEPAKITĘS: ten sprendimą priima OPERACIJA
   * (`jobAccessPolicy.reikiaRezultato()`), tad kvietėjui nėra ko pasirinkti.
   */
  assert.equal(typeof jobStore.get, "function");
});
