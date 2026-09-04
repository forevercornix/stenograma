const crypto = require("node:crypto");

const { kanoninisRezultatas } = require("../jobStore/common");

/**
 * `ArtifactStore` RIBOS TAISYKLĖS - VIENOS, VISIEMS BACKEND'AMS (#157, PR-2).
 *
 * ⚠️ VALIDACIJA GYVENA ČIA, NE IMPLEMENTACIJOSE.
 *
 * Kiekviena implementacija turi savo pavojų: filesystem - path traversal, objektų
 * saugykla - svetimą prefiksą, `jsonb` - NUL simbolį. Palikus patikras
 * implementacijoms, kiekviena gintų SAVO ribą, ir tas pats rezultatas vienoje
 * saugykloje būtų priimtas, kitoje - ne. Tada migracija tarp jų taptų negalima,
 * o #157 D1 (visi backend'ai duoda tą pačią kanoninę eilutę) - netiesa.
 *
 * ⚠️ AIBĖ SUSIAURINTA IKI GRIEŽČIAUSIO BACKEND'O. `fs` ir S3 techniškai
 * išsaugotų NUL simbolį, bet PostgreSQL `jsonb` jo nepriima apskritai. Riba
 * imama iš to, kuris gali mažiausiai - kitaip inline diegimas gautų rezultatą,
 * kurio niekada neatkurs.
 */

/**
 * ⚠️ `neatkartojama` — NE PATOGUMO VĖLIAVA (#157, PR-2).
 *
 * Struktūrinis atmetimas (`Date` rezultate, NUL simbolis, blogas raktas) nuo
 * kartojimo neišnyks: tas pats rezultatas bus atmestas kiekvieną kartą. Be
 * eksplicitinio ženklo BullMQ jį kartotų `attempts` kartų, o kiekvienas bandymas
 * reiškia PILNĄ transkribavimą arba LLM kvietimą iš naujo — tiksliai tai, ką
 * #153 uždarė dydžio pusėje (`workers/index.js:359-366`, `UnrecoverableError`).
 *
 * ⚠️ ŠI VĖLIAVA VIENA NIEKO NESUSTABDO. Ją privalo panaudoti completion kelias
 * (PR-4), suvyniodamas klaidą į `UnrecoverableError` — lygiai kaip
 * `assertResultWithinLimits`. Kol to nėra, ženklas yra paruošimas, ne garantija,
 * ir taip užrašytas plane.
 */
class ArtifactStoreError extends Error {
  constructor(message, code, { neatkartojama = false } = {}) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
    this.neatkartojama = neatkartojama;
  }
}

/** Struktūrinės klaidos: pakartojimas duotų tą patį rezultatą. */
function struktūrinė(message, code) {
  return new ArtifactStoreError(message, code, { neatkartojama: true });
}

/** Kontraktinės klaidos - jos yra dalis kontrakto, ne implementacijos detalė. */
const KLAIDA = Object.freeze({
  RAKTAS: "ARTIFACT_KEY_INVALID",
  REIKSME: "ARTIFACT_VALUE_UNSUPPORTED",
  NERASTA: "ARTIFACT_NOT_FOUND",
});

/**
 * ⚠️ RAKTAS TIKRINAMAS ALLOWLIST'U, NE DRAUDIMŲ SĄRAŠU.
 *
 * Draudimų sąrašas (be `..`, be `/` pradžioje) pralaimi kiekvienam naujam
 * kodavimui: `%2e%2e`, atgalinis brūkšnys, unicode variantai. Leidžiama aibė yra
 * siaura ir pakankama mūsų raktams (`results/<jobId>/<attemptId>.json`), tad
 * tikrinama ji.
 */
const LEISTINAS_SEGMENTAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_RAKTO_ILGIS = 512;

function patikrintiRakta(raktas) {
  if (typeof raktas !== "string" || raktas.length === 0) {
    throw struktūrinė("ArtifactStore: raktas privalo būti netuščia eilutė.", KLAIDA.RAKTAS);
  }

  if (raktas.length > MAX_RAKTO_ILGIS) {
    throw struktūrinė(`ArtifactStore: raktas ilgesnis nei ${MAX_RAKTO_ILGIS} simbolių.`, KLAIDA.RAKTAS);
  }

  for (const segmentas of raktas.split("/")) {
    if (!LEISTINAS_SEGMENTAS.test(segmentas)) {
      throw struktūrinė(
        `ArtifactStore: neleistinas rakto segmentas "${segmentas.slice(0, 40)}". ` +
          "Leidžiami tik [A-Za-z0-9._-], pradedant raide ar skaitmeniu.",
        KLAIDA.RAKTAS
      );
    }
  }

  return raktas;
}

/**
 * ⚠️ SERIALIZACIJA EINA PER KANONINĮ AUTORITETĄ (`common.js:731`).
 *
 * Ne dėl to, kad saugykloje privalo gulėti būtent kanoninė eilutė - fizinis
 * formatas yra implementacijos reikalas (#157 D1). Dėl to, kad `checksum` ir
 * `bytes` PRIVALO aprašyti tą patį, ką lygina idempotencijos kelias. Skaičiuoti
 * juos iš kitos reprezentacijos reikštų dvi tapatybes vienam rezultatui.
 */
const NUL_ESCAPE = "\\u0000";

function paruostiReiksme(reiksme) {
  if (reiksme === undefined) {
    throw struktūrinė("ArtifactStore: `undefined` nėra saugotina reikšmė.", KLAIDA.REIKSME);
  }

  let kanonine;
  try {
    kanonine = kanoninisRezultatas(reiksme);
  } catch (klaida) {
    throw struktūrinė(`ArtifactStore: reikšmės nepavyko kanonizuoti (${klaida.message}).`, KLAIDA.REIKSME);
  }

  if (typeof kanonine !== "string") {
    throw struktūrinė(
      "ArtifactStore: reikšmė nekanonizuojama į eilutę (funkcija, `undefined` ar simbolis).",
      KLAIDA.REIKSME
    );
  }

  /**
   * ⚠️ NUL TIKRINAMAS PO KANONIZAVIMO, NE PRIEŠ.
   *
   * Prieš jį tektų vaikščioti po visą struktūrą patiems - antra kanonizavimo
   * kopija. Po jo pakanka vienos patikros: `JSON.stringify` NUL simbolį paverčia
   * ESCAPE seka, tad ieškoma būtent jos, o ne paties simbolio.
   */
  if (kanonine.includes(NUL_ESCAPE)) {
    throw struktūrinė(
      "ArtifactStore: NUL simbolis nepalaikomas - PostgreSQL `jsonb` jo nepriima, " +
        "tad jis neįeina į bendrą backend'ų reikšmių aibę (#157 D1).",
      KLAIDA.REIKSME
    );
  }

  /**
   * ⚠️ INLINE REPREZENTACIJOS STABILUMAS - ANTRA DIVERGENCIJOS KLASĖ (#157 D1).
   *
   * ⚠️ IŠMATUOTA: `kanonizuoti()` struktūrą perrenka PATS ir kopijuoja tik
   * NUOSAVUS raktus, o `payload` į `jsonb` keliauja per `JSON.stringify`, kuris
   * kviečia `toJSON()` — dažniausiai gyvenantį PROTOTIPE:
   *
   *   kanoninė reikšmė      {"d":{}}
   *   inline saugoma        {"d":"1970-01-01T00:00:00.000Z"}
   *   perskaityta atgal     {"d":"1970-01-01T00:00:00.000Z"}
   *
   * Vadinasi visos `Date` reikšmės kanoniškai tapatingos tarpusavyje IR tuščiam
   * objektui, o po inline round-trip'o tapatybė PASIKEIČIA. Pakartotinis
   * `finish(COMPLETED)` su ta pačia įvestimi tada duotų ne no-op, o
   * `RESULT_CONFLICT` — teisėtam retry.
   *
   * ⚠️ `fs` ir S3 to NEPARODYTŲ: jie grąžina tuos pačius baitus. Todėl patikra
   * gyvena BOUNDARY, ne implementacijoje — kitaip rinkinys, žalias prieš `fs`,
   * praleistų klasę, kurią D1 ir buvo suformuluotas gaudyti.
   *
   * ⚠️ TAI INLINE KELIO MODELIS, NE PATS KELIAS. `JSON.parse(JSON.stringify(x))`
   * atkartoja `pg` serializaciją, bet NE `jsonb` normalizaciją. Šiandien jos
   * sutampa; jei kada nors nesutaps, autoritetas yra TIKRAS round-trip su PG, o
   * predikatas taisomas. Todėl jis NEPAKEIČIA inline pariteto testo — kitaip
   * atsirastų pagunda jį praleisti, nes „ties riba juk jau patikrinta".
   *
   * ⚠️ KAINA UŽRAŠOMA: viena papildoma `stringify` + `parse` + kanonizacija
   * rašymo kelyje (~2-3x CPU vienam rezultatui). Priimta, nes rezultatas
   * rašomas kartą per job'ą, o tyli divergencija kainuoja klaidą kiekviename
   * pakartojime.
   */
  /**
   * ⚠️ PATS PREDIKATAS GALI MESTI, IR TAI APDOROJAMA.
   *
   * `JSON.stringify` meta ties cikline nuoroda ir `BigInt`, o viršutinio lygio
   * `undefined` ar funkcijai grąžina `undefined` — tada `JSON.parse(undefined)`
   * duoda `SyntaxError`. Visais atvejais kvietėjas gautų SVETIMO tipo klaidą iš
   * patikros, kuri turėjo grąžinti tvarkingą atmetimą.
   */
  let inlineKanonine;
  try {
    inlineKanonine = kanoninisRezultatas(JSON.parse(JSON.stringify(reiksme)));
  } catch (klaida) {
    throw struktūrinė(
      `ArtifactStore: reikšmės nepavyko serializuoti inline keliu (${klaida.message}).`,
      KLAIDA.REIKSME
    );
  }

  if (inlineKanonine !== kanonine) {
    throw struktūrinė(
      "ArtifactStore: reikšmės tapatybė pasikeistų inline kelyje (objektas su prototipo " +
        "`toJSON`, pvz. `Date`). Tokia reikšmė skirtinguose backend'uose duotų skirtingą " +
        "kanoninę eilutę, tad atmetama ties riba (#157 D1).",
      KLAIDA.REIKSME
    );
  }

  const buferis = Buffer.from(kanonine, "utf8");

  return {
    kanonine,
    buferis,
    bytes: buferis.byteLength,
    checksum: crypto.createHash("sha256").update(buferis).digest("hex"),
  };
}

/** Reikšmės atkūrimas iš baitų - viena vieta, kad klaidos kodas būtų vienodas. */
function atkurtiReiksme(buferis, raktas) {
  try {
    return JSON.parse(buferis.toString("utf8"));
  } catch (klaida) {
    throw new ArtifactStoreError(
      `ArtifactStore: objekto "${raktas}" turinys nėra galiojantis JSON (${klaida.message}).`,
      KLAIDA.NERASTA
    );
  }
}

module.exports = {
  ArtifactStoreError,
  struktūrinė,
  KLAIDA,
  MAX_RAKTO_ILGIS,
  patikrintiRakta,
  paruostiReiksme,
  atkurtiReiksme,
};
