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
  const job = newJob({ actor: "key_abc123", ownerId: null, ownerKind: OWNER_KIND.API_KEY });
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
  assert.equal(await jobStore.update({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }, { status: "failed" }), jobStore.FORBIDDEN);
  assert.equal(await jobStore.remove({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }), jobStore.FORBIDDEN);

  const still = await jobStore.system.get(job.id);
  assert.ok(still, "svetimas job'as turi likti nepaliestas");
  assert.notEqual(still.status, "failed", "atmestas update neturi būti pritaikytas");
});

test("#159 FILTRAS: savininkas gauna, keičia ir ištrina savo job'ą", async () => {
  const job = await jobStore.create({ ownerId: A, ownerKind: OWNER_KIND.USER });

  assert.equal((await jobStore.get({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER })).id, job.id);
  const updated = await jobStore.update({ jobId: job.id, ownerId: A, ownerKind: OWNER_KIND.USER }, { status: "processing" });
  assert.equal(updated.status, "processing");
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
  const job = await jobStore.create({ actor: "key_9f2c1a", ownerId: null, ownerKind: OWNER_KIND.API_KEY });

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
  assert.ok(await jobStore.system.update(job.id, { status: "processing" }));
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

  const apiKeyScope = { jobId: legacy.id, ownerId: null, ownerKind: OWNER_KIND.API_KEY };
  assert.equal(await jobStore.get(apiKeyScope), jobStore.FORBIDDEN);
  assert.equal(await jobStore.update(apiKeyScope, { status: "failed" }), jobStore.FORBIDDEN);
  assert.equal(await jobStore.remove(apiKeyScope), jobStore.FORBIDDEN);
});

test("#159 KRITINIS: bendras API_KEY NĖRA desktop job'o savininkas", async () => {
  const desktop = await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.UNOWNED });

  const apiKeyScope = { jobId: desktop.id, ownerId: null, ownerKind: OWNER_KIND.API_KEY };
  assert.equal(await jobStore.get(apiKeyScope), jobStore.FORBIDDEN, "abu `null`, bet rūšys skiriasi");
});

test("#159 KRITINIS: desktop iškviečiantysis NĖRA API-key job'o savininkas", async () => {
  const apiJob = await jobStore.create({ ownerId: null, ownerKind: OWNER_KIND.API_KEY });

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
  const job = newJob({ ownerId: null, ownerKind: OWNER_KIND.API_KEY });
  const patched = applyPatch(job, { ownerKind: OWNER_KIND.USER, ownerId: A });

  assert.equal(patched.ownerKind, OWNER_KIND.API_KEY, "rūšis nustatoma TIK create() metu");
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
    () => jobStore.create({ ownerKind: OWNER_KIND.API_KEY, ownerId: A }),
    /negali turėti ownerId/,
    "bendras raktas nėra individas"
  );
  await assert.rejects(
    () => jobStore.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: A }),
    /negali turėti ownerId/
  );

  // Galiojantys deriniai praeina.
  assert.ok(await jobStore.create({ ownerKind: OWNER_KIND.USER, ownerId: A }));
  assert.ok(await jobStore.create({ ownerKind: OWNER_KIND.API_KEY, ownerId: null }));
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
    { ownerKind: OWNER_KIND.API_KEY, ownerId: A },
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
