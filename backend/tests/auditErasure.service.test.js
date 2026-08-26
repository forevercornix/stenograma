const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.LLM_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.NODE_ENV = "test";
delete process.env.PRIVACY_MODE;

const auditLog = require("../utils/auditLog");
const { transcribeAudio } = require("../services/transcriptionService");
const { generateProtocol } = require("../services/protocolService");

/**
 * REGRESIJOS TESTAS pagrindinei šakos klaidai.
 *
 * auditLog.subjectId skaičiuojamas iš (jobId ?? meetingId), o
 * removeBySubjectIdentifier(job.id) ieško pagal JOB id. Bet servisai rašydavo
 * tik neprivalomą meetingId, tad realiame sraute ištrynimas nieko nerasdavo.
 *
 * Ankstesnis maršruto testas to nepagavo, nes PATS sukurdavo audito įrašą su
 * jobId - t. y. tikrindavo ne tą kelią, kuris veikia produkcijoje. Šie testai
 * eina per tikras servisų funkcijas (būtent jas kviečia queues/processors.js).
 */

// Minimalus WAV antraštės buferis - kad praeitų detectAudioMagic patikrą.
function wavBuffer() {
  const buffer = Buffer.alloc(64);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WAVE", 8, "ascii");
  return buffer;
}

test("transcribeAudio() susieja audito įrašą su jobId, tad jį galima ištrinti", async () => {
  auditLog.clear();

  const jobId = "job-transcribe-erasure";

  await transcribeAudio({
    buffer: wavBuffer(),
    filename: "irasas.wav",
    mimeType: "audio/wav",
    language: "lt",
    diarize: false,
    jobId,
  });

  const entries = (await auditLog.getAll());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].subjectId, auditLog.pseudonymizeIdentifier(jobId));
  assert.notEqual(entries[0].subjectId, jobId, "ID turi būti pseudonimizuotas");

  assert.equal(await auditLog.removeBySubjectIdentifier(jobId), 1);
  assert.equal((await auditLog.getAll()).length, 0);
});

test("generateProtocol() susieja audito įrašą su jobId", async () => {
  auditLog.clear();

  const jobId = "job-protocol-erasure";

  await generateProtocol({
    title: "Testinis posėdis",
    transcript:
      "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita iki penktadienio.",
    jobId,
  });

  const entries = (await auditLog.getAll());
  assert.ok(entries.length >= 1);
  assert.ok(
    entries.every(
      (entry) => entry.subjectId === auditLog.pseudonymizeIdentifier(jobId)
    )
  );

  assert.ok((await auditLog.removeBySubjectIdentifier(jobId)) >= 1);
  assert.equal((await auditLog.getAll()).length, 0);
});

test("nesėkmingas transkribavimas irgi susiejamas su jobId", async () => {
  auditLog.clear();

  const jobId = "job-magic-bytes";

  await assert.rejects(
    transcribeAudio({
      buffer: Buffer.from("ne audio turinys"),
      filename: "irasas.wav",
      mimeType: "audio/wav",
      jobId,
    })
  );

  /**
   * DU įrašai: atmesto įkėlimo įvykis (GDPR #17) ir transkribavimo nesėkmė.
   * Abu susieti su tuo pačiu jobId, tad abu pašalinami ištrynus subjektą -
   * nesusietas įvykis būtų neištrinamas įrašas apie asmens veiksmą.
   */
  const entries = (await auditLog.getAll());
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.event === "UPLOAD_REJECTED" && e.outcome === "signature_mismatch"));
  assert.ok(entries.some((e) => e.result === "failure"));
  assert.equal(await auditLog.removeBySubjectIdentifier(jobId), 2);
});
