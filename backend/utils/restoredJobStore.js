const { createPostgresStore } = require("./jobStore/postgresStore");

/**
 * JOB'Ų SAUGYKLA, NUKREIPTA Į ATKURTĄ BAZĘ (#155, 7.6c / #250).
 *
 * ⚠️ KODĖL ŠIS ADAPTERIS APSKRITAI EGZISTUOJA.
 *
 * `jobStore` fasadas atsako į klausimą „kur gyvena GYVI job'ai", ir šiandien jo
 * atsakymas nėra PostgreSQL: 7.2a aktyvavimo barjeras `JOB_STORE_BACKEND=postgres`
 * verčia klaida, o vien `DATABASE_URL` grąžina `memory | barjeras: true`
 * (išmatuota). Po DR atkūrimo asmens duomenys guli būtent ATKURTOJE bazėje, tad
 * replay per fasadą būtų vakuumas — `jobs` eilutės liktų, o kvitas skelbtų sėkmę.
 *
 * ⚠️ TAI NĖRA ANTRAS JOB STORE IR NĖRA ANTRAS TRYNIMAS.
 *
 * Čia nėra nė vieno savo SQL sakinio: naudojamas tas pats `createPostgresStore()`,
 * kurį naudos fasadas, kai barjeras atsidarys. Adapteris tik perrašo paviršių iš
 * plokščio (`get`/`update`/`remove`) į `system.*`, kurio tikisi `jobErasure`.
 * Trynimo semantika lieka `eraseJob()` — viena visai sistemai.
 *
 * ⚠️ KĄ ŠIS KELIAS DENGIA IR KO NEKEIČIA.
 *
 * Nukreipiama TIK įrašo vieta. Audio saugykla, BullMQ eilė ir auditas yra
 * GLOBALŪS posistemiai, ne per-bazės: `eraseJob()` juos valo tais pačiais
 * kvietimais, o `storageKey` ima iš pačios atkurtos eilutės. Todėl audio
 * objektas pasiekiamas ir pašalinamas net tada, kai job'o įrašas atkeliavo iš
 * seno snapshot'o.
 *
 * ⚠️ NEPILNAS PAVIRŠIUS ATMETAMAS ČIA IR DAR KARTĄ `eraseJob()`. Dviguba
 * patikra sąmoninga: praleistas metodas reikštų tyliai nepašalintą artefaktų
 * klasę su sėkmės kvitu, o tokio gedimo kaina yra GDPR, ne patogumas.
 */

/**
 * Metodai, kurių `jobErasure.eraseJob()` reikalauja iš `system.*`.
 *
 * ⚠️ SARGAS TIKRINA BUVIMĄ, NE ELGESĮ IR NE PARAŠĄ (§12.1). Metodo dingimą jis
 * pagauna; tai, kad metodas ims elgtis kitaip ar praras parametrą — ne. Parašo
 * pusę uždaro ne patikra, o generavimas (žr. `sukurti()`).
 */
const BUTINI = Object.freeze(["get", "update", "remove"]);

/**
 * @param {import("pg").Pool} pool atkurtos bazės pool'as
 * @returns {{system: {get: Function, update: Function, remove: Function}}}
 */
function sukurti(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("restoredJobStore: reikia atkurtos bazės pool'o.");
  }

  const store = createPostgresStore(pool);

  const truksta = BUTINI.filter((metodas) => typeof store[metodas] !== "function");
  if (truksta.length > 0) {
    throw new TypeError(
      `restoredJobStore: \`postgresStore\` neteikia \`${truksta.join("`, `")}\`. ` +
        "Paviršius pasikeitė — adapteris privalo kristi, ne praleisti artefaktų klasę."
    );
  }

  /**
   * ⚠️ METODAI GENERUOJAMI, NE RAŠOMI RANKA (Codex, #291).
   *
   * Ankstesnė redakcija juos išvardijo su fiksuotais parametrais
   * (`get: (jobId) => store.get(jobId)`), ir adapteris TYLIAI NUMESDAVO antrąjį
   * argumentą. Taip mirė `{ hydrate: false }` DR replay kelyje — bet mirtų ir bet
   * kuris BŪSIMAS parametras, nes siaurinimas yra adapterio savybė, ne vieno
   * argumento klaida.
   *
   * ⚠️ IR SARGAS ŠITO NEPAGAVO, NORS STOVI 8 EILUTĖS AUKŠČIAU. Jis tikrina METODŲ
   * VARDUS, ne parašus, tad paviršiaus pokytį mato, o parametro pokyčio — ne.
   * `Function.length` čia irgi nepadėtų: `get(id, opts = {})` turi `length === 1`,
   * kaip ir `(jobId) => ...`. Todėl taisoma ne patikra, o MECHANIZMAS: rankomis
   * neparašytas metodas negali susiaurinti to, ko neaprašo.
   */
  const system = {};
  for (const metodas of BUTINI) {
    system[metodas] = (...argumentai) => store[metodas](...argumentai);
  }

  return { system };
}

module.exports = { BUTINI, sukurti };
