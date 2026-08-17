const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  LIMIT_KIND: K,
  ResultLimitError,
  getLimits,
  utf8ByteSize,
  jsonByteSize,
  assertWithinLimit,
  assertResultWithinLimits,
} = require("../utils/resultLimits");

/* ── baitų matavimas ──────────────────────────────────────────────────── */

test("#153 BAITAI: matuojami UTF-8 baitai, NE JS simbolių skaičius", () => {
  /**
   * `String.length` skaičiuoja UTF-16 code unit'us. Lietuviškam tekstui
   * skirtumas dvigubas: `ą`, `ė`, `ž` UTF-8 užima po 2 baitus.
   *
   * Naudojant `.length` riba būtų maždaug dvigubai laisvesnė nei deklaruota –
   * ir jos griežtumas priklausytų nuo TEKSTO KALBOS. Lietuviškam projektui tai
   * ne kraštinis atvejis, o įprastas.
   */
  assert.equal("ąėž".length, 3, "prielaida: JS mato 3 simbolius");
  assert.equal(utf8ByteSize("ąėž"), 6, "bet UTF-8 tai 6 baitai");

  assert.equal(utf8ByteSize("abc"), 3, "ASCII sutampa – todėl klaida nepastebima angliškuose testuose");
});

test("#153 BAITAI: objektai serializuojami, null ir undefined duoda 0", () => {
  assert.equal(jsonByteSize({ a: 1 }), Buffer.byteLength('{"a":1}', "utf8"));
  assert.equal(utf8ByteSize(null), 0);
  assert.equal(jsonByteSize(null), 0);
  assert.equal(utf8ByteSize(undefined), 0);
  assert.equal(jsonByteSize(undefined), 0);
});

/* ── konfigūracija ────────────────────────────────────────────────────── */

test("#153 RIBOS: numatytos reikšmės ir env perrašymas", () => {
  const numatytos = getLimits({});
  assert.equal(numatytos[K.RESULT_BYTES], 20 * 1024 * 1024);
  assert.equal(numatytos[K.TRANSCRIPTION_SEGMENTS], 100_000);

  const savos = getLimits({ MAX_RESULT_BYTES: "1024", MAX_SEGMENTS: "5" });
  assert.equal(savos[K.RESULT_BYTES], 1024);
  assert.equal(savos[K.TRANSCRIPTION_SEGMENTS], 5);
});

test("#153 RIBOS: netinkama env reikšmė grįžta prie numatytosios, ne prie 0", () => {
  /**
   * `0` ar neigiama riba reikštų, kad VISKAS viršija – sistema nustotų veikti.
   * Konfigūracijos klaida neturi virsti visišku sustojimu.
   */
  for (const bloga of ["0", "-5", "abc", "", "   "]) {
    const l = getLimits({ MAX_RESULT_BYTES: bloga });
    assert.equal(l[K.RESULT_BYTES], 20 * 1024 * 1024, `bloga reikšmė: ${JSON.stringify(bloga)}`);
  }
});

/* ── klaidų šeima ─────────────────────────────────────────────────────── */

test("#153 KLAIDA: struktūrizuota, atpažįstama be teksto analizės", () => {
  /**
   * Worker'iui, HTTP sluoksniui ir testams neturi reikėti atpažinti klaidos iš
   * pranešimo teksto – pakeitus formuluotę lūžtų viskas, kas ja rėmėsi.
   */
  try {
    assertWithinLimit(K.RESULT_BYTES, 5000, { MAX_RESULT_BYTES: "100" });
    assert.fail("turėjo mesti");
  } catch (e) {
    assert.ok(e instanceof ResultLimitError);
    assert.equal(e.code, "RESULT_TOO_LARGE");
    assert.equal(e.kind, K.RESULT_BYTES);
    assert.equal(e.limit, 100);
    assert.equal(e.actual, 5000);
  }
});

test("#153 KLAIDA: nežinoma ribos rūšis meta TypeError, ne tylų praleidimą", () => {
  assert.throws(() => assertWithinLimit("isgalvota", 1, {}), TypeError);
});

test("#153 RIBA: lygi reikšmė PRAEINA, viršijanti – ne", () => {
  const env = { MAX_RESULT_BYTES: "100" };
  assert.doesNotThrow(() => assertWithinLimit(K.RESULT_BYTES, 100, env), "riba imtinai");
  assert.throws(() => assertWithinLimit(K.RESULT_BYTES, 101, env), ResultLimitError);
});

/* ── rezultato payload ────────────────────────────────────────────────── */

test("#153 REZULTATAS: matuojamas TIK payload'as, ne job metaduomenys", () => {
  /**
   * Jei ribą taikytume visam job objektui, ji imtų priklausyti nuo laiko žymų,
   * statuso, `requestId`, audito laukų – t. y. nuo dalykų, neturinčių nieko
   * bendra su tiekėjo atsakymo dydžiu. Tas pats rezultatas praeitų arba ne
   * priklausomai nuo to, kiek metaduomenų pridėjo sistema.
   */
  const payload = { text: "trumpas" };
  const env = { MAX_RESULT_BYTES: String(jsonByteSize(payload) + 1) };

  assert.doesNotThrow(() => assertResultWithinLimits(payload, env));

  // Tas pats payload'as job objekto viduje su metaduomenimis – vis tiek praeina.
  const jobas = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestId: "req_abcdefabcdefabcdef",
    result: payload,
  };
  assert.ok(jsonByteSize(jobas) > jsonByteSize(payload), "prielaida: metaduomenys didesni");
  assert.doesNotThrow(() => assertResultWithinLimits(jobas.result, env));
});

test("#153 REZULTATAS: lietuviškas tekstas skaičiuojamas teisingai", () => {
  /**
   * Regresija prieš `.length` naudojimą: tekstas, kuris ASCII matu telpa,
   * lietuviškai gali netilpti – ir atvirkščiai, riba neturi būti tyliai
   * dvigubai laisvesnė.
   */
  const tekstas = "ą".repeat(100); // 200 baitų, 100 simbolių
  assert.equal(utf8ByteSize(tekstas), 200);

  assert.throws(
    () => assertWithinLimit(K.TRANSCRIPT_BYTES, utf8ByteSize(tekstas), { MAX_TRANSCRIPT_BYTES: "150" }),
    ResultLimitError,
    "150 baitų riba turi būti viršyta, nors simbolių tik 100"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * TERMINALUS `failed` PER LIFECYCLE KELIĄ
 *
 * Providerio lygio testų NEPAKANKA: svarbu, kad ribos viršijimas nebūtų
 * traktuojamas kaip paprastas transporto exception, o job'as pereitų į
 * TERMINALŲ `failed`, ne liktų pakibęs `processing`.
 * ══════════════════════════════════════════════════════════════════════════ */

const jobRunner = require("../queues/jobRunner");
const jobStore = require("../utils/jobStore");
const { OWNER_KIND } = require("../utils/jobStore/common");


/**
 * Paleidžia inline job'ą su processor'iumi, kuris meta duotą klaidą.
 *
 * `_runInline` naudoja UŽREGISTRUOTĄ processor'ių, ne perduotą argumentu –
 * todėl jį reikia laikinai pakeisti ir po testo atstatyti.
 */
async function runInlineSuKlaida(type, jobId, error) {
  const originalus = jobRunner._processors ? jobRunner._processors[type] : undefined;
  jobRunner.registerProcessor(type, async () => {
    throw error;
  });
  try {
    await jobRunner._runInline(type, jobId, {});
  } finally {
    if (originalus) jobRunner.registerProcessor(type, originalus);
  }
}

test("#153 LIFECYCLE: ribos viršijimas gauna DOMENINĮ kodą, ne internal_error", () => {
  /**
   * Be atskiros šakos klasifikatoriuje `ResultLimitError` taptų
   * `internal_error`, o pranešimas – sanitizuotas. Operatorius nematytų, KODĖL
   * darbas nepavyko, nors priežastis konkreti ir ne serverio klaida.
   */
  const err = new ResultLimitError({ kind: K.RESULT_BYTES, limit: 100, actual: 5000 });
  const { errorCode, message } = jobRunner._classifyError(err, "protocol job");

  assert.equal(errorCode, "RESULT_TOO_LARGE", "ne internal_error");
  assert.match(message, /result_bytes/, "pranešime matoma ribos rūšis");
  assert.match(message, /5000/, "ir išmatuotas dydis");
});

test("#153 LIFECYCLE: viršijus ribą job'as pereina į TERMINALŲ failed", async () => {
  /**
   * ESMINIS testas: `processing → limit exceeded → failed`.
   *
   * Blogiausias variantas būtų job'as, likęs `processing` – jis niekada
   * nepasibaigtų, o vartotojas laukas neribotai. Todėl tikrinamas ne tik
   * `errorCode`, bet ir tai, kad statusas TERMINALUS.
   */
  const job = await jobStore.create({
    type: "protocol",
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
  });

  await runInlineSuKlaida(
    "protocol",
    job.id,
    new ResultLimitError({ kind: K.TRANSCRIPT_BYTES, limit: 10, actual: 999 })
  );

  const po = await jobStore.system.get(job.id);
  assert.equal(po.status, jobStore.STATUS.FAILED, "NE processing");
  assert.equal(po.error_code, "RESULT_TOO_LARGE");
  assert.equal(po.result, null, "rezultato artefaktas neišsaugotas");
});

test("#153 LIFECYCLE: job metaduomenys LIEKA, kad priežastis būtų matoma", async () => {
  /**
   * „Rezultatas nesaugomas" nereiškia „job'as ištrinamas": be metaduomenų
   * vartotojas matytų tik dingusį darbą be jokios priežasties.
   */
  const job = await jobStore.create({
    type: "protocol",
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
  });

  await runInlineSuKlaida(
    "protocol",
    job.id,
    new ResultLimitError({ kind: K.RESULT_BYTES, limit: 1, actual: 2 })
  );

  const po = await jobStore.system.get(job.id);
  assert.ok(po, "job įrašas turi likti");
  assert.ok(po.error, "su klaidos pranešimu");
  assert.ok(po.updatedAt, "ir laiko žyma");
});

/* ══════════════════════════════════════════════════════════════════════════
 * SIMETRIJA: inline ir worker keliai matuoja vienodai
 * ══════════════════════════════════════════════════════════════════════════ */

test("#153 SIMETRIJA: patikra yra ABIEJUOSE vykdymo keliuose", () => {
  /**
   * BullMQ kelias yra PRODUKCIJOS kelias su Redis. Be patikros jame riba
   * veiktų tik dev/desktop režime – t. y. būtų neveiksminga būtent ten, kur
   * labiausiai reikia.
   *
   * Tikrinamas kodas, ne elgesys: worker'io paleidimas testuose reikalautų
   * tikro Redis, o pati riba jau padengta lifecycle testais aukščiau. Čia
   * saugoma tik nuo to, kad kas nors pridėtų trečią vykdymo kelią be patikros.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..");

  for (const failas of ["queues/jobRunner.js", "workers/index.js"]) {
    const src = fs.readFileSync(path.join(šaknis, failas), "utf8");
    assert.match(
      src,
      /assertResultWithinLimits\(result\)/,
      `${failas} turi tikrinti rezultato ribą prieš rašymą į store`
    );
  }
});

test("#153 SIMETRIJA: matuojama serializacija, ne backend'o vidinis formatas", () => {
  /**
   * Redis saugo hash su string reikšmėmis, atmintis – objektą. Jei riba būtų
   * matuojama backend'o formatu, tas pats rezultatas praeitų viename ir
   * kristų kitame.
   *
   * `jsonByteSize()` matuoja JSON serializaciją, tad reikšmė nepriklauso nuo
   * saugyklos.
   */
  const rezultatas = { text: "ąžuolas", segments: [{ start: 0, end: 1, text: "ąžuolas" }] };
  const tiesiogiai = jsonByteSize(rezultatas);
  const perSerializacija = Buffer.byteLength(JSON.stringify(rezultatas), "utf8");

  assert.equal(tiesiogiai, perSerializacija);
  assert.ok(tiesiogiai > JSON.stringify(rezultatas).length, "lietuviškas tekstas: baitų daugiau nei simbolių");
});

/* ══════════════════════════════════════════════════════════════════════════
 * ENV PARSERIS: dalinis skaičius NĖRA galiojanti reikšmė
 * ══════════════════════════════════════════════════════════════════════════ */

test("#153 ENV: prefiksinis skaičius atmetamas, ne priimamas kaip dalis", () => {
  /**
   * `Number.parseInt` priimtų `"20MB"` → 20, `"1.5"` → 1, `"1e6"` → 1.
   *
   * Tai blogiau nei aiški klaida: `MAX_RESULT_BYTES=20MB` taptų **20 baitų**
   * riba, t. y. viskas viršytų, ir sistema tyliai nustotų veikti. Operatorius
   * matytų `RESULT_TOO_LARGE` visiems darbams ir ieškotų klaidos ne toje vietoje.
   */
  // `" 12 "` čia NĖRA: apkerpami tarpai yra tikslinga elgsena (žr. testą žemiau).
  const blogos = ["10abc", "1.5", "1e6", "64MB", "20 971 520", "0x10", "+5"];

  for (const reikšmė of blogos) {
    const l = getLimits({ MAX_RESULT_BYTES: reikšmė });
    assert.equal(
      l[K.RESULT_BYTES],
      20 * 1024 * 1024,
      `${JSON.stringify(reikšmė)} turi grįžti prie numatytosios, ne būti dalinai parsinta`
    );
  }
});

test("#153 ENV: galiojanti reikšmė priimama, per didelė – atmetama", () => {
  assert.equal(getLimits({ MAX_RESULT_BYTES: "1024" })[K.RESULT_BYTES], 1024);
  assert.equal(getLimits({ MAX_RESULT_BYTES: "  2048  " })[K.RESULT_BYTES], 2048, "tarpai apkerpami");

  // Už `Number.isSafeInteger` ribų – nesaugu naudoti kaip ribą.
  const perDidelė = "99999999999999999999";
  assert.equal(getLimits({ MAX_RESULT_BYTES: perDidelė })[K.RESULT_BYTES], 20 * 1024 * 1024);
});

/* ══════════════════════════════════════════════════════════════════════════
 * DIARIZACIJA: post-response riba per tikrą providerį
 * ══════════════════════════════════════════════════════════════════════════ */

test("#153 DIARIZACIJA: per daug turns atmetama providerio lygiu", async () => {
  /**
   * Be šio testo `assertWithinLimit` eilutę `PyannoteDiarizationProvider`
   * viduje būtų galima pašalinti, o `resultLimits` rinkinys liktų žalias –
   * helperiai patys veiktų, tik niekas jų nebekviestų.
   */
  const http = require("node:http");
  const PyannoteProvider = require("../providers/diarization/PyannoteDiarizationProvider");

  const turns = Array.from({ length: 5 }, (_, i) => ({ start: i, end: i + 1, speaker: "A" }));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ turns }));
  });

  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/diarize`;
  process.env.MAX_DIARIZATION_TURNS = "2";

  try {
    const provider = new PyannoteProvider({ url });
    await assert.rejects(
      () => provider.diarize(Buffer.from("x".repeat(100)), {}),
      (e) => e.name === "ResultLimitError" && e.kind === K.DIARIZATION_TURNS && e.actual === 5
    );
  } finally {
    delete process.env.MAX_DIARIZATION_TURNS;
    srv.close();
  }
});

test("#153 DIARIZACIJA: normalus atsakymas su numatytomis ribomis praeina", async () => {
  const http = require("node:http");
  const PyannoteProvider = require("../providers/diarization/PyannoteDiarizationProvider");

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ turns: [{ start: 0, end: 5, speaker: "SPEAKER_00" }] }));
  });

  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/diarize`;

  try {
    const provider = new PyannoteProvider({ url });
    const r = await provider.diarize(Buffer.from("x".repeat(100)), {});
    assert.equal(r.turns.length, 1);
  } finally {
    srv.close();
  }
});

test("#153 MATAI: tekstas ir JSON matuojami SKIRTINGAI – ir tai tyčia", () => {
  /**
   * Bendras helperis, priimantis ir string'ą, ir objektą, matuotų juos
   * skirtinga semantika po tuo pačiu pavadinimu:
   *
   *   `"abc"` kaip TEKSTAS  → 3 baitai
   *   `"abc"` kaip JSON     → 5 baitai (su kabutėmis)
   *
   * Anksčiau ar vėliau tai supainiotų `MAX_TRANSCRIPT_BYTES` (tekstas) su
   * `MAX_RESULT_BYTES` (JSON payload) – ir riba imtų reikšti ne tą, kas
   * dokumentuota.
   */
  assert.equal(utf8ByteSize("abc"), 3);
  assert.equal(jsonByteSize("abc"), 5, "JSON prideda kabutes");
  assert.notEqual(utf8ByteSize("abc"), jsonByteSize("abc"));

  // Lietuviškas tekstas: abu matai teisingi, bet skirtingi.
  assert.equal(utf8ByteSize("ąėž"), 6);
  assert.equal(jsonByteSize("ąėž"), 8);
});
