/**
 * KEYSET KURSORIUS (#155, 7.4c / #212).
 *
 * ⚠️ „OPAQUE" NEREIŠKIA „ŠIFRUOTAS".
 *
 * Kursorius keliauja URL'e ir patenka į nginx access logus. Todėl jame NĖRA
 * filtrų reikšmių - `job_id` ten atsidūręs būtų tiksliai tas plaintext
 * nutekėjimas, kurio visas 7.4a/7.4b privatumo darbas vengia. Filtrų aibė
 * susiejama HMAC ATSPAUDU: serveris patikrina, ar kursorius grąžintas su ta
 * pačia užklausa, bet pačių reikšmių neatkuria ir jų nereikia.
 *
 * ⚠️ RŪŠIAVIMO RAKTAS - `seq`, VIENAS (7.4b tvarkos autoritetas).
 *
 * `timestamp` netinka: `now()` vienoje transakcijoje visoms eilutėms grąžina tą
 * patį momentą. `seq` unikalus ir monotoniškas, tad laužtuko nereikia, ir
 * kursorius yra vienas skaičius.
 */

const crypto = require("node:crypto");

/** ⚠️ 16 baitų pagal #212 - pakanka susiejimui, netempia URL. */
const FINGERPRINT_BYTES = 16;

class CursorError extends Error {
  constructor(message) {
    super(message);
    this.name = "CursorError";
    this.code = "AUDIT_CURSOR_INVALID";
  }
}

/**
 * Filtrų aibės atspaudas.
 *
 * ⚠️ KANONINĖ FORMA. Raktai rikiuojami, `null` ir `undefined` suvienodinami -
 * kitaip ta pati užklausa, parašyta kita tvarka, duotų kitą atspaudą, ir
 * teisėtas kursorius būtų atmestas.
 *
 * ⚠️ KRYPTIS ĮEINA Į ATSPAUDĄ (#212): pakeitus rūšiavimą kursorius privalo tapti
 * negaliojantis, nes jo `seq` riba reikštų priešingą pusę.
 */
function fingerprint(filtrai, aktyvusSecret) {
  if (!aktyvusSecret) {
    throw new CursorError("Kursoriaus atspaudui reikia aktyvaus rakto, o jo nėra.");
  }

  const kanoninis = JSON.stringify(
    Object.keys(filtrai)
      .sort()
      .reduce((acc, raktas) => {
        const reiksme = filtrai[raktas];
        acc[raktas] = reiksme === undefined ? null : reiksme;
        return acc;
      }, {})
  );

  return crypto
    .createHmac("sha256", aktyvusSecret)
    .update(kanoninis)
    .digest("base64url")
    .slice(0, Math.ceil((FINGERPRINT_BYTES * 8) / 6));
}

/** @returns {string} URL-safe tokenas. */
function encode(seq, atspaudas) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new CursorError(`Kursoriaus \`seq\` privalo būti neneigiamas sveikasis (gauta: ${typeof seq}).`);
  }

  return Buffer.from(JSON.stringify({ s: seq, f: atspaudas }), "utf8").toString("base64url");
}

/**
 * @returns {{seq: number, fingerprint: string}}
 * @throws {CursorError} sugadintam, nepilnam ar semantiškai netinkamam tokenui.
 *
 * ⚠️ VISOS NESĖKMĖS - `CursorError`, ne `SyntaxError` ir ne `TypeError`.
 * Maršrutas iš to daro 400; be šito sugadintas kursorius virstų 500, t. y.
 * kliento klaida atrodytų kaip serverio gedimas (#212).
 */
function decode(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new CursorError("Kursorius tuščias arba ne tekstas.");
  }

  let turinys;
  try {
    turinys = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    /** ⚠️ Priežastis NEPERSIUNČIAMA: jos tekste gali būti kliento duomenų. */
    throw new CursorError("Kursoriaus nepavyko iškoduoti.");
  }

  if (!turinys || typeof turinys !== "object" || Array.isArray(turinys)) {
    throw new CursorError("Kursoriaus turinys nėra objektas.");
  }
  if (!Number.isSafeInteger(turinys.s) || turinys.s < 0) {
    throw new CursorError("Kursoriuje trūksta tinkamos `seq` reikšmės.");
  }
  if (typeof turinys.f !== "string" || turinys.f.length === 0) {
    throw new CursorError("Kursoriuje trūksta filtrų atspaudo.");
  }

  return { seq: turinys.s, fingerprint: turinys.f };
}

/**
 * Iškoduoja ir patikrina, ar kursorius priklauso ŠIAI filtrų aibei.
 *
 * ⚠️ Rotavus aktyvų raktą atspaudas nebesutampa, ir anksčiau išduoti kursoriai
 * tampa negaliojantys. Tai SĄMONINGA #212 pasekmė, ne defektas: alternatyva
 * būtų atspaudą raktuoti kažkuo, kas nesikeičia, o tokio bendro rakto sistemoje
 * nėra. Kaina - klientas pradeda puslapiavimą iš naujo.
 */
function decodeForFilters(token, filtrai, aktyvusSecret) {
  const { seq, fingerprint: gautas } = decode(token);
  const laukiamas = fingerprint(filtrai, aktyvusSecret);

  if (gautas.length !== laukiamas.length || !crypto.timingSafeEqual(Buffer.from(gautas), Buffer.from(laukiamas))) {
    throw new CursorError(
      "Kursorius neatitinka šios užklausos filtrų arba rūšiavimo. Filtrus pakeitus " +
        "puslapiavimas pradedamas iš naujo; tas pats galioja po aktyvaus rakto rotacijos."
    );
  }

  return seq;
}

module.exports = { CursorError, FINGERPRINT_BYTES, fingerprint, encode, decode, decodeForFilters };
