const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const reconcile = require("../utils/postRestoreReconcile");
const jobPhase = require("../utils/jobPhase");
const auditEvents = require("../utils/auditEvents");
const sesijuPg = require("../utils/sessionStore/postgresStore");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const SAKNIS = path.resolve(__dirname, "..");

/**
 * 7.6b KONTRAKTAS BE PostgreSQL (#155, #249).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Įrodo: fail-closed sargus prieš pirmą mutaciją, terminalizavimo taisyklės
 * KILMĘ (patch'as ateina iš `jobPhase`, ne iš rankomis surašyto `SET`),
 * praleidimo predikato pagarbą ir CLI exit kodus.
 *
 * NEĮRODO: kad sesijos realiai revokuotos, kad transakcija atsukama, kad senas
 * cookie nebeautentifikuoja - tam reikia tikros DB, ir tai gyvena
 * `postRestoreReconcile.integration`, kuris vietinėje aplinkoje NEVYKDOMAS.
 */

const TAIKINYS = "postgres://vartotojas:slaptas@db.vidinis:5432/stenograma";
const APLINKA = { DATABASE_URL: "postgres://kitas:kitoks@db.vidinis:5432/stenograma" };

test("#249 D7/D7a: sargai krenta PRIEŠ pirmą mutaciją, skirtingais kodais", () => {
  /**
   * ⚠️ TRYS SKIRTINGI OPERATORIAUS VEIKSMAI — TRYS SKIRTINGI KODAI.
   *
   * „Nenurodyta bazė", „saugyklos ne PostgreSQL" ir „nurodyta ne ta bazė" reiškia
   * skirtingus taisymus. 7.6a ta pati pora išmokta brangiai: atmintinis backend'as
   * ir svetima bazė turi atskirus kodus, nes pirmuoju atveju suderinimas neturi
   * kur įvykti, o antruoju - įvyktų ne ten.
   */
  const kodas = (fn) => {
    try {
      fn();
      return "OK";
    } catch (err) {
      return err.code;
    }
  };

  assert.equal(kodas(() => reconcile.patikrintiSargus(null, APLINKA)), "RECONCILE_NO_TARGET");
  assert.equal(kodas(() => reconcile.patikrintiSargus(TAIKINYS, {})), "RECONCILE_BACKEND_NOT_POSTGRES");
  assert.equal(
    kodas(() => reconcile.patikrintiSargus(TAIKINYS, { DATABASE_URL: "postgres://u:p@db.vidinis:5432/kita" })),
    "RECONCILE_TARGET_MISMATCH"
  );
  assert.equal(
    kodas(() => reconcile.patikrintiSargus(TAIKINYS, { DATABASE_URL: "postgres://u:p@kitas.host:5432/stenograma" })),
    "RECONCILE_TARGET_MISMATCH"
  );

  /** `PG*` ašis tikrinama vienodai — dokumentuotas Compose diegimas neturi URL. */
  assert.equal(
    kodas(() => reconcile.patikrintiSargus(TAIKINYS, { PGHOST: "db.vidinis", PGDATABASE: "stenograma" })),
    "OK"
  );

  /** Kredencialai į klaidas nepatenka: jos rodo tik `host:port/db`. */
  try {
    reconcile.patikrintiSargus(TAIKINYS, { DATABASE_URL: "postgres://u:p@db.vidinis:5432/kita" });
    assert.fail("turėjo kristi");
  } catch (err) {
    assert.equal(err.message.includes("slaptas"), false);
  }
});

/**
 * ⚠️ PADIRBTAS KLIENTAS, NE MOCK'AS ANT `jobPhase`.
 *
 * 7.6a pamoka: mock'as įrodo tik tai, kad funkcija kviečiama. Čia `jobPhase` yra
 * TIKRAS, o padirbtas tik DB klientas - tad testas mato, KOKS patch'as gimė iš
 * autoriteto ir kas iš jo pateko į `UPDATE`.
 */
function padirbtasKlientas(eilutes) {
  const uzklausos = [];
  return {
    uzklausos,
    query: async (text, params) => {
      uzklausos.push({ text: String(text), params });

      if (/SELECT id FROM jobs WHERE status IN/.test(text)) {
        return { rows: eilutes.map((r) => ({ id: r.id })), rowCount: eilutes.length };
      }
      if (/FROM jobs j/.test(text)) {
        const eilute = eilutes.find((r) => r.id === params[0]);
        return { rows: eilute ? [eilute] : [], rowCount: eilute ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function jobEilute(id, status, extra = {}) {
  const dabar = new Date("2026-09-02T10:00:00.000Z");
  return {
    id,
    type: "transcription",
    status,
    phase: status === "processing" ? "transcribing" : null,
    progress_known: false,
    progress_current: null,
    progress_total: null,
    owner_id: "vartotojas-1",
    owner_kind: "user",
    tenant_id: null,
    idempotency_key: null,
    actor: "vartotojas-1",
    actor_role: "user",
    actor_source: "session",
    request_id: null,
    storage_key: `audio/${id}.wav`,
    artefacts: [],
    error_message: null,
    error_code: null,
    attempt_count: 0,
    audio_cleanup_pending: false,
    audio_cleanup_attempts: 0,
    audio_cleanup_next_attempt_at: null,
    deletion_pending: false,
    deletion_attempts: 0,
    deletion_next_attempt_at: null,
    created_at: dabar,
    updated_at: dabar,
    started_at: status === "processing" ? dabar : null,
    completed_at: null,
    schema_version: 1,
    version: 3,
    ...extra,
  };
}

test("#249 D3: terminalizavimo patch'as ATEINA IŠ `jobPhase`, ne iš rankomis surašyto SET", async () => {
  /**
   * ⚠️ TAI SKIRTUMAS TARP „ŠIANDIEN PRAEINA" IR „LIEKA TEISINGA".
   *
   * Rankomis surašytas `SET status='failed', phase=NULL, progress_known=false`
   * šiandien tenkintų `jobs_status_phase` ir `jobs_progress_*`, bet pasentų po
   * kito schemos pokyčio - 7.5b jau pridėjo `version`. Patch'as, gimęs iš
   * `jobPhase.finish()`, tenkina invariantus DĖL AUTORITETO.
   *
   * Testas tai tikrina ne skaitydamas kodą, o lygindamas realų `jobPhase`
   * rezultatą su tuo, kas nukeliavo į `UPDATE`.
   */
  const eilutes = [jobEilute("job-a", "queued"), jobEilute("job-b", "processing")];
  const klientas = padirbtasKlientas(eilutes);
  const store = createPostgresStore({ query: klientas.query });

  const r = await store.atkurimas.terminalizuotiNeTerminaliniusWithClient(klientas, {
    jobPhase,
    extra: { error: reconcile.TERMINALIZAVIMO_ZINUTE, error_code: reconcile.TERMINALIZAVIMO_KODAS },
  });

  assert.deepEqual(r, { rasta: 2, terminalizuota: 2, praleista: [] });

  const updates = klientas.uzklausos.filter((u) => /^\s*UPDATE jobs SET/m.test(u.text));
  assert.equal(updates.length, 2, "kiekvienas ne terminalinis job'as gauna savo `UPDATE`");

  /**
   * ⚠️ TIKRINAMOS REIKŠMĖS, NE STULPELIŲ BUVIMAS — IR TAI PATAISYTA PO MUTACIJOS.
   *
   * Pirmoji šio testo redakcija tvirtino `assert.match(u.text, /"phase" = \$/)`,
   * ir mutacija „patch'ą surašyti ranka (`{ status, ...extra }`) vietoj
   * `jobPhase.finish()`" jos NESULAUŽĖ: `writePatched()` į `SET` deda VISUS
   * kintamus stulpelius, tad `"phase" = $N` ten atsiranda nepriklausomai nuo
   * patch'o. Testas įrodinėjo rašytojo formą, ne taisyklės kilmę (#266).
   *
   * Dabar tikrinama REIKŠMĖ: `processing` job'as turi `phase = "transcribing"`,
   * ir tik `jobPhase.finish()` paverčia jį `null`. Ranka surašytas patch'as tą
   * fazę paliktų — ir testas krinta.
   */
  const reiksme = (u, stulpelis) => {
    const m = u.text.match(new RegExp(`"${stulpelis}" = \\$(\\d+)`));
    assert.ok(m, `\`${stulpelis}\` privalo patekti į SET`);
    return u.params[Number(m[1]) - 1];
  };

  for (const u of updates) {
    assert.equal(reiksme(u, "status"), "failed", "statusas ateina iš `jobPhase.finish`");
    assert.equal(reiksme(u, "phase"), null, "⚠️ tik autoritetas nuvalo fazę");
    assert.equal(reiksme(u, "progress_known"), false, "⚠️ tik autoritetas nuvalo progreso žymą");
    assert.equal(reiksme(u, "error_code"), reconcile.TERMINALIZAVIMO_KODAS);

    /** 7.5b: versija didinama SQL išraiška, ne skaičiuojama procese. */
    assert.match(u.text, /"version" = jobs\.version \+ 1/);
    assert.match(u.text, /"updated_at" = GREATEST/);
  }

  /**
   * ⚠️ KONTROLĖ MUTACIJAI: `processing` job'as ATĖJO su fazė != null, tad
   * pirmesnė patikra nėra tuščia.
   */
  assert.equal(eilutes.find((e) => e.id === "job-b").phase, "transcribing");

  /**
   * ⚠️ KONTROLĖ: tas pats patch'as, gautas TIESIOGIAI iš autoriteto, sutampa su
   * tuo, ką matė saugykla. Be šios eilutės testas įrodytų tik `UPDATE` formą.
   */
  const tiesiogiai = jobPhase.finish(
    { id: "job-a", type: "transcription", status: "queued", phase: null, progress: null, progressKnown: false },
    "failed",
    { error: reconcile.TERMINALIZAVIMO_ZINUTE, error_code: reconcile.TERMINALIZAVIMO_KODAS }
  );
  assert.equal(tiesiogiai.status, "failed");
  assert.equal(tiesiogiai.phase, null);
  assert.equal(tiesiogiai.progress, null);
  assert.equal(tiesiogiai.progressKnown, false);
});

test("#249 D5: praleidimo predikatas gerbiamas, praleisti job'ai grąžinami VARDAIS", async () => {
  /**
   * ⚠️ TYLUS APĖJIMAS NELEISTINAS. Praleidimas dėl ištrynimo žymos yra
   * SPRENDIMAS, tad jis privalo būti matomas: skaičius pasakytų „kažkas liko",
   * o vardai pasako, kas būtent, ir leidžia 7.6c juos rasti.
   */
  const eilutes = [jobEilute("job-a", "queued"), jobEilute("job-uzbarjeruotas", "processing"), jobEilute("job-c", "queued")];
  const klientas = padirbtasKlientas(eilutes);
  const store = createPostgresStore({ query: klientas.query });

  const r = await store.atkurimas.terminalizuotiNeTerminaliniusWithClient(klientas, {
    jobPhase,
    extra: { error_code: reconcile.TERMINALIZAVIMO_KODAS },
    praleisti: async (_klientas, id) => id === "job-uzbarjeruotas",
  });

  assert.deepEqual(r.praleista, ["job-uzbarjeruotas"]);
  assert.equal(r.terminalizuota, 2);
  assert.equal(r.rasta, 3);

  const paliesti = klientas.uzklausos
    .filter((u) => /^\s*UPDATE jobs SET/m.test(u.text))
    .map((u) => u.params[0]);
  assert.equal(paliesti.includes("job-uzbarjeruotas"), false, "užbarjeruotas job'as NEGALI būti paliestas");
});

test("#249: be `jobPhase` autoriteto terminalizavimas neįmanomas", async () => {
  const store = createPostgresStore({ query: async () => ({ rows: [], rowCount: 0 }) });

  await assert.rejects(
    () => store.atkurimas.terminalizuotiNeTerminaliniusWithClient({ query: async () => ({ rows: [] }) }, {}),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      assert.match(err.message, /jobPhase/);
      return true;
    }
  );

  await assert.rejects(() => sesijuPg.revokeAllActiveWithClient(null), (err) => {
    assert.equal(err instanceof TypeError, true);
    return true;
  });
});

test("#249 D6: masinė revokacija yra idempotentiška PAGAL SĄLYGĄ, ne pagal kvietėją", async () => {
  /**
   * ⚠️ `revoked_at IS NULL` DARO ANTRĄ VYKDYMĄ NEKENKSMINGĄ.
   *
   * Be šios sąlygos antras paleidimas perrašytų `revoked_at` nauju laiku, ir
   * „kada revokuota" pasislinktų - persistentinė būsena po pirmo ir antro
   * vykdymo nebesutaptų, nors abu grąžintų sėkmę (D9).
   */
  const uzklausos = [];
  const klientas = {
    query: async (text) => {
      uzklausos.push(String(text));
      return { rows: [], rowCount: 0 };
    },
  };

  await sesijuPg.revokeAllActiveWithClient(klientas);

  assert.equal(uzklausos.length, 1);
  assert.match(uzklausos[0], /UPDATE sessions SET revoked_at = now\(\)/);
  assert.match(uzklausos[0], /WHERE revoked_at IS NULL/);
});

test("#249 D8: audito įvykis registruotas ir NEBLOKUOJANTIS", () => {
  assert.equal(auditEvents.kategorija(reconcile.AUDITO_IVYKIS), auditEvents.kategorija("PG_DUMP_BACKUP_CREATED"));
  assert.ok(auditEvents.AUDIT_EVENTS[reconcile.AUDITO_IVYKIS], "neregistruotas įvykis mestų UnclassifiedAuditEventError");

  /** Antro audito mechanizmo nėra: modulis kviečia `rasytiAudita`, ne savo rašytoją. */
  const src = fs.readFileSync(path.join(SAKNIS, "utils", "postRestoreReconcile.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /auditWrite\.rasytiAudita\(/);
  assert.equal(/auditLog\.record\(/.test(src), false, "antras audito kelias neleistinas");
});

test("#249 D1: CLI neturi savo orkestracijos (statinė patikra su SAVITIKRA)", () => {
  /**
   * ⚠️ KOMENTARAI NUKERPAMI, IR PATIKRA TIKRINA PATI SAVE.
   *
   * 7.6a mutacija MU praėjo būtent todėl, kad statinė patikra sutapo su savo
   * pačios komentaru (#265). Todėl: (1) komentarai pašalinami prieš paiešką,
   * (2) detektorius čia pat įrodo, kad pažeidimą rastų.
   */
  const beKomentaru = (kelias) =>
    fs
      .readFileSync(kelias, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const cli = beKomentaru(path.join(SAKNIS, "scripts", "post-restore-reconcile.mjs"));
  const DRAUDZIAMA = ["UPDATE ", "SELECT ", "BEGIN", "COMMIT", "new Pool"];

  for (const draudziama of DRAUDZIAMA) {
    assert.equal(cli.includes(draudziama), false, `CLI negali turėti \`${draudziama}\` — procedūra gyvena utils/`);
  }

  assert.match(cli, /postRestoreReconcile/, "CLI privalo kviesti bendrą modulį");
  assert.match(cli, /auditStore\.init\(\)/, "audito saugykla be `init()` rašytų į atmintį (D7b)");
  assert.match(cli, /auditStore\.shutdown\(\)/);

  /** SAVITIKRA: detektorius privalo rasti pažeidimą, kitaip jis nieko netikrina. */
  const netikras = 'const x = 1;\nawait client.query("UPDATE jobs SET status = 1");';
  assert.equal(
    DRAUDZIAMA.some((d) => netikras.includes(d)),
    true,
    "detektorius nerado akivaizdaus pažeidimo — patikra būtų dekoratyvi"
  );
});

test("#249 D7: CLI atmintiniame režime KRENTA, ne praleidžia tyliai", () => {
  /**
   * ⚠️ TIKRAS PROCESAS, NE FAILO TEKSTAS. Klausimas yra „ką komanda daro",
   * o „sėkmingas praleidimas" čia būtų pavojingesnis už kritimą: operatorius
   * manytų, kad atkurtos sesijos revokuotos.
   */
  const paleisti = (args, env = {}) =>
    spawnSync(process.execPath, [path.join(SAKNIS, "scripts", "post-restore-reconcile.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "error", DATABASE_URL: "", PGHOST: "", ...env },
    });

  const memory = paleisti(["run", "--target", TAIKINYS, "--actor", "operatorius"]);
  assert.equal(memory.status, 2, "procedūros klaida yra exit 2");
  assert.match(memory.stderr, /RECONCILE_BACKEND_NOT_POSTGRES/);
  assert.equal(/Suderinta/.test(memory.stdout), false, "sėkmės pranešimo būti negali");

  const beActor = paleisti(["run", "--target", TAIKINYS]);
  assert.equal(beActor.status, 1, "naudojimo klaida yra exit 1");
  assert.match(beActor.stderr, /--actor/);

  const nezinoma = paleisti(["reconcile-everything"]);
  assert.equal(nezinoma.status, 1);

  const svetima = paleisti(["run", "--target", TAIKINYS, "--actor", "operatorius"], {
    DATABASE_URL: "postgres://u:p@db.vidinis:5432/kita",
  });
  assert.equal(svetima.status, 2);
  assert.match(svetima.stderr, /RECONCILE_TARGET_MISMATCH/);
});

test("#249: sėjimo seka yra LEGALI pagal lifecycle — tikrinama VIETOJE", async () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL DVIEJŲ SUGAIŠTŲ CI RAUNDŲ.
   *
   * Integracinio testo fixture krito ne ties tikrinamu elgesiu, o ties SĖJIMU:
   *
   *   1. `startPhase(job, "transcribing")` → `ILLEGAL_TRANSITION`
   *      (grafas yra `null → validating → transcribing → …`);
   *   2. `finishAtomic(job, "completed")` iš `queued` → `ILLEGAL_TERMINAL_TRANSITION`
   *      („nevykdytas darbas negali būti baigtas sėkmingai").
   *
   * Abi taisyklės yra `jobPhase` autoriteto, ne PostgreSQL — vadinasi atsakymą
   * duoda atminties backend'as per sekundę, ir CI'ui to klausimo užduoti
   * nereikia. Testas gina TĄ PAČIĄ seką, kurią naudoja integracinis testas:
   * helperis vienas.
   *
   * ⚠️ Tai ir yra šio raundo pamoka bendrąja forma: prielaidą, kurios patikrinti
   * NEREIKIA išorinio serviso, tikrinti CI'uje yra pasirinkimas laukti ilgiau
   * dėl to paties atsakymo.
   */
  const memory = require("../utils/jobStore/memoryStore");
  const { pasetiKeturisStatusus } = require("./helpers/postRestoreFixtures");

  const { queued, processing, failed, completed, zymetas } = await pasetiKeturisStatusus(memory, {
    ownerId: "11111111-1111-4111-8111-111111111111",
    storageKey: (vardas) => `audio/${vardas}-${crypto.randomUUID()}.wav`,
  });

  const busena = async (id) => {
    const j = await memory.get(id);
    return { status: j.status, phase: j.phase };
  };

  assert.deepEqual(await busena(queued.id), { status: "queued", phase: null });
  assert.deepEqual(await busena(processing.id), { status: "processing", phase: "transcribing" });
  assert.deepEqual(await busena(failed.id), { status: "failed", phase: null });
  assert.deepEqual(await busena(completed.id), { status: "completed", phase: null });
  assert.deepEqual(await busena(zymetas.id), { status: "queued", phase: null });

  /**
   * ⚠️ KONTROLĖ: `processing` job'as PRIVALO sėdėti gilesnėje nei pirmoji fazėje.
   * Kitaip integracinio testo teiginys „fazė nuvalyta" būtų tenkinamas ir tada,
   * kai valyti nebuvo ko.
   */
  assert.notEqual((await memory.get(processing.id)).phase, "validating");

  const rezultatas = await memory.get(completed.id);
  assert.ok(rezultatas.result, "`completed` be rezultato neegzistuoja (7.5b)");
});
