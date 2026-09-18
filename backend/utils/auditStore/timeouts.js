/**
 * AUDITO RAŠYMO LAIKO BIUDŽETAS (#155, 7.4b / #211).
 *
 * ⚠️ TRYS LAIKMAČIAI, VIENAS BIUDŽETAS - IR JIE NEGALI BŪTI LYGŪS.
 *
 * `suRiba()` (7.4a) skaičiuoja nuo `rasytiAudita()` iškvietimo, tad į jo langą
 * patenka IR laukimas eilėje prie pool'o jungties. `statement_timeout`
 * skaičiuoja tik nuo užklausos pradžios. Nustačius abu į tą pačią reikšmę,
 * fasadas VISADA suveiktų pirmas, o DB nespėtų nutraukti nė vienos užklausos:
 * antra gynybos linija taptų pirmąja, o pirmoji - negaliojančia.
 *
 * Todėl biudžetas dalijamas:
 *
 *   pool'o laukimas   0.2 × T   (`connectionTimeoutMillis` - riboja eilę)
 *   užklausa          0.7 × T   (`statement_timeout` - DB NUTRAUKIA)
 *   ────────────────────────
 *   blogiausiu atveju 0.9 × T   <   T = `AUDIT_WRITE_TIMEOUT_MS`
 *
 * Likę 10 % yra atsarga tinklo ir serializavimo kaštams. Invariantas
 * tikrinamas VYKDYMO METU, ne komentare: neteisinga konfigūracija turi kristi
 * starte, o ne pasirodyti kaip retas timeout produkcijoje.
 *
 * ⚠️ `AUDIT_WRITE_TIMEOUT_MS` NEPARSINAMAS ČIA. Vienintelis jo autoritetas
 * lieka `utils/auditWrite.js` - antras parseris išsiskirtų tyliai.
 */

const { auditWriteTimeoutMs } = require("../auditWrite");

/**
 * ⚠️ TRYS RIBOS, IR JŲ TVARKA SVARBI.
 *
 * `pg` kliento `query_timeout` pradedamas skaičiuoti, kai užklausa IŠSIUNČIAMA,
 * o serverio `statement_timeout` - kai serveris pradeda ją VYKDYTI. Nustačius
 * abu vienodus, klientas suveikia pirmas: `pg` atmeta žadėjimą ir nustoja laukti,
 * bet serverio užklausos NENUTRAUKIA. INSERT, spėjęs įsirašyti per tą tarpą,
 * kvietėjui praneštas kaip nepavykęs, o `suRiba()` vėlyvos sėkmės apdorojimas
 * (logas + skaitiklis) apskritai nepasiekiamas - neatitikimas tampa nematomas.
 *
 * Todėl serveris visada turi suspėti pirmas:
 *
 *   pool'o laukimas   0.15 × T   connectionTimeoutMillis
 *   serveris          0.55 × T   statement_timeout   ← NUTRAUKIA
 *   klientas          0.70 × T   query_timeout       ← tik jei serveris nebeatsako
 *   ─────────────────────────
 *   blogiausiu atveju 0.85 × T   <   T = AUDIT_WRITE_TIMEOUT_MS
 */
const POOL_DALIS = 0.15;
const UZKLAUSOS_DALIS = 0.55;
const KLIENTO_DALIS = 0.7;

/**
 * @returns {{facadeMs: number, poolAcquireMs: number, statementMs: number}}
 * @throws {Error} jei dalys nebetelpa į fasado langą.
 */
function auditTimeoutBudget(env = process.env) {
  const facadeMs = auditWriteTimeoutMs(env);

  const poolAcquireMs = Math.max(1, Math.round(facadeMs * POOL_DALIS));
  const statementMs = Math.max(1, Math.round(facadeMs * UZKLAUSOS_DALIS));
  const clientMs = Math.max(2, Math.round(facadeMs * KLIENTO_DALIS));

  /**
   * ⚠️ SARGYBA, NE PRIELAIDA. Dalys yra konstantos, bet apvalinimas ties labai
   * mažomis reikšmėmis (testinis `AUDIT_WRITE_TIMEOUT_MS=3`) gali jas išpūsti
   * virš lango. Tokiu atveju DB nebespėtų nutraukti užklausos, ir garantija,
   * kurią šis modulis teikia, tyliai nustotų galioti.
   */
  if (statementMs >= clientMs) {
    throw new Error(
      `AUDIT_WRITE_TIMEOUT_MS=${facadeMs} per mažas: serverio riba (${statementMs} ms) ` +
        `nebeankstesnė už kliento (${clientMs} ms), tad DB nespėtų nutraukti užklausos ` +
        "ir vėlyva sėkmė taptų nematoma."
    );
  }

  if (poolAcquireMs + clientMs >= facadeMs) {
    throw new Error(
      `AUDIT_WRITE_TIMEOUT_MS=${facadeMs} per mažas: pool (${poolAcquireMs} ms) ` +
        `ir kliento (${clientMs} ms) ribos netelpa į fasado langą, tad DB ` +
        "nespėtų nutraukti užklausos ir vėlyvas rašymas taptų neišvengiamas."
    );
  }

  return { facadeMs, poolAcquireMs, statementMs, clientMs };
}

module.exports = { auditTimeoutBudget, POOL_DALIS, UZKLAUSOS_DALIS, KLIENTO_DALIS };
