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

test("RETENCIJOS ĮSPĖJIMAS: turinys įvardija TIKSLIAI tai, ko operatorius nežino", () => {
  /**
   * ⚠️ TURINIO PATIKRA VYKDOMA VIETOJE; kad įspėjimas realiai LOGINAMAS starte,
   * tikrina `auditPersistence.integration` (reikia tikros DB).
   *
   * Postgres režime `audit_log` neribotai auga iki [7.4d]. Diegimas, matantis
   * `AUDIT_RETENTION_DAYS=30` konfigūracijoje, pagrįstai manytų, kad ji galioja -
   * todėl įspėjimas privalo pasakyti abu dalykus: kad NEVEIKIA ir kad lentelė AUGS.
   */
  const { RETENCIJOS_ISPEJIMAS } = require("../utils/auditStore");

  for (const privalomas of [
    "AUDIT_RETENTION_DAYS",
    "AUDIT_MAX_ENTRIES",
    "audit_log",
    "7.4d",
    "docs/audit-storage.md",
  ]) {
    assert.ok(
      RETENCIJOS_ISPEJIMAS.includes(privalomas),
      `įspėjime turi būti „${privalomas}" - kitaip operatorius nežinotų, ko ieškoti`
    );
  }

  assert.match(RETENCIJOS_ISPEJIMAS, /neribotai|nešalinamos/i, "poveikis turi būti įvardytas");

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
