const { getPrivacyConfig, validatePrivacyConfig } = require("./privacyConfig");

/**
 * VIENAS VALIDUOTAS RUNTIME OBJEKTAS (GDPR #5 DoD).
 *
 * Kuo tai skiriasi nuo `utils/privacyConfig.js`? Anas yra konfigūracijos
 * SKAITYMO API: `getPrivacyConfig()` kiekvieno kvietimo metu iš naujo
 * interpretuoja `process.env`. Interpretacija centralizuota, bet niekas
 * negarantuoja, kad du komponentai matys tą pačią būseną - proceso metu
 * pakeistas `process.env` (testai, worker bootstrap, netyčinis `delete`) tyliai
 * sukurtų dvi skirtingas efektyvias politikas viename procese. Būtent tokio
 * dviprasmiškumo šis projektas vengia kitur.
 *
 * Todėl politika sukuriama VIENĄ kartą paleidžiant, VALIDUOJAMA ir UŽŠALDOMA.
 * Visi vartotojai (routes, services, queues, workers, providers) ima tą patį
 * objektą, o ne skaito aplinką patys.
 *
 * Fail-fast: jei konfigūracija neteisinga, `initPrivacyPolicy()` meta klaidą -
 * serveris nestartuoja. Tai ta pati taisyklė, kurią jau taiko `startupChecks`,
 * tik dabar ji yra ir objekto sukūrimo sąlyga, o ne vien atskira patikra.
 *
 * Tingus fallback: worker'iai ir unit testai gali pasiekti politiką be
 * eksplicitinio `init` - tada ji sukuriama pirmo kreipimosi metu ir nuo tada
 * lieka nekintama. Svarbu, kad NEKINTA: vėlesnis `process.env` keitimas
 * efektyvios būsenos nebekeičia.
 */

let _policy = null;

class PrivacyPolicyError extends Error {
  constructor(errors) {
    super(`Neteisinga privatumo konfigūracija:\n- ${errors.join("\n- ")}`);
    this.name = "PrivacyPolicyError";
    this.code = "PRIVACY_POLICY_INVALID";
    this.errors = errors;
  }
}

/**
 * Užšaldyta efektyvi būsena BE validacijos.
 *
 * Validacija yra PALEIDIMO atsakomybė (žr. initPrivacyPolicy), ne objekto
 * sukūrimo sąlyga. Jei būtų atvirkščiai, tingus kelias mestų klaidą kiekvienam,
 * kas tik nori PERSKAITYTI nuostatą - įskaitant patį kodą, kuris tą neteisingą
 * konfigūraciją turi fail-closed užblokuoti.
 */
function _freeze(env) {
  return Object.freeze({ ...getPrivacyConfig(env), warnings: Object.freeze([]) });
}

/**
 * Kviečiama paleidžiant (server.js, workers): VALIDUOJA ir meta klaidą, jei
 * konfigūracija prieštaringa - serveris tada nestartuoja.
 */
function initPrivacyPolicy(env = process.env) {
  const { errors, warnings } = validatePrivacyConfig(env);
  if (errors.length) throw new PrivacyPolicyError(errors);

  _policy = Object.freeze({ ...getPrivacyConfig(env), warnings: Object.freeze([...warnings]) });
  return _policy;
}

/** Vienintelis būdas komponentui sužinoti efektyvią politiką. */
function getPrivacyPolicy() {
  if (!_policy) _policy = _freeze(process.env);
  return _policy;
}

module.exports = {
  PrivacyPolicyError,
  initPrivacyPolicy,
  getPrivacyPolicy,
  isInitialized: () => _policy !== null,
  /**
   * TESTAMS: leidžia perkurti politiką po `process.env` pakeitimo. Produkcijoje
   * tokio kelio NĖRA sąmoningai - jei jis egzistuotų, dingtų visa garantija.
   */
  _resetForTests() {
    _policy = null;
  },
};
