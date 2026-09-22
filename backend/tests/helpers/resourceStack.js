/**
 * RESURSŲ KRŪVA ADAPTERIŲ PARUOŠIMUI (#180 P2-A).
 *
 * ⚠️ PROBLEMA: `setup()` KRENTA PO DALIES RESURSŲ SUKŪRIMO.
 *
 * Kontrakto vykdytojas turi formą
 *
 *     const ctx = await adapter.setup();
 *     try { ... } finally { await ctx.cleanup(); }
 *
 * Jei `setup()` meta PRIEŠ grąžindamas `ctx`, išorinis `finally` NIEKADA
 * neįvykdomas, o `setup()` jau galėjo sukurti admin `Pool`'ą, laikiną duomenų
 * bazę ir darbinį `Pool`'ą. Jie nutekėtų: `pg` pool laiko event loop'ą gyvą,
 * tad `node --test` procesas nebesibaigtų, o laikina DB liktų serveryje.
 *
 * ⚠️ NUOSAVYBĖ TEN, KUR RESURSAS SUKURIAMAS. Kvietėjas negali sutvarkyti to,
 * ko niekada negavo, todėl atsakomybė lieka `setup()` viduje: kiekvienas
 * resursas registruojamas IŠ KARTO po sukūrimo, ir klaidos atveju krūva
 * išvyniojama atvirkštine tvarka.
 *
 * ⚠️ NUO #380 ŠI KRŪVA YRA VIENINTELIS `pg` GYVAVIMO CIKLO AUTORITETAS.
 *
 * Iki tol repo turėjo DU mechanizmus: šitą (nuosavybė kūrimo vietoje, išvyniojimas
 * atvirkštine tvarka) ir #351 helper'į `isipareigojimoTvora` faile (ribotas uždarymas
 * plius nutekėjusio kliento tvirtinimas). Nė vienas atskirai nedengė viso: šiam trūko
 * LAIKO RIBOS (`isvalyti()` laukė `pool.end()` neribotai, o nutekėjęs klientas jo
 * niekada neišsprendžia), anam — nuosavybės registro ir dalinio `setup()` apsaugos.
 *
 * Sujungta ČIA, nes registro kontraktas turi ŠEŠIS vartotojus, o riba yra jo `isvalyti()`
 * detalė: `registruoti()`/`kiek()`/`isvalyti()` parašai nepakito, o laiko riba virsta
 * valymo nesėkme — tai kategorija, kuriai vieta (`klaida.valymoKlaidos`) jau buvo.
 *
 * ⚠️ VALYMAS NEUŽDENGIA PIRMINĖS KLAIDOS. Pirminė `setup()` klaida visada
 * metama toliau; valymo nesėkmės kaupiamos `klaida.valymoKlaidos` masyve, kad
 * liktų matomos, bet nepakeistų diagnozės.
 */

/**
 * Apvalkalas, garantuojantis, kad veiksmas įvyks NE DAUGIAU nei kartą.
 *
 * Būtinas todėl, kad sėkmės kelias kai kuriuos resursus uždaro iš karto
 * (pvz. admin `Pool` po DB sukūrimo), o krūva juos vis tiek turi - `pg`
 * `pool.end()` iškviestas antrą kartą grąžina atmestą Promise.
 */
function vienaKarta(veiksmas) {
  let atlikta = false;
  return async () => {
    if (atlikta) return false;
    atlikta = true;
    await veiksmas();
    return true;
  };
}

/**
 * D5 — VIENO UŽDARYMO LAIKO RIBA.
 *
 * ⚠️ TAI NE TA PATI RIBA KAIP `run-tests.mjs` (120 s). Ten ribojamas VISAS failas,
 * čia — vienas `pool.end()`. Sveikas uždarymas trunka milisekundes: `pool.end()`
 * laukia tik kol laisvi klientai atsijungs. 10 s yra trys eilės dydžio atsargos, ir
 * jos viršijimas reiškia tik vieną dalyką — kažkas negrąžino kliento.
 */
const UZDARYMO_RIBA_MS = 10_000;

/**
 * ⚠️ VIENA REALIZACIJA, TRYS ĮĖJIMO TAŠKAI (#380 D4).
 *
 * `stebetiPoola` + `uzdarytiPoola` yra mechanizmas; `registruotiPoola` (krūvoje) ir
 * `poolasTestui` (testo kontekste) — tik jo apvalkalai. Trijų įėjimo taškų reikia ne
 * dėl skonio: repo `pg` pool'ai gyvena trimis skirtingais gyvavimo ciklais — krūvoje
 * (`setup()`/`cleanup()`), per testą (`t.after`) ir per vieną `try/finally` bloką, —
 * ir jų suvienodinimas reikštų perrašyti testus, kurie apie šį PR nieko nežino.
 *
 * ❌ TAI NĖRA TREČIAS MECHANIZMAS: riba, nutraukimas ir klaidų apskaita gyvena
 * VIENOJE vietoje žemiau, o apvalkalai tik nurodo, KADA ją paleisti.
 */
const stebimi = new WeakMap();

/**
 * D5 — KIEK LAUKTI LAISVO KLIENTO (#380, po M1 diagnozės).
 *
 * ⚠️ IŠMATUOTA, NE SPĖTA. Žaliame run'e (`35651144332`) `registryErasure.integration`
 * su ~77 testais ir šimtais užklausų trunka **2 s** — vadinasi vienas checkout su
 * prisijungimu kainuoja milisekundes. 5 s yra tris eilės dydžio atsarga.
 *
 * ⚠️ BE ŠIOS REIKŠMĖS POOL'O IŠSEKIMAS YRA AMŽINAS LAUKIMAS, IR TAI IŠMATUOTA
 * ŠALTINYJE. `pg-pool@3.14.0`: numatytasis `max` yra 10 (`index.js:89`), o pilname
 * pool'e be `connectionTimeoutMillis` užklausa dedama į `_pendingQueue` BE jokio
 * laikmačio (`:206–208`); laikmatis kuriamas tik tada, kai reikšmė nustatyta (`:218`).
 * Todėl M1 (run `35663397047`) `registryErasure` baigėsi ne `POOL_CLOSE_TIMEOUT` per
 * 10 s, o `FILE_TIMEOUT` per 120 s: nutekėję klientai užėmė visus slotus, ir kitas
 * `pool.query()` TESTO KŪNE laukė amžinai — teardown'o iki jo net nebuvo pasiekta.
 */
const CHECKOUT_RIBA_MS = 5_000;

/** `pg` tekstas, kurį grąžina `connect()` išsekus pool'ui (`pg-pool` `:223`). */
const PG_CHECKOUT_TIMEOUT = /timeout exceeded when trying to connect/i;

function testoFailas() {
  const a = process.argv.find((x) => typeof x === "string" && x.endsWith(".test.js"));
  return a ? a.slice(a.lastIndexOf("/") + 1) : "(nežinomas failas)";
}

/**
 * LENKTYNĖS, KURIOS ATŠAUKIA PRALAIMĖJUSĮ LAIKMATĮ.
 *
 * ⚠️ `Promise.race` PATS NIEKO NENUTRAUKIA. Sveikai užsidarius pool'ui laikmatis lieka
 * gyvas ir laiko event loop'ą, kol suveiks. Išmatuota: be atšaukimo backend job'as
 * užtruko **9 min 25 s** (run `35658701601`) vietoj ~5 min — testai tie patys, laukė
 * tik procesas, po ~10 s kiekviename faile.
 *
 * ⚠️ `unref()` ČIA NETINKA, IR TAI IRGI IŠMATUOTA. Jis laikmatį padaro nematomą event
 * loop'ui, tad procesas išeina NELAUKĘS nė tyčinio laukimo — `resursuKruva` testai,
 * tikrinantys būtent ribos suveikimą, tada nebeišvedami išvis.
 *
 * @returns {Promise<"OK"|"TIMEOUT">}
 */
function lenktynesSuRiba(zadas, ms) {
  let laikmatis;
  const riba = new Promise((r) => {
    laikmatis = setTimeout(() => r("TIMEOUT"), ms);
  });
  return Promise.race([zadas.then(() => "OK", () => "OK"), riba]).finally(() =>
    clearTimeout(laikmatis)
  );
}

/**
 * Prikabina `'error'` klausytoją kiekvienam pool'o klientui ir pradeda apskaitą.
 *
 * ⚠️ KABINAMA KŪRIMO METU, NE UŽDARYMO. `pg-pool@3.14.0` PAIMTAM klientui savo
 * klausytoją nuima (`index.js:344`), tad vėliau prikabinti jau nebėra kur: klaida
 * kyla ant kliento, kurio niekas nebeseka, ir `EventEmitter` verčia tai neperimta
 * išimtimi.
 */
function stebetiPoola(pool, { vardas = "pool", dsn } = {}) {
  if (stebimi.has(pool)) return pool;
  const busena = { vardas, dsn, tikros: [], valymo: [], valyme: false };
  stebimi.set(pool, busena);

  /**
   * ⚠️ IŠSEKIMAS PRIVALO BŪTI ĮVARDYTAS, NE AMŽINAS. `connectionTimeoutMillis`
   * nustatomas po konstrukcijos sąmoningai: `connect()` jį skaito KVIETIMO metu
   * (`pg-pool` `:206`, `:225`), tad kvietėjams nereikia nieko keisti. Jei kvietėjas jį
   * jau nurodė — nepaliečiam: tai jo matavimo dalis.
   */
  if (pool.options && !pool.options.connectionTimeoutMillis) {
    pool.options.connectionTimeoutMillis = CHECKOUT_RIBA_MS;
  }

  /**
   * ⚠️ `pg` PRANEŠIMAS („timeout exceeded when trying to connect") NEPASAKO NIEKO
   * NAUDINGO: nei kuris pool'as, nei kuriame faile, nei kiek klientų paimta. Čia jis
   * verčiamas į `POOL_EXHAUSTED` su visu tuo. `pool.query()` irgi eina per `connect()`
   * (`pg-pool` `query()` → `this.connect(...)`), tad vienos vietos pakanka abiem.
   */
  const originalusConnect =
    typeof pool.connect === "function" ? pool.connect.bind(pool) : null;
  const paversti = (err) => {
    if (!err || !PG_CHECKOUT_TIMEOUT.test(err.message || "")) return err;
    /**
     * ⚠️ RIBA IMAMA IŠ POOL'O, NE IŠ KONSTANTOS. Kvietėjas gali būti nurodęs savą
     * (`auditPersistence` „išsekęs pool'as" testas naudoja 300 ms), ir pranešimas,
     * skelbiantis mūsų numatytąją, meluotų apie tai, ką ką tik išmatavo.
     *
     * ⚠️ ORIGINALUS `pg` TEKSTAS IŠSAUGOMAS. Jis yra vienintelis dalykas, kurį atpažįsta
     * jau esantys tvirtinimai ir operatoriaus atmintis; nauja informacija PRIDEDAMA,
     * o ne keičia jį.
     */
    const riba = (pool.options && pool.options.connectionTimeoutMillis) || CHECKOUT_RIBA_MS;
    const naujas = new Error(
      `POOL_EXHAUSTED ${vardas} (${testoFailas()}): ${err.message} — per ${riba} ms negauta ` +
        `laisvo kliento (max=${pool.options && pool.options.max}, ` +
        `paimta=${pool.totalCount - pool.idleCount}, laukia=${pool.waitingCount}). ` +
        "Kažkas paima klientus ir nepadaro `release()`."
    );
    naujas.code = "POOL_EXHAUSTED";
    naujas.cause = err;
    return naujas;
  };
  if (originalusConnect) pool.connect = function (cb) {
    if (typeof cb === "function") {
      return originalusConnect((err, klientas, done) => cb(paversti(err), klientas, done));
    }
    return originalusConnect().catch((err) => {
      throw paversti(err);
    });
  };

  pool.on("connect", (client) =>
    client.on("error", (err) => {
      const irasas = `${vardas}: ${err && err.code ? err.code : "?"}`;
      if (busena.valyme) busena.valymo.push(irasas);
      else busena.tikros.push(irasas);
    })
  );
  return pool;
}

/**
 * RIBOTAS UŽDARYMAS — VIENINTELĖ VIETA, KUR TAI DAROMA (#380 D3a, D6, D7).
 *
 * ⚠️ `pool.end()` PAŽADO NELAUKIAMA NERIBOTAI. `pg-pool` jį išsprendžia tik kai
 * `_clients` tuščias (`index.js:140`), o negrąžinto kliento iš ten niekas nešalina
 * (`_remove` pasiekiamas tik per `idleListener` `:59` arba `release()` `:397/:404/:413`).
 * Laukimas būtų neribotas PAGAL KONSTRUKCIJĄ, ne dėl lėto tinklo.
 */
async function uzdarytiPoola(pool) {
  const busena = stebimi.get(pool) || { vardas: "pool", tikros: [], valymo: [] };

  const baigta = await lenktynesSuRiba(pool.end(), UZDARYMO_RIBA_MS);

  let ribaVirsyta = false;
  if (baigta === "TIMEOUT") {
    ribaVirsyta = true;
    busena.valyme = true;
    try {
      if (busena.dsn) {
        const { Client } = require("pg");
        const c = new Client({ connectionString: busena.dsn });
        await c.connect().catch(() => {});
        await c
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`
          )
          .catch(() => {});
        await c.end().catch(() => {});
      }
    } finally {
      busena.valyme = false;
    }
  }

  /**
   * ⚠️ D7: TIKROS JUNGČIŲ KLAIDOS YRA GEDIMAS, NE FONAS. Jei jungtis nutrūko NE per
   * šio helper'io valymą, ją nutraukė kažkas kitas — testas, DB restartas ar
   * operatorius. Atskiriama pagal ŽYMĘ, nustatytą prieš mūsų pačių
   * `pg_terminate_backend`, o ne pagal pranešimo tekstą: teksto filtras
   * (`/Connection terminated/`) paslėptų IDENTIŠKĄ tikrą gedimą.
   */
  const priezastys = [];
  if (ribaVirsyta) {
    priezastys.push(
      `POOL_CLOSE_TIMEOUT ${busena.vardas}: \`pool.end()\` nebaigė per ${UZDARYMO_RIBA_MS} ms ` +
        `(paimta klientų: ${pool.totalCount - pool.idleCount}, laukia: ${pool.waitingCount}). ` +
        "Kažkas paėmė klientą ir nepadarė `release()`."
    );
  }
  if (busena.tikros.length > 0) {
    priezastys.push(`CONNECTION_ERROR (ne valymo) ${busena.vardas}: ${busena.tikros.join(", ")}`);
  }
  if (priezastys.length > 0) throw new Error(priezastys.join(" | "));
}

/** D7 diagnostikai: klaidos, kurias sukėlė pats valymas (jos NĖRA gedimas). */
function poolKlaidos(pool) {
  const b = stebimi.get(pool);
  return b ? { tikros: [...b.tikros], valymo: [...b.valymo] } : { tikros: [], valymo: [] };
}

function sukurtiResursuKruva() {
  const irasai = [];

  /**
   * ⚠️ D7: KLAUSYTOJAS REGISTRUOJA, NE PRARYJA.
   *
   * Registruotiems pool'ams kiekvienam klientui kabinamas `'error'` klausytojas. Jis
   * reikalingas dviem dalykams, ir tik vienas iš jų yra kosmetinis:
   *
   *   1. be jo `pg-pool` PAIMTAS klientas klaidų klausytojo NETURI (`pg-pool@3.14.0`,
   *      `index.js:344` — `_acquireClient` jį nuima), tad nutraukus backend'ą
   *      `EventEmitter` verčia tai neperimta išimtimi ir procesas krenta;
   *   2. klaida yra DUOMUO: jei jungtis nutrūko ne per mūsų valymą, tai tikras gedimas,
   *      ir jis privalo būti matomas.
   *
   * ⚠️ ŽYMĖS LANGAS YRA SIAURAS, IR TAI SVARBU: tikra klaida, pataikiusi į priverstinio
 * valymo langą, būtų klasifikuota kaip valymo — bet tas langas atsidaro tik po
 * `UZDARYMO_RIBA_MS`, kai failas jau krenta, tad paslėpti jame nebėra ko.
 *
 * ⚠️ ATSKIRIAMA PAGAL ŽYMĘ, NE PAGAL PRANEŠIMĄ. `valyme` nustatoma PRIEŠ šios krūvos
   * pačios `pg_terminate_backend` ir nuimama po jo. Filtras pagal tekstą
   * (`/Connection terminated/`) atrodytų lygiavertis, bet paslėptų IDENTIŠKĄ tikrą
   * gedimą — testą, kuris pats nutraukia backend'ą, arba DB, kuri nukrito darbo metu.
   */
  return {
    /**
     * Registruoja jau SUKURTĄ resursą. Kviesti iš karto po sukūrimo.
     *
     * ⚠️ GRĄŽINA UŽDARYMO RANKENĄ, IR TAI SVARBU.
     *
     * Kai kuriuos resursus sėkmės kelias uždaro ANKSTI (pvz. admin `Pool`
     * nebereikalingas iš karto po `CREATE DATABASE`). Uždarius juos TIESIOGIAI
     * (`admin.end()`), krūva apie tai nesužino: `vienaKarta()` skaičiuoja tik
     * per JĄ einančius kvietimus, tad `isvalyti()` vėliau iškviestų `end()`
     * ANTRĄ kartą. Tikras `pg.Pool` tokiu atveju meta
     * „Called end on pool more than once".
     *
     * Todėl ankstyvas uždarymas privalo eiti per ŠIĄ rankeną - tada nuosavybė
     * lieka viena, o `isvalyti()` tampa tuščiu veiksmu.
     *
     * @returns {() => Promise<boolean>} `true` - uždaryta dabar, `false` - jau
     *   buvo uždaryta anksčiau.
     */
    registruoti(kas, veiksmas) {
      const uzdaryti = vienaKarta(veiksmas);
      irasai.push({ kas, veiksmas: uzdaryti });
      return uzdaryti;
    },

    /** Kiek resursų šiuo metu laikoma (diagnostikai ir testams). */
    kiek() {
      return irasai.length;
    },

    /**
     * REGISTRUOJA `pg.Pool` SU RIBOTU UŽDARYMU IR KLAIDŲ APSKAITA (#380 D3a, D6, D7).
     *
     * ⚠️ NAUDOTI VIETOJ `registruoti("pool", () => pool.end())`. Pastarasis uždarymą
     * palieka neribotą, o būtent jis ir kabo, kai klientas negrąžintas.
     *
     * @param {import("pg").Pool} pool
     * @param {{vardas: string, dsn?: string}} o `dsn` reikalingas tik tada, kai riba
     *   viršyta: tada atskira jungtis nutraukia likusius tos bazės backend'us, kad
     *   sokai užsidarytų ir event loop atsilaisvintų.
     */
    registruotiPoola(pool, { vardas, dsn } = {}) {
      stebetiPoola(pool, { vardas, dsn });
      return this.registruoti(vardas || "pool", () => uzdarytiPoola(pool));
    },

    /** Kiek pool'o klientų šiuo metu PAIMTA (dokumentuoti skaitikliai, ne `_`-laukai). */
    paimtuKlientu(pool) {
      return pool.totalCount - pool.idleCount;
    },

    /**
     * NUTEKĖJIMO TVIRTINIMAS — SKIRTUMAS PRIEŠ / PO, NE ABSOLIUTI LYGYBĖ (#351 precedentas).
     *
     * Absoliuti `totalCount === idleCount` neteisinga: testas gali pats teisėtai laikyti
     * klientą paimtą, ir tvirtinimas kristų be jokios regresijos.
     *
     * @returns {(assert: object) => void} tikrinimas, kviečiamas PO matuojamo veiksmo
     */
    matuotiNutekejima(pool, kontekstas) {
      const pries = this.paimtuKlientu(pool);
      return (assert) => {
        const po = this.paimtuKlientu(pool);
        assert.equal(
          po,
          pries,
          `POOL_LEAK ${kontekstas}: klientas paimtas ir negrąžintas ` +
            `(paimta prieš=${pries}, po=${po}). \`release()\` praleidžiamas kuriame nors kelyje?`
        );
        assert.equal(pool.waitingCount, 0, `POOL_WAITING ${kontekstas}: pool'e liko laukiančių`);
      };
    },

    /**
     * Išvynioja krūvą ATVIRKŠTINE tvarka. Naudojama ir klaidos, ir sėkmės
     * (`cleanup()`) keliuose, tad valymo logika yra VIENA.
     *
     * @param {Error} [klaida] - pirminė klaida, jei valoma po nesėkmės.
     */
    async isvalyti(klaida) {
      const eile = irasai.splice(0, irasai.length).reverse();
      const nesekmes = [];
      for (const { kas, veiksmas } of eile) {
        try {
          await veiksmas();
        } catch (e) {
          nesekmes.push(`${kas}: ${e.message}`);
        }
      }
      /**
       * ⚠️ D7: TIKROS JUNGČIŲ KLAIDOS YRA GEDIMAS, NE FONAS. Jei jungtis nutrūko NE per
       * šios krūvos valymą, tai reiškia, kad ją nutraukė kažkas kitas — testas, DB
       * restartas ar operatorius. Praryti tai reikštų, kad sargas mato tik savo paties
       * triukšmą.
       */
      if (nesekmes.length === 0) return;
      if (klaida) {
        klaida.valymoKlaidos = (klaida.valymoKlaidos || []).concat(nesekmes);
        return;
      }
      throw new Error(`resursų valymas nepavyko: ${nesekmes.join("; ")}`);
    },
  };
}

/**
 * VIENAS KVIETIMO TAŠKAS TESTAMS — `pool` plius jo gyvavimo ciklas (#380 D1).
 *
 * ⚠️ TAI NE TREČIAS MECHANIZMAS, O TO PATIES SUTRUMPINIMAS. Visa logika lieka krūvoje;
 * čia tik surišama trejybė, kuri kitaip kartotųsi 20+ failų: sukurti pool'ą,
 * užregistruoti jį krūvoje ir pakabinti išvyniojimą ant testo pabaigos.
 *
 * ⚠️ `t.after` META, JEI VALYMAS NEPAVYKO. Būtent to ir reikia: nutekėjęs klientas
 * privalo baigtis KRITUSIU testu su vardu, ne tyliu 20 min job timeout'u.
 *
 * @param {object} t         `node:test` konteksto objektas
 * @param {{dsn: string, vardas?: string, Pool?: Function}} o
 * @returns {{pool: object, kruva: object}}
 */
function poolasTestui(t, { dsn, vardas = "darbinis", Pool } = {}) {
  const kruva = sukurtiResursuKruva();
  const Konstruktorius = Pool || require("pg").Pool;
  const pool = new Konstruktorius({ connectionString: dsn });
  kruva.registruotiPoola(pool, { vardas, dsn });
  t.after(() => kruva.isvalyti());
  return { pool, kruva };
}

module.exports = { sukurtiResursuKruva, vienaKarta, poolasTestui, stebetiPoola, uzdarytiPoola, poolKlaidos };
