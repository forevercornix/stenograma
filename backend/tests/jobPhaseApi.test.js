const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";

const app = require("../server");
const jobStore = require("../utils/jobStore");
const { PHASE } = require("../utils/jobPhase");
const { STATUS, JOB_TYPES, OWNER_KIND } = require("../utils/jobStore/common");
const { NEVIEŠI_LAUKAI } = require("../utils/jobResponse");

app._setReadyForTests();

/**
 * #154, 6 žingsnis: FAZĖS HTTP ATSAKYME.
 *
 * Fazės jau egzistuoja store'e, bet iki šiol vartotojas jų nematė. Šie testai
 * tikrina, kad kontraktas pasiekia klientą IR kad jis vienodas abiejuose
 * endpoint'uose.
 */

async function naujas(type = JOB_TYPES.PROTOCOL) {
  return jobStore.create({ type, ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
}

const KELIAI = [
  ["/api/jobs", JOB_TYPES.PROTOCOL],
  ["/api/transcribe-jobs", JOB_TYPES.TRANSCRIPTION],
];

/* ── kontrakto vienodumas ─────────────────────────────────────────────── */

test("#154 API: ABU endpoint'ai grąžina TĄ PATĮ fazių kontraktą", async () => {
  /**
   * ⚠️ Anksčiau atsakymai buvo sudaromi RANKINIU BŪDU, laukas po lauko, ir jau
   * buvo išsiskyrę: `/api/transcribe-jobs` grąžindavo `progress`,
   * `/api/jobs` – ne. Klientas negali priklausyti nuo to, kurį endpoint'ą
   * kviečia.
   */
  for (const [kelias, type] of KELIAI) {
    const job = await naujas(type);
    const res = await request(app).get(`${kelias}/${job.id}`);

    assert.equal(res.status, 200, kelias);
    for (const laukas of ["phase", "progress", "progressKnown"]) {
      assert.ok(laukas in res.body, `${kelias}: trūksta lauko ${laukas}`);
    }
  }
});

test("#154 API: naujas job'as – phase=null, progressKnown=false", async () => {
  for (const [kelias, type] of KELIAI) {
    const job = await naujas(type);
    const res = await request(app).get(`${kelias}/${job.id}`);

    assert.equal(res.body.status, STATUS.QUEUED, kelias);
    assert.equal(res.body.phase, null, `${kelias}: queued neturi fazės`);
    assert.equal(res.body.progress, null);
    assert.equal(res.body.progressKnown, false);
  }
});

/* ── fazė matoma vykdymo metu ─────────────────────────────────────────── */

test("#154 API: processing job'as rodo FAZĘ ir progresą", async () => {
  const job = await naujas(JOB_TYPES.TRANSCRIPTION);
  await jobStore.system.restart(job.id);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 1872, total: 4420 },
  });

  const res = await request(app).get(`/api/transcribe-jobs/${job.id}`);

  assert.equal(res.body.status, STATUS.PROCESSING);
  assert.equal(res.body.phase, PHASE.TRANSCRIBING, "vartotojas mato, KAS vyksta");
  assert.deepEqual(res.body.progress, { current: 1872, total: 4420 });
  assert.equal(res.body.progressKnown, true);
});

test("#154 API: diarizacijos fazė rodoma su progressKnown=false", async () => {
  /**
   * Būtent tas atvejis, dėl kurio #154 pradėtas: transkripcija pasiekia 100 %,
   * diarizacija progreso neteikia, ir vartotojui atrodo, kad darbas pakibo.
   *
   * Dabar atsakymas tai atskiria: fazė pasikeitė, progresas nežinomas – tai NE
   * „užstrigo ties 100 %".
   */
  const job = await naujas(JOB_TYPES.TRANSCRIPTION);
  await jobStore.system.restart(job.id);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
    progress: { current: 4420, total: 4420 },
  });
  await jobStore.system.startPhase(job.id, PHASE.DIARIZING);

  const res = await request(app).get(`/api/transcribe-jobs/${job.id}`);

  assert.equal(res.body.phase, PHASE.DIARIZING);
  assert.equal(res.body.progress, null, "NE užstrigęs 100 %");
  assert.equal(res.body.progressKnown, false, "UI turi rodyti indeterminate");
});

test("#154 API: terminalus job'as fazės NEBETURI", async () => {
  const job = await naujas(JOB_TYPES.PROTOCOL);
  await jobStore.system.restart(job.id);
  await jobStore.system.startPhase(job.id, PHASE.GENERATING_PROTOCOL);
  await jobStore.system.finish(job.id, STATUS.COMPLETED, { result: { x: 1 } });

  const res = await request(app).get(`/api/jobs/${job.id}`);

  assert.equal(res.body.status, STATUS.COMPLETED);
  assert.equal(res.body.phase, null);
  assert.equal(res.body.progress, null);
  assert.equal(res.body.progressKnown, false);
});

/* ── vidiniai laukai ──────────────────────────────────────────────────── */

test("#154 API: vidiniai job laukai į atsakymą NEPATENKA", async () => {
  /**
   * Serializatorius naudoja ALLOWLIST, ne `{ ...job }`. Job įrašas turi
   * tapatybės (`actor`, `ownerId`) ir saugyklos (`storageKey`) detalių, kurių
   * klientui matyti nereikia.
   *
   * ⚠️ Su `{ ...job }` kiekvienas NAUJAS įrašo laukas automatiškai atsidurtų
   * atsakyme – įskaitant tuos, kurių niekas nesvarstė kaip viešų.
   */
  /**
   * ⚠️ KIEKVIENAM endpoint'ui – SAVO TIPO job'as, ir 200 REIKALAUJAMAS.
   *
   * Pirmoji versija kūrė vieną `transcription` job'ą, siuntė jį į abu kelius ir
   * darė `if (res.status !== 200) continue`. Tai reiškė, kad bet kokia
   * regresija – 401, 403, 404, 500 – paverstų testą „praėjusiu". Tikrinti
   * nutekėjimą galima tik atsakyme, kuris realiai grąžintas.
   */
  for (const [kelias, type] of KELIAI) {
    const job = await jobStore.create({
      type,
      ownerKind: OWNER_KIND.UNOWNED,
      ownerId: null,
      storageKey: "audio/slaptas-raktas.wav",
      actor: "vidinis-vartotojas",
    });

    const res = await request(app).get(`${kelias}/${job.id}`);
    assert.equal(res.status, 200, `${kelias}: atsakymas privalo būti 200`);

    for (const laukas of NEVIEŠI_LAUKAI) {
      assert.equal(
        laukas in res.body,
        false,
        `${kelias}: vidinis laukas "${laukas}" nutekėjo į atsakymą`
      );
    }
  }
});

test("#154 API: progressKnown yra BOOLEAN, ne string", async () => {
  /**
   * Redis viską grąžina kaip string'ą, o `"false"` yra truthy. Jei konversija
   * kada nors iškristų iš `BOOLEAN_FIELDS`, UI matytų „progresas žinomas" ten,
   * kur jo nėra. HTTP lygis yra paskutinė vieta, kur tai pastebima.
   */
  const job = await naujas(JOB_TYPES.TRANSCRIPTION);
  const res = await request(app).get(`/api/transcribe-jobs/${job.id}`);

  assert.equal(typeof res.body.progressKnown, "boolean");
});

/* ══════════════════════════════════════════════════════════════════════════
 * SERIALIZATORIAUS KONTRAKTAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 SERIALIZATORIUS: `extra` NEGALI perrašyti kanoninių laukų", () => {
  /**
   * Su `...extra` gale endpoint'as galėtų perduoti `{ status: "completed" }`
   * ir tyliai pakeisti state machine rezultatą atsakyme. Šiandien vienintelis
   * caller'is perduoda tik `variant`, tad problema neišnaudojama – bet
   * kontraktas ją leistų.
   *
   * Konfliktas yra PROGRAMAVIMO klaida: endpoint'as neturi turėti savo nuomonės
   * apie `status` ar `phase`.
   */
  const { serializeJob, REZERVUOTI } = require("../utils/jobResponse");
  const job = {
    id: "x",
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progressKnown: false,
  };

  for (const laukas of REZERVUOTI) {
    assert.throws(
      () => serializeJob(job, { [laukas]: "piktavališka" }),
      (e) => e instanceof TypeError && /negali perrašyti/.test(e.message),
      `${laukas} turi būti apsaugotas`
    );
  }

  // Endpoint'ui specifinis laukas praeina.
  const res = serializeJob(job, { variant: "original" });
  assert.equal(res.variant, "original");
  assert.equal(res.status, STATUS.PROCESSING, "kanoninis laukas nepakito");
});

test("#154 SERIALIZATORIUS: ne-boolean progressKnown yra KLAIDA, ne tylus vertimas", () => {
  /**
   * ⚠️ `Boolean("false") === true`. Tylus konvertavimas paverstų „progresas
   * nežinomas" į „žinomas", ir UI rodytų procentą ten, kur jo nėra – neteisinga
   * reikšmė atrodytų visiškai validi.
   *
   * Tai signalas, kad store normalizacija neveikia (laukas iškrito iš
   * `BOOLEAN_FIELDS`), o ne vartotojo įvestis.
   */
  const { serializeJob } = require("../utils/jobResponse");
  const bazė = { id: "x", status: STATUS.PROCESSING };

  for (const bloga of ["false", "true", 0, 1, "", "yes"]) {
    assert.throws(
      () => serializeJob({ ...bazė, progressKnown: bloga }),
      (e) => e instanceof TypeError && /BOOLEAN_FIELDS/.test(e.message),
      `${JSON.stringify(bloga)} turi būti atmesta`
    );
  }

  // `undefined`/`null` – legacy įrašai, jiems `false` teisinga.
  assert.equal(serializeJob({ ...bazė }).progressKnown, false);
  assert.equal(serializeJob({ ...bazė, progressKnown: null }).progressKnown, false);
  assert.equal(serializeJob({ ...bazė, progressKnown: true }).progressKnown, true);
});

test("#154 SERIALIZATORIUS: REZERVUOTI sąrašas SUTAMPA su realiais laukais", () => {
  /**
   * ⚠️ RANKINIS SĄRAŠAS BE ŠIO TESTO BŪTŲ SKOLA.
   *
   * `REZERVUOTI` naudojamas apsaugoti kanoninius laukus nuo `extra`
   * perrašymo. Pridėjus naują lauką į `serializeJob()`, bet pamiršus sąrašą,
   * jį būtų galima perrašyti – ir niekas apie tai nepraneštų.
   *
   * Vietoj priminimo komentare sinchronizacija tikrinama: sąrašas turi
   * ATITIKTI realiai grąžinamus laukus, be trūkstamų ir be perteklinių.
   */
  const { serializeJob, REZERVUOTI } = require("../utils/jobResponse");

  const grąžinami = Object.keys(
    serializeJob({ id: "x", status: STATUS.QUEUED, progressKnown: false })
  );

  const trūksta = grąžinami.filter((k) => !REZERVUOTI.has(k));
  const pertekliniai = [...REZERVUOTI].filter((k) => !grąžinami.includes(k));

  assert.deepEqual(
    trūksta,
    [],
    `serializeJob() grąžina laukus, kurių nėra REZERVUOTI – juos galima perrašyti per extra: ${trūksta.join(", ")}`
  );
  assert.deepEqual(
    pertekliniai,
    [],
    `REZERVUOTI turi laukų, kurių serializeJob() negrąžina: ${pertekliniai.join(", ")}`
  );
});

test("#154 SERIALIZATORIUS: NEVIEŠI_LAUKAI realiai egzistuoja job įraše", () => {
  /**
   * Antras rankinis sąrašas. Jei jame būtų laukas, kurio įraše nėra, testas
   * tikrintų nieko ir kurtų saugumo iliuziją.
   *
   * ⚠️ Tikrinama tik tai, kad sąrašo įrašai NĖRA pasenę. Išsamumo garantijos
   * nėra – naujas vidinis laukas čia automatiškai nepateks. Tikroji apsauga
   * yra pati allowlist forma (`serializeJob` grąžina TIK išvardytus laukus),
   * o šis sąrašas naudojamas testui.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { NEVIEŠI_LAUKAI } = require("../utils/jobResponse");

  /**
   * Tikrinama prieš `jobStore` KODĄ, ne `newJob()` rezultatą.
   *
   * ⚠️ Pirmoji versija lygino su `newJob()` grąžinamu objektu ir pažymėjo
   * `deletion_pending` bei `deletion_attempts` kaip pasenusius. Jie realiai
   * egzistuoja (`common.js:393`, `index.js:391`), tik pridedami VĖLIAU, ne
   * kūrimo metu. Testas, remiantis pradine forma, būtų vertęs šalinti
   * teisingus įrašus iš sąrašo.
   */
  const šaltinis = ["common.js", "index.js", "redisStore.js", "memoryStore.js"]
    .map((f) => path.resolve(__dirname, "..", "utils", "jobStore", f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

  const pasenę = NEVIEŠI_LAUKAI.filter((k) => !šaltinis.includes(k));

  assert.deepEqual(
    pasenę,
    [],
    `NEVIEŠI_LAUKAI mini laukus, kurių jobStore kode nebėra: ${pasenę.join(", ")}`
  );
});
