const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * EILĖS PRIEINAMUMO PREFLIGHT (#155, aktyvavimo barjero prielaida).
 *
 * ⚠️ KOKIĄ SPRAGĄ TAI UŽDARO.
 *
 * ADR `155-postgres-authority.md` išvardija šešias barjero prielaidas; ši buvo
 * vienintelė NEĮGYVENDINTA. Iki jos starto metu prie Redis nesijungdavo NIEKAS:
 * `hasQueueBackend()` vertina tik konfigūraciją, `jobRunner.init()` tikrino tik
 * ar `bullmq` galima `require()`, o jungtis kuriama LAZY pirmo `add` metu.
 *
 * Vadinasi `server.js` pažymėdavo runner'į ready ir imdavo klausytis, o PIRMAS
 * `enqueue` kabodavo arba kristų — jau turint priimtą užklausą.
 *
 * ⚠️ TESTAI VIETOJE VYKDOMI: `ioredis` mock'inamas, tikro Redis nereikia. Tikras
 * srautas lieka `queueRecovery.integration` (skip be `REDIS_URL`).
 */

/** Paleidžia `f()` su mock'intu `ioredis`, kurio `ping()` elgesys nurodomas. */
function suMockRedis(pingElgesys, f) {
  const origLoad = Module._load;

  Module._load = function (request) {
    if (request === "ioredis") {
      return class MockRedis {
        constructor() {}
        async ping() {
          return pingElgesys();
        }
        async quit() {}
      };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    delete require.cache[require.resolve("../queues/config")];
    return f(require("../queues/config"));
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve("../queues/config")];
  }
}

test("PREFLIGHT: be `REDIS_URL` verdiktas yra `nepasiekiama` su priežastimi", async () => {
  const senas = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const { patikrintiEilesJungti } = require("../queues/config");
    const v = await patikrintiEilesJungti();

    assert.equal(v.pasiekiama, false);
    assert.match(v.priezastis, /REDIS_URL/, "priežastis privalo įvardyti, KO trūksta");
  } finally {
    if (senas !== undefined) process.env.REDIS_URL = senas;
  }
});

test("PREFLIGHT: veikiantis `ping` duoda `pasiekiama: true`", async () => {
  process.env.REDIS_URL = "redis://mock:6379";

  const v = await suMockRedis(
    () => "PONG",
    ({ patikrintiEilesJungti }) => patikrintiEilesJungti({ timeoutMs: 500 })
  );

  assert.deepEqual(await v, { pasiekiama: true, priezastis: null });
});

test("PREFLIGHT: krentantis `ping` duoda `nepasiekiama`, ne metimą", async () => {
  /**
   * ⚠️ NEMETA — IR TAI SPRENDIMAS, NE PRALEIDIMAS. Verdiktas keliauja į
   * readiness atsakymą; metimas paverstų startą 500-uku ten, kur reikia
   * MATOMOS būsenos.
   */
  process.env.REDIS_URL = "redis://mock:6379";

  const v = await suMockRedis(
    () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    },
    ({ patikrintiEilesJungti }) => patikrintiEilesJungti({ timeoutMs: 500 })
  );

  const verdiktas = await v;
  assert.equal(verdiktas.pasiekiama, false);
  assert.match(verdiktas.priezastis, /ECONNREFUSED/);
});

test("PREFLIGHT: kabantis `ping` nutraukiamas pagal ribą", async () => {
  /**
   * ⚠️ BE RIBOS PREFLIGHT PAVERSTŲ STARTĄ PAKIBIMU — t. y. tiksliai tuo, ko jis
   * turi išvengti. Pakibęs Redis be ribos reikštų, kad serveris niekada nepradeda
   * klausytis ir orkestruotojas mato ne klaidą, o tylą.
   */
  process.env.REDIS_URL = "redis://mock:6379";

  const pradzia = Date.now();
  const v = await suMockRedis(
    () => new Promise(() => {}),
    ({ patikrintiEilesJungti }) => patikrintiEilesJungti({ timeoutMs: 120 })
  );

  const verdiktas = await v;
  assert.equal(verdiktas.pasiekiama, false);
  assert.match(verdiktas.priezastis, /timeout/i);
  assert.ok(Date.now() - pradzia < 3000, "riba privalo nutraukti, ne laukti neribotai");
});

test("PREFLIGHT: `REDIS_URL` slaptažodis NEPATENKA į priežastį", async () => {
  /**
   * ⚠️ PRIEŽASTIS KELIAUJA Į READINESS ATSAKYMĄ IR `doctor` IŠVESTĮ.
   *
   * `ioredis` klaidos tekste cituoja adresą, o `REDIS_URL` gali turėti
   * slaptažodį. Be sanitizacijos preflight, sukurtas gedimams RODYTI, taptų
   * kredencialų nutekėjimo keliu.
   */
  process.env.REDIS_URL = "redis://naudotojas:SLAPTAS@host:6379";

  const v = await suMockRedis(
    () => {
      throw new Error("connect ETIMEDOUT redis://naudotojas:SLAPTAS@host:6379");
    },
    ({ patikrintiEilesJungti }) => patikrintiEilesJungti({ timeoutMs: 500 })
  );

  const verdiktas = await v;
  assert.ok(!verdiktas.priezastis.includes("SLAPTAS"), `slaptažodis nutekėjo: ${verdiktas.priezastis}`);
  assert.match(verdiktas.priezastis, /PASLĖPTA/);
});

test("KONTROLĖ: sanitizacija nepašalina VISKO", () => {
  /**
   * Be jos „slaptažodžio nėra" tenkintų ir tuščia priežastis — o tada operatorius
   * matytų gedimą be jokios diagnostikos.
   */
  const tekstas = "connect ETIMEDOUT redis://a:b@host:6379";
  const saugus = tekstas.replace(/redis(s)?:\/\/[^\s]*/gi, "redis://[PASLĖPTA]");

  assert.match(saugus, /ETIMEDOUT/, "klaidos rūšis privalo išlikti");
  assert.ok(!saugus.includes("b@host"), "kredencialai privalo dingti");
});
