const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const auditLog = require("../utils/auditLog");
const auditStore = require("../utils/auditStore");
const { RETENCIJOS_BATCH } = require("../utils/auditStore/postgresStore");

/**
 * PERSISTENTINĖ AUDITO RETENCIJA IR `PRIVACY_MODE` (#155, 7.4d / #213).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Čia tikrinama sweep'o LOGIKA: riba skaičiuojama kartą, batch'ai riboti,
 * ciklai nepersidengia, `PRIVACY_MODE` nebekrenta produkcijoje. SQL teisingumo
 * ir tikro trynimo įrodymas gyvena `auditPersistence.integration.test.js`,
 * kuriam reikia tikros PostgreSQL - be jos ataskaitoje tai eina kaip NOT RUN.
 */

/** Saugykla, kuri fiksuoja, KOKIUS argumentus gavo kiekvienas batch'as. */
function stebimaSaugykla(atsakymai) {
  const kvietimai = [];

  return {
    kvietimai,
    saugykla: {
      backend: "postgres",
      async purgeExpired(cutoffIso, limit) {
        kvietimai.push({ cutoffIso, limit });
        const kiek = atsakymai[kvietimai.length - 1];
        return kiek === undefined ? 0 : kiek;
      },
    },
  };
}

async function suSaugykla(saugykla, veiksmas) {
  const originalus = auditStore.current;
  auditStore.current = () => saugykla;
  try {
    return await veiksmas();
  } finally {
    auditStore.current = originalus;
  }
}

test.afterEach(() => auditLog.clear());

test("RIBA: cutoff apskaičiuojamas VIENĄ kartą ir tas pats keliauja į visus batch'us", async () => {
  /**
   * ⚠️ PERSKAIČIUOJANT `now()` KIEKVIENAM BATCH'UI, NAIKINAMA AIBĖ SLENKA.
   *
   * Ilgas sweep'as pirmame batch'e dirbtų su viena riba, paskutiniame - su
   * vėlesne, tad rezultatas priklausytų nuo trukmės: kuo lėčiau, tuo daugiau
   * eilučių pagauta. Riba turi būti sweep'o savybė, ne laikrodžio.
   */
  const { kvietimai, saugykla } = stebimaSaugykla([RETENCIJOS_BATCH, RETENCIJOS_BATCH, 7]);

  await suSaugykla(saugykla, () => auditLog.purgeExpired(Date.now()));

  assert.equal(kvietimai.length, 3, "prielaida: ciklas kartojosi");

  const ribos = new Set(kvietimai.map((k) => k.cutoffIso));
  assert.equal(ribos.size, 1, `visi batch'ai privalo gauti tą pačią ribą, gauta: ${[...ribos]}`);
  assert.ok(!Number.isNaN(Date.parse(kvietimai[0].cutoffIso)), "riba perduodama kaip data");
});

test("BATCH'AI: ciklas kartoja, kol saugykla grąžina mažiau nei limitas", async () => {
  const { kvietimai, saugykla } = stebimaSaugykla([RETENCIJOS_BATCH, RETENCIJOS_BATCH, 3]);

  const pasalinta = await suSaugykla(saugykla, () => auditLog.purgeExpired(Date.now()));

  assert.equal(kvietimai.length, 3, "pilnas batch'as reiškia, kad gali būti daugiau");
  assert.equal(pasalinta, RETENCIJOS_BATCH * 2 + 3, "grąžinama pašalintų suma");

  /** ⚠️ Nepilnas batch'as baigia ciklą - kitaip sweep'as suktųsi amžinai. */
  const { kvietimai: vienas, saugykla: maza } = stebimaSaugykla([1]);
  await suSaugykla(maza, () => auditLog.purgeExpired(Date.now()));
  assert.equal(vienas.length, 1, "nepilnas pirmas batch'as - antro kvietimo nėra");
});

test("BATCH DYDIS: vienas autoritetingas šaltinis, ne pakartotas skaičius", async () => {
  /**
   * ⚠️ TESTAS NAUDOJA KONSTANTĄ, O NE KARTOJA JOS REIKŠMĘ.
   *
   * Ranka įrašytas dydis kode ir teste yra ta pati rankomis palaikomo sąrašo
   * klasė, kurią 7.4f pašalino kitur: pakeitus vieną, testas liktų žalias su
   * senuoju.
   */
  const { kvietimai, saugykla } = stebimaSaugykla([0]);

  await suSaugykla(saugykla, () => auditLog.purgeExpired(Date.now()));

  assert.equal(kvietimai[0].limit, RETENCIJOS_BATCH, "sweep'as naudoja autoritetingą dydį");
  assert.ok(Number.isInteger(RETENCIJOS_BATCH) && RETENCIJOS_BATCH > 0, "dydis - teigiamas sveikasis");
});

test("SWEEPER: `purgeExpired` grąžina BAIGTINĮ SVEIKĄJĮ skaičių, ne `Promise`", async () => {
  /**
   * ⚠️ TAI NE TIPO SMULKMENA (#213 DoD).
   *
   * `retentionSweeper` rašo `RETENTION_PURGE` audito įrašą su `audit=<skaičius>`.
   * Be `await` ten atsidurtų `[object Promise]`: įrašas, kuris turi ĮRODYTI
   * asmens duomenų pašalinimą, meluotų, o klaida taptų neapdorotu rejection.
   */
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  const summary = await runRetentionSweep({ now: Date.now() });

  assert.ok(Number.isInteger(summary.auditEntries), `gauta: ${String(summary.auditEntries)}`);
  assert.ok(Number.isFinite(summary.auditEntries));

  /** Ir tiesioginis kvietimas atminties režimu - ta pati garantija. */
  const tiesiogiai = await auditLog.purgeExpired(Date.now());
  assert.ok(Number.isInteger(tiesiogiai), `gauta: ${String(tiesiogiai)}`);
});

test("PERSIDENGIMAS: scheduler'io tick'as nepradeda antro sweep'o, kol vyksta pirmas", async () => {
  /**
   * ⚠️ ELGSENOS ĮRODYMAS, NE VĖLIAVOS EGZISTAVIMAS (#213 DoD).
   *
   * `isSweeping` kintamojo buvimas nieko neįrodo - jis gali būti nustatomas ne
   * ten arba nevalomas. Matuojamas LYGIAGRETUMAS: kiek sweep'ų vienu metu yra
   * viduje. Didesnis nei 1 reiškia, kad du ciklai konkuruoja dėl tų pačių
   * eilučių.
   *
   * ⚠️ `auditLog` importuojamas kaip objektas, tad savybės pakeitimas veikia
   * (AGENTS.md §9.1 destrukturizavimo spąstai netaikomi).
   */
  const { startRetentionSweeper } = require("../utils/retentionSweeper");

  const originalus = auditLog.purgeExpired;
  let dabar = 0;
  let daugiausiai = 0;

  auditLog.purgeExpired = async () => {
    dabar += 1;
    daugiausiai = Math.max(daugiausiai, dabar);
    await new Promise((r) => setTimeout(r, 120));
    dabar -= 1;
    return 0;
  };

  let timer = null;
  try {
    timer = startRetentionSweeper({ intervalMs: 20, runImmediately: false });
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    if (timer) clearInterval(timer);
    auditLog.purgeExpired = originalus;
  }

  assert.ok(daugiausiai >= 1, "prielaida: sweep'as apskritai vyko");
  assert.equal(daugiausiai, 1, `vienu metu vyko ${daugiausiai} sweep'ai - ciklai persidengė`);
});

test("PRIVACY_MODE: GAMYBINIAME režime postgres backend'as NEBEKRENTA", async () => {
  /**
   * ⚠️ VEIKIANTI KLAIDA, RASTA #213 PERŽIŪROJE - NE BŪSIMA SPRAGA.
   *
   * `record()`, `getAll()` ir `query()` su `PRIVACY_MODE=true` kviesdavo
   * `purgeForPrivacyMode()` → `clear()`, o `postgresStore.clear()` meta klaidą,
   * kai `NODE_ENV !== "test"`. Produkcijoje su PostgreSQL procesas krisdavo per
   * PIRMĄ audito rašymą, skaitymą ar užklausą.
   *
   * ⚠️ TESTAS SUKASI SU `NODE_ENV=production`. Su `NODE_ENV=test`
   * `postgresStore.clear()` nemeta, tad defekto pamatyti NEĮMANOMA - būtent
   * todėl jis ir išgyveno.
   */
  const savedEnv = process.env.NODE_ENV;
  const savedPrivacy = process.env.PRIVACY_MODE;

  const originalusCurrent = auditStore.current;
  const originalusBackend = auditStore.backend;

  let clearKviestas = 0;

  /** Saugykla, elgiasi kaip `postgresStore` produkcijoje: `clear()` meta. */
  const persistentine = {
    backend: "postgres",
    async clear() {
      clearKviestas += 1;
      throw new Error("auditStore.clear() persistentiniame režime leidžiamas TIK testuose");
    },
    async append() {
      throw new Error("PRIVACY_MODE metu rašyti negalima");
    },
    async list() {
      return { entries: [], total: 0 };
    },
    async queryPage() {
      return { entries: [], nextCursor: null };
    },
    async usedGenerations() {
      return [];
    },
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.PRIVACY_MODE = "true";
    auditStore.current = () => persistentine;
    auditStore.backend = () => "postgres";

    /** Visi trys keliai - tie patys, kurie krisdavo. */
    assert.equal(await auditLog.record({ event: "LOGIN_SUCCESS", success: true }), null);
    assert.deepEqual(await auditLog.getAll(), []);
    assert.deepEqual(await auditLog.query({ limit: 10 }), { entries: [], nextCursor: null });

    assert.equal(clearKviestas, 0, "persistentiniame režime `clear()` neturi būti kviečiamas");
  } finally {
    auditStore.current = originalusCurrent;
    auditStore.backend = originalusBackend;
    process.env.NODE_ENV = savedEnv;
    if (savedPrivacy === undefined) delete process.env.PRIVACY_MODE;
    else process.env.PRIVACY_MODE = savedPrivacy;
  }
});

test("PRIVACY_MODE: ATMINTIES režime valymas išlieka - kontraktas nepakeistas", async () => {
  /**
   * Pataisa liečia TIK persistentinį kelią. Atmintyje `PRIVACY_MODE` toliau
   * žada ištrynimą, ne nutildymą, ir tai turi likti įrodyta - kitaip „saugus
   * no-op" tyliai išplistų ten, kur valymas realiai reikalingas.
   */
  const savedPrivacy = process.env.PRIVACY_MODE;

  try {
    delete process.env.PRIVACY_MODE;
    await auditLog.record({ event: "LOGIN_SUCCESS", success: true });
    assert.equal((await auditLog.getAll()).length, 1, "prielaida: įrašas sukurtas");

    process.env.PRIVACY_MODE = "true";
    assert.deepEqual(await auditLog.getAll(), [], "atmintis privalo būti išvalyta");

    delete process.env.PRIVACY_MODE;
    assert.deepEqual(await auditLog.getAll(), [], "ištrinti įrašai negrįžta išjungus vėliavą");
  } finally {
    if (savedPrivacy === undefined) delete process.env.PRIVACY_MODE;
    else process.env.PRIVACY_MODE = savedPrivacy;
  }
});

test("`AUDIT_MAX_ENTRIES`: atminties semantika NEREGRESUOJA", async () => {
  /**
   * 7.4d keičia persistentinį kelią; atminties riba yra 7.4a elgesys ir privalo
   * likti tokia pat. Testas rašo daugiau nei riba ir tikrina, kad seniausi
   * išstumiami.
   */
  const saved = process.env.AUDIT_MAX_ENTRIES;

  try {
    process.env.AUDIT_MAX_ENTRIES = "3";
    auditLog.clear();

    for (let i = 0; i < 5; i += 1) {
      await auditLog.record({ event: "LOGIN_SUCCESS", jobId: `job-${i}`, success: true });
    }

    const irasai = await auditLog.getAll();
    assert.equal(irasai.length, 3, "atmintyje lieka tik paskutiniai N");
  } finally {
    if (saved === undefined) delete process.env.AUDIT_MAX_ENTRIES;
    else process.env.AUDIT_MAX_ENTRIES = saved;
    auditLog.clear();
  }
});

test("SAUGYKLOS RIBA: `< cutoff` šalinama, `== cutoff` ir `> cutoff` lieka", async () => {
  /**
   * ⚠️ TA PATI RIBA ABIEJUOSE BACKEND'UOSE. Čia tikrinama atminties realizacija;
   * RAW PostgreSQL riba - integraciniame teste. Skirtinga riba reikštų, kad tas
   * pats įrašas išgyvena viename backend'e ir dingsta kitame.
   */
  const memoryStore = require("../utils/auditStore/memoryStore");

  await memoryStore.clear();

  const cutoff = "2026-06-01T00:00:00.000Z";
  const bazine = { event: "LOGIN_SUCCESS", result: "success" };

  await memoryStore.append({ ...bazine, id: "pries", timestamp: "2026-05-31T23:59:59.999Z" });
  await memoryStore.append({ ...bazine, id: "lygiai", timestamp: cutoff });
  await memoryStore.append({ ...bazine, id: "po", timestamp: "2026-06-01T00:00:00.001Z" });

  const pasalinta = await memoryStore.purgeExpired(cutoff);

  assert.equal(pasalinta, 1, "tik `< cutoff` eilutė");

  const liko = (await memoryStore.list()).entries.map((e) => e.id).sort();
  assert.deepEqual(liko, ["lygiai", "po"], "`== cutoff` PRIVALO likti");

  await memoryStore.clear();
});

test("SAUGYKLOS RIBA: `limit` riboja VIENĄ kvietimą, ne visą aibę", async () => {
  const memoryStore = require("../utils/auditStore/memoryStore");

  await memoryStore.clear();

  for (let i = 0; i < 5; i += 1) {
    await memoryStore.append({
      id: `senas-${i}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "LOGIN_SUCCESS",
      result: "success",
    });
  }

  assert.equal(await memoryStore.purgeExpired("2026-06-01T00:00:00.000Z", 2), 2);
  assert.equal(await memoryStore.purgeExpired("2026-06-01T00:00:00.000Z", 2), 2);
  assert.equal(await memoryStore.purgeExpired("2026-06-01T00:00:00.000Z", 2), 1, "likutis");
  assert.equal(await memoryStore.purgeExpired("2026-06-01T00:00:00.000Z", 2), 0, "aibė išsemta");

  await memoryStore.clear();
});
