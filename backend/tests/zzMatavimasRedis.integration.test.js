const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/** LAIKINAS MATAVIMAS (#157 PR-4 raundas): Redis round-trip ir kanoninė tapatybė. */
test("MATAVIMAS: Date rezultatas Redis kelyje", { skip: skipWithoutRedis() }, async (t) => {
  const IORedis = require("ioredis");
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const { kanoninisRezultatas } = require("../utils/jobStore/common");

  const client = new IORedis(process.env.REDIS_URL);
  const store = createRedisStore(client);
  t.after(() => client.quit().catch(() => {}));

  const job = await store.create({ ownerKind: "unowned", type: "protocol" });
  await store.update(job.id, { status: "processing", phase: "generating" });

  const reiksme = { d: new Date(0) };
  const pirmas = await store.finishAtomic(job.id, "completed", { result: reiksme });
  t.diagnostic(`pirmas finish: ${typeof pirmas === "object" ? "job" : pirmas}`);

  const perskaitytas = await store.get(job.id, { hydrate: true });
  t.diagnostic(`prieš rašymą kanoninė : ${kanoninisRezultatas(reiksme)}`);
  t.diagnostic(`perskaityta kanoninė   : ${kanoninisRezultatas(perskaitytas.result)}`);

  const antras = await store.finishAtomic(job.id, "completed", { result: reiksme });
  t.diagnostic(`antras finish (ta pati įvestis): ${typeof antras === "object" ? "no-op (job)" : antras}`);

  await store.remove(job.id);

  assert.equal(antras, "RESULT_CONFLICT", "PROGNOZĖ: teisėtas retry gauna konfliktą");
});
