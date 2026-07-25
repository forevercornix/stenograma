const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const FasterWhisperProvider = require("../providers/transcription/FasterWhisperProvider");

// Šie testai naudoja MOCK HTTP serverį, imituojantį whisper-server SSE atsakymus.
// Jie tikrina backend PROVIDER pusę (SSE skaitymą, progresą, fallback, mid-stream
// nutrūkimą) - be realaus GPU/faster-whisper. Realus /transcribe-stream serverio
// elgesys (semaforas, temp valymas) tikrinamas RunPod'e - žr. RUNPOD.md.

function startMockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${port}/transcribe` });
    });
  });
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

test("SSE kontraktas: progress event'ai kviečia onProgress, done grąžina rezultatą", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    assert.ok(req.url.endsWith("/transcribe-stream"), "turi kviesti /transcribe-stream");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "progress", { percent: 25, processedSec: 60, totalSec: 240 });
    sse(res, "progress", { percent: 50, processedSec: 120, totalSec: 240 });
    sse(res, "done", { text: "labas", segments: [{ start: 0, end: 1, text: "labas" }], language: "lt" });
    res.end();
  });
  process.env.WHISPER_STREAM_PROGRESS = "true";

  const seen = [];
  const provider = new FasterWhisperProvider({ url });
  const result = await provider.transcribe(Buffer.from("x".repeat(1000)), {
    onProgress: (p) => seen.push(p.percent),
  });

  assert.deepEqual(seen, [25, 50], "onProgress gauna abu progresus");
  assert.equal(result.text, "labas");
  assert.equal(result.segments.length, 1);
  delete process.env.WHISPER_STREAM_PROGRESS;
  srv.close();
});

test("Fallback SAUGUS: jei streaming krinta ANKSTI (be progreso), grįžta į /transcribe", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    if (req.url.endsWith("/transcribe-stream")) {
      // krinta iškart, be jokio progreso
      res.writeHead(500);
      res.end();
    } else {
      // įprastas /transcribe pavyksta
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "fallback ok", segments: [], language: "lt" }));
    }
  });
  process.env.WHISPER_STREAM_PROGRESS = "true";

  const provider = new FasterWhisperProvider({ url });
  const result = await provider.transcribe(Buffer.from("x".repeat(1000)), {
    onProgress: () => {},
  });
  assert.equal(result.text, "fallback ok", "turi grįžti į įprastą kelią");

  delete process.env.WHISPER_STREAM_PROGRESS;
  srv.close();
});

test("Fallback NESAUGUS: jei streaming krinta ĮPUSĖJUS (po progreso), NEKARTOJA - meta klaidą", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    if (req.url.endsWith("/transcribe-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "progress", { percent: 40, processedSec: 96, totalSec: 240 });
      // nutrūksta be 'done' - imituojam mid-stream crash (su mažu delsu, kad progress
      // event spėtų nukeliauti pas klientą prieš nutrūkimą).
      setTimeout(() => res.destroy(), 50);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "NETURI BŪTI KVIESTA", segments: [], language: "lt" }));
    }
  });
  process.env.WHISPER_STREAM_PROGRESS = "true";

  const provider = new FasterWhisperProvider({ url });
  await assert.rejects(
    () => provider.transcribe(Buffer.from("x".repeat(1000)), { onProgress: () => {} }),
    /įpusėjus|nutr/i,
    "turi mesti klaidą, ne kartoti viso darbo"
  );

  delete process.env.WHISPER_STREAM_PROGRESS;
  srv.close();
});

test("Be WHISPER_STREAM_PROGRESS - naudoja įprastą /transcribe (ne stream)", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    assert.ok(req.url.endsWith("/transcribe") && !req.url.endsWith("/transcribe-stream"),
      "turi kviesti įprastą /transcribe");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "įprastas", segments: [], language: "lt" }));
  });
  // flag išjungtas (numatyta)

  const provider = new FasterWhisperProvider({ url });
  const result = await provider.transcribe(Buffer.from("x".repeat(1000)), {
    onProgress: () => {},  // net su onProgress - be flag'o neturi streamint
  });
  assert.equal(result.text, "įprastas");
  srv.close();
});
