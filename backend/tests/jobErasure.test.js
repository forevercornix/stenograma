const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.NODE_ENV = "test";
delete process.env.PRIVACY_MODE;

/**
 * Vienetiniai utils/jobErasure.js testai su MOCK'ais.
 *
 * Maršrutų testai vykdomi inline/mock režimu, tad jie NEĮRODO svarbiausios šio
 * modulio dalies: kad pasirenkama teisinga BullMQ eilė, kad job.remove() tikrai
 * kviečiamas, kad storageKey randamas ir kad klaidos atveju NEGRĄŽINAMA
 * klaidinanti sėkmė. Čia moduliai pakeičiami per require.cache.
 */

const ROOT = path.join(__dirname, "..");
const resolve = (relative) => require.resolve(path.join(ROOT, relative));

function loadEraseJob({
  mode = "bullmq",
  transcriptionQueue = {},
  protocolQueue = {},
  fileStorage = {},
  jobStore = {},
  auditLog = {},
}) {
  const calls = {
    transcriptionRemove: [],
    protocolRemove: [],
    storageDel: [],
    jobRemove: [],
    jobUpdate: [],
    auditRemove: [],
  };

  const stubs = {
    "queues/jobRunner": { getMode: () => mode },

    "queues/transcriptionQueue": {
      removeTranscriptionJob: async (id) => {
        calls.transcriptionRemove.push(id);
        if (transcriptionQueue.throws) throw new Error(transcriptionQueue.throws);
        return transcriptionQueue.data ?? null;
      },
    },

    "queues/protocolQueue": {
      removeProtocolJob: async (id) => {
        calls.protocolRemove.push(id);
        if (protocolQueue.throws) throw new Error(protocolQueue.throws);
        return protocolQueue.data ?? null;
      },
    },

    "utils/fileStorage": {
      del: async (key) => {
        calls.storageDel.push(key);
        if (fileStorage.throws) throw new Error(fileStorage.throws);
      },
    },

    "utils/jobStore": {
      JOB_TYPES: { TRANSCRIPTION: "transcription", PROTOCOL: "protocol" },
      remove: async (id) => {
        calls.jobRemove.push(id);
        if (jobStore.throws) throw new Error(jobStore.throws);
        return jobStore.removed ?? true;
      },
      update: async (id, patch) => {
        calls.jobUpdate.push({ id, patch });
        return { id, ...patch };
      },
    },

    "utils/auditLog": {
      removeBySubjectIdentifier: async (id) => {
        calls.auditRemove.push(id);
        if (auditLog.throws) throw new Error(auditLog.throws);
        return auditLog.removed ?? 1;
      },
    },
  };

  const injected = [];
  for (const [relative, exports] of Object.entries(stubs)) {
    const resolved = resolve(relative);
    injected.push(resolved);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }

  const erasurePath = resolve("utils/jobErasure");
  delete require.cache[erasurePath];
  const { eraseJob } = require(erasurePath);

  const restore = () => {
    for (const resolved of injected) delete require.cache[resolved];
    delete require.cache[erasurePath];
  };

  return { eraseJob, calls, restore };
}

function completedJob(overrides = {}) {
  return { id: "job-1", type: "transcription", status: "completed", storageKey: null, ...overrides };
}

test("BullMQ: transkripcijos jobas šalinamas iš TRANSKRIPCIJOS eilės", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: { storageKey: "audio-key" } } },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.deepEqual(calls.transcriptionRemove, ["job-1"]);
    assert.deepEqual(calls.protocolRemove, [], "protokolo eilė neturi būti liečiama");
    assert.deepEqual(calls.storageDel, ["audio-key"]);
    assert.deepEqual(calls.jobRemove, ["job-1"]);
    assert.equal(outcome.queueJobRemoved, true);
    assert.equal(outcome.storageRemoved, true);
    assert.equal(outcome.jobRemoved, true);
    assert.equal(outcome.criticalFailure, false);
  } finally {
    restore();
  }
});

test("BullMQ: protokolo jobas šalinamas iš PROTOKOLO eilės", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    protocolQueue: { data: { payload: {} } },
  });

  try {
    const outcome = await eraseJob(completedJob({ id: "job-2", type: "protocol" }));

    assert.deepEqual(calls.protocolRemove, ["job-2"]);
    assert.deepEqual(calls.transcriptionRemove, []);
    assert.equal(outcome.type, "protocol");
    assert.equal(outcome.criticalFailure, false);
  } finally {
    restore();
  }
});

test("inline režimas: storageKey imamas iš PATIES JOBO (eilės nėra)", async () => {
  // Regresija: anksčiau storageKey buvo gaunamas TIK iš BullMQ payload'o, tad
  // inline režime likęs audio failas apskritai nebuvo randamas.
  const { eraseJob, calls, restore } = loadEraseJob({ mode: "inline" });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: "orphan-audio" }));

    assert.deepEqual(calls.transcriptionRemove, [], "inline režime eilės nėra");
    assert.deepEqual(calls.storageDel, ["orphan-audio"]);
    assert.equal(outcome.storageRemoved, true);
    assert.equal(outcome.jobRemoved, true);
  } finally {
    restore();
  }
});

test("eilės klaida: jobStore įrašas NEŠALINAMAS, pažymimas deletion_pending", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { throws: "Redis connection lost" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.jobRemoved, false);
    assert.deepEqual(calls.jobRemove, [], "įrašas turi likti, kad DELETE būtų pakartojamas");
    assert.equal(calls.jobUpdate[0].patch.deletion_pending, true);
    assert.match(outcome.errors[0], /^queue:/);
  } finally {
    restore();
  }
});

test("storage klaida: jobStore įrašas NEŠALINAMAS", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: { storageKey: "audio-key" } } },
    fileStorage: { throws: "EACCES" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.storageRemoved, false);
    assert.deepEqual(calls.jobRemove, []);
    assert.match(outcome.errors[0], /^storage:/);
  } finally {
    restore();
  }
});

test("jobStore klaida pažymima kaip kritinė", async () => {
  const { eraseJob, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: {} } },
    jobStore: { throws: "store offline" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.jobRemoved, false);
    assert.match(outcome.errors.at(-1), /^jobStore:/);
  } finally {
    restore();
  }
});

test("audito klaida NĖRA kritinė - jobo duomenys vis tiek pašalinami", async () => {
  // Audito įrašai turi tik pseudonimizuotus metaduomenis, tad jų nepašalinimas
  // neturi blokuoti paties turinio ištrynimo. Klaida raportuojama.
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: {} } },
    auditLog: { throws: "audit store offline" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, false);
    assert.equal(outcome.jobRemoved, true);
    assert.deepEqual(calls.jobRemove, ["job-1"]);
    assert.match(outcome.errors[0], /^audit:/);
  } finally {
    restore();
  }
});

test("pakartotinis ištrynimas idempotentiškas (eilėje ir store jau tuščia)", async () => {
  const { eraseJob, restore } = loadEraseJob({
    transcriptionQueue: { data: null },
    jobStore: { removed: false },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.queueJobRemoved, false);
    assert.equal(outcome.jobRemoved, false);
    assert.equal(outcome.storageRemoved, false);
    assert.equal(outcome.criticalFailure, false);
    assert.deepEqual(outcome.errors, []);
  } finally {
    restore();
  }
});

test("tipas imamas iš JOBO, ne iš iškvietimo konteksto", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    protocolQueue: { data: { payload: {} } },
  });

  try {
    await eraseJob(completedJob({ type: "protocol" }));

    assert.deepEqual(calls.protocolRemove, ["job-1"]);
    assert.deepEqual(calls.transcriptionRemove, []);
  } finally {
    restore();
  }
});
