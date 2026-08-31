const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const memoryStore = require("../utils/jobStore/memoryStore");
const { createRedisStore, deserialize, serialize } = require("../utils/jobStore/redisStore");
const { jobToRow } = require("../utils/jobStore/postgresStore");
const { FakeRedis } = require("./helpers/fakeRedis");
const { IVESTYS, NELEISTINOS, NEDALYVAUJA_PATCHUOSE, patchLaukai } = require("./helpers/canonicalTypeFixtures");
const { assertSupportedSchemaVersion } = require("../utils/jobAuthorization");

const {
  newJob,
  applyPatch,
  normalizeJob,
  normalizeFieldValue,
  normalizeSchemaVersion,
  BOOLEAN_FIELDS,
  NUMBER_FIELDS,
  KANONINIAI_LAUKAI,
} = require("../utils/jobStore/common");

/**
 * KANONINIŲ TIPŲ NORMALIZAVIMAS IR BACKEND'Ų PARITETAS (#205, 7.2c).
 *
 * ⚠️ KĄ TAI GYNĖ IKI ŠIOL: NIEKO.
 *
 * `store.update(id, { audio_cleanup_pending: "false" })` prieš pataisą duodavo
 * TRIS skirtingus rezultatus - ir ne tik kitokį tipą, o PRIEŠINGĄ loginę
 * reikšmę (išmatuota, ne perskaityta):
 *
 *   memory            "false"  (string, TRUTHY)
 *   redis.update()    "false"  (string, TRUTHY)   ← rašymo kelias
 *   redis.get()       false                        ← skaitymo kelias
 *   postgres          true     (Boolean("false"))
 *
 * ⚠️ KODĖL TIKRINAMAS IR `update()` GRĄŽINIMAS, IR `get()`.
 *
 * Vien `get()` patikra nieko neįrodo: `redisStore.deserialize()` normalizuoja
 * skaitant, tad ji PASLĖPTŲ rašymo kelio regresiją visiškai. Būtent taip šis
 * gedimas ir išgyveno.
 *
 * ⚠️ REDIS TIKRINAMAS PER `FakeRedis`, NE PER TIKRĄ SERVERĮ - IR TAI PAKANKA.
 *
 * Gedimas gyvena `applyPatch()`, `serialize()` ir `deserialize()` funkcijose,
 * ne tinklo elgesyje. Tikras Redis čia nieko nepridėtų.
 *
 * PostgreSQL pusė dengiama dviem būdais: gryna `jobToRow()` funkcija (be DB,
 * vykdoma visur) ir pilnu round-trip'u `postgresStore.integration.test.js`, kur
 * jau yra veikianti DB infrastruktūra.
 */

const NAUJAS_REDIS = () => createRedisStore(new FakeRedis());

/** `{ reikšmė, tipas }` - kad palyginimas apimtų IR tipą, ne tik reikšmę. */
function pavidalas(v) {
  return { reiksme: v, tipas: typeof v };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. SARGAS IR JO RIBA
 * ══════════════════════════════════════════════════════════════════════════ */

test("#205 SARGAS: kiekvienas `newJob()` boolean/number laukas yra kanoninėje aibėje", () => {
  /**
   * ⚠️ AIBĖS DEKLARUOTOS, SARGAS TIKRINA - NE ATVIRKŠČIAI.
   *
   * Generavus aibes iš `newJob()`, schema taptų konstruktoriaus išvestine, ir
   * pamiršus lauką normalizavimas tyliai dingtų kartu su juo. Čia schema yra
   * autoritetas, o konstruktorius - tikrinamas prieš ją.
   */
  const job = newJob({});
  const trukstami = [];

  for (const [laukas, reiksme] of Object.entries(job)) {
    if (typeof reiksme === "boolean" && !BOOLEAN_FIELDS.has(laukas)) {
      trukstami.push(`${laukas} (boolean) nėra BOOLEAN_FIELDS`);
    }
    if (typeof reiksme === "number" && !NUMBER_FIELDS.has(laukas)) {
      trukstami.push(`${laukas} (number) nėra NUMBER_FIELDS`);
    }
  }

  assert.deepEqual(
    trukstami,
    [],
    "naujas typed laukas `newJob()` privalo turėti kanoninį tipų kontraktą - kitaip jis negaus normalizavimo"
  );
});

test("#205 SARGO RIBA: kanoniniai laukai, kurių `newJob()` NEMATERIALIZUOJA, deklaruoti eksplicitiškai", () => {
  /**
   * ⚠️ SARGAS MATO TIK `newJob()` IŠVESTĮ - ir tai jo riba, ne pilnumas.
   *
   * `deletion_pending` ir `deletion_attempts` atsiranda tik vėliau
   * (`postgresStore.rowToJob()`, ištrynimo kelias), tad sargas jų NIEKADA
   * nepamatytų. Jie kanoniniame kontrakte įrašyti rankomis.
   *
   * Šis testas paverčia tą ribą MATOMA: naujas kanoninis laukas, kurio
   * `newJob()` nemateralizuoja, privalo būti čia įvardytas sąmoningai, o ne
   * tyliai iškristi iš sargo akiračio.
   */
  const NEMATOMI_SARGUI = new Set(["deletion_pending", "deletion_attempts"]);

  const job = newJob({});
  const nedeklaruoti = KANONINIAI_LAUKAI.filter(
    (laukas) => !(laukas in job) && !NEMATOMI_SARGUI.has(laukas)
  );

  assert.deepEqual(
    nedeklaruoti,
    [],
    "kanoninis laukas, kurio `newJob()` nemateralizuoja, sargui NEMATOMAS - įrašykite jį į NEMATOMI_SARGUI sąmoningai"
  );

  /** Kita kryptis: sąrašas negali pasenti, jei laukas atsirastų `newJob()`. */
  const jauMaterializuoti = [...NEMATOMI_SARGUI].filter((laukas) => laukas in job);
  assert.deepEqual(
    jauMaterializuoti,
    [],
    "šie laukai jau yra `newJob()` išvestyje - sargas juos mato, tad išimtis nebereikalinga"
  );
});

test("#205 TYPED DEFAULTS: kanoniniai `newJob()` laukai turi typed reikšmes, ne `null`", () => {
  /**
   * ⚠️ INVARIANTAS, NUO KURIO PRIKLAUSO SARGAS. `typeof null === "object"`, tad
   * `null` inicijuotas boolean laukas sargui atrodytų netipizuotas ir tyliai
   * iškristų iš tikrinimo. Taisyklė užrašyta ir `newJob()` komentare.
   */
  const job = newJob({});
  const blogi = [];

  for (const laukas of KANONINIAI_LAUKAI) {
    if (!(laukas in job)) continue;
    const tikimasi = BOOLEAN_FIELDS.has(laukas) ? "boolean" : "number";
    if (typeof job[laukas] !== tikimasi) {
      blogi.push(`${laukas}: ${JSON.stringify(job[laukas])} (${typeof job[laukas]}), laukta ${tikimasi}`);
    }
  }

  assert.deepEqual(blogi, [], "kanoninis laukas privalo turėti typed numatytąją reikšmę");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. VIENA TAISYKLĖ DVIEM VIETOMS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#205 VIENAS HELPERIS: rašymo kelias ir `deserialize()` tai pačiai įvesčiai duoda TAPATŲ rezultatą", () => {
  /**
   * Po pataisos normalizavimo vietų lieka dvi - rašymo kelias `common.js` ir
   * `redisStore.deserialize()`, nes Redis fiziškai saugo tekstą. Dvi
   * nepriklausomos realizacijos yra ta pati klasė, kurią #205 šalina.
   */
  const skirtumai = [];

  for (const laukas of patchLaukai()) {
    for (const ivestis of [...IVESTYS[laukas], ...NELEISTINOS]) {
      /** `""` yra Redis SAVYBĖ, ne taisyklė - žr. atskirą testą žemiau. */
      if (ivestis === "") continue;

      const rasant = applyPatch(newJob({}), { [laukas]: ivestis })[laukas];
      const skaitant = deserialize({ [laukas]: ivestis })[laukas];

      if (!Object.is(rasant, skaitant)) {
        skirtumai.push(`${laukas}=${JSON.stringify(ivestis)}: rašant ${JSON.stringify(rasant)}, skaitant ${JSON.stringify(skaitant)}`);
      }
    }
  }

  assert.deepEqual(skirtumai, [], "abi normalizavimo vietos privalo naudoti tą pačią taisyklę");
});

test("#205 REDIS SAVYBĖ: `\"\"` reiškia `null`, ir tai NĖRA antra normalizavimo taisyklė", () => {
  /**
   * `serialize()` `null` užrašo kaip `""`, tad tuščia eilutė Redis hash'e
   * reiškia „buvo null", o ne „reikšmė tuščia". Skirtumas užrašomas testu, kad
   * nebūtų palaikytas taisyklių išsiskyrimu.
   *
   * ⚠️ Po 7.2c kanoniniame lauke `""` Redis'e nebeatsiranda: normalizavimas
   * įvyksta PRIEŠ `serialize()`, tad ten patenka jau `"false"` arba `"0"`.
   */
  assert.equal(deserialize({ audio_cleanup_pending: "" }).audio_cleanup_pending, null);
  assert.equal(normalizeFieldValue("audio_cleanup_pending", ""), false);

  const job = applyPatch(newJob({}), { audio_cleanup_pending: "" });
  assert.equal(job.audio_cleanup_pending, false);
  assert.equal(serialize(job).audio_cleanup_pending, "false", "į Redis patenka jau kanoninė reikšmė");
});

test("#205 `schemaVersion` AUTORITETAS: normalizavimą daro `normalizeSchemaVersion()`, ne bendra skaičių taisyklė", () => {
  /**
   * ⚠️ VIENAS AUTORITETAS PER LAUKĄ.
   *
   * Iki 7.2c to paties lauko normalizavimą aprašė DVI funkcijos:
   * `normalizeSchemaVersion()` (#204) ir `redisStore.deserialize()` viduje
   * įrašyta `parseInt(v, 10) || 0`. Jos nesutampa, ir #204-oji neturėjo NĖ
   * VIENO kvietėjo - deklaruota, bet neprijungta.
   *
   * Du skirtumai keičia ne tipą, o `assertSupportedSchemaVersion()` SPRENDIMĄ.
   * Šis testas fiksuoja naują elgesį, kad prijungimo nebūtų galima tyliai
   * atsukti.
   */
  const REIKSMES = [2, "2", 0, "0", null, undefined, "x", "2.5", 2.5, true, " 2 ", "3abc", "0x2"];

  for (const v of REIKSMES) {
    assert.deepEqual(
      pavidalas(normalizeFieldValue("schemaVersion", v)),
      pavidalas(normalizeSchemaVersion(v)),
      `schemaVersion=${JSON.stringify(v)}: kanoninis helperis privalo deleguoti į #204 taisyklę`
    );
  }

  /**
   * ⚠️ KONKRETUS ELGESIO POKYTIS, DĖL KURIO ŠIS TESTAS EGZISTUOJA.
   *
   * Sena `parseInt("2.5", 10) || 0` taisyklė duodavo `2`, ir sugadinta kopijos
   * reikšmė TYLIAI praeidavo kaip era 2. Dabar ji lieka `"2.5"` ir yra GARSIAI
   * atmetama - neaiški reikšmė negali būti aiškinama kaip kita loginė reikšmė.
   */
  const perimta = normalizeFieldValue("schemaVersion", "2.5");
  assert.equal(perimta, "2.5", "`\"2.5\"` NEGALI tyliai tapti era 2");
  assert.throws(
    () => assertSupportedSchemaVersion({ id: "x", schemaVersion: perimta }),
    /Nepalaikoma job schemaVersion/,
    "sugadinta era privalo būti atmesta, o ne priimta kaip 2"
  );

  /**
   * ⚠️ `"0x2"` → 2 yra #204 TAISYKLĖS SAVYBĖ (`Number("0x2") === 2`), NE 7.2c
   * sprendimas. Fiksuojama, kad vėliau niekas jos nepriskirtų šiam issue.
   */
  assert.equal(normalizeFieldValue("schemaVersion", "0x2"), 2);
});

test("#205 TRIPWIRE: `redisStore.js` nebeturi savo tipų aibių", () => {
  /**
   * ⚠️ TRIPWIRE, NE ELGSENOS ĮRODYMAS (AGENTS.md §9.2). Elgesį įrodo pariteto
   * ir tapatumo testai; šis gaudo tik atkurtą KOPIJĄ - t. y. antrą deklaraciją,
   * kuri iš pradžių elgtųsi vienodai, o išsiskirtų vėliau.
   *
   * ⚠️ KO ŠIS TRIPWIRE NEGAUDO, IR TAI PATIKRINTA MUTACIJA: kopijos, pavadintos
   * KITAIP (`BOOLEAN_FIELDS_LOKALIOS`). Elgesys tada nesikeičia, tad nekrinta ir
   * elgsenos testai. Tikras atsukimas atrodo kaip revertas su tais pačiais
   * vardais - jį šis tripwire pagauna; sąmoningą perrašymą kitu vardu gaudo
   * tik peržiūra. Riba užrašoma, o ne nutylima.
   */
  const saltinis = fs.readFileSync(
    path.join(__dirname, "..", "utils", "jobStore", "redisStore.js"),
    "utf8"
  );

  for (const vardas of ["BOOLEAN_FIELDS", "NUMBER_FIELDS"]) {
    assert.equal(
      new RegExp(`const\\s+${vardas}\\s*=`).test(saltinis),
      false,
      `${vardas} privalo ateiti iš common.js, ne būti deklaruota redisStore.js`
    );
    assert.equal(
      new RegExp(`${vardas}[^=]*\\}\\s*=\\s*require\\("\\./common"\\)`, "s").test(saltinis),
      true,
      `${vardas} privalo būti importuota iš common.js - be importo aibė vėl taptų vietine`
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. TRYS RAŠYMO KELIAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#205 KELIAS `create()`: sukurtas job'as kanoninių tipų abiejuose backend'uose", async () => {
  const redis = NAUJAS_REDIS();
  const mem = await memoryStore.create({});
  const red = await redis.create({});

  for (const [pavadinimas, job] of [["memory", mem], ["redis", red]]) {
    for (const laukas of KANONINIAI_LAUKAI) {
      if (!(laukas in job)) continue;
      const tikimasi = BOOLEAN_FIELDS.has(laukas) ? "boolean" : "number";
      assert.equal(typeof job[laukas], tikimasi, `${pavadinimas}/${laukas}`);
    }
  }

  assert.deepEqual(pavidalas((await redis.get(red.id)).audio_cleanup_pending), pavidalas(false));
});

test("#205 KELIAS `restoreRecord()`: sena kopija su eilutėmis atkuriama KANONINE", async () => {
  /**
   * ⚠️ ATSKIRAS KELIAS, KURIO `applyPatch()` NEDENGIA.
   *
   * `restoreRecord()` priima savavališką įrašą iš atsarginės kopijos, o senesnė
   * kopija gali turėti būtent tas tekstines reikšmes, dėl kurių #205 egzistuoja.
   * Atkūrimas be normalizavimo grąžintų gedimą į gyvą sistemą tuo momentu, kai
   * niekas neįtaria.
   */
  const senaKopija = {
    ...newJob({}),
    id: "55555555-5555-4555-8555-555555555555",
    audio_cleanup_pending: "false",
    deletion_pending: "false",
    attempt_count: "0",
    audio_cleanup_attempts: "0",
    deletion_attempts: "0",
    progressKnown: "false",
  };

  const redis = NAUJAS_REDIS();

  for (const [pavadinimas, store] of [["memory", memoryStore], ["redis", redis]]) {
    const grazinta = await store.restoreRecord({ ...senaKopija });
    const perskaityta = await store.get(senaKopija.id);

    for (const laukas of patchLaukai()) {
      const tikimasi = pavidalas(normalizeFieldValue(laukas, senaKopija[laukas]));
      assert.deepEqual(pavidalas(grazinta[laukas]), tikimasi,
        `${pavadinimas}/${laukas}: restoreRecord() GRĄŽINIMAS neredukuotas`);
      assert.deepEqual(pavidalas(perskaityta[laukas]), tikimasi,
        `${pavadinimas}/${laukas}: po get()`);
    }

    await store.remove(senaKopija.id);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. RAŠYMO + SKAITYMO PARITETAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#205 PARITETAS: `update()` grąžinimas IR `get()` sutampa memory ir Redis backend'uose", async () => {
  /**
   * ⚠️ PARAMETRIZUOTA PAGAL AIBĘ, ne pagal istorinius šešis laukus. Rankinis
   * sąrašas čia atkartotų būtent tą problemą, kurią #205 taiso: naujas
   * kanoninis laukas be įvesčių SULAUŽO testą (`patchLaukai()` × `IVESTYS`).
   */
  const beIvesciu = patchLaukai().filter((laukas) => !IVESTYS[laukas]);
  assert.deepEqual(beIvesciu, [], "naujas kanoninis laukas privalo gauti įvestis helpers/canonicalTypeFixtures.js");

  const redis = NAUJAS_REDIS();

  for (const laukas of patchLaukai()) {
    for (const ivestis of IVESTYS[laukas]) {
      const tikimasi = pavidalas(normalizeFieldValue(laukas, ivestis));

      const m = await memoryStore.create({});
      const mUpdate = await memoryStore.update(m.id, { [laukas]: ivestis });
      const mGet = await memoryStore.get(m.id);

      const r = await redis.create({});
      const rUpdate = await redis.update(r.id, { [laukas]: ivestis });
      const rGet = await redis.get(r.id);

      const kontekstas = `${laukas}=${JSON.stringify(ivestis)}`;

      assert.deepEqual(pavidalas(mUpdate[laukas]), tikimasi, `memory update() ${kontekstas}`);
      assert.deepEqual(pavidalas(mGet[laukas]), tikimasi, `memory get() ${kontekstas}`);

      /**
       * ⚠️ ŠI EILUTĖ YRA VISO TESTO ESMĖ. `redisStore.update()` grąžina objektą
       * PRIEŠ serialize/deserialize round-trip. Tikrinant tik `get()`,
       * `deserialize()` paslėptų rašymo kelio regresiją visiškai.
       */
      assert.deepEqual(pavidalas(rUpdate[laukas]), tikimasi, `redis update() ${kontekstas}`);
      assert.deepEqual(pavidalas(rGet[laukas]), tikimasi, `redis get() ${kontekstas}`);

      await memoryStore.remove(m.id);
    }
  }
});

test("#205 PARITETAS: neleistina įvestis elgiasi VIENODAI, o ne perkelia divergenciją", async () => {
  /**
   * ⚠️ POLITIKA NEIŠRASTA. `applyPatch()` iki 7.2c tipų neliečia visiškai
   * (grynas pass-through), bet pass-through NEGALI būti vienodas: PostgreSQL
   * `boolean` stulpelyje `"maybe"` fiziškai netelpa (`Boolean("maybe")` → true),
   * o memory jį paliktų eilute. Todėl imama TA PATI taisyklė, kurią repozitorija
   * jau turi skaitymo kelyje (`deserialize()`).
   *
   * Kitaip divergencija tiesiog persikeltų iš teisingų reikšmių į neteisingas.
   */
  const redis = NAUJAS_REDIS();

  for (const laukas of patchLaukai()) {
    for (const ivestis of NELEISTINOS) {
      const tikimasi = pavidalas(normalizeFieldValue(laukas, ivestis));

      const m = await memoryStore.create({});
      const mUpdate = await memoryStore.update(m.id, { [laukas]: ivestis });

      const r = await redis.create({});
      const rUpdate = await redis.update(r.id, { [laukas]: ivestis });
      const rGet = await redis.get(r.id);

      const kontekstas = `${laukas}=${JSON.stringify(ivestis)}`;
      assert.deepEqual(pavidalas(mUpdate[laukas]), tikimasi, `memory ${kontekstas}`);
      assert.deepEqual(pavidalas(rUpdate[laukas]), tikimasi, `redis update() ${kontekstas}`);
      assert.deepEqual(pavidalas(rGet[laukas]), tikimasi, `redis get() ${kontekstas}`);

      await memoryStore.remove(m.id);
    }
  }
});

test("#205 PostgreSQL RAŠYMO KELIAS: `jobToRow()` gauna kanonines reikšmes (be DB)", () => {
  /**
   * ⚠️ GRYNA FUNKCIJA - VYKDOMA IR TEN, KUR DUOMENŲ BAZĖS NĖRA.
   *
   * `jobToRow()` yra VISAS PostgreSQL rašymo mapping'as. Iki 7.2c jis gaudavo
   * `"false"` ir per `Boolean("false")` rašydavo `true` - priešingą loginę
   * reikšmę nei memory ar Redis. Dabar patch'as pasiekia jį jau kanoninis.
   *
   * Pilnas DB round-trip - `postgresStore.integration.test.js`.
   */
  const job = applyPatch(newJob({}), {
    audio_cleanup_pending: "false",
    deletion_pending: "false",
    attempt_count: "0",
    audio_cleanup_attempts: "0",
    deletion_attempts: "0",
    progressKnown: "false",
  });

  const row = jobToRow(job);

  assert.deepEqual(pavidalas(row.audio_cleanup_pending), pavidalas(false),
    "`Boolean(\"false\")` būtų davęs `true` - priešingą reikšmę");
  assert.deepEqual(pavidalas(row.deletion_pending), pavidalas(false));
  assert.deepEqual(pavidalas(row.progress_known), pavidalas(false));
  assert.deepEqual(pavidalas(row.attempt_count), pavidalas(0));
  assert.deepEqual(pavidalas(row.audio_cleanup_attempts), pavidalas(0));
  assert.deepEqual(pavidalas(row.deletion_attempts), pavidalas(0));
});

test("#205 `schemaVersion` per `update()` NEKINTAMAS - todėl jo nėra patch'ų matricoje", () => {
  /**
   * Išimtis (`NEDALYVAUJA_PATCHUOSE`) galioja tik tol, kol `applyPatch()` erą
   * tikrai laiko nekintamą. Jei tai pasikeistų, laukas turi grįžti į matricą -
   * šis testas tą užtikrina, kad išimtis netaptų tyliu praleidimu.
   */
  assert.deepEqual([...NEDALYVAUJA_PATCHUOSE], ["schemaVersion"]);

  const job = newJob({});
  assert.equal(applyPatch(job, { schemaVersion: "0" }).schemaVersion, 2);
  assert.equal(applyPatch(job, { schemaVersion: 99 }).schemaVersion, 2);

  /** Normalizavimą `schemaVersion` gauna kitu keliu - per `restoreRecord()`. */
  assert.equal(normalizeJob({ ...job, schemaVersion: "2" }).schemaVersion, 2);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. TRYS ISTORINIAI GEDIMAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#205 REGRESIJA: `listByFlag()` su `\"false\"` NEBEGRĄŽINA job'o (ta, kuri ištrynė gyvą audio)", async () => {
  /**
   * ⚠️ BRANGIAUSIAS IŠ TRIJŲ. `audio_cleanup_pending: "false"` yra TRUTHY, tad
   * `listByFlag()` grąžindavo VISUS job'us, o `retryPendingAudioCleanups()`
   * tada trindavo dar APDOROJAMŲ job'ų audio. Duomenų praradimas įvyko realiai.
   */
  const redis = NAUJAS_REDIS();

  const m = await memoryStore.create({});
  await memoryStore.update(m.id, { audio_cleanup_pending: "false" });
  const memRasti = (await memoryStore.listByFlag("audio_cleanup_pending")).filter((j) => j.id === m.id);
  assert.deepEqual(memRasti, [], "memory: `\"false\"` privalo reikšti NĖRA laukiančio valymo");

  const r = await redis.create({});
  await redis.update(r.id, { audio_cleanup_pending: "false" });
  const redisRasti = (await redis.listByFlag("audio_cleanup_pending")).filter((j) => j.id === r.id);
  assert.deepEqual(redisRasti, [], "redis: tas pats");

  /** Priešinga pusė: `"true"` privalo IŠLIKTI vėliava, ne dingti. */
  await memoryStore.update(m.id, { audio_cleanup_pending: "true" });
  assert.equal(
    (await memoryStore.listByFlag("audio_cleanup_pending")).some((j) => j.id === m.id),
    true,
    "teigiama pusė būtina - kitaip „viskas tuščia“ praeitų kaip sėkmė"
  );

  await memoryStore.remove(m.id);
});

test("#205 REGRESIJA: `progressKnown === false` REALIAI suveikia", async () => {
  /**
   * #154: `"false"` yra truthy, tad griežtas `=== false` niekada nesuveikdavo,
   * ir diarizacijos fazė rodydavo procentą vietoj „progresas neteikiamas".
   */
  const redis = NAUJAS_REDIS();

  const m = await memoryStore.create({});
  const po = await memoryStore.update(m.id, { progressKnown: "false" });
  assert.equal(po.progressKnown === false, true, "memory: griežtas lyginimas privalo suveikti");

  const r = await redis.create({});
  assert.equal((await redis.update(r.id, { progressKnown: "false" })).progressKnown === false, true);
  assert.equal((await redis.get(r.id)).progressKnown === false, true);

  await memoryStore.remove(m.id);
});

test("#205 REGRESIJA: `attempt_count` didinimas duoda skaičių, ne `\"01\"`", async () => {
  /**
   * `("0" || 0) + 1 === "01"` - eilučių konkatenacija, tad bandymų skaitliukas
   * ir alerto riba neveikė.
   */
  const redis = NAUJAS_REDIS();

  for (const [pavadinimas, store] of [["memory", memoryStore], ["redis", redis]]) {
    const job = await store.create({});
    const nustatytas = await store.update(job.id, { attempt_count: "0" });
    assert.deepEqual(pavadinimas && pavidalas(nustatytas.attempt_count), pavidalas(0));

    const padidintas = await store.update(job.id, { attempt_count: nustatytas.attempt_count + 1 });
    assert.deepEqual(pavidalas(padidintas.attempt_count), pavidalas(1), `${pavadinimas}: gauta "01"?`);

    await store.remove(job.id);
  }
});
