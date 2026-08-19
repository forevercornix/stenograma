/**
 * JOB ATSAKYMO SERIALIZATORIUS (#154).
 *
 * KODĖL BENDRAS. `GET /api/jobs/:id` ir `GET /api/transcribe-jobs/:id` iki šiol
 * atsakymą sudarė RANKINIU BŪDU, laukas po lauko – ir jau buvo išsiskyrę:
 * transkribavimo endpoint'as grąžindavo `progress`, protokolo – ne. Pridedant
 * `phase` tai būtų kartojęsi.
 *
 * Klientas negali priklausyti nuo to, kurį endpoint'ą kviečia: fazių ir
 * progreso kontraktas yra vienas (#154).
 *
 * ⚠️ ALLOWLIST, ne `{ ...job }`. Job įrašas turi vidinių laukų (`actor`,
 * `actorSource`, `ownerId`, `storageKey`, `schemaVersion`, `tenantId`), kurių
 * klientui matyti nereikia ir kurie yra tapatybės arba saugyklos detalės.
 * Naujas laukas įraše NEPATENKA į atsakymą savaime – tai sąmoningas
 * sprendimas, ne praleidimas.
 */

const { STATUS } = require("./jobStore/common");

/**
 * Fazės ir progreso dalis.
 *
 * `phase` prasminga TIK kai `status = processing`; kitais atvejais `null`
 * (#154, 1 punktas). Store tą invariantą jau užtikrina, bet serializatorius
 * jo nekartoja iš naujo – jis tiesiog perduoda tai, kas įraše.
 *
 * `progressKnown` yra ATSKIRAS laukas, ne `phase` išvestinė: UI remiasi juo,
 * ne heuristika „diarizacija progreso neteikia".
 */
function phaseFields(job) {
  return {
    phase: job.phase ?? null,
    // `progress` ir `progressKnown` – iš vienos vietos, žr. `progressFields()`.
    ...progressFields(job),
  };
}

/**
 * `progress` API riboje PRIVALO būti `{current, total}` arba `null`.
 *
 * ⚠️ LEGACY ĮRAŠAI NEŠA SKAIČIŲ. Iki #154 `queues/processors.js` rašė
 * `progress: percent` – neapdorotą procentą. Toks job'as, atkurtas iš Redis ar
 * atsarginės kopijos, per serializatorių praeidavo NEPAKEISTAS, ir klientas
 * gaudavo `progress: 42` su `progressKnown: false` – būseną, kurios nėra nei
 * deklaruotame tipe, nei `progressKnown=false → progress=null` invariante.
 *
 * Skaičius NEVERČIAMAS į `{current, total}`: nežinome, koks buvo `total`, o
 * spėti reikštų išgalvoti duomenis. Legacy reikšmė normalizuojama į `null` –
 * tai teisingas atsakymas „progreso nežinome".
 *
 * ⚠️ Skirtingai nei `progressKnown`, čia NE fail-fast: legacy įrašas yra
 * laukiama realybė, ne programavimo klaida. Jis natūraliai išnyksta per TTL.
 */
/**
 * `progress` ir `progressKnown` skaičiuojami KARTU.
 *
 * ⚠️ Atskirai jie gali išsiskirti. Jei `progressKnown: true`, o `progress`
 * netinkamas (`{current: 2, total: 1}`), normalizavimas grąžindavo `null`, bet
 * gretimas laukas likdavo `true` – t. y. API emitavo BŪTENT tą uždraustą
 * `true + null` derinį, nuo kurio saugo invariantas.
 *
 * Vienas laukas negali būti teisingas be kito, tad ir skaičiuojami vienoje
 * vietoje.
 */
function progressFields(job) {
  const known = normalizeProgressKnown(job.progressKnown);
  const progress = normalizeProgress(job.progress, known);

  return {
    progress,
    // Atmetus progresą, „žinomas" nebegalioja.
    progressKnown: progress === null ? false : known,
  };
}

function normalizeProgress(reiksme, progressKnown) {
  if (reiksme == null) return null;

  /**
   * ⚠️ OBJEKTIŠKUMO NEPAKANKA.
   *
   * Ankstesnė versija priimdavo bet kokį ne-masyvą, tad pro API praeidavo
   * `{}`, `{current: 2, total: 1}` ir net galiojantis objektas su
   * `progressKnown: false` – pastarasis tiesiogiai pažeidžia deklaruotą
   * `false → null` invariantą.
   *
   * Tikrinamos TOS PAČIOS sąlygos, kurias vykdo state machine
   * (`PROGRESS_INVARIANTS`), tad API riba ir domenas negali išsiskirti.
   */
  const { PROGRESS_INVARIANTS } = require("./jobPhase");

  const galioja =
    typeof reiksme === "object" &&
    !Array.isArray(reiksme) &&
    PROGRESS_INVARIANTS.every(({ tikrinti }) => tikrinti(reiksme));

  if (!galioja) return null;

  /**
   * `progressKnown=false` reiškia „progresas nežinomas", tad rodyti reikšmę
   * būtų prieštaringa net jei ji pati galiojanti.
   */
  if (progressKnown !== true) return null;

  /**
   * ⚠️ GRĄŽINAMI TIK VIEŠI LAUKAI.
   *
   * Atkurtas ar būsimos schemos įrašas gali turėti papildomų metaduomenų
   * (`{current, total, secret}`), ir anksčiau objektas būdavo perduodamas
   * NEPAKEISTAS – tad pro abu job endpoint'us nutekėtų viskas, ką kas nors
   * kada nors į jį įdėjo.
   *
   * Tai ta pati allowlist taisyklė kaip `serializeJob()`: naujas laukas
   * viešu netampa savaime.
   */
  return { current: reiksme.current, total: reiksme.total };
}

/**
 * `progressKnown` API riboje PRIVALO būti boolean.
 *
 * ⚠️ FAIL-FAST, ne `Boolean(...)`. Redis viską grąžina kaip string'ą, o
 * `Boolean("false") === true` – tylus konvertavimas paverstų „progresas
 * nežinomas" į „žinomas" ir UI rodytų procentą ten, kur jo nėra. Tai būtų
 * blogiau nei klaida: neteisinga reikšmė atrodytų visiškai validi.
 *
 * `undefined` ir `null` yra teisėti: legacy įrašai (iš prieš #154) lauko
 * neturi, ir jiems `false` yra teisinga numatytoji reikšmė.
 *
 * Bet kokia kita ne-boolean reikšmė reiškia, kad store normalizacija
 * neveikia (pvz. laukas iškrito iš `BOOLEAN_FIELDS`) – tai programavimo
 * klaida, ne vartotojo įvestis.
 */
function normalizeProgressKnown(reiksme) {
  if (reiksme == null) return false;
  if (typeof reiksme === "boolean") return reiksme;

  throw new TypeError(
    `progressKnown privalo būti boolean, gauta ${typeof reiksme} (${JSON.stringify(reiksme)}). ` +
      "Tikėtina priežastis: laukas iškrito iš redisStore BOOLEAN_FIELDS."
  );
}

/**
 * Bendri laukai, kuriuos grąžina VISI job endpoint'ai.
 *
 * @param {object} job
 * @param {object} [extra] – endpoint'ui specifiniai laukai (pvz. `variant`)
 */
function serializeJob(job, extra = {}) {
  /**
   * ⚠️ `extra` NEGALI perrašyti kanoninių laukų.
   *
   * Su `...extra` gale endpoint'as galėtų (netyčia ar ne) perduoti
   * `{ status: "completed" }` ar `{ phase: null }` ir tyliai pakeisti state
   * machine rezultatą atsakyme. Šiandien vienintelis caller'is perduoda tik
   * `variant`, tad problema neišnaudojama – bet kontraktas ją leidžia, o
   * užrakinti pigiausia dabar, kol caller'is vienas.
   *
   * Konfliktas yra PROGRAMAVIMO KLAIDA, ne runtime situacija: endpoint'as
   * neturi turėti savo nuomonės apie `status` ar `phase`.
   */
  const konfliktai = Object.keys(extra).filter((k) => REZERVUOTI.has(k));
  if (konfliktai.length > 0) {
    throw new TypeError(
      `serializeJob(): extra negali perrašyti kanoninių laukų: ${konfliktai.join(", ")}.`
    );
  }

  return {
    ...extra,
    jobId: job.id,
    status: job.status,
    ...phaseFields(job),
    result: job.result ?? null,
    error: job.error ?? null,
    error_code: job.error_code ?? null,
    attempt_count: job.attempt_count ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
  };
}

/**
 * Kanoniniai laukai – jų `extra` perrašyti negali.
 *
 * Sąrašas turi ATITIKTI `serializeJob()` grąžinamus laukus – tai TIKRINAMA
 * testu (`jobPhaseApi`: „REZERVUOTI sąrašas SUTAMPA su realiais laukais"),
 * tad pamiršus jį papildyti CI praneš. Priminimas komentare būtų buvęs skola.
 */
const REZERVUOTI = new Set([
  "jobId",
  "status",
  "phase",
  "progress",
  "progressKnown",
  "result",
  "error",
  "error_code",
  "attempt_count",
  "createdAt",
  "updatedAt",
  "started_at",
  "completed_at",
]);

/**
 * Laukai, kurių klientui NIEKADA nerodome – naudojama sargo teste.
 *
 * ⚠️ Tai NĖRA apsauga: apsauga yra pati allowlist forma – `serializeJob()`
 * grąžina TIK išvardytus laukus, tad naujas įrašo laukas viešu netampa savaime.
 * Šis sąrašas tik leidžia testui patikrinti rezultatą. Jo neaktualumas
 * tikrinamas testu, kad nesikauptų pasenusių įrašų.
 */
const NEVIEŠI_LAUKAI = Object.freeze([
  "actor",
  "actorSource",
  "ownerId",
  "ownerKind",
  "tenantId",
  "storageKey",
  "schemaVersion",
  "requestId",
  "audio_cleanup_pending",
  "audio_cleanup_attempts",
  "deletion_pending",
  "deletion_attempts",
]);

module.exports = { serializeJob, phaseFields, REZERVUOTI, NEVIEŠI_LAUKAI, STATUS };
