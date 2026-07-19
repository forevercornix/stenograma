const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execSync } = require("child_process");

// FASTER_WHISPER_MAX_CONCURRENCY skaitomas VIENĄ kartą modulio įkėlimo metu
// (module-level shared semaphore), todėl turi būti nustatytas PRIEŠ require.
process.env.FASTER_WHISPER_MAX_CONCURRENCY = "1";

const FasterWhisperEmbeddedProvider = require("../providers/transcription/FasterWhisperEmbeddedProvider");

const DELAY_SCRIPT = path.join(__dirname, "fixtures", "mock_faster_whisper_delay.py");

let pythonAvailable = true;
try {
  execSync("python3 --version", { stdio: "ignore" });
} catch {
  pythonAvailable = false;
}

test(
  "FasterWhisperEmbeddedProvider: FASTER_WHISPER_MAX_CONCURRENCY=1 serializuoja vienalaikes užklausas (apsauga nuo CPU/RAM prisotinimo)",
  { skip: !pythonAvailable && "python3 nerastas" },
  async () => {
    const provider = new FasterWhisperEmbeddedProvider({ scriptPath: DELAY_SCRIPT });

    const start = Date.now();
    // 3 vienalaikės užklausos, kiekviena "trunka" ~150ms Python skripte.
    // Su maxConcurrency=1 jos turi vykti IŠ EILĖS (~450ms+), ne lygiagrečiai (~150ms).
    await Promise.all([
      provider.transcribe(Buffer.from("a"), { filename: "a.wav" }),
      provider.transcribe(Buffer.from("b"), { filename: "b.wav" }),
      provider.transcribe(Buffer.from("c"), { filename: "c.wav" }),
    ]);
    const elapsedMs = Date.now() - start;

    // Jei serializuota - bent ~3*150ms = 450ms. Paliekame paklaidai (350ms riba),
    // kad testas nebūtų trapus lėtesnėje CI mašinoje, bet vis tiek aiškiai
    // atskirtų nuo lygiagretaus vykdymo (~150-200ms).
    assert.ok(
      elapsedMs >= 350,
      `Tikėtasi serializuoto vykdymo (>=350ms), gauta ${elapsedMs}ms - semaforas galbūt neveikia`
    );
  }
);
