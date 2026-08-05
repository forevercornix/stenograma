const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * VERTINIMO DUOMENŲ RINKINIO MANIFESTAS (#23.1).
 *
 * ⚠️ MANIFESTE NĖRA NEI GARSO, NEI TRANSKRIPCIJŲ.
 *
 * Jis aprašo, KOKIE įrašai sudaro rinkinį ir kur jų ieškoti — bet patys failai
 * lieka už repozitorijos ribų. Priežastis paprasta: susitikimų įrašuose yra
 * asmens duomenų, o repozitorija vieša.
 *
 * Todėl manifestas turi būti pakankamas atkuriamumui (kas, kada, kokiomis
 * sąlygomis vertinta) ir nepakankamas duomenų atkūrimui.
 */

/** Palaikomos audio sąlygos – nuo jų priklauso, ką rezultatas reiškia. */
const AUDIO_CONDITIONS = Object.freeze({
  CLEAN: "clean",
  NOISY: "noisy",
  OVERLAPPING: "overlapping_speech",
  FAR_FIELD: "far_field",
  PHONE: "phone_quality",
});

/** Rinkinio paskirtis. */
const DATASET_SPLIT = Object.freeze({
  /**
   * Kūrimo rinkinys: ant jo galima derinti, žiūrėti klaidas, kartoti.
   */
  DEVELOPMENT: "development",
  /**
   * GALUTINIS vertinimo rinkinys.
   *
   * ⚠️ Naudojamas VIENĄ kartą, prieš tai apibrėžus ribas. Derinimas ant jo
   * paverstų kokybės vartus savimi patvirtinančiu ritualu: bet kurį rezultatą
   * galima „pagerinti", jei matai atsakymus.
   */
  FINAL: "final",
});

/** Kilmė – nuo jos priklauso, ar duomenis apskritai teisėta naudoti. */
const SAMPLE_ORIGIN = Object.freeze({
  /** Sintetinis (TTS ar sugeneruotas) – asmens duomenų nėra. */
  SYNTHETIC: "synthetic",
  /** Realus įrašas su dokumentuotu dalyvių sutikimu. */
  CONSENTED: "consented",
  /** Viešas rinkinys su leidžiama licencija. */
  PUBLIC_DATASET: "public_dataset",
});

const REQUIRED_SAMPLE_FIELDS = [
  "id",
  "durationSeconds",
  "speakers",
  "condition",
  "origin",
  "language",
  /**
   * ⚠️ `split` PRIVALOMAS.
   *
   * Kūrimo ir galutinio rinkinių atskyrimas yra kertinė metodologijos
   * taisyklė. Palikus lauką neprivalomą, visi įrašai galėjo jo neturėti,
   * manifestas liktų validus, ir taisyklė būtų tik dokumentacija.
   */
  "split",
];

/**
 * LEIDŽIAMI LAUKAI – GRIEŽTAS ALLOWLIST.
 *
 * ⚠️ Privalomų laukų sąrašo NEPAKANKA: jis neuždraudžia PAPILDOMŲ. Manifestas
 * su `transcript` ar `audioBase64` būtų praėjęs validaciją, nors garantija
 * skelbia, kad turinio jame nėra.
 *
 * Repozitorija vieša, tad tai buvo tiesioginė privatumo spraga formate, kurio
 * paskirtis — turinio NETURĖTI.
 */
const ALLOWED_SAMPLE_FIELDS = new Set([
  ...["id", "durationSeconds", "speakers", "condition", "origin", "language", "split"],
  /** Neasmeniniai nuorodų raktai – kur ieškoti failų už repozitorijos ribų. */
  "storageRef",
  "referenceRef",
  /** Kontrolinės sumos vientisumui – jos turinio neatkuria. */
  "audioChecksum",
  "referenceChecksum",
  /** Laisvos pastabos apie sąlygas (be asmens duomenų). */
  "notes",
]);

/**
 * Laukų vardai, kurie NIEKADA neleidžiami, net jei atrodytų nekalti.
 *
 * Sąrašas atskiras nuo allowlist sąmoningai: jis leidžia duoti KONKREČIĄ
 * klaidą („čia gali būti turinys"), o ne bendrą „nežinomas laukas".
 */
const FORBIDDEN_SAMPLE_FIELDS = new Set([
  "transcript",
  "text",
  "content",
  "audio",
  "audioBase64",
  "audioData",
  "participants",
  "participantNames",
  "speakerNames",
]);

/**
 * Patikrina manifestą.
 *
 * FAIL-CLOSED: bet kuris trūkstamas ar netinkamas laukas reiškia, kad
 * rinkiniu remtis negalima. Vertinimas su neaiškiu rinkiniu duoda skaičių,
 * kurio prasmės niekas negali paaiškinti.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["manifesto nėra arba jis netinkamo tipo"] };
  }

  if (!manifest.version) errors.push("trūksta `version` – be jos rezultatų nebus galima susieti su rinkiniu");
  if (!manifest.createdAt) errors.push("trūksta `createdAt`");

  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    errors.push("`samples` privalo būti netuščias masyvas");
    return { valid: false, errors };
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    errors.push("`version` privalo būti netuščia eilutė");
  }

  /**
   * ⚠️ GRIEŽTAS ISO 8601, ne `Date.parse`.
   *
   * `Date.parse` priima daug nestandartinių formatų („Aug 5 2026"), kurių
   * interpretacija priklauso nuo aplinkos. Vertinimo rezultatai turi būti
   * atkuriami po metų ir kitoje mašinoje, tad data privalo būti vienareikšmė.
   */
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

  if (typeof manifest.createdAt !== "string" || !ISO_TIMESTAMP.test(manifest.createdAt)) {
    errors.push("`createdAt` privalo būti ISO 8601 data (pvz. 2026-08-05 arba 2026-08-05T12:00:00Z)");
  } else if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    errors.push("`createdAt` nėra galiojanti data");
  }

  const seenIds = new Set();

  for (const [index, sample] of manifest.samples.entries()) {
    const label = sample && sample.id ? `"${sample.id}"` : `#${index}`;

    if (!sample || typeof sample !== "object") {
      errors.push(`įrašas ${label}: nėra objektas`);
      continue;
    }

    /**
     * DRAUDŽIAMI IR NEŽINOMI LAUKAI.
     *
     * Tikrinama PIRMA: jei įraše yra turinio, tolesnės klaidos apie tipus
     * nesvarbios – manifestas nepriimtinas iš principo.
     */
    for (const key of Object.keys(sample)) {
      if (FORBIDDEN_SAMPLE_FIELDS.has(key)) {
        errors.push(`įrašas ${label}: laukas "${key}" NELEIDŽIAMAS – manifeste negali būti turinio`);
      } else if (!ALLOWED_SAMPLE_FIELDS.has(key)) {
        errors.push(`įrašas ${label}: nežinomas laukas "${key}" (leidžiami: ${[...ALLOWED_SAMPLE_FIELDS].join(", ")})`);
      }
    }

    for (const field of REQUIRED_SAMPLE_FIELDS) {
      if (sample[field] === undefined || sample[field] === null) {
        errors.push(`įrašas ${label}: trūksta lauko \`${field}\``);
      }
    }

    /**
     * TIPŲ IR RIBŲ PATIKRA.
     *
     * Be jos `durationSeconds: "ilgas"` ar `speakers: "du"` praeitų, o vėliau
     * sugadintų aprėpties skaičiavimą ir atspaudą — tyliai, be klaidos.
     */
    if (sample.id !== undefined && (typeof sample.id !== "string" || !sample.id.trim())) {
      errors.push(`įrašas ${label}: \`id\` privalo būti netuščia eilutė`);
    }

    if (sample.durationSeconds !== undefined) {
      const duration = sample.durationSeconds;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
        errors.push(`įrašas ${label}: \`durationSeconds\` privalo būti baigtinis skaičius > 0`);
      }
    }

    if (sample.language !== undefined && (typeof sample.language !== "string" || !sample.language.trim())) {
      errors.push(`įrašas ${label}: \`language\` privalo būti netuščia eilutė`);
    }

    if (sample.id) {
      if (seenIds.has(sample.id)) errors.push(`įrašo ID kartojasi: "${sample.id}"`);
      seenIds.add(sample.id);
    }

    if (sample.condition && !Object.values(AUDIO_CONDITIONS).includes(sample.condition)) {
      errors.push(`įrašas ${label}: nežinoma sąlyga "${sample.condition}"`);
    }

    /**
     * ⚠️ KILMĖ PRIVALOMA IR RIBOTA.
     *
     * Įrašas be aiškios kilmės negali būti naudojamas: vertinimo duomenys
     * gyvena ilgai, keliauja tarp žmonių ir patenka į ataskaitas. Neaiški
     * kilmė čia reiškia neaiškų teisinį pagrindą.
     */
    if (sample.origin && !Object.values(SAMPLE_ORIGIN).includes(sample.origin)) {
      errors.push(`įrašas ${label}: nežinoma kilmė "${sample.origin}"`);
    }

    if (sample.split && !Object.values(DATASET_SPLIT).includes(sample.split)) {
      errors.push(`įrašas ${label}: nežinomas rinkinys "${sample.split}"`);
    }

    if (sample.speakers !== undefined) {
      if (!Number.isInteger(sample.speakers) || sample.speakers < 1) {
        errors.push(`įrašas ${label}: \`speakers\` privalo būti sveikasis skaičius >= 1`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Ar rinkinys pakankamai ĮVAIRUS, kad rezultatas ką nors reikštų?
 *
 * ⚠️ Vertinimas su vienodais įrašais duoda tikslų skaičių apie siaurą atvejį
 * ir sukuria įspūdį, kad išmatuota kokybė apskritai.
 *
 * Tai NĖRA fail-closed patikra: rinkinys gali būti sąmoningai siauras
 * ankstyvoje stadijoje. Bet spragos turi būti MATOMOS ataskaitoje, ne
 * nutylėtos.
 */
function assessCoverage(manifest) {
  const samples = manifest.samples || [];

  const conditions = new Set(samples.map((s) => s.condition).filter(Boolean));
  const languages = new Set(samples.map((s) => s.language).filter(Boolean));
  const speakerCounts = new Set(samples.map((s) => s.speakers).filter(Boolean));

  const durations = samples.map((s) => s.durationSeconds).filter((d) => typeof d === "number");

  const gaps = [];

  /**
   * ⚠️ `far_field` ir `phone_quality` SĄMONINGAI nelaikomi spragomis.
   *
   * Jos yra REKOMENDUOJAMOS, ne privalomos pilotui: numatytas naudojimo
   * atvejis yra artimas mikrofonas posėdžių salėje. Jų įtraukimas į privalomų
   * sąrašą reikštų, kad kiekvienas rinkinys be salės įrašo atrodo nepilnas,
   * nors matuoja būtent tai, ką reikia.
   *
   * Bet jei jos rinkinyje YRA, rezultatas vertingesnis — riba tampa matoma, o
   * ne atrandama pilote.
   */
  if (!conditions.has(AUDIO_CONDITIONS.CLEAN)) gaps.push("nėra švaraus garso įrašų");
  if (!conditions.has(AUDIO_CONDITIONS.NOISY)) gaps.push("nėra triukšmingų įrašų");
  if (!conditions.has(AUDIO_CONDITIONS.OVERLAPPING)) gaps.push("nėra persidengiančios kalbos");

  /**
   * ⚠️ `far_field` ir `phone_quality` SĄMONINGAI nėra spragos.
   *
   * Jos REKOMENDUOJAMOS, bet neprivalomos pilotui: ne kiekvienas diegimas
   * susiduria su salės mikrofonu ar telefono kanalu. Įtraukus jas į spragas,
   * kiekvienas rinkinys atrodytų nepilnas, ir sąrašas nustotų reikšti
   * „trūksta to, kas būtina".
   *
   * Jei jūsų pilote tokios sąlygos pasitaiko, jų nebuvimą reikia laikyti
   * spraga — bet tai diegimo, ne karkaso sprendimas.
   */
  if (!languages.has("lt")) gaps.push("nėra lietuviškų įrašų");
  if (![...speakerCounts].some((count) => count >= 3)) gaps.push("nėra įrašų su 3+ kalbėtojais");

  if (durations.length > 0) {
    if (!durations.some((d) => d < 300)) gaps.push("nėra trumpų (<5 min) įrašų");
    if (!durations.some((d) => d > 1800)) gaps.push("nėra ilgų (>30 min) įrašų");
  }

  return {
    conditions: [...conditions],
    languages: [...languages],
    speakerRange: speakerCounts.size ? [Math.min(...speakerCounts), Math.max(...speakerCounts)] : null,
    durationRange: durations.length ? [Math.min(...durations), Math.max(...durations)] : null,
    totalSamples: samples.length,
    gaps,
  };
}

/**
 * Rinkinio tapatybė rezultatams.
 *
 * ⚠️ SEMANTIKA: atspaudas atsako „ar tas pats VERTINIMO RINKINYS", ne „ar tas
 * pats manifesto failas".
 *
 * Todėl į jį įeina laukai, keičiantys rezultato PRASMĘ (kokie įrašai, kokia
 * kilmė, kuris rinkinys), bet neįeina `storageRef` ar `audioChecksum`:
 * failo perkėlimas į kitą saugyklą ar sumos perskaičiavimas rinkinio
 * nepakeičia.
 *
 * Jei prireiktų atsakyti „ar failai tie patys", tam yra `audioChecksum` —
 * atskiras klausimas, sprendžiamas atskirai.
 *
 * Kontrolinė suma skaičiuojama nuo METADUOMENŲ, ne nuo garso: taip rezultatą
 * galima susieti su konkrečia rinkinio versija, neturint pačių failų.
 *
 * ⚠️ SEMANTIKA: atspaudas atsako „ar tas pats VERTINIMO RINKINYS", ne „ar tas
 * pats manifesto failas".
 *
 * Todėl į jį NEĮTRAUKIAMI `storageRef`, `audioChecksum` ir panašūs laukai:
 * failo perkėlimas į kitą saugyklą ar kontrolinės sumos perskaičiavimas
 * nekeičia to, KĄ vertiname. Priešingu atveju rezultatų nebūtų galima
 * palyginti po nekalto infrastruktūros pakeitimo.
 *
 * ⚠️ Tai NEĮRODO, kad failai nepakito — tik kad rinkinio APIBRĖŽIMAS tas pats.
 * Failų vientisumas sprendžiamas per `audioChecksum`, ir tai atskiras
 * klausimas.
 */
function manifestFingerprint(manifest) {
  /**
   * ⚠️ ĮTRAUKIAMI `origin` IR `split`.
   *
   * Pirmoji versija jų neapėmė, tad rinkinys iš sintetinių kūrimo įrašų ir
   * rinkinys iš realių GALUTINIŲ įrašų gaudavo TĄ PATĮ atspaudą — nors
   * metodologiškai ir teisiškai tai visiškai skirtingi rinkiniai.
   *
   * Atspaudas naudojamas rezultatui susieti su rinkinio versija, tad jis
   * privalo apimti viską, kas keičia rezultato PRASMĘ.
   */
  const canonical = (manifest.samples || [])
    .map((s) => `${s.id}|${s.durationSeconds}|${s.speakers}|${s.condition}|${s.language}|${s.origin}|${s.split}`)
    .sort()
    .join("\n");

  return crypto.createHash("sha256").update(`${manifest.version}\n${canonical}`).digest("hex").slice(0, 16);
}

/** Įkelia manifestą iš failo su aiškia klaida, jei jo nėra. */
function loadManifest(filePath) {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    const error = new Error(`Vertinimo manifestas nerastas: ${resolved}`);
    error.code = "MANIFEST_NOT_FOUND";
    throw error;
  }

  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

module.exports = {
  AUDIO_CONDITIONS,
  DATASET_SPLIT,
  SAMPLE_ORIGIN,
  REQUIRED_SAMPLE_FIELDS,
  validateManifest,
  assessCoverage,
  manifestFingerprint,
  loadManifest,
};
