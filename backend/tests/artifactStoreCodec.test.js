const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  paruostiReiksme,
  atkurtiReiksme,
  patikrintiRakta,
  MAX_SEGMENTO_BAITAI,
} = require("../utils/artifactStore/validation");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");

/**
 * ARTEFAKTO KODEKAS — VIENA REIKŠMIŲ SRITIS ABIEM KRYPTIM (#157, PR-2, Codex #290).
 *
 * ⚠️ RAŠYMO IR SKAITYMO SRITYS BUVO SKIRTINGOS.
 *
 * `put()` atmesdavo viršutinio lygio `null`, NUL simbolį ir neporinį surogatą, o
 * `read()` juos priimdavo. Atkurtas ar iš išorės pakeistas objektas galėjo grąžinti
 * tai, ko riba niekada nebūtų įsileidusi — ir literalus `null` čia blogiausias: jis
 * atkuria „`completed` be rezultato" būseną, po kurios terminalus valymas ištrina
 * šaltinio audio.
 *
 * Testuojama KLASĖ: kiekviena rašymo pusės taisyklė privalo galioti ir skaitymo
 * pusėje. Sąrašas išvedamas iš to paties scenarijų rinkinio, ne rašomas antrą kartą.
 */

const NUL = String.fromCharCode(0);
const VIENISAS_SUROGATAS = String.fromCharCode(0xd800);

/** Reikšmės, kurių riba NEPRIIMA rašant. Kiekviena jų privalo būti atmesta ir skaitant. */
const UZ_SRITIES = [
  { vardas: "viršutinio lygio null", tekstas: "null" },
  { vardas: "viršutinio lygio NaN (per Infinity)", tekstas: "1e999" },
  { vardas: "NUL tekste", tekstas: JSON.stringify({ x: `a${NUL}b` }) },
  { vardas: "vienišas surogatas", tekstas: JSON.stringify({ x: `a${VIENISAS_SUROGATAS}b` }) },
];

test("SKAITYMAS taiko TĄ PAČIĄ sritį kaip rašymas", () => {
  for (const scenarijus of UZ_SRITIES) {
    /** Kontrolė: ta pati reikšmė RAŠANT irgi atmetama — kitaip lygintume su niekuo. */
    let rasymoKodas = null;
    try {
      paruostiReiksme(JSON.parse(scenarijus.tekstas));
    } catch (klaida) {
      rasymoKodas = klaida.code;
    }
    assert.equal(rasymoKodas, "ARTIFACT_VALUE_UNSUPPORTED", `${scenarijus.vardas}: rašymo pusė`);

    let skaitymoKodas = null;
    try {
      atkurtiReiksme(Buffer.from(scenarijus.tekstas, "utf8"), "results/x.json");
    } catch (klaida) {
      skaitymoKodas = klaida.code;
    }

    /**
     * ⚠️ KODAS `SUGADINTAS`, NE `REIKSME`. Čia kalta ne kvietėjo įvestis, o
     * saugykloje gulintis turinys: „reikšmė nepalaikoma" nusiųstų operatorių
     * tikrinti tiekėjo rezultato, nors taisyti reikia objektą.
     */
    assert.equal(skaitymoKodas, "ARTIFACT_CORRUPT", `${scenarijus.vardas}: skaitymo pusė`);
  }
});

test("KONTROLĖ: teisėtas turinys perskaitomas nepakitęs", () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas dekoderio, kuris atmeta VISKĄ —
   * „sritys sutampa" tada reikštų dvi tuščias aibes.
   */
  const teiseti = [
    { x: 1 },
    { x: null, y: [null, 2] },
    { t: "ąčęėįšųūž" },
    { t: "emoji \u{1F469}" },
    { t: "literalus \\u0000 tekste" },
    [],
  ];

  for (const reiksme of teiseti) {
    const { buferis } = paruostiReiksme(reiksme);
    assert.deepEqual(atkurtiReiksme(buferis, "results/x.json"), reiksme);
  }
});

test("netaisyklingas UTF-8 yra SUGADINIMAS, ne tyliai pakeisti duomenys", () => {
  /**
   * ⚠️ `Buffer.toString("utf8")` blogus baitus pakeičia U+FFFD ir grąžina „sėkmę":
   * `JSON.parse` pavyksta, o kvietėjas gauna PAKEISTUS vartotojo duomenis vietoj
   * signalo, kad objektas sugadintas. Tyli duomenų mutacija yra blogiau nei klaida.
   */
  const sugadinti = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);

  let klaida = null;
  try {
    atkurtiReiksme(sugadinti, "results/x.json");
  } catch (e) {
    klaida = e;
  }

  assert.ok(klaida, "netaisyklingi baitai privalo būti pastebėti");
  assert.equal(klaida.code, "ARTIFACT_CORRUPT");
  assert.ok(!klaida.message.includes("\uFFFD"), "pakaitalas neturi nutekėti į pranešimą");
});

test("KONTROLĖ: tie patys baitai su taisyklingu UTF-8 praeina", () => {
  const geri = Buffer.from(JSON.stringify({ x: "ž" }), "utf8");
  assert.deepEqual(atkurtiReiksme(geri, "results/x.json"), { x: "ž" });
});

/* ═══ RAKTŲ PERNEŠAMUMAS ═══ */

test("rakto segmentas ribojamas BAITAIS, ne simboliais", () => {
  /**
   * ⚠️ `NAME_MAX` ext4, XFS ir APFS yra 255 BAITAI. Riba, matuojanti tik bendrą
   * rakto ilgį, praleisdavo 256 baitų segmentą, kurį `fs` atmesdavo žaliu
   * `ENAMETOOLONG` — raktas buvo teisėtas kontrakte ir neįmanomas vienoje jo
   * implementacijoje. Ta pati klasė kaip NUL: aibė imama iš to backend'o, kuris
   * gali MAŽIAUSIA.
   */
  assert.equal(MAX_SEGMENTO_BAITAI, 255);

  patikrintiRakta("a".repeat(MAX_SEGMENTO_BAITAI));
  patikrintiRakta(`results/${"b".repeat(MAX_SEGMENTO_BAITAI)}/c.json`);

  for (const raktas of ["a".repeat(MAX_SEGMENTO_BAITAI + 1), `results/${"b".repeat(300)}.json`]) {
    assert.throws(
      () => patikrintiRakta(raktas),
      (klaida) => klaida.code === "ARTIFACT_KEY_INVALID",
      "per ilgas segmentas privalo būti atmestas ties riba"
    );
  }
});

test("fs NIEKADA neišleidžia žalio `ENAMETOOLONG`", async (t) => {
  /**
   * ⚠️ RIBA NEŽINO KIEKVIENOS FAILŲ SISTEMOS. 255 baitai yra `NAME_MAX` įprastose
   * sistemose, bet konkretus overlay ar tinklinis tomas gali turėti mažesnę ribą.
   * Tada raktas, kurį kontraktas priima, čia vis tiek neįmanomas — ir kvietėjui tai
   * privalo atrodyti kaip rakto atmetimas, ne kaip svetimo tipo I/O klaida.
   */
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-raktu-ilgis-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "a".repeat(MAX_SEGMENTO_BAITAI);

  let klaida = null;
  try {
    await saugykla.put(raktas, { a: 1 });
  } catch (e) {
    klaida = e;
  }

  if (klaida) {
    assert.equal(klaida.code, "ARTIFACT_KEY_INVALID", `žalias ${klaida.code} išėjo pro ribą`);
  } else {
    assert.deepEqual(await saugykla.read(raktas), { a: 1 }, "priimtas raktas privalo veikti");
  }
});

/* ═══ INLINE PARITETAS: `jsonb` EILUTĖ IRGI YRA NEPATIKIMAS TURINYS ═══ */

const { createInlineArtifactStore } = require("../utils/artifactStore/inlineStore");

const JOB_ID = "11111111-2222-3333-4444-555555555555";

/** ⚠️ Dublis grąžina TIKRO kontrakto tipus: `rows` ir `rowCount` (#266 trečia dalis). */
function vykdytojasSu(payload) {
  return {
    async query(sql) {
      if (/SELECT payload/.test(sql)) return { rows: [{ payload }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test("inline skaitymas taiko TĄ PAČIĄ sritį kaip `fs` ir S3", async () => {
  /**
   * ⚠️ SRITIS, TAIKOMA DVIEM IŠ TRIJŲ BACKEND'Ų, NĖRA SRITIS.
   *
   * `fs`/S3 skaitymas praeidavo bendrą patikrą, o inline grąžindavo `payload`
   * tiesiai — tas pats netinkamas turinys viename diegime tapdavo
   * `ARTIFACT_CORRUPT`, o kitame „galiojančiu rezultatu". Bendras kontraktas taip
   * tampa priklausomas nuo backend'o (#157 D1 draudžia).
   *
   * ⚠️ `payload` yra `NOT NULL`, tad SQL `NULL` čia neateina. Bet `jsonb` reikšmė
   * `'null'` stulpeliui visiškai teisėta ir rezultatui — ne: ji atkuria
   * „`completed` be rezultato" būseną, kurią rašymo sargas uždarė.
   */
  const uzSrities = [
    { vardas: "viršutinio lygio null", payload: null },
    { vardas: "NUL tekste", payload: { x: `a${NUL}b` } },
    { vardas: "vienišas surogatas", payload: { x: `a${String.fromCharCode(0xd800)}b` } },
  ];

  for (const scenarijus of uzSrities) {
    const saugykla = createInlineArtifactStore({ vykdytojas: vykdytojasSu(scenarijus.payload) });

    await assert.rejects(
      () => saugykla.read(JOB_ID),
      (klaida) => klaida.code === "ARTIFACT_CORRUPT",
      `${scenarijus.vardas}: persistuotas turinys už srities privalo būti sugadinimas`
    );

    /** Ir srautas eina tuo pačiu keliu — kitaip liktų aplinkkelis. */
    await assert.rejects(
      () => saugykla.readStream(JOB_ID),
      (klaida) => klaida.code === "ARTIFACT_CORRUPT",
      `${scenarijus.vardas}: readStream irgi`
    );
  }
});

test("KONTROLĖ: teisėtas inline `payload` perskaitomas nepakitęs", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas inline saugyklos, kuri atmeta VISKĄ.
   */
  for (const payload of [{ text: "ok" }, { a: { b: [1, null] } }, [], { n: 0 }]) {
    const saugykla = createInlineArtifactStore({ vykdytojas: vykdytojasSu(payload) });
    assert.deepEqual(await saugykla.read(JOB_ID), payload);
  }
});

test("inline `verify()` sugadintą turinį klasifikuoja TAIP PAT kaip `read()`", async () => {
  /**
   * ⚠️ TAS PATS FAKTAS NEGALI TURĖTI DVIEJŲ SEMANTIKŲ (Codex, #290).
   *
   * `paruostiReiksme()` yra RAŠYMO pusės riba: netinkamai reikšmei ji meta
   * `ARTIFACT_VALUE_UNSUPPORTED` — „šio rezultato išsaugoti negalima". Bet
   * `verify()` skaito tai, kas JAU guli lentelėje (senos migracijos, rankinio
   * taisymo ar sugadinimo palikimas), ir `read()` tą pačią eilutę jau vadina
   * `ARTIFACT_CORRUPT`.
   *
   * Dviguba semantika siųstų remontą klaidinga kryptimi: operatorius tikrintų
   * tiekėjo rezultatą, nors taisyti reikia eilutę.
   */
  const uzSrities = [
    { vardas: "viršutinio lygio null", payload: null },
    { vardas: "NUL tekste", payload: { x: `a${NUL}b` } },
  ];

  for (const scenarijus of uzSrities) {
    const saugykla = createInlineArtifactStore({ vykdytojas: vykdytojasSu(scenarijus.payload) });

    const skaitymas = await saugykla.read(JOB_ID).then(() => null, (e) => e.code);
    const patikra = await saugykla
      .verify(JOB_ID, { bytes: 1, checksum: "a".repeat(64) })
      .then(() => null, (e) => e.code);

    assert.equal(skaitymas, "ARTIFACT_CORRUPT", `${scenarijus.vardas}: read`);
    assert.equal(patikra, "ARTIFACT_CORRUPT", `${scenarijus.vardas}: verify`);
    assert.notEqual(
      patikra,
      "ARTIFACT_VALUE_UNSUPPORTED",
      "persistuotas sugadinimas nėra nepavykęs NAUJO rezultato išsaugojimas"
    );
  }
});

test("KONTROLĖ: teisėtas inline `payload` verifikuojamas įprastai", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas `verify()`, kuris VISKĄ vadina
   * sugadinimu — tada „nuosekli klasifikacija" reikštų neveikiančią patikrą.
   */
  const saugykla = createInlineArtifactStore({ vykdytojas: vykdytojasSu({ text: "geras" }) });
  const verdiktas = await saugykla.verify(JOB_ID, { bytes: 1, checksum: "a".repeat(64) });

  assert.equal(verdiktas.exists, true);
  assert.equal(verdiktas.ok, false, "lūkestis nesutampa — bet tai palyginimas, ne sugadinimas");
  assert.equal(verdiktas.nepriklausomas, false);
  assert.ok(verdiktas.bytes > 0);
  assert.match(verdiktas.checksum, /^[0-9a-f]{64}$/);
});
