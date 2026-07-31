const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

process.env.NODE_ENV = "test";

const { buildExport } = require("../services/exportService");
const redactionComponent = require("../utils/redactionComponent");
const privacyPolicy = require("../utils/privacyPolicy");
const { validatePrivacyConfig, describeForDiagnostics } = require("../utils/privacyConfig");

/**
 * GDPR #5: EKSPORTO KONTROLĖ.
 *
 * Du DoD punktai:
 *  1) privacy-first režimas gali centralizuotai išjungti neredaguotą eksportą;
 *  2) retencija turi apimti eksporto artefaktus.
 *
 * Antrasis punktas šioje architektūroje uždaromas ĮRODYMU, o ne funkcija:
 * eksportai generuojami srautu į HTTP atsakymą ir NIEKUR nesaugomi, tad
 * retencijai nėra ko dengti. Žr. paskutinį testą - jis tą prielaidą tikrina,
 * o ne priima už tiesą.
 */

const MARKER = "EXPORT-Jonas-39001010000";

const PROTOCOL = {
  pavadinimas: `Posėdis su ${MARKER}`,
  data: "2026-01-01",
  dalyviai: [`Jonas ${MARKER}`],
  darbotvarke: ["Ataskaita"],
  aptarti_klausimai: [{ klausimas: "Ataskaita", santrauka: `Pristatė ${MARKER}` }],
  nutarimai: ["Patvirtinta"],
  veiksmai: [{ uzduotis: "Parengti", atsakingas: `Jonas ${MARKER}`, terminas: "2026-02-01" }],
};

function withPolicy(env, redact, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  redactionComponent._setLoaderForTests(redact ? () => ({ redact }) : null);
  privacyPolicy._resetForTests();

  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      redactionComponent._setLoaderForTests(null);
      privacyPolicy._resetForTests();
    }
  })();
}

test("numatytai (EXPORT_ALLOW_ORIGINAL=true) eksportas nepasikeičia", async () => {
  await withPolicy({ EXPORT_ALLOW_ORIGINAL: undefined }, null, async () => {
    const txt = await buildExport(PROTOCOL, "txt");
    assert.ok(txt.buffer.toString("utf8").includes(MARKER), "be nuostatos originalas eksportuojamas kaip anksčiau");
  });
});

test("EXPORT_ALLOW_ORIGINAL=false - VISI trys formatai gauna redaguotą turinį", async () => {
  const redact = (text) => text.replaceAll(MARKER, "[REDAGUOTA]");

  await withPolicy({ EXPORT_ALLOW_ORIGINAL: "false" }, redact, async () => {
    const txt = (await buildExport(PROTOCOL, "txt")).buffer.toString("utf8");
    assert.ok(!txt.includes(MARKER));
    assert.ok(txt.includes("[REDAGUOTA]"));

    const csv = (await buildExport(PROTOCOL, "csv")).buffer.toString("utf8");
    assert.ok(!csv.includes(MARKER));

    // DOCX yra dvejetainis (ZIP) - tikrinam patį buferį, nes būtent čia
    // "redaguok galutinį tekstą" požiūris būtų tyliai neveikęs.
    const docx = await buildExport(PROTOCOL, "docx");
    assert.ok(!docx.buffer.toString("latin1").includes(MARKER), "DOCX negali turėti originalo");
  });
});

test("FAIL-CLOSED: be #4 komponento failas apskritai negeneruojamas", async () => {
  await withPolicy({ EXPORT_ALLOW_ORIGINAL: "false" }, null, async () => {
    await assert.rejects(
      () => buildExport(PROTOCOL, "txt"),
      (e) => e.code === "EXPORT_ORIGINAL_FORBIDDEN"
    );
  });
});

test("FAIL-CLOSED: redakcijai kritus originalas NEGRĄŽINAMAS", async () => {
  const redact = () => {
    throw new Error("redakcija krito");
  };

  await withPolicy({ EXPORT_ALLOW_ORIGINAL: "false" }, redact, async () => {
    await assert.rejects(
      () => buildExport(PROTOCOL, "txt"),
      (e) => e.code === "EXPORT_ORIGINAL_FORBIDDEN" && !e.message.includes(MARKER)
    );
  });
});

test("startup: EXPORT_ALLOW_ORIGINAL=false be #4 komponento = klaida", () => {
  const { errors } = validatePrivacyConfig({ EXPORT_ALLOW_ORIGINAL: "false" });
  assert.ok(errors.some((e) => /EXPORT_ALLOW_ORIGINAL/.test(e) && /issue #4/.test(e)));
});

test("diagnostika rodo eksporto politiką ir artefaktų būseną", () => {
  const diagnostics = describeForDiagnostics({});
  assert.deepEqual(diagnostics.export, { allowOriginal: true, artifactsPersisted: false });
});

test("RETENCIJA: eksportas NERAŠO į diską (todėl retencijai nėra ko valyti)", async () => {
  /**
   * Ne katalogo skenavimas, o rašymo API perėmimas.
   *
   * Pirmoji šio testo versija lygino os.tmpdir() turinį prieš/po - ir buvo
   * klaidinga: `node --test` failus leidžia LYGIAGREČIAI, tad į tą patį katalogą
   * tuo metu rašo kiti testai (pvz. faster-whisper `stenograma-embedded-*.wav`).
   * Testas matydavo svetimą failą ir kaltindavo eksportą.
   *
   * Perimant fs API tikrinama tiksliai ta savybė, kuri rūpi - ar ŠIS kodas rašo -
   * ir rezultatas nepriklauso nuo to, kas vyksta aplinkui.
   */
  const attempts = [];
  const targets = [
    [fs, "writeFile"],
    [fs, "writeFileSync"],
    [fs, "appendFile"],
    [fs, "appendFileSync"],
    [fs, "createWriteStream"],
    [fs, "openSync"],
    [fs, "mkdtempSync"],
    [fs.promises, "writeFile"],
    [fs.promises, "appendFile"],
    [fs.promises, "open"],
    [fs.promises, "mkdtemp"],
  ];

  const saved = targets.map(([obj, key]) => [obj, key, obj[key]]);
  for (const [obj, key] of targets) {
    obj[key] = (...args) => {
      attempts.push(`${key}(${String(args[0])})`);
      throw new Error(`Eksportas bandė rašyti į diską: ${key}`);
    };
  }

  try {
    await withPolicy({ EXPORT_ALLOW_ORIGINAL: undefined }, null, async () => {
      for (const format of ["txt", "csv", "docx"]) {
        const out = await buildExport(PROTOCOL, format);
        assert.ok(out && out.buffer, `${format} turi būti sugeneruotas atmintyje`);
      }
    });
  } finally {
    for (const [obj, key, original] of saved) obj[key] = original;
  }

  assert.deepEqual(attempts, [], `eksportas rašė į diską: ${attempts.join(", ")}`);
});
