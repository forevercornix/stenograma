const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const { Readable } = require("node:stream");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { createS3ArtifactStore } = require("../utils/artifactStore/s3Store");
const { PRIEZASTIS } = require("../utils/artifactStore/validation");
const { getLimits, LIMIT_KIND } = require("../utils/resultLimits");

/**
 * `verify()` RIBA IMAMA IŠ TIKRINAMOS PUSĖS (#292).
 *
 * ⚠️ ŠAKNIS, KURIĄ ŠIS FAILAS UŽDARO. Persistintas `job_results.bytes` buvo
 * naudojamas IR kaip tikrinamas teiginys, IR kaip resursų biudžeto autoritetas.
 * Antrasis vaidmuo yra klaida: reikšmė ateina iš TOS PAČIOS pusės, kurią
 * `verify()` ir turi patikrinti.
 *
 * Pasekmės buvo dvi, ir abi tylios:
 *   `bytes: -5`    -> skaitymas nutrūksta ties pirmu gabalu, TEISĖTAS objektas
 *                     paskelbiamas neverifikuojamu;
 *   `bytes: 1e18`  -> biudžeto nebelieka, ir patikra tampa savo pačios gedimo
 *                     šaltiniu būtent tame kelyje, kuriam ji skirta.
 *
 * ⚠️ `Math.min(lūkestis, MAX_RESULT_BYTES)` NĖRA sprendimas — tai tylus
 * apkarpymas. Anomalija, nustatoma iš metaduomenų, ATMETAMA.
 *
 * ⚠️ DVI ANOMALIJOS - DU VERDIKTAI. Metaduomenų defektas siunčia operatorių tirti
 * DB eilutę, objekto anomalija — saugyklą. Sulyginus juos, taisymas eitų ne ta
 * kryptimi.
 */

const REMAS = getLimits()[LIMIT_KIND.RESULT_BYTES];

async function fsAplinka(t) {
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-292-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));
  const saugykla = createFsArtifactStore({ root: saknis });
  /** ⚠️ Šaknis grąžinama, kad testas galėtų keisti objektą UŽ saugyklos nugaros. */
  saugykla.saknisTestui = saknis;
  return saugykla;
}

const S3_KONF = {
  bucket: "kibiras",
  region: "us-east-1",
  accessKeyId: "a",
  secretAccessKey: "s",
  endpoint: "http://127.0.0.1:9",
};

/**
 * S3 dublis su LIUDYTOJU: įrašo, ar `GetObject` apskritai buvo pasiektas.
 *
 * ⚠️ BE LIUDYTOJO TESTAS ĮRODYTŲ TIK VERDIKTĄ. „Payload neatidaromas" yra
 * atskiras teiginys nuo „verdiktas teisingas", ir būtent jis yra #292 esmė:
 * sprendimas priimamas PRIEŠ I/O, ne po jo.
 */
function s3Dublis({ contentLength, kunas = "{}", nera = false }) {
  const kvietimai = [];
  const klientas = {
    async send(komanda) {
      const vardas = komanda.constructor.name;
      kvietimai.push(vardas);
      if (vardas === "GetBucketVersioningCommand") return {};
      if (vardas === "HeadObjectCommand") {
        /** ⚠️ Tikro SDK forma dingusiam objektui - `head()` ją verčia į `null`. */
        if (nera) {
          const k = new Error("NotFound");
          k.name = "NotFound";
          k.$metadata = { httpStatusCode: 404 };
          throw k;
        }
        return { ContentLength: contentLength };
      }
      if (vardas === "GetObjectCommand") return { Body: Readable.from([Buffer.from(kunas)]) };
      return {};
    },
  };
  return { klientas, kvietimai, saugykla: createS3ArtifactStore({ ...S3_KONF, klientas }) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. METADUOMENŲ DEFEKTAS — payload NEATIDAROMAS
 * ══════════════════════════════════════════════════════════════════════════ */

const NEVALIDUS_LUKESCIAI = [
  ["neigiamas", -5, PRIEZASTIS.METADUOMENYS_NEVALIDUS],
  ["trupmena", 12.5, PRIEZASTIS.METADUOMENYS_NEVALIDUS],
  ["šiukšlina eilutė", "abc", PRIEZASTIS.METADUOMENYS_NEVALIDUS],
];

test("#292 fs: nevalidus `expected.bytes` → METADUOMENŲ verdiktas, payload neatidaromas", async (t) => {
  const saugykla = await fsAplinka(t);
  const raktas = "results/a.json";
  await saugykla.put(raktas, { text: "mažas" });

  for (const [vardas, bytes, priezastis] of NEVALIDUS_LUKESCIAI) {
    const verdiktas = await saugykla.verify(raktas, { bytes, checksum: "a".repeat(64) });

    assert.equal(verdiktas.ok, false, `${vardas}: negali būti patvirtinta`);
    assert.equal(verdiktas.exists, true, `${vardas}: objektas YRA`);
    assert.equal(verdiktas.priezastis, priezastis, `${vardas}: kilmė - metaduomenys`);
    /** ⚠️ Sumos neskaičiavome, tad jos ir neteigiame - payload neatidarytas. */
    assert.equal(verdiktas.checksum, null, `${vardas}: suma neskaičiuota`);
  }
});

test("#292 s3: nevalidus `expected.bytes` → `GetObject` NEPASIEKIAMAS", async () => {
  for (const [vardas, bytes, priezastis] of NEVALIDUS_LUKESCIAI) {
    const { saugykla, kvietimai } = s3Dublis({ contentLength: 5 });

    const verdiktas = await saugykla.verify("results/a.json", { bytes, checksum: "a".repeat(64) });

    assert.equal(verdiktas.priezastis, priezastis, `${vardas}: kilmė - metaduomenys`);
    assert.equal(verdiktas.ok, false, `${vardas}: negali būti patvirtinta`);

    /**
     * ⚠️ SVARBIAUSIA ASERCIJA. Tinkle sprendimas privalo būti priimtas PRIEŠ
     * užklausą: `GetObject` nesiunčiamas, tad ir kūnas nepradedamas vartoti.
     */
    assert.equal(
      kvietimai.includes("GetObjectCommand"),
      false,
      `${vardas}: \`GetObject\` NEGALI būti siunčiamas: ${kvietimai.join(", ")}`
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. OBJEKTO ANOMALIJA — kita kilmė, kitas verdiktas
 * ══════════════════════════════════════════════════════════════════════════ */

test("#292 s3: `head().bytes` virš rėmo → OBJEKTO verdiktas, ne metaduomenų", async () => {
  const { saugykla, kvietimai } = s3Dublis({ contentLength: REMAS + 1 });

  const verdiktas = await saugykla.verify("results/a.json", { bytes: 1024, checksum: "a".repeat(64) });

  assert.equal(verdiktas.ok, false);
  assert.equal(verdiktas.exists, true, "objektas realiai YRA");
  assert.equal(
    verdiktas.priezastis,
    PRIEZASTIS.VIRSIJA_RIBA,
    "⚠️ kilmė - SAUGYKLA: operatorius turi tirti objektą, ne DB eilutę"
  );
  assert.equal(kvietimai.includes("GetObjectCommand"), false, "per didelis objektas neatidaromas");
});

test("#292 fs: objektas virš rėmo → OBJEKTO verdiktas", async (t) => {
  const saugykla = await fsAplinka(t);
  const raktas = "results/didelis.json";
  await saugykla.put(raktas, { text: "mažas" });

  /**
   * ⚠️ RĖMAS LAIKINAI SUMAŽINAMAS, ne objektas padidinamas iki 20 MB.
   * Tikrinamas SANTYKIS „objektas > rėmas", o 20 MB failo rašymas testą
   * paverstų disko matavimu.
   */
  const senas = process.env.MAX_RESULT_BYTES;
  process.env.MAX_RESULT_BYTES = "8";
  try {
    const verdiktas = await saugykla.verify(raktas, { bytes: 4, checksum: "a".repeat(64) });

    assert.equal(verdiktas.ok, false);
    assert.equal(verdiktas.exists, true);
    assert.equal(verdiktas.priezastis, PRIEZASTIS.VIRSIJA_RIBA, "kilmė - saugykla");
  } finally {
    if (senas === undefined) delete process.env.MAX_RESULT_BYTES;
    else process.env.MAX_RESULT_BYTES = senas;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. KONTROLĖ — be jos viskas praeitų ir su `verify()`, kuris atmeta VISKĄ
 * ══════════════════════════════════════════════════════════════════════════ */

test("#292 KONTROLĖ: teisėtas objektas ir teisėtas lūkestis PRAEINA (fs ir s3)", async (t) => {
  /**
   * ⚠️ ŠI KONTROLĖ YRA PRIVALOMA, NE PAPILDOMA.
   *
   * Trys aukštesni testai suderinami ir su `verify()`, kuris grąžina `ok:false`
   * VISADA. Tokia realizacija juos praeitų, o produkcija nustotų patvirtinti bet
   * ką. Ta klasė šioje sekoje pasirodė keturis kartus.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/geras.json";
  const kvitas = await saugykla.put(raktas, { text: "reprezentatyvus turinys" });

  const fsVerdiktas = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: kvitas.checksum });

  assert.equal(fsVerdiktas.ok, true, "⚠️ fs: teisėtas objektas PRIVALO būti patvirtintas");
  assert.equal(fsVerdiktas.priezastis, undefined, "sėkmė priežasties neturi");
  assert.equal(fsVerdiktas.bytes, kvitas.bytes);
  assert.equal(fsVerdiktas.checksum, kvitas.checksum);

  /** S3 pusė: tas pats turinys, tas pats lūkestis, tikras `GetObject`. */
  const kunas = JSON.stringify({ text: "s3 turinys" });
  const suma = crypto.createHash("sha256").update(Buffer.from(kunas)).digest("hex");
  const { saugykla: s3, kvietimai } = s3Dublis({ contentLength: Buffer.byteLength(kunas), kunas });

  const s3Verdiktas = await s3.verify("results/geras.json", { bytes: Buffer.byteLength(kunas), checksum: suma });

  assert.equal(s3Verdiktas.ok, true, "⚠️ s3: teisėtas objektas PRIVALO būti patvirtintas");
  assert.equal(s3Verdiktas.nepriklausomas, true);
  assert.ok(kvietimai.includes("GetObjectCommand"), "teisėtu atveju kūnas SKAITOMAS");
});

test("#292 KONTROLĖ: lūkesčio NĖRA - tai ne defektas, biudžetu tampa rėmas", async (t) => {
  /**
   * ⚠️ „Lauko nėra" ir „laukas šiukšlinas" NĖRA tas pats. Pirmas yra teisėta
   * būsena (inline eilutės, seni įrašai), antras - DB defektas. Sulyginus juos,
   * teisėtas kelias imtų grąžinti metaduomenų defekto verdiktą.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/be-lukescio.json";
  const kvitas = await saugykla.put(raktas, { text: "turinys" });

  const verdiktas = await saugykla.verify(raktas, {});

  assert.equal(verdiktas.priezastis, undefined, "nenurodytas lūkestis NĖRA defektas");
  assert.equal(verdiktas.exists, true);
  assert.equal(verdiktas.bytes, kvitas.bytes, "dydis išmatuotas ir grąžintas");
});

test("#292 BIUDŽETAS: saugykla praneša vieną dydį, atiduoda DIDESNĮ → skaitymas nutrūksta", async () => {
  /**
   * ⚠️ VIENINTELIS ATVEJIS, KUR BIUDŽETO ŠALTINIS YRA STEBIMAS.
   *
   * Metaduomenų vartai ir dydžių palyginimas pašalina visus kitus: kai lūkestis
   * validus ir sutampa su `head()`, abu biudžetai (senas ir naujas) yra TA PATI
   * reikšmė. Skirtumas lieka tik tada, kai objektas skaitymo metu pasirodo
   * DIDESNIS, nei ką tik pranešė saugykla.
   *
   * Tai ne teorinis atvejis: būtent taip atrodo objektas, pakeistas tarp `head()`
   * ir `GetObject`, arba saugykla, meluojanti apie `ContentLength`.
   *
   * ⚠️ BE ŠIO TESTO mutacija „biudžetas atgal į persistintą lūkestį" PRAEITŲ, ir
   * #292 pagrindinis pakeitimas liktų neapsaugotas. Išmatuota: taip ir buvo.
   */
  const paskelbtas = 16;
  const tikrasis = Buffer.alloc(4096, 0x61).toString("latin1");

  const { saugykla, kvietimai } = s3Dublis({ contentLength: paskelbtas, kunas: tikrasis });

  /**
   * ⚠️ LŪKESTIS NEPERDUODAMAS SĄMONINGAI, IR TAI VISO TESTO ESMĖ.
   *
   * Su lūkesčiu `bytes: 16` senas ir naujas biudžetas būtų TA PATI reikšmė (16),
   * ir mutacija praeitų — išmatuota. Be lūkesčio jie išsiskiria:
   *
   *   senas:  `MAX_RESULT_BYTES` (20 MB) -> 4096 baitai perskaitomi VISI;
   *   naujas: `head().bytes` (16)        -> skaitymas nutrūksta.
   */
  const verdiktas = await saugykla.verify("results/melagis.json", {});

  assert.ok(kvietimai.includes("GetObjectCommand"), "prielaida: kūnas buvo pradėtas skaityti");
  assert.equal(verdiktas.ok, false, "melagingas dydis negali būti patvirtintas");
  assert.equal(verdiktas.exists, true, "objektas YRA");
  assert.equal(
    verdiktas.priezastis,
    PRIEZASTIS.SAUGYKLA_NEATITINKA,
    "⚠️ kilmė - SAUGYKLA: ji pranešė ne tą, ką atidavė; riba čia nebuvo peržengta"
  );
  assert.equal(verdiktas.checksum, null, "nutraukto skaitymo sumos neteigiame");
});

/* ══════════════════════════════════════════════════════════════════════════
 * CODEX RAUNDAS: A (`bytes = 0`) ir B (`s3` fabrikuoja `exists`)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#292 A: `bytes = 0` yra METADUOMENŲ defektas — taip sako DB `CHECK`", async (t) => {
  /**
   * ⚠️ RIBA NE MŪSŲ SUGALVOTA. `job_results_integrity_shape` (migracija
   * `1756100000000`) reikalauja `bytes > 0`: kanoninė JSON eilutė niekada nėra 0
   * baitų, mažiausia įmanoma yra `{}` — du baitai.
   *
   * ⚠️ KAS BŪTŲ BE ŠIOS PATIKROS. Eilutė su `bytes = 0`, TUŠČIO payload SHA-256 ir
   * nupjautas tuščias objektas saugykloje duotų `ok: true` — atkūrimo
   * verifikacija PATVIRTINTŲ neįmanomą būseną.
   *
   * ⚠️ Tai ta pati klasė, kurią #292 uždaro, tik naujajame validatoriuje: antras
   * skaitinis domenas atsirado netyčia, nes validatorius su `CHECK` nesutapo.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/nulis.json";
  await saugykla.put(raktas, { text: "turinys" });

  const tusciasSha = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const verdiktas = await saugykla.verify(raktas, { bytes: 0, checksum: tusciasSha });

  assert.equal(verdiktas.ok, false, "⚠️ neįmanoma būsena NEGALI būti patvirtinta");
  assert.equal(
    verdiktas.priezastis,
    PRIEZASTIS.METADUOMENYS_NEVALIDUS,
    "kilmė - DB eilutė, ne saugykla"
  );
});

test("#292 A: `checksum` ne pagal `CHECK` formatą irgi yra METADUOMENŲ defektas", async (t) => {
  /**
   * ⚠️ ANTRA `CHECK` PUSĖ, RASTA TIKRINANT PIRMĄ.
   *
   * `CHECK` garantuoja `^[0-9a-f]{64}$`. Neatitinkanti suma eilutėje yra NEĮMANOMA
   * būsena, tad tai metaduomenų defektas — o ne „turinys nesutampa". Be šios
   * patikros operatorius būtų siunčiamas tirti SAUGYKLĄ, kai sugedusi yra DB
   * eilutė: tiksliai ta painiava, kurią #292 ir skiria.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/bloga-suma.json";
  const kvitas = await saugykla.put(raktas, { text: "turinys" });

  for (const [vardas, checksum] of [
    ["per trumpa", "a".repeat(63)],
    ["ne hex", "z".repeat(64)],
    ["tuščia", ""],
  ]) {
    const verdiktas = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum });

    assert.equal(
      verdiktas.priezastis,
      PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      `${vardas}: privalo būti metaduomenų defektas`
    );
  }
});

test("#292 B: nevalidus lūkestis PLIUS dingęs objektas → `NERASTA` ABIEJUOSE backend'uose", async (t) => {
  /**
   * ⚠️ DoD REIKALAVIMAS: „`fsStore` ir `s3Store` VIENODA SEMANTIKA".
   *
   * `s3` pusėje metaduomenų vartai buvo PIRMI, tad ankstyvas grįžimas praleisdavo
   * `HeadObject` ir grąžindavo `exists: true` DINGUSIAM objektui. `fs` pusėje
   * `head()` eina pirmas ir atsako teisingai.
   *
   * Ta pati persistinta būsena gaudavo skirtingus verdiktus pagal backend'ą, ir
   * operatoriaus išvada skyrėsi: tirti NESUTAPIMĄ vs tirti DINGUSĮ objektą.
   *
   * ⚠️ TREČIAS KARTAS ŠIOJE SEKOJE, kai `fs`/`s3` asimetrija duoda defektą.
   */
  const fs = await fsAplinka(t);
  const fsVerdiktas = await fs.verify("results/nera.json", { bytes: -5, checksum: "zzz" });

  assert.equal(fsVerdiktas.exists, false, "fs: dingusio objekto `exists` privalo būti `false`");

  const { saugykla: s3, kvietimai } = s3Dublis({ contentLength: null, nera: true });
  const s3Verdiktas = await s3.verify("results/nera.json", { bytes: -5, checksum: "zzz" });

  assert.equal(
    s3Verdiktas.exists,
    false,
    "⚠️ s3: `exists` privalo ATSPINDĖTI TIKROVĘ, o ne būti fabrikuotas iš ankstyvo grįžimo"
  );
  assert.deepEqual(
    { fs: fsVerdiktas.exists, s3: s3Verdiktas.exists },
    { fs: false, s3: false },
    "abu backend'ai - viena semantika"
  );

  /** ⚠️ ANTRAS TEIGINYS, TVIRTINAMAS ATSKIRAI: payload vis tiek neatidaromas. */
  assert.equal(
    kvietimai.includes("GetObjectCommand"),
    false,
    `payload NEGALI būti atidarytas: ${kvietimai.join(", ")}`
  );
});

test("#292 B1: `GetObject` nesiunčiamas IR `exists` atspindi tikrovę — du atskiri teiginiai", async () => {
  /**
   * ⚠️ KODĖL DU ASSERT'AI, O NE VIENAS.
   *
   * Ankstesnis testas tikrino TIK „`GetObject` nesiunčiamas", ir jis PRAĖJO, kol
   * `exists: true` buvo fabrikuojamas. Sargas, tikrinantis vieną savybę, gretimos
   * nemato — o defektas gyveno būtent gretimoje.
   */
  const { saugykla, kvietimai } = s3Dublis({ contentLength: 512 });
  const verdiktas = await saugykla.verify("results/yra.json", { bytes: -5, checksum: "a".repeat(64) });

  assert.equal(kvietimai.includes("GetObjectCommand"), false, "payload neatidaromas");
  assert.equal(verdiktas.exists, true, "objektas REALIAI yra - `exists` privalo tai rodyti");
  assert.equal(verdiktas.priezastis, PRIEZASTIS.METADUOMENYS_NEVALIDUS, "kilmė - metaduomenys");
  assert.ok(kvietimai.includes("HeadObjectCommand"), "tikrovė sužinoma per `head()`, ne spėjama");
});

test("#292 A: `bytes` virš ribos yra POLITIKOS, ne metaduomenų klausimas", async (t) => {
  /**
   * ⚠️ ŠIS ATVEJIS TAISO PRIELAIDĄ PAČIAME #292 BODY.
   *
   * Body teigė, kad teisėtas `bytes` niekada negali viršyti `MAX_RESULT_BYTES`,
   * nes `put()` didesnio nepriima — vadinasi peržengimas esąs anomalija „pagal
   * apibrėžimą". Tai galioja TIK jei riba niekada nemažėja.
   *
   * Sumažinus `MAX_RESULT_BYTES`, anksčiau TEISĖTAI įrašyti artefaktai turi
   * `bytes`, viršijantį dabartinę ribą, nors EILUTĖ IR OBJEKTAS SVEIKI. DB `CHECK`
   * maksimumo NETURI: riba yra diegimo politika, ne duomenų kontraktas.
   *
   * ⚠️ Pasakius „metaduomenų defektas", operatorius taisytų DB, kai reikia keisti
   * KONFIGŪRACIJĄ — tiksliai tas klaidingas nukreipimas, kuriam išvengti verdiktai
   * ir buvo atskirti.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/senas-didelis.json";
  const kvitas = await saugykla.put(raktas, { text: "visiškai sveikas turinys" });

  /** Riba sumažinama PO teisėto įrašymo — būtent tai ir įvyksta produkcijoje. */
  const senas = process.env.MAX_RESULT_BYTES;
  process.env.MAX_RESULT_BYTES = String(Math.max(1, kvitas.bytes - 1));
  try {
    const verdiktas = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: kvitas.checksum });

    assert.equal(
      verdiktas.priezastis,
      PRIEZASTIS.VIRSIJA_RIBA,
      "⚠️ sveika eilutė po ribos sumažinimo NĖRA metaduomenų defektas"
    );
    assert.notEqual(
      verdiktas.priezastis,
      PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      "operatorius neturi būti siunčiamas taisyti DB"
    );
    assert.equal(verdiktas.exists, true, "objektas YRA ir yra sveikas");
  } finally {
    if (senas === undefined) delete process.env.MAX_RESULT_BYTES;
    else process.env.MAX_RESULT_BYTES = senas;
  }
});

test("#292 B: `checksum` validuojamas ŽALIAS — kanonizavimas nėra validumo šaltinis", async (t) => {
  /**
   * ⚠️ ORDERING YDA MANO PACIOS ANKSTESNIAME TAISYME.
   *
   * Patikra buvo pridėta, bet ji žiūrėjo į `normalizuotiLaukima()` išvestį — t. y.
   * tikrino tai, ką pati ir sutvarkė. `trim().toLowerCase()` paverčia `"  AAA…  "`
   * teisinga atrodančia reikšme, tad DIDŽIOSIOMIS ar su tarpais persistinta suma
   * praeidavo, o SUTAPUS OBJEKTUI duodavo `ok: true`.
   *
   * ⚠️ Objektas čia SVEIKAS ir suma TEISINGA — skiriasi tik forma. Būtent todėl
   * testas įtikinamas: be žalios validacijos jis duotų `ok: true`.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/forma.json";
  const kvitas = await saugykla.put(raktas, { text: "turinys" });

  for (const [vardas, suma] of [
    ["didžiosiomis", kvitas.checksum.toUpperCase()],
    ["su tarpais", `  ${kvitas.checksum}  `],
    ["mišriu registru", kvitas.checksum.slice(0, 10).toUpperCase() + kvitas.checksum.slice(10)],
  ]) {
    const verdiktas = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: suma });

    assert.equal(
      verdiktas.priezastis,
      PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      `${vardas}: DB \`CHECK\` tokios formos neįleistų, tad eilutė sugadinta`
    );
    assert.equal(verdiktas.ok, false, `${vardas}: negali būti patvirtinta`);
  }

  /** ⚠️ KONTROLĖ: kanoninė forma toliau praeina — patikra neatmeta teisėtų. */
  const geras = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: kvitas.checksum });
  assert.equal(geras.ok, true, "teisėta kanoninė suma PRIVALO praeiti");
});

/* ══════════════════════════════════════════════════════════════════════════
 * TREČIAS CODEX RAUNDAS: B (pirmenybė) ir C (saugyklos anomalija)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#292 B: metaduomenų defektas NUSVERIA politiką — visi 6 deriniai apibrėžti", async (t) => {
  /**
   * ⚠️ ŠAKNIS, KURIĄ ŠIS TESTAS UŽDARO: pirmenybę nustatydavo `return` SEKA.
   *
   * `bytes` virš ribos PLIUS sugadintas `checksum` siųsdavo operatorių į
   * konfigūraciją, nors eilutė pažeidžia ir kontraktą. Pakeitus
   * `MAX_RESULT_BYTES`, politikos radinys dingtų, o sugadinta eilutė liktų — ir
   * liktų NEPRANEŠTA.
   *
   * ⚠️ TIKRINAMI VISI DERINIAI, ne tik tas, kurį kas nors pastebėjo: trys `bytes`
   * būsenos × dvi `checksum` būsenos. Būtent daliniai patikrinimai ir davė tris
   * raundus iš eilės dėl tos pačios tvarkos.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/deriniai.json";
  const kvitas = await saugykla.put(raktas, { text: "turinys" });

  const senas = process.env.MAX_RESULT_BYTES;
  process.env.MAX_RESULT_BYTES = String(Math.max(1, kvitas.bytes - 1));
  try {
    const BYTES = {
      ok: kvitas.bytes,
      nevalidus: 0,
      virsija: Number(process.env.MAX_RESULT_BYTES) + 1,
    };
    const SUMOS = { ok: kvitas.checksum, nevalidus: "ZZZ" };

    const LAUKIAMA = {
      "ok/ok": PRIEZASTIS.VIRSIJA_RIBA,
      "ok/nevalidus": PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      "nevalidus/ok": PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      "nevalidus/nevalidus": PRIEZASTIS.METADUOMENYS_NEVALIDUS,
      "virsija/ok": PRIEZASTIS.VIRSIJA_RIBA,
      "virsija/nevalidus": PRIEZASTIS.METADUOMENYS_NEVALIDUS,
    };

    let tikrinta = 0;
    for (const [bn, bv] of Object.entries(BYTES)) {
      for (const [cn, cv] of Object.entries(SUMOS)) {
        const verdiktas = await saugykla.verify(raktas, { bytes: bv, checksum: cv });
        assert.equal(verdiktas.priezastis, LAUKIAMA[`${bn}/${cn}`], `derinys ${bn}/${cn}`);
        tikrinta += 1;
      }
    }

    assert.equal(tikrinta, 6, "visi deriniai privalo būti patikrinti, ne pasirinkti");
  } finally {
    if (senas === undefined) delete process.env.MAX_RESULT_BYTES;
    else process.env.MAX_RESULT_BYTES = senas;
  }
});

test("#292 C: srautas viršija `head()`, bet TELPA į ribą → SAUGYKLOS anomalija", async (t) => {
  /**
   * ⚠️ KLASĖ, KURIOS NIEKADA NEBUVO, IR KURI PASIMATĖ TIK ATSIRADUS GRETIMAI.
   *
   * Objektas, paaugęs tarp `head()` ir skaitymo, bet likęs ŽEMIAU
   * `MAX_RESULT_BYTES`, gaudavo `VIRSIJA_RIBA` — operatorius keisdavo
   * konfigūraciją, nors riba NEBUVO peržengta.
   *
   * Radinys atsirado panaudojus naują verdiktą NE PAGAL PASKIRTĮ.
   */
  const { saugykla, kvietimai } = s3Dublis({
    contentLength: 16,
    kunas: Buffer.alloc(4096, 0x61).toString("latin1"),
  });

  const verdiktas = await saugykla.verify("results/paaugo.json", {});

  assert.ok(kvietimai.includes("GetObjectCommand"), "prielaida: kūnas pradėtas skaityti");
  assert.equal(
    verdiktas.priezastis,
    PRIEZASTIS.SAUGYKLA_NEATITINKA,
    "⚠️ 4 KiB telpa į 20 MB ribą — tai NE politikos klausimas"
  );
  assert.notEqual(verdiktas.priezastis, PRIEZASTIS.VIRSIJA_RIBA, "operatorius neturi keisti konfigūracijos");
});

test("#292 C: ta pati semantika `fs` pusėje (paritetas)", async (t) => {
  /**
   * ⚠️ `fs` TURĖJO TĄ PAČIĄ YDĄ. Paritetas tikrinamas eksplicitiškai, nes trečias
   * kartas šioje sekoje rodo, kad backend'ų asimetrija savaime nepasimato.
   */
  const saugykla = await fsAplinka(t);
  const raktas = "results/fs-paaugo.json";
  const kvitas = await saugykla.put(raktas, { text: "pradinis" });

  /** ⚠️ KONTROLĖ PIRMA: nepakitęs objektas privalo praeiti. */
  const kontrole = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: kvitas.checksum });
  assert.equal(kontrole.ok, true, "kontrolė: nepakitęs objektas praeina");

  /**
   * Objektas padidinamas UŽ saugyklos nugaros — 4 KiB gerokai žemiau 20 MB ribos.
   * `head()` praneš naują dydį, tad lūkestis NEPERDUODAMAS: kitaip suveiktų
   * dydžių palyginimas, ir skaitymas net neprasidėtų.
   */
  await fsp.writeFile(path.join(saugykla.saknisTestui, raktas), Buffer.alloc(4096, 0x61));

  /** ⚠️ Riba sumažinama iki 2 KiB, kad 4 KiB objektas ją viršytų ir be `head()`. */
  const senas = process.env.MAX_RESULT_BYTES;
  process.env.MAX_RESULT_BYTES = "2048";
  try {
    const verdiktas = await saugykla.verify(raktas, {});

    assert.equal(
      verdiktas.priezastis,
      PRIEZASTIS.VIRSIJA_RIBA,
      "objektas virš RIBOS - politikos klausimas, ir `fs` tai sako taip pat kaip `s3`"
    );
    assert.equal(verdiktas.exists, true);
  } finally {
    if (senas === undefined) delete process.env.MAX_RESULT_BYTES;
    else process.env.MAX_RESULT_BYTES = senas;
  }
});

test("#292 A: priežastys pasiekia OPERATORIAUS SANTRAUKĄ, ne tik objektą", () => {
  /**
   * ⚠️ §8b MATAVO NE TĄ RIBĄ.
   *
   * Jis klausė, ar `detale` IŠLIEKA objekte, ir atsakė „taip". Klausimas, kuris
   * svarbus: ar operatorius ją MATO. Runbook'o §9d spausdina TIK
   * `ataskaita.santrauka`, o joje priežasčių nebuvo — tad nė vienas produkcinis
   * kelias `detale` neskaitė.
   *
   * ⚠️ TESTAS EINA PER TĄ PATĮ LAUKĄ, KURĮ SPAUSDINA RUNBOOK'AS. Tikrinant
   * `ataskaita.nesekmes[].detale`, ši yda liktų nepastebėta — tai ką tik ir įvyko.
   */
  const { sudarytiAtaskaita } = require("../utils/artifactRestoreVerify");

  const ataskaita = sudarytiAtaskaita([
    { jobId: "a", verdiktas: "nesutampa", detale: PRIEZASTIS.METADUOMENYS_NEVALIDUS },
    { jobId: "b", verdiktas: "nesutampa", detale: PRIEZASTIS.VIRSIJA_RIBA },
    { jobId: "c", verdiktas: "nesutampa", detale: PRIEZASTIS.SAUGYKLA_NEATITINKA },
    { jobId: "d", verdiktas: "patikrinta" },
  ]);

  for (const priezastis of Object.values(PRIEZASTIS)) {
    assert.match(
      ataskaita.santrauka,
      new RegExp(priezastis),
      `⚠️ \`${priezastis}\` privalo būti SANTRAUKOJE - ją operatorius ir spausdina`
    );
  }

  /** Trys skirtingos operatoriaus išvados privalo būti atskiriamos. */
  assert.equal(Object.keys(ataskaita.pagalPriezasti).length, 3, "trys priežastys - trys eilutės");
});
