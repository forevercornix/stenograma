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
