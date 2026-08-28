const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * #21 PR2: OPERACINĖS PROCEDŪROS TURI ATITIKTI SISTEMĄ.
 *
 * Šios procedūros vykdomos incidento metu, dažnai vieną kartą ir be repeticijos.
 * Neteisinga komanda čia kainuoja ne laiką, o įrodymus — o jų atkurti
 * nebeįmanoma.
 *
 * Testai tikrina TEIGINIUS, ne formuluotes: ar auditas tikrai neišgyvena
 * restarto, ar minimi laukai egzistuoja, ar patikros seka remiasi realiais
 * atsakymais.
 */

const DOCS = path.join(__dirname, "..", "..", "docs");
const PROCEDURES = path.join(DOCS, "operations", "OPERATIONAL_PROCEDURES.md");

function procedures() {
  return fs.readFileSync(PROCEDURES, "utf8");
}

test.after(() => {
  try {
    require("../utils/deletionTombstones")._stopSweepForTests();
  } catch {
    // Modulis neįkeltas.
  }
});

test("DOKUMENTAS: yra ir susietas su incidentų runbook'u", () => {
  assert.ok(
    fs.existsSync(PROCEDURES),
    "Trūksta docs/operations/OPERATIONAL_PROCEDURES.md\n" +
      "Jei PERKELTAS, atnaujinkite: šį testą, README, INCIDENT_RESPONSE.md ir matricą."
  );

  const doc = procedures();
  assert.match(doc, /INCIDENT_RESPONSE\.md/, "turi nurodyti pagrindinį runbook'ą");
});

test("SEMANTIKA: auditas TIKRAI neišgyvena restarto – ir taip pasakyta", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Visa įrodymų išsaugojimo tvarka remiasi šiuo faktu: auditas saugomas tik
   * atmintyje, tad restartas jį ištrina. Jei tai kada nors pasikeis (atsiras
   * rašymas į diską), procedūra taps be reikalo skubi — bet, svarbiau, jei
   * dokumentas teigtų priešingai, operatorius restartuotų PRIEŠ išsaugodamas.
   *
   * Tikrinam KODĄ, ne tik tekstą.
   */
  const auditSource = fs.readFileSync(path.join(__dirname, "..", "utils", "auditLog.js"), "utf8");

  /**
   * Šablonas apima ir `fs.writeFile`, ir `require("fs").writeFileSync`, ir
   * `Sync` variantus.
   *
   * Pirmoji versija tikrino tik `fs.` prefiksą – ir mutacija, įrašiusi
   * `require("fs").writeFileSync(...)`, praėjo nepastebėta. Detekcija, kuri
   * nepagauna akivaizdaus atvejo, yra blogesnė nei jokios: ji sukuria
   * įspūdį, kad riba stebima.
   */
  const persistsToDisk = /(writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync)\s*\(/.test(
    auditSource
  );

  if (persistsToDisk) {
    assert.fail(
      "auditLog pradėjo rašyti į diską – įrodymų išsaugojimo skyrius nebeteisingas, atnaujinkite jį"
    );
  }

  const doc = procedures();

  assert.match(doc, /tik atmintyje/i, "riba turi būti įvardyta");
  assert.match(doc, /restartas jį ištrina|sunaikina įrodymus/i, "pasekmė turi būti įvardyta");
  assert.match(doc, /PIRMIAU nei bet ką kita|PIRMIAU/i, "tvarkos svarba turi būti įvardyta");
});

test("KOMANDOS: minimi endpoint'ai realiai atsako", async () => {
  /**
   * Įrodymų rinkimas remiasi konkrečiais keliais. Neveikiantis endpointas
   * reiškia, kad operatorius incidento metu negaus nieko — ir sužinos apie tai
   * blogiausiu momentu.
   */
  const doc = procedures();

  const EXPECTED = {
    "/api/health": [200],
    "/api/health/deep": [200, 503],
    "/api/ready": [200, 503],
    "/api/audit": [200, 401],
    "/api/jobs": [401, 404, 405],
  };

  const mentioned = [...doc.matchAll(/\/api\/[a-z/]+/g)].map((m) => m[0]);
  assert.ok(mentioned.length > 0, "procedūros turi minėti endpoint'us");

  const request = require("supertest");
  const app = require("../server");
  app._setReadyForTests();

  for (const endpoint of new Set(mentioned)) {
    const expected = EXPECTED[endpoint];
    assert.ok(expected, `dokumentas mini "${endpoint}" – įrašykite jo kontraktą į EXPECTED`);

    const response = await request(app).get(endpoint);
    assert.ok(
      expected.includes(response.status),
      `${endpoint} turi grąžinti ${expected.join("/")}, gauta ${response.status}`
    );
  }
});

test("AUDITAS: minimi įvykiai egzistuoja kode", () => {
  const doc = procedures();

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
  for (const dir of ["utils", "services", "middleware", "routes", "workers", "queues"]) {
    scan(path.join(__dirname, "..", dir));
  }

  const auditLines = doc.split("\n").filter((line) => /[Aa]uditas:/.test(line));
  const mentioned = new Set();
  for (const line of auditLines) {
    for (const match of line.matchAll(/`([A-Z][A-Z_]{4,})`/g)) mentioned.add(match[1]);
  }

  assert.ok(mentioned.size >= 4, `per mažai minimų audito įvykių: ${mentioned.size}`);

  for (const name of mentioned) {
    assert.ok(known.has(name), `dokumentas mini audito įvykį "${name}", kurio kode nėra`);
  }
});

test("AUDITAS: `/api/audit` parametrai atitinka realią schemą", () => {
  /**
   * Įrodymų rinkimo komanda runbook'e privalo veikti. Jei schema jos parametrų
   * nepriimtų, komanda grąžintų 400 - o operatorius manytų, kad audito nėra.
   *
   * ⚠️ 7.4c (#212) pakeitė kontraktą: `offset` → `cursor`, `event` → `action`.
   * Runbook'as migruotas kartu; testas tikrina ABI puses, kad dokumentas ir
   * schema neišsiskirtų.
   */
  const doc = procedures();
  const { schemas } = require("../middleware/validate");

  assert.ok(schemas.auditQuery, "audito užklausos schema turi egzistuoti");

  const geras = schemas.auditQuery.safeParse({ limit: "1000", action: "LOGIN_SUCCESS" });
  assert.equal(geras.success, true, "schema turi priimti `limit` ir `action`");

  const suKursoriumi = schemas.auditQuery.safeParse({ limit: "10", cursor: "abc" });
  assert.equal(suKursoriumi.success, true, "schema turi priimti `cursor`");

  /** ⚠️ Pašalinti parametrai privalo būti ATMETAMI, ne tyliai nukerpami. */
  for (const pasenes of [{ offset: "0" }, { event: "LOGIN_SUCCESS" }]) {
    assert.equal(
      schemas.auditQuery.safeParse({ limit: "10", ...pasenes }).success,
      false,
      `${Object.keys(pasenes)[0]} po 7.4c nebepriimamas`
    );
  }

  /** `from > to` yra tuščia užklausa, ne filtras. */
  assert.equal(
    schemas.auditQuery.safeParse({
      from: "2026-08-02T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    }).success,
    false,
    "`from > to` privalo būti 400"
  );

  assert.match(doc, /limit=/, "komanda turi naudoti limit");
  assert.match(doc, /cursor/, "puslapiavimas kursoriumi turi būti paaiškintas");
  assert.match(doc, /next_cursor/, "atsakymo laukas turi būti įvardytas");

  /**
   * ⚠️ `offset` runbook'e MINĖTI GALIMA - bet tik kaip paaiškinimą, kodėl jis
   * nebeveikia. Operatorius, radęs seną komandą kitur, turi suprasti gautą 400.
   * Draudžiama tik INSTRUKCIJA jį naudoti.
   */
  assert.match(doc, /offset[^\n]*400|400[^\n]*offset/i, "400 dėl `offset` turi būti paaiškintas");
  assert.doesNotMatch(doc, /Kartokite su `offset`/, "instrukcijos naudoti `offset` likti negali");
});

test("PSEUDONIMIZACIJA: įspėjimas atitinka realų audito lauką", () => {
  /**
   * Be šio įspėjimo operatorius ieškotų jobo ID audite, nieko nerastų ir
   * padarytų išvadą, kad įrašų nėra — nors jie yra.
   */
  const auditLog = require("../utils/auditLog");

  assert.equal(typeof auditLog.pseudonymizeIdentifier, "function", "funkcija turi egzistuoti");

  const pseudonym = auditLog.pseudonymizeIdentifier("job_testinis_123");
  assert.notEqual(pseudonym, "job_testinis_123", "ID turi būti pseudonimizuotas");

  const doc = procedures();
  assert.match(doc, /pseudonimizuot/i);
  assert.match(doc, /pseudonymizeIdentifier/, "turi būti nurodyta konkreti funkcija");
});

test("RETENCIJA: dokumentuota audito reikšmė SUTAMPA su .env.example", () => {
  const doc = procedures();
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  // `—` gali būti bet koks brūkšnys, o `**` – markdown paryškinimas.
  // Paryškinimas gali apimti visą frazę (`**Audito retencija — 30 d.**`),
  // tad `**` nebūtinai eina prieš skaičių.
  const documented = doc.match(/[Aa]udito retencija[^0-9]{0,12}(\d+)\s*d\./);
  assert.ok(documented, "audito retencija turi būti dokumentuota");

  const actual = envExample.match(/^AUDIT_RETENTION_DAYS=(\d+)/m);
  assert.ok(actual, "AUDIT_RETENTION_DAYS turi būti .env.example");

  assert.equal(
    Number(documented[1]),
    Number(actual[1]),
    "dokumentuota retencija išsiskyrė su konfigūracija"
  );

  /**
   * ⚠️ REIKŠMĖS SUTAPIMO NEBEPAKANKA (#155, 7.4b).
   *
   * Nuo `AUDIT_BACKEND=postgres` ta pati 30 dienų reikšmė NEBEGALIOJA:
   * `audit_log` eilutės automatiškai nešalinamos. Runbook'as, nurodantis tik
   * skaičių, siųstų operatorių manyti, kad ištrynimo langas užtikrintas, o
   * asmens duomenys audite liktų neribotai - tiesioginė GDPR saugojimo
   * ribojimo rizika.
   *
   * Todėl tikrinama ir tai, kad dokumentas ĮVARDIJA priklausomybę nuo
   * backend'o, o ne tik reikšmę.
   */
  assert.match(doc, /AUDIT_BACKEND/, "runbook'as privalo įvardyti, nuo ko retencija priklauso");
  assert.match(
    doc,
    /postgres/i,
    "persistentinis režimas privalo būti paminėtas - jame reikšmė negalioja"
  );
  assert.match(
    doc,
    /NEGALIOJA|nešalinamos|neribotai/,
    "runbook'as privalo pasakyti, kad postgres režime retencija neveikia"
  );
});

test("KLAIDINGI TEIGINIAI: `ENOENT` ištrynime tikrai reiškia sėkmę", () => {
  /**
   * Dokumentas teigia, kad `already_absent` yra sėkmė, ne gedimas. Tai
   * tikrinama patikra: jei klasifikacija pasikeistų, operatorius klaidingai
   * pradėtų incidentą dėl veikiančio ištrynimo.
   */
  const { classifyFailure } = require("../services/lifecycleService");

  assert.equal(classifyFailure("ENOENT: no such file or directory"), "already_absent");

  const doc = procedures();
  assert.match(doc, /already_absent/, "klasė turi būti įvardyta");
  assert.match(doc, /sėkmė/i, "reikšmė turi būti paaiškinta");
});

test("PATIKRA: seka turi VISUS šešis žingsnius", () => {
  /**
   * Praleistas žingsnis reiškia, kad kažkuri kontrolė liks nepatikrinta — o
   * būtent tai ir yra atkūrimo patikros prasmė.
   */
  const doc = procedures();

  const steps = [
    "Konfigūracija atkurta",
    "Autentifikacija veikia",
    "Rolės veikia",
    "Auditas rašomas",
    "Ištrynimas veikia",
    "Darbai realiai apdorojami",
  ];

  let lastIndex = -1;
  for (const step of steps) {
    const index = doc.indexOf(step);
    assert.ok(index !== -1, `trūksta patikros žingsnio: ${step}`);
    assert.ok(index > lastIndex, `žingsnis "${step}" ne savo vietoje`);
    lastIndex = index;
  }
});

test("PATIKRA: įvardyta, kad `mock` režimas duoda sintetinius rezultatus", () => {
  /**
   * Dažniausiai pamirštamas atkūrimo žingsnis: sistema veikia, `/api/health`
   * rodo `ok`, bet tiekėjai liko `mock` – ir naudotojai gauna sintetinius
   * protokolus kaip tikrus.
   */
  const doc = procedures();

  assert.match(doc, /nebe\s*`?mock`?/i, "turi būti nurodyta patikrinti tiekėjus");
  assert.match(doc, /sintetin/i, "pasekmė turi būti įvardyta");
});

test("KOMANDOS: bash blokuose NĖRA shell placeholder'ių", () => {
  /**
   * `<vardas>` bash bloke yra įvesties nukreipimas, ne placeholderis –
   * nukopijuota komanda duotų „No such file or directory".
   *
   * Ta pati klaida jau buvo rasta `INCIDENT_RESPONSE.md`; patikra kartojama
   * čia, nes tai atskiras dokumentas su savo komandomis.
   */
  const doc = procedures();

  const bashBlocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(bashBlocks.length >= 3, "procedūros turi turėti bash komandų");

  for (const block of bashBlocks) {
    const commands = block
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n");

    /**
     * `<host>` URL'uose leidžiamas: jis yra kabutėse ir shell jo
     * neinterpretuoja kaip nukreipimo.
     */
    /**
     * Praleidžiam tai, kas yra KABUTĖSE: `echo "$name=<nustatyta>"` nėra
     * nukreipimas – shell `<` viduje kabučių neinterpretuoja.
     *
     * Pirmoji versija to neskyrė ir pažymėjo teisėtą komandą kaip klaidingą.
     * Tikrinam TIK nukreipimą už kabučių ribų.
     */
    const withoutQuoted = commands
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .replace(/<host>/g, "HOST");

    assert.doesNotMatch(
      withoutQuoted,
      /<[-A-Za-z0-9_]+>/,
      `bash komandoje yra <placeholder> už kabučių ribų:\n${commands}`
    );
  }
});

test("SAUGUMAS: dokumente NĖRA tikrų paslapčių ir raginama jų nekopijuoti", () => {
  const secretsInventory = require("../utils/secretsInventory");
  const doc = procedures();

  const leaked = secretsInventory.findLeakedSecrets(doc, process.env);
  assert.deepEqual(leaked, [], `dokumente aptikta paslapčių: ${leaked.join(", ")}`);

  assert.ok(!/[0-9a-f]{64}/.test(doc), "jokių 64 hex simbolių raktų");

  /**
   * Ir eksplicitinis įspėjimas: incidento medžiaga dažnai keliauja per el.
   * paštą ir pokalbius, tad `.env` kopijavimas į ją būtų nutekėjimas.
   */
  assert.match(doc, /[Nn]iekada nekopijuokite `?\.env`? failo/, "įspėjimas turi būti eksplicitinis");
});

test("RIBOS: įvardyta, ko procedūros NEAPIMA", () => {
  const doc = procedures();

  const limits = [
    { pattern: /[Aa]utomatinio metrikų rinkimo.*nėra|automatinio metrikų rinkimo/i, what: "metrikų rinkimas" },
    { pattern: /centralizuoto logų/i, what: "logų kaupimas" },
    { pattern: /neišgyvena restarto/i, what: "audito persistencija" },
  ];

  for (const limit of limits) {
    assert.match(doc, limit.pattern, `riba neįvardyta: ${limit.what}`);
  }
});

test("LOGAI: `--since` apribojimas ĮVARDYTAS, ne nutylėtas", () => {
  /**
   * ⚠️ TYLUS APRIBOJIMAS incidentų dokumente yra pavojingesnis nei trūkstama
   * komanda.
   *
   * `--since 24h` paima tik paskutines 24 val. Jei incidentas prasidėjo
   * anksčiau, failas atrodys pilnas, o dalies įrodymų jame nebus — ir tai
   * paaiškės tik tada, kai jų prireiks.
   *
   * Todėl numatytoji komanda yra BE `--since`, o intervalo trumpinimas
   * pateikiamas kaip sąmoningas pasirinkimas su paaiškinta kaina.
   */
  const doc = procedures();

  // Pagrindinė įrodymų rinkimo komanda neturi riboti laiko.
  const evidenceBlock = doc.match(/# BE --since[\s\S]{0,200}?```/);
  assert.ok(evidenceBlock, "pagrindinė logų komanda turi būti be `--since`");

  assert.match(doc, /`--since` naudokite tik sąmoningai/i, "apribojimas turi būti įvardytas");
  assert.match(doc, /dalies įrodymų\s*\n?\s*tiesiog nebus|dalies įrodymų/i, "pasekmė turi būti įvardyta");

  /**
   * Ir antra, nepriklausoma riba: Docker logų rotacija gali pašalinti
   * seniausius įrašus nepriklausomai nuo `--since`.
   */
  assert.match(doc, /rotacijos nustatymus|logų rotacij/i, "Docker rotacijos riba turi būti paminėta");
});

test("PATIKRA: baigiamoji taisyklė aiškiai draudžia dalinį uždarymą", () => {
  /**
   * Dokumento logika tai numanė, bet operatorius incidento metu skaito
   * greitai. Viena eksplicitinė taisyklė čia vertingesnė nei kelios pastraipos
   * paaiškinimo.
   */
  const doc = procedures();

  assert.match(doc, /bent vienas žingsnis nepraeina/i, "taisyklė turi būti eksplicitinė");
  assert.match(doc, /nelaikomas uždarytu/i, "pasekmė turi būti aiški");
  assert.match(doc, /visi \*\*šeši\*\*|visi šeši/i, "turi būti nurodyta, kiek žingsnių privaloma");
});

test("APLINKA: įvardyta, kokiai aplinkai skirtos komandos", () => {
  /**
   * `grep`, `sed` ir `date` elgesys skiriasi BSD (macOS) ir GNU (Linux)
   * įrankiuose. Prielaida buvo teisinga, bet nutylėta — o incidento metu
   * neveikianti komanda kainuoja laiką.
   */
  const doc = procedures();

  assert.match(doc, /Linux shell \(bash\)/i, "aplinka turi būti įvardyta");
  assert.match(doc, /Docker Compose/i, "diegimo būdas turi būti įvardytas");
});

test("KOMANDOS: `.env` būsenos fiksavimas skaito FAILĄ, ne shell aplinką", () => {
  /**
   * ⚠️ REALI KLAIDA, rasta review metu.
   *
   * Pirmoji versija naudojo `printenv "$name"` — o tai skaito DABARTINIO
   * SHELL aplinką, ne `.env` failą. Operatorius, paleidęs komandą kataloge su
   * `.env`, bet neeksportavęs reikšmių (įprasta situacija), būtų gavęs:
   *
   *   LLM_PROVIDER=<tuščia>
   *   API_KEY=<tuščia>
   *
   * nors faile jos yra. Incidento įrodymai būtų tapę NETIKSLŪS — ir tai
   * blogiau nei jų nebuvimas, nes jais būtų pasitikima.
   */
  const doc = procedures();

  assert.ok(
    !/printenv\s+"\$name"/.test(doc),
    "`printenv \"$name\"` skaito shell aplinką, ne .env failą"
  );

  // Komanda turi remtis PAČIU failu.
  assert.match(doc, /awk -F=[\s\S]{0,300}?\.env/, "`.env` būsena turi būti skaitoma iš failo");

  /**
   * Ir antra riba, kurią review teisingai nurodė: failo būsena ≠ veikiančio
   * konteinerio konfigūracija.
   */
  assert.match(doc, /`\.env` FAILO būseną/i, "riba turi būti įvardyta");
  assert.match(doc, /docker compose exec backend printenv/, "turi būti pateiktas ir runtime variantas");
});

test("KOMANDOS: `curl` nepriima klaidos atsakymo kaip įrodymo", () => {
  /**
   * Be `--fail-with-body` `curl` tyliai išsaugo ir 401/403/500 atsakymą.
   * Failas atrodytų sukurtas, o jame būtų klaidos JSON — operatorius manytų,
   * kad auditas išsaugotas.
   */
  const doc = procedures();

  /**
   * Tikrinamos VISOS `curl` komandos, kurios rašo į failą (`-o`).
   *
   * Pirmoji versija tikrino teksto fragmentą aplink pirmą `/api/audit`
   * paminėjimą — o jis gali būti visai kitame skyriuje (pvz. metrikų
   * lentelėje). Mutacija, grąžinusi `curl -s`, dėl to praėjo.
   *
   * Kriterijus tikslus: jei komanda IŠSAUGO atsakymą kaip įrodymą, ji privalo
   * atmesti klaidas.
   */
  const bashBlocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

  const savingCurls = bashBlocks
    .flatMap((block) => block.split(/\n(?=curl)/))
    /**
     * `-o` turi priklausyti CURL, ne kitai komandai po `|`.
     *
     * `curl -s ... | grep -o '...'` neišsaugo failo — `-o` čia yra `grep`
     * vėliava. Pirmoji versija to neskyrė ir pažymėjo teisėtą diagnostikos
     * komandą kaip trūkstamą apsaugos.
     */
    .filter((chunk) => {
      if (!chunk.trimStart().startsWith("curl")) return false;

      // Imam tik curl dalį – iki pirmo pipe.
      const curlPart = chunk.split("|")[0];
      return /\s-o\s+\S/.test(curlPart) && !/-o\s+\/dev\/null/.test(curlPart);
    });

  assert.ok(savingCurls.length > 0, "turi būti bent viena curl komanda, rašanti į failą");

  for (const command of savingCurls) {
    assert.match(
      command,
      /--fail-with-body/,
      `curl išsaugo atsakymą kaip įrodymą, bet nepatikrina klaidos:\n${command.slice(0, 160)}`
    );
  }
  assert.match(doc, /curl kodas: \$\?|kodas.*\$\?/, "rezultato patikra turi būti pateikta");
});

test("TEIGINIAI: dokumentas NEteigia, kad shell komandos tikrinamos CI", () => {
  /**
   * Ankstesnė formuluotė („visos komandos ir laukai patikrinti prieš tikrą
   * kodą") buvo per stipri: CI tikrina endpoint'us, audito įvykius ir
   * semantines garantijas, bet bash komandų nevykdo.
   *
   * Per stiprus teiginys apie patikrinimą pavojingas būtent incidentų
   * dokumente — jis atgraso nuo išankstinio komandų išbandymo.
   */
  const doc = procedures();

  assert.ok(
    !/[Vv]isos komandos ir laukai patikrinti/.test(doc),
    "per stiprus teiginys apie komandų patikrinimą"
  );

  assert.match(doc, /automatiškai\s*\n?\s*nevykdom/i, "riba turi būti įvardyta");
  assert.match(doc, /patikrinkite savo diegime prieš incidentą/i, "turi būti nurodyta, ką daryti");
});

test("TVARKA: draudimas liečia RESTARTĄ, ne bet kokį sulaikymą", () => {
  /**
   * „Išsaugoti auditą PIRMIAU nei bet ką kita" teoriškai konfliktuotų su
   * aktyvia eksfiltracija: tada nenaikinantis sulaikymas (rakto atšaukimas,
   * tinklo prieigos uždarymas) turi vykti nedelsiant.
   *
   * Tikslus draudimas: negalima to, kas IŠTRINA atminties būseną.
   */
  const doc = procedures();

  assert.match(doc, /PRIEŠ bet kokį restartą/i, "draudimas turi būti susietas su restartu");
  assert.match(doc, /nenaikinančio/i, "nenaikinantis sulaikymas turi likti leidžiamas");
  assert.match(doc, /ištrina atminties būseną/i, "kriterijus turi būti aiškus");
});
