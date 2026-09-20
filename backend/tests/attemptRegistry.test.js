const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const attemptRegistry = require("../utils/attemptRegistry");
const { patikrintiRakta } = require("../utils/artifactStore/validation");

/**
 * BANDYMŲ REGISTRO FORMA (#157, PR-4).
 *
 * ⚠️ ELGESYS SU TIKRA DB TIKRINAMAS `externalCompletion.integration`; čia — tai, ką
 * galima įrodyti be servisų: rakto forma ir SQL, kuris realiai iškeliauja.
 */

function iraseVykdytojas() {
  const irasai = [];
  return {
    irasai,
    async query(sql, params = []) {
      irasai.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

test("bandymo raktas PRAEINA `ArtifactStore` ribą ir neša job'o prefiksą", () => {
  /**
   * ⚠️ RAKTAS NEIŠVEDAMAS IŠ CHECKSUM'O (A2 riba galioja abiem kryptimis), o `jobId`
   * prefiksas yra ERASURE reikalas — jis leidžia matyti, kam objektas priklauso.
   */
  const jobId = "11111111-2222-3333-4444-555555555555";
  const attemptId = attemptRegistry.naujasBandymas();
  const raktas = attemptRegistry.bandymoRaktas(jobId, attemptId);

  assert.equal(raktas, `results/${jobId}/${attemptId}.json`);
  patikrintiRakta(raktas);

  /** Du bandymai — du skirtingi objektai, net esant tam pačiam turiniui. */
  assert.notEqual(
    attemptRegistry.bandymoRaktas(jobId, attemptRegistry.naujasBandymas()),
    raktas
  );
});

test("registravimas rašo `pending` PRIEŠ rašymą į saugyklą", async () => {
  /**
   * ⚠️ KRYPTIS PASIRINKTA SĄMONINGAI: geriau eilutė be objekto, nei objektas be
   * eilutės. Pirmoji yra šiukšlė registre, antroji — transkripcija, kurios nepasiekia
   * nei erasure, nei DB krypties skenavimas.
   */
  const vykdytojas = iraseVykdytojas();
  await attemptRegistry.registruoti(vykdytojas, {
    attemptId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    jobId: "job-1",
    storageType: "fs",
    storageKey: "results/job-1/a.json",
  });

  const [irasas] = vykdytojas.irasai;
  assert.match(irasas.sql, /INSERT INTO job_result_attempts/);
  assert.equal(irasas.params[4], attemptRegistry.BUSENA.LAUKIA, "pradinė būsena — `pending`");
});

test("būsenų aibė SUTAMPA su migracijos aibe — abiem kryptim", () => {
  /**
   * ⚠️ GREP'AS ŠIO INVARIANTO NETIKRINA (§9.2, Codex #294).
   *
   * Pirmoji redakcija ieškojo kiekvienos būsenos šaltinio TEKSTE. `committed`
   * pašalinimas iš migracijos masyvo praeitų, nes žodis lieka komentare — o `CHECK`
   * pažeidimas pasimatytų tik prieš tikrą DB.
   *
   * Todėl aibė IŠRENKAMA iš pačios migracijos apibrėžties (masyvo literalo) ir lyginama
   * TIKSLIAI: trūkstama būsena ir perteklinė būsena abi yra defektai. Pirmoji reikštų,
   * kad kodas rašo tai, ko DB nepriims; antroji — kad DB priima būseną, kurios kodas
   * niekada nenaudos, ir niekas apie ją nieko nežino.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "1756300000000_job-result-attempts.js"),
    "utf8"
  );

  const apibrezimas = src.match(/const BUSENOS_FROZEN = \[([^\]]*)\]/);
  assert.ok(apibrezimas, "migracijoje privalo būti `BUSENOS_FROZEN` masyvo literalas");

  const migracijos = apibrezimas[1]
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .sort();

  assert.deepEqual(
    migracijos,
    Object.values(attemptRegistry.BUSENA).sort(),
    "kodo ir migracijos būsenų aibės privalo sutapti TIKSLIAI"
  );

  /**
   * ⚠️ IR PATS `CHECK` PRIVALO NAUDOTI TĄ AIBĘ. Be to migracija galėtų deklaruoti
   * masyvą ir apriboti stulpelį visai kitomis reikšmėmis.
   */
  assert.match(src, /busena IN \(\$\{sarasas\(BUSENOS_FROZEN\)\}\)|sarasas\(BUSENOS_FROZEN\)/);
});

test("KONTRAKTAS: retencijos gyvos nuosavybės aibė yra erasure aibės POAIBIS", () => {
  /**
   * ⚠️ DVI TO PATIES INVARIANTO REALIZACIJOS — IR SĄMONINGAI DVI (#305.1).
   *
   * Nuosavybės klausimą repo užduoda dviejose vietose, ir jos NĖRA ta pati
   * taisyklė:
   *
   *   erasure  (`postgresStore.svetimiAdresai`) — „ar A turi TEISĘ naikinti šį
   *             objektą?" Atsakymas: ne, jei jį užima BET KURIS svetimas
   *             bandymas, nes A neturi valdžios B gyvavimo ciklui;
   *   retencija (`attemptRegistry.valytiniBandymai`) — „ar objekto dar REIKIA?"
   *             Atsakymas: ne, jei svetimas bandymas yra `abandoned`, nes tą
   *             objektą šalintų ir paties B šlavėjas.
   *
   * ⚠️ TRYS KARTUS ŠIOJE SEKOJE DVI TO PATIES INVARIANTO REALIZACIJOS IŠSISKYRĖ
   * (`BUTINI` sąrašas, matricos skaičius, `PILNA_FORMA`). Todėl vieno šaltinio
   * čia nedarom — semantika skiriasi ir suliejimas reikštų vieną iš dviejų
   * klausimų atsakyti neteisingai, — o fiksuojam SĄRYŠĮ.
   *
   * ⚠️ SĄRYŠIS PATIKSLINTAS PO PIRMO CODEX RAUNDO. Iki jo buvo teigiama tiesiog
   * „retencijos aibė yra erasure aibės POAIBIS". Perrašius predikatą iš
   * NUOSAVYBĖS į GYVYBINGUMĄ, tai nustojo būti tiesa abiem kryptim:
   *
   *   - retencija dabar blokuoja IR TO PATIES job'o gyvą bandymą, o erasure toks
   *     atvejis nedomina (jis sąmoningai naikina viso job'o artefaktus);
   *   - retencija NEBEBLOKUOJA pasibaigusio `pending`, o erasure jį blokuoja.
   *
   * Tikrasis sąryšis, kuris ir yra saugumo garantija: APSIRIBOJUS SVETIMAIS
   * bandymais, retencijos gyvų būsenų aibė yra erasure „bet kokios būsenos"
   * aibės poaibis. To paties job'o blokavimas yra PAPILDOMA apsauga be erasure
   * atitikmens — pagal konstrukciją, ne praleidimas.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { BUSENA, GYVOS_BUSENOS } = require("../utils/attemptRegistry");

  const visos = Object.values(BUSENA);

  for (const busena of GYVOS_BUSENOS) {
    assert.ok(visos.includes(busena), `\`${busena}\` privalo būti žinoma būsena`);
  }

  assert.deepEqual(
    [...GYVOS_BUSENOS].sort(),
    ["committed", "pending"],
    "gyvos nuosavybės aibė yra SPRENDIMAS - jos pokytis privalo būti matomas čia"
  );

  assert.ok(
    !GYVOS_BUSENOS.includes(BUSENA.ATMESTA),
    "`abandoned` NEBLOKUOJA šlavimo: objekto nebereikia niekam, ir jį šalintų B šlavėjas"
  );

  /**
   * ⚠️ POAIBIO SĄRYŠĮ LAIKO TAI, KAD ERASURE UŽKLAUSA BŪSENŲ NEFILTRUOJA.
   *
   * Tai tripwire (§9.2): jei kas nors ten pridės `busena` sąlygą, poaibio
   * garantija gali nutrūkti TYLIAI — erasure imtų praleisti tai, ką retencija
   * trina. Testas neleidžia to padaryti nepastebėtai.
   */
  const { beKomentaru } = require("../utils/auditEvents");
  const pgStore = beKomentaru(
    fs.readFileSync(path.join(__dirname, "..", "utils", "jobStore", "postgresStore.js"), "utf8")
  );

  const pradzia = pgStore.indexOf("async function svetimiAdresai(");
  assert.ok(pradzia > 0, "prielaida: `svetimiAdresai()` egzistuoja");
  const kunas = pgStore.slice(pradzia, pgStore.indexOf("\n  async function", pradzia + 10));

  assert.match(kunas, /FROM job_result_attempts/, "prielaida: erasure tikrina ir registrą");
  assert.ok(
    !/busena\s*(=|<>|IN|=\s*ANY)/i.test(kunas),
    "erasure užklausa NETURI filtruoti būsenų - kitaip retencijos aibė nustotų būti jos poaibiu"
  );
});

test("ATIDARYMO SĄLYGA: raktas išvedamas iš `attemptId`, NE iš turinio", () => {
  /**
   * ⚠️ ŠIS TESTAS YRA CLAIM SPRENDIMO LIUDYTOJAS (#305.1).
   *
   * Sprendimas neįvesti claim protokolo remiasi IŠMATUOTA prielaida: du gyvi
   * bandymai NORMALIU keliu negauna to paties `(storage_type, storage_key)`, nes
   * raktas yra `results/<jobId>/<attemptId>.json`, o `attemptId` yra
   * `crypto.randomUUID()`. Todėl veikėjai #1, #3 ir #4 pasiekiami TIK per
   * nekonsistentiškus metaduomenis, o į juos repo jau atsako `NESAUGU` — atsisakyti
   * ir parodyti, ne inžineriškai saugiai apdoroti.
   *
   * ⚠️ ATIDARYMO SĄLYGA: claim tampa BŪTINAS, jei normalus kelias kada nors duos du
   * gyvus bandymus vienu adresu. Konkretus būdas tai padaryti — pakeisti raktą į
   * TURINIO adresą (variantas, kurį PR-4 jau kartą ATMETĖ: tada du job'ai su tuo
   * pačiu rezultatu dalytųsi objektu).
   *
   * Šis testas yra tos sąlygos sargas: jį sulaužius, claim sprendimas nustoja
   * galioti, ir tai pamatoma ČIA, ne produkcijoje.
   */
  const jobId = "11111111-2222-3333-4444-555555555555";

  /** 1. Raktas TURI savyje `attemptId` — vadinasi jis yra rakto dalis, ne priedas. */
  const attemptId = attemptRegistry.naujasBandymas();
  assert.match(
    attemptRegistry.bandymoRaktas(jobId, attemptId),
    new RegExp(attemptId),
    "raktas privalo nešti `attemptId` - be jo attempt-unikalumo nėra"
  );

  /**
   * 2. Funkcija NEMATO turinio. Turinio adresas reikalautų trečio argumento arba
   * checksum'o; dviejų argumentų parašas tai daro neįmanomu.
   */
  assert.equal(
    attemptRegistry.bandymoRaktas.length,
    2,
    "⚠️ trečias argumentas reikštų, kad raktas gali priklausyti nuo turinio - žr. atidarymo sąlygą"
  );

  /** 3. Tūkstantis bandymų - tūkstantis skirtingų adresų, be jokios kolizijos. */
  const raktai = new Set();
  for (let i = 0; i < 1000; i += 1) {
    raktai.add(attemptRegistry.bandymoRaktas(jobId, attemptRegistry.naujasBandymas()));
  }
  assert.equal(raktai.size, 1000, "kolizija reikštų, kad claim sprendimas nebegalioja");

  /**
   * 4. ⚠️ IR ABI PRODUKCINĖS REGISTRACIJOS VIETOS IMA `naujasBandymas()`.
   *
   * Be šito tikrintume tik funkciją, o ne tai, kad ja naudojamasi: kvietėjas,
   * perduodantis pastovų ar iš turinio išvestą `attemptId`, sąlygą sulaužytų,
   * funkcijos nepalietęs. Tai tripwire (§9.2), ne elgsenos įrodymas.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const { beKomentaru } = require("../utils/auditEvents");

  for (const santykinis of ["utils/jobStore/postgresStore.js", "utils/artifactMigration.js"]) {
    const svarus = beKomentaru(fs.readFileSync(path.join(__dirname, "..", santykinis), "utf8"));

    assert.match(
      svarus,
      /attemptRegistry\.naujasBandymas\(\)/,
      `${santykinis}: registracija privalo imti NAUJĄ atsitiktinį \`attemptId\``
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * #375 D4 — `23505` KLASIFIKACIJA BE DUOMENŲ BAZĖS
 * ══════════════════════════════════════════════════════════════════════════════ */

/** Vykdytojas, metantis nurodytą PostgreSQL klaidą — kaip ją mestų tikras `pg`. */
function metantisVykdytojas(code, constraint) {
  return {
    async query() {
      const klaida = new Error("duplicate key value violates unique constraint");
      klaida.code = code;
      klaida.constraint = constraint;
      throw klaida;
    },
  };
}

const BANDYMAS = {
  attemptId: "11111111-2222-3333-4444-555555555555",
  jobId: "99999999-8888-7777-6666-555555555555",
  storageType: "fs",
  storageKey: "results/99999999-8888-7777-6666-555555555555/a.json",
};

test("#375 D4: `23505` SU šio indekso vardu → `BendroAdresoKlaida`", async () => {
  /**
   * ⚠️ ELGSENA TIKRINAMA BE DB SĄMONINGAI. Klausimas čia yra „kaip klasifikuojama
   * klaida", ne „ar PostgreSQL ją meta" — antrąjį dengia
   * `postgresStore.integration`. Dublis leidžia patikrinti ir tą šaką, kurios
   * tikra DB pagal užsakymą negamina.
   */
  await assert.rejects(
    () =>
      attemptRegistry.registruoti(
        metantisVykdytojas("23505", attemptRegistry.VIENO_ADRESO_INDEKSAS),
        BANDYMAS
      ),
    (klaida) => {
      assert.ok(klaida instanceof attemptRegistry.BendroAdresoKlaida);
      assert.equal(klaida.code, "ATTEMPT_ADDRESS_TAKEN");
      assert.equal(klaida.storageType, "fs", "klaida neša adresą diagnostikai");
      return true;
    }
  );
});

test("#375 D4: `23505` su KITU konstraintu praeina NEPAKEISTAS", async () => {
  /**
   * ⚠️ ŠI ASERCIJA GINA `err.constraint` DALĮ.
   *
   * Ta pati lentelė turi bent tris unikalumo šaltinius: `attempt_id` PK, dalinį
   * `job_result_attempts_vienas_isipareigotas` ir mūsiškį. Klasifikuojant tik pagal
   * `err.code`, PK pažeidimas — visai kitas gedimas — būtų praneštas kaip bendras
   * adresas, ir remontas eitų ne ta kryptimi.
   */
  for (const svetimas of ["job_result_attempts_pkey", "job_result_attempts_vienas_isipareigotas"]) {
    await assert.rejects(
      () => attemptRegistry.registruoti(metantisVykdytojas("23505", svetimas), BANDYMAS),
      (klaida) => {
        assert.equal(
          klaida instanceof attemptRegistry.BendroAdresoKlaida,
          false,
          `${svetimas}: NĖRA bendro adreso klaida`
        );
        assert.equal(klaida.code, "23505", "originali klaida perduodama nepakeista");
        return true;
      }
    );
  }
});

test("#375 D4: ne `23505` klaida perduodama nepakeista", async () => {
  /** Ryšio ar sintaksės klaida neturi virsti domenine — kitaip dingtų priežastis. */
  await assert.rejects(
    () => attemptRegistry.registruoti(metantisVykdytojas("08006", null), BANDYMAS),
    (klaida) => klaida.code === "08006" && !(klaida instanceof attemptRegistry.BendroAdresoKlaida)
  );
});

test("#375: kolizijos klaidos tekste NĖRA `attemptId` — tik adresas", () => {
  /**
   * ⚠️ Pranešimas keliauja į job'o klaidos lauką ir logus. Adresas jame reikalingas
   * (be jo operatorius nežino, KURIS raktas užimtas), o `attemptId` — ne: jis nieko
   * neprideda prie diagnozės ir tik pailgina eilutę.
   */
  const klaida = new attemptRegistry.BendroAdresoKlaida("fs", BANDYMAS.storageKey);

  assert.match(klaida.message, /results\//, "adresas privalo būti matomas");
  assert.equal(klaida.message.includes(BANDYMAS.attemptId), false, "`attemptId` nereikalingas");
  assert.match(klaida.message, /#375/, "nuoroda į sprendimą");
});
