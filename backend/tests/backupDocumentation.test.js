const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const backupPolicy = require("../utils/backupPolicy");
const backupEncryption = require("../utils/backupEncryption");
const secretsInventory = require("../utils/secretsInventory");
const maintenanceLock = require("../utils/maintenanceLock");
const { PERMISSIONS } = require("../utils/permissions");
const { STEPS } = require("../services/restoreService");

/**
 * #20 PR5: RUNBOOK TURI ATITIKTI TIKROVĘ.
 *
 * Runbook'as yra pažadas operatoriui. Pasenęs jis blogesnis nei jokio: žmogus
 * nelaimės metu vykdys žingsnius, kurie nebeveikia, ir sužinos apie tai
 * blogiausiu momentu.
 *
 * Šie testai NETIKRINA teksto kokybės. Jie tikrina, kad dokumente minimi
 * dalykai realiai egzistuoja, o realiai egzistuojantys būtų paminėti.
 */

const DOCS = path.join(__dirname, "..", "..", "docs");

function runbook() {
  return fs.readFileSync(path.join(DOCS, "backup-runbook.md"), "utf8");
}

test("RUNBOOK: dokumentas egzistuoja", () => {
  assert.ok(
    fs.existsSync(path.join(DOCS, "backup-runbook.md")),
    "Trūksta backup-runbook.md\n" +
      "Jei jis PERVADINTAS, atnaujinkite: šį testą, README nuorodas ir docs/security-test-matrix.md."
  );
});

test("RUNBOOK: kopijuojamų artefaktų sąrašas SUTAMPA su politika", () => {
  /**
   * Sąrašas dokumente ir politika kode yra du atskiri tekstai, kurie ilgainiui
   * išsiskiria. Operatorius, planuojantis atkūrimą pagal dokumentą, tikėtųsi
   * duomenų, kurių kopijoje nėra.
   */
  const doc = runbook();

  for (const typeId of backupPolicy.includedTypes()) {
    assert.match(doc, new RegExp(`\`${typeId}\``), `įtraukiamas tipas nedokumentuotas: ${typeId}`);
  }

  for (const entry of backupPolicy.excludedTypes()) {
    assert.match(doc, new RegExp(`\`${entry.type}\``), `neįtraukiamas tipas nedokumentuotas: ${entry.type}`);
  }
});

test("RUNBOOK: numatytosios reikšmės SUTAMPA su kodu", () => {
  const doc = runbook();

  // Retencija.
  const retention = doc.match(/BACKUP_RETENTION_DAYS=(\d+)/);
  assert.ok(retention, "retencija turi būti dokumentuota");
  assert.equal(
    Number(retention[1]),
    backupPolicy.retentionDays({}),
    "dokumentuota retencija išsiskyrė su kodu"
  );

  // Užrakto trukmė.
  const lockMinutes = doc.match(/ne ilgiau kaip (\d+) min/);
  assert.ok(lockMinutes, "užrakto trukmė turi būti dokumentuota");
  assert.equal(
    Number(lockMinutes[1]),
    maintenanceLock.DEFAULT_MAX_HOLD_MS / 60000,
    "dokumentuota užrakto trukmė išsiskyrė su kodu"
  );
});

test("RUNBOOK: paslapčių skaičius SUTAMPA su inventoriumi", () => {
  /**
   * Skaičius dokumente yra tikrinamas teiginys, ne apytikslė nuoroda. Jei
   * inventorius papildomas, o dokumentas ne, operatorius rotuotų ne visas.
   */
  const doc = runbook();

  const total = doc.match(/\*\*(\d+) paslapčių\*\*/);
  assert.ok(total, "bendras paslapčių skaičius turi būti dokumentuotas");
  assert.equal(Number(total[1]), secretsInventory.SECRET_NAMES.length);

  const external = doc.match(/tiekėjų raktai\)\s*\|\s*(\d+)/);
  assert.ok(external, "išorinių paslapčių skaičius turi būti dokumentuotas");
  assert.equal(Number(external[1]), secretsInventory.externallyIssuedSecrets().length);
});

test("RUNBOOK: atkūrimo grandinės žingsniai VISI paminėti", () => {
  /**
   * Operatorius, gavęs `failedStep`, turi rasti jį dokumente. Nedokumentuotas
   * žingsnis reiškia, kad jis liks nesuprantamas būtent tada, kai reikia
   * greitai apsispręsti.
   */
  const doc = runbook();

  const documented = {
    [STEPS.MANIFEST]: /manifestas/i,
    [STEPS.FORMAT]: /formatas/i,
    [STEPS.APPLICATION]: /programos versija/i,
    [STEPS.CHECKSUM]: /kontrolinė suma/i,
    [STEPS.DECRYPTED]: /dešifravimas/i,
    [STEPS.CONTENT]: /turinys/i,
    [STEPS.SECRETS]: /paslaptys/i,
    [STEPS.CONFIGURATION]: /konfigūracija/i,
    [STEPS.PRIVACY]: /privatumas/i,
    [STEPS.APPLIED]: /pritaikymas/i,
  };

  for (const [step, pattern] of Object.entries(documented)) {
    assert.match(doc, pattern, `grandinės žingsnis nedokumentuotas: ${step}`);
  }
});

test("RUNBOOK: šifravimo formatas ir algoritmas SUTAMPA su kodu", () => {
  const doc = runbook();

  assert.match(doc, new RegExp(backupEncryption.ALGORITHM, "i"), "algoritmas turi būti dokumentuotas");
});

test("RUNBOOK: leidimai įvardyti tiksliai", () => {
  const doc = runbook();

  assert.match(doc, new RegExp(`\`${PERMISSIONS.BACKUP_CREATE}\``));
  assert.match(doc, new RegExp(`\`${PERMISSIONS.BACKUP_RESTORE}\``));
});

test("RUNBOOK: KIEKVIENA žinoma riba įvardyta", () => {
  /**
   * SVARBIAUSIAS šio failo testas.
   *
   * Runbook be ribų skyriaus klaidina labiau nei jokio: jis atrodo išsamus ir
   * todėl patikimas. Tikrinam, kad kiekviena ŽINOMA riba būtų įvardyta — ne
   * kad tekstas gražus.
   */
  const doc = runbook();

  const knownLimits = [
    { pattern: /tik viename procese|vienas backend procesas/i, what: "užraktas vieno proceso" },
    { pattern: /nėra transakcinis|NĖRA transakcinis/i, what: "pritaikymas ne transakcinis" },
    { pattern: /[Rr]akto ID nėra/, what: "rakto ID nefiksuojamas" },
    { pattern: /tik vienas ankstesnis raktas|Palaikomas \*\*tik vienas\*\*/i, what: "viena rotacija" },
    { pattern: /ZIP nepalaikomas|ZIP atidėtas/i, what: "ZIP nepalaikomas" },
    { pattern: /best-effort/i, what: "paslapčių patikros ribos" },
    { pattern: /[Ss]erveris kopijų nesaugo/, what: "serveris kopijų nesaugo" },
    { pattern: /audito žurnale \*\*nebus\*\*|[Aa]tkuriami duomenys, ne jų istorija/, what: "auditas neatkuriamas" },
  ];

  for (const limit of knownLimits) {
    assert.match(doc, limit.pattern, `riba neįvardyta: ${limit.what}`);
  }
});

test("RUNBOOK: ĮSPĖJA nerotuoti raktų du kartus iš eilės", () => {
  /**
   * Tai vienintelė operacinė klaida, kuri NEGRĮŽTAMAI sunaikina kopijas.
   * Ji privalo būti ne paminėta, o išskirta.
   */
  const doc = runbook();

  assert.match(doc, /NEROTUOTI DU KARTUS|nerotuoti.*du kartus/i, "įspėjimas turi būti aiškiai matomas");
  assert.match(doc, /neatkuriamos/i, "pasekmė turi būti įvardyta");
});

test("RUNBOOK: įvardija, kad atkūrimas NEGRĄŽINA ištrintų duomenų", () => {
  /**
   * Svarbiausia #20 garantija: kopija negali tapti būdu apeiti #19 GDPR
   * ištrynimą. Jos nebuvimas runbook'e reikštų, kad operatorius jos nežino ir
   * negali parodyti auditoriui.
   */
  const doc = runbook();

  assert.match(doc, /negrįžta/i);
  assert.match(doc, /#19/, "sąsaja su ištrynimo garantijomis turi būti nurodyta");
  assert.match(doc, /šifruotoms kopijoms.*rotacijos keliui|rotacijos keliui/i, "abu keliai turi būti įvardyti");
});

test("RUNBOOK: dokumentuoti VISI atsakymų kodai, kuriuos grąžina maršrutai", () => {
  /**
   * Nedokumentuotas kodas nelaimės metu reiškia spėjimą. Tikrinam prieš
   * TIKRĄ maršruto kodą, ne prieš prisiminimus.
   */
  const doc = runbook();
  const routeSource = fs.readFileSync(path.join(__dirname, "..", "routes", "backup.js"), "utf8");

  const statuses = new Set(
    [...routeSource.matchAll(/res\.status\((\d{3})\)/g)].map((match) => match[1])
  );

  assert.ok(statuses.size >= 4, `per mažai rastų statusų: ${[...statuses].join(", ")}`);

  for (const status of statuses) {
    assert.match(doc, new RegExp(`\`${status}\``), `atsakymo kodas nedokumentuotas: ${status}`);
  }
});

test("RUNBOOK: atkūrimo pratybos įvardytos kaip BŪTINOS", () => {
  /**
   * Kopija, kuri niekada nebuvo atkurta, nėra patikrintas atkūrimo
   * mechanizmas — tai pačios #20 issue formuluotė.
   */
  const doc = runbook();

  assert.match(doc, /niekada nebuvo atkurta/i);
  assert.match(doc, /seniausia/i, "seniausios kopijos testas turi būti įvardytas");
});

test("RUNBOOK: audito raktų reikalavimas susietas su TEISINGA kopijos rūšimi", () => {
  /**
   * ⚠️ DOKUMENTACIJA NEGALI PRIEŠTARAUTI POLITIKAI (#231 Codex peržiūra, P2).
   *
   * Runbook'as §1 teigė, kad „be raktų kopija bevertė", ir liepė tikrinti
   * kopijos `audit_log`. Bet `createBackup()` serializuoja tik `jobs` ir
   * `audio`, o `audit_entry` yra išbrauktųjų sąraše - aplikacijos kopijoje
   * audito eilučių NĖRA. Nurodymas buvo neįvykdomas, o įspėjimas - klaidinantis
   * būtent ten, kur operatorius jį skaito atkūrimo metu.
   *
   * Tikrinama ne frazė, o SĄSAJA: jei politika audito įrašus išbraukia, tekstas
   * privalo tai pasakyti ir reikalavimą priskirti pilnai PostgreSQL kopijai.
   */
  const backupPolicy = require("../utils/backupPolicy");
  const { ARTEFACT_TYPES } = require("../utils/artefactInventory");

  const auditoTipas = ARTEFACT_TYPES.AUDIT_ENTRY.id;

  assert.ok(
    backupPolicy.excludedTypes().some((i) => i.type === auditoTipas),
    "prielaida: politika audito įrašus išbraukia"
  );

  assert.ok(
    backupPolicy.excludedTables().includes("audit_log"),
    "prielaida: išbraukta ir lentelė, ne tik tipas"
  );

  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs/backup-runbook.md"), "utf8");

  assert.ok(
    /aplikacijos kopijoje audito eilučių\s+\*\*apskritai nėra\*\*|audito eilučių \*\*apskritai nėra\*\*/i.test(
      doc.replace(/\n/g, " ")
    ),
    "runbook'as privalo pasakyti, kad aplikacijos kopijoje audito eilučių nėra"
  );

  assert.ok(
    doc.includes("PILNAI PostgreSQL kopijai") || doc.includes("pilnos PostgreSQL kopijos"),
    "raktų reikalavimas privalo būti priskirtas pilnai PostgreSQL kopijai"
  );

  /** Ir nurodymas tikrinti `audit_log` negali likti be to konteksto. */
  const patikra = doc.indexOf("SELECT DISTINCT hash_key_id FROM audit_log");
  assert.notEqual(patikra, -1, "prielaida: patikros užklausa dokumentuota");
  assert.ok(
    doc.slice(Math.max(0, patikra - 800), patikra).includes("pilnos PostgreSQL kopijos"),
    "`audit_log` patikra privalo būti aiškiai priskirta pilnai PostgreSQL kopijai"
  );
});
