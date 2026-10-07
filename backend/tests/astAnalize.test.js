const test = require("node:test");
const assert = require("node:assert/strict");

const { analize, eiti, saknis, irisimai, arNarioKvietimas } = require("./helpers/astAnalize");

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

/* ───────── Įrišimų išrišimas (iškelta #246, pirmą kartą #440 P3) ───────── */

const KONFIG = Object.freeze({
  moduliai: { m: /(^|\/)modulis$/ },
  vardai: { m: /^daryk$/ },
});

function rista(kodas) {
  const { programa } = analize(kodas);
  const mazgai = [...eiti(programa)];
  return { mazgai, rista: irisimai(mazgai, KONFIG) };
}

function kiek(kodas) {
  const { mazgai, rista: r } = rista(kodas);
  return mazgai.filter((m) => arNarioKvietimas(m, "m", r, KONFIG.vardai)).length;
}

test("#246 D3a: `saknis()` grąžina member chain'o šaknį", () => {
  const { programa } = analize("a.b.c.daryk();");
  const kvietimas = [...eiti(programa)].find((n) => n.type === "CallExpression");
  assert.equal(saknis(kvietimas.callee), "a");
  assert.equal(saknis({ type: "Literal" }), null, "ne Identifier šaknis -> null");
});

test("#246 D3a: atpažįstamos VISOS įrišimo formos", () => {
  /**
   * ⚠️ LENTELĖ ABIEM KRYPTIMIS.
   *
   * Vien „randa" patikros neužtenka: pagalbininkas, kuris atitinka VISKĄ, yra
   * toks pat nenaudingas kaip tas, kuris neatitinka nieko — tik pirmasis dar ir
   * duoda klaidingus kritimus sarge, kuris jį naudoja.
   */
  const formos = [
    ["pažodinis", 'const m = require("./modulis"); m.daryk();', 1],
    ["alias", 'const m = require("./modulis"); const a = m; a.daryk();', 1],
    ["alias per du žingsnius", 'const m = require("./modulis"); const a = m; const b = a; b.daryk();', 1],
    ["deklaracijų tvarka APVERSTA", 'const b = a; const a = m; const m = require("./modulis"); b.daryk();', 1],
    ["gilesnis narys", 'const m = require("./modulis"); const s = m.sub; s.daryk();', 1],
    ["destruktūrizacija", 'const { daryk } = require("./modulis"); daryk();', 1],
    ["destruktūrizacija su pervardijimu", 'const { daryk: d } = require("./modulis"); d();', 1],
    ["narys iš require", 'const d = require("./modulis").daryk; d();', 1],
    ["⚠️ KITAS modulis", 'const x = require("./kitas"); x.daryk();', 0],
    ["⚠️ KITAS narys", 'const m = require("./modulis"); m.kitas();', 0],
    ["⚠️ nedestruktūrizuotas to paties vardo kvietimas", "daryk();", 0],
  ];

  for (const [vardas, kodas, laukta] of formos) {
    assert.equal(kiek(kodas), laukta, `forma „${vardas}": rasta ${kiek(kodas)}, laukta ${laukta}`);
  }
});

test("#246 D3a: `destrukt` aibė yra PER MODULĮ, ne bendra", () => {
  /**
   * ⚠️ ŠIS DEFEKTAS REALIAI BUVO (#440 P3 mutacija (b)).
   *
   * Su bendra aibe vieno modulio destruktūrizuotas vardas būdavo palaikomas ir
   * kito modulio nariu, ir sargas pranešdavo apie pažeidimą, kurio nėra.
   */
  const cfg = {
    moduliai: { a: /(^|\/)aaa$/, b: /(^|\/)bbb$/ },
    vardai: { a: /^daryk$/, b: /^daryk$/ },
  };
  const { programa } = analize('const { daryk } = require("./aaa"); daryk();');
  const mazgai = [...eiti(programa)];
  const r = irisimai(mazgai, cfg);

  assert.equal(mazgai.filter((m) => arNarioKvietimas(m, "a", r, cfg.vardai)).length, 1, "savo modulis");
  assert.equal(mazgai.filter((m) => arNarioKvietimas(m, "b", r, cfg.vardai)).length, 0, "⚠️ svetimas modulis NETURI atitikti");
});

test("#246 D3a ⚠️ RIBA: shadowing NEIŠRIŠAMAS (vienfailinis, ne scope manager)", () => {
  /**
   * ⚠️ UŽRAŠOMA KAIP RIBA, NE KAIP GEDIMAS.
   *
   * Pagalbininkas renka deklaracijas per visą failą, neskaičiuodamas scope'ų.
   * Vidinis `m`, užtemdantis modulio aliasą, vis tiek bus laikomas aliasu —
   * tai SAUGI kryptis sargui (daugiau radinių, ne mažiau), bet ji reiškia, kad
   * pagalbininkas NĖRA scope manager. Sargo antraštėje tai turi būti pasakyta.
   */
  const kodas = 'const m = require("./modulis"); function f(){ const m = {daryk(){}}; m.daryk(); }';
  assert.equal(kiek(kodas), 1, "užtemdytas vardas vis tiek atitinka — žinoma ir priimta riba");
});
