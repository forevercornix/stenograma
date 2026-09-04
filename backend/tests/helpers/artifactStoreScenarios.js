const { kanoninisRezultatas } = require("../../utils/jobStore/common");

/**
 * `ArtifactStore` KONTRAKTO SCENARIJAI - VIENAS SĄRAŠAS, TRYS BACKEND'AI (#157, PR-2).
 *
 * ⚠️ RAŠOMA PRIEŠ KONTRAKTĄ, NE PRIEŠ `fs` ELGESĮ.
 *
 * Šis rinkinys pirmas paleidžiamas prieš `fs`, tad į jį lengva įkoduoti
 * filesystem prielaidas: kad `head` pigus, kad rašymas iškart matomas, kad
 * klaidos sinchroninės, kad raktas yra kelias. Prieš S3 dalis jų netiesa.
 *
 * Todėl kiekvienas scenarijus formuluojamas TAIP, kad jo paaiškinime nebūtų
 * konkretaus backend'o. Kur elgesys kontrakte NEAPIBRĖŽTAS (perrašymas,
 * listing'as, laiko tvarka), scenarijaus NĖRA - geriau matoma spraga, nei tyliai
 * įtvirtinta implementacijos savybė.
 *
 * ⚠️ KODĖL SĄRAŠAS ATSKIRAI NUO TESTO. Jis yra VARTAI: S3 implementacija privalo
 * praeiti jį NEKEIČIAMA. Gyvendamas viename faile su `fs` testu, jis anksčiau ar
 * vėliau įgytų „jei backend === ..." šaką, ir vartai nustotų būti vartai.
 */

/**
 * ⚠️ NUL SIMBOLIS NEĮEINA Į LEISTINĄ REIKŠMIŲ AIBĘ, IR TAI KONTRAKTO SPRENDIMAS.
 *
 * PostgreSQL `jsonb` jo nepriima apskritai, o filesystem ir S3 jį išsaugotų.
 * Vadinasi tas pats loginis rezultatas duotų skirtingą elgesį skirtinguose
 * backend'uose - tiksliai tai, ką #157 D1 draudžia („po round-trip'o VISI
 * backend'ai duoda tą pačią kanoninę eilutę tam pačiam loginiam rezultatui").
 *
 * Aibė susiaurinama iki GRIEŽČIAUSIO backend'o, ir atmetimas vyksta ties riba,
 * ne saugykloje: kitaip `fs` priimtų tai, ko `inline` niekada nepriims, ir
 * migracija tarp jų taptų negalima.
 *
 * ⚠️ Rašoma per `fromCharCode`, ne literalu: NUL faile yra nematomas, ir jį
 * pirmas „sutvarkytų" bet kuris redaktorius ar formatuotojas.
 */
const NUL = String.fromCharCode(0);

/** Reikšmės, kurios PRIVALO išgyventi round-trip'ą nepakitusios. */
const GALIOJANTYS = Object.freeze([
  { vardas: "tuščias objektas", reiksme: {} },
  { vardas: "tuščias masyvas", reiksme: [] },
  { vardas: "paprastas tekstas", reiksme: { text: "labas" } },
  {
    vardas: "raktų tvarka NELEMIA tapatybės",
    reiksme: { b: 1, a: 2 },
    tapatuSu: { a: 2, b: 1 },
  },
  {
    vardas: "masyvo tvarka LEMIA tapatybę",
    reiksme: { segments: [1, 2] },
    skiriasiNuo: { segments: [2, 1] },
  },
  { vardas: "lietuviški rašmenys", reiksme: { text: "ąčęėįšųūž ĄČĘĖĮŠŲŪŽ" } },
  {
    /**
     * ⚠️ KONTROLĖ SUROGATO SARGUI: tekstas, kuriame LITERALIAI parašyta escape
     * seka. Kanoninėje eilutėje ji atrodo kaip dvigubas pasvirasis brūkšnys, ir
     * naivus šablonas ją atmestų kaip neporinį surogatą — nors PG ją priima.
     */
    vardas: "tekstas, kuriame literaliai parašyta escape seka",
    reiksme: { t: "eilutė su \\ud800 viduje" },
  },
  {
    vardas: "surogatinės poros ir jungtukas",
    reiksme: { text: "\u{1F469}‍\u{1F4BB} protokolas" },
  },
  { vardas: "įdėtos struktūros", reiksme: { a: { b: { c: [1, { d: null }] } } } },
  { vardas: "null reikšmės viduje", reiksme: { text: null, segments: [null] } },
  { vardas: "sveikieji skaičiai", reiksme: { n: 0, m: -1, k: 9007199254740991 } },
  { vardas: "trupmeniniai skaičiai", reiksme: { x: 0.1, y: 1e-7, z: -0.5 } },
  { vardas: "loginės reikšmės", reiksme: { ok: true, ne: false } },
  { vardas: "kabutės ir pasvirieji brūkšniai", reiksme: { text: "\\ \" ' `" } },
  { vardas: "naujosios eilutės ir tabai", reiksme: { text: "a\nb\tc\r\nd" } },
  { vardas: "ilgas tekstas", reiksme: { text: "x".repeat(100000) } },
  { vardas: "gilus masyvas", reiksme: { segments: Array.from({ length: 1000 }, (_, i) => ({ i })) } },
]);

/**
 * Reikšmės, kurias kontraktas ATMETA - vienodai visuose backend'uose.
 *
 * ⚠️ Atmetimas yra kontrakto dalis, ne implementacijos apsauga. Backend'as,
 * kuris tokią reikšmę priimtų, praeitų savo testus ir sulaužytų migraciją į kitą.
 */
const ATMETAMI = Object.freeze([
  { vardas: "NUL tekste", reiksme: { text: "a" + NUL + "b" } },
  { vardas: "NUL rakte", reiksme: { ["a" + NUL + "b"]: 1 } },
  { vardas: "NUL masyve", reiksme: [NUL] },
  { vardas: "undefined", reiksme: undefined },
  /**
   * ⚠️ VIRŠUTINIO LYGIO `null` — P1, ne kosmetika.
   *
   * Grandinė: external saugykla priima literalų `null` -> job'as `completed` ->
   * hidratacija duoda `result: null` -> terminalus valymas ištrina šaltinio
   * audio, o klientas rezultato NETURI. Negrįžtamai. Tai tiesioginis
   * prieštaravimas 7.5b taisyklei „`completed` be rezultato nėra sėkmė".
   *
   * ⚠️ IR RIBA BUVO PLATESNĖ UŽ SAVO PAČIOS IMPLEMENTACIJĄ: `payload` yra
   * `NOT NULL`, tad inline tokios reikšmės nepriimtų. Riba, priimanti tai, ko
   * viena jos implementacija negali, yra ta pati divergencija, kurią D1 draudžia.
   */
  { vardas: "viršutinio lygio null", reiksme: null },
  /**
   * ⚠️ IŠMATUOTA DIVERGENCIJA, NE TEORINĖ (peržiūros radinys).
   *
   * `kanonizuoti()` perrenka tik NUOSAVUS raktus, o inline `payload` keliauja per
   * `JSON.stringify`, kviečiantį PROTOTIPE gyvenantį `toJSON()`. Todėl `Date`
   * kanoniškai virsta `{}` (visos datos tapatingos tarpusavyje!), o po inline
   * round-trip'o - ISO eilute. Pakartotinis `finish()` tada duotų
   * `RESULT_CONFLICT`, ne no-op.
   *
   * `fs` ir S3 to neparodytų - jie grąžina tuos pačius baitus. Todėl reikšmė
   * atmetama ties riba, o ne paliekama kaip backend'o savybė.
   */
  { vardas: "Date (prototipo toJSON)", reiksme: { d: new Date(0) } },
  {
    vardas: "klasės egzempliorius su prototipo toJSON",
    reiksme: {
      x: new (class {
        toJSON() {
          return 1;
        }
      })(),
    },
  },
  {
    vardas: "ciklinė nuoroda",
    reiksme: (() => {
      const o = {};
      o.self = o;
      return o;
    })(),
  },
]);

/**
 * NUOSTOLINGOS, BET VIENODOS reikšmės.
 *
 * ⚠️ IŠMATUOTA, NE NUMANYTA. `kanoninisRezultatas()` (`common.js:731`) turi
 * `JSON.stringify` semantiką: funkcija ar `undefined` objekto lauke TYLIAI
 * dingsta, masyve virsta `null`.
 *
 * Kontraktas jų NEATMETA, ir tai sąmoningas sprendimas: atmetimui reikėtų
 * pereiti visą struktūrą - antros kanonizavimo kopijos, kurios #157 D1
 * eksplicitiškai vengia („antros lygybės taisyklės nėra"). O D1 rūpi PARITETAS:
 * praradimas vienodas VISUOSE backend'uose, tad tapatybė lieka viena.
 *
 * Užrašoma ir tikrinama, nes tylus lauko dingimas be įrašo yra spąstai
 * kiekvienam, kas kada nors perduos ne JSON kilmės objektą.
 */
const NUOSTOLINGI = Object.freeze([
  {
    vardas: "funkcija objekto lauke DINGSTA",
    reiksme: { text: "x", f: () => 1 },
    virsta: { text: "x" },
  },
  {
    vardas: "undefined objekto lauke DINGSTA",
    reiksme: { a: undefined, b: 1 },
    virsta: { b: 1 },
  },
  {
    vardas: "funkcija masyve VIRSTA null",
    reiksme: { segments: [1, () => 1] },
    virsta: { segments: [1, null] },
  },
  {
    vardas: "toJSON NUOSAVAME lauke veikia vienodai abiem keliais",
    reiksme: { u: { toJSON: () => "pakeista" } },
    virsta: { u: "pakeista" },
  },
]);

/**
 * Raktai, kuriuos kontraktas ATMETA.
 *
 * ⚠️ ATMETIMAS YRA SAUGUMO, NE PATOGUMO KLAUSIMAS. Vienam backend'ui `..` yra
 * path traversal, kitam - kito prefikso objektas. Riba turi būti VIENA ir gyventi
 * boundary, ne kiekvienoje implementacijoje atskirai.
 */
const BLOGI_RAKTAI = Object.freeze([
  { vardas: "tuščias", raktas: "" },
  { vardas: "ne eilutė", raktas: 42 },
  { vardas: "grįžimas atgal", raktas: "results/../../etc/passwd" },
  { vardas: "paslėptas grįžimas", raktas: "results/a/../../../b" },
  { vardas: "absoliutus", raktas: "/etc/passwd" },
  { vardas: "NUL rakte", raktas: "results/a" + NUL + "b" },
  { vardas: "naujoji eilutė", raktas: "results/a\nb" },
  { vardas: "tik taškai", raktas: ".." },
]);

/** Kanoninė tapatybė - vienintelis lygybės autoritetas (`common.js:731`). */
function tapatybe(reiksme) {
  return kanoninisRezultatas(reiksme);
}

module.exports = { GALIOJANTYS, ATMETAMI, NUOSTOLINGI, BLOGI_RAKTAI, tapatybe, NUL };
