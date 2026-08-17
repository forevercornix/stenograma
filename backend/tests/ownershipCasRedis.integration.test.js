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
  await client.flushdb();
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
  await client.flushdb();

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
  await client.flushdb();

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
  await client.flushdb();

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
  await client.flushdb();

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
  try {
    await store.create({ ownerId: A, ownerKind: K.USER });
    await store.create({ ownerId: B, ownerKind: K.USER });
    await store.create({ ownerId: null, ownerKind: K.UNOWNED });

    const all = await store.listAll();
    assert.equal(all.length, 3);

    for (const job of all) {
      // Šis failas testuoja BACKEND'Ą tiesiogiai – fazių metodai gyvena fasade (#154).
      const updated = await store.update(job.id, { status: "processing" });
      assert.equal(updated.status, "processing", "sisteminis kelias neturi filtruoti pagal savininką");
    }
  } finally {
    await client.quit();
  }
});
