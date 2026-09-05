/**
 * ARTEFAKTŲ SAUGYKLA — MODULIO ĮĖJIMAS (#157, PR-2).
 *
 * ⚠️ ŠIS FAILAS LOGIKOS NETURI IR NETURI TURĖTI.
 *
 * Parinkimas gyvena `backendSelection.js`, riba — `validation.js`, elgesys —
 * `inlineStore.js` / `fsStore.js` / `s3Store.js`. Čia tik viena vieta, kurią
 * kviečia vartotojai: `require("../utils/artifactStore")`.
 *
 * ⚠️ TAI ĮĖJIMAS, NE ANTRA RIBA. Jei čia atsirastų nors viena sąlyga, ribų būtų
 * dvi, ir klausimas „kur sprendžiama, kuri saugykla" turėtų du atsakymus.
 * Ta pati taisyklė kaip `scripts/dr-restore.mjs` atveju.
 */
const { ArtifactStoreError } = require("./validation");
const { LEISTINI, BUTINI, parinktiBackenda, sukurtiSaugykla } = require("./backendSelection");
const { skaitytiRibotai } = require("./boundedRead");

module.exports = {
  ArtifactStoreError,
  LEISTINI,
  BUTINI,
  parinktiBackenda,
  sukurtiSaugykla,
  skaitytiRibotai,
};
