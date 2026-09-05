const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createS3ArtifactStore, patikrintiVersijavima } = require("../utils/artifactStore/s3Store");

/**
 * S3 KAIP FAIL-CLOSED SAUGYKLOS RIBA (#157, PR-2, Codex #290).
 *
 * ⚠️ KODĖL ŠIE TESTAI NEGALI GYVENTI MinIO RINKINYJE.
 *
 * Tikra saugykla pagal užsakymą negamina protokolo gedimų: atsakymo be
 * `ContentLength`, sėkmės be kūno ar nežinomos versijavimo būsenos. Būtent jie yra
 * fail-closed elgesio esmė, tad klientas įterpiamas per užrašytą seamą, o
 * kviečiami TIE PATYS metodai, kuriuos kviečia produkcija.
 *
 * ⚠️ SEAMAS NEPAKEIČIA MinIO RINKINIO. Ten tikrinamas tikras protokolas su tikra
 * saugykla; čia — elgesys, kai saugykla atsako netaisyklingai.
 */

const KONFIGURACIJA = {
  bucket: "kibiras",
  region: "us-east-1",
  accessKeyId: "a",
  secretAccessKey: "s",
  endpoint: "http://127.0.0.1:9",
};

/**
 * Klientas, atsakantis pagal komandos vardą.
 *
 * ⚠️ DUBLIS GRĄŽINA TIKRO SDK FORMAS (#266 trečia dalis): `GetBucketVersioning` —
 * objektą, `HeadObject` — `ContentLength`, `GetObject` — `Body` srautą.
 */
function klientasSu(atsakymai) {
  return {
    kvietimai: [],
    async send(komanda) {
      const vardas = komanda.constructor.name;
      this.kvietimai.push(vardas);

      const atsakymas = atsakymai[vardas];
      if (typeof atsakymas === "function") return atsakymas(komanda);
      if (atsakymas instanceof Error) throw atsakymas;
      return atsakymas === undefined ? {} : atsakymas;
    },
  };
}

const NEVERSIJUOTAS = { GetBucketVersioningCommand: {} };

/* ═══ VERSIJAVIMAS ═══ */

test("nežinoma versijavimo būsena FAILINA UŽDARAI", async () => {
  /**
   * ⚠️ ANKSTESNĖ REDAKCIJA ATMESDAVO TIK `Enabled` IR `Suspended`.
   *
   * Trūkstamas atsakymas, `null` ar būsimas `Status` praeidavo kaip „neversijuota" —
   * fail-open būtent ten, kur sprendžiama, ar ištrynimas gali būti PATVIRTINTAS.
   */
  /**
   * ⚠️ PRIIMAMA TIKSLIAI VIENA FORMA: `Status === undefined`.
   *
   * `null` ir `""` atrodo „beveik kaip nieko", bet nė vienas iš jų nėra
   * dokumentuota neversijuoto kibiro forma — jie reiškia, kad būsena LIKO
   * NENUSTATYTA. Įsiminus juos kaip „Disabled", vėlesni `delete()` patvirtinimai
   * remtųsi garantija, kurios niekas nepatikrino.
   */
  const nesaugios = [
    ["Enabled", { Status: "Enabled" }],
    ["Suspended", { Status: "Suspended" }],
    ["nežinoma būsena", { Status: "Unknown" }],
    ["būsimas praplėtimas", { Status: "EnabledWithLock" }],
    ["null būsena", { Status: null }],
    ["tuščia eilutė", { Status: "" }],
    ["skaičius", { Status: 0 }],
    ["tuščias atsakymas", null],
    ["ne objektas", "Disabled"],
  ];

  for (const [vardas, atsakymas] of nesaugios) {
    await assert.rejects(
      () => patikrintiVersijavima(klientasSu({ GetBucketVersioningCommand: atsakymas }), "kibiras"),
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
      `${vardas}: privalo neleisti starto`
    );
  }
});

test("KONTROLĖ: dokumentuota neversijuoto kibiro forma PRAEINA", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas patikros, kuri atmeta VISKĄ — tada
   * „fail-closed" reikštų neveikiančią saugyklą, ne garantiją.
   */
  for (const atsakymas of [{}, { Status: undefined }, { MFADelete: "Disabled" }]) {
    const verdiktas = await patikrintiVersijavima(
      klientasSu({ GetBucketVersioningCommand: atsakymas }),
      "kibiras"
    );
    assert.equal(verdiktas.versijavimas, "Disabled");
  }
});

test("NĖ VIENA operacija nevyksta, kol politika nepatikrinta", async () => {
  /**
   * ⚠️ PATIKRA, KURIOS NIEKAS NEKVIEČIA, YRA DOKUMENTACIJA, NE SARGAS.
   *
   * Anksčiau `patikrintiSaugykla()` egzistavo tik kaip eksportuotas metodas.
   * Dabar jos laukia kiekviena operacija, tad versijuotame kibire nė vienas kelias
   * — įskaitant `delete()` — negali pranešti sėkmės.
   */
  const klientas = klientasSu({ GetBucketVersioningCommand: { Status: "Enabled" } });
  const saugykla = createS3ArtifactStore({ ...KONFIGURACIJA, klientas });

  const operacijos = [
    ["put", () => saugykla.put("results/a.json", { a: 1 })],
    ["head", () => saugykla.head("results/a.json")],
    ["read", () => saugykla.read("results/a.json")],
    ["readStream", () => saugykla.readStream("results/a.json")],
    ["verify", () => saugykla.verify("results/a.json", { bytes: 1, checksum: "a".repeat(64) })],
    ["delete", () => saugykla.delete("results/a.json")],
  ];

  for (const [vardas, veiksmas] of operacijos) {
    await assert.rejects(
      veiksmas,
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
      `${vardas}: versijuotame kibire privalo kristi`
    );
  }

  assert.ok(
    !klientas.kvietimai.some((k) => k !== "GetBucketVersioningCommand"),
    `nė viena objekto komanda neturi pasiekti saugyklos: ${klientas.kvietimai.join(", ")}`
  );
});

/* ═══ ATSAKYMŲ VALIDACIJA ═══ */

test("`HeadObject` be tinkamo `ContentLength` yra PROTOKOLO klaida", async () => {
  /**
   * ⚠️ `Number(undefined)` = `NaN`, o `head()` vis tiek skelbdavo `exists: true` —
   * kvietėjas gaudavo metaduomenis už dokumentuoto `{ exists, bytes }` kontrakto
   * ribų. Būtent jais remiasi orphan patikra ir hidratacijos dydžio riba.
   */
  /**
   * ⚠️ VALIDUOJAMA ŽALIA REIKŠMĖ, NE KONVERSIJOS REZULTATAS.
   *
   * `Number(null)`, `Number("")` ir `Number(false)` visi duoda `0` — teisėtą
   * sveikąjį skaičių. Tikrinant PO konversijos, netaisyklingas atsakymas virsdavo
   * `{ exists: true, bytes: 0 }`, ir orphan patikra remtųsi dydžiu, kurio saugykla
   * niekada nepranešė. SDK kontraktas yra `number | undefined`.
   */
  const blogi = [
    {},
    { ContentLength: null },
    { ContentLength: "" },
    { ContentLength: false },
    { ContentLength: true },
    { ContentLength: "12" },
    { ContentLength: "labas" },
    { ContentLength: NaN },
    { ContentLength: Infinity },
    { ContentLength: -1 },
    { ContentLength: 1.5 },
    { ContentLength: {} },
    { ContentLength: [] },
  ];

  for (const blogas of blogi) {
    const saugykla = createS3ArtifactStore({
      ...KONFIGURACIJA,
      klientas: klientasSu({ ...NEVERSIJUOTAS, HeadObjectCommand: blogas }),
    });

    await assert.rejects(
      () => saugykla.head("results/a.json"),
      (klaida) => klaida.code === "ARTIFACT_STORAGE_PROTOCOL",
      `${JSON.stringify(blogas)}: privalo būti protokolo klaida, ne dingęs objektas`
    );
  }
});

test("KONTROLĖ: tvarkingas `ContentLength` grąžina dokumentuotą formą", async () => {
  /** Ir nulinis dydis yra teisėtas — svarbu, kad jis ATEINA kaip skaičius. */
  for (const dydis of [0, 1, 12, 20 * 1024 * 1024]) {
    const saugykla = createS3ArtifactStore({
      ...KONFIGURACIJA,
      klientas: klientasSu({ ...NEVERSIJUOTAS, HeadObjectCommand: { ContentLength: dydis } }),
    });

    assert.deepEqual(await saugykla.head("results/a.json"), { exists: true, bytes: dydis });
  }
});

test("sėkmingas `GetObject` be kūno yra PROTOKOLO klaida", async () => {
  /**
   * ⚠️ Grąžinus jį neapžiūrėtą, `read()` ir `verify()` lūžtų vėliau su žaliu
   * `TypeError` iš `for await` — kvietėjas matytų programavimo klaidą ten, kur
   * sugedo saugyklos protokolas.
   */
  /**
   * ⚠️ TIKRINAMA TA GALIMYBĖ, KURIĄ REALIAI NAUDOJA VARTOTOJAI.
   *
   * `read()` ir `verify()` kūną vartoja per `for await`, tad `pipe()` buvimas
   * nieko negarantuoja: `{ Body: { pipe() {} } }` praeidavo patikrą ir lūždavo
   * žaliu `TypeError` — tiksliai tuo, ko patikra turėjo neleisti. Sinchroniškai
   * iteruojama eilutė taip pat netinka: `for await` jos nepriims kaip srauto.
   */
  const blogi = [
    {},
    { Body: null },
    { Body: 42 },
    { Body: "eilutė" },
    { Body: { pipe: "ne funkcija" } },
    { Body: { pipe() {} } },
    { Body: [1, 2, 3] },
  ];

  for (const blogas of blogi) {
    const saugykla = createS3ArtifactStore({
      ...KONFIGURACIJA,
      klientas: klientasSu({ ...NEVERSIJUOTAS, GetObjectCommand: blogas }),
    });

    for (const [vardas, veiksmas] of [
      ["readStream", () => saugykla.readStream("results/a.json")],
      ["read", () => saugykla.read("results/a.json")],
    ]) {
      await assert.rejects(
        veiksmas,
        (klaida) => klaida.code === "ARTIFACT_STORAGE_PROTOCOL",
        `${vardas} ${JSON.stringify(blogas)}: privalo įvardyti protokolo gedimą`
      );
    }
  }
});

/* ═══ VIENTISUMO PATIKRA BE VISO OBJEKTO BUFERINIMO ═══ */

test("`verify()` nutraukia skaitymą peržengus patikimą dydį", async (t) => {
  /**
   * ⚠️ OBJEKTAS, PAKEISTAS Į DAUG DIDESNĮ, IŠSEMTŲ ATKŪRIMO PROCESĄ BŪTENT TAME
   * KELYJE, KURIS SUGADINIMĄ IR TURI APTIKTI.
   *
   * Tikrinama, kad (1) verdiktas yra fail-closed `ok: false`, (2) srautas
   * NEPERSKAITOMAS iki galo — t. y. atmintis nebuvo išnaudota.
   */
  const gabalas = Buffer.alloc(64 * 1024, 0x61);
  let atiduota = 0;

  const srautas = new Readable({
    read() {
      atiduota += 1;
      this.push(atiduota > 2000 ? null : gabalas);
    },
  });

  const saugykla = createS3ArtifactStore({
    ...KONFIGURACIJA,
    klientas: klientasSu({ ...NEVERSIJUOTAS, GetObjectCommand: { Body: srautas } }),
  });

  const verdiktas = await saugykla.verify("results/a.json", {
    bytes: 128 * 1024,
    checksum: "a".repeat(64),
  });

  assert.equal(verdiktas.ok, false, "peržengęs dydį objektas negali būti patvirtintas");
  assert.equal(verdiktas.exists, true, "objektas YRA - tai ne nesančio objekto atvejis");
  assert.equal(verdiktas.checksum, null, "sumos neapskaičiavome, tad jos ir neteigiame");
  assert.equal(verdiktas.nepriklausomas, true);

  assert.ok(atiduota < 100, `srautas privalėjo būti nutrauktas anksti, o perskaityta ${atiduota} gabalų`);
  t.diagnostic(`perskaityta gabalų: ${atiduota}`);
});

test("KONTROLĖ: tinkamo dydžio objektas patvirtinamas inkrementiškai", async () => {
  const turinys = Buffer.from(JSON.stringify({ text: "vientisumas" }), "utf8");
  const checksum = crypto.createHash("sha256").update(turinys).digest("hex");

  const saugykla = createS3ArtifactStore({
    ...KONFIGURACIJA,
    klientas: klientasSu({
      ...NEVERSIJUOTAS,
      GetObjectCommand: () => ({ Body: Readable.from([turinys.subarray(0, 5), turinys.subarray(5)]) }),
    }),
  });

  const verdiktas = await saugykla.verify("results/a.json", { bytes: turinys.byteLength, checksum });

  assert.equal(verdiktas.ok, true, "sudalintas srautas privalo duoti tą pačią sumą");
  assert.equal(verdiktas.bytes, turinys.byteLength);
  assert.equal(verdiktas.checksum, checksum);
});

test("KONTROLĖ: async-iterable kūnas priimamas abiem formomis", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas patikros, kuri atmeta KIEKVIENĄ kūną.
   * Tikrinamos dvi realios formos: Node srautas ir async generatorius (kai kurie
   * S3-compatible SDK adapteriai grąžina būtent jį).
   */
  const turinys = Buffer.from(JSON.stringify({ text: "ok" }), "utf8");

  const formos = [
    ["Readable", () => Readable.from([turinys])],
    [
      "async generatorius",
      () => ({
        async *[Symbol.asyncIterator]() {
          yield turinys;
        },
      }),
    ],
  ];

  for (const [vardas, gamykla] of formos) {
    const saugykla = createS3ArtifactStore({
      ...KONFIGURACIJA,
      klientas: klientasSu({ ...NEVERSIJUOTAS, GetObjectCommand: () => ({ Body: gamykla() }) }),
    });

    assert.deepEqual(await saugykla.read("results/a.json"), { text: "ok" }, vardas);
  }
});
