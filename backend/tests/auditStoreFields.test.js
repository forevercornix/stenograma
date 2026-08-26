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
