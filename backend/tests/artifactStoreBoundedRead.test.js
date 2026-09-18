const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { skaitytiRibotai } = require("../utils/artifactStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");

/**
 * RIBOTAS SKAITYMAS — HIDRATACIJOS STABDIS (#157, PR-3).
 *
 * ⚠️ PIGI PATIKRA NIEKO NEGARANTUOJA. „Persistintas dydis > riba" taupo I/O, bet
 * objektas saugykloje gali būti perrašytas ar sugadintas iki didesnio — tada
 * pasenusi maža reikšmė patikrą praeina, ir į atmintį patenka savavališkai didelis
 * turinys. Ribotumą duoda TIK skaitiklis skaitymo metu, ir būtent jis čia tikrinamas.
 */

async function aplinka(t) {
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-ribotas-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));
  return createFsArtifactStore({ root: saknis });
}

test("teisėtas objektas perskaitomas ir grąžina TIKRĄ dydį", async (t) => {
  const saugykla = await aplinka(t);
  const reiksme = { text: "vientisumas", segments: [1, 2, 3] };

  const kvitas = await saugykla.put("results/a.json", reiksme);
  const { reiksme: perskaityta, bytes } = await skaitytiRibotai(saugykla, "results/a.json", {
    maxBaitai: 1024 * 1024,
    deklaruotiBaitai: kvitas.bytes,
  });

  assert.deepEqual(perskaityta, reiksme);
  assert.equal(bytes, kvitas.bytes, "dydis matuojamas skaitant, ne imamas iš metaduomenų");
});

test("objektas, IŠAUGĘS už deklaruoto dydžio, yra SUGADINIMAS", async (t) => {
  /**
   * ⚠️ TAI TA PATI KLASĖ KAIP `verify()`: turinys nebeatitinka to, kas apie jį
   * įrašyta. Tylus priėmimas reikštų, kad hidratacija grąžina duomenis, kurių
   * vientisumas paneigtas.
   */
  const saugykla = await aplinka(t);
  const kvitas = await saugykla.put("results/b.json", { text: "mažas" });

  /** Objektas pakeičiamas UŽ saugyklos nugaros — kaip po sugadinimo ar perrašymo. */
  const didelis = JSON.stringify({ text: "x".repeat(50000) });
  await fsp.writeFile(path.join(saugykla.root, "results/b.json"), didelis, "utf8");

  await assert.rejects(
    () =>
      skaitytiRibotai(saugykla, "results/b.json", {
        maxBaitai: 1024 * 1024,
        deklaruotiBaitai: kvitas.bytes,
      }),
    (klaida) => klaida.code === "ARTIFACT_CORRUPT",
    "didesnis nei deklaruota — sugadinimas, ne dydžio riba"
  );
});

test("objektas, NUPJAUTAS iki mažesnio, irgi yra SUGADINIMAS", async (t) => {
  /**
   * ⚠️ Nupjautas objektas dažniausiai nebus galiojantis JSON, bet remtis tuo būtų
   * prielaida: tikrinama tiesiogiai, kad hidratacija negrąžintų dalies kaip viso.
   */
  const saugykla = await aplinka(t);
  const reiksme = { text: "x".repeat(200) };
  const kvitas = await saugykla.put("results/c.json", reiksme);

  await fsp.writeFile(path.join(saugykla.root, "results/c.json"), JSON.stringify({ text: "x" }), "utf8");

  await assert.rejects(
    () =>
      skaitytiRibotai(saugykla, "results/c.json", {
        maxBaitai: 1024 * 1024,
        deklaruotiBaitai: kvitas.bytes,
      }),
    (klaida) => klaida.code === "ARTIFACT_CORRUPT"
  );
});

test("viršyta `MAX_RESULT_BYTES` yra RIBOS klaida, ne sugadinimas", async (t) => {
  /**
   * ⚠️ DVI RIBOS — DVI PRASMĖS. Per didelis rezultatas yra politikos klausimas
   * (`ResultLimitError`, #153), o neatitikimas metaduomenims — vientisumo. Suplakus
   * juos, operatorius nežinotų, ar didinti ribą, ar tirti saugyklą.
   */
  const saugykla = await aplinka(t);
  const reiksme = { text: "x".repeat(5000) };
  const kvitas = await saugykla.put("results/d.json", reiksme);

  await assert.rejects(
    () =>
      skaitytiRibotai(saugykla, "results/d.json", {
        maxBaitai: 100,
        deklaruotiBaitai: kvitas.bytes,
      }),
    (klaida) => klaida.name === "ResultLimitError" && klaida.kind === "result_bytes"
  );
});

test("be deklaruoto dydžio stabdo `MAX_RESULT_BYTES` — skaitiklis, ne metaduomenys", async (t) => {
  const saugykla = await aplinka(t);
  await saugykla.put("results/e.json", { text: "x".repeat(5000) });

  await assert.rejects(
    () => skaitytiRibotai(saugykla, "results/e.json", { maxBaitai: 100 }),
    (klaida) => klaida.name === "ResultLimitError"
  );

  /** KONTROLĖ: su pakankama riba tas pats objektas perskaitomas. */
  const { bytes } = await skaitytiRibotai(saugykla, "results/e.json", { maxBaitai: 1024 * 1024 });
  assert.ok(bytes > 5000);
});
