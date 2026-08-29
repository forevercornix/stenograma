const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * PERSISTENTINĖS IŠTRYNIMO ŽYMOS (#155, 7.5a / #183).
 *
 * ⚠️ ČIA GYVENA TAI, KĄ GALIMA ĮRODYTI BE DUOMENŲ BAZĖS: būsenų mašina,
 * allowlist'ai, retencijos formulė ir jos fail-safe, atmintinio režimo elgesys.
 *
 * SQL teisingumas - sąlyginių `UPDATE` formos, advisory lock'as, FK nebuvimas,
 * lygiagretumas tarp pool'ų - įrodomas `erasureMarks.integration.test.js` ir be
 * tikros PostgreSQL NĖRA `PASS` (AGENTS.md §14).
 */

const tombstones = require("../utils/deletionTombstones");
const states = require("../utils/deletionTombstones/states");
const erasureMarks = require("../services/erasureMarkService");

const S = states.TOMBSTONE_STATUS;

test.before(() => {
  tombstones._stopSweepForTests();
});

test("BŪSENOS: leidžiamų perėjimų matrica yra TIKSLIAI ta, kurią reikalauja #183", async () => {
  /**
   * ⚠️ TIKRINAMAS ELGESYS, NE KONSTANTA. Lentelės palyginimas su ja pačia
   * įrodytų tik, kad ji sau lygi. Todėl kiekvienas perėjimas realiai bandomas.
   */
  const bandymai = [
    { nuo: null, i: S.PENDING, leidžiama: true, kodel: "žymėjimas iš nieko" },
    { nuo: S.PENDING, i: S.DELETED, leidžiama: true, kodel: "sėkmingas užbaigimas" },
    { nuo: S.PENDING, i: S.FAILED, leidžiama: true, kodel: "nesėkmė" },
    { nuo: S.FAILED, i: S.PENDING, leidžiama: true, kodel: "eksplicitinis retry" },
    { nuo: S.FAILED, i: S.DELETED, leidžiama: false, kodel: "retry PRIVALO eiti per pending" },
    { nuo: S.FAILED, i: S.FAILED, leidžiama: false, kodel: "nesėkmė nekartojama vietoje" },
    { nuo: S.DELETED, i: S.FAILED, leidžiama: false, kodel: "GALUTINĖ - vėlyva nesėkmė neperrašo" },
    { nuo: S.DELETED, i: S.PENDING, leidžiama: false, kodel: "GALUTINĖ - prikelti negalima" },
  ];

  for (const { nuo, i, leidžiama, kodel } of bandymai) {
    await tombstones._clearForTests();
    const jobId = `matrica_${nuo || "nieko"}_${i}`;

    if (nuo !== null) {
      await tombstones.mark(jobId, { reason: states.ERASURE_REASON.USER_REQUEST });

      if (nuo === S.FAILED) await tombstones.complete(jobId, S.FAILED);
      if (nuo === S.DELETED) await tombstones.complete(jobId, S.DELETED);
    }

    if (nuo === null) {
      await tombstones.mark(jobId, { reason: states.ERASURE_REASON.USER_REQUEST });
    } else if (i === S.PENDING) {
      await tombstones.retry(jobId);
    } else {
      await tombstones.complete(jobId, i);
    }

    const galutine = (await tombstones.get(jobId)).status;

    assert.equal(
      galutine,
      leidžiama ? i : nuo,
      `${nuo || "nėra"} → ${i}: ${kodel} (gauta ${galutine})`
    );
  }
});

test("BŪSENOS: `deleted` yra vienintelė, iš kurios nėra JOKIO perėjimo", () => {
  /**
   * Struktūrinė patikra šalia elgsenos: postgres pusėje ta pati garantija
   * gyvena `UPDATE ... WHERE status = ANY($2)` FORMOJE - `deleted` neatsiranda
   * nė viename `from` sąraše. Ši patikra saugo, kad JS pusė nenukryptų.
   */
  assert.deepEqual(states.ALLOWED_TRANSITIONS[S.DELETED], []);
  assert.ok(states.ALLOWED_TRANSITIONS[S.PENDING].includes(S.DELETED));
  assert.ok(!states.ALLOWED_TRANSITIONS[S.FAILED].includes(S.DELETED));
});

test("BARJERAS: `pending`, `failed` IR `deleted` visi stabdo; tik nebuvimas leidžia", async () => {
  await tombstones._clearForTests();

  await tombstones.mark("b_pending", { reason: states.ERASURE_REASON.USER_REQUEST });

  await tombstones.mark("b_failed", { reason: states.ERASURE_REASON.USER_REQUEST });
  await tombstones.complete("b_failed", S.FAILED);

  await tombstones.mark("b_deleted", { reason: states.ERASURE_REASON.USER_REQUEST });
  await tombstones.complete("b_deleted", S.DELETED);

  for (const jobId of ["b_pending", "b_failed", "b_deleted"]) {
    assert.equal(await tombstones.isDeleted(jobId), true, `${jobId} privalo būti užbarjeruotas`);
    assert.equal(await tombstones.isBarred(jobId), true, "7.4e vardas duoda tą patį atsakymą");
  }

  /**
   * ⚠️ `deletion_failed` IŠLAIKO BARJERĄ SĄMONINGAI: nesėkmingas ištrynimas
   * reiškia, kad jautrūs duomenys dar gali egzistuoti. Leidus kurti naujus,
   * nepavykęs trynimas prikurtų dar daugiau to, ką bandom pašalinti.
   */
  assert.equal(await tombstones.isConfirmedDeleted("b_failed"), false, "bet NEPATVIRTINTAS");
  assert.equal(await tombstones.isDeleted("nera_zymos"), false, "be žymos - barjero NĖRA");
});

test("ALLOWLIST: nežinoma `reason` ATMETAMA, o ne normalizuojama", async () => {
  await tombstones._clearForTests();

  for (const bloga of ["kažkas", "", null, "USER_REQUEST", "user request"]) {
    await assert.rejects(
      () => tombstones.mark("j", { reason: bloga }),
      /Nežinoma ištrynimo priežastis/,
      `"${bloga}" privalo būti atmesta`
    );
  }

  for (const gera of Object.values(states.ERASURE_REASON)) {
    await tombstones._clearForTests();
    const z = await tombstones.mark("j", { reason: gera });
    assert.equal(z.reason, gera);
  }
});

test("PRIVATUMAS: `actorKind` yra kategorija - identifikatorius ATMETAMAS", async () => {
  /**
   * ⚠️ KODĖL TAI SVARBU BŪTENT ČIA. `erasure_marks` pergyvena jobą IR, skirtingai
   * nei `audit_log`, nėra išbraukiama iš atsarginių kopijų. Plikas `ownerId` ar
   * el. paštas joje taptų asmens duomenimis lentelėje, kurios paskirtis -
   * įrodyti, kad asmens duomenys pašalinti.
   */
  await tombstones._clearForTests();

  const identifikatoriai = [
    "user_42",
    "jonas@example.com",
    "sysadmin",
    "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  ];

  for (const id of identifikatoriai) {
    await assert.rejects(
      () => tombstones.mark("j", { reason: states.ERASURE_REASON.USER_REQUEST, actorKind: id }),
      /Nežinoma aktoriaus kategorija/,
      `"${id}" yra identifikatorius, ne kategorija`
    );
  }

  for (const kategorija of Object.values(states.ACTOR_KIND)) {
    await tombstones._clearForTests();
    const z = await tombstones.mark("j", {
      reason: states.ERASURE_REASON.USER_REQUEST,
      actorKind: kategorija,
    });
    assert.equal(z.actorKind, kategorija);
  }
});

test("PRIVATUMAS: RAW sentinel niekada nepatenka į žymą", async () => {
  /**
   * Sentinel tekstas imituoja tai, kas realiai atkeliauja klaidų žinutėse:
   * failų keliai, saugyklos raktai, tiekėjo atsakymai, transkripcijos gabalai.
   */
  const SENTINEL = "SLAPTA-TRANSKRIPCIJA-/tmp/uploads/abc.wav-sk_live_XYZ";

  await tombstones._clearForTests();

  await tombstones.mark("sentinel_job", { reason: states.ERASURE_REASON.USER_REQUEST });
  await tombstones.complete("sentinel_job", S.FAILED, { failureKind: SENTINEL });

  const zyma = await tombstones.get("sentinel_job");
  const serializuota = JSON.stringify(zyma);

  assert.ok(!serializuota.includes("SLAPTA"), `sentinel nutekėjo į žymą: ${serializuota}`);
  assert.ok(!serializuota.includes("/tmp/"), "failų kelias nutekėjo į žymą");

  /** Nežinoma kategorija virsta `null`, o ne būna įrašoma kaip tekstas. */
  assert.equal(zyma.lastFailureKind, null, "neatpažinta kategorija NEĮRAŠOMA");
});

test("RETENCIJA: formulė yra `max(prikėlimas, kopijos) + atsarga`, ne parinktas skaičius", () => {
  const { revivalHorizonsMs } = require("../queues/config");
  const { retentionDays } = require("../utils/backupPolicy");

  const env = {};
  const prikelimas = revivalHorizonsMs(env).max;
  const kopijos = retentionDays(env) * 24 * 3600 * 1000;

  assert.equal(
    tombstones.retentionMs(env),
    Math.max(prikelimas, kopijos) + tombstones.SAFETY_MARGIN_MS,
    "terminas privalo būti IŠVESTAS, o ne užrašytas"
  );

  /**
   * ⚠️ RIBOJANTIS DYDIS GALI PASIKEISTI. Šiandien tai kopijų horizontas (7 d.
   * prieš 24 h prikėlimo), bet formulė turi sekti abu: pailginus prikėlimo
   * horizontą, terminas privalo pailgėti savaime.
   */
  const ilgesnis = tombstones.retentionMs({ BACKUP_RETENTION_DAYS: "90" });
  assert.ok(
    ilgesnis > tombstones.retentionMs(env),
    "ilgesnė kopijų retencija privalo pailginti žymos terminą"
  );
});

test("RETENCIJA: `DELETION_TOMBSTONE_TTL_HOURS` gali TIK pailginti", async () => {
  /**
   * ⚠️ IKI 7.5a JIS BUVO VIENINTELIS TERMINAS. Palikus jį autoritetu,
   * operatorius galėtų nustatyti reikšmę žemiau prikėlimo horizonto ir tyliai
   * sulaužyti garantiją: žyma dingtų anksčiau, nei job'as nebegali būti
   * prikeltas.
   */
  const bazine = tombstones.retentionMs({});

  const trumpesnis = tombstones.retentionMs({ DELETION_TOMBSTONE_TTL_HOURS: "1" });
  assert.equal(trumpesnis, bazine, "trumpesnė reikšmė IGNORUOJAMA");

  const ilgesnis = tombstones.retentionMs({ DELETION_TOMBSTONE_TTL_HOURS: "8760" });
  assert.ok(ilgesnis > bazine, "ilgesnė reikšmė priimama");
  assert.equal(ilgesnis, 8760 * 3600 * 1000);
});

test("FALLBACK: be `DATABASE_URL` - atmintis, ir įspėjimas tai pasako GARSIAI", () => {
  assert.equal(tombstones.backend, "memory", "be DATABASE_URL backend'as privalo būti atmintis");

  const i = tombstones.ATMINTIES_ISPEJIMAS;

  assert.match(i, /TIK ATMINTYJE/, "riba privalo būti įvardyta");
  assert.match(i, /restart/i, "restarto poveikis privalo būti įvardytas");
  assert.match(i, /replik/i, "replikų riba privalo būti įvardyta");
  assert.match(i, /DATABASE_URL/, "privalo pasakyti, KADA garantija galioja");
  assert.match(i, /deletion-guarantees/, "privalo nurodyti, kur ieškoti pilno teksto");
});

test("OPERATORIUS: užstrigusios žymos matomos su amžiumi", async () => {
  await tombstones._clearForTests();

  await tombstones.mark("stuck_failed", { reason: states.ERASURE_REASON.USER_REQUEST });
  await tombstones.complete("stuck_failed", S.FAILED, { failureKind: "retryable" });

  await tombstones.mark("stuck_pending", { reason: states.ERASURE_REASON.OPERATOR_CLEANUP });

  await tombstones.mark("done", { reason: states.ERASURE_REASON.USER_REQUEST });
  await tombstones.complete("done", S.DELETED);

  const zymos = await erasureMarks.listStuck({ olderThanMs: 0 });
  const ids = zymos.map((z) => z.jobId).sort();

  assert.deepEqual(ids, ["stuck_failed", "stuck_pending"], "terminalės į sąrašą NEPATENKA");
  assert.ok(zymos.every((z) => typeof z.ageMs === "number"), "amžius privalo būti matomas");

  const failed = zymos.find((z) => z.jobId === "stuck_failed");
  assert.equal(failed.attempts, 1, "bandymų skaičius matomas operatoriui");
  assert.equal(failed.lastFailureKind, "retryable");
});

test("OPERATORIUS: `retry` veikia TIK iš `failed` ir palieka audito pėdsaką", async () => {
  await tombstones._clearForTests();

  const irasai = [];
  const auditWrite = require("../utils/auditWrite");
  const originalus = auditWrite.rasytiAudita;

  /**
   * ⚠️ PERIMAMA MODULIO EKSPORTO NUORODA, o `erasureMarkService` ją destruktūrina
   * importo metu - todėl servisas įkeliamas IŠ NAUJO po pakeitimo. Be to spy
   * tyliai nieko nedarytų (AGENTS.md §9.1).
   */
  auditWrite.rasytiAudita = async (irasas) => {
    irasai.push(irasas);
  };
  delete require.cache[require.resolve("../services/erasureMarkService")];
  const service = require("../services/erasureMarkService");

  try {
    await tombstones.mark("r1", { reason: states.ERASURE_REASON.USER_REQUEST });

    const isPending = await service.retryMark("r1", { actor: "operatorius" });
    assert.equal(isPending.changed, false, "iš `pending` retry beprasmis");
    assert.equal(isPending.reason, "not_failed");
    assert.equal(irasai.length, 0, "neįvykęs veiksmas NERAŠOMAS į auditą");

    await tombstones.complete("r1", S.FAILED);
    const isFailed = await service.retryMark("r1", { actor: "operatorius" });

    assert.equal(isFailed.changed, true);
    assert.equal(isFailed.status, S.PENDING);
    assert.equal(irasai.length, 1, "veiksmas privalo palikti pėdsaką");
    assert.equal(irasai[0].event, "ERASURE_MARK_RETRIED");
    assert.equal(irasai[0].actor, "operatorius");
    assert.equal(irasai[0].jobId, "r1");
  } finally {
    auditWrite.rasytiAudita = originalus;
    delete require.cache[require.resolve("../services/erasureMarkService")];
  }
});

test("OPERATORIUS: `force-resolve` rašo auditą PRIEŠ veiksmą - fail-closed", async () => {
  /**
   * ⚠️ TVARKA YRA ESMĖ. Force-resolve ATIDARO barjerą. Jei auditas kristų po
   * perėjimo, barjeras liktų nuimtas be jokio įrašo, kas jį nuėmė - t. y.
   * tiksliai tas atvejis, dėl kurio auditas ir egzistuoja.
   */
  await tombstones._clearForTests();

  const auditWrite = require("../utils/auditWrite");
  const originalus = auditWrite.rasytiAudita;

  auditWrite.rasytiAudita = async () => {
    throw new Error("auditas neprieinamas");
  };
  delete require.cache[require.resolve("../services/erasureMarkService")];
  const service = require("../services/erasureMarkService");

  try {
    await tombstones.mark("fr1", { reason: states.ERASURE_REASON.USER_REQUEST });
    await tombstones.complete("fr1", S.FAILED);

    await assert.rejects(
      () => service.forceResolveMark("fr1", { actor: "operatorius" }),
      /auditas neprieinamas/
    );

    assert.equal(
      (await tombstones.get("fr1")).status,
      S.FAILED,
      "kritus auditui žyma PRIVALO likti neterminalė"
    );
  } finally {
    auditWrite.rasytiAudita = originalus;
    delete require.cache[require.resolve("../services/erasureMarkService")];
  }
});

test("MIGRACIJA: užšaldytos aibės sutampa su `states.js` autoritetu", () => {
  /**
   * ⚠️ MIGRACIJA SĄMONINGAI NEIMPORTUOJA KONSTANTŲ (ji yra istorijos įrašas),
   * tad paritetą tikrina šis testas. Be jo pakeitus `states.js` šviežia DB
   * gautų vieną aibę, o atnaujinta liktų su kita - tyliai.
   */
  const saltinis = fs.readFileSync(
    path.join(__dirname, "../migrations/1755400000000_erasure-marks.js"),
    "utf8"
  );

  const aibe = (vardas) => {
    const pradzia = saltinis.indexOf(`const ${vardas} = [`);
    assert.notEqual(pradzia, -1, `migracijoje nerasta ${vardas}`);

    const pabaiga = saltinis.indexOf("];", pradzia);
    const eilute = saltinis.slice(pradzia, pabaiga);

    return eilute.match(/"[^"]+"/g).map((r) => r.replace(/"/g, ""));
  };

  assert.deepEqual(aibe("STATUSES_FROZEN").sort(), [...states.STATUSES].sort());
  assert.deepEqual(aibe("REASONS_FROZEN").sort(), [...states.REASONS].sort());
  assert.deepEqual(aibe("ACTOR_KINDS_FROZEN").sort(), [...states.ACTOR_KINDS].sort());
  assert.deepEqual(aibe("FAILURE_KINDS_FROZEN").sort(), [...states.FAILURE_KINDS].sort());
});

test("MIGRACIJA: FK į `jobs` NĖRA - tripwire", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2). Elgseną - kad `jobs` eilutės ištrynimas
   * NEPAŠALINA žymos - įrodo `erasureMarks.integration.test.js`, ir be tikros DB
   * jis NOT RUN. Ši patikra pigi ir gaudo akivaizdžiausią regresiją: kas nors
   * „sutvarko" schemą pridėdamas nuorodą.
   */
  const saltinis = fs.readFileSync(
    path.join(__dirname, "../migrations/1755400000000_erasure-marks.js"),
    "utf8"
  );

  const lentele = saltinis.slice(
    saltinis.indexOf('createTable("erasure_marks"'),
    saltinis.indexOf("addConstraint")
  );

  assert.ok(!/references/i.test(lentele), "`erasure_marks` NEGALI turėti FK į `jobs`");
  assert.ok(!/onDelete/i.test(lentele), "`ON DELETE` politikos čia negali būti");
});
