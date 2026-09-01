const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const auditLog = require("../utils/auditLog");
const auditWrite = require("../utils/auditWrite");
const { AuditWriteError, AuditWriteBlockedError, rasytiAudita } = auditWrite;
const { auditoGedimas } = require("../utils/auditHttp");
const tombstones = require("../utils/deletionTombstones");
const { arBlokuojantis } = require("../utils/auditEvents");

/**
 * AUDITO IŠTRYNIMO GALUTINUMAS — BARJERO ELGSENA (#155, 7.4e / #216).
 *
 * ⚠️ INVARIANTAS: sėkmingai baigus job'o ištrynimą, joks vėlesnis audito rašymas
 * tam job'ui NEGALI atkurti subjektui susietos eilutės.
 *
 * Iliustruojantis atvejis (`routes/exports.js`): užklausa išsprendžia
 * `linkedJobId`, rašo `EXPORT_STARTED`, generuoja ilgą eksportą, tuo metu
 * lygiagretus ištrynimas grąžina 204 — ir tada įrašomas `EXPORT_COMPLETED` tam
 * pačiam subjektui. Ištrynimas paskelbtas sėkmingu, o subjektas vėl turi eilutę.
 *
 * ⚠️ ŠIS FAILAS TIKRINA ELGSENĄ BE IŠORINIŲ SERVISŲ. Atominiai lenktynių
 * scenarijai (A/B/C) ir RAW DB įrodymas gyvena
 * `auditErasureFinality.integration.test.js` — jiems reikia tikros PostgreSQL.
 */

/**
 * ⚠️ `auditStore.init()` ČIA NEKVIEČIAMAS SĄMONINGAI.
 *
 * Numatytasis backend'as jau yra atmintinis, o eksplicitinis `init()` atstato
 * raktų generacijų būseną: `usedGenerations()` tada grąžina `[]`, ir
 * `removeBySubjectIdentifier()` neranda kandidatų. Tai pre-egzistuojanti 7.4c
 * savybė, ne 7.4e elgesys - bet jos įtraukimas į paruošimą tikrintų ne tai, ką
 * skelbia testas.
 */
async function svaru() {
  await tombstones._clearForTests();
  auditLog.clear();
  auditWrite._resetAuditCountersForTests();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. TRYS BŪSENOS: ALLOW · BLOCK · CHECK FAILED
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 ALLOW: nepažymėtas subjektas rašomas normaliai", async () => {
  await svaru();

  const eilute = await auditLog.record({ event: "EXPORT_COMPLETED", jobId: "leidziamas", success: true });

  assert.equal(eilute.subjectId, auditLog.pseudonymizeIdentifier("leidziamas"));
  assert.equal((await auditLog.getAll()).length, 1);
});

test("#216 BLOCK: pažymėtam subjektui `record()` meta `AuditWriteBlockedError`, o eilutės NĖRA", async () => {
  await svaru();
  await tombstones.mark("uzblokuotas");

  await assert.rejects(
    () => auditLog.record({ event: "EXPORT_COMPLETED", jobId: "uzblokuotas", success: true }),
    (klaida) => {
      /**
       * ⚠️ PAVELDĖJIMAS TIKRINAMAS EKSPLICITIŠKAI. `rasytiAudita()` catch daro
       * `klaida instanceof AuditWriteError ? klaida : new AuditWriteError(...)`,
       * tad be paveldėjimo blokas ties riba būtų suvyniotas, ir skirtumas
       * dingtų būtent ten, kur jis matomas kvietėjui.
       */
      assert.ok(klaida instanceof AuditWriteBlockedError);
      assert.ok(klaida instanceof AuditWriteError, "privalo paveldėti - žr. rasytiAudita catch");
      assert.equal(klaida.code, "AUDIT_WRITE_BLOCKED");
      return true;
    }
  );

  assert.equal((await auditLog.getAll()).length, 0, "užblokuota eilutė NEGALI atsirasti");
});

test("#216 BLOCK: `record()` NEGRĄŽINA sėkmingo įrašo objekto (jokio `saved || row`)", async () => {
  await svaru();
  await tombstones.mark("jokio-fallback");

  let grazinta = "nepakeista";
  try {
    grazinta = await auditLog.record({ event: "EXPORT_COMPLETED", jobId: "jokio-fallback", success: true });
  } catch {
    grazinta = "metė";
  }

  assert.equal(grazinta, "metė", "`return issaugota || row` paverstų barjero atmetimą sėkmingu įrašu");
});

test("#216 CHECK FAILED: barjero patikros gedimas NĖRA „subjektas nepažymėtas“", async () => {
  await svaru();

  /**
   * ⚠️ TRYS BŪSENOS, NE DVI. Patikros gedimas (DB timeout, jungtis, užklausa)
   * negali būti tyliai palaikytas ALLOW — tai fail-open ta pačia kryptimi, kurią
   * barjeras ir uždaro.
   *
   * Perimamas MODULIO EKSPORTAS, nes `memoryStore.append()` kviečia
   * `tombstones.isBarred(...)` per objektą, ne destruktūrizuotą nuorodą.
   */
  const originalus = tombstones.isBarred;
  tombstones.isBarred = async () => {
    throw new Error("simuliuotas DB gedimas patikros metu");
  };

  try {
    await assert.rejects(
      () => auditLog.record({ event: "EXPORT_COMPLETED", jobId: "patikra-krito", success: true }),
      /simuliuotas DB gedimas/
    );
    assert.equal((await auditLog.getAll()).length, 0, "gedimas NEGALI virsti įrašyta eilute");
  } finally {
    tombstones.isBarred = originalus;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. `rasytiAudita()` POLITIKA ABIEM KATEGORIJOMS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 BLOCK · blokuojantis įvykis: operacija ATMETAMA (fail-closed)", async () => {
  await svaru();
  await tombstones.mark("blok-atmetimas");

  await assert.rejects(
    () => rasytiAudita({ event: "ADMIN_DELETE_OVERRIDE", jobId: "blok-atmetimas", success: true }),
    (klaida) => {
      assert.ok(klaida instanceof AuditWriteError);
      assert.equal(klaida.code, "AUDIT_WRITE_BLOCKED", "blokas privalo išlikti atskiriamas ties riba");
      return true;
    }
  );
});

test("#216 BLOCK · ne-blokuojantis įvykis: operacija TĘSIASI, eilutės nėra, `unhandledRejection` nėra", async () => {
  await svaru();
  await tombstones.mark("neblok-tesiasi");

  const netvarkytos = [];
  const gaudytojas = (p) => netvarkytos.push(p);
  process.on("unhandledRejection", gaudytojas);

  try {
    const rezultatas = await rasytiAudita({
      event: "EXPORT_COMPLETED",
      jobId: "neblok-tesiasi",
      success: true,
    });

    assert.equal(rezultatas, null, "ne-blokuojantis gedimas grąžinamas NORMALIAI, bet be eilutės");
    assert.equal((await auditLog.getAll()).length, 0);
    assert.equal(auditWrite.getAuditCounters().auditWriteFailures, 1, "gedimas privalo būti MATOMAS");

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(netvarkytos, [], "užblokuotas rašymas negali tapti unhandledRejection");
  } finally {
    process.off("unhandledRejection", gaudytojas);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. APIMTIS: TIK SUBJEKTUI SUSIETOS EILUTĖS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 APIMTIS: įvykis BE subject binding nepavaldus barjerui", async () => {
  await svaru();
  await tombstones.mark("pazymetas-bet-nesusietas");

  /**
   * Be `jobId` subjekto nėra, tad barjeras netaikomas. Kitaip vieno job'o
   * ištrynimas sustabdytų su juo NESUSIJUSĮ auditą — pvz. `LOGIN_SUCCESS`.
   */
  const eilute = await auditLog.record({ event: "LOGIN_SUCCESS", success: true });

  assert.equal(eilute.subjectId, null);
  assert.equal((await auditLog.getAll()).length, 1);
});

test("#216 APIMTIS: kito job'o žyma neblokuoja šio job'o audito", async () => {
  await svaru();
  await tombstones.mark("svetimas");

  const eilute = await auditLog.record({ event: "EXPORT_COMPLETED", jobId: "savas", success: true });
  assert.ok(eilute.id);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. BARJERAS PRASIDEDA NUO `deletion_pending`
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 BŪSENOS: barjerą laiko `deletion_pending`, `deleted` IR `deletion_failed`", async () => {
  /**
   * ⚠️ LAUKTI `deleted` REIKŠTŲ PALIKTI LANGĄ, LYGŲ IŠTRYNIMO TRUKMEI.
   * `deletion_failed` barjerą irgi LAIKO: nepavykęs ištrynimas reiškia, kad
   * jautrūs duomenys gali dar egzistuoti.
   */
  const { TOMBSTONE_STATUS } = require("../utils/deletionTombstones/states");

  for (const busena of [TOMBSTONE_STATUS.PENDING, TOMBSTONE_STATUS.DELETED, TOMBSTONE_STATUS.FAILED]) {
    await svaru();
    await tombstones.mark("busenu-testas");

    if (busena !== TOMBSTONE_STATUS.PENDING) {
      await tombstones.complete("busenu-testas", busena);
    }

    const zyma = await tombstones.barrierState("busenu-testas");
    assert.equal(zyma.status, busena, "pre-būsena privalo atitikti scenarijų");

    await assert.rejects(
      () => auditLog.record({ event: "EXPORT_COMPLETED", jobId: "busenu-testas", success: true }),
      (k) => k.code === "AUDIT_WRITE_BLOCKED",
      `barjeras privalo galioti būsenoje ${busena}`
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. KEŠO NĖRA
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 BE KEŠO: ką tik sukurta žyma veikia IŠ KARTO", async () => {
  await svaru();

  /** Pirmas rašymas praeina - žymos dar nėra. */
  await auditLog.record({ event: "EXPORT_STARTED", jobId: "kesas", success: true });

  /** Žyma atsiranda TARP dviejų rašymų - tiksliai tas langas, kurį barjeras uždaro. */
  await tombstones.mark("kesas");

  await assert.rejects(
    () => auditLog.record({ event: "EXPORT_COMPLETED", jobId: "kesas", success: true }),
    (k) => k.code === "AUDIT_WRITE_BLOCKED",
    "kešuotas ALLOW atvertų būtent tą langą, kurį barjeras uždaro"
  );

  assert.equal((await auditLog.getAll()).length, 1, "turi likti TIK pirmasis įrašas");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. PRIVATUMAS: TRANSIENTINIS `job_id`
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 PRIVATUMAS: barjerui naudojamas `jobId` NEPERSISTINAMAS eilutėje", async () => {
  await svaru();

  const jobId = "slaptas-job-id-7f3a";
  const eilute = await auditLog.record({ event: "EXPORT_COMPLETED", jobId, success: true });

  assert.equal("jobId" in eilute, false, "`jobId` negali tapti eilutės lauku");

  const serializuota = JSON.stringify(await auditLog.getAll());
  assert.equal(
    serializuota.includes(jobId),
    false,
    "plikas job ID neturi būti nė viename lauke - RAW DB atitikmuo integraciniame teste"
  );
});

test("#216 PRIVATUMAS: `JOB_EXECUTION_DENIED` `details` nebeneša plikojo job ID", async () => {
  /**
   * ⚠️ ATSINEŠTAS 7.4b PAŽEIDIMAS, PATAISYTAS ČIA.
   *
   * `details` yra `auditStore/fields.js` `META_LAUKAI` allowlist'e, tad jo
   * turinys persistinamas į `audit_log.meta` JSONB. `jobId=${jobId}`
   * interpoliacija reiškė plikąjį identifikatorių audito lentelėje, kurio
   * `removeBySubjectIdentifier()` niekada nepasiektų (`subjectId` čia `null`).
   */
  const saltinis = fs.readFileSync(path.join(__dirname, "..", "utils", "jobAuthorization.js"), "utf8");

  assert.equal(
    /details:\s*`[^`]*\$\{jobId\}/.test(saltinis),
    false,
    "`jobId` interpoliacija į `details` persistina plikąjį identifikatorių"
  );
});

test("#216 TRIPWIRE: joks produkcinis `details` neinterpoliuoja plikojo job/meeting ID", () => {
  /**
   * ⚠️ TRIPWIRE, NE ELGSENOS ĮRODYMAS (AGENTS.md §9.2). Uždaro KLASĘ, ne atvejį:
   * `META_LAUKAI` praleidžia `details` į `meta` JSONB, tad bet kuri būsima
   * interpoliacija ten atsidurtų taip pat tyliai.
   *
   * ⚠️ APIMTIS SIAURA IR SĄMONINGAI: tikrinamas job/meeting ID. `routes/auth.js`
   * tuo pačiu keliu persistina `username=` — tai realus, atskiras radinys, bet
   * ne 7.4e apimtis; jam skirtas atskiras issue juodraštis.
   */
  const KATALOGAI = ["routes", "services", "utils", "middleware", "queues", "workers"];
  const SABLONAS = /details:\s*`[^`]*\$\{\s*(jobId|meetingId|job\.id)\s*\}/;

  const pazeidimai = [];

  const eiti = (dir) => {
    for (const irasas of fs.readdirSync(dir, { withFileTypes: true })) {
      const pilnas = path.join(dir, irasas.name);
      if (irasas.isDirectory()) eiti(pilnas);
      else if (irasas.name.endsWith(".js") && SABLONAS.test(fs.readFileSync(pilnas, "utf8"))) {
        pazeidimai.push(path.relative(path.join(__dirname, ".."), pilnas));
      }
    }
  };

  for (const k of KATALOGAI) {
    const kelias = path.join(__dirname, "..", k);
    if (fs.existsSync(kelias)) eiti(kelias);
  }

  assert.deepEqual(pazeidimai, [], "`details` persistinamas į `meta` JSONB - plikas ID ten patektų");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. INLINE KELIAS BE `jobId`
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 INLINE: `meetingId` be `jobId` NEBEKURIA persistentinio GDPR subjekto", async () => {
  await svaru();

  /**
   * ⚠️ IKI 7.4e: `subjectId = pseudonymizeIdentifier(jobId ?? meetingId)`.
   *
   * Inline `/api/generate` `jobId` neturi, tad subjektu tapdavo
   * `HMAC(meetingId)` — o `removeBySubjectIdentifier(jobId)` ieško PAGAL JOB ID
   * ir tokio įrašo NIEKADA neranda. Rezultatas: persistentinis subjektas, kurio
   * job erasure negali ištrinti.
   */
  const eilute = await auditLog.record({
    event: "PROTOCOL_COMPLETED",
    meetingId: "vartotojo-susitikimas",
    llmProvider: "mock",
    success: true,
  });

  assert.equal(eilute.subjectId, null, "be `jobId` subjekto binding'o būti negali");
  assert.equal(
    await auditLog.removeBySubjectIdentifier("vartotojo-susitikimas"),
    0,
    "nesukurtas subjektas neturi ką ištrinti"
  );

  const serializuota = JSON.stringify(await auditLog.getAll());
  assert.equal(serializuota.includes("vartotojo-susitikimas"), false, "nei plikas, nei jokia forma");
});

test("#216 INLINE: su `jobId` subjektas IŠLIEKA ir ištrinamas", async () => {
  await svaru();

  await auditLog.record({
    event: "PROTOCOL_COMPLETED",
    jobId: "job-su-id",
    meetingId: "tas-pats-susitikimas",
    llmProvider: "mock",
    success: true,
  });

  assert.equal(await auditLog.removeBySubjectIdentifier("job-su-id"), 1);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. HTTP ATVAIZDAVIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

function fakeRes() {
  return {
    kodas: null,
    kunas: null,
    status(k) {
      this.kodas = k;
      return this;
    },
    json(k) {
      this.kunas = k;
      return this;
    },
  };
}

test("#216 HTTP: blokas atsako 404 su TUO PAČIU kūnu kaip nerastas jobas", () => {
  /**
   * ⚠️ 503 BŪTŲ MELAGINGAS SIGNALAS: „bandykite vėliau" reiškia laikiną gedimą,
   * o pakartojimas niekada nepavyks — subjektas ištrintas.
   *
   * ⚠️ KŪNAS IDENTIŠKAS `routes/jobs.js` 404 keliui (AGENTS.md §16). 410 arba
   * savas `code` leistų kvietėjui, spėliojančiam job ID, atskirti „niekada
   * nebuvo" nuo „buvo ir ištrintas" — teigiamą patvirtinimą apie ištrintą
   * subjektą.
   */
  const res = fakeRes();
  auditoGedimas(res, new AuditWriteBlockedError("EXPORT_COMPLETED"), "testas");

  assert.equal(res.kodas, 404);
  assert.deepEqual(res.kunas, { error: "Jobas nerastas." });
  assert.equal("code" in res.kunas, false, "`code` grąžintų tą patį atskyrimą pro galines duris");
});

test("#216 HTTP: kitas audito gedimas ir toliau 503 `AUDIT_WRITE_FAILED`", () => {
  const res = fakeRes();
  auditoGedimas(res, new AuditWriteError("EXPORT_COMPLETED", "timeout"), "testas");

  assert.equal(res.kodas, 503);
  assert.equal(res.kunas.code, "AUDIT_WRITE_FAILED");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. APIMTIES IR PRIELAIDŲ TRIPWIRE'AI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 MEMORY: `memoryStore` neturi netikrų `erasure_marks` — kviečia TĄ PATĮ autoritetą", () => {
  const saltinis = fs.readFileSync(
    path.join(__dirname, "..", "utils", "auditStore", "memoryStore.js"),
    "utf8"
  );

  assert.match(saltinis, /require\("\.\.\/deletionTombstones"\)/, "autoritetas privalo būti bendras");

  /**
   * ⚠️ KOMENTARAI NUIMAMI PRIEŠ SKENUOJANT (AGENTS.md §9.2).
   *
   * Be to patikra pagautų SAVO PAČIOS dokumentaciją: `memoryStore` komentaras
   * kaip tik ir sako „netikrų `erasure_marks` čia nėra". Tai patikrinta - būtent
   * taip ir nutiko pirmoje šio testo versijoje.
   *
   * ⚠️ NE PER `beKomentaru()`: jis registruotas kaip žinomas defektas (regex
   * nuryja kodą, kai `/*` yra eilutės literale). Čia užtenka eilučių filtro,
   * nes ieškoma tik lentelės vardo.
   */
  const kodas = saltinis
    .split("\n")
    .filter((e) => {
      const t = e.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

  assert.equal(
    /erasure_marks|tombstoneStub|netikra[sZ]ym/i.test(kodas),
    false,
    "antra tiesos kopija atmintiniame backend'e būtų tiksliai tai, ko #216 vengia"
  );
});

test("#216 LATENTINĖ GARANTIJA: nė vienas produkcinis BLOKUOJANTIS įvykis nėra susietas su subjektu", () => {
  /**
   * ⚠️ ŠIS TESTAS FIKSUOJA APRIBOJIMĄ, NE PADENGIMĄ (AGENTS.md §12.1).
   *
   * Po 7.4e visi subjektui susieti produkciniai rašymai yra NE-BLOKUOJANTYS
   * (`EXPORT_*`, `PROTOCOL_*`, `TRANSCRIPTION_*`, `UPLOAD_REJECTED`), o septyni
   * administravimo įvykiai subjekto neteko sąmoningai. Vadinasi „BLOCK ant
   * blokuojančio atmeta operaciją" produkciniame kelyje NEIŠSIKVIEČIA — jis
   * įrodomas sintetiniu įvykiu (žr. testą §2 aukščiau).
   *
   * Testas saugo abi puses: jei kas nors ateityje SUSIETŲ blokuojantį įvykį su
   * `jobId`, jis krinta ir priverčia įvertinti, ar tas kelias atlaikys barjerą.
   */
  const KATALOGAI = ["routes", "services", "utils", "middleware", "queues", "workers"];
  const susieti = [];

  const eiti = (dir) => {
    for (const irasas of fs.readdirSync(dir, { withFileTypes: true })) {
      const pilnas = path.join(dir, irasas.name);
      if (irasas.isDirectory()) {
        eiti(pilnas);
        continue;
      }
      if (!irasas.name.endsWith(".js")) continue;

      const s = fs.readFileSync(pilnas, "utf8");

      for (const m of s.matchAll(/rasytiAudita\(\{/g)) {
        let gylis = 0;
        let i = m.index + m[0].length - 1;
        const pradzia = i;

        while (i < s.length) {
          if (s[i] === "{") gylis += 1;
          else if (s[i] === "}") {
            gylis -= 1;
            if (gylis === 0) break;
          }
          i += 1;
        }

        const blokas = s.slice(pradzia, i + 1);
        if (!/\n\s*jobId[,:]/.test(blokas)) continue;

        const ev = blokas.match(/event:\s*"([A-Z_]+)"/);
        if (!ev) continue;

        let blokuojantis;
        try {
          blokuojantis = arBlokuojantis(ev[1]);
        } catch {
          continue;
        }

        if (blokuojantis) {
          susieti.push(`${path.relative(path.join(__dirname, ".."), pilnas)}: ${ev[1]}`);
        }
      }
    }
  };

  for (const k of KATALOGAI) {
    const kelias = path.join(__dirname, "..", k);
    if (fs.existsSync(kelias)) eiti(kelias);
  }

  assert.deepEqual(
    susieti,
    [],
    "blokuojantis subjektui susietas įvykis būtų atmestas barjero - įvertinkite kelią prieš jį susiejant"
  );
});

test("#216 PRIELAIDA: barjero patikra telpa į `AUDIT_WRITE_TIMEOUT_MS` biudžetą", async () => {
  /**
   * ⚠️ VIRŠIJIMAS YRA CHECK FAILED, NE ALLOW.
   *
   * Barjeras vykdomas `append()` VIDUJE, tad jis yra po ta pačia
   * `suRiba(record(...), AUDIT_WRITE_TIMEOUT_MS)` riba. Lėta patikra duoda
   * timeout, o timeout — `AuditWriteError`, ne tylų praėjimą.
   */
  await svaru();

  const originalus = tombstones.isBarred;
  const originaliRiba = process.env.AUDIT_WRITE_TIMEOUT_MS;

  process.env.AUDIT_WRITE_TIMEOUT_MS = "40";
  tombstones.isBarred = () => new Promise((r) => setTimeout(() => r(false), 400));

  try {
    await assert.rejects(
      () => rasytiAudita({ event: "ADMIN_DELETE_OVERRIDE", jobId: "letas", success: true }),
      (k) => k instanceof AuditWriteError && /timeout/.test(k.message),
      "lėta barjero patikra privalo baigtis CHECK FAILED, ne ALLOW"
    );

    assert.equal((await auditLog.getAll()).length, 0);
  } finally {
    tombstones.isBarred = originalus;
    if (originaliRiba === undefined) delete process.env.AUDIT_WRITE_TIMEOUT_MS;
    else process.env.AUDIT_WRITE_TIMEOUT_MS = originaliRiba;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. VIENA IŠSPRĘSTA KONFIGŪRACIJA (audito ir žymų pool'ai)
 * ══════════════════════════════════════════════════════════════════════════ */

test("#216 KONFIGŪRACIJA: audito ir žymų jungtys statomos iš TO PATIES šaltinio", () => {
  /**
   * ⚠️ BE ŠITO BARJERAS TYLIAI NIEKADA NESUVEIKTŲ.
   *
   * `auditStore` `AUDIT_BACKEND=postgres` priima `DATABASE_URL` ARBA `PGHOST`,
   * o `deletionTombstones` iki 7.4e postgres rinkosi TIK su `DATABASE_URL`.
   * Dokumentuotame Compose diegime (`PG*`, be `DATABASE_URL`) auditas eitų į
   * PostgreSQL, o žymos liktų ATMINTYJE — barjeras skaitytų tuščią lentelę.
   *
   * Suderinamumo patikra to neišspręstų: ji reikalautų `DATABASE_URL`, o jį
   * pridėjus kristų `DATABASE_URL` + `PGHOST` konfliktas — aklavietė. Todėl
   * suvienodinta pati ATRANKA, o tapatumas galioja PAGAL KONSTRUKCIJĄ.
   */
  const { pgJungtiesNustatymai, arNurodytaPostgres } = require("../utils/pgConnection");

  assert.equal(arNurodytaPostgres({ PGHOST: "db" }), true, "`PG*` privalo reikšti PostgreSQL abiem");
  assert.equal(arNurodytaPostgres({ DATABASE_URL: "postgres://x/y" }), true);
  assert.equal(arNurodytaPostgres({}), false);

  const pg = pgJungtiesNustatymai({ PGHOST: "db", PGPORT: "5433", PGDATABASE: "s" });
  assert.deepEqual(pg, { host: "db", port: 5433, database: "s" });
  assert.equal("connectionString" in pg, false, "dvi formos kartu padarytų pirmenybę neakivaizdžia");

  const url = pgJungtiesNustatymai({ DATABASE_URL: "postgres://x/y", PGHOST: "ignoruojamas" });
  assert.deepEqual(url, { connectionString: "postgres://x/y" });

  /** Abu moduliai privalo imti DSN iš to paties helperio, ne kartoti logiką. */
  for (const failas of [
    path.join("utils", "auditStore", "index.js"),
    path.join("utils", "deletionTombstones", "index.js"),
  ]) {
    const s = fs.readFileSync(path.join(__dirname, "..", failas), "utf8");
    assert.match(s, /require\("\.\.?\/\.\.?\/pgConnection"\)|require\("\.\.\/pgConnection"\)/, failas);
  }
});

test("#216 `null` iš saugyklos yra NESĖKMĖ, ne sėkmė (buvęs `saved || row`)", async () => {
  /**
   * ⚠️ ŠIS KELIAS PASIEKIAMAS TIK PostgreSQL REŽIME, tad tikrinamas su pakeista
   * saugykla, o ne su atmintine (ji `null` negrąžina niekada).
   *
   * `postgresStore.append()` grąžina `null`, kai `ON CONFLICT DO NOTHING`
   * praleido įterpimą, o po jo `SELECT` eilutės neberado - t. y. ją ištrynė
   * erasure TARP dviejų sakinių. Buvęs `return issaugota || row` tokį atvejį
   * paversdavo sėkmingu įrašu su VIETINIU objektu.
   *
   * Perimamas `auditStore.current`, nes `auditLog.record()` kviečia būtent jį.
   */
  await svaru();

  const auditStore = require("../utils/auditStore");
  const originalus = auditStore.current;
  auditStore.current = () => ({ append: async () => null });

  try {
    await assert.rejects(
      () => auditLog.record({ event: "EXPORT_COMPLETED", jobId: "null-kelias", success: true }),
      (klaida) => {
        assert.ok(klaida instanceof AuditWriteError);
        assert.match(klaida.message, /nepatvirtino/);
        return true;
      },
      "`null` privalo tapti typed nesėkme, ne vietiniu objektu"
    );
  } finally {
    auditStore.current = originalus;
  }
});

test("#216 APIMTIS: `append()` su `jobId`, bet BE `subjectId`, barjerui nepavaldus", async () => {
  /**
   * ⚠️ TIKRINAMA TIESIOGIAI PER SAUGYKLĄ.
   *
   * Per `record()` abi sąlygos sutampa: kai yra `jobId`, yra ir `subjectId`.
   * Todėl `eilute.subjectId` sargyba yra gynyba į gylį TIESIOGINIAMS `append()`
   * kvietėjams - ir be šio testo jos pašalinimas nieko nesulaužytų (patikrinta
   * mutacija M11).
   */
  await svaru();
  await tombstones.mark("tiesioginis");

  const memoryStore = require("../utils/auditStore/memoryStore");

  const grazinta = await memoryStore.append(
    {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      event: "LOGIN_SUCCESS",
      subjectId: null,
      result: "success",
      requestId: null,
    },
    { jobId: "tiesioginis" }
  );

  assert.ok(grazinta, "eilutė be subjekto niekam nepriklauso - barjeras jai netaikomas");
});

test("#216 KONFIGŪRACIJA: žymų backend'o atranka priima `PGHOST`, ne tik `DATABASE_URL`", () => {
  /**
   * ⚠️ BE ŠIO TESTO ATSUKIMAS NIEKO NESULAUŽTŲ (patikrinta mutacija M9).
   *
   * Grąžinus `env.DATABASE_URL ? "postgres" : "memory"`, dokumentuotas Compose
   * diegimas (`PG*`) vėl gautų auditą PostgreSQL'e ir žymas ATMINTYJE - barjeras
   * skaitytų tuščią lentelę ir visada praleistų, tyliai.
   */
  assert.equal(tombstones.pasirinktiBackend({ PGHOST: "db" }), "postgres");
  assert.equal(tombstones.pasirinktiBackend({ DATABASE_URL: "postgres://x/y" }), "postgres");
  assert.equal(tombstones.pasirinktiBackend({}), "memory");
});
