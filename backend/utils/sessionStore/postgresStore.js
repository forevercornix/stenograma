const crypto = require("crypto");

const { generateSessionToken, hashSessionToken } = require("./tokens");
const {
  idleTimeoutMs,
  absoluteTimeoutMs,
  SESSION_SCHEMA_VERSION,
  PALAIKOMOS_SCHEMA_VERSIJOS,
  palaikomaSchemaVersija,
  patikrintiTapatybe,
  NEZINOMAS_VARDAS,
} = require("./common");

/**
 * PERSISTENTINĖS SESIJOS - PostgreSQL (#155, 7.3).
 *
 * ⚠️ TAI AUTENTIKACIJOS, NE SAUGYKLOS REALIZACIJA. Kiekvienas sprendimas
 * žemiau saugo nuo konkrečios regresijos, kurią „paprastas perkėlimas" padarytų
 * formaliai teisingai: vienas `expires_at` prarastų neveiklumo langą,
 * `uuid` cookie'je nuleistų entropiją ir paverstų DB turinį paslaptimi, o
 * `findByToken()` + `touch()` seka atidarytų revokacijos TOCTOU langą.
 */

/** Sesija be stabilaus `user_id` PostgreSQL režime negalima - `user_id` yra `NOT NULL`. */
class SessionIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionIdentityError";
    this.code = "IDENTITY_UNAVAILABLE";
  }
}

const UUID_FORMA =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB eilutė → tas pats objektas, kurį grąžina atminties backend'as. */
function rowToSession(row, username) {
  return {
    id: row.id,
    userId: row.user_id,
    username,
    role: row.role,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.getTime() : null,
    expiresAt: row.expires_at.getTime(),
    idleExpiresAt: row.idle_expires_at.getTime(),
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
    schemaVersion: row.schema_version,
  };
}

function createPostgresStore(pool) {
  /**
   * ⚠️ VIENAS LAIKO ŠALTINIS: DB LAIKRODIS.
   *
   * `expires_at` ir `idle_expires_at` skaičiuojami `now() + interval`, ne
   * `Date.now()` proceso pusėje. Atominis `touch` `UPDATE` tikrina
   * `expires_at > now()` DB laikrodžiu; jei reikšmės rašomos proceso
   * laikrodžiu, tas pats sprendimas remiasi DVIEM šaltiniais, ir jų poslinkis
   * nutrauks sesijas anksčiau ar vėliau nei nustatyta, o daugiaprocesėje
   * aplinkoje - nevienodai.
   *
   * Poslinkis šiame projekte JAU pripažintas realiu: būtent dėl jo
   * `last_seen_at <= expires_at` sąmoningai nėra `CHECK`.
   */
  async function create(identity, env = process.env) {
    const userId = identity && identity.id;

    /**
     * ⚠️ FAIL-CLOSED PRIEŠ RAŠYMĄ.
     *
     * `user_id` yra `NOT NULL`, tad be stabilaus ID sesija nesukuriama. Be
     * šios patikros klaida ateitų iš draiverio kaip `not-null violation` -
     * teisingas rezultatas, bet be paaiškinimo, kodėl login'as nepavyko.
     */
    if (!userId || !UUID_FORMA.test(String(userId))) {
      throw new SessionIdentityError(
        "PostgreSQL sesijai reikalingas stabilus AUTH_USERS userId (#158); " +
          "be jo sesija nekuriama, cookie nesiunčiama, prisijungimas nesėkmingas."
      );
    }

    const token = generateSessionToken();

    const { rows } = await pool.query(
      `INSERT INTO sessions
         (id, token_hash, user_id, role, created_at,
          expires_at, idle_expires_at, last_seen_at, schema_version)
       VALUES
         ($1, $2, $3, $4, now(),
          now() + make_interval(secs => $5::double precision),
          now() + make_interval(secs => $6::double precision),
          now(), $7)
       RETURNING *`,
      [
        crypto.randomUUID(),
        hashSessionToken(token),
        userId,
        identity.role,
        absoluteTimeoutMs(env) / 1000,
        idleTimeoutMs(env) / 1000,
        SESSION_SCHEMA_VERSION,
      ]
    );

    return { session: rowToSession(rows[0], identity.username), token };
  }

  /**
   * ⚠️ AUTENTIKACIJA IR `touch()` - VIENA SĄLYGINĖ OPERACIJA.
   *
   * Draudžiamas modelis:
   *
   *   findByToken(token) → patikrinti JS → touch(token) → autorizuoti
   *
   * Tarp skaitymo ir mutacijos atsiranda revokacijos TOCTOU langas:
   * daugiaprocesėje aplinkoje vienas procesas perskaito sesiją, kitas tuo metu
   * nustato `revoked_at` (atsijungimas, administracinė revokacija, startinis
   * suderinimas), o pirmasis vis tiek autorizuoja pasenusį snapshot'ą.
   *
   * Todėl `findByToken()` šiame modulyje NEEGZISTUOJA - ne „neeksportuojamas",
   * o neparašytas. Ko nėra, to refaktoringas negali panaudoti.
   *
   * ⚠️ `schema_version` FILTRUOJAMAS SQL'e, NE PO MUTACIJOS. Nežinomo formato
   * eilutė neturi būti net paliesta: JS pusės patikra po `UPDATE` jau būtų
   * pratęsusi jos neveiklumo langą.
   */
  async function touch(token, env = process.env) {
    if (!token) return null;

    const { rows } = await pool.query(
      `UPDATE sessions
          SET last_seen_at = now(),
              idle_expires_at = now() + make_interval(secs => $2::double precision)
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND idle_expires_at > now()
          AND schema_version = ANY($3::int[])
        RETURNING *`,
      [hashSessionToken(token), idleTimeoutMs(env) / 1000, PALAIKOMOS_SCHEMA_VERSIJOS]
    );

    if (rows.length === 0) return null;
    const row = rows[0];

    /**
     * DEFENSE-IN-DEPTH, ne pagrindinis kelias: aukščiau esantis `ANY(...)`
     * nepalaikomos versijos eilutės nepaliečia. Ši patikra normalizuoja
     * reikšmę eksplicitiškai (draiveris ar atkūrimo kelias gali duoti `"1"`)
     * ir yra vienintelis kelias atminties backend'e - tad ji tikrinama, ne
     * dekoratyvi.
     */
    if (!palaikomaSchemaVersija(row.schema_version)) return null;

    /**
     * ⚠️ `AUTH_USERS` TIKRINAMA DINAMIŠKAI, NE TIK STARTE.
     *
     * Startinis suderinimas dengia TIK restartą. Vartotojas, ištrintas ar
     * pažemintas RUNTIME metu, su galiojančia sesija toliau autorizuotų
     * užklausas sena role iki kito restarto - privilegijų eskalavimas.
     *
     * ⚠️ TAI NE ANTRA SESIJŲ UŽKLAUSA. `loadUsersById()` skaito `AUTH_USERS`
     * iš aplinkos, ne iš DB, tad sėkmingas autentikacijos kelias lieka VIENA
     * sesijų užklausa. Antra užklausa vyksta TIK revokuojant - ir tai
     * mutacija, ne skaitymas.
     */
    const patikra = patikrintiTapatybe(row.user_id, row.role, env);
    if (!patikra.ok) {
      await pool.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [row.id]
      );
      return null;
    }

    return rowToSession(row, patikra.user.username || NEZINOMAS_VARDAS);
  }

  /**
   * LOGINĖ revokacija, ne fizinis `DELETE`.
   *
   * `COALESCE` čia nereikalingas - `revoked_at IS NULL` sąlyga jau užtikrina,
   * kad pirmoji revokacijos žyma nebus perrašyta vėlesne.
   */
  async function destroy(token) {
    if (!token) return false;
    const res = await pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashSessionToken(token)]
    );
    return res.rowCount > 0;
  }

  async function destroyAllForUserId(userId) {
    if (!userId) return 0;
    const res = await pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    return res.rowCount;
  }

  /**
   * ⚠️ SEMANTIKA PASIRINKTA EKSPLICITIŠKAI (#181, „destroyAllForUser").
   *
   * Produkcinis kodas šio metodo NEKVIEČIA - vieninteliai kvietėjai yra
   * `tests/authFoundation.test.js`. Tai atgalinio suderinamumo paviršius, ne
   * veikianti administracinė funkcija.
   *
   * Iš dviejų leistinų variantų pasirinktas PIRMASIS: vardas išverčiamas į
   * `user_id` per `loadUsers(env)` ir revokacija vykdoma stabiliu raktu.
   *
   * ⚠️ TYLUS `0` BŪTŲ NEGALIMAS. Jis atrodytų kaip „vartotojas neturėjo
   * sesijų", o realiai reikštų neįvykusią revokaciją - tas pats tylaus
   * nesuveikimo šablonas, kurį #155 gaudė keturis kartus. Todėl vardo, kurio
   * `AUTH_USERS` nepažįsta, atveju metama klaida, o ne grąžinamas `0`.
   */
  async function destroyAllForUser(username, env = process.env) {
    const { loadUsers } = require("../credentials");
    const user = loadUsers(env).get(String(username || "").trim().toLowerCase());
    if (!user) {
      throw new SessionIdentityError(
        `destroyAllForUser("${username}"): vardo nėra AUTH_USERS, tad jo user_id ` +
          "nežinomas. PostgreSQL režime revokacija vykdoma stabiliu raktu, o " +
          "tylus 0 atrodytų kaip įvykdyta revokacija."
      );
    }
    return destroyAllForUserId(user.userId);
  }

  /**
   * RETENCIJA - vienintelis kelias, kuriuo eilutė dingsta FIZIŠKAI.
   *
   * ⚠️ REVOKUOTA SESIJA SAUGOMA BENT IKI SAVO `expires_at`.
   * `DELETE WHERE revoked_at IS NOT NULL` būtų momentinis ištrynimas, ir
   * atsakymas „ar ši cookie buvo ATŠAUKTA, ar jos niekada nebuvo" dingtų.
   *
   * ⚠️ NEVEIKLUMO LANGAS ŠALINA TIK NEREVOKUOTAS eilutes - kitaip revokuota,
   * bet dar nepasibaigusi sesija dingtų anksčiau, nei politika leidžia.
   *
   * IDEMPOTENTINIS: antras paleidimas iš eilės pašalina 0 eilučių.
   */
  async function sweepExpired() {
    const res = await pool.query(
      `DELETE FROM sessions
        WHERE expires_at <= now()
           OR (revoked_at IS NULL AND idle_expires_at <= now())`
    );
    return res.rowCount;
  }

  /** FIZINIS eilučių skaičius - revokuotos, bet dar nepasibaigusios, matomos. */
  async function size() {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sessions`);
    return rows[0].n;
  }

  /**
   * STARTINIS SUDERINIMAS SU `AUTH_USERS`.
   *
   * ⚠️ BE JO PERSISTENCIJA YRA TYLI SAUGUMO REGRESIJA. `docs/auth-deployment.md`
   * garantuoja, kad pašalinus vartotoją iš `AUTH_USERS` ir perkrovus prieiga
   * dingsta IŠ KARTO. Sesijoms atmintyje tai galiojo savaime; persistentinė
   * sesija išgyventų restartą su SENA role.
   *
   * ⚠️ VISAS CIKLAS, NE DALINĖ BŪSENA. Nutrūkus viduryje klaida keliama į viršų
   * ir `sessionReconcile` readiness NETAMPA `true` - serveris srauto nepriima.
   * Vienos transakcijos NEREIKALAUJAMA (dideliam kiekiui ji būtų blogesnė):
   * jau atliktos revokacijos gali likti committed, nes operacija
   * IDEMPOTENTINĖ, ir pakartotinis startas saugiai užbaigia likusią dalį.
   *
   * ⚠️ KEYSET, NE `OFFSET`. Revokuotos eilutės iškrenta iš filtro, tad
   * `OFFSET` praleistų nepatikrintas - būtent tokia dalinė aprėptis atrodytų
   * kaip sėkmingas suderinimas.
   */
  async function reconcile(env = process.env, { batchSize = 500 } = {}) {
    const { loadUsersById } = require("../credentials");
    const galiojantys = loadUsersById(env);

    let paskutinis = "00000000-0000-0000-0000-000000000000";
    let revokuota = 0;
    let patikrinta = 0;

    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, user_id, role FROM sessions
          WHERE revoked_at IS NULL
            AND expires_at > now()
            AND id > $1
          ORDER BY id
          LIMIT $2`,
        [paskutinis, batchSize]
      );
      if (rows.length === 0) break;

      const revokuoti = rows
        .filter((r) => {
          const user = galiojantys.get(r.user_id);
          return !user || user.role !== r.role;
        })
        .map((r) => r.id);

      if (revokuoti.length > 0) {
        const res = await pool.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [revokuoti]
        );
        revokuota += res.rowCount;
      }

      patikrinta += rows.length;
      paskutinis = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }

    return { patikrinta, revokuota };
  }

  return {
    backend: "postgres",
    create,
    touch,
    destroy,
    destroyAllForUser,
    destroyAllForUserId,
    sweepExpired,
    size,
    reconcile,
  };
}

module.exports = { createPostgresStore, SessionIdentityError };
