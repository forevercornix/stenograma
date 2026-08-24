/**
 * SESIJŲ BACKEND'O PARINKIMAS (#155, 7.3).
 *
 * ⚠️ ATSKIRAS JUNGIKLIS NUO `JOB_STORE_BACKEND`.
 *
 * Sujungus juos vienu kintamuoju, job metaduomenų aktyvavimo barjero
 * atidarymas AUTOMATIŠKAI perjungtų ir autentikaciją - du nesusiję sprendimai
 * taptų vienu. Sesijų persistencija yra saugumo sprendimas su savo rizika
 * (globali revokacija, rolės snapshot'as, startinis suderinimas), o ne job
 * saugyklos pasekmė.
 *
 * ⚠️ `DATABASE_URL` VIENAS SESIJŲ REŽIMO NEKEIČIA.
 *
 * Jis gali būti įvestas dėl migracijų, audito (7.4) ar bet kurios kitos #155
 * dalies. Diegimas, pridėjęs `DATABASE_URL` visai kitam tikslui, neturi
 * netikėtai pakeisti AUTENTIKACIJOS režimo - būtent toks tylus perjungimas
 * paverstų sesijas persistentinėmis be nė vieno sprendimo apie revokaciją.
 *
 * ⚠️ NEŽINOMA REIKŠMĖ - KLAIDA, NE FALLBACK. Tylus grįžimas į atmintį
 * reikštų, kad operatorius paprašė persistentinių sesijų, servisas pakilo, o
 * kiekvienas restartas atjungia visus vartotojus.
 */

const ALLOWED_SESSION_BACKENDS = Object.freeze(["memory", "postgres"]);

/**
 * @returns {"memory"|"postgres"}
 * @throws {Error} nežinomai reikšmei arba `postgres` be `DATABASE_URL`.
 */
function resolveSessionBackend(env = process.env) {
  const eksplicitinis = (env.SESSION_STORE_BACKEND || "").trim();

  if (!eksplicitinis) return "memory";

  if (!ALLOWED_SESSION_BACKENDS.includes(eksplicitinis)) {
    throw new Error(
      `SESSION_STORE_BACKEND="${eksplicitinis}" nežinomas. ` +
        `Galimos reikšmės: ${ALLOWED_SESSION_BACKENDS.join(", ")}.`
    );
  }

  /**
   * ⚠️ EKSPLICITINIS PASIRINKIMAS REIKALAUJA SAVO PRIKLAUSOMYBĖS.
   *
   * `SESSION_STORE_BACKEND=postgres` be `DATABASE_URL` tyliai paleistų
   * sesijas atmintyje: operatorius eksplicitiškai paprašytų persistencijos,
   * servisas sėkmingai pakiltų, o atsijungimas viename procese kitame
   * neveiktų - t. y. globali revokacija, dėl kurios visa tai daroma, būtų
   * dingusi be jokio pranešimo.
   */
  if (eksplicitinis === "postgres" && !env.DATABASE_URL) {
    throw new Error(
      "SESSION_STORE_BACKEND=postgres, bet DATABASE_URL nenustatytas. " +
        "Eksplicitinis backend'as negali tyliai virsti atmintimi - globali " +
        "revokacija ir sesijų išlikimas po restarto dingtų be įspėjimo."
    );
  }

  return eksplicitinis;
}

module.exports = { ALLOWED_SESSION_BACKENDS, resolveSessionBackend };
