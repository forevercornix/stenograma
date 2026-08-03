const { ARTEFACT_TYPES, PERSISTENCE, TYPES_BY_ID, typesByPersistence } = require("./artefactInventory");

/**
 * ATSARGINIŲ KOPIJŲ POLITIKA (#20 PR1).
 *
 * KODĖL POLITIKA IŠVEDAMA IŠ ARTEFAKTŲ REGISTRO, o ne rašoma iš naujo.
 *
 * #19 registras jau atsako į klausimą „kas išgyvena procesą" – būtent tas
 * atsakymas ir lemia, ką prasminga kopijuoti. Antras, nepriklausomas sąrašas
 * neišvengiamai išsiskirtų su pirmuoju: naujas artefakto tipas atsirastų
 * registre, bet ne kopijų politikoje, ir liktų nekopijuojamas TYLIAI.
 *
 * Taisyklė paprasta ir kildinama, ne sugalvota:
 *
 *   persistent  -> ĮTRAUKIAMA (išgyvena restartą, tad turi išgyventi ir gedimą)
 *   temporary   -> NEĮTRAUKIAMA (turi išnykti pati; kopija atkurtų šiukšles)
 *   ephemeral   -> NEĮTRAUKIAMA (niekada nesaugoma; kopija sukurtų ANTRĄ
 *                  asmens duomenų kopiją ten, kur jos sąmoningai nebuvo)
 */

/** Kopijos formato versija. Keičiama tik nesuderinamiems pakeitimams. */
const BACKUP_FORMAT_VERSION = 1;

/**
 * Seniausia formato versija, kurią dar galima atkurti.
 *
 * Atskirta nuo dabartinės sąmoningai: kopijų prasmė yra atkurti SENĄ būklę, tad
 * suderinamumo langas turi būti eksplicitinis, o ne numanomas iš to, kad
 * „kol kas versija tik viena".
 */
const MIN_RESTORABLE_VERSION = 1;

/**
 * IŠIMTYS, kurios NEIŠPLAUKIA iš persistencijos klasės.
 *
 * `queue_record` yra `persistent` (gyvena Redis'e ir išgyvena restartą), bet į
 * kopiją NEĮTRAUKIAMAS: tai vykdymo būsena, ne duomenys. Atkūrus ją, eilė
 * bandytų tęsti darbus, kurių kontekstas jau nebeegzistuoja – tiekėjų sesijos,
 * laikini failai, worker'ių būsena. Rezultatas būtų ne atkūrimas, o klaidų
 * srautas.
 *
 * Vietoj to atkūrimas palieka eilę tuščią, ir nebaigti darbai laikomi
 * prarastais – tai sąžininga riba, kurią reikia dokumentuoti, ne apeiti.
 */
const EXCLUDED_DESPITE_PERSISTENT = {
  [ARTEFACT_TYPES.QUEUE_RECORD.id]: "vykdymo būsena, ne duomenys – atkūrimas duotų klaidų srautą",
};

/** Ar šis artefakto tipas įtraukiamas į kopiją? */
function isIncluded(typeId) {
  const type = TYPES_BY_ID[typeId];
  if (!type) return false;
  if (typeId in EXCLUDED_DESPITE_PERSISTENT) return false;

  return type.persistence === PERSISTENCE.PERSISTENT;
}

/** Tipai, patenkantys į kopiją. */
function includedTypes() {
  return Object.values(ARTEFACT_TYPES)
    .map((type) => type.id)
    .filter(isIncluded);
}

/**
 * Tipai, NEPATENKANTYS į kopiją, su priežastimi.
 *
 * Priežastis privaloma: „neįtraukta" ir „pamiršta įtraukti" turi atrodyti
 * skirtingai – ta pati taisyklė kaip artefaktų skeneryje (#19 PR4).
 */
function excludedTypes() {
  return Object.values(ARTEFACT_TYPES)
    .filter((type) => !isIncluded(type.id))
    .map((type) => ({
      type: type.id,
      reason:
        EXCLUDED_DESPITE_PERSISTENT[type.id] ||
        (type.persistence === PERSISTENCE.TEMPORARY
          ? "laikinas – turi išnykti pats, kopija atkurtų šiukšles"
          : "efemeriškas – niekada nesaugomas, kopija sukurtų antrą PII kopiją"),
    }));
}

/**
 * Kopijų retencija.
 *
 * ⚠️ ŠI REIKŠMĖ APIBRĖŽIA FAKTINĮ IŠTRYNIMO LANGĄ.
 *
 * #19 ištrynimas veikia gyvoje sistemoje, bet kopijoje esantys duomenys lieka
 * iki jos galiojimo pabaigos. Todėl kopijų retencija yra ne tik atkūrimo, bet
 * ir privatumo nuostata: ji atsako, per kiek laiko ištrynimas tampa galutinis.
 */
const DEFAULT_RETENTION_DAYS = 7;

function retentionDays(env = process.env) {
  const raw = Number(env.BACKUP_RETENTION_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * Ar kopijos apskritai įjungtos?
 *
 * Numatytai IŠJUNGTOS: kopija yra papildoma asmens duomenų saugykla, tad jos
 * atsiradimas turi būti sąmoningas sprendimas, ne šalutinis atnaujinimo
 * poveikis.
 */
function isEnabled(env = process.env) {
  return String(env.BACKUP_ENABLED || "").toLowerCase() === "true";
}

/**
 * Sudaro politikos momentinę nuotrauką, įrašomą į manifestą.
 *
 * Nuotrauka reikalinga atkūrimui: be jos nežinotum, KOKIA politika galiojo
 * kopijos kūrimo metu, ir negalėtum pasakyti, ar kopijos turinys atitinka
 * dabartinius lūkesčius.
 */
function policySnapshot(env = process.env) {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    includedTypes: includedTypes(),
    excludedTypes: excludedTypes(),
    retentionDays: retentionDays(env),
  };
}

/**
 * Ar kopijos formato versiją dar galima atkurti?
 *
 * @returns {{compatible: boolean, reason?: string}}
 */
function checkRestoreCompatibility(manifestVersion) {
  if (!Number.isInteger(manifestVersion)) {
    return { compatible: false, reason: "manifeste nėra galiojančios formato versijos" };
  }

  if (manifestVersion > BACKUP_FORMAT_VERSION) {
    /**
     * NAUJESNĖ kopija į senesnę sistemą.
     *
     * Atmetama sąmoningai: naujesnis formatas gali turėti laukų, kurių ši
     * versija nesupranta, ir atkūrimas juos tyliai prarastų – o tai blogiau
     * nei atviras atsisakymas, nes atrodytų kaip sėkmė.
     */
    return {
      compatible: false,
      reason: `kopija sukurta naujesne versija (${manifestVersion} > ${BACKUP_FORMAT_VERSION})`,
    };
  }

  if (manifestVersion < MIN_RESTORABLE_VERSION) {
    return {
      compatible: false,
      reason: `kopijos formatas per senas (${manifestVersion} < ${MIN_RESTORABLE_VERSION})`,
    };
  }

  return { compatible: true };
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  MIN_RESTORABLE_VERSION,
  EXCLUDED_DESPITE_PERSISTENT,
  isIncluded,
  includedTypes,
  excludedTypes,
  retentionDays,
  isEnabled,
  policySnapshot,
  checkRestoreCompatibility,
};
