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

/**
 * ĮRIŠIMŲ IŠRIŠIMAS — IŠKELTA, KAI TO PRIREIKĖ ANTRĄ KARTĄ (#253 taisyklė).
 *
 * Pirmą kartą jį įvedė #440 P3 (`prieziurosUzraktoNuoma`), kur sargas atpažino
 * tik PAŽODINĮ `jobStore.create` ir praleisdavo `const store = jobStore;
 * store.create(...)`. Antrą kartą to paties prireikė #246 identity sargui.
 *
 * ❌ Trečią kartą kopijuoti nebereikia — dvi kopijos ilgainiui išsiskirtų, ir
 * viena iš jų liktų su senesniu atpažinimu.
 *
 * ⚠️ KĄ TAI YRA IR KO NE. Tai VIENFAILINIS, sintaksinis išrišimas: matomos
 * `require()` šaknys ir jų aliasai bei destruktūrizacijos tame pačiame faile.
 * ❌ NE scope manager (shadowing neskaičiuojamas), ❌ ne tarpfailinė analizė,
 * ❌ ne tarpprocedūrinis srautas. Vertė — apibrėžta ir patikrinama; ribos
 * rašomos sargo antraštėje, ne nutylimos.
 */

/** Member chain'o šaknis: `a.b.c` -> `"a"`; kitaip `null`. */
function saknis(mazgas) {
  let dabartinis = mazgas;
  while (dabartinis && dabartinis.type === "MemberExpression") dabartinis = dabartinis.object;
  return dabartinis && dabartinis.type === "Identifier" ? dabartinis.name : null;
}

/** `require("…/jobStore")` -> raktas iš `moduliai`, kurio šablonas atitinka; kitaip `null`. */
function modulisIsRequire(mazgas, moduliai) {
  if (!mazgas || mazgas.type !== "CallExpression") return null;
  if (mazgas.callee.type !== "Identifier" || mazgas.callee.name !== "require") return null;
  const arg = mazgas.arguments[0];
  if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") return null;
  const kelias = arg.value.replace(/\.js$/, "");
  for (const [vardas, sablonas] of Object.entries(moduliai)) {
    if (sablonas.test(kelias)) return vardas;
  }
  return null;
}

function pridetiDestrukt(pattern, modulis, destrukt, vardai) {
  let pakito = false;
  for (const savybe of pattern.properties) {
    if (savybe.type !== "Property" || savybe.key.type !== "Identifier") continue;
    if (!vardai[modulis].test(savybe.key.name)) continue;
    const vardas = savybe.value.type === "Identifier" ? savybe.value.name : savybe.key.name;
    if (!destrukt[modulis].has(vardas)) {
      destrukt[modulis].add(vardas);
      pakito = true;
    }
  }
  return pakito;
}

/**
 * Išriša failo įrišimus iki nejudamojo taško.
 *
 * @param {object[]} mazgai — `[...eiti(programa)]`
 * @param {{moduliai: Record<string, RegExp>, vardai: Record<string, RegExp>}} cfg
 *   `moduliai` — `require()` kelio šablonai; `vardai` — ieškomų savybių vardai.
 * @returns {{aliasai: Record<string, Set<string>>, destrukt: Record<string, Set<string>>}}
 *
 * ⚠️ KILPA BŪTINA: `const a = m; const b = a;` yra kelių žingsnių grandinė, o
 * deklaracijų tvarka faile negarantuota.
 *
 * ⚠️ `destrukt` PER MODULĮ, NE VIENA AIBĖ. Bendra aibė reikštų, kad vieno
 * modulio destruktūrizuotas vardas būtų palaikytas kito modulio nariu — #440
 * P3 mutacija (b) tą defektą ir atskleidė.
 */
function irisimai(mazgai, { moduliai, vardai }) {
  const aliasai = {};
  const destrukt = {};
  for (const vardas of Object.keys(moduliai)) {
    aliasai[vardas] = new Set();
    destrukt[vardas] = new Set();
  }

  for (const mazgas of mazgai) {
    if (mazgas.type !== "VariableDeclarator" || !mazgas.init) continue;

    const tiesiogiai = modulisIsRequire(mazgas.init, moduliai);
    if (tiesiogiai) {
      if (mazgas.id.type === "Identifier") aliasai[tiesiogiai].add(mazgas.id.name);
      else if (mazgas.id.type === "ObjectPattern") pridetiDestrukt(mazgas.id, tiesiogiai, destrukt, vardai);
      continue;
    }

    /** `require("…").savybe` — narys be tarpinio kintamojo. */
    if (mazgas.init.type === "MemberExpression") {
      const modulis = modulisIsRequire(mazgas.init.object, moduliai);
      if (
        modulis &&
        mazgas.init.property.type === "Identifier" &&
        vardai[modulis].test(mazgas.init.property.name) &&
        mazgas.id.type === "Identifier"
      ) {
        destrukt[modulis].add(mazgas.id.name);
      }
    }
  }

  let pakito = true;
  while (pakito) {
    pakito = false;
    for (const mazgas of mazgai) {
      if (mazgas.type !== "VariableDeclarator" || !mazgas.init) continue;
      for (const modulis of Object.keys(aliasai)) {
        const isAliaso =
          (mazgas.init.type === "Identifier" && aliasai[modulis].has(mazgas.init.name)) ||
          (mazgas.init.type === "MemberExpression" && aliasai[modulis].has(saknis(mazgas.init)));
        if (!isAliaso) continue;

        if (mazgas.id.type === "Identifier" && !aliasai[modulis].has(mazgas.id.name)) {
          aliasai[modulis].add(mazgas.id.name);
          pakito = true;
        } else if (mazgas.id.type === "ObjectPattern") {
          if (pridetiDestrukt(mazgas.id, modulis, destrukt, vardai)) pakito = true;
        }
      }
    }
  }

  return { aliasai, destrukt };
}

/**
 * Ar mazgas yra `modulis` nario kvietimas pagal išrištus įrišimus?
 *
 * Atpažįstama: `alias.vardas(...)`, `alias.gilesnis.vardas(...)` ir
 * destruktūrizuotas `vardas(...)`.
 */
function arNarioKvietimas(mazgas, modulis, rista, vardai) {
  if (mazgas.type !== "CallExpression") return false;
  const k = mazgas.callee;

  if (k.type === "MemberExpression" && k.property.type === "Identifier") {
    if (!vardai[modulis].test(k.property.name)) return false;
    return rista.aliasai[modulis].has(saknis(k));
  }

  if (k.type === "Identifier") return rista.destrukt[modulis].has(k.name);

  return false;
}

module.exports = { analize, eiti, saknis, modulisIsRequire, irisimai, arNarioKvietimas };
