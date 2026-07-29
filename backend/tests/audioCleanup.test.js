const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.NODE_ENV = "test";

/**
 * REGRESIJOS TESTAI: audio ištrynimo klaida NEGALI prarasti storageKey.
 *
 * Anksčiau abu valymo keliai darė taip:
 *
 *   await fileStorage.del(payload.storageKey).catch(() => {});
 *   await jobStore.update(jobId, { storageKey: null }).catch(() => {});
 *
 * Nepavykus `del()`, klaida buvo nutylima, bet raktas vis tiek dingdavo iš
 * jobStore - failas likdavo storage, o vėlesnis GDPR DELETE jo nebesurasdavo.
 * Tai paneigdavo pačią garantiją, dėl kurios storageKey buvo pradėtas saugoti.
 */

const ROOT = path.join(__dirname, "..");
const resolve = (relative) => require.resolve(path.join(ROOT, relative));

function loadReleaseAudio({ delThrows = null }) {
  const calls = { del: [], update: [] };

  const stubs = {
    "utils/fileStorage": {
      del: async (key) => {
        calls.del.push(key);
        if (delThrows) throw new Error(delThrows);
      },
    },
    "utils/jobStore": {
      update: async (id, patch) => {
        calls.update.push({ id, patch });
        return { id, ...patch };
      },
    },
  };

  const injected = [];
  for (const [relative, exports] of Object.entries(stubs)) {
    const resolved = resolve(relative);
    injected.push(resolved);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }

  const cleanupPath = resolve("utils/audioCleanup");
  delete require.cache[cleanupPath];
  const { releaseAudio } = require(cleanupPath);

  return {
    releaseAudio,
    calls,
    restore: () => {
      for (const resolved of injected) delete require.cache[resolved];
      delete require.cache[cleanupPath];
    },
  };
}

test("sėkmingas trynimas: storageKey nulinamas", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({});

  try {
    const removed = await releaseAudio("job-1", "audio-key");

    assert.equal(removed, true);
    assert.deepEqual(calls.del, ["audio-key"]);
    assert.deepEqual(calls.update, [
      { id: "job-1", patch: { storageKey: null, audio_cleanup_pending: false } },
    ]);
  } finally {
    restore();
  }
});

test("NEPAVYKĘS trynimas: storageKey LIEKA + jobas pažymimas pakartojimui", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({ delThrows: "EACCES" });

  try {
    const removed = await releaseAudio("job-1", "audio-key");

    assert.equal(removed, false);
    assert.deepEqual(calls.del, ["audio-key"]);

    // Raktas turi LIKTI, o jobas - būti pažymėtas pakartojimui. Vien rakto
    // palikimo neužtenka: be vėliavos nebaigto valymo niekas nepamatytų ir po
    // jobStore TTL nuoroda į failą dingtų.
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].patch.audio_cleanup_pending, true);
    assert.equal(calls.update[0].patch.storageKey, "audio-key");
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "storageKey neturi būti nulinamas"
    );
  } finally {
    restore();
  }
});

test("be storageKey - jokių šalutinių veiksmų", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({});

  try {
    assert.equal(await releaseAudio("job-1", null), false);
    assert.deepEqual(calls.del, []);
    assert.deepEqual(calls.update, []);
  } finally {
    restore();
  }
});

/**
 * Tie patys du scenarijai per TIKRUS iškvietimo taškus - kad testas liktų
 * prasmingas net jei kas nors vėl įrašytų valymo logiką tiesiai į runner'į.
 */
test("inline runner: cleanup klaidos atveju storageKey lieka", async () => {
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  const runnerPath = resolve("queues/jobRunner");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, runnerPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        throw new Error("storage down");
      },
    },
  };

  const jobs = new Map();
  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { QUEUED: "queued", PROCESSING: "processing", COMPLETED: "completed", FAILED: "failed" },
      update: async (id, patch) => {
        calls.update.push({ id, patch });
        jobs.set(id, { ...(jobs.get(id) || { id }), ...patch });
        return jobs.get(id);
      },
    },
  };

  try {
    const jobRunner = require(runnerPath);
    jobRunner.registerProcessor("transcription", async () => ({ text: "ok" }));

    await jobRunner._runInline("transcription", "job-inline", { storageKey: "audio-key" });

    assert.deepEqual(calls.del, ["audio-key"]);
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "nepavykus trynimui storageKey neturi būti nulinamas"
    );
    assert.ok(
      calls.update.some((call) => call.patch.audio_cleanup_pending === true),
      "jobas turi būti pažymėtas audio valymo pakartojimui"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, runnerPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});

test("worker cleanup: klaidos atveju storageKey lieka", async () => {
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  const workersPath = resolve("workers/index");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, workersPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        throw new Error("storage down");
      },
    },
  };

  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { COMPLETED: "completed", FAILED: "failed", PROCESSING: "processing" },
      update: async (id, patch) => {
        calls.update.push({ id, patch });
        return { id, ...patch };
      },
    },
  };

  try {
    const { _cleanupStorage } = require(workersPath);

    await _cleanupStorage({ storageKey: "audio-key" }, "job-worker");

    assert.deepEqual(calls.del, ["audio-key"]);
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "worker'yje nepavykus trynimui storageKey neturi būti nulinamas"
    );
    assert.ok(
      calls.update.some((call) => call.patch.audio_cleanup_pending === true),
      "jobas turi būti pažymėtas audio valymo pakartojimui"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, workersPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});
