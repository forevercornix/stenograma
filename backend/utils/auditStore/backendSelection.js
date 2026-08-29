/**
 * AUDITO BACKEND'O PARINKIMAS (#155, 7.4b / #211).
 *
 * ⚠️ ATSKIRAS JUNGIKLIS NUO `JOB_STORE_BACKEND` IR `SESSION_STORE_BACKEND`.
 *
 * Sujungus juos, job metaduomenų arba autentikacijos persistencijos įjungimas
 * AUTOMATIŠKAI perkeltų ir auditą į DB. Auditas turi savo riziką - privalomą
 * stabilią druską, append-only semantiką, GDPR ištrynimo kelią - ir jos
 * negalima paveldėti kaip nesusijusio sprendimo pasekmės.
 *
 * ⚠️ `DATABASE_URL` VIENAS AUDITO REŽIMO NEKEIČIA. Diegimas, pridėjęs jį dėl
 * migracijų ar sesijų, neturi netikėtai pradėti persistinti audito.
 *
 * ⚠️ NEŽINOMA REIKŠMĖ - KLAIDA, NE FALLBACK. Tylus grįžimas į atmintį reikštų,
 * kad operatorius paprašė persistentinio audito, servisas pakilo, o kiekvienas
 * restartas žurnalą ištrina.
 */

const ALLOWED_AUDIT_BACKENDS = Object.freeze(["memory", "postgres"]);

/**
 * @returns {"memory"|"postgres"}
 * @throws {Error} nežinomai reikšmei arba trūkstamai priklausomybei.
 */
function resolveAuditBackend(env = process.env) {
  const eksplicitinis = (env.AUDIT_BACKEND || "").trim();

  if (!eksplicitinis) return "memory";

  if (!ALLOWED_AUDIT_BACKENDS.includes(eksplicitinis)) {
    throw new Error(
      `AUDIT_BACKEND="${eksplicitinis}" nežinomas. ` +
        `Galimos reikšmės: ${ALLOWED_AUDIT_BACKENDS.join(", ")}.`
    );
  }

  if (eksplicitinis !== "postgres") return eksplicitinis;

  /**
   * ⚠️ EKSPLICITINIS PASIRINKIMAS REIKALAUJA SAVO PRIKLAUSOMYBĖS.
   *
   * `AUDIT_BACKEND=postgres` be `DATABASE_URL` tyliai paleistų auditą
   * atmintyje: operatorius paprašytų persistencijos, servisas pakiltų, o
   * žurnalas dingtų per pirmą restartą - t. y. dingtų būtent tai, dėl ko
   * persistencija ir įjungiama.
   */
  /**
   * ⚠️ PRIIMAMOS ABI KONFIGŪRACIJOS FORMOS.
   *
   * Dokumentuotas Compose diegimas DB perduoda per `PGHOST` ir kitus `PG*`, o ne
   * per `DATABASE_URL` - sąmoningai, nes slaptažodis su URI simboliais URL'e
   * reikštų kitką arba jį sugadintų. Reikalavus tik `DATABASE_URL`,
   * `AUDIT_BACKEND=postgres` dokumentuotame diegime NEĮSIJUNGTŲ: startas kristų
   * konfigūracijoje, kuri realiai yra teisinga.
   *
   * `pg` `PG*` skaito pats, tad `auditoPoolNustatymai()` `connectionString`
   * perduoda tik tada, kai URL realiai yra.
   */
  /**
   * ⚠️ ABU BŪDAI KARTU - KLAIDA, NE PIRMENYBĖ.
   *
   * Repo tai jau deklaruoja (`startupChecks.js`: „ABU KONFIGŪRAVIMO BŪDAI KARTU
   * = KLAIDA, ne pirmenybė"), bet TIK minkštame self-check'e, kuris vykdomas PO
   * `listen()`. Auditui to nepakanka: `auditoPoolNustatymai()` tyliai teikia
   * pirmenybę `DATABASE_URL`, tad servisas galėtų paskelbti readiness ir rašyti
   * auditą į VISAI KITĄ duomenų bazę nei ta, kurią nurodo Compose `PG*`.
   *
   * Auditas yra būtent ta lentelė, apie kurią klausiama po incidento - „į kurią
   * DB jis rašė" negali priklausyti nuo tylios pirmenybės.
   */
  if (env.DATABASE_URL && env.PGHOST) {
    throw new Error(
      "AUDIT_BACKEND=postgres, bet nustatyti IR DATABASE_URL, IR PGHOST. " +
        "Neaišku, į kurią DB rašomas auditas: pool'as teiktų pirmenybę " +
        "DATABASE_URL, o Compose profiliai naudoja PG*. Palikite TIK VIENĄ būdą."
    );
  }

  if (!env.DATABASE_URL && !env.PGHOST) {
    throw new Error(
      "AUDIT_BACKEND=postgres, bet nei DATABASE_URL, nei PGHOST nenustatyti. " +
        "Eksplicitinis backend'as negali tyliai virsti atmintimi - audito " +
        "žurnalas dingtų per pirmą restartą be jokio įspėjimo."
    );
  }

  /**
   * ⚠️ `AUDIT_ID_SALT` TAMPA PRIVALOMA (#211).
   *
   * `auditLog.resolveSalt()` sąmoningai generuoja procesui lokalią atsitiktinę
   * druską, kai jos nėra. Atmintyje tai nekainuoja - žurnalas ir taip miršta su
   * procesu. Persistuojant kaina yra GDPR: po restarto ar kitoje replikoje
   * `pseudonymizeIdentifier(jobId)` duotų KITĄ reikšmę, tad
   * `removeBySubjectIdentifier()` senų įrašų NERASTŲ, ir asmens duomenų
   * ištrynimas jų nepasiektų - tyliai, grąžindamas „ištrinta 0".
   */
  if (!env.AUDIT_ID_SALT) {
    throw new Error(
      "AUDIT_BACKEND=postgres reikalauja AUDIT_ID_SALT. Be jos pseudonimai " +
        "skiriasi tarp restartų ir replikų, tad GDPR ištrynimas senų įrašų " +
        "nerastų. Sugeneruokite: openssl rand -hex 32"
    );
  }

  /**
   * ⚠️ `AUDIT_ID_SALT_ID` - OPERATORIAUS ETIKETĖ, NE IŠVESTINĖ IŠ DRUSKOS.
   *
   * `hash_key_id` yra `NOT NULL`, nes be jo 7.4c rotacija nežinotų, KURIS
   * raktas skaičiavo kurį `subject_id`, ir istoriniai įrašai taptų
   * nekoreliuojami. Etiketė sąmoningai nesusijusi su pačia druska: išvesta iš
   * jos, ji taptų orakulu druskos spėjimams tikrinti.
   */
  if (!env.AUDIT_ID_SALT_ID) {
    throw new Error(
      "AUDIT_BACKEND=postgres reikalauja AUDIT_ID_SALT_ID - operatoriaus " +
        "priskirtos etiketės dabartiniam raktui (pvz. \"2026-08\"). Be jos " +
        "vėlesnė rakto rotacija nebegalėtų atskirti, kuris raktas skaičiavo " +
        "kurį pseudonimą."
    );
  }

  /**
   * ⚠️ `PRIVACY_MODE=true` × `postgres` NEBĖRA STARTO KLAIDA (#213, 7.4d).
   *
   * ⚠️ TAI EKSPLICITINIS 7.4b (#211) SPRENDIMO ATŠAUKIMAS, NE PRALEIDIMAS.
   *
   * 7.4b šį derinį atmetė, nes tuomet jis neturėjo apibrėžtos semantikos:
   * `PRIVACY_MODE` reiškė „nerašyti", `postgres` - „saugoti patvariai", ir
   * tylus leidimas būtų davęs migruotą, amžinai tuščią lentelę, kuri stebint
   * atrodo kaip veikianti sistema. Tuo metu atsisakymas startuoti buvo
   * sąžiningesnis atsakymas.
   *
   * 7.4d tą semantiką apibrėžia: starto metu `audit_log` FIZIŠKAI išvalomas, o
   * nauji įrašai nepersistinami. Derinys nebėra prieštaringas - jis reiškia
   * „auditas išjungtas, ir tai, kas buvo surinkta, ištrinama".
   *
   * ⚠️ IR SVARBIAUSIA: SU SARGU NĖRA JOKIO PALAIKOMO BŪDO IŠTRINTI
   * PERSISTENTINIŲ AUDITO EILUČIŲ PER `PRIVACY_MODE`. Operatorius, įjungęs
   * vėliavą, negalėdavo startuoti; perjungęs `AUDIT_BACKEND=memory`, paleisdavo
   * procesą, bet DB eilutės LIKDAVO nepaliestos. Fail-fast čia saugojo ne
   * duomenis, o užrakindavo juos - priešingai, nei žada in-memory kontraktas,
   * kuris `PRIVACY_MODE` metu žada ištrynimą, ne nutildymą.
   *
   * Derinys lieka matomas: `init()` jį garsiai įspėja kiekvieno starto metu
   * (žr. `auditStore/index.js`), tad tylaus „tuščios lentelės" scenarijaus,
   * kurio 7.4b vengė, nėra.
   */

  return eksplicitinis;
}

module.exports = { ALLOWED_AUDIT_BACKENDS, resolveAuditBackend };
