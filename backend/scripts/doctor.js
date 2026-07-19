#!/usr/bin/env node
/**
 * Diagnostikos komanda: `npm run doctor`
 * Patikrina visą aplinką ir parodo aiškią ✅/⚠️/❌ ataskaitą PRIEŠ bandant
 * paleisti sistemą - vietoj to, kad problemos išlįstų po pirmos užklausos.
 * Grąžina exit code 1, jei yra kritinių (❌) problemų.
 */
require("dotenv").config();
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { validateConfig, runSelfChecks } = require("../utils/startupChecks");

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve(err ? { ok: false, out: (stderr || err.message).trim() } : { ok: true, out: stdout.trim() })
    );
  });
}

const OK = (name, detail) => ({ level: "ok", name, detail });
const WARN = (name, detail) => ({ level: "warn", name, detail });
const FAIL = (name, detail) => ({ level: "fail", name, detail });

async function main() {
  const results = [];
  const pythonBin = process.env.FASTER_WHISPER_PYTHON_BIN || "python3";

  // --- Runtime ---
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  results.push(nodeMajor >= 20 ? OK("Node.js", `v${process.versions.node}`) : FAIL("Node.js", `v${process.versions.node} - reikia >= 20`));

  const py = await run(pythonBin, ["--version"]);
  results.push(py.ok ? OK("Python", `${py.out} (per "${pythonBin}")`) : WARN("Python", `"${pythonBin}" nerastas - reikalingas TIK faster-whisper-embedded profiliui. Windows: nustatykite FASTER_WHISPER_PYTHON_BIN=python`));

  // --- faster-whisper + CUDA (tik jei Python yra) ---
  if (py.ok) {
    // 45s timeout: pirmas (šaltas) importas lėtose/1-CPU mašinose gali užtrukti
    // gerokai ilgiau nei šiltas - realiai pastebėta šioje sandbox aplinkoje.
    const fw = await run(pythonBin, ["-c", "import faster_whisper; print(faster_whisper.__version__)"], 45000);
    results.push(fw.ok ? OK("faster-whisper paketas", `v${fw.out}`) : WARN("faster-whisper paketas", `neįdiegtas - paleiskite: pip install -r scripts/requirements.txt (reikia TIK embedded profiliui)`));

    const cuda = await run(pythonBin, ["-c", "import ctranslate2; print(ctranslate2.get_cuda_device_count())"], 20000);
    if (cuda.ok) {
      const count = parseInt(cuda.out, 10);
      const wantCuda = (process.env.FASTER_WHISPER_DEVICE || "cpu") === "cuda";
      if (count > 0) results.push(OK("CUDA", `${count} GPU aptikta (ctranslate2)`));
      else results.push(wantCuda ? FAIL("CUDA", "FASTER_WHISPER_DEVICE=cuda, bet GPU neaptikta - patikrinkite nvidia-cublas-cu12/cudnn diegimą ir tvarkykles") : OK("CUDA", "GPU neaptikta (nekritiška - naudojamas device=cpu)"));
    } else if ((process.env.FASTER_WHISPER_DEVICE || "cpu") === "cuda") {
      results.push(FAIL("CUDA", `nepavyko patikrinti per ctranslate2: ${cuda.out.slice(0, 150)}`));
    }
  }

  // --- ffmpeg (nebūtinas - faster-whisper naudoja PyAV su įtrauktomis ffmpeg bibliotekomis,
  // bet naudingas fragmentų pjaustymui/diagnostikai) ---
  const ff = await run("ffmpeg", ["-version"], 8000);
  results.push(ff.ok ? OK("ffmpeg", ff.out.split("\n")[0]) : WARN("ffmpeg", "nerastas - NEBŪTINAS transkribavimui (PyAV turi savo), bet naudingas audio diagnostikai"));

  // --- Resursai ---
  const totalGB = (os.totalmem() / 1024 ** 3).toFixed(1);
  const freeGB = (os.freemem() / 1024 ** 3).toFixed(1);
  results.push(os.freemem() > 2 * 1024 ** 3 ? OK("RAM", `${freeGB}GB laisva iš ${totalGB}GB`) : WARN("RAM", `tik ${freeGB}GB laisva - small modeliui reikia ~1-2GB, medium ~3-4GB`));
  try {
    const df = await run("df", ["-BG", "--output=avail", os.tmpdir()], 8000);
    if (df.ok) {
      const availGB = parseInt(df.out.split("\n").pop(), 10);
      results.push(availGB > 5 ? OK("Diskas (tmp)", `${availGB}GB laisva`) : WARN("Diskas (tmp)", `tik ${availGB}GB - dideliems audio failams ir modeliams gali pritrūkti`));
    }
  } catch (_) { /* Windows - df nėra, praleidžiame */ }

  // --- Konfigūracija ---
  const { errors, warnings } = validateConfig();
  for (const e of errors) results.push(FAIL("Konfigūracija", e));
  for (const w of warnings) results.push(WARN("Konfigūracija", w));
  if (errors.length === 0) results.push(OK("Konfigūracija", "visi privalomi kintamieji suderinti su pasirinktais tiekėjais"));

  // --- Komponentų pasiekiamumas (ta pati logika kaip /api/health/deep) ---
  const checks = await runSelfChecks();
  for (const c of checks) results.push(c.ok ? OK(c.name, c.detail) : FAIL(c.name, c.detail));

  // --- Ataskaita ---
  console.log("\n=== Stenograma doctor ===\n");
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" };
  for (const r of results) console.log(`${icon[r.level]} ${r.name}: ${r.detail}`);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\nIš viso: ${results.length} patikrų, ${fails} kritinių problemų, ${warns} įspėjimų.`);
  if (fails > 0) {
    console.log("Ištaisykite ❌ problemas prieš paleisdami (žr. .env.example ir backend/README.md).");
    process.exit(1);
  }
  console.log(fails === 0 && warns === 0 ? "Viskas paruošta. 🎉" : "Galima paleisti; ⚠️ verta peržiūrėti.");
}

main().catch((e) => {
  console.error("doctor nulūžo:", e);
  process.exit(1);
});
