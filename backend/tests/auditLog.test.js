const test = require("node:test");
const assert = require("node:assert/strict");

const auditLog = require("../utils/auditLog");

const ENV_KEYS = ["AUDIT_RETENTION_DAYS", "AUDIT_MAX_ENTRIES", "PRIVACY_MODE", "AUDIT_ID_SALT"];

test.beforeEach(() => {
  // Anksčiau kiekvienas testas trynė env kintamuosius PATS, savo pabaigoje.
  // Kritus assert'ui (pvz. PRIVACY_MODE=true testе) reikšmė nutekėdavo į kitus
  // to paties failo testus - node:test juos vykdo TAME PAČIAME procese.
  for (const key of ENV_KEYS) delete process.env[key];
  auditLog.clear();
});

test.afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

test("pseudonymizes job identifier", () => {
  const row = auditLog.record({
    event: "JOB_CREATED",
    meetingId: "abc123",
    success: true,
  });

  assert.equal(row.event, "JOB_CREATED");
  assert.equal(row.result, "success");
  assert.notEqual(row.subjectId, "abc123");
  assert.equal("meetingId" in row, false);
});

test("redacts secrets and personal data from errors", () => {
  const row = auditLog.record({
    success: false,
    error:
      "jonas@example.com +37061234567 39001010001 " +
      "Authorization: Bearer secret-token " +
      "/tmp/private/audio.mp3",
  });

  assert.doesNotMatch(row.error, /jonas@example\.com/);
  assert.doesNotMatch(row.error, /37061234567/);
  assert.doesNotMatch(row.error, /39001010001/);
  assert.doesNotMatch(row.error, /secret-token/);
  assert.doesNotMatch(row.error, /audio\.mp3/);
});

test("sanitizeForLogging recursively redacts sensitive keys", () => {
  const sanitized = auditLog.sanitizeForLogging({
    user: {
      email: "person@example.com",
      harmless: "technical value",
    },
    authorization: "Bearer token-value",
    transcript: "private transcript",
    nested: {
      apiKey: "secret-key",
      ok: true,
    },
  });

  assert.equal(sanitized.user.email, "[EMAIL_REDACTED]");
  assert.equal(sanitized.user.harmless, "technical value");
  assert.equal(sanitized.authorization, "[REDACTED]");
  assert.equal(sanitized.transcript, "[REDACTED]");
  assert.equal(sanitized.nested.apiKey, "[REDACTED]");
  assert.equal(sanitized.nested.ok, true);
});

test("uses 30 day retention by default", () => {
  delete process.env.AUDIT_RETENTION_DAYS;

  assert.equal(auditLog.getRetentionDays(), 30);
});

test("purges audit entries older than configured retention", () => {
  process.env.AUDIT_RETENTION_DAYS = "1";

  auditLog.record({
    event: "JOB_CREATED",
    meetingId: "old-job",
    success: true,
  });

  const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const removed = auditLog.purgeExpired(twoDaysLater);

  assert.equal(removed, 1);
  assert.equal(auditLog.getAll().length, 0);

  delete process.env.AUDIT_RETENTION_DAYS;
});

test("removes audit entries belonging to a job identifier", () => {
  auditLog.record({
    event: "JOB_CREATED",
    jobId: "job-to-delete",
    success: true,
  });

  auditLog.record({
    event: "JOB_CREATED",
    jobId: "job-to-keep",
    success: true,
  });

  const removed =
    auditLog.removeBySubjectIdentifier("job-to-delete");

  assert.equal(removed, 1);
  assert.equal(auditLog.getAll().length, 1);
  assert.equal(
    auditLog.getAll()[0].subjectId,
    auditLog.pseudonymizeIdentifier("job-to-keep")
  );
});

test("privacy mode disables audit recording", () => {
  process.env.PRIVACY_MODE = "true";
  auditLog.clear();

  const recorded = auditLog.record({
    event: "JOB_CREATED",
    jobId: "privacy-job",
    success: true,
  });

  assert.equal(recorded, null);
  assert.equal(auditLog.getAll().length, 0);

  delete process.env.PRIVACY_MODE;
});

test("privacy mode clears previously accumulated audit entries", () => {
  delete process.env.PRIVACY_MODE;
  auditLog.clear();

  auditLog.record({
    event: "JOB_CREATED",
    jobId: "existing-job",
    success: true,
  });

  assert.equal(auditLog.getAll().length, 1);

  process.env.PRIVACY_MODE = "true";

  auditLog.record({
    event: "JOB_CREATED",
    jobId: "ignored-job",
    success: true,
  });

  assert.equal(auditLog.getAll().length, 0);

  delete process.env.PRIVACY_MODE;
});

test("privacy mode is disabled by default", () => {
  delete process.env.PRIVACY_MODE;

  assert.equal(auditLog.isPrivacyModeEnabled(), false);
});

test("kontroliuojami laukai NEredaguojami kaip PII", () => {
  // Regresija: bendras telefono šablonas "claude-3-5-sonnet-20241022" versdavo
  // "claude-3-5-sonnet-[PHONE_REDACTED]" ir sunaikindavo modelio/kaštų auditą.
  const row = auditLog.record({
    llmProvider: "claude",
    llmModel: "claude-3-5-sonnet-20241022",
    promptVersion: "meeting_v3",
    transcriptionProvider: "faster-whisper-embedded (inline)",
    success: true,
  });

  assert.equal(row.llmModel, "claude-3-5-sonnet-20241022");
  assert.equal(row.promptVersion, "meeting_v3");
  assert.equal(row.transcriptionProvider, "faster-whisper-embedded (inline)");
});

test("diagnostikai naudingi skaičiai klaidose išlieka", () => {
  const row = auditLog.record({
    success: false,
    error: "Whisper failed at 2026-07-29 13:09:51 after 12345678 ms",
  });

  assert.match(row.error, /2026-07-29 13:09:51/);
  assert.match(row.error, /12345678 ms/);
});

test("URL kelias slepiamas, bet hostas lieka matomas", () => {
  const row = auditLog.record({
    success: false,
    error: "connect ECONNREFUSED 10.0.0.5:8001 calling http://pyannote:8001/diarize",
  });

  assert.match(row.error, /http:\/\/pyannote:8001\/\[PATH_REDACTED\]/);
  assert.match(row.error, /\[IP_REDACTED\]/);
  assert.doesNotMatch(row.error, /10\.0\.0\.5/);
});

test("audito ID nesikartoja po ištrynimo", () => {
  const a = auditLog.record({ jobId: "a", success: true });
  auditLog.record({ jobId: "b", success: true });
  auditLog.removeBySubjectIdentifier("b");
  const c = auditLog.record({ jobId: "c", success: true });

  const ids = auditLog.getAll().map((entry) => entry.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(c.id > a.id);
});

test("getAll() taiko retenciją ir be naujų įrašų", () => {
  // Anksčiau purgeExpired() buvo kviečiamas TIK iš record(), tad nustojus
  // srautui pasenę įrašai likdavo matomi per GET /api/audit.
  process.env.AUDIT_RETENTION_DAYS = "1";

  auditLog.record({ jobId: "senas", success: true });
  assert.equal(auditLog.getAll().length, 1);

  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 24 * 60 * 60 * 1000;

  try {
    assert.equal(auditLog.getAll().length, 0);
  } finally {
    Date.now = realNow;
  }
});

test("AUDIT_MAX_ENTRIES riboja žurnalo dydį", () => {
  process.env.AUDIT_MAX_ENTRIES = "3";

  for (let i = 0; i < 10; i += 1) {
    auditLog.record({ jobId: `job-${i}`, success: true });
  }

  assert.equal(auditLog.getAll().length, 3);
});
