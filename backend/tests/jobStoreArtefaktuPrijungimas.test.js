const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const jobStore = require("../utils/jobStore");

/**
 * PRIJUNGIMO TAISYKLĖS BE DUOMENŲ BAZĖS (#157, PR-7, 3 sąlyga).
 *
 * ⚠️ KODĖL ATSKIRAI NUO INTEGRACINIO FAILO.
 *
 * `initializePostgres()` be tikros DB nepasileidžia, tad visos jo asercijos guli
 * `postgres` rinkinyje ir matomos tik CI'uje. Bet svarbiausia šio žingsnio taisyklė —
 * **`inline` saugykla NEPADUODAMA** — nuo DB nepriklauso, o jos pažeidimas sulaužytų
 * užbaigimą KIEKVIENAM diegimui, kuris #157 dar nenaudoja. Tokia taisyklė negali
 * laukti CI raundo.
 *
 * ⚠️ TIKRINAMA TA PATI FUNKCIJA, kurią kviečia `initializePostgres()`
 * (`_paruostiArtefaktuSaugyklaForTests`), o ne jos perrašyta versija.
 *
 * ⚠️ BENDRA BŪSENA: keičiamas `process.env`, tad kiekvienas testas jį atstato
 * `finally` bloke — įskaitant kelią, kuriame funkcija metė.
 */

async function suAplinka(aplinka, veiksmas) {
  const raktai = ["ARTIFACT_STORE_BACKEND", "ARTIFACT_FS_ROOT", "ARTIFACT_S3_BUCKET"];
  const buve = Object.fromEntries(raktai.map((r) => [r, process.env[r]]));

  for (const r of raktai) delete process.env[r];
  for (const [r, v] of Object.entries(aplinka)) process.env[r] = v;

  try {
    return await veiksmas();
  } finally {
    for (const [r, v] of Object.entries(buve)) {
      if (v === undefined) delete process.env[r];
      else process.env[r] = v;
    }
  }
}

const paruosti = () => jobStore._paruostiArtefaktuSaugyklaForTests();

/**
 * ⚠️ SVARBIAUSIAS ŠIO ŽINGSNIO TESTAS.
 *
 * `inlineStore.backend` yra `"inline"`, o `paruostiExternalRasyma()` iš to lauko
 * gamina `storage_type` KARTU su `storage_key`. `job_results_storage_shape` inline
 * šakai reikalauja `storage_key IS NULL`, tad paduota inline saugykla duotų `23514`
 * kiekvienam užbaigimui — ir tai pasimatytų ne starte, o per pirmą `finish()`.
 */
test("`inline` NEGRĄŽINA saugyklos — kitaip lūžtų kiekvienas užbaigimas", async () => {
  await suAplinka({}, async () => {
    assert.deepEqual(await paruosti(), {}, "numatytoji aplinka = inline, be saugyklos");
  });

  await suAplinka({ ARTIFACT_STORE_BACKEND: "inline" }, async () => {
    assert.deepEqual(await paruosti(), {}, "eksplicitinis `inline` — tas pats atsakymas");
  });
});

test("`fs` grąžina saugyklą su savo backend'u", async () => {
  const saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-paruosti-"));

  try {
    await suAplinka({ ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: saknis }, async () => {
      const parinktys = await paruosti();
      assert.equal(parinktys.rasymoSaugykla.backend, "fs");
      /** ⚠️ `artifactStores` NEPADUODAMAS: skaitymo žemėlapis IŠVEDAMAS iš `backend`. */
      assert.deepEqual(Object.keys(parinktys), ["rasymoSaugykla"]);
    });
  } finally {
    fs.rmSync(saknis, { recursive: true, force: true });
  }
});

/**
 * ⚠️ GRĮŽIMAS Į `inline` NEGALIMAS — TAI PR-2 KONTRAKTAS, NE ŠIO ŽINGSNIO IŠRADIMAS.
 *
 * Iki šio žingsnio serveris `parinktiBackenda()` nekvietė iš viso, tad diegimas su
 * `ARTIFACT_STORE_BACKEND=s3` ir trūkstamu raktu startuodavo ir rašydavo `inline` —
 * tiksliai tas tylus grįžimas, kurį `backendSelection.js` draudžia žodžiais.
 */
test("netinkama konfigūracija META, o ne grąžina tuščias parinktis", async () => {
  await suAplinka({ ARTIFACT_STORE_BACKEND: "s3", ARTIFACT_S3_BUCKET: "b" }, async () => {
    await assert.rejects(paruosti, /bet trūksta: ARTIFACT_S3_REGION/);
  });

  await suAplinka({ ARTIFACT_STORE_BACKEND: "gcs" }, async () => {
    await assert.rejects(paruosti, /nežinomas/);
  });
});

test("netinkamas `ARTIFACT_FS_ROOT` matomas ČIA, ne per pirmą rašymą", async () => {
  const failas = path.join(os.tmpdir(), `stenograma-ne-katalogas-unit-${process.pid}`);
  fs.writeFileSync(failas, "failas", "utf8");

  try {
    await suAplinka({ ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: failas }, async () => {
      await assert.rejects(paruosti);
    });
  } finally {
    fs.unlinkSync(failas);
  }
});
