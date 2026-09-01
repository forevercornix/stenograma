/**
 * AUDITO SAUGYKLA ATMINTYJE (#155, 7.4b / #211).
 *
 * ⚠️ TAS PATS KONTRAKTAS KAIP `postgresStore`, NE „paprastesnis variantas".
 *
 * Iki 7.4b masyvas gyveno `auditLog.js` viduje, o skaitymo ribojimą darė
 * maršrutas (`.slice()` po `getAll()`). Perkėlus ribojimą į SQL tik postgres
 * pusėje, du backend'ai imtų grąžinti skirtingus dalykus tam pačiam kvietimui:
 * memory - visą žurnalą, postgres - puslapį. Todėl riba ir filtrai taikomi
 * ABIEJUOSE, ir bendras kontrakto rinkinys tai tikrina.
 *
 * ⚠️ RETENCIJOS POLITIKA ČIA NEGYVENA, BET MECHANIZMAS - TAIP (#213, 7.4d).
 * `auditLog` retenciją masyvui taiko pats (7.4a elgesys), tačiau nuo 7.4d ši
 * saugykla turi ir bendro kontrakto dalį - `retencijosRiba()` bei
 * `purgeExpired()`, tuos pačius, ką postgres pusė. Terminą ir sweep'o ritmą
 * toliau nustato `auditLog`/`retentionSweeper`, ne saugykla.
 * Žr. `docs/audit-storage.md` §9.
 */

/** @type {object[]} įrašymo tvarka = masyvo tvarka; `seq` atitikmuo postgres pusėje. */
const { normalizuoti } = require("./fields");

const eilutes = [];

/**
 * ⚠️ `seq` LAIKOMAS ŠALIA EILUTĖS, NE JOJE (#155, 7.4c).
 *
 * Eilutės yra `Object.freeze`-intos, o jų raktų aibę valdo `fields.js` ir tikrina
 * paritetų testas - `seq` lauko į jas dėti negalima. `WeakMap` duoda tą patį
 * monotonišką raktą, kurį postgres pusėje duoda `BIGSERIAL`, ir lieka nematomas
 * per `list()`, `getAll()` bei `/api/audit` atsakymą.
 */
const seqPagalEilute = new WeakMap();
let kitasSeq = 1;

/**
 * Filtrai taikomi PRIEŠ ribojimą - kitaip `limit` reikštų skirtingus dalykus
 * su filtru ir be jo. Ta pati tvarka kaip SQL `WHERE ... LIMIT`.
 */
function filtruoti(sarasas, { event, requestId }) {
  let rezultatas = sarasas;

  if (event) rezultatas = rezultatas.filter((e) => e.event === event);
  if (requestId) rezultatas = rezultatas.filter((e) => e.requestId === requestId);

  return rezultatas;
}

const memoryStore = {
  backend: "memory",

  /**
   * ⚠️ IDEMPOTENTIŠKA PAGAL `id` - kaip ir `ON CONFLICT (id) DO NOTHING`
   * postgres pusėje (#211: at-least-once semantika).
   *
   * Be šito pakartotinis rašymas po timeout atmintyje sukurtų ANTRĄ eilutę, o
   * DB - ne, ir tas pats įvykis skirtinguose backend'uose duotų skirtingą
   * žurnalą. Divergenciją rado bendras kontrakto rinkinys, ne peržiūra.
   *
   * Linijinė paieška priimtina: atminties žurnalą riboja `AUDIT_MAX_ENTRIES`,
   * o persistentinis kelias šios šakos nenaudoja.
   */
  async append(eilute, kontekstas = {}) {
    /**
     * IŠTRYNIMO BARJERAS ATMINTINIAME BACKEND'E (#155, 7.4e / #216).
     *
     * ⚠️ NETIKRŲ `erasure_marks` ČIA NĖRA IR NEBUS. Kviečiamas TAS PATS
     * autoritetas (`utils/deletionTombstones`) - antra tiesos kopija būtų
     * tiksliai tai, ko #216 vengia.
     *
     * ⚠️ APIMTIS: `deletionTombstones` backend'ą renka pagal konfigūraciją, NE
     * pagal audito backend'ą. Be `DATABASE_URL`/`PGHOST` barjeras yra procesui
     * lokalus - ir tai priimtina, nes atmintinis auditas ir taip procesui
     * lokalus. Su jais barjeras eina į DB, nors auditas lieka atmintyje.
     *
     * ⚠️ TRANSAKCIJOS ČIA NĖRA, tad „patikrink, tada rašyk" langas lieka. Tai ta
     * pati riba, kurią įvardija `deletionTombstones` `ATMINTIES_ISPEJIMAS`, ne
     * atskiras gedimas: atmintinė saugykla neišgyvena nė restarto.
     */
    const jobId = kontekstas.jobId ?? null;

    if (jobId && eilute.subjectId) {
      const tombstones = require("../deletionTombstones");
      if (await tombstones.isBarred(jobId)) {
        const klaida = new Error(`Job ${jobId} užbarjeruotas ištrynimo žyma.`);
        klaida.code = "ERASURE_BARRIER";
        throw klaida;
      }
    }

    const esama = eilutes.find((e) => e.id === eilute.id);
    if (esama) return esama;

    /** ⚠️ Allowlist taikomas ir čia - žr. `normalizuoti()` paaiškinimą. */
    const svari = normalizuoti(eilute);

    seqPagalEilute.set(svari, kitasSeq);
    kitasSeq += 1;

    eilutes.push(svari);
    return svari;
  },

  /**
   * @returns {Promise<{entries: object[], total: number}>} `total` yra kiekis
   *   PO filtrų, bet PRIEŠ ribojimą - be jo klientas nežinotų, ar yra daugiau.
   */
  async list({ limit = null, offset = 0, event = null, requestId = null } = {}) {
    const filtruoti_ = filtruoti(eilutes, { event, requestId });
    const total = filtruoti_.length;

    const nuo = offset;
    const iki = limit === null ? undefined : offset + limit;

    // Kopijos, kad išorinis kodas nepakeistų saugomų eilučių.
    return { entries: filtruoti_.slice(nuo, iki).map((e) => ({ ...e })), total };
  },

  async removeBySubject(subjectId) {
    /** ⚠️ Priima ir masyvą - žr. `postgresStore` paaiškinimą (#212). */
    const sarasas = (Array.isArray(subjectId) ? subjectId : [subjectId]).filter(Boolean);
    if (sarasas.length === 0) return 0;

    const ieskomi = new Set(sarasas);

    let pasalinta = 0;
    for (let i = eilutes.length - 1; i >= 0; i -= 1) {
      if (ieskomi.has(eilutes[i].subjectId)) {
        eilutes.splice(i, 1);
        pasalinta += 1;
      }
    }
    return pasalinta;
  },

  /**
   * KEYSET PUSLAPIS: `seq` MAŽĖJIMO tvarka (naujausi pirma).
   *
   * ⚠️ DESC GALIOJA TIK ČIA. `list()` ir per jį `getAll()` lieka saugyklos (ASC)
   * tvarka - 7.4b paritetų rinkinys ir jo testai nekeičiami (#212).
   *
   * `limit + 1` peržvalga: `nextAfterSeq` grąžinamas tiksliai tada, kai kitas
   * puslapis realiai egzistuoja, tad tuščio paskutinio puslapio nebūna.
   */
  async queryPage({
    limit = 100,
    afterSeq = null,
    action = null,
    requestId = null,
    from = null,
    to = null,
    subjectIds = null,
  } = {}) {
    const nuo = from ? Date.parse(from) : null;
    const iki = to ? Date.parse(to) : null;
    const subjektai = subjectIds ? new Set(subjectIds) : null;

    const tinka = (e) => {
      if (action && e.event !== action) return false;
      if (requestId && e.requestId !== requestId) return false;
      if (subjektai && !subjektai.has(e.subjectId)) return false;
      if (nuo !== null || iki !== null) {
        const t = Date.parse(e.timestamp);
        if (nuo !== null && t < nuo) return false;
        if (iki !== null && t > iki) return false;
      }
      return true;
    };

    const surikiuoti = eilutes
      .filter((e) => tinka(e))
      .map((e) => ({ eilute: e, seq: seqPagalEilute.get(e) }))
      .sort((a, b) => b.seq - a.seq)
      .filter((x) => afterSeq === null || x.seq < afterSeq);

    const puslapis = surikiuoti.slice(0, limit + 1);
    const yraDaugiau = puslapis.length > limit;
    const grazinami = yraDaugiau ? puslapis.slice(0, limit) : puslapis;

    return {
      entries: grazinami.map((x) => ({ ...x.eilute })),
      nextAfterSeq: yraDaugiau ? grazinami[grazinami.length - 1].seq : null,
    };
  },

  async countBySubject(subjectId) {
    if (!subjectId) return 0;
    return eilutes.filter((e) => e.subjectId === subjectId).length;
  },

  /**
   * Retencijos riba atmintyje - iš ĮLEIDŽIAMO `now` (#233 Codex, P1).
   *
   * ⚠️ SKIRTUMAS NUO POSTGRES YRA TEISINGAS, NE NUKRYPIMAS. Atmintyje
   * `timestamp` rašo tas pats procesas, tad jo laikrodis IR YRA autoritetas;
   * #213 reikalavimas dėl kontroliuojamo laiko šaltinio čia reiškia būtent
   * įleidžiamą `now`, kurį naudoja testai. Postgres pusėje autoritetas yra DB,
   * nes ten rašymo žymą deda ji.
   */
  async retencijosRiba(dienos, now = Date.now()) {
    const skaicius = Number(dienos);

    if (!Number.isFinite(skaicius) || skaicius <= 0) {
      throw new Error(`Retencijos terminas privalo būti teigiamas (gauta: ${dienos}).`);
    }

    return new Date(now - skaicius * 24 * 60 * 60 * 1000).toISOString();
  },

  /**
   * RETENCIJA - TAS PATS KONTRAKTAS KAIP POSTGRES (#155, 7.4d / #213).
   *
   * ⚠️ RIBA GRIEŽTA IR VIENODA ABIEJUOSE BACKEND'UOSE: `< cutoff` šalinama,
   * `== cutoff` lieka. Skirtinga riba čia reikštų, kad tas pats įrašas išgyvena
   * atmintyje ir dingsta DB - tokį nukrypimą pagauna bendras paritetų rinkinys.
   *
   * ⚠️ `limit` gerbiamas, nors atmintyje jis nebūtinas. Kontraktas turi būti
   * vienodas: sweep'o ciklas nežino, kuris backend'as po juo, ir jo elgesys
   * neturi priklausyti nuo to.
   *
   * ⚠️ NETINKAMO `timestamp` eilutės ČIA NEŠALINAMOS - tai daro `auditLog`
   * atminties kelias (7.4a elgesys). Postgres pusėje `timestamp` yra `NOT NULL
   * timestamptz`, tad netinkamos reikšmės negali atsirasti, ir šis metodas
   * abiejuose backend'uose reiškia tą patį.
   */
  async purgeExpired(cutoffIso, limit = Infinity) {
    const riba = Date.parse(cutoffIso);
    if (!Number.isFinite(riba)) throw new Error(`Netinkamas retencijos cutoff: ${cutoffIso}`);

    const pasalinti = [];

    for (const eilute of eilutes) {
      if (pasalinti.length >= limit) break;

      const laikas = Date.parse(eilute.timestamp);
      if (Number.isFinite(laikas) && laikas < riba) pasalinti.push(eilute);
    }

    for (const eilute of pasalinti) {
      const vieta = eilutes.indexOf(eilute);
      if (vieta !== -1) eilutes.splice(vieta, 1);
    }

    return pasalinti.length;
  },

  /**
   * `PRIVACY_MODE` starto valymas - simetriškas postgres keliui.
   *
   * Atmintyje jis sutampa su `clear()`, bet vardas išlaikomas atskiras: sweep'o
   * ir init'o kodas neturi šakotis pagal backend'ą.
   */
  async purgeAllForPrivacy() {
    const kiek = eilutes.length;
    eilutes.length = 0;
    return kiek;
  },

  async clear() {
    eilutes.length = 0;
    /** ⚠️ `seq` NEATSTATOMAS: kursoriai iš ankstesnio rinkinio neturi netikėtai atgyti. */
  },

  /**
   * ⚠️ ATMINTIS GENERACIJŲ NETURI (#212: patikra yra postgres-only).
   *
   * `hash_key_id` atmintyje niekur nerašomas - jis egzistuoja tik persistentinėje
   * eilutėje. Tuščias sąrašas reiškia „nėra ką tikrinti", ne „nežinoma".
   */
  async usedGenerations() {
    return [];
  },

  /**
   * ⚠️ ATMINTINIAME REŽIME BARJERO LENTELĖS NĖRA IR NEREIKIA (#216).
   *
   * Metodas egzistuoja dėl KONTRAKTO PARITETO: trūkstamas metodas viename
   * backend'e reikštų, kad fasadas tyliai grįžta į atsarginį kelią.
   */
  async probeBarrier() {
    return true;
  },

  async probe() {
    return true;
  },

  async close() {
    /** Atmintis neturi ką uždaryti - metodas egzistuoja dėl kontrakto vienodumo. */
  },

  /**
   * ⚠️ TIK `auditLog` VIDINIAM ATMINTIES KELIUI (7.4a elgesys).
   *
   * Neįeina į bendrą backend'ų kontraktą - postgres pusėje masyvo atitikmens
   * nėra, o bendra retencija nuo 7.4d eina per `retencijosRiba()` ir
   * `purgeExpired()`. Eksponuojama, kad `auditLog` nelaikytų antros nuorodos.
   */
  _eilutes: eilutes,
};

module.exports = memoryStore;
