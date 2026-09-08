const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const attemptRegistry = require("../utils/attemptRegistry");
const { STATUS, OWNER_KIND } = require("../utils/jobStore/common");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * ERASURE PER BANDYMŲ REGISTRĄ (#157, PR-5).
 *
 * ⚠️ ČIA `joboBandymai()` PIRMĄ KARTĄ TAMPA PRODUKCINIU KELIU.
 *
 * PR-4 registrą parašė, bet už modulio ribų jo niekas nekvietė — tad „erasure trina
 * pagal registrą" buvo dokumentacija, ne savybė. Šis failas tikrina ne tik tai, kad
 * objektai pašalinti, bet ir kad REGISTRAS buvo skaitymo šaltinis: nereferencuotas
 * bandymas pasiekiamas TIK per jį.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("registryerasure");
const PRALEISTI = skipWithoutPostgres();

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function adminPg(sql) {
  const c = new Client({ connectionString: adminDatabaseUrl() });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("#157 PR-5: erasure trina PAGAL REGISTRĄ", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-erasure-"));
  t.after(async () => {
    await pool.end().catch(() => {});
    await fsp.rm(saknis, { recursive: true, force: true });
  });

  const fs = createFsArtifactStore({ root: saknis });
  const saugykla = { ...fs, backend: "fs" };
  const store = createPostgresStore(pool, { rasymoSaugykla: saugykla });

  async function naujasJobas() {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
    await store.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });
    return job.id;
  }

  /**
   * ⚠️ NUTRŪKĘS PROCESAS ATKURIAMAS TIESIOGIAI, IR TAI VIENINTELIS BŪDAS.
   *
   * Bandymas, kurio objektas parašytas, bet nuoroda neįsipareigota, atsiranda tik tada,
   * kai procesas miršta tarp `put()` ir commit'o. Per produkcinį kelią to nepakartosi
   * nenužudžius proceso; per registro API — pakartoji tiksliai. Būtent šitą klasę
   * registras ir sukurtas padaryti matomą.
   */
  async function nutrukesBandymas(jobId, turinys) {
    const attemptId = attemptRegistry.naujasBandymas();
    const raktas = attemptRegistry.bandymoRaktas(jobId, attemptId);

    await attemptRegistry.registruoti(pool, {
      attemptId,
      jobId,
      storageType: "fs",
      storageKey: raktas,
    });
    await saugykla.put(raktas, turinys);

    return { attemptId, raktas };
  }

  async function rezultatoEilute(jobId) {
    const { rows } = await pool.query("SELECT storage_type, storage_key FROM job_results WHERE job_id = $1", [jobId]);
    return rows[0] || null;
  }

  await t.test("`listResultArtifacts()` grąžina IR nereferencuotus bandymus", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });

    const eilute = await rezultatoEilute(id);
    const nutrukes = await nutrukesBandymas(id, { text: "niekada neįsipareigotas" });

    const artefaktai = await store.listResultArtifacts(id);
    const raktai = artefaktai.map((a) => a.storageKey);

    assert.ok(raktai.includes(eilute.storage_key), "referencuotas objektas privalo būti sąraše");
    assert.ok(
      raktai.includes(nutrukes.raktas),
      `nereferencuotas bandymas privalo būti sąraše — jis pasiekiamas TIK per registrą: ${raktai.join(", ")}`
    );

    /** ⚠️ KONTROLĖ: `job_results` apie jį NIEKO nežino. */
    assert.notEqual(nutrukes.raktas, eilute.storage_key);
    const { rows } = await pool.query("SELECT 1 FROM job_results WHERE storage_key = $1", [nutrukes.raktas]);
    assert.equal(rows.length, 0, "nuoroda į nutrūkusį bandymą neegzistuoja — tai ir yra esmė");

    /** Referencuotas grąžinamas PASKUTINIS: kvietėjas trina eilės tvarka. */
    assert.equal(
      artefaktai[artefaktai.length - 1].storageKey,
      eilute.storage_key,
      "referencuotas objektas privalo būti paskutinis"
    );
    assert.equal(artefaktai[artefaktai.length - 1].referencuotas, true);
  });

  await t.test("`deleteResultArtifacts()` pašalina VISUS bandymus, ne tik referencuotą", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });

    const eilute = await rezultatoEilute(id);
    const a = await nutrukesBandymas(id, { text: "nutrūkęs A" });
    const b = await nutrukesBandymas(id, { text: "nutrūkęs B" });

    assert.ok(await saugykla.head(a.raktas), "kontrolė: objektas prieš šalinimą YRA");

    const rezultatas = await store.deleteResultArtifacts(id);

    assert.deepEqual(rezultatas.nepavyko, [], "nė vienas šalinimas negali nepavykti");
    assert.equal(rezultatas.pasalinti.length, 3, `laukta trijų: ${JSON.stringify(rezultatas)}`);

    for (const raktas of [a.raktas, b.raktas, eilute.storage_key]) {
      assert.equal(await saugykla.head(raktas), null, `objektas liko: ${raktas}`);
    }
  });

  await t.test("REGISTRAS yra šaltinis NEREFERENCUOTIEMS bandymams: be jo eilutės objektas IŠLIEKA", async () => {
    /**
     * ⚠️ MUTACIJOS EKVIVALENTAS, ĮVYKDYTAS DUOMENIMIS, NE KODU.
     *
     * Jei erasure eitų per `job_results.storage_key`, nutrūkusio bandymo objektas
     * išliktų — ir tai vienintelis skirtumas tarp „trina pagal nuorodą" ir „trina pagal
     * registrą". Pašalinus registro eilutę, sąlygos tampa lygiai tokios, kokios būtų
     * BE registro, ir objektas privalo išlikti.
     *
     * ⚠️ KĄ TIKSLIAI ĮRODO — IR KO NE. Įrodoma, kad registras yra šaltinis
     * NEREFERENCUOTIEMS bandymams. REFERENCUOTAS objektas atrandamas ABIEM keliais:
     * `listResultArtifacts()` jį grąžina ir be registro eilutės (`busena: null` šaka,
     * `job_results` pusė). Tai SĄMONINGA dviguba gynyba, ne spraga — bet jei šio testo
     * pavadinimas ar komentaras teigtų „registras yra vienintelis šaltinis", teiginys
     * būtų platesnis už tai, kas patikrinta, ir kitas skaitytojas jo nebetikrintų.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });
    const nutrukes = await nutrukesBandymas(id, { text: "be registro eilutės" });

    await pool.query("DELETE FROM job_result_attempts WHERE attempt_id = $1", [nutrukes.attemptId]);

    const rezultatas = await store.deleteResultArtifacts(id);

    assert.deepEqual(rezultatas.nepavyko, []);
    assert.ok(
      await saugykla.head(nutrukes.raktas),
      "be registro eilutės objektas PRIVALO likti — kitaip testas nieko apie registrą neįrodo"
    );

    /** Sutvarkoma, kad likutis neterštų kitų subtestų. */
    await saugykla.delete(nutrukes.raktas);
  });

  await t.test("retencijos predikatas: NUORODA saugo eilutę nepriklausomai nuo amžiaus", async () => {
    /**
     * ⚠️ ĮĖJIMO SĄLYGA 3, PIRMOJI ŠAKA. Eilutė, kurios `storage_key` yra gyvoje
     * `job_results` eilutėje, nėra kandidatė NIEKADA — net kai ji senesnė už bet kokią
     * ribą. Be to retencija galėtų pašalinti vienintelį likusį adresą.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "referencuotas" } });

    /** Eilutė dirbtinai pasendinama — amžius nustoja būti kliūtis. */
    await pool.query("UPDATE job_result_attempts SET created_at = now() - INTERVAL '90 days' WHERE job_id = $1", [id]);

    const { kandidatai } = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });

    const musu = kandidatai.filter((k) => k.job_id === id);
    assert.deepEqual(musu, [], `referencuota eilutė NEGALI būti kandidatė: ${JSON.stringify(musu)}`);
  });

  await t.test("retencijos predikatas: NEIŠSPRĘSTA ŽYMA saugo eilutę ir be nuorodos", async () => {
    /**
     * ⚠️ ĮĖJIMO SĄLYGA 3, ANTROJI ŠAKA — IR BŪTENT JI DENGIA DALINĮ GEDIMĄ.
     *
     * Ištrynimas naikina nuorodas (`ON DELETE CASCADE`), tad pirmoji šaka dingsta tada,
     * kai jos labiausiai reikia. Čia atkuriama būtent ta būsena: nuorodos nebėra, žyma
     * neišspręsta, eilutė sena — ir ji vis tiek NĖRA kandidatė.
     */
    const id = await naujasJobas();
    const nutrukes = await nutrukesBandymas(id, { text: "žymos gynyba" });

    await pool.query("UPDATE job_result_attempts SET created_at = now() - INTERVAL '90 days' WHERE job_id = $1", [id]);

    /** KONTROLĖ: be žymos ji YRA kandidatė. */
    const pries = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });
    assert.ok(
      pries.kandidatai.some((k) => k.attempt_id === nutrukes.attemptId),
      "kontrolė: be žymos sena, nereferencuota eilutė privalo būti kandidatė"
    );

    await pool.query(
      "INSERT INTO erasure_marks (job_id, status, reason, marked_at) VALUES ($1, $2, $3, now())",
      [id, "deletion_pending", "user_request"]
    );

    const po = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });
    assert.ok(
      !po.kandidatai.some((k) => k.attempt_id === nutrukes.attemptId),
      "neišspręsta žyma privalo saugoti eilutę — kitaip `deletionRetry` netenka adresų"
    );

    /** O uždarius žymą apsauga PASIBAIGIA pati — ji nėra amžina. */
    await pool.query("UPDATE erasure_marks SET status = $2, completed_at = now() WHERE job_id = $1", [id, "deleted"]);
    const uzdarius = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });
    assert.ok(
      uzdarius.kandidatai.some((k) => k.attempt_id === nutrukes.attemptId),
      "uždarius žymą eilutė teisėtai tampa valytina"
    );

    await saugykla.delete(nutrukes.raktas);
  });

  await t.test("`pending` turi SAVO ribą, ilgesnę nei `abandoned` (sąlyga 4a)", async () => {
    /**
     * ⚠️ VYKSTANTIS RAŠYMAS ATRODO KAIP NUTRŪKĘS. Eilutė sukuriama PRIEŠ `put()`, o
     * laikinas vardas nuo PR-5 apskaičiuojamas — tad šlavėjas gali ištrinti vykstančio
     * rašymo laikinąjį failą. `abandoned` tokios rizikos neturi: rašytojas baigė.
     */
    const id = await naujasJobas();
    const laukiantis = await nutrukesBandymas(id, { text: "pending" });
    const atmestas = await nutrukesBandymas(id, { text: "abandoned" });
    await attemptRegistry.pazymeti(pool, atmestas.attemptId, attemptRegistry.BUSENA.ATMESTA);

    await pool.query("UPDATE job_result_attempts SET created_at = now() - INTERVAL '2 hours' WHERE job_id = $1", [id]);

    const { kandidatai } = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 24 * 60 * 60 * 1000,
      atmestuRibaMs: 60 * 60 * 1000,
      kiekis: 100,
    });

    const raktai = kandidatai.map((k) => k.attempt_id);
    assert.ok(raktai.includes(atmestas.attemptId), "`abandoned` už savo ribos — kandidatas");
    assert.ok(
      !raktai.includes(laukiantis.attemptId),
      "`pending` dar savo riboje — NEGALI būti kandidatas, nes rašymas gali vykti"
    );

    for (const b of [laukiantis, atmestas]) await saugykla.delete(b.raktas);
  });

  await t.test("`created_at` ATEITYJE nešluojamas ir SKAIČIUOJAMAS (sąlyga 4b)", async () => {
    /**
     * ⚠️ PO ATKŪRIMO IŠ `pg_dump` ŽYMOS YRA ŠALTINIO LAIKO — ta pati klasė kaip
     * `deploymentIdentity`. Ateityje esantis `created_at` yra vienintelė DETEKTUOJAMA to
     * dalis, ir ji privalo būti ne tik praleista, bet ir MATOMA: tyliai praleistas
     * valymas atrodo kaip valymas (7.5a precedentas).
     */
    const id = await naujasJobas();
    const nutrukes = await nutrukesBandymas(id, { text: "iš ateities" });

    await pool.query("UPDATE job_result_attempts SET created_at = now() + INTERVAL '5 days' WHERE job_id = $1", [id]);

    const { kandidatai, praleista } = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });

    assert.ok(
      !kandidatai.some((k) => k.attempt_id === nutrukes.attemptId),
      "ateities `created_at` — amžius neapskaičiuojamas, tad NEŠLUOJAMA"
    );
    assert.ok(praleista >= 1, "praleidimas privalo būti SUSKAIČIUOTAS, ne tylus");

    await saugykla.delete(nutrukes.raktas);
  });

  await t.test("`praleista` matomas net kai partiją užpildo senos eilutės", async () => {
    /**
     * ⚠️ MATOMUMO PRIEMONĖ, MATUOJAMA TAIP, KAD NEGALĖTŲ PASIRODYTI (Codex, #304).
     *
     * `ORDER BY created_at LIMIT n` partiją užpildo SENOMIS tinkamomis eilutėmis, tad
     * ateities žymos į ją nepatenka. Skaitiklis rodytų nulį BŪTENT tada, kai atsilikimas
     * didžiausias — ir tvirtintų, kad problemos nėra.
     */
    const id = await naujasJobas();
    const seni = [];
    for (let i = 0; i < 3; i += 1) seni.push(await nutrukesBandymas(id, { text: `senas ${i}` }));
    const ateities = await nutrukesBandymas(id, { text: "iš ateities" });

    await pool.query("UPDATE job_result_attempts SET created_at = now() - INTERVAL '90 days' WHERE job_id = $1", [id]);
    await pool.query("UPDATE job_result_attempts SET created_at = now() + INTERVAL '5 days' WHERE attempt_id = $1", [
      ateities.attemptId,
    ]);

    /** Partija MAŽESNĖ nei senų eilučių skaičius — ateities eilutė į ją nepatenka. */
    const { kandidatai, praleista } = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 2,
    });

    assert.equal(kandidatai.length, 2, "kontrolė: partija tikrai ribota");
    assert.ok(
      !kandidatai.some((k) => k.attempt_id === ateities.attemptId),
      "kontrolė: ateities eilutė į partiją nepateko"
    );
    assert.ok(praleista >= 1, `praleistųjų skaičius privalo būti matomas ir už partijos ribų: ${praleista}`);

    for (const b of [...seni, ateities]) await saugykla.delete(b.raktas);
  });

  await t.test("erasure šalina IR LAIKINĄJĮ failą — ne tik galutinį raktą", async () => {
    /**
     * ⚠️ KRYPTIS BUVO APVERSTA (Codex, #304).
     *
     * Šlavėjas zondavo abu adresus, o erasure trynė tik `storageKey` — tad ŠIUKŠLIŲ
     * SURINKĖJAS turėjo stipresnę garantiją nei autoritetingas BDAR kelias. Bandymas,
     * žuvęs prieš `rename`, palikdavo laikinąjį failą su transkripcija, o erasure
     * grąžindavo `jauNebuvo`, t. y. sėkmę. Po to objektas tampa nepasiekiamas
     * GALUTINAI: registro eilutė dingsta, `list(prefix)` nėra, vardo nebėra iš ko išvesti.
     */
    const { laikinasVardas } = require("../utils/artifactStore/fsStore");
    const id = await naujasJobas();

    /** Bandymas registruotas, laikinas failas parašytas, `rename` neįvyko. */
    const attemptId = attemptRegistry.naujasBandymas();
    const raktas = attemptRegistry.bandymoRaktas(id, attemptId);
    await attemptRegistry.registruoti(pool, { attemptId, jobId: id, storageType: "fs", storageKey: raktas });

    const laikinasKelias = path.join(saknis, path.dirname(raktas), laikinasVardas(raktas));
    await fsp.mkdir(path.dirname(laikinasKelias), { recursive: true });
    await fsp.writeFile(laikinasKelias, JSON.stringify({ text: "transkripcija" }), { mode: 0o600 });

    assert.ok(await fsp.stat(laikinasKelias).catch(() => null), "kontrolė: laikinas failas YRA");
    assert.equal(await saugykla.head(raktas), null, "kontrolė: galutinio objekto NĖRA");

    const rezultatas = await store.deleteResultArtifacts(id);

    assert.deepEqual(rezultatas.nepavyko, []);
    assert.equal(
      await fsp.stat(laikinasKelias).catch(() => null),
      null,
      "laikinojo failo su transkripcija NEGALI likti po patvirtinto ištrynimo"
    );
    assert.deepEqual(rezultatas.pasalinti, [raktas], "ir tai privalo būti raportuojama kaip PAŠALINTA");
  });

  await t.test("tapatybė yra PORA `(storage_type, storage_key)`, ne raktas", async () => {
    /**
     * ⚠️ RAKTUOJANT VIEN `storage_key`, VIENAS FIZINIS OBJEKTAS DINGTŲ TYLIAI (Codex, #304).
     *
     * `(fs, k)` ir `(s3, k)` yra DU fiziniai adresai. Metaduomenys, atkurti ar migruoti
     * tarp backend'ų, gali rodyti į nukopijuotą objektą tuo pačiu loginiu raktu — ir
     * tada aibė, raktuota vien raktu, praneštų vieną, o egzistuotų du.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "pora" } });
    const eilute = await rezultatoEilute(id);

    /** Bandymas su TUO PAČIU raktu, bet kitu backend'u. */
    await pool.query(
      `INSERT INTO job_result_attempts (attempt_id, job_id, storage_type, storage_key, busena)
       VALUES ($1, $2, 's3', $3, $4)`,
      [attemptRegistry.naujasBandymas(), id, eilute.storage_key, attemptRegistry.BUSENA.ATMESTA]
    );

    const artefaktai = await store.listResultArtifacts(id);
    const tipai = artefaktai.filter((a) => a.storageKey === eilute.storage_key).map((a) => a.storageType).sort();

    assert.deepEqual(tipai, ["fs", "s3"], `abu fiziniai adresai privalo likti aibėje: ${JSON.stringify(artefaktai)}`);
  });

  await t.test("bandymas, įsipareigotas PO enumeracijos, sustabdo eilutės šalinimą", async () => {
    /**
     * ⚠️ SNAPSHOT BE PAKARTOTINĖS PATIKROS PO UŽRAKTO (Codex, #304).
     *
     * Enumeracija vyksta BE užrakto — kitaip fizinis I/O būtų po `jobs` eilutės užraktu,
     * ko PR-4 D4 neleidžia. Tarp jos ir eilutės šalinimo worker'is, praėjęs žymos patikrą
     * PRIEŠ žymos atsiradimą, gali įsipareigoti naują bandymą. Be pakartotinės patikros
     * `CASCADE` pašalintų šviežią `job_results` nuorodą, objektas liktų be nuorodos, o
     * ištrynimas praneštų SĖKMĘ.
     *
     * Tai ta pati forma, kurią PR-4 sprendė du kartus: pre-check duoda faktus, sprendimą
     * priima transakcija po užrakto.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "snapshot" } });

    /** Aibė, matyta PRIEŠ I/O. */
    const matyti = await store.listResultArtifacts(id);
    assert.ok(matyti.length > 0, "kontrolė: aibė netuščia");

    /** Po enumeracijos atsiranda NAUJAS bandymas — tiksliai tas atvejis. */
    const naujas = await nutrukesBandymas(id, { text: "įsipareigotas po snapshot'o" });

    const pasalinta = await store.remove(id, { tiketiniAdresai: matyti });

    assert.equal(pasalinta, false, "eilutė NEGALI būti pašalinta: aibė pasikeitė");
    const { rows } = await pool.query("SELECT 1 FROM jobs WHERE id = $1", [id]);
    assert.equal(rows.length, 1, "job'o eilutė privalo likti — pakartojimas turi ką daryti");

    /**
     * ⚠️ VIEN AIBĖS ATNAUJINIMO NEUŽTENKA, IR TAI SĄMONINGA (Codex, #304 A radinys).
     *
     * Naujasis bandymas yra `pending`, t. y. rašytojas gali būti vykdomas DABAR: jo
     * objektą ištrynus, `put()` galėtų jį grąžinti TUO PAČIU adresu, o aibės palyginimas
     * to nepamatytų. Todėl šalinimas blokuojamas, kol bandymas nebaigtas.
     */
    const atnaujinta = await store.listResultArtifacts(id);
    assert.equal(
      await store.remove(id, { tiketiniAdresai: atnaujinta }),
      false,
      "`pending` bandymas privalo blokuoti finalizaciją net su atnaujinta aibe"
    );

    /** KONTROLĖ: rašytojui pasibaigus (arba šlavėjui uždarius eilutę) šalinimas praeina. */
    await attemptRegistry.pazymeti(pool, naujas.attemptId, attemptRegistry.BUSENA.ATMESTA);
    const galutine = await store.listResultArtifacts(id);
    assert.equal(await store.remove(id, { tiketiniAdresai: galutine }), true, "kontrolė: baigtas bandymas nebeblokuoja");

    await saugykla.delete(naujas.raktas);
  });

  await t.test("finalizacija pašalina IR registro eilutes — ne tik `jobs` eilutę", async () => {
    /**
     * ⚠️ NERIBOTAI SAUGOMAS `job_id` PLIUS ADRESAS PO PATVIRTINTO IŠTRYNIMO (Codex, #304).
     *
     * `job_result_attempts` sąmoningai neturi FK į `jobs` — kad išgyventų nutrūkusį
     * ištrynimą ir liktų įrodymu. Bet po PATVIRTINTO ištrynimo tas argumentas nebegalioja:
     * eilutė lieka amžinai su job ID ir saugyklos adresu, o tai asmens duomenų liekana
     * ištrynime, kurį patys paskelbėme baigtu.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "finalizacija" } });
    const nutrukes = await nutrukesBandymas(id, { text: "apleistas" });
    await attemptRegistry.pazymeti(pool, nutrukes.attemptId, attemptRegistry.BUSENA.ATMESTA);

    const pries = await attemptRegistry.joboBandymai(pool, id);
    assert.ok(pries.length >= 2, "kontrolė: registre yra eilučių");

    const artefaktai = await store.deleteResultArtifacts(id);
    assert.deepEqual(artefaktai.nepavyko, []);

    assert.equal(await store.remove(id, { tiketiniAdresai: artefaktai.matyti }), true);

    assert.deepEqual(
      await attemptRegistry.joboBandymai(pool, id),
      [],
      "po patvirtinto ištrynimo registro eilučių likti NEGALI"
    );
  });

  await t.test("ŠLAVIMAS: trys verdiktai prieš tikrą DB ir tikrą failų sistemą", async () => {
    /**
     * ⚠️ VIENETINIAI TESTAI TIKRINA VERDIKTŲ LOGIKĄ SU DUBLIU (`sweepVerdiktai`); čia
     * tikrinama, kad ta pati logika veikia su TIKRA saugykla ir TIKRU registru — t. y.
     * kad zondas randa būtent tuos failus, kuriuos palieka tikras nutrūkęs rašymas.
     */
    const { laikinasVardas } = require("../utils/artifactStore/fsStore");

    /** 1. `nebuvo`: eilutė yra, objekto nėra nė vienoje pusėje. */
    const idA = await naujasJobas();
    const a = attemptRegistry.naujasBandymas();
    const raktasA = attemptRegistry.bandymoRaktas(idA, a);
    await attemptRegistry.registruoti(pool, { attemptId: a, jobId: idA, storageType: "fs", storageKey: raktasA });

    /** 2. `pasalinta` nutrūkus PRIEŠ `rename`: tik laikinas failas. */
    const idB = await naujasJobas();
    const b = attemptRegistry.naujasBandymas();
    const raktasB = attemptRegistry.bandymoRaktas(idB, b);
    await attemptRegistry.registruoti(pool, { attemptId: b, jobId: idB, storageType: "fs", storageKey: raktasB });
    const laikinasB = path.join(saknis, path.dirname(raktasB), laikinasVardas(raktasB));
    await fsp.mkdir(path.dirname(laikinasB), { recursive: true });
    await fsp.writeFile(laikinasB, "{}", { mode: 0o600 });

    /** 3. `pasalinta` nutrūkus PO `rename`: tik galutinis objektas. */
    const idC = await naujasJobas();
    const c = await nutrukesBandymas(idC, { text: "po rename" });

    const verdiktai = await store.sweepResultArtifacts([
      { attempt_id: a, storage_type: "fs", storage_key: raktasA },
      { attempt_id: b, storage_type: "fs", storage_key: raktasB },
      { attempt_id: c.attemptId, storage_type: "fs", storage_key: c.raktas },
    ]);

    assert.deepEqual(
      verdiktai.map((v) => v.verdiktas),
      ["nebuvo", "pasalinta", "pasalinta"],
      JSON.stringify(verdiktai)
    );
    assert.equal(await fsp.stat(laikinasB).catch(() => null), null, "laikinas failas pašalintas");
    assert.equal(await saugykla.head(c.raktas), null, "galutinis objektas pašalintas");
  });

  await t.test("ŠLAVIMAS: `pazeidimas` NEŠALINA nė vieno objekto", async () => {
    /**
     * ⚠️ SU ATTEMPT-UNIQUE RAKTAIS ŠI BŪSENA NEĮMANOMA, ir būtent todėl ji yra signalas.
     * Atkuriama tiesiogiai — kitaip jos nepamatytum, kol schema nepasikeis.
     */
    const { laikinasVardas } = require("../utils/artifactStore/fsStore");

    const id = await naujasJobas();
    const bandymas = await nutrukesBandymas(id, { text: "galutinis" });
    const laikinas = path.join(saknis, path.dirname(bandymas.raktas), laikinasVardas(bandymas.raktas));
    await fsp.writeFile(laikinas, "{}", { mode: 0o600 });

    const [verdiktas] = await store.sweepResultArtifacts([
      { attempt_id: bandymas.attemptId, storage_type: "fs", storage_key: bandymas.raktas },
    ]);

    assert.equal(verdiktas.verdiktas, "pazeidimas");
    assert.ok(await saugykla.head(bandymas.raktas), "galutinis objektas privalo LIKTI");
    assert.ok(await fsp.stat(laikinas).catch(() => null), "laikinas failas privalo LIKTI");

    /** Karantinas: pirmas kartas grąžina eilutę, antras — nieko. */
    const pirmas = await store.pazymetiKarantina([bandymas.attemptId]);
    assert.equal(pirmas.length, 1, "pirmas kartas karantinuoja");
    const antras = await store.pazymetiKarantina([bandymas.attemptId]);
    assert.deepEqual(antras, [], "antras kartas TYLI — pranešimas vienkartinis");

    /** Bet eilutė lieka MATOMA suvestinėje, kol operatorius ją uždaro. */
    assert.ok((await store.karantinuotuSkaicius()) >= 1, "karantinas matomas, kol egzistuoja");

    /** Ir kandidatų predikatas jos nebeima — veiksmas nekartojamas. */
    await pool.query("UPDATE job_result_attempts SET created_at = now() - INTERVAL '90 days' WHERE attempt_id = $1", [
      bandymas.attemptId,
    ]);
    const { kandidatai } = await attemptRegistry.valytiniBandymai(pool, {
      laukianciuRibaMs: 1,
      atmestuRibaMs: 1,
      kiekis: 100,
    });
    assert.ok(
      !kandidatai.some((k) => k.attempt_id === bandymas.attemptId),
      "karantinuota eilutė nebėra kandidatė"
    );

    await saugykla.delete(bandymas.raktas);
    await fsp.rm(laikinas, { force: true });
  });

  await t.test("`eraseJob()` per fasado paviršių nueina iki saugyklos", async () => {
    /**
     * ⚠️ ANKSTESNI SUBTESTAI TIKRINA STORE'Ą; ŠIS — LAIDĄ.
     *
     * `jobErasure` klausia `store.system.deleteResultArtifacts()`, ir be šio subtesto
     * liktų neįrodyta, kad produkcinis erasure kelias tą metodą apskritai kviečia.
     * Adapteris atkartoja fasado paviršių, o ne apeina jį: `jobStore/index.js` `system`
     * bloke tie patys keturi metodai.
     */
    const { eraseJob } = require("../utils/jobErasure");

    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "per fasadą" } });
    const eilute = await rezultatoEilute(id);
    const nutrukes = await nutrukesBandymas(id, { text: "per fasadą, nutrūkęs" });

    const adapteris = {
      system: {
        get: (jobId, nustatymai) => store.get(jobId, nustatymai),
        update: (jobId, patch) => store.update(jobId, patch),
        remove: (jobId) => store.remove(jobId),
        deleteResultArtifacts: (jobId) => store.deleteResultArtifacts(jobId),
      },
    };

    const outcome = await eraseJob({ id, type: "transcription", storageKey: null }, { store: adapteris });

    assert.equal(outcome.criticalFailure, false, `klaidos: ${outcome.errors.join("; ")}`);
    assert.equal(outcome.resultArtifactsRemoved, 2, "abu objektai — referencuotas ir nutrūkęs");
    assert.equal(await saugykla.head(eilute.storage_key), null);
    assert.equal(await saugykla.head(nutrukes.raktas), null);
    assert.equal(outcome.jobRemoved, true, "objektai pašalinti, tad eilutę šalinti leidžiama");
  });
});
