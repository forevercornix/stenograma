const jobStore = require("./jobStore");
const { getOwnerScope } = require("./ownerScope");
const {
  ACCESS_INPUT,
  ACCESS_DECISION,
  OPERATION,
  decideJobAccess,
  reikiaRezultato,
} = require("./jobAccessPolicy");

/**
 * POLITIKOS → HTTP ADAPTERIS (#160).
 *
 * VIENA VIETA VISIEMS MARŠRUTAMS. `GET`, eksportas ir `DELETE` egzistuoja
 * trijuose failuose; jei kiekvienas pats verstų `FORBIDDEN`/`null` į statusą,
 * politika neišvengiamai išsiskirtų, o skirtumas būtų tyli spraga — vienas
 * endpoint'as imtų grąžinti 403 ten, kur kitas grąžina 404, ir atsirastų
 * egzistavimo orakulas per „lengvesnį" kelią.
 *
 * ADAPTERIS NEPRIIMA SPRENDIMO. Sprendimą priima gryna
 * `decideJobAccess()`; adapteris tik paverčia store rezultatą į politikos
 * įėjimą ir sprendimą — į HTTP atsaką. Šalutinis poveikis (trynimas, auditas)
 * lieka `services/adminJobService.js`.
 */

/** Store rezultatas → politikos įėjimas. */
function toAccessInput(result) {
  if (result === jobStore.FORBIDDEN) return ACCESS_INPUT.FORBIDDEN;
  if (!result) return ACCESS_INPUT.MISSING;
  return ACCESS_INPUT.OWNED;
}

/**
 * Iškviečiančiojo tapatybė politikai: nuosavybės scope + rolė.
 *
 * Rolė imama iš `req.authz`, kurį nustato `middleware/authorize.js`. Rūšis —
 * iš `getOwnerScope()`, todėl `isSessionAdmin()` mato ABI dimensijas ir bendro
 * rakto `administrator` rolė override'o nesuteikia.
 */
function getAccessActor(req) {
  const scope = getOwnerScope(req);
  return { ...scope, role: req.authz ? req.authz.role : null };
}

/**
 * Nuskaito job'ą vartotojo scope'u ir priima politikos sprendimą.
 *
 * @returns {Promise<{decision: string, job: object|null, scope: object, actor: object}>}
 */
async function resolveJobAccess(req, jobId, operation) {
  const actor = getAccessActor(req);
  const scope = { ownerId: actor.ownerId, ownerKind: actor.ownerKind };

  /**
   * ⚠️ HIDRATACIJA YRA OPERACIJOS SPRENDIMAS (#157, PR-3).
   *
   * Ši grandinė prasideda MARŠRUTE, ne saugykloje: `resolveJobAccess()` naudoja
   * KIEKVIENAS interaktyvus endpoint'as (`routes/jobs.js` READ ir DELETE,
   * `routes/transcribeJobs.js` READ ir DELETE, `routes/exports.js`). Ieškant, kas
   * hidratuoja be reikalo, saugyklos metodų peržiūros NEPAKAKO — reikėjo eiti nuo
   * maršruto.
   *
   * `DELETE` rezultato nenaudoja, bet už jį mokėjo — ir krisdavo ties hidratacija
   * būtent tada, kai objektas sugadintas. Vėliavą parenka operacija, ne kvietėjas:
   * naujas endpoint'as gauna teisingą elgesį kartu su operacijos pasirinkimu.
   */
  const hydrate = reikiaRezultato(operation);
  const result = await jobStore.get({ jobId, ...scope }, { hydrate });
  const input = toAccessInput(result);

  return {
    decision: decideJobAccess({ input, actor, operation }),
    job: input === ACCESS_INPUT.OWNED ? result : null,
    scope,
    actor,
  };
}

/**
 * Atsako už NEIGIAMUS sprendimus. Grąžina `true`, jei užklausa jau atsakyta.
 *
 * `NOT_FOUND` → 404 (egzistavimas slepiamas)
 * `DENIED`    → 403 (tik session-admin: administraciniame kontekste slėpimas
 *                    nėra prioritetas, o skirtumas tarp „nėra" ir „yra, bet
 *                    skaitymo override neleidžiamas" yra diagnostiškai vertingas)
 *
 * ⚠️ APIMTIS: šis mapping'as skirtas INTERAKTYVIEMS SKAITYMO endpoint'ams
 * (`GET`) ir `DELETE`. Eksportas jo SĄMONINGAI nekviečia – ten `DENIED` ir
 * `NOT_FOUND` abu virsta `linkState = "missing"`, kad svetimas ir
 * neegzistuojantis job'as būtų neatskiriami audito `link=` lauke.
 *
 * Todėl `ADMIN_READ_NOT_ALLOWED` kodas čia yra tikslus, o ne per siauras.
 * Jei kada atsiras trečias interaktyvus endpoint'as su `DENIED`, kuriam šis
 * tekstas netiks, teisingas sprendimas – perduoti `operation` ir generuoti
 * kodą pagal ją, o ne praplėsti šį pranešimą į bendrinį.
 */
function respondToDenial(decision, res, { notFoundMessage } = {}) {
  if (decision === ACCESS_DECISION.NOT_FOUND) {
    res.status(404).json({
      error: notFoundMessage || "Jobas nerastas.",
    });
    return true;
  }

  if (decision === ACCESS_DECISION.DENIED) {
    res.status(403).json({
      error: "Šis darbas priklauso kitam vartotojui. Skaitymo override neleidžiamas.",
      code: "ADMIN_READ_NOT_ALLOWED",
    });
    return true;
  }

  return false;
}

module.exports = {
  ACCESS_DECISION,
  OPERATION,
  resolveJobAccess,
  respondToDenial,
  getAccessActor,
  toAccessInput,
};
