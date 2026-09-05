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
  /**
   * ⚠️ `cause` YRA DERINIMO GRANDINĖ, NE ŽURNALO LAUKAS (Codex, #290).
   *
   * Originali klaida (parserio, SDK ar failų sistemos) gali nešti artefakto turinio
   * fragmentą. Ji išsaugoma, nes be jos derinimas su debugger'iu tampa spėliojimu —
   * bet automatinis jos serializavimas grąžintų tą patį turinį į logus pro kitas
   * duris. Todėl kvietėjai logguoja TIK kodą ir saugius metaduomenis
   * (`jobRunner._classifyError`).
   */
  constructor(message, code, { neatkartojama = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
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
  /**
   * ⚠️ SUGADINTAS NĖRA NERASTAS (Codex, #290).
   *
   * „Nėra objekto" siunčia remontą į ATKŪRIMĄ iš atsarginės kopijos; „turinys
   * neperskaitomas" reiškia, kad objektas YRA vietoje, ir ten reikia vientisumo
   * tyrimo. Vienas kodas abiem verstų operatorių ieškoti to, kas guli po ranka.
   */
  SUGADINTAS: "ARTIFACT_CORRUPT",
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

/**
 * ⚠️ SEGMENTAS RIBOJAMAS BAITAIS, NE SIMBOLIAIS (Codex, #290).
 *
 * Failų sistemos vieno vardo riba (`NAME_MAX`) ext4, XFS ir APFS yra 255 BAITAI.
 * Riba, matuojanti tik bendrą rakto ilgį, praleisdavo 256 baitų segmentą, kurį
 * `fs` backend'as atmesdavo žaliu `ENAMETOOLONG` — t. y. raktas buvo teisėtas
 * kontrakte ir neįmanomas vienoje jo implementacijoje. Ta pati klasė kaip NUL: aibė
 * imama iš to backend'o, kuris gali MAŽIAUSIA.
 *
 * ⚠️ BAITAI, NE `length`. Lietuviški rašmenys UTF-8 užima po du baitus, tad
 * simboliais matuojanti riba 255 „simbolių" segmentą paverstų 400+ baitų vardu.
 * (Šiandien allowlist'as daugiabaičių simbolių neleidžia, bet riba neturi
 * priklausyti nuo kito sargo formos.)
 */
const MAX_SEGMENTO_BAITAI = 255;

function patikrintiRakta(raktas) {
  if (typeof raktas !== "string" || raktas.length === 0) {
    throw struktūrinė("ArtifactStore: raktas privalo būti netuščia eilutė.", KLAIDA.RAKTAS);
  }

  if (raktas.length > MAX_RAKTO_ILGIS) {
    throw struktūrinė(`ArtifactStore: raktas ilgesnis nei ${MAX_RAKTO_ILGIS} simbolių.`, KLAIDA.RAKTAS);
  }

  for (const segmentas of raktas.split("/")) {
    if (Buffer.byteLength(segmentas, "utf8") > MAX_SEGMENTO_BAITAI) {
      throw struktūrinė(
        `ArtifactStore: rakto segmentas ilgesnis nei ${MAX_SEGMENTO_BAITAI} baitai. ` +
          "Failų sistemos vieno vardo riba yra 255 baitai, tad ilgesnio segmento " +
          "`fs` backend'as išsaugoti negalėtų (#157 D1).",
        KLAIDA.RAKTAS
      );
    }

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
/**
 * ⚠️ „TIKRAS ESCAPE, NE TEKSTAS APIE ESCAPE" - VIENA TAISYKLĖ, NE DU SĄRAŠAI
 * (Codex, #290).
 *
 * Kanoninėje eilutėje pavojingi simboliai gyvena kaip escape sekos, tad ieškoma
 * jų. Bet `substring` paieška negali atskirti tikros sekos nuo TEKSTO, kuriame ta
 * seka parašyta literaliai: teisėtas rezultatas (pvz. programinio kodo
 * transkripcija) turi vieną pasvirąjį brūkšnį daugiau, ir naivi paieška sutampa
 * nuo antrojo.
 *
 * ⚠️ KLAIDOS KRYPTIS BUVO PAVOJINGESNĖ, NEI ATRODO. PG tokį tekstą PRIIMA, o riba
 * jį atmesdavo - t. y. riba buvo griežtesnė ta kryptimi, kurios matricos eilutė
 * negina, ir rezultatas būtų nesaugotinas be jokios priežasties.
 *
 * Todėl nelyginio pasvirųjų brūkšnių skaičiaus taisyklė gyvena VIENOJE vietoje, o
 * konkretūs šablonai iš jos IŠVEDAMI. Surogatams ji jau buvo; NUL jos neturėjo.
 */
function tikroEscapeSablonas(kunas) {
  return new RegExp("(?:^|[^\\\\])(?:\\\\\\\\)*\\\\u" + kunas);
}

/** NUL kanoninėje eilutėje: `\u0000` su NELYGINIU pasvirųjų brūkšnių skaičiumi. */
const NUL_ESCAPE = tikroEscapeSablonas("0000");

/**
 * Neporinis surogatas kanoninėje eilutėje: `\uD800`-`\uDFFF` su NELYGINIU
 * pasvirųjų brūkšnių skaičiumi (tikras escape, ne tekstas apie escape).
 */
const VIENISAS_SUROGATAS = tikroEscapeSablonas("[dD][89a-fA-F][0-9a-fA-F]{2}");

/**
 * VIENA REIKŠMIŲ SRITIS — TA PATI ABIEM KRYPTIM (Codex, #290).
 *
 * ⚠️ RAŠYMO IR SKAITYMO SRITYS BUVO SKIRTINGOS, IR TAI YRA KLASĖ, NE ATVEJIS.
 *
 * `put()` atmesdavo viršutinio lygio `null`, NUL simbolį ir neporinį surogatą, o
 * `read()` juos PRIIMDAVO: atkurtas ar iš išorės pakeistas objektas galėjo grąžinti
 * būtent tai, ko riba niekada nebūtų įsileidusi. Literalus `null` čia blogiausias —
 * jis atkuria „`completed` be rezultato" būseną, po kurios terminalus valymas
 * ištrina šaltinio audio.
 *
 * Todėl sritis gyvena VIENOJE funkcijoje, o kodavimas ir dekodavimas yra tik dvi
 * jos kryptys. Naujai taisyklei nebereikia atsiminti antros vietos.
 *
 * ⚠️ KAINA UŽRAŠOMA: skaitymo kelias dabar kanonizuoja perskaitytą reikšmę. Tai
 * viena papildoma struktūros perėja vienam artefaktui — priimta, nes hidratacija
 * ribojama `MAX_RESULT_BYTES` (#157 D5), o tyli divergencija kainuoja duomenų
 * praradimą.
 *
 * @returns {string} kanoninė eilutė
 */
function patikrintiSriti(reiksme) {
  /**
   * ⚠️ VIRŠUTINIO LYGIO `null` ATMETAMAS KARTU SU `undefined` (Codex, #290).
   *
   * `rezultatoNera()` (`common.js`) juos laiko TA PAČIA būsena: „rezultato
   * apskritai nėra". Vadinasi external saugykla, priėmusi literalų `null`,
   * leistų job'ui tapti `completed` be rezultato — o terminalus valymas tada
   * ištrintų šaltinio audio, ir klientas neturėtų nieko. NEGRĮŽTAMAI.
   *
   * ⚠️ RIBA BUVO PLATESNĖ UŽ SAVO IMPLEMENTACIJĄ: `job_results.payload` yra
   * `NOT NULL`, tad inline tokios reikšmės nepriimtų. Riba, priimanti tai, ko
   * viena jos implementacija negali, yra ta pati divergencija, kurią D1 draudžia.
   *
   * ⚠️ `null` LAUKAI OBJEKTO VIDUJE LIEKA TEISĖTI — tai turinys, ne jo nebuvimas.
   */
  if (reiksme === undefined || reiksme === null) {
    throw struktūrinė(
      "ArtifactStore: `undefined` ir `null` reiškia REZULTATO NEBUVIMĄ, ne saugotiną reikšmę " +
        "(`common.js` `rezultatoNera()`). `null` laukai objekto viduje leidžiami.",
      KLAIDA.REIKSME
    );
  }

  /**
   * ⚠️ NE BAIGTINIS SKAIČIUS VIRŠUTINIAME LYGYJE = REZULTATO NEBUVIMAS
   * (Codex, #290).
   *
   * `NaN`, `Infinity` ir `-Infinity` pro ankstesnį sargą praeidavo, o
   * kanonizavimas juos paverčia `null` (išmatuota: `kanoninisRezultatas(NaN)`
   * grąžina `"null"`). Vadinasi saugykloje atsidurtų literalus `null` - tiksliai
   * ta būsena, kurią sargas ir uždarė: `completed` be rezultato, po kurio
   * terminalus valymas ištrina šaltinio audio.
   *
   * ⚠️ VIDUJE ESANTIS `NaN` NEATMETAMAS. Jis virsta `null` VIENODAI visuose
   * backend'uose, tad tapatybė lieka viena (`NUOSTOLINGI` klasė). Atmesti jį
   * reikštų pereiti visą struktūrą - antrą kanonizavimo kopiją, kurios D1
   * eksplicitiškai vengia. Skirtumas ne kosmetinis: viršutiniame lygyje dingsta
   * REZULTATAS, viduje - vienas laukas.
   */
  if (typeof reiksme === "number" && !Number.isFinite(reiksme)) {
    throw struktūrinė(
      "ArtifactStore: `NaN` ir begalybė kanonizuojamos į `null`, o tai reiškia REZULTATO " +
        "NEBUVIMĄ (`common.js` `rezultatoNera()`), ne saugotiną reikšmę.",
      KLAIDA.REIKSME
    );
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
  if (NUL_ESCAPE.test(kanonine)) {
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

  /**
   * ⚠️ VIENIŠAS SUROGATAS — IŠMATUOTA, NE NUMANYTA (CI 33909895874).
   *
   * PostgreSQL `jsonb` neporinio surogato NEPRIIMA: `22P02`. Riba jį PRALEIDO,
   * ir tai buvo vienintelis atvejis, kur ji buvo ŠVELNESNĖ už PG — reikšmė būtų
   * praėjusi `put()`, o inline diegimas gautų klaidą jau PO sėkmės.
   *
   * ⚠️ KODĖL `fs` TO NEPARODĖ. `JSON.stringify` neporinį surogatą UŽKODUOJA kaip
   * ASCII escape (`\ud800`), tad kanoninėje eilutėje raw simbolio nėra ir
   * filesystem round-trip nelūžta. Klasė matoma tik prieš PG — dėl to
   * `jobResultsJsonbDomain.integration` ir egzistuoja.
   *
   * ⚠️ REALUMAS: JS eilutės surogatus neša laisvai, ir jie atsiranda PJAUSTANT
   * tekstą — segmentų dalijime ar apkarpyme ties dydžio riba. Pjūvis per emoji
   * palieka pusę poros, ir rezultatas iškeliauja į `finish()`.
   *
   * ⚠️ NELYGINIS PASVIRŲJŲ BRŪKŠNIŲ SKAIČIUS. Be jo tekstas, kuriame LITERALIAI
   * parašyta `\ud800`, būtų atmestas kaip surogatas: kanoninėje eilutėje jis
   * atrodo kaip `\\ud800`, ir naivus šablonas sutaptų su vidine dalimi.
   */
  if (VIENISAS_SUROGATAS.test(kanonine)) {
    throw struktūrinė(
      "ArtifactStore: neporinis surogatas nepalaikomas - PostgreSQL `jsonb` jį atmeta " +
        "(`22P02`), tad jis neįeina į bendrą backend'ų reikšmių aibę (#157 D1). " +
        "Dažniausia kilmė: teksto pjūvis per emoji ar retesnį simbolį.",
      KLAIDA.REIKSME
    );
  }

  return kanonine;
}

/**
 * KODAVIMAS: reikšmė -> kanoniniai baitai + metaduomenys.
 *
 * ⚠️ `bytes` IR `checksum` SKAIČIUOJAMI IŠ TŲ PAČIŲ BAITŲ, KURIE PERSISTINAMI.
 * Implementacijos pradinės reikšmės nebeserializuoja — kitaip tarp kvito ir
 * įrašymo liktų langas, kuriame reikšmė spėja pasikeisti.
 */
function paruostiReiksme(reiksme) {
  const kanonine = patikrintiSriti(reiksme);
  const buferis = Buffer.from(kanonine, "utf8");

  return {
    kanonine,
    buferis,
    bytes: buferis.byteLength,
    checksum: crypto.createHash("sha256").update(buferis).digest("hex"),
  };
}

/**
 * LAUKIAMI METADUOMENYS NORMALIZUOJAMI VIENOJE VIETOJE (Codex P1, #290).
 *
 * ⚠️ `job_results.bytes` YRA `bigint`, IR `node-postgres` JĮ GRĄŽINA EILUTE.
 *
 * 64 bitų sveikasis į JS skaičių saugiai netelpa, tad `pg` tokius stulpelius
 * paduoda kaip eilutes. Griežtas `===` tada lygina `"12"` su `12` ir grąžina
 * `false` KIEKVIENAM DB paremtam artefaktui: 7.6 restore verifikacija skelbtų,
 * kad viskas sugadinta, būtent tada, kai ja remiamasi. Klaidos kryptis blogiausia
 * įmanoma - ne tyli spraga, o visuotinis klaidingas aliarmas.
 *
 * ⚠️ NORMALIZUOJAMA TIK LAUKIAMA PUSĖ. Faktinius `bytes`/`checksum` skaičiuoja
 * pati saugykla, tad jų tipas yra mūsų, o ne draiverio reikalas. Konvertuoti abi
 * puses reikštų slėpti ir tikras klaidas.
 *
 * ⚠️ NEATPAŽINTAS TIPAS VIRSTA `null`, NE NULIU. `null` niekada nesutaps su
 * faktine reikšme, tad neaiškus lūkestis duoda `ok: false` - fail-closed. Nulis
 * atsitiktinai sutaptų su tuščiu objektu.
 */
function normalizuotiLaukima(laukiama = {}) {
  const salt = laukiama && typeof laukiama === "object" ? laukiama : {};

  let bytes = null;
  if (typeof salt.bytes === "number" && Number.isFinite(salt.bytes)) bytes = salt.bytes;
  else if (typeof salt.bytes === "bigint") bytes = Number(salt.bytes);
  else if (typeof salt.bytes === "string" && /^\d+$/.test(salt.bytes.trim())) bytes = Number(salt.bytes.trim());

  /** Šešioliktainės sumos registras nėra prasmė, tad jis nesukuria nesutapimo. */
  const checksum = typeof salt.checksum === "string" ? salt.checksum.trim().toLowerCase() : null;

  return { bytes, checksum };
}

/**
 * NESANČIO OBJEKTO VERDIKTAS - VIENA FORMA VISIEMS BACKEND'AMS (Codex, #290).
 *
 * ⚠️ TRŪKSTAMAS LAUKAS YRA TREČIA BŪSENA. PR-7 ataskaita eilutes skirsto pagal
 * `nepriklausomas`; jei nesančiam objektui tas laukas negrįžta, `undefined`
 * tyliai susilieja su „patvirtinta priklausomai". Trys implementacijos, rašančios
 * tą pačią formą ranka, anksčiau ar vėliau išsiskiria - tad forma viena.
 */
function nesancioVerdiktas(nepriklausomas) {
  return { ok: false, exists: false, bytes: null, checksum: null, nepriklausomas };
}

/** Rastam objektui: palyginimas su lūkesčiu, ta pati forma kaip `nesancioVerdiktas`. */
function vientisumoVerdiktas({ laukiama, bytes, checksum, nepriklausomas }) {
  const lauktas = normalizuotiLaukima(laukiama);

  return {
    ok: lauktas.bytes === bytes && lauktas.checksum === checksum,
    exists: true,
    bytes,
    checksum,
    nepriklausomas,
  };
}

/**
 * Reikšmės atkūrimas iš baitų - viena vieta, kad klaidos kodas būtų vienodas.
 *
 * ⚠️ PARSERIO DIAGNOSTIKA NEĮEINA Į PRANEŠIMĄ (Codex, #290).
 *
 * `JSON.parse` klaidos tekste Node cituoja NEPAVYKUSIĄ vietą — t. y. artefakto
 * turinio fragmentą. Transkripcijų atveju tai asmenvardžiai, adresai ar sveikatos
 * informacija, o pranešimas keliauja į job'o klaidos lauką, kurį mato savininkas.
 * Node 18 rodo vieną simbolį, Node 22 (CI ir produkcija) — iki dešimties: versija
 * keičia nuotėkio DYDĮ, ne jo egzistavimą.
 *
 * ⚠️ ORIGINALI KLAIDA LIEKA `cause` GRANDINĖJE, BET NIEKUR NELOGGUOJAMA. Ji skirta
 * derinimui su debugger'iu, ne žurnalui; automatinis jos serializavimas grąžintų
 * tą patį turinį pro kitas duris (žr. `jobRunner._classifyError`).
 */
function sugadintas(raktas, priezastis, kilme) {
  const nesekme = new ArtifactStoreError(
    `ArtifactStore: objekto "${raktas}" ${priezastis}.`,
    KLAIDA.SUGADINTAS,
    { cause: kilme }
  );

  return nesekme;
}

/**
 * ⚠️ NETAISYKLINGAS UTF-8 TYLIAI PAKEIČIA DUOMENIS (Codex, #290).
 *
 * `Buffer.toString("utf8")` blogus baitus pakeičia U+FFFD ir grąžina „sėkmę": tada
 * `JSON.parse` pavyksta, o kvietėjas gauna PAKEISTUS vartotojo duomenis vietoj
 * signalo, kad objektas sugadintas. Pvz. `{"x":"\xff"}` virsta `{x:"\uFFFD"}`.
 *
 * Griežtas dekoderis tą klasę uždaro: sugadinti baitai tampa `ARTIFACT_CORRUPT`,
 * t. y. eina remonto keliu, o ne į rezultatą.
 */
const GRIEZTAS_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * DEKODAVIMAS: baitai -> patikrinta reikšmė. Kodavimo atvirkštinė kryptis.
 *
 * ⚠️ TRYS PAKOPOS, IR VISOS TRYS FAIL-CLOSED: griežtas UTF-8, `JSON.parse` ir TA
 * PATI reikšmių sritis, kurią taiko `put()`. Trečioji yra esminė — be jos
 * saugykloje gulinti reikšmė galėtų būti tokia, kokios riba niekada neįsileido.
 */
function atkurtiReiksme(buferis, raktas) {
  let tekstas;
  try {
    tekstas = GRIEZTAS_UTF8.decode(buferis);
  } catch (klaida) {
    throw sugadintas(raktas, "turinys nėra galiojantis UTF-8", klaida);
  }

  let reiksme;
  try {
    reiksme = JSON.parse(tekstas);
  } catch (klaida) {
    throw sugadintas(raktas, "turinys nėra galiojantis JSON", klaida);
  }

  try {
    patikrintiSriti(reiksme);
  } catch (klaida) {
    /**
     * ⚠️ KODAS YRA `SUGADINTAS`, NE `REIKSME`. Čia kalta ne kvietėjo įvestis, o
     * saugykloje gulintis turinys: `ARTIFACT_VALUE_UNSUPPORTED` nusiųstų operatorių
     * tikrinti tiekėjo rezultato, nors taisyti reikia objektą.
     */
    throw sugadintas(raktas, `turinys už leistinos reikšmių srities (${klaida.code})`, klaida);
  }

  return reiksme;
}

module.exports = {
  ArtifactStoreError,
  struktūrinė,
  KLAIDA,
  MAX_RAKTO_ILGIS,
  MAX_SEGMENTO_BAITAI,
  patikrintiRakta,
  patikrintiSriti,
  paruostiReiksme,
  atkurtiReiksme,
  normalizuotiLaukima,
  nesancioVerdiktas,
  vientisumoVerdiktas,
};
