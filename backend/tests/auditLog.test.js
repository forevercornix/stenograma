const test = require("node:test");
const assert = require("node:assert/strict");

const auditLog = require("../utils/auditLog");

test.beforeEach(() => {
  auditLog.clear();
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
