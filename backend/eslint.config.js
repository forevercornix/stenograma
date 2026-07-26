// ESLint flat config (v9+) backend'ui. Pragmatiškas: gaudo realias klaidas
// (nenaudoti kintamieji, nepasiekiamas kodas, tušti catch), bet neužblokuoja dėl
// stiliaus smulkmenų. Tikslas - aptikti bug'us, ne perrašyti visą kodą.
const globals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "writable",
  require: "readonly",
  exports: "writable",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  fetch: "readonly",
  AbortController: "readonly",
  URLSearchParams: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
};

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**", "coverage/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals,
    },
    rules: {
      // Realios klaidos (error):
      "no-unreachable": "error",           // nepasiekiamas kodas po return/throw
      "no-dupe-keys": "error",             // pasikartojantys objekto raktai
      "no-dupe-args": "error",
      "no-cond-assign": "error",           // atsitiktinis = vietoj == sąlygoje
      "no-constant-condition": ["error", { checkLoops: false }],
      "use-isnan": "error",
      "valid-typeof": "error",
      // Įspėjimai (warn) - nekritiniai, bet verti dėmesio:
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: false }],  // tušti catch - warn
      "no-undef": "error",
    },
  },
  {
    // Testų failai: leidžiam node:test globalus per import, ne per globals
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: { ...globals },
    },
  },
];
