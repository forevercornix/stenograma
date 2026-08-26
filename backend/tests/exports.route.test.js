const { markCompleted } = require("./helpers/jobPhaseFixtures");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
delete process.env.PRIVACY_MODE;

const request = require("supertest");
const app = require("../server");
const auditLog = require("../utils/auditLog");

/**
 * GDPR #6: eksporto įvykiai audite + turinio/PII nutekėjimo patikra.
 */

const PII = {
  name: "Jonas Petraitis",
  email: "jonas.petraitis@pavyzdys.lt",
  phone: "+37061234567",
  personalCode: "39001010001",
  secret: "sk-ant-labai-slaptas-raktas",
};

function protocolWithPII() {
  return {
    pavadinimas: `Slaptas posėdis su ${PII.name}`,
    data: "2026-07-30",
    dalyviai: [PII.name, PII.email],
    darbotvarke: [`Susisiekti ${PII.phone}`],
    aptarti_klausimai: [
      { klausimas: "Asmens kodas", santrauka: `Patikrinti ${PII.personalCode}` },
    ],
    nutarimai: [`Naudoti raktą ${PII.secret}`],
    veiksmai: [
      { uzduotis: "Paskambinti", atsakingas: PII.name, terminas: "2026-08-01" },
    ],
  };
}

test.beforeEach(() => auditLog.clear());

test("POST /api/exports - txt eksportas grąžina failą ir įrašo audito įvykius", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: "job-abc" });

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/plain/);
  assert.match(res.headers["content-disposition"], /attachment; filename="protokolas_originalas_2026-07-30\.txt"/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.text.includes("PROTOKOLAS"));

  const events = (await auditLog.getAll()).map((entry) => entry.event);
  assert.deepEqual(events, ["EXPORT_STARTED", "EXPORT_COMPLETED"]);
});

test("POST /api/exports - csv eksportas su BOM ir veiksmų stulpeliais", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "csv", protocol: protocolWithPII() });

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.ok(res.text.startsWith("\uFEFF"), "Excel'iui reikalingas BOM");
  assert.match(res.text, /Užduotis/);
});

test("POST /api/exports - docx yra TIKRAS OOXML, ne HTML", async () => {
  const res = await request(app)
    .post("/api/exports")
    .set("Accept", "application/octet-stream")
    .send({ variant: "original", format: "docx", protocol: protocolWithPII() })
    .buffer()
    .parse((response, callback) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    });

  assert.equal(res.status, 200);
  assert.match(
    res.headers["content-type"],
    /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/
  );

  // OOXML yra ZIP - pirmi du baitai "PK".
  assert.equal(res.body.slice(0, 2).toString(), "PK");
  assert.ok(res.body.length > 1000);
});

test("POST /api/exports - nežinomas formatas atmetamas be audito įvykio", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ format: "pdf", protocol: protocolWithPII() });

  assert.equal(res.status, 400);
  // Variantas tikrinamas PIRMA (jis privalomas), tad formato klaidai gauti
  // reikia galiojančio varianto. Abu pranešimai vardija galimas reikšmes.
  // Vienas validacijos klaidų formatas (#14).
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.ok(res.body.details.some((issue) => issue.path === "format"));
  assert.equal((await auditLog.getAll()).length, 0, "atmesta užklausa nėra eksporto įvykis");
});

test("POST /api/exports - be protocol grąžina 400", async () => {
  const res = await request(app).post("/api/exports").send({ variant: "original", format: "txt" });

  assert.equal(res.status, 400);
});

test("audito įrašuose NĖRA jokio protokolo turinio ar PII", async () => {
  // GDPR #6 DoD: "Automated tests verify that representative PII does not appear in logs."
  for (const format of ["txt", "csv", "docx"]) {
    await request(app)
      .post("/api/exports")
      .send({ variant: "original", format, protocol: protocolWithPII(), jobId: "job-pii" });
  }

  const serialized = JSON.stringify((await auditLog.getAll()));

  for (const [label, value] of Object.entries(PII)) {
    assert.ok(
      !serialized.includes(value),
      `audito žurnale rastas ${label}: ${value}`
    );
  }

  // Taip pat neturi būti nei protokolo pavadinimo, nei failo vardo, nei tiesioginio jobId.
  assert.ok(!serialized.includes("Slaptas posėdis"));
  assert.ok(!serialized.includes("protokolas_originalas_2026-07-30"));
  assert.ok(!serialized.includes("job-pii"), "jobId turi būti pseudonimizuotas");

  // Bet naudingi techniniai metaduomenys - turi būti.
  assert.match(serialized, /EXPORT_COMPLETED/);
  // `format` persikėlė iš laisvos `details` eilutės į STRUKTŪRIZUOTĄ lauką -
  // kitaip audito nefiltruotum pagal formatą ar variantą (GDPR #17).
  assert.match(serialized, /"format":"docx"/);
  assert.match(serialized, /"variant":"(original|redacted)"/);
  assert.match(serialized, /"outcome":"delivered"/);
  assert.match(serialized, /bytes=\d+/);
});

test("eksporto įvykiai susieti su jobId pseudonimu - ištrinami kartu su jobu", async () => {
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  // Jobas turi REALIAI egzistuoti - nepatikrinto jobId ryšys nebekuriamas
  // (žr. audito vientisumo testus žemiau).
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id);

  await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: job.id });

  const subjectId = auditLog.pseudonymizeIdentifier(job.id);
  assert.ok((await auditLog.getAll()).every((entry) => entry.subjectId === subjectId));

  assert.equal(await auditLog.removeBySubjectIdentifier(job.id), 2);
  assert.equal((await auditLog.getAll()).length, 0);

  await jobStore.system.remove(job.id);
});

test("failo vardas nepasiduoda path traversal per protokolo datą", async () => {
  const protocol = protocolWithPII();
  protocol.data = "../../etc/passwd";

  const res = await request(app).post("/api/exports").send({ variant: "original", format: "txt", protocol });

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.headers["content-disposition"], /\.\./);
  assert.match(res.headers["content-disposition"], /filename="protokolas_originalas_[0-9A-Za-z-]+\.txt"/);
});

test("DELETE /api/transcribe-jobs/:id pašalina ir EKSPORTO įvykius", async () => {
  // Dėl to eksportui ir perduodamas jobId: kitaip EXPORT_* įrašai audite liktų
  // "be savininko" ir jų nepašalintų jobo ištrynimas.
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id, { result: { text: "transkripcija" } });

  await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: job.id });

  const subjectId = auditLog.pseudonymizeIdentifier(job.id);
  assert.equal((await auditLog.getAll()).filter((e) => e.subjectId === subjectId).length, 2);

  const res = await request(app).delete(`/api/transcribe-jobs/${job.id}`);
  assert.equal(res.status, 204);

  assert.equal(
    (await auditLog.getAll()).filter((e) => e.subjectId === subjectId).length,
    0,
    "eksporto įvykiai turi būti pašalinti kartu su jobu"
  );
});

test("CSV: formulėmis prasidedančios reikšmės eksportuojamos kaip TEKSTAS", async () => {
  // CSV formula injection: `veiksmai` turinys ateina iš LLM/vartotojo, o Excel
  // reikšmę, prasidedančią =, +, - ar @, vykdytų kaip formulę.
  const protocol = {
    data: "2026-07-30",
    veiksmai: [
      {
        uzduotis: '=HYPERLINK("https://evil.example","Atidaryti")',
        atsakingas: "+CMD",
        terminas: "@SUM(1+1)",
      },
      { uzduotis: "-5", atsakingas: "Jonas", terminas: "2026-08-01" },
    ],
  };

  const res = await request(app).post("/api/exports").send({ variant: "original", format: "csv", protocol });

  assert.equal(res.status, 200);

  const csv = res.text;

  // Nė viena reikšmė neturi prasidėti formulės simboliu.
  assert.ok(!csv.includes('"=HYPERLINK'), "= turi būti neutralizuotas");
  assert.ok(csv.includes("'=HYPERLINK"), "Papa prideda apostrofą");
  assert.ok(csv.includes("'+CMD"));
  assert.ok(csv.includes("'@SUM(1+1)"));
  assert.ok(csv.includes("'-5"));

  // Turinys vis tiek turi būti perskaitomas žmogui.
  assert.match(csv, /evil\.example/);
  assert.match(csv, /Jonas/);
});

test("eksporto auditas NEsusiejamas su neegzistuojančiu jobId (link=missing)", async () => {
  // Audito vientisumas: klientas negali savavališkai pasirinkti ryšio, kitaip
  // svetimo jobo ištrynimas pašalintų ir jam nepriklausančius eksporto įrašus.
  auditLog.clear();

  const res = await request(app).post("/api/exports").send({ variant: "original", format: "txt",
    protocol: protocolWithPII(),
    jobId: "issigalvotas-jobo-id",
  });

  assert.equal(res.status, 200, "eksportas neturi nutrūkti dėl audito ryšio");

  const entries = (await auditLog.getAll());
  assert.equal(entries.length, 2);

  for (const entry of entries) {
    assert.equal(entry.subjectId, null, "neturi būti ryšio su išgalvotu subjektu");
    assert.match(entry.details, /link=missing/);
  }

  assert.ok(
    !JSON.stringify(entries).includes("issigalvotas"),
    "nepatikrintas jobId niekur nesaugomas"
  );
});

test("eksporto auditas NEsusiejamas su PROTOKOLO jobu (link=invalid_type)", async () => {
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  const protocolJob = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await markCompleted(jobStore.system, protocolJob.id);

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: protocolJob.id });

  assert.equal(res.status, 200);
  assert.ok((await auditLog.getAll()).every((e) => e.subjectId === null));
  assert.ok((await auditLog.getAll()).every((e) => /link=invalid_type/.test(e.details)));

  await jobStore.system.remove(protocolJob.id);
});

test("eksporto auditas SUSIEJAMAS su realiu transkribavimo jobu", async () => {
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id);

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: job.id });

  assert.equal(res.status, 200);

  const subjectId = auditLog.pseudonymizeIdentifier(job.id);
  const own = (await auditLog.getAll()).filter((e) => e.subjectId === subjectId);

  assert.equal(own.length, 2);
  assert.ok(own.every((e) => /link=job/.test(e.details)));

  await jobStore.system.remove(job.id);
});

test("saugyklos klaida atskiriama nuo neegzistuojančio jobo (link=store_error + warning)", async () => {
  // Su bendra "unresolved" etikete neveikiantis Redis atrodytų lygiai taip pat kaip
  // išgalvotas ID, tad auditas paslėptų infrastruktūros problemą.
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  const originalGet = jobStore.get;
  const originalWarn = console.warn;
  const warnings = [];

  jobStore.get = async () => {
    const error = new Error("connect ECONNREFUSED redis://naudotojas:slaptas@10.0.0.5:6379");
    error.code = "ECONNREFUSED";
    throw error;
  };
  // SVARBU: ne String(), o JSON - `String({...})` duoda "[object Object]", tad
  // tikrinimas "ar slaptažodis nepatenka į logą" būtų tuščias (patikrinta: buvo).
  console.warn = (...args) =>
    warnings.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ")
    );

  try {
    const res = await request(app)
      .post("/api/exports")
      .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: "bet-koks-id" });

    // Eksportas neturi nutrūkti dėl audito ryšio patikros.
    assert.equal(res.status, 200);

    const entries = (await auditLog.getAll());
    assert.ok(entries.every((e) => /link=store_error/.test(e.details)));
    assert.ok(entries.every((e) => e.subjectId === null));

    // Įspėjimas serveryje - kad problema būtų pastebėta. Filtruojam pagal savo
    // pranešimą, nes console.warn naudoja ir kiti middleware (pvz. apiKeyAuth).
    const own = warnings.filter((line) => line.includes("saugyklos klaida"));
    assert.equal(own.length, 1);

    // Ir jis sanitizuotas: prisijungimo duomenys neturi nutekėti į logą.
    assert.ok(!own[0].includes("slaptas"), "slaptažodis negali patekti į logą");
    assert.ok(!own[0].includes("10.0.0.5"), "IP turi būti redaguotas");
  } finally {
    jobStore.get = originalGet;
    console.warn = originalWarn;
  }
});

test("visos link reikšmės yra iš žinomo rinkinio", async () => {
  const jobStore = require("../utils/jobStore");
  auditLog.clear();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id);

  await request(app).post("/api/exports").send({ variant: "original", format: "txt", protocol: protocolWithPII() });
  await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: job.id });
  await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPII(), jobId: "nera-tokio" });

  const states = new Set(
    (await auditLog.getAll()).map((entry) => (entry.details.match(/link=(\w+)/) || [])[1])
  );

  assert.deepEqual([...states].sort(), ["job", "missing", "none"]);

  await jobStore.system.remove(job.id);
});
