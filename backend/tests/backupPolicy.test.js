const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const backupPolicy = require("../utils/backupPolicy");
const backupManifest = require("../utils/backupManifest");
const { ARTEFACT_TYPES, PERSISTENCE, typesByPersistence } = require("../utils/artefactInventory");

/**
 * #20 PR1: KOPIJŲ POLITIKA IR MANIFESTAS.
 *
 * Šis etapas nieko nekopijuoja – jis apibrėžia, KAS bus kopijuojama, kokia
 * forma ir kaip patikrinti, ar kopija tinkama atkurti.
 */

test("POLITIKA: išvedama IŠ REGISTRO, ne rašoma atskirai", () => {
  /**
   * Antras, nepriklausomas sąrašas neišvengiamai išsiskirtų su registru:
   * naujas artefakto tipas atsirastų viename, bet ne kitame, ir liktų
   * nekopijuojamas TYLIAI.
   *
   * Tikrinam ryšį, ne konkretų sąrašą – kitaip testas irgi taptų trečiąja
   * kopija to paties.
   */
  const persistent = typesByPersistence(PERSISTENCE.PERSISTENT);

  for (const typeId of backupPolicy.includedTypes()) {
    assert.ok(persistent.includes(typeId), `${typeId} įtrauktas, bet nėra persistent`);
  }
});

test("POLITIKA: efemeriški artefaktai NIEKADA nekopijuojami", () => {
  /**
   * Kopija su efemerišku artefaktu reikštų ANTRĄ asmens duomenų kopiją ten,
   * kur jos sąmoningai nebuvo. Visa #4/#5/#8 redakcijos sistema remiasi tuo,
   * kad eksportai ir redaguotos transkripcijos nesaugomos.
   */
  for (const typeId of typesByPersistence(PERSISTENCE.EPHEMERAL)) {
    assert.equal(backupPolicy.isIncluded(typeId), false, `${typeId} NEGALI patekti į kopiją`);
  }
});

test("POLITIKA: laikini artefaktai nekopijuojami", () => {
  for (const typeId of typesByPersistence(PERSISTENCE.TEMPORARY)) {
    assert.equal(backupPolicy.isIncluded(typeId), false, `${typeId}: kopija atkurtų šiukšles`);
  }
});

test("POLITIKA: eilės įrašas NEĮTRAUKIAMAS, nors yra persistent", () => {
  /**
   * Vienintelė išimtis, kuri NEIŠPLAUKIA iš persistencijos klasės.
   *
   * `queue_record` išgyvena restartą, bet tai VYKDYMO BŪSENA, ne duomenys.
   * Atkūrus ją, eilė bandytų tęsti darbus, kurių kontekstas jau nebeegzistuoja
   * – tiekėjų sesijos, laikini failai, worker'ių būsena. Rezultatas būtų ne
   * atkūrimas, o klaidų srautas.
   */
  assert.equal(backupPolicy.isIncluded(ARTEFACT_TYPES.QUEUE_RECORD.id), false);

  const excluded = backupPolicy.excludedTypes().find((e) => e.type === ARTEFACT_TYPES.QUEUE_RECORD.id);
  assert.ok(excluded, "išimtis turi būti sąraše");
  assert.match(excluded.reason, /vykdymo būsena/i, "išimtis privalo turėti priežastį");
});

test("POLITIKA: KIEKVIENAS neįtrauktas tipas turi priežastį", () => {
  /**
   * „Neįtraukta" ir „pamiršta įtraukti" turi atrodyti skirtingai – ta pati
   * taisyklė kaip artefaktų skeneryje (#19 PR4).
   */
  for (const entry of backupPolicy.excludedTypes()) {
    assert.ok(entry.reason && entry.reason.length > 10, `${entry.type}: priežastis per trumpa arba jos nėra`);
  }
});

test("POLITIKA: kiekvienas registro tipas yra ARBA įtrauktas, ARBA neįtrauktas su priežastimi", () => {
  /**
   * Deny-by-default patikra: naujas artefakto tipas privalo atsidurti viename
   * iš dviejų sąrašų. Tylus praleidimas reikštų tipą, apie kurį politika
   * nieko nesako.
   */
  const included = new Set(backupPolicy.includedTypes());
  const excluded = new Set(backupPolicy.excludedTypes().map((e) => e.type));

  for (const type of Object.values(ARTEFACT_TYPES)) {
    const inOne = included.has(type.id) !== excluded.has(type.id);
    assert.ok(inOne, `${type.id}: turi būti TIKSLIAI viename sąraše`);
  }
});

test("RETENCIJA: numatytoji reikšmė galioja, netinkama nepriimama", () => {
  assert.equal(backupPolicy.retentionDays({}), 7);
  assert.equal(backupPolicy.retentionDays({ BACKUP_RETENTION_DAYS: "30" }), 30);

  // Netinkamos reikšmės krenta į numatytąją; startup jas atmeta atskirai.
  assert.equal(backupPolicy.retentionDays({ BACKUP_RETENTION_DAYS: "abc" }), 7);
  assert.equal(backupPolicy.retentionDays({ BACKUP_RETENTION_DAYS: "0" }), 7);
});

test("KOPIJOS: numatytai IŠJUNGTOS", () => {
  /**
   * Kopija yra papildoma asmens duomenų saugykla, tad jos atsiradimas turi
   * būti sąmoningas sprendimas, ne šalutinis atnaujinimo poveikis.
   */
  assert.equal(backupPolicy.isEnabled({}), false);
  assert.equal(backupPolicy.isEnabled({ BACKUP_ENABLED: "true" }), true);
  assert.equal(backupPolicy.isEnabled({ BACKUP_ENABLED: "TRUE" }), true);
  assert.equal(backupPolicy.isEnabled({ BACKUP_ENABLED: "1" }), false, "tik `true` įjungia");
});

test("MANIFESTAS: turi visus privalomus laukus", () => {
  const buffer = Buffer.from("turinys");
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 3, bytes: 512 }],
    checksum: backupManifest.computeChecksum(buffer),
  });

  for (const field of backupManifest.REQUIRED_FIELDS) {
    assert.ok(manifest[field] !== undefined, `trūksta lauko: ${field}`);
  }

  assert.equal(backupManifest.validateManifest(manifest).valid, true);
});

test("MANIFESTAS: NĖRA asmens duomenų – tik metaduomenys", () => {
  /**
   * Manifestą turi būti galima peržiūrėti nepasiekiant paties turinio – kitaip
   * diagnostika reikštų prieigą prie duomenų.
   */
  const manifest = backupManifest.createManifest({
    contents: [{ type: "transcript", count: 2, bytes: 100 }],
    checksum: "abc123",
  });

  /**
   * Tikrinam STRUKTŪRĄ, ne teksto ilgį.
   *
   * Pirmoji versija ieškojo ilgų eilučių regex'u – ir pagavo `excludedTypes`
   * priežasčių tekstus, kurie yra metaduomenys, o ne turinys. Tikslus
   * klausimas kitas: ar `contents` įrašuose yra kas nors, išskyrus tipą ir
   * skaičius?
   */
  const ALLOWED_CONTENT_KEYS = new Set(["type", "count", "bytes"]);

  for (const entry of manifest.contents) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        ALLOWED_CONTENT_KEYS.has(key),
        `manifesto turinyje neleidžiamas laukas "${key}" – čia tik metaduomenys`
      );
    }
    assert.equal(typeof entry.count, "number");
    assert.equal(typeof entry.bytes, "number");
  }

  const serialized = JSON.stringify(manifest);
  assert.ok(!/\/tmp\/|\/home\/|\/var\//.test(serialized), "jokių failų kelių");
});

test("MANIFESTAS: kūrimas ATMETA tipus, kurių politika neleidžia", () => {
  /**
   * Tikrinama KURIANT, ne tik atkuriant: tokią klaidą pigiau sustabdyti iš
   * karto, nei aptikti po metų, kai kopija jau egzistuoja.
   */
  assert.throws(
    () =>
      backupManifest.createManifest({
        contents: [{ type: ARTEFACT_TYPES.EXPORT_ORIGINAL.id, count: 1, bytes: 10 }],
        checksum: "x",
      }),
    (e) => e.code === "BACKUP_MANIFEST_INVALID"
  );
});

test("MANIFESTAS: be kontrolinės sumos nesukuriamas", () => {
  assert.throws(
    () => backupManifest.createManifest({ contents: [], checksum: null }),
    (e) => e.code === "BACKUP_MANIFEST_INVALID"
  );
});

test("VALIDACIJA: FAIL-CLOSED – trūkstamas laukas atmeta kopiją", () => {
  /**
   * Atkūrimas iš kopijos, kuria negalima pasitikėti, blogiau nei atsisakymas:
   * jis atrodo kaip sėkmė.
   */
  const buffer = Buffer.from("x");
  const valid = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 1 }],
    checksum: backupManifest.computeChecksum(buffer),
  });

  for (const field of backupManifest.REQUIRED_FIELDS) {
    const broken = { ...valid };
    delete broken[field];

    const result = backupManifest.validateManifest(broken);
    assert.equal(result.valid, false, `be lauko "${field}" manifestas turi būti atmestas`);
  }
});

test("VALIDACIJA: manifesto visai nėra", () => {
  assert.equal(backupManifest.validateManifest(null).valid, false);
  assert.equal(backupManifest.validateManifest(undefined).valid, false);
  assert.equal(backupManifest.validateManifest("ne objektas").valid, false);
});

test("SUDERINAMUMAS: NAUJESNĖ kopija į senesnę sistemą atmetama", () => {
  /**
   * Naujesnis formatas gali turėti laukų, kurių ši versija nesupranta, ir
   * atkūrimas juos TYLIAI prarastų – blogiau nei atviras atsisakymas, nes
   * atrodytų kaip sėkmė.
   */
  const future = backupPolicy.BACKUP_FORMAT_VERSION + 1;
  const result = backupPolicy.checkRestoreCompatibility(future);

  assert.equal(result.compatible, false);
  assert.match(result.reason, /naujesne/i);
});

test("SUDERINAMUMAS: netinkama versija atmetama", () => {
  for (const bad of [null, undefined, "1", 1.5, NaN]) {
    assert.equal(
      backupPolicy.checkRestoreCompatibility(bad).compatible,
      false,
      `versija ${JSON.stringify(bad)} turėjo būti atmesta`
    );
  }

  assert.equal(backupPolicy.checkRestoreCompatibility(backupPolicy.BACKUP_FORMAT_VERSION).compatible, true);
});

test("KONTROLINĖ SUMA: pakitęs turinys aptinkamas", () => {
  const original = Buffer.from("originalus turinys");
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: original.length }],
    checksum: backupManifest.computeChecksum(original),
  });

  assert.equal(backupManifest.verifyChecksum(manifest, original), true);
  assert.equal(backupManifest.verifyChecksum(manifest, Buffer.from("pakeistas turinys")), false);

  // Net vieno baito pokytis.
  const almostSame = Buffer.from("originalus turiniyx".slice(0, original.length));
  assert.equal(backupManifest.verifyChecksum(manifest, almostSame), false);
});

test("RETENCIJA: terminas įrašomas Į MANIFESTĄ, ne skaičiuojamas atkuriant", () => {
  /**
   * Politika gali pasikeisti; kopijai galioja ta, kuri veikė ją kuriant.
   * Priešingu atveju sumažinus `BACKUP_RETENTION_DAYS` senos kopijos staiga
   * taptų „pasibaigusiomis" atgaline data, o padidinus – atgytų.
   */
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 1 }],
    checksum: "x",
    env: { BACKUP_RETENTION_DAYS: "30" },
  });

  assert.equal(manifest.policy.retentionDays, 30);
  assert.ok(manifest.expiresAt, "terminas privalo būti manifeste");

  const days = (Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt)) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 30) < 0.1, `laukta ~30 dienų, gauta ${days}`);
});

test("RETENCIJA: pasibaigusi kopija atpažįstama", () => {
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 1 }],
    checksum: "x",
  });

  assert.equal(backupManifest.isExpired(manifest), false);
  assert.equal(backupManifest.isExpired(manifest, Date.parse(manifest.expiresAt) + 1), true);
});

test("STARTUP: netinkama `BACKUP_RETENTION_DAYS` stabdo paleidimą", () => {
  /**
   * Ši reikšmė apibrėžia FAKTINĮ ištrynimo langą. Tyliai virtusi numatytąja,
   * ji reikštų, kad privatumo politikoje deklaruotas terminas neatitinka
   * tikrovės.
   */
  const { validateConfig } = require("../utils/startupChecks");

  for (const bad of ["abc", "0", "-1", "7xyz", "9999"]) {
    const { errors } = validateConfig({ BACKUP_RETENTION_DAYS: bad });
    assert.ok(
      errors.some((e) => e.includes("BACKUP_RETENTION_DAYS")),
      `"${bad}" turėjo stabdyti paleidimą`
    );
  }

  assert.deepEqual(
    validateConfig({ BACKUP_RETENTION_DAYS: "7" }).errors.filter((e) => /BACKUP/.test(e)),
    []
  );
});

test("MANIFESTAS: `applicationVersion` ATSKIRAS nuo formato versijos", () => {
  /**
   * Jos keičiasi nepriklausomai: daug programos leidimų gali dalintis tuo
   * pačiu kopijos formatu.
   *
   * Formato versija atsako „ar šią kopiją apskritai galima perskaityti";
   * programos – „kokia sistema ją sukūrė". Operatoriui antrasis klausimas
   * svarbus PRIEŠ atkūrimą, ir atsakymas turi būti matomas neišpakavus kopijos.
   */
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 10 }],
    checksum: "x",
  });

  assert.equal(manifest.formatVersion, backupPolicy.BACKUP_FORMAT_VERSION);
  assert.ok(manifest.applicationVersion, "programos versija privaloma");

  // Ir ji sutampa su tikrąja - ne išgalvota.
  const packageVersion = require("../package.json").version;
  assert.equal(manifest.applicationVersion, packageVersion);
});

test("MANIFESTAS: be `applicationVersion` atmetamas", () => {
  const manifest = backupManifest.createManifest({
    contents: [{ type: "job_record", count: 1, bytes: 10 }],
    checksum: "x",
  });

  const broken = { ...manifest };
  delete broken.applicationVersion;

  assert.equal(backupManifest.validateManifest(broken).valid, false);
});

test("KONTROLINĖ SUMA: dokumentuota, kad ji NEAPSAUGO nuo tyčinio pakeitimo", () => {
  /**
   * Sąžiningumo patikra grėsmių modeliui.
   *
   * Kas gali pakeisti kopijos turinį, gali perskaičiuoti ir sumą – jokios
   * paslapties čia nedalyvauja. Be aiškaus įrašo apie tai lengva susidaryti
   * įspūdį, kad kontrolinė suma jau suteikia saugumo garantiją, ir neapsaugoti
   * saugyklos prieigos.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "utils", "backupManifest.js"), "utf8");

  assert.match(source, /NE NUO PAKEITIMO|neapsaugo nuo tyčinio/i, "riba turi būti įvardyta kode");
  assert.match(source, /paraš|HMAC/i, "turi būti nurodytas sprendimas (parašas su raktu)");
});

test("7.6 KABLIUKAS: `audit_log` išbraukimas IŠVEDAMAS iš politikos, ne surašytas", () => {
  /**
   * ⚠️ TAI KABLIUKAS, KURIO REIKIA 7.6 DoD („prieš kopiją įrašyta unikali audito
   * eilutė po restore NERANDAMA").
   *
   * Testas privalo gauti aibę IŠ POLITIKOS. Įrašius `audit_log` literalu, jis
   * taptų rankomis palaikomu sąrašu, kuris tyliai išsiskiria: politika galėtų
   * pakeisti išbraukimą, o testas toliau tvirtintų seną tiesą.
   */
  const { excludedTables, excludedTypes, TABLE_BY_TYPE } = require("../utils/backupPolicy");
  const { ARTEFACT_TYPES } = require("../utils/artefactInventory");

  const lentelės = excludedTables();

  assert.ok(
    lentelės.includes(TABLE_BY_TYPE[ARTEFACT_TYPES.AUDIT_ENTRY.id]),
    "audito lentelė privalo būti išbraukimų aibėje"
  );

  /** ⚠️ Aibė ateina iš politikos: išbraukus tipą, dingsta ir lentelė. */
  const išbrauktiTipai = excludedTypes().map((į) => į.type);
  assert.ok(
    išbrauktiTipai.includes(ARTEFACT_TYPES.AUDIT_ENTRY.id),
    "prielaida: auditas išbrauktas politikos lygiu"
  );

  for (const lentelė of lentelės) {
    const tipas = Object.entries(TABLE_BY_TYPE).find(([, l]) => l === lentelė);
    assert.ok(tipas, `${lentelė} nėra susieta su jokiu artefakto tipu`);
    assert.ok(
      išbrauktiTipai.includes(tipas[0]),
      `${lentelė} aibėje, nors jos tipas ${tipas[0]} NĖRA išbrauktas - aibė nebeišvedama`
    );
  }
});

test("ŽEMĖLAPIS: KIEKVIENAS artefakto tipas turi lentelės įrašą", () => {
  /**
   * ⚠️ BE ŠIOS PATIKROS PROBLEMA TIK PERSIKELTŲ.
   *
   * Rankomis palaikomas sąrašas teste būtų pakeistas rankomis palaikomu
   * žemėlapiu kode. Naujas `ARTEFACT_TYPES` narys be įrašo `TABLE_BY_TYPE`
   * tyliai iškristų iš `excludedTables()`, ir 7.6 patikra jo nebematytų.
   *
   * `null` yra TEISĖTA reikšmė - „šis tipas neturi savo lentelės". Trūkstamas
   * raktas - ne.
   */
  const { TABLE_BY_TYPE } = require("../utils/backupPolicy");
  const { ARTEFACT_TYPES } = require("../utils/artefactInventory");

  const trūksta = Object.values(ARTEFACT_TYPES)
    .map((t) => t.id)
    .filter((id) => !(id in TABLE_BY_TYPE));

  assert.deepEqual(
    trūksta,
    [],
    `TABLE_BY_TYPE neturi įrašo: ${trūksta.join(", ")}. Pridėkite lentelės vardą arba ` +
      "eksplicitinį `null`, jei tipas savo lentelės neturi."
  );

  /**
   * ⚠️ RAKTO BUVIMO NEPAKANKA (#233 Codex raundas 3, #3).
   *
   * `id in TABLE_BY_TYPE` tikrina tik savybės buvimą, tad rašybos klaida
   * (`TABLES.suklysta` → `undefined`) šią patikrą praeidavo. Pasekmė nėra
   * teorinė: `excludedTables()` `undefined` reikšmes išfiltruoja, tad lentelė
   * TYLIAI iškristų iš išbrauktųjų - t. y. audito eilutės patektų į kopiją,
   * nors politika sako priešingai.
   *
   * `null` lieka teisėtas - jis reiškia sąmoningą „šis tipas savo lentelės
   * neturi". Viskas kita privalo būti netuščias lentelės vardas.
   */
  const blogosReiksmes = Object.entries(TABLE_BY_TYPE).filter(
    ([, lentele]) => lentele !== null && !(typeof lentele === "string" && lentele.trim() !== "")
  );

  assert.deepEqual(
    blogosReiksmes.map(([id, lentele]) => `${id}=${String(lentele)}`),
    [],
    "kiekviena reikšmė privalo būti arba `null` sentinelis, arba netuščias lentelės vardas"
  );

  /** Ir atvirkščiai: žemėlapyje neturi likti tipų, kurių nebėra. */
  const žinomi = new Set(Object.values(ARTEFACT_TYPES).map((t) => t.id));
  for (const id of Object.keys(TABLE_BY_TYPE)) {
    assert.ok(žinomi.has(id), `TABLE_BY_TYPE mini nežinomą tipą "${id}"`);
  }
});
