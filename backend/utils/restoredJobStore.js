const { createPostgresStore, KONSTRUKCIJOS_PARINKTYS } = require("./jobStore/postgresStore");

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
 *
 * ⚠️ SĄRAŠAS IMAMAS IŠ `jobErasure`, NE KARTOJAMAS (#157, PR-5).
 *
 * Iki tol čia gulėjo antra to paties sąrašo kopija, ir ji iškart atsiliko: PR-5
 * pridėjo `deleteResultArtifacts`, `jobErasure` jo pareikalavo, o adapteris liko su
 * senuoju trejetu — DR replay krito CI (`34142484397`). Tai TA PATI ketvirtojo atvejo
 * forma, kurią PR-3 uždarė generavimu: sąrašas, gyvenantis dviese, išsiskiria tyliai,
 * o kaina čia yra praleista artefaktų klasė su sėkmės kvitu.
 */
const { BUTINI_SYSTEM_METODAI: BUTINI } = require("./jobErasure");

/**
 * @param {import("pg").Pool} pool atkurtos bazės pool'as
 * @returns {{system: {get: Function, update: Function, remove: Function}}}
 */
/**
 * ⚠️ KIEKVIENA KONSTRUKCIJOS PARINKTIS TURI DEKLARUOTĄ SPRENDIMĄ (#157, PR-5; Codex #304).
 *
 * Trečias kartas iš eilės, kai šis adapteris atsiliko nuo `postgresStore`: PR-3 numesti
 * parašai, PR-5 antra būtinų metodų sąrašo kopija, dabar — saugyklos, be kurių DR replay
 * su bet kokia external eilute krenta `parinktiArtefaktuSaugykla()` viduje.
 *
 * Taškinis taisymas („perduokim ir saugyklas") uždarytų trečią atvejį ir paliktų
 * ketvirtą. Šaknis yra ta, kad adapteris STATO store'ą, tad kiekviena nauja parinktis jam
 * yra nauja skola. Struktūrinio taisymo (adapteris gauna JAU SUKONFIGŪRUOTĄ store'ą)
 * šiandien padaryti negalima: gamybinio surinkimo, iš kurio kvietėjas jį gautų, dar nėra
 * — tai PR-7 („prijungimas `initializePostgres()` viduje"). Užrašyta, o ne apeita
 * tyliai (§19.3).
 *
 * Todėl mechanizmas: aibė ateina iš `postgresStore`, o čia kiekvienas jos vardas turi
 * EKSPLICITINĮ sprendimą. Atsiradus ketvirtai parinkčiai, `sukurti()` kris — ne DR
 * replay viduryje, o konstrukcijos metu, su vardu.
 */
const PARINKCIU_SPRENDIMAI = Object.freeze({
  /** Perduodama: atkurtoje bazėje gali būti `fs` ir `s3` eilučių vienu metu. */
  artifactStores: "perduodama",
  /** Perduodama: vieno tipo saugykla yra tas pats klausimas siauresne forma. */
  artifactStore: "perduodama",
  /**
   * NEPERDUODAMA SĄMONINGAI: replay tik ŠALINA. Rašymo saugykla atkurtoje bazėje
   * reikštų, kad DR kelias gali kurti naujus artefaktus — o jis to daryti negali.
   */
  rasymoSaugykla: "nenaudojama-replay-tik-salina",
});

/**
 * NEPILNA KONFIGŪRACIJA ATMETAMA PRIEŠ PIRMĄ REPLAY ŽINGSNĮ (#157, PR-5; Codex #304).
 *
 * ⚠️ KRITIMAS VIDURYJE YRA BLOGIAUSIA IŠ TRIJŲ GALIMYBIŲ. Be šios patikros DR replay su
 * external eilute nueina iki `parinktiArtefaktuSaugykla()` ir krenta ten — dalis job'ų
 * jau apdorota, replay pažymimas kritiniu, o operatorius mato klaidą apie „neregistruotą
 * `storage_type`" viduryje procedūros, kurios apimtis jam nebeaiški.
 *
 * Patikra yra AIBIŲ palyginimas: kokių tipų eilučių bazėje YRA prieš tai, kokių saugyklų
 * adapteriui PADUOTA. Ji nieko netrina ir nieko nekeičia.
 *
 * ⚠️ `inline` NEREIKALAUJA SAUGYKLOS: turinys gyvena eilutėje ir dingsta kartu su ja.
 */
async function paruosti(pool, parinktys = {}) {
  const adapteris = sukurti(pool, parinktys);

  const { rows } = await pool.query(
    `SELECT DISTINCT storage_type FROM job_results WHERE storage_type <> 'inline'
     UNION
     SELECT DISTINCT storage_type FROM job_result_attempts`
  );

  const turimi = new Set([
    ...Object.keys((parinktys && parinktys.artifactStores) || {}),
    ...(parinktys && parinktys.artifactStore && parinktys.artifactStore.backend
      ? [parinktys.artifactStore.backend]
      : []),
  ]);

  const truksta = rows.map((r) => r.storage_type).filter((tipas) => tipas && !turimi.has(tipas));

  if (truksta.length > 0) {
    throw new TypeError(
      `restoredJobStore: atkurtoje bazėje yra \`${truksta.join("`, `")}\` eilučių, bet šioms ` +
        "saugykloms adapteris negavo. Replay pašalintų DB eilutes, o objektai liktų — " +
        "tad procedūra stabdoma PRIEŠ pirmą žingsnį, ne viduryje."
    );
  }

  return adapteris;
}

function sukurti(pool, { artifactStores = null, artifactStore = null } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("restoredJobStore: reikia atkurtos bazės pool'o.");
  }

  const nedeklaruotos = KONSTRUKCIJOS_PARINKTYS.filter((v) => !PARINKCIU_SPRENDIMAI[v]);
  if (nedeklaruotos.length > 0) {
    throw new TypeError(
      `restoredJobStore: \`postgresStore\` turi parinktis be sprendimo: \`${nedeklaruotos.join("`, `")}\`. ` +
        "Adapteris privalo pasakyti, ką su kiekviena daro — kitaip nauja parinktis tyliai " +
        "dingsta, o DR replay krenta viduryje."
    );
  }

  const store = createPostgresStore(pool, { artifactStores, artifactStore });

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

module.exports = { BUTINI, sukurti, paruosti };
