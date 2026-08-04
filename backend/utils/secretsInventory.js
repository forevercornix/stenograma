/**
 * PASLAPČIŲ INVENTORIUS (#20 PR3).
 *
 * Atsako į tris klausimus, kurių iki šiol niekur nebuvo užrašyta:
 *
 *   1. KAS yra paslaptis? (kad kopijos ir logai galėtų jų vengti)
 *   2. KĄ ji atrakina? (kad nutekėjus būtų aišku, kas paveikta)
 *   3. KAIP ją pakeisti? (kad rotacija nebūtų archeologija)
 *
 * KODĖL NE VIEN PAGAL VARDĄ.
 *
 * Taisyklė „viskas su `KEY` yra paslaptis" atrodo patogi, bet klysta abiem
 * kryptimis: `API_KEY_ROLE` yra rolės pavadinimas, ne paslaptis (ir #18 CodeQL
 * kaip tik dėl to suveikė klaidingai), o `HUGGINGFACE_TOKEN` neturi `KEY`
 * žodžio, bet yra tikra paslaptis.
 *
 * Todėl sąrašas EKSPLICITINIS: naujas kintamasis privalo būti čia užregistruotas
 * sąmoningai, o ne pakliūti į kategoriją pagal atsitiktinį pavadinimą.
 */

/**
 * @typedef {object} SecretDefinition
 * @property {string} name - aplinkos kintamojo vardas
 * @property {string} unlocks - ką ši paslaptis suteikia
 * @property {string} rotation - kaip ją pakeisti
 * @property {boolean} externallyIssued - ar ją išduoda trečioji šalis
 */

/** @type {SecretDefinition[]} */
const SECRETS = [
  {
    name: "API_KEY",
    unlocks: "prieigą prie visų apsaugotų API endpoint'ų su `API_KEY_ROLE` role",
    rotation: "pakeisti reikšmę ir perkrauti; senas raktas nustoja veikti nedelsiant",
    externallyIssued: false,
  },
  {
    name: "AUDIT_API_KEY",
    unlocks: "audito žurnalo skaitymą (atskirai nuo `API_KEY`)",
    rotation: "pakeisti reikšmę ir perkrauti",
    externallyIssued: false,
  },
  {
    name: "AUTH_USERS",
    unlocks: "vartotojų paskyras – slaptažodžių maišas, ne patys slaptažodžiai",
    rotation: "sugeneruoti naują maišą per `scripts/hash-password.js`, pakeisti įrašą, perkrauti",
    externallyIssued: false,
  },
  {
    name: "ANTHROPIC_API_KEY",
    unlocks: "Claude API – apmokestinama trečiosios šalies paslauga",
    rotation: "atšaukti tiekėjo konsolėje, sugeneruoti naują, pakeisti reikšmę",
    externallyIssued: true,
  },
  {
    name: "OPENAI_API_KEY",
    unlocks: "OpenAI (Whisper ir GPT) – apmokestinama",
    rotation: "atšaukti tiekėjo konsolėje, sugeneruoti naują",
    externallyIssued: true,
  },
  {
    name: "GOOGLE_API_KEY",
    unlocks: "Google Speech ir Gemini – apmokestinama",
    rotation: "atšaukti Google Cloud konsolėje",
    externallyIssued: true,
  },
  {
    name: "DEEPGRAM_API_KEY",
    unlocks: "Deepgram transkribavimą – apmokestinama",
    rotation: "atšaukti tiekėjo konsolėje",
    externallyIssued: true,
  },
  {
    name: "ASSEMBLYAI_API_KEY",
    unlocks: "AssemblyAI diarizaciją – apmokestinama",
    rotation: "atšaukti tiekėjo konsolėje",
    externallyIssued: true,
  },
  {
    name: "PYANNOTEAI_API_KEY",
    unlocks: "pyannote.ai debesies diarizaciją – apmokestinama",
    rotation: "atšaukti tiekėjo konsolėje",
    externallyIssued: true,
  },
  {
    name: "HUGGINGFACE_TOKEN",
    unlocks: "pyannote modelių atsisiuntimą (gated modeliai)",
    rotation: "atšaukti HuggingFace nustatymuose, sugeneruoti naują",
    externallyIssued: true,
  },
  {
    name: "AZURE_SPEECH_KEY",
    unlocks: "Azure Speech transkribavimą – apmokestinama",
    rotation: "perrinkti raktą Azure portale (yra du raktai – galima keisti be prastovos)",
    externallyIssued: true,
  },
  {
    name: "BACKUP_ENCRYPTION_KEY",
    unlocks: "VISŲ dabartiniu raktu šifruotų atsarginių kopijų turinį – galingiausia paslaptis sistemoje",
    rotation:
      "sugeneruoti naują (`backupEncryption.generateKey()`), senąjį perkelti į BACKUP_ENCRYPTION_KEY_PREVIOUS; " +
      "senojo NEŠALINTI, kol jo kopijos nepasibaigė pagal retenciją",
    externallyIssued: false,
  },
  {
    name: "BACKUP_ENCRYPTION_KEY_PREVIOUS",
    unlocks: "senesnių, ankstesniu raktu šifruotų kopijų turinį",
    rotation: "šalinamas tik tada, kai visos juo šifruotos kopijos pasibaigė arba peršifruotos",
    externallyIssued: false,
  },
  {
    name: "REDIS_URL",
    unlocks: "job store ir eiles; gali turėti slaptažodį URL'e",
    rotation: "pakeisti Redis slaptažodį ir URL, perkrauti",
    externallyIssued: false,
  },
];

/**
 * KINTAMIEJI, KURIE ATRODO KAIP PASLAPTYS, BET JOMIS NĖRA.
 *
 * Įvardyti eksplicitiškai, nes automatinės taisyklės (ir žmonės) juos
 * klaidingai priskiria paslaptims. `API_KEY_ROLE` yra rolės pavadinimas
 * (`administrator`/`operator`), o ne raktas – #18 CodeQL kaip tik dėl to
 * suveikė klaidingai.
 */
const NOT_SECRETS = {
  API_KEY_ROLE: "rolės pavadinimas, ne raktas",
  ANTHROPIC_MAX_TOKENS: "skaitinė riba",
  HEALTH_DETAILS: "loginė vėliava",
};

const SECRET_NAMES = SECRETS.map((s) => s.name);

/** Ar šis aplinkos kintamasis yra paslaptis? */
function isSecret(name) {
  return SECRET_NAMES.includes(name);
}

/** Paslaptys, kurias išduoda trečiosios šalys – jų rotacija priklauso nuo tiekėjo. */
function externallyIssuedSecrets() {
  return SECRETS.filter((s) => s.externallyIssued);
}

/**
 * Ar tekste yra kurios nors sukonfigūruotos paslapties REIKŠMĖ?
 *
 * Naudojama kopijoms ir logams tikrinti. Lyginamos REIKŠMĖS, ne vardai:
 * kintamojo vardas tekste yra nekenksmingas, o reikšmė – ne.
 *
 * ⚠️ Trumpos reikšmės praleidžiamos. Reikšmė „true" ar „1" tekste pasitaikytų
 * atsitiktinai, ir kiekvienas toks sutapimas būtų klaidingas aliarmas, kuris
 * ilgainiui išmokytų ignoruoti visą patikrą.
 *
 * @returns {string[]} paslapčių VARDAI (ne reikšmės), kurių aptikta
 */
function findLeakedSecrets(text, env = process.env) {
  if (!text) return [];

  const haystack = typeof text === "string" ? text : JSON.stringify(text);
  const found = [];

  for (const secret of SECRETS) {
    const value = env[secret.name];
    if (!value || String(value).length < 8) continue;

    if (haystack.includes(String(value))) found.push(secret.name);
  }

  return found;
}

/**
 * Kokios paslaptys sukonfigūruotos? Grąžina TIK vardus.
 *
 * Reikšmės niekada negrąžinamos – funkcija skirta diagnostikai („ar raktas
 * nustatytas?"), ne prieigai prie jų.
 */
function configuredSecrets(env = process.env) {
  return SECRET_NAMES.filter((name) => Boolean(env[name]));
}

module.exports = {
  SECRETS,
  SECRET_NAMES,
  NOT_SECRETS,
  isSecret,
  externallyIssuedSecrets,
  findLeakedSecrets,
  configuredSecrets,
};
