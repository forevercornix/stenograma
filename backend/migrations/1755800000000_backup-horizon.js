/**
 * IŠLEISTŲ KOPIJŲ HORIZONTAS: `backup_horizon` (#155, 7.5a / #183).
 *
 * ⚠️ KODĖL TO NEUŽTENKA SKAIČIUOTI IŠ `BACKUP_RETENTION_DAYS`.
 *
 * Ištrynimo žymos terminas išvedamas iš to, kiek laiko job'as dar gali būti
 * prikeltas - įskaitant atkūrimą iš kopijos. Iki šiol jis imdavo DABARTINĘ
 * `BACKUP_RETENTION_DAYS` reikšmę, bet jau IŠLEISTA kopija savo galiojimo
 * nepraranda, kai nustatymas sumažinamas:
 *
 *   d0   `BACKUP_RETENTION_DAYS=90`, sukuriama kopija - ji galioja iki d90
 *   d1   nustatymas sumažinamas iki 7
 *   d2   job'as ištrinamas -> žymos terminas ~8 dienos
 *   d10  žyma pašalinama, o d0 kopija tebegalioja iki d90
 *   d11  atkūrimas iš tos kopijos ID priima - ištrynimas ATSISTATO
 *
 * Serveris išleistų kopijų nesaugo, tad vienintelis būdas tai žinoti - įrašyti
 * horizontą jų KŪRIMO metu. Lentelėje viena eilutė: aukščiausia kada nors
 * išleista galiojimo riba, keliama per `GREATEST`, niekada nemažinama.
 *
 * ⚠️ ASMENS DUOMENŲ NĖRA - tik laiko žyma.
 *
 * ⚠️ APRIBOJIMAS: kopija, sukurta be `DATABASE_URL`, čia neužsirašo. Tai
 * įvardyta `docs/deletion-guarantees.md` kartu su kitais atmintinio režimo
 * apribojimais.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("backup_horizon", {
    /**
     * VIENA eilutė. `CHECK (id)` neleidžia antros: du „aukščiausi vandenys"
     * reikštų, kad skaitytojas turi rinktis, o rinkimasis čia yra klaida.
     */
    id: { type: "boolean", primaryKey: true, default: true, notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("backup_horizon", "backup_horizon_single_row", {
    check: "id",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("backup_horizon");
};
