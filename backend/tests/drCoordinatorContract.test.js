const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const drCoordinator = require("../utils/drCoordinator");
const auditLog = require("../utils/auditLog");

/**
 * 7.6c DR SEKOS IR OVERRIDE KONTRAKTAS (#155, #250).
 *
 * ⚠️ SEKA TIKRINAMA KRITIMU, NE STEBĖJIMU.
 *
 * Testas, skaičiuojantis, kiek kartų buvo kviesta funkcija, tikrina REALIZACIJĄ.
 * Čia tikrinama GARANTIJA: žingsnis, gavęs ne to žingsnio rezultatą, KRENTA. Todėl
 * kiekvienam sekos raktui yra ir kontrolė — tikras rezultatas praeina, kitaip
 * testas praeitų ir tada, jei sargas atmestų VISKĄ.
 */

const CHECKSUM = "a".repeat(64);

function tikrasMerge() {
  return { zingsnis: "merge", zurnaloChecksum: CHECKSUM, zymos: [], sulietos: [], praleistos: [] };
}

function tikrasReplay() {
  return { zingsnis: "replay", zurnaloChecksum: CHECKSUM, istrinta: [], jauNebuvo: [], nesekmes: [] };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. SEKA
 * ═══════════════════════════════════════════════════════════════════════════ */

test("SEKA: replay be suliejimo rezultato KRENTA", () => {
  for (const bloga of [undefined, null, {}, { zingsnis: "replay", zurnaloChecksum: CHECKSUM, zymos: [] }, { zingsnis: "merge", zymos: [] }]) {
    assert.throws(
      () => drCoordinator._patikrintiMerge(bloga),
      (k) => k.code === "DR_SEQUENCE_VIOLATION",
      `neteisingas įėjimas praėjo: ${JSON.stringify(bloga)}`
    );
  }
});

test("SEKA: tikras suliejimo rezultatas PRAEINA (kontrolė)", () => {
  assert.doesNotThrow(() => drCoordinator._patikrintiMerge(tikrasMerge()));
});

test("SEKA: suderinimas be replay rezultato KRENTA", () => {
  for (const bloga of [undefined, null, {}, { zingsnis: "merge", zurnaloChecksum: CHECKSUM }, { zingsnis: "replay" }]) {
    assert.throws(
      () => drCoordinator._patikrintiReplay(bloga),
      (k) => k.code === "DR_SEQUENCE_VIOLATION"
    );
  }
});

test("SEKA: tikras replay rezultatas PRAEINA (kontrolė)", () => {
  assert.doesNotThrow(() => drCoordinator._patikrintiReplay(tikrasReplay()));
});

test("SEKA: `replay()` su svetimu objektu krenta PRIEŠ bet kokį trynimą", async () => {
  await assert.rejects(
    () => drCoordinator.replay({ merge: { zingsnis: "merge", zymos: [{ jobId: "x", status: "deletion_pending" }] } }),
    (k) => k.code === "DR_SEQUENCE_VIOLATION",
    "be `zurnaloChecksum` rankomis sukurtas objektas sekos nepraeina"
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. PASENUSIO ŽURNALO OVERRIDE — ABI LAIKMENOS
 * ═══════════════════════════════════════════════════════════════════════════ */

const SARGAI = Object.freeze({
  amzius: 25 * 3_600_000,
  langas: 24 * 3_600_000,
  deploymentId: "11111111-1111-4111-8111-111111111111",
  zurnaloChecksum: CHECKSUM,
});

const ZURNALAS = Object.freeze({ zymos: [] });

/** Audito dublis: `rasytiAudita()` politika lieka tikra, keičiasi tik REŽIMAS ir rezultatas. */
function auditoDublis({ privacy = false } = {}) {
  return { isPrivacyModeEnabled: () => privacy };
}

test("OVERRIDE (auditas): kvitas įrašomas → priėmimas tęsiasi ir laikmena įvardyta", async () => {
  await auditLog.clear();

  const rez = await drCoordinator._uzfiksuotiOverride({
    sargai: SARGAI,
    zurnalas: ZURNALAS,
    actor: "op",
    patvirtinimas: null,
    auditLog: auditoDublis(),
  });

  assert.equal(rez.laikmena, "audito_irasas");
  assert.equal(rez.pasenimoValandos, 25);

  const { entries } = await auditLog.query({ limit: 50 });
  const kvitai = (entries || []).filter((e) => e.event === drCoordinator.SVIEZUMO_OVERRIDE_IVYKIS);
  assert.equal(kvitai.length, 1, "pėdsakas realiai gulė į auditą");
});

test("OVERRIDE (auditas): kvito NĖRA → priėmimas NETĘSIAMAS", async () => {
  /**
   * ⚠️ `PRIVACY_MODE` čia išjungtas, tad `null` gali reikšti TIK gedimą — būtent
   * tai daro šį fail-closed vienareikšmiu.
   */
  const auditStore = require("../utils/auditStore");
  const tikrasis = auditStore.current;
  auditStore.current = () => ({ async append() { return null; }, async query() { return { entries: [], total: 0 }; } });

  try {
    await assert.rejects(
      () =>
        drCoordinator._uzfiksuotiOverride({
          sargai: SARGAI,
          zurnalas: ZURNALAS,
          actor: "op",
          patvirtinimas: null,
          auditLog: auditoDublis(),
        }),
      (k) => k.code === "DR_STALE_OVERRIDE_UNRECORDED",
      "sąmoningas rizikos prisiėmimas be pėdsako neleidžiamas"
    );
  } finally {
    auditStore.current = tikrasis;
  }
});

test("OVERRIDE (privatumas): be patvirtinimo KRENTA, o klaida neša laukiamas reikšmes", async () => {
  await assert.rejects(
    () =>
      drCoordinator._uzfiksuotiOverride({
        sargai: SARGAI,
        zurnalas: ZURNALAS,
        actor: "op",
        patvirtinimas: null,
        auditLog: auditoDublis({ privacy: true }),
      }),
    (k) =>
      k.code === "DR_STALE_OVERRIDE_UNCONFIRMED" &&
      k.message.includes(CHECKSUM) &&
      k.message.includes("pasenimoValandos=25"),
    "be reikšmių operatorius neturėtų iš kur jų gauti"
  );
});

test("OVERRIDE (privatumas): sutampantis patvirtinimas PRAEINA (kontrolė)", async () => {
  const rez = await drCoordinator._uzfiksuotiOverride({
    sargai: SARGAI,
    zurnalas: ZURNALAS,
    actor: "op",
    patvirtinimas: {
      deploymentId: SARGAI.deploymentId,
      zurnaloChecksum: SARGAI.zurnaloChecksum,
      pasenimoValandos: 25,
    },
    auditLog: auditoDublis({ privacy: true }),
  });

  assert.equal(rez.laikmena, "operatoriaus_patvirtinimas");
  assert.equal(rez.pasenimoValandos, 25);
});

test("OVERRIDE (privatumas): kiekvienas neteisingas laukas atskirai KRENTA", async () => {
  const teisingas = {
    deploymentId: SARGAI.deploymentId,
    zurnaloChecksum: SARGAI.zurnaloChecksum,
    pasenimoValandos: 25,
  };

  /**
   * ⚠️ KIEKVIENAS LAUKAS ATSKIRAI. Vienas „blogas patvirtinimas" praeitų ir tada,
   * jei lygintume tik vieną iš trijų — o `--yes` su teisingu checksum'u būtų
   * tiksliai tas apėjimas, kurio šis sargas neturi leisti.
   */
  const blogi = [
    { ...teisingas, deploymentId: "22222222-2222-4222-8222-222222222222" },
    { ...teisingas, zurnaloChecksum: "b".repeat(64) },
    { ...teisingas, pasenimoValandos: 24 },
    { ...teisingas, pasenimoValandos: 26 },
  ];

  for (const patvirtinimas of blogi) {
    await assert.rejects(
      () =>
        drCoordinator._uzfiksuotiOverride({
          sargai: SARGAI,
          zurnalas: ZURNALAS,
          actor: "op",
          patvirtinimas,
          auditLog: auditoDublis({ privacy: true }),
        }),
      (k) => k.code === "DR_STALE_OVERRIDE_UNCONFIRMED",
      `praėjo neteisingas patvirtinimas: ${JSON.stringify(patvirtinimas)}`
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. ŠVIEŽUMO LANGAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("LANGAS: numatytasis 24 h, override iš aplinkos, šiukšlės grąžina numatytąjį", () => {
  assert.equal(drCoordinator.NUMATYTAS_SVIEZUMO_LANGAS_MS, 24 * 3_600_000);
  assert.equal(drCoordinator.sviezumoLangasMs({}), 24 * 3_600_000);
  assert.equal(drCoordinator.sviezumoLangasMs({ ERASURE_EXPORT_MAX_AGE_MS: "3600000" }), 3_600_000);
  assert.equal(drCoordinator.sviezumoLangasMs({ ERASURE_EXPORT_MAX_AGE_MS: "ne skaičius" }), 24 * 3_600_000);
  assert.equal(drCoordinator.sviezumoLangasMs({ ERASURE_EXPORT_MAX_AGE_MS: "-5" }), 24 * 3_600_000);
});
