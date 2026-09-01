const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const { normalizeOwnerId, matchesOwner, newJob, applyPatch, OWNER_KIND } = require("../utils/jobStore/common");

const A = "11111111-1111-4111-8111-111111111111";

/**
 * TIKRAS pre-#159 įrašas.
 *
 * `create()` sąmoningai NEBELEIDŽIA sukurti įrašo be `ownerKind` – dabartinis
 * writer'is neturi mokėti rašyti senos eros formato. Todėl legacy fixture
 * konstruojamas per `restoreRecord()`, kuris atkuria įrašą tokį, koks jis
 * buvo saugykloje. Taip testai tikrina TIKRĄ legacy formatą, o ne tą, kurį
 * dabartinis writer'is pats sugeneravo.
 */
async function legacyJob(fields = {}) {
  const { newJob } = require("../utils/jobStore/common");
  const job = newJob({ ownerKind: "unowned", ...fields });
  delete job.ownerKind; // pre-#159 įrašai šio lauko NETURĖJO
  return jobStore.restoreRecord(job);
}
const B = "44444444-4444-4444-8444-444444444444";

/* ── kanoninė reikšmė ─────────────────────────────────────────────────── */

test("#159 normalizeOwnerId: null, undefined ir trūkstamas laukas yra viena reikšmė", () => {
  assert.equal(normalizeOwnerId(null), "");
  assert.equal(normalizeOwnerId(undefined), "");
  assert.equal(normalizeOwnerId(""), "");
  assert.equal(normalizeOwnerId(A), A);
});

test("#159 matchesOwner: `\"\"` NĖRA wildcard", () => {
  /**
   * Jei „savininko nėra" sutaptų su bet kuo, desktop režimo įrašas atidarytų
   * prieigą prie visų job'ų – ir atvirkščiai.
   */
  assert.equal(matchesOwner({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED }, { ownerId: null, ownerKind: OWNER_KIND.UNOWNED }), true, "null + null → sutampa");
  assert.equal(matchesOwner({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED }, { ownerId: A, ownerKind: OWNER_KIND.USER }), false, "null + UUID → NEsutampa");
  assert.equal(matchesOwner({ ownerId: A, ownerKind: OWNER_KIND.USER }, { ownerId: null, ownerKind: OWNER_KIND.UNOWNED }), false, "UUID + null → NEsutampa");
  assert.equal(matchesOwner({ ownerId: A, ownerKind: OWNER_KIND.USER }, { ownerId: A, ownerKind: OWNER_KIND.USER }), true);
  assert.equal(matchesOwner({ ownerId: A, ownerKind: OWNER_KIND.USER }, { ownerId: B, ownerKind: OWNER_KIND.USER }), false);
});

test("#159 ownerId ir actor yra ATSKIRI laukai", () => {
  /**
   * Reikšmė sutampa kūrimo metu, bet semantika skiriasi: `actor` yra vykdytojo
   * tapatybė (rolei perskaičiuoti), `ownerId` – duomenų nuosavybė (prieigai).
   * API rakto kelyje jie net nesutampa: actor = `key_<hex>`, owner = null.
   */
  const job = newJob({ actor: "key_abc123", ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL });
  assert.equal(job.actor, "key_abc123");
  assert.equal(job.ownerId, null);
});

test("#159 ownerId NEKEIČIAMAS per applyPatch", () => {
  /**
   * Patch'ai formuojami dešimtyse vietų. Jei nuosavybė būtų keičiama kaip bet
   * kuris laukas, vienas neatsargus patch'as tyliai perduotų job'ą kitam
   * savininkui, ir filtras taptų beprasmis.
   */
  const job = newJob({ ownerId: A, ownerKind: OWNER_KIND.USER });
  const patched = applyPatch(job, { ownerId: B, status: "processing" });

  assert.equal(patched.ownerId, A, "nuosavybė nustatoma TIK create() metu");
  assert.equal(patched.status, "processing");
});

/* ── scope reikalavimas ───────────────────────────────────────────────── */

test("#159 SCOPE: pozicinis argumentas atmetamas, ne tyliai praleidžiamas", async () => {
  /**
   * Tylus praleidimas su `undefined` savininku būtų blogiausias variantas:
   * filtras taptų dekoracija, o migracijos metu praleista vieta pasimatytų
   * tik produkcijoje.
   */
  await assert.rejects(() => jobStore.get("abc"), /reikalauja scope objekto/);
  await assert.rejects(() => jobStore.update("abc", {}), /reikalauja scope objekto/);
  await assert.rejects(() => jobStore.remove("abc"), /reikalauja scope objekto/);
});

test("#159 SCOPE: praleistas ownerId yra klaida, o null – teisėta reikšmė", async () => {
  await assert.rejects(
    () => jobStore.get({ jobId: "abc", ownerKind: OWNER_KIND.USER }),
    /trūksta ownerId/,
    "praleistas laukas neturi tyliai tapti „be savininko\""
  );

  const job = await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED });
  const found = await jobStore.get({ jobId: job.id, ownerId: null, ownerKind: OWNER_KIND.UNOWNED });
  assert.equal(found.id, job.id, "desktop režimas: null perduotas eksplicitiškai veikia");
});

/* ── filtravimas ──────────────────────────────────────────────────────── */

test("#159 FILTRAS: A negauna, nekeičia ir neištrina B job'o", async () => {
  const job = await jobStore.create({ ownerId: B, ownerKind: OWNER_KIND.USER });

  assert.equal(await jobStore.get({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), jobStore.FORBIDDEN);
  assert.equal(await jobStore.update({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }, { attempt_count: 7 }), jobStore.FORBIDDEN);
  assert.equal(await jobStore.remove({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), jobStore.FORBIDDEN);

  const still = await jobStore.system.get(job.id);
  assert.ok(still, "svetimas job'as turi likti nepaliestas");
  assert.notEqual(still.status, "failed", "atmestas update neturi būti pritaikytas");
});

test("#159 FILTRAS: savininkas gauna, keičia ir ištrina savo job'ą", async () => {
  const job = await jobStore.create({ ownerId: A, ownerKind: OWNER_KIND.USER });

  assert.equal((await jobStore.get({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER })).id, job.id);
  const updated = await jobStore.update({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }, { attempt_count: 7 });
  assert.equal(updated.attempt_count, 7, "savininkas gali keisti savo job\x27ą");
  assert.equal(await jobStore.remove({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), true);
});

test("#159 FILTRAS: `null` ir FORBIDDEN yra ATSKIRI rezultatai", async () => {
  /**
   * 152.3 pagal šį skirtumą sprendžia 403 vs 404. Sulieti į `null` reikštų,
   * kad transporto sluoksnis nebeturi iš ko pasirinkti.
   */
  const job = await jobStore.create({ ownerId: B, ownerKind: OWNER_KIND.USER });

  assert.equal(await jobStore.get({ jobId: "nera-tokio", ownerId: A, ownerKind: OWNER_KIND.USER }), null, "nėra → null");
  assert.equal(await jobStore.get({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), jobStore.FORBIDDEN, "svetimas → FORBIDDEN");
  assert.notEqual(jobStore.FORBIDDEN, null);
  assert.equal(typeof jobStore.FORBIDDEN, "symbol", "Symbol negalima gauti iš JSON ar sumaišyti su job objektu");
});

/* ── sisteminis namespace ─────────────────────────────────────────────── */

test("#159 API-KEY: bendro rakto job'ai gauna ownerId=null (sąmoningas kontraktas)", async () => {
  /**
   * Bendras `API_KEY` nėra individo tapatybė - jį gali turėti keli žmonės ar
   * servisai. Priskirti jam „savininką" reikštų išgalvoti tapatybę, kurios
   * nėra, ir du skirtingi rakto naudotojai taptų vienu „vartotoju".
   *
   * `actor` tokiam job'ui YRA reikšmingas (rakto atspaudas auditui), bet
   * `ownerId` lieka `null`. Tai užrakina skirtumą tarp dviejų laukų.
   */
  const job = await jobStore.create({ actor: "key_9f2c1a", ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL });

  assert.equal(job.ownerId, null, "bendras raktas neturi išgalvotos nuosavybės");
  assert.equal(job.actor, "key_9f2c1a", "auditui rakto atspaudas išlieka");

  // `null` NĖRA wildcard: sesijos vartotojas tokio job'o negauna.
  assert.equal(await jobStore.get({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), jobStore.FORBIDDEN);
});

test("#159 SYSTEM: sweep mato VISUS job'us nepriklausomai nuo savininko", async () => {
  /**
   * Aklas visų metodų scope'inimas tyliai sulaužytų retenciją: ji pradėtų
   * praleisti svetimus įrašus be jokios klaidos.
   */
  const before = (await jobStore.system.listAll()).length;

  await jobStore.create({ ownerId: A, ownerKind: OWNER_KIND.USER });
  await jobStore.create({ ownerId: B, ownerKind: OWNER_KIND.USER });
  await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED });

  const all = await jobStore.system.listAll();
  assert.equal(all.length, before + 3, "sweep turi matyti visus tris savininkus");
});

test("#159 SYSTEM: get/update/remove veikia be owner konteksto", async () => {
  const job = await jobStore.create({ ownerId: B, ownerKind: OWNER_KIND.USER });

  assert.ok(await jobStore.system.get(job.id), "worker'is neturi ir negali turėti ownerId");
  assert.ok(await jobStore.system.restart(job.id));
  assert.equal(await jobStore.system.remove(job.id), true);
});

/* ── `ownerId = null` NĖRA nuosavybės įrodymas ────────────────────────── */

test("#159 KRITINIS: bendras API_KEY NĖRA legacy job'o savininkas", async () => {
  /**
   * PAVOJINGIAUSIA PORA – ir ilgą laiką ji praeidavo.
   *
   * Kol nuosavybė buvo lyginama TIK pagal `ownerId`, galiojo:
   *
   *   legacy job (ownerId nėra)      → normalizuojama į ""
   *   API-key užklausa (ownerId null) → normalizuojama į ""
   *   "" === ""                        → SAVININKAS
   *
   * Bendro rakto turėtojas tapdavo visų prieš #159 sukurtų job'ų savininku.
   * `ownerKind` tai uždaro: legacy įrašas neturi rūšies ir nesutampa su nė
   * viena vartotojo lygio rūšimi.
   */
  const legacy = await legacyJob({ actor: "senas-vartotojas" });
  /**
   * `undefined` (laukas nesantis) ir `null` abu reiškia „eros nėra". Per Redis
   * jie suvienodinami į `null`, atmintyje lieka `undefined` – `matchesOwner()`
   * abu traktuoja vienodai (`!job.ownerKind`).
   */
  assert.ok(legacy.ownerKind == null, "prielaida: legacy įrašas be rūšies");

  /**
   * Pavadinime NĖRA „key" sąmoningai: CodeQL `js/clear-text-logging` taisyklė
   * laiko `*Key*` identifikatorius jautriais ir pažymi bet kokį jų kelią į
   * logerį. Čia objektas jokios paslapties neturi (`{ jobId, ownerId,
   * ownerKind }`), o logamas tik `jobId` – bet klaidingo signalo pigiau
   * išvengti nei jį kaskart atmetinėti. Atmestas įspėjimas dar ir nuslopintų
   * TIKRĄ radinį, jei jis kada atsirastų tame pačiame kelyje.
   */
  const sharedPrincipal = { jobId: legacy.id, ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL };
  assert.equal(await jobStore.get(sharedPrincipal), jobStore.FORBIDDEN);
  assert.equal(await jobStore.finish(sharedPrincipal, "failed"), jobStore.FORBIDDEN);
  assert.equal(await jobStore.remove(sharedPrincipal), jobStore.FORBIDDEN);
});

test("#159 KRITINIS: bendras API_KEY NĖRA desktop job'o savininkas", async () => {
  const desktop = await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED });

  const sharedPrincipal = { jobId: desktop.id, ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL };
  assert.equal(await jobStore.get(sharedPrincipal), jobStore.FORBIDDEN, "abu `null`, bet rūšys skiriasi");
});

test("#159 KRITINIS: desktop iškviečiantysis NĖRA API-key job'o savininkas", async () => {
  const apiJob = await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL });

  const desktopScope = { jobId: apiJob.id, ownerId: null, ownerKind: OWNER_KIND.UNOWNED };
  assert.equal(await jobStore.get(desktopScope), jobStore.FORBIDDEN);
});

test("#159 legacy job'as nepasiekiamas NĖ VIENAI vartotojo rūšiai", async () => {
  /**
   * Legacy įrašai natūraliai išnyksta per TTL/retenciją. Ar juos gali pasiekti
   * admin – transporto politikos klausimas (#160), ne duomenų sluoksnio.
   */
  const legacy = await legacyJob({ actor: "senas" });

  for (const kind of Object.values(OWNER_KIND)) {
    const result = await jobStore.get({ jobId: legacy.id, ownerId: kind === OWNER_KIND.USER ? A : null, ownerKind: kind });
    assert.equal(result, jobStore.FORBIDDEN, `legacy neturi priklausyti rūšiai ${kind}`);
  }
});

test("#159 SCOPE: praleistas ownerKind yra klaida", async () => {
  await assert.rejects(
    () => jobStore.get({ jobId: "abc", ownerId: null }),
    /ownerKind privalo būti/,
    "`ownerId: null` be rūšies neturi tyliai praeiti"
  );
  await assert.rejects(
    () => jobStore.get({ jobId: "abc", ownerId: null, ownerKind: "isgalvota" }),
    /ownerKind privalo būti/
  );
});

test("#159 ownerKind NEKEIČIAMAS per applyPatch", () => {
  const job = newJob({ ownerId: null, ownerKind: OWNER_KIND.API_PRINCIPAL });
  const patched = applyPatch(job, { ownerKind: OWNER_KIND.USER, ownerId: A });

  assert.equal(patched.ownerKind, OWNER_KIND.API_PRINCIPAL, "rūšis nustatoma TIK create() metu");
  assert.equal(patched.ownerId, null);
});

/* ── kūrimo kontraktas ────────────────────────────────────────────────── */

test("#159 CREATE: legacy formato per create() sukurti NEĮMANOMA", async () => {
  /**
   * #158 pamoka: dabartinis writer'is neturi mokėti rašyti senos eros formato.
   * Praleistas `ownerKind` sukurtų job'ą, kuris store sluoksnyje elgtųsi kaip
   * legacy ir būtų NEPASIEKIAMAS savo savininkui – klaida tyli, nes kūrimas
   * pavyksta, o dingsta tik prieiga.
   */
  await assert.rejects(() => jobStore.create({ actor: "senas" }), /ownerKind/);
  await assert.rejects(() => jobStore.create({ ownerKind: null }), /ownerKind/);
  await assert.rejects(() => jobStore.create({ ownerKind: "isgalvota" }), /ownerKind/);
});

test("#159 CREATE: rūšies ir ID derinys validuojamas, ne tik enum", async () => {
  /**
   * `ownerKind` su nesuderinamu `ownerId` yra semantiškai prieštaringas
   * įrašas, nors `matchesOwner()` jį techniškai palygintų.
   */
  await assert.rejects(
    () => jobStore.create({ ownerKind: OWNER_KIND.USER, ownerId: null }),
    /reikalauja ownerId/,
    "vartotojas be stabilaus ID nėra tapatybė"
  );
  await assert.rejects(
    () => jobStore.create({ ownerKind: OWNER_KIND.API_PRINCIPAL, ownerId: A }),
    /negali turėti ownerId/,
    "bendras raktas nėra individas"
  );
  await assert.rejects(
    () => jobStore.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: A }),
    /negali turėti ownerId/
  );

  // Galiojantys deriniai praeina.
  assert.ok(await jobStore.create({ ownerKind: OWNER_KIND.USER, ownerId: A }));
  assert.ok(await jobStore.create({ ownerKind: OWNER_KIND.API_PRINCIPAL, ownerId: null }));
  assert.ok(await jobStore.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null }));
});

test("#159 INVARIANTAS: prieštaringa tapatybė atmetama IR skaitymo kelyje", async () => {
  /**
   * Iš pradžių derinys buvo tikrinamas tik `create()` metu, o `assertScope()`
   * tikrino vien enum. Tai nebuvo authorization bypass – `matchesOwner()` vis
   * tiek reikalauja sutapti abiem dimensijoms, tad neteisingas scope duotų
   * `FORBIDDEN`.
   *
   * Bet dvi atskiros taisyklės tose pačiose būsenose ilgainiui išsiskiria:
   * būsena, kurios negalima ĮRAŠYTI, vis tiek būtų priimama kaip
   * iškviečiančiojo TAPATYBĖ. Dabar abu kelius saugo tas pats
   * `assertOwnerIdentity()`.
   */
  const neįmanomos = [
    { ownerKind: OWNER_KIND.USER, ownerId: null },
    { ownerKind: OWNER_KIND.API_PRINCIPAL, ownerId: A },
    { ownerKind: OWNER_KIND.UNOWNED, ownerId: A },
  ];

  for (const identity of neįmanomos) {
    const label = `${identity.ownerKind}+${identity.ownerId}`;

    await assert.rejects(() => jobStore.get({ jobId: "x", ...identity }), TypeError, `get: ${label}`);
    await assert.rejects(() => jobStore.update({ jobId: "x", ...identity }, {}), TypeError, `update: ${label}`);
    await assert.rejects(() => jobStore.remove({ jobId: "x", ...identity }), TypeError, `remove: ${label}`);
    await assert.rejects(() => jobStore.create(identity), TypeError, `create: ${label}`);
  }
});

test("#159 INVARIANTAS: klaidos pranešimas nurodo, KURIS metodas", async () => {
  /**
   * Bendras validatorius neturi prarasti konteksto – kitaip trasoje matytum
   * tik „ownerKind privalo būti", nežinodamas, kuris iškvietimas sugedo.
   */
  await assert.rejects(
    () => jobStore.get({ jobId: "x", ownerKind: OWNER_KIND.USER, ownerId: null }),
    /jobStore\.get\(\)/
  );
  await assert.rejects(
    () => jobStore.create({ ownerKind: OWNER_KIND.USER, ownerId: null }),
    /jobStore\.create\(\)/
  );
});

/* ── NUOMA IR KŪRIMO KETINIMAS (#155, Gemini pre-review) ──────────────────── */

test("applyPatch: tenantId ir idempotencyKey NEKEIČIAMI", () => {
  /**
   * ⚠️ BE ŠIOS APSAUGOS BACKEND'AI IŠSISKIRIA.
   *
   * `postgresStore` juos išbraukia iš `UPDATE ... SET` (`IMMUTABLE_COLUMNS`),
   * tad DB pasilieka senas reikšmes. Memory ir Redis remiasi TIK
   * `applyPatch()`, tad be jo tas pats patch'as ten reikšmę pakeistų -
   * stebimas elgesys skirtųsi priklausomai nuo backend'o.
   *
   * Patikrinta eksperimentu prieš pataisymą: memory grąžindavo
   * `tenantId="1111...", idempotencyKey="PAKEISTA"`, PostgreSQL - senas.
   */
  const job = newJob({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "pradinis" });

  const po = applyPatch(job, {
    tenantId: "11111111-1111-1111-1111-111111111111",
    idempotencyKey: "pakeista",
    attempt_count: 3,
  });

  assert.equal(po.tenantId, null, "nuoma yra izoliacijos riba - patch'u nekeičiama");
  assert.equal(po.idempotencyKey, "pradinis", "kūrimo ketinimas patch'u nekeičiamas");
  assert.equal(po.attempt_count, 3, "likęs patch'as privalo būti pritaikytas");
});

test("applyPatch: nekintamų laukų aibė sutampa su postgresStore IMMUTABLE_COLUMNS", () => {
  /**
   * ⚠️ DVI APSAUGOS PRIVALO DENGTI TĄ PATĮ. `applyPatch()` saugo camelCase
   * laukus, `IMMUTABLE_COLUMNS` - snake_case stulpelius. Jei aibės išsiskirtų,
   * atsirastų laukas, kurį vienas backend'as keičia, o kitas ne - tiksliai ta
   * divergencija, kurią šis testas ir gaudo.
   */
  const { IMMUTABLE_COLUMNS } = require("../utils/jobStore/postgresStore");

  const camelIšSnake = {
    id: "id",
    owner_id: "ownerId",
    owner_kind: "ownerKind",
    tenant_id: "tenantId",
    idempotency_key: "idempotencyKey",
    schema_version: "schemaVersion",
    created_at: "created_at",
  };

  const job = newJob({ ownerKind: OWNER_KIND.USER, ownerId: "22222222-2222-2222-2222-222222222222", idempotencyKey: "x" });

  for (const stulpelis of IMMUTABLE_COLUMNS) {
    const laukas = camelIšSnake[stulpelis];
    assert.ok(laukas, `nežinomas nekintamas stulpelis "${stulpelis}" - papildykite atvaizdavimą`);

    const po = applyPatch(job, { [laukas]: "BANDYMAS_PAKEISTI" });
    assert.notEqual(
      po[laukas],
      "BANDYMAS_PAKEISTI",
      `"${laukas}" keičiamas per applyPatch(), nors postgresStore jį laiko nekintamu`
    );
  }
});

test("newJob: schemaVersion normalizuojamas į skaičių (backend'ų paritetas)", () => {
  /**
   * ⚠️ `assertSupportedSchemaVersion()` lygina `=== 2`, tad `"2"` runtime
   * ATMETA. Redis eilutę konvertuoja (`NUMERIC_FIELDS`), PostgreSQL - per
   * `integer` stulpelį, o memory be normalizavimo paliktų `"2"`: tas pats
   * įrašas būtų vykdomas dviejuose backend'uose ir nevykdomas trečiame.
   */
  assert.equal(newJob({ ownerKind: OWNER_KIND.UNOWNED }).schemaVersion, 2);

  /**
   * ⚠️ KVIETĖJO REIKŠMĖ IGNORUOJAMA. `create()` neturi galimybės pagaminti
   * legacy (`null`) ar nežinomos (`3`, `"x"`) eros įrašo - toks job'as
   * autorizacijoje būtų arba palaikytas senoviniu, arba atmestas.
   */
  for (const bandymas of ["2", "x", null, 3, undefined]) {
    assert.equal(
      newJob({ ownerKind: OWNER_KIND.UNOWNED, schemaVersion: bandymas }).schemaVersion,
      2,
      `schemaVersion=${bandymas} neturi paveikti naujo job'o eros`
    );
  }
});

test("#180 P2-2: postgresStore.updateOwned() rašo TIK patch'o stulpelius, nuosavybė lieka WHERE dalyje", async () => {
  /**
   * ⚠️ FAKE POOL, NE TIKRAS PostgreSQL - IR TAI SĄMONINGA.
   *
   * Elgesį su tikru DB (konkurentinė mutacija tarp read ir CAS) įrodo
   * `postgresStore.integration` lenktynių testas, bet jis be `DATABASE_URL`
   * praleidžiamas. Šis testas tikrina SUGENERUOTĄ mutaciją ir veikia
   * KIEKVIENAME `npm test` paleidime, tad regresija pagaunama iš karto, o ne
   * tik PostgreSQL CI žingsnyje.
   *
   * Tikrinamos keturios savybės:
   *   1. `SET` turi patch'o pakeistus stulpelius;
   *   2. `SET` NETURI nepakeistų (pasenusių) stulpelių;
   *   3. `SET` NETURI nė vieno `IMMUTABLE_COLUMNS` nario;
   *   4. nuosavybės CAS lieka `WHERE` dalyje su NULL-safe `owner_id`.
   */
  const {
    createPostgresStore,
    jobToRow,
    IMMUTABLE_COLUMNS,
  } = require("../utils/jobStore/postgresStore");

  const scope = { ownerKind: OWNER_KIND.USER, ownerId: A };
  const esamas = newJob({ ownerKind: scope.ownerKind, ownerId: scope.ownerId });
  Object.assign(esamas, {
    status: "processing",
    phase: "transcribing",
    attempt_count: 4,
    deletion_pending: true,
    storageKey: "audio/senas",
  });

  let pagauta = null;
  const client = {
    query: async (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*SELECT j\.\*/.test(sql)) {
        const eilute = jobToRow(esamas);
        eilute.artefacts = [];        // pg jsonb grąžinamas jau dekoduotas
        return { rows: [eilute], rowCount: 1 };
      }
      /**
       * #180 P2-3: mutacija dabar įvyniota į duomenis keičiantį CTE, o nesėkmės
       * klasifikacija skaičiuojama TAME PAČIAME sakinyje. Išorinis `SELECT`
       * grąžina vieną eilutę su `pakeista`/`priezastis`.
       */
      if (/^WITH mutacija AS/.test(sql)) {
        pagauta = { sql, params };
        return { rows: [{ pakeista: 1, priezastis: 0 }], rowCount: 1 };
      }
      throw new Error(`netikėta SQL užklausa: ${sql}`);
    },
    release: () => {},
  };

  const store = createPostgresStore({ connect: async () => client });

  /** Patch'e YRA ir priešiškų nekintamų laukų - jie neturi patekti į `SET`. */
  const outcome = await store.updateOwned(
    esamas.id,
    {
      requestId: "naujas",
      error_code: "PROVIDER_TIMEOUT",
      ownerId: "99999999-9999-4999-8999-999999999999",
      ownerKind: OWNER_KIND.API_PRINCIPAL,
      tenantId: "88888888-8888-4888-8888-888888888888",
      idempotencyKey: "pakeista",
      schemaVersion: 999,
      createdAt: "2000-01-01T00:00:00.000Z",
      id: "77777777-7777-4777-8777-777777777777",
    },
    scope
  );

  assert.notEqual(outcome, null);
  assert.notEqual(outcome, "FORBIDDEN");
  assert.ok(pagauta, "sąlyginė mutacija privalo būti įvykdyta");

  const setDalis = pagauta.sql.slice(0, pagauta.sql.indexOf("WHERE"));
  const stulpeliai = [...setDalis.matchAll(/"([a-z_]+)" = \$/g)].map((m) => m[1]);

  // 1) Patch'o pakeisti stulpeliai YRA.
  for (const laukiamas of ["request_id", "error_code"]) {
    assert.ok(stulpeliai.includes(laukiamas), `SET privalo turėti "${laukiamas}"`);
  }
  /**
   * ⚠️ `updated_at` nebėra PARAMETRAS - jį rašo SQL išraiška rašymo metu, kad
   * po užrakto laukimo neperrašytų konkurento naujesnės žymos.
   */
  assert.ok(setDalis.includes("clock_timestamp()"),
    "updated_at privalo būti skaičiuojamas rašymo metu");
  // 2) Nepakeisti (pasenę) stulpeliai NEPATENKA - būtent jie buvo atsukami.
  for (const draudziamas of ["status", "phase", "attempt_count", "deletion_pending",
    "deletion_attempts", "storage_key", "artefacts", "progress_known",
    "progress_current", "progress_total", "started_at", "completed_at",
    "error_message"]) {
    assert.equal(
      stulpeliai.includes(draudziamas),
      false,
      `SET neturi liesti nepakeisto stulpelio "${draudziamas}" - platus SET atsuka konkurentų darbą`
    );
  }

  // 3) Nė vienas nekintamas stulpelis - net kai patch'as jų aiškiai prašo.
  for (const nekintamas of IMMUTABLE_COLUMNS) {
    assert.equal(
      stulpeliai.includes(nekintamas),
      false,
      `NEKINTAMAS stulpelis "${nekintamas}" niekada negali patekti į SET`
    );
  }

  // 4) Nuosavybės CAS lieka `WHERE` dalyje, NULL-safe, su teisingais parametrais.
  assert.match(pagauta.sql, /WHERE id = \$1/);
  assert.match(pagauta.sql, /owner_id IS NOT DISTINCT FROM \$2/);
  assert.match(pagauta.sql, /owner_kind = \$3/);
  assert.equal(pagauta.params[0], esamas.id);
  assert.equal(pagauta.params[1], scope.ownerId);
  assert.equal(pagauta.params[2], scope.ownerKind);

  /**
   * 5) VERSIJOS SĄLYGA – TAME PAČIAME `WHERE`, ne antru round-trip'u (#184, 7.5b).
   *
   * ⚠️ Šis testas KRITO, kai buvo pridėtas ketvirtasis parametras – ir tai
   * teisingas elgesys, ne trukdis: parametrų skaičiaus patikra egzistuoja būtent
   * tam, kad nauja sąlyga negalėtų atsirasti nepastebėta. Todėl tikrinamas ne
   * tik naujas skaičius, bet ir pati sąlygos FORMA.
   *
   * `$4::int IS NULL` šaka reiškia „sąlygos nėra": be `expectedVersion` elgesys
   * lieka toks pat, koks buvo iki 7.5b.
   */
  assert.match(pagauta.sql, /\(\$4::int IS NULL OR version = \$4\)/,
    "nuosavybė IR versija privalo būti viename UPDATE");
  assert.equal(pagauta.params[3], null, "be `expectedVersion` sąlyga neaktyvi");

  assert.equal(pagauta.params.length, 4 + stulpeliai.length,
    "parametrų skaičius privalo atitikti parametrizuotų SET stulpelių skaičių");
});

test("#180 P2-C: PostgreSQL atkūrimas KRENTA UŽDARAI dėl neatstovaujamo progreso", async () => {
  /**
   * ⚠️ VEIKIA BE PostgreSQL - ir todėl paleidžiamas kiekviename `npm test`.
   *
   * `restoreRecord()` yra vienintelis kelias, aplenkiantis progreso validaciją
   * (`restoreService._validateContent()` tikrina tik `id`). Ranka redaguota ar
   * sugadinta kopija su skaitinėmis EILUTĖMIS arba įdėtais metaduomenimis
   * pasiektų `double precision` parametrus ir būtų TYLIAI perinterpretuota /
   * nukirpta. Option C tokias būsenas laiko struktūriškai neatstovaujamomis,
   * tad atkūrimas privalo kristi.
   *
   * ⚠️ TIKRINAMA IR TAI, KAD NIEKO NEBUVO VYKDOMA. `restoreRecord()` daro
   * `DELETE` + `INSERT`; jei patikra būtų PO destruktyvaus žingsnio, netinkamas
   * įrašas ištrintų esamą ir tik tada kristų.
   */
  const { createPostgresStore } = require("../utils/jobStore/postgresStore");

  const bazinis = {
    id: "33333333-3333-4333-8333-333333333333",
    type: "transcription", status: "processing", phase: "transcribing",
    ownerKind: OWNER_KIND.UNOWNED, ownerId: null, tenantId: null, artefacts: [],
    created_at: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const vykdytos = [];
  const pool = {
    connect: async () => ({
      query: async (sql) => { vykdytos.push(String(sql).trim().slice(0, 24)); return { rows: [], rowCount: 0 }; },
      release: () => {},
    }),
    query: async () => ({ rows: [] }),
  };
  const store = createPostgresStore(pool);

  const netinkami = [
    ["skaitinės eilutės", { progressKnown: true, progress: { current: "8", total: "10" } }, /nėra baigtinis SKAIČIUS/],
    ["įdėti metaduomenys", { progressKnown: true, progress: { metadata: { total: 20 }, current: 5, total: 10 } }, /laisvos formos raktų/],
    ["progressKnown be progreso", { progressKnown: true, progress: null }, /reikalauja \{ current, total \}/],
    ["progresas be progressKnown", { progressKnown: false, progress: { current: 5, total: 10 } }, /tyliai prarastos/],
    ["NaN reikšmė", { progressKnown: true, progress: { current: NaN, total: 10 } }, /nėra baigtinis SKAIČIUS/],
  ];

  for (const [pavadinimas, progresas, sablonas] of netinkami) {
    vykdytos.length = 0;
    await assert.rejects(
      () => store.restoreRecord({ ...bazinis, ...progresas }),
      (e) => e.code === "UNSUPPORTED_PROGRESS_REPRESENTATION" && sablonas.test(e.message),
      `${pavadinimas}: atkūrimas privalo kristi uždarai`
    );
    /** ⚠️ ESMĖ: nė viena užklausa - taigi nė vienas `DELETE` - neįvyko. */
    assert.deepEqual(vykdytos, [],
      `${pavadinimas}: patikra privalo įvykti PRIEŠ destruktyvų DELETE`);
  }

  /** Teisėtos formos privalo praeiti nepakitusios. */
  for (const [pavadinimas, progresas] of [
    ["skaitinis progresas", { progressKnown: true, progress: { current: 5, total: 10 } }],
    ["be progreso", { progressKnown: false, progress: null }],
    ["legacy be progressKnown", {}],
  ]) {
    vykdytos.length = 0;
    await store.restoreRecord({ ...bazinis, ...progresas });
    assert.ok(vykdytos.length > 0, `${pavadinimas}: teisėtas įrašas privalo būti atkurtas`);
  }
});

test("#180 P2-C: PostgreSQL atkūrimas atmeta NE-BOOLEAN progressKnown", async () => {
  /**
   * ⚠️ TYLUS PRASMĖS PAKEITIMAS.
   *
   * Ranka redaguota kopija su `progressKnown: "true"` (EILUTE) anksčiau
   * praeidavo: `!== true` ją laikė „progreso nėra" šaka, o `jobToRow()` paskui
   * įrašydavo `progress_known = false`. Įrašas atkuriamas TYLIAI pakeista
   * prasme - būtent tai #180 6 punktas draudžia.
   *
   * MUTACIJOS ĮRODYMAS: pašalinus boolean patikrą, `"true"` ir `1` praeina.
   */
  const { createPostgresStore } = require("../utils/jobStore/postgresStore");
  const vykdytos = [];
  const pool = {
    connect: async () => ({
      query: async (sql) => { vykdytos.push(String(sql).slice(0, 12)); return { rows: [], rowCount: 0 }; },
      release: () => {},
    }),
    query: async () => ({ rows: [] }),
  };
  const store = createPostgresStore(pool);
  const bazinis = {
    id: "44444444-4444-4444-8444-444444444444",
    type: "transcription", status: "processing", phase: "transcribing",
    ownerKind: OWNER_KIND.UNOWNED, ownerId: null, tenantId: null, artefacts: [],
    created_at: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };

  for (const bloga of ["true", "false", 1, 0, null]) {
    vykdytos.length = 0;
    await assert.rejects(
      () => store.restoreRecord({ ...bazinis, progressKnown: bloga, progress: null }),
      (e) => e.code === "UNSUPPORTED_PROGRESS_REPRESENTATION" && /nėra boolean/.test(e.message),
      `progressKnown=${JSON.stringify(bloga)} privalo būti atmestas`
    );
    assert.deepEqual(vykdytos, [], "patikra privalo įvykti PRIEŠ destruktyvų DELETE");
  }

  /** Teisėtos formos: tikras boolean arba visai nesantis laukas (legacy). */
  for (const gera of [{ progressKnown: false, progress: null }, { progress: null }]) {
    vykdytos.length = 0;
    await store.restoreRecord({ ...bazinis, ...gera });
    assert.ok(vykdytos.length > 0, `teisėta forma privalo būti atkurta: ${JSON.stringify(gera)}`);
  }
});

test("#180 CAS: PATCH_STULPELIAI dengia KIEKVIENĄ kintamą stulpelį", () => {
  /**
   * ⚠️ PRALEISTAS LAUKAS = TYLIAI NEĮRAŠYTAS PATCH'AS.
   *
   * `changedColumns()` `SET` sąrašą sudaro iš patch'o paliestų stulpelių. Jei
   * kuris nors kintamas stulpelis šiame atvaizdavime neturėtų patch rakto, jį
   * keičiantis patch'as būtų tyliai praleistas, kai reikšmė sutampa su pasenusiu
   * snapshot'u. Todėl aibė tikrinama, o ne prižiūrima iš atminties.
   */
  const { PATCH_STULPELIAI, IMMUTABLE_COLUMNS } = require("../utils/jobStore/postgresStore");
  const { COLUMNS } = require("../utils/jobStore/postgresStore");

  const dengiami = new Set();
  for (const stulpeliai of Object.values(PATCH_STULPELIAI)) {
    for (const c of stulpeliai) dengiami.add(c);
  }

  /** Kiekvienas atvaizduotas stulpelis privalo realiai egzistuoti. */
  for (const c of dengiami) {
    assert.ok((COLUMNS || []).includes(c) || c === "updated_at",
      `PATCH_STULPELIAI nurodo nežinomą stulpelį "${c}"`);
  }

  /** Ir kiekvienas KINTAMAS stulpelis privalo turėti bent vieną patch raktą. */
  const kintami = (COLUMNS || []).filter((c) => !IMMUTABLE_COLUMNS.has(c));
  const nedengiami = kintami.filter((c) => !dengiami.has(c));
  assert.deepEqual(nedengiami, [],
    `stulpeliai be patch rakto (patch'as jiems būtų tyliai prarastas): ${nedengiami.join(", ")}`);
});

test("#180 CAS: eksplicitiškai nurodytas laukas rašomas NET jei sutampa su snapshot'u", () => {
  /**
   * ⚠️ TIKSLIAI TAS ATVEJIS, KURIO SKIRTUMO SĄRAŠAS NEPAGAUDAVO.
   *
   * Kvietėjas nustato `requestId` į TĄ PAČIĄ reikšmę, kurią ką tik perskaitė.
   * Skirtumo nėra, tad senoji realizacija stulpelį praleisdavo - o jei konkurentas
   * jį tuo tarpu pakeitė, CAS pavykdavo ir grąžindavo SĖKMĘ paliekant svetimą
   * reikšmę. Patch'as būdavo tyliai prarastas.
   *
   * MUTACIJOS ĮRODYMAS: grąžinus `changedColumns()` prie vien skirtumo,
   * `request_id` iškrenta iš `SET` ir šis testas krinta.
   */
  const { createPostgresStore, jobToRow } = require("../utils/jobStore/postgresStore");

  const esamas = newJob({ ownerKind: OWNER_KIND.USER, ownerId: A });
  esamas.requestId = "nepakitusi-reiksme";

  let pagauta = null;
  const client = {
    query: async (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*SELECT j\.\*/.test(sql)) {
        const r = jobToRow(esamas);
        r.artefacts = [];
        return { rows: [r], rowCount: 1 };
      }
      if (/^WITH mutacija AS/.test(sql)) {
        pagauta = { sql, params };
        return { rows: [{ pakeista: 1, priezastis: 0, buvo: 1 }], rowCount: 1 };
      }
      throw new Error(`netikėta SQL: ${sql.slice(0, 40)}`);
    },
    release: () => {},
  };

  return createPostgresStore({ connect: async () => client })
    .updateOwned(esamas.id, { requestId: "nepakitusi-reiksme" },
      { ownerKind: OWNER_KIND.USER, ownerId: A })
    .then(() => {
      assert.ok(pagauta, "sąlyginė mutacija privalo būti įvykdyta");
      const setDalis = pagauta.sql.slice(0, pagauta.sql.indexOf("WHERE"));
      assert.ok(setDalis.includes('"request_id"'),
        `eksplicitiškai nurodytas stulpelis privalo patekti į SET: ${setDalis}`);

      /**
       * ⚠️ LAIKO ŽYMA - SQL IŠRAIŠKA, NE PASENĘS PARAMETRAS. Prieš CAS
       * užfiksuota JS reikšmė po užrakto laukimo perrašytų konkurento naujesnę.
       */
      assert.ok(setDalis.includes("clock_timestamp()"),
        `updated_at privalo būti skaičiuojamas rašymo metu: ${setDalis}`);
      assert.equal(/"updated_at" = \$\d/.test(setDalis), false,
        "updated_at negali būti perduodamas kaip pasenęs parametras");
    });
});

test("#180 P2-6: progreso CAS predikatas saugo TIKSLIAI žinomus komponentus", () => {
  /**
   * ⚠️ SARGAS PRIEŠ TYLŲ NUOKRYPĮ.
   *
   * `postgresStore.integration` izoliacijos testai tikrina po VIENĄ predikato
   * komponentą. Jų saugomų laukų sąrašas išvedamas iš paties predikato, tad
   * rankinio nuokrypio nebėra - bet naujas komponentas vis tiek liktų BE
   * izoliuoto testo, o pašalintas dingtų nepastebėtas.
   *
   * Šis tikrinimas veikia BE PostgreSQL, tad krinta jau `npm test` metu ir
   * priverčia sąmoningai atnaujinti įrodymus.
   *
   * ⚠️ TAI STRUKTŪRINIS SARGAS (AGENTS.md §9.2), ne elgesio įrodymas: jis sako,
   * KURIE komponentai saugomi, o ne kad kiekvienas realiai atmeta pasenusį
   * įvykį. Elgesį įrodo izoliuoti lenktynių testai.
   */
  const { PROGRESO_CAS_PREDIKATAS } = require("../utils/jobStore/postgresStore");

  const komponentai = [
    ...new Set(
      [...PROGRESO_CAS_PREDIKATAS.matchAll(/([a-z_]+)\s+(?:IS NOT DISTINCT FROM|=)\s+\$/g)]
        .map((m) => m[1])
    ),
  ];

  assert.deepEqual(komponentai, [
    "id",
    "type",
    "status",
    "phase",
    "progress_known",
    "progress_current",
    "progress_total",
  ], "pasikeitus CAS predikatui privaloma atnaujinti ir izoliuotus lenktynių testus");
});

test("#180 CAS: update() taip pat stampuoja updated_at RAŠYMO metu", () => {
  /**
   * ⚠️ TAS PATS GEDIMAS KAIP CAS KELIUOSE.
   *
   * `update()` (per `writePatched()`) daro neužrakintą skaitymą ir po jo
   * besąlyginį `UPDATE`. Laukiant svetimo eilutės užrakto, `applyPatch()` dar
   * prieš laukimą užfiksuota `updatedAt` perrašytų konkurento naujesnę žymą
   * atgal; užlaikymui viršijus `TTL_MS`, ką tik commit'inta eilutė iš karto
   * taptų tinkama `sweepExpired()` valymui.
   *
   * MUTACIJOS ĮRODYMAS: grąžinus `updated_at` į parametrų sąrašą, `SET` vėl
   * turi `"updated_at" = $n`, ir šis testas krinta.
   */
  const { createPostgresStore, jobToRow } = require("../utils/jobStore/postgresStore");

  const esamas = newJob({ ownerKind: OWNER_KIND.UNOWNED });
  let pagauta = null;
  const client = {
    query: async (sql) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*SELECT j\.\*/.test(sql)) {
        const r = jobToRow(esamas);
        r.artefacts = [];
        return { rows: [r], rowCount: 1 };
      }
      if (/^UPDATE jobs SET/.test(sql)) {
        pagauta = sql;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  return createPostgresStore({ connect: async () => client })
    .update(esamas.id, { attempt_count: 3 })
    .then(() => {
      assert.ok(pagauta, "mutacija privalo būti įvykdyta");
      const setDalis = pagauta.slice(0, pagauta.indexOf("WHERE"));
      assert.ok(setDalis.includes("clock_timestamp()"),
        `updated_at privalo būti skaičiuojamas rašymo metu: ${setDalis}`);
      assert.equal(/"updated_at" = \$\d/.test(setDalis), false,
        "updated_at negali būti perduodamas kaip pasenęs parametras");
      /** Likę stulpeliai privalo likti parametrizuoti (be SQL injekcijos rizikos). */
      assert.ok(setDalis.includes('"attempt_count" = $'),
        "kiti stulpeliai privalo likti parametrais");
    });
});
