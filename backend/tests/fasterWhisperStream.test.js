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
    sse(res, "started", {});
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

test("'started' event draudžia fallback net BE progreso (krito po started, prieš 1-ą segmentą)", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    if (req.url.endsWith("/transcribe-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "started", {});
      // krinta iškart po started, be jokio progreso ir be done
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
    "po 'started' fallback draudžiamas, net be progreso"
  );

  delete process.env.WHISPER_STREAM_PROGRESS;
  srv.close();
});

test("SSE error event su JSON grąžina žmogui skaitomą žinutę (ne visą JSON)", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "error", { error: "Serveris užimtas" });
    res.end();
  });
  process.env.WHISPER_STREAM_PROGRESS = "true";

  const provider = new FasterWhisperProvider({ url });
  await assert.rejects(
    () => provider.transcribe(Buffer.from("x".repeat(1000)), { onProgress: () => {} }),
    (e) => {
      assert.ok(e.message.includes("Serveris užimtas"), "žinutė ištraukta iš JSON");
      assert.ok(!e.message.includes("{"), "ne visa JSON eilutė");
      return true;
    }
  );

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

/* ══════════════════════════════════════════════════════════════════════════
 * #153: DYDŽIO RIBOS SRAUTO KELYJE
 * ══════════════════════════════════════════════════════════════════════════ */

test("#153 RAM: nutraukiamas NEBAIGTAS SSE įvykis (MAX_STREAM_BUFFER_BYTES)", async () => {
  /**
   * TIKROJI RAM GARANTIJA.
   *
   * ⚠️ ANKSTESNĖ TESTO VERSIJA NIEKO NEĮRODĖ. Ji siuntė daug PILNŲ `progress`
   * įvykių ir tikrino kaupiamą skaitiklį – bet pilni įvykiai iš buferio
   * pašalinami iškart, tad buferio maksimumas tokiu atveju yra 0 baitų.
   * Išmatuota: 50 įvykių po 2 KB → cumul 101 600, buferio maksimumas 0.
   *
   * Čia serveris pradeda VIENĄ įvykį ir jo NEUŽBAIGIA (`\n\n` nesiunčia),
   * o balastą pila gabalais. Be ribos `buffer` augtų neribotai – tai tiksliai
   * tas atvejis, kai patologinis `done` su 50 000 segmentų sukauptų visą JSON
   * prieš `JSON.parse`.
   */
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: started\ndata: {}\n\n");

    // NEBAIGTAS įvykis: antraštė be terminuojančio tuščios eilutės.
    res.write('event: done\ndata: {"text":"');
    const timer = setInterval(() => res.write("x".repeat(4000)), 1);
    res.on("close", () => clearInterval(timer));
  });

  process.env.WHISPER_STREAM_PROGRESS = "true";
  process.env.MAX_STREAM_BUFFER_BYTES = "20000";

  try {
    const provider = new FasterWhisperProvider({ url });

    /**
     * Savas laikmatis SĄMONINGAI: be ribos serveris niekada nebaigia, tad
     * testas ne KRISTŲ, o UŽSTRIGTŲ – ir mutacijos patikra nieko neparodytų.
     */
    const laikmatis = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TESTAS UŽSTRIGO: riba nesuveikė per 5 s")), 5000)
    );

    await assert.rejects(
      () =>
        Promise.race([
          provider.transcribe(Buffer.from("x".repeat(1000)), { onProgress: () => {} }),
          laikmatis,
        ]),
      (e) => e.name === "ResultLimitError" && e.kind === "stream_buffer_bytes",
      "turi kristi dėl NEBAIGTO įvykio dydžio"
    );
  } finally {
    delete process.env.MAX_STREAM_BUFFER_BYTES;
    srv.close();
  }
});

test("#153 KVOTA: daug PILNŲ įvykių neaugina buferio, bet kvotą viršija", async () => {
  /**
   * Antra riba matuoja KITĄ dalyką: kaupiamus transporto baitus. Ji NĖRA RAM
   * apsauga – ji riboja begalinį srautą (serverį, kuris siunčia `progress`
   * amžinai ir niekada nebaigia).
   *
   * Testas sąmoningai siunčia PILNUS įvykius: jie buferio neaugina, tad
   * `STREAM_BUFFER_BYTES` nesuveiktų, o `STREAM_TOTAL_BYTES` – suveikia.
   * Būtent tuo abi ribos ir skiriasi.
   */
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "started", {});
    const timer = setInterval(() => sse(res, "progress", { percent: 1, b: "x".repeat(2000) }), 1);
    res.on("close", () => clearInterval(timer));
  });

  process.env.WHISPER_STREAM_PROGRESS = "true";
  process.env.MAX_STREAM_TOTAL_BYTES = "20000";
  process.env.MAX_STREAM_BUFFER_BYTES = "10000000"; // aukšta – kad neuždengtų kvotos

  try {
    const provider = new FasterWhisperProvider({ url });
    const laikmatis = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TESTAS UŽSTRIGO: kvota nesuveikė per 5 s")), 5000)
    );

    await assert.rejects(
      () =>
        Promise.race([
          provider.transcribe(Buffer.from("x".repeat(1000)), { onProgress: () => {} }),
          laikmatis,
        ]),
      (e) => e.name === "ResultLimitError" && e.kind === "stream_total_bytes",
      "kvota turi suveikti net kai buferis mažas"
    );
  } finally {
    delete process.env.MAX_STREAM_TOTAL_BYTES;
    delete process.env.MAX_STREAM_BUFFER_BYTES;
    srv.close();
  }
});

test("#153 POST-RESPONSE: per daug segmentų `done` įvykyje atmetama", async () => {
  /**
   * Segmentai ateina TIK terminaliame `done` įvykyje (`server.py` kaupia juos
   * serverio pusėje), tad ši riba yra post-response. Ji saugo downstream –
   * store ir protokolo generavimą – ne kliento RAM.
   */
  const segments = Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1, text: "a" }));
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "started", {});
    sse(res, "done", { text: "a", segments, language: "lt" });
    res.end();
  });

  process.env.WHISPER_STREAM_PROGRESS = "true";
  process.env.MAX_SEGMENTS = "10";

  try {
    const provider = new FasterWhisperProvider({ url });
    await assert.rejects(
      () => provider.transcribe(Buffer.from("x".repeat(100)), { onProgress: () => {} }),
      (e) => e.name === "ResultLimitError" && e.kind === "transcription_segments"
    );
  } finally {
    delete process.env.MAX_SEGMENTS;
    srv.close();
  }
});

test("#153 POST-RESPONSE: transkripcijos baitai matuojami UTF-8, ne simboliais", async () => {
  /**
   * Lietuviškas tekstas: 200 simbolių = 400 baitų. Su `.length` matu riba
   * 300 nebūtų viršyta, su baitų matu – viršyta. Regresija prieš `.length`.
   */
  const tekstas = "ą".repeat(200);
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "started", {});
    sse(res, "done", { text: tekstas, segments: [], language: "lt" });
    res.end();
  });

  process.env.WHISPER_STREAM_PROGRESS = "true";
  process.env.MAX_TRANSCRIPT_BYTES = "300";

  try {
    const provider = new FasterWhisperProvider({ url });
    await assert.rejects(
      () => provider.transcribe(Buffer.from("x".repeat(100)), { onProgress: () => {} }),
      (e) => e.name === "ResultLimitError" && e.kind === "transcript_bytes" && e.actual === 400
    );
  } finally {
    delete process.env.MAX_TRANSCRIPT_BYTES;
    srv.close();
  }
});

test("#153 NORMALUS srautas su numatytomis ribomis praeina (regresija)", async () => {
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    sse(res, "started", {});
    sse(res, "progress", { percent: 50 });
    sse(res, "done", { text: "labas pasauli", segments: [{ start: 0, end: 1, text: "labas" }], language: "lt" });
    res.end();
  });

  process.env.WHISPER_STREAM_PROGRESS = "true";
  try {
    const provider = new FasterWhisperProvider({ url });
    const r = await provider.transcribe(Buffer.from("x".repeat(1000)), { onProgress: () => {} });
    assert.equal(r.text, "labas pasauli", "numatytos ribos neturi pertraukti normalaus srauto");
  } finally {
    srv.close();
  }
});

test("#153 NON-STREAM: turinio ribos veikia ir su WHISPER_STREAM_PROGRESS=false", async () => {
  /**
   * KRITINIS ATVEJIS: numatytoji konfigūracija.
   *
   * `WHISPER_STREAM_PROGRESS` numatytai IŠJUNGTA, tad įprastas `/transcribe`
   * kelias yra pagrindinis. Anksčiau `MAX_TRANSCRIPT_BYTES` ir `MAX_SEGMENTS`
   * buvo tikrinami TIK streaming šakoje – vadinasi numatytoje konfigūracijoje
   * jie neveikdavo visai, nors dokumentuoti kaip bendros rezultatų ribos.
   *
   * Ribos elgesys negali priklausyti nuo transporto režimo pasirinkimo.
   */
  const segments = Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1, text: "a" }));
  const { srv, url } = await startMockServer((req, res) => {
    assert.ok(!req.url.endsWith("/transcribe-stream"), "turi eiti ĮPRASTU keliu");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "a", segments, language: "lt" }));
  });

  delete process.env.WHISPER_STREAM_PROGRESS; // numatytoji būsena
  process.env.MAX_SEGMENTS = "10";

  try {
    const provider = new FasterWhisperProvider({ url });
    await assert.rejects(
      () => provider.transcribe(Buffer.from("x".repeat(100)), {}),
      (e) => e.name === "ResultLimitError" && e.kind === "transcription_segments",
      "riba turi veikti ir be streaming"
    );
  } finally {
    delete process.env.MAX_SEGMENTS;
    srv.close();
  }
});

test("#153 NON-STREAM: transkripcijos baitai matuojami ir įprastame kelyje", async () => {
  const tekstas = "ą".repeat(200); // 400 baitų
  const { srv, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: tekstas, segments: [], language: "lt" }));
  });

  delete process.env.WHISPER_STREAM_PROGRESS;
  process.env.MAX_TRANSCRIPT_BYTES = "300";

  try {
    const provider = new FasterWhisperProvider({ url });
    await assert.rejects(
      () => provider.transcribe(Buffer.from("x".repeat(100)), {}),
      (e) => e.kind === "transcript_bytes" && e.actual === 400
    );
  } finally {
    delete process.env.MAX_TRANSCRIPT_BYTES;
    srv.close();
  }
});
