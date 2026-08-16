const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * #158: TRIJŲ ERŲ MARŠRUTIZAVIMAS SU TIKRU REDIS.
 *
 * KODĖL ATSKIRAS INTEGRACINIS TESTAS.
 *
 * `jobAuthorization.js` dokumentuoja jau įvykusią klaidą: #17 laikų job'ai
 * turėjo `actor` be `actorSource`, ir dėl to 0 iš 6 job'ų pasiekė procesorių.
 * Vienetiniai testai to nepagavo, nes tikrino `{actor: null, actorSource: null}` –
 * derinį, kurio realiai beveik nebūna. Rasta tik CI su tikru Redis.
 *
 * Šis PR įveda tą pačią klaidos klasę: `schemaVersion` per Redis grįžta kaip
 * STRING (`"2"`), o maršrutizavimas lygina `=== 2`. Be tipo konversijos
 * (`NUMBER_FIELDS` sąraše) kiekvienas Redis job'as tyliai atrodytų kaip legacy.
 * Objektų literalai atmintyje šito NEATSKLEIDŽIA.
 *
 * Praleidžiamas be `REDIS_URL` – kaip ir kiti integraciniai testai.
 */

const REDIS_URL = process.env.REDIS_URL;
const skip = REDIS_URL ? false : "reikia REDIS_URL (tikro Redis) - žr. failo komentarą";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { hashPassword } = require("../utils/credentials");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "33333333-3333-4333-8333-333333333333";

process.env.AUTH_USERS =
  `sysadmin:administrator:${hashPassword("admin-slaptas-1")}:${ADMIN_ID},` +
  `darbuotojas:operator:${hashPassword("operator-slaptas-2")}:${OPERATOR_ID}`;

const { authorizeJobExecution, DENY_REASON } = require("../utils/jobAuthorization");
const { PERMISSIONS } = require("../utils/permissions");
const { serialize, deserialize } = require("../utils/jobStore/redisStore");
const { newJob } = require("../utils/jobStore/common");

/** Round-trip per TIKRĄ Redis – ne per objektą atmintyje. */
async function throughRedis(job) {
  const IORedis = require("ioredis");
  const client = new IORedis(REDIS_URL);
  const key = `test:era:${job.id}`;
  try {
    await client.hset(key, serialize(job));
    const raw = await client.hgetall(key);
    return deserialize(raw);
  } finally {
    await client.del(key);
    await client.quit();
  }
}

test("#158 REDIS: schemaVersion išlieka SKAIČIUMI po round-trip", { skip }, async () => {
  const job = newJob({ type: "protocol", actor: OPERATOR_ID, actorSource: "session" });

  const restored = await throughRedis(job);

  assert.equal(typeof restored.schemaVersion, "number",
    'Redis grąžina "2" kaip string; be NUMBER_FIELDS konversijos === 2 tyliai nepataikytų');
  assert.equal(restored.schemaVersion, 2);
});

test("#158 REDIS: v2 jobas po round-trip sprendžiamas pagal ID, ne kaip legacy", { skip }, async () => {
  const job = newJob({ type: "protocol", actor: OPERATOR_ID, actorSource: "session" });

  const restored = await throughRedis(job);
  const decision = authorizeJobExecution(restored, PERMISSIONS.JOB_CREATE);

  assert.equal(decision.allowed, true, "v2 jobas iš Redis turi praeiti ID paiešką");
  assert.equal(decision.role, "operator");
});

test("#158 REDIS: v2 jobas iš Redis išgyvena PERVADINIMĄ", { skip }, async () => {
  const job = newJob({ type: "protocol", actor: OPERATOR_ID, actorSource: "session" });
  const restored = await throughRedis(job);

  const poPervadinimo = {
    AUTH_USERS:
      `sysadmin:administrator:${hashPassword("admin-slaptas-1")}:${ADMIN_ID},` +
      `visai-kitas-vardas:operator:${hashPassword("operator-slaptas-2")}:${OPERATOR_ID}`,
  };

  const decision = authorizeJobExecution(restored, PERMISSIONS.JOB_CREATE, poPervadinimo);
  assert.equal(decision.allowed, true, "tas pats ID – tas pats žmogus");
});

test("#158 REDIS: visos TRYS eros elgiasi teisingai po round-trip", { skip }, async () => {
  /**
   * Tikrinama ŠAKA, ne tik „visi praėjo". Žalias rezultatas su neteisingu
   * fallback'u atrodytų lygiai taip pat: v2 job'as, tyliai nukritęs į vardo
   * paiešką, irgi būtų atmestas – bet dėl visai kitos priežasties.
   */
  const era17 = await throughRedis({ ...newJob({ type: "protocol" }), schemaVersion: undefined, actor: "darbuotojas", actorSource: null });
  const era18 = await throughRedis({ ...newJob({ type: "protocol" }), schemaVersion: undefined, actor: "darbuotojas", actorSource: "session" });
  const eraV2 = await throughRedis(newJob({ type: "protocol", actor: OPERATOR_ID, actorSource: "session" }));

  const d17 = authorizeJobExecution(era17, PERMISSIONS.JOB_CREATE);
  assert.equal(d17.allowed, true, "#17: passthrough");
  assert.equal(d17.reason, DENY_REASON.NO_ACTOR, "#17 turi eiti NO_ACTOR šaka");

  const d18 = authorizeJobExecution(era18, PERMISSIONS.JOB_CREATE);
  assert.equal(d18.allowed, true, "#18: vardo paieška");
  assert.equal(d18.role, "operator");

  const dV2 = authorizeJobExecution(eraV2, PERMISSIONS.JOB_CREATE);
  assert.equal(dV2.allowed, true, "v2: ID paieška");
  assert.equal(dV2.role, "operator");
});
