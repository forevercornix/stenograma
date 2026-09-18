/**
 * DIEGIMO TAPATYBĖ — „AR TAI TAS PATS DIEGIMAS" (#155, 7.6c / #250).
 *
 * ⚠️ TAI KITAS KLAUSIMAS NEI `pgConnection.arTaPatiBaze()`.
 *
 * `pgConnection` atsako „kur `pg` realiai jungsis" — tai VIETA. Šis modulis
 * atsako „ar šie duomenys yra to paties diegimo" — tai TAPATYBĖ. DR metu vieta
 * beveik visada kita, o tapatybė privalo išlikti; sumaišius abu, sargas kristų
 * kiekvienoje tikroje avarijoje ir taptų ceremonija.
 *
 * ⚠️ IDENTIFIKATORIUS KELIAUJA SU `pg_dump`. Jis gyvena eilutėje, tad atkurta
 * bazė turi ŠALTINIO tapatybę — būtent tai leidžia ištrynimo žurnalui atpažinti
 * „savo" duomenis kitame hoste.
 *
 * ⚠️ TAI DUOMENŲ KILMĖS, NE APLINKOS TAPATYBĖ.
 *
 * Staging, atkurtas iš produkcijos dump'o, turi produkcijos identifikatorių, tad
 * produkcijos žurnalas kilmės patikrą prieš jį PRAEIS — ir replay ten ištrins tuos
 * pačius `job_id`. Tai teisinga (duomenys tie patys), bet operatorius, skaitantis
 * „kilmės sargas", gali tikėtis APLINKOS apsaugos, kurios čia nėra ir neturi būti.
 *
 * ⚠️ RIBA, KURIOS SARGAS NEDENGIA PAGAL KONSTRUKCIJĄ: du klonai iš to paties
 * dump'o turi TĄ PATĮ identifikatorių, tad vieno klono žurnalas praeis prieš kitą.
 * Tai neišvengiama pasirinkus duomenų kilmės tapatybę — ta pati klasė kaip
 * `pgConnection.js` riba „du klasteriai tame pačiame hoste su vienodu bazės vardu
 * palyginime sutampa". Užrašyta čia, kad neliktų numanoma.
 */

class DeploymentIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeploymentIdentityError";
    this.code = code;
  }
}

/**
 * Nuskaito diegimo identifikatorių.
 *
 * ⚠️ FAIL-CLOSED, NE `null`. Lentelės nebuvimas reiškia, kad bazė nemigruota
 * (arba atkurta iš dump'o, senesnio už šią migraciją). Grąžinus `null`, kilmės
 * patikra tyliai virstų „nežinau, tad leidžiu" — tai fail-open būtent toje
 * vietoje, kur sprendžiama, ar trinti svetimus duomenis.
 *
 * @param {{query: Function}} vykdytojas pool arba transakcijos klientas
 */
async function skaitytiTapatybe(vykdytojas) {
  if (!vykdytojas || typeof vykdytojas.query !== "function") {
    throw new TypeError("skaitytiTapatybe: reikia DB kliento arba pool'o.");
  }

  let rows;
  try {
    ({ rows } = await vykdytojas.query("SELECT deployment_id FROM deployment_identity WHERE id"));
  } catch (klaida) {
    throw new DeploymentIdentityError(
      `Diegimo tapatybės lentelės nėra arba ji nepasiekiama (${klaida.code || klaida.message}). ` +
        "Paleiskite migracijas (`npm run migrate:up`) prieš ištrynimo žurnalo operacijas.",
      "DEPLOYMENT_IDENTITY_MISSING"
    );
  }

  if (!rows.length || !rows[0].deployment_id) {
    throw new DeploymentIdentityError(
      "Diegimo tapatybės eilutės nėra. Migracija ją sukuria; jei bazė atkurta iš " +
        "senesnio dump'o, paleiskite migracijas prieš importą.",
      "DEPLOYMENT_IDENTITY_MISSING"
    );
  }

  return String(rows[0].deployment_id);
}

/**
 * Ar žurnalas kilęs iš ŠIO diegimo?
 *
 * ⚠️ GRĄŽINA SPRENDIMĄ, NE META KLAIDOS. Kvietėjas (koordinatorius) turi savo
 * klaidų kodus ir savo audito įrašą; čia gyvena tik palyginimas, kad jo
 * kartojimo nebūtų dviejose vietose.
 */
function arTasPatsDiegimas(zurnaloId, bazesId) {
  return Boolean(zurnaloId) && Boolean(bazesId) && String(zurnaloId) === String(bazesId);
}

module.exports = { DeploymentIdentityError, skaitytiTapatybe, arTasPatsDiegimas };
