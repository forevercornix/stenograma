import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchHealth,
  fetchReadiness,
  generateProtocol,
  transcribeAudioJob,
  withApiKeyHeader,
} from "./stenogramaApi";

// Tiesioginiai API modulio unit testai (ne per App komponentą). Dengia: API key header,
// 4xx/5xx apdorojimą, polling completed/failed/maxPolls, onProgress, abort, ne-JSON.

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: () => Promise.resolve(body),
  };
}

function textRes(text, { ok = false, status = 502 } = {}) {
  return {
    ok,
    status,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
    text: () => Promise.resolve(text),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("withApiKeyHeader", () => {
  it("be VITE_API_KEY nieko neprideda", () => {
    // VITE_API_KEY teste nenustatytas -> tuščias -> grąžina originalius headers.
    const h = withApiKeyHeader({ "Content-Type": "application/json" });
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["Content-Type"]).toBe("application/json");
  });
});

describe("fetchHealth / fetchReadiness", () => {
  it("fetchHealth grąžina JSON kai 200", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonRes({ status: "ok" })));
    const data = await fetchHealth();
    expect(data.status).toBe("ok");
  });

  it("fetchReadiness meta klaidą kai 503 (neparuošta)", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonRes({ ready: false }, { ok: false, status: 503 })));
    await expect(fetchReadiness()).rejects.toThrow(/neparuoštas/i);
  });
});

describe("generateProtocol", () => {
  it("grąžina protocol kai 200", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonRes({ protocol: { pavadinimas: "X" }, meta: {} })));
    const data = await generateProtocol({ title: "T", date: "2025", participants: [], transcript: "x" });
    expect(data.protocol.pavadinimas).toBe("X");
  });

  it("meta klaidą su serverio žinute kai 4xx/5xx", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonRes({ error: "Trūksta lauko" }, { ok: false, status: 400 })));
    await expect(generateProtocol({})).rejects.toThrow(/Trūksta lauko/);
  });

  it("ne-JSON atsakymą (HTML 502) apdoroja informatyviai, ne 'Unexpected token'", async () => {
    global.fetch = vi.fn(() => Promise.resolve(textRes("<html>502 Bad Gateway</html>", { ok: false, status: 502 })));
    await expect(generateProtocol({})).rejects.toThrow(/502|Bad Gateway/);
  });
});

describe("transcribeAudioJob polling", () => {
  it("baigiasi kai job completed, grąžina rezultatą", async () => {
    let poll = 0;
    global.fetch = vi.fn((url) => {
      if (url.includes("/transcribe-jobs/")) {
        poll++;
        return Promise.resolve(jsonRes({ status: poll >= 2 ? "completed" : "processing", result: { text: "ok" } }));
      }
      return Promise.resolve(jsonRes({ jobId: "j1", status: "queued" }));
    });
    const job = await transcribeAudioJob({ audioFile: new Blob(["x"]), diarize: false, pollIntervalMs: 1 });
    expect(job.status).toBe("completed");
    expect(job.result.text).toBe("ok");
  });

  it("meta klaidą kai job failed", async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes("/transcribe-jobs/")) {
        return Promise.resolve(jsonRes({ status: "failed", error: "Modelis krito" }));
      }
      return Promise.resolve(jsonRes({ jobId: "j1", status: "queued" }));
    });
    await expect(
      transcribeAudioJob({ audioFile: new Blob(["x"]), diarize: false, pollIntervalMs: 1 })
    ).rejects.toThrow(/Modelis krito/);
  });

  it("onProgress kviečiamas kiekvieno poll'o metu", async () => {
    let poll = 0;
    global.fetch = vi.fn((url) => {
      if (url.includes("/transcribe-jobs/")) {
        poll++;
        return Promise.resolve(jsonRes({ status: poll >= 3 ? "completed" : "processing", result: { text: "ok" } }));
      }
      return Promise.resolve(jsonRes({ jobId: "j1", status: "queued" }));
    });
    const seen = [];
    await transcribeAudioJob({
      audioFile: new Blob(["x"]),
      diarize: false,
      pollIntervalMs: 1,
      onProgress: (j) => seen.push(j.status),
    });
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it("viršijus maxPolls meta 'užtruko per ilgai'", async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes("/transcribe-jobs/")) {
        return Promise.resolve(jsonRes({ status: "processing" })); // niekada nebaigia
      }
      return Promise.resolve(jsonRes({ jobId: "j1", status: "queued" }));
    });
    await expect(
      transcribeAudioJob({ audioFile: new Blob(["x"]), diarize: false, pollIntervalMs: 1, maxPolls: 3 })
    ).rejects.toThrow(/per ilgai/i);
  });

  it("abort signalas nutraukia polling'ą (AbortError)", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn((url) => {
      if (url.includes("/transcribe-jobs/")) {
        controller.abort(); // nutraukiam per pirmą poll'ą
        return Promise.resolve(jsonRes({ status: "processing" }));
      }
      return Promise.resolve(jsonRes({ jobId: "j1", status: "queued" }));
    });
    await expect(
      transcribeAudioJob({
        audioFile: new Blob(["x"]),
        diarize: false,
        pollIntervalMs: 50,
        signal: controller.signal,
      })
    ).rejects.toThrow(/Aborted/i);
  });
});
