const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SERVISŲ MANIFESTAS: TAS PATS SERVISAS - TAS PATS APIBRĖŽIMAS (#405, D).
 *
 * ⚠️ KODĖL SARGAS, O NE "VIENAS AUTORITETAS".
 *
 * `postgresS3` rinkiniui reikia ir PostgreSQL, ir S3 saugyklos, o signalų atskyrimas
 * (#405 D) reikalauja, kad S3 kelias gyventų ATSKIRAME job'e. `services:` yra
 * job'o lygio raktas, tad antras job'as privalo turėti savo `postgres:`
 * apibrėžimą. Kelio aplinkkeliui nėra, ir tai IŠMATUOTA, ne numatyta:
 *
 *   `services.<id>.image: ${{ env.X }}`  -> workflow atmetamas prieš startą,
 *                                           0 job'ų (zondas 36061618938)
 *   kontrolė su kietai įrašytu atvaizdu  -> 12 job'ų, zondas žalias
 *                                           (36061770186)
 *
 * Composite action irgi nepadeda: jis prideda tik `steps`, ne `services`.
 *
 * Todėl ginama ne "kopijos nėra", o SILPNESNĖ IR ĮGYVENDINAMA savybė:
 * kopijos negali TYLIAI išsiskirti. Dublis leistinas; nepastebėtas dublio
 * nuokrypis - ne.
 *
 * ⚠️ AIBĖ IŠVEDAMA IŠ `ci.yml`, NE IŠ SĄRAŠO ŠIAME FAILE. Rankinis sąrašas
 * gintų tik tuos servisus, kuriuos kas nors atsiminė įrašyti - t. y. praleistų
 * būtent naują job'ą, dėl kurio sargas ir atsirado.
 */

const CI_KELIAS = path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml");

/**
 * Struktūriškai išveda VISUS `jobs.<job>.services.<id>` apibrėžimus.
 *
 * Parsinama rankomis, kaip ir `workflowIntegrity` bei `vykdymoPlanas`: repo
 * neturi YAML priklausomybės backend'e, o sargas, reikalaujantis naujos
 * priklausomybės, būtų brangesnis už ginamą savybę.
 *
 * ⚠️ KOMENTARAI IR TUŠČIOS EILUTĖS IŠMETAMOS. Jos yra paaiškinimas, ne
 * apibrėžimas: dviem kopijoms reikia skirtingų paaiškinimų (kiekviena sako, ko
 * TEN reikia), o reikalavimas jas suvienodinti verstų paaiškinimus trinti.
 */
function servisuApibrezimai(tekstas) {
  const eilutes = tekstas.split("\n");
  const rezultatas = [];

  let jobas = null;
  let servisuose = false;
  let dabartinis = null;

  const uzdaryti = () => {
    if (dabartinis) rezultatas.push(dabartinis);
    dabartinis = null;
  };

  for (let i = 0; i < eilutes.length; i += 1) {
    const eil = eilutes[i];

    const jobM = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(eil);
    if (jobM) {
      uzdaryti();
      jobas = jobM[1];
      servisuose = false;
      continue;
    }

    if (jobas === null) continue;

    /** Bet kuris kitas job'o lygio raktas užbaigia `services:` bloką. */
    const jobRaktas = /^ {4}[A-Za-z][\w-]*:/.exec(eil);
    if (jobRaktas) {
      uzdaryti();
      servisuose = /^ {4}services:\s*$/.test(eil);
      continue;
    }

    if (!servisuose) continue;
    if (/^\s*#/.test(eil) || eil.trim() === "") continue;

    const servM = /^ {6}([A-Za-z][\w-]*):\s*$/.exec(eil);
    if (servM) {
      uzdaryti();
      dabartinis = { jobas, servisas: servM[1], eilute: i + 1, blokas: [] };
      continue;
    }

    if (dabartinis && /^ {8}/.test(eil)) dabartinis.blokas.push(eil.replace(/\s+$/, ""));
  }

  uzdaryti();
  return rezultatas;
}

/**
 * Vienas pažeidimas vienam SERVISUI, kurio apibrėžimai išsiskyrė.
 *
 * ⚠️ NE VIENAS PAŽEIDIMAS VIENAI SKIRTINGAI EILUTEI. Pakeitus atvaizdą,
 * operatoriui reikia žinoti "servisas `postgres` dviejuose job'uose skiriasi",
 * o ne gauti tiek pranešimų, kiek eilučių nesutapo.
 */
function pazeidimai(tekstas) {
  const pagalVarda = new Map();
  for (const a of servisuApibrezimai(tekstas)) {
    if (!pagalVarda.has(a.servisas)) pagalVarda.set(a.servisas, []);
    pagalVarda.get(a.servisas).push(a);
  }

  const rezultatas = [];
  for (const [servisas, sarasas] of pagalVarda) {
    if (sarasas.length < 2) continue;

    const etalonas = sarasas[0].blokas.join("\n");
    const issiskyre = sarasas.filter((a) => a.blokas.join("\n") !== etalonas);
    if (issiskyre.length === 0) continue;

    rezultatas.push({
      servisas,
      etalonoJobas: sarasas[0].jobas,
      issiskyreJobai: issiskyre.map((a) => `${a.jobas} (eil. ${a.eilute})`),
    });
  }
  return rezultatas;
}

function ciTekstas() {
  return fs.readFileSync(CI_KELIAS, "utf8");
}

/** Pakeičia PASKUTINĮ pasitaikymą - t. y. antrąją (dubliuotą) kopiją. */
function pakeistiPaskutini(tekstas, ka, kuo) {
  const vieta = tekstas.lastIndexOf(ka);
  assert.notEqual(vieta, -1, `mutacijai reikalingas fragmentas nerastas: ${ka}`);
  return tekstas.slice(0, vieta) + kuo + tekstas.slice(vieta + ka.length);
}

test("ci.yml: tas pats servisas VISUR apibrėžtas vienodai", () => {
  const rasta = pazeidimai(ciTekstas());
  assert.deepEqual(
    rasta,
    [],
    `servisų apibrėžimai išsiskyrė:\n${JSON.stringify(rasta, null, 2)}`
  );
});

/**
 * ⚠️ SARGAS, KURIS NIEKO NEGINA, YRA BLOGESNIS UŽ JO NEBUVIMĄ.
 *
 * Jei nė vienas servisas nebūtų apibrėžtas dukart, ankstesnis testas būtų
 * tuščiai žalias - ir liktų toks net tada, kai kas nors antrą apibrėžimą
 * įrašytų su klaida, o parsinimas jo nerastų.
 */
test("SARGAS NĖRA TUŠČIAS: bent vienas servisas apibrėžtas ≥2 job'uose", () => {
  const apibrezimai = servisuApibrezimai(ciTekstas());
  const kiekiai = new Map();
  for (const a of apibrezimai) kiekiai.set(a.servisas, (kiekiai.get(a.servisas) || 0) + 1);

  const dubliuoti = [...kiekiai].filter(([, n]) => n >= 2);
  assert.notEqual(
    dubliuoti.length,
    0,
    `nė vienas servisas nedubliuotas - sargas nieko netikrina. Rasta: ${JSON.stringify([...kiekiai])}`
  );
});

test("kiekvienas rastas apibrėžimas turi `image:` - parsinimas pagavo bloką, ne antraštę", () => {
  const apibrezimai = servisuApibrezimai(ciTekstas());
  assert.ok(apibrezimai.length >= 2, `rasta per mažai apibrėžimų: ${apibrezimai.length}`);

  for (const a of apibrezimai) {
    assert.ok(
      a.blokas.some((e) => /^ {8}image:\s*\S/.test(e)),
      `${a.jobas}.services.${a.servisas} (eil. ${a.eilute}) neturi \`image:\``
    );
  }
});

test("SAVIPATIKRA: pakeistas vienos kopijos ATVAIZDAS → tiksliai 1 pažeidimas", () => {
  const sugadinta = pakeistiPaskutini(
    ciTekstas(),
    "image: postgres:16-alpine",
    "image: postgres:15-alpine"
  );

  const rasta = pazeidimai(sugadinta);
  assert.equal(rasta.length, 1, `laukta 1 pažeidimo, rasta ${rasta.length}`);
  assert.equal(rasta[0].servisas, "postgres");
  assert.equal(rasta[0].issiskyreJobai.length, 1);
  assert.match(rasta[0].issiskyreJobai[0], /^backend-s3 \(eil\. \d+\)$/);
});

/**
 * ⚠️ NE TIK `image:`. Vienodas atvaizdas su skirtingu slaptažodžiu yra tas pats
 * tylus išsiskyrimas: `DATABASE_URL` viename job'e veiktų, kitame - ne.
 */
test("SAVIPATIKRA: pakeistas vienos kopijos `env` → irgi 1 pažeidimas", () => {
  const sugadinta = pakeistiPaskutini(
    ciTekstas(),
    "POSTGRES_PASSWORD: postgres",
    "POSTGRES_PASSWORD: kitas"
  );

  const rasta = pazeidimai(sugadinta);
  assert.equal(rasta.length, 1, `laukta 1 pažeidimo, rasta ${rasta.length}`);
  assert.equal(rasta[0].servisas, "postgres");
});

/**
 * ⚠️ KONTROLĖ PRIEŠ KLAIDINGĄ TEIGIAMĄ. Sargas, krentantis dėl komentaro,
 * verstų arba trinti paaiškinimus, arba jį patį išjungti - abu blogiau už
 * jo nebuvimą.
 */
test("KONTROLĖ: komentaro pridėjimas vienoje kopijoje pažeidimu NELAIKOMAS", () => {
  const sugadinta = pakeistiPaskutini(
    ciTekstas(),
    "      postgres:\n        image: postgres:16-alpine",
    "      postgres:\n        # Tas pats servisas, kita priežastis.\n        image: postgres:16-alpine"
  );

  assert.deepEqual(pazeidimai(sugadinta), []);
});

test("KONTROLĖ: švarus `ci.yml` duoda 0 pažeidimų ir po mutacijų grąžinimo", () => {
  assert.deepEqual(pazeidimai(ciTekstas()), []);
});
