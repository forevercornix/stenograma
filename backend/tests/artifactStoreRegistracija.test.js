const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createPostgresStore } = require("../utils/jobStore/postgresStore");

/**
 * SAUGYKLŲ REGISTRACIJA KONSTRUKCIJOS METU (#157, PR-4; Codex #294).
 *
 * ⚠️ ŠITO NEREIKIA TIKROS DB: klausimas yra apie žemėlapį, sudaromą `createPostgresStore()`
 * pradžioje, ne apie užklausas.
 */

/** Pool'as, kurio niekas nekviečia — konstrukcija DB neliečia. */
const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };

function saugykla(backend, zyme) {
  return { backend, zyme, put: async () => ({}), read: async () => ({}), head: async () => null };
}

test("KONFLIKTUOJANTI to paties `backend` registracija KRENTA konstrukcijos metu", () => {
  /**
   * ⚠️ TYLUS PERRAŠYMAS BUVO BLOGIAUSIAS IŠ TRIJŲ GALIMŲ ELGESIŲ.
   *
   * `rasymoSaugykla` įrašoma pirma, o `artifactStores` ciklas ją PERRAŠYDAVO. Su `fs`
   * root A rašymui ir root B skaitymui `finishAtomic()` įsipareigotų nuorodą į A, o
   * hidratacija po commit'o ir visi vėlesni skaitymai eitų per B: sėkmingai užbaigtas
   * job'as su NEPERSKAITOMU rezultatu.
   *
   * ⚠️ FAIL-CLOSED, NE „RAŠYMO SAUGYKLA LAIMI". Abu variantai pašalina neperskaitomą
   * rezultatą, bet „laimi" paliktų klaidingą konfigūraciją veikiančią ir tylią —
   * operatorius toliau tikėtų, kad skaitymai eina per B. Žemėlapis sudaromas VIENĄ kartą
   * paleidimo metu, tad kritimas ten yra pigus ir garsus. Tas pats šablonas, kurį PR jau
   * taiko `backend` lauko reikalavimui.
   */
  let klaida = null;
  try {
    createPostgresStore(pool, {
      rasymoSaugykla: saugykla("fs", "rašymui"),
      artifactStores: { fs: saugykla("fs", "skaitymui") },
    });
  } catch (e) {
    klaida = e;
  }

  assert.ok(klaida instanceof TypeError, "konfliktas privalo kristi konstrukcijos metu");
  assert.match(klaida.message, /fs/, "pranešime privalo būti konfliktuojantis `backend`");
  assert.match(klaida.message, /rasymoSaugykla|artifactStores/, "ir tai, kas su kuo konfliktuoja");
});

test("TA PATI saugykla abiejose vietose — teisėta, ne konfliktas", () => {
  /**
   * ⚠️ BE ŠITO SARGAS UŽDRAUSTŲ NORMALŲ PRIJUNGIMĄ (PR-7): ten `fs` saugykla natūraliai
   * yra ir rašymo taikinys, ir `fs` eilučių skaitytoja. Tikrinama TAPATYBĖ, ne `backend`
   * sutapimas.
   */
  const fs = saugykla("fs", "viena");

  assert.doesNotThrow(() =>
    createPostgresStore(pool, { rasymoSaugykla: fs, artifactStores: { fs } })
  );
});

test("SKIRTINGI `backend`'ai konflikto nesudaro", () => {
  assert.doesNotThrow(() =>
    createPostgresStore(pool, {
      rasymoSaugykla: saugykla("fs", "rašymui"),
      artifactStores: { s3: saugykla("s3", "senoms eilutėms") },
    })
  );
});

test("`artifactStore` (vienaskaita) kertasi su tais pačiais sargais", () => {
  /**
   * Trečias įėjimas į tą patį žemėlapį; be jo sargas dengtų du kelius iš trijų.
   */
  assert.throws(
    () =>
      createPostgresStore(pool, {
        rasymoSaugykla: saugykla("fs", "rašymui"),
        artifactStore: saugykla("fs", "kitas objektas"),
      }),
    TypeError
  );

  const fs = saugykla("fs", "viena");
  assert.doesNotThrow(() => createPostgresStore(pool, { rasymoSaugykla: fs, artifactStore: fs }));
});
