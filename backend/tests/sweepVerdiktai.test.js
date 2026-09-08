const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createPostgresStore } = require("../utils/jobStore/postgresStore");

/**
 * ŠLAVIMO VERDIKTAI — ZONDO KLAIDOS KELIAS (#157, PR-5).
 *
 * ⚠️ IŠ KETURIŲ ZONDO BŪSENŲ ŠI VIENINTELĖ YRA DESTRUKTYVI TYLĖJIMU.
 *
 * `nebuvo` uždaro registro eilutę kaip sėkmę, o eilutė yra VIENINTELIS objekto adresas
 * (`list(prefix)` pagal A3 nėra). Vadinasi laikinas saugyklos gedimas, palaikytas
 * nebuvimu, padaro objektą su transkripcija nepasiekiamą GALUTINAI. Visos kitos trys
 * būsenos klysta saugia kryptimi: `pasalinta` daugiausia bando trinti tai, ko nėra,
 * `pazeidimas` nieko netrina, o naujas kandidatas ateis kitame cikle.
 *
 * Kodas šitą jau daro teisingai (`fsStore` zondas skiria `ENOENT`, o
 * `sweepResultArtifacts` metimą verčia `nepavyko`) — bet iki šiol tai buvo tik kodas.
 */

/** Pool'as, kurio verdiktų kelias neliečia: sprendimai priimami iš saugyklos atsakymų. */
const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };

function saugykla({ zondas, galva, trynimai = [] }) {
  return {
    backend: "fs",
    turiLaikinaji: true,
    trynimai,
    laikinasisZondas: zondas,
    head: galva,
    async delete(raktas) {
      trynimai.push(`galutinis:${raktas}`);
      return true;
    },
    async pasalintiLaikinaji(raktas) {
      trynimai.push(`laikinas:${raktas}`);
      return true;
    },
  };
}

const kandidatas = { attempt_id: "a1", storage_type: "fs", storage_key: "results/j/a.json" };

test("zondo GEDIMAS (ne `ENOENT`) duoda `nepavyko`, ne `nebuvo`", async () => {
  const trynimai = [];
  const store = createPostgresStore(pool, {
    artifactStores: {
      fs: saugykla({
        async zondas() {
          const klaida = new Error("saugykla nepasiekiama");
          klaida.code = "EIO";
          throw klaida;
        },
        async galva() {
          return null;
        },
        trynimai,
      }),
    },
  });

  const [verdiktas] = await store.sweepResultArtifacts([kandidatas]);

  assert.equal(verdiktas.verdiktas, "nepavyko", "gedimas NEGALI virsti nebuvimu");
  assert.match(verdiktas.priezastis, /nepasiekiama/);
  assert.deepEqual(trynimai, [], "nieko netrinta");
});

test("KONTROLĖ: `ENOENT` abiejose pusėse duoda `nebuvo` — eilutė uždaroma", async () => {
  /**
   * Be šios kontrolės ankstesnis testas būtų tenkinamas ir zondo, kuris VISKĄ verčia
   * `nepavyko`: tada šlavėjas nieko niekada neuždarytų, ir tai atrodytų kaip saugumas.
   */
  const trynimai = [];
  const store = createPostgresStore(pool, {
    artifactStores: {
      fs: saugykla({
        async zondas() {
          return { yra: false, bytes: null };
        },
        async galva() {
          return null;
        },
        trynimai,
      }),
    },
  });

  const [verdiktas] = await store.sweepResultArtifacts([kandidatas]);

  assert.equal(verdiktas.verdiktas, "nebuvo");
  assert.deepEqual(trynimai, [], "nėra ko trinti");
});

test("`head()` gedimas irgi duoda `nepavyko` — ne tik zondo", async () => {
  /**
   * ⚠️ TA PATI KLASĖ KITOJE POROS PUSĖJE. `head()` grąžina `null` nesant objekto, tad
   * metimas iš jo yra tikras gedimas, o ne „nėra".
   */
  const store = createPostgresStore(pool, {
    artifactStores: {
      fs: saugykla({
        async zondas() {
          return { yra: false, bytes: null };
        },
        async galva() {
          throw new Error("S3 5xx");
        },
      }),
    },
  });

  const [verdiktas] = await store.sweepResultArtifacts([kandidatas]);

  assert.equal(verdiktas.verdiktas, "nepavyko");
  assert.match(verdiktas.priezastis, /5xx/);
});

test("neregistruotas `storage_type` yra `nepavyko`, ne praleidimas", async () => {
  /**
   * Praleidus jį tyliai, šlavėjas raportuotų sėkmę objektui, kurio net nebandė paliesti.
   */
  const store = createPostgresStore(pool, { artifactStores: { fs: saugykla({}) } });

  const [verdiktas] = await store.sweepResultArtifacts([{ ...kandidatas, storage_type: "s3" }]);

  assert.equal(verdiktas.verdiktas, "nepavyko");
  assert.match(verdiktas.priezastis, /s3/);
});

test("VERDIKTŲ POROS LENTELĖ: keturios būsenos, po vieną kelią", async () => {
  /**
   * ⚠️ VERDIKTAS PRIIMAMAS IŠ POROS, NE IŠ DVIEJŲ `if`. Šis testas fiksuoja visą lentelę
   * vienoje vietoje: jei kas nors ateityje išskirs šakas, viena iš keturių eilučių
   * pasikeis, ir tai bus matoma čia, o ne trijuose atskiruose testuose.
   */
  const atvejai = [
    { laikinas: false, galutinis: false, laukiama: "nebuvo", trynimai: [] },
    { laikinas: false, galutinis: true, laukiama: "pasalinta", trynimai: ["galutinis:results/j/a.json"] },
    { laikinas: true, galutinis: false, laukiama: "pasalinta", trynimai: ["laikinas:results/j/a.json"] },
    { laikinas: true, galutinis: true, laukiama: "pazeidimas", trynimai: [] },
  ];

  for (const atvejis of atvejai) {
    const trynimai = [];
    const store = createPostgresStore(pool, {
      artifactStores: {
        fs: saugykla({
          async zondas() {
            return { yra: atvejis.laikinas, bytes: null };
          },
          async galva() {
            return atvejis.galutinis ? { exists: true, bytes: 1 } : null;
          },
          trynimai,
        }),
      },
    });

    const [verdiktas] = await store.sweepResultArtifacts([kandidatas]);

    const zyme = `laikinas=${atvejis.laikinas} galutinis=${atvejis.galutinis}`;
    assert.equal(verdiktas.verdiktas, atvejis.laukiama, zyme);
    assert.deepEqual(trynimai, atvejis.trynimai, zyme);
  }
});
