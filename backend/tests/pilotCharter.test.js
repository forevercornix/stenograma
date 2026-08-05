const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * #28 PR1: PILOTO CHARTA.
 *
 * Charta yra pažadas organizacijai: ji sako, ko pilotas apima ir ko ne. Jos
 * senėjimas pavojingesnis nei techninės dokumentacijos — ja remiamasi
 * priimant sprendimus apie asmens duomenis, ne konfigūruojant sistemą.
 *
 * Todėl tikrinama, kad charta remtųsi TIKRAIS sistemos faktais ir kad jos
 * ribų sąrašas neatsiliktų nuo realiai žinomų ribų.
 */

const DOCS = path.join(__dirname, "..", "..", "docs");
const CHARTER = path.join(DOCS, "pilot", "PILOT_CHARTER.md");

function charter() {
  return fs.readFileSync(CHARTER, "utf8");
}

test("CHARTA: dokumentas egzistuoja", () => {
  assert.ok(
    fs.existsSync(CHARTER),
    "Trūksta docs/pilot/PILOT_CHARTER.md\n" +
      "Jei PERKELTAS, atnaujinkite: šį testą, README ir docs/security-test-matrix.md."
  );
});

test("TIEKĖJAI: skaičiai SUTAMPA su realiu inventoriumi", () => {
  /**
   * Charta nurodo, kiek tiekėjų sistema palaiko. Šis skaičius yra tikrinamas
   * teiginys, ne apytikslė nuoroda: pridėjus tiekėją ir nepakeitus chartos,
   * ji aprašytų kitą sistemą nei ta, kuri veikia.
   */
  const { MATRIX } = require("../utils/providerPrivacy");

  let local = 0;
  let external = 0;

  for (const byKind of Object.values(MATRIX)) {
    for (const technical of Object.values(byKind)) {
      if (technical.processing === "local") local += 1;
      else if (technical.processing === "external") external += 1;
    }
  }

  const text = charter();

  assert.match(text, new RegExp(`\\*\\*${local} lokalius\\*\\*`), `lokalių tiekėjų skaičius (${local}) neatitinka`);
  assert.match(text, new RegExp(`\\*\\*${external} išorinius\\*\\*`), `išorinių tiekėjų skaičius (${external}) neatitinka`);
});

test("PRIVATUMO PROFILIAI: minimi TIK egzistuojantys", () => {
  /**
   * Charta, minint neegzistuojantį profilį, nurodytų operatoriui nustatyti
   * reikšmę, kurios sistema nepriima — ir tai paaiškėtų tik diegiant.
   *
   * Ta pati klaida jau buvo #20: `PRIVACY_PROFILE="ephemeral"` tyliai krito į
   * numatytąjį.
   */
  const { PROFILES } = require("../utils/privacyConfig");
  const text = charter();

  const mentioned = [...text.matchAll(/`(standard|local_only|ephemeral|[a-z_]+)`/g)]
    .map((match) => match[1])
    .filter((name) => /^(standard|local_only|ephemeral|strict|minimal)$/.test(name));

  for (const profile of new Set(mentioned)) {
    assert.ok(
      Object.values(PROFILES).includes(profile),
      `charta mini privatumo profilį "${profile}", kurio sistema neturi`
    );
  }

  // Ir abu tikri profiliai paminėti.
  for (const profile of Object.values(PROFILES)) {
    assert.match(text, new RegExp(`\`${profile}\``), `profilis "${profile}" nedokumentuotas`);
  }
});

test("KONFIGŪRACIJA: minimi kintamieji REALIAI egzistuoja", () => {
  const text = charter();
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  const mentioned = [...text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((match) => match[1]);

  /** Ne konfigūracijos kintamieji – jie tikrinami kitur. */
  const notSettings = new Set(["BDAR", "WER", "CER", "SLO", "SLA"]);

  for (const name of new Set(mentioned)) {
    if (notSettings.has(name)) continue;

    assert.match(
      envExample,
      new RegExp(`^#?\\s*${name}=`, "m"),
      `charta mini \`${name}\`, kurio nėra .env.example`
    );
  }
});

test("RIBOS: charta įvardija VISAS žinomas sistemos ribas", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Ribų santrauka chartoje yra tai, ką skaitys sprendimą priimantis žmogus.
   * Praleista riba reiškia, kad jis manys, jog jos nėra — o santraukos
   * skaitomos dažniau nei pilni techniniai dokumentai.
   *
   * Kiekviena riba tikrinama IR chartoje, IR pirminiame dokumente: kitaip
   * santrauka teigtų tai, ko šaltinis nesako.
   */
  const text = charter();

  const limits = [
    {
      what: "auditas tik atmintyje",
      inCharter: /[Aa]uditas gyvena tik atmintyje/,
      source: "operations/OPERATIONAL_PROCEDURES.md",
      inSource: /nerašomas į diską/,
    },
    {
      what: "įkėlimų jungiklio nėra",
      inCharter: /[Įį]kėlimų išjungimo jungiklio nėra/,
      source: "operations/INCIDENT_RESPONSE.md",
      inSource: /ĮKĖLIMŲ IŠJUNGIMO JUNGIKLIO NĖRA/,
    },
    {
      what: "užraktas viename procese",
      inCharter: /[Uu]žraktas veikia tik viename procese/,
      /**
       * Riba pirmą kartą įvardyta #20 kopijų runbook'e (ten ji atsirado kartu
       * su priežiūros užraktu), ne #21 dokumentuose — nors intuityviai
       * atrodytų, kad tai incidentų tema.
       */
      source: "backup-runbook.md",
      inSource: /[Uu]žraktas veikia tik viename procese/,
    },
    {
      what: "atkūrimas ne transakcinis",
      inCharter: /[Aa]tkūrimo pritaikymas nėra transakcinis/,
      source: "backup-runbook.md",
      inSource: /nėra transakcinis/,
    },
    {
      what: "kopijų retencija = ištrynimo langas",
      inCharter: /kopijų retencija apibrėžia faktinį ištrynimo langą/,
      source: "deletion-guarantees.md",
      inSource: /[Ff]aktinį ištrynimo langą/,
    },
    {
      what: "processor nesustabdomas vidury",
      inCharter: /[Vv]ykdomas processor'ius nesustabdomas vidury/,
      source: "deletion-guarantees.md",
      inSource: /nesustabdomas vidury/,
    },
    {
      what: "tiekėjų savybės nepatikrintos",
      inCharter: /[Ii]šorinių tiekėjų privatumo savybės nepatikrintos/,
      source: "provider-governance.md",
      inSource: /NEPATIKRINTOS|netikrino/,
    },
    {
      what: "nuosavybės patikrų nėra",
      inCharter: /[Nn]uosavybės patikrų nėra/,
      source: "deletion-guarantees.md",
      inSource: /[Nn]uosavybės patikrų nėra/,
    },
  ];

  for (const limit of limits) {
    assert.match(text, limit.inCharter, `chartoje neįvardyta riba: ${limit.what}`);

    const source = fs.readFileSync(path.join(DOCS, limit.source), "utf8");
    assert.match(
      source,
      limit.inSource,
      `riba „${limit.what}" chartoje yra, bet ${limit.source} apie ją nekalba`
    );
  }
});

test("RIBOS: kiekviena nuoroda į issue realiai egzistuoja dokumentuose", () => {
  /**
   * Nuoroda „#21" be atitinkamo dokumento reikštų, kad skaitytojas negali
   * pasitikrinti teiginio — o charta remiasi kitų etapų darbu.
   */
  const text = charter();

  const referenced = [...text.matchAll(/#(\d{2})/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 5, "charta turi remtis kitais etapais");

  const knownIssues = new Set(["18", "19", "20", "21", "22", "23", "24", "28"]);

  for (const issue of new Set(referenced)) {
    assert.ok(knownIssues.has(issue), `charta mini #${issue}, kurio nėra projekte`);
  }
});

test("HIPOTEZĖS: kiekviena PANEIGIAMA ir turi tikrinimo būdą", () => {
  /**
   * Hipotezė, kurios paneigti neįmanoma, nieko netikrina — ji tik aprašo
   * lūkestį. Pilotas be paneigiamų hipotezių visada „pavyksta".
   */
  const text = charter();

  const hypothesisSection = text.slice(text.indexOf("## 2. Hipotezės"), text.indexOf("## 3."));

  for (const id of ["H1", "H2", "H3", "H4"]) {
    assert.match(hypothesisSection, new RegExp(`\\| ${id} \\|`), `trūksta hipotezės ${id}`);
  }

  // Kiekviena eilutė turi tikrinimo būdą (trečias stulpelis netuščias).
  const rows = hypothesisSection.split("\n").filter((line) => /^\| H\d \|/.test(line));

  for (const row of rows) {
    const columns = row.split("|").map((cell) => cell.trim());
    assert.ok(columns[3] && columns[3].length > 5, `hipotezė be tikrinimo būdo: ${row}`);
  }

  assert.match(text, /paneigti/, "paneigiamumo reikalavimas turi būti įvardytas");
});

test("HIPOTEZĖS: transkribavimo ir protokolo kokybė ATSKIRTOS", () => {
  /**
   * Gera transkripcija negarantuoja gero protokolo. Sulieję juos į vieną
   * hipotezę, gautume rezultatą, kurio nepavyktų paaiškinti: neaišku, kuri
   * grandies dalis suklydo.
   */
  const text = charter();

  assert.match(text, /#23/, "transkribavimo metodika turi būti nurodyta");
  assert.match(text, /#24/, "protokolo metodika turi būti nurodyta");
  assert.match(text, /H1 ir H3 yra skirtingi klausimai/i);
});

test("DRAUDIMAI: ypatingų kategorijų duomenys uždrausti su PAGRINDIMU", () => {
  /**
   * Draudimas be priežasties atrodo kaip perdėtas atsargumas ir pirmas
   * pažeidžiamas. Su BDAR 9 str. nuoroda jis tampa argumentu.
   */
  const text = charter();

  assert.match(text, /ypatingų kategorijų/i);
  assert.match(text, /9 str/, "teisinis pagrindas turi būti nurodytas");
});

test("DRAUDIMAI: redakcija įvardyta kaip APSAUGA, ne leidimas", () => {
  /**
   * Be šio patikslinimo redakcijos komponentas taptų pateisinimu kalbėti apie
   * asmens kodus: „juk sistema juos pašalins".
   */
  const text = charter();

  assert.match(text, /[Rr]edakcijos komponentas yra apsauga, ne leidimas/);
  assert.match(text, /nepaverčia to tvarkinga praktika/);
});

test("APIMTIS: keitimas reikalauja ĮRAŠO", () => {
  /**
   * ⚠️ Pagrindinė apsauga nuo virtimo nedokumentuota paslauga.
   *
   * Kiekvienas atskiras praplėtimas atrodo mažas — todėl svarbu ne uždrausti
   * pakeitimus, o reikalauti, kad jie būtų MATOMI.
   */
  const text = charter();

  assert.match(text, /[Aa]pimtis yra užšaldyta/);
  assert.match(text, /[Pp]akeitimas be įrašo laikomas neįvykusiu/);
  assert.match(text, /data, pagrindimu ir tvirtinusiu/i, "įrašo turinys turi būti apibrėžtas");
});

test("PRIELAIDOS: kiekviena turi PASEKMĘ, jei neteisinga", () => {
  /**
   * Prielaidų sąrašas be pasekmių yra deklaracija. Su pasekmėmis jis tampa
   * įrankiu: pastebėjus, kad prielaida nebegalioja, iš karto aišku, ką
   * peržiūrėti.
   */
  const text = charter();

  const section = text.slice(text.indexOf("## 8. Prielaidos"), text.indexOf("## 9."));
  const rows = section.split("\n").filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line));

  assert.ok(rows.length >= 5, `per mažai prielaidų: ${rows.length}`);

  for (const row of rows.slice(1)) {
    const columns = row.split("|").map((cell) => cell.trim());
    assert.ok(columns[2] && columns[2].length > 10, `prielaida be pasekmės: ${row}`);
  }
});

test("PABAIGA: pilotas NĖRA automatinis perėjimas į produkciją", () => {
  /**
   * Be šio sakinio sėkmingas pilotas natūraliai virsta paslauga — tiesiog
   * niekas nepriima sprendimo jį stabdyti.
   */
  const text = charter();

  assert.match(text, /nėra automatinis perėjimas į produkciją/i);
  assert.match(text, /#28 PR3/, "turi nurodyti, kur sprendimas priimamas");
});

test("SAUGUMAS: chartoje NĖRA tikrų paslapčių", () => {
  const secretsInventory = require("../utils/secretsInventory");
  const text = charter();

  assert.deepEqual(secretsInventory.findLeakedSecrets(text, process.env), []);
  assert.ok(!/[0-9a-f]{64}/.test(text), "jokių 64 hex simbolių raktų");
});

/* ------------------------------------------------------------------ */
/* METODIKŲ BŪKLĖ                                                      */
/* ------------------------------------------------------------------ */

test("METODIKOS: charta SKIRIA įgyvendintą metodiką nuo planuojamos", () => {
  /**
   * ⚠️ REALUS NETIKSLUMAS, rastas peržiūroje.
   *
   * Pirmoji versija H1 ir H3 pateikė vienodai („#23 metodika", „#24
   * metodika"), nors #23 protokolas EGZISTUOJA, o #24 — dar ne.
   *
   * Charta tapo priklausoma nuo neegzistuojančio artefakto: skaitytojas
   * manytų, kad H3 galima vertinti jau dabar.
   */
  const text = charter();

  // #23 metodika realiai yra – nuoroda turi vesti į ją.
  assert.ok(
    fs.existsSync(path.join(DOCS, "evaluation-protocol.md")),
    "#23 protokolas turi egzistuoti"
  );
  assert.match(text, /evaluation-protocol\.md/, "H1 turi nurodyti realų dokumentą");
  assert.match(text, /jau apibrėžta/i, "įgyvendintos metodikos būklė turi būti įvardyta");

  // #24 metodikos dar nėra – charta privalo tai pasakyti.
  assert.match(text, /dar neįgyvendinta/i, "planuojamos metodikos būklė turi būti įvardyta");
  assert.match(text, /H3 negali būti vertinama, kol #24 metodikos nėra/i);
});

test("METODIKOS: jei #24 atsiras, chartą reikės atnaujinti", () => {
  /**
   * Sargybinis testas: kol #24 dokumento nėra, charta teisingai sako „dar
   * neįgyvendinta". Atsiradus dokumentui šis testas kris ir privers formuluotę
   * pataisyti — kitaip charta liktų pasenusi kaip tik ta kryptimi, kuri
   * svarbi.
   */
  const protocolAccuracyDocs = fs
    .readdirSync(DOCS)
    .filter((name) => /protocol-accuracy|protokolo-tikslum/i.test(name));

  assert.deepEqual(
    protocolAccuracyDocs,
    [],
    "atsirado #24 metodika – atnaujinkite chartos H3 formuluotę ir šį testą"
  );
});

test("H2: matavimas SUSIETAS su tuo pačiu žmogumi", () => {
  /**
   * Skirtingų žmonių rezultatai nepalyginami: skirtumas tarp jų dažnai
   * didesnis nei tarp rankinio ir automatinio būdo. Be šio patikslinimo H2
   * matuotų žmones, ne sistemą.
   */
  const text = charter();

  assert.match(text, /\*\*tas pats žmogus\*\*/i);
  assert.match(text, /[Ss]kirtingų žmonių rezultatai nepalyginami/);
});

/* ------------------------------------------------------------------ */
/* PAPILDYTOS RIBOS IR TAISYKLĖS                                       */
/* ------------------------------------------------------------------ */

test("RIBOS: valdysena ĮGYVENDINA, bet NEĮRODO organizacinio sprendimo", () => {
  /**
   * Viena svarbiausių #22 minčių: kodas negali atskirti apgalvoto sprendimo
   * nuo neatsargaus `.env` pakeitimo.
   *
   * Chartoje ji būtina, nes būtent charta skaitoma priimant sprendimą, ar
   * pilotas gali startuoti su išoriniais tiekėjais.
   */
  const text = charter();

  assert.match(text, /įgyvendina\*\* patvirtinimą, bet \*\*neįrodo\*\* organizacinio sprendimo/);

  // Ir šaltinis apie tai kalba.
  const source = fs.readFileSync(path.join(DOCS, "provider-governance.md"), "utf8");
  assert.match(source, /\*\*įgyvendina\*\*/);
  assert.match(source, /\*\*neįrodo\*\*/);
});

test("DUOMENYS: biometriniai identifikatoriai įvardyti atskirai", () => {
  /**
   * Garso įrašas savaime yra biometrinis šaltinis. Sąmoningas balso
   * atpažinimo naudojimas — atskira BDAR 9 str. sritis, ir be eksplicitinio
   * įvardijimo riba lieka numanoma.
   */
  const text = charter();

  assert.match(text, /[Bb]iometriniai identifikatoriai/);
  assert.match(text, /biometrinis šaltinis/);
});

test("APIMTIS: skubūs saugumo pakeitimai NĖRA apimties pakeitimas", () => {
  /**
   * ⚠️ Priešingu atveju sulaikymas priklausytų nuo tvirtinimo grandinės — o
   * incidento metu tai reikštų, kad poveikis tęsiasi, kol vyksta
   * administravimas.
   *
   * Bet jie fiksuojami PO FAKTO: išimtis liečia laiką, ne atskaitomybę.
   */
  const text = charter();

  assert.match(text, /[Ss]kubus saugumo pataisymas NĖRA apimties pakeitimas/i);
  assert.match(text, /fiksuojami po fakto/i, "atskaitomybė turi likti");
  assert.match(text, /#21/, "turi nurodyti incidentų procedūras");
});

test("ORGANIZACIJOS: atskiras sąrašas irgi valdomas pakeitimų tvarka", () => {
  /**
   * Atskiras dokumentas nereiškia laisvesnės tvarkos: priešingu atveju
   * organizacijas būtų galima pridėti apeinant chartą.
   */
  const text = charter();

  assert.match(text, /ta pati apimties keitimo tvarka/i);
  assert.match(text, /apeinant chartą/i);
});

test("TIKSLAS: susietas su sprendimu PLĖSTI, ne abstrakčiai plėtoti", () => {
  /**
   * „Verta plėtoti" nieko nesako apie tai, kas vyksta po piloto. „Verta plėsti
   * už piloto ribų" tiesiogiai susieja tikslą su #28 PR3 sprendimu.
   */
  const text = charter();

  assert.match(text, /plėsti už piloto ribų/i);
});
