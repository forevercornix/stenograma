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

const POOL_DALIS = 0.2;
const UZKLAUSOS_DALIS = 0.7;

/**
 * @returns {{facadeMs: number, poolAcquireMs: number, statementMs: number}}
 * @throws {Error} jei dalys nebetelpa į fasado langą.
 */
function auditTimeoutBudget(env = process.env) {
  const facadeMs = auditWriteTimeoutMs(env);

  const poolAcquireMs = Math.max(1, Math.round(facadeMs * POOL_DALIS));
  const statementMs = Math.max(1, Math.round(facadeMs * UZKLAUSOS_DALIS));

  /**
   * ⚠️ SARGYBA, NE PRIELAIDA. Dalys yra konstantos, bet apvalinimas ties labai
   * mažomis reikšmėmis (testinis `AUDIT_WRITE_TIMEOUT_MS=3`) gali jas išpūsti
   * virš lango. Tokiu atveju DB nebespėtų nutraukti užklausos, ir garantija,
   * kurią šis modulis teikia, tyliai nustotų galioti.
   */
  if (poolAcquireMs + statementMs >= facadeMs) {
    throw new Error(
      `AUDIT_WRITE_TIMEOUT_MS=${facadeMs} per mažas: pool (${poolAcquireMs} ms) ` +
        `ir užklausos (${statementMs} ms) ribos netelpa į fasado langą, tad DB ` +
        "nespėtų nutraukti užklausos ir vėlyvas rašymas taptų neišvengiamas."
    );
  }

  return { facadeMs, poolAcquireMs, statementMs };
}

module.exports = { auditTimeoutBudget, POOL_DALIS, UZKLAUSOS_DALIS };
