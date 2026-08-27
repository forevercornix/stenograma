const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const auditLog = require("../utils/auditLog");
const auditStore = require("../utils/auditStore");

/**
 * RAKTO ROTACIJA IR GDPR — ATMINTIES BACKEND'AS (#155, 7.4c / #212).
 *
 * ⚠️ ŠIS FAILAS NĖRA ROTACIJOS ĮRODYMAS DB LYGIU, IR TAI SVARBU.
 *
 * Atminties backend'as `hash_key_id` NESAUGO — generacijos etiketė egzistuoja
 * tik persistentinėje eilutėje. Todėl čia tikrinama TIK fan-out logika: kad
 * `removeBySubjectIdentifier()` apskaičiuoja kandidatus VISOMS taikomoms
 * generacijoms ir pašalina juos vienu kartu.
 *
 * RAW DB įrodymo — kad eilutės su `hash_key_id = A` ir `= B` fiziškai dingsta —
 * čia NĖRA ir būti negali. Jį duoda `auditPersistence.integration.test.js`,
 * kuriam reikia tikros PostgreSQL. Ataskaitoje tai dvi ATSKIROS eilutės.
 */

const RAKTAS_A = "cm90YWNpamEtcmFrdGFzLUE";
const RAKTAS_B = "cm90YWNpamEtcmFrdGFzLUI";

/** Aplinka be `AUDIT_BACKEND` — atmintis, bet su eksplicitiniais raktų ID. */
function aplinka({ aktyvusId, aktyvusSecret, istoriniai = null }) {
  const env = {
    AUDIT_BACKEND: "memory",
    AUDIT_ID_SALT_ID: aktyvusId,
    AUDIT_ID_SALT: aktyvusSecret,
  };
  if (istoriniai) env.AUDIT_ID_SALT_PREVIOUS = istoriniai;
  return env;
}

test.afterEach(async () => {
  await auditStore.shutdown();
  auditLog.clear();
});

test("ROTACIJA: po rotacijos tas pats job'as gauna KITĄ pseudonimą", async () => {
  /**
   * Jei pseudonimas nesikeistų, rotacija nieko nekeistų — o visa 7.4c prasmė yra
   * ta, kad senas raktas nebeleidžia susieti naujų įrašų su senais.
   */
  await auditStore.shutdown();
  await auditStore.init(aplinka({ aktyvusId: "A", aktyvusSecret: RAKTAS_A }));

  const suA = auditLog.pseudonymizeIdentifier("job-rotacija");

  await auditStore.shutdown();
  await auditStore.init(
    aplinka({ aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
  );

  const suB = auditLog.pseudonymizeIdentifier("job-rotacija");

  assert.notEqual(suA, suB, "rotavus raktą pseudonimas privalo pasikeisti");
  assert.match(suA, /^[0-9a-f]{20}$/);
  assert.match(suB, /^[0-9a-f]{20}$/);
});

test("GDPR: ištrynimas pasiekia ABI generacijas, ne tik aktyviąją", async () => {
  /**
   * ⚠️ TAI PAGRINDINIS ŠIO FAILO TESTAS.
   *
   * Skaičiuojant tik aktyviu raktu, PRIEŠ rotaciją sukurti įrašai liktų
   * saugykloje, nors `removeBySubjectIdentifier()` grąžintų sėkmę — GDPR
   * ištrynimas praneštų apie darbą, kurio neatliko.
   */
  await auditStore.shutdown();
  await auditStore.init(aplinka({ aktyvusId: "A", aktyvusSecret: RAKTAS_A }));

  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-KITAS", success: true });

  const poA = await auditLog.getAll();
  assert.equal(poA.length, 2, "prielaida: abu įrašai sukurti");
  const subjektasA = poA.find((e) => e.event === "PROCESSING_COMPLETED").subjectId;

  /** ── ROTACIJA: A tampa istoriniu, B aktyviu ─────────────────────────────── */
  await auditStore.shutdown();
  await auditStore.init(
    aplinka({ aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
  );

  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

  const priesTrinant = await auditLog.getAll();
  assert.equal(priesTrinant.length, 3, "atmintis išgyvena `init()`, tad įrašų yra trys");

  const subjektaiX = new Set(
    priesTrinant.filter((e) => e.subjectId !== undefined).map((e) => e.subjectId)
  );
  assert.ok(subjektaiX.size >= 2, "prielaida: skirtingos generacijos davė skirtingus pseudonimus");

  /** ── IŠTRYNIMAS ────────────────────────────────────────────────────────── */
  const pasalinta = await auditLog.removeBySubjectIdentifier("job-X");

  assert.equal(pasalinta, 2, "privalo dingti ABU `job-X` įrašai — ir senas, ir naujas");

  const liko = await auditLog.getAll();
  assert.equal(liko.length, 1, "svetimo job'o įrašas privalo likti");
  assert.notEqual(liko[0].subjectId, subjektasA, "likęs įrašas nėra ištrintasis");
});

test("GDPR: be istorinio rakto senas įrašas LIEKA — ir tai matoma", async () => {
  /**
   * ⚠️ NEIGIAMA PUSĖ, BE KURIOS TEIGIAMA NIEKO NEĮRODO.
   *
   * Jei ištrynimas praeitų ir be istorinio rakto, ankstesnis testas galėtų būti
   * teisingas dėl visai kitos priežasties (pvz. jei visi pseudonimai sutaptų).
   * Čia parodoma, kad būtent istorinis raktas daro skirtumą — ir kartu, kodėl
   * `AUDIT_ID_SALT_PREVIOUS` praradimas yra GDPR problema, ne nepatogumas.
   */
  await auditStore.shutdown();
  await auditStore.init(aplinka({ aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

  /** Rotacija BE `AUDIT_ID_SALT_PREVIOUS` — senasis raktas pamirštamas. */
  await auditStore.shutdown();
  await auditStore.init(aplinka({ aktyvusId: "B", aktyvusSecret: RAKTAS_B }));
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

  const pasalinta = await auditLog.removeBySubjectIdentifier("job-X");

  assert.equal(pasalinta, 1, "be istorinio rakto pasiekiamas tik naujasis įrašas");
  assert.equal((await auditLog.getAll()).length, 1, "senasis lieka — jo pseudonimo atkurti nebeįmanoma");
});

test("PAIEŠKA: `job_id` filtras randa įrašą, sukurtą PRIEŠ rotaciją", async () => {
  await auditStore.shutdown();
  await auditStore.init(aplinka({ aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-istorinis", success: true });

  await auditStore.shutdown();
  await auditStore.init(
    aplinka({ aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
  );
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-istorinis", success: true });
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-svetimas", success: true });

  const { entries } = await auditLog.query({ limit: 50, jobId: "job-istorinis" });

  assert.equal(entries.length, 2, "randami įrašai iš ABIEJŲ generacijų");

  const { entries: svetimi } = await auditLog.query({ limit: 50, jobId: "job-svetimas" });
  assert.equal(svetimi.length, 1, "svetimas job'as nepatenka");
});

test("PRIVATUMAS: plikas `job_id` nepatenka nei į įrašą, nei į atsakymą", async () => {
  await auditStore.shutdown();
  await auditStore.init(
    aplinka({ aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
  );

  const SENTINEL = "job-PLIKAS-SENTINEL-c4e1";
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: SENTINEL, success: true });

  const { entries, nextCursor } = await auditLog.query({ limit: 50, jobId: SENTINEL });

  assert.equal(entries.length, 1, "filtras privalo rasti įrašą");

  const serializuota = JSON.stringify(entries) + String(nextCursor);
  assert.ok(!serializuota.includes(SENTINEL), "plikas ID negali grįžti nei įraše, nei kursoriuje");
  assert.ok(!serializuota.includes(RAKTAS_A), "secret'as negali grįžti");
  assert.ok(!serializuota.includes(RAKTAS_B), "secret'as negali grįžti");
});
