const test = require("node:test");
const assert = require("node:assert/strict");

const auditLog = require("../utils/auditLog");
const { STULPELIAI, META_LAUKAI, visiLaukai, isrinktiMeta } = require("../utils/auditStore/fields");
const { EVENT_PATTERN } = require("../utils/auditEvents");

/**
 * LAUKŲ SKIRSTYMO PARITETAS (#155, 7.4b / #211).
 *
 * Šie testai saugo nuo tylaus lauko dingimo: `record()` papildomas nauju lauku,
 * `fields.js` - ne, ir postgres backend'as jo nebeišsaugo. Memory režime viskas
 * atrodo gerai, o skirtumas pasimato tik po diegimo su tikra DB.
 */

test("SKIRSTYMAS: sąrašai apima TIKSLIAI tuos laukus, kuriuos grąžina `record()`", async () => {
  auditLog.clear();

  /**
   * ⚠️ Lyginama su TIKRA išvestimi, ne su rankiniu sąrašu testo viduje - antra
   * kopija čia turėtų tą pačią ydą kaip ir trečia kopija store'e.
   *
   * Įrašas turi būti „turtingas": laukai, kurių `record()` nepriskiria, vis
   * tiek atsiranda kaip `null`, tad raktų aibė nepriklauso nuo įvesties. Bet
   * jei kada priklausytų, testas turi tai pastebėti.
   */
  const eilute = await auditLog.record({
    event: "PROCESSING_COMPLETED",
    jobId: "laukų-testas",
    success: true,
    promptVersion: "v1",
    details: "x=1",
    variant: "original",
    format: "txt",
    outcome: "delivered",
    route: "/api/exports",
    mime: "text/plain",
    sizeBytes: 10,
    limitBytes: 20,
  });

  const faktiniai = Object.keys(eilute).sort();
  const deklaruoti = visiLaukai().sort();

  assert.deepEqual(
    deklaruoti,
    faktiniai,
    "`fields.js` skirstymas atsiliko nuo `record()` - naujas laukas nebūtų išsaugotas postgres režime"
  );
});

test("SKIRSTYMAS: stulpeliai ir `meta` NESIDUBLIUOJA", () => {
  const persidengia = Object.keys(STULPELIAI).filter((l) => META_LAUKAI.includes(l));

  assert.deepEqual(
    persidengia,
    [],
    "laukas ir stulpelyje, ir `meta` reikštų du skirtingus autoritetus tai pačiai reikšmei"
  );
});

test("SKIRSTYMAS: filtruojami laukai YRA stulpeliai, ne `meta`", () => {
  /**
   * #211: filtruojami laukai turi turėti savo indeksus, o ne remtis pilnu JSONB
   * skenavimu. Perkėlus bet kurį iš jų į `meta`, indeksas taptų nepasiekiamas,
   * o užklausa - pilnu lentelės skenavimu.
   */
  for (const laukas of ["id", "timestamp", "event", "subjectId", "result", "requestId"]) {
    assert.ok(laukas in STULPELIAI, `${laukas} privalo likti stulpeliu su savo indeksu`);
  }
});

test("`meta` ALLOWLIST: nežinomas laukas NUTYLIMAS, ne persistinamas", () => {
  const meta = isrinktiMeta({
    details: "leistina",
    transcript: "SLAPTA TRANSKRIPCIJA",
    prompt: "sisteminis prompt'as",
    jobId: "plikas-id",
    email: "asmuo@example.com",
  });

  assert.equal(meta.details, "leistina");

  for (const draudžiamas of ["transcript", "prompt", "jobId", "email"]) {
    assert.ok(
      !(draudžiamas in meta),
      `${draudžiamas} negali patekti į \`meta\` - allowlist yra saugos riba`
    );
  }
});

test("`meta`: nei `undefined`, nei `null` nerašomi į JSONB, bet round-trip duoda `null`", () => {
  /**
   * ⚠️ KONTRAKTAS SĄMONINGAI SUGRIEŽTINTAS (#211 peržiūra, P2).
   *
   * `record()` beveik visiems neprivalomiems laukams priskiria `null`. Anksčiau
   * `isrinktiMeta()` praleisdavo tik `undefined`, tad KIEKVIENA eilutė nešdavo
   * visus 21 allowlist raktą - minimaliam prisijungimo įvykiui ~385 simboliai
   * JSON dar prieš JSONB pridėtinę kainą. Postgres režime retencijos nėra
   * (7.4d), tad ši kaina kaupiasi neribotai augančioje lentelėje.
   *
   * ⚠️ API KONTRAKTAS NESIKEIČIA, ir būtent tai čia tikrinama: praleistas raktas
   * skaitant atkuriamas kaip `null`. Be šios antros pusės sutaupymas būtų
   * pirktas backend'ų divergencijos kaina.
   */
  const meta = isrinktiMeta({ details: "yra", error: null, route: undefined, sizeBytes: 0 });

  assert.equal(meta.details, "yra");
  assert.ok(!("error" in meta), "`null` neturi užimti vietos JSONB'e");
  assert.ok(!("route" in meta), "`undefined` neturi sukurti rakto");

  /** ⚠️ `0` ir `""` NĖRA `null` - falsy reikšmės privalo išlikti. */
  assert.equal(meta.sizeBytes, 0, "nulis yra reikšmė, ne trūkstamas laukas");

  /** Round-trip: postgres skaitymas praleistus raktus atkuria kaip `null`. */
  const { iEilute } = require("../utils/auditStore/postgresStore");
  const atkurta = iEilute({
    id: "x",
    timestamp: "2026-01-01T00:00:00.000Z",
    event: "LOGIN_SUCCESS",
    subject_id: null,
    result: "success",
    request_id: null,
    meta,
  });

  assert.equal(atkurta.error, null, "praleistas raktas privalo grįžti kaip `null`");
  assert.equal(atkurta.route, null);
  assert.equal(atkurta.sizeBytes, 0, "reikšmė `0` negali virsti `null`");
  assert.deepEqual(Object.keys(atkurta).sort(), visiLaukai().sort(), "raktų aibė nesikeičia");
});

test("ĮVYKIO ŠABLONAS: migracijoje UŽŠALDYTAS, bet dabartinį šabloną PADENGIA migracija", () => {
  /**
   * ⚠️ KONTRAKTAS PASIKEITĖ PO #211 PERŽIŪROS - IR TAI SĄMONINGA.
   *
   * Pirmoji versija migracijoje `require`-ino `EVENT_PATTERN`, kad autoritetas
   * liktų vienas. Bet migracija yra ISTORIJOS ĮRAŠAS: pakeitus šabloną, šviežia
   * DB gautų NAUJĄ constraint'ą, o atnaujinta liktų su SENU - `node-pg-migrate`
   * migraciją jau pažymėjo pritaikyta. Abi startuotų (vardas tas pats), bet
   * priimtų SKIRTINGAS įvykių aibes: audito elgesys imtų priklausyti nuo
   * diegimo istorijos.
   *
   * Dabar: migracijose šablonas UŽŠALDYTAS literalu, o šis testas reikalauja,
   * kad dabartinį `EVENT_PATTERN` PADENGTŲ bent viena migracija. Pakeitus
   * šabloną be naujos migracijos - testas krinta ir pasako, ko trūksta.
   *
   * ELGSENĄ (kad DB ir runtime priima tą pačią aibę) tikrina
   * `auditPersistence.integration`, o startas lygina TIKRĄ constraint'o
   * apibrėžimą su `EVENT_PATTERN`.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");
  const dir = path.join(__dirname, "..", "migrations");

  const uzsaldyti = [];
  for (const failas of fs.readdirSync(dir)) {
    if (!failas.endsWith(".js")) continue;

    /**
     * ⚠️ KOMENTARAI NUSKUTAMI (AGENTS.md §9.2). Migracijos komentaras PAAIŠKINA,
     * kodėl importo nebėra, ir jame ta eilutė paminėta - be nuskutimo patikra
     * pagautų savo pačios dokumentaciją. Taip jau nutiko šiam testui.
     */
    const turinys = beKomentaru(fs.readFileSync(path.join(dir, failas), "utf8"));

    for (const m of turinys.matchAll(/EVENT_PATTERN_FROZEN\s*=\s*"([^"]+)"/g)) {
      uzsaldyti.push({ failas, sablonas: m[1] });
    }

    /** ⚠️ Importas migracijoje reikštų, kad istorijos įrašas vėl kinta su kodu. */
    assert.doesNotMatch(
      turinys,
      /require\(["'][^"']*auditEvents["']\)/,
      `${failas}: migracija NEGALI importuoti \`EVENT_PATTERN\` - žr. testo paaiškinimą`
    );
  }

  assert.ok(uzsaldyti.length > 0, "bent viena migracija privalo apibrėžti įvykių šabloną");

  assert.ok(
    uzsaldyti.some((u) => u.sablonas === EVENT_PATTERN.source),
    `dabartinio \`EVENT_PATTERN\` (${EVENT_PATTERN.source}) nepadengia nė viena migracija. ` +
      `Užšaldyti: ${uzsaldyti.map((u) => `${u.failas}: ${u.sablonas}`).join("; ")}. ` +
      "Pakeitus šabloną reikia NAUJOS migracijos - senoji jau pažymėta pritaikyta."
  );

  assert.ok(EVENT_PATTERN.source.startsWith("^"), "šablonas turi būti pririštas prie eilutės pradžios");
});

test("SKENERIO IŠIMTIS: saugyklos sluoksnis realiai NĖRA producer'is", () => {
  /**
   * ⚠️ IŠIMTIS BE SARGYBOS YRA SPRAGA.
   *
   * `producerIvykiai()` praleidžia `utils/auditStore/*`, nes tas sluoksnis
   * įvykius atvaizduoja, o ne kuria (`event: row.event`). Jei jame kada
   * atsirastų tikras rašymo kvietimas, klasifikacijos pilnumo patikra jo
   * NEBEMATYTŲ - neklasifikuotas įvykis praslystų pro startą.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { NE_PRODUCER_KELIAI, beKomentaru } = require("../utils/auditEvents");

  assert.deepEqual(NE_PRODUCER_KELIAI, ["auditStore"], "išimčių sąrašas išaugo - patikrink kiekvieną");

  const dir = path.join(__dirname, "..", "utils", "auditStore");

  for (const failas of fs.readdirSync(dir)) {
    if (!failas.endsWith(".js")) continue;

    const svarus = beKomentaru(fs.readFileSync(path.join(dir, failas), "utf8"));

    assert.doesNotMatch(
      svarus,
      /rasytiAudita\(|auditLog\.record\(/,
      `${failas}: saugyklos sluoksnyje atsirado rašymo kvietimas - išimtis nebegalioja`
    );
  }
});

test("NERIBOTAS SKAITYMAS: nauji produkciniai `auditLog.getAll()` kvietėjai DRAUDŽIAMI", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2), ne elgsenos įrodymas.
   *
   * `getAll()` grąžina VISĄ žurnalą be ribos. Kontraktas išlaikytas sąmoningai:
   * dešimtys esamų testų juo remiasi, o #211 reikalauja, kad jie praeitų be
   * modifikacijų. Bet persistentiniame režime tai reiškia pilną `audit_log`
   * lentelės perkėlimą per tinklą - o auditas yra būtent ta lentelė, kuri auga
   * be ribos.
   *
   * Produkciniai keliai turi naudoti `query({limit, ...})` arba `hasSubject()`.
   * Šiandien NĖ VIENAS produkcinis kelias `getAll()` nekviečia, tad whitelist'as
   * TUŠČIAS - stipriausia įmanoma forma. Naujas kvietėjas privalo laužyti šį
   * testą ir būti pridėtas čia SĄMONINGAI, su paaiškinimu, o ne atsirasti tyliai.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");

  /**
   * Žinomi kvietėjai. Kiekvienas įrašas privalo turėti priežastį - be jos
   * whitelist'as taptų vieta, kur riba tyliai plečiama.
   *
   * @type {Array<{failas: string, kodel: string}>}
   */
  const LEIDZIAMI = [];

  const PRODUKCINIAI = ["utils", "services", "middleware", "routes", "workers", "queues"];
  const saknis = path.join(__dirname, "..");

  /** Fasado apibrėžimas ir saugyklos sluoksnis nėra kvietėjai. */
  const NE_KVIETEJAI = ["utils/auditLog.js", "utils/auditStore/"];

  const rasti = [];

  for (const katalogas of PRODUKCINIAI) {
    const dir = path.join(saknis, katalogas);
    let irasai;
    try {
      irasai = fs.readdirSync(dir, { recursive: true });
    } catch {
      continue;
    }

    for (const irasas of irasai) {
      const santykinis = `${katalogas}/${String(irasas)}`;
      if (!santykinis.endsWith(".js")) continue;
      if (NE_KVIETEJAI.some((k) => santykinis.startsWith(k))) continue;

      const svarus = beKomentaru(fs.readFileSync(path.join(dir, String(irasas)), "utf8"));

      if (/auditLog\s*\.\s*getAll\s*\(/.test(svarus)) rasti.push(santykinis);
    }
  }

  const netiketi = rasti.filter((f) => !LEIDZIAMI.some((l) => l.failas === f));

  assert.deepEqual(
    netiketi,
    [],
    "naujas neribotas audito skaitymas produkciniame kelyje: " +
      `${netiketi.join(", ")}. Naudokite \`query({limit})\` arba \`hasSubject()\`; ` +
      "jei neribotas skaitymas tikrai būtinas - pridėkite į LEIDZIAMI su priežastimi"
  );

  /**
   * ⚠️ IR ATVIRKŠČIAI: whitelist'as, atsilikęs nuo kodo, tyliai leistų grąžinti
   * pašalintą kvietėją. Kiekvienas įrašas privalo atitikti realų failą.
   */
  for (const leidžiamas of LEIDZIAMI) {
    assert.ok(
      rasti.includes(leidžiamas.failas),
      `${leidžiamas.failas} whitelist'e, bet \`getAll()\` nebekviečia - įrašą pašalinkite`
    );
    assert.ok(leidžiamas.kodel && leidžiamas.kodel.length > 10, "whitelist įrašas be priežasties");
  }
});

test("RETENCIJOS ĮSPĖJIMAS: turinys atitinka 7.4d elgesį, o ne senąjį", () => {
  /**
   * ⚠️ ŠIS TESTAS PERRAŠYTAS 7.4d (#213), NES JO DALYKAS PASIKEITĖ.
   *
   * Iki 7.4d įspėjimas skelbė, kad retencija postgres režime NEVEIKIA ir kad
   * lentelė augs neribotai - tada tai buvo tiesa. Įgyvendinus persistentinę
   * retenciją tas pats tekstas taptų MELU, o melas šioje vietoje brangus:
   * operatorius arba pridėtų antrą išorinę valymo politiką, arba nepasitikėtų
   * veikiančiu mechanizmu.
   *
   * Todėl tikrinama, kad tekstas skelbia NAUJĄ elgesį ir nebeskelbia senojo.
   * Turinio patikra vykdoma vietoje; kad įspėjimas realiai loginamas starte,
   * tikrina `auditPersistence.integration` (reikia tikros DB).
   */
  const { RETENCIJOS_ISPEJIMAS } = require("../utils/auditStore");

  for (const privalomas of ["AUDIT_RETENTION_DAYS", "AUDIT_MAX_ENTRIES", "docs/audit-storage.md"]) {
    assert.ok(
      RETENCIJOS_ISPEJIMAS.includes(privalomas),
      `įspėjime turi būti „${privalomas}" - kitaip operatorius nežinotų, ko ieškoti`
    );
  }

  /** ⚠️ Skirtumas, dėl kurio įspėjimas apskritai lieka: kiekio riba NĖRA retencija. */
  assert.match(
    RETENCIJOS_ISPEJIMAS,
    /NETAIKOMA|nešalinamos vien dėl kiekio/i,
    "`AUDIT_MAX_ENTRIES` netaikymas persistentinėms eilutėms privalo būti įvardytas"
  );

  /** ⚠️ SENASIS TEIGINYS NEGALI GRĮŽTI. */
  assert.doesNotMatch(
    RETENCIJOS_ISPEJIMAS,
    /retencija NEVEIKIA|augs neribotai|iki tol reikalinga išorinė/i,
    "tekstas skelbia elgesį, kurio 7.4d nebeturi"
  );

  /** ⚠️ Ne klaida, o įspėjimas - startas privalo tęstis. */
  assert.doesNotMatch(RETENCIJOS_ISPEJIMAS, /NUTRAUK|startas negalimas/i);
});

test("WORKER'IAI: `initializeWorkerOrFail` inicijuoja IR audito saugyklą", async () => {
  /**
   * ⚠️ P1 (#211 peržiūra): worker'iai rašo auditą, bet jo neinicijuodavo.
   *
   * `transcriptionService` ir `protocolService` kviečiami BULLMQ worker'io
   * procese ir rašo audito įvykius. Be `auditStore.init()` tame procese
   * `auditStore` liktų numatytoji ATMINTIS: su `AUDIT_BACKEND=postgres`
   * worker'io įvykiai niekada nepasiektų DB ir dingtų per restartą - tyliai,
   * nes HTTP procese viskas atrodytų teisingai. Be to worker'is pakiltų net
   * tada, kai audito DB nepasiekiama.
   *
   * ⚠️ TIKRINAMA ELGSENA: klaida injektuojama į TĄ PATĮ `auditStore.init`,
   * kurį kviečia produkcinis kelias. Teksto paieška (`grep auditStore.init`)
   * praeitų ir tada, kai kvietimas yra, bet jo rezultatas ignoruojamas.
   */
  const workers = require("../workers");
  const auditStore = require("../utils/auditStore");
  const jobStore = require("../utils/jobStore");

  /**
   * ⚠️ IŠSAUGOMI VISI PERRAŠOMI METODAI (AGENTS.md §9.3).
   *
   * Pirmoji versija išsaugojo `init`, bet ne `hasQueueBackend` - tad visi
   * vėlesni šio failo testai matytų suklastotą eilės galimybę, ir naujo testo
   * pridėjimas ar pertvarkymas tyliai sukurtų klaidingą praėjimą.
   */
  const saved = {
    redis: process.env.REDIS_URL,
    init: auditStore.init,
    jobInit: jobStore.init,
    hasQueue: jobStore.hasQueueBackend,
  };
  process.env.REDIS_URL = "redis://testas:6379";

  /** `jobStore.init()` neturi bandyti tikro Redis - mus domina TIK audito šaka. */
  jobStore.init = async () => {};
  jobStore.hasQueueBackend = () => true;

  let kviesta = false;
  auditStore.init = async () => {
    kviesta = true;
    throw new Error("audito saugykla nepasiekiama");
  };

  try {
    await assert.rejects(
      () => workers.initializeWorkerOrFail("testinis-worker"),
      /audito saugykla nepasiekiama/,
      "worker'is negali pakilti, kai audito saugykla neprieinama"
    );
    assert.ok(kviesta, "`auditStore.init()` privalo būti kviečiamas worker'io starte");
  } finally {
    auditStore.init = saved.init;
    jobStore.init = saved.jobInit;
    jobStore.hasQueueBackend = saved.hasQueue;
    if (saved.redis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.redis;
  }
});

test("BIUDŽETAS: DB laiko invariantas NEGALIOJA atminties režimui", () => {
  /**
   * ⚠️ #211 peržiūra (P2).
   *
   * `auditTimeoutBudget()` dalija langą tarp pool'o laukimo ir
   * `statement_timeout` - abu egzistuoja TIK su PostgreSQL. Atminties režimu
   * `AUDIT_WRITE_TIMEOUT_MS=3` yra teisėta reikšmė: `auditWriteTimeoutMs()` ją
   * priima, ir `suRiba()` su ja veikia. Besąlyginė patikra nutraukdavo startą
   * dėl DB invarianto, kurio toje konfigūracijoje apskritai nėra.
   */
  const { validateConfig } = require("../utils/startupChecks");

  const bazė = { NODE_ENV: "test", LLM_PROVIDER: "mock", TRANSCRIPTION_PROVIDER: "mock" };
  const auditoKlaidos = (env) =>
    (validateConfig(env).errors || []).filter((e) => /AUDIT_WRITE_TIMEOUT_MS/.test(e));

  assert.deepEqual(
    auditoKlaidos({ ...bazė, AUDIT_WRITE_TIMEOUT_MS: "3" }),
    [],
    "atminties režimu maža riba yra teisėta - startas negali dėl jos kristi"
  );

  /** Bet postgres režimu ta pati reikšmė reiškia, kad DB nespėtų nutraukti užklausos. */
  const pgKlaidos = auditoKlaidos({
    ...bazė,
    AUDIT_BACKEND: "postgres",
    DATABASE_URL: "postgres://x",
    AUDIT_ID_SALT: "s",
    AUDIT_ID_SALT_ID: "i",
    AUDIT_WRITE_TIMEOUT_MS: "3",
  });
  assert.equal(pgKlaidos.length, 1, "postgres režimu biudžeto invariantas privalo galioti");
});

test("BIUDŽETAS: ribų TVARKA tikrinama LOKALIAI, ne tik prieš tikrą DB", () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL REALIOS KLAIDOS.
   *
   * Biudžeto dalys buvo perdalytos (0.2/0.7 → 0.15/0.55/0.70), bet konkretūs
   * skaičiai gyveno TIK PostgreSQL teste, kuris be `DATABASE_URL` praleidžiamas.
   * Lokaliai viskas atrodė žalia, o drift'as pasimatė tik CI - po push'o.
   *
   * Santykiai nepriklauso nuo DB, tad ir tikrinami čia:
   *
   *   serveris < klientas   - kitaip `pg` atmestų PIRMAS, o serverio užklausa
   *                           liktų vykdoma; INSERT, spėjęs įsirašyti, būtų
   *                           praneštas kaip nepavykęs, o `suRiba()` vėlyvos
   *                           sėkmės logas ir skaitiklis liktų nepasiekti;
   *   pool + klientas < T   - kitaip fasadas suveiktų anksčiau už abu.
   */
  const { auditTimeoutBudget } = require("../utils/auditStore/timeouts");

  for (const T of [500, 2000, 10000]) {
    const b = auditTimeoutBudget({ AUDIT_WRITE_TIMEOUT_MS: String(T) });

    assert.equal(b.facadeMs, T);
    assert.ok(b.statementMs < b.clientMs, `T=${T}: serverio riba privalo būti ankstesnė už kliento`);
    assert.ok(
      b.poolAcquireMs + b.clientMs < b.facadeMs,
      `T=${T}: pool ir kliento ribos privalo tilpti į fasado langą`
    );
  }

  /** Kanarėlė: numatytoji reikšmė duoda būtent tą trejetą, kurį tikrina PG testas. */
  const numatyta = auditTimeoutBudget({});
  assert.deepEqual(
    [numatyta.poolAcquireMs, numatyta.statementMs, numatyta.clientMs],
    [300, 1100, 1400],
    "pakeitus dalis - atnaujinkite IR `auditPersistence.integration` reikšmes"
  );
});

test("DRUSKA: `init(env)` perduota druska galioja IR pseudonimizacijai", async () => {
  /**
   * ⚠️ #211 peržiūra (P2): DU AUTORITETAI TAM PAČIAM RAKTUI.
   *
   * `init(env)` validuodavo `env.AUDIT_ID_SALT`, o `auditLog.resolveSalt()`
   * skaitė TIK `process.env`. Įterptinis kvietėjas taip gaudavo `hash_key_id`
   * iš injektuotos konfigūracijos, o `subject_id` - iš kitos, galimai
   * atsitiktinės druskos. Po TIKRO proceso restarto
   * `removeBySubjectIdentifier()` senų eilučių neberastų.
   *
   * Sugeneruota procesui lokali druska `shutdown()` išgyvena, tad restarto
   * testas šį neatitikimą uždengdavo - todėl tikrinama čia, tiesiogiai.
   */
  const auditStore = require("../utils/auditStore");
  const crypto = require("node:crypto");

  const savedSalt = process.env.AUDIT_ID_SALT;
  delete process.env.AUDIT_ID_SALT;

  const INJEKTUOTA = "injektuota-druska-nera-process-env";

  try {
    await auditStore.shutdown();
    await auditStore.init({ AUDIT_BACKEND: "memory", AUDIT_ID_SALT: INJEKTUOTA });

    const laukiama = crypto
      .createHmac("sha256", INJEKTUOTA)
      .update("job-druskos-testas")
      .digest("hex")
      .slice(0, 20);

    assert.equal(
      auditLog.pseudonymizeIdentifier("job-druskos-testas"),
      laukiama,
      "pseudonimizacija privalo naudoti PERDUOTĄ druską, ne sugeneruotą"
    );
  } finally {
    await auditStore.shutdown();
    if (savedSalt === undefined) delete process.env.AUDIT_ID_SALT;
    else process.env.AUDIT_ID_SALT = savedSalt;
  }
});

test("SKAITYMAS: nepalaikoma `meta` forma NEPAVERČIA puslapio 500 klaida", () => {
  /**
   * ⚠️ #211 peržiūra (P2). JSONB teisėtai priima skaliarus (`42`, `"tekstas"`,
   * `true`). Tokia eilutė - tiesioginio SQL rašytojo ar senesnio producer'io
   * palikimas - versdavo `laukas in meta` mesti `TypeError`, ir VISAS
   * `GET /api/audit` puslapis grąžindavo 500. Vienas įrašas taptų nuodinga
   * eilute, kurios per API nebeperskaitytum.
   *
   * Schema tokių nebepriima (`audit_log_meta_is_object`), bet skaitymas privalo
   * atlaikyti jau esamas: viena bloga eilutė neturi padaryti neperskaitomo viso
   * žurnalo.
   */
  const { iEilute } = require("../utils/auditStore/postgresStore");

  const bazė = {
    id: "x",
    timestamp: "2026-01-01T00:00:00.000Z",
    event: "LOGIN_SUCCESS",
    subject_id: null,
    result: "success",
    request_id: null,
  };

  for (const bloga of [42, "tekstas", true, null, ["a"]]) {
    const eilute = iEilute({ ...bazė, meta: bloga });

    assert.deepEqual(
      Object.keys(eilute).sort(),
      visiLaukai().sort(),
      `meta=${JSON.stringify(bloga)}: raktų aibė privalo likti pilna`
    );
    assert.equal(eilute.details, null, "nepalaikoma forma virsta tuščiais laukais, ne klaida");
  }

  /** Teisinga forma nepaliečiama. */
  assert.equal(iEilute({ ...bazė, meta: { details: "ok" } }).details, "ok");
});

test("KONFIGŪRACIJA: `init(env)` yra VIENAS autoritetas visiems trims laukams", async () => {
  /**
   * ⚠️ #211 peržiūra (P2 ×2). Ta pati yda kaip su druska, tik kituose laukuose.
   *
   *   `PRIVACY_MODE`: `init()` priimtų `false`, o `auditLog` skaitytų globalų
   *   `true` ir TYLIAI mestų kiekvieną įrašą - procesas praneštų apie sėkmingai
   *   paruoštą persistentinę saugyklą, kuri lieka amžinai tuščia.
   *
   *   `AUDIT_WRITE_TIMEOUT_MS`: pool'o biudžetas skaičiuotųsi iš injektuotos
   *   reikšmės, o `rasytiAudita()` - iš globalios. Fasadas praneštų nesėkmę
   *   anksčiau, nei DB spėtų nutraukti užklausą, ir vėlyvo rašymo langas, kurio
   *   biudžetas kaip tik ir vengia, grįžtų.
   */
  const auditStore = require("../utils/auditStore");
  const { auditWriteTimeoutMs } = require("../utils/auditWrite");

  const saved = {
    privacy: process.env.PRIVACY_MODE,
    timeout: process.env.AUDIT_WRITE_TIMEOUT_MS,
  };

  /** Globali aplinka sąmoningai PRIEŠTARAUJA injektuotai. */
  process.env.PRIVACY_MODE = "true";
  process.env.AUDIT_WRITE_TIMEOUT_MS = "100";

  try {
    await auditStore.shutdown();

    /** Prielaida: be `init()` galioja globalios reikšmės. */
    assert.equal(auditLog.isPrivacyModeEnabled(), true, "prielaida: globalus PRIVACY_MODE veikia");
    assert.equal(auditWriteTimeoutMs(), 100, "prielaida: globalus timeout veikia");

    await auditStore.init({
      AUDIT_BACKEND: "memory",
      PRIVACY_MODE: "false",
      AUDIT_WRITE_TIMEOUT_MS: "2000",
    });

    assert.equal(
      auditLog.isPrivacyModeEnabled(),
      false,
      "injektuotas PRIVACY_MODE=false privalo galioti - kitaip saugykla liktų tyliai tuščia"
    );
    assert.equal(
      auditWriteTimeoutMs(),
      2000,
      "injektuotas timeout privalo galioti - kitaip fasadas ir pool'as skaičiuotų skirtingus langus"
    );

    /** Po `shutdown()` autoritetas grįžta į aplinką. */
    await auditStore.shutdown();
    assert.equal(auditLog.isPrivacyModeEnabled(), true);
    assert.equal(auditWriteTimeoutMs(), 100);
  } finally {
    await auditStore.shutdown();
    for (const [raktas, reiksme] of [
      ["PRIVACY_MODE", saved.privacy],
      ["AUDIT_WRITE_TIMEOUT_MS", saved.timeout],
    ]) {
      if (reiksme === undefined) delete process.env[raktas];
      else process.env[raktas] = reiksme;
    }
  }
});

test("POOL: neveiklios jungties klaida NENUŽUDO proceso", () => {
  /**
   * ⚠️ #211 peržiūra (P1).
   *
   * `pg-pool` neveiklios jungties klaidą (DB restartas, tinklo trūkis) skelbia
   * kaip `error` įvykį ant pool'o. `EventEmitter` neapdorotą `error` META, tad
   * Node nutraukia visą procesą - HTTP serverį arba worker'į. Tai apeitų įprastą
   * klaidų apdorojimą abiem įvykių kategorijoms: proceso tiesiog nebeliktų.
   *
   * ⚠️ TIKRINAMAS PRODUKCINIS KELIAS, ne atskiras `EventEmitter`: naudojamas
   * TAS PATS `pg.Pool` su tais pačiais nustatymais, kuriuos kuria
   * `auditoPoolNustatymai()`. Klausytojas registruojamas `initializePostgres()`,
   * tad čia atkartojama ta pati registracija ir tikrinama, kad `emit` nemeta.
   */
  const { Pool } = require("pg");
  const { auditoPoolNustatymai } = require("../utils/auditStore");

  const pool = new Pool(auditoPoolNustatymai({ PGHOST: "nepasiekiamas-hostas" }));

  try {
    /** BE klausytojo tai mestų ir nužudytų procesą. */
    assert.throws(
      () => pool.emit("error", new Error("idle client error")),
      /idle client error/,
      "prielaida: be klausytojo `error` įvykis META"
    );

    pool.on("error", () => {});

    assert.doesNotThrow(
      () => pool.emit("error", new Error("idle client error")),
      "su klausytoju procesas privalo išgyventi"
    );
  } finally {
    pool.end().catch(() => {});
  }
});

test("POOL'AI: VISI TRYS registruoja `error` klausytoją", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2) VISIEMS TRIMS PRODUKCINIAMS POOL'AMS.
   *
   * `pg-pool` neveiklios jungties klaidą skelbia kaip `error` įvykį ant pool'o.
   * `EventEmitter` neapdorotą `error` META, tad Node nutraukia visą procesą -
   * ne užklausą, o HTTP serverį ar worker'į.
   *
   * Spraga buvo VIENODA visuose trijuose (`jobStore`, `sessionStore`,
   * `auditStore`), tad ir sargyba bendra: naujas pool'as be klausytojo krinta
   * čia, o ne produkcijoje per pirmą DB restartą.
   *
   * Elgseną (kad `emit` su klausytoju NEMETA) tikrina atskiras testas žemiau.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");

  const FAILAI = [
    "utils/jobStore/index.js",
    "utils/sessionStore/index.js",
    "utils/auditStore/index.js",
  ];

  for (const santykinis of FAILAI) {
    const svarus = beKomentaru(fs.readFileSync(path.join(__dirname, "..", santykinis), "utf8"));

    const poolKurimai = (svarus.match(/new Pool\(/g) || []).length;
    const klausytojai = (svarus.match(/pool\.on\(\s*["']error["']/g) || []).length;

    assert.ok(poolKurimai > 0, `${santykinis}: prielaida - failas kuria pool'ą`);
    assert.equal(
      klausytojai,
      poolKurimai,
      `${santykinis}: kiekvienas \`new Pool()\` privalo turėti \`error\` klausytoją - ` +
        "be jo neveikli jungtis nužudo procesą"
    );
  }
});

test("KONFIGŪRACIJA: audito moduliai NESKAITO `process.env` už autoriteto ribų", () => {
  /**
   * ⚠️ SARGYBA NUO KETVIRTO SIMPTOMO.
   *
   * #211 peržiūroje trys atskiri radiniai pasirodė esą tos pačios šaknies:
   * `init(env)` atrodo priimantis pilną konfigūraciją, bet dalis jos toliau
   * skaitoma iš `process.env`. Kiekvienas simptomas atrodė nesusijęs su
   * ankstesniais (`AUDIT_ID_SALT`, tada `PRIVACY_MODE`, tada
   * `AUDIT_WRITE_TIMEOUT_MS`), ir kiekvienas buvo pastebėtas atskirai.
   *
   * Ši patikra išveda taisyklę iš `KONFIG_RAKTAI`: audito moduliuose neturi
   * likti nė vieno `process.env.AUDIT_*` ar `PRIVACY_MODE` skaitymo, kurio
   * nedengia autoritetas.
   *
   * ⚠️ TRIPWIRE, ne elgsenos įrodymas (AGENTS.md §9.2). Elgseną - kad injektuota
   * reikšmė realiai laimi - tikrina atskiras testas aukščiau.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");
  const { KONFIG_RAKTAI } = require("../utils/auditStore");

  const MODULIAI = [
    "utils/auditLog.js",
    "utils/auditWrite.js",
    "utils/auditStore/index.js",
    "utils/auditStore/backendSelection.js",
    "utils/auditStore/timeouts.js",
    "utils/auditStore/memoryStore.js",
    "utils/auditStore/postgresStore.js",
    "utils/auditStore/fields.js",
    "utils/auditStore/keyRing.js",
  ];

  /**
   * `NODE_ENV` NĖRA audito konfigūracija - tai vykdymo režimas, kurį naudoja
   * `clear()` sargyba. Įtraukta eksplicitiškai, kad išimtis būtų matoma.
   */
  const LEIDZIAMI_NE_KONFIG = ["NODE_ENV"];

  for (const santykinis of MODULIAI) {
    const svarus = beKomentaru(fs.readFileSync(path.join(__dirname, "..", santykinis), "utf8"));

    for (const m of svarus.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      const raktas = m[1];

      if (LEIDZIAMI_NE_KONFIG.includes(raktas)) continue;

      assert.ok(
        KONFIG_RAKTAI.includes(raktas),
        `${santykinis}: \`process.env.${raktas}\` nėra tarp KONFIG_RAKTAI. ` +
          "Arba pridėkite jį prie autoriteto (`init(env)` fiksuoja, vartotojai skaito " +
          "iš ten), arba - jei tai ne audito konfigūracija - prie LEIDZIAMI_NE_KONFIG " +
          "su priežastimi."
      );
    }
  }

  /** ⚠️ IR ATVIRKŠČIAI: kiekvienas deklaruotas raktas privalo būti realiai naudojamas. */
  const visasTurinys = MODULIAI.map((f) =>
    beKomentaru(fs.readFileSync(path.join(__dirname, "..", f), "utf8"))
  ).join("\n");

  for (const raktas of KONFIG_RAKTAI) {
    assert.match(
      visasTurinys,
      new RegExp(raktas),
      `${raktas} deklaruotas KONFIG_RAKTAI, bet niekur nenaudojamas - sąrašas atsiliko nuo kodo`
    );
  }
});

test("POOL: injektuoti `PG*` PERSIUNČIAMI, ne paliekami bibliotekos nuožiūrai", () => {
  /**
   * ⚠️ #211 peržiūra (P2). TA PATI „dvi konfigūracijos" ŠEIMA, KITAS SKAITYTOJAS.
   *
   * `pg` `PGHOST` ir kitus skaito iš `process.env`, o `init(env)` konfigūraciją
   * priima kaip OBJEKTĄ. Įterptinis kvietėjas, perdavęs `PGHOST` tik objekte,
   * praeitų `resolveAuditBackend()` (jis žiūri į tą patį objektą), bet pool'as
   * jungtųsi prie GLOBALIOS aplinkos nurodytos - arba numatytosios - duomenų
   * bazės. Auditas rašytųsi ne ten, kur operatorius nurodė.
   *
   * ⚠️ `process.env` tripwire šito NEPAGAUNA: antrasis skaitytojas čia ne mūsų
   * kodas, o pati biblioteka. Todėl reikalinga atskira patikra.
   */
  const { auditoPoolNustatymai } = require("../utils/auditStore");

  const n = auditoPoolNustatymai({
    PGHOST: "injektuotas-hostas",
    PGPORT: "5433",
    PGUSER: "injektuotas-vartotojas",
    PGPASSWORD: "injektuotas-slaptazodis",
    PGDATABASE: "injektuota-baze",
  });

  assert.equal(n.host, "injektuotas-hostas");
  assert.equal(n.port, 5433, "portas privalo būti SKAIČIUS, ne tekstas");
  assert.equal(n.user, "injektuotas-vartotojas");
  assert.equal(n.password, "injektuotas-slaptazodis");
  assert.equal(n.database, "injektuota-baze");

  /**
   * ⚠️ SU `DATABASE_URL` `PG*` NEPERSIUNČIAMI: `pg` taikytų juos abu, ir
   * pirmenybė taptų neakivaizdi. URL yra vienas autoritetas.
   */
  const suUrl = auditoPoolNustatymai({ DATABASE_URL: "postgres://a/b", PGHOST: "kitas" });

  assert.equal(suUrl.connectionString, "postgres://a/b");
  assert.equal(suUrl.host, undefined, "su URL `PG*` neturi būti maišomi");
});

test("KONFLIKTAS: `DATABASE_URL` IR `PGHOST` kartu NUTRAUKIA startą", () => {
  /**
   * ⚠️ #211 peržiūra (P2). Repo tai JAU deklaruoja (`startupChecks.js`: „ABU
   * KONFIGŪRAVIMO BŪDAI KARTU = KLAIDA, ne pirmenybė"), bet tik MINKŠTAME
   * self-check'e, kuris vykdomas PO `listen()`.
   *
   * Auditui to nepakanka: `auditoPoolNustatymai()` tyliai teiktų pirmenybę
   * `DATABASE_URL`, tad servisas paskelbtų readiness ir rašytų auditą į VISAI
   * KITĄ duomenų bazę nei ta, kurią nurodo Compose `PG*`. Auditas yra būtent ta
   * lentelė, apie kurią klausiama po incidento - „į kurią DB jis rašė" negali
   * priklausyti nuo tylios pirmenybės.
   */
  const { resolveAuditBackend } = require("../utils/auditStore/backendSelection");

  const bazė = { AUDIT_BACKEND: "postgres", AUDIT_ID_SALT: "s", AUDIT_ID_SALT_ID: "i" };

  /** Kiekvienas atskirai - teisėtas. */
  assert.equal(resolveAuditBackend({ ...bazė, DATABASE_URL: "postgres://a/b" }), "postgres");
  assert.equal(resolveAuditBackend({ ...bazė, PGHOST: "postgres" }), "postgres");

  assert.throws(
    () => resolveAuditBackend({ ...bazė, DATABASE_URL: "postgres://a/b", PGHOST: "kitas" }),
    /IR DATABASE_URL, IR PGHOST|TIK VIENĄ/,
    "abu kartu privalo nutraukti startą, o ne tyliai pasirinkti vieną"
  );
});

test("DOKUMENTACIJA: `PG*` forma įvardyta kaip PALAIKOMA, o konfliktas - kaip klaida", () => {
  /**
   * ⚠️ AGENTS.md §12.1: dokumentacija negali teigti kitaip nei kodas.
   *
   * `resolveAuditBackend()` priima `PG*` be `DATABASE_URL`, bet dokumentacija
   * sakė, kad `DATABASE_URL` privalomas. Operatorius, sekantis ją su Compose
   * `PG*`, arba be reikalo konstruotų URL (įskaitant slaptažodį, kurio
   * rezervuoti simboliai pakeičia URI reikšmę), arba manytų, kad konfigūracija
   * neteisinga.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const saknis = path.join(__dirname, "..", "..");

  const doc = fs.readFileSync(path.join(saknis, "docs", "audit-storage.md"), "utf8");
  const env = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  for (const [pavadinimas, turinys] of [["docs/audit-storage.md", doc], [".env.example", env]]) {
    assert.match(turinys, /PGHOST/, `${pavadinimas}: \`PG*\` forma turi būti įvardyta`);
    assert.match(
      turinys,
      /ABU KARTU/,
      `${pavadinimas}: konfliktas turi būti įvardytas kaip klaida, ne pirmenybė`
    );
  }
});

test("GENERACIJOS: skenavimo KLAIDA metama, o ne verčiama į tuščią sąrašą", async () => {
  /**
   * ⚠️ FAIL-OPEN ČIA BŪTŲ GDPR SPRAGA, IR DVIGUBA.
   *
   * Jei `usedGenerations()` po SQL klaidos grąžintų `[]`, atsitiktų du dalykai
   * vienu metu:
   *   1. našlaičių patikra praeitų TUŠČIAI - „nėra generacijų, nėra ką tikrinti",
   *      tad startas pavyktų su įrašais, kurių `subject_id` nebeatkuriamas;
   *   2. kiekio taisyklė nuspręstų, kad VISI istoriniai raktai nebereikalingi, ir
   *      atmestų raktus, kurie realiai turi įrašų - klaidingas startup FAIL.
   *
   * ⚠️ TIKRINAMA ELGSENA, NE ŠALTINIO TEKSTAS. Pirmoji šios patikros versija
   * skenavo failą ieškodama `catch` - tai tik tripwire (AGENTS.md §9.2), ir ji
   * nebūtų pastebėjusi klaidos rijimo, atsiradusio kitoje vietoje (pvz. `.catch()`
   * grandinėje ar aukštesniame kvietėjuje).
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  /** ⚠️ KRENTANTI UŽKLAUSA, ne tuščia lentelė - tai skirtingi dalykai. */
  const krentantisPool = {
    query: async () => {
      const e = new Error("connection terminated unexpectedly");
      e.code = "57P01";
      throw e;
    },
  };

  await assert.rejects(
    () => createPostgresStore(krentantisPool, { hashKeyId: "A" }).usedGenerations(),
    (e) => e.code === "57P01",
    "skenavimo klaida privalo propaguotis, kad `init()` nutrauktų startą"
  );

  /**
   * ⚠️ PRIEŠINGA PUSĖ: tuščia lentelė yra TEISĖTAS `[]`.
   *
   * Be jos testas praeitų ir tada, kai `usedGenerations()` meta VISADA - o tai
   * padarytų neįmanomą pirmą startą su tuščia `audit_log`.
   */
  const tusciasPool = { query: async () => ({ rows: [] }) };
  assert.deepEqual(
    await createPostgresStore(tusciasPool, { hashKeyId: "A" }).usedGenerations(),
    [],
    "tuščia lentelė nėra klaida"
  );

  /**
   * Tripwire greta elgsenos: kvietimo vieta `init()` kelyje irgi neturi `catch`,
   * kitaip klaida būtų sugauta jau po to, kai `usedGenerations()` ją teisingai
   * metė. Pjaunama iki KITOS funkcijos deklaracijos - `indexOf("async function
   * init")` randa `initializePostgres` (poeilutė) ir duotų tuščią intervalą.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");

  const indexSrc = beKomentaru(
    fs.readFileSync(path.join(__dirname, "..", "utils/auditStore/index.js"), "utf8")
  );
  const pradzia = indexSrc.indexOf("async function patikrintiGeneracijas");
  assert.notEqual(pradzia, -1, "prielaida: patikra rasta");

  const kita = indexSrc.slice(pradzia + 1).search(/\n(async )?function \w+/);
  const patikra = indexSrc.slice(pradzia, kita === -1 ? undefined : pradzia + 1 + kita);

  assert.ok(patikra.length > 50, "prielaida: funkcijos kūnas išpjautas");
  assert.doesNotMatch(patikra, /catch/, "generacijų patikra negali ryti skenavimo klaidos");
});

test("ZONDAS: tikrina TEISES (SELECT/INSERT/DELETE), ne vien ryšį", () => {
  /**
   * ⚠️ `SELECT 1` ĮRODO TIK TIEK, KAD JUNGTIS GYVA (#155, 7.4f / #231).
   *
   * Rolė su atimta `DELETE` teise jį praeitų, o `removeBySubjectIdentifier()`
   * kristų VYKDYMO metu - GDPR ištrynimas lūžtų tyliai, o visi sveikatos
   * signalai liktų žali. Būtent todėl `DELETE` yra būtinųjų aibėje.
   */
  const { BUTINOS_PRIVILEGIJOS } = require("../utils/auditStore/postgresStore");

  assert.deepEqual(
    [...BUTINOS_PRIVILEGIJOS].sort(),
    ["DELETE", "INSERT", "SELECT"],
    "trūkstama privilegija reikštų tyliai lūžtantį kelią"
  );
});

test("ZONDAS: kiekvienos trūkstamos teisės pakanka, kad zondas grąžintų `false`", async () => {
  const { createPostgresStore, BUTINOS_PRIVILEGIJOS } = require("../utils/auditStore/postgresStore");

  const suTeisemis = (atimta) => ({
    query: async () => ({
      rows: [
        BUTINOS_PRIVILEGIJOS.reduce(
          (acc, p) => ({ ...acc, [p.toLowerCase()]: p !== atimta }),
          { perskaityta: 0, seka_leidziama: true }
        ),
      ],
    }),
  });

  assert.equal(
    await createPostgresStore(suTeisemis(null), { hashKeyId: "A" }).probe(),
    true,
    "su visomis teisėmis zondas teigiamas"
  );

  for (const privilegija of BUTINOS_PRIVILEGIJOS) {
    const store = createPostgresStore(suTeisemis(privilegija), { hashKeyId: "A" });
    assert.equal(
      await store.probe(),
      false,
      `be ${privilegija} zondas privalo grąžinti false - kitaip gedimas liktų nematomas`
    );
  }
});

test("ZONDAS: NEMUTUOJA - jokio INSERT ar DELETE bandomojo įrašo", () => {
  /**
   * Readiness kviečiamas kiekvieno orkestruotojo probe metu. Bandomasis įrašas
   * reikštų nuolatinį audito lentelės šiukšlinimą ir WAL srautą dėl
   * diagnostikos - o append-only trigeris tokios eilutės dar ir neleistų
   * ištrinti be pėdsako.
   */
  const uzklausos = [];
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  const pool = {
    query: async (sql) => {
      uzklausos.push(sql);
      return {
        rows: [{ perskaityta: 0, select: true, insert: true, delete: true, seka_leidziama: true }],
      };
    },
  };

  return createPostgresStore(pool, { hashKeyId: "A" })
    .probe()
    .then(() => {
      assert.equal(uzklausos.length, 1, "vienas round-trip");

      /**
       * ⚠️ Tikrinami SAKINIAI, ne žodžiai: `has_table_privilege(...) AS "insert"`
       * teisėtai turi žodį `insert` stulpelio pseudonime. Pirmoji šios patikros
       * versija būtent taip ir krito.
       */
      assert.doesNotMatch(uzklausos[0], /\bINSERT\s+INTO\b/i, "zondas negali rašyti");
      assert.doesNotMatch(uzklausos[0], /\bDELETE\s+FROM\b/i, "zondas negali trinti");
      assert.doesNotMatch(uzklausos[0], /\bUPDATE\s+\w+\s+SET\b/i, "zondas negali keisti");
      assert.match(uzklausos[0], /has_table_privilege/, "teisės tikrinamos per katalogą");
    });
});

test("ZONDAS: SEKOS teisė tikrinama - be jos kiekvienas `append()` kristų", async () => {
  /**
   * ⚠️ `INSERT` ANT LENTELĖS NEPAKANKA (#231 Codex peržiūra, P1).
   *
   * `seq BIGSERIAL` kiekvieno rašymo metu kviečia `nextval()` ant ATSKIRO sekos
   * objekto, kurio teisės suteikiamos atskirai. Rolė su `INSERT` ant lentelės,
   * bet be teisės ant sekos, praeitų senąjį zondą žalią, o kiekvienas
   * `append()` kristų vykdymo metu - tas pats tylaus gedimo režimas, dėl kurio
   * privilegijų zondas ir daromas.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  const suSeka = (leidziama) => ({
    query: async () => ({
      rows: [
        {
          perskaityta: 0,
          select: true,
          insert: true,
          delete: true,
          seka_leidziama: leidziama,
        },
      ],
    }),
  });

  assert.equal(
    await createPostgresStore(suSeka(true), { hashKeyId: "A" }).probe(),
    true,
    "su visomis teisėmis zondas teigiamas"
  );

  assert.equal(
    await createPostgresStore(suSeka(false), { hashKeyId: "A" }).probe(),
    false,
    "be teisės ant sekos zondas PRIVALO būti raudonas"
  );

  /**
   * ⚠️ `NULL` (sekos nėra) yra fail-closed, ne „nežinoma". Stulpelis be sekos
   * reiškia kitokią schemą, nei ta, kuriai rašytas `append()`.
   */
  assert.equal(
    await createPostgresStore(suSeka(null), { hashKeyId: "A" }).probe(),
    false,
    "dingusi seka negali reikšti sveikos būsenos"
  );
});

test("ZONDAS: seka randama per katalogą, o abu iškvietimai NEMUTUOJA", async () => {
  /**
   * ⚠️ Sekos vardas NESPĖLIOJAMAS. `audit_log_seq_seq` yra numatytoji forma, bet
   * ne garantija - pervadinta ar perkelta seka reikštų zondą, tikrinantį
   * neegzistuojantį objektą, t. y. tylų `false` visai sveikam diegimui.
   *
   * ⚠️ Ir svarbiausia: patikra negali kviesti `nextval()`. Tai sunaudotų sekos
   * reikšmes kiekvieno readiness poll'o metu ir paliktų `seq` spragas.
   */
  const uzklausos = [];
  const { createPostgresStore, SEKOS_PRIVILEGIJOS } = require("../utils/auditStore/postgresStore");

  const pool = {
    query: async (sql) => {
      uzklausos.push(sql);
      return {
        rows: [{ perskaityta: 0, select: true, insert: true, delete: true, seka_leidziama: true }],
      };
    },
  };

  await createPostgresStore(pool, { hashKeyId: "A" }).probe();

  assert.equal(uzklausos.length, 1, "vienas round-trip - seka netampa antra užklausa");
  assert.match(uzklausos[0], /pg_get_serial_sequence/, "seka randama per katalogą");
  assert.match(uzklausos[0], /has_sequence_privilege/, "tikrinama sekos teisė");
  assert.doesNotMatch(uzklausos[0], /\bnextval\b/i, "zondas negali sunaudoti sekos reikšmės");
  assert.doesNotMatch(uzklausos[0], /\bsetval\b/i, "zondas negali perstatyti sekos");

  /**
   * `nextval()` reikalauja `USAGE` ARBA `UPDATE`. Reikalauti vien `USAGE`
   * reikštų klaidingai raudoną zondą veikiančiam diegimui.
   */
  assert.deepEqual([...SEKOS_PRIVILEGIJOS].sort(), ["UPDATE", "USAGE"]);
  for (const privilegija of SEKOS_PRIVILEGIJOS) {
    assert.ok(
      uzklausos[0].includes(`'${privilegija}'`),
      `${privilegija} privalo dalyvauti patikroje`
    );
  }
});

test("SINGLE-FLIGHT: kabanti užklausa NEUŽRAKINA readiness po biudžeto", async () => {
  /**
   * ⚠️ BE RIBOS SINGLE-FLIGHT VIRSTA UŽRAKTU (#233 Codex raundas 2, #3).
   *
   * Kai `READINESS_TIMEOUT_MS` trumpesnis už pool'o `query_timeout`, maršrutas
   * nutrūksta, o užklausa lieka kaboti. Kiekvienas kitas poll'as gaudavo TĄ PATĮ
   * pažadą - tad net atsistačiusios DB readiness nepamatydavo, kol sena užklausa
   * pagaliau baigsis. Rezultatas priešingas single-flight tikslui: vietoj
   * apribotos apkrovos gaudavom neapribotą prastovą.
   *
   * Tikrinama UŽKLAUSŲ SKAIČIUMI, ne laiku: antras poll'as po biudžeto privalo
   * inicijuoti NAUJĄ užklausą.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  const BIUDZETAS_MS = 60;
  let kiek = 0;
  let atrakintiAntra = null;

  const pool = {
    query: async () => {
      kiek += 1;
      /** Pirma užklausa KABO - kaip DB, kuri nebeatsako. */
      if (kiek === 1) return new Promise(() => {});
      return new Promise((resolve) => {
        atrakintiAntra = () =>
          resolve({
            rows: [{ perskaityta: 0, select: true, insert: true, delete: true, seka_leidziama: true }],
          });
      });
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A", readinessBudgetMs: BIUDZETAS_MS });

  /** ⚠️ Nelaukiam: maršrutas šio pažado jau atsisakė. */
  store.probe().catch(() => {});

  /** Iškart po jo - dalijamės, nes biudžetas dar nepasibaigęs. */
  store.probe().catch(() => {});
  assert.equal(kiek, 1, "biudžeto ribose lygiagretūs poll'ai privalo dalintis viena užklausa");

  await new Promise((r) => setTimeout(r, BIUDZETAS_MS + 20));

  const treciasZondas = store.probe();
  assert.equal(kiek, 2, "po biudžeto naujas poll'as privalo pradėti SAVO užklausą");

  atrakintiAntra();
  assert.equal(await treciasZondas, true, "atsistačiusi DB pastebima nelaukiant senos užklausos");
});

test("KEŠAS: PASENĘS zondas negali jo užpildyti - net grąžinęs `true`", async () => {
  /**
   * ⚠️ ŠIĄ SPRAGĄ ĮNEŠĖ PATS SINGLE-FLIGHT TAISYMAS (#233 Codex raundas 3, #1).
   *
   * Seka, kuri readiness padaro žalią su atimtomis teisėmis:
   *   1. zondas A startuoja ir kabo;
   *   2. praėjus biudžetui poll'as paleidžia zondą B;
   *   3. B grąžina `false` - teisės atimtos;
   *   4. A PAVĖLUOTAI baigiasi su senu `true` ir įrašo jį į kešą;
   *   5. kitas poll'as gauna `true` iš kešo, NEIŠSIUNTĘS jokios užklausos.
   *
   * Tai tas pats tylus gedimas, dėl kurio privilegijų zondas apskritai daromas,
   * tik per savo paties kešą - todėl P1, ne kešavimo smulkmena.
   *
   * Įrodymas - UŽKLAUSŲ SKAIČIUS: jei kešas būtų užterštas, trečio poll'o
   * užklausos nebūtų.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  const BIUDZETAS_MS = 60;
  let kiek = 0;
  let baigtiPirma = null;

  const pool = {
    query: async () => {
      kiek += 1;

      /** Pirma užklausa kabo, o vėliau grąžina SENĄ „viskas gerai". */
      if (kiek === 1) {
        return new Promise((resolve) => {
          baigtiPirma = () =>
            resolve({
              rows: [
                { perskaityta: 0, select: true, insert: true, delete: true, seka_leidziama: true },
              ],
            });
        });
      }

      /** Tuo metu teisės jau atimtos - visos vėlesnės užklausos tai mato. */
      return {
        rows: [{ perskaityta: 0, select: true, insert: true, delete: false, seka_leidziama: true }],
      };
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A", readinessBudgetMs: BIUDZETAS_MS });

  const pasenes = store.probe();

  await new Promise((r) => setTimeout(r, BIUDZETAS_MS + 20));

  assert.equal(await store.probe(), false, "prielaida: naujas zondas mato atimtas teises");
  assert.equal(kiek, 2, "prielaida: pasenęs įrašas nebedalinamas");

  /** ── Pasenęs zondas baigiasi PO to, su senu `true` ────────────────────── */
  baigtiPirma();

  assert.equal(
    await pasenes,
    false,
    "pasenusio zondo atsakymas per senas, kad juo remtųsi readiness - fail-closed"
  );

  /** ── Ir svarbiausia: kešas privalo likti TUŠČIAS ──────────────────────── */
  assert.equal(await store.probe(), false, "readiness negali tapti žalia dėl seno atsakymo");
  assert.equal(kiek, 3, "trečias poll'as PRIVALO klausti DB - kešas negali būti užterštas");
});

test("KEŠAS: įrodomas `pool.query` SKAIČIUMI, ne laiko matavimu", async () => {
  /**
   * ⚠️ REALIZACIJA SU `Date.now()`, BET BE FAKTINIO PRALEIDIMO, PRAEITŲ NAIVŲ TESTĄ.
   *
   * Laiko matavimas parodytų, kad antras kvietimas greitas - bet jis būtų
   * greitas ir tada, kai užklausa vis tiek išsiunčiama į vietinę DB. Vienintelis
   * įrodymas yra kvietimų SKAIČIUS.
   */
  const { createPostgresStore, PROBE_CACHE_TTL_MS } = require("../utils/auditStore/postgresStore");

  let kiek = 0;
  const pool = {
    query: async () => {
      kiek += 1;
      return {
        rows: [{ perskaityta: 0, select: true, insert: true, delete: true, seka_leidziama: true }],
      };
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A" });

  for (let i = 0; i < 5; i += 1) assert.equal(await store.probe(), true);
  assert.equal(kiek, 1, "penki kvietimai kešo lange privalo duoti VIENĄ užklausą");

  /**
   * ⚠️ IR KEŠAS PRIVALO BAIGTI GALIOTI. Amžinai kešuotas „sveikas" slėptų
   * dingusią DB - readiness rodytų 200, kol procesas gyvas.
   */
  store._resetProbeCacheForTests();
  await store.probe();
  assert.equal(kiek, 2, "pasibaigus galiojimui užklausa privalo pasikartoti");
  assert.ok(PROBE_CACHE_TTL_MS > 0 && PROBE_CACHE_TTL_MS <= 5000, "TTL turi būti trumpas");
});

test("KEŠAS: NEIGIAMAS rezultatas NEKEŠUOJAMAS, bet lygiagretūs zondai sujungiami", async () => {
  /**
   * ⚠️ DU PRIEŠINGI REIKALAVIMAI, IR ABU BŪTINI.
   *
   * Neigiamo kešuoti negalima: atsistačiusi DB turi būti pastebėta per kitą
   * poll'ą, ne po TTL. Bet be jokios apsaugos krentanti DB gautų užklausą
   * kiekvienam poll'ui - tas pats apkrovos kelias, kurio kešas ir vengia.
   *
   * Sprendimas - SINGLE-FLIGHT, ne trumpas neigiamas TTL: jis apriboja
   * LYGIAGREČIAS užklausas iki vienos, bet atsistatymo aptikimo neatideda.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  let kiek = 0;
  let atsakymas = false;
  const pool = {
    query: async () => {
      kiek += 1;
      await new Promise((r) => setImmediate(r));
      return {
        rows: [
          { perskaityta: 0, select: true, insert: true, delete: atsakymas, seka_leidziama: true },
        ],
      };
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A" });

  /** Nuoseklūs neigiami kvietimai - kiekvienas klausia DB iš naujo. */
  assert.equal(await store.probe(), false);
  assert.equal(await store.probe(), false);
  assert.equal(kiek, 2, "neigiamas rezultatas NEGALI būti kešuojamas");

  /** Lygiagretūs - viena užklausa visiems. */
  kiek = 0;
  const [a, b, c] = await Promise.all([store.probe(), store.probe(), store.probe()]);
  assert.deepEqual([a, b, c], [false, false, false]);
  assert.equal(kiek, 1, "lygiagretūs zondai privalo dalintis viena užklausa");

  /** Atsistačius DB - pastebima IŠ KARTO, be TTL laukimo. */
  atsakymas = true;
  assert.equal(await store.probe(), true, "atsistatymas neturi būti atidėtas");
});
