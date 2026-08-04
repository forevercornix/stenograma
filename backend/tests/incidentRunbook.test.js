const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const secretsInventory = require("../utils/secretsInventory");

/**
 * #21 PR1: INCIDENTŲ RUNBOOK TURI REMTIS TIKRA SISTEMA.
 *
 * Incidentų runbook'as skaitomas blogiausiu įmanomu momentu: skubant, su
 * nepilna informacija, dažnai ne to žmogaus, kuris jį rašė.
 *
 * Todėl jame minimi dalykai privalo egzistuoti. Nurodytas neteisingas
 * kintamasis ar neveikianti komanda kainuoja ne tik laiką — jie sukelia
 * abejonę visu dokumentu būtent tada, kai juo reikia pasitikėti.
 *
 * Šie testai NETIKRINA teksto kokybės. Jie tikrina, kad dokumente minimi
 * dalykai realiai egzistuoja.
 */

const DOCS = path.join(__dirname, "..", "..", "docs");
const RUNBOOK = path.join(DOCS, "operations", "INCIDENT_RESPONSE.md");

function runbook() {
  return fs.readFileSync(RUNBOOK, "utf8");
}

/**
 * VALYMAS PO SERVERIO ĮKĖLIMO.
 *
 * Endpointų testas kelia `../server`, kuris paleidžia periodinius laikmačius
 * (sesijų sweep, ištrynimo žymos). Be valymo vaikinis procesas gali nespėti
 * tvarkingai baigtis, ir Node testų vykdyklė krinta FAILO lygiu su klaida,
 * neturinčia nieko bendro su testų turiniu.
 *
 * Ta pati problema jau buvo #18 `rbac.route` teste – todėl dedama iš karto, ne
 * po to, kai pasirodo nestabilumas.
 */
test.after(async () => {
  try {
    const tombstones = require("../utils/deletionTombstones");
    tombstones._stopSweepForTests();
  } catch {
    // Modulis neįkeltas - nieko valyti.
  }

  try {
    const sessionStore = require("../utils/sessionStore");
    sessionStore._stopPeriodicSweepForTests();
  } catch {
    // Tas pats.
  }
});

test("RUNBOOK: dokumentas yra ten, kur reikalauja #21 DoD", () => {
  /**
   * Kelias `docs/operations/INCIDENT_RESPONSE.md` nurodytas pačioje issue.
   * Perkėlus jį, nuorodos iš README ir kitų dokumentų nustotų veikti.
   */
  assert.ok(
    fs.existsSync(RUNBOOK),
    "Trūksta docs/operations/INCIDENT_RESPONSE.md\n" +
      "Jei PERKELTAS, atnaujinkite: šį testą, README ir docs/security-test-matrix.md."
  );
});

test("KONFIGŪRACIJA: KOMANDOSE naudojami kintamieji realiai egzistuoja", () => {
  /**
   * ⚠️ Tikrinamos BASH BLOKŲ priskyrimo eilutės, ne vien paminėjimai.
   *
   * Pirmoji versija tikrino, ar vardas figūruoja dokumente „kažkur" – ir
   * mutacija, sugadinusi komandą į `TRANSCRIPTION_PROVIDERIS=mock`, PRAĖJO,
   * nes teisingas vardas buvo paminėtas lentelėje kitoje vietoje.
   *
   * Operatorius vykdo KOMANDĄ, ne lentelę. Būtent ji turi būti teisinga.
   */
  const doc = runbook();
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  /**
   * SHELL kintamieji ≠ konfigūracijos nuostatos.
   *
   * `WORKER_SERVICE="worker"` yra pagalbinis kintamasis pačioje komandoje, ne
   * `.env` nuostata — jo ten ir neturi būti. Tikrinam tik tuos, kurie
   * pateikiami kaip konfigūracija.
   */
  const SHELL_LOCALS = new Set(["WORKER_SERVICE"]);

  const assignments = [...doc.matchAll(/^([A-Z][A-Z0-9_]{2,})=/gm)]
    .map((m) => m[1])
    .filter((name) => !SHELL_LOCALS.has(name));

  assert.ok(assignments.length >= 4, `per mažai rastų priskyrimų: ${assignments.length}`);

  for (const name of new Set(assignments)) {
    assert.match(
      envExample,
      new RegExp(`^#?\\s*${name}=`, "m"),
      `runbook komandoje naudoja \`${name}\`, kurio nėra .env.example`
    );
  }
});

test("KONFIGŪRACIJA: minimi kintamieji REALIAI egzistuoja", () => {
  /**
   * Sulaikymo veiksmai remiasi konkrečiais kintamaisiais. Neteisingas vardas
   * reiškia, kad operatorius nedelsiant vykdys komandą, kuri nieko nepadaro —
   * ir manys, kad tiekėjai išjungti.
   */
  const doc = runbook();
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  // Kintamieji, kuriuos runbook mini kaip sulaikymo priemonę.
  const referenced = ["LLM_PROVIDER", "TRANSCRIPTION_PROVIDER", "DIARIZATION_PROVIDER", "API_KEY_ROLE", "AUTH_USERS"];

  for (const name of referenced) {
    /**
     * Priimam ir `backtick`, ir bash bloko formą.
     *
     * Pirmoji versija reikalavo backtick'ų – ir krito dėl kintamųjų, esančių
     * ```bash blokuose, kur jie natūraliai rašomi be jų. Testas tikrino
     * FORMATAVIMĄ, ne turinį.
     */
    assert.match(doc, new RegExp(`\\b${name}\\b`), `runbook turi minėti ${name}`);
    assert.match(
      envExample,
      new RegExp(`^#?\\s*${name}=`, "m"),
      `${name} minimas runbook'e, bet jo nėra .env.example`
    );
  }
});

test("PASLAPTYS: nurodoma, KUR rasti aktualų sąrašą", () => {
  /**
   * Ankstesnė versija tikrino KIEKĮ ("8 tiekėjų raktai") ir taip įtvirtino
   * skaičių, kuris incidento metu nieko nesako: svarbu žinoti, KURIUOS raktus
   * atšaukti, ne kiek jų yra.
   *
   * Be to skaičius dokumente yra papildomas trapumo šaltinis — jis sensta su
   * kiekvienu nauju tiekėju.
   */
  const doc = runbook();

  assert.match(doc, /secretsInventory\.js/, "turi nurodyti, kur rasti aktualų sąrašą");

  // Ir inventorius realiai egzistuoja.
  assert.ok(secretsInventory.externallyIssuedSecrets().length > 0, "inventoriuje turi būti išorinių paslapčių");
});

test("PASLAPTYS: įvardytas skirtumas tarp vidinių ir IŠORINIŲ", () => {
  /**
   * Kritinė detalė: išorinės paslapties neužtenka pakeisti konfigūracijoje —
   * senasis raktas lieka galiojantis, kol jo neatšauksite pas tiekėją.
   *
   * Praleidus tai, „kredencialas atšauktas" būtų netiesa.
   */
  const doc = runbook();

  assert.match(doc, /atšaukti tiekėjo konsolėje/i, "atšaukimas pas tiekėją turi būti įvardytas");
  assert.match(doc, /neužtenka pakeisti konfigūracijoje/i, "pasekmė turi būti įvardyta");
});

test("AUDITAS: minimi audito įvykiai REALIAI egzistuoja kode", () => {
  /**
   * Runbook nurodo, kur ieškoti požymių. Neegzistuojantis įvykio vardas
   * reiškia paiešką, kuri niekada nieko neras — ir klaidingą išvadą, kad
   * incidento nebuvo.
   *
   * ⚠️ HEURISTIKA SIAURINAMA SĄMONINGAI.
   *
   * Ankstesnė versija laikė audito įvykiu KIEKVIENĄ backtick'uose paminėtą
   * didžiųjų raidžių vardą su pabraukimu — ir pažymėjo `UPLOADS_ENABLED`
   * (siūlomą konfigūracijos kintamąjį) kaip neegzistuojantį įvykį.
   *
   * Tikrinam tik tuos vardus, kurie MINIMI KARTU su audito kontekstu:
   * lentelės eilutėse apie audito požymius. Tai siauriau, bet tikrina tai, ką
   * teigia, o ne viską, kas panašu į konstantą.
   */
  const doc = runbook();

  const sourceDirs = ["utils", "services", "middleware", "routes", "workers", "queues"];
  const known = new Set();

  function scan(dir) {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith(".js")) {
        const source = fs.readFileSync(full, "utf8");
        for (const match of source.matchAll(/event:\s*["']([A-Z_]+)["']/g)) known.add(match[1]);
      }
    }
  }

  for (const dir of sourceDirs) scan(path.join(__dirname, "..", dir));

  assert.ok(known.size >= 8, `per mažai rastų audito įvykių: ${known.size}`);

  /**
   * Iš dokumento imam TIK tuos vardus, kurie pateikti kaip audito požymiai —
   * t. y. eilutėse, kuriose minimas `audit` kontekstas.
   */
  const auditLines = doc
    .split("\n")
    .filter((line) => /audit|LIFECYCLE_|AUTHORIZATION_|_DENIED|_ERASED/i.test(line));

  const mentioned = new Set();
  for (const line of auditLines) {
    for (const match of line.matchAll(/`([A-Z][A-Z_]{6,})`/g)) mentioned.add(match[1]);
  }

  assert.ok(mentioned.size > 0, "runbook turi minėti bent vieną audito įvykį");

  for (const name of mentioned) {
    assert.ok(known.has(name), `runbook mini audito įvykį "${name}", kurio kode nėra`);
  }
});

test("ENDPOINT'AI: minimi keliai REALIAI atsako", async () => {
  /**
   * ⚠️ TIKRINAMA ELGSENA, ne `server.js` tekstas.
   *
   * Ankstesnė versija ieškojo literalo faile — ir būtų sulūžusi teisėto
   * refaktoringo metu (perkėlus maršrutą į routerį ar pakeitus kabutes), nors
   * endpointas toliau veiktų.
   *
   * Operatoriui svarbu, kad kelias ATSAKO, ne kur jis parašytas.
   */
  const doc = runbook();

  /**
   * Kiekvienam dokumentuojamam endpointui – AIŠKUS kontraktas.
   *
   * Bendra `[200, 503]` taisyklė visiems keliams sulūžtų, kai runbook'e
   * atsirastų autentifikuotas diagnostikos endpointas: teisėtas 401 ar 403
   * būtų palaikytas gedimu.
   */
  const EXPECTED_STATUSES = {
    "/api/ready": [200, 503],
    "/api/health": [200],
  };

  const mentioned = [...doc.matchAll(/`(\/api\/[a-z/]+)`/g)].map((m) => m[1]);
  assert.ok(mentioned.length > 0, "runbook turi minėti bent vieną endpointą");

  const request = require("supertest");
  const app = require("../server");
  app._setReadyForTests();

  for (const endpoint of new Set(mentioned)) {
    const expected = EXPECTED_STATUSES[endpoint];
    assert.ok(expected, `runbook mini "${endpoint}" – įrašykite jo kontraktą į EXPECTED_STATUSES`);

    const response = await request(app).get(endpoint);

    /**
     * `notEqual(404)` būtų per silpna: 500 irgi „atsako". Health endpoint'ai
     * pagrįstai grąžina 200 arba 503 (nepasiruošęs), bet niekada 500.
     */
    assert.ok(
      expected.includes(response.status),
      `${endpoint} turi grąžinti ${expected.join("/")}, gauta ${response.status}`
    );
  }
});

test("SKUBUMAS: visi keturi lygiai su REAGAVIMO TERMINAIS", () => {
  /**
   * Lygis be termino nieko nesako. „Aukštas" be „per 1 val." reiškia, kad du
   * žmonės supras jį skirtingai — ir abu manys, kad teisingai.
   */
  const doc = runbook();

  const levels = [
    { pattern: /Kritinis.*<\s*15 min/s, what: "kritinis su <15 min" },
    { pattern: /Aukštas.*per 1 val/s, what: "aukštas su 1 val." },
    { pattern: /Vidutinis.*darbo dieną/s, what: "vidutinis su darbo diena" },
    { pattern: /Žemas.*priežiūros lang/s, what: "žemas su priežiūros langu" },
  ];

  for (const level of levels) {
    assert.match(doc, level.pattern, `trūksta lygio su terminu: ${level.what}`);
  }
});

test("EIGA: visi septyni žingsniai dokumentuoti TA PAČIA tvarka", () => {
  /**
   * Tvarka nėra atsitiktinė: sulaikymas eina PRIEŠ įrodymų išsaugojimą, nes
   * kol poveikis tęsiasi, kiekviena minutė prideda naujų paveiktų duomenų.
   */
  const doc = runbook();

  /**
   * ⚠️ Tikrinamas TIK numeruotas eigos blokas, ne visas dokumentas.
   *
   * Ankstesnė versija naudojo `doc.indexOf(step)` visame tekste – tad frazė,
   * pasitaikiusi įžangoje ar paaiškinime, būtų nulėmusi rezultatą. Testas apie
   * TVARKĄ priklausė nuo atsitiktinės dokumento vietos.
   *
   * (Ankstesniame PR aprašyme klaidingai nurodžiau, kad ši pastaba jau
   * ištaisyta – realiai ji liko. Taisoma dabar.)
   */
  const workflowMatch = doc.match(/## 4\. Reagavimo eiga[\s\S]*?```\n([\s\S]*?)```/);
  assert.ok(workflowMatch, "trūksta numeruoto reagavimo eigos bloko");

  const workflow = workflowMatch[1];

  const steps = [
    "Aptikti ir klasifikuoti",
    "Sulaikyti",
    "Išsaugoti",
    "Įvertinti",
    "Atkurti",
    "Patikrinti atkūrimą",
    "peržiūr",
  ];

  let lastIndex = -1;
  for (const step of steps) {
    const index = workflow.indexOf(step);
    assert.ok(index !== -1, `eigos bloke trūksta žingsnio: ${step}`);
    assert.ok(index > lastIndex, `žingsnis "${step}" ne savo vietoje – tvarka svarbi`);
    lastIndex = index;
  }
});

test("GDPR: pranešimas NĖRA pateikiamas kaip automatinis", () => {
  /**
   * #21 eksplicitiškai reikalauja neteigti, kad kiekvienas incidentas
   * automatiškai reikalauja pranešimo. Perdėtas teiginys būtų toks pat
   * žalingas kaip praleistas: jis mokytų ignoruoti visą skyrių.
   */
  const doc = runbook();

  assert.match(doc, /[Nn]e kiekvienas incidentas reikalauja pranešimo/);
  assert.match(doc, /72 val/, "BDAR terminas turi būti nurodytas");

  /**
   * Laikrodžio pradžia turi būti EDPB „awareness" prasme: pagrįstas tikrumas,
   * kad įvyko pažeidimas.
   *
   * Ankstesnė formuluotė („nuo sužinojimo") buvo per kategoriška – ji galėjo
   * būti suprasta kaip pradžia nuo pirmo nepatvirtinto techninio signalo.
   */
  assert.match(doc, /pagrįstą\s+tikrumą/i, "laikrodžio pradžia turi būti apibrėžta tiksliai");
  // `[*\s]+` – tarp žodžių gali būti eilutės lūžis IR markdown žymėjimas (`**`).
  assert.match(doc, /ne[*\s]+nuo[*\s]+pirmo[*\s]+nepatvirtinto/i, "turi būti pasakyta, kas NĖRA pradžia");
});

test("GDPR: sprendimą priima DUOMENŲ VALDYTOJAS, ne piloto savininkas", () => {
  /**
   * Pagal BDAR 33 str. atsakomybė tenka VALDYTOJUI. Piloto savininko
   * pareigybės pavadinimas savaime nesuteikia teisės spręsti jo vardu — o
   * ankstesnė šio dokumento versija būtent taip ir teigė.
   *
   * `\s+` vietoj tarpo: Markdown eilutės laužomos ties ~80 simbolių.
   */
  const doc = runbook();

  assert.match(doc, /duomenų\s+valdytojas\s+ar\s+jo\s+įgaliotas/i, "atsakomybė turi būti priskirta valdytojui");
  assert.match(doc, /33\s*str/i, "teisinis pagrindas turi būti nurodytas");
  assert.match(doc, /nesuteikia teisės/i, "riba turi būti aiški");

  /**
   * ⚠️ NEIGIAMA PATIKRA.
   *
   * Teigiama patikra tik patvirtina, kad teisinga frazė KAŽKUR yra – ji
   * neaptinka prieštaraujančio teiginio kitoje vietoje. Būtent taip v2 ir
   * nutiko: paaiškinimas buvo teisingas, o LENTELĖ virš jo tebeteigė, kad
   * sprendžia piloto savininkas.
   *
   * Incidento metu operatorius greičiau perskaitys lentelę nei vėlesnę išlygą.
   */
  assert.doesNotMatch(
    doc,
    /[Pp]iloto savininkas sprendžia dėl pranešimo/,
    "piloto savininkui negalima priskirti valdytojo sprendimo"
  );
});

test("SULAIKYMAS: veiksmai įvardyti kaip GRĮŽTAMI ir nenaikinantys", () => {
  /**
   * Svarbiausia sulaikymo savybė: jis neturi sunaikinti įrodymų. Operatorius
   * skubėdamas linkęs „perkurti aplinką" — dokumentas privalo tai atkalbėti.
   */
  const doc = runbook();

  assert.match(doc, /grįžtam/i, "grįžtamumas turi būti įvardytas");
  assert.match(doc, /nenaikina|nenaikinantis/i, "turi būti pasakyta, ko NEDARYTI");
  assert.match(doc, /kill -9/, "įspėjimas dėl worker'ių nutraukimo turi būti konkretus");
});

test("ROLĖS: įvardytos ROLĖS, ne asmenys", () => {
  /**
   * Dokumentas su konkrečiais vardais pasensta pirmiau nei bet kuri jo dalis,
   * o pilote kelias roles dažnai atlieka tas pats žmogus.
   */
  const doc = runbook();

  assert.match(doc, /rolės, ne asmenys/i);
  assert.match(doc, /Piloto savininkas/);
  assert.match(doc, /Techninis atsakingas/);
});

test("SAUGUMAS: dokumente NĖRA tikrų paslapčių", () => {
  /**
   * Runbook gyvena viešoje repozitorijoje. Pavyzdys su tikra reikšme būtų
   * nutekėjimas – ir dar toks, kurio niekas nepastebėtų, nes „tai tik
   * dokumentacija".
   */
  const doc = runbook();

  const leaked = secretsInventory.findLeakedSecrets(doc, process.env);
  assert.deepEqual(leaked, [], `runbook'e aptikta paslapčių: ${leaked.join(", ")}`);

  // Ir jokių raktus primenančių literalų.
  assert.ok(!/sk-ant-[A-Za-z0-9]{10,}/.test(doc), "jokių Anthropic raktų pavyzdžių");
  assert.ok(!/[0-9a-f]{64}/.test(doc), "jokių 64 hex simbolių raktų");
});

test("SEMANTIKA: `API_KEY_ROLE=operator` NESUSTABDO įkėlimų – ir taip pasakyta", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Pirmoji runbook versija teigė, kad `API_KEY_ROLE=operator` „atima kūrimo
   * teises" ir taip sustabdo įkėlimus. Tai buvo NETIESA: operatorius **turi**
   * `job:create` ir `export:redacted`; jis netenka tik `job:delete` ir
   * `export:original`.
   *
   * Pasekmė būtų pavojinga: operatorius incidento metu įvykdytų komandą ir
   * klaidingai manytų, kad duomenų priėmimas sustabdytas.
   *
   * Kiti šio failo testai tikrina, ar minimi VARDAI egzistuoja. Šis tikrina,
   * ar TEIGINYS apie jų poveikį teisingas — būtent to trūko.
   */
  const { hasPermission, PERMISSIONS } = require("../utils/permissions");

  // 1. TIKROVĖ: operatorius gali kurti darbus ir eksportuoti redaguotą variantą.
  assert.equal(hasPermission("operator", PERMISSIONS.JOB_CREATE), true);
  assert.equal(hasPermission("operator", PERMISSIONS.EXPORT_REDACTED), true);

  // 2. Ir netenka tik šių dviejų.
  assert.equal(hasPermission("operator", PERMISSIONS.JOB_DELETE), false);
  assert.equal(hasPermission("operator", PERMISSIONS.EXPORT_ORIGINAL), false);

  // 3. DOKUMENTAS privalo tai pasakyti, o ne teigti priešingai.
  const doc = runbook();

  assert.match(
    doc,
    /API_KEY_ROLE=operator`?\s*\*?\*?\s*NESUSTABDO/i,
    "runbook privalo aiškiai pasakyti, kad tai NESUSTABDO įkėlimų"
  );
  assert.ok(
    !/API_KEY_ROLE=operator[\s\S]{0,200}?sustabdo įkėlimus/i.test(doc.replace(/NESUSTABDO/gi, "")),
    "runbook NEGALI teigti, kad ši nuostata sustabdo įkėlimus"
  );
});

test("SEMANTIKA: įkėlimų jungiklio NĖRA – ir tai pasakyta", () => {
  /**
   * Sistema neturi `UPLOADS_ENABLED` ar panašios nuostatos. Runbook privalo
   * tai pripažinti, o ne siūlyti neegzistuojančio mechanizmo.
   */
  const doc = runbook();
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  assert.ok(!/^#?\s*UPLOADS_ENABLED=/m.test(envExample), "jei jungiklis atsirado, runbook reikia atnaujinti");
  assert.match(doc, /ĮKĖLIMŲ IŠJUNGIMO JUNGIKLIO NĖRA/i, "riba turi būti pripažinta");
});

test("SEMANTIKA: SIGTERM elgesys aprašytas PAGAL KODĄ, ne bendrai", () => {
  /**
   * `docker compose stop` savaime negarantuoja, kad darbai užbaigiami — tai
   * priklauso nuo to, ar aplikacija apdoroja SIGTERM.
   *
   * Tikrovė: BullMQ worker'is TURI grakštų uždarymą, `server.js` — NE. Tad
   * inline režime vykdomas darbas nutraukiamas.
   */
  const workerSource = fs.readFileSync(path.join(__dirname, "..", "workers", "index.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  /**
   * Tikrinam ne vien žodį, o KVIETIMĄ: `process.on("SIGTERM", ...)` ir tai,
   * kad uždarymas realiai laukia worker'io.
   *
   * Vien `/SIGTERM/` paieška praeitų ir tada, jei liktų tik komentaras.
   */
  assert.match(workerSource, /process\.on\(["']SIGTERM["']/, "worker turi REGISTRUOTI SIGTERM apdorojimą");
  assert.match(workerSource, /await\s+\w*[Ww]orker\w*\.close\(|shutdownWorker/, "uždarymas turi laukti worker'io");

  const serverHandlesSigterm = /process\.on\(["']SIGTERM["']/.test(serverSource);

  const doc = runbook();

  if (serverHandlesSigterm) {
    assert.fail(
      "server.js pradėjo apdoroti SIGTERM – runbook teiginys apie inline režimą nebeteisingas, atnaujinkite jį"
    );
  }

  assert.match(doc, /SIGTERM\s+\*\*neapdoroja\*\*|SIGTERM.*neapdoroja/i, "inline režimo riba turi būti įvardyta");
  assert.match(doc, /nutraukiamas/i, "pasekmė turi būti įvardyta");
});

test("KOMANDOS: bash blokuose NĖRA shell placeholder'ių", () => {
  /**
   * ⚠️ `<vardas>` bash bloke NĖRA tekstinis placeholderis.
   *
   * `<` reiškia įvesties nukreipimą iš failo, tad nukopijuota komanda duotų
   * `bash: vardas: No such file or directory`.
   *
   * Tai tiksliai ta klaidų rūšis, nuo kurios šie testai turėtų saugoti:
   * komanda atrodo teisinga dokumente, o realiai neveikia — ir tai paaiškėja
   * incidento metu.
   *
   * Vietoj jų naudojami kintamieji: `WORKER_SERVICE="worker"`.
   */
  const doc = runbook();

  const bashBlocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(bashBlocks.length > 0, "runbook turi turėti bash komandų");

  for (const block of bashBlocks) {
    // Praleidžiam komentarų eilutes – jose `<...>` nekenksmingas.
    const commands = block
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n");

    assert.doesNotMatch(
      commands,
      /<[-A-Za-z0-9_]+>/,
      `bash komandoje yra <placeholder> – shell jį interpretuos kaip nukreipimą:\n${commands}`
    );
  }
});

test("GARANTIJOS: eilės vykdymo konfigūracija NEPATEIKIAMA kaip besąlyginė", () => {
  /**
   * Ši garantija galioja tik jei VISI worker procesai perkrauti IR tiekėjas
   * parenkamas darbo vykdymo, ne kūrimo metu.
   *
   * Dokumente ji jau buvo sušvelninta viename skyriuje, bet kitame liko
   * kategoriška — dvi skirtingo griežtumo formuluotės tame pačiame dokumente
   * blogesnės nei viena silpnesnė.
   */
  const doc = runbook();

  assert.doesNotMatch(
    doc,
    /eilėje esantys darbai[\s*]+bus vykdomi/i,
    "eilės vykdymo konfigūracija negali būti pateikiama kaip besąlyginė garantija"
  );

  assert.match(doc, /turėtų būti[\s\S]{0,80}vykdomi nauja konfigūracija/i, "sąlyginė formuluotė turi likti");
});

test("SEMANTIKA: produkcijoje be AUTH_USERS ir API_KEY darbai NEPRIIMAMI", async () => {
  /**
   * ⚠️ TIKRINAMA VIENINTELĖ REALI INTAKE STABDYMO PROCEDŪRA.
   *
   * Runbook teigia, kad produkcijoje pašalinus abu mechanizmus endpoint'ai
   * grąžina 503. Iki šiol tai buvo TIK teiginys — testai tikrino leidimus ir
   * `UPLOADS_ENABLED` nebuvimą, bet ne pačią procedūrą.
   *
   * Kadangi tai pateikiama kaip vienintelis būdas sustabdyti duomenų priėmimą,
   * neįrodyta garantija čia pavojingesnė nei bet kur kitur.
   *
   * Vykdoma ATSKIRAME procese: `NODE_ENV=production` jau pakrautam moduliui
   * nepakeistų elgesio, o globalios `process.env` mutacijos paliestų kitus
   * testus.
   */
  const { execFileSync } = require("child_process");

  const script = `
    process.env.NODE_ENV = "production";
    process.env.AUTH_USERS = "";
    process.env.API_KEY = "";
    process.env.LOG_LEVEL = "error";
    process.env.LLM_PROVIDER = "mock";
    process.env.TRANSCRIPTION_PROVIDER = "mock";
    process.env.DIARIZATION_PROVIDER = "none";
    process.env.CORS_ORIGIN = "http://localhost:5173";

    const request = require("supertest");
    const app = require("./server");
    app._setReadyForTests();

    request(app)
      .post("/api/jobs")
      .send({ transcript: "Jonas: Sveiki, pradedam susitikimą. Reikia ataskaitos." })
      .then((res) => {
        console.log(JSON.stringify({ status: res.status }));
        process.exit(0);
      })
      .catch((error) => {
        console.log(JSON.stringify({ error: error.message }));
        process.exit(1);
      });
  `;

  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30000,
  });

  const result = JSON.parse(output.trim().split("\n").pop());

  assert.equal(
    result.status,
    503,
    `produkcijoje be abiejų mechanizmų darbų kūrimas turi grąžinti 503, gauta ${result.status}`
  );
});
