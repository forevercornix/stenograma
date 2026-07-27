const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
delete process.env.REDIS_URL; // inline režimas testui

const app = require("../server");

// Regresinis testas P1 pataisymui: startServer TURI inicijuoti jobStore ir jobRunner
// PRIEŠ listen (kitaip ankstyva užklausa galėtų laimėti race ir sukurti memory+BullMQ).
// Tikrinam kvietimų TVARKĄ per injektuotą listen + onStep.
test("startServer: jobStore.init -> jobRunner.init -> listen (tvarka)", async () => {
  const events = [];
  let listenCalledAt = null;

  await app.startServer({
    port: 0,
    listen: async () => { listenCalledAt = events.length; }, // NEatidarom tikro porto
    onStep: (name) => events.push(name),
  });

  // Tvarka turi būti tiksliai ši:
  assert.deepEqual(events, ["jobStore.init", "jobRunner.init", "listen"],
    "init turi vykti PRIEŠ listen, nuoseklia tvarka");

  // listen kviečiamas PASKUTINIS (po abiejų init).
  assert.equal(listenCalledAt, 2, "listen turi būti po jobStore ir jobRunner init");
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
