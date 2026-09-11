/**
 * RESTORE VERIFIKACIJA: AR `storage_key` RODO Į VIENTISĄ ARTEFAKTĄ (#157, PR-7).
 *
 * ⚠️ ATASKAITA SKIRSTO PAGAL `nepriklausomas`, NE PAGAL `ok` — TAI VISO MODULIO ESMĖ.
 *
 * `verify()` inline eilutei gali tik perskaičiuoti sumą iš TO PATIES `payload`, iš
 * kurio ją ir gamintų — jis lygina reikšmę su savimi ir grąžina `ok: true` visada.
 * Tai ne klaida, o KITA garantija, ir kontraktas ją deklaruoja lauku
 * `nepriklausomas: false`.
 *
 * Po migracijos DB bus MIŠRI, ir inline eilučių joje bus dauguma. Ataskaita,
 * skaičiuojanti `ok`, parodytų beveik 100 % ir būtų MELAS: pratybos praeitų per
 * lengvai, o operatorius manytų patikrinęs tai, ko niekas netikrino.
 *
 * ⚠️ LAUKAS, KURIO NIEKAS NESKAITO, NĖRA GARANTIJA — lygiai kaip `neatkartojama` be
 * `UnrecoverableError` (#157, PR-4 pamoka). `nepriklausomas` egzistuoja nuo PR-2;
 * šis modulis yra pirmasis, kuris pagal jį SPRENDŽIA.
 *
 * ⚠️ SPRENDŽIAMA PER-ROW, NE PAGAL KONFIGŪRACIJĄ (sąlyga 6).
 *
 * Konfigūracija sako, kur rašoma ŠIANDIEN; eilutė sako, kur guli JAU ESANTIS
 * rezultatas. Mišrioje DB tai skirtingi atsakymai, ir `backupPolicy.TABLE_BY_TYPE`
 * antrojo nežino — todėl jis ir nebeteigia apie turinį (§12.1 korekcija ten).
 *
 * ⚠️ LAUKIAMA REIKŠMĖ IMAMA IŠ DB, NIEKADA NEPERSKAIČIUOJAMA IŠ TIKRINAMO OBJEKTO
 * (sąlyga 8).
 *
 * `bytes` ir `checksum` yra PR-1 kolonos, įrašytos rašymo metu kartu su nuoroda.
 * Perskaičiavus jas iš to paties objekto, kurį tikriname, verifikacija lygintų
 * objektą su savimi — tiksliai tas pats tuščias `ok: true`, tik be inline pateisinimo.
 * Būtent todėl čia kviečiamas `verify()`, o ne `head()`: `head()` grąžina tik dydį,
 * tad SUGADINTAS TO PATIES ILGIO objektas jį praeitų.
 *
 * ⚠️ KAINA UŽRAŠOMA: `verify()` PERSKAITO VISĄ OBJEKTĄ.
 *
 * `fs` ir S3 checksum'o metaduomenyse neturi, tad vientisumą patvirtinti galima tik
 * perskaičius (žr. `fsStore.verify()`). Vadinasi ši procedūra kainuoja vieną pilną
 * skaitymą kiekvienai external eilutei ir NĖRA metadata kelias. Ji paleidžiama
 * atkūrimo pratybose ir po restore, ne kiekviename starte.
 */

/** Eilutės verdiktas — užšaldyta aibė, nes ją cituoja ataskaita ir testai. */
const VERDIKTAS = Object.freeze({
  /** Objektas patikrintas prieš NEPRIKLAUSOMĄ metaduomenį. */
  PATIKRINTA: "patikrinta",
  /** Inline eilutė: nepriklausomo autoriteto NĖRA, tikrinti nebuvo ko. */
  NEPATIKRINAMA_INLINE: "nepatikrinama_inline",
  /** Objekto saugykloje nėra. */
  NERASTA: "nerasta",
  /** Objektas yra, bet neatitinka DB persistinto `bytes`/`checksum`. */
  NESUTAMPA: "nesutampa",
  /** `storage_type` neturi registruotos saugyklos — perskaityti neįmanoma. */
  SAUGYKLA_NEREGISTRUOTA: "saugykla_neregistruota",
  /**
   * External saugykla grąžino `nepriklausomas: false`.
   *
   * ⚠️ TAI KONTRAKTO PAŽEIDIMAS, NE INLINE ATVEJIS, ir jis turi savo verdiktą.
   * Suplakus jį su `nepatikrinama_inline`, backend'as, praradęs nepriklausomą
   * patikrą, ataskaitoje atrodytų kaip teisėta inline eilutė — t. y. regresija
   * pasislėptų po normalia būsena.
   */
  NEPRIKLAUSOMUMO_NETEKO: "nepriklausomumo_neteko",
});

/** Verdiktai, po kurių atkūrimas NEGALI būti paskelbtas sėkmingu. */
const NESEKMES = Object.freeze([
  VERDIKTAS.NERASTA,
  VERDIKTAS.NESUTAMPA,
  VERDIKTAS.SAUGYKLA_NEREGISTRUOTA,
  VERDIKTAS.NEPRIKLAUSOMUMO_NETEKO,
]);

/**
 * Vienos eilutės verdiktas.
 *
 * @param {object} eilute `{ job_id, storage_type, storage_key, bytes, checksum }`
 * @param {(tipas: string) => object} parinktiSaugykla rezolveris; meta nežinomam tipui
 */
async function patikrintiEilute(eilute, parinktiSaugykla) {
  if (eilute.storage_type === "inline") {
    return { jobId: eilute.job_id, storageType: "inline", verdiktas: VERDIKTAS.NEPATIKRINAMA_INLINE };
  }

  let saugykla;
  try {
    saugykla = parinktiSaugykla(eilute.storage_type);
  } catch (klaida) {
    /**
     * ⚠️ NEREGISTRUOTAS TIPAS — NESĖKMĖ, NE PRALEIDIMAS.
     *
     * Praleidus, ataskaita tylėtų apie eilutes, kurių perskaityti NEĮMANOMA, ir
     * atkūrimas būtų paskelbtas sėkmingu su nepasiekiamais rezultatais.
     */
    return {
      jobId: eilute.job_id,
      storageType: eilute.storage_type,
      verdiktas: VERDIKTAS.SAUGYKLA_NEREGISTRUOTA,
      detale: klaida.message,
    };
  }

  /**
   * ⚠️ LAUKIAMA IMAMA IŠ EILUTĖS, NE IŠ OBJEKTO. `bigint` per `node-postgres`
   * grįžta EILUTE, tad normalizuojama čia — `verify()` gauna tai, ką įrašė rašymas.
   */
  const laukiama = { bytes: Number(eilute.bytes), checksum: eilute.checksum };

  let verdiktas;
  try {
    verdiktas = await saugykla.verify(eilute.storage_key, laukiama);
  } catch (klaida) {
    return {
      jobId: eilute.job_id,
      storageType: eilute.storage_type,
      verdiktas: VERDIKTAS.NERASTA,
      detale: klaida.kodas || klaida.code || "ARTIFACT_ERROR",
    };
  }

  if (!verdiktas.exists) {
    return { jobId: eilute.job_id, storageType: eilute.storage_type, verdiktas: VERDIKTAS.NERASTA };
  }

  if (verdiktas.nepriklausomas !== true) {
    return {
      jobId: eilute.job_id,
      storageType: eilute.storage_type,
      verdiktas: VERDIKTAS.NEPRIKLAUSOMUMO_NETEKO,
    };
  }

  if (verdiktas.ok !== true) {
    return { jobId: eilute.job_id, storageType: eilute.storage_type, verdiktas: VERDIKTAS.NESUTAMPA };
  }

  return { jobId: eilute.job_id, storageType: eilute.storage_type, verdiktas: VERDIKTAS.PATIKRINTA };
}

/**
 * Ataskaita iš eilučių verdiktų.
 *
 * ⚠️ SKAIČIUOJAMOS ABI PUSĖS ATSKIRAI, IR TAI DoD FORMULUOTĖ: „restore verifikacija
 * pateikia ATSKIRAI patikrintų ir NEPATIKRINAMŲ eilučių skaičius". Vienas skaičius
 * „patikrinta: N" mišrioje DB skambėtų kaip pilna patikra.
 */
function sudarytiAtaskaita(verdiktai) {
  const pagalVerdikta = {};
  for (const v of Object.values(VERDIKTAS)) pagalVerdikta[v] = 0;
  for (const v of verdiktai) pagalVerdikta[v.verdiktas] += 1;

  const nesekmes = verdiktai.filter((v) => NESEKMES.includes(v.verdiktas));

  return {
    eiluciuIsViso: verdiktai.length,
    /** ⚠️ TIK `nepriklausomas: true` — inline čia NEĮEINA. */
    nepriklausomaiPatikrinta: pagalVerdikta[VERDIKTAS.PATIKRINTA],
    nepatikrinama: pagalVerdikta[VERDIKTAS.NEPATIKRINAMA_INLINE],
    pagalVerdikta,
    nesekmes,
    /** ⚠️ FAIL-CLOSED: viena nesėkmė reiškia, kad atkūrimas nepatvirtintas. */
    ok: nesekmes.length === 0,
    santrauka: suformuotiSantrauka(verdiktai.length, pagalVerdikta, nesekmes.length),
  };
}

function suformuotiSantrauka(isViso, pagalVerdikta, nesekmiu) {
  const patikrinta = pagalVerdikta[VERDIKTAS.PATIKRINTA];
  const inline = pagalVerdikta[VERDIKTAS.NEPATIKRINAMA_INLINE];

  /**
   * ⚠️ „NEPATIKRINAMA" RAŠOMA VISADA, NET KAI NULIS.
   *
   * Praleidus nulinį skaičių, ataskaitos forma priklausytų nuo duomenų, ir
   * operatorius, matęs tik „patikrinta: N", negalėtų atskirti „inline eilučių nėra"
   * nuo „apie inline eilutes ši ataskaita nieko nesako".
   */
  return (
    `eilučių ${isViso}; nepriklausomai patikrinta ${patikrinta}; ` +
    `nepatikrinama (inline, nėra su kuo lyginti) ${inline}; nesėkmių ${nesekmiu}`
  );
}

module.exports = { VERDIKTAS, NESEKMES, patikrintiEilute, sudarytiAtaskaita };
