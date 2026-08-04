const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const governance = require("../utils/providerGovernance");
const { MATRIX } = require("../utils/providerPrivacy");

/**
 * #22.1: TIEKĖJŲ INVENTORIUS IR VALDYSENA.
 *
 * Šis etapas nieko neblokuoja vykdymo metu (tai #22.2) — jis apibrėžia
 * POLITIKĄ ir tikrina, kad ji būtų pilna, sąžininga ir neišvengiamai susieta
 * su realiais tiekėjais.
 */

const DOC = path.join(__dirname, "..", "..", "docs", "provider-governance.md");

function doc() {
  return fs.readFileSync(DOC, "utf8");
}

test("INVENTORIUS: KIEKVIENAS matricos tiekėjas turi valdysenos įrašą", () => {
  /**
   * ⚠️ SVARBIAUSIAS ŠIO FAILO TESTAS.
   *
   * Valdysena išvedama IŠ `providerPrivacy.MATRIX`, ne rašoma atskirai.
   * Antras, nepriklausomas sąrašas neišvengiamai išsiskirtų: naujas tiekėjas
   * atsirastų viename, bet ne kitame, ir liktų BE POLITIKOS tyliai.
   *
   * Ta pati taisyklė kaip #20 kopijų politikoje, išvestoje iš #19 registro.
   */
  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const provider of Object.keys(byKind)) {
      const entry = governance.governanceFor(kind, provider);

      assert.ok(
        entry,
        `tiekėjas "${provider}" (${kind}) yra matricoje, bet neturi valdysenos įrašo`
      );
    }
  }
});

test("INVENTORIUS: valdysenoje NĖRA tiekėjų, kurių nėra matricoje", () => {
  /**
   * Priešinga kryptis: valdysenos įrašas be techninio atitikmens reikštų
   * politiką tiekėjui, kurio sistema neturi — ir toks įrašas tyliai pasentų.
   */
  for (const [kind, byKind] of Object.entries(governance.GOVERNANCE)) {
    for (const provider of Object.keys(byKind)) {
      assert.ok(
        MATRIX[kind] && MATRIX[kind][provider],
        `valdysenoje yra "${provider}" (${kind}), bet matricoje jo nėra`
      );
    }
  }
});

test("KERTINĖ TAISYKLĖ: nežinoma savybė NIEKADA nereiškia patvirtinimo", () => {
  /**
   * Tiekėjas, apie kurio retenciją nieko nežinome, nėra „tikriausiai
   * tvarkingas" — jis nepatvirtintas. Priešingas numatytasis elgesys reikštų,
   * kad neišsamus dokumentavimas automatiškai suteikia leidimą.
   */
  for (const [kind, byKind] of Object.entries(governance.GOVERNANCE)) {
    for (const [provider, entry] of Object.entries(byKind)) {
      if (entry.confidence !== governance.CONFIDENCE.UNKNOWN) continue;

      assert.equal(
        entry.approval,
        governance.APPROVAL.REQUIRED,
        `"${provider}" (${kind}): savybės nežinomos, bet patvirtinimas nereikalaujamas`
      );

      const { allowed } = governance.isProviderAllowed(kind, provider);
      assert.equal(allowed, false, `"${provider}" (${kind}) leidžiamas be patvirtinimo`);
    }
  }
});

test("SĄŽININGUMAS: nė vienas IŠORINIS tiekėjas nepažymėtas `verified`", () => {
  /**
   * Šis projektas išorinių tiekėjų savybių NETIKRINO. Įrašyti `verified` be
   * realaus patikrinimo reikštų teigti neverifikuotas sutartines garantijas —
   * tiksliai tą klaidą, nuo kurios #22 saugo.
   */
  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const [provider, technical] of Object.entries(byKind)) {
      if (technical.processing !== "external") continue;

      const entry = governance.governanceFor(kind, provider);

      assert.notEqual(
        entry.confidence,
        governance.CONFIDENCE.VERIFIED,
        `"${provider}" (${kind}) pažymėtas verified, nors išorinių tiekėjų netikrinom`
      );
    }
  }
});

test("SĄŽININGUMAS: LOKALŪS tiekėjai gali būti `verified`", () => {
  /**
   * Vienintelis atvejis, kai `verified` sąžininga: apdorojimo vietą galima
   * patikrinti KODE, ne tiekėjo pažadais.
   */
  const localEntry = governance.governanceFor("llm", "mock");

  assert.equal(localEntry.confidence, governance.CONFIDENCE.VERIFIED);
  assert.equal(localEntry.approval, governance.APPROVAL.NOT_REQUIRED);
});

test("FAIL-CLOSED: nežinomas tiekėjas NELEIDŽIAMAS", () => {
  /**
   * Naujas tiekėjas, pridėtas be valdysenos įrašo, neveiks — tai sąmoninga
   * trintis. Priešingu atveju jį būtų galima pridėti ir naudoti, o politika
   * apie jį tylėtų.
   */
  const { allowed, reason } = governance.isProviderAllowed("llm", "naujas-tiekejas");

  assert.equal(allowed, false);
  assert.match(reason, /neturi valdysenos įrašo/);
});

test("FAIL-CLOSED: nežinomas TIPAS neleidžiamas", () => {
  assert.equal(governance.isProviderAllowed("nezinomas", "mock").allowed, false);
  assert.equal(governance.governanceFor("nezinomas", "mock"), null);
});

test("PATVIRTINIMAS: išorinis tiekėjas leidžiamas TIK su eksplicitiniu sąrašu", () => {
  /**
   * Sąrašas ateina iš konfigūracijos, ne iš kodo: patvirtinimas yra duomenų
   * valdytojo SPRENDIMAS, o ne projekto savybė.
   */
  assert.equal(governance.isProviderAllowed("llm", "claude").allowed, false);

  assert.equal(
    governance.isProviderAllowed("llm", "claude", { approvedExternal: ["claude"] }).allowed,
    true
  );

  // Kito tiekėjo patvirtinimas šio neatrakina.
  assert.equal(
    governance.isProviderAllowed("llm", "gpt", { approvedExternal: ["claude"] }).allowed,
    false
  );
});

test("PATVIRTINIMAS: sąrašas skaitomas iš `APPROVED_EXTERNAL_PROVIDERS`", () => {
  assert.deepEqual(governance.approvedExternalProviders({}), []);

  assert.deepEqual(
    governance.approvedExternalProviders({ APPROVED_EXTERNAL_PROVIDERS: "claude, WHISPER ,, gpt" }),
    ["claude", "whisper", "gpt"]
  );
});

test("DIAGNOSTIKA: politika rodoma BE paslapčių", () => {
  /**
   * Diagnostika turi atsakyti „ar leidžiama", ne „su kuo jungiamasi".
   * Raktai, endpoint'ai ir kredencialai į ją nepatenka.
   */
  const description = governance.describeGovernance("llm", "claude", {
    ANTHROPIC_API_KEY: "sk-ant-labai-slaptas-raktas-123",
    APPROVED_EXTERNAL_PROVIDERS: "claude",
  });

  const serialized = JSON.stringify(description);

  assert.ok(!serialized.includes("sk-ant-labai-slaptas-raktas-123"), "raktas NEGALI patekti");
  assert.ok(!/https?:\/\//.test(serialized), "jokių endpoint'ų");

  // Bet politikos faktai rodomi.
  assert.equal(description.processing, "external");
  assert.equal(description.dataSent, "transcript");
  assert.equal(description.allowed, true);
});

test("DIAGNOSTIKA: nežinomas tiekėjas grąžina `known: false`, ne klaidą", () => {
  const description = governance.describeGovernance("llm", "nera-tokio");

  assert.equal(description.known, false);
  assert.equal(description.provider, "nera-tokio");
});

test("DOKUMENTAS: kiekvienas tiekėjas paminėtas inventoriuje", () => {
  /**
   * Tiekėjas, kurio nėra dokumente, operatoriui neegzistuoja — o būtent
   * dokumentu remiamasi pildant diegimo sąrašą.
   */
  const text = doc();

  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const provider of Object.keys(byKind)) {
      assert.match(
        text,
        new RegExp(`\`${provider}\``),
        `tiekėjas "${provider}" (${kind}) nedokumentuotas`
      );
    }
  }
});

test("DOKUMENTAS: išoriniai tiekėjai pažymėti kaip reikalaujantys patvirtinimo", () => {
  const text = doc();

  const externalProviders = [];
  for (const [kind, byKind] of Object.entries(MATRIX)) {
    for (const [provider, technical] of Object.entries(byKind)) {
      if (technical.processing === "external") externalProviders.push({ kind, provider });
    }
  }

  assert.ok(externalProviders.length >= 6, `per mažai išorinių tiekėjų: ${externalProviders.length}`);

  for (const { provider } of externalProviders) {
    const row = text.split("\n").find((line) => line.includes(`\`${provider}\``) && line.includes("|"));

    assert.ok(row, `tiekėjo "${provider}" nėra lentelėje`);
    assert.match(row, /reikalingas/, `"${provider}" lentelėje nepažymėtas kaip reikalaujantis patvirtinimo`);
  }
});

test("DOKUMENTAS: kertinė taisyklė įvardyta", () => {
  const text = doc();

  assert.match(text, /NEŽINOMA SAVYBĖ NIEKADA NEREIŠKIA PATVIRTINIMO/i);
  assert.match(text, /neišsamus dokumentavimas\s*\n?\s*automatiškai suteikia leidimą/i);
});

test("DOKUMENTAS: įvardyta, kad techninė kontrolė NĖRA teisinė atitiktis", () => {
  /**
   * #22 eksplicitiškai reikalauja nepateikti techninių kontrolių kaip pilnos
   * teisinės atitikties. Perdėtas teiginys čia būtų žalingesnis nei
   * praleistas: jis sukurtų klaidingą saugumo jausmą sprendžiant apie asmens
   * duomenis.
   */
  const text = doc();

  assert.match(text, /[Tt]echninė kontrolė nėra teisinė atitiktis/);
  assert.match(text, /nepakeičia duomenų valdytojo sprendimo/i);
});

test("DOKUMENTAS: kontrolinis sąrašas apima visas #22 sritis", () => {
  const text = doc();

  for (const area of [
    "### Autentifikacija",
    "### Privatumo režimas",
    "### Tiekėjai",
    "### Retencija",
    "### Eksportai",
    "### Logai",
    "### Kopijos",
    "### Incidentai",
  ]) {
    assert.ok(text.includes(area), `kontroliniame sąraše trūksta srities: ${area}`);
  }
});

test("SAUGUMAS: dokumente NĖRA tikrų paslapčių", () => {
  const secretsInventory = require("../utils/secretsInventory");
  const text = doc();

  assert.deepEqual(secretsInventory.findLeakedSecrets(text, process.env), []);
  assert.ok(!/[0-9a-f]{64}/.test(text), "jokių 64 hex simbolių raktų");
});

test("FORMULUOTĖ: sąrašas ĮGYVENDINA sprendimą, bet jo NEĮRODO", () => {
  /**
   * ⚠️ SUBTILUS, BET SVARBUS SKIRTUMAS.
   *
   * Kodas negali atskirti apgalvoto duomenų valdytojo sprendimo nuo
   * neatsargaus `.env` pakeitimo: įrašius `claude`, tiekėjas leidžiamas net
   * tada, kai DPA nepasirašyta ir retencija nežinoma.
   *
   * Jei dokumentacija teigtų, kad sąrašas „reiškia sprendimą", konfigūracija
   * atrodytų kaip ATITIKTIES ĮRODYMAS — ir auditui būtų rodomas `.env` failas
   * vietoj realaus sprendimo įrašo.
   *
   * Tai tikrinama testu, nes formuluotė trumpesnė ir patogesnė, tad natūraliai
   * grįžtų per pirmą redagavimą.
   */
  const text = doc();

  assert.match(text, /\*\*įgyvendina\*\*/, "sąrašas turi būti aprašytas kaip įgyvendinantis");
  assert.match(text, /\*\*neįrodo\*\*/, "ir aiškiai NEįrodantis");
  assert.match(text, /nėra atitikties įrodymas/i, "pasekmė turi būti įvardyta");

  assert.ok(
    !/[Šš]is sąrašas reiškia \*\*duomenų valdytojo sprendimą\*\*/.test(text),
    "grąžinta formuluotė, teigianti, kad konfigūracija YRA sprendimas"
  );
});

test("SĄŽININGUMAS: `unknown` įvardytas kaip „nepatikrinta\", ne „nesaugu\"", () => {
  /**
   * Skaitytojas, supratęs `unknown` kaip „nesaugu", padarytų neteisingą
   * išvadą apie tiekėją. Reikšmė siauresnė: šis projektas savybės netikrino.
   */
  const text = doc();

  assert.match(text, /`unknown` ≠ „nesaugu"/);
  assert.match(text, /šis projektas savybės\s*\n?\s*netikrino/i);
});

test("KONFIGŪRACIJA: patvirtintų tiekėjų sąrašas DEDUBLIKUOJAMAS", () => {
  /**
   * `claude,CLAUDE, claude` yra vienas tiekėjas – diagnostikoje jis turi
   * pasirodyti vieną kartą.
   */
  const governanceModule = require("../utils/providerGovernance");

  assert.deepEqual(
    governanceModule.approvedExternalProviders({ APPROVED_EXTERNAL_PROVIDERS: "claude,CLAUDE, claude ,gpt" }),
    ["claude", "gpt"]
  );
});

test("PASITIKĖJIMAS: `assumed` nenaudojamas, bet jo paskirtis dokumentuota", () => {
  /**
   * Negyvas kelias be paaiškinimo ilgainiui pašalinamas kaip „nereikalingas".
   * Šis lygis paliktas KONKREČIAM DIEGIMUI: operatorius, perskaitęs sutartį,
   * pažymi savybę kaip `assumed`, kai ji dokumentuota viešai, bet nepatvirtinta
   * raštu.
   */
  const governanceModule = require("../utils/providerGovernance");

  const used = Object.values(governanceModule.GOVERNANCE)
    .flatMap((byKind) => Object.values(byKind))
    .map((entry) => entry.confidence);

  assert.ok(
    !used.includes(governanceModule.CONFIDENCE.ASSUMED),
    "šiame projekte `assumed` neturėtų būti naudojamas – neturime pagrįstų prielaidų"
  );

  // Bet paskirtis paaiškinta ir kode, ir dokumente.
  const fsModule = require("fs");
  const source = fsModule.readFileSync(
    require("path").join(__dirname, "..", "utils", "providerGovernance.js"),
    "utf8"
  );

  assert.match(source, /Lygis paliktas KONKREČIAM DIEGIMUI/, "paskirtis turi būti užrašyta kode");
  assert.match(doc(), /`assumed` šiame projekte nenaudojamas/, "ir dokumente");
});
