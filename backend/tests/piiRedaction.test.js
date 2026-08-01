const test = require("node:test");
const assert = require("node:assert/strict");

const {
  redact,
  redactDetailed,
  redactSegments,
  isValidPersonalCode,
  resolveCategories,
  normalizeCategories,
  ALL_CATEGORIES,
  POLICY_VERSION,
  PLACEHOLDERS,
  LIMITATIONS,
} = require("../utils/piiRedaction");

/**
 * GDPR #4: komponento testai.
 *
 * DoD reikalauja TRIJŲ rūšių atvejų:
 *  - teigiami: tikras PII aptinkamas;
 *  - neigiami: PII nėra, tekstas nekeičiamas;
 *  - klaidingai teigiami: kažkas PANAŠU į PII, bet nėra - ir NETURI būti liesta.
 *
 * Trečioji grupė svarbiausia. Per agresyvi redakcija sugadina protokolą tyliai:
 * niekas nemato, kad dingo suma, data ar punkto numeris, kol nepradeda skaityti.
 */

/** Realiai galiojantys LT asmens kodai (kontrolinės sumos teisingos). */
const VALID_CODE = "39001010000";
const SECOND_VALID_CODE = "48503151233";

test("KONTROLINĖ SUMA: galiojantis kodas priimamas", () => {
  assert.equal(isValidPersonalCode(VALID_CODE), true);
});

test("KLAIDINGAI TEIGIAMI: 11 skaitmenų dar nereiškia asmens kodo", () => {
  const notCodes = [
    "12345678901", // pirmas skaitmuo 1, bet data ir suma neteisingos
    "39001010001", // teisinga struktūra, BLOGA kontrolinė suma
    "79001010000", // lyties/amžiaus skaitmuo 7 neegzistuoja
    "31301010000", // 13-as mėnuo
    "39002300000", // vasario 30-a
    "00000000000",
  ];

  for (const value of notCodes) {
    assert.equal(isValidPersonalCode(value), false, `${value} neturėtų būti laikomas asmens kodu`);
    assert.equal(redact(`Numeris ${value}.`), `Numeris ${value}.`, `${value} neturėtų būti redaguotas`);
  }
});

test("TELEFONAI: visi realūs lietuviški pavidalai", () => {
  // Visos šios formos pasitaiko transkripcijose. Vienas griežtas šablonas jų
  // nepadengia, todėl naudojamas kandidatas + validacija.
  const phones = [
    "+37060012345",
    "+370 600 12345",
    "860012345",
    "8 600 12345",
    "(8-5) 212 3456",
  ];

  for (const phone of phones) {
    assert.equal(redact(`Skambinti ${phone}.`), "Skambinti [TELEFONAS].", `nepagauta: ${phone}`);
  }
});

test("TEIGIAMI: asmens kodas, el. paštas, telefonas, IBAN", () => {
  const result = redactDetailed(
    `Kodas ${VALID_CODE}, paštas jonas.jonaitis@imone.lt, tel. +370 600 12345, ` +
      "sąskaita LT121000011101001000."
  );

  assert.ok(result.text.includes(PLACEHOLDERS.PERSONAL_CODE));
  assert.ok(result.text.includes(PLACEHOLDERS.EMAIL));
  assert.ok(result.text.includes(PLACEHOLDERS.PHONE));
  assert.ok(result.text.includes(PLACEHOLDERS.IBAN));

  assert.ok(!result.text.includes(VALID_CODE));
  assert.ok(!result.text.includes("jonas.jonaitis@imone.lt"));
  assert.ok(!result.text.includes("LT121000011101001000"));
});

test("KLAIDINGAI TEIGIAMI: datos, sumos, punktų numeriai NELIEČIAMI", () => {
  const safe = [
    "Posėdis vyko 2026-03-15, pradžia 14:30.",
    "Biudžetas 15000 Eur, likutis 2450,50 Eur.",
    "Žiūrėti 3.2 punktą ir 15 straipsnį.",
    "Balsavo 12 už, 3 prieš, 1 susilaikė.",
    "Sutarties Nr. 2026/114 galiojimas iki 2027 m.",
    "Telefonu skambinta 3 kartus.",
  ];

  for (const text of safe) {
    assert.equal(redact(text), text, `neturėjo būti keičiama: ${text}`);
  }
});

test("NEIGIAMI: tekstas be PII nekeičiamas, statistika tuščia", () => {
  const text = "Pirmininkas pristatė ketvirčio ataskaitą. Nutarta patvirtinti vienbalsiai.";
  const result = redactDetailed(text);

  assert.equal(result.text, text);
  assert.deepEqual(result.stats, {});
});

test("NUOSEKLŪS placeholder'iai: ta pati kategorija - tas pats žymuo", () => {
  const result = redactDetailed(`Kodai ${VALID_CODE} ir ${SECOND_VALID_CODE}.`);
  const matches = result.text.match(/\[ASMENS_KODAS\]/g) || [];

  assert.equal(matches.length, 2, "abu kodai gauna TĄ PATĮ žymenį");
});

test("VARDAI SĄMONINGAI NELIEČIAMI (aprėpties sprendimas, ne praleidimas)", () => {
  const text = "Jonas Jonaitis ir Petras Petraitis pasirašė protokolą.";
  assert.equal(redact(text), text);
});

test("STRUKTŪRA: segmentuose redaguojamas tik `text`", () => {
  const segments = [
    { text: `Mano kodas ${VALID_CODE}.`, speaker: "SPEAKER_1", start: 0, end: 3.5 },
    { text: "Ačiū.", speaker: "SPEAKER_2", start: 3.5, end: 4 },
  ];

  const result = redactSegments(segments);

  assert.equal(result.segments[0].speaker, "SPEAKER_1");
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 3.5);
  assert.ok(result.segments[0].text.includes(PLACEHOLDERS.PERSONAL_CODE));

  assert.deepEqual(result.segments[1], segments[1], "segmentas be PII nekeičiamas");
  assert.equal(result.stats.PERSONAL_CODE, 1);
});

test("STATISTIKA neturi aptiktų REIKŠMIŲ (ji keliauja į auditą ir logus)", () => {
  const result = redactDetailed(`${VALID_CODE} ir slaptas@pastas.lt`);
  const serialized = JSON.stringify(result.stats);

  assert.ok(!serialized.includes(VALID_CODE));
  assert.ok(!serialized.includes("slaptas@pastas.lt"));
  assert.deepEqual(result.stats, { PERSONAL_CODE: 1, EMAIL: 1 });
});

test("kraštiniai atvejai neverčia komponento kristi", () => {
  assert.equal(redact(""), "");
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.equal(redactSegments(null).segments, null);
  assert.deepEqual(redactSegments([{ speaker: "A" }]).segments, [{ speaker: "A" }]);
});

test("politikos versija ir apribojimai yra dokumentuoti kode", () => {
  assert.match(POLICY_VERSION, /^pii-v\d+$/);
  assert.ok(LIMITATIONS.length >= 4);
  assert.ok(LIMITATIONS.some((l) => /[Vv]ardai/.test(l)), "vardų apribojimas turi būti įvardytas");
  assert.ok(LIMITATIONS.some((l) => /[Aa]dresai/.test(l)), "adresų apribojimas turi būti įvardytas");
  assert.ok(
    LIMITATIONS.some((l) => /pseudonimizuot/i.test(l)),
    "turi būti pasakyta, kad rezultatas NĖRA anonimizuotas"
  );
});

test("HTML/XSS transkripcijoje IŠLIEKA tekstu, o ne tampa žymenimis", () => {
  // Redaktorius neturi nei įvesti, nei pašalinti HTML - jo darbas yra PII.
  // Saugų atvaizdavimą užtikrina frontend (žr. frontend/src/App.test.jsx).
  const hostile = `<script>alert(1)</script> kodas ${VALID_CODE}`;
  const result = redact(hostile);

  assert.ok(result.includes("<script>"), "redaktorius nekeičia HTML - tai ne jo atsakomybė");
  assert.ok(result.includes(PLACEHOLDERS.PERSONAL_CODE));
});

/**
 * ---------------------------------------------------------------------------
 * CODE REVIEW pataisymai: ribos, konfigūracija, telefonų balansas.
 * ---------------------------------------------------------------------------
 */

test("RIBOS: asmens kodas aptinkamas ir šalia skyrybos ar brūkšnelio", () => {
  // Pirmoji versija turėjo `(?<![\d-])`, tad šie atvejai PRAEIDAVO neredaguoti -
  // realus PII praleidimas, kurį pagavo code review.
  const cases = [
    `AK-${VALID_CODE}`,
    `asmens-kodas-${VALID_CODE}`,
    `a.k.:${VALID_CODE}`,
    `(${VALID_CODE})`,
    `${VALID_CODE},`,
    `kodas ${VALID_CODE}.`,
  ];

  for (const text of cases) {
    assert.ok(
      redact(text).includes(PLACEHOLDERS.PERSONAL_CODE),
      `neaptikta: ${text}`
    );
    assert.ok(!redact(text).includes(VALID_CODE), `kodas liko: ${text}`);
  }
});

test("RIBOS: 12+ skaitmenų seka NĖRA asmens kodas net jei viduje slypi galiojantis", () => {
  assert.equal(redact(`9${VALID_CODE}`), `9${VALID_CODE}`);
  assert.equal(redact(`${VALID_CODE}9`), `${VALID_CODE}9`);
});

test("TELEFONŲ KLAIDINGAI TEIGIAMI: dokumentų ir sutarčių numeriai", () => {
  // Visi rasti realiai peržiūrint: 9 skaitmenys nuo „8" nėra telefonas, jei po
  // aštuoneto nėra operatoriaus/srities kodo.
  const notPhones = [
    "Sutarties numeris 812345678",
    "Sąskaitos dalis 876543210",
    "Dokumento ID 800000001",
    "Registracijos Nr. 370123456789",
    "Suma 12 345 678 Eur",
    "Numeris 899999999",
    "Kodas 820000000",
  ];

  for (const text of notPhones) {
    assert.equal(redact(text), text, `neturėjo būti laikoma telefonu: ${text}`);
  }
});

test("TELEFONAI: lietuviški srities ir mobilieji kodai vis tiek aptinkami", () => {
  for (const phone of ["860012345", "852123456", "837123456", "846123456", "37060012345"]) {
    assert.equal(redact(`Tel. ${phone}`), "Tel. [TELEFONAS]", `nepagauta: ${phone}`);
  }
});

test("KONFIGŪRACIJA: kategorijas galima įjungti atskirai", () => {
  const text = `${VALID_CODE}, jonas@x.lt, +37060012345, LT121000011101001000`;

  const onlyEmail = redact(text, { categories: ["EMAIL"] });
  assert.ok(onlyEmail.includes(PLACEHOLDERS.EMAIL));
  assert.ok(onlyEmail.includes(VALID_CODE), "išjungta kategorija NEREDAGUOJAMA");
  assert.ok(onlyEmail.includes("+37060012345"));

  const codeAndPhone = redact(text, { categories: ["PERSONAL_CODE", "PHONE"] });
  assert.ok(codeAndPhone.includes(PLACEHOLDERS.PERSONAL_CODE));
  assert.ok(codeAndPhone.includes(PLACEHOLDERS.PHONE));
  assert.ok(codeAndPhone.includes("jonas@x.lt"));
});

test("KONFIGŪRACIJA: PII_REDACTION_CATEGORIES skaitoma iš aplinkos", () => {
  const saved = process.env.PII_REDACTION_CATEGORIES;
  process.env.PII_REDACTION_CATEGORIES = "personal_code,email";
  // Politika UŽŠALDYTA, tad po env pakeitimo ją reikia perkurti - būtent to ir
  // norima: proceso viduryje pakeista aplinka efektyvios elgsenos nekeičia.
  require("../utils/privacyPolicy")._resetForTests();

  try {
    assert.deepEqual(resolveCategories(), ["PERSONAL_CODE", "EMAIL"]);
    const result = redact(`${VALID_CODE} ir +37060012345`);
    assert.ok(result.includes(PLACEHOLDERS.PERSONAL_CODE));
    assert.ok(result.includes("+37060012345"), "telefonas išjungtas konfigūracija");
  } finally {
    if (saved === undefined) delete process.env.PII_REDACTION_CATEGORIES;
    else process.env.PII_REDACTION_CATEGORIES = saved;
    require("../utils/privacyPolicy")._resetForTests();
  }
});

test("KONFIGŪRACIJA: rašybos klaida yra KLAIDA, ne tylus 'neredaguoti nieko'", () => {
  const saved = process.env.PII_REDACTION_CATEGORIES;
  process.env.PII_REDACTION_CATEGORIES = "persnal_code";

  try {
    assert.throws(() => resolveCategories(), (e) => e.code === "PII_CATEGORIES_INVALID");
  } finally {
    if (saved === undefined) delete process.env.PII_REDACTION_CATEGORIES;
    else process.env.PII_REDACTION_CATEGORIES = saved;
  }
});

test("KONFIGŪRACIJA: nenustatyta reiškia VISAS kategorijas", () => {
  const saved = process.env.PII_REDACTION_CATEGORIES;
  delete process.env.PII_REDACTION_CATEGORIES;

  try {
    assert.deepEqual(resolveCategories(), ALL_CATEGORIES);
  } finally {
    if (saved !== undefined) process.env.PII_REDACTION_CATEGORIES = saved;
  }
});

test("EL. PAŠTAS: realios formos ir kontekstai", () => {
  const positives = [
    ["Jonas.Jonaitis@Imone.LT", "didžiosios raidės"],
    ["vardas+zyma@imone.lt", "plus adresavimas"],
    ["a@b.sub.imone.lt", "keli subdomenai"],
    ["rašyti jonas@imone.lt dėl ataskaitos", "lietuviškas tekstas greta"],
  ];

  for (const [text, why] of positives) {
    assert.ok(redact(text).includes(PLACEHOLDERS.EMAIL), `nepagauta (${why}): ${text}`);
    assert.ok(!redact(text).includes("@imone.lt"), `domenas liko (${why}): ${text}`);
  }

  // Skliaustai ir kableliai neturi „prilipti" prie adreso.
  assert.equal(redact("(jonas@imone.lt)"), "([EL_PAŠTAS])");
  assert.equal(redact("jonas@imone.lt, petras@imone.lt"), "[EL_PAŠTAS], [EL_PAŠTAS]");
});

test("EL. PAŠTAS: neigiami atvejai NEREDAGUOJAMI", () => {
  // Be TLD tai ne adresas, o šnekamoji nuoroda ar techninis vardas.
  for (const text of ["vardas@localhost", "a@b", "@domenas.lt", "kaina 15 @ 3 Eur"]) {
    assert.equal(redact(text), text, `neturėjo būti keičiama: ${text}`);
  }
});

test("TARPTAUTINIAI TELEFONAI: `+` aptikimas SĄMONINGAI platus", () => {
  /**
   * Bet kokia 8-15 skaitmenų seka su `+` laikoma telefonu. Tai reiškia, kad
   * `+12345678` (dokumento kodas) irgi bus redaguotas.
   *
   * Sąmoningas pasirinkimas: telefonų numerių formatų pasaulyje per daug, kad
   * juos būtų galima patikimai atskirti nuo kitų `+` identifikatorių, o
   * praleistas tikras numeris yra brangesnis už perteklinį redagavimą.
   * Dokumentuota README; testas šią ribą fiksuoja, kad ji nepasikeistų tyliai.
   */
  for (const text of ["+37060012345", "+44 20 7946 0958", "+12345678"]) {
    assert.ok(redact(`Kontaktas ${text}`).includes(PLACEHOLDERS.PHONE), `nepagauta: ${text}`);
  }

  // Riba vis dėlto yra: per trumpa arba per ilga seka neliečiama.
  assert.equal(redact("Punktas +1234"), "Punktas +1234");
  assert.equal(redact("Kodas +1234567890123456789"), "Kodas +1234567890123456789");
});

test("KORPUSAS: realistiškos pastraipos nesugadinamos", () => {
  /**
   * Klaidingai teigiami pavojingiausi ne pavieniuose žodžiuose, o ištisame
   * tekste, kur skaičiai eina greta. Šis korpusas imituoja tikras protokolo
   * pastraipas; nė viena neturi būti keičiama.
   */
  const corpus = [
    "Posėdis įvyko 2026-03-15, pradžia 14:30, pabaiga 16:45.",
    "Patvirtintas biudžetas 125 000 Eur, rezervas 12 500 Eur.",
    "Vadovautasi Vyriausybės nutarimu Nr. 1234 ir įstatymo 15 straipsnio 3 dalimi.",
    "Automobilio valstybinis numeris ABC 123 perduotas ūkio skyriui.",
    "Sąskaita faktūra SF-2026-00412 apmokėta 2026 m. kovo 20 d.",
    "Balsavimo rezultatai: 12 už, 3 prieš, 1 susilaikė.",
    "Sutarties Nr. 2026/114 galiojimas pratęstas iki 2027-12-31.",
    "Darbuotojų skaičius padidėjo nuo 45 iki 52 asmenų.",
    "Projekto kodas P-2026-0001, biudžeto eilutė 3.2.1.",
    "Patalpų plotas 1250 kv. m, nuomos kaina 8,50 Eur už kv. m.",
    "Registracijos kodas 302 471 623 nurodytas paraiškoje.",
    "Ataskaitinis laikotarpis 2025 10 01 - 2025 12 31.",
  ];

  for (const paragraph of corpus) {
    assert.equal(redact(paragraph), paragraph, `sugadinta pastraipa: ${paragraph}`);
  }
});

test("KORPUSAS: tikras PII tose pačiose pastraipose VIS TIEK aptinkamas", () => {
  // Sveikatos patikra: korpuso testas turi įrodyti tikslumą, ne aklumą.
  const withPii = `Posėdyje dalyvavo Jonas Jonaitis (a.k. ${VALID_CODE}), ` +
    "kontaktai: jonas@imone.lt, tel. +370 600 12345, atsiskaitymai per LT121000011101001000.";

  const result = redactDetailed(withPii);

  assert.deepEqual(result.stats, { IBAN: 1, EMAIL: 1, PERSONAL_CODE: 1, PHONE: 1 });
  assert.ok(result.text.includes("Jonas Jonaitis"), "vardas lieka");
});

test("KATEGORIJOS: tuščias efektyvus sąrašas ATMETAMAS", () => {
  // `[]` reikštų „pažymėta kaip redaguota, bet neredaguota nieko" - blogiausias
  // įmanomas derinys, nes sistema tvirtina apsaugojusi.
  for (const value of [",", " , , "]) {
    assert.throws(
      () => resolveCategories({ PII_REDACTION_CATEGORIES: value }),
      (e) => e.code === "PII_CATEGORIES_INVALID" && /tuščias sąrašas/.test(e.message),
      `neatmesta: ${JSON.stringify(value)}`
    );
  }

  assert.throws(() => redact("x", { categories: [] }), (e) => e.code === "PII_CATEGORIES_INVALID");
});

test("KATEGORIJOS: programinė sąsaja validuojama taip pat kaip env", () => {
  // Anksčiau `options.categories` buvo naudojamas tiesiogiai, apeidamas patikrą.
  assert.throws(
    () => redact("x", { categories: ["PERSNAL_CODE"] }),
    (e) => e.code === "PII_CATEGORIES_INVALID"
  );

  // Dublikatai nekenkia - deduplikuojami tyliai.
  assert.deepEqual(normalizeCategories(["EMAIL", "EMAIL"]), ["EMAIL"]);
  assert.deepEqual(normalizeCategories("email, personal_code"), ["EMAIL", "PERSONAL_CODE"]);
});
