const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { ArtifactStoreError, atkurtiReiksme, KLAIDA } = require("../utils/artifactStore/validation");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const jobRunner = require("../queues/jobRunner");

/**
 * KLAIDŲ PRANEŠIMŲ HIGIENA (#157, PR-2, Codex #290).
 *
 * ⚠️ JOB'O KLAIDOS LAUKĄ MATO SAVININKAS.
 *
 * `_classifyError()` grąžindavo `ArtifactStoreError.message` nepakeistą, o tas
 * pranešimas nešasi `JSON.parse` diagnostiką, į kurią Node įdeda ARTEFAKTO
 * TURINIO fragmentą. Transkripcijų atveju tai jautrūs duomenys — asmenvardžiai,
 * adresai, sveikatos informacija — savininkui matomame lauke.
 *
 * ⚠️ NODE VERSIJA KEIČIA NUOTĖKIO DYDĮ, NE JO EGZISTAVIMĄ. Node 18 rodo vieną
 * simbolį, Node 22 (CI ir produkcija) — iki dešimties turinio simbolių. Todėl
 * testuojama TAISYKLĖ („viešas pranešimas gaminamas iš KODO"), o ne konkretaus
 * fragmento nebuvimas: pastarasis Node 18 praeitų ir be pataisymo (§9.2).
 */

const SLAPTAS = "PACIENTAS-JONAS-JONAITIS-19850101";

test("viešas pranešimas gaminamas iš KODO, ne iš `message`", () => {
  const klaida = new ArtifactStoreError(
    `ArtifactStore: turinys nėra JSON (Unexpected token, "${SLAPTAS}" ...)`,
    "ARTIFACT_CORRUPT"
  );

  const { errorCode, message } = jobRunner._classifyError(klaida, "testas");

  assert.equal(errorCode, "ARTIFACT_CORRUPT", "kodas privalo išlikti — pagal jį sprendžia operatorius");
  assert.ok(!message.includes(SLAPTAS), `viešame pranešime yra artefakto turinys: ${message}`);
  assert.ok(message.length > 0, "kvietėjas privalo gauti ką rodyti");
});

test("KONTROLĖ: kiekvienas artefakto kodas turi SAVO viešą pranešimą", () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas ir vienu bendru „klaida" tekstu —
   * tada `ARTIFACT_NOT_FOUND` (dingo objektas) ir `ARTIFACT_VALUE_UNSUPPORTED`
   * (rezultatas nesaugotinas) atrodytų vienodai, nors reikalauja skirtingo
   * veiksmo.
   */
  const kodai = [
    "ARTIFACT_VALUE_UNSUPPORTED",
    "ARTIFACT_KEY_INVALID",
    "ARTIFACT_NOT_FOUND",
    "ARTIFACT_CORRUPT",
    "ARTIFACT_CONFIG_INVALID",
  ];

  const pranesimai = kodai.map(
    (kodas) => jobRunner._classifyError(new ArtifactStoreError(SLAPTAS, kodas), "testas").message
  );

  assert.equal(new Set(pranesimai).size, kodai.length, "pranešimai privalo skirtis pagal kodą");
  for (const pranesimas of pranesimai) {
    assert.ok(!pranesimas.includes(SLAPTAS), "nė vienas pranešimas neneša originalaus teksto");
  }
});

test("SUGADINTAS ≠ NERASTAS: netaisyklingas JSON turi savo kodą", () => {
  /**
   * ⚠️ ATKŪRIMAS SIUNČIAMAS KLAIDINGU KELIU, jei abu suplakami.
   *
   * „Nėra objekto" reiškia orphan / dingusį artefaktą — remontas eina per
   * atkūrimą iš atsarginės kopijos. „Turinys sugadintas" reiškia, kad objektas
   * YRA, bet neperskaitomas: ten reikia vientisumo tyrimo, o ne paieškos.
   * Vienas kodas abiem verstų operatorių ieškoti to, kas guli vietoje.
   */
  let klaida = null;
  try {
    atkurtiReiksme(Buffer.from(SLAPTAS, "utf8"), "results/x.json");
  } catch (e) {
    klaida = e;
  }

  assert.ok(klaida instanceof ArtifactStoreError);
  assert.equal(klaida.code, KLAIDA.SUGADINTAS);
  assert.notEqual(klaida.code, KLAIDA.NERASTA, "sugadintas turinys nėra dingęs objektas");

  assert.ok(!klaida.message.includes(SLAPTAS), "pranešime nėra artefakto turinio");

  /**
   * ⚠️ ORIGINALI KLAIDA LIEKA `cause` GRANDINĖJE, BET NIEKUR NELOGGUOJAMA.
   *
   * Ankstesnė redakcija ją dėjo į `priezastis` lauką, kurį `_classifyError()`
   * rašydavo į logą — turinys iškeliaudavo pro kitas duris. `cause` yra
   * standartinė derinimo grandinė; taisyklė ta pati, kur ji nebūtų: automatiškai
   * serializuoti jos negalima (žr. „logai neša TIK kodą" testą).
   */
  assert.ok(klaida.cause instanceof Error, "kilmė išsaugoma derinimui per `cause`");
});

test("tikras sugadintas objektas fs saugykloje: `ARTIFACT_CORRUPT`, ne `ARTIFACT_NOT_FOUND`", async (t) => {
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-sugadintas-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/sugadintas.json";

  await saugykla.put(raktas, { text: "geras" });
  await fsp.writeFile(path.join(saknis, raktas), SLAPTAS, "utf8");

  await assert.rejects(
    () => saugykla.read(raktas),
    (klaida) => klaida.code === "ARTIFACT_CORRUPT" && !klaida.message.includes(SLAPTAS),
    "esantis, bet neperskaitomas objektas privalo turėti savo kodą"
  );

  assert.ok(await saugykla.head(raktas), "objektas VIS DAR yra — būtent tuo jis skiriasi nuo dingusio");
});
