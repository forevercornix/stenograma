/**
 * ARTEFAKTŲ INVENTORIUS IR GYVAVIMO CIKLO MODELIS (#19 PR1).
 *
 * KODĖL TO REIKIA, kai ištrynimas jau veikia.
 *
 * `utils/jobErasure.js` jau trina eilę, jobo įrašą, audio ir auditą. Bet jis
 * trina TAI, KĄ ŽINO – o žinojimas išbarstytas po kodą: audio raktas viename
 * modulyje, eksporto failai kitame, laikini konversijos failai trečiame. Kai
 * atsiranda naujas artefakto tipas, nėra vietos, kur jį reikėtų UŽREGISTRUOTI,
 * tad jis lieka nematomas ištrynimui – tyliai.
 *
 * Šis modulis yra ta vieta. Jis NIEKO NETRINA (tai #19 PR2) – jis atsako į
 * klausimus „kokie artefaktai egzistuoja", „kam jie priklauso", „iš ko jie
 * išvesti" ir „kokioje būsenoje yra".
 */

/**
 * PERSISTENCIJOS KLASĖS.
 *
 * Skirtumas praktinis, ne teorinis: nuo jo priklauso, KO tikimasi po
 * ištrynimo ir ką reiškia „artefakto nebėra".
 */
const PERSISTENCE = {
  /** Išgyvena procesą ir restartą. Ištrynimas privalo juos pasiekti. */
  PERSISTENT: "persistent",
  /** Gyvena tik apdorojimo metu; turi išnykti patys, bet gali „pakibti" po kritimo. */
  TEMPORARY: "temporary",
  /** Niekada nesaugomi – generuojami užklausos metu ir egzistuoja tik atsakyme. */
  EPHEMERAL: "ephemeral",
};

/**
 * ARTEFAKTŲ TIPŲ REGISTRAS.
 *
 * `owner` – kieno identifikatorius artefaktą sieja (`job` arba `meeting`).
 * `derivedFrom` – iš kurio tipo jis išvestas; `null` reiškia šaknį. Būtent šis
 * laukas leidžia apeiti VISĄ išvedimo grafą nuo įkelto audio iki eksporto, o ne
 * spėlioti ryšius pagal pavadinimus.
 *
 * ⚠️ `meeting` NAUDOJAMAS DAR NĖRA. Visi šiuo metu registruoti tipai priklauso
 * jobui. Reikšmė modelyje palikta sąmoningai: #19 reikalauja koreliacijos „to a
 * job **or meeting** identifier", o susitikimo lygio artefaktai (pvz. keli
 * jobai vienam posėdžiui) yra numatoma kryptis. Bet kol tokių artefaktų nėra,
 * `ownerKind: "meeting"` yra tik galimybė, ne veikiantis kelias – ir testai
 * neturi apsimesti, kad jis patikrintas.
 */
const ARTEFACT_TYPES = {
  SOURCE_AUDIO: {
    id: "source_audio",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: null,
    description: "Įkeltas garso ar vaizdo failas saugykloje",
  },

  UPLOAD_TEMP: {
    id: "upload_temp",
    persistence: PERSISTENCE.TEMPORARY,
    owner: "job",
    derivedFrom: null,
    description: "Multer laikinas failas įkėlimo metu",
  },

  CONVERSION_TEMP: {
    id: "conversion_temp",
    persistence: PERSISTENCE.TEMPORARY,
    owner: "job",
    derivedFrom: "source_audio",
    description: "ffmpeg/WAV konversijos tarpinis failas",
  },

  TRANSCRIPT: {
    id: "transcript",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: "source_audio",
    description: "Transkripcijos tekstas ir segmentai jobo įraše",
  },

  TRANSCRIPT_REDACTED: {
    id: "transcript_redacted",
    persistence: PERSISTENCE.EPHEMERAL,
    owner: "job",
    derivedFrom: "transcript",
    /**
     * EFEMERIŠKAS SĄMONINGAI (žr. #4): redaguotas variantas perskaičiuojamas
     * kiekvienam panaudojimui ir niekada nesaugomas. Jei jis būtų saugomas,
     * atsirastų ANTRA asmens duomenų kopija, kurią reikėtų atskirai trinti.
     */
    description: "Redaguota transkripcija – generuojama, nesaugoma",
  },

  PROTOCOL: {
    id: "protocol",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: "transcript",
    description: "Sugeneruotas protokolas jobo rezultate",
  },

  EXPORT_REDACTED: {
    id: "export_redacted",
    persistence: PERSISTENCE.EPHEMERAL,
    owner: "job",
    derivedFrom: "protocol",
    description: "Redaguotas eksporto failas – siunčiamas ir nesaugomas",
  },

  EXPORT_ORIGINAL: {
    id: "export_original",
    persistence: PERSISTENCE.EPHEMERAL,
    owner: "job",
    derivedFrom: "protocol",
    description: "Originalus eksporto failas – siunčiamas ir nesaugomas",
  },

  QUEUE_RECORD: {
    id: "queue_record",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: null,
    description: "BullMQ jobo įrašas su payload'u Redis'e",
  },

  JOB_RECORD: {
    id: "job_record",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: null,
    description: "jobStore įrašas (būsena, rezultatas, metaduomenys)",
  },

  AUDIT_ENTRY: {
    id: "audit_entry",
    persistence: PERSISTENCE.PERSISTENT,
    owner: "job",
    derivedFrom: null,
    /**
     * ⚠️ Auditas trinamas KITAIP nei kiti artefaktai: dalis įrašų privalo
     * likti kaip ištrynimo įrodymas (žr. #19 „minimum audit evidence"). Todėl
     * jis registre yra, bet jo ištrynimas nėra „viską pašalinti".
     */
    description: "Audito įrašai, susieti su jobu",
  },
};

/** Greitesnė paieška pagal `id`. */
const TYPES_BY_ID = Object.fromEntries(Object.values(ARTEFACT_TYPES).map((t) => [t.id, t]));

/**
 * GYVAVIMO CIKLO BŪSENOS.
 *
 * Modeliuojamas ARTEFAKTAS, ne jobas – jobo būsena (`queued`/`processing`/…)
 * atsako į kitą klausimą. Artefaktui svarbu tik: ar jis egzistuoja, ar
 * pažymėtas trynimui, ar jau ištrintas, ar ištrinti nepavyko.
 */
const LIFECYCLE_STATES = {
  /** Užregistruotas ir egzistuoja. */
  ACTIVE: "active",
  /** Pažymėtas ištrynimui (tombstone jau yra), bet dar nepašalintas. */
  PENDING_DELETION: "pending_deletion",
  /** Patvirtintai pašalintas. */
  DELETED: "deleted",
  /** Ištrinti nepavyko; galima kartoti. */
  DELETION_FAILED_RETRYABLE: "deletion_failed_retryable",
  /** Ištrinti nepavyko ir kartojimas nepadės – reikia žmogaus. */
  DELETION_FAILED_PERMANENT: "deletion_failed_permanent",
};

/**
 * LEIDŽIAMI PERĖJIMAI.
 *
 * Deny-by-default, kaip ir leidimų registre (#18): perėjimas, kurio čia nėra,
 * yra draudžiamas. Svarbiausia taisyklė – iš `DELETED` NĖRA kelio atgal.
 * Priešingu atveju vėluojantis worker'is galėtų „atgaivinti" ištrintą
 * artefaktą, ir ištrynimas taptų laikinu.
 */
const ALLOWED_TRANSITIONS = {
  [LIFECYCLE_STATES.ACTIVE]: [LIFECYCLE_STATES.PENDING_DELETION],

  [LIFECYCLE_STATES.PENDING_DELETION]: [
    LIFECYCLE_STATES.DELETED,
    LIFECYCLE_STATES.DELETION_FAILED_RETRYABLE,
    LIFECYCLE_STATES.DELETION_FAILED_PERMANENT,
  ],

  [LIFECYCLE_STATES.DELETION_FAILED_RETRYABLE]: [
    LIFECYCLE_STATES.PENDING_DELETION, // pakartotinis bandymas
    LIFECYCLE_STATES.DELETED,
    LIFECYCLE_STATES.DELETION_FAILED_PERMANENT, // išnaudoti bandymai
  ],

  /**
   * GALUTINĖS BŪSENOS – jokių išeinančių perėjimų.
   *
   * `DELETED` yra galutinė pagal apibrėžimą. `DELETION_FAILED_PERMANENT` –
   * todėl, kad jis reiškia „reikia žmogaus": automatinis perėjimas iš jo
   * paslėptų problemą, kurią kaip tik reikia matyti.
   */
  [LIFECYCLE_STATES.DELETED]: [],
  [LIFECYCLE_STATES.DELETION_FAILED_PERMANENT]: [],
};

/** Ar perėjimas leidžiamas? Deny-by-default. */
function canTransition(from, to) {
  if (!from || !to) return false;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Perėjimas su AIŠKIA klaida, ne tyliu praleidimu.
 *
 * @throws {Error} su `code: "INVALID_LIFECYCLE_TRANSITION"`
 */
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`Neleidžiamas gyvavimo ciklo perėjimas: ${from} -> ${to}.`);
    error.code = "INVALID_LIFECYCLE_TRANSITION";
    throw error;
  }
}

/**
 * Sukuria inventoriaus įrašą.
 *
 * `retentionDeadline` yra `null`, kol jo nenustato retencijos politika –
 * efemeriškiems artefaktams jis beprasmis, nes jie neišgyvena užklausos.
 *
 * ⚠️ `sourceArtefactId` ŠIAME ETAPE NEVALIDUOJAMAS.
 *
 * Priimama bet kokia reikšmė, nes patikra reikalauja KONTEKSTO, kurio čia nėra:
 * norint patvirtinti nuorodą, reikia matyti visą jobo inventorių ir žinoti, ar
 * nurodytas artefaktas jame egzistuoja bei ar jo tipas atitinka
 * `derivedFrom`. Šiame PR realūs artefaktai dar neregistruojami, tad
 * nevaliduota nuoroda niekur nepatenka.
 *
 * KĄ PRIVALO PATIKRINTI KITAS ETAPAS (registruojant artefaktus realiuose
 * keliuose):
 *   1. jei tipas turi `derivedFrom`, `sourceArtefactId` yra PRIVALOMAS;
 *   2. jei tipas yra šaknis (`derivedFrom === null`), `sourceArtefactId`
 *      privalo būti `null` – kitaip grafe atsirastų netikras ryšys;
 *   3. nurodytas artefaktas turi egzistuoti TAME PAČIAME inventoriuje;
 *   4. jo tipas turi sutapti su `derivedFrom`.
 *
 * Be 3 ir 4 punktų ištrynimas galėtų apeiti grafą, kurio dalis nurodo į
 * niekur – o tai yra tyli spraga: apėjimas „pavyktų", tik nieko nerastų.
 */
function createRecord({ type, ownerId, sourceArtefactId = null, retentionDeadline = null }) {
  const definition = TYPES_BY_ID[type];

  if (!definition) {
    const error = new Error(`Nežinomas artefakto tipas: "${type}".`);
    error.code = "UNKNOWN_ARTEFACT_TYPE";
    throw error;
  }
  if (!ownerId) {
    const error = new Error(`Artefaktas "${type}" be savininko ID – jo nebūtų kaip susieti su jobu.`);
    error.code = "ARTEFACT_WITHOUT_OWNER";
    throw error;
  }

  return {
    type: definition.id,
    ownerId,
    ownerKind: definition.owner,
    persistence: definition.persistence,
    sourceArtefactId,
    state: LIFECYCLE_STATES.ACTIVE,
    retentionDeadline,
    deletedAt: null,
    failureReason: null,
  };
}

/**
 * Išvedimo grandinė nuo šaknies iki nurodyto tipo.
 *
 * Naudinga ištrynimui: kad būtų galima apeiti VISĄ grafą, o ne tikėtis, kad
 * kiekvienas artefaktas bus prisimintas atskirai.
 */
function derivationChain(typeId) {
  const chain = [];
  let current = TYPES_BY_ID[typeId];

  while (current) {
    chain.unshift(current.id);
    current = current.derivedFrom ? TYPES_BY_ID[current.derivedFrom] : null;
  }

  return chain;
}

/**
 * Visi tipai, kurie tiesiogiai ar netiesiogiai išvesti iš nurodyto.
 *
 * Rekursija be cache SĄMONINGAI: registre yra 11 tipų, gylis – 4, ir funkcija
 * kviečiama ne karštame kelyje (ištrynimo planavimas, ne kiekviena užklausa).
 * Cache čia pridėtų invalidacijos klausimą be jokio išmatuojamo pelno.
 *
 * Verta grįžti, jei registras išaugtų iki dešimčių tipų ARBA jei ši funkcija
 * atsidurtų užklausos kelyje – tada `descendantTypes` rezultatą galima
 * apskaičiuoti vieną kartą modulio įkėlimo metu, nes registras yra statinis.
 */
function descendantTypes(typeId) {
  const direct = Object.values(ARTEFACT_TYPES).filter((t) => t.derivedFrom === typeId);
  return direct.flatMap((t) => [t.id, ...descendantTypes(t.id)]);
}

/** Tipai pagal persistencijos klasę – ištrynimo ir patikrų planavimui. */
function typesByPersistence(persistence) {
  return Object.values(ARTEFACT_TYPES)
    .filter((t) => t.persistence === persistence)
    .map((t) => t.id);
}

module.exports = {
  PERSISTENCE,
  ARTEFACT_TYPES,
  TYPES_BY_ID,
  LIFECYCLE_STATES,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  createRecord,
  derivationChain,
  descendantTypes,
  typesByPersistence,
};
