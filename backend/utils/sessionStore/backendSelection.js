const { arNurodytaPostgres } = require("../pgConnection");

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
 * ⚠️ TAI NUSTOJO BŪTI PROGNOZE (#155). Barjeras atidarytas, ir sesijų režimas
 * nepasikeitė nė viename diegime — būtent todėl, kad jungiklis atskiras. Atskyrimo
 * kaina buvo vienas kintamasis; jo nauda išmatuota tą dieną, kai barjeras krito.
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
 * @throws {Error} nežinomai reikšmei arba `postgres` be nurodyto PostgreSQL (#245).
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
  /**
   * ⚠️ „POSTGRES NURODYTAS" SPRENDŽIA `pgConnection`, NE ŠI VIETA (#245).
   *
   * Iki šito reikalauta būtent `DATABASE_URL`. Dokumentuotame Compose diegime
   * jo NĖRA — ten `PG*` — tad eksplicitinis persistencijos prašymas krisdavo
   * su pranešimu apie kintamąjį, kurio diegimas net nenaudoja. Antra to paties
   * pasekmė buvo blogesnė: pasirinkti persistenciją tame diegime būdavo
   * NEĮMANOMA, o pridėjus `DATABASE_URL` krisdavo audito `PGHOST` konfliktas.
   */
  if (eksplicitinis === "postgres" && !arNurodytaPostgres(env)) {
    throw new Error(
      "SESSION_STORE_BACKEND=postgres, bet jungtis nenurodyta: reikia arba " +
        "DATABASE_URL, arba PGHOST (su PG* rinkiniu). " +
        "Eksplicitinis backend'as negali tyliai virsti atmintimi - globali " +
        "revokacija ir sesijų išlikimas po restarto dingtų be įspėjimo."
    );
  }

  return eksplicitinis;
}

module.exports = { ALLOWED_SESSION_BACKENDS, resolveSessionBackend };
