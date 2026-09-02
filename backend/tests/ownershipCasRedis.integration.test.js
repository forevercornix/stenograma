const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * #159: NUOSAVYBĖS CAS SU TIKRU REDIS.
 *
 * KODĖL ATSKIRAS INTEGRACINIS TESTAS.
 *
 * `redisStore.update()` yra read-then-write: `get()` → `applyPatch()` → `hset()`.
 * Tarp skaitymo ir rašymo yra langas, per kurį savininkas gali pasikeisti.
 * Objektai atmintyje šito NEATSKLEIDŽIA – ten `updateOwned` vykdomas be `await`
 * tarp patikros ir rašymo, tad lenktynių apskritai nėra.
 *
 * ATOMIŠKUMO RIBA (sąmoninga). Atominė daroma TIK nuosavybės savybė: `HSET`
 * neįvyksta, jei savininkas pasikeitė. Patch'as skaičiuojamas iš galimai
 * pasenusio įrašo – tai esama last-write-wins semantika, kurios #159 nekeičia.
 * Šie testai tikrina BŪTENT nuosavybę, o ne apsimeta, kad visas patch'as tapo CAS.
 *
 * Praleidžiamas be `REDIS_URL`.
 */

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : "reikia REDIS_URL (tikro Redis)";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const A = "11111111-1111-4111-8111-111111111111";
const K = require("../utils/jobStore/common").OWNER_KIND;

/** Vartotojo scope – `ownerKind` privalomas (žr. `matchesOwner`). */
const user = (id) => ({ ownerId: id, ownerKind: K.USER });
const desktop = { ownerId: null, ownerKind: K.UNOWNED };
const B = "44444444-4444-4444-8444-444444444444";

async function freshStore() {
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);
  return { store: createRedisStore(client), client };
}

test("#159 REDIS: savininkas keičia savo job'ą", { skip }, async () => {
  const { store, client } = await freshStore();
  try {
    const job = await store.create({ ownerId: A, ownerKind: K.USER });
    const updated = await store.updateOwned(job.id, { attempt_count: 7 }, user(A));
    assert.equal(updated.attempt_count, 7, "savininkas gali keisti savo job\x27ą");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS: svetimas savininkas gauna FORBIDDEN ir NIEKO nepakeičia", { skip }, async () => {
  const { store, client } = await freshStore();
  try {
    const job = await store.create({ ownerId: A, ownerKind: K.USER });

    assert.equal(await store.updateOwned(job.id, { attempt_count: 7 }, user(B)), "FORBIDDEN");

    const still = await store.get(job.id);
    assert.notEqual(still.status, "failed", "atmestas rašymas neturi palikti pėdsako");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS CAS: savininko pakeitimas TARP skaitymo ir rašymo blokuoja HSET", { skip }, async () => {
  /**
   * ESMINIS ŠIO PR TESTAS – ir jį lengva parašyti taip, kad jis nieko netikrintų.
   *
   * PIRMOJI VERSIJA BUVO BEVERTĖ. Ji keisdavo savininką PRIEŠ kviesdama
   * `updateOwned()`, tad suveikdavo JS pusės `matchesOwner()` greitasis kelias
   * ir `FORBIDDEN` grįždavo dar nepasiekus Lua. Pašalinus CAS patikrą iš Lua,
   * testas VIS TIEK praeidavo – mutacija to neaptiko.
   *
   * Tikras lenktynių langas yra TARP `get()` ir `eval()`. Todėl čia
   * įsiterpiama būtent ten: klientas apgaubiamas taip, kad pirmojo `eval`
   * metu (t. y. po to, kai JS patikra jau praėjo) savininkas būtų pakeistas.
   *
   * Taip Lua gauna užklausą su `ARGV[1] = A`, o rakte jau yra `B`.
   */
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);

  try {
    const plain = createRedisStore(client);
    const job = await plain.create({ ownerId: A, ownerKind: K.USER });

    // Klientas, kuris savininką perima TIK tada, kai jau kviečiamas Lua.
    let hijacked = false;
    const racing = Object.create(client);
    racing.eval = async (...args) => {
      if (!hijacked) {
        hijacked = true;
        await client.hset(`job:${job.id}`, "ownerId", B);
      }
      return client.eval(...args);
    };

    const store = createRedisStore(racing);
    const result = await store.updateOwned(job.id, { attempt_count: 7 }, user(A));

    assert.ok(hijacked, "prielaida: savininkas pakeistas būtent prieš Lua kvietimą");
    assert.equal(result, "FORBIDDEN", "CAS turi pamatyti, kad savininkas pasikeitė PO JS patikros");

    const final = await client.hgetall(`job:${job.id}`);
    assert.notEqual(final.status, "failed", "HSET neturėjo įvykti");
    assert.equal(final.ownerId, B, "nuosavybė liko naujojo savininko");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS CAS: Lua yra vienintelė garantija, ne JS greitasis kelias", { skip }, async () => {
  /**
   * JS pusės `matchesOwner()` yra tik optimizacija – ji taupo round-trip'ą,
   * kai savininkas akivaizdžiai nesutampa. Saugumo garantija turi galioti ir
   * ją apėjus, todėl Lua kviečiama TIESIOGIAI su pasenusiu lauktu savininku.
   */
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);

  try {
    const store = createRedisStore(client);
    const job = await store.create({ ownerId: B, ownerKind: K.USER });

    const CAS = `
      if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
      local current = redis.call('HGET', KEYS[1], 'ownerId')
      if current == false or current == nil then current = '' end
      if current ~= ARGV[1] then return 0 end
      redis.call('HSET', KEYS[1], unpack(ARGV, 2))
      return 1
    `;

    const outcome = await client.eval(CAS, 1, `job:${job.id}`, A, "status", "failed");
    assert.equal(Number(outcome), 0, "Lua turi atmesti rašymą su neteisingu savininku");

    const still = await client.hgetall(`job:${job.id}`);
    assert.notEqual(still.status, "failed");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS CAS: rūšies pakeitimas irgi blokuoja rašymą", { skip }, async () => {
  /**
   * `ownerId` vienas nepakanka net CAS lygmenyje: `""` yra teisėtas trims
   * būsenoms (desktop, bendras raktas, legacy). Jei Lua tikrintų tik ID,
   * desktop iškviečiantysis galėtų perrašyti API-key job'ą – abu turi `""`.
   */
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);

  try {
    const store = createRedisStore(client);
    const apiJob = await store.create({ ownerId: null, ownerKind: K.API_KEY });

    const result = await store.updateOwned(apiJob.id, { attempt_count: 7 }, desktop);
    assert.equal(result, "FORBIDDEN", "tas pats `\"\"` ownerId, bet kita rūšis");

    const still = await client.hgetall(`job:${apiJob.id}`);
    assert.notEqual(still.status, "failed");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS CAS: RŪŠIES pakeitimas tarp skaitymo ir rašymo blokuoja HSET", { skip }, async () => {
  /**
   * Ta pati pamoka kaip su `ownerId`: testas, keičiantis rūšį PRIEŠ
   * `updateOwned()`, suveiktų JS pusės `matchesOwner()` greitajame kelyje ir
   * Lua nepasiektų. Mutacija (Lua `kind` patikros pašalinimas) liktų nepagauta.
   *
   * Todėl rūšis keičiama interceptinant pirmą `eval()` – t. y. po JS patikros.
   */
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);

  try {
    const plain = createRedisStore(client);
    const job = await plain.create({ ownerId: null, ownerKind: K.UNOWNED });

    let hijacked = false;
    const racing = Object.create(client);
    racing.eval = async (...args) => {
      if (!hijacked) {
        hijacked = true;
        await client.hset(`job:${job.id}`, "ownerKind", K.API_KEY);
      }
      return client.eval(...args);
    };

    const store = createRedisStore(racing);
    const result = await store.updateOwned(job.id, { attempt_count: 7 }, desktop);

    assert.ok(hijacked, "prielaida: rūšis pakeista būtent prieš Lua kvietimą");
    assert.equal(result, "FORBIDDEN", "CAS turi tikrinti ir rūšį, ne tik ownerId");

    const final = await client.hgetall(`job:${job.id}`);
    assert.notEqual(final.status, "failed", "HSET neturėjo įvykti");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS: ownerId=null semantika – trys atvejai", { skip }, async () => {
  /**
   * Redis `null` saugo kaip tuščią string'ą. Be kanoninės formos desktop
   * režimo savininkas nesutaptų pats su savimi, o `""` galėtų tapti wildcard'u.
   */
  const { store, client } = await freshStore();
  try {
    const desktopJob = await store.create({ ownerId: null, ownerKind: K.UNOWNED });
    const owned = await store.create({ ownerId: A, ownerKind: K.USER });

    assert.ok(await store.updateOwned(desktopJob.id, { attempt_count: 7 }, desktop),
      "null job'as + null lauktas → leidžiama");
    assert.equal(await store.updateOwned(desktopJob.id, { attempt_count: 7 }, user(A)), "FORBIDDEN",
      "null job'as + UUID lauktas → atmetama");
    assert.equal(await store.updateOwned(owned.id, { attempt_count: 7 }, desktop), "FORBIDDEN",
      "UUID job'as + null lauktas → atmetama (`\"\"` NĖRA wildcard)");
  } finally {
    await client.quit();
  }
});

test("#159 REDIS: removeOwned taip pat CAS", { skip }, async () => {
  const { store, client } = await freshStore();
  try {
    const job = await store.create({ ownerId: A, ownerKind: K.USER });

    assert.equal(await store.removeOwned(job.id, user(B)), "FORBIDDEN");
    assert.ok(await store.get(job.id), "svetimas remove neturi ištrinti");

    assert.equal(await store.removeOwned(job.id, user(A)), true);
    assert.equal(await store.get(job.id), null);
  } finally {
    await client.quit();
  }
});

test("#159 REDIS: nesantis job'as duoda null, ne FORBIDDEN", { skip }, async () => {
  const { store, client } = await freshStore();
  try {
    assert.equal(await store.updateOwned("nera-tokio", { attempt_count: 7 }, user(A)), null);
    assert.equal(await store.removeOwned("nera-tokio", user(A)), false);
  } finally {
    await client.quit();
  }
});

test("#159 REDIS: fono keliai apdoroja job'us su SKIRTINGAIS savininkais", { skip }, async () => {
  /**
   * Worker'iai ir sweeper'iai neturi owner konteksto. Po namespace migracijos
   * jie turi ir toliau matyti visų savininkų job'us – priešingu atveju
   * retencija tyliai praleistų dalį įrašų.
   */
  const { store, client } = await freshStore();
  const sukurti = [];
  try {
    /**
     * ⚠️ TIKRINAMI SAVI job'ai, ne `all.length`.
     *
     * Anksčiau testas rėmėsi tuo, kad `flushdb()` paliko tuščią DB. Bet
     * `node --test` failus vykdo LYGIAGREČIAI: kitas failas tuo metu kuria
     * savo įrašus, ir `listAll().length` tampa nenuspėjamas – matėme 4 ir 9
     * vietoj 3. Dar blogiau, pats `flushdb()` naikino kitų failų būseną
     * vidury jų darbo.
     */
    sukurti.push(await store.create({ ownerId: A, ownerKind: K.USER }));
    sukurti.push(await store.create({ ownerId: B, ownerKind: K.USER }));
    sukurti.push(await store.create({ ownerId: null, ownerKind: K.UNOWNED }));

    const all = await store.listAll();
    const musu = all.filter((j) => sukurti.some((s) => s.id === j.id));
    assert.equal(musu.length, 3, "sisteminis kelias mato VISŲ savininkų job'us");

    for (const job of musu) {
      // Šis failas testuoja BACKEND'Ą tiesiogiai – fazių metodai gyvena fasade (#154).
      const updated = await store.update(job.id, { status: "processing" });
      assert.equal(updated.status, "processing", "sisteminis kelias neturi filtruoti pagal savininką");
    }
  } finally {
    for (const job of sukurti) {
      await client.del(`job:${job.id}`).catch(() => {});
      await client.zrem("jobs:index", job.id).catch(() => {});
    }
    await client.quit();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * OPTIMISTIC LOCK VERSIJOS CAS (#184, 7.5b)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#184 REDIS: `expectedVersion` konfliktas atmeta rašymą Lua viduje", { skip }, async () => {
  /**
   * ⚠️ TIKRAS REDIS BŪTINAS, IR TAI NE FORMALUMAS.
   *
   * `FakeRedis` `eval` neturi, tad versijos sąlyga per jį apskritai nevykdoma.
   * Patikra JS pusėje būtų bevertė: tarp `get()` ir `hset()` yra `await`, ir
   * būtent tas langas yra visa problema. Šis testas tikrina, kad sąlyga realiai
   * gyvena SKRIPTE.
   */
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    assert.equal(job.version, 1);

    /** Konkurentas įrašo savo pakeitimą - versija tampa 2. */
    await store.update(job.id, { actor: "konkurentas" });

    /** Pasenęs kvietėjas tebeturi snapshot'ą su `version = 1`. */
    const rezultatas = await store.update(job.id, { actor: "pasenes" }, { expectedVersion: 1 });
    assert.equal(rezultatas, "CONCURRENCY_CONFLICT");

    const dabartinis = await store.get(job.id);
    assert.equal(dabartinis.actor, "konkurentas", "konfliktas NIEKO neįrašė");
    assert.equal(dabartinis.version, 2, "konfliktas versijos NEDIDINA");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184 REDIS: sutampanti versija praeina, ir increment'as yra TOJE PAČIOJE operacijoje", { skip }, async () => {
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    const po = await store.update(job.id, { actor: "as" }, { expectedVersion: 1 });
    assert.equal(po.version, 2);
    assert.equal(po.actor, "as");

    /** Persistentinė reikšmė - iš Redis, ne iš grąžinimo. */
    const hash = await client.hgetall(`job:${job.id}`);
    assert.equal(hash.version, "2", "versija ir patch'as įrašyti kartu");
    assert.equal(hash.actor, "as");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184 REDIS: SVETIMAS savininkas su pasenusia versija gauna FORBIDDEN, ne konfliktą", { skip }, async () => {
  /**
   * ⚠️ TVARKA TIKRINAMA LUA VIDUJE. Abi nesėkmės sąlygos tenkinamos vienu metu;
   * skriptas nuosavybę tikrina PIRMA ir grąžina `0`, ne `2`. Perklasifikavus
   * kvietėjas gautų „bandyk dar kartą" ten, kur atsakymas yra „tau negalima".
   */
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    await store.update(job.id, { actor: "konkurentas" });

    const rezultatas = await store.updateOwned(
      job.id,
      { actor: "as" },
      user(B),
      { expectedVersion: 1 }
    );
    assert.equal(rezultatas, "FORBIDDEN");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184 REDIS: SAVAS savininkas su pasenusia versija gauna CONCURRENCY_CONFLICT", { skip }, async () => {
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    await store.update(job.id, { actor: "konkurentas" });

    const rezultatas = await store.updateOwned(
      job.id,
      { actor: "as" },
      user(A),
      { expectedVersion: 1 }
    );
    assert.equal(rezultatas, "CONCURRENCY_CONFLICT");
    assert.equal((await store.get(job.id)).actor, "konkurentas");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184 REDIS: be `expectedVersion` elgesys NEPAKITĘS (last-write-wins)", { skip }, async () => {
  /**
   * ⚠️ REGRESIJOS SARGAS. Sąlyginis kelias neturi tapti numatytuoju: sisteminiai
   * kvietėjai (retencija, valymas) jos neperduoda, ir jų semantika 7.5b
   * nekeičiama.
   */
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    await store.update(job.id, { actor: "pirmas" });
    const po = await store.update(job.id, { actor: "antras" });
    assert.equal(po.actor, "antras");
    assert.equal(po.version, 3);
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184 REDIS: nerastas įrašas grąžina `null` IR su sąlyga, IR be jos", { skip }, async () => {
  const { store, client } = await freshStore();
  try {
    assert.equal(await store.update("nera-tokio", { actor: "x" }), null);
    assert.equal(await store.update("nera-tokio", { actor: "x" }, { expectedVersion: 1 }), null);
  } finally {
    await client.quit();
  }
});

test("#184-B ⚠️ `finishAtomic` po pralaimėto CAS PERKLASIFIKUOJA į RESULT_CONFLICT", { skip }, async () => {
  /**
   * ⚠️ TRYS BACKEND'AI TURI ATSAKYTI VIENODAI Į TĄ PAČIĄ LENKTYNĘ (Codex B8).
   *
   * PostgreSQL sprendimą priima po `FOR UPDATE` toje pačioje transakcijoje, tad
   * pralaimėtojas iškart mato įsipareigotą būseną ir grąžina `RESULT_CONFLICT`.
   * Redis atomiškumą gauna iš versijos CAS, tad be perklasifikavimo grąžindavo
   * vien `CONCURRENCY_CONFLICT` — o kvietėjo retry tada pamatytų jau `completed`
   * job'ą ir gautų NUGALĖTOJO rezultatą kaip idempotentišką sėkmę. Reikalingas
   * `RESULT_CONFLICT` dingtų TYLIAI.
   *
   * ⚠️ TIKRAS REDIS BŪTINAS: kelias eina per `CAS_VERSIJA_LUA`, o `FakeRedis`
   * `eval` neturi. Vietinėje aplinkoje šis testas NEVYKDOMAS.
   *
   * ⚠️ LENKTYNĖ ATKURIAMA DETERMINISTIŠKAI, ne laiku: konkurentas įsipareigoja
   * rezultatą TARP `finishAtomic()` skaitymo ir jo rašymo, per `get` stub'ą.
   */
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    await store.update(job.id, { status: "processing", phase: "validating" });

    const originalusGet = store.get;
    let konkurentasIvyko = false;
    store.get = async (id) => {
      const snapshot = await originalusGet(id);
      if (!konkurentasIvyko) {
        konkurentasIvyko = true;
        store.get = originalusGet;
        await store.finishAtomic(id, "completed", { result: { vykdytojas: "A" } });
        store.get = async (x) => {
          store.get = originalusGet;
          return originalusGet(x);
        };
      }
      return snapshot;
    };

    let rezultatas;
    try {
      rezultatas = await store.finishAtomic(job.id, "completed", {
        result: { vykdytojas: "B" },
      });
    } finally {
      store.get = originalusGet;
    }

    assert.ok(konkurentasIvyko, "prielaida: konkurentas tikrai įsiterpė");
    assert.equal(
      rezultatas,
      "RESULT_CONFLICT",
      "⚠️ pralaimėtojas privalo gauti REZULTATO konfliktą, ne generinį versijos"
    );

    const galutinis = await store.get(job.id);
    assert.deepEqual(galutinis.result, { vykdytojas: "A" }, "nugalėtojo rezultatas nepaliestas");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});

test("#184-B ⚠️ priimtas progreso įvykis didina `version` (Lua HINCRBY)", { skip }, async () => {
  /**
   * ⚠️ REDIS PROGRESO KELIAS VERSIJOS APSKRITAI NEDIDINO (Codex B7).
   *
   * `CAS_PROGRESS_LUA` rašė tik `progress`, `progressKnown` ir `updatedAt`, o
   * memory bei PostgreSQL eina per `applyPatch()` ir didina. Pasekmė nebuvo
   * kosmetinė: po PRIIMTO progreso įvykio snapshot'as su senąja versija LIKDAVO
   * galiojantis vėlesniam CAS, nors įrašo būsena jau pasikeitusi — trys
   * backend'ai turėjo tris skirtingus `version` kontraktus.
   *
   * ⚠️ Vietinis `jobVersionParity` testas to nepagavo: jis eina per fasadą su
   * MEMORY backend'u, o Redis progreso kelias reikalauja `eval`.
   */
  const { store, client } = await freshStore();
  const job = await store.create({ ownerId: A, ownerKind: K.USER });
  try {
    await store.update(job.id, { status: "processing", phase: "transcribing" });
    const pries = await store.get(job.id);

    const po = await store.reportProgressAtomic(job.id, {
      phase: "transcribing",
      progress: { current: 5, total: 10 },
    });

    assert.ok(po && typeof po === "object", "įvykis TIKRAI priimtas, ne atmestas");
    assert.equal(po.progress.current, 5);
    assert.equal(po.version, pries.version + 1, "⚠️ priimtas įvykis yra mutacija: tiksliai +1");

    const hash = await client.hgetall(`job:${job.id}`);
    assert.equal(hash.version, String(pries.version + 1), "persistentinė reikšmė sutampa");
  } finally {
    await client.del(`job:${job.id}`).catch(() => {});
    await client.zrem("jobs:index", job.id).catch(() => {});
    await client.quit();
  }
});
