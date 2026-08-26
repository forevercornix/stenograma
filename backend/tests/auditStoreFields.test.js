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

test("`meta` ALLOWLIST: `undefined` nevirsta raktu (paritetas su memory)", () => {
  const meta = isrinktiMeta({ details: undefined, error: null });

  assert.ok(!("details" in meta), "`undefined` neturi sukurti rakto JSONB'e");
  assert.equal(meta.error, null, "`null` yra reikšmė ir privalo išlikti");
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
