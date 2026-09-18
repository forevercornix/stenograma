/**
 * AUDITO SAUGYKLOS SEAMAS — VIENAS, KELIEMS TESTAMS (#155, #250).
 *
 * ⚠️ SEAMAS YRA `auditStore.current()`, NE `rasytiAudita()`.
 *
 * Pakeitus patį `rasytiAudita()` testas tikrintų savo stub'ą: dingtų blokuojančio
 * įvykio politika (klaida → sėkmė nedeklaruojama), o būtent ji dažniausiai ir yra
 * tikrinamas dalykas. Keičiama tik SAUGYKLA — kaip `sessionStore._setStoreForTests()`
 * sesijų pusėje; visas kelias virš jos lieka produkcinis.
 *
 * ⚠️ `tikIvykiui` YRA ESMINIS, NE PATOGUMAS.
 *
 * Sulaužius VISĄ saugyklą, `eraseJob()` krenta ties savo paties `DATA_ERASED`
 * kvitu, ir testas matuoja kitą kelią, nei skelbia pavadinime. Būtent taip
 * `erasureReplayContract` tvarkos mutacija iš pradžių NEBUVO pagauta: mutuota
 * eilutė net nebūdavo pasiekiama.
 *
 * Helperis bendras, nes dvi kopijos ilgainiui išsiskirtų, o skirtumas būtų
 * matomas tik kaip praeinanti mutacija.
 */

/**
 * @param {Function} veiksmas kviečiama su sugadinta saugykla
 * @param {object} [opcijos]
 * @param {string|null} [opcijos.tikIvykiui] laužyti `append()` TIK šiam įvykiui
 * @returns {Promise<*>} `veiksmas` rezultatas; saugykla visada atstatoma
 */
function suSugadintuAuditu(veiksmas, { tikIvykiui = null } = {}) {
  const auditStore = require("../../utils/auditStore");
  const tikrasis = auditStore.current;

  auditStore.current = () => {
    const realus = tikrasis();

    if (!tikIvykiui) {
      return {
        async append() {
          throw new Error("audito saugykla nepasiekiama");
        },
        async query() {
          return { entries: [], total: 0 };
        },
      };
    }

    return new Proxy(realus, {
      get(taikinys, raktas) {
        if (raktas === "append") {
          return async (eilute, kontekstas) => {
            if (eilute && eilute.event === tikIvykiui) {
              throw new Error(`audito rašymas nepasiekiamas (${tikIvykiui})`);
            }
            return taikinys.append(eilute, kontekstas);
          };
        }
        const reiksme = taikinys[raktas];
        return typeof reiksme === "function" ? reiksme.bind(taikinys) : reiksme;
      },
    });
  };

  return Promise.resolve()
    .then(veiksmas)
    .finally(() => {
      auditStore.current = tikrasis;
    });
}

module.exports = { suSugadintuAuditu };
