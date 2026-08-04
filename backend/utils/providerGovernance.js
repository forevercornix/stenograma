const { MATRIX, LOCAL, EXTERNAL, DEPENDS } = require("./providerPrivacy");

/**
 * TIEKĖJŲ VALDYSENA (#22.1).
 *
 * KODĖL SLUOKSNIS VIRŠ `providerPrivacy`, o ne naujas sąrašas.
 *
 * `providerPrivacy.MATRIX` jau atsako į techninį klausimą: kur vyksta
 * apdorojimas ir kokie duomenys išsiunčiami. Antras, nepriklausomas tiekėjų
 * sąrašas neišvengiamai išsiskirtų — naujas tiekėjas atsirastų viename, bet ne
 * kitame, ir liktų be politikos TYLIAI.
 *
 * Ta pati taisyklė kaip #20 kopijų politikoje, išvestoje iš #19 registro.
 *
 * Čia pridedami tik VALDYSENOS klausimai, į kuriuos technika neatsako:
 * regionas, retencija, naudojimas modelių mokymui ir organizacinis
 * patvirtinimas.
 */

/**
 * ⚠️ NEŽINOMA REIKŠMĖ NIEKADA NEREIŠKIA PATVIRTINIMO.
 *
 * Tai kertinė #22 taisyklė. Tiekėjas, apie kurio retenciją nieko nežinome,
 * nėra „tikriausiai tvarkingas" — jis yra **nepatvirtintas**, kol duomenų
 * valdytojas eksplicitiškai nenusprendžia kitaip.
 *
 * Priešingas numatytasis elgesys reikštų, kad neišsamus dokumentavimas
 * automatiškai suteikia leidimą.
 */
const UNKNOWN = "unknown";

/** Ar tiekėjo savybė patikrinta, ar tik prielaida? */
const CONFIDENCE = {
  /** Patikrinta kode arba tiekėjo dokumentacijoje šio projekto metu. */
  VERIFIED: "verified",
  /**
   * Pagrįsta prielaida iš viešos informacijos – NEPATIKRINTA.
   *
   * ⚠️ Šiame projekte nenaudojamas SĄMONINGAI: mes neturime nė vienos
   * savybės, kurią galėtume sąžiningai vadinti pagrįsta prielaida — jos arba
   * patikrintos kode (lokalūs tiekėjai), arba nežinomos (išoriniai).
   *
   * Lygis paliktas KONKREČIAM DIEGIMUI: operatorius, perskaitęs tiekėjo
   * sutartį, gali pažymėti savybę kaip `assumed`, kai ji dokumentuota viešai,
   * bet nepatvirtinta raštu. Tai tikslesnė būsena nei „verified" ar „unknown".
   */
  ASSUMED: "assumed",
  /** Nežinoma. Traktuojama kaip NEPATVIRTINTA. */
  UNKNOWN: "unknown",
};

/** Organizacinio patvirtinimo būsena. */
const APPROVAL = {
  /** Nereikalingas – apdorojimas vyksta lokaliai, duomenys neišeina. */
  NOT_REQUIRED: "not_required",
  /** Reikalingas ir duomenų valdytojo suteiktas (deployment prielaida). */
  GRANTED: "granted",
  /** Reikalingas, bet NESUTEIKTAS ar nežinomas – tiekėjas neleidžiamas. */
  REQUIRED: "required",
};

/**
 * VALDYSENOS ĮRAŠAI.
 *
 * ⚠️ Visos `external` tiekėjų savybės čia pažymėtos `assumed` arba `unknown`
 * SĄMONINGAI. Šis projektas jų **netikrino** su tiekėjais, o įrašyti
 * „verified" be patikrinimo reikštų tiksliai tą klaidą, nuo kurios #22 saugo:
 * neverifikuotų sutartinių garantijų teigimą.
 *
 * `granted` reikšmė reiškia ne „mes patikrinom", o „diegimo prielaida:
 * duomenų valdytojas tai patvirtino". Be to patvirtinimo tiekėjas neleidžiamas.
 */
const GOVERNANCE = {
  transcription: {
    mock: _local("Duomenys neapdorojami – fiksuotas atsakymas."),
    "faster-whisper-embedded": _local("Modelis vykdomas tame pačiame procese."),
    "faster-whisper-server": _local("Modelis vykdomas jūsų infrastruktūroje."),
    "faster-whisper": _local("Priklauso nuo profilio; abu variantai lokalūs."),
    whisper: _external("OpenAI"),
    azure: _external("Microsoft Azure"),
    google: _external("Google Cloud"),
    deepgram: _external("Deepgram"),
  },
  diarization: {
    none: _local("Diarizacija išjungta."),
    inline: _local("Naudojama transkribavimo tiekėjo diarizacija – atskiro siuntimo nėra."),
    mock: _local("Deterministiniai intervalai."),
    pyannote: _local("Modelis vykdomas jūsų infrastruktūroje."),
    "pyannote-cloud": _external("pyannote.ai"),
    assemblyai: _external("AssemblyAI"),
  },
  llm: {
    mock: _local("Heuristikos, be išorinio kvietimo."),
    claude: _external("Anthropic"),
    gpt: _external("OpenAI"),
    gemini: _external("Google"),
  },
};

/**
 * Lokalus tiekėjas: duomenys neišeina, tad regiono, retencijos ir mokymo
 * klausimai NETAIKOMI, o patvirtinimo nereikia.
 *
 * Tai vienintelis atvejis, kai `verified` yra sąžininga: apdorojimo vietą
 * galima patikrinti kode, ne tiekėjo pažadais.
 */
function _local(notes) {
  return {
    region: "n/a",
    retention: "n/a",
    modelTraining: "n/a",
    confidence: CONFIDENCE.VERIFIED,
    approval: APPROVAL.NOT_REQUIRED,
    notes,
  };
}

/**
 * Išorinis tiekėjas.
 *
 * ⚠️ VISI laukai `unknown`, o pasitikėjimas – `unknown`.
 *
 * Tai nėra spraga, kurią reikia užpildyti spėjimais: tai tiksli šio projekto
 * būklė. Konkretaus diegimo operatorius, patikrinęs tiekėjo sutartį, šias
 * reikšmes užpildo savo aplinkoje ir pažymi patvirtinimą.
 */
function _external(vendor) {
  return {
    region: UNKNOWN,
    retention: UNKNOWN,
    modelTraining: UNKNOWN,
    confidence: CONFIDENCE.UNKNOWN,
    approval: APPROVAL.REQUIRED,
    notes: `${vendor}: privatumo savybės šiame projekte NEPATIKRINTOS.`,
  };
}

/** Valdysenos įrašas konkrečiam tiekėjui. */
function governanceFor(kind, provider) {
  const byKind = GOVERNANCE[kind];
  if (!byKind) return null;

  return byKind[provider] || null;
}

/**
 * Ar tiekėją leidžiama naudoti?
 *
 * FAIL-CLOSED: nežinomas tiekėjas, nežinomas tipas ar trūkstamas įrašas
 * reiškia **neleidžiama**. Naujas tiekėjas, pridėtas be valdysenos įrašo,
 * neveiks, kol jo savybės nebus įvardytos — tai sąmoninga trintis.
 *
 * @returns {{allowed: boolean, reason?: string}}
 */
function isProviderAllowed(kind, provider, { approvedExternal = [] } = {}) {
  const entry = governanceFor(kind, provider);

  if (!entry) {
    return {
      allowed: false,
      reason: `tiekėjas "${provider}" (${kind}) neturi valdysenos įrašo – pridėkite jį į providerGovernance.js`,
    };
  }

  if (entry.approval === APPROVAL.NOT_REQUIRED) return { allowed: true };

  /**
   * Išoriniam tiekėjui reikia EKSPLICITINIO patvirtinimo diegime.
   *
   * ⚠️ ŠIS SĄRAŠAS ĮGYVENDINA jau priimtą duomenų valdytojo sprendimą — jis
   * jo NEĮRODO ir negali įrodyti.
   *
   * Kodas negali atskirti apgalvoto sprendimo nuo neatsargaus `.env`
   * pakeitimo: įrašius `claude` tiekėjas leidžiamas net tada, kai DPA
   * nepasirašyta, regionas nepatikrintas, o retencija nežinoma.
   *
   * Skirtumas svarbus: priešingu atveju konfigūracija atrodytų kaip
   * ATITIKTIES ĮRODYMAS, ir auditui būtų rodomas `.env` failas vietoj realaus
   * sprendimo įrašo.
   */
  if (approvedExternal.includes(provider)) return { allowed: true };

  return {
    allowed: false,
    reason:
      `tiekėjas "${provider}" (${kind}) yra išorinis ir nepatvirtintas. ` +
      `Patvirtinkite per APPROVED_EXTERNAL_PROVIDERS arba naudokite lokalų tiekėją.`,
  };
}

/**
 * Patvirtintų išorinių tiekėjų sąrašas iš konfigūracijos.
 *
 * Dublikatai šalinami: `claude,CLAUDE, claude` yra vienas tiekėjas, ir
 * diagnostikoje jis turi pasirodyti vieną kartą.
 */
function approvedExternalProviders(env = process.env) {
  const names = String(env.APPROVED_EXTERNAL_PROVIDERS || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(names)];
}

/**
 * Efektyvi tiekėjo politika DIAGNOSTIKAI.
 *
 * ⚠️ BE PASLAPČIŲ. Grąžinami tik politikos faktai — jokių raktų, endpoint'ų
 * ar kredencialų. Diagnostika turi atsakyti „ar leidžiama", ne „su kuo
 * jungiamasi".
 */
function describeGovernance(kind, provider, env = process.env) {
  const technical = MATRIX[kind] && MATRIX[kind][provider];
  const entry = governanceFor(kind, provider);

  if (!technical || !entry) return { kind, provider, known: false };

  const { allowed, reason } = isProviderAllowed(kind, provider, {
    approvedExternal: approvedExternalProviders(env),
  });

  return {
    kind,
    provider,
    known: true,
    processing: technical.processing,
    dataSent: technical.dataSent,
    region: entry.region,
    retention: entry.retention,
    modelTraining: entry.modelTraining,
    confidence: entry.confidence,
    approval: entry.approval,
    allowed,
    ...(reason ? { reason } : {}),
  };
}

/** Visi tiekėjai, kuriems reikia organizacinio patvirtinimo. */
function providersRequiringApproval() {
  const result = [];

  for (const [kind, byKind] of Object.entries(GOVERNANCE)) {
    for (const [provider, entry] of Object.entries(byKind)) {
      if (entry.approval === APPROVAL.REQUIRED) result.push({ kind, provider });
    }
  }

  return result;
}

/**
 * Meta klaidą, jei tiekėjas neleidžiamas.
 *
 * ⚠️ VIENA implementacija visiems trims fabrikams.
 *
 * Pirmoji #22.2 versija turėjo po kopiją kiekviename fabrike — trys beveik
 * identiškos funkcijos. Jos veikė vienodai, bet pakeitus vieną (pvz. pridėjus
 * audito įrašą ar patikslinus pranešimą) kitos dvi tyliai atsiliktų, ir
 * politika taptų nevienoda priklausomai nuo tiekėjo tipo.
 */
function assertProviderAllowed(kind, name, env = process.env) {
  const { allowed, reason } = isProviderAllowed(kind, name, {
    approvedExternal: approvedExternalProviders(env),
  });

  if (allowed) return;

  const error = new Error(`Tiekėjas neleidžiamas: ${reason}`);
  error.code = "PROVIDER_NOT_APPROVED";
  throw error;
}

/**
 * TESTINIO TIEKĖJO REGISTRACIJA.
 *
 * Testai injektuoja netikrus tiekėjus tiesiai į fabrikų `REGISTRY`. Kad
 * valdysena jų neblokuotų, jie privalo užregistruoti ir POLITIKĄ — tai
 * sąmoninga simetrija: netikras tiekėjas turi deklaruoti savo privatumo
 * savybes lygiai taip, kaip tikras.
 *
 * ⚠️ Veikia TIK `NODE_ENV=test`. Produkcijoje tai būtų būdas apeiti visą
 * valdyseną vienu kvietimu.
 *
 * @returns {Function} atstatymo funkcija (`finally` blokui)
 */
function registerTestProvider(kind, name, entry) {
  if (process.env.NODE_ENV !== "test") {
    const error = new Error("registerTestProvider veikia tik NODE_ENV=test.");
    error.code = "TEST_ONLY";
    throw error;
  }

  if (!GOVERNANCE[kind]) GOVERNANCE[kind] = {};

  const had = Object.prototype.hasOwnProperty.call(GOVERNANCE[kind], name);
  const previous = GOVERNANCE[kind][name];

  GOVERNANCE[kind][name] = entry;

  return () => {
    if (had) GOVERNANCE[kind][name] = previous;
    else delete GOVERNANCE[kind][name];
  };
}

module.exports = {
  GOVERNANCE,
  registerTestProvider,
  CONFIDENCE,
  APPROVAL,
  UNKNOWN,
  governanceFor,
  isProviderAllowed,
  assertProviderAllowed,
  approvedExternalProviders,
  describeGovernance,
  providersRequiringApproval,
  // Re-eksportas patogumui; vienintelis šaltinis - utils/providerPrivacy.js.
  LOCAL,
  EXTERNAL,
  DEPENDS,
};
