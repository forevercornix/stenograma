const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.BACKUP_ENABLED = "true";

const secretsInventory = require("../utils/secretsInventory");
const backupEncryption = require("../utils/backupEncryption");
const { hasPermission, PERMISSIONS } = require("../utils/permissions");
const jobStore = require("../utils/jobStore");
const tombstones = require("../utils/deletionTombstones");
const backupService = require("../services/backupService");
const restoreService = require("../services/restoreService");
const { STEPS } = restoreService;

/**
 * #20 PR3: GYVAVIMO CIKLAS, RETENCIJA IR RAKTŲ VALDYMAS.
 */

test.after(() => {
  tombstones._stopSweepForTests();
});

/**
 * Minimalus GALIOJANTIS manifestas kriptografiniams unit testams.
 *
 * ⚠️ Be jo `v2` šifruoti NEGALIMA – manifestas yra formato sutarties dalis.
 * Pirmoji šių testų versija jo neperduodavo, ir tai buvo tylus požymis, kad
 * kelias be AAD atrodo normalus: testas, pavadintas „šifravimo ciklu", realiai
 * tikrino kitą formatą nei tas, kurį kuria produkcinis srautas.
 */
function testManifest(overrides = {}) {
  return {
    formatVersion: 1,
    applicationVersion: "1.2.0",
    encrypted: true,
    encryptionAlgorithm: `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`,
    snapshotTime: "2026-08-04T00:00:00.000Z",
    excludedInFlightJobs: 0,
    contents: [],
    ...overrides,
  };
}

async function backupOf() {
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 1 } });
  return backupService.createBackup({ actor: "sysadmin" });
}

/* ------------------------------------------------------------------ */
/* PASLAPČIŲ INVENTORIUS                                               */
/* ------------------------------------------------------------------ */

test("PASLAPTYS: sąrašas EKSPLICITINIS, ne pagal vardo šabloną", () => {
  /**
   * Taisyklė „viskas su `KEY` yra paslaptis" klysta ABIEM kryptimis:
   * `API_KEY_ROLE` yra rolės pavadinimas (#18 CodeQL kaip tik dėl to suveikė
   * klaidingai), o `HUGGINGFACE_TOKEN` neturi `KEY` žodžio, bet yra tikra
   * paslaptis.
   */
  assert.equal(secretsInventory.isSecret("API_KEY_ROLE"), false, "rolės pavadinimas NĖRA paslaptis");
  assert.equal(secretsInventory.isSecret("ANTHROPIC_MAX_TOKENS"), false, "skaitinė riba NĖRA paslaptis");

  assert.equal(secretsInventory.isSecret("HUGGINGFACE_TOKEN"), true, "be `KEY`, bet paslaptis");
  assert.equal(secretsInventory.isSecret("API_KEY"), true);
  assert.equal(secretsInventory.isSecret("AUTH_USERS"), true);
});

test("PASLAPTYS: kiekviena turi `unlocks` ir `rotation`", () => {
  /**
   * Be `unlocks` nutekėjus nebūtų aišku, kas paveikta. Be `rotation` rotacija
   * taptų archeologija – kiekvienas incidentas prasidėtų nuo klausimo „o kaip
   * šitą pakeisti?".
   */
  for (const secret of secretsInventory.SECRETS) {
    assert.ok(secret.unlocks && secret.unlocks.length > 15, `${secret.name}: unlocks per trumpas`);
    assert.ok(secret.rotation && secret.rotation.length > 15, `${secret.name}: rotation per trumpas`);
    assert.equal(typeof secret.externallyIssued, "boolean");
  }
});

test("PASLAPTYS: išorinės atskirtos nuo vidinių", () => {
  /**
   * Skirtumas praktinis: vidinę paslaptį galima pakeisti savarankiškai, o
   * išorinę reikia atšaukti tiekėjo konsolėje – ir jei to nepadarysi, senas
   * raktas lieka galiojantis net pakeitus konfigūraciją.
   */
  const external = secretsInventory.externallyIssuedSecrets().map((s) => s.name);

  assert.ok(external.includes("ANTHROPIC_API_KEY"));
  assert.ok(external.includes("HUGGINGFACE_TOKEN"));
  assert.ok(!external.includes("API_KEY"), "vidinis raktas neturi būti išorinių sąraše");

  for (const secret of secretsInventory.externallyIssuedSecrets()) {
    assert.match(secret.rotation, /atšaukti|perrinkti/i, `${secret.name}: rotacija turi minėti atšaukimą`);
  }
});

test("PASLAPTYS: aptinkamos REIKŠMĖS, ne vardai", () => {
  /**
   * Kintamojo vardas tekste yra nekenksmingas, o reikšmė – ne.
   */
  const env = { ANTHROPIC_API_KEY: "sk-ant-labai-slaptas-raktas" };

  assert.deepEqual(secretsInventory.findLeakedSecrets("ANTHROPIC_API_KEY nenustatytas", env), []);
  assert.deepEqual(secretsInventory.findLeakedSecrets("naudojam sk-ant-labai-slaptas-raktas", env), [
    "ANTHROPIC_API_KEY",
  ]);
});

test("PASLAPTYS: trumpos reikšmės ignoruojamos (klaidingi aliarmai)", () => {
  /**
   * Reikšmė „true" ar „1" tekste pasitaikytų atsitiktinai, ir kiekvienas toks
   * sutapimas būtų klaidingas aliarmas, kuris ilgainiui išmokytų ignoruoti
   * visą patikrą.
   */
  assert.deepEqual(secretsInventory.findLeakedSecrets("viskas true", { API_KEY: "true" }), []);
  assert.deepEqual(secretsInventory.findLeakedSecrets("skaičius 1", { API_KEY: "1" }), []);
});

test("PASLAPTYS: `configuredSecrets` grąžina TIK vardus", () => {
  const env = { API_KEY: "slaptas-raktas-123", ANTHROPIC_API_KEY: "sk-ant-xyz" };
  const configured = secretsInventory.configuredSecrets(env);

  assert.ok(configured.includes("API_KEY"));
  assert.ok(!JSON.stringify(configured).includes("slaptas-raktas-123"), "reikšmės negrąžinamos NIEKADA");
});

/* ------------------------------------------------------------------ */
/* ŠIFRAVIMAS IR RAKTŲ ROTACIJA                                        */
/* ------------------------------------------------------------------ */

test("ŠIFRAVIMAS: ciklas veikia, turinys neįskaitomas", () => {
  const key = backupEncryption.generateKey();
  const env = { BACKUP_ENCRYPTION_KEY: key };

  const envelope = backupEncryption.encrypt(Buffer.from("slaptas protokolo turinys"), { env: env, manifest: testManifest() });

  assert.ok(!JSON.stringify(envelope).includes("slaptas protokolo"), "turinys neturi būti įskaitomas");
  assert.equal(backupEncryption.decrypt(envelope, { env: env, manifest: testManifest() }).plaintext.toString(), "slaptas protokolo turinys");
});

test("ŠIFRAVIMAS: PAKEISTAS turinys aptinkamas (GCM žyma)", () => {
  /**
   * Tai uždaro spragą, kurią PR1 sąžiningai įvardijo: kontrolinė suma apsaugo
   * nuo sugadinimo, bet ne nuo tyčinio pakeitimo, nes jokios paslapties joje
   * nedalyvauja. GCM žyma tokią paslaptį įveda.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const envelope = backupEncryption.encrypt(Buffer.from("originalas"), { env: env, manifest: testManifest() });

  const tampered = { ...envelope, ciphertext: Buffer.from("pakeista").toString("base64") };

  assert.throws(
    () => backupEncryption.decrypt(tampered, { env: env, manifest: testManifest() }),
    (e) => e.code === "BACKUP_DECRYPTION_FAILED"
  );
});

test("ROTACIJA: senos kopijos LIEKA atkuriamos", () => {
  /**
   * ⚠️ BE ANKSTESNIO RAKTO ROTACIJA PADARYTŲ SENAS KOPIJAS ŠIUKŠLĖMIS
   * būtent tą akimirką, kai jų gali prireikti.
   */
  const senas = backupEncryption.generateKey();
  const naujas = backupEncryption.generateKey();

  const envelope = backupEncryption.encrypt(Buffer.from("sena kopija"), { env: { BACKUP_ENCRYPTION_KEY: senas }, manifest: testManifest() });

  const poRotacijos = { BACKUP_ENCRYPTION_KEY: naujas, BACKUP_ENCRYPTION_KEY_PREVIOUS: senas };
  const result = backupEncryption.decrypt(envelope, { env: poRotacijos, manifest: testManifest() });

  assert.equal(result.plaintext.toString(), "sena kopija");
  assert.equal(result.usedPreviousKey, true, "turi būti aišku, kad panaudotas SENAS raktas");
});

test("ROTACIJA: be ankstesnio rakto sena kopija NEATKURIAMA (fail-closed)", () => {
  const senas = backupEncryption.generateKey();
  const naujas = backupEncryption.generateKey();

  const envelope = backupEncryption.encrypt(Buffer.from("x"), { env: { BACKUP_ENCRYPTION_KEY: senas }, manifest: testManifest() });

  assert.throws(
    () => backupEncryption.decrypt(envelope, { env: { BACKUP_ENCRYPTION_KEY: naujas }, manifest: testManifest() }),
    (e) => e.code === "BACKUP_DECRYPTION_FAILED",
    "be senojo rakto turi kristi, o ne grąžinti šiukšles"
  );
});

test("RAKTAS: netinkamo ilgio atmetamas, o ne tyliai ištempiamas", () => {
  /**
   * Trumpesnis raktas priimamas NEBŪTŲ saugus, o tyliai jį „ištempti" reikštų
   * apsimesti turint 256 bitų raktą, kurio nėra.
   */
  for (const bad of ["abc", "1234", "z".repeat(64), "ab".repeat(20)]) {
    assert.throws(
      () => backupEncryption.currentKey({ BACKUP_ENCRYPTION_KEY: bad }),
      (e) => e.code === "BACKUP_KEY_INVALID",
      `raktas "${bad.slice(0, 10)}..." turėjo būti atmestas`
    );
  }

  assert.ok(backupEncryption.currentKey({ BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() }));
});

test("RAKTAS: generuojamas 64 hex simbolių", () => {
  const key = backupEncryption.generateKey();
  assert.match(key, /^[0-9a-f]{64}$/, "raktas turi būti 32 baitai hex formatu");
});

/* ------------------------------------------------------------------ */
/* ATKŪRIMO VALIDACIJA                                                 */
/* ------------------------------------------------------------------ */

test("ATKŪRIMAS: kopija su PASLAPTIMI atmetama", async () => {
  /**
   * Kopija su raktu yra paslapčių nutekėjimas – atkurti ją reikštų tą
   * nutekėjimą pakartoti ir, dar blogiau, priimti kaip normą.
   */
  const backup = await backupOf();

  const parsed = JSON.parse(backup.data.toString("utf8"));
  parsed.jobs[0].result = { pastaba: "raktas sk-ant-nutekejes-raktas-123" };

  const withSecret = Buffer.from(JSON.stringify(parsed), "utf8");
  const manifest = {
    ...backup.manifest,
    checksum: require("../utils/backupManifest").computeChecksum(withSecret),
  };

  const result = await restoreService.restoreBackup({
    manifest,
    data: withSecret,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-nutekejes-raktas-123" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.SECRETS);
  assert.match(result.reason, /ANTHROPIC_API_KEY/, "turi nurodyti KURIĄ paslaptį");
});

test("ATKŪRIMAS: pranešime yra paslapties VARDAS, ne reikšmė", async () => {
  /**
   * Priešingu atveju klaidos tekstas taptų ANTRU nutekėjimo kanalu.
   */
  const backup = await backupOf();

  const parsed = JSON.parse(backup.data.toString("utf8"));
  parsed.jobs[0].result = { x: "sk-ant-nutekejes-raktas-456" };
  const withSecret = Buffer.from(JSON.stringify(parsed), "utf8");

  const result = await restoreService.restoreBackup({
    manifest: { ...backup.manifest, checksum: require("../utils/backupManifest").computeChecksum(withSecret) },
    data: withSecret,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-nutekejes-raktas-456" },
  });

  assert.ok(!result.reason.includes("sk-ant-nutekejes-raktas-456"), "reikšmė NEGALI patekti į pranešimą");
});

test("ATKŪRIMAS: netinkama KONFIGŪRACIJA sustabdo", async () => {
  /**
   * Atkurti duomenys pateks į DABARTINĘ konfigūraciją. Jei ji netinkama,
   * atkūrimas duotų veikiančius duomenis neveikiančioje sistemoje, ir gedimas
   * pasirodytų vėliau, jau atrodydamas kaip atkūrimo problema.
   *
   * Naudojama TA PATI `startupChecks.validateConfig` kaip paleidžiant – dvi
   * validacijos ilgainiui išsiskirtų.
   */
  const backup = await backupOf();

  const result = await restoreService.restoreBackup({
    ...backup,
    env: { ...process.env, JOB_TTL_MINUTES: "abc" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.CONFIGURATION);
});

test("ATKŪRIMAS: NEIŠSAUGOJIMO režimas blokuoja", async () => {
  /**
   * Administratorius eksplicitiškai nurodė `PERSISTENT_STORAGE=false`, tad
   * sistema žada nelaikyti turinio. Atkūrus į ją kopiją, diske atsirastų
   * būtent tai, ko šis režimas žada neturėti – ir žadas taptų melu, nors
   * kiekvienas komponentas atskirai veiktų teisingai.
   */
  const backup = await backupOf();

  const result = await restoreService.restoreBackup({
    ...backup,
    env: { ...process.env, PERSISTENT_STORAGE: "false", REDIS_URL: "" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.PRIVACY);
});

test("ATKŪRIMAS: įprastas režimas be Redis NEBLOKUOJAMAS", async () => {
  /**
   * REGRESIJA, kurią padariau rašydamas: pirmoji privatumo patikros versija
   * tikrino `persistentStorage`, kuris reiškia „Redis saugykla" ir be
   * `REDIS_URL` yra `false` NET įprastame diegime. Ji blokavo visus atkūrimus
   * atmintinėje saugykloje – t. y. daugumą.
   */
  const backup = await backupOf();

  const result = await restoreService.restoreBackup({
    ...backup,
    env: { ...process.env, PERSISTENT_STORAGE: undefined, REDIS_URL: "" },
  });

  assert.equal(result.ok, true, `įprastas atkūrimas neturi būti blokuojamas: ${result.reason}`);
});

/* ------------------------------------------------------------------ */
/* RBAC                                                                */
/* ------------------------------------------------------------------ */

test("RBAC: leidimų LENTELĖ – kopijos priskirtos tik administratoriui", () => {
  /**
   * ⚠️ ŠIS TESTAS TIKRINA LENTELĘ, NE ĮĖJIMO TAŠKĄ.
   *
   * HTTP maršrutų kopijoms dar nėra, tad negalima teigti, kad „operatorius
   * negali sukurti kopijos" – galima teigti tik tiek, kad leidimas jam
   * nepriskirtas.
   *
   * Skirtumas svarbus: tai tiksliai ta klaidų klasė, kuri jau pasitaikė su
   * šifravimu – modulis egzistuoja, testai žali, bet produkcinis kelias jo
   * nekviečia.
   */
  /**
   * Kopija yra VISŲ duomenų nuotrauka vienoje vietoje – galingiausias
   * eksportas, koks įmanomas. Atkūrimas dar destruktyvesnis: jis perrašo
   * esamą būseną, tad griežtesnis net už `job:delete`.
   */
  assert.equal(hasPermission("operator", PERMISSIONS.BACKUP_CREATE), false);
  assert.equal(hasPermission("operator", PERMISSIONS.BACKUP_RESTORE), false);

  assert.equal(hasPermission("administrator", PERMISSIONS.BACKUP_CREATE), true);
  assert.equal(hasPermission("administrator", PERMISSIONS.BACKUP_RESTORE), true);
});

test("RBAC: įėjimo taškas JAU YRA – garantija tikrinama integraciniais testais", () => {
  /**
   * SARGINIS TESTAS SUVEIKĖ KAIP SUPROJEKTUOTA.
   *
   * PR3 jis krito iškart, kai atsirado `routes/backup.js` – ir taip privertė
   * pakeisti jį realiu įrodymu, o ne palikti garantiją neįrodytą.
   *
   * Dabar tikrinam PRIEŠINGĄ dalyką: kad maršrutas egzistuoja IR kad jame yra
   * leidimų patikros. Realus RBAC elgesys (401/403/leidžiama) tikrinamas per
   * HTTP `backupRoutes.route` teste.
   */
  const fs = require("fs");
  const path = require("path");
  const routePath = path.join(__dirname, "..", "routes", "backup.js");

  assert.ok(fs.existsSync(routePath), "kopijų maršrutas turi egzistuoti");

  const source = fs.readFileSync(routePath, "utf8");

  assert.match(source, /requirePermission\(PERMISSIONS\.BACKUP_CREATE\)/, "kūrimas turi tikrinti leidimą");
  assert.match(source, /requirePermission\(PERMISSIONS\.BACKUP_RESTORE\)/, "atkūrimas turi tikrinti leidimą");
});

test("RBAC: leidimai deny-by-default ir nežinomiems", () => {
  assert.equal(hasPermission("backup-operator", PERMISSIONS.BACKUP_CREATE), false);
  assert.equal(hasPermission(null, PERMISSIONS.BACKUP_RESTORE), false);
});

/* ------------------------------------------------------------------ */
/* ŠIFRAVIMAS REALIAME SRAUTE                                          */
/* ------------------------------------------------------------------ */

test("SRAUTAS: kopija REALIAI šifruojama, kai raktas nustatytas", async () => {
  /**
   * SPRAGA, kurią rado review: šifravimo modulis buvo parašytas ir ištestuotas,
   * bet NIEKUR nenaudojamas – `createBackup` grąžindavo atvirą JSON.
   *
   * Ištestuotas modulis, kurio niekas nekviečia, yra blogiau nei jokio: jis
   * sukuria įspūdį, kad funkcija veikia.
   */
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { slaptas: "PROTOKOLO TURINYS" } });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const { manifest, data } = await backupService.createBackup({ actor: "sysadmin", env });

  assert.equal(manifest.encrypted, true, "manifestas turi žymėti šifravimą");
  assert.match(manifest.encryptionAlgorithm, /aes-256-gcm/, "algoritmas turi būti užfiksuotas");

  const raw = data.toString("utf8");
  assert.ok(!raw.includes("PROTOKOLO TURINYS"), "turinys NEGALI būti įskaitomas kopijoje");
  assert.ok(!raw.includes(job.id), "net jobo ID neturi būti atviras");
});

test("SRAUTAS: be rakto kopija NEšifruojama ir tai matoma manifeste", async () => {
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: "" };
  const { manifest } = await backupService.createBackup({ actor: "sysadmin", env });

  assert.equal(manifest.encrypted, false);
  assert.equal(manifest.encryptionAlgorithm, null);
});

test("SRAUTAS: šifruota kopija ATKURIAMA per pilną grandinę", async () => {
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 42 } });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  await jobStore.system.remove(job.id);

  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin", env });

  assert.equal(result.ok, true, `atkūrimas nepavyko: ${result.reason}`);
  assert.ok(result.completedSteps.includes(STEPS.DECRYPTED));

  const restored = await jobStore.system.get(job.id);
  assert.ok(restored, "jobas turi grįžti");
  assert.equal(restored.result.x, 42, "turinys turi būti teisingai dešifruotas");
});

test("SRAUTAS: šifruota kopija su NETINKAMU raktu neatkuriama", async () => {
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 1 } });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  const svetimas = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const result = await restoreService.restoreBackup({ ...backup, env: svetimas });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.DECRYPTED);
  assert.ok(!result.reason.includes(env.BACKUP_ENCRYPTION_KEY), "raktas NEGALI patekti į pranešimą");
});

test("SRAUTAS: ROTACIJA – kopija atkuriama ankstesniu raktu", async () => {
  /**
   * Pilnas rotacijos scenarijus per tikrą srautą, ne vien modulio lygiu.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 7 } });

  const senas = backupEncryption.generateKey();
  const backup = await backupService.createBackup({
    actor: "sysadmin",
    env: { ...process.env, BACKUP_ENCRYPTION_KEY: senas },
  });

  await jobStore.system.remove(job.id);

  // Raktas pakeistas; senasis paliktas rotacijai.
  const poRotacijos = {
    ...process.env,
    BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey(),
    BACKUP_ENCRYPTION_KEY_PREVIOUS: senas,
  };

  const result = await restoreService.restoreBackup({ ...backup, env: poRotacijos });

  assert.equal(result.ok, true, `rotacija turi išsaugoti senas kopijas: ${result.reason}`);
  assert.equal((await jobStore.system.get(job.id)).result.x, 7);
});

test("SRAUTAS: kontrolinė suma dengia ŠIFRUOTĄ turinį", async () => {
  /**
   * Suma skaičiuojama nuo to, kas REALIAI saugoma. Skaičiuojant nuo atviro
   * teksto atkūrimas turėtų pirma dešifruoti, kad galėtų patikrinti vientisumą
   * – ir sugadintas failas būtų aptiktas tik po dešifravimo bandymo, kai
   * priežastis jau dviprasmiška (sugadinta ar netinkamas raktas?).
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  const corrupted = Buffer.from(backup.data.toString("utf8").replace(/.$/, "X"));
  const result = await restoreService.restoreBackup({ manifest: backup.manifest, data: corrupted, env });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.CHECKSUM, "sugadinimas turi būti aptiktas PRIEŠ dešifravimą");
});

/* ------------------------------------------------------------------ */
/* MANIFESTO AUTENTIŠKUMAS (AAD)                                       */
/* ------------------------------------------------------------------ */

test("AAD: PAKEISTAS manifesto laukas sulaužo dešifravimą", async () => {
  /**
   * GCM autentifikuoja tik `cipher.update()` turinį. Manifestas lieka už žymos
   * ribų, o atkūrimas remiasi būtent juo. Kontrolinė suma nepadeda: kas gali
   * pakeisti failus, gali ją perskaičiuoti.
   *
   * AAD tai paverčia neįmanomu.
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  /**
   * `applicationVersion` čia SĄMONINGAI nėra: jį pakeitus grandinė sustoja
   * ANKSČIAU – versijos suderinamumo žingsnyje. Tai teisinga (pigesnė patikra
   * eina pirma), bet reiškia, kad AAD apsaugos tuo atveju nepamatytume.
   *
   * Tikrinam laukus, kurie grandinės anksčiau nesustabdo – tik jie įrodo, kad
   * apsauga ateina BŪTENT iš AAD.
   */
  for (const [field, value] of [
    ["snapshotTime", "2001-01-01T00:00:00.000Z"],
    ["excludedInFlightJobs", 999],
  ]) {
    const forged = { ...backup.manifest, [field]: value };

    const result = await restoreService.restoreBackup({ manifest: forged, data: backup.data, env });

    assert.equal(result.ok, false, `pakeistas \`${field}\` turėjo sulaužyti atkūrimą`);
    assert.equal(result.failedStep, STEPS.DECRYPTED, `\`${field}\`: apsauga turi ateiti iš AAD`);
  }

  // `applicationVersion` apsaugotas irgi - tik anksčiau esančiu žingsniu.
  const wrongVersion = await restoreService.restoreBackup({
    manifest: { ...backup.manifest, applicationVersion: "0.1.0" },
    data: backup.data,
    env,
  });
  assert.equal(wrongVersion.ok, false);
});

test("AAD: turinio SUKEITIMAS tarp dviejų kopijų atmetamas", async () => {
  /**
   * Be AAD užpuolikas galėtų pateikti kitos kopijos ciphertext su šios kopijos
   * manifestu ir perskaičiuoti kontrolinę sumą – atkūrimas pavyktų, o
   * operatorius gautų ne tuos duomenis, kurių tikėjosi.
   */
  await jobStore.init();
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  const first = await backupService.createBackup({ actor: "sysadmin", env });

  await new Promise((r) => setTimeout(r, 5));
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  const second = await backupService.createBackup({ actor: "sysadmin", env });

  // Antros kopijos turinys su pirmos manifestu; suma perskaičiuota.
  const swapped = {
    ...first.manifest,
    checksum: require("../utils/backupManifest").computeChecksum(second.data),
  };

  const result = await restoreService.restoreBackup({ manifest: swapped, data: second.data, env });

  assert.equal(result.ok, false, "sukeistas turinys turi būti atmestas");
  assert.equal(result.failedStep, STEPS.DECRYPTED);
});

test("ALGORITMAS: `encrypted: true` be algoritmo atmetamas", async () => {
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  for (const bad of [null, "aes-128-cbc", "aes-256-gcm-v99"]) {
    const result = await restoreService.restoreBackup({
      manifest: { ...backup.manifest, encryptionAlgorithm: bad },
      data: backup.data,
      env,
    });

    assert.equal(result.ok, false, `algoritmas "${bad}" turėjo būti atmestas`);
    assert.equal(result.failedStep, STEPS.DECRYPTED);
  }
});

test("ALGORITMAS: nenuoseklus manifestas (`encrypted: false` su algoritmu) atmetamas", async () => {
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const backup = await backupService.createBackup({
    actor: "sysadmin",
    env: { ...process.env, BACKUP_ENCRYPTION_KEY: "" },
  });

  const result = await restoreService.restoreBackup({
    manifest: { ...backup.manifest, encryptionAlgorithm: "aes-256-gcm-v1" },
    data: backup.data,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /nenuoseklus/i);
});

/* ------------------------------------------------------------------ */
/* ENVELOPE STRUKTŪRA                                                  */
/* ------------------------------------------------------------------ */

test("ENVELOPE: netinkama struktūra atmetama prieš base64 dekodavimą", () => {
  /**
   * ⚠️ TIKSLI FORMULUOTĖ: patikra vyksta prieš `Buffer.from(..., "base64")`,
   * bet NE prieš viso failo nuskaitymą – iki čia jis jau perskaitytas ir
   * išparsintas. Viso failo dydžio ribojimas priklauso įėjimo taškui, kurio
   * dar nėra.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  const bad = [
    null,
    {},
    { format: "v99", iv: "x", authTag: "y", ciphertext: "z" },
    // `v1` čia nebenaudojamas: jis atmetamas ATSKIRU kodu kaip nebepalaikomas
    // formatas (žr. testą apie formato versijavimą), ne kaip struktūros klaida.
    { format: "v2", iv: "", authTag: "y", ciphertext: "z" },
    { format: "v2", iv: 123, authTag: "y", ciphertext: "z" },
    { format: "v2", iv: Buffer.alloc(5).toString("base64"), authTag: Buffer.alloc(16).toString("base64"), ciphertext: "AAAA" },
    { format: "v2", iv: Buffer.alloc(12).toString("base64"), authTag: Buffer.alloc(4).toString("base64"), ciphertext: "AAAA" },
  ];

  for (const envelope of bad) {
    assert.throws(
      () => backupEncryption.decrypt(envelope, { env }),
      (e) => e.code === "BACKUP_ENCRYPTION_FORMAT",
      `envelope ${JSON.stringify(envelope)} turėjo būti atmestas`
    );
  }
});

/* ------------------------------------------------------------------ */
/* PASLAPTYS KŪRIMO METU                                               */
/* ------------------------------------------------------------------ */

test("PASLAPTYS: aptinkamos jau KURIANT kopiją, ne tik atkuriant", async () => {
  /**
   * Anksčiau patikra vykdavo TIK atkuriant – tad kopija su nutekėjusia
   * paslaptimi būdavo sukuriama, laikoma visą retencijos laikotarpį, ir
   * problema paaiškėdavo nelaimės metu.
   *
   * Atkūrimo momentas yra blogiausia vieta pirmą kartą sužinoti, kad kopija
   * neatitinka politikos.
   */
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, {
    status: "completed",
    result: { pastaba: "raktas sk-ant-nutekejo-kuriant-999" },
  });

  await assert.rejects(
    () =>
      backupService.createBackup({
        actor: "sysadmin",
        env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-nutekejo-kuriant-999" },
      }),
    (e) => e.code === "BACKUP_SECRETS_PRESENT"
  );
});

test("PASLAPTYS: kūrimo klaidoje yra VARDAS, ne reikšmė", async () => {
  await jobStore.init();
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: "sk-ant-slaptas-tekstas-777" } });

  try {
    await backupService.createBackup({
      actor: "sysadmin",
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-slaptas-tekstas-777" },
    });
    assert.fail("turėjo mesti klaidą");
  } catch (error) {
    assert.match(error.message, /ANTHROPIC_API_KEY/);
    assert.ok(!error.message.includes("sk-ant-slaptas-tekstas-777"), "reikšmė NEGALI patekti į klaidą");
  }
});

test("PASLAPTYS: kopijų raktai yra INVENTORIUJE", () => {
  /**
   * Jie atsirado tame pačiame PR, kuriame deklaruota, kad inventorius
   * eksplicitinis. `BACKUP_ENCRYPTION_KEY` nutekėjimas atveria VISAS juo
   * šifruotas kopijas – tai galingiausia paslaptis sistemoje.
   */
  assert.equal(secretsInventory.isSecret("BACKUP_ENCRYPTION_KEY"), true);
  assert.equal(secretsInventory.isSecret("BACKUP_ENCRYPTION_KEY_PREVIOUS"), true);

  const key = secretsInventory.SECRETS.find((s) => s.name === "BACKUP_ENCRYPTION_KEY");
  assert.match(key.unlocks, /kopij/i, "turi paaiškinti, ką atrakina");
  assert.match(key.rotation, /PREVIOUS/, "rotacija turi minėti ankstesnį raktą");
});

/* ------------------------------------------------------------------ */
/* ŠIFRUOTAS ATKŪRIMAS × #19 ŽYMOS                                     */
/* ------------------------------------------------------------------ */

test("ŽYMOS: ŠIFRUOTA kopija irgi negrąžina ištrinto jobo", async () => {
  /**
   * Pagrindinė #20 garantija yra ne „dešifruoja", o „dešifruoja IR VIS TIEK
   * neapeina #19 GDPR ištrynimo".
   *
   * Šifravimas įterpė naują kelią prieš `APPLIED`; be šio testo negalima
   * teigti, kad svarbiausia #19 garantija jį išlaikė.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 1 } });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  await jobStore.system.remove(job.id);
  tombstones.mark(job.id, { actor: "sysadmin" });
  tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED);

  const result = await restoreService.restoreBackup({ ...backup, actor: "sysadmin", env });

  assert.equal(result.ok, true, "atkūrimas pats pavyksta");
  assert.equal(await jobStore.system.get(job.id), null, "bet ištrintas jobas NEGRĮŽTA net iš šifruotos kopijos");
});

test("ŽYMOS: atkūrimas ANKSTESNIU raktu irgi gerbia žymas", async () => {
  /**
   * Rotacijos kelias yra atskira šaka – ji irgi privalo išlaikyti #19
   * garantiją, ne tik pagrindinis kelias.
   */
  await tombstones._clearForTests();
  await jobStore.init();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.system.update(job.id, { status: "completed", result: { x: 1 } });

  const senas = backupEncryption.generateKey();
  const backup = await backupService.createBackup({
    actor: "sysadmin",
    env: { ...process.env, BACKUP_ENCRYPTION_KEY: senas },
  });

  await jobStore.system.remove(job.id);
  tombstones.mark(job.id, { actor: "sysadmin" });
  tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED);

  const result = await restoreService.restoreBackup({
    ...backup,
    env: {
      ...process.env,
      BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey(),
      BACKUP_ENCRYPTION_KEY_PREVIOUS: senas,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(await jobStore.system.get(job.id), null, "ištrintas jobas negrįžta ir per rotacijos kelią");
});

test("STARTUP: netinkamas ANKSTESNIS raktas aptinkamas paleidžiant", () => {
  /**
   * `decrypt` mestų klaidą DAR PRIEŠ pradedant bandyti kandidatus – tad
   * atkūrimas kristų net su TEISINGU dabartiniu raktu.
   *
   * Tai fail-closed, bet sužinoti apie tai nelaimės metu yra blogiausias
   * momentas.
   */
  const { validateConfig } = require("../utils/startupChecks");

  for (const name of ["BACKUP_ENCRYPTION_KEY", "BACKUP_ENCRYPTION_KEY_PREVIOUS"]) {
    for (const bad of ["abc", "z".repeat(64), "ab".repeat(20)]) {
      const { errors } = validateConfig({ [name]: bad });
      assert.ok(errors.some((e) => e.includes(name)), `${name}="${bad.slice(0, 8)}" turėjo stabdyti paleidimą`);
    }
  }

  const valid = validateConfig({ BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() });
  assert.deepEqual(valid.errors.filter((e) => /BACKUP_ENCRYPTION/.test(e)), []);
});

test("STARTUP: ankstesnis raktas BE dabartinio duoda įspėjimą", () => {
  /**
   * Toks derinys reiškia, kad naujos kopijos NEBUS šifruojamos, o senos dar
   * dešifruojamos – dažniausiai nebaigta rotacija, ne sąmoningas sprendimas.
   */
  const { validateConfig } = require("../utils/startupChecks");

  const { warnings } = validateConfig({ BACKUP_ENCRYPTION_KEY_PREVIOUS: backupEncryption.generateKey() });
  assert.ok(warnings.some((w) => /rotacija/i.test(w)));
});

/* ------------------------------------------------------------------ */
/* FORMATO VERSIJAVIMAS IR MANIFESTO DOWNGRADE                         */
/* ------------------------------------------------------------------ */

test("FORMATAS: AAD pridėjimas pakėlė versiją į v2", () => {
  /**
   * GCM žyma skaičiuojama ĮTRAUKIANT AAD, tad kopija be jo su nauju kodu
   * NEDEŠIFRUOJAMA. Palikus `v1` egzistuotų dvi semantiškai skirtingos kopijos
   * su tuo pačiu vardu, ir atkūrimas neturėtų kaip jų atskirti.
   */
  assert.equal(backupEncryption.FORMAT, "v2", "AAD pridėjimas yra formato pakeitimas");
});

test("FORMATAS: `v1` atmetamas su KONKREČIA priežastimi", () => {
  /**
   * Tyli nesėkmė atrodytų kaip sugadinta kopija, ir operatorius ieškotų
   * problemos ne ten, kur ji yra.
   *
   * `v1` egzistavo tik neišleistose iteracijose – nė viena sumerginta versija
   * šifruotų kopijų nekūrė, tad tokių kopijų diegimuose būti negali.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  const legacy = {
    format: "v1",
    iv: Buffer.alloc(12).toString("base64"),
    authTag: Buffer.alloc(16).toString("base64"),
    ciphertext: "AAAA",
  };

  assert.throws(
    () => backupEncryption.decrypt(legacy, { env }),
    (e) => e.code === "BACKUP_FORMAT_UNSUPPORTED" && /nebepalaikomas/.test(e.message)
  );
});

test("FORMATAS: manifesto algoritmas atitinka envelope versiją", async () => {
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const { manifest, data } = await backupService.createBackup({ actor: "sysadmin", env });

  assert.equal(manifest.encryptionAlgorithm, `${backupEncryption.ALGORITHM}-v2`);

  const envelope = JSON.parse(data.toString("utf8"));
  assert.equal(envelope.format, "v2", "envelope ir manifestas turi sutapti");
});

test("DOWNGRADE: `encrypted: true → false` atmetamas", async () => {
  /**
   * SVARBIAUSIAS šio bloko testas.
   *
   * Užpuolikas gali pakeisti `encrypted` į `false`, pašalinti algoritmą ir
   * perskaičiuoti kontrolinę sumą. Tada atkūrimas net nebandytų dešifruoti –
   * AAD apsauga nebūtų pasiekta, nes dešifravimo šaka nebūtų vykdoma.
   *
   * Apsauga apeinama tame pačiame žingsnyje, kurį ji turėtų saugoti.
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  const downgraded = {
    ...backup.manifest,
    encrypted: false,
    encryptionAlgorithm: null,
    // Kontrolinė suma perskaičiuota – ji downgrade nesustabdo.
    checksum: require("../utils/backupManifest").computeChecksum(backup.data),
  };

  const result = await restoreService.restoreBackup({ manifest: downgraded, data: backup.data, env });

  assert.equal(result.ok, false, "manifesto downgrade turi būti atmestas");

  /**
   * Tikrinam KONKRETŲ žingsnį, ne vien `ok === false`.
   *
   * Pirmoji šio testo versija tikrino tik `failedStep !== APPLIED` – ir
   * praeidavo, nes downgrade atsitiktinai kristų turinio validacijoje su
   * pranešimu „laukas `jobs` privalo būti masyvas". Testas būtų žalias, o
   * apsaugos nebūtų.
   */
  assert.equal(result.failedStep, STEPS.DECRYPTED, "downgrade turi būti aptiktas TIKSLINGAI");
  assert.match(result.reason, /downgrade/i);
});

test("DOWNGRADE: `encrypted` privalo būti BOOLEAN", async () => {
  /**
   * `"false"`, `0` ar `null` turi skirtingas truthy/falsy interpretacijas –
   * o šis laukas sprendžia, ar apskritai dešifruoti. Neapibrėžtumas reikštų,
   * kad downgrade galimas net be klastojimo, vien dėl tipo painiavos.
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  for (const bad of ["false", "true", 0, 1, null]) {
    const result = await restoreService.restoreBackup({
      manifest: { ...backup.manifest, encrypted: bad },
      data: backup.data,
      env,
    });

    assert.equal(result.ok, false, `\`encrypted: ${JSON.stringify(bad)}\` turėjo būti atmestas`);

    /**
     * Tikrinam KONKREČIĄ priežastį, ne vien `ok === false`.
     *
     * Be jos testas praeitų ir tada, jei tipo patikros nebūtų – atmetimas
     * įvyktų vėliau, kitame sluoksnyje, ir mutacija liktų nepastebėta.
     */
    assert.match(result.reason, /privalo būti boolean/, `\`${JSON.stringify(bad)}\`: turi suveikti TIPO patikra`);
  }
});

test("AAD: `contents` klastojimas sulaužo dešifravimą", async () => {
  /**
   * `contents` yra operatoriaus sprendimų pagrindas: ar kopija pilna, ar joje
   * yra audio, kokio atkūrimo tikėtis. Suklastotas jis nekeistų atkurtų
   * duomenų, bet keistų sprendimą, ar apskritai pradėti atkūrimą.
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  const forged = {
    ...backup.manifest,
    contents: backup.manifest.contents.map((c) => ({ ...c, count: c.count + 100 })),
  };

  const result = await restoreService.restoreBackup({ manifest: forged, data: backup.data, env });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, STEPS.DECRYPTED);
});

test("AAD: `contents` TVARKA nesvarbi (kanonizavimas)", () => {
  /**
   * Masyvo tvarka nėra garantuota; skirtinga tvarka duotų skirtingą AAD, ir
   * dešifravimas kristų be jokios realios priežasties.
   */
  const base = {
    formatVersion: 1,
    applicationVersion: "1.2.0",
    encrypted: true,
    encryptionAlgorithm: "aes-256-gcm-v2",
    snapshotTime: "2026-01-01T00:00:00.000Z",
    excludedInFlightJobs: 0,
    contents: [
      { type: "job_record", count: 2, bytes: 10 },
      { type: "source_audio", count: 1, bytes: 20 },
    ],
  };

  const reordered = { ...base, contents: [...base.contents].reverse() };

  assert.equal(
    backupEncryption.manifestAadV2(base).toString(),
    backupEncryption.manifestAadV2(reordered).toString(),
    "tvarka neturi keisti AAD"
  );
});

test("AAD: schema susieta su FORMATO VERSIJA", () => {
  /**
   * Laukų sąrašas yra dalis ilgalaikės formato sutarties: bet koks pakeitimas
   * padarytų ankstesnes kopijas neatkuriamas. Todėl schema pavadinta pagal
   * versiją – būsimas `v3` galės turėti kitą rinkinį, o `v2` liks nepakitęs.
   */
  assert.equal(typeof backupEncryption.manifestAadV2, "function");

  assert.throws(
    () => backupEncryption.manifestAad({}, "v99"),
    (e) => e.code === "BACKUP_ENCRYPTION_FORMAT"
  );
});

/* ------------------------------------------------------------------ */
/* v2 FORMATO SUTARTIS: MANIFESTAS PRIVALOMAS                          */
/* ------------------------------------------------------------------ */

test("SUTARTIS: `v2` šifravimui manifestas PRIVALOMAS", () => {
  /**
   * Palikus jį neprivalomą, `v2` reikštų DU skirtingus dalykus: „AES-GCM su
   * manifesto AAD" ir „be jo". Tai lygiai ta pati problema, dėl kurios `v1`
   * buvo pakeistas į `v2`.
   *
   * Formato versija privalo nusakyti KRIPTOGRAFINĘ SUTARTĮ, ne tai, kaip
   * konkretus kvietėjas pasirinko iškviesti funkciją.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  assert.throws(
    () => backupEncryption.encrypt(Buffer.from("x"), { env }),
    (e) => e.code === "BACKUP_MANIFEST_REQUIRED"
  );
});

test("SUTARTIS: `v2` dešifravimui manifestas PRIVALOMAS", () => {
  /**
   * Priešingu atveju modulis pats leistų apeiti AAD apsaugą, kurią jis įveda.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const envelope = backupEncryption.encrypt(Buffer.from("x"), { env, manifest: testManifest() });

  assert.throws(
    () => backupEncryption.decrypt(envelope, { env }),
    (e) => e.code === "BACKUP_MANIFEST_REQUIRED"
  );
});

test("SUTARTIS: `v2` be AAD sukurti NEĮMANOMA", () => {
  /**
   * Praktinė rizika, kurią tai uždaro: būsimas migracijos ar administravimo
   * skriptas galėtų sukurti envelope su `format: "v2"`, kurio žyma
   * apskaičiuota be AAD. Toks failas atrodytų teisėtas, bet `restoreService`
   * jo NEBEATKURTŲ.
   */
  const env = { BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  for (const options of [{ env }, { env, manifest: null }, { env, manifest: undefined }]) {
    assert.throws(
      () => backupEncryption.encrypt(Buffer.from("x"), options),
      (e) => e.code === "BACKUP_MANIFEST_REQUIRED",
      `variantas ${JSON.stringify(Object.keys(options))} turėjo būti atmestas`
    );
  }
});

test("LEGACY: `v1` atmetamas su konkrečia priežastimi PILNAME sraute", async () => {
  /**
   * Algoritmo patikra vyksta PRIEŠ envelope analizę, tad be atskiro atvejo
   * tikra `v1` kopija būtų atmesta kaip „nepalaikomas algoritmas", ir
   * paaiškinimas operatoriaus nepasiektų – jis ieškotų blogo rakto ar
   * sugadinto failo.
   */
  await jobStore.init();
  await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });

  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const backup = await backupService.createBackup({ actor: "sysadmin", env });

  const legacy = {
    ...backup.manifest,
    encryptionAlgorithm: `${backupEncryption.ALGORITHM}-v1`,
  };

  const result = await restoreService.restoreBackup({ manifest: legacy, data: backup.data, env });

  assert.equal(result.ok, false);
  assert.match(result.reason, /nebepalaikomas/i, "operatorius turi sužinoti, kad tai LEGACY formatas");
  assert.match(result.reason, /neišleista/i, "priežastis turi paaiškinti, iš kur toks formatas");
});

test("AAD: `contents` schema tikrinama GRIEŽTAI prieš kanonizavimą", () => {
  /**
   * Manifestas atkuriant ateina iš NEPATIKIMO šaltinio. Be patikros
   * `Number("abc")` duotų `NaN`, o `JSON.stringify(NaN)` – `null`, ir
   * skirtingos netinkamos reikšmės suplaktų į tą patį AAD.
   *
   * Tai nesukurtų tiesioginės spragos, bet AAD nustotų atskirti tai, ką
   * turėtų atskirti.
   */
  const base = testManifest();

  /**
   * Tikrinamos DVI klaidų klasės:
   *   1. `contents` apskritai ne masyvas – prieštarauja manifesto sutarčiai,
   *      nes tai PRIVALOMAS laukas;
   *   2. masyvas su netinkamais įrašais.
   *
   * Pirmoji anksčiau tyliai virsdavo `null` – kriptografinės spragos tai
   * nesukurdavo, bet leido tiesioginiam modulio kvietėjui sukurti semantiškai
   * netinkamą, o kriptografiškai galiojantį manifestą.
   */
  for (const bad of [
    null,
    undefined,
    {},
    "abc",
    42,
    [{ type: "x", count: "abc", bytes: 1 }],
    [{ type: "", count: 1, bytes: 1 }],
    [{ type: "x", count: -1, bytes: 1 }],
    [{ type: "x", count: 1.5, bytes: 1 }],
    ["ne objektas"],
    [null],
  ]) {
    assert.throws(
      () => backupEncryption.manifestAadV2({ ...base, contents: bad }),
      (e) => e.code === "BACKUP_MANIFEST_INVALID",
      `contents ${JSON.stringify(bad)} turėjo būti atmestas`
    );
  }

  // Galiojantis praeina, įskaitant TUŠČIĄ masyvą (kopija be turinio yra teisėta).
  assert.ok(backupEncryption.manifestAadV2({ ...base, contents: [] }));
  assert.ok(backupEncryption.manifestAadV2({ ...base, contents: [{ type: "job_record", count: 2, bytes: 10 }] }));
});
