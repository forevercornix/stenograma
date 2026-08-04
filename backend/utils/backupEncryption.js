const crypto = require("crypto");

/**
 * KOPIJŲ ŠIFRAVIMAS (#20 PR3).
 *
 * AES-256-GCM. GCM pasirinktas, o ne CBC, todėl kad jis duoda ir konfidencialumą,
 * IR autentiškumą: pakeitus šifruotą tekstą, dešifravimas KRINTA, o ne grąžina
 * šiukšles.
 *
 * Tai uždaro spragą, kurią #20 PR1 sąžiningai įvardijo: kontrolinė suma
 * apsaugo nuo sugadinimo, bet ne nuo tyčinio pakeitimo, nes jokios paslapties
 * joje nedalyvauja. GCM žyma tokią paslaptį įveda.
 *
 * ⚠️ ŠIFRAVIMAS NEPAKEIČIA PRIEIGOS KONTROLĖS. Kas turi raktą, turi duomenis.
 * Raktas privalo gyventi atskirai nuo kopijų – priešingu atveju šifravimas
 * tampa apeiga, o ne apsauga.
 */

const ALGORITHM = "aes-256-gcm";

/**
 * MANIFESTO LAUKAI, SUSIEJAMI SU ŠIFRUOTU TURINIU (AAD).
 *
 * ⚠️ GCM autentifikuoja TIK tai, kas paduota į `cipher.update()`. Manifestas
 * lieka už žymos ribų, o atkūrimas remiasi būtent juo: `encrypted` sprendžia,
 * ar apskritai dešifruoti, `formatVersion` – ar kopija suderinama.
 *
 * Kontrolinė suma čia nepadeda: kas gali pakeisti failus, gali ją
 * perskaičiuoti – jokios paslapties joje nedalyvauja.
 *
 * Be AAD užpuolikas galėtų SUKEISTI šifruotus turinius tarp dviejų kopijų arba
 * suklastoti manifesto teiginius (`snapshotTime`, `contents`), ir dešifravimas
 * vis tiek pavyktų. AAD tai paverčia neįmanomu: pakeitus bet kurį iš šių laukų,
 * `decipher.final()` krinta.
 *
 * Sąrašas SIAURAS ir stabilus: į jį patenka tik laukai, kurie lemia atkūrimo
 * SPRENDIMUS. Įtraukus kintančius laukus (pvz. `expiresAt`) kopijos taptų
 * neatkuriamos po nekaltų metaduomenų pakeitimų.
 */
const AUTHENTICATED_MANIFEST_FIELDS = [
  "formatVersion",
  "applicationVersion",
  /**
   * ⚠️ `encrypted` YRA SVARBIAUSIAS LAUKAS ŠIAME SĄRAŠE.
   *
   * Būtent jis sprendžia, ar atkūrimas apskritai vykdys dešifravimą. Be jo
   * užpuolikas galėtų pakeisti `encrypted: true` į `false`, pašalinti
   * algoritmą ir perskaičiuoti kontrolinę sumą – AAD apsauga tada net
   * nebūtų pasiekta, nes dešifravimo šaka nebūtų vykdoma.
   *
   * Tai manifesto DOWNGRADE: apsauga apeinama tame pačiame žingsnyje, kurį
   * ji turėtų saugoti.
   *
   * ⚠️ SĄŽININGAI: šis laukas AAD sąraše yra PERTEKLINIS SLUOKSNIS. Praktiškai
   * kiekvieną jo pakeitimą sugauna anksčiau esančios EKSPLICITINĖS patikros
   * `restoreService`: tipo patikra (`typeof !== "boolean"`) ir downgrade
   * aptikimas (`encrypted: false` su envelope turiniu).
   *
   * Todėl atskiro testo, kuris izoliuotų BŪTENT AAD apsaugą šiam laukui, nėra
   * ir negali būti – kitos patikros suveikia pirmos. Laukas paliktas
   * sąmoningai: jei kada nors tos patikros būtų perkeltos ar pašalintos,
   * AAD liktų paskutine gynybos linija.
   */
  "encrypted",
  "encryptionAlgorithm",
  "snapshotTime",
  "excludedInFlightJobs",
  /**
   * `contents` – operatoriaus sprendimų pagrindas: ar kopija pilna, ar joje yra
   * audio, kokio atkūrimo tikėtis. Suklastotas jis nekeistų atkurtų duomenų,
   * bet keistų sprendimą, ar apskritai pradėti atkūrimą.
   */
  "contents",
];

/**
 * ⚠️ `checksum` Į AAD NEPATENKA SĄMONINGAI.
 *
 * Jis skaičiuojamas nuo ŠIFRUOTO turinio, t. y. jau PO šifravimo – šifruojant
 * jo reikšmės dar nėra. Įtraukus jį, AAD šifruojant ir dešifruojant skirtųsi,
 * ir kiekvienas atkūrimas kristų.
 *
 * Apsaugos tai nesumažina: suma apskaičiuojama nuo to paties ciphertext, kurį
 * jau autentifikuoja GCM žyma. Pakeitus ciphertext, žyma nesutaptų nepriklausomai
 * nuo to, ar suma perskaičiuota.
 *
 * `excludedInFlightJobs` įtrauktas vietoj jo: tai operatoriui reikšmingas
 * teiginys apie kopijos pilnumą, kurį verta apsaugoti nuo klastojimo.
 */

/**
 * Kanonizuoja manifesto saugumo laukus į AAD.
 *
 * Raktai rūšiuojami – JSON objektų tvarka nėra garantuota, o skirtinga tvarka
 * duotų skirtingą AAD ir dešifravimas kristų be jokios realios priežasties.
 */
/**
 * AAD schema SUSIETA SU FORMATO VERSIJA.
 *
 * Laukų sąrašas yra dalis ilgalaikės kopijų formato sutarties: bet koks jo
 * pakeitimas (lauko pridėjimas, pašalinimas, `null` interpretacijos pokytis)
 * padarytų ankstesnes kopijas neatkuriamas.
 *
 * Todėl funkcija pavadinta pagal VERSIJĄ, ne bendrai: būsimas `v3` galės turėti
 * kitą rinkinį, o `manifestAadV2` liks nepakitęs senoms kopijoms.
 */
function manifestAadV2(manifest) {
  const selected = {};

  for (const field of AUTHENTICATED_MANIFEST_FIELDS) {
    const value = manifest && manifest[field] !== undefined ? manifest[field] : null;

    /**
     * `contents` kanonizuojamas: masyvo tvarka nėra garantuota, o skirtinga
     * tvarka duotų skirtingą AAD ir dešifravimas kristų be realios priežasties.
     */
    selected[field] = field === "contents" ? _canonicalContents(value) : value;
  }

  const canonical = Object.keys(selected)
    .sort()
    .map((key) => `${key}=${JSON.stringify(selected[key])}`)
    .join("&");

  return Buffer.from(canonical, "utf8");
}

/**
 * Kanonizuoja `contents` su GRIEŽTA schemos patikra.
 *
 * ⚠️ Manifestas atkuriant ateina iš NEPATIKIMO šaltinio. Be patikros
 * `Number("abc")` duotų `NaN`, o `JSON.stringify(NaN)` – `null`, ir skirtingos
 * netinkamos reikšmės suplaktų į tą patį AAD. Tai nesukurtų tiesioginės
 * spragos, bet AAD nustotų atskirti tai, ką turėtų atskirti.
 *
 * AAD nėra manifesto schemos validacijos pakaitalas – bet jis neturi ir tyliai
 * priimti šiukšlių.
 */
function _canonicalContents(value) {
  /**
   * NE MASYVAS – KLAIDA, ne tylus `null`.
   *
   * `contents` yra PRIVALOMAS manifesto laukas (žr. `backupManifest`
   * REQUIRED_FIELDS), tad `null`, `{}`, `"abc"` ar `undefined` prieštarauja
   * pačiai manifesto sutarčiai.
   *
   * Kriptografinės spragos tai nesukurdavo – AAD vis tiek būdavo
   * apskaičiuotas, ir pakeitus tikrą masyvą į `null` žyma nebesutaptų. Bet
   * tiesioginis modulio kvietėjas galėjo sukurti semantiškai netinkamą, o
   * kriptografiškai galiojantį `v2` manifestą – ir komentaras apie „griežtą
   * schemą" būtų buvęs netikslus.
   */
  if (!Array.isArray(value)) {
    throw _encryptionError("`contents` privalo būti masyvas.", "BACKUP_MANIFEST_INVALID");
  }

  return [...value]
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw _encryptionError("`contents` įrašas nėra objektas.", "BACKUP_MANIFEST_INVALID");
      }

      const count = Number(entry.count);
      const bytes = Number(entry.bytes);

      if (typeof entry.type !== "string" || !entry.type) {
        throw _encryptionError("`contents` įrašas be tipo.", "BACKUP_MANIFEST_INVALID");
      }
      if (!Number.isInteger(count) || count < 0 || !Number.isInteger(bytes) || bytes < 0) {
        throw _encryptionError(
          `\`contents\` įrašas "${entry.type}": count ir bytes privalo būti neneigiami sveikieji.`,
          "BACKUP_MANIFEST_INVALID"
        );
      }

      return { type: entry.type, count, bytes };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** Pasirenka AAD schemą pagal formato versiją. */
function manifestAad(manifest, format = FORMAT) {
  if (format === "v2") return manifestAadV2(manifest);

  throw _encryptionError(`AAD schema neapibrėžta formatui: ${format}`, "BACKUP_ENCRYPTION_FORMAT");
}
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standartas
/**
 * FORMATO VERSIJA.
 *
 * ⚠️ `v2` DĖL AAD, ne dėl algoritmo.
 *
 * `v1` buvo tas pats AES-256-GCM, bet BE manifesto autentifikavimo. GCM žyma
 * skaičiuojama ĮTRAUKIANT AAD, tad kopija, užšifruota be jo, su nauju kodu
 * NEDEŠIFRUOJAMA – `final()` krinta.
 *
 * Palikus `v1` egzistuotų dvi semantiškai skirtingos kopijos su tuo pačiu
 * vardu, ir atkūrimas neturėtų kaip jų atskirti. AAD pridėjimas yra FORMATO
 * pakeitimas, tad jis versijuojamas.
 */
const FORMAT = "v2";

/**
 * Formatai, kurių ši versija NEBEPRIIMA, su paaiškinimu operatoriui.
 *
 * `v1` egzistavo tik neišleistose #20 PR3 iteracijose – nė viena sumerginta
 * versija šifruotų kopijų nekūrė (PR2 šifravimo apskritai neturėjo). Todėl
 * `v1` kopijų realiuose diegimuose būti negali, ir jų palaikymas reikštų
 * mirusį kodą su savo klaidų rizika.
 *
 * Bet atmesti reikia AIŠKIAI: tyli nesėkmė atrodytų kaip sugadinta kopija.
 */
const UNSUPPORTED_FORMATS = {
  v1: "sukurta neišleista versija be manifesto autentifikavimo (AAD) – tokių kopijų diegimuose neturėtų būti",
};

/**
 * Nuskaito raktą iš aplinkos.
 *
 * Raktas turi būti 64 hex simboliai (32 baitai). Trumpesnis priimamas NEBŪTŲ
 * saugus, o tyliai jį „ištempti" reikštų apsimesti turint 256 bitų raktą,
 * kurio nėra.
 */
function _readKey(value, name) {
  if (!value) return null;

  if (!/^[0-9a-fA-F]{64}$/.test(String(value))) {
    const error = new Error(`${name} privalo būti 64 hex simboliai (32 baitai).`);
    error.code = "BACKUP_KEY_INVALID";
    throw error;
  }

  return Buffer.from(String(value), "hex");
}

function currentKey(env = process.env) {
  return _readKey(env.BACKUP_ENCRYPTION_KEY, "BACKUP_ENCRYPTION_KEY");
}

/**
 * ANKSTESNIS raktas – rotacijai.
 *
 * ⚠️ BE JO ROTACIJA PADARYTŲ SENAS KOPIJAS NEATKURIAMAS.
 *
 * Pakeitus raktą, visos ankstesnės kopijos taptų šiukšlėmis būtent tą akimirką,
 * kai jų gali prireikti. `BACKUP_ENCRYPTION_KEY_PREVIOUS` leidžia jas skaityti,
 * kol jos nustos galioti pagal retenciją arba bus peršifruotos.
 *
 * Naujos kopijos VISADA šifruojamos dabartiniu raktu – senasis naudojamas tik
 * dešifravimui.
 */
function previousKey(env = process.env) {
  return _readKey(env.BACKUP_ENCRYPTION_KEY_PREVIOUS, "BACKUP_ENCRYPTION_KEY_PREVIOUS");
}

/** Ar šifravimas sukonfigūruotas? */
function isEnabled(env = process.env) {
  return Boolean(env.BACKUP_ENCRYPTION_KEY);
}

/**
 * Užšifruoja kopijos turinį.
 *
 * @returns {{format: string, iv: string, authTag: string, ciphertext: string}}
 */
function encrypt(plaintext, { env = process.env, manifest } = {}) {
  /**
   * ⚠️ MANIFESTAS PRIVALOMAS – tai `v2` FORMATO SUTARTIES dalis.
   *
   * Palikus jį neprivalomą, `v2` reikštų DU skirtingus dalykus: „AES-GCM su
   * manifesto AAD" ir „AES-GCM be jo". Tai lygiai ta pati problema, dėl kurios
   * `v1` buvo pakeistas į `v2` – formato versija privalo nusakyti kriptografinę
   * sutartį, o ne tai, kaip konkretus kvietėjas pasirinko iškviesti funkciją.
   *
   * Praktinė rizika: būsimas migracijos ar administravimo skriptas galėtų
   * sukurti envelope su `format: "v2"`, kurio žyma apskaičiuota be AAD. Toks
   * failas atrodytų teisėtas, bet `restoreService` jo NEBEATKURTŲ, nes
   * dešifruodamas pridėtų AAD, kurio šifruojant nebuvo.
   */
  if (!manifest) {
    throw _encryptionError(`${FORMAT} šifravimui privalomas manifestas.`, "BACKUP_MANIFEST_REQUIRED");
  }

  const key = currentKey(env);
  if (!key) {
    const error = new Error("Šifravimas neįjungtas (`BACKUP_ENCRYPTION_KEY`).");
    error.code = "BACKUP_ENCRYPTION_DISABLED";
    throw error;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  // Manifestas susiejamas su turiniu - žr. AUTHENTICATED_MANIFEST_FIELDS.
  cipher.setAAD(manifestAad(manifest, FORMAT));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    format: FORMAT,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Dešifruoja, bandant dabartinį IR ankstesnį raktą.
 *
 * FAIL-CLOSED: jei nė vienas raktas netinka, metama klaida. Grąžinti dalinį ar
 * iškraipytą turinį būtų blogiau nei atviras atsisakymas – GCM žyma kaip tik
 * tam ir skirta.
 *
 * @returns {{plaintext: Buffer, usedPreviousKey: boolean}}
 */
/** Didžiausias priimtinas šifruotas turinys – apsauga nuo atminties išnaudojimo. */
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Patikrina envelope STRUKTŪRĄ prieš bet kokias dideles alokacijas.
 *
 * Be jos `Buffer.from(x, "base64")` bandytų alokuoti tiek, kiek nurodyta
 * įvestyje – o įvestis ateina iš kopijos failo, kuriuo pasitikėti negalima.
 * Node crypto galiausiai daug klaidų atmestų, bet jau po alokacijos.
 */
function _assertEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw _encryptionError("Envelope nėra objektas.", "BACKUP_ENCRYPTION_FORMAT");
  }

  if (envelope.format !== FORMAT) {
    /**
     * Nebepalaikomiems formatams – KONKRETI priežastis.
     *
     * Tyli nesėkmė atrodytų kaip sugadinta kopija, ir operatorius ieškotų
     * problemos ne ten, kur ji yra.
     */
    const reason = UNSUPPORTED_FORMATS[envelope.format];

    throw _encryptionError(
      reason
        ? `Kopijos formatas "${envelope.format}" nebepalaikomas: ${reason}`
        : `Nežinomas šifravimo formatas: ${envelope.format}`,
      reason ? "BACKUP_FORMAT_UNSUPPORTED" : "BACKUP_ENCRYPTION_FORMAT"
    );
  }

  for (const field of ["iv", "authTag", "ciphertext"]) {
    if (typeof envelope[field] !== "string" || envelope[field].length === 0) {
      throw _encryptionError(`Envelope laukas \`${field}\` privalo būti netuščia eilutė.`, "BACKUP_ENCRYPTION_FORMAT");
    }
  }

  // base64 ilgis ~4/3 nuo baitų - tikrinam PRIEŠ dekodavimą.
  if (envelope.ciphertext.length > (MAX_CIPHERTEXT_BYTES / 3) * 4) {
    throw _encryptionError("Šifruotas turinys viršija leistiną dydį.", "BACKUP_ENCRYPTION_TOO_LARGE");
  }

  const iv = Buffer.from(envelope.iv, "base64");
  if (iv.length !== IV_BYTES) {
    throw _encryptionError(`IV privalo būti ${IV_BYTES} baitai, gauta ${iv.length}.`, "BACKUP_ENCRYPTION_FORMAT");
  }

  const tag = Buffer.from(envelope.authTag, "base64");
  if (tag.length !== 16) {
    throw _encryptionError(`GCM žyma privalo būti 16 baitų, gauta ${tag.length}.`, "BACKUP_ENCRYPTION_FORMAT");
  }
}

function _encryptionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decrypt(envelope, { env = process.env, manifest } = {}) {
  _assertEnvelopeShape(envelope);

  /**
   * Ta pati sutartis dešifruojant: be manifesto `v2` envelope perskaityti
   * NEGALIMA. Priešingu atveju modulis pats leistų apeiti AAD apsaugą, kurią
   * jis įveda.
   */
  if (!manifest) {
    throw _encryptionError(`${envelope.format} dešifravimui privalomas manifestas.`, "BACKUP_MANIFEST_REQUIRED");
  }

  const candidates = [
    { key: currentKey(env), previous: false },
    { key: previousKey(env), previous: true },
  ].filter((candidate) => candidate.key);

  if (candidates.length === 0) {
    const error = new Error("Nėra dešifravimo rakto (`BACKUP_ENCRYPTION_KEY`).");
    error.code = "BACKUP_ENCRYPTION_DISABLED";
    throw error;
  }

  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, candidate.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));

      // TAS PATS AAD kaip šifruojant - kitaip `final()` kris.
      decipher.setAAD(manifestAad(manifest, envelope.format));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);

      return { plaintext, usedPreviousKey: candidate.previous };
    } catch {
      // Šis raktas netiko - bandom kitą.
    }
  }

  const error = new Error("Nepavyko dešifruoti: netinkamas raktas arba pakeistas turinys.");
  error.code = "BACKUP_DECRYPTION_FAILED";
  throw error;
}

/** Naujo rakto generavimas – operatoriui. */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

module.exports = {
  ALGORITHM,
  FORMAT,
  AUTHENTICATED_MANIFEST_FIELDS,
  UNSUPPORTED_FORMATS,
  manifestAadV2,
  MAX_CIPHERTEXT_BYTES,
  manifestAad,
  isEnabled,
  currentKey,
  previousKey,
  encrypt,
  decrypt,
  generateKey,
};
