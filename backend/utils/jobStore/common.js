const crypto = require("crypto");

// Job statusai (bendri abiem backend'ams). `cancelled` pridėtas pagal production
// planą - jobas, kurį vartotojas ar sistema nutraukė prieš pabaigą.
const STATUS = {
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const TTL_MS = parseInt(process.env.JOB_TTL_MINUTES || "60", 10) * 60 * 1000;

/**
 * Sukuria naują job objektą su visais laukais. Bendra abiem backend'ams, kad
 * struktūra būtų vienoda nepriklausomai nuo saugyklos (in-memory ar Redis).
 *
 * Laukai pagal production planą:
 *  - attempt_count: kiek kartų bandyta apdoroti (retry politikai);
 *  - created_at / started_at / completed_at: gyvavimo ciklo laikai (diagnostikai);
 *  - error_code / error_message: struktūrizuota klaida (ne tik tekstas).
 */
/**
 * ERA NORMALIZUOJAMA Į SKAIČIŲ (#155).
 *
 * ⚠️ `newJob()` NAUDOJA TIK EILUTĖS ATVAIZDO NORMALIZAVIMĄ. Naujas job'as
 * VISADA gauna erą `2`; `null`, `3` ar `"x"` iš kviečiančiojo nepriimami.
 * Kitaip `create()` galėtų pagaminti įrašą, kurį autorizacija laiko legacy
 * (`null`) arba visai atmeta - t. y. job'ą, kuris niekada nepasileis.
 *
 * ⚠️ BE ŠITO BACKEND'AI IŠSISKIRIA. `assertSupportedSchemaVersion()` lygina
 * `=== 2`, tad `"2"` runtime ATMETA. Redis eilutę konvertuoja
 * (`redisStore.js` NUMERIC_FIELDS), PostgreSQL - per `integer` stulpelio tipą,
 * o memory paliktų `"2"` ir job'as taptų nevykdomas TIK atmintyje.
 *
 * Konvertuojama, o ne atmetama, nes du backend'ai tai jau daro - atmetimas
 * pakeistų jų elgesį. Ne skaitinė reikšmė paliekama nepakeista: ją atmes
 * `assertSupportedSchemaVersion()` ir DB `CHECK`.
 */
function normalizeSchemaVersion(value) {
  if (value === undefined || value === null) return value;

  const skaicius = Number(value);
  return Number.isInteger(skaicius) ? skaicius : value;
}

const CURRENT_SCHEMA_VERSION = 2;

/* ══════════════════════════════════════════════════════════════════════════
 * KANONINIS TIPŲ KONTRAKTAS (#205, 7.2c)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ AIBĖS DEKLARUOJAMOS, NE GENERUOJAMOS IŠ `newJob()`.
 *
 * `newJob()` yra runtime konstruktorius, o laukų schema - duomenų modelio
 * kontraktas. Schema neturi būti netiesiogiai „atrandama" paleidžiant
 * konstruktorių; ji deklaruojama, o konstruktorius prieš ją tikrinamas
 * (`tests/jobStoreTypeNormalization.test.js` sargas).
 *
 * ⚠️ `deletion_pending` IR `deletion_attempts` `newJob()` IŠVESTYJE NEEGZISTUOJA.
 * Juos materializuoja tik `postgresStore.rowToJob()` ir ištrynimo kelias, tad
 * sargas jų NEMATO - jie čia įrašyti rankomis. Tai ir yra sargo riba, įvardyta
 * prie jo paties.
 */
const BOOLEAN_FIELDS = new Set([
  "audio_cleanup_pending",
  "deletion_pending",
  /**
   * #154: `"false"` yra TRUTHY, tad be konversijos `progressKnown === false`
   * niekada nesuveikia, ir diarizacijos fazė rodo procentą vietoj „progresas
   * neteikiamas".
   */
  "progressKnown",
]);

const NUMBER_FIELDS = new Set([
  "attempt_count",
  "audio_cleanup_attempts",
  "deletion_attempts",
  /** Įrašo era (#158). Jos taisyklė - `normalizeSchemaVersion()`, žr. žemiau. */
  "schemaVersion",
  /**
   * OPTIMISTIC LOCK VERSIJA (#184, 7.5b).
   *
   * ⚠️ KANONINIŲ LAUKŲ AIBĖJE BŪTINAI. Redis hash'e reikšmės yra TEKSTAS, tad be
   * normalizavimo `redisStore` grąžintų `version: "3"`, o memory - `3`. Bendras
   * kontrakto rinkinys lygina backend'ų būsenas `deepEqual`, tad skirtumas
   * nebūtų „kosmetinis" - jis arba sulaužytų palyginimą, arba priverstų lauką iš
   * jo išimti, t. y. tyliai susiaurintų rinkinį.
   */
  "version",
]);

const KANONINIAI_LAUKAI = Object.freeze([...BOOLEAN_FIELDS, ...NUMBER_FIELDS]);

/**
 * VIENA TAISYKLĖ, KURIĄ NAUDOJA ABI NORMALIZAVIMO VIETOS (#205).
 *
 * Jų yra dvi ir po pataisos lieka dvi: rašymo kelias (`normalizeJob()` per
 * `newJob()`, `applyPatch()` ir `restoreRecord()`) ir `redisStore.deserialize()`
 * skaitymo kelyje, nes Redis fiziškai saugo tekstą. Dvi nepriklausomos
 * realizacijos yra ta pati klasė, kurią #205 ir šalina.
 *
 * ⚠️ NE `Boolean()`. `Boolean("false") === true` - reikšmė virstų PRIEŠINGA
 * logine reikšme. Tai ir buvo gedimas, kuris tris kartus sprogo.
 *
 * ⚠️ TAISYKLĖ NEIŠRASTA: tai `redisStore.deserialize()` taisyklė, iki šiol
 * veikusi tik skaitant. Rašymo kelias jos neturėjo, tad tas pats patch'as
 * trijuose backend'uose duodavo skirtingą reikšmę.
 *
 * ⚠️ `null` IR `undefined` PALIEKAMI NEPAKEISTI, ir tai NE praleidimas.
 * `schemaVersion: null` yra LEGACY EROS ŽYMĖ (#158): `applyPatch()` skiria
 * „lauko nėra" nuo `null`, o `assertSupportedSchemaVersion()` `null` praleidžia.
 * Konvertavus `null` → `0`, kiekvienas legacy įrašas po pirmo `update()` taptų
 * nežinomos eros ir nebepasileistų.
 *
 * KAINA, ĮVARDYTA: `null` boolean lauke lieka `null` memory/Redis pusėje ir
 * `false` PostgreSQL pusėje (`jobToRow()` daro `Boolean()`). Tai VIENINTELĖ
 * likusi kanoninio kontrakto divergencija po 7.2c; ji pre-egzistuoja, nėra #205
 * tema (issue kalba apie eilutines reikšmes) ir turi savo issue kandidatą.
 */
function normalizeFieldValue(laukas, reiksme) {
  if (reiksme === null || reiksme === undefined) return reiksme;

  /**
   * ⚠️ `schemaVersion` TURI SAVO AUTORITETĄ, IR JIS NE ČIA.
   *
   * `normalizeSchemaVersion()` yra #204 taisyklė; #205 jos NEKEIČIA, tik
   * pagaliau prijungia - iki 7.2c ji neturėjo nė vieno kvietėjo, o veikė
   * `redisStore.deserialize()` `parseInt(v, 10) || 0`. Abi taisyklės sutampa
   * įprastoms reikšmėms, bet ne kraštinėms, ir du skirtumai keičia ne tipą, o
   * `assertSupportedSchemaVersion()` SPRENDIMĄ:
   *
   *   "2.5"  → `parseInt` duotų 2 (era PRIIMTA tyliai) · ši taisyklė duoda
   *            "2.5" (era ATMESTA) - o tylus neaiškios reikšmės aiškinimas
   *            kaip kitos loginės reikšmės yra būtent tai, ką #205 draudžia;
   *   "0x2"  → ši taisyklė duoda 2 (era PRIIMTA). Tai #204 taisyklės savybė
   *            (`Number("0x2") === 2`), NE 7.2c sprendimas.
   */
  if (laukas === "schemaVersion") return normalizeSchemaVersion(reiksme);

  if (BOOLEAN_FIELDS.has(laukas)) return String(reiksme).toLowerCase() === "true";
  if (NUMBER_FIELDS.has(laukas)) return parseInt(reiksme, 10) || 0;

  return reiksme;
}

/**
 * Kanoniniai job objekto laukai - į kanoninius tipus.
 *
 * ⚠️ LIEČIAMI TIK ESAMI RAKTAI. Materializavus visą aibę, kiekvienas memory
 * job'as staiga gautų `deletion_pending: false` ir `deletion_attempts: 0`:
 * pasikeistų objekto forma, atsarginių kopijų turinys ir kontraktų testų
 * palyginimai. `deletion_*` laukų `newJob()` sąmoningai nemateralizuoja.
 */
function normalizeJob(job) {
  if (!job || typeof job !== "object") return job;

  /**
   * ⚠️ NETINKAMA ATKURTA `version` ATMETAMA GARSIAI (#184, Codex B9).
   *
   * `version` yra `NUMBER_FIELDS` aibėje, tad bendra taisyklė
   * (`parseInt(x, 10) || 0`) priimtų `0`, neigiamą ar `"1x"` (→ `1`) tyliai.
   * PostgreSQL tokias reikšmes atmeta per `jobs_version_positive`, o memory ir
   * Redis jas ATKURTŲ — ir sugadinti optimistic-lock metaduomenys taptų
   * autoritetingi skirtingai, priklausomai nuo backend'o.
   *
   * Tikrinama ŽALIA reikšmė, ne normalizuota: `parseInt("1x", 10)` grąžina `1`,
   * tad po normalizavimo klaida būtų nebematoma.
   *
   * ⚠️ NUMATYTOJI `1` LIEKA TIK TRŪKSTAMAM LAUKUI. Legacy įrašas iš prieš 7.5b
   * lauko neturi, ir tai NĖRA klaida (žr. materializavimą žemiau); klaida yra
   * PATEIKTA, bet negaliojanti reikšmė.
   */
  if (job.version !== undefined && job.version !== null) {
    const zalia = job.version;

    /**
     * ⚠️ VIRŠUTINĖ RIBA YRA BENDRIAUSIA IŠ TRIJŲ SAUGYKLŲ (#184, Codex F3).
     *
     * `jobs.version` yra PostgreSQL `integer`, tad jo lubos — 2147483647.
     * Vien „skaitmenys ir ≥ 1" praleistų `"2147483648"`: memory ir Redis tokį
     * įrašą atkurtų, o PostgreSQL atmestų — TAS PATS backup'as elgtųsi
     * skirtingai priklausomai nuo backend'o, o tai ir yra klasė, kurią ši
     * patikra šalina.
     *
     * Dar didesnės reikšmės JS pusėje prarastų tikslumą arba virstų
     * `Infinity`, ir „tiksliai +1" kontraktas nustotų galioti tyliai.
     */
    const VERSIJOS_LUBOS = 2147483647;

    const skaicius =
      typeof zalia === "number"
        ? zalia
        : typeof zalia === "string" && /^[0-9]+$/.test(zalia)
          ? Number(zalia)
          : NaN;

    const galioja =
      Number.isInteger(skaicius) && skaicius >= 1 && skaicius <= VERSIJOS_LUBOS;

    if (!galioja) {
      throw new Error(
        `Netinkama optimistic-lock versija: ${JSON.stringify(zalia)}. ` +
          `Leidžiami tik sveikieji skaičiai nuo 1 iki ${VERSIJOS_LUBOS} ` +
          "(arba lauko nebuvimas legacy įrašuose)."
      );
    }
  }

  const out = { ...job };
  for (const laukas of KANONINIAI_LAUKAI) {
    if (laukas in out) out[laukas] = normalizeFieldValue(laukas, out[laukas]);
  }

  /**
   * ⚠️ VIENINTELĖ SĄMONINGA IŠIMTIS IŠ „LIEČIAMI TIK ESAMI RAKTAI" (#184, 7.5b).
   *
   * `version` MATERIALIZUOJAMA, nes priešingu atveju atkūrimo kelias išskirtų
   * backend'us: `postgresStore.rowToJob()` senai eilutei duoda `?? 1` (stulpelis
   * `NOT NULL DEFAULT 1`), o memory ir Redis atkurtų kopijos įrašą BE lauko.
   * Kontrakto rinkinys tokį skirtumą pagautų kaip formos neatitikimą - ir teisingai.
   *
   * Skirtumas nuo `deletion_*` atvejo, kurį komentaras aukščiau draudžia, yra
   * esminis: `deletion_*` laukų `newJob()` NEMATERIALIZUOJA, tad jų buvimas ar
   * nebuvimas yra reikšmingas faktas. `version` `newJob()` materializuoja visada,
   * tad jo NEBUVIMAS reiškia tik viena - įrašas senesnis už 7.5b.
   */
  if (out.version === undefined || out.version === null) out.version = 1;

  return out;
}

/**
 * ⚠️ TYPED DEFAULTS INVARIANTAS (#205, 7.2c) — SKAITYTI PRIEŠ PRIDEDANT LAUKĄ.
 *
 * Kanoninis boolean laukas čia PRIVALO gauti `false`, skaitinis - `0`. Niekada
 * `null` ar `undefined`: `typeof null === "object"`, tad sargas
 * (`tests/jobStoreTypeNormalization.test.js`) tokio lauko tipo neatpažintų, jis
 * tyliai iškristų iš `BOOLEAN_FIELDS`/`NUMBER_FIELDS` ir normalizavimo negautų -
 * t. y. grįžtų būtent tas gedimas, kurį 7.2c uždaro.
 *
 * Jei kada nors prireiks nullable typed lauko, jo tipas deklaruojamas
 * kanoniniame kontrakte EKSPLICITIŠKAI ir sargas praplečiamas. Tyliai iškristi
 * iš tikrinimo jis negali.
 */
function newJob(fields = {}) {
  const now = new Date().toISOString();
  return normalizeJob({
    id: crypto.randomUUID(),
    /**
     * ĮRAŠO ERA (#158) – nulemia, kaip `utils/jobAuthorization.js` sprendžia
     * aktoriaus tapatybę. Repo turi TRIS eras, ne dvi:
     *
     *   nėra + actorSource nėra    → #17: NO_ACTOR passthrough
     *   nėra + actorSource=session → #18: legacy username lookup
     *   2    + actorSource=session → #158: ID lookup pagal userId
     *
     * ERA, o ne `actor` eilutės forma: vardo šablonas įleidžia UUID formos
     * vardą, o API rakto aktorius (`key_<hex>`) irgi nėra UUID – forma negali
     * nulemti lookup kelio.
     *
     * IMMUTABLE: `applyPatch()` šio lauko nekeičia. Era yra faktas apie tai,
     * kaip įrašas buvo SUKURTAS; jos perrašymas reikštų, kad seno įrašo
     * `actor` (username) staiga būtų aiškinamas kaip `userId`.
     */
    /**
     * ⚠️ ERA NEPRIKLAUSO NUO KVIETĖJO. `fields.schemaVersion` SĄMONINGAI
     * ignoruojamas: `create()` neturi galimybės pagaminti legacy (`null`) ar
     * nežinomos (`3`, `"x"`) eros įrašo, kurį autorizacija vėliau atmestų arba
     * interpretuotų kaip senovinį.
     *
     * Eilutės atvaizdo normalizavimas (`"2"` → `2`) reikalingas ATKŪRIMO
     * kelyje, ne čia - žr. `normalizeSchemaVersion()`.
     */
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // Jobo TIPAS. Abu async endpoint'ai (transkripcija ir protokolas) naudoja TĄ
    // PATĮ jobStore, tad be tipo DELETE /api/transcribe-jobs/:id priimdavo ir
    // protokolo jobo ID: įrašas būdavo surandamas ir ištrinamas, o valymo kodas
    // ieškodavo NE TOJE BullMQ eilėje - duomenys likdavo, klientas gaudavo 204.
    type: fields.type || "transcription",
    // Bendro audio storage raktas. Saugomas, kol failas TIKRAI ištrintas (tada
    // nustatomas į null) - kad GDPR ištrynimas surastų likutį ir INLINE režime,
    // kur BullMQ jobo (ir jo payload'o su storageKey) apskritai nėra.
    storageKey: fields.storageKey || null,
    /**
     * KORELIACIJA (GDPR #17). Užklausos ID ir aktoriaus atspaudas keliauja su
     * jobu, kad worker'io logai ir audito įrašai būtų susiejami su HTTP
     * užklausa, kuri jį sukūrė. Tai IDENTIFIKATORIAI, ne turinys - jokio
     * transkripcijos, IP ar antraščių pėdsako čia nėra.
     */
    requestId: fields.requestId || null,
    /**
     * FAZĖ IR PROGRESAS (#154).
     *
     * `phase` prasminga tik kai `status = processing`; kitais atvejais `null`.
     * `progressKnown` yra ATSKIRAS laukas, ne `phase` išvestinė – šiandien
     * pyannote progreso neteikia, bet kitas diarizacijos provideris ateityje
     * gali.
     *
     * ⚠️ Šių laukų NEKEISTI tiesiogiai per `update()`. Perėjimus valdo
     * `utils/jobPhase.js`, o store juos siūlo per `startPhase`, `reportProgress`
     * ir `finish`. Neapdorotas patch'as apeitų `status × phase` invariantą.
     */
    /**
     * ⚠️ `fields` ČIA NENAUDOJAMI SĄMONINGAI.
     *
     * Priimant `fields.phase` būtų galima sukurti `queued + phase=transcribing`
     * – derinį, kurį `startPhase()` draudžia. Tai būtų antras writer'io
     * apėjimas, šįkart per `create()`, ne per `update()`.
     *
     * Naujas job'as fazės būseną gauna TIK iš kontrakto pradžios. Perėjimus
     * valdo `utils/jobPhase.js`.
     *
     * (`restoreRecord()` legacy įrašams eina kitu keliu ir čia nepatenka.)
     */
    phase: null,
    progress: null,
    progressKnown: false,
    /**
     * DUOMENŲ NUOSAVYBĖ (#159).
     *
     * ⚠️ `ownerId` IR `actor` NĖRA TAS PATS, net kai reikšmė sutampa.
     * `actor` yra VYKDYTOJO tapatybė (kas paleido darbą - naudojama rolei
     * perskaičiuoti vykdymo metu). `ownerId` yra DUOMENŲ nuosavybė (kieno tai
     * įrašas - naudojama prieigai riboti). Jie sutampa kūrimo metu, bet
     * semantika skiriasi, todėl laukai atskiri ir nesujungiami.
     *
     * `null` reiškia „savininko nėra". Ši reikšmė SUTINKAMA trimis būsenomis,
     * bet naujas `create()` leidžia tik dvi iš jų:
     *
     *   1. desktop / no-auth (`UNOWNED`)   – kuriama;
     *   2. bendras `API_KEY` (`API_KEY`)   – kuriama;
     *   3. legacy įrašai iš prieš #159     – NEKURIAMI, tik atkuriami
     *      (`restoreRecord()` arba seni įrašai saugykloje).
     *
     * Trečiojo `create()` sąmoningai NEPRIIMA (`assertOwnerIdentity`):
     * dabartinis writer'is neturi mokėti rašyti senos eros formato, nes toks
     * įrašas būtų nepasiekiamas savo savininkui, o klaida – tyli.
     *
     * Antrasis yra SĄMONINGAS sprendimas, ne praleidimas: bendras `API_KEY`
     * pagal apibrėžimą nėra individo tapatybė (jį gali turėti keli žmonės ar
     * servisai), todėl priskirti jam „savininką" reikštų išgalvoti tapatybę,
     * kurios nėra. `actor` tokiam job'ui yra rakto atspaudas (`key_<hex>`) -
     * to pakanka auditui, bet ne nuosavybei.
     *
     * `null` NEreiškia „prieinama visiems" - `matchesOwner()` reikalauja, kad
     * sutaptų IR `ownerKind`. Ar bendro rakto turėtojas turi pasiekti `null`
     * savininko job'us, yra transporto lygio politikos klausimas (#160), ne
     * duomenų sluoksnio.
     */
    ownerId: fields.ownerId ?? null,
    /**
     * NUOSAVYBĖS RŪŠIS (#159) – kad `null` nustotų reikšti TRIS skirtingus dalykus.
     *
     * Be šio lauko `normalizeOwnerId()` suvienodina desktop, legacy ir bendro
     * `API_KEY` job'us į vieną `""` reikšmę – ir bendro rakto turėtojas tampa
     * legacy bei desktop job'ų „savininku". Tai ne teorinė spraga: maršrutai
     * API rakto kelyje perduoda būtent `ownerId: null`.
     *
     *   OWNER_KIND.USER    – sesijos vartotojas; `ownerId` yra stabilus UUID
     *   OWNER_KIND.API_PRINCIPAL – bendras raktas; `ownerId` NĖRA (raktas nėra individas)
     *   OWNER_KIND.UNOWNED – desktop / no-auth; autentifikacijos apskritai nėra
     *   `null` (laukas nesantis) – LEGACY įrašas iš prieš #159; `create()`
     *                                jo NEPRIIMA, tik `restoreRecord()`
     *
     * Legacy įrašai NEPRIKLAUSO niekam iš vartotojo lygio iškviečiančiųjų –
     * jie natūraliai išnyksta per TTL/retenciją. Ar juos gali pasiekti admin,
     * yra transporto politikos klausimas (#160).
     */
    ownerKind: fields.ownerKind ?? null,
    /** Paruošta multi-tenancy etapui; kol kas visada `null`. */
    tenantId: fields.tenantId ?? null,
    /**
     * IDEMPOTENCY RAKTAS (#155, 7.2a).
     *
     * Bendro kontrakto laukas, ne PostgreSQL detalė: unikalumą užtikrina DB
     * dalinis indeksas `(tenant_id, idempotency_key)`, bet lauko privalo turėti
     * VISI backend'ai — kitaip `postgresStore` skaitytų `job.idempotencyKey`,
     * kurio `newJob()` nematerializuoja, ir indeksas liktų dekoracija: kiekvienas
     * `INSERT` siųstų `NULL`, o dalinis indeksas `NULL` eilučių neapima.
     *
     * Šiandien nė vienas kviečiantysis jo neperduoda — laukas paruoštas, bet
     * neaktyvus. Unikalumo garantija tikrinama 7.2a integraciniame teste.
     */
    idempotencyKey: fields.idempotencyKey ?? null,
    actor: fields.actor || null,
    /**
     * AKTORIAUS ROLĖ IR ŠALTINIS (#18 PR3).
     *
     * ⚠️ `actorRole` NĖRA AUTORITETINGAS. Tai ISTORINIS įrašas – „kokia rolė
     * buvo kūrimo metu" – skirtas auditui ir diagnostikai, NE sprendimui, ar
     * leidžiama vykdyti.
     *
     * Autorizacija VISADA perskaičiuoja dabartinę rolę iš kredencialų
     * saugyklos (`utils/jobAuthorization.js resolveCurrentRole`). Jei kas nors
     * kada nors ims spręsti pagal šį lauką, revokacija nustos veikti eilėje
     * laukiantiems darbams – tyliai, ir be jokio klaidos pranešimo.
     *
     * Saugoma TIK tai, ko reikia autorizacijai ATKURTI: nekintamas aktoriaus
     * ID (`actor`), rolės nuotrauka ir mechanizmas, kuriuo jis buvo
     * autentifikuotas.
     *
     * KAS ČIA NEPATENKA IR KODĖL: jokių bearer tokenų, sesijos ID, cookie ar
     * slaptažodžių. Jobas gyvena Redis'e, BullMQ eilėse ir logų kontekste –
     * paslaptis ten išgyventų kur kas ilgiau nei pati užklausa, o revokacija
     * jos nepasiektų.
     */
    actorRole: fields.actorRole || null,
    actorSource: fields.actorSource || null,

    /**
     * ARTEFAKTŲ INVENTORIUS (#19 PR1).
     *
     * Mašininiu būdu skaitomas sąrašas: tipas, savininkas, šaltinis, gyvavimo
     * ciklo būsena, retencijos terminas ir ištrynimo būklė.
     *
     * KODĖL JOBO ĮRAŠE, o ne atskiroje saugykloje: koreliacija tampa
     * automatinė – artefaktas negali tapti našlaičiu, nes gyvena kartu su tuo,
     * kam priklauso. Atskira lentelė reikštų dvi saugyklas, kurios gali
     * išsiskirti būtent tada, kai to labiausiai nenorim (dalinis ištrynimas).
     *
     * Formatas aprašytas `utils/artefactInventory.js`.
     */
    artefacts: fields.artefacts || [],
    // Techninis audio valymas nepavyko - laukiama pakartojimo. SĄMONINGAI
    // ATSKIRTA nuo `deletion_pending`: ta vėliava reiškia VARTOTOJO prašytą
    // viso jobo ištrynimą, o ši - tik nebereikalingo audio pašalinimą, kai
    // transkripcijos rezultatas dar turi likti prieinamas.
    audio_cleanup_pending: false,
    audio_cleanup_attempts: 0,
    status: STATUS.QUEUED,
    result: null,
    // `progress` deklaruojamas aukščiau kartu su `phase` ir `progressKnown` –
    // trys #154 kontrakto laukai laikomi vienoje vietoje.
    // Struktūrizuota klaida.
    error: null, // atgalinis suderinamumas (senas laukas) - lieka kaip error_message kopija
    error_code: null,
    error_message: null,
    // Retry / gyvavimo ciklas.
    attempt_count: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    /**
     * OPTIMISTIC LOCK VERSIJA (#184, 7.5b). Pradinė reikšmė - `1`, ta pati
     * visuose trijuose backend'uose ir ta pati, kurią migracija duoda esamoms
     * eilutėms (`DEFAULT 1`). Didinama TIK `applyPatch()` - žr. ten.
     */
    version: 1,
    // Atgalinis suderinamumas su senais laukais (routes/frontend jų tikisi).
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Normalizuoja `update` patch'ą: kai nustatomas status, automatiškai užpildo
 * atitinkamus laiko laukus ir sinchronizuoja senus/naujus klaidos laukus. Tai
 * daroma VIENOJE vietoje, kad abu backend'ai elgtųsi identiškai.
 */
/**
 * KANONINĖ `ownerId` REIKŠMĖ palyginimui (#159).
 *
 * Redis `null` saugo kaip tuščią string'ą, o objektuose atmintyje tai `null`
 * arba `undefined`. Be vienos kanoninės formos palyginimas remtųsi Redis
 * trūkstamo lauko ir Lua `nil` niuansais, ir desktop režimo `null` savininkas
 * nesutaptų pats su savimi.
 *
 * `""` = „savininko nėra". Tai NĖRA wildcard: `""` sutampa tik su `""`.
 */
function normalizeOwnerId(value) {
  return value == null ? "" : String(value);
}

/**
 * Ar `job` priklauso `expectedOwnerId`?
 *
 * Griežtas lygumas po normalizavimo - jokio „null praleidžia viską". Desktop
 * režime abi pusės yra `""` ir sutampa; ten, kur auth įjungtas, `""` job'as
 * nesutaps su UUID ir atvirkščiai.
 */
/** Nuosavybės rūšys – žr. `newJob().ownerKind`. */
const OWNER_KIND = Object.freeze({
  USER: "user",
  /**
   * Bendro `API_KEY` principalas.
   *
   * SAVYBĖS pavadinimas yra `API_PRINCIPAL`, ne `API_KEY`, dėl dviejų priežasčių:
   *
   * 1. TIKSLUMAS. Konstanta aprašo nuosavybės RŪŠĮ – kas yra job'o savininkas –
   *    o ne kredencialą. „Owner kind = API key" konceptualiai neteisinga:
   *    savininkas yra principalas, kuriam raktas priklauso.
   * 2. CodeQL `js/clear-text-logging` laiko `*KEY*` identifikatorius jautriais
   *    ir pažymi bet kokį jų kelią į logerį. Ši konstanta jokios paslapties
   *    neturi, bet klaidingas įspėjimas krito CI du kartus.
   *
   * REIKŠMĖ (`"api-key"`) NEKEIČIAMA: ji jau saugoma Redis'e job įrašuose, tad
   * pakeitimas būtų duomenų migracija be jokios naudos.
   */
  API_PRINCIPAL: "api-key",
  UNOWNED: "unowned",
});

const OWNER_KIND_VALUES = new Set(Object.values(OWNER_KIND));

/**
 * PRINCIPALO INVARIANTAS – vienas šaltinis rašymui IR skaitymui (#159).
 *
 * Galiojantys deriniai:
 *
 *   USER    + ne-null ownerId   (vartotojas su stabiliu UUID)
 *   API_KEY + null              (bendras raktas nėra individas)
 *   UNOWNED + null              (desktop / no-auth)
 *
 * KODĖL BENDRA FUNKCIJA. Iš pradžių derinys buvo tikrinamas tik `create()`
 * metu, o `assertScope()` tikrino vien enum. Tai neduodavo authorization
 * bypass – `matchesOwner()` vis tiek reikalauja sutapti abiem dimensijoms,
 * tad neteisingas scope duotų `FORBIDDEN`. Bet dvi atskiros taisyklės tose
 * pačiose būsenose ilgainiui išsiskiria, ir neįmanoma būsena, kurios negalima
 * ĮRAŠYTI, vis tiek būtų priimama kaip iškviečiančiojo TAPATYBĖ.
 *
 * @param {{ownerId: string|null, ownerKind: string}} identity
 * @param {string} context – kur klaida įvyko (`jobStore.create()` ir pan.)
 */
function assertOwnerIdentity(identity, context) {
  const kind = identity ? identity.ownerKind : undefined;

  if (!OWNER_KIND_VALUES.has(kind)) {
    throw new TypeError(
      `${context}: ownerKind privalo būti viena iš: ` +
        `${[...OWNER_KIND_VALUES].join(", ")}. Gauta: ${String(kind)}.`
    );
  }

  const hasId = identity.ownerId != null && identity.ownerId !== "";

  if (kind === OWNER_KIND.USER && !hasId) {
    throw new TypeError(
      `${context}: ownerKind="user" reikalauja ownerId. ` +
        "Vartotojas be stabilaus ID nėra tapatybė (žr. #158)."
    );
  }
  if (kind !== OWNER_KIND.USER && hasId) {
    throw new TypeError(
      `${context}: ownerKind="${kind}" negali turėti ownerId. ` +
        "Bendras raktas ir desktop režimas nėra individo tapatybė."
    );
  }
}

/**
 * Ar `job` priklauso iškviečiančiajam?
 *
 * REIKALAUJA SUTAPTI ABIEJŲ: rūšies IR identifikatoriaus.
 *
 * `ownerId` vienas nepakanka: `null` yra teisėtas trims skirtingoms būsenoms
 * (desktop, bendras raktas, legacy), ir vien pagal jį bendro rakto turėtojas
 * taptų legacy bei desktop job'ų savininku. `ownerId = null` NĖRA įrodymas,
 * kad autentifikuotas principalas yra savininkas.
 *
 * Legacy įrašai (`ownerKind = null`) nesutampa su NĖ VIENA vartotojo lygio
 * rūšimi – fail-closed. Sisteminiam keliui nuosavybė netaikoma iš viso.
 *
 * @param {object} job
 * @param {{ownerId: string|null, ownerKind: string}} scope
 */
function matchesOwner(job, scope) {
  if (!job) return false;

  const kind = scope && typeof scope === "object" ? scope.ownerKind : undefined;
  const id = scope && typeof scope === "object" ? scope.ownerId : undefined;

  // Legacy įrašas arba nežinoma rūšis – nesutampa su niekuo iš vartotojo pusės.
  if (!job.ownerKind || !kind) return false;
  if (job.ownerKind !== kind) return false;

  return normalizeOwnerId(job.ownerId) === normalizeOwnerId(id);
}

function applyPatch(job, patch) {
  const now = new Date().toISOString();
  const next = { ...job, ...patch, updatedAt: now };

  /**
   * ERA IR ID YRA NEKEIČIAMI (#158).
   *
   * Patch'as ateina iš worker'ių ir maršrutų; netyčinis `schemaVersion`
   * perrašymas pakeistų, kaip aiškinamas `actor` laukas – legacy įrašo
   * username imtų atrodyti kaip userId. Grąžinama pradinė reikšmė, o ne
   * metama klaida: patch'ai formuojami daug kur, ir tylus atsparumas čia
   * saugesnis nei srauto nutraukimas.
   */
  next.id = job.id;
  /**
   * NUOSAVYBĖ NEKEIČIAMA PER PATCH'Ą (#159).
   *
   * Patch'ai formuojami dešimtyse vietų (worker'iai, retencija, maršrutai).
   * Jei `ownerId` būtų keičiamas kaip bet kuris laukas, vienas neatsargus
   * patch'as tyliai perduotų job'ą kitam savininkui - ir nuosavybės filtras
   * taptų beprasmis. Nuosavybė nustatoma TIK `create()` metu.
   */
  if ("ownerId" in job) next.ownerId = job.ownerId;
  if ("ownerKind" in job) next.ownerKind = job.ownerKind;
  if ("schemaVersion" in job) {
    next.schemaVersion = job.schemaVersion;
  } else {
    delete next.schemaVersion;
  }

  /**
   * OPTIMISTIC LOCK VERSIJOS INCREMENT'AS (#184, 7.5b).
   *
   * ⚠️ ČIA, IR TIK ČIA. `applyPatch()` jau yra bendras SEPTYNIŲ mutacijos kelių
   * taškas (žr. normalizavimo komentarą žemiau), tad `+1` čia reiškia, kad nė
   * vienas backend'as savo skaičiavimo neturi. Trys realizacijos neišvengiamai
   * išsiskirtų būtent ten, kur skirtumo niekas netikrina.
   *
   * ⚠️ IŠ TO SEKA VIENAS INCREMENT'AS `startPhase`/`finish` PORAI.
   *
   * Abu fasado metodai yra `get` + VIENAS `store.update()`, tad vienas
   * `applyPatch()` ir vienas `+1`. Du increment'ai atsirastų tik iš dviejų
   * `update()` kvietimų - o tai matoma diff'e, ne paslėpta skaičiavimo detalė.
   * Garantija yra KONSTRUKCIJOS, ne budrumo.
   *
   * ⚠️ PATCH'AS VERSIJOS NEKEIČIA - kaip `id`, nuosavybė ir era. Kvietėjas,
   * atsiuntęs `{ version: 99 }`, gauna `job.version + 1`. Versija yra saugyklos
   * faktas apie mutacijų skaičių, ne kvietėjo duomuo.
   *
   * ⚠️ NEPAVYKĘS CAS ČIA NEPATENKA. `applyPatch()` skaičiuoja reikšmę, kurią
   * saugykla dar TIK bandys įrašyti; jei sąlyginis `UPDATE` paliečia 0 eilučių,
   * persistentinė `version` lieka nepakitusi.
   */
  next.version = (job.version ?? 0) + 1;

  /**
   * NUOMA IR KŪRIMO KETINIMAS NEKEIČIAMI (#155).
   *
   * ⚠️ BE ŠIŲ EILUČIŲ BACKEND'AI IŠSISKIRIA. `postgresStore` juos išbraukia iš
   * `UPDATE ... SET` (`IMMUTABLE_COLUMNS`), tad DB pasilieka senas reikšmes ir
   * `get()` grąžina jas. Memory ir Redis remiasi TIK šiuo helperiu, tad tas
   * pats patch'as ten reikšmę pakeistų - stebimas elgesys skirtųsi
   * priklausomai nuo backend'o.
   *
   * `tenantId` yra izoliacijos riba (būsimai multi-tenancy), o
   * `idempotencyKey` identifikuoja KŪRIMO ketinimą: leidus jį keisti, du
   * skirtingi ketinimai galėtų susilieti arba vienas atsilaisvintų
   * pakartotiniam naudojimui.
   */
  if ("tenantId" in job) next.tenantId = job.tenantId;
  if ("idempotencyKey" in job) next.idempotencyKey = job.idempotencyKey;

  /**
   * SUKŪRIMO LAIKAS NEKEIČIAMAS. Ta pati priežastis: `postgresStore` jį
   * išbraukia iš `SET`, tad patch'as ten neturėtų poveikio, o memory/Redis
   * jį pakeistų. Nė vienas produkcinis kelias `created_at` per patch'ą
   * nesiunčia - riba įvedama, kol nekainuoja.
   */
  if ("created_at" in job) next.created_at = job.created_at;
  if ("createdAt" in job) next.createdAt = job.createdAt;

  // Laiko žymos pagal status perėjimą.
  if (patch.status === STATUS.PROCESSING && !job.started_at) {
    next.started_at = now;
  }
  if (
    (patch.status === STATUS.COMPLETED ||
      patch.status === STATUS.FAILED ||
      patch.status === STATUS.CANCELLED) &&
    !job.completed_at
  ) {
    next.completed_at = now;
  }

  // Klaidos laukų sinchronizacija (senas `error` <-> naujas `error_message`).
  if (patch.error !== undefined && patch.error_message === undefined) {
    next.error_message = patch.error;
  }
  if (patch.error_message !== undefined && patch.error === undefined) {
    next.error = patch.error_message;
  }

  /**
   * ⚠️ AUTORITETINGAS RAŠYMO KELIO NORMALIZAVIMO TAŠKAS (#205, 7.2c).
   *
   * ČIA, o ne kiekviename `update()`: `applyPatch()` yra bendras septynių
   * mutacijos kelių taškas - `memoryStore` (`update`, `updateOwned`,
   * `reportProgressAtomicSync`), `redisStore` (`update`, `updateOwned`) ir
   * `postgresStore` (`writePatched` bei du sąlyginiai CAS keliai). Taisant
   * kiekvieną atskirai liktų penki neapsaugoti.
   *
   * ⚠️ NORMALIZUOJAMA PRIEŠ backend'ui gaunant objektą, tad `update()`
   * TIESIOGINIS grąžinimas jau kanoninis - dar prieš Redis serialize/deserialize
   * round-trip. Vien `get()` tikrinantis testas šito neįrodytų: Redis skaitymo
   * kelias paslėptų rašymo kelio regresiją.
   */
  return normalizeJob(next);
}

/**
 * KANONINĖ REZULTATO REPREZENTACIJA — VIENAS LYGYBĖS AUTORITETAS (#184, 7.5b).
 *
 * ⚠️ KODĖL BE ŠITO IDEMPOTENTIŠKUMAS BŪTŲ BACKEND-PRIKLAUSOMAS.
 *
 * `job_results.payload` yra `jsonb`. PostgreSQL `jsonb` NESAUGO raktų tvarkos,
 * šalina raktų dublikatus ir normalizuoja skaičius. Vadinasi tas pats
 * rezultatas, įrašytas ir perskaitytas atgal, JS objektų palyginime
 * (`JSON.stringify` ar `deepEqual` su kitokia raktų tvarka) atrodytų KITAS —
 * PostgreSQL kelyje pakartotinis `finish(COMPLETED)` visada skelbtų konfliktą,
 * o memory kelyje veiktų. Tai ne kraštinis atvejis: raktų tvarką lemia tai,
 * kaip objektas buvo sukonstruotas.
 *
 * ⚠️ MASYVŲ TVARKA NEKEIČIAMA. Ji yra SEMANTIKA: transkripcijos segmentų ar
 * kalbėtojų eilė nėra aibė. Rūšiuojant masyvus, du skirtingi rezultatai taptų
 * „tuo pačiu" ir antrasis vykdytojas tyliai priimtų svetimą darbą kaip savo.
 *
 * ⚠️ TAI NĖRA `backupEncryption._canonicalContents()` AR `evaluationManifest`.
 * Tie kanonizavimai tarnauja AES-GCM AAD susiejimui ir manifesto hash ID.
 * Pernaudojus juos čia, kriptografinis AAD taptų priklausomas nuo job lygybės
 * taisyklės — ir jos pakeitimas ateityje sulaužytų iššifravimą.
 *
 * ⚠️ HASH-ONLY LYGYBĖS ČIA NĖRA. Kelių valandų transkripcijos palyginimo kaina
 * yra realus klausimas, bet optimizacija atskiriama nuo teisingumo: hash
 * lygybė reikalautų įrodytos collision-safe verifikavimo semantikos.
 *
 * @param {*} reiksme
 * @returns {string} stabili eilutė palyginimui
 */
function kanoninisRezultatas(reiksme) {
  return JSON.stringify(kanonizuoti(reiksme));
}

/** Ar rezultato APSKRITAI nėra? `null` ir `undefined` — ta pati būsena. */
function rezultatoNera(reiksme) {
  return reiksme === undefined || reiksme === null;
}

function kanonizuoti(reiksme) {
  if (reiksme === null || typeof reiksme !== "object") {
    /**
     * ⚠️ `undefined` PAVERČIAMAS `null`. `JSON.stringify(undefined)` grąžina
     * `undefined` (ne eilutę), tad be šito palyginimas lygintų `undefined` su
     * `undefined` ir mestų klaidą pirmame `.length` kvietime.
     */
    return reiksme === undefined ? null : reiksme;
  }
  if (Array.isArray(reiksme)) return reiksme.map(kanonizuoti);

  const out = {};
  for (const raktas of Object.keys(reiksme).sort()) {
    /**
     * ⚠️ `undefined` REIKŠMĖS LAUKAI PRALEIDŽIAMI. `jsonb` jų neturi
     * (`JSON.stringify` juos išmeta), tad palikti juos čia reikštų, kad
     * įrašytas ir perskaitytas objektas skiriasi nuo įrašomo.
     */
    if (reiksme[raktas] === undefined) continue;
    out[raktas] = kanonizuoti(reiksme[raktas]);
  }
  return out;
}

/**
 * BENDRA IDEMPOTENTIŠKUMO TAISYKLĖ VISIEMS TRIMS BACKEND'AMS (#184, 7.5b).
 *
 * ⚠️ ANTROS LYGYBĖS TAISYKLĖS NĖRA. Trys saugyklos kviečia ŠITĄ funkciją, tad
 * „tas pats rezultatas" reiškia tą patį PostgreSQL, Redis ir atmintyje.
 *
 * @returns {undefined} sprendimo nėra - eiti įprastu perėjimo keliu
 */
function idempotentiskasAtsakymas(job, status, extra) {
  if (job.status !== STATUS.COMPLETED) return undefined;

  /**
   * ⚠️ `COMPLETED` BE REZULTATO NĖRA SĖKMĖ.
   *
   * Tai remontuotina būsena (nutrūkusi transakcija, ranka redaguota eilutė), ir
   * ji privalo būti ATSKIRIAMA nuo „tas pats rezultatas". Kvietėjo veiksmas
   * skiriasi iš esmės: audio šalinti NEGALIMA, nes rezultato, dėl kurio jis
   * nebereikalingas, saugykloje nėra.
   */
  if (rezultatoNera(job.result)) return "COMPLETED_WITHOUT_RESULT";

  /**
   * ⚠️ NEATITINKANTIS STATUSAS PALIEKAMAS `jobPhase`. `finish(FAILED)` ant
   * `completed` job'o yra gyvavimo ciklo klausimas, ne rezultato — atsakymas
   * privalo likti `JobPhaseError`, ne `RESULT_CONFLICT`.
   */
  if (status !== STATUS.COMPLETED) return undefined;

  return kanoninisRezultatas(extra.result) === kanoninisRezultatas(job.result)
    ? job
    : "RESULT_CONFLICT";
}

const JOB_TYPES = { TRANSCRIPTION: "transcription", PROTOCOL: "protocol" };

/**
 * Ar jobo dar NEGALIMA išmesti pagal TTL? Kol yra nebaigtas valymas, jobStore
 * įrašas yra VIENINTELIS šaltinis, iš kurio žinomas `storageKey` (BullMQ jobas
 * gali būti jau pašalintas). Išmetus jį per TTL, likęs audio failas taptų
 * nebeatsekamas.
 */
function hasPendingCleanup(job) {
  return Boolean(job && (job.audio_cleanup_pending || job.deletion_pending));
}

function isFinished(status) {
  return status === STATUS.COMPLETED || status === STATUS.FAILED || status === STATUS.CANCELLED;
}

module.exports = {
  normalizeSchemaVersion,
  BOOLEAN_FIELDS,
  NUMBER_FIELDS,
  kanoninisRezultatas,
  rezultatoNera,
  idempotentiskasAtsakymas,
  KANONINIAI_LAUKAI,
  normalizeFieldValue,
  normalizeJob,
  CURRENT_SCHEMA_VERSION,
  STATUS,
  JOB_TYPES,
  TTL_MS,
  newJob,
  applyPatch,
  isFinished,
  hasPendingCleanup,
  normalizeOwnerId,
  matchesOwner,
  assertOwnerIdentity,
  OWNER_KIND,
};
