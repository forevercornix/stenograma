const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const artefactScanner = require("../utils/artefactScanner");
const { DELETION_STATUS } = require("../services/lifecycleService");
const tombstones = require("../utils/deletionTombstones");

/**
 * #19 PR5: DOKUMENTACIJA TURI ATITIKTI TIKROVĘ.
 *
 * Dokumentas apie ištrynimo garantijas yra pažadas – jei jis pasensta, sistema
 * teigia daugiau, nei daro. Tai pavojingiau nei trūkstama funkcija, nes kuria
 * klaidingą pasitikėjimą būtent ten, kur jo negalima turėti.
 *
 * Šie testai NETIKRINA teksto kokybės. Jie tikrina, kad dokumente minimi
 * dalykai realiai egzistuoja, o realiai egzistuojantys būtų paminėti.
 */

const DOCS = path.join(__dirname, "..", "..", "docs");

function readDoc(name) {
  return fs.readFileSync(path.join(DOCS, name), "utf8");
}

test("DOKUMENTAI: visi #19 dokumentai egzistuoja", () => {
  /**
   * Tikrinama pagal VARDĄ, tad pervadinus dokumentą testas lūš – ir tai
   * teisinga: vardas yra nuorodų taškas iš README, matricos ir kitų dokumentų,
   * kurie pervadinus irgi nustotų veikti.
   *
   * Bet klaidos pranešimas turi pasakyti, KĄ daryti – kitaip pervadinimas
   * atrodys kaip nesuprantamas testo gedimas.
   */
  const required = ["artefact-lifecycle.md", "deletion-guarantees.md"];

  for (const name of required) {
    assert.ok(
      fs.existsSync(path.join(DOCS, name)),
      `Trūksta dokumento: ${name}\n` +
        "Jei jis PERVADINTAS, atnaujinkite: šį testą, README nuorodas ir " +
        "docs/security-test-matrix.md – vardas naudojamas nuorodose."
    );
  }
});

test("RETENCIJA: dokumento LENTELĖS reikšmės sutampa su .env.example", () => {
  /**
   * ⚠️ Pirmoji šio testo versija turėjo reikšmes ĮRAŠYTAS PAČIAME TESTE ir
   * lygino jas su `.env.example`. Dokumento lentelė nebuvo skaitoma visai –
   * tad ji galėjo teigti bet ką, o testas liktų žalias. Mutacija, pakeitusi
   * `24` į `48` dokumente, praėjo nepastebėta.
   *
   * Dabar reikšmės imamos IŠ DOKUMENTO ir lyginamos su konfigūracija. Tai
   * vienintelis būdas pagauti dokumento senėjimą.
   */
  const doc = readDoc("deletion-guarantees.md");
  const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  const documentedRows = [...doc.matchAll(/\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|/g)];

  assert.ok(documentedRows.length >= 4, `retencijos lentelė per trumpa: ${documentedRows.length} eilučių`);

  const checked = [];

  for (const [, name, documentedValue] of documentedRows) {
    const match = envExample.match(new RegExp(`^#?\\s*${name}=(\\d+)`, "m"));
    if (!match) continue; // nuostatos, kurių `.env.example` nenurodo skaičiumi

    assert.equal(
      Number(documentedValue),
      Number(match[1]),
      `${name}: dokumente ${documentedValue}, .env.example ${match[1]} – reikšmės išsiskyrė`
    );
    checked.push(name);
  }

  assert.ok(
    checked.length >= 3,
    `per mažai palygintų nuostatų (${checked.join(", ")}) – testas beveik nieko netikrina`
  );
});

test("RETENCIJA: `JOB_TTL_MINUTES` numatytoji sutampa su KODU, ne tik su .env", () => {
  /**
   * `.env.example` yra dokumentacija, ne vykdomas kodas. Tikroji numatytoji
   * reikšmė gyvena `jobStore/common.js` – jei jos išsiskirtų, diegimas be
   * `.env` elgtųsi kitaip nei aprašyta.
   */
  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "jobStore", "common.js"), "utf8");

  assert.match(
    source,
    /JOB_TTL_MINUTES \|\| "60"/,
    "kodo numatytoji reikšmė turi sutapti su dokumentuota (60)"
  );
});

test("ARTEFAKTAI: kiekvienas registro tipas paminėtas gyvavimo ciklo dokumente", () => {
  /**
   * Naujas artefakto tipas be dokumentacijos yra nematomas tam, kas skaito
   * dokumentą – o būtent dokumentu remiasi auditorius ir naujas komandos narys.
   */
  const doc = readDoc("artefact-lifecycle.md");

  for (const type of Object.values(ARTEFACT_TYPES)) {
    assert.match(doc, new RegExp(`\`${type.id}\``), `artefakto tipas nedokumentuotas: ${type.id}`);
  }
});

test("SKENERIS: dokumentuota lentelė apima visus skenuojamus tipus", () => {
  const doc = readDoc("artefact-lifecycle.md");

  for (const typeId of artefactScanner.scannableTypes()) {
    assert.match(doc, new RegExp(`\`${typeId}\``), `skenuojamas tipas nedokumentuotas: ${typeId}`);
  }
});

test("BŪSENOS: visos ištrynimo būsenos dokumentuotos", () => {
  const doc = readDoc("artefact-lifecycle.md");

  for (const status of Object.values(DELETION_STATUS)) {
    assert.match(doc, new RegExp(status), `ištrynimo būsena nedokumentuota: ${status}`);
  }

  for (const status of Object.values(tombstones.TOMBSTONE_STATUS)) {
    assert.match(doc, new RegExp(status), `žymos būsena nedokumentuota: ${status}`);
  }
});

test("RIBOS: dokumentas ĮVARDIJA, ko ištrynimas negarantuoja", () => {
  /**
   * Svarbiausias šio failo testas.
   *
   * Dokumentas be ribų skyriaus klaidina labiau nei jokio dokumento: jis
   * atrodo išsamus ir todėl patikimas. Tikrinam, kad kiekviena ŽINOMA riba
   * būtų įvardyta – ne kad tekstas gražus.
   */
  const doc = readDoc("deletion-guarantees.md");

  /**
   * Šablonai taikomi į KONKREČIUS teiginius, ne į atskirus žodžius.
   *
   * Pirmoji versija ieškojo vien `/restart/i` – o žodis „restarto" dokumente
   * pasitaiko keturis kartus visai kitame kontekste (pvz. „valymas paleidžiamas
   * iškart po starto"). Tad ribos pašalinimas testo nesulaužydavo: jis rasdavo
   * žodį kitoje vietoje ir nurimdavo.
   */
  const knownLimits = [
    { pattern: /žymos neišgyvena restarto/i, what: "žymos neišgyvena restarto" },
    { pattern: /atsarginė?s? kopij/i, what: "atsarginės kopijos" },
    { pattern: /trečiųjų šalių tiekėj/i, what: "trečiųjų šalių tiekėjai" },
    { pattern: /`upload_temp`, `conversion_temp`.*neskenuojam/i, what: "laikini failai dar neskenuojami" },
    { pattern: /nesustabdomas vidury/i, what: "vykdomas processor'ius nesustabdomas" },
  ];

  for (const limit of knownLimits) {
    assert.match(doc, limit.pattern, `riba neįvardyta: ${limit.what}`);
  }
});

test("RIBOS: gyvavimo ciklo dokumentas turi „Ko NEAPIMA\" skyrių", () => {
  const doc = readDoc("artefact-lifecycle.md");
  assert.match(doc, /NEAPIMA|NEGARANTUOJA/, "dokumentas privalo įvardyti savo ribas");
});

test("#20 SĄSAJA: atsarginių kopijų riba nurodo į atskirą issue", () => {
  /**
   * Kriptografinis ištrynimas per raktų valdymą yra už #19 ribų. Nuoroda į #20
   * paverčia tai matomu tęsiniu, o ne nutylėta spraga.
   */
  const doc = readDoc("deletion-guarantees.md");

  assert.match(doc, /#20/, "atsarginių kopijų riba turi nurodyti į #20");
});

test("AUDITAS: dokumentuota, kad subjekto ID yra PSEUDONIMIZUOTAS", () => {
  /**
   * Be šios pastabos operatorius, ieškantis audito įrašų pagal jobo ID,
   * nieko neras ir padarys išvadą, kad įrašų nėra – nors jie yra.
   */
  const doc = readDoc("deletion-guarantees.md");

  assert.match(doc, /pseudonimizuot/i, "pseudonimizacija turi būti paaiškinta");
  assert.match(doc, /pseudonymizeIdentifier/, "turi būti nurodyta konkreti funkcija");
});

test("EKSPLOATACIJA: dokumentuotas veiksmas nepavykus ištrynimui", () => {
  /**
   * `503` be instrukcijos, ką daryti, yra nenaudingas: operatorius nežino, ar
   * kartoti, ar eskaluoti.
   */
  const doc = readDoc("deletion-guarantees.md");

  assert.match(doc, /503/, "dalinio ištrynimo atsakymas turi būti dokumentuotas");
  assert.match(doc, /kartok|pakartot/i, "turi būti nurodyta, kad užklausa kartojama");
  assert.match(doc, /nonRetryable/, "turi būti paaiškinta, kada kartojimas nepadės");
});
