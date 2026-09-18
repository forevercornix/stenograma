const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createInlineArtifactStore } = require("../utils/artifactStore/inlineStore");
const { kanoninisRezultatas } = require("../utils/jobStore/common");

/**
 * INLINE RAŠO TĄ PATĮ, KĄ APRAŠO KVITAS (#157, PR-2, Codex #290).
 *
 * ⚠️ KODĖL TAI ATSKIRAS, VIETOJE VYKDOMAS TESTAS.
 *
 * Bendras kontrakto rinkinys tą patį tikrina per REZULTATĄ (įrašyk — perskaityk —
 * palygink su kvitu), bet inline atveju jis reikalauja tikros PostgreSQL, tad
 * vietoje NEVYKDOMAS. Čia tikrinama ta pati tiesa per PARAMETRĄ: kas realiai
 * iškeliauja į `INSERT`. Įrodymas silpnesnis (dublis nėra `jsonb`), bet jis
 * vykdomas kiekvienam commit'ui, o stipresnįjį duoda CI.
 *
 * ⚠️ DUBLIS GRĄŽINA TIKRO KONTRAKTO TIPUS (#266 trečia dalis): `rows` ir
 * `rowCount`. Dublis, grąžinantis `undefined`, taptų antrąja specifikacija ir
 * paslėptų defektą — būtent taip PR #288 defektas ir buvo pasislėpęs.
 */

function iraseVykdytojas() {
  const irasai = [];
  return {
    irasai,
    async query(sql, params = []) {
      irasai.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

const JOB_ID = "11111111-2222-3333-4444-555555555555";

test("į `payload` iškeliauja RIBOS paruošta eilutė, ne antra serializacija", async () => {
  const vykdytojas = iraseVykdytojas();
  const saugykla = createInlineArtifactStore({ vykdytojas });

  /**
   * ⚠️ REIKŠMĖ SVYRUOJA PO RIBOS SKAITYMŲ. Skaičius išmatuojamas, ne įkoduojamas
   * — žr. bendrą rinkinį; čia ta pati technika, kad testas persikalibruotų pats.
   */
  const { paruostiReiksme } = require("../utils/artifactStore/validation");

  let ribosSkaitymai = 0;
  paruostiReiksme({
    get text() {
      ribosSkaitymai += 1;
      return "pastovi";
    },
  });

  let kvietimai = 0;
  const nestabili = {
    get text() {
      kvietimai += 1;
      return kvietimai <= ribosSkaitymai ? "pirma" : "antra";
    },
  };

  const kvitas = await saugykla.put(JOB_ID, nestabili);

  const insert = vykdytojas.irasai.find((i) => /INSERT INTO job_results/.test(i.sql));
  assert.ok(insert, "rašymas privalo eiti per `job_results`");

  const irasyta = insert.params[1];

  assert.equal(
    kanoninisRezultatas(JSON.parse(irasyta)),
    kanoninisRezultatas({ text: "pirma" }),
    "įrašytas turinys privalo būti tas, kurį matė riba — ne vėlesnė reikšmės būsena"
  );

  assert.equal(
    Buffer.byteLength(kanoninisRezultatas(JSON.parse(irasyta)), "utf8"),
    kvitas.bytes,
    "`bytes` privalo matuoti ĮRAŠYTĄ turinį"
  );
});

test("KONTROLĖ: paprasta reikšmė ir toliau įrašoma pilnai", () => {
  /**
   * Be jos ankstesnis testas praeitų ir tada, jei `put()` imtų rašyti tuščią
   * eilutę arba nerašyti nieko: „įrašyta = tai, ką matė riba" tada būtų
   * tenkinama tuštuma.
   */
  const vykdytojas = iraseVykdytojas();
  const saugykla = createInlineArtifactStore({ vykdytojas });

  return saugykla.put(JOB_ID, { text: "kontrolė", segments: [1, 2] }).then((kvitas) => {
    const insert = vykdytojas.irasai.find((i) => /INSERT INTO job_results/.test(i.sql));

    assert.deepEqual(
      JSON.parse(insert.params[1]),
      { text: "kontrolė", segments: [1, 2] },
      "turinys privalo pasiekti saugyklą nepakitęs"
    );
    assert.ok(kvitas.bytes > 0);
  });
});
