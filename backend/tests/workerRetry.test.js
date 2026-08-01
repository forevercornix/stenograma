const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "warn";
process.env.LOG_FORMAT = "json";

const { createLogger } = require("../utils/logger");

/**
 * GDPR #17: `failed` TIK galutinei nesėkmei.
 *
 * BullMQ `failed` įvykis kviečiamas ir tarpiniam bandymui. Žymint jį `failed`,
 * grandinė atrodytų taip:
 *   queued → processing → provider → failed → processing → completed
 * t. y. logas rodytų galutinę nesėkmę ten, kur jos nebuvo.
 *
 * Realaus BullMQ čia nėra (jam reikia Redis), tad tikrinam SPRENDIMO TAISYKLĘ,
 * kurią naudoja workers/index.js - tą pačią išraišką, tik izoliuotai.
 */

function stageFor(attemptsMade, maxAttempts) {
  const exhausted = attemptsMade >= maxAttempts;
  return exhausted ? "failed" : "retrying";
}

function capture(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines.map((line) => JSON.parse(line));
}

test("TARPINIS bandymas žymimas `retrying`, ne `failed`", () => {
  assert.equal(stageFor(1, 3), "retrying");
  assert.equal(stageFor(2, 3), "retrying");
});

test("GALUTINIS bandymas žymimas `failed`", () => {
  assert.equal(stageFor(3, 3), "failed");
  assert.equal(stageFor(4, 3), "failed");
});

test("STRUKTŪRA: worker'is nebežymi `failed` prieš išnaudojant bandymus", () => {
  /**
   * Elgsenos testui reikėtų tikro Redis, tad tikrinam struktūrą - tiksliai tai,
   * kas buvo klaidinga: `failed` buvo rašomas PRIEŠ `attemptsExhausted` skaičiavimą.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../workers/index.js"), "utf8");

  assert.match(source, /stage: attemptsExhausted \? "failed" : "retrying"/);
  assert.ok(
    !/log\.warn\("Darbas nepavyko", \{ stage: "failed"/.test(source),
    "besąlyginis `failed` negali grįžti"
  );
});

test("Įvykis neša bandymo numerį ir ribą", () => {
  const log = createLogger("worker");

  const entries = capture(() => {
    log.warn("Darbas bus kartojamas", {
      stage: "retrying",
      execution: "worker",
      jobId: "job-1",
      attempt: 1,
      maxAttempts: 3,
      errorCode: "PROVIDER_ERROR",
    });
  });

  // Be `attempt`/`maxAttempts` „retrying" nepasako, ar liko bandymų, ar tai
  // paskutinis - o būtent tai ir svarbu skaitant grandinę.
  assert.equal(entries[0].data.attempt, 1);
  assert.equal(entries[0].data.maxAttempts, 3);
  assert.equal(entries[0].data.stage, "retrying");
});
