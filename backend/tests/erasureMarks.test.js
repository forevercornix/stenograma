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
  const prikelimas = revivalHorizonsMs(env).horizonMs;
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

test("FALLBACK: be PostgreSQL - atmintis, ir įspėjimas tai pasako GARSIAI", () => {
  assert.equal(tombstones.backend, "memory", "be PostgreSQL backend'as privalo būti atmintis");

  /**
   * ⚠️ `PG*` PRIIMAMAS LYGIAI KAIP `DATABASE_URL` (#216, 7.4e).
   *
   * Iki 7.4e atranka žiūrėjo tik į `DATABASE_URL`, o `auditStore` priimdavo abu.
   * Dokumentuotame Compose diegime (`PG*`) auditas eidavo į DB, o žymos liktų
   * atmintyje - barjeras skaitytų tuščią lentelę ir visada praleistų, tyliai.
   */
  assert.equal(tombstones.pasirinktiBackend({ PGHOST: "db" }), "postgres");
  assert.equal(tombstones.pasirinktiBackend({ DATABASE_URL: "postgres://x/y" }), "postgres");
  assert.equal(tombstones.pasirinktiBackend({}), "memory");

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

    /**
     * ⚠️ `jobId` ČIA NEBEPERDUODAMAS (#155, 7.4e / #216) - ir tai TIKRINAMA, ne
     * praleidžiama.
     *
     * Anksčiau ši eilutė reikalavo `irasai[0].jobId === "r1"`. 7.4e barjeras
     * atmeta subjektui susietą audito rašymą pažymėtam `job_id`, o šis įvykis
     * rašomas iškart PO `tombstones.retry()` - t. y. apie garantuotai pažymėtą
     * job'ą. Su subject binding operatoriaus kelias nustotų veikti visiškai.
     *
     * Tikrinama PRIEŠINGA kryptis, kad atsukimas būtų matomas: pėdsakas
     * privalo likti (`event`, `actor`, kiekis aukščiau), bet BE subjekto.
     */
    assert.equal(
      "jobId" in irasai[0],
      false,
      "administravimo įvykis negali būti susietas su ištrinamu subjektu - žr. #216"
    );
  } finally {
    auditWrite.rasytiAudita = originalus;
    delete require.cache[require.resolve("../services/erasureMarkService")];
  }
});

test("OPERATORIUS: auditas rašomas PO perėjimo, o `success` atitinka rezultatą", async () => {
  /**
   * ⚠️ ŠIS TESTAS APVERSTAS 7.5a PERŽIŪROJE (#183 Codex, P2).
   *
   * Ankstesnė versija reikalavo audito PRIEŠ veiksmą, ir tas argumentas
   * galiojo: force-resolve ATIDARO barjerą, tad kritęs auditas neturi palikti
   * jo nuimto be įrašo.
   *
   * Bet ta tvarka dengė tik vieną gedimo pusę. Antroji: du lygiagretūs
   * operatoriai abu perskaito būseną, abu įrašo `success: true`, o sąlyginis
   * perėjimas pavyksta TIK vienam - lieka patvarus SĖKMĖS įrašas veiksmui,
   * kurio nebuvo. Auditu, kuriuo negalima pasitikėti, remiamasi; trūkstamu -
   * ne.
   *
   * Todėl tikrinama nauja garantija: `success` atspindi FAKTINĮ perėjimą.
   */
  await tombstones._clearForTests();

  const auditWrite = require("../utils/auditWrite");
  const originalus = auditWrite.rasytiAudita;

  const irasai = [];
  auditWrite.rasytiAudita = async (irasas) => {
    irasai.push(irasas);
  };
  delete require.cache[require.resolve("../services/erasureMarkService")];
  const service = require("../services/erasureMarkService");

  try {
    await tombstones.mark("fr1", { reason: states.ERASURE_REASON.USER_REQUEST });
    await tombstones.complete("fr1", S.FAILED);

    /** ── Pirmas operatorius: perėjimas ĮVYKSTA ───────────────────────────── */
    const pirmas = await service.forceResolveMark("fr1", { actor: "operatorius-A" });

    assert.equal(pirmas.changed, true, "prielaida: pirmas force-resolve pakeičia būseną");
    assert.equal(irasai.length, 1);
    assert.equal(irasai[0].event, "ERASURE_MARK_FORCE_RESOLVED");
    assert.equal(irasai[0].success, true, "įvykęs veiksmas rašomas kaip sėkmė");

    /**
     * ── Antras operatorius tai pačiai žymai: perėjimo NĖRA ────────────────
     *
     * Žyma jau terminalė, tad servisas grąžina `changed: false`. Su senąja
     * tvarka čia būtų atsiradęs ANTRAS `success: true` įrašas - patvarus
     * pėdsakas veiksmo, kurio neįvyko.
     */
    const antras = await service.forceResolveMark("fr1", { actor: "operatorius-B" });

    assert.equal(antras.changed, false, "terminali žyma antrą kartą nebekeičiama");
    assert.ok(
      !irasai.some((i) => i.success === true && i.actor === "operatorius-B"),
      `sėkmės įrašo veiksmui, kurio nebuvo, būti negali: ${JSON.stringify(irasai)}`
    );
  } finally {
    auditWrite.rasytiAudita = originalus;
    delete require.cache[require.resolve("../services/erasureMarkService")];
  }
});

test("OPERATORIUS: `retry` sėkmės įrašas irgi atitinka faktinį perėjimą", async () => {
  /**
   * Ta pati garantija antrame kelyje: `retryMark` sąlyginis perėjimas
   * `failed → pending` pavyksta tik vienam iš dviejų lygiagrečių operatorių.
   */
  await tombstones._clearForTests();

  const auditWrite = require("../utils/auditWrite");
  const originalus = auditWrite.rasytiAudita;

  const irasai = [];
  auditWrite.rasytiAudita = async (irasas) => {
    irasai.push(irasas);
  };
  delete require.cache[require.resolve("../services/erasureMarkService")];
  const service = require("../services/erasureMarkService");

  try {
    await tombstones.mark("rt1", { reason: states.ERASURE_REASON.USER_REQUEST });
    await tombstones.complete("rt1", S.FAILED);

    const rezultatas = await service.retryMark("rt1", { actor: "operatorius" });

    assert.equal(rezultatas.changed, true, "prielaida: retry pakeičia būseną");
    assert.equal(irasai.length, 1);
    assert.equal(irasai[0].event, "ERASURE_MARK_RETRIED");
    assert.equal(irasai[0].success, true);
    assert.match(irasai[0].details, /changed=true/, "rezultatas matomas ir `details` lauke");
  } finally {
    auditWrite.rasytiAudita = originalus;
    delete require.cache[require.resolve("../services/erasureMarkService")];
  }
});

/**
 * Ištraukia užšaldytą aibę iš migracijos šaltinio, nesvarbu kelinta ji.
 *
 * Vardas su nebūtina priesaga (`REASONS_FROZEN`, `REASONS_FROZEN_V2`,
 * `FAILURE_KINDS_FROZEN_V2`, ...), nes kiekviena praplečianti migracija turi
 * savo sąrašą - importuoti konstantos jos negali, tai istorijos įrašai.
 */
function uzsaldytaAibe(saltinis, vardas) {
  const m = new RegExp("const " + vardas + "[A-Z0-9_]* = \\[").exec(saltinis);
  if (!m) return null;

  const pabaiga = saltinis.indexOf("];", m.index);
  assert.notEqual(pabaiga, -1, `neužbaigta ${vardas} deklaracija`);

  return saltinis
    .slice(m.index, pabaiga)
    .match(/"[^"]+"/g)
    .map((r) => r.replace(/"/g, ""));
}

test("MIGRACIJA: užšaldytos aibės gali TIK plėstis, o naujausios atitinka `states.js`", () => {
  /**
   * ⚠️ TESTAS SĄMONINGAI NEĮRAŠO NĖ VIENOS MIGRACIJOS VARDO.
   *
   * Migracijos NEIMPORTUOJA konstantų (jos yra istorijos įrašai), tad paritetą
   * turi tikrinti testas. Ankstesnė versija lygino su vienu užkoduotu failu, ir
   * tai jau kartą būtų pralindę tyliai: aibė nuo tada plėtėsi DU kartus
   * (`orphan_cleanup` #183, `executor_lost` #183), kaskart nauja migracija.
   *
   * Autoritetu laikoma NAUJAUSIA pagal vardą deklaracija - t. y. ta, kuri realiai
   * galioja šviežiai migruotai DB.
   *
   * Antra tikrinama savybė - KRYPTIS. Allowlist gali plėstis, bet reikšmė iš jo
   * dingti negali: jau įrašytos žymos taptų `check_violation` eilutėmis, o tokia
   * migracija aptinkama tik diegimo metu.
   */
  const migDir = path.join(__dirname, "../migrations");
  const failai = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith(".js"))
    .sort();

  const aibes = [
    ["STATUSES_FROZEN", states.STATUSES],
    ["REASONS_FROZEN", states.REASONS],
    ["ACTOR_KINDS_FROZEN", states.ACTOR_KINDS],
    ["FAILURE_KINDS_FROZEN", states.FAILURE_KINDS],
  ];

  for (const [vardas, autoritetas] of aibes) {
    const deklaracijos = failai
      .map((failas) => ({
        failas,
        reiksmes: uzsaldytaAibe(fs.readFileSync(path.join(migDir, failas), "utf8"), vardas),
      }))
      .filter((d) => d.reiksmes);

    assert.ok(deklaracijos.length >= 1, `${vardas} nerasta nė vienoje migracijoje`);

    const naujausia = deklaracijos[deklaracijos.length - 1];

    assert.deepEqual(
      [...naujausia.reiksmes].sort(),
      [...autoritetas].sort(),
      `${vardas}: naujausia migracija (${naujausia.failas}) ir \`states.js\` išsiskyrė - ` +
        "pasikeitus aibei reikia NAUJOS migracijos"
    );

    for (let i = 1; i < deklaracijos.length; i += 1) {
      const dingo = deklaracijos[i - 1].reiksmes.filter(
        (r) => !deklaracijos[i].reiksmes.includes(r)
      );

      assert.deepEqual(
        dingo,
        [],
        `${deklaracijos[i].failas} pašalino reikšmes, kurias leido ` +
          `${deklaracijos[i - 1].failas}: ${dingo.join(", ")}`
      );
    }
  }
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

test("VIENAS AUTORITETAS: `erasure_marks` SQL neegzistuoja už modulio ribų - VISAME backend'e", () => {
  /**
   * ⚠️ TRIPWIRE PER VISĄ REPO, NE PER VIENĄ FAILĄ (AGENTS.md §9.2).
   *
   * #183 reikalauja, kad 7.4e neskaitytų `erasure_marks` ad-hoc SQL skirtingose
   * vietose. Iki šito taisyklę gynė TIK `restoreService` patikra - vieno failo
   * sargas prieš repo masto taisyklę, t. y. ta pati klasė kaip keturios jau
   * užregistruotos kokybės skolos.
   *
   * ⚠️ KOMENTARAI SĄMONINGAI NEVALOMI, ir tai NE aplaidumas.
   *
   * Vienintelis repo turimas valytojas yra `beKomentaru()`, o jis registruotas
   * kaip keistinas (`rizika10`): blokinius komentarus šalina reguliariuoju
   * reiškiniu, tad `/*` eilutės literale nurytų kodą - įskaitant tikrą pažeidimą.
   * Statyti naują sargą ant to pamato reikštų gauti TYLIĄ gedimo kryptį būtent
   * ten, kur sargas ir reikalingas.
   *
   * Vietoj to ieškoma SQL FORMOS - veiksmažodžio prieš lentelės vardą. Proza to
   * nedaro: esami komentarai (`lifecycleService`, `jobStore`) mini lentelę, bet
   * ne kaip SQL. Kaina: komentaras, cituojantis SQL, patikrą suerzins. Tai
   * GARSI kryptis - priimtina tripwire'ui, priešingai nei tyli.
   *
   * ⚠️ KO ŠI PATIKRA NEDENGIA: dinamiškai sukonstruoto lentelės vardo
   * (`FROM ${lentele}`). Tam reikėtų tikro tokenizatoriaus - žr. `rizika10`.
   */
  const fs = require("node:fs");
  const path = require("node:path");

  const saknis = path.resolve(__dirname, "..");

  /**
   * Leistinos vietos ir KODĖL kiekviena:
   *   `utils/deletionTombstones/` - pats autoritetas;
   *   `migrations/`               - schemos apibrėžimas, ne prieigos kelias;
   *   `tests/`                    - invariantai TIKRINAMI RAW SQL sąmoningai,
   *                                 nes patikra per tą patį sluoksnį, kuris
   *                                 juos ir turėtų pažeisti, nieko neįrodo.
   */
  const LEIDZIAMA = ["utils/deletionTombstones", "migrations", "tests", "node_modules"];

  const SQL_FORMA = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+erasure_marks\b/i;

  const pazeidejai = [];

  const eiti = (dir) => {
    for (const irasas of fs.readdirSync(dir, { withFileTypes: true })) {
      const pilnas = path.join(dir, irasas.name);
      const santykinis = path.relative(saknis, pilnas);

      if (LEIDZIAMA.some((p) => santykinis === p || santykinis.startsWith(`${p}${path.sep}`))) {
        continue;
      }

      if (irasas.isDirectory()) {
        eiti(pilnas);
        continue;
      }

      if (!irasas.name.endsWith(".js")) continue;

      const turinys = fs.readFileSync(pilnas, "utf8");
      for (const eilute of turinys.split("\n")) {
        if (SQL_FORMA.test(eilute)) pazeidejai.push(`${santykinis}: ${eilute.trim()}`);
      }
    }
  };

  eiti(saknis);

  assert.deepEqual(
    pazeidejai,
    [],
    "`erasure_marks` SQL privalo gyventi TIK `utils/deletionTombstones/`. " +
      `Rasta kitur:\n${pazeidejai.join("\n")}`
  );
});

test("VIENAS AUTORITETAS: patikra REALIAI gaudo - savitikra", () => {
  /**
   * ⚠️ TRIPWIRE'AS BE SAVITIKROS YRA TEIGINYS, NE SARGAS.
   *
   * Patikra aukščiau praeina ir tada, kai jos šablonas nieko nebeatitinka
   * (pvz. kas nors „sutvarkė" reguliarųjį reiškinį). Todėl tas pats šablonas
   * paleidžiamas prieš žinomai pažeidžiantį tekstą.
   */
  const SQL_FORMA = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+erasure_marks\b/i;

  const pazeidimai = [
    'const { rows } = await pool.query("SELECT status FROM erasure_marks WHERE job_id = $1");',
    "await client.query(`DELETE FROM erasure_marks WHERE job_id = $1`);",
    'await pool.query("UPDATE erasure_marks SET status = $1");',
    'await pool.query("INSERT INTO erasure_marks (job_id) VALUES ($1)");',
  ];

  for (const eilute of pazeidimai) {
    assert.ok(SQL_FORMA.test(eilute), `šablonas privalo pagauti: ${eilute}`);
  }

  /** Ir NEturi gaudyti prozos - kitaip komentarai taptų neįmanomi. */
  const proza = [
    " * Persistentiniame režime atsakymas ateina iš `erasure_marks`, o `Promise` yra",
    " * Nuo 7.5a autoritetas yra sąlyginis `erasure_marks` rašymas su per-`job_id`",
    " * `erasure_marks` pergyvena jobą ir nėra išbraukiama iš kopijų",
  ];

  for (const eilute of proza) {
    assert.ok(!SQL_FORMA.test(eilute), `šablonas NETURI gaudyti prozos: ${eilute}`);
  }
});

test("ATOMIŠKUMAS: neteisingas `actorKind` NEPALIEKA pusiau įvykusio perėjimo", async () => {
  /**
   * ⚠️ VALIDACIJA PRIEŠ MUTACIJĄ (#183 Codex, P2).
   *
   * Anksčiau `assertActorKind` buvo kviečiamas PO to, kai `status`,
   * `updatedAt` ir `completedAt` jau pakeisti. Kvietėjas matydavo atmestą
   * operaciją - be audito įrašo, nes metama - o barjeras VIS TIEK būdavo
   * perėjęs. PostgreSQL validuoja prieš `UPDATE`, tad tas pats įvedimas
   * duodavo skirtingą atomiškumą skirtinguose backend'uose.
   *
   * ⚠️ TIKRINAMA SAUGYKLA TIESIOGIAI, ne fasadas: `complete()` `actorKind`
   * neperduoda - jį perduoda `retry`/`forceResolve` keliai, o defektas gyvena
   * `_perkelti()` viduje. Per fasadą testas nieko neįrodytų.
   */
  const memoryStore = require("../utils/deletionTombstones/memoryStore");

  await memoryStore.clear();
  await memoryStore.mark("atom1", { reason: states.ERASURE_REASON.USER_REQUEST });

  const pries = await memoryStore.get("atom1");
  assert.equal(pries.status, S.PENDING, "prielaida: žyma pradinėje būsenoje");

  await assert.rejects(
    () => memoryStore.transition("atom1", S.DELETED, { actorKind: "nesamas-veikejas" }),
    /Nežinoma aktoriaus kategorija/,
    "neleistina kategorija privalo būti atmesta"
  );

  const po = await memoryStore.get("atom1");

  assert.equal(po.status, S.PENDING, "būsena NEGALI būti pasikeitusi po atmestos operacijos");
  assert.equal(po.completedAt, null, "ištrynimo laikas irgi neturi atsirasti");
  assert.equal(po.updatedAt, pries.updatedAt, "įrašas neturi būti paliestas");

  /** Teisinga kategorija tuo pačiu keliu privalo praeiti - kitaip testas įrodytų tik lūžį. */
  const gerai = await memoryStore.transition("atom1", S.DELETED, {
    actorKind: states.ACTOR_KIND.OPERATOR,
  });
  assert.equal(gerai.status, S.DELETED);

  await memoryStore.clear();
});
