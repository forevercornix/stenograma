const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * EILĖS PRIKĖLIMO HORIZONTAI IR `delay` RIBA (#155, 7.5a / #183).
 *
 * ⚠️ KODĖL TAI YRA IŠTRYNIMO KLAUSIMAS, NE EILIŲ KLAUSIMAS.
 *
 * Ištrynimo žymos negalima pašalinti anksčiau, nei nebegali pasirodyti
 * vėluojantis darbas. Todėl „kiek ilgiausiai job'as gali būti prikeltas" yra
 * ĮVESTIS į retencijos formulę, o ne eilių konfigūracijos detalė.
 */

const { revivalHorizonsMs, enqueue, MAX_JOB_DELAY_MS } = require("../queues/config");
const { beKomentaru } = require("../utils/auditEvents");

test("VIENETAI: `age` yra SEKUNDĖS, `stalledInterval` - MILISEKUNDĖS", () => {
  /**
   * ⚠️ TAI VIENINTELĖ VIETA, KUR KLAIDA BŪTŲ NEMATOMA. Abu dydžiai yra
   * skaičiai, tad `Math.max()` ant neapdorotų reikšmių nieko nemestų: 86400
   * (sekundžių para) atrodytų mažiau nei 600000 (dešimt minučių ms), ir
   * horizontas nukristų nuo paros iki dešimties minučių - tyliai.
   */
  const env = {
    QUEUE_TTL_SECONDS: "3600",
    QUEUE_STALLED_INTERVAL_MS: "30000",
    QUEUE_MAX_STALLED: "2",
    QUEUE_LOCK_DURATION_MS: "600000",
    QUEUE_MAX_ATTEMPTS: "3",
    QUEUE_BACKOFF_MS: "5000",
  };

  const h = revivalHorizonsMs(env);

  assert.equal(h.removeOnComplete, 3600 * 1000, "sekundės privalo būti padaugintos");
  assert.equal(h.removeOnFail, 24 * 3600 * 1000, "`removeOnFail.age` - irgi sekundės");
  assert.equal(h.stalled, 30000 * 2 + 600000, "milisekundės NEDAUGINAMOS");
  assert.equal(h.retry, 5000 + 10000, "eksponentinis backoff per `attempts - 1` laukimus");
});

test("HORIZONTAS: nuoseklios dedamosios SUDEDAMOS, terminalios - `max`", () => {
  /**
   * ⚠️ ŠIS TESTAS PERRAŠYTAS 7.5a PERŽIŪROJE (#183, P1).
   *
   * Ankstesnė versija tvirtino `max === removeOnFail` ir tuo užrašė KLAIDINGĄ
   * formulę kaip tiesą. Vieno job'o gyvenimo linija dedamąsias SUDEDA: `delay`
   * → retry grandinė → terminalus laikymas. Maksimumas iš jų grąžina vieną
   * dedamąją, o job'as gyvena jų sumą - žyma dingtų, kol BullMQ dar gali jį
   * prikelti.
   *
   * Todėl tikrinama STRUKTŪRA, ne konkreti ribojanti dedamoji.
   */
  const h = revivalHorizonsMs({});

  assert.equal(
    h.nuoseklus,
    h.delayMax + h.retry + h.stalled,
    "nuosekli dalis - suma, ne maksimumas"
  );
  assert.equal(
    h.terminalus,
    Math.max(h.removeOnComplete, h.removeOnFail),
    "job'as baigiasi arba `completed`, arba `failed` - ne abiem"
  );
  assert.equal(h.horizonMs, h.nuoseklus + h.terminalus);

  /** ⚠️ Horizontas negali būti mažesnis už BET KURIĄ atskirą dedamąją. */
  for (const [vardas, reiksme] of Object.entries(h)) {
    if (["nuoseklus", "terminalus", "horizonMs"].includes(vardas)) continue;
    assert.ok(h.horizonMs >= reiksme, `horizontas mažesnis už \`${vardas}\` (${reiksme} ms)`);
  }
});

test("HORIZONTAS: ilga retry grandinė VIRŠIJA bet kurią atskirą dedamąją", () => {
  /**
   * ⚠️ TAI TAS SCENARIJUS, KURĮ SENOJI FORMULĖ PRALEISDAVO (#183 Codex, P1).
   *
   * Sukonfigūruojama retry grandinė, kurios suma didesnė už kiekvieną atskirą
   * dedamąją. Su `Math.max(...)` horizontas būtų lygus vienai jų - ir žyma
   * baigtų galioti, kol job'as dar gyvas eilėje.
   *
   * Skaičiai parinkti taip, kad `retry` viršytų `removeOnFail`: 5 bandymai,
   * bazė 6 h → 6 + 12 + 24 + 48 = 90 h, o `removeOnFail` numatytai 24 h.
   */
  const env = {
    QUEUE_MAX_ATTEMPTS: "5",
    QUEUE_BACKOFF_MS: String(6 * 3600 * 1000),
  };

  const h = revivalHorizonsMs(env);

  const didziausiaAtskira = Math.max(
    h.removeOnComplete,
    h.removeOnFail,
    h.stalled,
    h.retry,
    h.delayMax
  );

  assert.ok(h.retry > h.removeOnFail, `prielaida: retry (${h.retry}) viršija removeOnFail`);
  assert.ok(
    h.horizonMs > didziausiaAtskira,
    `horizontas ${h.horizonMs} privalo viršyti didžiausią atskirą dedamąją ${didziausiaAtskira} - ` +
      "kitaip job'as gyvena ilgiau nei jį saugantis įrašas"
  );

  /** Ir konkrečiai: suma, ne maksimumas. */
  assert.equal(h.horizonMs, h.delayMax + h.retry + h.stalled + h.terminalus);
});

test("HORIZONTAS: `delay` riba yra VIENA IŠ nuosekliųjų dedamųjų", () => {
  const h = revivalHorizonsMs({});
  assert.equal(h.delayMax, MAX_JOB_DELAY_MS, "riba privalo dalyvauti skaičiavime");
  assert.ok(h.horizonMs >= MAX_JOB_DELAY_MS, "horizontas negali būti mažesnis už leistiną atidėjimą");
});

test("HORIZONTAS: lauko `max` NEBĖRA - vardas meluotų", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2 ir §12.1). Grąžinus `max` lauką, kvietėjas
   * galėtų jį pasiimti manydamas gaunąs horizontą, o gautų vieną dedamąją.
   * Pašalinimas paverčia tokį kvietimą `undefined`, ne tyliai per mažu skaičiumi.
   */
  const h = revivalHorizonsMs({});
  assert.equal(h.max, undefined, "`max` po 7.5a peržiūros nebeegzistuoja");
});

test("FAIL-SAFE: neapskaičiuojamas dydis META, o ne tyliai virsta nuliu", () => {
  /**
   * ⚠️ `parseInt("abc")` duoda `NaN`. Palaikius jį nuliu, klaidinga konfigūracija
   * TYLIAI sutrumpintų horizontą, o kartu ir žymos retenciją. Metimas paverčia
   * tai `retentionMs()` fail-safe atveju: žymos NEŠALINAMOS, kol konfigūracija
   * nepataisyta.
   */
  assert.throws(
    () => revivalHorizonsMs({ QUEUE_TTL_SECONDS: "nežinia" }),
    /Neapskaičiuojamas eilės horizonto dydis/
  );

  assert.throws(() => revivalHorizonsMs({ QUEUE_LOCK_DURATION_MS: "-5" }), /Neapskaičiuojamas/);
});

test("`delay` RIBA: viršijus - įdėjimas ATMETAMAS, o ne apkarpomas", async () => {
  /**
   * ⚠️ VYKDOMA, NE DOKUMENTUOJAMA. Dokumentuota riba nesustabdo nė vieno
   * producer'io. Apkarpymas irgi netiktų: kvietėjas manytų atidėjęs valandai, o
   * darbas ateitų anksčiau - tyli semantikos klaida vietoj garsios.
   */
  const idėti = [];
  const queue = {
    add: async (name, data, opts) => {
      idėti.push({ name, data, opts });
      return { id: "x" };
    },
  };

  await enqueue(queue, "transcribe", { jobId: "j" }, { delay: MAX_JOB_DELAY_MS });
  assert.equal(idėti.length, 1, "riba imtinai - leidžiama");

  await assert.rejects(
    () => enqueue(queue, "transcribe", { jobId: "j" }, { delay: MAX_JOB_DELAY_MS + 1 }),
    /viršija leistiną/,
    "viršijus ribą įdėjimas privalo būti atmestas"
  );

  await assert.rejects(
    () => enqueue(queue, "transcribe", { jobId: "j" }, { delay: "vėliau" }),
    /Neteisinga/,
    "netinkama reikšmė irgi atmetama"
  );

  assert.equal(idėti.length, 1, "atmestas įdėjimas NEGALI pasiekti eilės");
});

test("`delay` RIBA: be `delay` įdėjimas veikia įprastai", async () => {
  /**
   * ⚠️ PRIEŠINGA KRYPTIS. Be jos „viskas atmetama" praeitų kaip sėkmė - ta pati
   * klaida, kurią #183 įvardija async cutover atveju.
   */
  const idėti = [];
  const queue = { add: async (...a) => idėti.push(a) };

  await enqueue(queue, "generate", { jobId: "j" }, { attempts: 3 });
  assert.equal(idėti.length, 1, "įprastas įdėjimas privalo praeiti");
});

test("TRIPWIRE: `queue.add(` neegzistuoja už `enqueue()` ribų", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2), NE ELGSENOS ĮRODYMAS. Elgseną tikrina testai
   * aukščiau. Ši patikra gaudo vieną konkretų regresijos būdą: naują producer'į,
   * kviečiantį `queue.add()` tiesiogiai ir taip apeinantį ribą.
   *
   * ⚠️ KOMENTARAI IR EILUTĖS NUVALOMOS - kitaip patikra pagautų savo pačios
   * dokumentaciją (AGENTS.md §9.2).
   */
  const dir = path.join(__dirname, "../queues");
  const pazeidejai = [];

  for (const failas of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const svarus = beKomentaru(fs.readFileSync(path.join(dir, failas), "utf8"));

    for (const eilute of svarus.split("\n")) {
      if (!/\bqueue\.add\s*\(/.test(eilute)) continue;
      /** `config.js` yra pati `enqueue()` realizacija - vienintelė leistina vieta. */
      if (failas === "config.js") continue;
      pazeidejai.push(`${failas}: ${eilute.trim()}`);
    }
  }

  assert.deepEqual(
    pazeidejai,
    [],
    `producer'iai privalo eiti per \`enqueue()\`, kad \`delay\` riba būtų vykdoma:\n${pazeidejai.join("\n")}`
  );
});

test("PRODUCER'IAI: abu realiai naudoja `enqueue()`", () => {
  /**
   * Tripwire aukščiau įrodo, kad tiesioginio kvietimo NĖRA. Šis - kad vietoj jo
   * yra teisingas. Be antrosios pusės producer'is, iš kurio įdėjimas apskritai
   * pašalintas, praeitų.
   */
  for (const failas of ["transcriptionQueue.js", "protocolQueue.js"]) {
    const svarus = beKomentaru(
      fs.readFileSync(path.join(__dirname, "../queues", failas), "utf8")
    );

    assert.match(svarus, /enqueue\(queue,/, `${failas} privalo įdėti per \`enqueue()\``);
  }
});
