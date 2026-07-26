// ESLint flat config (v9+) frontend'ui. Su React ir React Hooks taisyklėmis.
// Svarbiausia - react-hooks/exhaustive-deps (App.jsx turi kelis eslint-disable šiai
// taisyklei; dabar ESLint jas kontroliuoja, ne vien komentarai). Pragmatiškas:
// hook klaidos - warn (kad neužblokuotų, bet matytųsi), realios klaidos - error.
const reactPlugin = require("eslint-plugin-react");
const reactHooks = require("eslint-plugin-react-hooks");

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  Blob: "readonly",
  URL: "readonly",
  FormData: "readonly",
  FileReader: "readonly",
  MediaRecorder: "readonly",
  AudioContext: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  localStorage: "readonly",
  alert: "readonly",
  atob: "readonly",
  btoa: "readonly",
  TextDecoder: "readonly",
  React: "readonly",
  global: "readonly",
  process: "readonly",
  vi: "readonly",
};

module.exports = [
  {
    files: ["src/**/*.{js,jsx}"],
    ignores: ["node_modules/**", "dist/**", "e2e/**"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    settings: { react: { version: "detect" } },
    rules: {
      // React Hooks - svarbiausia priežastis pridėti ESLint:
      "react-hooks/rules-of-hooks": "error",       // hook'ai tik top-level (rimta klaida)
      "react-hooks/exhaustive-deps": "warn",       // trūkstamos deps - warn (kontroliuojama)
      // Realios klaidos:
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-cond-assign": "error",
      "use-isnan": "error",
      "no-undef": "error",
      // Įspėjimai:
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: false }],
    },
  },
];
