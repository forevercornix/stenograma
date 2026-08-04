const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * #21 PR3: PERŽIŪRA, PRATYBOS IR APIMTIES PATIKRA.
 *
 * Šis dokumentas uždaro #21, tad jame yra apimties lentelė su nuorodomis į
 * konkrečius kitų dokumentų skyrius. Tokia lentelė sensta greičiausiai iš
 * visko: pakanka pervadinti skyrių, ir nuoroda tampa melu, kurio niekas
 * nepastebi, kol jo neprireikia.
 */

const OPS = path.join(__dirname, "..", "..", "docs", "operations");

function doc(name) {
  return fs.readFileSync(path.join(OPS, name), "utf8");
}

function postmortem() {
  return doc("POSTMORTEM_AND_EXERCISES.md");
}

test("DOKUMENTAS: yra ir susietas su abiem kitais", () => {
  assert.ok(
    fs.existsSync(path.join(OPS, "POSTMORTEM_AND_EXERCISES.md")),
    "Trūksta docs/operations/POSTMORTEM_AND_EXERCISES.md"
  );

  const text = postmortem();
  assert.match(text, /INCIDENT_RESPONSE\.md/);
  assert.match(text, /OPERATIONAL_PROCEDURES\.md/);
});

test("APIMTIS: kiekviena nuoroda į skyrių REALIAI egzistuoja", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Apimties lentelė nurodo konkrečius skyrius (`§2`, `§5`). Pervadinus ar
   * pernumeravus skyrių, nuoroda tampa melu — o būtent tokia lentelė
   * naudojama, kai reikia greitai rasti procedūrą.
   *
   * Tikrinam, kad kiekvienas nurodytas numeris tame dokumente egzistuotų.
   */
  const text = postmortem();

  const references = [...text.matchAll(/\[`([A-Z_]+\.md)`\]\([^)]+\)\s*§(\d+)/g)];
  assert.ok(references.length >= 10, `per mažai nuorodų į skyrius: ${references.length}`);

  for (const [, file, section] of references) {
    const target = doc(file);

    assert.match(
      target,
      new RegExp(`^##\\s*${section}\\.`, "m"),
      `${file} neturi skyriaus §${section} – nuoroda pasenusi`
    );
  }
});

test("APIMTIS: nuorodos veda į VISUS tris dokumentus", () => {
  /**
   * Jei lentelė nurodytų tik vieną failą, ji nebeatliktų navigacijos
   * funkcijos, dėl kurios sukurta.
   */
  const text = postmortem();

  assert.match(text, /INCIDENT_RESPONSE\.md`\]\([^)]+\)\s*§/, "turi nurodyti į incidentų runbook'ą");
  assert.match(text, /OPERATIONAL_PROCEDURES\.md`\]\([^)]+\)\s*§/, "turi nurodyti į procedūras");
  assert.match(text, /šis dokumentas §/, "turi nurodyti ir į save");
});

test("ŠABLONAS: turi visus privalomus skyrius", () => {
  /**
   * Trūkstamas skyrius peržiūroje reiškia, kad kažkuris klausimas liks
   * neatsakytas — ir dažniausiai tai bus tas, kurio niekas nenori atsakyti.
   */
  const text = postmortem();

  const sections = [
    "## Santrauka",
    "## Poveikis",
    "## Laiko juosta",
    "## Kaip aptikta",
    "## Priežastis",
    "## Kas veikė gerai",
    "## Kas neveikė",
    "## Veiksmai",
    "## Ar reikia keisti runbook",
  ];

  for (const section of sections) {
    assert.ok(text.includes(section), `šablone trūksta skyriaus: ${section}`);
  }
});

test("ŠABLONAS: laiko juosta apima pilną incidento eigą", () => {
  /**
   * Laiko juosta be „įrodymai išsaugoti" eilutės neleistų vėliau atsakyti,
   * ar jie apskritai buvo išsaugoti — o tai svarbiausias #21 PR2 reikalavimas.
   */
  const text = postmortem();

  for (const moment of [
    "Pirmas signalas",
    "Incidentas pripažintas",
    "Pirmas sulaikymo veiksmas",
    "Įrodymai išsaugoti",
    "Priežastis nustatyta",
    "Paslauga atkurta",
    "Atkūrimo patikra baigta",
  ]) {
    assert.ok(text.includes(moment), `laiko juostoje trūksta: ${moment}`);
  }
});

test("ŠABLONAS: draudžia turinį, vardus ir raktus", () => {
  /**
   * Peržiūros keliauja plačiau ir saugomos ilgiau nei patys duomenys. Tai
   * padaro jas patogia nutekėjimo vieta — būtent todėl, kad atrodo kaip
   * „tik dokumentacija".
   */
  const text = postmortem();

  assert.match(text, /NERAŠOMI dokumentų turinio fragmentai|Dokumentų turinio fragmentai/);
  assert.match(text, /[Rr]aktai, slaptažodžiai/);
  assert.match(text, /naudotojų vardai/i);
});

test("ŠABLONAS: veiksmas be atsakingo ir termino įvardytas kaip netinkamas", () => {
  /**
   * Be šios taisyklės „veiksmų" skyrius virsta pageidavimų sąrašu, kurio
   * niekas nevykdo — ir kitas incidentas įvyks dėl to paties.
   */
  const text = postmortem();

  assert.match(text, /be atsakingo ir termino/i);
  assert.match(text, /pageidavimas, ne veiksmas/i);
});

test("PRATYBOS: įvardyta, kad neišbandytas runbook nėra procedūra", () => {
  /**
   * Ta pati logika kaip su kopijomis (#20): kopija, kuri niekada nebuvo
   * atkurta, nėra atkūrimo mechanizmas. Nuoroda į `backup-runbook.md` daro šį
   * ryšį matomą.
   */
  const text = postmortem();

  assert.match(text, /niekada nebuvo išbandytas/i);
  assert.match(text, /backup-runbook\.md/, "ryšys su kopijų pratybomis turi būti nurodytas");
});

test("PRATYBOS: svarbiausias rezultatas – NE „pavyko\"", () => {
  /**
   * Sklandžios pratybos, po kurių nieko nepataisyta, dažniausiai reiškia, kad
   * vykdyta iš atminties, ne pagal dokumentą. Be šio įspėjimo pratybos tampa
   * ritualu.
   */
  const text = postmortem();

  assert.match(text, /ne „pavyko"/i);
  assert.match(text, /iš atminties, ne pagal dokumentą/i);
});

test("RIBOS: visos aštuonios įvardytos ir sutampa su kitais dokumentais", () => {
  /**
   * Ribų lentelė yra santrauka to, kas išbarstyta po tris dokumentus. Jei ji
   * praleistų ribą, skaitytojas manytų, kad jos nėra — o santraukos skaitomos
   * dažniau nei pilni tekstai.
   *
   * ⚠️ ŠALTINIO ŠABLONAS NURODOMAS EKSPLICITIŠKAI.
   *
   * Pirmoji versija jį IŠVEDINĖJO iš ribos pavadinimo
   * (`limit.what.split(" ")[0].slice(0, 6)`) — ir gaudavo tokius raktažodžius
   * kaip `"dev"` ar `"logų"`, kurie dokumente sutampa su bet kuo. Patikra
   * praeitų net tada, jei šaltinyje būtų visai kita mintis su tuo pačiu
   * žodžiu.
   *
   * Trys ribos anksčiau turėjo `source: null` ir apskritai nebuvo tikrinamos
   * prieš šaltinį. Dabar KIEKVIENA turi arba konkretų šaltinio šabloną, arba
   * eksplicitinę priežastį, kodėl jo nėra.
   *
   * ⚠️ ŠABLONAI BE ALTERNATYVŲ IR SUSIETI SU SKYRIUMI.
   *
   * Antrasis review raundas parodė dvi likusias silpnybes:
   *
   *   1. `A|B` alternatyvos: pakanka, kad suveiktų PLATESNIS variantas, ir
   *      konkretaus teiginio dingimas liktų nepastebėtas. Pvz. `SIGTERM`
   *      dokumente minimas 3 kartus – pirmoji alternatyva galėjo sutapti su
   *      visai kitu paminėjimu.
   *
   *   2. Šablonas, sutampantis su SANTRAUKOS fraze, įrodo tik tai, kad frazė
   *      kažkur yra – ne kad šaltinis ribą paaiškina. `Centralizuoto logų
   *      kaupimo` buvo būtent toks atvejis.
   *
   * Todėl: vienas tikslus šablonas kiekvienai ribai, ieškomas KONKREČIAME
   * šaltinio skyriuje.
   */

  /** Ištraukia skyrių pagal antraštę – iki kitos to paties lygio antraštės. */
  function section(fileName, heading) {
    const source = doc(fileName);
    const start = source.indexOf(heading);

    assert.notEqual(start, -1, `${fileName} neturi skyriaus „${heading}" – šablonas pasenęs`);

    const rest = source.slice(start + heading.length);
    const next = rest.search(/\n## /);

    return next === -1 ? rest : rest.slice(0, next);
  }
  const text = postmortem();

  const limits = [
    {
      summary: /[Aa]uditas gyvena tik atmintyje/,
      what: "audito trumpalaikiškumas",
      source: "OPERATIONAL_PROCEDURES.md",
      sourceHeading: "## 1. Įrodymų išsaugojimas",
      sourcePattern: /Jis \*\*nerašomas į diską\*\*/,
    },
    {
      summary: /[Įį]kėlimų jungiklio nėra/,
      what: "įkėlimų jungiklis",
      source: "INCIDENT_RESPONSE.md",
      sourceHeading: "## 5. Sulaikymo veiksmai",
      sourcePattern: /ĮKĖLIMŲ IŠJUNGIMO JUNGIKLIO NĖRA/,
    },
    {
      summary: /[Dd]ev režime apsaugos nėra/,
      what: "dev režimas",
      source: "INCIDENT_RESPONSE.md",
      sourceHeading: "## 5. Sulaikymo veiksmai",
      sourcePattern: /[Dd]ev režime šis metodas NEVEIKIA/,
    },
    {
      summary: /[Ii]nline režime nėra grakštaus/,
      what: "inline sustabdymas",
      source: "INCIDENT_RESPONSE.md",
      sourceHeading: "## 5. Sulaikymo veiksmai",
      sourcePattern: /[Ii]nline režime tokio „drain" nėra/,
    },
    {
      summary: /[Cc]entralizuoto logų kaupimo nėra/,
      what: "logų kaupimas",
      source: "OPERATIONAL_PROCEDURES.md",
      /**
       * Susieta su „NEAPIMA" skyriumi: taip tikrinama, kad šaltinis ribą
       * PRIPAŽĮSTA, o ne tiesiog kartoja tą pačią frazę kitame kontekste.
       */
      sourceHeading: "## 5. Ko šios procedūros NEAPIMA",
      sourcePattern: /[Cc]entralizuoto logų kaupimo/,
    },
    /**
     * Šios trys ribos kyla iš PAČIOS SISTEMOS apimties, ne iš kito dokumento
     * teiginio – jos pirmą kartą įvardijamos būtent čia, santraukoje.
     */
    { summary: /[Aa]utomatinių aliarmų nėra/, what: "aliarmai", source: null, reason: "sistemos apimties riba" },
    { summary: /[Bb]udėjimo 24\/7 nėra/, what: "budėjimas", source: null, reason: "organizacinė riba" },
    {
      summary: /[Aa]utomatinės klasifikacijos nėra/,
      what: "klasifikacija",
      source: null,
      reason: "sistemos apimties riba",
    },
  ];

  assert.equal(limits.length, 8, "ribų sąrašas turi atitikti dokumentuotą skaičių");

  for (const limit of limits) {
    assert.match(text, limit.summary, `riba neįvardyta santraukoje: ${limit.what}`);

    if (limit.source) {
      /**
       * Šablonas be alternatyvų – kitaip pakaktų, kad suveiktų platesnis
       * variantas, ir konkretaus teiginio dingimas liktų nepastebėtas.
       */
      assert.ok(
        !limit.sourcePattern.source.includes("|"),
        `riba „${limit.what}": šaltinio šablonas turi alternatyvą – naudokite vieną tikslų`
      );

      assert.match(
        section(limit.source, limit.sourceHeading),
        limit.sourcePattern,
        `riba „${limit.what}" santraukoje yra, bet ${limit.source} skyriuje ` +
          `„${limit.sourceHeading}" apie ją nekalba`
      );
    } else {
      assert.ok(limit.reason, `riba „${limit.what}" be šaltinio privalo turėti priežastį`);
    }
  }
});

test("TVARKA: audito išsaugojimas NĖRA pateikiamas kaip absoliučiai pirmas", () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL PASIKARTOJANČIOS KLAIDOS.
   *
   * Teiginys „įrodymų išsaugojimas — pirmas incidento žingsnis" buvo
   * pašalintas per #21 PR2 review, ir aš jį grąžinau TRIS kartus iš eilės:
   * PR3 v1, v2 ir v3. Kiekvieną kartą jį rado recenzentas, ne testas.
   *
   * Kai klaida kartojasi tris kartus, jos priežastis nebėra neatidumas —
   * formuluotė tiesiog patogesnė ir trumpesnė, tad natūraliai grįžta.
   * Vienintelis būdas ją sustabdyti — patikra, ne pastanga.
   *
   * KODĖL TAI SVARBU: vykstant aktyviai eksfiltracijai operatorius, sekantis
   * absoliučią taisyklę, kelias minutes puslapiuotų auditą vietoj to, kad
   * nedelsiant atšauktų raktą. Grįžtamas sulaikymas įrodymų nenaikina, tad
   * jokio konflikto nėra — tik klaidingas dokumentas.
   */
  const text = postmortem();

  for (const forbidden of [
    /įrodymų išsaugojimas (?:yra |— )?\*?\*?pirmas\*?\*? incidento žingsnis/i,
    /išsaugojimas — pirmas žingsnis/i,
    /auditas visada pirmas(?!")/i,
  ]) {
    assert.doesNotMatch(text, forbidden, `grąžinta absoliuti taisyklė: ${forbidden}`);
  }

  // Ir teisinga, niuansuota formuluotė privalo būti.
  assert.match(text, /prieš bet kokį restartą/i, "draudimas turi būti susietas su restartu");
  assert.match(text, /nenaikinanči/i, "nenaikinantis sulaikymas turi likti leidžiamas");
});

test("PRATYBOS: prieigos sustabdymui reikalaujama `NODE_ENV=production`", () => {
  /**
   * Prieštaravimas, kurį rado review: „pratybos ne produkcijoje" + „tikėtis
   * 503" negali galioti kartu, nes 503 atsiranda TIK produkcinėje
   * autentifikacijos semantikoje.
   *
   * Dev režime, pašalinus abu mechanizmus, sistema užklausas PRALEIDŽIA — tad
   * pratybos parodytų priešingą rezultatą, ir operatorius klaidingai
   * paskelbtų saugumo gedimą.
   */
  const text = postmortem();

  assert.match(text, /ne gyvoje produkcijos aplinkoje/i, "pratybų aplinka turi būti neprodukcinė");

  /**
   * Sąlyga tikrinama PAČIOJE pratybų eilutėje, ne „kažkur dokumente".
   *
   * Pirmoji versija ieškojo `NODE_ENV=production` visame tekste – o jis
   * minimas ir paaiškinime žemiau, tad sąlygos dingimas iš LENTELĖS liko
   * nepastebėtas. Operatorius skaito lentelę.
   */
  const exerciseRow = text.split("\n").find((line) => /\*\*Prieigos sustabdymas\*\*/.test(line));
  assert.ok(exerciseRow, "pratybų lentelėje turi būti prieigos sustabdymo eilutė");

  assert.match(
    exerciseRow,
    /NODE_ENV=production/,
    `pratybų eilutėje trūksta produkcinės semantikos sąlygos:\n${exerciseRow}`
  );
  assert.match(text, /praleidžia.*administrator|administrator.*teisėmis/i, "dev elgesys turi būti paaiškintas");
});

test("PRATYBOS: rakto atšaukimui reikalaujamas TESTINIS kredencialas", () => {
  /**
   * Be šio patikslinimo metinės pratybos galėtų būti atliktos su produkciniu
   * raktu – ir procedūros patikrinimas taptų incidentu.
   */
  const text = postmortem();

  assert.match(text, /testinis.*kredencialas|Tik \*\*testinis\*\*/i);
  assert.match(text, /produkcinių raktų pratyboms neatšaukiama/i);
});

test("RIBOS: audito trumpalaikiškumas įvardytas kaip SVARBIAUSIAS", () => {
  /**
   * Jis lemia ne tik tai, ką turėsime po incidento, bet ir VEIKSMŲ TVARKĄ jo
   * metu. Todėl jis negali būti tiesiog vienas iš aštuonių punktų sąraše.
   */
  const text = postmortem();

  assert.match(text, /[Ss]varbiausia iš jų — audito trumpalaikiškumas/);
  assert.match(text, /veiksmų tvarką jo metu/i, "poveikis tvarkai turi būti įvardytas");
});

test("APIMTIS: „out of scope\" punktai atitinka issue", () => {
  /**
   * Sąrašas, kas sąmoningai NEDAROMA, apsaugo nuo klaidingo lūkesčio, kad
   * rinkinys apima daugiau, nei apima.
   */
  const text = postmortem();

    /**
   * `\s+` vietoj tarpo: Markdown eilutės laužomos ties ~80 simbolių, tad
   * frazė gali būti perskelta. Tai jau trečias kartas šioje serijoje – verta
   * atsiminti rašant tekstą tikrinančius testus.
   */
  for (const excluded of [/SOC/i, /teisinė\s+konsultacija/i, /24\/7/, /ekspertizė/i]) {
    assert.match(text, excluded, `„out of scope" punktas neįvardytas: ${excluded}`);
  }
});

test("SAUGUMAS: dokumente NĖRA tikrų paslapčių", () => {
  const secretsInventory = require("../utils/secretsInventory");
  const text = postmortem();

  const leaked = secretsInventory.findLeakedSecrets(text, process.env);
  assert.deepEqual(leaked, [], `dokumente aptikta paslapčių: ${leaked.join(", ")}`);

  assert.ok(!/[0-9a-f]{64}/.test(text), "jokių 64 hex simbolių raktų");
});

test("KOMANDOS: bash blokuose NĖRA shell placeholder'ių", () => {
  /**
   * Ta pati patikra kaip kituose dviejuose dokumentuose. Šiame jų mažai, bet
   * `markdown` blokuose esantys šablonai neturi tapti vykdomomis komandomis.
   */
  const text = postmortem();

  const bashBlocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

  for (const block of bashBlocks) {
    const commands = block
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n")
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''");

    assert.doesNotMatch(commands, /<[-A-Za-z0-9_]+>/, `bash komandoje yra <placeholder>:\n${commands}`);
  }
});
