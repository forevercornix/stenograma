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
const { KNOWN_ROLES } = require("./credentials");

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

  /**
   * AUTENTIFIKACIJOS KONFIGŪRACIJA (#18 PR1).
   *
   * `AUTH_USERS` yra NEPRIVALOMAS šiame etape (žr. utils/credentials.js
   * komentarą - PR1 dar nekeičia esamų maršrutų apsaugos). Bet jei jis
   * NUSTATYTAS, formatas turi būti teisingas VISADA, nepriklausomai nuo
   * aplinkos - blogai suformuotas įrašas reikštų, kad administratorius mano
   * turintis veikiantį vartotoją, kurio realiai nėra.
   */
  try {
    require("./credentials").loadUsers(env);
  } catch (e) {
    errors.push(e.message);
  }

  /**
   * SESIJOS LAIKO LIMITAI - ta pati logika kaip kitos skaitinės saugumo
   * nuostatos (žr. securityBaseline.js requirePositiveInt): netinkama reikšmė
   * turi stabdyti startą, o ne tyliai virsti NaN ir duoti nulinį ar begalinį
   * galiojimą.
   */
  for (const [name, opts] of [
    ["SESSION_IDLE_TIMEOUT_MINUTES", { min: 1, max: 24 * 60 }],
    ["SESSION_ABSOLUTE_TIMEOUT_HOURS", { min: 1, max: 24 * 30 }],
    /**
     * LOGIN LIMITAI (#18 PR1, review pastaba).
     *
     * `parseInt(env.X || "30", 10)` tyliai priima šiukšlę: `parseInt("10xyz",
     * 10) === 10`, o `parseInt("abc", 10) === NaN` (kas duotų `max: NaN` -
     * `express-rate-limit` tada arba niekada neriboja, arba elgiasi
     * neapibrėžtai). Ta pati taisyklė, kuri jau taikoma sesijos laiko
     * limitams: netinkama saugumo konfigūracija stabdo startą, o ne tyliai
     * pakeičia elgesį.
     */
    /**
     * Žymos TTL (#19). Ta pati taisyklė kaip kitoms saugumo nuostatoms:
     * `parseInt("10xyz")` tyliai duotų 10, o `abc` – NaN, ir žyma galiotų
     * neapibrėžtą laiką. Ištrynimo garantijai tai reikštų, kad vėluojanti
     * eilės žinutė vėl galėtų kurti artefaktus.
     */
    ["DELETION_TOMBSTONE_TTL_HOURS", { min: 1, max: 24 * 365 }],
    /**
     * Kopijų retencija (#20). Ji apibrėžia FAKTINĮ ištrynimo langą: #19
     * ištrynimas veikia gyvoje sistemoje, o kopijoje esantys duomenys lieka iki
     * jos galiojimo pabaigos. Netinkama reikšmė tyliai virstų numatytąja, ir
     * privatumo politikoje deklaruotas terminas neatitiktų tikrovės.
     */
    ["BACKUP_RETENTION_DAYS", { min: 1, max: 365 }],
    ["RATE_LIMIT_LOGIN_IP_MAX", { min: 1, max: 10_000 }],
    ["RATE_LIMIT_LOGIN_ACCOUNT_MAX", { min: 1, max: 10_000 }],
  ]) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
      errors.push(`${name}="${raw}" netinkama - laukiamas sveikas skaičius nuo ${opts.min} iki ${opts.max}.`);
    }
  }

  /**
   * API_KEY_ROLE (#18 PR2).
   *
   * Rolė, kurią gauna bendro `API_KEY` turėtojas. Netinkama reikšmė turi
   * stabdyti startą, o ne tyliai virsti `null` - tada `resolveIdentity()`
   * grąžintų `null`, ir VISI rakto keliai duotų 401, atrodydami kaip
   * autentifikacijos gedimas, o ne konfigūracijos klaida.
   */
  /**
   * KOPIJŲ ŠIFRAVIMO RAKTAI (#20).
   *
   * Tikrinamas IR ankstesnis raktas: jei jo formatas netinkamas, `decrypt`
   * mestų klaidą DAR PRIEŠ pradedant bandyti kandidatus – tad atkūrimas kristų
   * net su TEISINGU dabartiniu raktu.
   *
   * Tai fail-closed, bet operaciškai netikėta, o sužinoti apie tai nelaimės
   * metu yra blogiausias momentas.
   */
  for (const name of ["BACKUP_ENCRYPTION_KEY", "BACKUP_ENCRYPTION_KEY_PREVIOUS"]) {
    const raw = env[name];
    if (!raw) continue;

    if (!/^[0-9a-fA-F]{64}$/.test(String(raw))) {
      errors.push(`${name} netinkamo formato – privalo būti 64 hex simboliai (32 baitai).`);
    }
  }

  /**
   * ĮSPĖJIMAS: ankstesnis raktas be dabartinio.
   *
   * Toks derinys reiškia, kad naujos kopijos NEBUS šifruojamos, o senos dar
   * dešifruojamos – dažniausiai tai nebaigta rotacija, ne sąmoningas
   * sprendimas.
   */
  if (env.BACKUP_ENCRYPTION_KEY_PREVIOUS && !env.BACKUP_ENCRYPTION_KEY) {
    warnings.push(
      "BACKUP_ENCRYPTION_KEY_PREVIOUS nustatytas be BACKUP_ENCRYPTION_KEY – naujos kopijos NEBUS šifruojamos. " +
        "Greičiausiai nebaigta rotacija."
    );
  }

  const apiKeyRole = (env.API_KEY_ROLE || "").trim().toLowerCase();
  if (apiKeyRole && !KNOWN_ROLES.includes(apiKeyRole)) {
    /**
     * REIKŠMĖ NEĮTRAUKIAMA į pranešimą sąmoningai.
     *
     * CodeQL (`js/clear-text-logging`) pažymėjo ankstesnę versiją, kuri
     * interpoliavo `env.API_KEY_ROLE` tiesiai į klaidą. Konkrečiai ŠI reikšmė
     * yra rolės pavadinimas, ne paslaptis - bet taisyklė teisinga iš principo:
     * aplinkos kintamojo reikšmės echo į logus yra šablonas, kurio verta
     * vengti, o čia jos net nereikia.
     *
     * Diagnostika nenukenčia: administratorius mato, KURIS kintamasis blogas
     * ir kokios reikšmės galimos - to pakanka ištaisyti, o pats įvedė reikšmę
     * ir taip ją žino.
     */
    errors.push(
      `API_KEY_ROLE reikšmė nežinoma. Galimos: ${KNOWN_ROLES.join(", ")}.`
    );
  }

  /**
   * ĮSPĖJIMAS (ne klaida): numatytoji `administrator` rolė bendram raktui.
   *
   * Tai SĄMONINGAS atgalinio suderinamumo sprendimas - iki #18 rakto turėtojas
   * galėjo viską. Bet kol taip yra, RBAC rakto turėtojų NERIBOJA: `job:delete`
   * ir `export:original` apsaugos jiems negalioja.
   *
   * Klaida čia būtų per griežta (sulaužytų veikiančius diegimus), tylėjimas -
   * per švelnus (administratorius nepastebėtų, kad rolės neveikia).
   */
  if (env.API_KEY && !apiKeyRole) {
    warnings.push(
      "API_KEY nustatytas, bet API_KEY_ROLE - ne. Numatytai raktas gauna 'administrator' rolę, " +
        "tad RBAC jo NERIBOJA (įskaitant DELETE ir originalo eksportą). " +
        "Realiam rolių atskyrimui nustatykite API_KEY_ROLE=operator arba pereikite prie sesijų."
    );
  }

  /**
   * PRODUKCIJOS SAUGUMO PATIKROS (#14: „Production startup fails when required
   * security configuration is unsafe").
   *
   * Šios klaidos galioja TIK produkcijoje: kūrimo aplinkoje laisvesnis CORS ir
   * nenustatytas API_KEY yra patogumas, o ne rizika. Produkcijoje tas pats
   * derinys reiškia atvirą API su realiais raktais.
   */
  if (env.NODE_ENV === "production") {
    if ((env.CORS_ORIGIN || "").trim() === "*") {
      errors.push(
        "CORS_ORIGIN=* produkcijoje neleidžiamas - bet koks domenas galėtų kviesti šį API " +
          "vartotojo naršyklės vardu. Nurodykite konkrečias kilmes."
      );
    }

    if (String(env.TRUST_PROXY || "").toLowerCase() === "true") {
      errors.push(
        "TRUST_PROXY=true produkcijoje leidžia bet kam klastoti X-Forwarded-For ir apeiti rate " +
          "limitą. Nurodykite proxy šuolių skaičių (pvz. TRUST_PROXY=1) arba tinklą."
      );
    }
  }

  /**
   * Saugumo konfigūracija tikrinama VISOSE aplinkose ir PALEIDŽIANT.
   *
   * Kitaip netinkama reikšmė pasirodytų tik registruojant middleware (kritimas
   * be konteksto) arba pirmoje užklausoje - t. y. tada, kai serveris jau laikomas
   * veikiančiu.
   */
  const security = require("./securityBaseline");

  for (const check of [
    () => security.resolveCorsOptions(env),
    () => security.requireBodyLimit(env, "1mb"),
    () => security.requirePositiveInt(env, "READINESS_TIMEOUT_MS", 2000, { min: 100, max: 60_000 }),
    () => security.requirePositiveInt(env, "RATE_LIMIT_GENERAL_MAX", 300, { min: 1, max: 1_000_000 }),
  ]) {
    try {
      check();
    } catch (e) {
      errors.push(e.message);
    }
  }

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
