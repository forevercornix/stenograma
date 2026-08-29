const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const auditLog = require("../utils/auditLog");
const auditStore = require("../utils/auditStore");
const { RETENCIJOS_BATCH, VALANDOS_PARAI } = require("../utils/auditStore/postgresStore");

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

/**
 * SAUGYKLOS LAIKRODŽIO SENTINEL.
 *
 * ⚠️ SĄMONINGAI TOLI NUO `Date.now()`. Riba, apskaičiuota Node procese, niekada
 * nebus lygi šiai reikšmei - todėl testas mato SKIRTUMĄ tarp „riba iš saugyklos"
 * ir „riba iš proceso laikrodžio", o ne tik tai, kad kažkokia riba perduota.
 */
const SAUGYKLOS_RIBA = "2000-01-01T00:00:00.000Z";

/** Saugykla, kuri fiksuoja, KOKIUS argumentus gavo kiekvienas batch'as. */
function stebimaSaugykla(atsakymai) {
  const kvietimai = [];
  const ribosKvietimai = [];

  return {
    kvietimai,
    ribosKvietimai,
    saugykla: {
      backend: "postgres",
      async retencijosRiba(dienos, now) {
        ribosKvietimai.push({ dienos, now });
        return SAUGYKLOS_RIBA;
      },
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

test("RIBA: ateina IŠ SAUGYKLOS laikrodžio, apskaičiuojama VIENĄ kartą", async () => {
  /**
   * ⚠️ DVI ATSKIROS GARANTIJOS VIENAME TESTE, IR ABI BŪTINOS.
   *
   * **Kartą per sweep'ą.** Perskaičiuojant ribą kiekvienam batch'ui, ilgo
   * sweep'o metu naikinama aibė slenka: pirmas batch'as dirbtų su viena riba,
   * paskutinis su vėlesne, ir rezultatas priklausytų nuo trukmės.
   *
   * **Iš saugyklos, ne iš šio proceso** (#233 Codex, P1). Persistentiniame
   * režime `timestamp` rašo DB `now()`, nes replikų laikrodžiai skiriasi.
   * Skaičiuojant ribą Node procese, skubantis laikrodis NEGRĮŽTAMAI ištrintų
   * eilutes, kurioms terminas dar nesuėjo. Sentinel reikšmė parinkta taip, kad
   * Node apskaičiuota riba niekada su ja nesutaptų - tad testas skiria
   * „paklausė saugyklos" nuo „pats paskaičiavo".
   */
  const { kvietimai, ribosKvietimai, saugykla } = stebimaSaugykla([
    RETENCIJOS_BATCH,
    RETENCIJOS_BATCH,
    7,
  ]);

  await suSaugykla(saugykla, () => auditLog.purgeExpired(Date.now()));

  assert.equal(kvietimai.length, 3, "prielaida: ciklas kartojosi");
  assert.equal(ribosKvietimai.length, 1, "ribos privalo būti klausiama VIENĄ kartą per sweep'ą");

  const ribos = new Set(kvietimai.map((k) => k.cutoffIso));
  assert.deepEqual(
    [...ribos],
    [SAUGYKLOS_RIBA],
    "visi batch'ai privalo gauti TĄ PAČIĄ saugyklos duotą ribą, ne proceso laikrodžio"
  );

  /** Ir terminas perduodamas, kad saugykla galėtų jį pritaikyti savo laikrodžiui. */
  assert.ok(Number.isFinite(Number(ribosKvietimai[0].dienos)), "perduodamas retencijos terminas");
});

test("RIBA: postgres saugykla ją skaičiuoja SQL `now()`, ne Node laikrodžiu", async () => {
  /**
   * ⚠️ ĮRODYMAS SAUGYKLOS LYGYJE. Ankstesnis testas rodo, kad `auditLog` ribos
   * KLAUSIA; šis - kad postgres realizacija atsako DB laikrodžiu, o ne
   * persiskaičiuoja Node pusėje.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");

  const uzklausos = [];
  const DB_ATSAKYMAS = new Date("2001-02-03T04:05:06.000Z");

  const pool = {
    query: async (sql, params) => {
      uzklausos.push({ sql: String(sql), params });
      return { rows: [{ riba: DB_ATSAKYMAS }] };
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A" });
  const riba = await store.retencijosRiba(30);

  assert.equal(riba, DB_ATSAKYMAS.toISOString(), "grąžinama BŪTENT DB duota reikšmė");
  assert.match(uzklausos[0].sql, /now\(\)/i, "riba skaičiuojama SQL `now()`");
  assert.deepEqual(
    uzklausos[0].params,
    [30 * VALANDOS_PARAI],
    "terminas perduodamas parametru, ne interpoliuojamas (valandomis - žr. DST testą)"
  );

  /** Netinkamas terminas atmetamas dar prieš SQL - kitaip trintume pagal šiukšlę. */
  for (const blogas of [0, -1, "trisdešimt", null]) {
    await assert.rejects(() => store.retencijosRiba(blogas), /teigiamas/i);
  }
});

test("RIBA: DST - langas matuojamas FIKSUOTOMIS valandomis, ne kalendorinėmis dienomis", async () => {
  /**
   * ⚠️ TRIPWIRE PLIUS PARITETO PATIKRA (AGENTS.md §9.2), NE PG ELGSENOS ĮRODYMAS.
   *
   * Pati aritmetika vyksta PostgreSQL viduje, tad be DB jos įvykdyti neįmanoma;
   * elgsenos įrodymas yra `auditPersistence.integration` DST scenarijus ir jis
   * pažymėtas [PG NOT RUN]. Čia ginama SQL FORMA ir PRAŠOMAS VIENETAS - būtent
   * jie ir buvo radinys.
   *
   * `interval 'N days'` `timestamptz` aritmetikoje yra KALENDORINIS: DST zonoje
   * jis išlaiko tą pačią vietinio laikrodžio valandą, tad perstatymą kertantis
   * langas duoda 23 arba 25 valandas per dieną. Atmintis skaičiuoja tikslų
   * `dienos * 24 h`. Skirtumas - viena valanda, du kartus per metus, ir jo
   * kaina yra NEGRĮŽTAMAS trynimas anksčiau laiko.
   */
  const { createPostgresStore } = require("../utils/auditStore/postgresStore");
  const memoryStore = require("../utils/auditStore/memoryStore");

  const uzklausos = [];
  const pool = {
    query: async (sql, params) => {
      uzklausos.push({ sql: String(sql), params });
      return { rows: [{ riba: new Date("2000-01-01T00:00:00.000Z") }] };
    },
  };
  const store = createPostgresStore(pool, { hashKeyId: "A" });

  await store.retencijosRiba(30);
  const sql = uzklausos[0].sql;

  /**
   * ⚠️ SKENUOJAMA VISA UŽKLAUSA, ne langas aplink `now()` - fiksuoto pločio
   * langai lūžta, kai tekstas paauga (AGENTS.md §9.1). Užklausa yra vienaeilė,
   * be komentarų, tad savo dokumentacijos ši patikra pagauti negali.
   */
  assert.doesNotMatch(
    sql,
    /\bday|\bmonth|\byear|\bweek/i,
    `kalendoriniai interval laukai DST zonoje nėra 24 h: ${sql}`
  );
  assert.match(sql, /INTERVAL\s+'1 hour'/i, `riba privalo remtis tikslia trukme: ${sql}`);

  /**
   * Konstanta yra VERTIMO vardas, ne derinamas parametras: parą sudaro 24
   * valandos nepriklausomai nuo politikos. Prisegta, kad importas negalėtų
   * tyliai pasikeisti kartu su kodu.
   */
  assert.equal(VALANDOS_PARAI, 24, "para = 24 valandos");

  /** Praleistas daugiklis reikštų 30 VALANDŲ retenciją vietoj 30 dienų. */
  for (const dienos of [30, 1, 365, 0.5]) {
    uzklausos.length = 0;
    await store.retencijosRiba(dienos);
    assert.equal(
      uzklausos[0].params[0],
      dienos * VALANDOS_PARAI,
      `${dienos} d. privalo virsti ${dienos * VALANDOS_PARAI} val.`
    );
  }

  /**
   * PARITETAS: tas pats terminas → tas pats valandų skaičius abiejuose
   * backend'uose. Atminties riba čia yra ETALONAS, nes ji ir apibrėžia
   * kontraktą, kurį postgres pusė privalo atkartoti.
   */
  const dabar = Date.parse("2026-03-29T12:00:00.000Z");
  const atmintiesRiba = await memoryStore.retencijosRiba(30, dabar);
  const atmintiesValandos = (dabar - Date.parse(atmintiesRiba)) / 3600000;

  uzklausos.length = 0;
  await store.retencijosRiba(30);
  assert.equal(
    uzklausos[0].params[0],
    atmintiesValandos,
    "abu backend'ai privalo prašyti TO PATIES valandų skaičiaus"
  );
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

test("PRIVACY_MODE × postgres: PARINKIMAS derinio NEBEATMETA (7.4b sargo atšaukimas)", () => {
  /**
   * ⚠️ RUNNABLE ĮRODYMAS SARGO ATŠAUKIMUI (#213 Codex, raundas 5, radinys 2).
   *
   * Iki šito matrica šią garantiją siejo su `startupChecks` rinkiniu, kuriame
   * nėra NĖ VIENO `PRIVACY_MODE` testo - t. y. rodė į dengimą, kurio nėra.
   * Purge ir garsus įspėjimas gyvena `init()` postgres šakoje ir be DB
   * nevykdomi ([PG NOT RUN] `auditPersistence.integration`), bet PATS LEIDIMAS
   * gyvena čia, gryname `resolveAuditBackend()`, ir tikrinamas be DB.
   *
   * Grąžinus sargą, nepasiekiamas tampa visas #213 `PRIVACY_MODE` kontraktas:
   * instancija nepakyla, o persistentinių eilučių per vėliavą ištrinti nebėra
   * kaip - fail-fast saugotų ne duomenis, o užrakintų juos.
   */
  const { resolveAuditBackend } = require("../utils/auditStore/backendSelection");

  const bazė = {
    AUDIT_BACKEND: "postgres",
    AUDIT_ID_SALT: "s",
    AUDIT_ID_SALT_ID: "i",
    DATABASE_URL: "postgres://a/b",
  };

  assert.equal(
    resolveAuditBackend({ ...bazė, PRIVACY_MODE: "true" }),
    "postgres",
    "derinys privalo būti LEIDŽIAMAS - kitaip #213 kontraktas nepasiekiamas"
  );

  /** Abi pusės: vien teigiama leistų grąžinti sargą po `PRIVACY_MODE=false`. */
  assert.equal(resolveAuditBackend({ ...bazė, PRIVACY_MODE: "false" }), "postgres");
  assert.equal(resolveAuditBackend({ ...bazė }), "postgres");
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

test("DALINIS REZULTATAS: kritus batch'ui, jau ištrintos eilutės NEDINGSTA iš suvestinės", async () => {
  /**
   * ⚠️ TYLUS IŠTRYNIMAS BE PĖDSAKO (#233 Codex, P2).
   *
   * Batch'ai commit'inasi atskirai. Kritus vėlesniam, priskyrimas sweeper'yje
   * neįvyksta, ir be šios grandinės `auditEntries` liktų nulis. Jei tuo pačiu
   * ciklu nepašalinta nei job'ų, nei audio, ciklas atrodytų tuščias: nei
   * `RETENTION_PURGE` įrašo, nei klaidos - o audito eilutės jau negrįžtamai
   * ištrintos.
   */
  const { runRetentionSweep } = require("../utils/retentionSweeper");

  let kvietimas = 0;
  const saugykla = {
    backend: "postgres",
    /** ⚠️ `append` būtinas: dėl klaidos sweeper'is dabar RAŠO `RETENTION_PURGE`. */
    async append(eilute) {
      return eilute;
    },
    async retencijosRiba() {
      return SAUGYKLOS_RIBA;
    },
    async purgeExpired() {
      kvietimas += 1;
      if (kvietimas <= 2) return RETENCIJOS_BATCH;
      throw new Error("DB nutrūko po dviejų batch'ų");
    },
  };

  /** Tiesioginis kvietimas: klaida keliauja su jau pašalintų skaičiumi. */
  await suSaugykla(saugykla, async () => {
    await assert.rejects(
      () => auditLog.purgeExpired(Date.now()),
      (e) => {
        assert.equal(e.pasalinta, RETENCIJOS_BATCH * 2, "klaida neša jau įvykdytų batch'ų sumą");
        return true;
      }
    );
  });

  /** Ir sweeper'is tą skaičių paviešina, o ne praneša tuščią ciklą. */
  kvietimas = 0;
  const summary = await suSaugykla(saugykla, () => runRetentionSweep({ now: Date.now() }));

  assert.equal(summary.auditEntries, RETENCIJOS_BATCH * 2, "suvestinė rodo realiai pašalintas");
  assert.ok(
    summary.errors.some((e) => e.includes("audit:")),
    "klaida privalo likti matoma, o ne būti nurašyta į tylų nulį"
  );
});

test("STARTO PURGE: batch'inamas, o ne vienas neribotas `DELETE`", async () => {
  /**
   * ⚠️ TIMEOUT'AS PRIEŠ READINESS (#233 Codex, P2).
   *
   * Vienas neribotas `DELETE FROM audit_log` perrašo kiekvieną eilutę ir indekso
   * įrašą viename sakinyje, o pool'ui galioja audito `statement_timeout`. Ant
   * išaugusios lentelės - ypač per pirmą atnaujinimą iš anksčiau neribotos
   * saugyklos - kiekvienas `PRIVACY_MODE` startas baigtųsi timeout'u.
   *
   * ⚠️ `FOR UPDATE` BE `SKIP LOCKED` - skirtumas nuo retencijos. Purge privalo
   * išvalyti VISKĄ prieš readiness; praleista užrakinta eilutė antros progos
   * negautų.
   */
  const { createPostgresStore, RETENCIJOS_BATCH: RIBA } = require("../utils/auditStore/postgresStore");

  const uzklausos = [];
  let liko = RIBA * 2 + 5;

  const pool = {
    query: async (sql, params) => {
      uzklausos.push(String(sql));
      const kiek = Math.min(liko, params ? params[0] : liko);
      liko -= kiek;
      return { rowCount: kiek };
    },
  };

  const store = createPostgresStore(pool, { hashKeyId: "A" });
  const viso = await store.purgeAllForPrivacy();

  assert.equal(viso, RIBA * 2 + 5, "grąžinamas pilnas pašalintų kiekis");
  assert.equal(uzklausos.length, 4, "trys partijos + baigiamasis tuščias kvietimas");

  for (const sql of uzklausos) {
    assert.match(sql, /LIMIT/i, "kiekviena partija ribota");
    assert.match(sql, /FOR UPDATE/i, "kandidatai užrakinami");
    assert.doesNotMatch(sql, /SKIP LOCKED/i, "purge negali praleisti užrakintų eilučių");
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
