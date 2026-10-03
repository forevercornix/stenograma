const { Linter } = require("eslint");

/**
 * AST ANALIZĖ SARGAMS — BENDRAS MECHANIZMAS (#423, #253).
 *
 * ⚠️ IŠKELTA, KAI TAS PATS KELIAS PRIREIKĖ ANTRĄ KARTĄ.
 *
 * Pirmą kartą jį įvedė `operatoriausExitKodai` (#423), kur penki Codex P2 radiniai
 * turėjo VIENĄ šaknį: aibė buvo vedama iš neapdoroto teksto su fiksuotais langais
 * (400 simbolių, 60 eilučių, `\d`, visas failas). Antrą kartą to paties prireikė
 * `savininkoFinishAprėptis` (#253), kur regex'as matė tik plokščią objekto literalą
 * pirmame argumente, tad `finish(scope, COMPLETED)` su KINTAMUOJU praeidavo.
 *
 * Abu kartus sprendimas tas pats: tekstas neturi struktūros, tad riba visada yra
 * spėjimas. ❌ Trečią kartą kopijuoti nebereikia — dvi kopijos ilgainiui išsiskirtų,
 * ir viena iš jų liktų su senuoju langu.
 *
 * ⚠️ NE NAUJA PRIKLAUSOMYBĖ — IŠMATUOTA. `eslint` yra DEKLARUOTA `devDependency`
 * (`^10.10.0`, lock'e 10.10.0), o jo viešas `Linter` API per in-memory taisyklę
 * atiduoda `Program` mazgą ir komentarus. `acorn`/`espree` NENAUDOJAMI: repo juos
 * turi tik tranzityviai per `eslint`, o iš repo šaknies `acorn` apskritai
 * išsisprendžia į SISTEMINĮ `/usr/share/nodejs/acorn`. Tranzityvi priklausomybė gali
 * išnykti atnaujinus `eslint`; deklaruota — ne.
 *
 * ⚠️ ŠIS HELPER'IS TURI SAVO ELGSENOS TESTĄ (`astAnalize.test.js`, #410 D3a).
 * Kategorijos helper'is be savo testo yra tas pats mechanizmas, kurį sprendžia #412:
 * bendra logika, kurios niekas netikrina, o abu kvietėjai ją laiko savaime suprantama.
 */
function analize(tekstas) {
  const linter = new Linter();
  let programa = null;
  let komentarai = [];

  const pranesimai = linter.verify(tekstas, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: {
      sargas: {
        rules: {
          imk: {
            create(ctx) {
              return {
                Program(n) {
                  programa = n;
                  komentarai = ctx.sourceCode.getAllComments();
                },
              };
            },
          },
        },
      },
    },
    rules: { "sargas/imk": "error" },
  });

  /**
   * ⚠️ PARSINIMO KLAIDA YRA PAŽEIDIMAS, NE TYLI TUŠČIA AIBĖ. Grąžinus `null`, sargas
   * failą laikytų „be radinių" ir praneštų sėkmę — tiksliai tas tylus praleidimas,
   * kurio AST perėjimas ir turi nebūti.
   */
  const fatal = pranesimai.find((p) => p.fatal);
  if (fatal) throw new Error(`nepavyko suparsinti: ${fatal.message} (${fatal.line}:${fatal.column})`);

  return { programa, komentarai };
}

/** Rekursinis AST apėjimas be priklausomybių: `parent` praleidžiamas (ciklas). */
function* eiti(mazgas) {
  if (!mazgas || typeof mazgas !== "object") return;
  if (Array.isArray(mazgas)) {
    for (const x of mazgas) yield* eiti(x);
    return;
  }
  if (typeof mazgas.type === "string") yield mazgas;
  for (const k of Object.keys(mazgas)) {
    if (k === "parent") continue;
    const v = mazgas[k];
    if (v && typeof v === "object") yield* eiti(v);
  }
}

module.exports = { analize, eiti };
