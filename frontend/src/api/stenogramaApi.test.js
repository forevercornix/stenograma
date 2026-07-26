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
    await expect(generateProtocol({})).rejects.toThrow(/502|ne JSON/i);
  });

  it("priima application/problem+json (RFC 7807 klaidų formatą)", async () => {
    // +json variantai (pvz. application/problem+json) turi būti priimami kaip JSON,
    // ne atmesti kaip "ne JSON".
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        headers: { get: () => "application/problem+json" },
        json: () => Promise.resolve({ error: "Validacijos klaida" }),
      })
    );
    await expect(generateProtocol({})).rejects.toThrow(/Validacijos klaida/);
  });

  it("200 OK su HTML body (proxy login page) metamas kaip klaida, NE grąžinamas kaip sėkmė", async () => {
    // KRITINIS (review): reverse proxy gali grąžinti 200 OK + text/html (login page).
    // res.ok=true, tad ankstesnė logika grąžindavo {error: html} kaip SĖKMĘ, ir
    // data.protocol taptų undefined. Dabar ne-JSON VISADA metamas (visi sėkmingi API
    // atsakymai yra JSON). Ir NEišvedam viso proxy HTML vartotojui.
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        text: () => Promise.resolve("<html>Proxy login page</html>"),
      })
    );
    await expect(generateProtocol({})).rejects.toThrow(/ne JSON/i);
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

  it("abort nutraukia AKTYVŲ fetch (mock fetch reaguoja į signal)", async () => {
    // Reviewer pastaba: ankstesnis testas tikrino tik delay(), ne fetch atšaukimą.
    // Čia mock fetch pats atmeta AbortError, kai signalas nutraukiamas VYKSTANT fetch.
    const controller = new AbortController();
    global.fetch = vi.fn((url, opts) => {
      return new Promise((resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        // create atsako iškart; simuliuojam, kad abort ateina fetch metu
        if (!url.includes("/transcribe-jobs/")) {
          setTimeout(() => resolve(jsonRes({ jobId: "j1", status: "queued" })), 5);
        }
        // poll fetch niekada neatsako - laukia abort
      });
    });
    setTimeout(() => controller.abort(), 20);
    await expect(
      transcribeAudioJob({ audioFile: new Blob(["x"]), diarize: false, pollIntervalMs: 5, signal: controller.signal })
    ).rejects.toThrow(/Aborted/i);
  });

  it("sugadintas JSON su 200 OK (ok:true) metamas kaip klaida, NE grąžinamas kaip sėkmė", async () => {
    // KRITINIS (review): realus scenarijus - proxy grąžina 200 OK + json content-type,
    // bet body sugadintas/tuščias. res.ok===true, tad ankstesnė logika grąžindavo
    // {error:...} kaip SĖKMĘ, ir data.protocol taptų undefined. Dabar metam klaidą.
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true, // TIKRAS 200 (ne prieštaringas ok:false/status:200)
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
      })
    );
    await expect(generateProtocol({})).rejects.toThrow(/neteisingas JSON/i);
  });
});
