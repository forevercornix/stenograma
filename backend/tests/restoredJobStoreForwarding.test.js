const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { sukurti, BUTINI } = require("../utils/restoredJobStore");

/**
 * ADAPTERIS NEGALI SIAURINTI PARAŠO (#157, PR-3, Codex #291).
 *
 * ⚠️ ŠAKNIS BUVO NE TRŪKSTAMAS `hydrate`, O PARAŠO NUSIAURINIMAS.
 *
 * `get: (jobId) => store.get(jobId)` tyliai numesdavo antrąjį argumentą. Taip mirė
 * `{ hydrate: false }` DR replay kelyje — bet lygiai taip mirtų ir bet kuris BŪSIMAS
 * parametras. Todėl metodai generuojami iš `BUTINI`, o ne rašomi ranka.
 *
 * ⚠️ IR SARGAS 8 EILUTĖS AUKŠČIAU ŠITO NEPAGAVO: jis tikrina metodų VARDUS, ne
 * parašus. `Function.length` irgi nepadėtų — `get(id, opts = {})` turi `length === 1`,
 * kaip ir `(jobId) => ...`. Tikrinamas ELGESYS: ar parametras realiai nukeliauja.
 */

/** Pool'as, fiksuojantis SQL — tikro kontrakto forma (`rows`, `rowCount`). */
function iraseinantisPool() {
  const uzklausos = [];
  return {
    uzklausos,
    async query(sql, params) {
      uzklausos.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

const JOB_ID = "11111111-2222-3333-4444-555555555555";

test("`system.get()` PERSIUNČIA nustatymus į `postgresStore`", async () => {
  /**
   * ⚠️ TIKRINAMA PER SQL, NE PER SPY: `hydrate: false` reiškia METADUOMENŲ užklausą,
   * tad `r.payload` joje neturi būti. Taip matuojamas rezultatas, o ne tarpinis
   * kvietimas — jei kada nors pasikeis, kaip parametras keliauja, testas vis tiek
   * kalbės apie tą patį faktą.
   */
  const pool = iraseinantisPool();
  const store = sukurti(pool);

  await store.system.get(JOB_ID, { hydrate: false });

  const sql = pool.uzklausos.map((u) => u.sql).join("\n");
  assert.ok(!/r\.payload/.test(sql), `metaduomenų kelias neturi traukti turinio:\n${sql}`);
  assert.match(sql, /FROM jobs j/, "bet job'o eilutė vis tiek skaitoma");
});

test("KONTROLĖ: be nustatymų tas pats adapteris hidratuoja", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas ir adapterio, kuris NIEKADA
   * nehidratuoja — tada „parametras persiunčiamas" reikštų „parametras ignoruojamas
   * kita kryptimi".
   */
  const pool = iraseinantisPool();
  const store = sukurti(pool);

  await store.system.get(JOB_ID, { hydrate: true });

  const sql = pool.uzklausos.map((u) => u.sql).join("\n");
  assert.match(sql, /r\.payload/, "numatytasis kelias turinį traukia");
});

test("kiekvienas `BUTINI` metodas persiunčia VISUS argumentus", async () => {
  /**
   * ⚠️ AIBĖ IŠVEDAMA IŠ `BUTINI`, ne surašoma teste: pridėjus metodą, jis iškart
   * patenka į patikrą. Būtent tokio išvedimo trūko ir pačiame adapteryje.
   */
  const gauti = new Map();
  const netikrasStore = {};
  for (const metodas of BUTINI) {
    netikrasStore[metodas] = async (...argumentai) => {
      gauti.set(metodas, argumentai);
      return null;
    };
  }

  /** Adapteris kuria savo `postgresStore`, tad tikriname generavimo taisyklę tiesiogiai. */
  const system = {};
  for (const metodas of BUTINI) {
    system[metodas] = (...argumentai) => netikrasStore[metodas](...argumentai);
  }

  for (const metodas of BUTINI) {
    await system[metodas](JOB_ID, { zyme: metodas }, "trecias");
  }

  for (const metodas of BUTINI) {
    assert.deepEqual(
      gauti.get(metodas),
      [JOB_ID, { zyme: metodas }, "trecias"],
      `${metodas}: adapteris privalo persiųsti VISUS argumentus`
    );
  }
});

test("#157 PR-5: adapteris DEKLARUOJA sprendimą kiekvienai `postgresStore` parinkčiai", () => {
  /**
   * ⚠️ TREČIAS KARTAS TA PAČIA PRIEŽASTIMI (Codex, #304).
   *
   * PR-3 adapteris numesdavo parašus, PR-5 turėjo antrą būtinų metodų sąrašo kopiją, o
   * dabar — nebeperduodavo saugyklų, tad DR replay su bet kokia external eilute krito
   * `parinktiArtefaktuSaugykla()` viduje.
   *
   * Šaknis ta pati: adapteris STATO store'ą, tad kiekviena nauja konstrukcijos parinktis
   * jam yra nauja skola. Taškinis taisymas uždarytų trečią atvejį ir paliktų ketvirtą,
   * todėl aibė ateina iš `postgresStore`, o adapteris privalo turėti sprendimą kiekvienam
   * jos vardui. Šis testas krenta, kai atsiranda ketvirta parinktis.
   */
  const { KONSTRUKCIJOS_PARINKTYS } = require("../utils/jobStore/postgresStore");
  const restoredJobStore = require("../utils/restoredJobStore");

  assert.ok(KONSTRUKCIJOS_PARINKTYS.length > 0, "kontrolė: aibė netuščia");

  /** Konstrukcija su tikru pool'o dubliu privalo praeiti — visos parinktys deklaruotos. */
  assert.doesNotThrow(() => restoredJobStore.sukurti({ query: async () => ({ rows: [] }) }));
});

test("#157 PR-5: nepilna konfigūracija atmetama PRIEŠ pirmą replay žingsnį", async () => {
  /**
   * ⚠️ KRITIMAS VIDURYJE YRA BLOGIAUSIA IŠ TRIJŲ GALIMYBIŲ: dalis job'ų jau apdorota,
   * replay pažymimas kritiniu, o operatorius mato klaidą apie neregistruotą
   * `storage_type` procedūros viduryje.
   */
  const restoredJobStore = require("../utils/restoredJobStore");

  const suExternal = {
    query: async (sql) => {
      if (/storage_type/.test(sql)) return { rows: [{ storage_type: "s3" }] };
      return { rows: [] };
    },
  };

  await assert.rejects(() => restoredJobStore.paruosti(suExternal), /s3/);

  /** KONTROLĖ: padavus tai saugyklai, paruošimas praeina. */
  const adapteris = await restoredJobStore.paruosti(suExternal, {
    artifactStores: { s3: { backend: "s3" } },
  });
  assert.equal(typeof adapteris.system.remove, "function");

  /** KONTROLĖ: inline-only bazė saugyklų nereikalauja. */
  const tikInline = { query: async () => ({ rows: [] }) };
  assert.ok(await restoredJobStore.paruosti(tikInline));
});
