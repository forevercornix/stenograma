const {
  ArtifactStoreError,
  KLAIDA,
  patikrintiRakta,
  paruostiReiksme,
  patikrintiPersistuotaReiksme,
  nesancioVerdiktas,
  vientisumoVerdiktas,
} = require("./validation");
const { kanoninisRezultatas } = require("../jobStore/common");

/**
 * `InlineArtifactStore` - rezultatas `job_results.payload` stulpelyje (#157, PR-2).
 *
 * ⚠️ TAI ESAMAS ELGESYS, APRENGTAS KONTRAKTU, NE NAUJA SAUGYKLA. Turinys ir
 * toliau guli `jsonb` stulpelyje, kaip iki #157; keičiasi tik tai, kad jis
 * pasiekiamas per tą patį `ArtifactStore` paviršių kaip `fs` ir S3.
 *
 * ⚠️ ADRESAS YRA JOB'O TAPATYBĖ, NE KELIAS.
 *
 * Eilutė turi `PRIMARY KEY (job_id)` ir FK į `jobs`, tad išgalvotas kelio formos
 * raktas čia apskritai neįrašomas. Todėl inline raktas YRA `job_id` - ir būtent
 * dėl to kontrakto rinkinys raktų gamybą paveda backend'ui.
 *
 * ⚠️ `reference` VISADA `null`.
 *
 * `job_results_storage_shape` reikalauja, kad inline eilutėje `storage_key` būtų
 * `NULL`. Grąžinus adresą kaip nuorodą, pirmas kvietėjas, kuris ją persistintų,
 * gautų `23514`. Adresas ir nuoroda čia iš principo skirtingi - žr. `fsStore.js`.
 *
 * ⚠️ `bytes` IR `checksum` IŠVEDAMI, NE SAUGOMI.
 *
 * Inline eilutė jų neturi (invariantas reikalauja tik external šakoje), tad jie
 * skaičiuojami iš perskaitytos reikšmės. Iš to seka, kad `verify()` čia lygina
 * reikšmę SU SAVIMI - `nepriklausomas: false`. Tai kita garantija nei external
 * atveju, ir 7.6 restore verifikacija privalo tą skirtumą matyti.
 */

function createInlineArtifactStore({ vykdytojas } = {}) {
  if (!vykdytojas || typeof vykdytojas.query !== "function") {
    throw new ArtifactStoreError(
      "InlineArtifactStore: reikia DB kliento arba pool'o.",
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  /**
   * ⚠️ NE-UUID ADRESAS YRA „NĖRA", NE KLAIDA (Codex, #290).
   *
   * `job_id` yra `uuid`, tad užklausa su `"nesantis"` mestų žalią `22P02`.
   * Bet tas pats raktas `fs` ir S3 atveju yra GALIOJANTIS - tiesiog be objekto.
   * Grąžindamas rakto ar DB klaidą, inline išskirtų save tam pačiam įėjimui, ir
   * bendras kontrakto rinkinys nustotų būti vykdomas vienodai.
   *
   * ⚠️ FORMA TIKRINAMA PRIEŠ UŽKLAUSĄ, ne per implicit cast: taip klaida
   * neatsiranda išvis, o ne gaudoma po fakto pagal SQLSTATE.
   */
  const UUID_FORMA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * ⚠️ TA PATI RAKTO VALIDACIJA KAIP VISUR. Inline raktas yra `job_id`, tad
   * kelio pavojų čia nėra - bet riba viena visiems, kitaip du backend'ai
   * priimtų skirtingas aibes (žr. `validation.js`).
   */
  async function eilute(raktas) {
    patikrintiRakta(raktas);

    if (!UUID_FORMA.test(raktas)) return null;

    const { rows } = await vykdytojas.query(
      "SELECT payload FROM job_results WHERE job_id = $1 AND storage_type = 'inline'",
      [raktas]
    );

    return rows[0] || null;
  }

  function matmenys(reiksme) {
    const kanonine = kanoninisRezultatas(reiksme);
    const buferis = Buffer.from(kanonine, "utf8");
    return { kanonine, buferis, bytes: buferis.byteLength };
  }

  async function put(raktas, reiksme) {
    patikrintiRakta(raktas);

    /**
     * ⚠️ RAŠANT FORMA PRIVALO BŪTI TEISINGA. Skaitymo pusėje ne-UUID reiškia
     * „nėra", bet rašymas į tokį adresą yra kvietėjo klaida: inline adresas YRA
     * job'o tapatybė, ir tylus praleidimas paslėptų, kad rezultatas niekur
     * nenukeliavo.
     */
    if (!UUID_FORMA.test(raktas)) {
      throw new ArtifactStoreError(
        `InlineArtifactStore: adresas "${raktas}" nėra job'o tapatybė (UUID).`,
        KLAIDA.RAKTAS
      );
    }

    const paruosta = paruostiReiksme(reiksme);

    /**
     * ⚠️ RAŠOMA RIBOS PARUOŠTA EILUTĖ, NE ANTRA SERIALIZACIJA (Codex, #290).
     *
     * Ankstesnė redakcija čia iš naujo kvietė `JSON.stringify(reiksme)`, ir tai
     * buvo VIENINTELĖ vieta, kur `checksum` galėjo aprašyti ne tai, kas įrašyta:
     * tarp ribos skaičiavimo ir šios eilutės reikšmė spėja pasikeisti (getter'is,
     * `toJSON` su būsena), o kvitas apie tai nieko nežino. Būtent tuo kvitu
     * remiasi 7.6 vientisumo patikra ir PR-4 idempotencijos fast-path.
     *
     * ⚠️ TAI NEKEIČIA `jsonb` TURINIO. Kanoninė eilutė nuo `JSON.stringify`
     * skiriasi tik raktų tvarka, o `jsonb` jos nesaugo (`common.js:731`) — tad
     * produkcinis kelias lieka tas pats, kaip `upsertResult()`, o vienintelis
     * pokytis yra tas, kad serializacija įvyksta VIENĄ kartą.
     */
    await vykdytojas.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())
       ON CONFLICT (job_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [raktas, paruosta.kanonine]
    );

    return { key: raktas, reference: null, bytes: paruosta.bytes, checksum: paruosta.checksum };
  }

  async function read(raktas) {
    const rasta = await eilute(raktas);

    if (!rasta) {
      throw new ArtifactStoreError(`InlineArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
    }

    /**
     * ⚠️ `jsonb` EILUTĖ YRA TOKS PAT NEPATIKIMAS TURINYS KAIP FAILAS (Codex, #290).
     *
     * `fs` ir S3 skaitymas praeina bendrą reikšmių sritį, o inline grąžindavo
     * `payload` tiesiai. Schemą tenkinantis, bet srities neatitinkantis turinys —
     * pvz. viršutinio lygio `null`, likęs po migracijos ar rankinio taisymo —
     * viename diegime tapdavo `ARTIFACT_CORRUPT`, o kitame „galiojančiu rezultatu".
     *
     * Literalus `null` čia ypač brangus: jis atkuria „`completed` be rezultato"
     * būseną, kurią rašymo sargas ir uždarė. `payload` yra `NOT NULL`, tad SQL
     * `NULL` čia neateina — bet `jsonb` reikšmė `'null'` yra visiškai teisėta
     * stulpeliui ir NETEISĖTA rezultatui.
     *
     * ⚠️ TAISYKLĖ NEDUBLIUOJAMA: kviečiama TA PATI ribos funkcija, kurią naudoja
     * baitų kelias — tik be UTF-8 ir `JSON.parse` pakopų, kurių `jsonb` nereikia.
     */
    return patikrintiPersistuotaReiksme(rasta.payload, raktas);
  }

  async function head(raktas) {
    const rasta = await eilute(raktas);
    if (!rasta) return null;

    /** Dydis IŠVEDAMAS iš perskaitytos reikšmės - stulpelyje jo nėra. */
    return { exists: true, bytes: matmenys(rasta.payload).bytes };
  }

  async function readStream(raktas) {
    const reiksme = await read(raktas);
    const { Readable } = require("node:stream");

    /**
     * ⚠️ SRAUTAS ČIA YRA FORMA, NE OPTIMIZACIJA. `jsonb` stulpelis skaitomas
     * vienu gabalu - to nepakeisi. Kontraktas reikalauja srauto, kad kvietėjo
     * kodas būtų vienodas visiems backend'ams; inline atveju jis tiesiog
     * neduoda atminties naudos, ir tai užrašyta, o ne nutylėta.
     */
    return Readable.from([matmenys(reiksme).buferis]);
  }

  async function verify(raktas, laukiama = {}) {
    const rasta = await eilute(raktas);
    if (!rasta) return nesancioVerdiktas(false);

    /**
     * ⚠️ SUGADINTAS PERSISTUOTAS TURINYS YRA SUGADINIMAS IR ČIA (Codex, #290).
     *
     * `paruostiReiksme()` yra RAŠYMO pusės riba: netinkamai reikšmei ji meta
     * `ARTIFACT_VALUE_UNSUPPORTED`, t. y. „šio rezultato išsaugoti negalima". Bet
     * `verify()` skaito tai, kas JAU guli lentelėje, ir ta pati eilutė per `read()`
     * jau klasifikuojama kaip `ARTIFACT_CORRUPT`.
     *
     * Dviguba semantika tam pačiam faktui siųstų remontą klaidinga kryptimi:
     * operatorius tikrintų tiekėjo rezultatą, nors taisyti reikia eilutę. Todėl
     * pirmiausia taikoma TA PATI persistuoto turinio patikra kaip `read()`, ir tik
     * po jos išvedami matmenys.
     */
    patikrintiPersistuotaReiksme(rasta.payload, raktas);

    const { bytes, checksum } = paruostiReiksme(rasta.payload);

    /**
     * ⚠️ `nepriklausomas: false` - LYGINAMA REIKŠMĖ SU SAVIMI.
     *
     * Nepriklausomo metaduomens nėra: `bytes` ir `checksum` ką tik išvesti iš to
     * paties `payload`. Palyginimas su `laukiama` vis tiek prasmingas (jis
     * pagauna, jei kvietėjo lūkestis kilo iš KITOS reikšmės), bet objekto
     * vientisumo jis NEĮRODO. Vėliava tai pasako garsiai.
     */
    return vientisumoVerdiktas({ laukiama, bytes, checksum, nepriklausomas: false });
  }

  async function del(raktas) {
    patikrintiRakta(raktas);

    if (!UUID_FORMA.test(raktas)) return false;

    const { rowCount } = await vykdytojas.query(
      "DELETE FROM job_results WHERE job_id = $1 AND storage_type = 'inline'",
      [raktas]
    );

    /** `false` = eilutės NEBUVO. Ta pati semantika kaip `fs` (7.6c pamoka). */
    return rowCount > 0;
  }

  /**
   * STARTO PATIKRA — SĄMONINGAI TUŠČIA, IR TAI UŽRAŠOMA (Codex, #290).
   *
   * ⚠️ TUŠČIA NE DĖL TO, KAD PAMIRŠTA. Inline saugykla neturi savo išorinio
   * resurso: lentelę ir jungtį valdo `jobStore` sluoksnis, o vykdytojo buvimas
   * patikrintas konstruktoriuje. Papildoma užklausa čia reikštų antrą schemos
   * autoritetą.
   *
   * ⚠️ METODAS VIS TIEK EGZISTUOJA, nes factory laukia jo VISIEMS backend'ams.
   * Sąlyginis „jei backend'as turi patikrą" reikštų, kad naujas backend'as be jos
   * praslystų tyliai — o būtent taip `fs` fail-fast ir liko nekviečiamas.
   */
  async function patikrintiSaugykla() {
    return { backend: "inline", isorinioResurso: false };
  }

  return { backend: "inline", put, read, readStream, head, verify, delete: del, patikrintiSaugykla };
}

module.exports = { createInlineArtifactStore };
