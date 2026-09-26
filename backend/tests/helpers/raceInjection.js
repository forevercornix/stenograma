/**
 * LENKTYNIŲ INJEKCIJA SU LAIKO RIBA (#180 P3-10).
 *
 * ⚠️ KODĖL RIBA APSKRITAI REIKALINGA.
 *
 * PostgreSQL CAS lenktynių testai įterpia konkurentinę mutaciją ANTRA jungtimi,
 * kol store transakcija dar atidaryta. Tai veikia TIK todėl, kad store prieš CAS
 * NEUŽRAKINA eilutės (P2-3: sąlyginė mutacija, ne `SELECT ... FOR UPDATE`).
 *
 * Jei kas nors grąžintų pesimistinį užraktą prieš CAS, injekcija užsiblokuotų
 * ties eilutės užraktu, store lauktų injekcijos, ir testas KABOTŲ iki išorinio
 * `node --test` / CI laikmačio. CI parodytų tik „timeout" - be jokios nuorodos
 * į regresijos vietą. Todėl injekcija turi SAVO ribą ir krinta greitai su
 * tikslia diagnostika.
 *
 * ⚠️ UŽSTRIGUSI UŽKLAUSA REALIAI NUTRAUKIAMA. `pg_cancel_backend()` siunčia
 * signalą blokuotam backend'ui, tad užklausa nutrūksta (SQLSTATE 57014), o
 * jungtis sunaikinama. Be to blokuota užklausa laikytų event loop'ą gyvą, ir
 * kabojimas tik persikeltų iš testo į proceso pabaigą.
 *
 * ⚠️ ATSKIRAS MODULIS SĄMONINGAI, IR FAIL-FAST ELGSENA TIKRINAMA (#412).
 *
 * Iki #412 čia stovėjo teiginys, kad elgseną „galima patikrinti su netikru pool'u" —
 * ketinimas, užrašytas kaip savybė (§12.1). Testo nebuvo, o šio sargo gedimas yra
 * TYLUS: su `unref()`, su per ilga riba arba su kabančiu valymu visos trys būsenos
 * atrodo vienodai, kol regresijos nėra.
 *
 * Dabar tikrina `tests/lenktyniuInjekcija.test.js` — izoliuotuose vaikiniuose
 * procesuose, su netikru pool'u, be PostgreSQL. Trys savybės, trys atskiri parašai,
 * kiekviena su savo mutacija.
 */

/** Riba parinkta gerokai virš normalaus vykdymo (~ms) ir gerokai žemiau CI ribos. */
const INJEKCIJOS_RIBA_MS = 5000;

/**
 * @param {() => object} gautiPool - pool'o tiekėjas (testuose jis priskiriamas
 *   tik `before` metu, tad reikšmė imama tingiai).
 * @param {number} [ribaMs]
 */
function sukurtiInjektoriu(gautiPool, ribaMs = INJEKCIJOS_RIBA_MS) {
  return async function injekcijaSuRiba(sql, params, kontekstas) {
    const pool = gautiPool();
    const klientas = await pool.connect();

    /**
     * ⚠️ PREAMBULĖ RIBOS NETURI, IR TAI SĄMONINGAS KOMPROMISAS (#412).
     *
     * `SELECT pg_backend_pid()` vykdoma PRIEŠ laikmatį, tad žemiau esanti riba jos
     * nedengia. Neribotas kelias atrodo kaip spraga, tad priežastis užrašoma čia —
     * kitaip kitas skaitytojas spręs iš naujo. Du IŠMATUOTI ramsčiai:
     *
     *   1. `pg_backend_pid()` NEIMA JOKIO UŽRAKTO ir neliečia nė vienos lentelės.
     *      Eilutės užraktas — vienintelė regresija, dėl kurios šis sargas egzistuoja —
     *      jos blokuoti negali.
     *   2. `pool.connect()`, einantis dar anksčiau ir būtų DIDESNĖ spraga, jau
     *      ribotas: vartotojas kuria pool'ą per `stebetiPoola`, o šis nustato
     *      `connectionTimeoutMillis = 5000`, jei jo nėra
     *      (`resourceStack.js:194–195`, #380). Pool'o išsekimas baigiasi įvardytu
     *      kritimu, ne amžinu laukimu.
     *
     * Ribos plėtimas čia reikštų antrą laikmatį keliui, kuris dėl ginamos regresijos
     * užstrigti negali.
     */
    let pid = null;
    try {
      const r = await klientas.query("SELECT pg_backend_pid() AS pid");
      pid = r && r.rows && r.rows[0] ? r.rows[0].pid : null;
    } catch (e) {
      klientas.release(true);
      throw e;
    }

    /**
     * ⚠️ SĖKMĖS ŠAKOS PRISKYRIMAS YRA SIMETRINIS/GYNYBINIS, BE STEBIMO EFEKTO.
     *
     * Išmatuota (#412): jį pašalinus rezultatas nepasikeičia — sėkmės kelyje `catch`
     * nevykdomas, tad `baigta` niekas neskaito. Todėl jo NEDENGIA joks testas, ir tai
     * ne praleidimas. Klaidos šakos priskyrimas, priešingai, yra reikšmingas: be jo
     * įprasta SQL klaida nukeliautų į griežtą šaką (`pg_cancel_backend` +
     * `release(true)`) — tą dengia `lenktyniuInjekcija` klaidos kontrolė.
     */
    let baigta = false;
    const darbas = Promise.resolve(klientas.query(sql, params)).then(
      (r) => { baigta = true; return r; },
      (e) => { baigta = true; throw e; }
    );

    let laikmatis;
    const riba = new Promise((_, reject) => {
      laikmatis = setTimeout(
        () => reject(new Error(
          `race injection blocked before CAS after ${ribaMs} ms [${kontekstas}]: ` +
          "pessimistic row lock likely reintroduced - the store must NOT hold a row " +
          "lock while the competing mutation is injected (#180 P2-3/P3-10)"
        )),
        ribaMs
      );
      /**
       * ⚠️ BE `unref()`. Su juo laikmatis nelaikytų event loop'o gyvo, ir jei
       * blokuota užklausa loop'o nelaiko (pvz. netikras pool'as), procesas
       * baigtųsi anksčiau, nei riba suveiktų - sargas tyliai nesuveiktų.
       * `clearTimeout()` iškviečiamas ABIEJUOSE keliuose, tad laikmatis
       * neprailgina normalaus vykdymo.
       *
       * ⚠️ TIKRINAMA, NE TIK APRAŠYTA (#412): `lenktyniuInjekcija` matuoja VAIKO
       * gyvavimo trukmę — pridėjus `unref()` procesas baigiasi prieš ribą ir
       * laukiama diagnostika NEATVYKSTA. Tai vienintelė iš trijų savybių, kurios
       * gedimas nieko nesulaužo viduje, tad įrodymas gyvena tėviniame procese.
       */
    });

    try {
      const rezultatas = await darbas; /* MUTACIJA M1 (#412): riba pašalinta */
      clearTimeout(laikmatis);
      klientas.release();
      return rezultatas;
    } catch (err) {
      clearTimeout(laikmatis);
      if (baigta) {
        klientas.release();
      } else {
        /** Nutraukiam blokuotą backend'ą, kad nei testas, nei procesas nekabotų. */
        if (pid != null) {
          await pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
        }
        /**
         * ⚠️ UŽSTRIGUSIOS UŽKLAUSOS NELAUKIAM. `await darbas` čia reikštų, kad
         * valymas pats gali kaboti amžinai (jei nutraukimas nesuveikė) - t. y.
         * tiksliai tas gedimas, kurio ši riba turi išvengti. Pakanka pridėti
         * tuščią `catch`, kad nebūtų `unhandledRejection`, ir sunaikinti jungtį.
         *
         * ⚠️ TIKRINAMA `lenktyniuInjekcija` (#412). Išmatuota, kad `await darbas`
         * čia NEKABO: išvalius laikmatį niekas event loop'o nebelaiko ir procesas
         * tyliai baigiasi. Todėl testo parašas yra `release(true)` NEBUVIMAS po
         * `pg_cancel_backend`, o ne kabėjimas — pastarojo laukdami nieko negautume.
         */
        darbas.catch(() => {});
        klientas.release(true);
      }
      throw err;
    }
  };
}

module.exports = { INJEKCIJOS_RIBA_MS, sukurtiInjektoriu };
