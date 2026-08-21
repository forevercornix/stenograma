/**
 * BACKEND'O PARINKIMO POLITIKA (#155, 7.2a).
 *
 * ⚠️ ATSKIRAS MODULIS SĄMONINGAI, ne `index.js` dalis.
 *
 * Į šį klausimą — „kuris backend'as bus naudojamas šiam env deriniui?" —
 * privalo būti VIENAS autoritetingas atsakymas, ir jo reikia DVIEM
 * skambintojams:
 *
 *   `jobStore/index.js`   – kad inicijuotų teisingą saugyklą;
 *   `utils/privacyConfig` – kad praneštų, ar saugykla persistentinė.
 *
 * `index.js` per `privacyPolicy` jau priklauso nuo `privacyConfig`, tad
 * `privacyConfig` negali priklausyti nuo `index.js` — būtų ciklas. Be šio
 * modulio `privacyConfig` turėtų savo, ANTRĄ taisyklių kopiją, ir abi
 * ilgainiui išsiskirtų būtent ten, kur skirtumo kaina didžiausia: operatorius
 * manytų, kad job'ai išgyvena restartą, o jie neišgyventų.
 *
 * ⚠️ JOKIŲ ŠALUTINIŲ EFEKTŲ IR JOKIŲ VIDINIŲ PRIKLAUSOMYBIŲ. Funkcijos čia
 * priima `env` ir grąžina sprendimą; saugyklos jos neinicijuoja.
 */

/**
 * BACKEND'AI, KURIUOS MATO KELI PROCESAI.
 *
 * Skirtumas nuo „persistentinis" nėra atsitiktinis, nors šiandien aibė ta
 * pati: `memory` gyvena VIENO proceso viduje, tad nei išgyvena restartą, nei
 * yra matomas atskiram worker procesui. Būtent ši savybė lemia ir
 * persistencijos pranešimą, ir eilės tinkamumą.
 */
const SHARED_BACKENDS = Object.freeze(["redis", "postgres"]);

const ALLOWED_BACKENDS = Object.freeze(["postgres", "redis", "memory"]);

/**
 * ⚠️ AKTYVAVIMO BARJERAS (ADR „AKTYVAVIMO BARJERAS").
 *
 * `postgresStore` yra ĮGYVENDINTAS, bet NEPARENKAMAS. ADR sako, kad rollback
 * į Redis nepalaikomas, tad PostgreSQL negali tapti autoritetingas anksčiau,
 * nei egzistuoja kelias tą režimą atlaikyti:
 *
 *   1. patikrintas restore (7.6 dalis);
 *   2. persistentės ištrynimo žymos (7.5a) — `deletionTombstones` yra proceso
 *      atmintis, tad restore pratybos negali įvykdyti savo ištrinto job'o
 *      scenarijaus;
 *   3. transakcinis + SĄLYGINIS rezultatų užbaigimas (7.5b) — kitaip nutrūkęs
 *      procesas palieka `completed` be `job_results`;
 *   4. fail-closed prisijungimas, patikrintas realiu startu (7.2a `[F2]`).
 *
 * ⚠️ KONSTANTA, NE ENV KINTAMASIS. `ALLOW_POSTGRES=1` reikštų, kad barjerą
 * galima apeiti diegimo metu, nepraėjus nė vienos prielaidos ir be jokios
 * peržiūros. Konstanta reiškia, kad atidarymas yra commit'as.
 */
const POSTGRES_AKTYVAVIMAS_LEISTAS = false;

/**
 * NORIMAS backend'as — eksplicitinė pirmenybė.
 *
 * ⚠️ Iki #155 rinkimasis rėmėsi vien `REDIS_URL` buvimu. Su trimis
 * backend'ais tyli pirmenybė reikštų, kad veikiantis režimas priklauso nuo to,
 * kurie env kintamieji atsitiktinai nustatyti — ir diegimas, pridėjęs
 * `DATABASE_URL` sesijoms (7.3), netyčia perjungtų ir job metaduomenis.
 *
 * ⚠️ TAI DAR NE FAKTINIS BACKEND'AS. Grąžinama reikšmė yra NORAS; faktinį
 * lemia `applyActivationBarrier()`. Du lygmenys atskirti, kad
 * `DATABASE_URL > REDIS_URL` galiotų kaip politika ir tada, kai barjeras
 * PostgreSQL dar neleidžia.
 *
 * @returns {{norimas: string, priezastis: string, eksplicitinis: boolean}}
 */
function resolveBackendChoice(env = process.env) {
  const eksplicitinis = env.JOB_STORE_BACKEND;

  if (eksplicitinis) {
    if (!ALLOWED_BACKENDS.includes(eksplicitinis)) {
      throw new Error(
        `JOB_STORE_BACKEND="${eksplicitinis}" nežinomas. ` +
          `Galimos reikšmės: ${ALLOWED_BACKENDS.join(", ")}.`
      );
    }
    /**
     * ⚠️ EKSPLICITINIS PASIRINKIMAS REIKALAUJA SAVO PRIKLAUSOMYBĖS.
     *
     * Be šios patikros `JOB_STORE_BACKEND=redis` BE `REDIS_URL` tyliai
     * paleistų atminties saugyklą: operatorius eksplicitiškai paprašytų
     * Redis, servisas sėkmingai pakiltų, ir kiekvienas job'as dingtų po
     * restarto - net be prisijungimo įspėjimo, nes jungtis nė nebandoma.
     */
    if (eksplicitinis === "redis" && !env.REDIS_URL) {
      throw new Error(
        "JOB_STORE_BACKEND=redis, bet REDIS_URL nenustatytas. Eksplicitinis " +
          "backend'as negali tyliai virsti atmintimi - job'ai dingtų po restarto."
      );
    }
    if (eksplicitinis === "postgres" && !env.DATABASE_URL) {
      throw new Error(
        "JOB_STORE_BACKEND=postgres, bet DATABASE_URL nenustatytas."
      );
    }

    /**
     * ⚠️ `REDIS_REQUIRED=true` YRA KIETA GARANTIJA, ne pageidavimas.
     *
     * `jobStore/index.js:128` ją supranta kaip „fallback į atmintį yra kritinė
     * klaida". Bet `JOB_STORE_BACKEND=memory` atmintį parenka PRIEŠ bandant
     * Redis, tad garantija būtų apeita nė karto nesuveikusi: servisas
     * pakiltų inline režimu ir prarastų job'us, nors konfigūracija
     * eksplicitiškai draudžia būtent tai.
     *
     * Du prieštaraujantys nurodymai negali būti tyliai sutaikyti - krintame.
     */
    if (eksplicitinis === "memory" && env.REDIS_REQUIRED === "true") {
      throw new Error(
        "JOB_STORE_BACKEND=memory kartu su REDIS_REQUIRED=true - prieštaringa " +
          "konfigūracija. REDIS_REQUIRED draudžia darbą su in-memory saugykla, o " +
          "JOB_STORE_BACKEND ją parenka. Pašalinkite vieną iš jų."
      );
    }

    return { norimas: eksplicitinis, priezastis: "JOB_STORE_BACKEND", eksplicitinis: true };
  }

  if (env.DATABASE_URL) return { norimas: "postgres", priezastis: "DATABASE_URL", eksplicitinis: false };
  if (env.REDIS_URL) return { norimas: "redis", priezastis: "REDIS_URL", eksplicitinis: false };
  return { norimas: "memory", priezastis: "numatyta", eksplicitinis: false };
}

/**
 * NORAS → FAKTAS.
 *
 * Kol barjeras galioja, `DATABASE_URL` NETYLI perjungia srauto: parenkamas
 * ankstesnis backend'as, o skambintojas gauna `barjeras: true`, kad galėtų
 * apie tai pranešti. Eksplicitinis `JOB_STORE_BACKEND=postgres` yra KLAIDA, ne
 * įspėjimas — nurodymo ignoruoti tyliai negalima.
 */
function applyActivationBarrier(choice, env = process.env) {
  if (choice.norimas !== "postgres") return { ...choice, barjeras: false };
  if (POSTGRES_AKTYVAVIMAS_LEISTAS) return { ...choice, barjeras: false };

  if (choice.eksplicitinis) {
    throw new Error(
      "JOB_STORE_BACKEND=postgres dar neleidžiamas: PostgreSQL backend'as " +
        "įgyvendintas (#155, 7.2a), bet aktyvavimo barjeras reikalauja " +
        "patikrinto restore (7.6), persistentinių ištrynimo žymų (7.5a), " +
        "sąlyginio transakcinio užbaigimo (7.5b) ir fail-closed starto " +
        "patikros. Žr. docs/decisions/155-postgres-authority.md."
    );
  }

  const atsarginis = env.REDIS_URL ? "redis" : "memory";
  return {
    norimas: atsarginis,
    priezastis: `${choice.priezastis} (barjeras)`,
    eksplicitinis: false,
    barjeras: true,
  };
}

/**
 * FAKTINIS backend'as — vienintelis autoritetingas atsakymas.
 *
 * Visi, kas nori žinoti „kas realiai bus naudojama", privalo eiti PER ŠITĄ, o
 * ne skaityti env kintamuosius patys.
 */
function selectBackend(env = process.env) {
  return applyActivationBarrier(resolveBackendChoice(env), env);
}

/**
 * Ar job store bus PERSISTENTINIS?
 *
 * ⚠️ ATSAKYMAS NĖRA „ar nustatytas DATABASE_URL".
 *
 * Būtent taip buvo iš pradžių, ir tai melavo: su `DATABASE_URL` be
 * `REDIS_URL` aktyvavimo barjeras palieka job'us ATMINTYJE, o
 * `privacyConfig` skelbdavo `persistentStorage = true`. Operatorius pagrįstai
 * manytų, kad job'ai išgyvens restartą — ir prarastų metaduomenis bei
 * rezultatus.
 *
 * Kol barjeras uždarytas, vien `DATABASE_URL` persistencijos NEDUODA. Barjerą
 * atidarius ši funkcija ims grąžinti `true` be jokio pakeitimo čia.
 */
function isPersistentBackend(env = process.env) {
  return SHARED_BACKENDS.includes(selectBackend(env).norimas);
}

/**
 * Ar galima naudoti BullMQ eilę?
 *
 * ⚠️ GRYNA FUNKCIJA SĄMONINGAI. Sprendimas priklauso nuo dviejų įvesčių, tad
 * jos abi perduodamos - o ne skaitomos iš `process.env` ir modulio būsenos
 * funkcijos viduje. Priežastis testinė: netiesiogiai tikrinama funkcija
 * priverčia testą arba kelti tikrą Redis, arba kartoti tą pačią sąlygą
 * helperyje - t. y. sukurti ANTRĄ taisyklės kopiją, kuri lieka žalia net
 * realizacijai apsivertus. Su gryna funkcija kiekvienas derinys tikrinamas
 * tiesiogiai.
 *
 * SĄLYGA DVINARĖ, ne vienanarė:
 *
 *   1. `REDIS_URL` — BullMQ gyvena Redis'e ir kitaip veikti negali;
 *   2. BENDRAS metaduomenų backend'as (`redis` arba `postgres`).
 *
 * KODĖL ANTROJI. BullMQ vykdo darbą ATSKIRAME worker procese. Su `memory`
 * metaduomenimis tas procesas atnaujintų SAVO atminties kopiją, o HTTP
 * procesas jos nematytų: klientas amžinai apklausinėtų `queued` job'ą, kuris
 * kitame procese jau baigtas. Eilė be bendros saugyklos yra ne optimizacija, o
 * gedimo režimas.
 *
 * KAS PASIKEITĖ (#155, 7.2a). Anksčiau `server.js` klausė
 * `getBackend() === "redis"` — t. y. reikalavo KONKREČIAI Redis. Pasirinkus
 * PostgreSQL metaduomenims vykdymas nukristų į inline režimą, nors Redis
 * veikia: sukurti eilės job'ai liktų nesuvartoti. Reikalavimas dabar yra
 * „bendras backend'as", ne „būtent Redis".
 *
 * @param {object} env
 * @param {string} metadataBackend faktinis job store backend'as
 */
function canUseQueue(env, metadataBackend) {
  return Boolean(env.REDIS_URL) && SHARED_BACKENDS.includes(metadataBackend);
}

module.exports = {
  SHARED_BACKENDS,
  canUseQueue,
  ALLOWED_BACKENDS,
  POSTGRES_AKTYVAVIMAS_LEISTAS,
  resolveBackendChoice,
  applyActivationBarrier,
  selectBackend,
  isPersistentBackend,
};
