const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const rubric = require("../utils/protocolRubric");
const traceability = require("../utils/protocolTraceability");

/**
 * #24.1: PROTOKOLO VERTINIMO RUBRIKA IR ATSEKAMUMAS.
 *
 * Šis etapas nieko nevertina — jis apibrėžia metodiką. Rezultatai yra #24.2,
 * sprendimas dėl piloto — #24.3.
 */

function finding(dimension, severity, protocolField = "nutarimai") {
  return { dimension: rubric.DIMENSIONS[dimension], severity: rubric.SEVERITY[severity], protocolField };
}

/* ------------------------------------------------------------------ */
/* SUNKUMO SVORIAI                                                     */
/* ------------------------------------------------------------------ */

test("SVORIAI: netiesiniai – kosmetinės NEKOMPENSUOJA kritinių", () => {
  /**
   * ⚠️ Tiesinė skalė leistų „kompensuoti" išgalvotą nutarimą tvarkingu
   * formatavimu. Dešimt kosmetinių klaidų NĖRA lygu vienai kritinei.
   */
  const cosmetic = rubric.weightedErrorScore(Array(10).fill(finding("COMPLETENESS", "COSMETIC")));
  const critical = rubric.weightedErrorScore([finding("NO_UNSUPPORTED_ADDITIONS", "CRITICAL")]);

  assert.ok(critical > cosmetic * 10, "kritinė klaida turi sverti gerokai daugiau");
});

test("SVORIAI: nežinomas sunkumas METAMAS, ne ignoruojamas", () => {
  /**
   * Tyliai praleistas radinys reikštų, kad balas mažesnis, nei turėtų būti —
   * ir vertinimas atrodytų geresnis dėl duomenų klaidos.
   */
  assert.throws(
    () => rubric.weightedErrorScore([{ severity: "labai_bloga", dimension: "x", protocolField: "y" }]),
    (error) => error.code === "UNKNOWN_SEVERITY"
  );
});

/* ------------------------------------------------------------------ */
/* PRIĖMIMAS                                                           */
/* ------------------------------------------------------------------ */

test("PRIĖMIMAS: kritinė klaida yra VETO", () => {
  /**
   * ⚠️ SVARBIAUSIA ŠIO FAILO GARANTIJA.
   *
   * Protokolas su išgalvotu nutarimu netinkamas, net jei visa kita
   * nepriekaištinga. Balų riba leistų vienai kritinei klaidai „prasprūsti",
   * jei protokolas ilgas ir kitur tvarkingas.
   */
  const result = rubric.evaluateAcceptance([finding("NO_UNSUPPORTED_ADDITIONS", "CRITICAL")], {
    maxWeightedScore: 10000,
  });

  assert.equal(result.accepted, false, "net su milžiniška riba kritinė klaida neleidžia priimti");
  assert.equal(result.vetoed, true);
  assert.equal(result.criticalCount, 1);
});

test("PRIĖMIMAS: be kritinių sprendžia balų riba", () => {
  const few = rubric.evaluateAcceptance(Array(3).fill(finding("COMPLETENESS", "MINOR")));
  assert.equal(few.accepted, true, `3 smulkios klaidos turi praeiti: ${few.score}`);

  const many = rubric.evaluateAcceptance(Array(3).fill(finding("COMPLETENESS", "MAJOR")));
  assert.equal(many.accepted, false, "3 didelės klaidos turi viršyti ribą");
});

test("PRIĖMIMAS: tuščias radinių sąrašas priimamas", () => {
  const result = rubric.evaluateAcceptance([]);

  assert.equal(result.accepted, true);
  assert.equal(result.score, 0);
});

/* ------------------------------------------------------------------ */
/* RADINIŲ VALIDACIJA                                                  */
/* ------------------------------------------------------------------ */

test("RADINYS: privalo turėti dimensiją, sunkumą ir lauką", () => {
  /**
   * Radinys be dimensijos ar sunkumo negali būti nei suskaičiuotas, nei
   * palygintas su kitu vertinimu.
   */
  const { valid, errors } = rubric.validateFinding({ dimension: "x", severity: "y" });

  assert.equal(valid, false);
  assert.ok(errors.some((error) => /dimensija/.test(error)));
  assert.ok(errors.some((error) => /sunkumas/.test(error)));
  assert.ok(errors.some((error) => /protocolField/.test(error)));
});

test("RADINYS: CITATOS ir turinys NELEIDŽIAMI", () => {
  /**
   * ⚠️ Vertinimo rezultatai keliauja į ataskaitas ir repozitoriją, tad
   * „modelis parašė, kad Jonas atleidžiamas" būtų nutekėjimas.
   *
   * Aprašymas turi būti KATEGORINIS: „išgalvotas nutarimas", ne jo turinys.
   */
  for (const key of ["excerpt", "quote", "text"]) {
    const { valid, errors } = rubric.validateFinding({
      ...finding("FACTUAL_CORRECTNESS", "CRITICAL"),
      [key]: "Jonas sakė, kad projektas atšaukiamas",
    });

    assert.equal(valid, false, `laukas "${key}" turėjo būti atmestas`);
    assert.ok(errors.some((error) => /citatų ar turinio/.test(error)));
  }
});

/* ------------------------------------------------------------------ */
/* ATSEKAMUMAS                                                         */
/* ------------------------------------------------------------------ */

test("ATSEKAMUMAS: nuoroda yra POZICIJA, ne tekstas", () => {
  /**
   * ⚠️ Saugant citatą atsekamumo įrašas taptų transkripcijos kopija — su
   * visais asmens duomenimis ir jokia retencija.
   *
   * Pozicija patikrinama turint transkripciją; be jos ji nieko neatskleidžia.
   */
  const reference = traceability.createEvidenceReference({ segmentIndex: 12 });

  assert.deepEqual(reference, { segmentIndex: 12 });
  assert.ok(!JSON.stringify(reference).includes("text"));

  const timed = traceability.createEvidenceReference({ startMs: 1000, endMs: 4500 });
  assert.deepEqual(timed, { startMs: 1000, endMs: 4500 });
});

test("ATSEKAMUMAS: nuoroda be pozicijos ATMETAMA", () => {
  assert.throws(
    () => traceability.createEvidenceReference({}),
    (error) => error.code === "EVIDENCE_REFERENCE_INVALID"
  );

  assert.throws(
    () => traceability.createEvidenceReference({ startMs: 5000, endMs: 1000 }),
    (error) => error.code === "EVIDENCE_REFERENCE_INVALID"
  );
});

test("ATSEKAMUMAS: nutarimai ir užduotys REIKALAUJA nuorodos", () => {
  /**
   * Būtent jie lemia veiksmus po susitikimo. Nutarimas be atsekamumo yra
   * teiginys, kurio niekas negali patikrinti.
   */
  for (const field of rubric.EVIDENCE_REQUIRED_FIELDS) {
    const result = traceability.assessClaim({
      protocolField: field,
      origin: rubric.CLAIM_ORIGIN.TRANSCRIPT_DERIVED,
      evidence: [],
    });

    assert.equal(result.supported, false, `laukas "${field}" turėjo reikalauti nuorodos`);
  }
});

test("ATSEKAMUMAS: santrauka nuorodos NEREIKALAUJA", () => {
  /**
   * Reikalauti nuorodos santraukai būtų beprasmiška — ji pagal apibrėžimą
   * apibendrina visą įrašą.
   */
  const result = traceability.assessClaim({
    protocolField: "santrauka",
    origin: rubric.CLAIM_ORIGIN.TRANSCRIPT_DERIVED,
  });

  assert.equal(result.supported, true);
});

test("ATSEKAMUMAS: nepagrįstas teiginys yra GEDIMAS", () => {
  /**
   * ⚠️ Tai pavojingiausia protokolo klaidų rūšis: ji atrodo lygiai taip pat
   * įtikinamai kaip teisingas teiginys.
   */
  const result = traceability.assessClaim({
    protocolField: "nutarimai",
    origin: rubric.CLAIM_ORIGIN.UNSUPPORTED,
    evidence: [{ segmentIndex: 1 }],
  });

  assert.equal(result.supported, false, "nuoroda nepaverčia nepagrįsto teiginio pagrįstu");
  assert.match(result.problems[0], /neturi pagrindo/);
});

test("ATSEKAMUMAS: modelio išvada PRIVALO būti pažymėta", () => {
  /**
   * Ji gali būti teisinga — bet skaitytojas turi žinoti, kad tai išvada, ne
   * įraše nuskambėjęs teiginys. Priešingu atveju protokole atsiranda faktų,
   * kurių niekas nepasakė.
   */
  const unmarked = traceability.assessClaim({
    protocolField: "uzduotis",
    origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE,
    evidence: [{ segmentIndex: 3 }],
  });

  assert.equal(unmarked.supported, false);
  assert.match(unmarked.problems[0], /nepažymėtas kaip neapibrėžtas/);

  const marked = traceability.assessClaim({
    protocolField: "uzduotis",
    origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE,
    evidence: [{ segmentIndex: 3 }],
    markedAsInference: true,
  });

  assert.equal(marked.supported, true);
});

test("MATRICA: skaičiuoja atsekamumo dalį ir NĖRA kokybės matas", () => {
  /**
   * Protokolas gali būti 100% atsekamas ir vis tiek praleisti pusę sprendimų —
   * pilnumas matuojamas atskirai (`COMPLETENESS`).
   */
  const matrix = traceability.buildTraceabilityMatrix([
    { protocolField: "nutarimai", origin: rubric.CLAIM_ORIGIN.TRANSCRIPT_DERIVED, evidence: [{ segmentIndex: 1 }] },
    { protocolField: "uzduotis", origin: rubric.CLAIM_ORIGIN.UNSUPPORTED },
  ]);

  assert.equal(matrix.total, 2);
  assert.equal(matrix.unsupported, 1);
  assert.equal(matrix.traceabilityRate, 0.5);

  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "protocolTraceability.js"), "utf8");
  assert.match(source, /NĖRA kokybės matas/, "riba turi būti užrašyta");
});

test("MATRICA: turinio sargyba veikia", () => {
  assert.doesNotThrow(() => traceability.assertNoContent({ total: 1, rows: [{ protocolField: "nutarimai" }] }));

  assert.throws(
    () => traceability.assertNoContent({ rows: [{ protocolField: "nutarimai", quote: "Jonas sakė" }] }),
    (error) => error.code === "TRACEABILITY_CONTAINS_CONTENT"
  );
});

/* ------------------------------------------------------------------ */
/* SĄSAJA SU REALIA SISTEMA                                            */
/* ------------------------------------------------------------------ */

test("LAUKAI: reikalaujantys nuorodos REALIAI egzistuoja protokole", () => {
  /**
   * Rubrika, reikalaujanti nuorodos neegzistuojančiam laukui, būtų
   * netikrinama: nė vienas protokolas jos nepažeistų.
   */
  const promptSource = fs.readFileSync(path.join(__dirname, "..", "prompts", "meeting_v3.js"), "utf8");

  for (const field of rubric.EVIDENCE_REQUIRED_FIELDS) {
    assert.match(
      promptSource,
      new RegExp(`"${field}"`),
      `laukas "${field}" reikalaujamas rubrikoje, bet protokolo struktūroje jo nėra`
    );
  }
});

test("PROMPTAI: versijavimas JAU egzistuoja ir yra fiksuojamas", () => {
  /**
   * #24 reikalauja versijuoto etalono. Sistema promptus jau versijuoja
   * (`meeting_v1`…`v3`), tad rubrikai nereikia kurti antro mechanizmo — bet
   * vertinimo rezultatas privalo prompt versiją FIKSUOTI.
   *
   * Skirtingos prompt versijos duoda skirtingus protokolus; rezultatas be jos
   * nepalyginamas.
   */
  const { buildPrompt } = require("../prompts");

  const built = buildPrompt({ transcript: "testas" });

  assert.ok(built.promptVersion, "prompt versija turi būti grąžinama");
  assert.match(built.promptVersion, /^meeting_v\d+$/);

  assert.throws(() => buildPrompt({ transcript: "x" }, "meeting_v999"), /Nežinoma prompt versija/);
});

/* ------------------------------------------------------------------ */
/* METODIKOS DOKUMENTAS                                                */
/* ------------------------------------------------------------------ */

function methodology() {
  return fs.readFileSync(path.join(__dirname, "..", "..", "docs", "protocol-evaluation-rubric.md"), "utf8");
}

test("DOKUMENTAS: visos dimensijos ir sunkumo lygiai dokumentuoti", () => {
  const doc = methodology();

  for (const dimension of Object.values(rubric.DIMENSIONS)) {
    assert.match(doc, new RegExp(`\`${dimension}\``), `dimensija "${dimension}" nedokumentuota`);
  }

  for (const severity of Object.values(rubric.SEVERITY)) {
    assert.match(doc, new RegExp(`\`${severity}\``), `sunkumas "${severity}" nedokumentuotas`);
  }

  for (const origin of Object.values(rubric.CLAIM_ORIGIN)) {
    assert.match(doc, new RegExp(`\`${origin}\``), `kilmė "${origin}" nedokumentuota`);
  }
});

test("DOKUMENTAS: svoriai SUTAMPA su kodu", () => {
  /**
   * Svoris dokumente ir kode yra du atskiri tekstai. Išsiskyrus jiems,
   * vertintojas skaičiuotų pagal vieną skalę, o sistema — pagal kitą.
   */
  const doc = methodology();

  for (const [severity, weight] of Object.entries(rubric.SEVERITY_WEIGHTS)) {
    const row = doc.split("\n").find((line) => line.includes(`\`${severity}\``) && line.includes("|"));

    assert.ok(row, `sunkumas "${severity}" neturi eilutės lentelėje`);

    const documented = row.match(/\|\s*([\d,]+)\s*\|/);
    assert.ok(documented, `sunkumui "${severity}" nenurodytas svoris`);

    assert.equal(
      Number(documented[1].replace(",", ".")),
      weight,
      `svoris "${severity}" dokumente išsiskyrė su kodu`
    );
  }
});

test("DOKUMENTAS: laukai, reikalaujantys nuorodos, SUTAMPA su kodu", () => {
  const doc = methodology();

  for (const field of rubric.EVIDENCE_REQUIRED_FIELDS) {
    const row = doc.split("\n").find((line) => line.includes(`\`${field}\``) && line.includes("|"));

    assert.ok(row, `laukas "${field}" nedokumentuotas`);
    assert.match(row, /privaloma/, `laukas "${field}" dokumente nepažymėtas kaip privalomas`);
  }
});

test("DOKUMENTAS: veto taisyklė įvardyta", () => {
  const doc = methodology();

  assert.match(doc, /[Kk]ritinė klaida yra veto/);
  assert.match(doc, /nepriklausomai\s*\n?\s*nuo bendro balo/i);
});

test("DOKUMENTAS: DETERMINIZMO riba įvardyta", () => {
  /**
   * ⚠️ Skirtumas nuo #23: `faster-whisper` su fiksuotais parametrais
   * pakartojamas, o LLM — ne.
   *
   * Be šios pastabos vienas paleidimas atrodytų kaip modelio kokybės matas.
   */
  const doc = methodology();

  assert.match(doc, /LLM nėra deterministinis/i);
  assert.match(doc, /vienas paleidimas \*\*nėra\*\* modelio kokybės matas/i);
});

test("DOKUMENTAS: rubrika NEPAKEIČIA žmogaus peržiūros", () => {
  /**
   * #24 „out of scope" eksplicitiškai draudžia garantuoti, kad AI protokolui
   * peržiūros nereikia. Metodika turi tai pakartoti — ji matuoja, KIEK
   * peržiūros reikia, ne panaikina ją.
   */
  const doc = methodology();

  assert.match(doc, /nepakeičia žmogaus peržiūros/i);
  assert.match(doc, /matuoja, kiek jos reikia/i);
});

test("DOKUMENTAS: pateikti KATEGORINIO aprašymo pavyzdžiai", () => {
  /**
   * Taisyklė „nerašyti turinio" be pavyzdžių lieka abstrakti — vertintojas
   * nežino, kur riba.
   */
  const doc = methodology();

  assert.match(doc, /Netinkamai \| Tinkamai/);
  assert.match(doc, /[Ii]šgalvotas nutarimas apie personalo sprendimą/);
});

test("DOKUMENTAS: prompt versijavimo reikalavimas įvardytas", () => {
  const doc = methodology();

  assert.match(doc, /meeting_v3/, "reali prompt versija turi būti nurodyta");
  assert.match(doc, /privalo fiksuoti prompt versiją/i);
});

test("SAUGUMAS: dokumente NĖRA tikrų paslapčių", () => {
  const secretsInventory = require("../utils/secretsInventory");
  const doc = methodology();

  assert.deepEqual(secretsInventory.findLeakedSecrets(doc, process.env), []);
});

/* ------------------------------------------------------------------ */
/* KILMĖS RIBA                                                         */
/* ------------------------------------------------------------------ */

test("KILMĖ: taisyklė duoda VIENAREIKŠMĮ atsakymą", () => {
  /**
   * ⚠️ Be jos du vertintojai tą patį teiginį klasifikuotų skirtingai, ir
   * rezultatai taptų nepalyginami.
   *
   * Lemiamas skirtumas tarp `model_inference` ir `unsupported` yra ne
   * tikėtinumas, o ar galima NURODYTI PAGRINDĄ.
   */
  assert.equal(rubric.classifyClaimOrigin({ hasEvidence: false }), rubric.CLAIM_ORIGIN.UNSUPPORTED);

  assert.equal(
    rubric.classifyClaimOrigin({ hasEvidence: true, statedExplicitly: true }),
    rubric.CLAIM_ORIGIN.TRANSCRIPT_DERIVED
  );

  assert.equal(
    rubric.classifyClaimOrigin({ hasEvidence: true, statedExplicitly: false, followsFromEvidence: true }),
    rubric.CLAIM_ORIGIN.MODEL_INFERENCE
  );

  // Nuoroda yra, bet teiginys nei pasakytas, nei išplaukia.
  assert.equal(
    rubric.classifyClaimOrigin({ hasEvidence: true, statedExplicitly: false, followsFromEvidence: false }),
    rubric.CLAIM_ORIGIN.UNSUPPORTED
  );
});

test("KILMĖ: IŠVADA irgi privalo turėti nuorodą", () => {
  /**
   * ⚠️ REALUS NENUOSEKLUMAS, rastas peržiūroje.
   *
   * Pirmoji versija nuorodos reikalavo tik `transcript_derived` atveju — tad
   * išvada be jokio pagrindo praeidavo, ir `model_inference` tapdavo
   * praktiškai neatskiriamas nuo `unsupported`.
   *
   * Išvada visada kyla IŠ KAŽKO. Be nuorodos ji yra prasimanymas, tik
   * pavadintas kitaip.
   */
  const withoutEvidence = traceability.assessClaim({
    protocolField: "nutarimai",
    origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE,
    markedAsInference: true,
    evidence: [],
  });

  assert.equal(withoutEvidence.supported, false, "išvada be nuorodos turi būti atmesta");
  assert.match(withoutEvidence.problems[0], /nenurodyti segmentai/);

  const withEvidence = traceability.assessClaim({
    protocolField: "nutarimai",
    origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE,
    markedAsInference: true,
    evidence: [{ segmentIndex: 7 }],
  });

  assert.equal(withEvidence.supported, true);
});

/* ------------------------------------------------------------------ */
/* VERTINTOJŲ NESUTARIMAI                                              */
/* ------------------------------------------------------------------ */

test("NESUTARIMAI: imamas GRIEŽTESNIS sunkumas", () => {
  /**
   * ⚠️ Piloto kontekste per griežtas vertinimas kainuoja papildomą peržiūrą, o
   * per švelnus — NETIKRĄ PASITIKĖJIMĄ.
   */
  const resolved = rubric.resolveDisagreement({ severity: rubric.SEVERITY.MINOR }, { severity: rubric.SEVERITY.MAJOR });

  assert.equal(resolved.severity, rubric.SEVERITY.MAJOR);
  assert.equal(resolved.disagreed, true);
  assert.ok(resolved.notes.some((note) => /griežtesnis/.test(note)));
});

test("NESUTARIMAI: imama KONSERVATYVESNĖ kilmė", () => {
  const resolved = rubric.resolveDisagreement(
    { severity: rubric.SEVERITY.MINOR, origin: rubric.CLAIM_ORIGIN.TRANSCRIPT_DERIVED },
    { severity: rubric.SEVERITY.MINOR, origin: rubric.CLAIM_ORIGIN.UNSUPPORTED }
  );

  assert.equal(resolved.origin, rubric.CLAIM_ORIGIN.UNSUPPORTED);
  assert.equal(resolved.disagreed, true);
});

test("NESUTARIMAI: sutampantys vertinimai NEŽYMIMI kaip nesutarimas", () => {
  const resolved = rubric.resolveDisagreement(
    { severity: rubric.SEVERITY.MAJOR, origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE },
    { severity: rubric.SEVERITY.MAJOR, origin: rubric.CLAIM_ORIGIN.MODEL_INFERENCE }
  );

  assert.equal(resolved.disagreed, false);
  assert.deepEqual(resolved.notes, []);
});

test("SUTARIMAS: dalis skaičiuojama ir yra METODIKOS, ne kokybės matas", () => {
  /**
   * Žemas sutarimas reiškia, kad rubrika neaiški, o ne kad protokolas blogas.
   * Jei sutarimas žemas, taisyti reikia RUBRIKĄ, ne rezultatus.
   */
  const rate = rubric.agreementRate([
    { a: { severity: rubric.SEVERITY.MAJOR }, b: { severity: rubric.SEVERITY.MAJOR } },
    { a: { severity: rubric.SEVERITY.MINOR }, b: { severity: rubric.SEVERITY.MAJOR } },
  ]);

  assert.equal(rate, 0.5);
  assert.equal(rubric.agreementRate([]), null);

  const doc = methodology();
  assert.match(doc, /NĖRA kokybės matas — tai METODIKOS matas/i);
  assert.match(doc, /taisyti reikia rubriką, ne rezultatus/i);
});

test("DOKUMENTAS: du vertintojai reikalaujami GALUTINIAM rinkiniui", () => {
  const doc = methodology();

  assert.match(doc, /Du, nepriklausomai/i);
  assert.match(doc, /vieno žmogaus nuomonė čia\s*\n?\s*per silpna/i);
});

/* ------------------------------------------------------------------ */
/* PATIKSLINIMAI                                                       */
/* ------------------------------------------------------------------ */

test("DOKUMENTAS: balo negalima lyginti tarp skirtingo ilgio protokolų", () => {
  /**
   * 30 min ir 5 val. susitikimas gali turėti tą patį balą, nors klaidų tankis
   * visiškai skirtingas. Balas skirtas VIENO protokolo priėmimui, ne modelių
   * reitingavimui.
   */
  const doc = methodology();

  assert.match(doc, /negalima lyginti tarp skirtingo ilgio/i);
  assert.match(doc, /ne modelių reitingavimui/i);
});

test("DOKUMENTAS: veto taikomas PIRMIAU nei balų riba", () => {
  const doc = methodology();

  assert.match(doc, /[Vv]eto taikomas PIRMIAU nei balų riba/);
  assert.match(doc, /sprendimo nekeičia/i);
});

test("DOKUMENTAS: 100% atsekamumas ≠ 100% teisingumas", () => {
  const doc = methodology();

  assert.match(doc, /100% atsekamumas ≠ 100% teisingumas/);
});

test("DOKUMENTAS: fiksuojama konkreti MODELIO versija", () => {
  /**
   * `claude` ir `gpt` skiriasi, bet skiriasi ir to paties tiekėjo modeliai.
   * Rezultatas be modelio versijos nepalyginamas net su savimi po mėnesio.
   */
  const doc = methodology();

  assert.match(doc, /\*\*Modelio versija\*\*/);
  assert.match(doc, /nepalyginamas net su savimi po\s*\n?\s*mėnesio/i);
});
