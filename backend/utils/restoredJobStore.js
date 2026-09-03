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

/** Metodai, kurių `jobErasure.eraseJob()` reikalauja iš `system.*`. */
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

  return {
    system: {
      get: (jobId) => store.get(jobId),
      update: (jobId, patch) => store.update(jobId, patch),
      remove: (jobId) => store.remove(jobId),
    },
  };
}

module.exports = { BUTINI, sukurti };
