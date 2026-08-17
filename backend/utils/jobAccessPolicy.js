const { OWNER_KIND } = require("./jobStore/common");

/**
 * JOB PRIEIGOS POLITIKA (#160).
 *
 * GRYNA FUNKCIJA. Ji priima SPRENDIMĄ, bet nevykdo veiksmo: nekviečia store'o,
 * nieko netrina ir neaudituoja. Šalutinis poveikis lieka servise.
 *
 * Priešingu atveju „bendras HTTP mapping helperis" tyliai virstų authorization
 * + deletion orchestration moduliu, o lenktynių scenarijus taptų sunku
 * testuoti izoliuotai.
 *
 * Politika gyvena VIENOJE vietoje sąmoningai. #159 tą pačią pamoką davė
 * `getOwnerScope()`: trys kopijos (`GET`, `DELETE`, eksportas) neišvengiamai
 * išsiskiria, o skirtumas yra tyli politikos spraga.
 */

/** Ką store grąžino vartotojo scope'ui. */
const ACCESS_INPUT = Object.freeze({
  /** Job'as rastas ir priklauso iškviečiančiajam. */
  OWNED: "owned",
  /** Job'as YRA, bet svetimas arba legacy (`jobStore.FORBIDDEN`). */
  FORBIDDEN: "forbidden",
  /** Job'o store'e NĖRA – našlaitis arba niekada nebuvo (`null`). */
  MISSING: "missing",
});

/** Politikos sprendimas. Maršrutas jį verčia HTTP atsaku, servisas – veiksmu. */
const ACCESS_DECISION = Object.freeze({
  /** Leidžiama kaip savininkui. */
  OWNER_ACCESS: "owner_access",
  /** Leidžiamas administracinis trynimas svetimo/legacy job'o. */
  ADMIN_DELETE_OVERRIDE: "admin_delete_override",
  /** Leidžiamas administracinis našlaičių valymas. */
  ADMIN_ORPHAN_CLEANUP: "admin_orphan_cleanup",
  /**
   * Našlaičių valymas VIENO VARTOTOJO režime (desktop / no-auth).
   *
   * Atskiras nuo administracinio sąmoningai: tai NĖRA override. Grėsmės
   * modelis našlaičių valymui yra „kitas vartotojas žino tavo job ID" – o
   * desktop režime kitų vartotojų NĖRA. Padarius jį admin-only, desktop
   * diegime našlaičių valymas taptų neįmanomas, nes ten admin'o iš viso nėra;
   * kartu dingtų galimybė ištrinti duomenis, kurių job įrašas jau pasibaigė
   * pagal TTL (GDPR reikšminga).
   *
   * Atskiras sprendimas leidžia auditui skirti šiuos du atvejus.
   */
  DESKTOP_ORPHAN_CLEANUP: "desktop_orphan_cleanup",
  /** Draudžiama, bet egzistavimas NESLEPIAMAS (403) – tik session-admin. */
  DENIED: "denied",
  /** Draudžiama IR egzistavimas slepiamas (404). */
  NOT_FOUND: "not_found",
});

const OPERATION = Object.freeze({
  READ: "read",
  EXPORT: "export",
  DELETE: "delete",
});

/**
 * Ar iškviečiantysis yra SESSION-ADMIN?
 *
 * ⚠️ NEPAKANKA `role === "administrator"`.
 *
 * `middleware/authorize.js:35`:
 *
 *     const raw = (env.API_KEY_ROLE || "administrator").trim().toLowerCase();
 *
 * `API_KEY_ROLE` NUMATYTOJI reikšmė yra `administrator`. Todėl patikra vien
 * pagal rolę atidarytų trynimo override KIEKVIENAM bendro rakto turėtojui
 * pagal nutylėjimą – be jokios konfigūracijos klaidos.
 *
 * Override teisė priklauso principalo RŪŠIAI ir rolei kartu: tik sesijos
 * tapatybė su stabiliu `userId` ir `administrator` role.
 */
function isSessionAdmin(actor) {
  if (!actor) return false;
  return (
    actor.ownerKind === OWNER_KIND.USER &&
    Boolean(actor.ownerId) &&
    actor.role === "administrator"
  );
}

/**
 * @param {object} params
 * @param {string} params.input – `ACCESS_INPUT` reikšmė
 * @param {{ownerId: string|null, ownerKind: string, role: string}} params.actor
 * @param {string} params.operation – `OPERATION` reikšmė
 * @returns {string} `ACCESS_DECISION` reikšmė
 */
function decideJobAccess({ input, actor, operation }) {
  if (!Object.values(ACCESS_INPUT).includes(input)) {
    throw new TypeError(`decideJobAccess: nežinomas input: ${String(input)}`);
  }
  if (!Object.values(OPERATION).includes(operation)) {
    throw new TypeError(`decideJobAccess: nežinoma operacija: ${String(operation)}`);
  }

  if (input === ACCESS_INPUT.OWNED) return ACCESS_DECISION.OWNER_ACCESS;

  const admin = isSessionAdmin(actor);

  /**
   * SVETIMAS ARBA LEGACY job'as (store'e YRA).
   *
   * Override yra OPERACIJOS, ne rolės savybė: admin gali IŠTRINTI, bet negali
   * SKAITYTI. Svetimo protokolo skaitymas jautresnis nei trynimas – trynimas
   * turinio nepamato. Least privilege.
   *
   * Admin'ui grąžinamas `DENIED` (403), ne `NOT_FOUND`: administraciniame
   * kontekste egzistavimo slėpimas nėra prioritetas, o skirtumas tarp „nėra"
   * ir „yra, bet skaitymo override neleidžiamas" yra diagnostiškai vertingas.
   */
  if (input === ACCESS_INPUT.FORBIDDEN) {
    if (!admin) return ACCESS_DECISION.NOT_FOUND;
    return operation === OPERATION.DELETE
      ? ACCESS_DECISION.ADMIN_DELETE_OVERRIDE
      : ACCESS_DECISION.DENIED;
  }

  /**
   * JOB'O STORE'E NĖRA – našlaitis arba niekada nebuvo.
   *
   * ⚠️ `MISSING` ir `FORBIDDEN` NEGALI dalytis viena šaka: legacy job'as
   * store'e YRA (tik be `ownerKind`), našlaičio NĖRA. Skiriasi tai, ką
   * apskritai galima įrodyti apie nuosavybę.
   *
   * Našlaičių valymas yra admin-only: kai store įrašo nebėra, nuosavybės
   * patikrinti neįmanoma (`ownershipVerified: false`), tad eilinis vartotojas,
   * žinantis job ID, galėtų ištrinti svetimus BullMQ ir audito pėdsakus.
   */
  /**
   * DESKTOP IŠIMTIS – tik `UNOWNED` principalui ir tik `DELETE`.
   *
   * `API_KEY` čia NEPATENKA sąmoningai: bendrą raktą gali turėti keli žmonės
   * ar servisai, tad „kitų vartotojų nėra" prielaida jam negalioja.
   */
  if (actor && actor.ownerKind === OWNER_KIND.UNOWNED) {
    return operation === OPERATION.DELETE
      ? ACCESS_DECISION.DESKTOP_ORPHAN_CLEANUP
      : ACCESS_DECISION.NOT_FOUND;
  }

  if (!admin) return ACCESS_DECISION.NOT_FOUND;
  return operation === OPERATION.DELETE
    ? ACCESS_DECISION.ADMIN_ORPHAN_CLEANUP
    : ACCESS_DECISION.DENIED;
}

module.exports = {
  ACCESS_INPUT,
  ACCESS_DECISION,
  OPERATION,
  isSessionAdmin,
  decideJobAccess,
};
