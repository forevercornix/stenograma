const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const { STATUS, JOB_TYPES, OWNER_KIND } = require("../utils/jobStore/common");
const { PHASE } = require("../utils/jobPhase");
const { registerProcessors } = require("../queues/register");

/**
 * Atstato TIKRUOSIUS processor'ius.
 *
 * ⚠️ `jobRunner._processors` NEEKSPORTUOJAMAS – ankstesnė versija juo rėmėsi
 * (`jobRunner._processors ? ... : undefined`), tad `originalus` visada buvo
 * `undefined`, ir testinis processor'ius LIKDAVO globaliame registre. Tai būtų
 * nutekėję į kitus testus.
 *
 * `registerProcessors()` yra viešas kontraktas – juo ir naudojamės.
 */
function atstatytiProcessorius() {
  registerProcessors();
}

/**
 * #154, 5 žingsnis: TERMINALŪS, RETRY IR RECOVERY KELIAI.
 *
 * Ankstesni žingsniai padengė laimingą kelią. Šie testai tikrina, kad
 * `status × phase` invariantas galioja ir TEN, kur darbas nutrūksta – t. y.
 * ten, kur diagnostika svarbiausia ir kur klaidos pastebimos vėliausiai.
 */

async function naujas(type = JOB_TYPES.TRANSCRIPTION) {
  return jobStore.create({ type, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
}

/* ── autorizacijos atšaukimas ─────────────────────────────────────────── */

test("#154 SARGAS: tiesioginio `update(id, { status })` šablono nėra", () => {
  /**
   * ⚠️ ELGESIO, NE TEKSTO PATIKRA – bet čia sąmoningai statinė.
   *
   * `workerAuthorization.test.js` tikrino `grep AUTHORIZATION_REVOKED` ir dėl
   * to PRALEIDO tikrą regresiją: abu atšaukimo keliai rašė
   * `update({ status: FAILED })`, kurį #154 sargas meta. Produkcijoje jie būtų
   * kritę, o testas liko žalias, nes tekstas nepasikeitė.
   *
   * Šis sargas tikrina priešingą kryptį: kad tokio rašymo NĖRA.
   *
   * ⚠️ GARANTIJOS APIMTIS SIAURESNĖ, NEI GALI ATRODYTI. Tikrinamas TIK
   * tiesioginis `update(id, { status: ... })` šablonas keturių katalogų
   * TIESIOGINIUOSE `.js` failuose. Neaptinkama:
   *
   *   – subkatalogai (`providers/`, `utils/jobStore/` ir pan.);
   *   – netiesioginė forma:
   *
   *         const patch = { status: STATUS.FAILED };
   *         await jobStore.system.update(jobId, patch);
   *
   * Tikroji apsauga yra STORE sargas (`assertNoRawPhaseWrite`), kuris meta
   * klaidą vykdymo metu nepriklausomai nuo rašymo formos. Šis testas tik
   * pagreitina grįžtamąjį ryšį – pagauna dažniausią šabloną anksčiau nei
   * runtime. Kritiniai keliai turi TURĖTI ELGESIO testus (žr. žemiau), ne
   * remtis vien šiuo grep'u.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..");

  const pažeidimai = [];
  const katalogai = ["routes", "queues", "workers", "services"];

  for (const dir of katalogai) {
    const kelias = path.join(šaknis, dir);
    if (!fs.existsSync(kelias)) continue;

    for (const failas of fs.readdirSync(kelias).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(kelias, failas), "utf8");

      /**
       * ⚠️ TIKRINAMAS VISAS FAILAS, ne eilutė po eilutės.
       *
       * Pirmoji versija skenavo eilutėmis ir PRALEIDO daugiaeilius kvietimus:
       *
       *   await jobStore.system.update(jobId, {
       *     status: jobStore.STATUS.FAILED,     ← nematoma
       *
       * o būtent tokia forma ir buvo abu atšaukimo keliai. Mutacija praeidavo.
       */
      const šablonas = /\.update\(\s*[^,)]+,\s*\{[^}]*?\bstatus\s*:/gs;
      let m;
      while ((m = šablonas.exec(src)) !== null) {
        const eilute = src.slice(0, m.index).split("\n").length;
        pažeidimai.push(`${dir}/${failas}:${eilute}: ${m[0].replace(/\s+/g, " ").trim()}`);
      }
    }
  }

  assert.deepEqual(
    pažeidimai,
    [],
    "Statusą keičia TIK jobPhase metodai (startPhase/restart/finish):\n" + pažeidimai.join("\n")
  );
});

test("#154 ATŠAUKIMAS: INLINE kelias realiai pažymi job'ą failed", async (t) => {
  /**
   * Cleanup per `t.after()`, ne `finally`: jis suveikia ir tada, kai testas
   * nutrūksta ne dėl išimties (pvz. `assert` prieš `finally` bloką arba
   * timeout). `finally` čia irgi veiktų, bet `t.after()` yra Node testų
   * kontrakto dalis ir nepriklauso nuo to, kur atsidūrė `try`.
   */
  t.after(() => atstatytiProcessorius());

  /**
   * TIKRAS PRODUKCIJOS KELIAS, ne `finish()` semantika.
   *
   * ⚠️ Pirmoji šio testo versija kvietė `jobStore.system.finish()` tiesiogiai –
   * t. y. įrodinėjo tai, kas jau įrodyta 2 žingsnyje, o rastos regresijos
   * (`update({ status })` atšaukimo šakoje) NEPALIESDAVO. Tai buvo ta pati
   * klaida kaip `workerAuthorization.test.js`, tik kitame sluoksnyje.
   *
   * Čia autorizacija atmetama NATŪRALIAI: job'as neša `actorSource: "session"`
   * su vartotoju, kurio `AUTH_USERS` nebėra.
   */
  const job = await jobStore.create({
    type: JOB_TYPES.TRANSCRIPTION,
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
    actor: "istrintas-vartotojas",
    actorSource: "session",
  });

  let processorKviestas = false;
  jobRunner.registerProcessor("transcription", async () => {
    processorKviestas = true;
    return { text: "neturėtų būti" };
  });

  await jobRunner._runInline("transcription", job.id, {});
  const po = await jobStore.system.get(job.id);

  assert.equal(processorKviestas, false, "darbas neturi prasidėti");
  assert.equal(po.status, STATUS.FAILED, "job'as pažymėtas failed");
  assert.equal(po.error_code, "AUTHORIZATION_REVOKED");
  assert.equal(po.phase, null, "fazė išvalyta");
  assert.equal(po.progress, null);
  assert.equal(po.progressKnown, false);
});

test("#154 ATŠAUKIMAS: WORKER kelias naudoja TĄ PATĮ finish() metodą", () => {
  /**
   * ⚠️ STRUKTŪRINIS, NE ELGESIO TESTAS.
   *
   * Inline kelias turi tikrą elgesio padengimą (testas aukščiau vykdo
   * `_runInline()`). Šis tikrina tik SOURCE lygį – worker'io šakai paleisti
   * reikėtų tikro BullMQ. Mutacija krinta, bet runtime kelias nevykdomas.
   *
   * Vertinga tiek, kiek abi implementacijos lieka simetriškos. Joms
   * išsiskyrus, čia reikės tikro worker'io testo.
   *
   * ⚠️ Tikrinamas visas failas, ne fiksuoto dydžio langas prieš kodą.
   * Ankstesnė versija ėmė 400–500 simbolių ir krito dėl to, kad komentaras
   * ilgesnis nei langas – patikra, priklausanti nuo komentaro ilgio, nieko
   * neįrodo.
   *
   * Kartu skenuojamas ir tekstas be komentarų, kad patikra nepagautų savo
   * pačios dokumentacijos.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..");

  for (const failas of ["queues/jobRunner.js", "workers/index.js"]) {
    const src = fs
      .readFileSync(path.join(šaknis, failas), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const i = src.indexOf("AUTHORIZATION_REVOKED");
    assert.ok(i > 0, `${failas}: atšaukimo šaka turi egzistuoti KODE, ne tik komentare`);

    /**
     * Ieškom artimiausio kvietimo PRIEŠ kodą – be komentarų jis šalia.
     *
     * ⚠️ PRIIMAMI ABU TERMINALŪS KELIAI (#184, 7.5b). `finishFailed()` yra
     * `finish(FAILED, …)` su konfliktų politika, o ne jo apėjimas: jis kviečia
     * TĄ PATĮ `jobPhase.finish()` per `system.finish` kūną. Garantija, kurią šis
     * testas saugo, nepakito – draudžiamas lieka neapdorotas `update({status})`.
     */
    const priesKoda = src.slice(0, i);
    const paskutinisFinish = Math.max(
      priesKoda.lastIndexOf(".finish("),
      priesKoda.lastIndexOf(".finishFailed(")
    );
    const paskutinisUpdate = priesKoda.lastIndexOf(".update(");

    assert.ok(paskutinisFinish > 0, `${failas}: turi naudoti finish() arba finishFailed()`);
    assert.ok(
      paskutinisFinish > paskutinisUpdate,
      `${failas}: artimiausias kvietimas prieš AUTHORIZATION_REVOKED turi būti finish(), ne update()`
    );
  }
});

/* ── retry ────────────────────────────────────────────────────────────── */

test("#154 RETRY: pakartotinis paleidimas iš BET KURIOS fazės grąžina į pradžią", async () => {
  /**
   * BullMQ retry paleidžia processor'ių iš naujo, o job'as gali būti bet
   * kurioje fazėje – worker'is galėjo kristi vykdymo metu.
   */
  for (const faze of [PHASE.VALIDATING, PHASE.TRANSCRIBING, PHASE.DIARIZING, PHASE.MERGING]) {
    const job = await naujas();
    await jobStore.system.restart(job.id);

    // Nuvedam iki norimos fazės.
    const kelias = [PHASE.VALIDATING, PHASE.TRANSCRIBING, PHASE.DIARIZING, PHASE.MERGING];
    for (const f of kelias.slice(1, kelias.indexOf(faze) + 1)) {
      await jobStore.system.startPhase(job.id, f);
    }

    const po = await jobStore.system.restart(job.id, { attempt_count: 2 });

    assert.equal(po.phase, PHASE.VALIDATING, `retry iš ${faze} grąžina į validating`);
    assert.equal(po.progress, null, "progresas resetinamas");
    assert.equal(po.attempt_count, 2);
  }
});

test("#154 RETRY: terminalaus job'o perpaleisti NEGALIMA", async () => {
  /**
   * Vėluojanti eilės žinutė neturi „atgaivinti" jau baigto darbo. Be šios
   * patikros `completed` job'as grįžtų į `processing` ir vartotojas matytų
   * pažangą darbe, kuris jau baigtas.
   */
  for (const status of [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]) {
    const job = await naujas();
    await jobStore.system.restart(job.id);
    /** ⚠️ `completed` reikalauja rezultato (#184, C11). */
    await jobStore.system.finish(job.id, status, status === STATUS.COMPLETED ? { result: { text: "ok" } } : {});

    await assert.rejects(
      () => jobStore.system.restart(job.id),
      (e) => e.code === "JOB_ALREADY_TERMINAL",
      `${status} job'o perpaleisti negalima`
    );
  }
});

/* ── klaidos klasifikacija ────────────────────────────────────────────── */

test("#154 KLAIDA: nelegalus perėjimas job'ą pažymi SAVO kodu", async (t) => {
  t.after(() => atstatytiProcessorius());

  /**
   * Jei fazės klaida įvyktų vykdymo metu, job'as turi baigtis su domeniniu
   * kodu, ne `internal_error` – state corruption reikalauja kitokio tyrimo nei
   * laikinas tiekėjo gedimas.
   */
  const { JobPhaseError } = require("../utils/jobPhase");
  const job = await naujas();

  jobRunner.registerProcessor("transcription", async () => {
    throw new JobPhaseError("neleistinas perėjimas", "ILLEGAL_TRANSITION");
  });

  await jobRunner._runInline("transcription", job.id, {});
  const po = await jobStore.system.get(job.id);

  assert.equal(po.status, STATUS.FAILED);
  assert.equal(po.error_code, "ILLEGAL_TRANSITION", "ne internal_error");
  assert.equal(po.phase, null, "fazė išvalyta net klaidos atveju");
});

/* ── recovery ─────────────────────────────────────────────────────────── */

test("#154 RECOVERY: nutrūkęs job'as lieka processing su fazе, ne pakibęs be jos", async () => {
  /**
   * Worker'iui kritus job'as lieka `processing`. Svarbu, kad jis turėtų FAZĘ –
   * kitaip UI rodytų „apdorojama", nežinodama ko, ir stalled recovery negalėtų
   * pasakyti, kur darbas nutrūko.
   *
   * `processing + phase=null` yra neleistinas derinys (#154), tad šis testas
   * fiksuoja, kad jis neatsiranda net nutrūkus.
   */
  const job = await naujas();
  await jobStore.system.restart(job.id);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 1872, total: 4420 },
  });

  // Worker'is „krinta" – jokio finish() nekviečiama.
  const po = await jobStore.system.get(job.id);

  assert.equal(po.status, STATUS.PROCESSING);
  assert.equal(po.phase, PHASE.TRANSCRIBING, "matoma, KUR nutrūko");
  assert.deepEqual(po.progress, { current: 1872, total: 4420 });
});

test("#154 RECOVERY: persistintas progresas NĖRA media-level resume pažadas", async () => {
  /**
   * Dokumentacinis invariantas (#154, 8 punktas). Persistintas `1872/4420`
   * reiškia „tiek buvo parodyta", ne „Whisper tęs nuo 1872 sekundės".
   *
   * Po perpaleidimo progresas resetinamas – jei jį paliktume, UI rodytų 42 %,
   * kai realus darbas yra ties 0 %.
   */
  const job = await naujas();
  await jobStore.system.restart(job.id);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 1872, total: 4420 },
  });

  const po = await jobStore.system.restart(job.id, { attempt_count: 2 });

  assert.equal(po.progress, null, "progresas NEIŠSAUGOMAS – jis nereiškia resume taško");
  assert.equal(po.progressKnown, false);
});
