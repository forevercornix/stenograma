/**
 * VIENAS SAUGYKLOS ADRESAS ↔ VIENA REGISTRO EILUTĖ — DB INVARIANTAS (#375).
 *
 * ⚠️ KĄ TIKSLIAI PAKEIČIA. Iki šiol `(storage_type, storage_key)` unikalumą laikė
 * RAKTO GENERAVIMO KONVENCIJA: `bandymoRaktas()` deda `attemptId` į kelią, o jis
 * yra `crypto.randomUUID()`. Konvencija galioja tol, kol niekas nepakeičia rakto
 * schemos ir nepriderina trečios `registruoti()` kvietimo vietos. Niekas to
 * nesustabdytų — nei testas, nei schema.
 *
 * ⚠️ KODĖL TAI SVARBU DABAR. #351 D6 remsis būtent šia savybe: šlavėjo užraktas
 * serializuoja tik kandidatės pačios commit'ą, o saugumas TARP skirtingų bandymų
 * kyla iš to, kad du bandymai negali dalytis adresu. #375 yra #351 prielaida, ir
 * prielaida, kurios niekas netikrina, nėra prielaida.
 *
 * ⚠️ PILNAS, NE DALINIS (D1).
 *
 *   ❌ Tik `storage_key`: tas pats raktas `fs` ir `s3` saugyklose yra SKIRTINGI
 *      objektai. Unikalumas ant vieno stulpelio uždraustų teisėtą būseną.
 *   ❌ `WHERE busena <> 'abandoned'`: `abandoned` eilutė su tuo pačiu raktu yra
 *      LYGIAI tas bendras adresas, kurį šalina šlavėjas. Dalinis indeksas
 *      praleistų būtent pavojingą atvejį.
 *
 * ⚠️ GARANTIJA GALIOJA TIK REGISTRUI. „Vienas objektas ↔ vienas savininkas visoje
 * sistemoje" ji NETEIKIA: `job_results.storage_key` yra atskira nuorodų erdvė be
 * FK į šią lentelę (#375 atviras klausimas 2).
 *
 * ⚠️ KODĖL ATSKIRA MIGRACIJA, O NE `1756300000000` TAISYMAS. Migracija yra
 * istorijos įrašas; redagavus ankstesnę, jau migruota bazė indekso NEGAUTŲ, o
 * šviežia gautų — dvi bazės, praeinančios tuos pačius testus, turėtų skirtingas
 * garantijas. Ta pati priežastis užrašyta `1756400000000`.
 *
 * ⚠️ TRANSAKCINIS, NE `CONCURRENTLY`. Lentelė APRIBOTA, ne istorinė: šlavėjas
 * eilutes fiziškai trina (`attemptRegistry.pasalintiBandymus`), o erasure šalina
 * ir `committed`. Dydis ≈ vykdomi plius neseni job'ai, ne visa istorija. Prie
 * tokio dydžio `CONCURRENTLY` reikalautų `noTransaction` (precedento repo nėra)
 * ir atsineštų `INVALID` indekso kelią — kainą be atitinkamos naudos.
 */

exports.shorthands = undefined;

/**
 * ⚠️ VARDAS KARTOJAMAS, NE IMPORTUOJAMAS IŠ KONSTANTOS.
 *
 * Užšaldymo konvencija (`1756300000000`): migracija privalo reikšti tą patį po
 * metų, net jei kodas pasikeitė. Importas susietų istorijos įrašą su judančiu
 * moduliu. Kodo pusėje tas pats vardas gyvena `attemptRegistry.js`, ir juos
 * sieja kontraktinis testas, ne bendra konstanta.
 */
const INDEKSAS = "job_result_attempts_vienas_adresas";

exports.up = (pgm) => {
  /**
   * ⚠️ `lock_timeout` PRIVALOMAS, IR TAI NE HIGIENA (D3).
   *
   * `LOCK TABLE ... SHARE` ir `CREATE INDEX` laukia už KIEKVIENOS atviros
   * transakcijos, rašiusios į lentelę — tarp jų ir pakibusio rašytojo su atvira
   * `isipareigoti()` transakcija. Kol migracija laukia, eilėje už jos stovi VISI
   * nauji `registruoti()`, nes jie prašo nesuderinamo užrakto.
   *
   * Be ribos migracija sustabdo rezultatų rašymą NERIBOTAM laikui — ir tai
   * atrodo kaip pakibęs deploy'us, ne kaip gedimas. Su riba ji krenta GARSIAI,
   * per 5 s, ir deploy'us kartojamas, kai rašytojas atsilaisvina.
   *
   * 5 s pasirinkti sąmoningai: ilgiau nei normali rašymo transakcija (ji trunka
   * milisekundes), trumpiau nei bet kuris žmogaus pastebimas prastovos langas.
   */
  pgm.sql("SET LOCAL lock_timeout = '5s'");

  /**
   * ⚠️ UŽRAKTAS PRIEŠ PREFLIGHT, NE PO JO.
   *
   * Be jo tarp dublikatų patikros ir indekso statymo telpa naujas `INSERT`, ir
   * operatorius gautų plikąją `23505` vietoj D3 diagnostikos — t. y. preflight
   * pažadėtų tai, ko neduoda.
   *
   * `SHARE` pakanka: jis blokuoja rašymą, bet leidžia skaitymą, ir yra tas pats
   * lygis, kurį `CREATE INDEX` ima pats. Griežtesnis (`EXCLUSIVE`) sustabdytų ir
   * skaitymą be jokios papildomos naudos.
   */
  pgm.sql(`LOCK TABLE job_result_attempts IN SHARE MODE`);

  /**
   * ⚠️ PREFLIGHT YRA DIAGNOSTIKA, NE GARANTIJA. Galutinis autoritetas — pats
   * unikalaus indekso statymas žemiau. Preflight egzistuoja tam, kad operatorius
   * gautų SKAIČIŲ ir `storage_type`, o ne vieną PostgreSQL eilutę apie pirmą
   * pasitaikiusį raktą.
   *
   * ❌ JOKIO AUTOMATINIO „SUTVARKYMO". Trynimas, pervadinimas ar „palikti
   * naujausią" yra sprendimai APIE DUOMENIS, ne apie schemą. Dublikatas čia
   * reiškia, kad du bandymai rodo į vieną objektą — kuris iš jų teisėtas,
   * migracija žinoti negali, o suklydusi sunaikintų vienintelę transkripcijos
   * kopiją.
   *
   * ⚠️ RAKTŲ IŠVESTYJE NĖRA. `1756300000000` užrašė, kad `storage_key` asmens
   * duomenų neturi, bet diagnostikai pakanka skaičiaus ir tipo — o migracijų
   * išvestis keliauja į deploy'aus logus, kurių retencija kitokia nei DB.
   */
  pgm.sql(`
    DO $$
    DECLARE
      dublikatu bigint;
      tipai text;
    BEGIN
      SELECT count(*), coalesce(string_agg(DISTINCT d.storage_type, ', ' ORDER BY d.storage_type), '-')
        INTO dublikatu, tipai
        FROM (
          SELECT storage_type, storage_key
            FROM job_result_attempts
           GROUP BY storage_type, storage_key
          HAVING count(*) > 1
        ) d;

      IF dublikatu > 0 THEN
        RAISE EXCEPTION
          'job_result_attempts turi % adresą(-us), kuriuo(-iais) dalijasi daugiau nei vienas bandymas '
          '(storage_type: %). Migracija sustabdyta: automatinis sutvarkymas yra sprendimas apie '
          'duomenis, ne apie schemą, ir suklydęs sunaikintų vienintelę transkripcijos kopiją. '
          'Raktai čia sąmoningai nerodomi — peržiūrėkite DB pusėje: '
          'SELECT storage_type, storage_key, count(*), array_agg(attempt_id) '
          'FROM job_result_attempts GROUP BY 1, 2 HAVING count(*) > 1; '
          'Žr. #375.', dublikatu, tipai;
      END IF;
    END $$;
  `);

  /**
   * ⚠️ NEVEIKIANTIS INDEKSAS TUO PAČIU VARDU — TIKRINAMA PRIEŠ STATYMĄ (D6).
   *
   * ❌ `IF NOT EXISTS` čia būtų tyli katastrofa: po nepavykusio `CONCURRENTLY`
   * statymo lieka `INVALID` indeksas tuo vardu, `IF NOT EXISTS` jį praleidžia,
   * migracija praeina ŽALIA, o konstrainto nėra. Tai yra būtent ta klaida,
   * kurios šis issue neturi palikti.
   *
   * Plikas `CREATE UNIQUE INDEX` tokiu atveju irgi kristų (`42P07`), bet su
   * pranešimu „relation already exists", kuris operatoriui nepasako, KAD indeksas
   * neveikiantis ir KĄ su juo daryti. Todėl atvejis atskiriamas čia.
   */
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = 'job_result_attempts_vienas_adresas'
           AND NOT i.indisvalid
      ) THEN
        RAISE EXCEPTION
          'Indeksas job_result_attempts_vienas_adresas jau egzistuoja, bet yra NEVEIKIANTIS '
          '(indisvalid = false) — likęs po nutrūkusio statymo. Jis NIEKO neužtikrina, tad '
          'migracija nepraeis tyliai. Pašalinkite jį (DROP INDEX job_result_attempts_vienas_adresas) '
          'ir kartokite. Žr. #375 D6.';
      END IF;
    END $$;
  `);

  pgm.createIndex("job_result_attempts", ["storage_type", "storage_key"], {
    name: INDEKSAS,
    unique: true,
  });

  /**
   * ⚠️ PO STATYMO — PATIKRINTI, KAD INDEKSAS REALIAI GALIOJA (D6).
   *
   * Transakciniame kelyje `CREATE UNIQUE INDEX` arba pavyksta, arba krenta, tad
   * `indisvalid = false` čia neturėtų atsirasti. Patikra lieka kaip tvora: jei
   * kas nors kada nors perrašys šią migraciją į `CONCURRENTLY`, ji pagaus
   * `INVALID` rezultatą, o ne leis migracijai paskelbti sėkmę be konstrainto.
   */
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = 'job_result_attempts_vienas_adresas'
           AND i.indisvalid
           AND i.indisunique
      ) THEN
        RAISE EXCEPTION
          'job_result_attempts_vienas_adresas nesukurtas arba neveikiantis po statymo. '
          'Migracija NEGALI skelbti sėkmės — #351 D6 remtųsi invariantu, kurio nėra. Žr. #375 D6.';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex("job_result_attempts", ["storage_type", "storage_key"], { name: INDEKSAS });
};
