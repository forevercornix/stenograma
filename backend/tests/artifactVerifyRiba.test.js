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
  return createFsArtifactStore({ root: saknis });
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
  ["virš rėmo", REMAS + 1, PRIEZASTIS.METADUOMENYS_VIRSIJA],
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
    PRIEZASTIS.OBJEKTAS_VIRSIJA,
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
    assert.equal(verdiktas.priezastis, PRIEZASTIS.OBJEKTAS_VIRSIJA, "kilmė - saugykla");
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
    PRIEZASTIS.OBJEKTAS_VIRSIJA,
    "⚠️ kilmė - saugykla: ji pranešė ne tą, ką atidavė"
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
