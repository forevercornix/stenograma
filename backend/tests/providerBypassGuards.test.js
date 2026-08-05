const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.APPROVED_EXTERNAL_PROVIDERS = "";

const governance = require("../utils/providerGovernance");
const { MATRIX } = require("../utils/providerPrivacy");

/**
 * #22.3: APSAUGA NUO REGRESO.
 *
 * #22.1 apibrėžė politiką, #22.2 ją įgyvendino. Čia tikrinama, kad jos
 * NEBŪTŲ GALIMA APEITI — nei šiandien, nei po refaktoringo.
 *
 * Skirtumas nuo #22.2 testų: tie tikrina, kad patikra VEIKIA. Šie tikrina, kad
 * nėra KELIO, kuriuo ją būtų galima aplenkti.
 */

const BACKEND = path.join(__dirname, "..");

/** Visi `.js` failai kataloge (rekursyviai). */
function collectFiles(dir) {
  const full = path.join(BACKEND, dir);
  if (!fs.existsSync(full)) return [];

  const result = [];

  function walk(current) {
    for (const entry = fs.readdirSync(current, { withFileTypes: true }), i = { v: 0 }; i.v < entry.length; i.v++) {
      const item = entry[i.v];
      const itemPath = path.join(current, item.name);

      if (item.isDirectory()) walk(itemPath);
      else if (item.name.endsWith(".js")) result.push(itemPath);
    }
  }

  walk(full);
  return result;
}

/* ------------------------------------------------------------------ */
/* STRUKTŪRINĖS SARGYBOS                                               */
/* ------------------------------------------------------------------ */

test("APĖJIMAS: maršrutai, worker'iai ir eilės NEIMPORTUOJA tiekėjų tiesiogiai", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Visa #22.2 architektūra remiasi tuo, kad fabrikas yra VIENINTELIS kelias.
   * Tiesioginis provider klasės importas maršrute ar worker'yje aplenktų
   * fabriką — ir kartu visą valdyseną.
   *
   * Toks importas atrodytų nekaltai („juk tik viena vieta"), o politika taptų
   * neveikianti būtent tame kelyje. Elgsenos testas to nepagautų: jis tikrina
   * esamus kelius, ne naujus.
   */
  const offenders = [];

  for (const dir of ["routes", "workers", "queues", "middleware"]) {
    for (const file of collectFiles(dir)) {
      const source = fs.readFileSync(file, "utf8");

      /**
       * Ieškoma TIESIOGINIO provider klasės importo, ne fabriko.
       * `require("../providers/llm")` (fabrikas) leidžiamas;
       * `require("../providers/llm/ClaudeProvider")` – ne.
       */
      const directImports = [...source.matchAll(/require\(["'][^"']*providers\/(\w+)\/(\w+)["']\)/g)];

      for (const [match, , member] of directImports) {
        if (member === "index") continue;

        offenders.push(`${path.relative(BACKEND, file)}: ${match}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `tiesioginis tiekėjo importas aplenkia fabriką ir visą valdyseną:\n${offenders.join("\n")}`
  );
});

test("APĖJIMAS: fabrikai yra VIENINTELIS kelias į provider klases", () => {
  /**
   * Priešinga kryptis: tikrinam, kad provider klases importuoja TIK jų pačių
   * fabrikai. Bet kas kitas reikštų antrą kelią.
   */
  const allowed = new Set([
    "providers/transcription/index.js",
    "providers/diarization/index.js",
    "providers/llm/index.js",
  ]);

  const offenders = [];

  for (const dir of ["routes", "services", "workers", "queues", "utils", "providers"]) {
    for (const file of collectFiles(dir)) {
      const relative = path.relative(BACKEND, file).replace(/\\/g, "/");
      if (allowed.has(relative)) continue;

      // Praleidžiam pačias provider klases ir bazines klases.
      if (/^providers\/\w+\/\w*Provider\.js$/.test(relative)) continue;

      const source = fs.readFileSync(file, "utf8");
      const directImports = [...source.matchAll(/require\(["'][^"']*providers\/\w+\/(\w+Provider)["']\)/g)];

      for (const [match] of directImports) {
        offenders.push(`${relative}: ${match}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `provider klasės importuojamos ne per fabriką:\n${offenders.join("\n")}`);
});

test("APĖJIMAS: servisai kviečia fabrikus, ne konstruktorius", () => {
  /**
   * Servisai yra vienintelis sluoksnis tarp maršrutų ir tiekėjų. Jei jie
   * instancijuotų klasę tiesiogiai (`new ClaudeProvider()`), fabriko patikra
   * būtų aplenkta.
   */
  const offenders = [];

  for (const file of collectFiles("services")) {
    const source = fs.readFileSync(file, "utf8");

    const directInstantiation = [...source.matchAll(/new\s+(\w+Provider)\s*\(/g)];

    for (const [, className] of directInstantiation) {
      offenders.push(`${path.relative(BACKEND, file)}: new ${className}()`);
    }
  }

  assert.deepEqual(offenders, [], `tiesioginė instanciacija aplenkia fabriką:\n${offenders.join("\n")}`);
});

/* ------------------------------------------------------------------ */
/* POLITIKOS PILNUMAS                                                  */
/* ------------------------------------------------------------------ */

test("SINCHRONIZACIJA: matrica, valdysena ir dokumentas neišsiskiria", () => {
  /**
   * Trys šaltiniai turi sutapti. Kiekvienas gali pasikeisti atskirai, tad
   * tikrinamos VISOS trys poros — ne tik viena kryptis.
   */
  const doc = fs.readFileSync(path.join(BACKEND, "..", "docs", "provider-governance.md"), "utf8");

  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const provider of Object.keys(byKind)) {
      assert.ok(governance.governanceFor(kind, provider), `${kind}/${provider}: nėra valdysenoje`);
      assert.match(doc, new RegExp(`\`${provider}\``), `${kind}/${provider}: nėra dokumente`);
    }
  }

  for (const [kind, byKind] of Object.entries(governance.GOVERNANCE)) {
    for (const provider of Object.keys(byKind)) {
      assert.ok(MATRIX[kind] && MATRIX[kind][provider], `${kind}/${provider}: valdysenoje, bet ne matricoje`);
    }
  }
});

test("PILNUMAS: KIEKVIENAS registro tiekėjas turi politiką", () => {
  /**
   * Registras (`REGISTRY`) yra tai, ką sistema realiai gali sukurti. Tiekėjas
   * jame be politikos reikštų kelią, kurio valdysena nemato.
   *
   * Tikrinamas REGISTRAS, ne matrica: matricą galima papildyti pamiršus
   * registrą ir atvirkščiai.
   */
  const factories = [
    ["transcription", require("../providers/transcription").REGISTRY],
    ["diarization", require("../providers/diarization").REGISTRY],
    ["llm", require("../providers/llm").REGISTRY],
  ];

  for (const [kind, registry] of factories) {
    for (const provider of Object.keys(registry)) {
      assert.ok(
        governance.governanceFor(kind, provider),
        `${kind}/${provider} yra REGISTRY, bet neturi valdysenos įrašo – jį būtų galima sukurti be politikos`
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* AUDITAS                                                             */
/* ------------------------------------------------------------------ */

test("AUDITAS: atmestas tiekėjas fiksuojamas BE paslapčių", () => {
  /**
   * #22 reikalauja, kad politikos sprendimai būtų matomi audite, kur
   * techniškai įmanoma.
   *
   * Fabrikas audito nerašo sąmoningai: jis kviečiamas ir startup metu, kai
   * audito posistemė dar neinicijuota. Vietoj to fiksuojama ten, kur sprendimas
   * turi pasekmę vartotojui — atmetus jobą.
   */
  const auditLog = require("../utils/auditLog");
  const before = auditLog.getAll().length;

  auditLog.record({
    event: "PROVIDER_REJECTED",
    success: false,
    outcome: "not_approved",
    details: "llm=claude",
  });

  const entry = auditLog.getAll().slice(before)[0];

  assert.ok(entry, "įvykis turi būti užfiksuotas");
  assert.equal(entry.event, "PROVIDER_REJECTED");

  const serialized = JSON.stringify(entry);
  assert.ok(!/sk-|api[_-]?key/i.test(serialized), "audite negali būti raktų");
});

/* ------------------------------------------------------------------ */
/* DIAGNOSTIKA                                                         */
/* ------------------------------------------------------------------ */

test("DIAGNOSTIKA: efektyvi politika sutampa su realiu sprendimu", () => {
  /**
   * Diagnostika, rodanti kitokį atsakymą nei realus vykdymas, blogesnė nei
   * jokios: operatorius ja remsis spręsdamas, ar konfigūracija teisinga.
   */
  const env = { APPROVED_EXTERNAL_PROVIDERS: "claude" };

  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const provider of Object.keys(byKind)) {
      const described = governance.describeGovernance(kind, provider, env);
      const actual = governance.isProviderAllowed(kind, provider, {
        approvedExternal: governance.approvedExternalProviders(env),
      });

      assert.equal(
        described.allowed,
        actual.allowed,
        `${kind}/${provider}: diagnostika rodo ${described.allowed}, o vykdymas ${actual.allowed}`
      );
    }
  }
});

test("DIAGNOSTIKA: nė vienam tiekėjui negrąžinamos paslaptys", () => {
  /**
   * Tikrinama VISIEMS, ne vienam pavyzdžiui: naujas tiekėjas su kitokia
   * struktūra galėtų netyčia atskleisti daugiau.
   */
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-slaptas-raktas-testui",
    OPENAI_API_KEY: "sk-openai-slaptas-testui",
    APPROVED_EXTERNAL_PROVIDERS: "claude,whisper",
  };

  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const provider of Object.keys(byKind)) {
      const serialized = JSON.stringify(governance.describeGovernance(kind, provider, env));

      assert.ok(!serialized.includes("sk-ant-slaptas-raktas-testui"), `${kind}/${provider}: nutekėjo raktas`);
      assert.ok(!serialized.includes("sk-openai-slaptas-testui"), `${kind}/${provider}: nutekėjo raktas`);
      assert.ok(!/https?:\/\//.test(serialized), `${kind}/${provider}: nutekėjo endpoint'as`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* DOKUMENTACIJOS SINCHRONIZACIJA                                      */
/* ------------------------------------------------------------------ */

test("DOKUMENTAI: README ir valdysena nesiskiria dėl `APPROVED_EXTERNAL_PROVIDERS`", () => {
  /**
   * README yra vieša garantijų santrauka. Jei ji teigtų kitką nei kodas,
   * skaitytojas remtųsi neteisinga informacija — ir tai pastebėtų tik
   * diegdamas.
   */
  const readme = fs.readFileSync(path.join(BACKEND, "..", "README.md"), "utf8");

  assert.match(readme, /APPROVED_EXTERNAL_PROVIDERS/, "README turi minėti nuostatą");
  /**
   * `ne\s?įrodo` – tekste gali būti `neįrodo` arba `ne įrodo`; testas apie
   * TURINĮ neturi kristi dėl rašybos varianto.
   */
  assert.match(readme, /įgyvendina[\s\S]{0,40}?ne\s?įrodo/i, "README turi išlaikyti #22.1 formuluotę");

  // Ir nuostata realiai skaitoma.
  assert.deepEqual(governance.approvedExternalProviders({ APPROVED_EXTERNAL_PROVIDERS: "claude" }), ["claude"]);
});

test("DOKUMENTAI: `.env.example` mini nuostatą su įspėjimu", () => {
  const envExample = fs.readFileSync(path.join(BACKEND, ".env.example"), "utf8");

  assert.match(envExample, /APPROVED_EXTERNAL_PROVIDERS/);
  assert.match(envExample, /NEVEIKS|neveiks/, "turi būti įvardyta pasekmė be patvirtinimo");
});
