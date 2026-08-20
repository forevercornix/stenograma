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
const { isProviderAllowed, approvedExternalProviders } = require("./providerGovernance");

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

  /**
   * TIEKĖJŲ VALDYSENA (#22.2).
   *
   * Tikrinama PALEIDŽIANT, ne pirmoje užklausoje. Priešingu atveju sistema
   * pasileistų su neleistina konfigūracija ir kristų tik tada, kai vartotojas
   * jau atsiuntė failą — o tai reikštų, kad jo duomenys jau sistemoje.
   *
   * Fabrikų patikra (#22.2) lieka kaip antras sluoksnis: ji dengia užklausos
   * override ir dinaminį pasirinkimą, kurių startup nemato.
   */
  /**
   * Naudojamas TAS PATS parseris kaip fabrikuose.
   *
   * Pirmoji versija turėjo savo kopiją (`split`/`trim`/`filter`) — dvi vietos,
   * parsinančios tą pačią konfigūraciją. Jos veikė vienodai TĄ DIENĄ, bet
   * pridėjus dedublikavimą ar naujas taisykles startup ir fabrikai būtų
   * išsiskyrę, ir sistema pasileistų su konfigūracija, kurios pati vėliau
   * nepriimtų.
   */
  const approvedExternal = approvedExternalProviders(env);

  for (const [variable, kind, fallback] of [
    ["TRANSCRIPTION_PROVIDER", "transcription", "mock"],
    ["DIARIZATION_PROVIDER", "diarization", "none"],
    ["LLM_PROVIDER", "llm", "mock"],
  ]) {
    const selected = (env[variable] || fallback).toLowerCase();
    const { allowed, reason } = isProviderAllowed(kind, selected, { approvedExternal });

    if (!allowed) errors.push(`${variable}: ${reason}`);
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

  /**
   * PostgreSQL (#155, 7.1).
   *
   * Rodoma TIK kai `DATABASE_URL` nustatytas: be jo backend'as naudoja Redis
   * arba in-memory store, ir „PostgreSQL nepasiekiamas" būtų klaidinantis
   * įspėjimas desktop režimu.
   *
   * Tikrinama ne tik prisijungimas, bet ir MIGRACIJŲ būsena: veikianti DB su
   * nepritaikyta schema yra kita problema nei neveikianti DB, ir operatorius
   * turi jas atskirti.
   */
  /**
   * ⚠️ DU KONFIGŪRAVIMO BŪDAI.
   *
   * Docker profiliai naudoja atskirus `PG*` kintamuosius, nes slaptažodis su
   * URI simboliais (`/`, `?`, `#`) sukonstruotame URL reikštų kitką. Lokaliai
   * ir CI patogiau vienas `DATABASE_URL`.
   *
   * `pg` biblioteka `PG*` skaito pati, kai `connectionString` neperduodamas.
   */
  if (env.DATABASE_URL || env.PGHOST) {
    /**
     * ⚠️ ABU KONFIGŪRAVIMO BŪDAI KARTU = KLAIDA, ne pirmenybė.
     *
     * Docker profiliai backend'ui perduoda `PG*`, o `.env` failuose dažnai
     * lieka `DATABASE_URL`. `doctor` skaito ABU failus, tad operatorius gali
     * turėti abu vienu metu — ir tada `doctor` tikrintų VISAI KITĄ DB nei tą,
     * su kuria dirba stackas.
     *
     * Tyli pirmenybė čia blogesnė už klaidą: diagnostika, rodanti ne tą
     * duomenų bazę, yra blogesnė nei diagnostikos nebuvimas.
     */
    if (env.DATABASE_URL && env.PGHOST) {
      checks.push({
        name: "PostgreSQL (migracijų infrastruktūra)",
        ok: false,
        detail:
          "KONFLIKTAS: nustatyti IR `DATABASE_URL`, IR `PGHOST` - neaišku, kuri DB " +
          "tikrinama. Docker profiliai naudoja `PG*`; palikite tik vieną būdą.",
      });
    } else {
      checks.push(await postgresReachability(env));
    }
  }

  return checks;
}

/** Prisijungimas + migracijų būsena. Klaidos pranešime NĖRA prisijungimo eilutės. */
async function postgresReachability(env) {
  /**
   * ⚠️ VARDAS SAKO „migracijų infrastruktūra", ne „job store".
   *
   * 7.1 metu `jobStore` PostgreSQL dar nenaudoja, sesijos ir auditas irgi ne.
   * Žalia varnelė su vardu „job store, sesijos, auditas" operatoriui reikštų,
   * kad tie įrašai jau persistenti — o jie nėra. Vardas pasikeis 7.2a–7.4,
   * kai integracijos realiai atsiras.
   */
  const name = "PostgreSQL (migracijų infrastruktūra)";
  let client;

  try {
    const { Client } = require("pg");
    /**
     * ⚠️ `PG*` PERDUODAMI EKSPLICITIŠKAI.
     *
     * `pg` numatytai skaito `process.env`, o ne šiai funkcijai perduotą `env`.
     * Testams ir bet kokiam kvietimui su kitokia konfigūracija tai reikštų,
     * kad tikrinama NE ta duomenų bazė, kurią nurodė kvietėjas.
     */
    client = new Client({
      connectionString: env.DATABASE_URL || undefined,
      ...(env.DATABASE_URL
        ? {}
        : {
            host: env.PGHOST,
            port: env.PGPORT ? Number(env.PGPORT) : 5432,
            user: env.PGUSER,
            password: env.PGPASSWORD,
            database: env.PGDATABASE,
          }),
      connectionTimeoutMillis: 5000,
      /**
       * ⚠️ UŽKLAUSŲ TIMEOUT ATSKIRAI. `connectionTimeoutMillis` galioja tik
       * prisijungimui: jei serveris priima jungtį, bet nustoja atsakinėti,
       * kiekviena `query()` lauktų neribotai — `make doctor` pakibtų, o
       * `/api/health/deep` užklausos liktų atviros.
       */
      statement_timeout: 5000,
      query_timeout: 5000,
    });
    await client.connect();

    const versija = (await client.query("SHOW server_version")).rows[0].server_version;

    /**
     * `pgmigrations` nebuvimas reiškia, kad `npm run migrate:up` dar
     * nepaleistas — DB veikia, bet schemos nėra.
     */
    const lentelė = await client.query(
      "SELECT to_regclass('public.pgmigrations') IS NOT NULL AS yra"
    );

    if (!lentelė.rows[0].yra) {
      return {
        name,
        ok: false,
        detail: `prisijungta (PostgreSQL ${versija}), bet MIGRACIJOS NEPRITAIKYTOS - paleiskite \`npm run migrate:up\``,
      };
    }

    /**
     * ⚠️ LYGINAMA SU REPO MIGRACIJOMIS, ne tik skaičiuojama.
     *
     * `pgmigrations` egzistavimas reiškia, kad migracijos KAŽKADA paleistos.
     * DB, kurioje pritaikyta tik senesnė migracija, be šio palyginimo grąžintų
     * `ok: true`, ir `/api/health/deep` rodytų 200, kol užklausos ims kristi.
     */
    const pritaikytos = new Set(
      (await client.query("SELECT name FROM pgmigrations")).rows.map((r) => r.name)
    );

    const fs = require("node:fs");
    const path = require("node:path");
    const katalogas = path.resolve(__dirname, "..", "migrations");

    const repo = fs.existsSync(katalogas)
      ? fs
          .readdirSync(katalogas)
          .filter((f) => /\.(js|sql)$/.test(f))
          .map((f) => f.replace(/\.(js|sql)$/, ""))
      : [];

    const laukia = repo.filter((m) => !pritaikytos.has(m));
    const nežinomos = [...pritaikytos].filter((m) => !repo.includes(m));

    if (laukia.length > 0) {
      return {
        name,
        ok: false,
        detail:
          `prisijungta (PostgreSQL ${versija}), bet LAUKIA ${laukia.length} migracijų ` +
          `(${laukia.slice(0, 3).join(", ")}${laukia.length > 3 ? "..." : ""}) - ` +
          "paleiskite `npm run migrate:up`",
      };
    }

    if (nežinomos.length > 0) {
      /**
       * DB turi migracijų, kurių repo nėra — tikėtina, kad kodas senesnis nei
       * schema (rollback ar mišrus diegimas). Tai kita problema nei trūkstamos.
       */
      return {
        name,
        ok: false,
        detail:
          `prisijungta (PostgreSQL ${versija}), bet DB turi ${nežinomos.length} NEŽINOMŲ ` +
          "migracijų - ar kodas senesnis nei schema?",
      };
    }

    return {
      name,
      ok: true,
      detail: `PostgreSQL ${versija}, pritaikyta migracijų: ${pritaikytos.size}`,
    };
  } catch (e) {
    /**
     * ⚠️ `DATABASE_URL` NERODOMAS — jame yra slaptažodis. Rodomas tik hostas ir
     * klaidos kodas, kaip `httpReachability` atveju.
     */
    let host = "(nežinomas host)";
    try {
      host = env.DATABASE_URL
        ? new URL(env.DATABASE_URL).host
        : `${env.PGHOST}:${env.PGPORT || 5432}`;
    } catch {
      /* netinkamas URL - hosto nerodom */
    }

    /**
     * ⚠️ SKIRTINGI GEDIMAI REIKALAUJA SKIRTINGŲ VEIKSMŲ.
     *
     * Ankstesnė versija viską vadino „NEPASIEKIAMAS: ar servisas paleistas?".
     * Bet neteisingas slaptažodis, nesanti DB ar trūkstamos teisės reiškia, kad
     * servisas VEIKIA — operatorius siųstas klaidinga kryptimi.
     */
    const PAGAL_KODĄ = {
      "28P01": "neteisingi prisijungimo duomenys (POSTGRES_PASSWORD?)",
      "28000": "prisijungimas atmestas (pg_hba.conf ar vartotojas?)",
      "3D000": "tokios duomenų bazės NĖRA (POSTGRES_DB?)",
      "42501": "trūksta teisių skaityti `pgmigrations`",
      "57P03": "serveris paleidžiamas - dar nepriima jungčių",
    };

    const paaiškinimas = PAGAL_KODĄ[e.code];
    if (paaiškinimas) {
      return { name, ok: false, detail: `${host}: ${paaiškinimas} (${e.code})` };
    }

    return { name, ok: false, detail: `${host} NEPASIEKIAMAS (${e.code || e.name}): ar servisas paleistas?` };
  } finally {
    if (client) await client.end().catch(() => {});
  }
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
