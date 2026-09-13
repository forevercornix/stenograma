const { test } = require("node:test");
const assert = require("node:assert/strict");

const { kanoninisRezultatas } = require("../utils/jobStore/common");

/**
 * KANONINĖ TAPATYBĖ MODELIUOJA SAUGYKLĄ (#298).
 *
 * ⚠️ KĄ `kanonizuoti()` IŠ VISO TURI DARYTI.
 *
 * Jis egzistuoja tam, kad pagamintų tapatybę, kuri IŠGYVENA saugyklos round-trip'ą.
 * Visos trys saugyklos serializuoja per `JSON.stringify`, o jis `toJSON` KVIEČIA.
 * `kanonizuoti()`, jo nekviesdavęs, nebuvo griežtesnis — jis MODELIAVO SAUGYKLĄ
 * NETEISINGAI, ir teisėtas pakartojimas gaudavo `RESULT_CONFLICT`.
 *
 * Išmatuota prieš tikrą Redis (#298, CI 34106486710). Redis yra AKTYVUS kelias;
 * PostgreSQL tuo metu buvo už aktyvavimo barjero. ⚠️ NEBĖRA (#155): barjeras
 * atidarytas, tad `postgres` yra pasirenkamas kelias — o išvada nesikeičia,
 * nes klausimas apie GRYNĄ funkciją, kurią visi trys keliai kviečia vienodai.
 *
 * ⚠️ TESTAI BE DB IR BE SAUGYKLOS — SĄMONINGAI. Klausimas yra apie GRYNĄ funkciją,
 * ir dublis čia ne aproksimacija, o pati tikrovė: `JSON.stringify` yra tas pats
 * `JSON.stringify` visuose trijuose keliuose. Elgesį prieš tikras saugyklas tikrina
 * bendras scenarijų rinkinys (`artifactStoreScenarios`, `NUOSTOLINGI`).
 */

const rt = (v) => JSON.parse(JSON.stringify(v));

/**
 * ⚠️ SAVYBĖ, NE ATVEJŲ SĄRAŠAS: kanoninė forma privalo nepakisti po round-trip'o.
 *
 * Sąrašas atsakytų „šie penki atvejai veikia"; savybė atsako „taip yra apibrėžta".
 * Korpusas — tik jos liudytojai, ir naujas atvejis pridedamas į vieną vietą.
 */
const KORPUSAS = Object.freeze([
  ["tuščias objektas", {}],
  ["tuščias masyvas", []],
  ["gilus paprastas", { a: { b: { c: [1, "2", true, null] } } }],
  ["raktų tvarka", { b: 1, a: 2, C: 3, "": 4 }],
  ["undefined laukas", { a: 1, b: undefined }],
  ["NaN ir begalybė viduje", { n: NaN, i: Infinity, j: -Infinity }],
  ["Map ir Set", { m: new Map([["a", 1]]), s: new Set([1]) }],
  ["klasė be toJSON", { k: new (class { constructor() { this.x = "x"; } })() }],
  ["__proto__ iš JSON", JSON.parse('{"__proto__":{"a":1},"b":2}')],
  ["neporinis surogatas tekste", { t: "a\ud800b" }],
  ["literalus escape tekste", { t: "literalus \\ud800" }],
  ["transkripcijos forma", { segments: [{ start: 0, end: 1, text: "labas", speaker: "S0" }], text: "labas" }],
  /** #298 branduolys — visos trys pozicijos, kuriomis `Date` gali atsirasti. */
  ["Date lauke", { d: new Date(0) }],
  ["Date masyve", { a: [new Date(0)] }],
  ["Date giliai", { a: [{ b: { c: new Date(0) } }] }],
  ["Date viršutiniame lygyje", new Date(0)],
  ["klasė su prototipo toJSON", { k: new (class { toJSON() { return "PROTO"; } })() }],
  ["toJSON objekto literale", { k: { x: "x", toJSON() { return "x"; } } }],
  ["toJSON grąžina objektą su toJSON", { k: { toJSON() { return { toJSON() { return 1; } }; } } }],
]);

test("SAVYBĖ: kanoninė forma pergyvena JSON round-trip'ą", () => {
  for (const [vardas, reiksme] of KORPUSAS) {
    assert.equal(
      kanoninisRezultatas(reiksme),
      kanoninisRezultatas(rt(reiksme)),
      `${vardas}: tapatybė pasikeičia po saugojimo — teisėtas pakartojimas gautų RESULT_CONFLICT`
    );
  }
});

/**
 * ⚠️ TAI YRA PATS #298: PRIEŠ TAISYMĄ ŠIS TESTAS KRISDAVO.
 *
 * Laikomas ATSKIRAI nuo savybės, nes savybė pasako „taip apibrėžta", o šis —
 * „štai konkretus melagingas konfliktas, dėl kurio ji atsirado". Praradus antrąjį,
 * pirmasis liktų taisyklė be priežasties.
 */
test("#298: `Date` rezultate NEBEDUODA melagingo konflikto", () => {
  const rezultatas = { d: new Date(0) };

  assert.equal(kanoninisRezultatas(rezultatas), '{"d":"1970-01-01T00:00:00.000Z"}');
  assert.equal(
    kanoninisRezultatas(rezultatas),
    kanoninisRezultatas(rt(rezultatas)),
    "prieš #298: {\"d\":{}} prieš {\"d\":\"1970-...\"}"
  );

  /** ⚠️ IR DATOS NEBĖRA TAPATINGOS TARPUSAVYJE — tai buvo antra to paties defekto pusė. */
  assert.notEqual(
    kanoninisRezultatas({ d: new Date(0) }),
    kanoninisRezultatas({ d: new Date(1000) }),
    "visos datos, kanonizuotos į `{}`, būtų `finish()` akimis TAS PATS rezultatas"
  );
});

/**
 * ⚠️ CUTOVER SARGAS: JAU PERSISTINTOS TAPATYBĖS NEPAKITO.
 *
 * `job_results.checksum` ir `job_result_attempts.checksum` yra UŽŠALDYTOS kanoninės
 * formos — apskaičiuotos rašymo metu ir nebeperskaičiuojamos. Jei #298 pakeistų nors
 * vienos jau įrašytos reikšmės tapatybę, teisėtas pakartojimas po diegimo matytų
 * nesutapimą ir eitų remonto arba `RESULT_CONFLICT` keliu.
 *
 * ⚠️ ATSAKYMAS YRA STRUKTŪRINIS, NE STATISTINIS. Saugykloje gulintys baitai YRA
 * kanoninė eilutė (`paruostiReiksme()` grąžina `kanonine`), o iš `JSON.parse` gauta
 * reikšmė prototipo `toJSON` neturi NIEKADA — kode nėra nė vieno `JSON.parse`
 * reviver'io. Vadinasi #298 negali pakeisti nė vienos jau įrašytos tapatybės, ir
 * tai tikrinama, o ne teigiama.
 */
test("CUTOVER: jau įrašytų reikšmių tapatybė NEPAKITO", () => {
  for (const [vardas, reiksme] of KORPUSAS) {
    const irasyta = kanoninisRezultatas(reiksme);
    assert.equal(
      kanoninisRezultatas(JSON.parse(irasyta)),
      irasyta,
      `${vardas}: perskaityta iš saugyklos reikšmė duoda KITĄ kanoninę eilutę`
    );
  }
});

/**
 * ⚠️ TAPATYBĖS, KURIŲ #298 NETURĖJO PALIESTI — UŽŠALDYTOS PAŽODŽIUI.
 *
 * Savybės testas pasakytų „stabilu", bet nepasakytų „stabilu ties TA PAČIA reikšme".
 * Šios eilutės yra tos, kurias gamino kodas PRIEŠ #298; jos užrašytos literalais
 * sąmoningai — antra `kanonizuoti()` implementacija testų pusėje būtų kopija,
 * nustojanti sutapti tyliai (#305 klasė).
 */
test("CUTOVER: reikšmių be prototipo `toJSON` kanoninės eilutės nepakitusios", () => {
  const UZSALDYTA = Object.freeze({
    '{"a":2,"b":1}': { b: 1, a: 2 },
    '{"text":"labas"}': { text: "labas" },
    '{"segments":[1,2]}': { segments: [1, 2] },
    '{"a":1}': { a: 1, b: undefined },
    '{"i":null,"j":null,"n":null}': { n: NaN, i: Infinity, j: -Infinity },
    '{"m":{},"s":{}}': { m: new Map([["a", 1]]), s: new Set([1]) },
    '{"text":"x"}': { text: "x", f: () => 1 },
    '{"segments":[1,null]}': { segments: [1, () => 1] },
  });

  for (const [laukiama, reiksme] of Object.entries(UZSALDYTA)) {
    assert.equal(kanoninisRezultatas(reiksme), laukiama);
  }
});

/**
 * ⚠️ `toJSON` KVIEČIAMAS LYGIAI TAIP PAT, KAIP TAI DARO `JSON.stringify`.
 *
 * Ne „panašiai": bet koks nukrypimas atkurtų tą patį defektą iš kitos pusės — modelis
 * vėl skirtųsi nuo saugyklos. Tikrinama TIKRUOJU `JSON.stringify` kaip etalonu, ne
 * mūsų prielaida apie jį.
 *
 * Dvi savybės viename zonde: kviečiama VIENĄ kartą lygyje (ne rekursiškai per
 * grąžintą reikšmę) ir su RAKTU (`toJSON(key)`).
 */
test("`toJSON` semantika sutampa su `JSON.stringify` — kvietimų seka ir raktai", () => {
  const gaminti = (kvietimai) => ({
    laukas: {
      toJSON(k) {
        kvietimai.push(k);
        return { gilyn: { toJSON(k2) { kvietimai.push(`VIDINIS:${k2}`); return 1; } } };
      },
    },
  });

  const musu = [];
  kanoninisRezultatas(gaminti(musu));

  const etalonas = [];
  JSON.stringify(gaminti(etalonas));

  assert.deepEqual(musu, etalonas, "kvietimų seka arba raktai skiriasi nuo `JSON.stringify`");
  assert.deepEqual(musu, ["laukas", "VIDINIS:gilyn"], "laukiama: vienas kvietimas lygyje, su raktu");
});

/**
 * ⚠️ FUNKCIJOS IR SIMBOLIAI TVARKOMI ČIA, NE PALIEKAMI IŠORINIAM `JSON.stringify`.
 *
 * Anksčiau jie patekdavo į kanoninį objektą, o juos išmesdavo galutinis
 * `JSON.stringify`. Rezultatas sutapdavo VISADA, išskyrus raktą `toJSON`: tada
 * išorinis `stringify` funkciją ne išmesdavo, o IŠKVIESDAVO. Tai vienintelis
 * atvejis, kuriuo #298 taisymas iš pradžių buvo nepilnas — išmatuota, ne numanyta.
 */
test("funkcija ir simbolis: objekte praleidžiami, masyve VIRSTA `null`", () => {
  assert.equal(kanoninisRezultatas({ a: 1, f: () => 1, [Symbol("s")]: 1, s: Symbol("x") }), '{"a":1}');

  /** ⚠️ MASYVE — `null`, ne praleidimas: indeksų poslinkis reikštų KITĄ rezultatą. */
  assert.equal(kanoninisRezultatas({ a: [1, () => 1, 2] }), '{"a":[1,null,2]}');

  /** Raktas `toJSON` funkcijai — atvejis, kuriuo pirmoji redakcija krito. */
  assert.equal(kanoninisRezultatas({ k: { toJSON() { return { toJSON() { return 1; } }; } } }), '{"k":{}}');
});
