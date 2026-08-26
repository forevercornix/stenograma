/**
 * AUDITO EILUTĖS LAUKŲ AUTORITETAS (#155, 7.4b / #211).
 *
 * ⚠️ VIENAS SKIRSTYMO ŠALTINIS.
 *
 * Tas pats klausimas - „kurie laukai yra stulpeliai, o kurie `meta`" - kyla
 * trijose vietose: migracijoje, `postgresStore` rašyme ir skaityme. Trys
 * rankomis palaikomi sąrašai išsiskirtų tyliai: laukas, pridėtas prie INSERT,
 * bet pamirštas SELECT'e, dingtų iš `getAll()` be jokio signalo, o memory ir
 * postgres backend'ai imtų grąžinti skirtingus objektus.
 *
 * ⚠️ SĄRAŠAI TIKRINAMI PRIEŠ `record()` IŠVESTĮ, NE PRIEŠ KOMENTARĄ.
 *
 * `visiLaukai()` egzistuoja tam, kad testas galėtų palyginti jį su TIKRA
 * `auditLog.record()` išvestimi. Naujas laukas, neįrašytas nė į vieną sąrašą,
 * krenta testu - o ne tampa tyliai neišsaugomas (AGENTS.md §12.1).
 */

/**
 * STULPELIAIS TAMPA TIK FILTRUOJAMI LAUKAI (#211).
 *
 * Raktas - `record()` lauko vardas, reikšmė - DB stulpelis. Likusieji laukai
 * neturi savo indekso, tad stulpeliu būti neprivalo; jų vieta - `meta`.
 *
 * `hash_key_id` ir `seq` ČIA NĖRA sąmoningai: jų `record()` negrąžina.
 * Pirmąjį prideda store'as iš `AUDIT_ID_SALT_ID`, antrą - pati DB.
 */
const STULPELIAI = Object.freeze({
  id: "id",
  timestamp: "timestamp",
  event: "event",
  subjectId: "subject_id",
  result: "result",
  requestId: "request_id",
});

/**
 * `meta` JSONB ALLOWLIST.
 *
 * ⚠️ TAI SAUGOS RIBA, NE PATOGUMO SĄRAŠAS. Be jo bet kuris naujas `record()`
 * laukas automatiškai taptų persistinamas - įskaitant tokį, kuris atneštų
 * transkripcijos turinio, prompt'o ar PII. Nežinomas laukas NUTYLIMAS.
 */
const META_LAUKAI = Object.freeze([
  "promptVersion",
  "llmProvider",
  "llmModel",
  "transcriptionProvider",
  "diarizationProvider",
  "processingTimeMs",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "jsonRepairAttempts",
  "error",
  "details",
  "redaction",
  "variant",
  "format",
  "outcome",
  "route",
  "mime",
  "sizeBytes",
  "limitBytes",
  "actor",
]);

/** Visi laukai, kuriuos backend'as įsipareigoja išsaugoti ir grąžinti. */
function visiLaukai() {
  return [...Object.keys(STULPELIAI), ...META_LAUKAI];
}

/**
 * Atrenka į `meta` einančius laukus. Nežinomi NUTYLIMI - žr. `META_LAUKAI`.
 *
 * `undefined` reikšmės praleidžiamos, kad JSONB neįgytų raktų su `null`, kurių
 * memory backend'as neturi: paritetas tikrinamas pagal raktų aibę, ne tik
 * reikšmes.
 */
function isrinktiMeta(eilute) {
  const meta = {};

  for (const laukas of META_LAUKAI) {
    const reiksme = eilute[laukas];
    if (reiksme !== undefined) meta[laukas] = reiksme;
  }

  return meta;
}

/**
 * Eilutė, apkarpyta iki DEKLARUOTŲ laukų.
 *
 * ⚠️ ALLOWLIST YRA SAUGYKLOS RIBOS GARANTIJA, NE SQL DETALĖ.
 *
 * PostgreSQL pusėje ji galioja savaime - į `meta` patenka tik `isrinktiMeta()`
 * atrinkti laukai. Atmintyje objektas anksčiau buvo saugomas TOKS, KOKS ATĖJO,
 * tad nežinomas laukas (`transcript`, plikas `jobId`) išliktų ir grįžtų per
 * `/api/audit`. Du backend'ai duotų skirtingą privatumo garantiją, o testuose
 * naudojamas kaip tik silpnesnysis - divergenciją rado bendras kontrakto
 * rinkinys.
 *
 * Trūkstami `meta` laukai užpildomi `null`, kad raktų aibė sutaptų su tuo, ką
 * grąžina postgres `iEilute()`.
 */
function normalizuoti(eilute) {
  const rezultatas = {};

  for (const laukas of Object.keys(STULPELIAI)) {
    rezultatas[laukas] = eilute[laukas] === undefined ? null : eilute[laukas];
  }

  for (const laukas of META_LAUKAI) {
    rezultatas[laukas] = eilute[laukas] === undefined ? null : eilute[laukas];
  }

  return rezultatas;
}

module.exports = { STULPELIAI, META_LAUKAI, visiLaukai, isrinktiMeta, normalizuoti };
