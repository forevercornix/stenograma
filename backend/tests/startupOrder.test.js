const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
delete process.env.REDIS_URL; // inline režimas testui

const app = require("../server");

// Regresinis testas P1 pataisymui: startServer TURI inicijuoti jobStore ir jobRunner
// PRIEŠ listen (kitaip ankstyva užklausa galėtų laimėti race ir sukurti memory+BullMQ).
// Tikrinam kvietimų TVARKĄ per injektuotą listen + onStep.
//
// ⚠️ #155 / 7.3 PRAPLĖTĖ SEKĄ. `sessionStore.init()` ir startinis `AUTH_USERS`
// suderinimas yra SESIJŲ AUTORITETO paruošimas: `authRoute` prijungtas be
// `requireJobSystemReady`, tad readiness middleware vienas paliktų
// `/api/auth/login` landą į pusiau inicijuotą saugyklą. Todėl abu žingsniai
// privalo baigtis PRIEŠ `listen`, ir tvarka tikrinama `deepEqual`, ne
// „yra sąraše" - įterptas žingsnis po `listen` praeitų narystės patikrą.
//
// ⚠️ #155 / 7.4b PRAPLĖTĖ SEKĄ DAR KARTĄ. `auditStore.init()` yra AUDITO
// AUTORITETO paruošimas: `AUDIT_BACKEND=postgres` su nepasiekiama DB, netaikyta
// migracija ar nukritusiu append-only trigeriu privalo NUTRAUKTI startą. Be to
// auditas rašomas iš `/api/auth/login` - kelio be `requireJobSystemReady` - tad
// inicijavus jį fone, tame lange blokuojantis autentikacijos įvykis kristų su
// `AUDIT_WRITE_FAILED`.
test("startServer: jobStore -> sessionStore -> auditStore -> jobRunner -> listen (tvarka)", async () => {
  const events = [];
  let listenCalledAt = null;

  await app.startServer({
    port: 0,
    listen: async () => { listenCalledAt = events.length; }, // NEatidarom tikro porto
    onStep: (name) => events.push(name),
  });

  // Tvarka turi būti tiksliai ši:
  assert.deepEqual(
    events,
    [
      "jobStore.init",
      "sessionStore.init",
      "sessionStore.reconcile",
      "auditStore.init",
      /**
       * ⚠️ PRIEŠ `jobRunner.init` SĄMONINGAI (#155, 7.5a / #183).
       *
       * Runner'is apdoroja job'us, kurie kiekvienam vykdymui klausia ištrynimo
       * barjero. Inicijavus žymas po jo, egzistuotų langas, kuriame job'as jau
       * gali būti paimtas, o barjeras dar neinicijuotas.
       */
      "deletionTombstones.init",
      "jobRunner.init",
      "listen",
    ],
    "init turi vykti PRIEŠ listen, nuoseklia tvarka"
  );

  // listen kviečiamas PASKUTINIS (po visų init žingsnių).
  assert.equal(listenCalledAt, events.length - 1, "listen turi būti paskutinis žingsnis");
  assert.ok(
    events.indexOf("sessionStore.reconcile") < events.indexOf("listen"),
    "sesijų suderinimas privalo baigtis prieš pirmą aptarnautą užklausą"
  );
  assert.ok(
    events.indexOf("auditStore.init") < events.indexOf("listen"),
    "audito saugykla privalo būti paruošta prieš pirmą aptarnautą užklausą"
  );
});

test("startServer: audito saugyklos klaida reiškia, kad listen NEKVIEČIAMAS", async () => {
  /**
   * ⚠️ JOKIO FALLBACK Į ATMINTĮ (#211).
   *
   * `AUDIT_BACKEND=postgres` su nepasiekiama DB privalo nutraukti startą. Tylus
   * grįžimas į atmintį reikštų, kad operatorius paprašė persistentinio audito,
   * servisas pakilo ir rašo į vietą, kuri dingsta per restartą - o paaiškėtų
   * tai tik tada, kai audito prireiks.
   *
   * Klaida injektuojama į TĄ PATĮ `auditStore.init`, kurį kviečia
   * `startServer()`: kitaip testas praeitų ir tada, kai jis apskritai
   * nekviečiamas.
   */
  const auditStore = require("../utils/auditStore");
  const originalus = auditStore.init;
  auditStore.init = async () => {
    throw new Error("audito saugykla nepasiekiama");
  };

  const events = [];
  try {
    await assert.rejects(
      () =>
        app.startServer({
          port: 0,
          listen: async () => { events.push("listen"); },
          onStep: (name) => events.push(name),
        }),
      /audito saugykla nepasiekiama/
    );
  } finally {
    auditStore.init = originalus;
  }

  assert.ok(!events.includes("listen"), "kritus auditui serveris negali pradėti aptarnauti srauto");
});

test("startServer: sesijų suderinimo klaida reiškia, kad listen NEKVIEČIAMAS", async () => {
  /**
   * ⚠️ NEPAVYKĘS SUDERINIMAS NEGALI VIRSTI APTARNAUJAMU SRAUTU.
   *
   * Suderinimas revokuoja sesijas, kurių rolė `AUTH_USERS` pasikeitė arba
   * kurių vartotojo nebėra. Jei jis nutrūksta, o serveris vis tiek pakyla,
   * būtent tos sesijos - pažemintos ir pašalintos - toliau autorizuoja
   * užklausas sena role.
   *
   * Klaida injektuojama į `sessionStore.reconcile`, t. y. į TĄ PATĮ kvietimą,
   * kurį daro `startServer()`, o ne į žemesnį sluoksnį: kitaip testas
   * praeitų ir tada, kai `startServer()` suderinimo apskritai nekviečia.
   */
  const sessionStore = require("../utils/sessionStore");
  const originalus = sessionStore.reconcile;
  sessionStore.reconcile = async () => {
    throw new Error("suderinimas nutrūko ties 3-ia partija");
  };

  const events = [];
  try {
    await assert.rejects(
      () =>
        app.startServer({
          port: 0,
          listen: async () => { events.push("listen"); },
          onStep: (name) => events.push(name),
        }),
      /suderinimas nutrūko/
    );
  } finally {
    sessionStore.reconcile = originalus;
  }

  assert.ok(!events.includes("listen"), "listen negali įvykti po nepavykusio suderinimo");
});

test("startServer: readiness=true PRIEŠ listen (job endpointai nebus 503 kai serveris klauso)", async () => {
  let readyAtListen = null;
  await app.startServer({
    port: 0,
    listen: async () => {
      // Momentu, kai listen kviečiamas, readiness JAU turi būti true.
      const request = require("supertest");
      const res = await request(app).get("/api/ready");
      readyAtListen = res.status;
    },
    onStep: () => {},
  });
  assert.equal(readyAtListen, 200, "listen metu /api/ready jau turi būti 200 (init baigtas)");
});
