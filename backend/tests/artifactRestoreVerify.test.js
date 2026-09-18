const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  VERDIKTAS,
  patikrintiEilute,
  sudarytiAtaskaita,
} = require("../utils/artifactRestoreVerify");

/**
 * RESTORE VERIFIKACIJOS VERDIKTAI (#157, PR-7, sąlygos 6-8) — BE DB.
 *
 * ⚠️ KLAUSIMAS YRA APIE SPRENDIMĄ, NE APIE I/O. „Ar ši eilutė laikoma patikrinta"
 * priklauso nuo `verify()` verdikto laukų, o ne nuo to, kuri saugykla jį pagamino.
 * Dublis čia tikslesnis už gyvą saugyklą: `nepriklausomas: false` iš EXTERNAL
 * saugyklos yra kontrakto pažeidimas, kurio tikra saugykla tiesiog negamina — o
 * ataskaita privalo jį atskirti nuo teisėtos inline eilutės.
 *
 * Elgesį prieš tikras saugyklas tikrina `artifactRestoreIntegrity.integration`.
 */

const saugykla = (verdiktas) => ({ backend: "fs", verify: async () => verdiktas });
const rezolveris = (s) => (tipas) => {
  if (!s) throw new Error(`postgresStore: '${tipas}' neregistruota`);
  return s;
};

const eilute = (extra = {}) => ({
  job_id: "j1",
  storage_type: "fs",
  storage_key: "k/j1",
  bytes: "42",
  checksum: "a".repeat(64),
  ...extra,
});

test("inline eilutė NIEKADA nėra `patikrinta` — nėra su kuo lyginti", async () => {
  const v = await patikrintiEilute(eilute({ storage_type: "inline", storage_key: null }), rezolveris(null));
  assert.equal(v.verdiktas, VERDIKTAS.NEPATIKRINAMA_INLINE);
});

test("external eilutė su `ok` IR `nepriklausomas` — patikrinta", async () => {
  const v = await patikrintiEilute(
    eilute(),
    rezolveris(saugykla({ ok: true, exists: true, bytes: 42, checksum: "a".repeat(64), nepriklausomas: true }))
  );
  assert.equal(v.verdiktas, VERDIKTAS.PATIKRINTA);
});

/**
 * ⚠️ ŠIS TESTAS YRA VISO MODULIO PRIEŽASTIS.
 *
 * `ok: true` su `nepriklausomas: false` reiškia „reikšmė sutampa su savimi". Jei
 * ataskaita skaičiuotų `ok`, mišrioje DB ji rodytų beveik 100 % ir būtų melas.
 */
test("`ok: true` su `nepriklausomas: false` NĖRA patikrinta — ir turi SAVO verdiktą", async () => {
  const v = await patikrintiEilute(
    eilute(),
    rezolveris(saugykla({ ok: true, exists: true, bytes: 42, checksum: "a".repeat(64), nepriklausomas: false }))
  );

  assert.equal(v.verdiktas, VERDIKTAS.NEPRIKLAUSOMUMO_NETEKO);
  assert.notEqual(
    v.verdiktas,
    VERDIKTAS.NEPATIKRINAMA_INLINE,
    "suplakus su inline, backend'as, praradęs nepriklausomą patikrą, atrodytų kaip teisėta eilutė"
  );
});

test("nesantis objektas — `nerasta`", async () => {
  const v = await patikrintiEilute(
    eilute(),
    rezolveris(saugykla({ ok: false, exists: false, bytes: null, checksum: null, nepriklausomas: true }))
  );
  assert.equal(v.verdiktas, VERDIKTAS.NERASTA);
});

test("sugadintas objektas — `nesutampa`", async () => {
  const v = await patikrintiEilute(
    eilute(),
    rezolveris(saugykla({ ok: false, exists: true, bytes: 41, checksum: "b".repeat(64), nepriklausomas: true }))
  );
  assert.equal(v.verdiktas, VERDIKTAS.NESUTAMPA);
});

/**
 * ⚠️ NEREGISTRUOTAS TIPAS — NESĖKMĖ, NE PRALEIDIMAS. Praleidus, ataskaita tylėtų
 * apie eilutes, kurių perskaityti NEĮMANOMA, ir atkūrimas būtų paskelbtas sėkmingu.
 */
test("neregistruotas `storage_type` — nesėkmė, ne praleidimas", async () => {
  const v = await patikrintiEilute(eilute({ storage_type: "s3" }), rezolveris(null));
  assert.equal(v.verdiktas, VERDIKTAS.SAUGYKLA_NEREGISTRUOTA);
});

test("kritęs `verify()` neišverčia procedūros — virsta `nerasta` su kodu", async () => {
  const sugedusi = { backend: "fs", verify: async () => { throw Object.assign(new Error("x"), { kodas: "ARTIFACT_IO" }); } };
  const v = await patikrintiEilute(eilute(), rezolveris(sugedusi));
  assert.equal(v.verdiktas, VERDIKTAS.NERASTA);
  assert.equal(v.detale, "ARTIFACT_IO");
});

/**
 * ⚠️ SĄLYGA 8: LAUKIAMA REIKŠMĖ ATEINA IŠ EILUTĖS, NE IŠ OBJEKTO.
 *
 * Perskaičiavus ją iš tikrinamo objekto, verifikacija lygintų objektą su savimi —
 * tas pats tuščias `ok: true`, tik be inline pateisinimo. Tikrinama, KĄ gavo
 * `verify()`, o ne kad jis buvo iškviestas.
 */
test("sąlyga 8: `verify()` gauna DB persistintus `bytes`/`checksum`", async () => {
  let gauta = null;
  const stebima = { backend: "fs", verify: async (_r, laukiama) => { gauta = laukiama; return { ok: true, exists: true, nepriklausomas: true }; } };

  await patikrintiEilute(eilute({ bytes: "4096", checksum: "c".repeat(64) }), rezolveris(stebima));

  assert.deepEqual(gauta, { bytes: 4096, checksum: "c".repeat(64) });
  /** ⚠️ `bigint` per `node-postgres` grįžta EILUTE — normalizuojama vieną kartą. */
  assert.equal(typeof gauta.bytes, "number", "eilutė vietoj skaičiaus reikštų `41 !== '41'` kiekvienai eilutei");
});

/**
 * ⚠️ ATASKAITA PATEIKIA ABI PUSES ATSKIRAI — TAI DoD FORMULUOTĖ.
 *
 * Vienas skaičius „patikrinta: N" mišrioje DB skambėtų kaip pilna patikra, nors
 * dauguma eilučių būtų inline ir nepatikrintos.
 */
test("ataskaita skiria `patikrinta` nuo `nepatikrinama` — mišrioje DB", () => {
  const v = (verdiktas, n) => Array.from({ length: n }, (_, i) => ({ jobId: `j${verdiktas}${i}`, verdiktas }));

  const ataskaita = sudarytiAtaskaita([
    ...v(VERDIKTAS.NEPATIKRINAMA_INLINE, 97),
    ...v(VERDIKTAS.PATIKRINTA, 3),
  ]);

  assert.equal(ataskaita.eiluciuIsViso, 100);
  assert.equal(ataskaita.nepriklausomaiPatikrinta, 3);
  assert.equal(ataskaita.nepatikrinama, 97);
  assert.equal(ataskaita.ok, true);

  /** ⚠️ 3 %, ne 100 %: būtent šito skirtumo dėlei modulis ir egzistuoja. */
  assert.match(ataskaita.santrauka, /nepriklausomai patikrinta 3/);
  assert.match(ataskaita.santrauka, /nepatikrinama \(inline[^)]*\) 97/);
});

test("nulinis `nepatikrinama` ATASKAITOJE VIS TIEK RAŠOMAS", () => {
  const ataskaita = sudarytiAtaskaita([{ jobId: "j1", verdiktas: VERDIKTAS.PATIKRINTA }]);
  assert.match(
    ataskaita.santrauka,
    /nepatikrinama \(inline[^)]*\) 0/,
    "praleidus nulinį skaičių, ataskaitos forma priklausytų nuo duomenų: nėra inline eilučių taptų neatskiriama nuo apie jas nieko nesakoma"
  );
});

test("FAIL-CLOSED: viena nesėkmė nuverčia visą ataskaitą", () => {
  for (const blogas of [VERDIKTAS.NERASTA, VERDIKTAS.NESUTAMPA, VERDIKTAS.SAUGYKLA_NEREGISTRUOTA, VERDIKTAS.NEPRIKLAUSOMUMO_NETEKO]) {
    const ataskaita = sudarytiAtaskaita([
      { jobId: "geras", verdiktas: VERDIKTAS.PATIKRINTA },
      { jobId: "blogas", verdiktas: blogas },
    ]);
    assert.equal(ataskaita.ok, false, `${blogas}: atkūrimas negali būti paskelbtas sėkmingu`);
    assert.equal(ataskaita.nesekmes.length, 1);
    assert.equal(ataskaita.nesekmes[0].jobId, "blogas", "nesėkmė privalo įvardyti EILUTĘ, ne tik skaičių");
  }
});

test("inline eilutė ataskaitos NENUVERČIA — tai ne nesėkmė", () => {
  const ataskaita = sudarytiAtaskaita([{ jobId: "j1", verdiktas: VERDIKTAS.NEPATIKRINAMA_INLINE }]);
  assert.equal(ataskaita.ok, true, "nebuvo ko tikrinti nėra tas pat, kas patikra nepavyko");
});
