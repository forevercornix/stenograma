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

test("ĮVYKIO ŠABLONAS: migracija naudoja `auditEvents` autoritetą, ne savo kopiją", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2), ne elgsenos įrodymas.
   *
   * Elgseną - kad DB realiai atmeta neatitinkantį įvykį - tikrina integracinis
   * testas prieš tikrą DB. Čia saugoma tik nuo antros šablono kopijos
   * atsiradimo: ji išsiskirtų tyliai, ir runtime priimtų įvykį, kurio DB
   * nebepriima.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const kelias = path.join(__dirname, "..", "migrations", "1755300000000_audit-log.js");
  const turinys = fs.readFileSync(kelias, "utf8");

  assert.match(
    turinys,
    /require\("\.\.\/utils\/auditEvents"\)/,
    "migracija privalo IMPORTUOTI šabloną, o ne jį perrašyti"
  );
  assert.doesNotMatch(
    turinys,
    /\^\[A-Z\]\[A-Z0-9_\]/,
    "šablono literalas migracijoje reikštų antrą autoritetą"
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
