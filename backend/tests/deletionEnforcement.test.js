const { markCompleted } = require("./helpers/jobPhaseFixtures");
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

  assert.ok(await jobStore.system.restart(job.id), "prieš žymą – leidžiama");

  await tombstones.mark(job.id, { reason: "user_request" });

  assert.equal(
    await markCompleted(jobStore.system, job.id),
    null,
    "po žymos atnaujinimas turi būti ATMESTAS"
  );
});

test("VYKDYMAS: be žymos jobas NEPRALEIDŽIAMAS - priešinga kryptis", async () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL #183 P0 (DoD proof gap 1).
   *
   * Nuo 7.5a `isDeleted()` asinchroninis, o `Promise` yra truthy. Pamiršus
   * `await`, KIEKVIENAS jobas būtų praleistas kaip ištrintas: apdorojimas
   * sustotų visiškai, o testai, tikrinantys tik „su žyma - praleidžiama",
   * liktų žali. „Viskas blokuojama" atrodytų kaip sėkmė.
   *
   * Todėl tikrinamos ABI kryptys tame pačiame teste ir tuo pačiu keliu.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const jobRunner = require("../queues/jobRunner");
  const vykdyta = [];

  /** ⚠️ Parašas yra `(payload, jobId)` - žr. `_executeInline`. */
  jobRunner.registerProcessor("transcription", async (payload, jobId) => {
    vykdyta.push(jobId);
    return { text: "ok" };
  });

  /** 1. BE ŽYMOS - procesorius PRIVALO būti pakviestas. */
  const svarus = await jobStore.create({
    ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
  });

  await jobRunner._runInline("transcription", svarus.id, { storageKey: null });

  assert.deepEqual(
    vykdyta,
    [svarus.id],
    "be ištrynimo žymos darbas PRIVALO būti atliktas - kitaip `await` trūkumas liktų nepastebėtas"
  );

  /** 2. SU ŽYMA - procesorius NEPRIVALO būti pakviestas. */
  const zymetas = await jobStore.create({
    ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
  });

  await tombstones.mark(zymetas.id, { reason: "user_request" });
  await jobRunner._runInline("transcription", zymetas.id, { storageKey: null });

  assert.deepEqual(vykdyta, [svarus.id], "pažymėtas jobas NEGALI būti vykdomas");
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
  await tombstones.mark(job.id, { reason: "user_request" });

  /**
   * ⚠️ Šis testas tikrina APĖJIMO MECHANIZMĄ (`allowAfterDeletion`), ne fazių
   * kontraktą. Todėl jis sąmoningai naudoja neutralų lauką, o ne `status` –
   * po #154 statusą valdo state machine, ir `update()` jo nebepriima.
   */
  assert.equal(
    await jobStore.system.update(job.id, { attempt_count: 3 }, { allowAfterDeletion: true }),
    null,
    "`true` NETURI atidaryti apėjimo"
  );

  assert.ok(
    await jobStore.system.update(
      job.id,
      { attempt_count: 3 },
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

  await tombstones.mark(job.id, { reason: "user_request" }); // status = deletion_pending
  assert.equal(await tombstones.isConfirmedDeleted(job.id), false, "dar nepatvirtinta");

  assert.equal(
    await markCompleted(jobStore.system, job.id),
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

  await tombstones.mark(job.id, { reason: "user_request" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.FAILED);

  assert.equal(await markCompleted(jobStore.system, job.id), null);
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
  await jobStore.system.restart(job.id);

  // Ištrynimas įvyksta VIDURYJE darbo.
  await lifecycleService.deleteJobArtefacts(job, job.id, { actor: "sysadmin" });

  // Worker'is bando įrašyti rezultatą.
  const afterDeletion = await markCompleted(jobStore.system, job.id, { result: { protokolas: "neturėtų išlikti" } });

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
     * ⚠️ TIKRINAMAS `await`, NE PAMINĖJIMAS (#155, 7.5a / #183, P0).
     *
     * Iki 7.5a čia buvo ieškoma vien `tombstones.isDeleted(jobId)`. Nuo tada
     * funkcija asinchroninė, o `Promise` yra truthy: pamiršus `await`, KIEKVIENAS
     * job'as būtų praleistas kaip ištrintas - visas apdorojimas sustotų, o šis
     * testas praeitų. Būtent tokia patikra ir sukuria dengimo iliuziją.
     *
     * ⚠️ TRIPWIRE (AGENTS.md §9.2), NE ELGSENOS ĮRODYMAS. Elgseną tikrina du
     * testai šiame pat faile: „be žymos job'as NEPRALEIDŽIAMAS" (priešinga
     * kryptis) ir „su žyma - praleidžiamas".
     *
     * Priimam abi rašymo formas - tiesioginę sąlygą ir per kintamąjį - bet abi
     * PRIVALO turėti `await`.
     */
    assert.match(
      source,
      /await\s+tombstones\.isDeleted\(/,
      `${file} privalo AWAIT'INTI ištrynimo žymos patikrą - be to Promise visada truthy`
    );

    /** Nė vieno kvietimo be `await`: viena pamiršta vieta atveria tą patį kelią. */
    const beAwait = source.match(/(?<!await\s)tombstones\.isDeleted\(/g);
    assert.equal(
      beAwait,
      null,
      `${file} turi NEAWAIT'INTŲ isDeleted kvietimų: ${beAwait && beAwait.join(", ")}`
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

  const guard = source.match(/if \(await tombstones\.isDeleted\(jobId\)\) \{[\s\S]*?\n {6}\}/);
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

test("ŽYMOS: riba GALIOJA TIK atmintiniam režimui - ir tai užrašyta", async () => {
  /**
   * ⚠️ APVERSTAS TESTAS (#155, 7.5a / #183).
   *
   * Iki 7.5a jis reikalavo, kad `deletionTombstones` sakytų „žymos gyvena TIK
   * ATMINTYJE" ir kad restartas jas praranda. Po persistentinių žymų tai tapo
   * MELU - bet melu, ginamu žalio testo: pakeitus kodą teisingai, testas būtų
   * kritęs ir spaudęs teiginį grąžinti.
   *
   * Tai ta pati klasė kaip #213 rizika 13 (pasenęs teiginys, ginamas testo),
   * todėl testas ne šalinamas, o apverčiamas: dabar jis reikalauja, kad riba
   * būtų įvardyta SĄLYGINIAI - galiojanti atmintiniam režimui, negaliojanti su
   * `DATABASE_URL`. Besąlygiškas apribojimo pašalinimas būtų toks pat melas,
   * tik priešinga kryptimi.
   */
  const tombstones = require("../utils/deletionTombstones");

  assert.match(
    tombstones.ATMINTIES_ISPEJIMAS,
    /TIK ATMINTYJE/,
    "atmintinio režimo riba privalo likti įvardyta"
  );
  assert.match(
    tombstones.ATMINTIES_ISPEJIMAS,
    /restart/i,
    "restarto poveikis privalo likti įvardytas"
  );
  assert.match(
    tombstones.ATMINTIES_ISPEJIMAS,
    /DATABASE_URL/,
    "įspėjimas privalo pasakyti, KADA garantija galioja - kitaip jis skamba besąlygiškai"
  );

  /** Be `DATABASE_URL` backend'as PRIVALO būti atmintis, o ne tylus postgres bandymas. */
  assert.equal(tombstones.backend, "memory", "be DATABASE_URL - atmintinis backend'as");
});
