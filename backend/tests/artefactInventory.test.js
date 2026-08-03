const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const inventory = require("../utils/artefactInventory");
const {
  ARTEFACT_TYPES,
  PERSISTENCE,
  LIFECYCLE_STATES,
  canTransition,
  assertTransition,
  createRecord,
  derivationChain,
  descendantTypes,
  typesByPersistence,
} = inventory;

/**
 * #19 PR1: ARTEFAKTŲ INVENTORIUS IR GYVAVIMO CIKLO MODELIS.
 *
 * Šis PR nieko netrina – jis atsako, KOKIE artefaktai egzistuoja, kam
 * priklauso ir iš ko išvesti. Testai atitinkamai tikrina modelį, ne ištrynimą.
 */

test("REGISTRAS: kiekvienas tipas turi pilną apibrėžimą", () => {
  /**
   * Trūkstamas laukas reikštų artefaktą, kurio ištrynimas negalėtų suplanuoti:
   * be `owner` jo nesusiesi su jobu, be `persistence` nežinai, ko tikėtis po
   * ištrynimo.
   */
  for (const [name, def] of Object.entries(ARTEFACT_TYPES)) {
    assert.ok(def.id, `${name}: trūksta id`);
    assert.ok(def.description, `${name}: trūksta aprašymo`);
    assert.ok(["job", "meeting"].includes(def.owner), `${name}: netinkamas owner "${def.owner}"`);
    assert.ok(
      Object.values(PERSISTENCE).includes(def.persistence),
      `${name}: netinkama persistence "${def.persistence}"`
    );
  }
});

test("REGISTRAS: `derivedFrom` nurodo TIKRUS tipus, ne išgalvotus", () => {
  const knownIds = new Set(Object.values(ARTEFACT_TYPES).map((t) => t.id));

  for (const def of Object.values(ARTEFACT_TYPES)) {
    if (def.derivedFrom === null) continue;
    assert.ok(knownIds.has(def.derivedFrom), `${def.id}: derivedFrom "${def.derivedFrom}" neegzistuoja`);
  }
});

test("REGISTRAS: išvedimo grafe nėra ciklų", () => {
  /**
   * Ciklas reikštų begalinį ištrynimo apėjimą. Tikrinam kiekvieną tipą, o ne
   * tik tuos, kuriuos prisimenam – naujas tipas su klaidingu `derivedFrom`
   * pakliūtų čia iškart.
   */
  for (const def of Object.values(ARTEFACT_TYPES)) {
    const chain = derivationChain(def.id);
    assert.equal(new Set(chain).size, chain.length, `${def.id}: grandinėje kartojasi tipas -> ciklas`);
  }
});

test("GRAFAS: eksportas atsekamas iki įkelto audio", () => {
  /**
   * Pilnas kelias nuo šaknies iki lapo – būtent to reikalauja #19
   * („traverses the complete derivation graph from source upload through
   * transcripts, protocols and exports").
   */
  assert.deepEqual(derivationChain("export_original"), [
    "source_audio",
    "transcript",
    "protocol",
    "export_original",
  ]);
});

test("GRAFAS: iš audio išvesti VISI turinio artefaktai", () => {
  const descendants = descendantTypes("source_audio");

  for (const expected of ["transcript", "protocol", "export_original", "export_redacted", "transcript_redacted"]) {
    assert.ok(descendants.includes(expected), `trūksta palikuonio: ${expected}`);
  }
});

test("PERSISTENCIJA: efemeriški artefaktai NIEKADA nesaugomi", () => {
  /**
   * Redaguota transkripcija ir eksportai perskaičiuojami kiekvienam
   * panaudojimui. Jei kuris nors taptų `persistent`, atsirastų ANTRA asmens
   * duomenų kopija, kurią reikėtų atskirai trinti – ir apie kurią ištrynimas
   * nieko nežinotų.
   */
  const ephemeral = typesByPersistence(PERSISTENCE.EPHEMERAL);

  assert.ok(ephemeral.includes("transcript_redacted"));
  assert.ok(ephemeral.includes("export_redacted"));
  assert.ok(ephemeral.includes("export_original"));
});

test("PERSISTENCIJA: turinio artefaktai, kurie IŠGYVENA restartą, pažymėti persistent", () => {
  const persistent = typesByPersistence(PERSISTENCE.PERSISTENT);

  for (const expected of ["source_audio", "transcript", "protocol", "job_record", "queue_record"]) {
    assert.ok(persistent.includes(expected), `${expected} turi būti persistent`);
  }
});

test("BŪSENOS: iš DELETED nėra kelio atgal", () => {
  /**
   * Svarbiausia modelio taisyklė. Jei artefaktą būtų galima „atgaivinti",
   * vėluojantis worker'is ar pakartotinis job'as paverstų ištrynimą laikinu.
   */
  for (const state of Object.values(LIFECYCLE_STATES)) {
    assert.equal(
      canTransition(LIFECYCLE_STATES.DELETED, state),
      false,
      `DELETED -> ${state} turi būti draudžiamas`
    );
  }
});

test("BŪSENOS: ištrynimas privalo eiti per PENDING_DELETION (tombstone pirma)", () => {
  /**
   * #19 reikalauja, kad tombstone atsirastų PRIEŠ šalinimą. Tiesioginis
   * ACTIVE -> DELETED reikštų, kad tarp „dar yra" ir „jau nėra" nelieka
   * būsenos, kurioje worker'is galėtų pamatyti ištrynimo žymą.
   */
  assert.equal(canTransition(LIFECYCLE_STATES.ACTIVE, LIFECYCLE_STATES.DELETED), false);
  assert.equal(canTransition(LIFECYCLE_STATES.ACTIVE, LIFECYCLE_STATES.PENDING_DELETION), true);
  assert.equal(canTransition(LIFECYCLE_STATES.PENDING_DELETION, LIFECYCLE_STATES.DELETED), true);
});

test("BŪSENOS: retryable gedimas leidžia kartoti, permanent – ne", () => {
  assert.equal(
    canTransition(LIFECYCLE_STATES.DELETION_FAILED_RETRYABLE, LIFECYCLE_STATES.PENDING_DELETION),
    true
  );

  /**
   * Iš `PERMANENT` nėra išeities SĄMONINGAI: ji reiškia „reikia žmogaus", ir
   * automatinis perėjimas paslėptų būtent tai, ką reikia matyti.
   */
  for (const state of Object.values(LIFECYCLE_STATES)) {
    assert.equal(canTransition(LIFECYCLE_STATES.DELETION_FAILED_PERMANENT, state), false);
  }
});

test("BŪSENOS: deny-by-default – nežinoma būsena neleidžia nieko", () => {
  assert.equal(canTransition("kazkokia_nauja", LIFECYCLE_STATES.DELETED), false);
  assert.equal(canTransition(LIFECYCLE_STATES.ACTIVE, "kazkokia_nauja"), false);
  assert.equal(canTransition(null, null), false);
});

test("BŪSENOS: assertTransition meta AIŠKIĄ klaidą, o ne tyliai praleidžia", () => {
  assert.throws(
    () => assertTransition(LIFECYCLE_STATES.DELETED, LIFECYCLE_STATES.ACTIVE),
    (e) => e.code === "INVALID_LIFECYCLE_TRANSITION"
  );

  assert.doesNotThrow(() => assertTransition(LIFECYCLE_STATES.ACTIVE, LIFECYCLE_STATES.PENDING_DELETION));
});

test("ĮRAŠAS: sukuriamas su visais laukais, kurių reikia ištrynimui", () => {
  const record = createRecord({ type: "source_audio", ownerId: "job_abc", retentionDeadline: 123 });

  assert.equal(record.type, "source_audio");
  assert.equal(record.ownerId, "job_abc");
  assert.equal(record.ownerKind, "job");
  assert.equal(record.persistence, PERSISTENCE.PERSISTENT);
  assert.equal(record.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(record.retentionDeadline, 123);
  assert.equal(record.deletedAt, null);
});

test("ĮRAŠAS: artefaktas BE savininko atmetamas", () => {
  /**
   * Artefaktas be savininko ID yra būsimas našlaitis: jo nebūtų kaip rasti
   * nei tiesiogine paieška, nei inventoriaus skenavimu.
   */
  assert.throws(() => createRecord({ type: "source_audio", ownerId: null }), (e) => e.code === "ARTEFACT_WITHOUT_OWNER");
  assert.throws(() => createRecord({ type: "source_audio", ownerId: "" }), (e) => e.code === "ARTEFACT_WITHOUT_OWNER");
});

test("ĮRAŠAS: nežinomas tipas atmetamas", () => {
  assert.throws(
    () => createRecord({ type: "kazkoks_naujas_failas", ownerId: "job_abc" }),
    (e) => e.code === "UNKNOWN_ARTEFACT_TYPE"
  );
});

test("SAUGYKLA: inventorius išlieka jobo įraše", async () => {
  const jobStore = require("../utils/jobStore");
  await jobStore.init();

  const record = createRecord({ type: "source_audio", ownerId: "placeholder" });
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION, artefacts: [record] });

  const loaded = await jobStore.get(job.id);

  assert.ok(Array.isArray(loaded.artefacts), "inventorius turi būti masyvas");
  assert.equal(loaded.artefacts.length, 1);
  assert.equal(loaded.artefacts[0].type, "source_audio");
  assert.equal(loaded.artefacts[0].state, LIFECYCLE_STATES.ACTIVE);
});

test("SAUGYKLA: jobas be artefaktų turi TUŠČIĄ masyvą, ne undefined", async () => {
  /**
   * `undefined` reikštų, kad kiekvienas skaitantis kodas turi tikrinti
   * egzistavimą prieš iteruodamas – ir vienas jų kada nors pamirš.
   */
  const jobStore = require("../utils/jobStore");
  await jobStore.init();

  const job = await jobStore.create({ type: jobStore.JOB_TYPES.PROTOCOL });
  const loaded = await jobStore.get(job.id);

  assert.deepEqual(loaded.artefacts, []);
});
