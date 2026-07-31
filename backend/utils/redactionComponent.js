/**
 * PII REDAKCIJOS KOMPONENTO APTIKIMAS (GDPR #5 sąsaja su #4).
 *
 * Vienintelė vieta, kuri žino, KAIP randamas redakcijos komponentas. Naudoja
 * `utils/privacyConfig` (validacijai ir diagnostikai) ir `providers/llm/index`
 * (realiam vykdymui) - kad abu remtųsi tuo pačiu atsakymu.
 *
 * TRYS BŪSENOS, o ne boolean. Ankstesnė versija turėjo `catch { return false; }`,
 * kuris modulio SyntaxError paversdavo į "modulio nėra" - administratorius matytų
 * pranešimą "įgyvendinkite #4", nors modulis jau parašytas ir tiesiog neįsikelia.
 */

const MODULE_PATH = "./piiRedaction";

const STATE = {
  OK: "ok",
  MISSING: "missing",
  LOAD_ERROR: "load_error",
  INVALID_CONTRACT: "invalid_contract",
};

let _loaderForTests = null;

function _load() {
  if (_loaderForTests) return _loaderForTests();
  return require(MODULE_PATH);
}

/**
 * @returns {{state: string, detail: string|null, redact: Function|null}}
 */
function probeRedactionComponent() {
  let mod;

  try {
    mod = _load();
  } catch (e) {
    // Skiriam "nėra failo" nuo "failas yra, bet krenta". Tik pirmasis reiškia,
    // kad #4 dar neįgyvendintas.
    const missing = e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(MODULE_PATH);

    return missing
      ? { state: STATE.MISSING, detail: null, redact: null }
      : { state: STATE.LOAD_ERROR, detail: e && e.message ? e.message : String(e), redact: null };
  }

  if (!mod || typeof mod.redact !== "function") {
    return {
      state: STATE.INVALID_CONTRACT,
      detail: `${MODULE_PATH} neturi eksportuojamos redact() funkcijos`,
      redact: null,
    };
  }

  return { state: STATE.OK, detail: null, redact: mod.redact };
}

/** Trumpinys ten, kur svarbu tik "ar galima pasikliauti". */
function isRedactionAvailable() {
  return probeRedactionComponent().state === STATE.OK;
}

module.exports = {
  STATE,
  MODULE_PATH,
  probeRedactionComponent,
  isRedactionAvailable,
  /** TESTAMS: suvaidina #4 modulį (arba jo įkėlimo klaidą). null - reali patikra. */
  _setLoaderForTests(fn) {
    _loaderForTests = fn;
  },
};
