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
function newJob(fields = {}) {
  const now = new Date().toISOString();
  return {
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
    schemaVersion: 2,
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
    // Atgalinis suderinamumas su senais laukais (routes/frontend jų tikisi).
    createdAt: now,
    updatedAt: now,
  };
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

  return next;
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
