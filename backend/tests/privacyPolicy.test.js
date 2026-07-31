const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";

const privacyPolicy = require("../utils/privacyPolicy");
const { getPrivacyConfig } = require("../utils/privacyConfig");

/**
 * GDPR #5 DoD: "one validated runtime object used by routes, services, queues,
 * workers, providers".
 *
 * Testuojama pati SAVYBĖ, o ne jos vartotojai: kad proceso metu pakeistas
 * process.env NEBEGALI sukurti dviejų skirtingų efektyvių būsenų viename
 * procese. Iki šito privatumo nuostatos buvo skaitomos kiekvieno kvietimo metu,
 * tad du komponentai galėjo matyti skirtingą tiesą.
 */

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    privacyPolicy._resetForTests();
  }
}

test("politika yra TAS PATS objektas kiekvienam vartotojui", () => {
  privacyPolicy._resetForTests();

  const a = privacyPolicy.getPrivacyPolicy();
  const b = privacyPolicy.getPrivacyPolicy();

  assert.equal(a, b, "turi būti ta pati nuoroda, ne kopija");
  privacyPolicy._resetForTests();
});

test("politika UŽŠALDYTA - vartotojas negali jos pakeisti kitiems", () => {
  privacyPolicy._resetForTests();
  const policy = privacyPolicy.getPrivacyPolicy();

  assert.equal(Object.isFrozen(policy), true);
  assert.throws(() => {
    "use strict";
    policy.requireRedactionBeforeExternal = true;
  }, TypeError);

  privacyPolicy._resetForTests();
});

test("ESMĖ: process.env pakeitimas PO sukūrimo efektyvios būsenos NEKEIČIA", () => {
  withEnv({ REQUIRE_REDACTION_BEFORE_EXTERNAL: undefined }, () => {
    privacyPolicy._resetForTests();
    const before = privacyPolicy.getPrivacyPolicy().requireRedactionBeforeExternal;
    assert.equal(before, false);

    // Kas nors proceso viduryje "įjungia" nuostatą.
    process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";

    // Neapdorotas skaitymas iš env jau rodytų true - būtent tas dviprasmiškumas
    // ir buvo problema.
    assert.equal(getPrivacyConfig().requireRedactionBeforeExternal, true);

    // Politika - ne.
    assert.equal(privacyPolicy.getPrivacyPolicy().requireRedactionBeforeExternal, false);

    delete process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  });
});

test("initPrivacyPolicy VALIDUOJA ir meta klaidą (paleidimas nutrūksta)", () => {
  withEnv({ PRIVACY_PROFILE: "local_only", LLM_PROVIDER: "claude" }, () => {
    privacyPolicy._resetForTests();

    assert.throws(
      () => privacyPolicy.initPrivacyPolicy(),
      (e) => e.code === "PRIVACY_POLICY_INVALID" && e.errors.some((x) => /local_only/.test(x))
    );
  });
});

test("tingus kelias NEVALIDUOJA - skaitymas neturi kristi dėl blogos konfigūracijos", () => {
  withEnv({ PRIVACY_PROFILE: "local_only", LLM_PROVIDER: "claude" }, () => {
    privacyPolicy._resetForTests();

    // Kitaip fail-closed patikros, kurios tą blogą konfigūraciją turi
    // UŽBLOKUOTI, pačios nukristų bandydamos perskaityti nuostatą.
    const policy = privacyPolicy.getPrivacyPolicy();
    assert.equal(policy.localOnly, true);
    assert.equal(policy.allowExternalProviders, false);
  });
});

test("isInitialized skiria eksplicitinį startą nuo tingaus fallback'o", () => {
  privacyPolicy._resetForTests();
  assert.equal(privacyPolicy.isInitialized(), false);

  privacyPolicy.getPrivacyPolicy();
  assert.equal(privacyPolicy.isInitialized(), true);

  privacyPolicy._resetForTests();
});
