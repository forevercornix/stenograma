const jobStore = require("./jobStore");

/**
 * IŠKVIEČIANČIOJO NUOSAVYBĖS SCOPE (#159).
 *
 * VIENA KOPIJA SĄMONINGAI. Ši logika yra saugumui kritinė, ir #159 metu ji
 * trumpam egzistavo trimis kopijomis (`routes/jobs.js`, `routes/transcribeJobs.js`,
 * inline `routes/exports.js`). Vienai kopijai pamiršus dev-open niuansą,
 * skirtingi endpoint'ai imtų taikyti SKIRTINGĄ nuosavybės politiką – ir tai
 * būtų tyli spraga, nes kiekvienas endpoint'as atskirai atrodytų teisingas.
 *
 * `ownerId` vienas nepakanka: `null` yra teisėtas trims skirtingoms būsenoms
 * (desktop, bendras `API_KEY`, legacy įrašas). Be rūšies jos suplaktų į vieną
 * reikšmę, ir bendro rakto turėtojas taptų legacy bei desktop job'ų savininku.
 *
 *   sesija         → USER    + stabilus UUID
 *   bendras raktas → API_KEY + null (raktas nėra individas – jį gali turėti
 *                    keli žmonės ar servisai)
 *   be auth        → UNOWNED + null (desktop režimas)
 *
 * @param {object} req
 * @returns {{ownerId: string|null, ownerKind: string}}
 */
function getOwnerScope(req) {
  if (req.user && req.user.id) {
    return { ownerId: req.user.id, ownerKind: jobStore.OWNER_KIND.USER };
  }

  /**
   * API_KEY vs DEV-OPEN.
   *
   * `req.authz.source === "api-key"` NEPAKANKA: `middleware/authenticate.js`
   * dev-open kelyje (nei rakto, nei sesijos, `NODE_ENV != production`) taip pat
   * nustato `apiKeyAuthenticated = true`, tad `source` tampa `"api-key"` be
   * jokio rakto. Tai desktop režimas, ne bendras raktas – ir be šios patikros
   * visi lokalūs job'ai taptų nepasiekiami jų kūrėjui.
   */
  const sharedCredentialConfigured = Boolean((process.env.API_KEY || "").trim());
  if (sharedCredentialConfigured && req.authz && req.authz.source === "api-key") {
    return { ownerId: null, ownerKind: jobStore.OWNER_KIND.API_PRINCIPAL };
  }

  return { ownerId: null, ownerKind: jobStore.OWNER_KIND.UNOWNED };
}

module.exports = { getOwnerScope };
