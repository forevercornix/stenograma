/**
 * FAKE Redis klientas - imituoja ioredis API (hset/hgetall/zadd/...) in-memory,
 * kad Redis backend'o LOGIKĄ (serialize/deserialize, raktų schema, sweep) būtų
 * galima testuoti BE tikro Redis serverio (sandbox'e jo nėra). Tai NEtikrina
 * tikro Redis tinklo elgesio, bet tikrina, kad mūsų kodas teisingai naudoja
 * Redis komandas ir teisingai (de)serializuoja job'us.
 *
 * ⚠️ BENDRAS HELPERIS, NE KOPIJA KIEKVIENAME TESTE (#205, 7.2c).
 *
 * Iki 7.2c ši klasė gyveno `jobStoreRedis.test.js` viduje. Antram vartotojui
 * (tipų normalizavimo paritetui) reikėjo tos pačios imitacijos, o antra kopija
 * yra tiksliai ta „dvi nepriklausomos realizacijos" klasė, kurią #205 ir
 * šalina - tik testų sluoksnyje. Skirtingai elgiantis dviem fake'ams, du testai
 * matuotų skirtingą Redis.
 */
class FakeRedis {
  constructor() {
    this.hashes = new Map(); // key -> {field: value}
    this.zsets = new Map(); // key -> Map(member -> score)
    this.expires = new Map();
  }
  async hset(key, obj) {
    this.hashes.set(key, { ...(this.hashes.get(key) || {}), ...obj });
    return "OK";
  }
  async hgetall(key) {
    return this.hashes.get(key) || {};
  }
  async zadd(key, score, member) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    this.zsets.get(key).set(member, score);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()].filter(([, s]) => s >= min && s <= max).map(([m]) => m);
  }
  async zrem(key, member) {
    const z = this.zsets.get(key);
    if (z) z.delete(member);
    return 1;
  }
  async zcard(key) {
    return this.zsets.get(key)?.size || 0;
  }
  async zrange(key, start, stop) {
    const z = this.zsets.get(key);
    if (!z) return [];
    // Rūšiuojam pagal score (kaip Redis), grąžinam member'ius. start/stop: 0,-1 = visi.
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }
  pipeline() {
    // Minimalus pipeline mock: kaupia komandas, exec() grąžina [[null, rezultatas], ...].
    const cmds = [];
    const self = this;
    const p = {
      exists(key) { cmds.push(["exists", key]); return p; },
      hgetall(key) { cmds.push(["hgetall", key]); return p; },
      async exec() {
        const out = [];
        for (const [cmd, key] of cmds) {
          if (cmd === "exists") out.push([null, self.hashes.has(key) ? 1 : 0]);
          if (cmd === "hgetall") out.push([null, { ...(self.hashes.get(key) || {}) }]);
        }
        return out;
      },
      // Kiek komandų sudėta - kad testas galėtų patikrinti, jog naudojamas
      // VIENAS round-trip, o ne N atskirų kvietimų.
      _commandCount: () => cmds.length,
    };
    return p;
  }
  async exists(key) {
    return this.hashes.has(key) ? 1 : 0;
  }

  async del(key) {
    return this.hashes.delete(key) ? 1 : 0;
  }
  async expire(key, seconds) {
    this.expires.set(key, seconds);
    return 1;
  }
  /** `redisStore.update()` kviečia jį nebaigto valymo job'ams (`hasPendingCleanup`). */
  async persist(key) {
    return this.expires.delete(key) ? 1 : 0;
  }
  // Imituojam expire efektą testui: pašalinam hash, paliekam zset įrašą.
  _forceExpire(key) {
    this.hashes.delete(key);
  }
}

module.exports = { FakeRedis };
