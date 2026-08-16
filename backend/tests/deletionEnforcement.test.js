const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";

const tombstones = require("../utils/deletionTombstones");
const jobStore = require("../utils/jobStore");
const lifecycleService = require("../services/lifecycleService");

/**
 * #19 PR3: WORKER'IAI NEGALI ATKURTI ARTEFAKTŲ PO IŠTRYNIMO.
 *
 * PR2 žymas UŽDĖJO, bet niekas jų netikrino – tad vėluojanti eilės žinutė ar
 * pasenęs worker'is vis dar galėjo atkurti tai, ko kaip tik atsikratėme, ir
 * ištrynimas būdavo laikinas.
 */

test.after(() => {
  tombstones._stopSweepForTests();
});

test("APSAUGA: `jobStore.update` atmeta atnaujinimą po ištrynimo", async () => {
  /**
   * Patikra padėta į `update`, nes tai VIENINTELIS kelias, kuriuo jobo įrašas
   * keičiasi – inline, worker'yje ir retencijoje. Patikra prie kiekvieno
   * kvietėjo reikštų kelias dešimtis vietų, iš kurių viena anksčiau ar vėliau
   * būtų pamiršta, ir spraga būtų tyli.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  assert.ok(await jobStore.system.update(job.id, { status: jobStore.STATUS.PROCESSING }), "prieš žymą – leidžiama");

  tombstones.mark(job.id, { actor: "sysadmin" });

  assert.equal(
    await jobStore.system.update(job.id, { status: jobStore.STATUS.COMPLETED }),
    null,
    "po žymos atnaujinimas turi būti ATMESTAS"
  );
});

test("APSAUGA: apėjimui reikia SIMBOLIO, `true` neveikia", async () => {
  /**
   * Pirmoji versija priėmė `{ allowAfterDeletion: true }` – per galingas
   * „escape hatch": bet kuris naujas kvietėjas galėjo jį parašyti netyčia (ar
   * bandydamas „pataisyti" atmestą atnaujinimą) ir vėl atidaryti kelią
   * artefaktų kūrimui po ištrynimo.
   *
   * `Symbol` negalima atspėti, atsitiktinai įrašyti ar perduoti iš JSON
   * konfigūracijos – reikia eksplicitiškai importuoti.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  tombstones.mark(job.id, { actor: "sysadmin" });

  assert.equal(
    await jobStore.system.update(job.id, { status: jobStore.STATUS.FAILED }, { allowAfterDeletion: true }),
    null,
    "`true` NETURI atidaryti apėjimo"
  );

  assert.ok(
    await jobStore.system.update(
      job.id,
      { status: jobStore.STATUS.FAILED },
      { allowAfterDeletion: jobStore.LIFECYCLE_INTERNAL }
    ),
    "tik simbolis leidžia apeiti"
  );
});

test("APSAUGA: vidinį raktą mini TIK leidžiami failai", () => {
  /**
   * Simbolis apsaugo nuo ATSITIKTINIO apėjimo, bet ne nuo sąmoningo. Ši
   * patikra padaro sąmoningą naudojimą matomą: naujas failas, importuojantis
   * `LIFECYCLE_INTERNAL`, sulaužo testą ir patenka į peržiūrą.
   */
  const fs = require("fs");
  const path = require("path");

  const ALLOWED = new Set([
    "utils/jobStore/index.js", // pats apibrėžimas
    "tests/deletionEnforcement.test.js", // ši patikra
  ]);

  const offenders = [];

  function scan(dir, prefix = "") {
    for (const entry of fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        scan(`${dir}/${entry.name}`, rel);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;

      const source = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      if (/LIFECYCLE_INTERNAL/.test(source) && !ALLOWED.has(rel)) offenders.push(rel);
    }
  }

  for (const dir of ["utils", "services", "routes", "queues", "workers", "tests"]) scan(dir);

  assert.deepEqual(offenders, [], `vidinį raktą mini neleidžiami failai:\n${offenders.join("\n")}`);
});

test("APSAUGA: `pending` žyma irgi blokuoja – ne tik `deleted`", async () => {
  /**
   * Kol ištrynimas VYKSTA, artefaktų kurti negalima lygiai taip pat. Priešingu
   * atveju worker'is spėtų įsiterpti tarp žymos ir šalinimo – būtent tas langas,
   * dėl kurio žyma uždedama pirma.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  tombstones.mark(job.id, { actor: "x" }); // status = deletion_pending
  assert.equal(tombstones.isConfirmedDeleted(job.id), false, "dar nepatvirtinta");

  assert.equal(
    await jobStore.system.update(job.id, { status: jobStore.STATUS.COMPLETED }),
    null,
    "vykstant ištrynimui atnaujinimas irgi atmetamas"
  );
});

test("APSAUGA: nepavykęs ištrynimas NEATIDARO kelio atgal", async () => {
  /**
   * `deletion_failed` reiškia „nepavyko", ne „atšaukta". Jei po nesėkmės
   * worker'is vėl galėtų kurti artefaktus, nepavykęs trynimas prikurtų dar
   * daugiau to, ką bandom pašalinti.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  tombstones.mark(job.id, { actor: "x" });
  tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.FAILED);

  assert.equal(await jobStore.system.update(job.id, { status: jobStore.STATUS.COMPLETED }), null);
});

test("LENKTYNĖS: ištrynimas VYKDYMO metu neleidžia užbaigti darbo", async () => {
  /**
   * Realus scenarijus: worker'is dirba, administratorius spaudžia DELETE.
   * Darbas neturi „užsibaigti" ir įrašyti rezultato – tai būtų naujas
   * artefaktas ištrintam jobui.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: jobStore.STATUS.PROCESSING });

  // Ištrynimas įvyksta VIDURYJE darbo.
  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  // Worker'is bando įrašyti rezultatą.
  const afterDeletion = await jobStore.system.update(job.id, {
    status: jobStore.STATUS.COMPLETED,
    result: { protokolas: "neturėtų išlikti" },
  });

  assert.equal(afterDeletion, null, "rezultatas NEGALI būti įrašytas po ištrynimo");
  assert.equal(await jobStore.system.get(job.id), null, "jobo įrašo neturi būti");
});

test("STRUKTŪRA: ABU vykdymo keliai tikrina žymą PRIEŠ darbą", () => {
  /**
   * Jei tik vienas kelias tikrintų, ištrynimo garantija priklausytų nuo to, ar
   * sukonfigūruotas Redis – t. y. būtų nenuspėjama.
   *
   * Tikrinam KVIETIMĄ, ne vien identifikatorių: importo eilutė faile lieka ir
   * pašalinus patikrą (ta pati klaida, kurią jau padariau #18 PR3).
   */
  const fs = require("fs");
  const path = require("path");

  for (const file of ["../workers/index.js", "../queues/jobRunner.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");

    /**
     * Priimam ABI rašymo formas – tiesioginę sąlygą ir per kintamąjį.
     * Pirmoji versija tikrino tik `if (tombstones.isDeleted(jobId))`, tad
     * nekalta refaktorizacija į `const deleted = ...; if (deleted)` būtų
     * sulaužiusi testą, nors apsauga liktų vietoje.
     */
    assert.match(
      source,
      /tombstones\.isDeleted\(jobId\)/,
      `${file} turi tikrinti ištrynimo žymą prieš vykdymą`
    );
  }
});

test("STRUKTŪRA: worker'is NEMETA klaidos dėl ištrinto jobo", () => {
  /**
   * Klaida priverstų BullMQ kartoti, o kartojimas niekada nepavyks – jobas
   * ištrintas visam laikui. Tyliai užbaigiam, kad žinutė dingtų iš eilės.
   *
   * Be to worker'is gautų `null` iš `jobStore.update` ir mestų „įrašas
   * nerastas" – teisingas rezultatas su klaidinga priežastimi, kurią būtų
   * sunku diagnozuoti.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../workers/index.js"), "utf8");

  const guard = source.match(/if \(tombstones\.isDeleted\(jobId\)\) \{[\s\S]*?\n {6}\}/);
  assert.ok(guard, "patikra turi egzistuoti");

  assert.ok(!/throw/.test(guard[0]), "praleidimas neturi mesti klaidos – BullMQ kartotų amžinai");
  assert.match(guard[0], /return/, "turi tyliai užbaigti");
});

test("RETENCIJA: valymas paleidžiamas IŠKART po starto, ne po intervalo", () => {
  /**
   * Be pradinio ciklo po restarto pasenę duomenys liktų dar visą intervalą
   * (numatytai valandą). Automatinei retencijai tai per ilgai – ir būtent po
   * restarto sistemoje dažniausiai būna likučių.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../utils/retentionSweeper.js"), "utf8");

  assert.match(source, /runImmediately\s*=\s*true/, "pradinis ciklas turi būti numatytasis");
});

test("ŽYMOS: restartas jas praranda – riba dokumentuota, ne praleista", () => {
  /**
   * Sąžiningumo testas: žymos gyvena tik atmintyje, tad po restarto vėluojanti
   * eilės žinutė vėl galėtų kurti artefaktus.
   *
   * Testas fiksuoja, kad tai ŽINOMA ir UŽRAŠYTA. Be tokio įrašo riba ilgainiui
   * taptų nematoma, o dokumentacija tvirtintų daugiau, nei sistema daro.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../utils/deletionTombstones.js"), "utf8");

  assert.match(source, /TIK ATMINTYJE|tik atmintyje/i, "riba turi būti įvardyta kode");
  assert.match(source, /[Rr]estartas/, "restarto poveikis turi būti įvardytas");
});
