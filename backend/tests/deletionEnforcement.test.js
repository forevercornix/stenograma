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
  const { registerProcessors } = require("../queues/register");
  const vykdyta = [];

  /**
   * ⚠️ PROCESORIUS ATSTATOMAS (#183 Codex, P1).
   *
   * `registerProcessor()` rašo į MODULIO globalų registrą. Be atstatymo bet
   * kuris vėlesnis testas tame pačiame procese, naudojantis inline
   * transkripciją, vykdytų šitą netikrą `{ text: "ok" }` - rezultatai
   * priklausytų nuo testų eilės, o procesoriaus regresija praeitų nepastebėta.
   *
   * Atstatoma per `registerProcessors()` - tą patį viešą kontraktą, kurį
   * naudoja `server.js` ir `jobPhaseTerminal.test.js`, ne per privatų registrą.
   */
  test.after(() => registerProcessors());

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

test("READINESS: žymų saugykla zonduojama - neveikianti DB reiškia NOT ready", async () => {
  /**
   * ⚠️ „LAZY init" IR „NIEKADA NEZONDUOJAMA" NĖRA TAS PATS (#183 Codex, P1).
   *
   * Su nustatytu `DATABASE_URL` ir nepasiekiama DB instancija startuodavo,
   * praneštų `ready`, priimtų job'us, o gedimą aptiktų tik pirmo `isDeleted()`
   * metu - jau vykdydama darbą, kurį barjeras turėjo sustabdyti. Tai ta pati
   * forma kaip 7.4f `readiness.auditStore`, kurio `/api/ready` netikrino.
   */
  const request = require("supertest");
  const app = require("../server");
  const tombstones = require("../utils/deletionTombstones");

  app._setReadyForTests(true);

  const originalus = tombstones.probe;

  try {
    /** Prielaida: veikiant saugyklai readiness praeina. */
    tombstones.probe = async () => true;
    assert.equal((await request(app).get("/api/ready")).status, 200, "prielaida: kitkas paruošta");

    /** Neveikianti žymų saugykla PRIVALO duoti 503. */
    tombstones.probe = async () => false;

    const res = await request(app).get("/api/ready");

    assert.equal(res.status, 503, "neveikianti žymų saugykla reiškia NOT ready");
    assert.equal(res.body.components.tombstonesReachable, false, "komponentas privalo būti matomas");

    /** ⚠️ Liveness NEPALIESTAS - kitaip orkestruotojas perkrautų podą cikle. */
    assert.equal((await request(app).get("/api/health")).status, 200, "liveness lieka");
  } finally {
    tombstones.probe = originalus;
  }
});

test("SKRIPTAS: inicijuoja AUDITO saugyklą, ne tik žymų", async () => {
  /**
   * ⚠️ ANTRA TOS PAČIOS KLAIDOS PUSĖ (#183 Codex, P1).
   *
   * `.env` pataisa sutvarkė DUOMENIS - žyma keliauja į PostgreSQL. Bet auditas
   * keliavo į niekur: be `auditStore.init()` su `AUDIT_BACKEND=postgres`
   * `rasytiAudita()` rašo į numatytąjį ATMINTIES fasadą, procesas baigiasi, ir
   * kiekvienas `ERASURE_MARK_RETRIED` / `ERASURE_MARK_FORCE_RESOLVED` dingsta.
   * Operatoriaus veiksmai liktų neaudituoti, nors dokumentacija žada patvarų
   * pėdsaką.
   *
   * ⚠️ KAIP TAI ĮRODOMA BE DUOMENŲ BAZĖS. `AUDIT_BACKEND` ir žymų backend'as
   * valdomi ATSKIRAI: žymos renkasi postgres tik pagal `DATABASE_URL`. Paleidus
   * be `DATABASE_URL`, bet su `AUDIT_BACKEND=postgres`, žymos lieka atmintyje, o
   * audito saugykla privalo kristi fail-closed. Klaida pasirodo TIK tada, kai
   * `init()` realiai kviečiamas - be pataisos skriptas ramiai išvestų sąrašą.
   *
   * RAW `audit_log` įrodymas su tikra DB - `erasureMarks.integration`.
   */
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");

  const skriptas = path.join(__dirname, "..", "scripts", "erasure-marks.js");

  const paleisti = (env) => {
    try {
      return { kodas: 0, isvestis: execFileSync("node", [skriptas, "list"], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      }) };
    } catch (e) {
      return { kodas: e.status, isvestis: (e.stdout || "") + (e.stderr || "") };
    }
  };

  const be = { ...process.env };
  delete be.DATABASE_URL;

  const rezultatas = paleisti({ ...be, AUDIT_BACKEND: "postgres", DATABASE_URL: undefined });

  assert.match(
    rezultatas.isvestis,
    /AUDIT_BACKEND=postgres, bet nei DATABASE_URL/,
    `skriptas privalo inicijuoti audito saugyklą ir kristi fail-closed: ${rezultatas.isvestis}`
  );
});

test("ATKŪRIMAS: žyma, atsiradusi RAŠYMO metu, atšaukia atkūrimą", async () => {
  /**
   * ⚠️ KOMPENSUOJANTI PATIKRA (#183 Codex, P1).
   *
   * Fasado patikra ir `store.restoreRecord()` yra du atskiri veiksmai:
   * lygiagreti replika gali įterpti žymą tarp jų, ir atkūrimas prikeltų
   * ištrintą job'ą. Persistentiniame kelyje langą uždaro `assertNotBarred()`
   * KVIETĖJO transakcijoje; kitiems backend'ams tokios transakcijos nėra, tad
   * langas uždaromas po-rašymo patikra.
   *
   * ⚠️ LENKTYNĖS DETERMINISTINĖS: `isDeleted` pirmą kartą grąžina `false` (kaip
   * prieš žymą), o antrą - `true`. Jokio laukimo; eiliškumas valdomas.
   *
   * Persistentinio kelio atomiškumą įrodo `erasureMarks.integration` - be DB
   * jis NOT RUN.
   */
  const jobStore = require("../utils/jobStore");
  const tombstones = require("../utils/deletionTombstones");

  await tombstones._clearForTests();
  await jobStore.init();

  const jobas = await jobStore.create({
    ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
  });
  await jobStore.system.remove(jobas.id);

  const originalus = tombstones.isDeleted;
  let kartas = 0;

  tombstones.isDeleted = async (id) => {
    kartas += 1;
    /** 1: fasado ankstyva patikra - žymos dar nėra. 2+: po rašymo - jau yra. */
    return kartas === 1 ? false : originalus(id);
  };

  try {
    /** Žyma atsiranda „lygiagrečiai" - iškart po ankstyvos patikros. */
    await tombstones.mark(jobas.id, { reason: "user_request" });

    const rezultatas = await jobStore.restoreRecord(jobas);

    assert.equal(rezultatas, null, "atkūrimas privalo būti atšauktas");
    assert.equal(await jobStore.system.get(jobas.id), null, "atkurtas įrašas privalo būti pašalintas");
    assert.ok(kartas >= 2, "po-rašymo patikra privalo įvykti");
  } finally {
    tombstones.isDeleted = originalus;
    await tombstones._clearForTests();
  }
});

test("RETENCIJA: žymų riba ateina IŠ SAUGYKLOS, ne iš Node laikrodžio", async () => {
  /**
   * ⚠️ TREČIAS TOS PAČIOS KLAIDOS ATVEJIS (#183 Codex, P2).
   *
   * `updated_at` rašomas DB `now()`, o riba ateidavo iš `Date.now()`. Skubantis
   * replikos laikrodis ištrindavo barjerus anksčiau, nei pagal juos sukūrusią DB
   * suėjo horizontas. Tas pats defektas jau taisytas 7.4d audito retencijoje ir
   * jos DST variante.
   */
  const { createErasureMarkStore } = require("../utils/deletionTombstones/postgresStore");

  const uzklausos = [];
  const DB_ATSAKYMAS = new Date("2001-02-03T04:05:06.000Z");

  const pool = {
    query: async (sql, params) => {
      uzklausos.push({ sql: String(sql), params });
      return { rows: [{ riba: DB_ATSAKYMAS }], rowCount: 0 };
    },
  };

  const store = createErasureMarkStore(pool);
  const riba = await store.retencijosRiba(72 * 3600 * 1000);

  assert.equal(riba, DB_ATSAKYMAS.getTime(), "grąžinama BŪTENT DB duota reikšmė");
  assert.match(uzklausos[0].sql, /now\(\)/i, "riba skaičiuojama SQL `now()`");
  assert.deepEqual(uzklausos[0].params, [String(72 * 3600 * 1000)], "terminas - parametru");

  for (const blogas of [0, -1, "nežinia", null]) {
    await assert.rejects(() => store.retencijosRiba(blogas), /teigiamas/i);
  }

  /**
   * ⚠️ IR FASADAS PRIVALO JOS KLAUSTI, ne skaičiuoti pats.
   *
   * Pirmoji šio testo versija tikrino tik saugyklą: fasadą grąžinus prie
   * `now - terminas` testas liko žalias, nors defektas grįžo. Čia pakeičiamas
   * `memoryStore` - jį fasadas naudoja be `DATABASE_URL`, tad naujo produkcinio
   * test-kabliuko nereikia.
   */
  const SENTINEL = 946684800000; // 2000-01-01
  const tombstones = require("../utils/deletionTombstones");
  const memoryStore = require("../utils/deletionTombstones/memoryStore");

  const ribos = [];
  const gautosRibos = [];

  const senaRiba = memoryStore.retencijosRiba;
  const senasPurge = memoryStore.purgeExpired;

  memoryStore.retencijosRiba = async (terminas) => {
    ribos.push(terminas);
    return SENTINEL;
  };
  memoryStore.purgeExpired = async (cutoff) => {
    gautosRibos.push(cutoff);
    return 0;
  };

  try {
    await tombstones._clearForTests();
    await tombstones.purgeExpired(Date.now());

    assert.equal(ribos.length, 1, "ribos klausiama VIENĄ kartą per sweep'ą");
    assert.deepEqual(gautosRibos, [SENTINEL], "batch'ai privalo gauti SAUGYKLOS duotą ribą");
  } finally {
    memoryStore.retencijosRiba = senaRiba;
    memoryStore.purgeExpired = senasPurge;
  }
});

test("ATKŪRIMAS: nepavykęs kompensuojantis valymas KRENTA, o ne praneša sėkmę", async () => {
  /**
   * ⚠️ „PRALEISTA" IR „PALIKTA" NĖRA TAS PATS (#183 Codex).
   *
   * Kai žyma atsiranda rašymo metu, atkurtas įrašas šalinamas. Jei TAS
   * šalinimas krinta (pvz. Redis dingsta iškart po priėmimo), anksčiau klaida
   * būdavo suloginama, o funkcija grąžindavo `null` - kvietėjas suprastų, kad
   * atkūrimas saugiai praleistas, nors užbarjeruotas job'as LIKO saugykloje ir
   * praradus atminties žymą atgytų.
   */
  const jobStore = require("../utils/jobStore");
  const tombstones = require("../utils/deletionTombstones");

  await tombstones._clearForTests();
  await jobStore.init();

  const jobas = await jobStore.create({
    ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
  });
  await jobStore.system.remove(jobas.id);

  const senasIsDeleted = tombstones.isDeleted;
  const senasRemove = jobStore.system.remove;
  let kartas = 0;

  tombstones.isDeleted = async (id) => (++kartas === 1 ? false : senasIsDeleted(id));

  try {
    await tombstones.mark(jobas.id, { reason: "user_request" });

    /** Valymas krinta - saugykla dingo iškart po priėmimo. */
    const store = require("../utils/jobStore/memoryStore");
    const senasStoreRemove = store.remove;
    store.remove = async () => {
      throw new Error("saugykla neprieinama");
    };

    try {
      await assert.rejects(
        () => jobStore.restoreRecord(jobas),
        /Užbarjeruotas įrašas LIKO saugykloje/,
        "nepavykęs valymas privalo būti matomas kvietėjui, ne nutylėtas"
      );
    } finally {
      store.remove = senasStoreRemove;
    }
  } finally {
    tombstones.isDeleted = senasIsDeleted;
    jobStore.system.remove = senasRemove;
    await tombstones._clearForTests();
  }
});
