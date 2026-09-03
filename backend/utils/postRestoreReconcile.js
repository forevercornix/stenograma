const { Pool } = require("pg");

const { arNurodytaPostgres, arTaPatiBaze, tapatybesTekstas, pgJungtiesNustatymai } = require("./pgConnection");
const { createPostgresStore } = require("./jobStore/postgresStore");
const sesijuPg = require("./sessionStore/postgresStore");
/**
 * ⚠️ `postgresStore`, NE FASADAS - IR TAI REPO UŽRAŠYTA TAISYKLĖ.
 *
 * `deletionTombstones/index.js:443` aiškina spąstus: fasado `assertNotBarred()`
 * daro `ensureInit()`, kuris jungiasi pagal `process.env`, o perduotas klientas
 * gali priklausyti KITAI bazei - #183 taip ir krito. Kvietėjui, kuris jau turi
 * klientą, skirta `assertNotBarredWithClient()`. Čia klientas yra mūsų
 * transakcija, tad naudojamas būtent tas kelias.
 */
const { assertNotBarredWithClient } = require("./deletionTombstones/postgresStore");
const auditWrite = require("./auditWrite");
const { selectBackend } = require("./jobStore/backendSelection");
const { resolveSessionBackend } = require("./sessionStore/backendSelection");
const { createLogger } = require("./logger");

const log = createLogger("post-restore-reconcile");

/**
 * POST-RESTORE APLIKACINIS SUDERINIMAS (#155, 7.6b / #249).
 *
 * Grandinės vieta: 7.6a „saugiai atkurk DB" -> ČIA „dar offline padaryk atkurtą
 * aplikacinę būseną saugią" -> 7.6c „pritaikyk po snapshot'o įvykusius
 * ištrynimus" -> tik tada startas ir cutover.
 *
 * ⚠️ KĄ ŠIS MODULIS DARO IR KO NEDARO.
 *
 * Daro DU dalykus vienoje transakcijoje: revokuoja VISAS atkurtas sesijas ir
 * terminalizuoja `queued`/`processing` job'us. Nedaro NIEKO daugiau - jokio
 * eilių replay, jokio ištrynimų replay, jokio job'ų PRIKĖLIMO. Prikelti job'ą
 * galima tik žinant, kad jo duomenys neištrinti, o tai yra 7.6c klausimas.
 *
 * ⚠️ KODĖL SAVO POOL'AS, O NE FASADAI.
 *
 * D4 reikalauja VIENOS transakcijos abiem dalykams. `jobStore` ir `sessionStore`
 * fasadai turi po savo pool'ą, tad dvi jungtys transakcijos dalytis negali.
 * Sprendimas: kiekviena saugykla duoda operaciją, priimančią SVETIMĄ klientą
 * (`terminalizuotiNeTerminaliniusWithClient`, `revokeAllActiveWithClient`,
 * `assertNotBarredWithClient`), o transakcijos ribas valdo ŠIS modulis - vienas,
 * kuris mato abu dalykus. Semantika lieka savo moduliuose; čia tik ribos.
 *
 * ⚠️ POOL'AS STATOMAS IŠ TOS PAČIOS APLINKOS KAIP FASADŲ (`pgJungtiesNustatymai`),
 * tad tapatumas yra PAGAL KONSTRUKCIJĄ. Perduotas `--target` NENAUDOJAMAS
 * jungtis - jis tik TIKRINAMAS prieš tą aplinką (D7a). Saugyklų perkonfigūravimas
 * pagal svetimą URL atmestas: bendrame procese jos perimtų globalią būseną.
 */

class ReconcileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}

/** Audito įvykis - registruotas `utils/auditEvents.js`, antro mechanizmo nekuriama (D8). */
const AUDITO_IVYKIS = "POST_RESTORE_RECONCILED";

/** `error_code`, kurį gauna terminalizuoti job'ai - matomas ir operatoriui, ir DB. */
const TERMINALIZAVIMO_KODAS = "POST_RESTORE_TERMINALIZED";

const TERMINALIZAVIMO_ZINUTE =
  "Job'as nutrūko duomenų bazės atkūrimo metu ir buvo terminalizuotas " +
  "post-restore suderinimo (7.6b). Vykdymas neatnaujinamas.";

/**
 * APLIKACIJOS AUTORITETAS KIEKVIENAI AŠIAI (#280 peržiūra, P1).
 *
 * ⚠️ `DATABASE_URL` BUVIMAS NĖRA BACKEND'O SPRENDIMAS.
 *
 * Sargas tikrino tik jungties nustatymus, o aplikacija saugyklas renkasi kitaip:
 *
 *   selectBackend({DATABASE_URL})            -> { norimas: "memory", barjeras: true }
 *   selectBackend({DATABASE_URL, REDIS_URL}) -> { norimas: "redis",  barjeras: true }
 *   resolveSessionBackend({DATABASE_URL})    -> "memory"
 *
 * `POSTGRES_AKTYVAVIMAS_LEISTAS = false` reiškia, kad job'ų autoritetas ŠIANDIEN
 * niekada nėra PostgreSQL. Vadinasi `verify` galėjo pasakyti „galima cutover",
 * kai gyva būsena yra kitur — o Redis atveju ne terminaliniai job'ai po starto
 * ATSINAUJINA. Tai tas pats „sėkmingas praleidimas", kurio D7 neleidžia, tik
 * barjero, ne atminties režime.
 *
 * ⚠️ GRIEŽTAS YRA VERDIKTAS, NE KOMANDA.
 *
 * Reikalauti `SESSION_STORE_BACKEND=postgres` būtų per stipru: atmintinės sesijos
 * restarto NEIŠGYVENA, tad atkūrimas jų prikelti negali — revokacija ten
 * NEREIKALINGA, o ne „praleista". Tylėti apie Redis job'us būtų per silpna.
 * Todėl kiekviena ašis įvardijama atskirai:
 *
 *   `suderinta`    - autoritetas PostgreSQL: darbas atliktas ir skaitosi į „saugu";
 *   `nereikalinga` - autoritetas atmintyje: prikelti nėra ko;
 *   `nepadengta`   - autoritetas Redis: gyva būsena LIEKA ten ir po starto grįš.
 *
 * ⚠️ DARBAS ATLIEKAMAS ABIEM AŠIMS NEPRIKLAUSOMAI NUO VERDIKTO. Atkurtoje bazėje
 * likusios `queued` eilutės ir neatšauktos sesijos taps gyvos tą dieną, kai
 * atsidarys 7.2a barjeras arba `SESSION_STORE_BACKEND` taps `postgres`. Verdiktas
 * atsako į klausimą „ar dabar saugu", ne „ar buvo dirbta".
 */
const VERDIKTAS = Object.freeze({
  SUDERINTA: "suderinta",
  NEREIKALINGA: "nereikalinga",
  NEPADENGTA: "nepadengta",
});

function _asiesVerdiktas(autoritetas) {
  if (autoritetas === "postgres") return VERDIKTAS.SUDERINTA;
  if (autoritetas === "redis") return VERDIKTAS.NEPADENGTA;
  return VERDIKTAS.NEREIKALINGA;
}

function nustatytiAsis(env = process.env) {
  const jobai = selectBackend(env);

  return {
    sesijos: {
      autoritetas: resolveSessionBackend(env),
      verdiktas: _asiesVerdiktas(resolveSessionBackend(env)),
    },
    jobai: {
      autoritetas: jobai.norimas,
      barjeras: Boolean(jobai.barjeras),
      verdiktas: _asiesVerdiktas(jobai.norimas),
    },
  };
}

/** Ar visos ašys arba suderintos, arba įrodomai neprikeliamos? */
function arSaugu(asys) {
  return [asys.sesijos, asys.jobai].every((a) => a.verdiktas !== VERDIKTAS.NEPADENGTA);
}

/**
 * FAIL-CLOSED SARGAI PRIEŠ PIRMĄ MUTACIJĄ (D7, D7a).
 *
 * ⚠️ ATMINTINIS BACKEND'AS IR SVETIMA BAZĖ - DVI SKIRTINGOS KLAIDOS.
 *
 * Jos reiškia skirtingus operatoriaus veiksmus: pirmuoju atveju suderinimas
 * apskritai neturi kur įvykti (ir „sėkmingas praleidimas" leistų manyti, kad
 * įvyko), antruoju - jis įvyktų ne toje bazėje. 7.6a ta pati pora išmokta
 * brangiai: `PG_BACKUP_HORIZON_NOT_PERSISTENT` ir `PG_BACKUP_SOURCE_MISMATCH`.
 */
function patikrintiSargus(targetUrl, env) {
  if (!targetUrl) {
    throw new ReconcileError("Nenurodytas `--target` (atkurtos bazės URL).", "RECONCILE_NO_TARGET");
  }

  if (!arNurodytaPostgres(env)) {
    throw new ReconcileError(
      "Saugyklos nėra PostgreSQL režime (`DATABASE_URL`/`PGHOST` nenurodyti). " +
        "Post-restore suderinimas yra PostgreSQL atkūrimo procedūros dalis: atmintiniame " +
        "režime jis formaliai įvyktų ir dingtų procesui pasibaigus.",
      "RECONCILE_BACKEND_NOT_POSTGRES"
    );
  }

  /**
   * ⚠️ DVIPRASMIŠKA KONFIGŪRACIJA — SAVAS KODAS, NE „nesutapimas".
   *
   * `DATABASE_URL` ir `PG*` kartu reiškia, kad klausimas „ta pati bazė?" atsakymo
   * neturi, o ne kad atsakymas neigiamas. Operatoriaus veiksmas kitoks: pašalinti
   * vieną formą, ne taisyti `--target`.
   */
  let palyginimas;
  try {
    palyginimas = arTaPatiBaze(targetUrl, env);
  } catch (klaida) {
    if (klaida.code === "PG_CONNECTION_AMBIGUOUS") {
      throw new ReconcileError(klaida.message, "RECONCILE_CONNECTION_AMBIGUOUS");
    }
    throw klaida;
  }

  const { sutampa, nurodyta, konfiguracija } = palyginimas;
  if (!sutampa) {
    throw new ReconcileError(
      `Nurodyta bazė (${tapatybesTekstas(nurodyta)}) nesutampa su ta, prie kurios ` +
        `prisirišusios saugyklos (${tapatybesTekstas(konfiguracija)}). Suderinimas paliestų ` +
        "ne tą bazę, kurią ką tik atkūrėte.",
      "RECONCILE_TARGET_MISMATCH"
    );
  }

  return { tapatybe: tapatybesTekstas(konfiguracija) };
}

function _pool(env) {
  return new Pool({
    ...pgJungtiesNustatymai(env),
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS) || 5000,
    max: 1,
  });
}

/**
 * Tombstone barjeras kaip PRALEIDIMO predikatas (D5).
 *
 * ⚠️ SPRENDIMĄ PRIIMA BARJERAS, NE MŪSŲ `SELECT`.
 *
 * Sava užklausa į ištrynimo žymų lentelę būtų antra jų interpretacija — ir ją
 * gaudo repo tripwire'as („VIENAS AUTORITETAS", `erasureMarks.test.js`), kuris
 * komentarų sąmoningai nevalo. Čia kviečiamas tas pats `assertNotBarredWithClient()`, kurį
 * naudoja fasadas, ir jo `ERASURE_BARRIER` reiškia „praleisti". Tylaus apėjimo
 * nėra: praleisti job'ai grąžinami vardais ir patenka į evidenciją.
 *
 * ⚠️ KODĖL PRALEIDŽIAMA, NE TERMINALIZUOJAMA. Rašymas į įrašą, kurio ištrynimas
 * jau pretenduotas, yra tiksliai tai, ką barjeras draudžia. Tokie job'ai lieka
 * 7.6c, kur ištrynimai ir pritaikomi.
 */
async function _arUzbarjeruotas(client, jobId) {
  try {
    await assertNotBarredWithClient(client, jobId);
    return false;
  } catch (klaida) {
    if (klaida && klaida.code === "ERASURE_BARRIER") return true;
    throw klaida;
  }
}

/**
 * Vienas loginis fail-closed suderinimas (D4).
 *
 * @returns {{tapatybe: string, sesijos: number, jobai: object, nieko: boolean}}
 */
async function suderinti({ targetUrl, actor = null, env = process.env } = {}) {
  const { tapatybe } = patikrintiSargus(targetUrl, env);

  /**
   * ⚠️ AŠYS NUSTATOMOS PRIEŠ TRANSAKCIJĄ (#280, II raundas).
   *
   * `nustatytiAsis()` gali MESTI: `JOB_STORE_BACKEND=postgres` su uždarytu 7.2a
   * barjeru yra konfigūracijos klaida, ne įspėjimas. Kviečiant po `COMMIT`, ta
   * klaida atsidurdavo `catch` bloke, `ROLLBACK` vėluodavo (commit'as jau
   * įvykęs), auditas būdavo praleistas, o CLI grąžindavo 2 — t. y.
   * **commit'intas, neaudituotas darbas, praneštas kaip nesėkmė.**
   *
   * Konfigūracijos klaidos privalo kristi ten pat, kur ir kiti sargai: prieš
   * pirmą mutaciją.
   */
  const asys = nustatytiAsis(env);

  const pool = _pool(env);
  const jobStore = createPostgresStore(pool);
  const jobPhase = require("./jobPhase");

  let rezultatas;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /**
     * ⚠️ SESIJOS PIRMOS, IR TAI NE ATSITIKTINUMAS. Jei transakcija nutrūktų po
     * job'ų, bet prieš sesijas, rollback vis tiek grąžintų viską - bet tvarka
     * skaitoma kaip prioritetas: pavojingiausia atkurtos būsenos dalis yra
     * gyvos sesijos, kurios autentifikuoja SENUS cookie.
     */
    const revokuota = await sesijuPg.revokeAllActiveWithClient(client);

    const jobai = await jobStore.atkurimas.terminalizuotiNeTerminaliniusWithClient(client, {
      jobPhase,
      extra: { error: TERMINALIZAVIMO_ZINUTE, error_code: TERMINALIZAVIMO_KODAS },
      praleisti: _arUzbarjeruotas,
    });

    await client.query("COMMIT");
    rezultatas = { tapatybe, sesijos: revokuota, jobai, asys };
  } catch (klaida) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* jungtis jau nutrūkusi - pirminė klaida svarbesnė */
    }
    throw klaida;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }

  /**
   * ⚠️ EVIDENCIJA TIK PO COMMIT (D8). Audito rašymas transakcijos viduje
   * reikštų, kad rollback ištrina ir įrašą apie tai, kad buvo bandyta - bet
   * blogiau: nepavykęs suderinimas paliktų įrašą „suderinta". Kategoriją
   * (blokuojantis / ne) nustato `utils/auditEvents.js`, ne šis kvietimas.
   */
  await auditWrite.rasytiAudita({
    event: AUDITO_IVYKIS,
    success: true,
    actor: actor || undefined,
    details:
      `db=${rezultatas.tapatybe} sesijos=${rezultatas.sesijos} ` +
      `jobai=${rezultatas.jobai.terminalizuota}/${rezultatas.jobai.rasta} ` +
      `praleista=${rezultatas.jobai.praleista.length} ` +
      `verdiktas.sesijos=${rezultatas.asys.sesijos.verdiktas} ` +
      `verdiktas.jobai=${rezultatas.asys.jobai.verdiktas}`,
  });

  const nieko = rezultatas.sesijos === 0 && rezultatas.jobai.rasta === 0;

  log.info("Post-restore suderinimas baigtas", {
    stage: "post_restore_reconciled",
    sesijos: rezultatas.sesijos,
    terminalizuota: rezultatas.jobai.terminalizuota,
    praleista: rezultatas.jobai.praleista.length,
    nieko,
  });

  return { ...rezultatas, nieko };
}

/**
 * VERIFIKACIJA - atskiras žingsnis prieš startą (D1, D2a).
 *
 * ⚠️ TAI PROCEDŪRINĖS RIBOS MAŠININĖ DALIS, NE INVARIANTAS. Ji atsako
 * „ar ši bazė suderinta", bet niekas nesustabdo operatoriaus, paleidusio
 * serverį jos nepaleidus - riba užrašyta runbook'e ir ataskaitoje (D2).
 *
 * ⚠️ UŽBARJERUOTI JOB'AI NĖRA NESUDERINIMAS. Jie sąmoningai palikti 7.6c, tad
 * verifikacija juos ATSKIRIA: `neterminalus` sąrašas rodo tik tuos, kuriuos
 * suderinimas privalėjo paliesti.
 */
async function patikrinti({ targetUrl, env = process.env } = {}) {
  const { tapatybe } = patikrintiSargus(targetUrl, env);

  const pool = _pool(env);
  const jobStore = createPostgresStore(pool);
  const client = await pool.connect();

  try {
    const aktyviosSesijos = await sesijuPg.countActiveWithClient(client);
    const neterminalus = await jobStore.atkurimas.skaiciuotiNeTerminaliniusWithClient(client);

    const uzbarjeruoti = [];
    for (const id of neterminalus) {
      /**
       * ⚠️ SKAITYMO KELYJE BARJERAS TIKRINAMAS SAVO TRANSAKCIJOJE.
       * `assertNotBarredWithClient()` ima `pg_advisory_xact_lock`, o be
       * transakcijos toks užraktas atsilaisvintų iškart - patikra liktų
       * formaliai teisinga, bet be užrakto prasmės.
       */
      await client.query("BEGIN");
      try {
        if (await _arUzbarjeruotas(client, id)) uzbarjeruoti.push(id);
      } finally {
        await client.query("COMMIT");
      }
    }

    const nesuderinti = neterminalus.filter((id) => !uzbarjeruoti.includes(id));

    const asys = nustatytiAsis(env);

    /**
     * ⚠️ „SAUGU" REIKALAUJA DVIEJŲ DALYKŲ, NE VIENO.
     *
     * Tuščia bazės pusė nieko nereiškia, jei tos ašies gyvas autoritetas yra
     * kitur: Redis job'ai lieka nepaliesti ir po starto atsinaujins. Todėl
     * nepadengta ašis NEGALI virsti „saugu su išnaša" — ji duoda atskirą
     * atsakymą, kurį CLI paverčia savo exit kodu.
     */
    return {
      tapatybe,
      aktyviosSesijos,
      nesuderinti,
      uzbarjeruoti,
      asys,
      duomenysSutvarkyti: aktyviosSesijos === 0 && nesuderinti.length === 0,
      suderinta: aktyviosSesijos === 0 && nesuderinti.length === 0 && arSaugu(asys),
    };
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

module.exports = {
  ReconcileError,
  AUDITO_IVYKIS,
  TERMINALIZAVIMO_KODAS,
  TERMINALIZAVIMO_ZINUTE,
  VERDIKTAS,
  nustatytiAsis,
  arSaugu,
  patikrintiSargus,
  suderinti,
  patikrinti,
};
