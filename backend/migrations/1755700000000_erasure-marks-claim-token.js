/**
 * PRETENZIJOS ŽETONAS: `erasure_marks.claim_token` (#155, 7.5a / #183).
 *
 * ⚠️ KODĖL STULPELIS, O NE `updated_at` PALYGINIMAS.
 *
 * Peržiūroje buvo pasiūlyta pretenziją daryti compare-and-swap būdu ant
 * `updated_at`. Tai NEUŽDARO lango: CAS atskiria tik tuos, kurie perskaitė TĄ
 * PAČIĄ reikšmę, t. y. atėjusius vienu metu. Vėliau atėjusi replika perskaito
 * jau po-pretenzijos reikšmę ir sėkmingai ja pasiremia:
 *
 *   t1  A: CAS(T0) ✓ → updated_at = T1, A trina
 *   t2  B: skaito T1, CAS(T1) ✓ → B TAIP PAT trina
 *
 * Tvarus išskirtinumas reikalauja arba BŪSENOS, arba laikomo lock'o, arba
 * nuomos. Lock'as per išorinį I/O DoD draudžiamas, nuomos 7.5a atsisakė - lieka
 * būsena. `updated_at` yra laiko žyma, ne pretenzijos būsena.
 *
 * ⚠️ ŽETONAS IDENTIFIKUOJA BANDYMĄ, NE VYKDYTOJĄ.
 *
 * Atsitiktinis UUID kiekvienai pretenzijai, o NE proceso ar instancijos ID: tas
 * pats procesas po restarto neturi „atpažinti" savo seno žetono ir tęsti darbo,
 * kurio nebedaro. Po restarto nepaveldima jokia pretenzija.
 *
 * ⚠️ ASMENS DUOMENŲ ČIA NĖRA - UUID atsitiktinis, su niekuo nesusietas.
 *
 * ŽETONO GYVAVIMO TAISYKLĖ (viena, ir ji gyvena `_perkelti`):
 * žetonas galioja lygiai tiek, kiek trunka `deletion_pending` būsena. Jį
 * nustato TIK `INSERT` (kūrėjas) arba pretenzijos `UPDATE` (autorizuotas
 * pakartojimas), o VISI perėjimai jį išvalo. Todėl:
 *
 *   - `pending → deleted` - terminalizacija žetoną nuvalo (jis ten nieko negina);
 *   - `pending → failed` - įskaitant `release`;
 *   - `failed → pending` - `retry` palieka NULL, t. y. autorizuota, bet nepaimta.
 *
 * Dvi vietos, valančios tą patį lauką, būtų ta pati klasė kaip dvi kartojimo
 * sistemos - todėl vieta viena.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("erasure_marks", {
    claim_token: { type: "uuid" },
  });

  /**
   * Dalinis indeksas: užklausiama tik „ar ši `pending` žyma nepaimta".
   * Terminalės eilutės į indeksą nepatenka - jos žetono neturi.
   */
  pgm.createIndex("erasure_marks", ["job_id"], {
    name: "erasure_marks_unclaimed_idx",
    where: "claim_token IS NULL AND status = 'deletion_pending'",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("erasure_marks", ["job_id"], {
    name: "erasure_marks_unclaimed_idx",
    ifExists: true,
  });
  pgm.dropColumn("erasure_marks", "claim_token");
};
