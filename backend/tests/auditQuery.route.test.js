const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
delete process.env.AUDIT_API_KEY;

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const app = require("../server");
app._setReadyForTests();

/**
 * `GET /api/audit` KONTRAKTAS PO 7.4c (#212).
 *
 * ⚠️ ŠIS MARŠRUTAS TURI BREAKING CHANGE LANGĄ, IR JIS SĄMONINGAS.
 *
 * `offset` → `cursor`, `event` → `action`, `total` pašalintas. Visi trys
 * pakeitimai daromi VIENU kartu: du vardai tam pačiam filtrui arba tylus
 * `OFFSET` fallback būtų būtent ta drift'o rūšis, kurios #212 vengia.
 */

async function iraso(kiek, perrasymai = {}) {
  const sukurti = [];
  for (let i = 0; i < kiek; i += 1) {
    sukurti.push(
      await auditLog.record({
        event: "PROCESSING_COMPLETED",
        jobId: `job-marsruto-${i}`,
        success: true,
        details: `nr-${i}`,
        ...perrasymai,
      })
    );
  }
  return sukurti;
}

test("PUSLAPIAVIMAS: `next_cursor` veda per visus įrašus be dublikatų", async () => {
  auditLog.clear();
  await iraso(7);

  const matyti = [];
  let cursor = null;
  let puslapiu = 0;

  do {
    const url = `/api/audit?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await request(app).get(url);

    assert.equal(res.status, 200);
    assert.ok(res.body.entries.length > 0, "tuščias puslapis neleidžiamas");

    matyti.push(...res.body.entries.map((e) => e.details));
    cursor = res.body.next_cursor;
    puslapiu += 1;
  } while (cursor !== null && puslapiu < 10);

  assert.equal(new Set(matyti).size, matyti.length, "dublikatų būti negali");
  assert.equal(matyti[0], "nr-6", "naujausi pirma (DESC)");
  assert.equal(cursor, null, "`next_cursor` privalo tapti null");
});

test("KONTRAKTAS: `total` ir `offset` iš atsakymo PAŠALINTI", async () => {
  auditLog.clear();
  await iraso(2);

  const res = await request(app).get("/api/audit?limit=1");

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["entries", "limit", "next_cursor"]);
});

test("MIGRACIJA: `offset` ir `event` ATMETAMI su 400", async () => {
  /**
   * ⚠️ Schema yra `.strict()`, tad pašalinus laukus jie savaime tampa 400. Bet
   * tai vis tiek POLITIKOS sprendimas šiam maršrutui, ne šalutinis efektas -
   * todėl tikrinamas eksplicitiškai (#212).
   */
  for (const [parametras, url] of [
    ["offset", "/api/audit?limit=2&offset=0"],
    ["event", "/api/audit?event=LOGIN_SUCCESS"],
  ]) {
    const res = await request(app).get(url);
    assert.equal(res.status, 400, `${parametras} privalo būti atmestas, ne tyliai ignoruojamas`);
  }
});

test("KURSORIUS: sugadintas duoda 400, NE 500", async () => {
  /**
   * ⚠️ Tai kliento klaida. Be atskiro apdorojimo `CursorError` nukristų į bendrą
   * `catch` ir virstų 500 - serverio gedimu, kurio nėra.
   */
  for (const blogas of ["!!!", "abc", Buffer.from("[1,2]").toString("base64url"), "x".repeat(400)]) {
    const res = await request(app).get(`/api/audit?cursor=${encodeURIComponent(blogas)}`);

    assert.equal(res.status, 400, `"${blogas.slice(0, 12)}" turi duoti 400`);
    assert.equal(res.body.code, "AUDIT_CURSOR_INVALID");
  }
});

test("KURSORIUS: su PAKEISTAIS filtrais atmetamas, o ne tyliai grąžina kitus rezultatus", async () => {
  auditLog.clear();
  await iraso(5, { event: "LOGIN_SUCCESS" });

  const pirmas = await request(app).get("/api/audit?limit=2&action=LOGIN_SUCCESS");
  assert.equal(pirmas.status, 200);
  assert.ok(pirmas.body.next_cursor, "prielaida: yra kitas puslapis");

  const suKitu = await request(app).get(
    `/api/audit?limit=2&action=LOGOUT&cursor=${encodeURIComponent(pirmas.body.next_cursor)}`
  );

  assert.equal(suKitu.status, 400, "kursorius susietas su filtrų aibe");
  assert.equal(suKitu.body.code, "AUDIT_CURSOR_INVALID");
});

test("FILTRAI: `action`, `request_id` ir `job_id` komponuojasi", async () => {
  auditLog.clear();

  const { runWithContext } = require("../utils/requestContext");

  await runWithContext({ requestId: "req-taikinys" }, async () => {
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-taikinys", success: true });
  });
  await runWithContext({ requestId: "req-kitas" }, async () => {
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-taikinys", success: true });
  });
  await auditLog.record({ event: "LOGIN_FAILED", jobId: "job-taikinys", success: false });
  await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-kitas", success: true });

  const res = await request(app).get(
    "/api/audit?action=LOGIN_SUCCESS&requestId=req-taikinys&jobId=job-taikinys"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1, "trys filtrai privalo susikirsti");
  assert.equal(res.body.entries[0].event, "LOGIN_SUCCESS");
  assert.equal(res.body.entries[0].requestId, "req-taikinys");
});

test("PRIVATUMAS: `job_id` filtras veikia, bet plikas ID NEGRĮŽTA atsakyme", async () => {
  /**
   * ⚠️ #212: `job_id` niekada netampa plaintext lauku. Filtras jį paverčia
   * kandidatiniais `subject_id`, o atsakyme lieka tik pseudonimas.
   */
  auditLog.clear();

  const SENTINEL = "job-PLIKAS-SENTINEL-a7f3";
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: SENTINEL, success: true });
  await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "kitas-job", success: true });

  const res = await request(app).get(`/api/audit?jobId=${encodeURIComponent(SENTINEL)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1, "filtras privalo rasti būtent tą įrašą");

  const serializuota = JSON.stringify(res.body);
  assert.ok(!serializuota.includes(SENTINEL), "plikas job ID negali grįžti atsakyme");
  assert.ok(res.body.entries[0].subjectId, "grąžinamas pseudonimas");

  /** ⚠️ Ir kursoriuje jo irgi nėra - jis keliauja URL'e. */
  if (res.body.next_cursor) {
    const atkoduota = Buffer.from(res.body.next_cursor, "base64url").toString("utf8");
    assert.ok(!atkoduota.includes(SENTINEL), "job ID negali keliauti kursoriuje");
  }
});

test("FILTRAI: `from`/`to` validuojami, o `from > to` yra 400", async () => {
  const netinkami = [
    ["ne ISO-8601", "/api/audit?from=vakar"],
    ["tik data be laiko", "/api/audit?from=2026-08-01"],
    ["from > to", "/api/audit?from=2026-08-02T00:00:00Z&to=2026-08-01T00:00:00Z"],
  ];

  for (const [pavadinimas, url] of netinkami) {
    assert.equal((await request(app).get(url)).status, 400, `${pavadinimas} privalo duoti 400`);
  }

  const geras = await request(app).get("/api/audit?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z");
  assert.equal(geras.status, 200, "teisingas intervalas privalo veikti");
});

test("FILTRAI: `from`/`to` realiai apriboja rinkinį", async () => {
  auditLog.clear();
  await iraso(3);

  const ateitis = new Date(Date.now() + 3600_000).toISOString();
  const tuscias = await request(app).get(`/api/audit?from=${ateitis}`);

  assert.equal(tuscias.status, 200);
  assert.deepEqual(tuscias.body.entries, [], "ateities intervalas įrašų neturi");
  assert.equal(tuscias.body.next_cursor, null, "tuščiam rezultatui kursoriaus nėra");

  const praeitis = new Date(Date.now() - 3600_000).toISOString();
  const visi = await request(app).get(`/api/audit?from=${praeitis}`);
  assert.equal(visi.body.entries.length, 3);
});
