/**
 * AUDITO RAKTŲ ŽIEDAS (#155, 7.4c / #212).
 *
 * ⚠️ VIENINTELIS AKTYVAUS IR ISTORINIŲ RAKTŲ AUTORITETAS.
 *
 * `AUDIT_ID_SALT_PREVIOUS` NEGALI būti parsinamas atskirai užklausos, ištrynimo
 * ir starto kode. Trys kopijos išsiskirtų tyliai, o kaina būtų GDPR: ištrynimas
 * apskaičiuotų kitą kandidatų aibę nei paieška, ir dalis įrašų liktų
 * nepasiekiami. 7.4b peržiūra tą pačią „dvi konfigūracijos" ydą rado keturis
 * kartus iš eilės - čia ji uždaroma iš anksto.
 *
 * ⚠️ SECRET'AI NIEKADA NEPATENKA Į KLAIDAS AR LOGUS. Klaidų tekstuose minimi tik
 * generacijų ID - jie yra etiketės, ne paslaptys.
 */

const crypto = require("node:crypto");

/** Generacijos ID formatas (#212). Etiketė, ne paslaptis. */
const ID_FORMAT = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Secret formatas: base64url arba hex.
 *
 * Kablelio ir dvitaškio jame būti negali - būtent todėl `id:secret` sąrašo
 * skaidymas yra vienareikšmis ir nereikalauja ekranavimo.
 */
const SECRET_FORMAT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * ⚠️ RIBA TAIKOMA TIK NEBEREIKALINGIEMS RAKTAMS (#212).
 *
 * Naivus derinys „maks. N istorinių" + „rakto negalima pašalinti, kol DB yra jo
 * įrašų" duoda spąstus: pasukus raktą N+1 kartų greičiau nei suveikia retencija,
 * viršijimas neleidžia startuoti, o pašalinti nė vieno negalima. Todėl riba
 * pažeidžiama TIK tada, kai bent vienas istorinis raktas DB įrašų nebeturi -
 * sprendimą priima `auditStore/index.js`, nes jam reikia DB.
 */
const HISTORICAL_SOFT_LIMIT = 10;

class AuditKeyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditKeyConfigError";
    this.code = "AUDIT_KEY_CONFIG_INVALID";
  }
}

function tikrintiId(id, kontekstas) {
  if (!id) {
    throw new AuditKeyConfigError(`${kontekstas}: generacijos ID tuščias.`);
  }
  if (!ID_FORMAT.test(id)) {
    throw new AuditKeyConfigError(
      `${kontekstas}: generacijos ID "${id}" netinkamo formato. ` +
        "Leidžiama: raidės, skaitmenys, `_`, `.`, `-`; 1-64 simboliai."
    );
  }
}

function tikrintiSecret(secret, id) {
  if (!secret) {
    throw new AuditKeyConfigError(`Generacijos "${id}" secret'as tuščias.`);
  }
  if (!SECRET_FORMAT.test(secret)) {
    /** ⚠️ Reikšmė NEĮTRAUKIAMA - tik ID ir laukiamas formatas. */
    throw new AuditKeyConfigError(
      `Generacijos "${id}" secret'as netinkamo formato. Laukiama base64url arba hex ` +
        "(be kablelių ir dvitaškių)."
    );
  }
}

/**
 * Išparsina `AUDIT_ID_SALT_PREVIOUS`: kableliais atskirtas `id:secret` sąrašas.
 *
 * @returns {Array<{id: string, secret: string}>}
 */
function parsintiIstorinius(raw) {
  if (!raw || !String(raw).trim()) return [];

  return String(raw)
    .split(",")
    .map((dalis) => dalis.trim())
    .filter((dalis) => dalis.length > 0)
    .map((dalis) => {
      const riba = dalis.indexOf(":");

      if (riba === -1) {
        throw new AuditKeyConfigError(
          "AUDIT_ID_SALT_PREVIOUS elementas be dvitaškio - laukiama `id:secret`. " +
            "Sugadintą reikšmę pataisykite; jos turinys čia sąmoningai nerodomas."
        );
      }

      const id = dalis.slice(0, riba).trim();
      const secret = dalis.slice(riba + 1).trim();

      tikrintiId(id, "AUDIT_ID_SALT_PREVIOUS");
      tikrintiSecret(secret, id);

      return { id, secret };
    });
}

/**
 * Sudaro raktų žiedą iš aplinkos.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string|null} [opts.aktyvusSecret] jau išspręstas aktyvus secret'as
 *   (7.4b konfigūracijos autoritetas); be jo imama `env.AUDIT_ID_SALT`.
 * @param {boolean} [opts.reikalaujamaAktyvausId] `true` persistentiniam
 *   backend'ui, kur ID realiai įrašomas kaip `hash_key_id`.
 * @throws {AuditKeyConfigError}
 */
function resolveKeyRing(env = process.env, opts = {}) {
  const { aktyvusSecret = null, reikalaujamaAktyvausId = false } = opts;

  const activeId = (env.AUDIT_ID_SALT_ID || "").trim() || null;
  const activeSecret = aktyvusSecret || env.AUDIT_ID_SALT || null;

  if (reikalaujamaAktyvausId) {
    tikrintiId(activeId, "AUDIT_ID_SALT_ID");
    tikrintiSecret(activeSecret, activeId);
  } else if (activeId) {
    /** Atminties režimu ID neprivalomas, bet nurodytas privalo būti taisyklingas. */
    tikrintiId(activeId, "AUDIT_ID_SALT_ID");
  }

  const istoriniai = parsintiIstorinius(env.AUDIT_ID_SALT_PREVIOUS);

  /**
   * ⚠️ VIENA AIBĖ: aktyvus + istoriniai ID privalo nesikartoti.
   *
   * Dublikatas reikštų, kad tas pats `hash_key_id` DB atitinka du skirtingus
   * secret'us, ir `subject_id` atkūrimas taptų neapibrėžtas.
   */
  const matyti = new Map();
  if (activeId) matyti.set(activeId, "aktyvus");

  for (const { id } of istoriniai) {
    if (matyti.has(id)) {
      throw new AuditKeyConfigError(
        `Generacijos ID "${id}" kartojasi (${matyti.get(id)} ir istorinis). ` +
          "Tas pats `hash_key_id` atitiktų du secret'us, ir `subject_id` atkūrimas " +
          "taptų neapibrėžtas."
      );
    }
    matyti.set(id, "istorinis");
  }

  const visi = new Map();
  if (activeId && activeSecret) visi.set(activeId, activeSecret);
  for (const { id, secret } of istoriniai) visi.set(id, secret);

  return Object.freeze({
    activeId,
    activeSecret,
    /** @type {ReadonlyArray<{id: string, secret: string}>} */
    historical: Object.freeze(istoriniai.map((k) => Object.freeze({ ...k }))),
    /** ID → secret; naudoti `secretFor()`, ne tiesiogiai. */
    visi,
    historicalCount: istoriniai.length,
  });
}

/** @returns {string|null} secret'as generacijai arba `null`, jei žiedas jos neturi. */
function secretFor(ring, generationId) {
  return ring.visi.get(generationId) || null;
}

/** HMAC pseudonimas KONKREČIA generacija. Tas pats algoritmas kaip 7.4a. */
function subjectIdFor(secret, value) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 20);
}

/**
 * Kandidatiniai `subject_id` vienam identifikatoriui.
 *
 * ⚠️ FAN-OUT AUTORITETAS - DB, NE ENV SĄRAŠO ILGIS (#212).
 *
 * `generationIds` ateina iš `audit_log` faktiškai naudojamų generacijų, tad
 * konfigūracijoje likę raktai be įrašų kandidatų aibės nedidina. Aktyvus raktas
 * įtraukiamas visada - juo rašomi nauji įrašai, kurių DB dar gali ir neturėti.
 *
 * @returns {string[]} unikalūs pseudonimai; tuščias, jei `value` tuščias.
 */
function candidateSubjectIds(ring, value, generationIds = []) {
  if (value === null || value === undefined || value === "") return [];

  /**
   * ⚠️ TUŠČIAS SĄRAŠAS REIŠKIA „NEŽINOMA", NE „NĖRA".
   *
   * Postgres pusėje `usedGenerations()` grąžina faktines DB generacijas, ir
   * fan-out apribojamas jomis. Atminties backend'as `hash_key_id` nesaugo, tad
   * grąžina tuščią sąrašą - jei tai suprastume kaip „generacijų nėra",
   * kandidatas liktų vienas, ir po rotacijos to paties proceso metu seni įrašai
   * taptų neištrinami. Todėl be informacijos naudojami VISI sukonfigūruoti
   * raktai: aibė vis tiek ribota env sąrašu, o GDPR kelias lieka veikiantis.
   */
  const naudojamos = new Set(generationIds);

  if (naudojamos.size === 0) {
    for (const id of ring.visi.keys()) naudojamos.add(id);
  }

  if (ring.activeId) naudojamos.add(ring.activeId);

  const rezultatas = new Set();

  for (const id of naudojamos) {
    const secret = secretFor(ring, id);
    if (secret) rezultatas.add(subjectIdFor(secret, value));
  }

  /**
   * Be ID (atminties režimas su sugeneruota druska) generacijų nėra, bet
   * pseudonimas vis tiek skaičiuojamas - kitaip ištrynimas nustotų veikti.
   */
  if (rezultatas.size === 0 && ring.activeSecret) {
    rezultatas.add(subjectIdFor(ring.activeSecret, value));
  }

  return [...rezultatas];
}

module.exports = {
  AuditKeyConfigError,
  ID_FORMAT,
  SECRET_FORMAT,
  HISTORICAL_SOFT_LIMIT,
  resolveKeyRing,
  secretFor,
  subjectIdFor,
  candidateSubjectIds,
};
