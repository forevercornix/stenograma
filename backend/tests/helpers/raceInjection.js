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
 * ⚠️ ATSKIRAS MODULIS SĄMONINGAI. Taip fail-fast elgesį galima patikrinti su
 * netikru pool'u, be tikro PostgreSQL - kitaip pats sargas liktų neišbandytas.
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

    let pid = null;
    try {
      const r = await klientas.query("SELECT pg_backend_pid() AS pid");
      pid = r && r.rows && r.rows[0] ? r.rows[0].pid : null;
    } catch (e) {
      klientas.release(true);
      throw e;
    }

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
       */
    });

    try {
      const rezultatas = await Promise.race([darbas, riba]);
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
         */
        darbas.catch(() => {});
        klientas.release(true);
      }
      throw err;
    }
  };
}

module.exports = { INJEKCIJOS_RIBA_MS, sukurtiInjektoriu };
