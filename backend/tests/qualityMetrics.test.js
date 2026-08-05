const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const metrics = require("../utils/qualityMetrics");
const manifest = require("../utils/evaluationManifest");

/**
 * #23.1: VERTINIMO KARKASAS.
 *
 * Šis etapas nieko nevertina — jis paruošia MATAVIMO priemones. Rezultatai
 * yra #23.2, sprendimas „ar pilotas gali startuoti" — #23.3.
 *
 * Testai čia svarbūs ypatingu būdu: metrika su klaida duotų skaičių, kuris
 * atrodo patikimai ir yra neteisingas. Neteisingas WER blogesnis nei jokio —
 * juo remiantis būtų priimtas sprendimas apie pilotą.
 */

/* ------------------------------------------------------------------ */
/* NORMALIZAVIMAS                                                      */
/* ------------------------------------------------------------------ */

test("NORMALIZAVIMAS: lietuviški diakritikai IŠLAIKOMI", () => {
  /**
   * ⚠️ „Šalis" ir „salis" yra SKIRTINGI žodžiai.
   *
   * Diakritikų šalinimas dirbtinai pagerintų WER ir paslėptų realų trūkumą,
   * kuris protokole matomas. Tai ne griežtumas dėl griežtumo: klaidingas
   * žodis protokole keičia prasmę.
   */
  assert.deepEqual(metrics.normalize("Šalis šildo"), ["šalis", "šildo"]);
  assert.equal(metrics.NORMALIZATION_RULES.stripDiacritics, false);

  const result = metrics.wordErrorRate("šalis", "salis");
  assert.ok(result.wer > 0, "diakritikos klaida turi būti skaičiuojama");
});

test("NORMALIZAVIMAS: skaitmenys NEKEIČIAMI į žodžius", () => {
  /**
   * Protokole data turi būti teisinga, ir „2026" vs „du tūkstančiai dvidešimt
   * šeši" yra tikra klaida, ne formato skirtumas.
   */
  assert.equal(metrics.NORMALIZATION_RULES.normalizeNumbers, false);
  assert.ok(metrics.wordErrorRate("2026 metai", "du tūkstančiai dvidešimt šeši metai").wer > 0);
});

test("NORMALIZAVIMAS: skyryba ir raidžių dydis nekeičia rezultato", () => {
  /**
   * Whisper skyrybą deda pagal savo taisykles, žmogus — pagal kitas. Lyginti
   * jas reikštų matuoti skyrybos stilių, ne atpažinimą.
   */
  const result = metrics.wordErrorRate("Jonas kalbėjo, ilgai.", "jonas kalbėjo ilgai");

  assert.equal(result.wer, 0, "skyryba ir didžiosios raidės neturi kurti klaidų");
});

/* ------------------------------------------------------------------ */
/* WER                                                                 */
/* ------------------------------------------------------------------ */

test("WER: identiškas tekstas duoda 0", () => {
  assert.equal(metrics.wordErrorRate("posėdis prasideda", "posėdis prasideda").wer, 0);
});

test("WER: operacijos skaidomos į S/I/D", () => {
  /**
   * Be šio skaidymo nebūtų galima atsakyti, KOKIA klaida vyrauja — o tai yra
   * #23.2 gedimų analizės pagrindas. „WER 18%" nieko nesako, jei nežinai, ar
   * modelis praleidžia žodžius, ar prigalvoja savų.
   */
  const substitution = metrics.wordErrorRate("vienas du trys", "vienas keturi trys");
  assert.equal(substitution.substitutions, 1);
  assert.equal(substitution.insertions, 0);
  assert.equal(substitution.deletions, 0);

  const deletion = metrics.wordErrorRate("vienas du trys", "vienas trys");
  assert.equal(deletion.deletions, 1);

  const insertion = metrics.wordErrorRate("vienas trys", "vienas du trys");
  assert.equal(insertion.insertions, 1);
});

test("WER: gali VIRŠYTI 100% – reikšmė neapkerpama", () => {
  /**
   * Jei sistema prigeneravo daugiau žodžių, nei jų buvo, WER > 1. Apkirpus iki
   * 100% dingtų informacija apie tai, kaip stipriai modelis haliucinuoja — o
   * tai realus `tiny` modelio elgesys lietuvių kalbai.
   */
  const result = metrics.wordErrorRate("taip", "taip taip taip taip taip");

  assert.ok(result.wer > 1, `laukta WER > 1, gauta ${result.wer}`);
  assert.equal(result.insertions, 4);
});

test("WER: tuščias referencinis tekstas grąžina `null`, ne 0", () => {
  /**
   * „0% klaidų" būtų melas: jei sistema kažką grąžino, o referencinis tuščias,
   * tai 100% įterpimų. Dalyba iš nulio negalima, tad grąžinamas `null` su
   * paaiškinimu.
   */
  const withOutput = metrics.wordErrorRate("", "kažkas atsirado");

  assert.equal(withOutput.wer, null);
  assert.match(withOutput.note, /neapibrėžtas/);

  // Abu tušti – tai teisėtas 0.
  assert.equal(metrics.wordErrorRate("", "").wer, 0);
});

test("WER: skaičiuojamas nuo REFERENCINIO ilgio", () => {
  /**
   * WER = (S+I+D)/N, kur N – referencinio teksto žodžiai. Dalyba iš hipotezės
   * ilgio duotų mažesnį skaičių būtent tada, kai sistema prigeneravo daug —
   * t. y. slėptų blogiausią atvejį.
   */
  const result = metrics.wordErrorRate("vienas du trys keturi", "vienas");

  assert.equal(result.referenceWords, 4);
  assert.equal(result.wer, 3 / 4);
});

/* ------------------------------------------------------------------ */
/* CER                                                                 */
/* ------------------------------------------------------------------ */

test("CER: atskiria linksniavimo klaidą nuo nesuprasto žodžio", () => {
  /**
   * ⚠️ TAI PAGRINDINĖ CER PRIDĖTINĖ VERTĖ LIETUVIŲ KALBAI.
   *
   * WER laiko „biudžetą" ir „biudžeta" visiškai skirtingais (100% to žodžio
   * klaida), nors skiriasi viena raidė. CER parodo, ar modelis nesupranta
   * žodžio, ar tik linksniuoja kitaip.
   */
  const wer = metrics.wordErrorRate("aptarėme biudžetą", "aptarėme biudžeta");
  const cer = metrics.characterErrorRate("aptarėme biudžetą", "aptarėme biudžeta");

  assert.ok(cer.cer < wer.wer, `CER (${cer.cer}) turi būti mažesnis nei WER (${wer.wer})`);
  assert.ok(cer.cer > 0, "bet klaida vis tiek skaičiuojama");
});

/* ------------------------------------------------------------------ */
/* KALBĖTOJŲ PRISKYRIMAS                                               */
/* ------------------------------------------------------------------ */

test("KALBĖTOJAI: vardų skirtumas NEBAUDŽIAMAS – ieškoma susiejimo", () => {
  /**
   * Viena sistema sako „SPEAKER_00", kita — „Jonas". Tiesioginis lyginimas
   * duotų 0% tikslumą tobulai suskirsčiusiai sistemai.
   */
  const reference = [
    { speaker: "Jonas" },
    { speaker: "Petras" },
    { speaker: "Jonas" },
    { speaker: "Petras" },
  ];
  const hypothesis = [
    { speaker: "SPEAKER_00" },
    { speaker: "SPEAKER_01" },
    { speaker: "SPEAKER_00" },
    { speaker: "SPEAKER_01" },
  ];

  const result = metrics.speakerAttributionRate(reference, hypothesis);

  assert.equal(result.accuracy, 1, "teisingas suskirstymas turi duoti 100%");
});

test("KALBĖTOJAI: klaidingas priskyrimas mažina tikslumą", () => {
  const reference = [{ speaker: "A" }, { speaker: "B" }, { speaker: "A" }, { speaker: "B" }];
  const hypothesis = [{ speaker: "X" }, { speaker: "X" }, { speaker: "X" }, { speaker: "Y" }];

  const result = metrics.speakerAttributionRate(reference, hypothesis);

  assert.ok(result.accuracy < 1, "sumaišyti kalbėtojai turi mažinti tikslumą");
});

test("KALBĖTOJAI: segmentų skaičiaus neatitikimas ĮVARDIJAMAS atskirai", () => {
  /**
   * Jei sistema suskaidė kalbą kitaip, priskyrimo tikslumas mažiau
   * reikšmingas — tai savarankiškas signalas, ne detalė.
   */
  const result = metrics.speakerAttributionRate(
    [{ speaker: "A" }, { speaker: "B" }, { speaker: "A" }],
    [{ speaker: "X" }, { speaker: "Y" }]
  );

  assert.equal(result.segmentCountMismatch, true);
  assert.equal(result.missedSegments, 1, "trūkstami segmentai turi būti suskaičiuoti");
});

test("KALBĖTOJAI: metrika NEVADINAMA standartiniu DER", () => {
  /**
   * ⚠️ SĄŽININGUMO PATIKRA.
   *
   * Kanoninis DER (NIST) matuoja LAIKO proporcijas su „forgiveness collar" ir
   * optimaliu susiejimu. Mūsų metrika matuoja SEGMENTŲ priskyrimą — silpnesnė
   * ir NEPALYGINAMA su publikuojamais DER skaičiais.
   *
   * Pavadinus ją DER, ataskaita teigtų palyginamumą, kurio nėra.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "qualityMetrics.js"), "utf8");

  assert.match(source, /NĖRA standartinis DER/, "riba turi būti įvardyta");
  assert.match(source, /NEPALYGINAMAS/, "pasekmė turi būti įvardyta");

  assert.equal(typeof metrics.speakerAttributionRate, "function");
  assert.equal(metrics.diarizationErrorRate, undefined, "funkcija neturi vadintis DER");
});

/* ------------------------------------------------------------------ */
/* MANIFESTAS                                                          */
/* ------------------------------------------------------------------ */

test("MANIFESTAS: privalomi laukai tikrinami KIEKVIENAM įrašui", () => {
  const { valid, errors } = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05",
    samples: [{ id: "a" }],
  });

  assert.equal(valid, false);

  for (const field of manifest.REQUIRED_SAMPLE_FIELDS) {
    if (field === "id") continue;
    assert.ok(
      errors.some((error) => error.includes(field)),
      `trūkstamas laukas \`${field}\` neaptiktas`
    );
  }
});

test("MANIFESTAS: kilmė PRIVALOMA ir ribota sąrašu", () => {
  /**
   * ⚠️ Vertinimo duomenys gyvena ilgai, keliauja tarp žmonių ir patenka į
   * ataskaitas. Neaiški kilmė čia reiškia neaiškų teisinį pagrindą.
   */
  const { errors } = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05",
    samples: [
      {
        id: "a",
        durationSeconds: 60,
        speakers: 2,
        condition: "clean",
        language: "lt",
        origin: "kažkur radau",
      },
    ],
  });

  assert.ok(errors.some((error) => /nežinoma kilmė/.test(error)));

  // Ir leidžiamos reikšmės ribotos.
  assert.deepEqual(Object.values(manifest.SAMPLE_ORIGIN).sort(), ["consented", "public_dataset", "synthetic"]);
});

test("MANIFESTAS: pasikartojantis ID aptinkamas", () => {
  /**
   * Dublikatas reikštų, kad tas pats įrašas vertinamas du kartus ir
   * neproporcingai veikia vidurkį.
   */
  const sample = {
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    origin: "synthetic",
    language: "lt",
  };

  const { errors } = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05",
    samples: [
      { id: "tas-pats", ...sample },
      { id: "tas-pats", ...sample },
    ],
  });

  assert.ok(errors.some((error) => /kartojasi/.test(error)));
});

test("APRĖPTIS: spragos ĮVARDIJAMOS, bet nestabdo", () => {
  /**
   * Rinkinys gali būti sąmoningai siauras ankstyvoje stadijoje. Bet spragos
   * turi būti MATOMOS ataskaitoje: vertinimas su vienodais įrašais duoda
   * tikslų skaičių apie siaurą atvejį ir sukuria įspūdį, kad išmatuota kokybė
   * apskritai.
   */
  const coverage = manifest.assessCoverage({
    samples: [
      {
        id: "a",
        durationSeconds: 60,
        speakers: 2,
        condition: "clean",
        language: "lt",
        origin: "synthetic",
      },
    ],
  });

  assert.ok(coverage.gaps.length > 0, "siauras rinkinys turi turėti spragų");
  assert.ok(coverage.gaps.some((gap) => /triukšming/.test(gap)));
  assert.ok(coverage.gaps.some((gap) => /persidengianči/.test(gap)));
  assert.ok(coverage.gaps.some((gap) => /ilg/.test(gap)));
});

test("APRĖPTIS: lietuvių kalbos trūkumas įvardijamas", () => {
  /**
   * #23 eksplicitiškai reikalauja lietuviškos medžiagos. Rinkinys be jos
   * matuotų kitą kalbą nei ta, kuriai sistema skirta.
   */
  const coverage = manifest.assessCoverage({
    samples: [{ id: "a", durationSeconds: 60, speakers: 2, condition: "clean", language: "en" }],
  });

  assert.ok(coverage.gaps.some((gap) => /lietuvišk/.test(gap)));
});

test("ATSPAUDAS: keičiasi su rinkiniu, nepriklauso nuo tvarkos", () => {
  /**
   * Rezultatą reikia susieti su konkrečia rinkinio versija. Priklausomybė nuo
   * įrašų tvarkos reikštų, kad tas pats rinkinys duoda skirtingus atspaudus.
   */
  const base = {
    version: "1.0",
    samples: [
      { id: "a", durationSeconds: 60, speakers: 2, condition: "clean", language: "lt" },
      { id: "b", durationSeconds: 120, speakers: 3, condition: "noisy", language: "lt" },
    ],
  };

  const reordered = { ...base, samples: [...base.samples].reverse() };
  assert.equal(manifest.manifestFingerprint(base), manifest.manifestFingerprint(reordered));

  const changed = {
    ...base,
    samples: [...base.samples, { id: "c", durationSeconds: 30, speakers: 1, condition: "clean", language: "lt" }],
  };
  assert.notEqual(manifest.manifestFingerprint(base), manifest.manifestFingerprint(changed));
});

test("RINKINIAI: kūrimo ir GALUTINIS atskirti", () => {
  /**
   * ⚠️ Galutinis rinkinys naudojamas VIENĄ kartą, prieš tai apibrėžus ribas.
   *
   * Derinimas ant jo paverstų kokybės vartus savimi patvirtinančiu ritualu:
   * bet kurį rezultatą galima „pagerinti", jei matai atsakymus.
   */
  assert.deepEqual(Object.values(manifest.DATASET_SPLIT).sort(), ["development", "final"]);

  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "evaluationManifest.js"), "utf8");

  assert.match(source, /Naudojamas VIENĄ kartą/, "taisyklė turi būti užrašyta");
});

test("PRIVATUMAS: manifeste NĖRA nei garso, nei transkripcijų", () => {
  /**
   * Manifestas turi būti pakankamas ATKURIAMUMUI (kas, kada, kokiomis
   * sąlygomis vertinta) ir NEPAKANKAMAS duomenų atkūrimui — repozitorija
   * vieša, o susitikimų įrašuose yra asmens duomenų.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "evaluationManifest.js"), "utf8");

  assert.match(source, /MANIFESTE NĖRA NEI GARSO, NEI TRANSKRIPCIJŲ/);

  // Ir privalomų laukų sąraše nėra turinio.
  for (const field of manifest.REQUIRED_SAMPLE_FIELDS) {
    assert.ok(
      !/transcript|audio|text|content/i.test(field),
      `privalomas laukas "${field}" gali turėti turinio`
    );
  }
});

/* ------------------------------------------------------------------ */
/* PROTOKOLO DOKUMENTAS                                                */
/* ------------------------------------------------------------------ */

test("PROTOKOLAS: dokumentas egzistuoja ir sutampa su normalizavimo taisyklėmis", () => {
  /**
   * ⚠️ Normalizavimo taisyklės kode ir protokole yra du atskiri tekstai.
   * Išsiskyrus jiems, ataskaita aprašytų vieną metodiką, o skaičiai būtų
   * apskaičiuoti pagal kitą — ir niekas to nepastebėtų, nes abu atrodytų
   * teisingi.
   */
  const fs = require("fs");
  const path = require("path");

  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "evaluation-protocol.md"), "utf8");

  const documented = {
    stripDiacritics: /[Dd]iakritikai išlaikomi/.test(doc) ? false : true,
    normalizeNumbers: /[Ss]kaitmenys nekeičiami/.test(doc) ? false : true,
  };

  assert.equal(
    documented.stripDiacritics,
    metrics.NORMALIZATION_RULES.stripDiacritics,
    "diakritikų taisyklė dokumente išsiskyrė su kodu"
  );
  assert.equal(
    documented.normalizeNumbers,
    metrics.NORMALIZATION_RULES.normalizeNumbers,
    "skaitmenų taisyklė dokumente išsiskyrė su kodu"
  );
});

test("PROTOKOLAS: įvardyta, kad rašomas PRIEŠ matavimą", () => {
  /**
   * Apibrėžus metodiką po to, kai rezultatai matomi, ji neišvengiamai
   * pasirenkama taip, kad rezultatai atrodytų geriau — net be blogos valios.
   */
  const fs = require("fs");
  const path = require("path");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "evaluation-protocol.md"), "utf8");

  assert.match(doc, /[Pp]rotokolas rašomas PRIEŠ matavimą/);
  assert.match(doc, /net be blogos valios/);
});

test("PROTOKOLAS: DER riba įvardyta ir dokumente", () => {
  const fs = require("fs");
  const path = require("path");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "evaluation-protocol.md"), "utf8");

  assert.match(doc, /NĖRA standartinis DER/);
  assert.match(doc, /[Nn]epalyginamas su publikuojamais DER/);
});

test("PROTOKOLAS: visos privalomos rinkinio kategorijos dokumentuotos", () => {
  const fs = require("fs");
  const path = require("path");
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "evaluation-protocol.md"), "utf8");

  for (const condition of Object.values(manifest.AUDIO_CONDITIONS)) {
    const readable = { clean: "vari|švar", noisy: "triukšming", overlapping_speech: "persidengianti",
      far_field: "far_field|toli", phone_quality: "phone|telefon" }[condition];

    if (!readable) continue;
    assert.match(doc, new RegExp(readable, "i"), `sąlyga "${condition}" nedokumentuota`);
  }

  for (const origin of Object.values(manifest.SAMPLE_ORIGIN)) {
    assert.match(doc, new RegExp(`\`${origin}\``), `kilmė "${origin}" nedokumentuota`);
  }
});

/* ------------------------------------------------------------------ */
/* KALBĖTOJŲ METRIKOS TAISYMAI                                         */
/* ------------------------------------------------------------------ */

test("KALBĖTOJAI: prarasti segmentai NEGALI duoti 100%", () => {
  /**
   * ⚠️ REALUS DEFEKTAS, rastas peržiūroje.
   *
   * Pirmoji versija lygino tik `min(ref, hyp)` segmentų ir dalijo iš palygintų.
   * Sistema, praradusi PUSĘ kalbos, gaudavo `accuracy: 1` — pagrindinė metrika
   * sakė „tobula".
   *
   * `segmentCountMismatch` vėliavos nepakako: niekas negarantuoja, kad kokybės
   * vartai (#23.3) ją įtrauks. Blogiausia kokybės metrikos klaida yra ne
   * kritimas, o įtikinamai atrodantis neteisingas skaičius.
   */
  const result = metrics.speakerAttributionRate(
    [{ speaker: "A" }, { speaker: "B" }, { speaker: "A" }, { speaker: "B" }],
    [{ speaker: "X" }, { speaker: "Y" }]
  );

  assert.notEqual(result.accuracy, 1, "prarasta pusė segmentų negali duoti 100%");
  assert.equal(result.accuracy, 0.5, "vardiklis turi būti DIDESNIS iš dviejų");
  assert.equal(result.missedSegments, 2);
});

test("KALBĖTOJAI: PERTEKLINIAI segmentai irgi mažina tikslumą", () => {
  /**
   * Sistema, suskaidžiusi kalbą per smulkiai, klysta ne mažiau nei praradusi
   * segmentus — tik kita kryptimi.
   */
  const result = metrics.speakerAttributionRate(
    [{ speaker: "A" }, { speaker: "B" }],
    [{ speaker: "X" }, { speaker: "Y" }, { speaker: "X" }, { speaker: "Y" }]
  );

  assert.ok(result.accuracy < 1);
  assert.equal(result.extraSegments, 2);
});

test("KALBĖTOJAI: susiejimas OPTIMALUS, ne godus", () => {
  /**
   * Godus algoritmas gali paimti didžiausią individualią porą ir taip
   * užblokuoti dvi kitas, kurių bendra suma būtų geresnė.
   *
   * Kalbėtojų posėdyje nedaug, tad optimalų atsakymą galima rasti išbandant
   * visas permutacijas — be papildomos priklausomybės.
   */
  const result = metrics.speakerAttributionRate(
    [{ speaker: "A" }, { speaker: "A" }, { speaker: "B" }, { speaker: "C" }],
    [{ speaker: "X" }, { speaker: "X" }, { speaker: "Y" }, { speaker: "Z" }]
  );

  assert.equal(result.mappingMethod, "optimal");
  assert.equal(result.accuracy, 1, "optimalus susiejimas turi rasti tobulą atitikmenį");
});

test("KALBĖTOJAI: susiejimo metodas GRĄŽINAMAS", () => {
  /**
   * Daug kalbėtojų reiškia godų susiejimą ir galimai PESIMISTINĮ rezultatą.
   * Ataskaita turi galėti tai įvardyti, o kokybės vartai — neremtis juo kaip
   * tiksliu skaičiumi.
   */
  const result = metrics.speakerAttributionRate([{ speaker: "A" }], [{ speaker: "X" }]);

  assert.ok(["optimal", "greedy"].includes(result.mappingMethod));
});

/* ------------------------------------------------------------------ */
/* SKYRYBA                                                             */
/* ------------------------------------------------------------------ */

test("SKYRYBA: tipografinės kabutės ir brūkšniai NEKURIA klaidų", () => {
  /**
   * ⚠️ REALUS DEFEKTAS: pirmoji versija turėjo rankinį simbolių sąrašą ir
   * nepašalindavo tipografinių kabučių. Vizualiai identiškas tekstas gaudavo
   * 100% WER — dokumentacija skelbė „skyryba pašalinama", o kodas šalino tik
   * dalį jos.
   */
  for (const [reference, hypothesis, label] of [
    ["Sprendimas — priimtas", "Sprendimas priimtas", "ilgas brūkšnys"],
    ["Sprendimas – priimtas", "Sprendimas priimtas", "vidutinis brūkšnys"],
    ["\u201cSprendimas\u201d", "Sprendimas", "tipografinės kabutės"],
    ["„Sprendimas“", "Sprendimas", "lietuviškos kabutės"],
    ["taip/ne", "taip ne", "pasvirasis brūkšnys"],
    ["Jonas kalbėjo, ilgai.", "jonas kalbėjo ilgai", "paprasta skyryba"],
  ]) {
    assert.equal(
      metrics.wordErrorRate(reference, hypothesis).wer,
      0,
      `${label}: skyryba neturi kurti klaidų`
    );
  }
});

test("SKYRYBA: brūkšnelis ir apostrofas ŽODYJE paliekami", () => {
  /**
   * Jie yra žodžio DALIS: pašalinus, „penkiasdešimt-šeši" taptų dviem žodžiais,
   * ir žodžių skaičius iškryptų.
   */
  assert.deepEqual(metrics.normalize("penkiasdešimt-šeši"), ["penkiasdešimt-šeši"]);
  assert.deepEqual(metrics.normalize("d\u2019Artanjanas"), ["d\u2019artanjanas"]);
});

/* ------------------------------------------------------------------ */
/* MANIFESTO GRIEŽTUMAS                                                */
/* ------------------------------------------------------------------ */

test("MANIFESTAS: turinio laukai NELEIDŽIAMI", () => {
  /**
   * ⚠️ PRIVATUMO SPRAGA, rasta peržiūroje.
   *
   * Privalomų laukų sąrašas neuždraudžia PAPILDOMŲ — manifestas su
   * `transcript` ar `audioBase64` praeidavo validaciją, nors garantija skelbia,
   * kad turinio jame nėra. Repozitorija vieša.
   */
  const base = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    origin: "synthetic",
    language: "lt",
    split: "development",
  };

  for (const forbidden of ["transcript", "text", "audioBase64", "participantNames", "speakerNames"]) {
    const { valid, errors } = manifest.validateManifest({
      version: "1.0",
      createdAt: "2026-08-05T00:00:00Z",
      samples: [{ ...base, [forbidden]: "kažkas" }],
    });

    assert.equal(valid, false, `laukas "${forbidden}" turėjo būti atmestas`);
    assert.ok(errors.some((error) => error.includes(forbidden) && /NELEIDŽIAMAS/.test(error)));
  }
});

test("MANIFESTAS: nežinomi laukai atmetami (allowlist)", () => {
  const { valid, errors } = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05T00:00:00Z",
    samples: [
      {
        id: "a",
        durationSeconds: 60,
        speakers: 2,
        condition: "clean",
        origin: "synthetic",
        language: "lt",
        split: "development",
        kazkokslaukas: "reikšmė",
      },
    ],
  });

  assert.equal(valid, false);
  assert.ok(errors.some((error) => /nežinomas laukas/.test(error)));
});

test("MANIFESTAS: nuorodų ir sumų laukai LEIDŽIAMI", () => {
  /**
   * Vertinimą turi būti galima pakartoti neįdėjus duomenų į repozitoriją, tad
   * neasmeniniai nuorodų raktai ir kontrolinės sumos yra būtini — jie turinio
   * neatkuria.
   */
  const { valid, errors } = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05T00:00:00Z",
    samples: [
      {
        id: "a",
        durationSeconds: 60,
        speakers: 2,
        condition: "clean",
        origin: "synthetic",
        language: "lt",
        split: "development",
        storageRef: "evaluation-store://lt-final/a",
        referenceRef: "evaluation-store://lt-final/a.ref",
        audioChecksum: "abc123",
      },
    ],
  });

  assert.equal(valid, true, errors.join(" | "));
});

test("MANIFESTAS: `split` PRIVALOMAS ir ribotas", () => {
  /**
   * Kūrimo ir galutinio rinkinių atskyrimas yra kertinė taisyklė. Palikus
   * lauką neprivalomą, ji būtų tik dokumentacija.
   */
  const base = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    origin: "synthetic",
    language: "lt",
  };

  const missing = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05T00:00:00Z",
    samples: [base],
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => /split/.test(error)));

  for (const split of ["development", "final"]) {
    const result = manifest.validateManifest({
      version: "1.0",
      createdAt: "2026-08-05T00:00:00Z",
      samples: [{ ...base, split }],
    });
    assert.equal(result.valid, true, `"${split}" turėjo būti priimtas: ${result.errors.join(" | ")}`);
  }

  const invalid = manifest.validateManifest({
    version: "1.0",
    createdAt: "2026-08-05T00:00:00Z",
    samples: [{ ...base, split: "tuning" }],
  });
  assert.equal(invalid.valid, false);
});

test("MANIFESTAS: tipai ir ribos tikrinami", () => {
  /**
   * Be šios patikros `durationSeconds: "ilgas"` praeitų ir vėliau tyliai
   * sugadintų aprėpties skaičiavimą bei atspaudą.
   */
  const base = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    origin: "synthetic",
    language: "lt",
    split: "development",
  };

  const invalidCases = [
    { id: "" },
    { durationSeconds: "ilgas" },
    { durationSeconds: -5 },
    { durationSeconds: 0 },
    { speakers: "du" },
    { speakers: 1.5 },
    { speakers: 0 },
    { language: "" },
  ];

  for (const override of invalidCases) {
    const { valid } = manifest.validateManifest({
      version: "1.0",
      createdAt: "2026-08-05T00:00:00Z",
      samples: [{ ...base, ...override }],
    });

    assert.equal(valid, false, `${JSON.stringify(override)} turėjo būti atmestas`);
  }
});

test("MANIFESTAS: `version` ir `createdAt` tikrinami", () => {
  const samples = [
    {
      id: "a",
      durationSeconds: 60,
      speakers: 2,
      condition: "clean",
      origin: "synthetic",
      language: "lt",
      split: "development",
    },
  ];

  assert.equal(manifest.validateManifest({ version: "", createdAt: "2026-08-05T00:00:00Z", samples }).valid, false);
  assert.equal(manifest.validateManifest({ version: "1.0", createdAt: "vakar", samples }).valid, false);
});

test("ATSPAUDAS: apima `origin` ir `split`", () => {
  /**
   * ⚠️ Pirmoji versija jų neapėmė: rinkinys iš SINTETINIŲ kūrimo įrašų ir
   * rinkinys iš REALIŲ galutinių gaudavo tą patį atspaudą — nors
   * metodologiškai ir teisiškai tai visiškai skirtingi rinkiniai.
   */
  const base = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    language: "lt",
    origin: "synthetic",
    split: "development",
  };

  const reference = manifest.manifestFingerprint({ version: "1.0", samples: [base] });

  assert.notEqual(
    manifest.manifestFingerprint({ version: "1.0", samples: [{ ...base, origin: "consented" }] }),
    reference,
    "kilmės pokytis turi keisti atspaudą"
  );

  assert.notEqual(
    manifest.manifestFingerprint({ version: "1.0", samples: [{ ...base, split: "final" }] }),
    reference,
    "rinkinio pokytis turi keisti atspaudą"
  );
});

/* ------------------------------------------------------------------ */
/* METODOLOGIJOS SPRENDIMŲ PAAIŠKINIMAI                                */
/* ------------------------------------------------------------------ */

test("PAAIŠKINIMAI: sprendimai, kurie be komentaro liktų spėjami", () => {
  /**
   * Kelios šio modulio reikšmės atrodo savavališkos, kol nepaaiškintos:
   * kodėl riba 6, kodėl atspaudas neapima kontrolinių sumų, kodėl `far_field`
   * nėra spraga.
   *
   * Be paaiškinimo kitas žmogus arba jas pakeis kaip nereikšmingas, arba
   * paliks nesuprastas — abu atvejai blogesni nei kelios eilutės teksto.
   */
  const fs = require("fs");
  const path = require("path");

  const metricsSource = fs.readFileSync(path.join(__dirname, "..", "utils", "qualityMetrics.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(__dirname, "..", "utils", "evaluationManifest.js"), "utf8");

  // Kodėl būtent 6 kalbėtojai.
  // \s+ – tekste naudojamas lygiavimas, ne vienas tarpas.
  assert.match(metricsSource, /6!\s*=\s*720/, "permutacijų riba turi būti pagrįsta skaičiais");

  // Žinoma `\p{S}` riba.
  assert.match(metricsSource, /C\+\+/, "matematinių simbolių riba turi būti įvardyta");

  // Atspaudo semantika.
  assert.match(manifestSource, /tas pats VERTINIMO RINKINYS/, "atspaudo semantika turi būti apibrėžta");

  // `far_field` sprendimas.
  assert.match(manifestSource, /REKOMENDUOJAMOS, ne privalomos/, "sąmoningas sprendimas turi būti užrašytas");
});

test("DATA: priimamas TIK ISO 8601", () => {
  /**
   * `Date.parse` priima „August 5, 2026" ir panašius formatus, kurie
   * skirtingose aplinkose interpretuojami skirtingai. Vertinimo data patenka į
   * ataskaitas ir naudojama rezultatams susieti — ji turi būti vienareikšmė.
   */
  const sample = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    origin: "synthetic",
    language: "lt",
    split: "development",
  };

  for (const accepted of ["2026-08-05", "2026-08-05T10:00:00Z", "2026-08-05T10:00:00+03:00"]) {
    assert.equal(
      manifest.validateManifest({ version: "1.0", createdAt: accepted, samples: [sample] }).valid,
      true,
      `"${accepted}" turėjo būti priimta`
    );
  }

  for (const rejected of ["August 5, 2026", "2026/08/05", "05-08-2026", "vakar"]) {
    assert.equal(
      manifest.validateManifest({ version: "1.0", createdAt: rejected, samples: [sample] }).valid,
      false,
      `"${rejected}" turėjo būti atmesta`
    );
  }
});

test("ATSPAUDAS: kontrolinės sumos jo NEKEIČIA", () => {
  /**
   * Atspaudas atsako „ar tas pats VERTINIMO RINKINYS", ne „ar tas pats failas".
   * Failo perkėlimas į kitą saugyklą nekeičia to, KĄ vertiname — priešingu
   * atveju rezultatų nebūtų galima palyginti po nekalto infrastruktūros
   * pakeitimo.
   */
  const base = {
    id: "a",
    durationSeconds: 60,
    speakers: 2,
    condition: "clean",
    language: "lt",
    origin: "synthetic",
    split: "development",
  };

  const withRefs = { ...base, storageRef: "store://a", audioChecksum: "abc123" };

  assert.equal(
    manifest.manifestFingerprint({ version: "1.0", samples: [base] }),
    manifest.manifestFingerprint({ version: "1.0", samples: [withRefs] }),
    "nuorodos ir sumos neturi keisti rinkinio tapatybės"
  );
});

test("README: įvardyta, kad matuojama TRANSKRIPCIJA, ne protokolas", () => {
  /**
   * Be šio sakinio skaitytojas gali manyti, kad WER matuoja galutinio
   * protokolo kokybę — o tai visai kitas uždavinys (#24).
   */
  const fs = require("fs");
  const path = require("path");
  const readme = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");

  assert.match(readme, /TRANSKRIPCIJOS kokybę \(#23\)/);
  assert.match(readme, /ne protokolo kokybę\s*\n?\s*\(#24\)/);
});
