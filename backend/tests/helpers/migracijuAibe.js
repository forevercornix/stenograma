/**
 * MIGRACIJŲ POAIBIS PAGAL TVARKĄ, NE PAGAL VARDĄ (#376 Codex P2 #3).
 *
 * ⚠️ VARDO IŠIMTIS NĖRA „IKI ŠIOS MIGRACIJOS". `iki375()` filtravo
 * `f !== VIENO_ADRESO_MIGRACIJA`, t. y. šalino VIENĄ failą, o ne viską po jo.
 *
 * Pridėjus `1756800000000`, ji pateko į „iki #375" katalogą, `checkOrder`
 * atmestų #375 kaip ne eilės tvarka, ir testai kristų NEIŠBANDĘ to, ką turėjo
 * išbandyti. Gedimas atrodytų kaip #375 problema, nors priežastis — fixture.
 *
 * ⚠️ TA PATI TAISYKLĖ, KURIĄ #376 JAU UŽRAŠĖ `lock_timeout` GRĄŽINIMUI: migracijų
 * rinkinys yra TVARKA, ne vardų aibė, ir prielaida, galiojanti tik todėl, kad
 * niekas dar nepridėjo sekančio failo, nėra prielaida.
 *
 * ⚠️ GRYNA FUNKCIJA — tikrinama be DB ir be failų sistemos. Būtent tai leidžia
 * mutaciją paleisti lokaliai, o ne laukti CI.
 */

/**
 * Migracijos, einančios PRIEŠ nurodytą (leksikografiškai — laiko žymos prefiksas).
 *
 * @param {string[]} visos migracijų failų vardai
 * @param {string} riba failas, nuo kurio (imtinai) atkertama
 * @returns {string[]} surikiuotas poaibis
 */
function iki(visos, riba) {
  return [...visos].sort().filter((f) => f < riba);
}

module.exports = { iki };
