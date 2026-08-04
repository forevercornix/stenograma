const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { getLLMProvider } = require("../providers/llm");
const { getTranscriptionProvider } = require("../providers/transcription");
const { getDiarizationProvider } = require("../providers/diarization");
const { validateConfig } = require("../utils/startupChecks");

/**
 * #22.2: TIEKĖJŲ POLITIKOS VYKDYMAS.
 *
 * #22.1 apibrėžė POLITIKĄ. Čia tikrinama, kad ji būtų VYKDOMA — ir kad jos
 * nebūtų galima apeiti nė vienu keliu.
 */

/** Laikinai nustato aplinkos kintamuosius ir garantuotai atstato. */
function withEnv(overrides, fn) {
  const saved = {};

  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* FABRIKAI – VIENINTELIS KELIAS                                       */
/* ------------------------------------------------------------------ */

test("VYKDYMAS: nepatvirtintas tiekėjas blokuojamas VISUOSE trijuose fabrikuose", () => {
  /**
   * ⚠️ Patikra dedama FABRIKE, ne maršrute — tai vienintelis kelias, kuriuo
   * tiekėjas atsiranda. Tas pats principas kaip #19 ištrynimo žymų patikra
   * `jobStore.update` viduje.
   *
   * Todėl ji automatiškai galioja HTTP maršrutams, inline vykdymui ir BullMQ
   * worker'iams. Kiekvienam pridėti atskirą patikrą reikštų tris vietas,
   * kurios ilgainiui išsiskirs.
   */
  withEnv(
    {
      APPROVED_EXTERNAL_PROVIDERS: "",
      ANTHROPIC_API_KEY: "sk-ant-testas",
      OPENAI_API_KEY: "sk-testas",
      PYANNOTEAI_API_KEY: "testas",
    },
    () => {
      for (const [factory, name, kind] of [
        [getLLMProvider, "claude", "llm"],
        [getTranscriptionProvider, "whisper", "transcription"],
        [getDiarizationProvider, "pyannote-cloud", "diarization"],
      ]) {
        assert.throws(
          () => factory(name),
          (error) => error.code === "PROVIDER_NOT_APPROVED",
          `${kind}: "${name}" turėjo būti blokuotas`
        );
      }
    }
  );
});

test("VYKDYMAS: patvirtintas tiekėjas praeina – apsauga NĖRA aklas blokas", () => {
  /**
   * Be šio testo #22.2 galėtų virsti visišku išorinių tiekėjų draudimu, ir
   * niekas to nepastebėtų: visi „blokuoja" testai liktų žali.
   */
  withEnv({ APPROVED_EXTERNAL_PROVIDERS: "claude", ANTHROPIC_API_KEY: "sk-ant-testas" }, () => {
    assert.ok(getLLMProvider("claude"), "patvirtintas tiekėjas turi veikti");
  });
});

test("VYKDYMAS: lokalūs tiekėjai veikia BE patvirtinimo", () => {
  /**
   * Patvirtinimo reikalavimas taikomas tik išoriniams — lokalūs duomenų
   * neišsiunčia, tad organizacinio sprendimo jiems nereikia.
   */
  withEnv({ APPROVED_EXTERNAL_PROVIDERS: "" }, () => {
    assert.ok(getLLMProvider("mock"));
    assert.ok(getTranscriptionProvider("mock"));
    /**
     * `none` teisėtai grąžina `null` – diarizacija išjungta, tiekėjo nėra.
     * Svarbu, kad NEMESTŲ klaidos: valdysena jo neblokuoja.
     */
    assert.doesNotThrow(() => getDiarizationProvider("none"));
    assert.ok(getDiarizationProvider("mock"), "mock diarizacija turi veikti");
  });
});

test("VYKDYMAS: patvirtinus VIENĄ tiekėją, kiti lieka blokuoti", () => {
  /**
   * Patvirtinimas yra per tiekėją, ne per kategoriją: leidus `claude`,
   * `gpt` nepasidaro leidžiamas.
   */
  withEnv(
    { APPROVED_EXTERNAL_PROVIDERS: "claude", ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-b" },
    () => {
      assert.ok(getLLMProvider("claude"));

      assert.throws(
        () => getLLMProvider("gpt"),
        (error) => error.code === "PROVIDER_NOT_APPROVED"
      );
    }
  );
});

/* ------------------------------------------------------------------ */
/* UŽKLAUSOS OVERRIDE                                                  */
/* ------------------------------------------------------------------ */

test("OVERRIDE: užklausos parametras NEAPEINA valdysenos", () => {
  /**
   * Startup validacija mato tik `.env`. Užklausos override ateina vėliau ir
   * apeitų ją, jei patikra būtų tik paleidimo metu — todėl fabrikų sluoksnis
   * būtinas kaip antras.
   */
  withEnv(
    { LLM_PROVIDER: "mock", APPROVED_EXTERNAL_PROVIDERS: "", ANTHROPIC_API_KEY: "sk-ant-testas" },
    () => {
      assert.ok(getLLMProvider(), "numatytasis mock veikia");

      assert.throws(
        () => getLLMProvider("claude"),
        (error) => error.code === "PROVIDER_NOT_APPROVED",
        "override į nepatvirtintą tiekėją turi būti blokuotas"
      );
    }
  );
});

/* ------------------------------------------------------------------ */
/* STARTUP                                                             */
/* ------------------------------------------------------------------ */

test("STARTUP: neleistinas tiekėjas stabdo PALEIDIMĄ", () => {
  /**
   * Tikrinama paleidžiant, ne pirmoje užklausoje. Priešingu atveju sistema
   * pasileistų su neleistina konfigūracija ir kristų tada, kai vartotojas jau
   * atsiuntė failą — o tai reikštų, kad jo duomenys jau sistemoje.
   */
  const { errors } = validateConfig({
    LLM_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "sk-ant-testas",
    APPROVED_EXTERNAL_PROVIDERS: "",
  });

  assert.ok(
    errors.some((error) => /nepatvirtintas/.test(error)),
    `laukta valdysenos klaidos: ${errors.join(" | ")}`
  );
});

test("STARTUP: tikrinami VISI trys tiekėjų kintamieji", () => {
  /**
   * Praleistas kintamasis reikštų, kad viena kategorija apeina politiką —
   * o būtent transkribavimas siunčia jautriausius duomenis.
   */
  for (const [variable, value] of [
    ["TRANSCRIPTION_PROVIDER", "whisper"],
    ["DIARIZATION_PROVIDER", "pyannote-cloud"],
    ["LLM_PROVIDER", "claude"],
  ]) {
    const { errors } = validateConfig({
      [variable]: value,
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-b",
      PYANNOTEAI_API_KEY: "c",
      APPROVED_EXTERNAL_PROVIDERS: "",
    });

    assert.ok(
      errors.some((error) => error.startsWith(variable) && /nepatvirtintas/.test(error)),
      `${variable} netikrinamas startup metu`
    );
  }
});

test("STARTUP: patvirtinus tiekėją valdysenos klaida DINGSTA", () => {
  const { errors } = validateConfig({
    LLM_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "sk-ant-testas",
    APPROVED_EXTERNAL_PROVIDERS: "claude",
  });

  assert.deepEqual(
    errors.filter((error) => /nepatvirtintas|valdysenos/.test(error)),
    []
  );
});

/* ------------------------------------------------------------------ */
/* DIAGNOSTIKOS TVARKA                                                 */
/* ------------------------------------------------------------------ */

test("TVARKA: rašybos klaida duoda „nežinomas tiekėjas\", ne valdysenos klaidą", () => {
  /**
   * ⚠️ TVARKA SVARBI DIAGNOSTIKAI.
   *
   * Pirmoji šio PR versija tikrino valdyseną PRIEŠ registrą — ir rašybos
   * klaida („clade") duodavo „nėra valdysenos įrašo", siųsdama operatorių
   * taisyti ne to failo.
   *
   * Registro klaida tikslesnė: ji pateikia galimų tiekėjų sąrašą.
   */
  assert.throws(() => getLLMProvider("clade"), /Nežinomas LLM_PROVIDER/);
  assert.throws(() => getTranscriptionProvider("wisper"), /Nežinomas TRANSCRIPTION_PROVIDER/);
});

/* ------------------------------------------------------------------ */
/* STRUKTŪRINĖS GARANTIJOS                                             */
/* ------------------------------------------------------------------ */

test("STRUKTŪRA: VISI trys fabrikai kviečia TĄ PAČIĄ patikrą", () => {
  /**
   * Struktūrinė sargyba: naujas fabrikas be patikros būtų kelias, apeinantis
   * visą valdyseną. Tekstinė patikra čia tinkama — ji gaudo praleidimą, kurio
   * elgsenos testas nepastebėtų, nes tokio fabriko dar nėra.
   */
  for (const kind of ["transcription", "diarization", "llm"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "providers", kind, "index.js"), "utf8");

    assert.match(
      source,
      new RegExp(`assertProviderAllowed\\("${kind}", name\\)`),
      `${kind} fabrikas netikrina valdysenos`
    );
  }
});

test("STRUKTŪRA: patikra eina PO registro tikrinimo", () => {
  /**
   * Tvarką lengva netyčia sukeisti pertvarkant kodą, o elgsenos testas tai
   * pagautų tik per vieną konkretų atvejį. Ši patikra fiksuoja pačią tvarką.
   */
  for (const kind of ["transcription", "diarization", "llm"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "providers", kind, "index.js"), "utf8");

    const registryCheck = source.indexOf("hasOwnProperty.call(REGISTRY");
    const governanceCheck = source.indexOf(`assertProviderAllowed("${kind}"`);

    assert.notEqual(registryCheck, -1, `${kind}: nerasta registro patikra`);
    assert.ok(
      governanceCheck > registryCheck,
      `${kind}: valdysena tikrinama PRIEŠ registrą – rašybos klaidos diagnostika bus klaidinanti`
    );
  }
});

test("TESTINIS TIEKĖJAS: registracija veikia TIK `NODE_ENV=test`", () => {
  /**
   * Testai injektuoja netikrus tiekėjus į `REGISTRY`, tad turi deklaruoti ir
   * politiką. Produkcijoje tas pats kelias būtų būdas apeiti visą valdyseną
   * vienu kvietimu.
   */
  const { registerTestProvider } = require("../utils/providerGovernance");

  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    assert.throws(
      () => registerTestProvider("llm", "piktas", {}),
      (error) => error.code === "TEST_ONLY"
    );
  } finally {
    process.env.NODE_ENV = saved;
  }

  // Testų aplinkoje veikia ir grąžina atstatymo funkciją.
  const restore = registerTestProvider("llm", "laikinas", { approval: "not_required" });
  assert.equal(typeof restore, "function");

  restore();

  const { governanceFor } = require("../utils/providerGovernance");
  assert.equal(governanceFor("llm", "laikinas"), null, "atstatymas turi pašalinti įrašą");
});

test("STRUKTŪRA: fabrikai naudoja VIENĄ bendrą patikrą, ne kopijas", () => {
  /**
   * Pirmoji #22.2 versija turėjo po kopiją kiekviename fabrike — trys beveik
   * identiškos funkcijos. Jos veikė vienodai, bet pakeitus vieną (pvz.
   * pridėjus audito įrašą) kitos dvi tyliai atsiliktų, ir politika taptų
   * NEVIENODA priklausomai nuo tiekėjo tipo.
   */
  for (const kind of ["transcription", "diarization", "llm"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "providers", kind, "index.js"), "utf8");

    assert.match(
      source,
      /require\("\.\.\/\.\.\/utils\/providerGovernance"\)/,
      `${kind} turi naudoti bendrą modulį`
    );

    assert.ok(
      !/function assertProvider\w*Allowed/.test(source),
      `${kind} turi savo patikros kopiją – naudokite bendrą`
    );
  }
});

test("KONFIGŪRACIJA: startup ir fabrikai naudoja TĄ PATĮ parserį", () => {
  /**
   * Dvi vietos, parsinančios tą pačią konfigūraciją, veikia vienodai tik tą
   * dieną. Pridėjus dedublikavimą ar naujas taisykles jos išsiskirtų, ir
   * sistema pasileistų su konfigūracija, kurios pati vėliau nepriimtų.
   */
  const startupSource = fs.readFileSync(path.join(__dirname, "..", "utils", "startupChecks.js"), "utf8");

  assert.match(startupSource, /approvedExternalProviders\(env\)/, "startup turi naudoti bendrą parserį");

  assert.ok(
    !/APPROVED_EXTERNAL_PROVIDERS[\s\S]{0,120}?\.split\(","\)/.test(startupSource),
    "startup turi savo parserio kopiją"
  );

  // Ir elgesys sutampa: dedublikavimas galioja abiejose vietose.
  const { errors } = validateConfig({
    LLM_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "sk-testas",
    APPROVED_EXTERNAL_PROVIDERS: "claude,CLAUDE, claude",
  });

  assert.deepEqual(
    errors.filter((error) => /nepatvirtintas/.test(error)),
    [],
    "dubliuotas patvirtinimas turi veikti kaip vienas"
  );
});

test("MANIFESTAS: dublikatai rinkiniuose STABDO paleidimą", () => {
  /**
   * ⚠️ Rasta #22.2 peržiūroje: `suites.js` turėjo tą patį testą DU kartus.
   *
   * Paleidiklis dedublikuoja (`new Set(...)`), tad klaida buvo TYLIAI
   * NEKENKSMINGA — testai vykdomi teisingai, ir niekas nepastebi. Ją pamatė
   * žmogus, skaitydamas diff'ą, o ne įrankis.
   *
   * Tyliai nekenksminga klaida vis tiek yra klaida: ji rodo, kad manifestas
   * redaguotas neatidžiai.
   */
  const runnerSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-tests.mjs"), "utf8");

  assert.match(runnerSource, /nurodytas DU kartus/, "paleidiklis turi tikrinti dublikatus");

  // Ir pats manifestas švarus.
  // Modulis eksportuoja { suites, defaultSuites }, ne patį objektą.
  const { suites } = require("./suites");

  for (const [suiteName, names] of Object.entries(suites)) {
    assert.equal(
      new Set(names).size,
      names.length,
      `rinkinyje "${suiteName}" yra dublikatų`
    );
  }
});
