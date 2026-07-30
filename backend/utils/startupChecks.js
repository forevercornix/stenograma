/**
 * Dvi startup patikros lygmenys (vartotojo prašymas po realaus diegimo RunPod'e:
 * "programa turėtų pati pasakyti ko trūksta, o ne sugriūti po pirmos užklausos"):
 *
 * 1) validateConfig() - SINCHRONINĖ, KIETA: tikrina, ar konfigūracija apskritai
 *    logiškai suderinta (pvz. LLM_PROVIDER=claude be ANTHROPIC_API_KEY reiškia
 *    garantuotą klaidą pirmoje užklausoje). Radus klaidų, serveris NESTARTUOJA
 *    ir aiškiai išvardija, ko trūksta. SKIP_CONFIG_VALIDATION=true - avarinis
 *    apėjimas (pvz. CI ar neįprastas setup).
 *
 * 2) startupSelfCheck() - ASINCHRONINĖ, MINKŠTA: realiai patikrina pasiekiamumą
 *    (Python importas, pyannote HTTP ir pan.) ir spausdina ✅/❌ eilutes, bet
 *    NESTABDO serverio - išorinis servisas gali pasikelti vėliau.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const KNOWN_LLM = ["mock", "claude", "gpt", "gemini"];
const KNOWN_TRANSCRIPTION = [
  "mock", "whisper", "faster-whisper", "faster-whisper-server", "faster-whisper-embedded",
  "deepgram", "assemblyai", "azure", "google",
];
const KNOWN_DIARIZATION = ["none", "inline", "mock", "pyannote", "pyannote-cloud", "assemblyai"];

function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  const llm = (env.LLM_PROVIDER || "mock").toLowerCase();
  const trans = (env.TRANSCRIPTION_PROVIDER || "mock").toLowerCase();
  const diar = (env.DIARIZATION_PROVIDER || "none").toLowerCase();

  if (!KNOWN_LLM.includes(llm)) errors.push(`LLM_PROVIDER="${llm}" nežinomas. Galimi: ${KNOWN_LLM.join(", ")}`);
  if (!KNOWN_TRANSCRIPTION.includes(trans)) errors.push(`TRANSCRIPTION_PROVIDER="${trans}" nežinomas. Galimi: ${KNOWN_TRANSCRIPTION.join(", ")}`);
  if (!KNOWN_DIARIZATION.includes(diar)) errors.push(`DIARIZATION_PROVIDER="${diar}" nežinomas. Galimi: ${KNOWN_DIARIZATION.join(", ")}`);

  // LLM raktai - be jų pirmoji užklausa garantuotai kris
  if (llm === "claude" && !env.ANTHROPIC_API_KEY) errors.push("LLM_PROVIDER=claude, bet ANTHROPIC_API_KEY nenustatytas.");
  if (llm === "gpt" && !env.OPENAI_API_KEY) errors.push("LLM_PROVIDER=gpt, bet OPENAI_API_KEY nenustatytas.");
  if (llm === "gemini" && !env.GOOGLE_API_KEY) errors.push("LLM_PROVIDER=gemini, bet GOOGLE_API_KEY nenustatytas.");

  // Transkripcija
  if (trans === "whisper" && !env.OPENAI_API_KEY) errors.push("TRANSCRIPTION_PROVIDER=whisper (OpenAI), bet OPENAI_API_KEY nenustatytas.");
  if (trans === "deepgram" && !env.DEEPGRAM_API_KEY) errors.push("TRANSCRIPTION_PROVIDER=deepgram, bet DEEPGRAM_API_KEY nenustatytas.");
  if (trans === "faster-whisper-embedded") {
    const scriptPath = path.join(__dirname, "..", "scripts", "faster_whisper_transcribe.py");
    if (!fs.existsSync(scriptPath)) errors.push(`faster-whisper-embedded: nerastas ${scriptPath}`);
    const model = env.FASTER_WHISPER_MODEL || "small";
    // Jei modelis nurodytas kaip kelias (o ne HF pavadinimas) - kelias turi egzistuoti
    if ((model.includes("/") || model.includes("\\")) && !fs.existsSync(model)) {
      errors.push(
        `FASTER_WHISPER_MODEL="${model}" atrodo kaip kelias, bet toks katalogas neegzistuoja. ` +
          `Nurodykite egzistuojantį kelią ARBA HF pavadinimą (pvz. "small") - tada modelis atsisiųs automatiškai.`
      );
    }
  }

  // Diarizacija
  if (diar === "pyannote" && !env.PYANNOTE_URL) {
    warnings.push('DIARIZATION_PROVIDER=pyannote be PYANNOTE_URL - naudojamas numatytas http://localhost:8001/diarize.');
  }

  // Skaitiniai kintamieji privalo parsintis
  for (const name of ["MAX_UPLOAD_MB", "ANTHROPIC_MAX_TOKENS", "FASTER_WHISPER_EMBEDDED_TIMEOUT_MS", "RATE_LIMIT_MAX_REQUESTS", "PORT"]) {
    if (env[name] !== undefined && env[name] !== "" && Number.isNaN(parseInt(env[name], 10))) {
      errors.push(`${name}="${env[name]}" nėra skaičius.`);
    }
  }

  if (llm === "mock") warnings.push("LLM_PROVIDER=mock - demo režimas, protokolus generuoja paprasta heuristika, ne tikras AI.");
  if (env.API_KEY === undefined || env.API_KEY === "") {
    warnings.push("API_KEY nenustatytas - API atviras be autentifikacijos (tinka tik lokaliam naudojimui).");
  }

  // Audito pseudonimizacijos druska. Produkcijoje tai KIETA klaida, ne įspėjimas:
  // be jos naudojama repozitorijoje esanti vieša numatytoji reikšmė, tad bet kas,
  // žinantis ar spėjantis job/meeting ID, gali apskaičiuoti tą patį HMAC ir
  // "pseudonimizacija" nustoja ką nors saugoti.
  // SĄMONINGAI įspėjimas, ne klaida: be druskos generuojama atsitiktinė (žr.
  // utils/auditLog.js), tad viešos numatytosios reikšmės problemos nebėra ir
  // nėra pagrindo neleisti serveriui startuoti. Kieta klaida čia buvo sulaužiusi
  // dokumentuotą `docker compose up` kelią - backend image'e ENV NODE_ENV=production,
  // o druskos ten niekas nenustato, tad konteineris nebepasileisdavo.
  if (env.NODE_ENV === "production" && !env.AUDIT_ID_SALT && env.PRIVACY_MODE !== "true") {
    warnings.push(
      "AUDIT_ID_SALT nenustatytas, o NODE_ENV=production - naudojama atsitiktinė šiam " +
        "procesui sugeneruota druska. Pseudonimai nebus vienodi po perkrovimo ar kitoje " +
        "replikoje. Persistentiniam auditui nustatykite: openssl rand -hex 32."
    );
  }

  // Privatumo konfigūracija (GDPR #5) ir išorinių tiekėjų įspėjimai (GDPR #7).
  const { validatePrivacyConfig } = require("./privacyConfig");
  const privacy = validatePrivacyConfig(env);
  errors.push(...privacy.errors);
  warnings.push(...privacy.warnings);

  return { errors, warnings };
}

/**
 * Minkštos realaus pasiekiamumo patikros - grąžina masyvą {name, ok, detail}.
 * Naudojama IR startup metu (spausdinti ✅/❌), IR /api/health/deep endpoint'e,
 * IR scripts/doctor.js - viena tiesos vieta.
 */
async function runSelfChecks(env = process.env) {
  const checks = [];
  const llm = (env.LLM_PROVIDER || "mock").toLowerCase();
  const trans = (env.TRANSCRIPTION_PROVIDER || "mock").toLowerCase();
  const diar = (env.DIARIZATION_PROVIDER || "none").toLowerCase();

  // LLM: raktų buvimas (gyvo kvietimo nedarome - kainuotų pinigus kiekvieno health metu)
  if (llm === "mock") {
    checks.push({ name: "LLM (mock)", ok: true, detail: "demo režimas, raktų nereikia" });
  } else {
    const keyName = { claude: "ANTHROPIC_API_KEY", gpt: "OPENAI_API_KEY", gemini: "GOOGLE_API_KEY" }[llm];
    const present = Boolean(env[keyName]);
    checks.push({
      name: `LLM (${llm})`,
      ok: present,
      detail: present ? `${keyName} nustatytas (gyvas kvietimas netikrintas - kainuotų)` : `${keyName} NENUSTATYTAS`,
    });
  }

  // Transkripcija
  if (trans === "mock") {
    checks.push({ name: "Transkripcija (mock)", ok: true, detail: "demo režimas" });
  } else if (trans === "faster-whisper-embedded") {
    const pythonBin = env.FASTER_WHISPER_PYTHON_BIN || "python3";
    const result = await new Promise((resolve) => {
      execFile(pythonBin, ["-c", "import faster_whisper; print(faster_whisper.__version__)"], { timeout: 45000 }, (err, stdout, stderr) =>
        resolve(err ? { ok: false, detail: `"${pythonBin}" arba faster_whisper nepasiekiamas: ${(stderr || err.message).trim().slice(0, 200)}` } : { ok: true, detail: `faster-whisper ${stdout.trim()} per ${pythonBin}` })
      );
    });
    checks.push({ name: "Transkripcija (faster-whisper-embedded)", ...result });
    const model = env.FASTER_WHISPER_MODEL || "small";
    if (model.includes("/") || model.includes("\\")) {
      const exists = fs.existsSync(model);
      checks.push({ name: "Whisper modelis (lokalus kelias)", ok: exists, detail: exists ? model : `${model} NEEGZISTUOJA` });
    } else {
      checks.push({ name: "Whisper modelis (HF)", ok: true, detail: `"${model}" - atsisiųs automatiškai pirmo naudojimo metu, jei dar nėra cache` });
    }
  } else if (trans === "faster-whisper" || trans === "faster-whisper-server") {
    const url = env.FASTER_WHISPER_URL || "http://localhost:8000/transcribe";
    checks.push(await httpReachability("Transkripcija (faster-whisper serveris)", url));
  } else {
    checks.push({ name: `Transkripcija (${trans})`, ok: true, detail: "išorinis API - pasiekiamumas tikrinamas tik realios užklausos metu" });
  }

  // Diarizacija
  if (diar === "none" || diar === "inline") {
    checks.push({ name: `Diarizacija (${diar})`, ok: true, detail: diar === "none" ? "išjungta" : "per transkripcijos tiekėją" });
  } else if (diar === "pyannote") {
    const url = env.PYANNOTE_URL || "http://localhost:8001/diarize";
    checks.push(await httpReachability("Diarizacija (pyannote)", url));
  } else {
    checks.push({ name: `Diarizacija (${diar})`, ok: true, detail: "išorinis API" });
  }

  return checks;
}

// Pasiekiamumo patikra: bandome bazinį URL (be kelio) su trumpu timeout - mums
// svarbu "ar kas nors ten klauso", ne konkretaus endpoint'o atsakymas (jis gali
// grąžinti 404/405 GET'ui, bet tai VIS TIEK reiškia, kad serveris gyvas).
async function httpReachability(name, fullUrl) {
  try {
    const base = new URL(fullUrl);
    const probeUrl = `${base.protocol}//${base.host}/`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(probeUrl, { signal: controller.signal }).finally(() => clearTimeout(t));
    return { name, ok: true, detail: `${base.host} pasiekiamas (HTTP ${res.status}); pilnas endpoint: ${fullUrl}` };
  } catch (e) {
    return { name, ok: false, detail: `${fullUrl} NEPASIEKIAMAS (${e.cause?.code || e.name}): ar servisas paleistas?` };
  }
}

module.exports = { validateConfig, runSelfChecks };
