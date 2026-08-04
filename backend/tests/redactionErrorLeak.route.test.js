const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * GDPR #5: REDAKCIJOS KLAIDA NETURI TAPTI PII NUTEKĖJIMU (visas kelias).
 *
 * `tests/redactionEnforcement.test.js` įrodo, kad jautrus `cause.message`
 * nepatenka į pačią `RedactionError`. To NEPAKANKA: klaida keliauja toliau į
 * HTTP atsakymą, audito žurnalą ir serverio logą, ir kiekvienas iš tų kelių turi
 * savo sanitizaciją. Šis testas dengia visą grandinę iš karto.
 *
 * KODĖL TAI SVARBU BŪTENT ČIA: routes/generate.js ne-500 HttpError grąžina
 * klientui NESANITIZUOTĄ (`{ error: e.message, details: e.details }`). Šiandien
 * redakcijos klaida tampa 500 ir yra sanitizuojama, bet ta apsauga remiasi vien
 * statuso kodu. Jei kas nors kada nors nuspręs, kad "tiekėjas krito" semantiškai
 * yra 502, pranešimas iškeliaus klientui be jokio filtro. Testas tą statusą
 * užfiksuoja, kad toks pakeitimas nepraeitų tyliai.
 */

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "claude";

/**
 * Tiekėjų valdysena (#22.2): išorinis tiekėjas neveikia be eksplicitinio
 * patvirtinimo — nei startup metu, nei fabrike.
 *
 * Testas tikrina REDAKCIJOS elgesį su išoriniu tiekėju, tad patvirtinimas čia
 * yra prielaida, ne tikrinamas dalykas. Be jo serveris apskritai
 * nepasileistų.
 */
process.env.APPROVED_EXTERNAL_PROVIDERS = "claude";
process.env.ANTHROPIC_API_KEY = "sk-ant-testinis";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";

/** Unikalus žymuo: jei jis kur nors išlenda, tai realus nutekėjimas. */
const MARKER = "ZYMUO-Jonas-Jonaitis-39001010000";

const redactionComponent = require("../utils/redactionComponent");

// Registruojama PRIEŠ server.js: startup validacija tikrina, ar redakcijos
// komponentas prieinamas, ir be jo serveris sąmoningai nestartuotų.
redactionComponent._setLoaderForTests(() => ({
  redact() {
    const error = new Error(`redakcijos modelis krito apdorojant: ${MARKER}`);
    error.code = MARKER;
    throw error;
  },
}));

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const app = require("../server");
app._setReadyForTests();

/** Perima VISUS console kanalus - logas yra vienas iš trijų nutekėjimo kelių. */
function captureConsole() {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const captured = [];

  for (const channel of Object.keys(original)) {
    console[channel] = (...args) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }

  return {
    text: () => captured.join("\n"),
    restore: () => Object.assign(console, original),
  };
}

test("redakcijos klaida: žymuo nepatenka NEI į atsakymą, NEI į auditą, NEI į logą", async (t) => {
  const consoleCapture = captureConsole();
  t.after(() => {
    consoleCapture.restore();
    redactionComponent._setLoaderForTests(null);
  });

  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilga testinė transkripcija, kad praeitų validaciją." });

  // 1. HTTP atsakymas
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(MARKER), `žymuo rastas atsakyme: ${body}`);

  // 2. Audito žurnalas
  const audit = JSON.stringify(auditLog.getAll());
  assert.ok(!audit.includes(MARKER), "žymuo rastas audito įraše");

  // 3. Serverio logas
  const logs = consoleCapture.text();
  assert.ok(!logs.includes(MARKER), "žymuo rastas serverio loge");
});

test("statusas yra STABILUS 500, o ne paveldėtas iš vidinės klaidos", async (t) => {
  const consoleCapture = captureConsole();
  t.after(() => {
    consoleCapture.restore();
    redactionComponent._setLoaderForTests(null);
  });

  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilga testinė transkripcija, kad praeitų validaciją." });

  // Sąmoningai 500: routes/generate.js sanitizuoja TIK 500. Jei kas nors pakeis
  // redakcijos klaidą į 502 ar 4xx, pranešimas keliaus klientui neapdorotas -
  // ir šis assert'as kris pirmas.
  assert.equal(res.status, 500, "redakcijos klaida turi likti 500, kad būtų sanitizuojama");
  assert.equal(typeof res.body.error, "string");
});

test("tiekėjas NEBUVO iškviestas - klaida įvyko prieš tinklo kvietimą", async (t) => {
  const consoleCapture = captureConsole();
  t.after(() => {
    consoleCapture.restore();
    redactionComponent._setLoaderForTests(null);
  });

  // ANTHROPIC_API_KEY yra netikras. Jei užklausa būtų pasiekusi Claude, gautume
  // tinklo/401 klaidą, o ne redakcijos. Netiesiogiai patvirtina fail-closed tvarką.
  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilga testinė transkripcija, kad praeitų validaciją." });

  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes("anthropic"), "atsakyme neturi būti tiekėjo detalių");
});
