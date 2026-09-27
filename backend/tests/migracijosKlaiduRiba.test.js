const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRIEZASTIS,
  migruoti,
  NutrauktaPartijosKlaida,
} = require("../utils/artifactMigration");
const { ArtifactStoreError, KLAIDA } = require("../utils/artifactStore/validation");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * MIGRACIJOS KLAIDŲ KLASIŲ RIBA (#421, D1–D9).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO. Ta pati klasifikuota infrastruktūrinė priežastis gauna
 * VIENĄ partijos kontraktą, nesvarbu, kuriame sluoksnyje ji aptikta: DB gedimas
 * (nuo #417) ir saugyklos gedimas (nuo #421) abu nutraukia partiją
 * `NutrauktaPartijosKlaida` ir NIEKO nepažymi `failed`.
 *
 * ⚠️ KĄ JIS SAUGO NUO „PATAISYMO". `ok !== true` verdiktas ir eilutės savybės
 * gedimai LIEKA `failed` su tęsiamu ciklu. Testas „D6" žemiau yra svarbiausias
 * šio darbo sargas: be jo #421 pataisa pablogintų teisingą elgesį.
 *
 * ⚠️ BE DB. Klausimas yra apie KLASIFIKACIJĄ ir partijos verdiktą, ne apie SQL:
 * dublis fiksuoja kiekvieną sakinį, tad „ar `failed` įrašas parašytas" matoma
 * tiesiogiai. Elgesį su tikra DB tikrina `artifactMigration.integration`.
 */

/**
 * Dublis su N kandidatų. Fiksuoja VISUS sakinius su parametrais — kitaip
 * „`failed` įrašo NĖRA" būtų tikrinama pagal tai, ko testas nemato.
 */
function padirbtasPoolDaug(eiluciu = 1, payload = { text: "x" }) {
  const sakiniai = [];

  const atsakymas = (sql) => {
    if (/FROM job_results r/.test(sql)) {
      return {
        rows: Array.from({ length: eiluciu }, (_, i) => ({ job_id: `job-${i + 1}` })),
        rowCount: eiluciu,
      };
    }
    if (/SELECT\s+payload/.test(sql)) return { rows: [{ payload }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  const irasyti = (sql, params) => sakiniai.push({ sql: String(sql), params: params || [] });

  const client = {
    async query(sql, params) {
      irasyti(sql, params);
      return atsakymas(String(sql));
    },
    release() {},
  };

  return {
    sakiniai,
    /**
     * `failed` progreso ĮRAŠAI — tai, ko po D2 sisteminiame kelyje būti NEGALI.
     *
     * ⚠️ Tikrinamas `INSERT`, ne vien lentelės vardas: `KANDIDATAI_SQL` tą pačią
     * lentelę ir tą patį žodį `'failed'` mini ATRANKOJE, tad platesnis filtras
     * skaičiuotų skaitymą kaip rašymą.
     */
    nesekmes() {
      return sakiniai.filter(
        (s) => /INSERT INTO artifact_migration_progress/.test(s.sql) && /'failed'/.test(s.sql)
      );
    },
    atmestiBandymai() {
      return sakiniai.filter(
        (s) => /UPDATE job_result_attempts/.test(s.sql) && s.params[1] === "abandoned"
      );
    },
    async query(sql, params) {
      irasyti(sql, params);
      return atsakymas(String(sql));
    },
    async connect() {
      return client;
    },
  };
}

function padirbtaSaugykla(perrasymai = {}) {
  const irasai = { put: 0, verify: 0, delete: [] };

  return {
    irasai,
    backend: "fs",
    async put(raktas) {
      irasai.put += 1;
      return { reference: raktas, bytes: 10, checksum: "e".repeat(64) };
    },
    async verify() {
      irasai.verify += 1;
      return { ok: true, exists: true, bytes: 10, checksum: "e".repeat(64), nepriklausomas: true };
    },
    async head() {
      return { bytes: 10 };
    },
    async delete(raktas) {
      irasai.delete.push(raktas);
      return true;
    },
    ...perrasymai,
  };
}

// ---------------------------------------------------------------------------
// D1 + D2: sisteminis `put()` gedimas
// ---------------------------------------------------------------------------

test("#421 D2: sisteminis `put()` gedimas NUTRAUKIA partiją ir NEPALIEKA `failed`", async () => {
  /**
   * ⚠️ DVI ASERCIJOS, DVI SKIRTINGOS SAVYBĖS. „Nutraukė" be „nepažymėjo" būtų
   * tenkinama realizacijos, kuri pažymi IR meta — o tada eilutė iš atrankos vis
   * tiek iškristų, ir `--retry-failed` liktų būtinas.
   */
  const pool = padirbtasPoolDaug(3);
  const saugykla = padirbtaSaugykla({
    async put() {
      throw Object.assign(new Error("ECONNREFUSED: saugykla nepasiekiama"), {
        code: "ECONNREFUSED",
      });
    },
  });

  await assert.rejects(() => migruoti(pool, saugykla, {}), NutrauktaPartijosKlaida);
  assert.deepEqual(pool.nesekmes(), [], "sisteminis gedimas NEGALI palikti `failed` įrašo");
});

test("#421 D4: naudojamas #417 kontraktas — dalinė suvestinė ir `cause`", async () => {
  /**
   * ❌ Naujo kontrakto nėra: ta pati klasė, tie patys laukai, tas pats exit kodas.
   */
  const pool = padirbtasPoolDaug(2);
  const saugykla = padirbtaSaugykla({
    async put() {
      throw new Error("saugykla nepasiekiama");
    },
  });

  const klaida = await migruoti(pool, saugykla, {}).then(
    () => null,
    (e) => e
  );

  assert.ok(klaida instanceof NutrauktaPartijosKlaida);
  assert.equal(klaida.code, "MIGRATION_BATCH_ABORTED");
  assert.equal(klaida.suvestine.nutraukta, true);
  assert.equal(klaida.suvestine.apdorota, 0, "nė viena eilutė baigties negavo");
  assert.ok(klaida.cause, "originali klaida privalo likti grandinėje");
  assert.match(String(klaida.cause.message), /nepasiekiama/);
});

test("#421 D7: sisteminiame kelyje objektas ir bandymo įrašas sutvarkomi", async () => {
  /**
   * ⚠️ `return` → `throw` NEGALI PALIKTI NAUJŲ ORPHAN'Ų. Valymas kviečiamas
   * PRIEŠ klasifikaciją, tad jis vyksta abiejose šakose.
   */
  const pool = padirbtasPoolDaug(1);
  const saugykla = padirbtaSaugykla({
    async put() {
      throw new Error("saugykla nepasiekiama");
    },
  });

  await assert.rejects(() => migruoti(pool, saugykla, {}), NutrauktaPartijosKlaida);

  assert.equal(saugykla.irasai.delete.length, 1, "objekto šalinimas PRIVALO būti bandytas");
  assert.equal(pool.atmestiBandymai().length, 1, "bandymas privalo likti `abandoned`");
});

// ---------------------------------------------------------------------------
// D1 riba: eilutės lygio klaida iš `put()` elgiasi KAIP ANKSČIAU
// ---------------------------------------------------------------------------

test("#421 D3: eilutės lygio `put()` klaida lieka `failed`, ciklas TĘSIA", async () => {
  /**
   * ⚠️ TAI STRUKTŪRINĖ IŠIMTIS, NE PRANEŠIMO ANALIZĖ (atviras kl. 1).
   *
   * Šiandien nei `RAKTAS`, nei `REIKSME` iš `put()` migratoriaus nepasiekia
   * (`job_id` yra `uuid`, o reikšmė paruošiama ir tikrinama 1 žingsnyje). Testas
   * tikrina, kad riba VEIKIA, jei kuris nors iš tų invariantų kada nors nutrūktų:
   * eilutės savybė neturi nutraukti 10 000 eilučių partijos.
   */
  const pool = padirbtasPoolDaug(2);
  const saugykla = padirbtaSaugykla({
    async put() {
      throw new ArtifactStoreError("blogas raktas", KLAIDA.RAKTAS);
    },
  });

  const s = await migruoti(pool, saugykla, {});

  assert.equal(s.nutraukta, false, "eilutės savybė partijos NENUTRAUKIA");
  assert.equal(s.apdorota, 2, "abi eilutės gavo baigtį");
  assert.equal(s.nepavyko[PRIEZASTIS.SAUGYKLOS_KLAIDA], 2);
  assert.equal(pool.nesekmes().length, 2, "eilutės savybė PRIVALO palikti `failed`");
});

test("#421 D3: `payload` neatvaizduojamas lieka EILUTĖS savybe — partija tęsiasi", async () => {
  /**
   * ⚠️ DVI KLASĖS PRIVALO LIKTI ATSKIRIAMOS (D1 riba, D3).
   *
   * Neatvaizduojamas `payload` yra TOS eilutės savybė: kita eilutė su tvarkingu
   * turiniu praeitų. Pavertus jį sisteminiu, vienas sugedęs įrašas sustabdytų
   * visą partiją — t. y. #421 pataisa nuklystų į priešingą kraštutinumą.
   *
   * ⚠️ `NUL` simbolis parinktas todėl, kad jį atmeta `paruostiReiksme()` —
   * patikra, kuri migratoriuje vyksta PRIEŠ registrą (1 žingsnis).
   */
  const pool = padirbtasPoolDaug(2, { text: "a\u0000b" });
  const saugykla = padirbtaSaugykla();

  const s = await migruoti(pool, saugykla, {});

  assert.equal(s.nutraukta, false, "eilutės savybė partijos NENUTRAUKIA");
  assert.equal(s.apdorota, 2);
  assert.equal(s.nepavyko[PRIEZASTIS.PAYLOAD_NEATVAIZDUOJAMAS], 2);
  assert.equal(pool.nesekmes().length, 2, "eilutės savybė PRIVALO palikti `failed`");
  assert.equal(saugykla.irasai.put, 0, "riba tikrinama PRIEŠ rašymą");
});

// ---------------------------------------------------------------------------
// D6: `verify()` — dvi šakos
// ---------------------------------------------------------------------------

test("#421 D6: `verify()` META išimtį → partija nutraukiama, `failed` įrašo nėra", async () => {
  /**
   * Metimas reiškia, kad patikra NEĮVYKO. Abu adapteriai verdiktą GRĄŽINA
   * (įskaitant „nėra" ir „nesutampa") ir meta tik tada, kai patikros atlikti
   * nepavyko — tad metimas yra tos pačios klasės gedimas kaip `put()` metimas.
   */
  const pool = padirbtasPoolDaug(2);
  const saugykla = padirbtaSaugykla({
    async verify() {
      throw Object.assign(new Error("ETIMEDOUT: saugykla neatsako"), { code: "ETIMEDOUT" });
    },
  });

  await assert.rejects(() => migruoti(pool, saugykla, {}), NutrauktaPartijosKlaida);
  assert.deepEqual(pool.nesekmes(), [], "`verify()` metimas NEGALI palikti `failed` įrašo");
  assert.equal(saugykla.irasai.delete.length, 1, "bandymo objektas išvalomas");
  assert.equal(pool.atmestiBandymai().length, 1, "bandymas pažymimas `abandoned`");
});

test("#421 D6 SARGAS: `verify()` verdiktas `ok: false` lieka `failed`, partija TĘSIASI", async () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO DARBO SARGAS. „Sutaisymas", paverčiantis VISĄ `verify()`
   * gedimą fataliu, pablogintų teisingą elgesį: tikras vieno objekto vientisumo
   * nesutapimas sustabdytų visą partiją, nors kitos eilutės su juo neturi nieko
   * bendra.
   *
   * Skirtumas nuo testo aukščiau yra vienas ir struktūrinis: ten adapteris METĖ,
   * čia — GRĄŽINO verdiktą.
   */
  const pool = padirbtasPoolDaug(2);
  const saugykla = padirbtaSaugykla({
    async verify() {
      return {
        ok: false,
        exists: true,
        bytes: 10,
        checksum: "a".repeat(64),
        nepriklausomas: true,
      };
    },
  });

  const s = await migruoti(pool, saugykla, {});

  assert.equal(s.nutraukta, false, "neigiamas verdiktas partijos NENUTRAUKIA");
  assert.equal(s.nepavyko[PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS], 2);
  assert.equal(pool.nesekmes().length, 2, "neigiamas verdiktas PRIVALO palikti `failed`");
});

// ---------------------------------------------------------------------------
// Partija sugenda VIDURYJE
// ---------------------------------------------------------------------------

test("#421: partija sugenda TIES K — 1..K-1 lieka atlikti, K-oji be įrašo", async () => {
  /**
   * ⚠️ K IŠ N, KUR 1 < K < N. Gedimas ties pirmąja eilute nieko neatskirtų:
   * `perkelta: 0` ir „nutraukta prieš pradedant" atrodo vienodai. Tik vidurinis
   * gedimas parodo, kad ankstesnis darbas IŠLIEKA, o nutrūkusi eilutė į
   * `apdorota` NEĮEINA.
   */
  const N = 4;
  const K = 3;
  let kviesta = 0;
  const pool = padirbtasPoolDaug(N);
  const saugykla = padirbtaSaugykla({
    async put(raktas) {
      kviesta += 1;
      if (kviesta === K) throw new Error("saugykla dingo viduryje partijos");
      return { reference: raktas, bytes: 10, checksum: "e".repeat(64) };
    },
  });

  const klaida = await migruoti(pool, saugykla, {}).then(
    () => null,
    (e) => e
  );

  assert.ok(klaida instanceof NutrauktaPartijosKlaida);
  assert.equal(klaida.suvestine.perkelta, K - 1, "ankstesnės eilutės PERKELTOS");
  assert.equal(klaida.suvestine.apdorota, K - 1, "nutrūkusi eilutė į `apdorota` NEĮEINA");
  assert.equal(klaida.suvestine.nutraukta, true);
  assert.equal(kviesta, K, "ciklas NETĘSIAMAS — likusios eilutės nepaliestos");
  assert.deepEqual(pool.nesekmes(), [], "nutrūkusi eilutė lieka kandidatė BE `retryFailed`");
});

test("#421 KONTROLĖ: be gedimo partija baigiasi normaliai", async () => {
  /**
   * ⚠️ BE ŠITO viską nutraukianti realizacija praeitų kiekvieną testą aukščiau.
   */
  const pool = padirbtasPoolDaug(3);
  const saugykla = padirbtaSaugykla();

  const s = await migruoti(pool, saugykla, {});

  assert.equal(s.nutraukta, false);
  assert.equal(s.apdorota, 3);
  assert.equal(s.perkelta, 3);
  assert.deepEqual(pool.nesekmes(), []);
});
