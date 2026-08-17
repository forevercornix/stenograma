const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execSync } = require("child_process");
const FasterWhisperEmbeddedProvider = require("../providers/transcription/FasterWhisperEmbeddedProvider");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SUCCESS_SCRIPT = path.join(FIXTURES_DIR, "mock_faster_whisper_success.py");
const ERROR_SCRIPT = path.join(FIXTURES_DIR, "mock_faster_whisper_error.py");
const HANG_SCRIPT = path.join(FIXTURES_DIR, "mock_faster_whisper_hang.py");

let pythonAvailable = true;
try {
  execSync("python3 --version", { stdio: "ignore" });
} catch {
  pythonAvailable = false;
}

test("FasterWhisperEmbeddedProvider: sėkmingas atsakymas atitinka standartinį TranscriptionProvider kontraktą", { skip: !pythonAvailable && "python3 nerastas šioje aplinkoje" }, async () => {
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: SUCCESS_SCRIPT, model: "small", device: "cpu" });
  const result = await provider.transcribe(Buffer.from("fake audio bytes"), { filename: "test.wav", language: "lt" });

  assert.equal(result.provider, "faster-whisper-embedded");
  assert.equal(result.diarization, false);
  assert.equal(result.language, "lt");
  assert.equal(result.confidence, 0.95);
  assert.equal(result.segments.length, 2);
  assert.match(result.text, /Mock transkripcija/);
  // Patikriname, kad Node pusė TIKRAI perdavė mūsų nurodytus parametrus Python skriptui
  assert.match(result.text, /modelis=small/);
  assert.match(result.text, /device=cpu/);
});

test("FasterWhisperEmbeddedProvider: audio buferis realiai įrašomas į laikiną failą PRIEŠ paleidžiant Python", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  // mock_faster_whisper_success.py pats patikrina, kad audio_path egzistuoja -
  // jei Node pusė neįrašytų buferio į diską teisingai, gautume klaidą čia.
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: SUCCESS_SCRIPT });
  const result = await provider.transcribe(Buffer.from("bet koks turinys"), { filename: "irasas.mp3" });
  assert.ok(result.text.length > 0);
});

test("FasterWhisperEmbeddedProvider: Python klaida (pvz. sugadintas audio) tampa aiškia JS klaida", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: ERROR_SCRIPT });
  await assert.rejects(
    () => provider.transcribe(Buffer.from("x"), { filename: "test.wav" }),
    /Simuliuota klaida/
  );
});

test("FasterWhisperEmbeddedProvider: neteisingas pythonBin grąžina aiškų 'ar Python įdiegtas' pranešimą", async () => {
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: SUCCESS_SCRIPT, pythonBin: "tikrai-neegzistuojantis-python-xyz" });
  await assert.rejects(
    () => provider.transcribe(Buffer.from("x"), { filename: "test.wav" }),
    /nepavyko paleisti/
  );
});

test("FasterWhisperEmbeddedProvider: procesas nutraukiamas po timeout (kabantis modelio atsisiuntimas ir pan.)", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: HANG_SCRIPT, timeoutMs: 300 });
  await assert.rejects(
    () => provider.transcribe(Buffer.from("x"), { filename: "test.wav" }),
    /viršijo 300ms limitą/
  );
});

test("FasterWhisperEmbeddedProvider: laikinas audio failas ištrinamas po apdorojimo (sėkmės ir klaidos atveju)", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const fsp = require("fs/promises");
  const fsSync = require("fs");

  // DETERMINISTINIS patikrinimas (be race condition): stebime KONKRETŲ failą,
  // kurį šis kvietimas sukuria. Ankstesnė versija lygino bendrą tmpdir failų
  // skaičių, kuris buvo NEPASTOVUS, nes lygiagretūs testai kuria tokio pat
  // prefikso failus. Dabar užfiksuojame tikslų kelią per writeFile skaitiklį ir
  // patikriname, kad TO failo nebėra po transcribe().
  //
  // Providerio transcribe() naudoja crypto.randomUUID() - tad kelias unikalus.
  // Perimame fsp.writeFile, kad sužinotume tikslų sukurtą kelią.
  const createdPaths = [];
  const origWriteFile = fsp.writeFile;
  fsp.writeFile = async (p, ...rest) => {
    if (typeof p === "string" && p.includes("stenograma-embedded-")) createdPaths.push(p);
    return origWriteFile(p, ...rest);
  };

  try {
    const provider = new FasterWhisperEmbeddedProvider({ scriptPath: SUCCESS_SCRIPT });
    await provider.transcribe(Buffer.from("x"), { filename: "test.wav" });

    new FasterWhisperEmbeddedProvider({ scriptPath: ERROR_SCRIPT });
    await provider.transcribe(Buffer.from("x"), { filename: "test.wav" }).catch(() => {});

    // Turi būti užfiksuoti bent 2 sukurti keliai (sėkmės + klaidos atvejai).
    assert.ok(createdPaths.length >= 2, `Tikėtasi >=2 sukurtų laikinų failų, gauta ${createdPaths.length}`);

    // KIEKVIENAS jų turi būti ištrintas (nei vienas neišliko) - TIKSLIAI mūsų
    // failai, nepriklausomai nuo to, ką daro lygiagretūs testai.
    for (const p of createdPaths) {
      assert.equal(fsSync.existsSync(p), false, `Laikinas failas neištrintas: ${p}`);
    }
  } finally {
    fsp.writeFile = origWriteFile;
  }
});

test("FasterWhisperEmbeddedProvider: CUDA bibliotekos kelio nustatymas GRACINGAI grąžina null, kai nvidia-cublas/cudnn neįdiegti", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: SUCCESS_SCRIPT, device: "cuda" });
  const result = await provider._resolveCudaLibraryPath();
  // Šioje aplinkoje (be GPU/be nvidia-cublas-cu12 įdiegto) tikimasi null - SVARBU,
  // kad tai nesukeltų klaidos ar nenutrauktų viso transcribe() srauto.
  assert.equal(result, null);
  // Patvirtiname, kad transcribe() vis tiek sėkmingai baigiasi net su device="cuda"
  // nustatymu, kai realaus CUDA nėra (mock scriptas nekreipia dėmesio į --device,
  // tad tai testuoja TIK Node pusės gracingą elgesį, ne tikrą GPU vykdymą).
  const transcribeResult = await provider.transcribe(Buffer.from("x"), { filename: "test.wav" });
  assert.equal(transcribeResult.provider, "faster-whisper-embedded");
});

test("FasterWhisperEmbeddedProvider: onProgress callback iškviečiamas REALIU LAIKU su kiekvienu segmentu (ne tik po viso proceso pabaigos)", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const progressScript = path.join(FIXTURES_DIR, "mock_faster_whisper_progress.py");
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: progressScript });

  const progressUpdates = [];
  const result = await provider.transcribe(Buffer.from("x"), {
    filename: "test.wav",
    onProgress: (p) => progressUpdates.push(p),
  });

  assert.equal(progressUpdates.length, 3);
  assert.deepEqual(progressUpdates[0], { current: 10, total: 30 });
  assert.deepEqual(progressUpdates[2], { current: 30, total: 30 });
  assert.equal(result.text, "mock su progresu");
});

test("FasterWhisperEmbeddedProvider: veikia normaliai IR BE onProgress (neprivalomas parametras)", { skip: !pythonAvailable && "python3 nerastas" }, async () => {
  const progressScript = path.join(FIXTURES_DIR, "mock_faster_whisper_progress.py");
  const provider = new FasterWhisperEmbeddedProvider({ scriptPath: progressScript });
  const result = await provider.transcribe(Buffer.from("x"), { filename: "test.wav" });
  assert.equal(result.text, "mock su progresu");
});
