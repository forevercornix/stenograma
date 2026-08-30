/**
 * IŠTRYNIMO ŽYMOS ATMINTYJE (#155, 7.5a / #183).
 *
 * ⚠️ TAS PATS KONTRAKTAS KAIP `postgresStore`, NE SUPAPRASTINTA VERSIJA.
 *
 * Skiriasi tik patvarumas. Visa kita - būsenų mašina, allowlist'ai, sąlyginiai
 * perėjimai, retencija tik `deleted` būsenai - privalo elgtis vienodai, kitaip
 * be `DATABASE_URL` paleisti testai tikrintų kitą sistemą nei ta, kuri veikia
 * produkcijoje. Paritetą tikrina bendras kontrakto rinkinys.
 *
 * ⚠️ ŠIS BACKEND'AS GARANTIJOS NEDUODA. Žymos neišgyvena restarto ir nėra
 * bendros replikoms - t. y. tiksliai tas apribojimas, kurį 7.5a šalina. Todėl
 * fasadas atmintiniame režime garsiai įspėja, o `docs/deletion-guarantees.md`
 * garantiją formuluoja SĄLYGINIAI.
 */

const {
  TOMBSTONE_STATUS,
  assertReason,
  assertActorKind,
  assertFailureKind,
  allowedSources,
} = require("./states");

/** jobId -> įrašas. Vienas procesas, viena kopija. */
const zymos = new Map();

function kopija(irasas) {
  return irasas ? { ...irasas } : null;
}

/**
 * Idempotentinis žymėjimas.
 *
 * ⚠️ ESAMAS ĮRAŠAS LAIMI - įskaitant `deleted`. Pakartotinis žymėjimas negali
 * nei pastumti `requestedAt` (jis atsako „kada paprašyta"), nei prikelti jau
 * patvirtinto ištrynimo atgal į `pending`. Postgres pusėje tą patį daro
 * `ON CONFLICT (job_id) DO NOTHING`, o NE `DO UPDATE`.
 */
async function mark(jobId, { reason, actorKind = null, now = Date.now() } = {}) {
  if (!jobId) return null;

  assertReason(reason);
  assertActorKind(actorKind);

  /**
   * ⚠️ `claimed` ATSAKO Į KLAUSIMĄ „AR AŠ ESU VYKDYTOJAS", NE „AR YRA ŽYMA".
   *
   * Be jo kvietėjas negali atskirti, ar žymą SUKŪRĖ jis, ar tik PAMATĖ svetimą -
   * abiem atvejais grąžinamas `deletion_pending` įrašas. Dvi replikos tada abi
   * pradėtų destruktyvų I/O tam pačiam jobui.
   *
   * Postgres pusėje tai `INSERT ... ON CONFLICT DO NOTHING RETURNING` rezultatas:
   * eilutė grąžinama TIK tam, kas įterpė. Atmintinis atitikmuo - ar rakto dar
   * nebuvo. Abu atvejai atominiai savo saugykloje.
   */
  const esamas = zymos.get(jobId);
  if (esamas) return { ...kopija(esamas), claimed: false };

  const irasas = {
    jobId,
    status: TOMBSTONE_STATUS.PENDING,
    reason,
    actorKind,
    /** DB stulpelis - `marked_at`; vardas paliktas dėl esamo rezultato kontrakto. */
    requestedAt: now,
    updatedAt: now,
    completedAt: null,
    attempts: 0,
    lastFailureKind: null,
  };

  zymos.set(jobId, irasas);
  return { ...kopija(irasas), claimed: true };
}

/**
 * SĄLYGINIS perėjimas: pavyksta tik tada, kai dabartinė būsena yra `from`.
 *
 * ⚠️ SIMETRIŠKA POSTGRES `UPDATE ... WHERE status = $from`. Grąžina `null`, kai
 * perėjimas neleidžiamas - kvietėjas tada perskaito autoritetingą būseną ir ją
 * grąžina, o NE perrašo.
 */
async function transition(jobId, to, options = {}) {
  return _perkelti(jobId, allowedSources(to), to, options);
}

/**
 * ⚠️ SĄMONINGAS LENTELĖS APĖJIMAS - TIK OPERATORIAUS IŠEIČIAI.
 *
 * `forceResolve` veda `deletion_failed → deleted`, ko įprasta mašina neleidžia:
 * ten retry privalo eiti per `pending`. Tai ne spraga, o dokumentuotas rankinis
 * sprendimas, kurį `erasureMarkService` fiksuoja auditu PO perėjimo, su
 * `success` pagal faktinį rezultatą (#183).
 *
 * Atskiras vardas, o ne argumentas: apėjimas privalo būti matomas kvietimo
 * vietoje ir peržiūroje, ne paslėptas parametre.
 */
async function transitionOverride(jobId, from, to, options = {}) {
  return _perkelti(jobId, from, to, options);
}

async function _perkelti(
  jobId,
  from,
  to,
  { completedAt = null, failureKind = null, actorKind = undefined, now = Date.now() } = {}
) {
  const irasas = zymos.get(jobId);
  if (!irasas) return null;
  if (!from.includes(irasas.status)) return null;

  /**
   * ⚠️ VISOS OPCIJOS VALIDUOJAMOS PRIEŠ LIEČIANT ĮRAŠĄ (#183 Codex, P2).
   *
   * Anksčiau `assertFailureKind` ir `assertActorKind` buvo kviečiami PO to, kai
   * `status`, `updatedAt`, `completedAt` ir `attempts` jau pakeisti. Neteisinga
   * reikšmė metė, kvietėjas matė atmestą operaciją be audito įrašo, o barjeras
   * VIS TIEK buvo perėjęs.
   *
   * PostgreSQL validuoja prieš `UPDATE`, tad tas pats įvedimas duodavo skirtingą
   * atomiškumą skirtinguose backend'uose - būtent tokį nukrypimą bendras
   * kontrakto rinkinys ir turi gaudyti.
   */
  const naujasFailureKind = to === TOMBSTONE_STATUS.FAILED ? assertFailureKind(failureKind) : null;
  const naujasActorKind = actorKind === undefined ? undefined : assertActorKind(actorKind);

  irasas.status = to;
  irasas.updatedAt = now;

  /**
   * `completed_at` ir būsena privalo sutapti - DB tai daro CHECK constraint'as
   * (`(status = 'deleted') = (completed_at IS NOT NULL)`), čia tą patį daro ši
   * eilutė. Nesėkmė NETURI ištrynimo laiko.
   */
  irasas.completedAt = to === TOMBSTONE_STATUS.DELETED ? completedAt || now : null;

  if (to === TOMBSTONE_STATUS.FAILED) {
    irasas.attempts += 1;
    irasas.lastFailureKind = naujasFailureKind;
  }

  if (to === TOMBSTONE_STATUS.PENDING) irasas.lastFailureKind = null;
  if (naujasActorKind !== undefined) irasas.actorKind = naujasActorKind;

  return kopija(irasas);
}

async function get(jobId) {
  if (!jobId) return null;
  return kopija(zymos.get(jobId));
}

/**
 * Neterminalės žymos pagal amžių - operatoriaus matomumo kelias.
 *
 * ⚠️ `deleted` ČIA NEPATENKA. Užstrigusi žyma yra `pending` arba `failed`;
 * terminalės sąraše tik trukdytų.
 */
async function listUnresolved({ olderThanMs = 0, limit = 100, now = Date.now() } = {}) {
  const riba = now - olderThanMs;

  return [...zymos.values()]
    .filter((z) => z.status !== TOMBSTONE_STATUS.DELETED && z.requestedAt <= riba)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .slice(0, limit)
    .map((z) => ({ ...kopija(z), ageMs: now - z.requestedAt }));
}

/**
 * Šalina TIK `deleted` žymas, senesnes už ribą.
 *
 * ⚠️ `pending` ir `failed` NESENSTA. Nesėkmingas ištrynimas reiškia, kad
 * jautrūs duomenys dar gali egzistuoti; žymos pašalinimas atidarytų barjerą
 * būtent tada, kai jis reikalingiausias.
 */
/**
 * Riba atmintyje - iš įleidžiamo `now`.
 *
 * ⚠️ SKIRTUMAS NUO POSTGRES TEISINGAS: atmintyje `updatedAt` rašo tas pats
 * procesas, tad jo laikrodis IR YRA autoritetas. Postgres pusėje žymą laiku
 * pažymi DB, tad riba privalo ateiti iš jos.
 */
async function retencijosRiba(terminasMs, now = Date.now()) {
  const skaicius = Number(terminasMs);

  if (!Number.isFinite(skaicius) || skaicius <= 0) {
    throw new Error(`Retencijos terminas privalo būti teigiamas (gauta: ${terminasMs}).`);
  }

  return now - skaicius;
}

async function purgeExpired(cutoffMs, limit = Infinity) {
  let pasalinta = 0;

  for (const [jobId, z] of zymos.entries()) {
    if (pasalinta >= limit) break;
    if (z.status !== TOMBSTONE_STATUS.DELETED) continue;
    if (z.updatedAt >= cutoffMs) continue;

    zymos.delete(jobId);
    pasalinta += 1;
  }

  return pasalinta;
}

async function size() {
  return zymos.size;
}

async function clear() {
  zymos.clear();
}

async function close() {
  /** Atmintis neturi ko uždaryti - metodas egzistuoja dėl kontrakto vienodumo. */
}

/**
 * Zondas - simetriškas postgres realizacijai (#183 Codex, P1).
 *
 * Atmintis visada pasiekiama; metodas egzistuoja tam, kad readiness kelias
 * nešakotųsi pagal backend'ą.
 */
async function probe() {
  return true;
}

module.exports = {
  probe,
  retencijosRiba,
  mark,
  transition,
  transitionOverride,
  get,
  listUnresolved,
  purgeExpired,
  size,
  clear,
  close,
  backend: "memory",
};
