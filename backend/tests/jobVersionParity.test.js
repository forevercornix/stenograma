const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const { createRedisStore } = require("../utils/jobStore/redisStore");
const { FakeRedis } = require("./helpers/fakeRedis");
const { newJob, applyPatch, normalizeJob, JOB_TYPES, OWNER_KIND } = require("../utils/jobStore/common");
const { jobToRow, rowToJob } = require("../utils/jobStore/postgresStore");

const jobStore = require("../utils/jobStore");
const { PHASE } = require("../utils/jobPhase");

/**
 * OPTIMISTIC LOCK VERSIJOS PARITETAS (#184, 7.5b — commit A).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Įrodo: `version` yra BENDRO job kontrakto dalis (ne PostgreSQL detalė), jos
 * pradinė reikšmė vienoda visuose trijuose backend'uose, ir kiekviena sėkminga
 * mutacija ją didina LYGIAI vienetu.
 *
 * NEĮRODO: kad pasenusi `version` sukelia konfliktą — CAS sąlyga įvedama
 * commit'e B. Šis failas yra jo prielaida, ne pakaitalas.
 *
 * ⚠️ PostgreSQL čia dengiamas TIK per `jobToRow()`/`rowToJob()` — grynas
 * žemėlapių lygmuo, be DB. Tikras round-trip yra `postgres` rinkinyje ir
 * vietinėje aplinkoje NEVYKDOMAS (žr. `postgresGuard`).
 */

function NAUJAS_REDIS() {
  return createRedisStore(new FakeRedis());
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. PRADINĖ REIKŠMĖ — VIENA VISIEMS TRIMS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 naujas job'as gauna `version = 1` visuose trijuose backend'uose", async () => {
  const mem = await memoryStore.create({});
  assert.equal(mem.version, 1, "memory");

  const redis = await NAUJAS_REDIS().create({});
  assert.equal(redis.version, 1, "redis (grąžinimas iš rašymo kelio)");

  /**
   * ⚠️ PostgreSQL kelias tikrinamas per žemėlapius, nes DB čia nėra. `jobToRow()`
   * yra vienintelė vieta, kur job objektas virsta `INSERT` parametrais — jei
   * `version` iš jos iškristų, stulpelis gautų `DEFAULT`, ir sutapimas būtų
   * atsitiktinis, ne garantuotas.
   */
  assert.equal(jobToRow(newJob({})).version, 1, "postgres (jobToRow)");
});

test("#184 Redis `get()` grąžina SKAIČIŲ, ne tekstą", async () => {
  /**
   * ⚠️ ŠITAS TESTAS YRA PRIEŽASTIS, KODĖL `version` YRA `NUMBER_FIELDS` AIBĖJE.
   *
   * Redis hash reikšmės yra tekstas. Be normalizavimo `redisStore` grąžintų
   * `"1"`, o memory — `1`, ir bendro kontrakto rinkinio `deepEqual` lūžtų. Tai
   * ne kosmetika: alternatyva būtų išimti lauką iš palyginimų, t. y. tyliai
   * susiaurinti rinkinį — būtent tai, ką #184 draudžia.
   */
  const redis = NAUJAS_REDIS();
  const sukurtas = await redis.create({});
  const skaitytas = await redis.get(sukurtas.id);

  assert.equal(typeof skaitytas.version, "number");
  assert.equal(skaitytas.version, 1);
});

test("#184 atkurtas SENAS įrašas be `version` gauna `1` visuose trijuose", async () => {
  /**
   * Kopijos įrašas iš prieš 7.5b lauko neturi. `postgresStore.rowToJob()` jam
   * duoda `?? 1` (stulpelis `NOT NULL DEFAULT 1`); memory ir Redis be
   * materializavimo grąžintų įrašą BE lauko, ir formos išsiskirtų.
   */
  const senas = newJob({});
  delete senas.version;

  const mem = await memoryStore.restoreRecord({ ...senas, id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(mem.version, 1, "memory");

  const redis = await NAUJAS_REDIS().restoreRecord({ ...senas, id: "22222222-2222-4222-8222-222222222222" });
  assert.equal(redis.version, 1, "redis");

  assert.equal(rowToJob({ id: "x", artefacts: [] }).version, 1, "postgres (rowToJob be stulpelio)");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. INCREMENT'AS — LYGIAI VIENETU
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 kiekviena sėkminga mutacija didina `version` LYGIAI vienetu", async () => {
  /**
   * ⚠️ LYGINAMOS REIKŠMĖS, NE „PADIDĖJO". `assert.ok(po > pries)` praleistų ir
   * `+2`, ir `+7` — o būtent dviejų increment'ų klaida yra ta, kurios #184
   * bijo. Todėl kiekvienas žingsnis tikrinamas tikslia reikšme.
   */
  const mem = await memoryStore.create({});
  assert.equal(mem.version, 1);

  const po1 = await memoryStore.update(mem.id, { actor: "a" });
  assert.equal(po1.version, 2);

  const po2 = await memoryStore.update(mem.id, { actor: "b" });
  assert.equal(po2.version, 3);

  const po3 = await memoryStore.update(mem.id, { actor: "b" });
  assert.equal(po3.version, 4, "TOKS PAT patch'as vis tiek yra mutacija");

  const perskaitytas = await memoryStore.get(mem.id);
  assert.equal(perskaitytas.version, 4, "grąžinta reikšmė sutampa su persistentine");
});

test("#184-B ⚠️ Redis versiją didina SERVERIS, ne JS snapshot'as", async () => {
  /**
   * ⚠️ ŠIS TESTAS BUVO PERRAŠYTAS, NES FIKSAVO KLAIDĄ (Codex B6).
   *
   * Ankstesnė redakcija reikalavo, kad `version` būtų rašomas TAME PAČIAME
   * `hset` kaip ir patch'as — t. y. kaip `applyPatch()` apskaičiuota SNAPSHOT'O
   * reikšmė. Būtent tai ir buvo defektas: du lygiagretūs kvietėjai perskaito
   * `N`, abu apskaičiuoja `N + 1`, abu įrašo — įvyko dvi mutacijos, o versija
   * paaugo vieną kartą. Po to pasenęs snapshot'as CAS'ą praeitų.
   *
   * Naujas kontraktas: reikšmę skaičiuoja SERVERIS (`HINCRBY`), o `hset` jos
   * nebeliečia. Tas pats sprendimas kaip PostgreSQL `VERSIJOS_ZYMA`.
   */
  const fake = new FakeRedis();
  const redis = createRedisStore(fake);
  const sukurtas = await redis.create({});

  const rasymai = [];
  const incr = [];
  const originalusHset = fake.hset.bind(fake);
  const originalusIncr = fake.hincrby.bind(fake);
  fake.hset = async (key, obj) => {
    rasymai.push(Object.keys(obj));
    return originalusHset(key, obj);
  };
  fake.hincrby = async (key, field, delta) => {
    incr.push([field, delta]);
    return originalusIncr(key, field, delta);
  };

  const po = await redis.update(sukurtas.id, { actor: "a" });

  assert.equal(po.version, 2, "grąžinama SERVERIO apskaičiuota reikšmė");
  assert.ok(rasymai.length >= 1, "patch'as įrašytas");
  assert.equal(
    rasymai.some((laukai) => laukai.includes("version")),
    false,
    "⚠️ `version` NEGALI būti tarp rašomų laukų - tai būtų snapshot'o reikšmė"
  );
  assert.deepEqual(incr, [["version", 1]], "versiją didina atominis serverio skaitiklis");

  /** Persistentinė reikšmė sutampa su grąžinta. */
  const skaitytas = await redis.get(sukurtas.id);
  assert.equal(skaitytas.version, 2);
});

test("#184-B ⚠️ besąlyginis Redis rašymas eina VIENA transakcija", async () => {
  /**
   * ⚠️ DVI ATSKIROS KOMANDOS NEUŽTENKA (Codex F1).
   *
   * Jei `HSET` pavyksta, o `HINCRBY` krenta (nutrūkęs ryšys tarp `await`), lieka
   * NAUJI LAUKAI SU SENA VERSIJA. Tą versiją turintis klientas tada praeina CAS
   * ir perrašo neužfiksuotą pakeitimą — lūžta būtent ta invarianta, kurią B6
   * atkuria.
   *
   * Pirmoji šio PR redakcija tą riziką tik APRAŠĖ komentare. Aprašyta skylė
   * lieka skylė.
   *
   * ⚠️ ŠIS TESTAS NEĮRODO REDIS ATOMIŠKUMO — vienoje gijoje jis trivialus.
   * Įrodo tik tai, kad kodas komandas SIUNČIA viena transakcija, o ne dviem
   * nepriklausomais `await`. Tikrą elgesį tikrina `redis` rinkinys.
   */
  const fake = new FakeRedis();
  const redis = createRedisStore(fake);
  const job = await redis.create({});

  let multiKvietimu = 0;
  let komanduTransakcijoje = 0;
  const originalusMulti = fake.multi.bind(fake);
  fake.multi = () => {
    multiKvietimu += 1;
    const m = originalusMulti();
    const originalusExec = m.exec;
    m.exec = async () => {
      komanduTransakcijoje = m._commandCount();
      return originalusExec();
    };
    return m;
  };

  const po = await redis.update(job.id, { actor: "a" });

  assert.equal(multiKvietimu, 1, "rašymas privalo eiti per MULTI");
  assert.equal(komanduTransakcijoje, 2, "laukų rašymas IR versijos didinimas - vienoje transakcijoje");
  assert.equal(po.version, 2, "grąžinama transakcijos apskaičiuota reikšmė");
});

test("#184-B ⚠️ DU KVIETĖJAI NUO TO PATIES SNAPSHOT'O duoda +2, ne +1", async () => {
  /**
   * ⚠️ ŠIS TESTAS BUVO PERRAŠYTAS, NES NIEKO NEĮRODĖ (Codex F4).
   *
   * Pirmoji redakcija tiesiog kvietė `update()` du kartus iš eilės ir tikrino,
   * kad versijos yra 2 ir 3. Bet antrasis kvietimas skaito PIRMOJO įrašytą
   * reikšmę, tad **iki pataisos buvusi snapshot'o realizacija būtų davusi
   * lygiai tą patį** — testas būtų žalias ir su defektu. Regresijos apsaugos
   * nulis.
   *
   * Prarandamo padidinimo klasė reikalauja, kad ABU kvietėjai pradėtų nuo TOS
   * PAČIOS `N`. Tai įvedama deterministiškai: `hgetall` abiem kvietimams grąžina
   * TĄ PATĮ pradinį snapshot'ą, tad `applyPatch()` abu kartus apskaičiuoja
   * `N + 1`.
   *
   * Su snapshot'o realizacija (`hset` su versija) abu rašytų `2` → galutinė `2`.
   * Su serverio skaitikliu (`HINCRBY`) — `2` ir `3` → galutinė `3`.
   */
  const fake = new FakeRedis();
  const redis = createRedisStore(fake);
  const job = await redis.create({});
  assert.equal(job.version, 1);

  const pradinis = { ...(await fake.hgetall(`job:${job.id}`)) };
  const originalus = fake.hgetall.bind(fake);
  let uzsaldyta = 0;

  fake.hgetall = async (key) => {
    if (key === `job:${job.id}` && uzsaldyta < 2) {
      uzsaldyta += 1;
      /** ⚠️ ABU kvietėjai mato TĄ PAČIĄ `version = 1`. */
      return { ...pradinis };
    }
    return originalus(key);
  };

  try {
    await redis.update(job.id, { actor: "a" });
    await redis.update(job.id, { actor: "b" });
  } finally {
    fake.hgetall = originalus;
  }

  assert.equal(uzsaldyta, 2, "prielaida: abu kvietimai tikrai matė tą patį snapshot'ą");

  const galutinis = await redis.get(job.id);
  assert.equal(
    galutinis.version,
    3,
    "⚠️ DVI mutacijos = DU padidinimai. Snapshot'o realizacija čia duotų 2 - prarastas padidinimas"
  );
});

test("#184 `applyPatch()` yra VIENINTELIS increment'o šaltinis", async () => {
  /**
   * ⚠️ MUTACIJOS TAIKINYS. Pašalinus `next.version = (job.version ?? 0) + 1`
   * eilutę iš `common.js`, šis testas privalo kristi — kartu su visais aukščiau.
   * Jei nekris, increment'as gyvena kur nors dar, ir trys backend'ai turi tris
   * skaičiavimus.
   */
  const job = newJob({});
  assert.equal(job.version, 1);
  assert.equal(applyPatch(job, {}).version, 2);
  assert.equal(applyPatch(applyPatch(job, {}), {}).version, 3);

  /** Nuosavybė, tapatybė ir era nesikeičia — versija keičiasi. Ta pati apsaugų šeima. */
  const su = applyPatch(job, { id: "kitas", ownerId: "svetimas", version: 42 });
  assert.equal(su.id, job.id);
  assert.equal(su.ownerId, job.ownerId);
  assert.equal(su.version, 2);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. `startPhase` / `finish` — VIENAS INCREMENT'AS, NE DU
 * ══════════════════════════════════════════════════════════════════════════ */

async function naujasPerFasada() {
  return jobStore.create({
    type: JOB_TYPES.TRANSCRIPTION,
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
  });
}

test("#184 `startPhase()` (`get` + `update` pora) duoda VIENĄ increment'ą", async () => {
  /**
   * ⚠️ LENGVIAUSIA NETYČIA SULAUŽYTI VIETA (#184 DoD).
   *
   * Fasadas yra `store.get()` → `jobPhase.startPhase()` → `store.update()`.
   * Naivi realizacija, kuri versiją didintų ir fasade, ir saugykloje, duotų
   * `+2` — ir niekas to nepastebėtų, nes reikšmė vis tiek „padidėja".
   */
  const job = await naujasPerFasada();
  assert.equal(job.version, 1);

  const po = await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  assert.equal(po.version, 2, "viena loginė operacija = +1, ne +2");

  const po2 = await jobStore.system.startPhase(po.id, PHASE.TRANSCRIBING);
  assert.equal(po2.version, 3);
});

test("#184 `finish()` (`get` + `update` pora) duoda VIENĄ increment'ą", async () => {
  const job = await naujasPerFasada();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);

  const pries = await jobStore.system.get(job.id);
  const po = await jobStore.system.finish(job.id, jobStore.STATUS.FAILED, { error: "x" });

  assert.equal(po.version, pries.version + 1, "tiksliai +1");
  assert.equal(po.status, jobStore.STATUS.FAILED);
});

test("#184 PRIIMTAS progreso įvykis duoda vieną increment'ą", async () => {
  /**
   * Progreso kelias saugykloje yra ATSKIRAS (`reportProgressAtomic`), tad
   * increment'o jis galėtų nepasiekti — arba pasiekti du kartus. Tikrinama
   * atskirai būtent todėl.
   */
  const job = await naujasPerFasada();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, { progress: { current: 0, total: 10 } });
  const pries = await jobStore.system.get(job.id);

  const po = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 5, total: 10 },
  });

  assert.equal(po.progress.current, 5, "įvykis TIKRAI priimtas, ne atmestas");
  assert.equal(po.version, pries.version + 1, "tiksliai +1");
});

test("#184 ATMESTAS progreso įvykis versijos NEKEIČIA", async () => {
  /**
   * ⚠️ TAI NE SMULKMENA, O KONTRAKTO PUNKTAS: „mutacija, kuri nieko neatnaujino,
   * `version` nekeičia". Atmetimas (pavėlavęs įvykis, ne ta fazė, regresija)
   * nutinka reguliariai — BullMQ retry ir replay tai daro savaime. Jei jis
   * versiją didintų, konkurentas prarastų CAS be jokios realios mutacijos, ir
   * `expectedVersion` taptų triukšmu.
   *
   * ⚠️ Šis testas RADO faktą, o ne patvirtino spėjimą: pirma redakcija laukė
   * `+1` po atmesto įvykio ir krito. Elgesys teisingas — testas buvo klaidingas.
   */
  const job = await naujasPerFasada();
  await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
  await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, { progress: { current: 5, total: 10 } });
  const pries = await jobStore.system.get(job.id);

  /** REGRESIJA: 2 < 5 — `jobPhase` tokį įvykį atmeta. */
  const po = await jobStore.system.reportProgress(job.id, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 2, total: 10 },
  });

  assert.equal(po.progress.current, 5, "įrašas nepakeistas");
  assert.equal(po.version, pries.version, "atmetimas NĖRA mutacija");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. ŽEMĖLAPIŲ PILNUMAS (PostgreSQL, be DB)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 `version` išgyvena `jobToRow` → `rowToJob` round-trip", () => {
  /**
   * ⚠️ STATINĖ PATIKRA ČIA NEPAKANKA (AGENTS.md §9.2). `COLUMNS` sąraše esantis
   * vardas neįrodo, kad reikšmė realiai keliauja abiem kryptimis — pamirštas
   * `rowToJob` įrašas grąžintų `undefined`, ir pirmas `update()` versiją
   * atstatytų į `1`.
   */
  const job = normalizeJob({ ...newJob({}), version: 5 });
  const row = jobToRow(job);
  assert.equal(row.version, 5);

  const atgal = rowToJob({ ...row, artefacts: [], progress_known: false });
  assert.equal(atgal.version, 5);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. VERSIJOS KONTRAKTO PARITETAS (Codex B grupė)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184-B ⚠️ netinkama ATKURTA versija atmetama GARSIAI, ne tyliai taisoma", () => {
  /**
   * ⚠️ BENDRA SKAITINIŲ LAUKŲ TAISYKLĖ ČIA BŪTŲ PAVOJINGA (Codex B9).
   *
   * `parseInt(x, 10) || 0` priimtų `0`, neigiamą ir `"1x"` (→ `1`). PostgreSQL
   * tokias reikšmes atmeta per `jobs_version_positive`, o memory ir Redis jas
   * ATKURTŲ — sugadinti optimistic-lock metaduomenys taptų autoritetingi
   * skirtingai, priklausomai nuo backend'o.
   *
   * ⚠️ TIKRINAMA ŽALIA REIKŠMĖ: `parseInt("1x", 10)` yra `1`, tad po
   * normalizavimo klaida būtų nebematoma. Todėl `"1x"` yra atskiras atvejis
   * sąraše, ne pavyzdys.
   */
  const bazinis = newJob({});

  /**
   * ⚠️ VIRŠUTINĖ RIBA IRGI PRIVALOMA (Codex F3). `jobs.version` yra PostgreSQL
   * `integer`, tad `"2147483648"` PG atmestų, o memory/Redis atkurtų — tas pats
   * backup'as elgtųsi skirtingai priklausomai nuo backend'o.
   */
  for (const bloga of [0, -1, 1.5, "1x", "abc", "", true, {}, 2147483648, "2147483648", 1e20]) {
    assert.throws(
      () => normalizeJob({ ...bazinis, version: bloga }),
      /Netinkama optimistic-lock versija/,
      `${JSON.stringify(bloga)} privalo būti atmesta`
    );
  }

  /** Galiojančios formos - įskaitant Redis tekstinę. */
  assert.equal(normalizeJob({ ...bazinis, version: 1 }).version, 1);
  assert.equal(normalizeJob({ ...bazinis, version: 7 }).version, 7);
  assert.equal(normalizeJob({ ...bazinis, version: "7" }).version, 7, "Redis saugo tekstą");
  assert.equal(
    normalizeJob({ ...bazinis, version: 2147483647 }).version,
    2147483647,
    "PostgreSQL `integer` lubos - dar galioja"
  );

  /**
   * ⚠️ TRŪKSTAMAS laukas NĖRA klaida - legacy įrašas iš prieš 7.5b jo neturi.
   * Numatytoji `1` galioja TIK šiam atvejui.
   */
  const legacy = { ...bazinis };
  delete legacy.version;
  assert.equal(normalizeJob(legacy).version, 1, "legacy įrašas gauna numatytąją");
  assert.equal(normalizeJob({ ...bazinis, version: null }).version, 1);
});
