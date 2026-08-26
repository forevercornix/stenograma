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

test("pseudonymizes job identifier", async () => {
  const row = await auditLog.record({
    event: "JOB_CREATED",
    meetingId: "abc123",
    success: true,
  });

  assert.equal(row.event, "JOB_CREATED");
  assert.equal(row.result, "success");
  assert.notEqual(row.subjectId, "abc123");
  assert.equal("meetingId" in row, false);
});

test("redacts secrets and personal data from errors", async () => {
  const row = await auditLog.record({
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

test("purges audit entries older than configured retention", async () => {
  process.env.AUDIT_RETENTION_DAYS = "1";

  await auditLog.record({
    event: "JOB_CREATED",
    meetingId: "old-job",
    success: true,
  });

  const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const removed = auditLog.purgeExpired(twoDaysLater);

  assert.equal(removed, 1);
  assert.equal((await auditLog.getAll()).length, 0);

  delete process.env.AUDIT_RETENTION_DAYS;
});

test("removes audit entries belonging to a job identifier", async () => {
  await auditLog.record({
    event: "JOB_CREATED",
    jobId: "job-to-delete",
    success: true,
  });

  await auditLog.record({
    event: "JOB_CREATED",
    jobId: "job-to-keep",
    success: true,
  });

  const removed = await auditLog.removeBySubjectIdentifier("job-to-delete");

  assert.equal(removed, 1);
  assert.equal((await auditLog.getAll()).length, 1);
  assert.equal(
    (await auditLog.getAll())[0].subjectId,
    auditLog.pseudonymizeIdentifier("job-to-keep")
  );
});

test("privacy mode disables audit recording", async () => {
  process.env.PRIVACY_MODE = "true";
  auditLog.clear();

  const recorded = await auditLog.record({
    event: "JOB_CREATED",
    jobId: "privacy-job",
    success: true,
  });

  assert.equal(recorded, null);
  assert.equal((await auditLog.getAll()).length, 0);

  delete process.env.PRIVACY_MODE;
});

test("privacy mode clears previously accumulated audit entries", async () => {
  delete process.env.PRIVACY_MODE;
  auditLog.clear();

  await auditLog.record({
    event: "JOB_CREATED",
    jobId: "existing-job",
    success: true,
  });

  assert.equal((await auditLog.getAll()).length, 1);

  process.env.PRIVACY_MODE = "true";

  await auditLog.record({
    event: "JOB_CREATED",
    jobId: "ignored-job",
    success: true,
  });

  assert.equal((await auditLog.getAll()).length, 0);

  delete process.env.PRIVACY_MODE;
});

test("privacy mode is disabled by default", () => {
  delete process.env.PRIVACY_MODE;

  assert.equal(auditLog.isPrivacyModeEnabled(), false);
});

test("kontroliuojami laukai NEredaguojami kaip PII", async () => {
  // Regresija: bendras telefono šablonas "claude-3-5-sonnet-20241022" versdavo
  // "claude-3-5-sonnet-[PHONE_REDACTED]" ir sunaikindavo modelio/kaštų auditą.
  const row = await auditLog.record({
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

test("diagnostikai naudingi skaičiai klaidose išlieka", async () => {
  const row = await auditLog.record({
    success: false,
    error: "Whisper failed at 2026-07-29 13:09:51 after 12345678 ms",
  });

  assert.match(row.error, /2026-07-29 13:09:51/);
  assert.match(row.error, /12345678 ms/);
});

test("URL kelias slepiamas, bet hostas lieka matomas", async () => {
  const row = await auditLog.record({
    success: false,
    error: "connect ECONNREFUSED 10.0.0.5:8001 calling http://pyannote:8001/diarize",
  });

  assert.match(row.error, /http:\/\/pyannote:8001\/\[PATH_REDACTED\]/);
  assert.match(row.error, /\[IP_REDACTED\]/);
  assert.doesNotMatch(row.error, /10\.0\.0\.5/);
});

test("audito ID nesikartoja po ištrynimo", async () => {
  const a = await auditLog.record({ jobId: "a", success: true });
  await auditLog.record({ jobId: "b", success: true });
  await auditLog.removeBySubjectIdentifier("b");
  const c = await auditLog.record({ jobId: "c", success: true });

  const ids = (await auditLog.getAll()).map((entry) => entry.id);

  assert.equal(new Set(ids).size, ids.length);
  // UUID, ne skaitiklis: skaitiklis lieka unikalus tik vieno proceso gyvavimo
  // metu, o auditą perkėlus į SQLite/Postgres ID turi likti stabilus.
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.notEqual(a.id, c.id);
});

test("getAll() taiko retenciją ir be naujų įrašų", async () => {
  // Anksčiau purgeExpired() buvo kviečiamas TIK iš record(), tad nustojus
  // srautui pasenę įrašai likdavo matomi per GET /api/audit.
  process.env.AUDIT_RETENTION_DAYS = "1";

  await auditLog.record({ jobId: "senas", success: true });
  assert.equal((await auditLog.getAll()).length, 1);

  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 24 * 60 * 60 * 1000;

  try {
    assert.equal((await auditLog.getAll()).length, 0);
  } finally {
    Date.now = realNow;
  }
});

test("AUDIT_MAX_ENTRIES riboja žurnalo dydį", async () => {
  process.env.AUDIT_MAX_ENTRIES = "3";

  for (let i = 0; i < 10; i += 1) {
    await auditLog.record({ jobId: `job-${i}`, success: true });
  }

  assert.equal((await auditLog.getAll()).length, 3);
});

test("URL prisijungimo duomenys redaguojami bet kokioje schemoje", () => {
  // Rasta realiai: neveikiančio Redis klaidos pranešimas su pilnu connection
  // string (`redis://naudotojas:slaptas@host`) patekdavo į serverio logą.
  const cases = [
    "connect ECONNREFUSED redis://naudotojas:slaptas@10.0.0.5:6379",
    "postgres://admin:labaislaptas@db.internal:5432/stenograma",
    "amqp://guest:guest@rabbit:5672",
  ];

  for (const message of cases) {
    const sanitized = auditLog.sanitizeForLogging(new Error(message));

    assert.match(sanitized.message, /\[CREDENTIALS_REDACTED\]/);
    for (const secret of ["slaptas", "labaislaptas", "guest:guest"]) {
      assert.ok(
        !sanitized.message.includes(secret),
        `${secret} nepašalintas iš: ${sanitized.message}`
      );
    }
  }
});

test("URL be prisijungimo duomenų nekeičiamas be reikalo", () => {
  const sanitized = auditLog.sanitizeForLogging(new Error("redis://localhost:6379"));

  assert.equal(sanitized.message, "redis://localhost:6379");
  assert.doesNotMatch(sanitized.message, /REDACTED/);
});

test("be AUDIT_ID_SALT naudojama ATSITIKTINĖ druska, ne vieša numatytoji", () => {
  // Anksčiau čia buvo repozitorijoje matoma reikšmė - bet kas, žinantis job ID,
  // galėjo apskaičiuoti tą patį HMAC, tad pseudonimizacija nesaugojo nieko.
  delete process.env.AUDIT_ID_SALT;

  const viesaSenaDruska = require("node:crypto")
    .createHmac("sha256", "stenograma-local-audit-v1")
    .update("job-1")
    .digest("hex")
    .slice(0, 20);

  const actual = auditLog.pseudonymizeIdentifier("job-1");

  assert.notEqual(actual, viesaSenaDruska, "negali sutapti su vieša repo reikšme");
  assert.equal(actual, auditLog.pseudonymizeIdentifier("job-1"), "procese turi būti stabilu");
});

test("nustatytas AUDIT_ID_SALT turi pirmenybę prieš sugeneruotą", () => {
  delete process.env.AUDIT_ID_SALT;
  const generuotas = auditLog.pseudonymizeIdentifier("job-1");

  process.env.AUDIT_ID_SALT = "aiskiai-nustatyta-druska";
  const nustatytas = auditLog.pseudonymizeIdentifier("job-1");

  assert.notEqual(nustatytas, generuotas);
  assert.equal(
    nustatytas,
    require("node:crypto")
      .createHmac("sha256", "aiskiai-nustatyta-druska")
      .update("job-1")
      .digest("hex")
      .slice(0, 20)
  );

  delete process.env.AUDIT_ID_SALT;
});
