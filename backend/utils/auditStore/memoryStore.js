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
 * ⚠️ RETENCIJA ČIA NEGYVENA. `auditLog` ją taiko masyvui pats (7.4a elgesys);
 * persistentinės retencijos savininkas yra 7.4d. Skirtumas SĄMONINGAS ir
 * dokumentuotas - žr. `docs/audit-storage.md`.
 */

/** @type {object[]} įrašymo tvarka = masyvo tvarka; `seq` atitikmuo postgres pusėje. */
const { normalizuoti } = require("./fields");

const eilutes = [];

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
  async append(eilute) {
    const esama = eilutes.find((e) => e.id === eilute.id);
    if (esama) return esama;

    /** ⚠️ Allowlist taikomas ir čia - žr. `normalizuoti()` paaiškinimą. */
    const svari = normalizuoti(eilute);

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
    if (!subjectId) return 0;

    let pasalinta = 0;
    for (let i = eilutes.length - 1; i >= 0; i -= 1) {
      if (eilutes[i].subjectId === subjectId) {
        eilutes.splice(i, 1);
        pasalinta += 1;
      }
    }
    return pasalinta;
  },

  async countBySubject(subjectId) {
    if (!subjectId) return 0;
    return eilutes.filter((e) => e.subjectId === subjectId).length;
  },

  async clear() {
    eilutes.length = 0;
  },

  async probe() {
    return true;
  },

  async close() {
    /** Atmintis neturi ką uždaryti - metodas egzistuoja dėl kontrakto vienodumo. */
  },

  /**
   * ⚠️ TIK `auditLog` VIDINEI RETENCIJAI IR RIBOJIMUI (7.4a elgesys).
   *
   * Neįeina į bendrą backend'ų kontraktą: postgres pusėje retencijos savininkas
   * yra 7.4d. Eksponuojama, kad `auditLog` nelaikytų antros masyvo nuorodos.
   */
  _eilutes: eilutes,
};

module.exports = memoryStore;
