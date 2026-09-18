const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CursorError,
  fingerprint,
  encode,
  decode,
  decodeForFilters,
} = require("../utils/auditStore/cursor");

/**
 * KEYSET KURSORIUS (#155, 7.4c / #212).
 *
 * ⚠️ SVARBIAUSIAS ŠIO MODULIO REIKALAVIMAS - NE PUSLAPIAVIMAS, O PRIVATUMAS.
 *
 * Kursorius keliauja URL'e ir patenka į nginx access logus. `job_id` jame būtų
 * tiksliai tas plaintext nutekėjimas, kurio vengia visas 7.4a/7.4b darbas.
 * Todėl filtrai susiejami HMAC atspaudu, o ne užkoduojami.
 */

const SECRET = "testinis-aktyvus-raktas-base64url";
const FILTRAI = Object.freeze({ action: "LOGIN_SUCCESS", jobId: "yra", requestId: null, dir: "desc" });

test("PRIVATUMAS: filtrų reikšmių kursoriuje NĖRA", () => {
  /**
   * ⚠️ „Opaque" nereiškia „šifruotas" - base64url atkoduojamas trivialiai.
   * Todėl tikrinama ATKODUOTA reikšmė, ne pats tokenas.
   */
  const SLAPTAS_JOB = "job-a7f3-SENTINEL-e91c";

  const atspaudas = fingerprint({ ...FILTRAI, jobId: SLAPTAS_JOB }, SECRET);
  const token = encode(12345, atspaudas);

  const atkoduota = Buffer.from(token, "base64url").toString("utf8");

  assert.ok(!atkoduota.includes(SLAPTAS_JOB), "job_id negali keliauti kursoriuje");
  assert.ok(!atkoduota.includes(SECRET), "secret'as negali keliauti kursoriuje");
  assert.ok(!atkoduota.includes("LOGIN_SUCCESS"), "filtrų reikšmės nekoduojamos");

  /** Payload'e yra TIK sort key ir atspaudas (#212). */
  assert.deepEqual(Object.keys(JSON.parse(atkoduota)).sort(), ["f", "s"]);
});

test("FORMATAS: tokenas URL-safe, be ekranavimo poreikio", () => {
  const token = encode(1, fingerprint(FILTRAI, SECRET));

  assert.match(token, /^[A-Za-z0-9_-]+$/, "base64url be `+`, `/`, `=`");
  assert.equal(encodeURIComponent(token), token, "URL'e ekranuoti nereikia");
});

test("ATSPAUDAS: kanoninis - raktų tvarka reikšmės neturi", () => {
  /**
   * Be kanonizavimo ta pati užklausa, parašyta kita tvarka, duotų kitą atspaudą,
   * ir teisėtas kursorius būtų atmestas - klientas matytų atsitiktinius 400.
   */
  const a = fingerprint({ action: "X", jobId: "yra", dir: "desc" }, SECRET);
  const b = fingerprint({ dir: "desc", jobId: "yra", action: "X" }, SECRET);

  assert.equal(a, b);

  /** `undefined` ir `null` - tas pats „nefiltruojama". */
  assert.equal(
    fingerprint({ action: "X", requestId: undefined }, SECRET),
    fingerprint({ action: "X", requestId: null }, SECRET)
  );
});

test("SUSIEJIMAS: kitokia filtrų aibė ATMETAMA", () => {
  const token = encode(99, fingerprint(FILTRAI, SECRET));

  assert.equal(decodeForFilters(token, FILTRAI, SECRET), 99, "sava aibė - praeina");

  const svetimos = [
    ["kitas action", { ...FILTRAI, action: "LOGOUT" }],
    ["pridėtas filtras", { ...FILTRAI, requestId: "req-1" }],
    ["nuimtas job_id", { ...FILTRAI, jobId: null }],
    ["kita kryptis", { ...FILTRAI, dir: "asc" }],
  ];

  for (const [pavadinimas, filtrai] of svetimos) {
    assert.throws(
      () => decodeForFilters(token, filtrai, SECRET),
      (e) => e instanceof CursorError,
      `${pavadinimas}: privalo būti atmesta, ne tyliai grąžinti kitus rezultatus`
    );
  }
});

test("ROTACIJA: pasukus aktyvų raktą seni kursoriai NUSTOJA GALIOTI", () => {
  /**
   * ⚠️ SĄMONINGA #212 PASEKMĖ, ne defektas.
   *
   * Atspaudas raktuojamas aktyviu `AUDIT_ID_SALT`. Alternatyva būtų raktuoti
   * kažkuo, kas nesikeičia, o tokio bendro rakto sistemoje nėra. Kaina -
   * klientas pradeda puslapiavimą iš naujo; nauda - filtrai nekeliauja URL'e.
   */
  const token = encode(7, fingerprint(FILTRAI, SECRET));

  assert.equal(decodeForFilters(token, FILTRAI, SECRET), 7);

  assert.throws(
    () => decodeForFilters(token, FILTRAI, "naujas-raktas-po-rotacijos"),
    (e) => e instanceof CursorError,
    "po rotacijos senas kursorius privalo būti atmestas"
  );
});

test("KLAIDOS: kiekviena netinkama forma yra `CursorError`, ne 500", () => {
  /**
   * ⚠️ Maršrutas iš `CursorError` daro 400. Bet kuri kita klaidos rūšis
   * (`SyntaxError` iš `JSON.parse`, `TypeError` iš `Buffer`) nukristų į bendrą
   * `catch` ir virstų 500 - kliento klaida atrodytų kaip serverio gedimas.
   */
  const netinkami = [
    ["ne tekstas", null],
    ["tuščias", ""],
    ["ne base64url", "!!!nevalidus!!!"],
    ["ne JSON", Buffer.from("tiesiog tekstas").toString("base64url")],
    ["masyvas", Buffer.from("[1,2]").toString("base64url")],
    ["be `s`", Buffer.from(JSON.stringify({ f: "abc" })).toString("base64url")],
    ["be `f`", Buffer.from(JSON.stringify({ s: 1 })).toString("base64url")],
    ["neigiamas `s`", Buffer.from(JSON.stringify({ s: -1, f: "abc" })).toString("base64url")],
    ["`s` ne sveikasis", Buffer.from(JSON.stringify({ s: 1.5, f: "abc" })).toString("base64url")],
    ["`f` tuščias", Buffer.from(JSON.stringify({ s: 1, f: "" })).toString("base64url")],
  ];

  for (const [pavadinimas, token] of netinkami) {
    assert.throws(
      () => decode(token),
      (e) => e instanceof CursorError && e.code === "AUDIT_CURSOR_INVALID",
      `${pavadinimas}: privalo būti CursorError`
    );
  }
});

test("KLAIDOS: pranešime NĖRA kliento duomenų", () => {
  /**
   * `JSON.parse` klaidos tekste atsiduria dalis įvesties. Persiuntus ją klientui,
   * sugadintas tokenas grįžtų atgal atsakyme - o jame gali būti bet kas.
   */
  const SENTINEL = "SLAPTA-REIKSME-SENTINEL";
  const token = Buffer.from(SENTINEL).toString("base64url");

  try {
    decode(token);
    assert.fail("prielaida: tokenas netinkamas");
  } catch (e) {
    assert.ok(!e.message.includes(SENTINEL), "kliento duomenys negali grįžti klaidoje");
  }
});

test("ENCODE: netinkamas `seq` atmetamas dar rašant", () => {
  const atspaudas = fingerprint(FILTRAI, SECRET);

  for (const blogas of [-1, 1.5, "1", null, undefined, NaN]) {
    assert.throws(() => encode(blogas, atspaudas), (e) => e instanceof CursorError);
  }

  assert.ok(encode(0, atspaudas), "nulis yra teisėtas `seq`");
});

test("ATSPAUDAS: be aktyvaus rakto - klaida, ne tylus praleidimas", () => {
  /** Be rakto atspaudas būtų konstanta, ir susiejimas nustotų galioti. */
  assert.throws(() => fingerprint(FILTRAI, null), (e) => e instanceof CursorError);
  assert.throws(() => fingerprint(FILTRAI, ""), (e) => e instanceof CursorError);
});
