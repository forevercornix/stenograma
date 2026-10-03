const test = require("node:test");
const assert = require("node:assert/strict");

const { analize, eiti } = require("./helpers/astAnalize");

/**
 * BENDRO AST HELPER'IO ELGSENOS TESTAS (#410 D3a).
 *
 * ⚠️ KATEGORIJOS HELPER'IS BE SAVO TESTO YRA TAS PATS MECHANIZMAS, KURĮ SPRENDŽIA #412.
 *
 * `analize()`/`eiti()` naudoja DU sargai — `operatoriausExitKodai` (#423) ir
 * `savininkoFinishAprėptis` (#253). Jei helper'is tyliai nustotų matyti dalį mazgų
 * ar praryti parsinimo klaidą, ABU sargai liktų žali, o jų aibės susitrauktų. Nė
 * vienas jų to nepamatytų: jie tikrina savo radinius, ne įrankį.
 *
 * ⚠️ TIKRINAMA TAI, KUO REMIASI KVIETĖJAI, ne API forma:
 *   1. komentarai ir eilutės NĖRA kodo mazgai (tai #423 1 radinio pagrindas);
 *   2. pilni sveikieji, ne vienas skaitmuo (#423 2 radinys);
 *   3. apėjimas pasiekia GILIAI įdėtus mazgus (abiejų sargų pagrindas);
 *   4. parsinimo klaida META, ne grąžina tuščią aibę.
 */

test("#410 D3a: komentarai ir eilutės NĖRA kodo mazgai", () => {
  const { programa } = analize(`
    // process.exitCode = 9
    const z = "a.finish({ x: 1 }, 'completed')";
    /* b.finish(scope, 'completed'); */
  `);

  const kvietimai = [...eiti(programa)].filter((n) => n.type === "CallExpression");
  assert.deepEqual(kvietimai, [], "komentare ir eilutėje esantis kvietimas nėra kvietimas");

  const literalai = [...eiti(programa)].filter((n) => n.type === "Literal");
  assert.ok(
    literalai.every((n) => typeof n.value === "string"),
    "eilutės literalas lieka `string`, ne skaičius"
  );
});

test("#410 D3a: sveikieji literalai grąžinami PILNI, ne po vieną skaitmenį", () => {
  const { programa } = analize("process.exitCode = 10; const a = 255;");
  const skaiciai = [...eiti(programa)]
    .filter((n) => n.type === "Literal" && Number.isInteger(n.value))
    .map((n) => n.value)
    .sort((a, b) => a - b);

  assert.deepEqual(skaiciai, [10, 255], "dvizenkliai ir trizenkliai nesuskyla");
});

test("#410 D3a: apėjimas pasiekia GILIAI įdėtus mazgus", () => {
  /**
   * ⚠️ GYLIS YRA TA SAVYBĖ, KURIA ABU SARGAI REMIASI. `#253` ieško `.finish(`
   * bet kuriame produkcinio failo gylyje — maršruto `catch` bloke, `.then()`
   * handler'yje, įdėtoje funkcijoje. Apėjimas, sustojantis ties `body`, duotų
   * tuščią aibę ir žalią sargą.
   */
  const { programa } = analize(`
    try {
      if (x) {
        [1].forEach(() => {
          promise.then(() => { jobStore.finish(scope, STATUS.COMPLETED); });
        });
      }
    } catch (e) { /* tyla */ }
  `);

  const finish = [...eiti(programa)].filter(
    (n) =>
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.name === "finish"
  );

  assert.equal(finish.length, 1, "giliai įdėtas kvietimas privalo būti pasiektas");
  assert.equal(finish[0].arguments.length, 2);
});

test("#410 D3a: parsinimo klaida META, ne grąžina tuščią aibę", () => {
  /**
   * ⚠️ TYLI TUŠČIA AIBĖ YRA BLOGIAUSIA BAIGTIS. Sargas failą laikytų „be radinių"
   * ir praneštų sėkmę — t. y. sintaksės klaida būtų būdas sargą išjungti.
   */
  assert.throws(() => analize("function ( { ] )"), /nepavyko suparsinti/);
});

test("#410 D3a: `parent` nuoroda apėjimo NEUŽCIKLINA", () => {
  /**
   * ESLint mazgai turi `parent`, tad naivus apėjimas kristų į begalinę rekursiją.
   * Testas yra laiko riba: be praleidimo jis nebaigtų.
   */
  const { programa } = analize("a.b(c, d); e.f(g);");
  const visi = [...eiti(programa)];
  assert.ok(visi.length > 5, `apėjimas privalo baigtis ir rasti mazgus, rasta ${visi.length}`);
});
