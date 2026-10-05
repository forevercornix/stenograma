const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { analize, eiti, irisimai, arNarioKvietimas } = require("./helpers/astAnalize");
const { loadUsers, hashPassword } = require("../utils/credentials");

/**
 * #246 D9 — STRUKTŪRINIS IDENTITY SARGAS.
 *
 * ⚠️ KĄ ŠIS SARGAS YRA: ankstyvas signalas, saugantis TRIS repo FAKTIŠKAI
 * naudojamas propagacijos formas, kurias nustatė #246 §0.1 matavimas.
 *
 * ⚠️ KĄ JIS NĖRA, IR KO SĄMONINGAI NEDENGIA (#246 D9; matuota §0.1):
 *
 *   1. ❌ NAUJAS MARŠRUTAS, PERDUODANTIS VARDĄ PER SERVISĄ. Būtent tokia buvo
 *      `authorize.js:50` → maršrutai → servisai → `rasytiAudita` grandinė, ir
 *      ją rado peržiūra, ne paieška. Tam reikėtų tarpprocedūrinio taint-sekimo
 *      — atskiro, gerokai didesnio darbo (#246 „Ko NEAPIMA").
 *   2. ❌ APVALKALAS KITAME MODULYJE. Modulis, eksportuojantis savo
 *      `pazymetiVeiksma()`, kuris viduje kviečia `setActor()`, bus pažymėtas
 *      TAME modulyje (teisingai), bet jo kvietėjas — ne.
 *   3. ❌ DINAMINIS RAKTAS. `obj[kintamasis] = vardas` arba
 *      `rasytiAudita({ [laukas]: vardas })` AST'e nėra `Identifier` savybė.
 *   4. ❌ `<SPREAD>` ARGUMENTAI. `rasytiAudita` turi dvi tokias vietas, abi
 *      `services/protocolService.js` (`...(redactionAuditMeta ? {...} : {})`).
 *      Rankinis patikrinimas (#246 prieš sargo rašymą): abi neša tik `redaction`
 *      raktą, kurio turinys yra `redactionStatus` / `policyVersion` / `variant` /
 *      `outcome` / skaitliukai. ⚠️ BET `:231` paskleidžia VISĄ
 *      `redactionAuditMeta` objektą, tad jo saugumą garantuoja `piiRedaction.js`
 *      konstrukcija ir komentaras, NE struktūra. Sargas į vidų nežiūri.
 *   5. ❌ SHADOWING. `helpers/astAnalize.js` įrišimų išrišimas yra vienfailinis
 *      ir ne scope manager (žr. jo antraštę ir `astAnalize.test.js` ribos testą).
 *
 * ⚠️ GALUTINĖ PERSISTAVIMO GARANTIJA YRA RAW ELGSENOS TESTAS
 * (`identityAuditRaw.integration.test.js`), ne šis sargas. Jei kada atrodys, kad
 * sargas pakankamas, perskaityti šį sąrašą dar kartą.
 */

const SAKNIS = path.join(__dirname, "..");

/**
 * IDENTIFIKUOJANČIŲ LAUKŲ VARDAI — IŠVEDAMI IŠ AUTORITETO, ne surašomi.
 *
 * Autoritetas yra `utils/credentials.js` vartotojo įrašo schema
 * (`vardas:rolė:maiša:userId`). ⚠️ `role` IŠSKIRIAMAS: `KNOWN_ROLES` yra uždara
 * enum'a, ne identifikatorius, ir jo įtraukimas duotų klaidingus kritimus.
 * ❌ Jokio naujo produkcinio PII klasifikatoriaus čia nekuriama — tik skaitoma
 * esama schema.
 */
function identifikuojantysLaukai() {
  const maisa = hashPassword("fikstura-slaptas-1");
  const vartotojai = loadUsers({
    AUTH_USERS: `sargofikstura:operator:${maisa}:33333333-3333-4333-8333-333333333333`,
  });
  const [vartotojas] = [...vartotojai.values()];
  const laukai = Object.keys(vartotojas).filter((k) => k !== "role");
  assert.ok(laukai.includes("username"), "schema privalo turėti `username`");
  assert.ok(laukai.includes("userId"), "schema privalo turėti `userId`");
  return laukai;
}

/**
 * ⚠️ ALIASAI: TA PATI REIKŠMĖ, KITAS SAVYBĖS VARDAS — IR TAI REALUS DEFEKTAS.
 *
 * Schemos vardai neužtenka: `userId` repo prieinamas dar dviem vardais, ir
 * BŪTENT dėl to pirmoji šio sargo redakcija NEBŪTŲ pagavusi C kanalo
 * (`actor: actor.ownerId`). Rasta paleidus M5 mutaciją prieš sargą.
 *
 * ⚠️ ŽEMĖLAPIS INKARUOTAS, NE SURAŠYTAS IŠ ATMINTIES: kiekvienam aliasui
 * tikrinama, kad pervadinimas produkcijoje DAR egzistuoja. Pakeitus pervadinimą,
 * krenta ši patikra, ne tylus praleidimas sarge.
 */
const ALIASAI = Object.freeze([
  {
    savybe: "ownerId",
    failas: "utils/ownerScope.js",
    inkaras: "ownerId: req.user.id",
  },
  {
    savybe: "id",
    failas: "middleware/sessionAuth.js",
    inkaras: "id: session.userId",
    /** ⚠️ TIK po `req.user` / `session` šaknimi: `job.id` nėra asmuo. */
    tikSaknys: ["user", "session"],
  },
]);

test("#246 D9 ⚠️ ALIASŲ INKARAI: pervadinimai produkcijoje dar egzistuoja", () => {
  for (const alias of ALIASAI) {
    const tekstas = fs.readFileSync(path.join(SAKNIS, alias.failas), "utf8");
    assert.ok(
      tekstas.includes(alias.inkaras),
      `aliasas \`${alias.savybe}\` inkaruotas į "${alias.inkaras}" (${alias.failas}), bet jo tekste nebėra — žemėlapį reikia perskaičiuoti`
    );
  }
});

function produkciniaiFailai(saknis = SAKNIS) {
  const rasti = [];
  (function eitiKatalogu(katalogas) {
    for (const irasas of fs.readdirSync(katalogas, { withFileTypes: true })) {
      if (irasas.name === "node_modules" || irasas.name === "tests") continue;
      const pilnas = path.join(katalogas, irasas.name);
      if (irasas.isDirectory()) eitiKatalogu(pilnas);
      else if (/\.(js|mjs)$/.test(irasas.name)) rasti.push(pilnas);
    }
  })(saknis);
  return rasti;
}

const KONFIG = Object.freeze({
  moduliai: { requestContext: /(^|\/)requestContext$/ },
  vardai: { requestContext: /^setActor$/ },
});

/**
 * Ar išraiška yra narys, nešantis asmens reikšmę?
 *
 * Atitinka schemos laukus (`username`, `userId`, `passwordHash`) ir inkaruotus
 * aliasus; `id` — tik po `req.user` / `session` šaknimi.
 */
function arIdentityNarys(mazgas, laukai) {
  if (!mazgas || mazgas.type !== "MemberExpression") return false;
  if (mazgas.property.type !== "Identifier") return false;
  const vardas = mazgas.property.name;

  if (laukai.includes(vardas)) return true;

  const alias = ALIASAI.find((a) => a.savybe === vardas);
  if (!alias) return false;
  if (!alias.tikSaknys) return true;

  /** Šaknis tikrinama iš tiesioginio objekto: `req.user.id` -> `user`. */
  const objektas = mazgas.object;
  const objektoVardas =
    objektas.type === "MemberExpression" && objektas.property.type === "Identifier"
      ? objektas.property.name
      : objektas.type === "Identifier"
        ? objektas.name
        : null;
  return alias.tikSaknys.includes(objektoVardas);
}

/** Ar mazgas yra `rasytiAudita(...)` kvietimas? */
function arAuditoRasymas(mazgas) {
  if (mazgas.type !== "CallExpression") return false;
  const k = mazgas.callee;
  const vardas =
    k.type === "Identifier"
      ? k.name
      : k.type === "MemberExpression" && k.property.type === "Identifier"
        ? k.property.name
        : null;
  return vardas === "rasytiAudita";
}

/** Savybės reikšmė plius ternaro šakos — `actor: x ? y.username : null`. */
function reiksmes(savybe) {
  const r = [savybe.value];
  if (savybe.value.type === "ConditionalExpression") r.push(savybe.value.consequent, savybe.value.alternate);
  return r;
}

let _medis = null;
function medis() {
  if (_medis) return _medis;
  _medis = [];
  for (const failas of produkciniaiFailai()) {
    const tekstas = fs.readFileSync(failas, "utf8");
    /** Pirminis filtras — saugi viršutinė aproksimacija (žr. #440 P3 pagrindimą). */
    if (!/setActor|actor|username|userId/.test(tekstas)) continue;
    const { programa } = analize(tekstas);
    const mazgai = [...eiti(programa)];
    _medis.push({
      failas: path.relative(SAKNIS, failas),
      mazgai,
      rista: irisimai(mazgai, KONFIG),
    });
  }
  return _medis;
}

test("#246 D9 SAVIKONTROLĖ: detektoriai neakli", () => {
  /**
   * ⚠️ BE ŠIOS PATIKROS visi trys invariantai praeitų TUŠČIAI, jei AST
   * predikatas nustotų atitikti — sargas rodytų žalią be apsaugos.
   */
  const laukai = identifikuojantysLaukai();

  const imituotas = `
    const { setActor } = require("../utils/requestContext");
    function blogai(req, session) {
      setActor(session.username);
      const identity = { actor: req.user.username, role: "x" };
      return identity;
    }
  `;
  const { programa } = analize(imituotas);
  const mazgai = [...eiti(programa)];
  const rista = irisimai(mazgai, KONFIG);

  const setActorKvietimai = mazgai.filter((m) => arNarioKvietimas(m, "requestContext", rista, KONFIG.vardai));
  assert.equal(setActorKvietimai.length, 1, "`setActor` detektorius aklas");
  assert.ok(arIdentityNarys(setActorKvietimai[0].arguments[0], laukai), "argumento detektorius aklas");

  const actorSavybes = mazgai.filter(
    (m) => m.type === "Property" && m.key.type === "Identifier" && m.key.name === "actor"
  );
  assert.equal(actorSavybes.length, 1, "`actor` savybės detektorius aklas");
  assert.ok(arIdentityNarys(actorSavybes[0].value, laukai), "savybės reikšmės detektorius aklas");

  assert.ok(medis().length >= 10, `medyje ${medis().length} failų — pirminis filtras per agresyvus`);
});

test("#246 D9 · I1: `setActor()` niekada negauna identifikuojančio lauko", () => {
  /**
   * A KANALAS. ⚠️ Tai buvo tikroji šaknis: `actor` yra `META_LAUKAI`, o
   * `auditLog.js` numatytąją reikšmę ima `entry.actor ?? getActor()`, tad vienas
   * `setActor(session.username)` įrašydavo vardą į KIEKVIENOS sesija
   * autentifikuotos užklausos audito eilutę.
   */
  const laukai = identifikuojantysLaukai();
  const pazeidimai = [];
  for (const { failas, mazgai, rista } of medis()) {
    for (const mazgas of mazgai) {
      if (!arNarioKvietimas(mazgas, "requestContext", rista, KONFIG.vardai)) continue;
      if (arIdentityNarys(mazgas.arguments[0], laukai)) {
        pazeidimai.push(`${failas}:${mazgas.loc.start.line}`);
      }
    }
  }
  assert.deepEqual(pazeidimai, [], `\`setActor()\` gauna identity:\n${pazeidimai.join("\n")}`);
});

test("#246 D9 · I2a: `rasytiAudita()` argumento `actor` nėra asmens reikšmė", () => {
  /**
   * C KANALAS. `adminJobService` keturios vietos rašė `actor: actor.ownerId`, o
   * `ownerId` yra `req.user.id` (#158 userId) — pagal #246 toks pat pažeidimas
   * kaip plikas vardas.
   *
   * ⚠️ APIMTIS YRA `rasytiAudita` ARGUMENTAS, NE VISI `actor:` RAKTAI.
   * Globalus variantas buvo pirmoji šio testo redakcija, ir jis pagavo
   * TEISĖTĄ nuosavybės kelią: `routes/jobs.js` `jobActor()` grąžina
   * `actor: req.user.id` į `jobStore.create()`, o tai darbo SAVININKAS, kurį
   * #246 eksplicitiškai palieka (`jobs.owner_id`, ne `audit_log.meta`).
   * Klaidingas kritimas ten būtų privertęs arba išimti sargą, arba sulaužyti
   * nuosavybės modelį.
   */
  const laukai = identifikuojantysLaukai();
  const pazeidimai = [];
  for (const { failas, mazgai } of medis()) {
    for (const mazgas of mazgai) {
      if (!arAuditoRasymas(mazgas)) continue;
      const arg = mazgas.arguments[0];
      if (!arg || arg.type !== "ObjectExpression") continue;
      for (const savybe of arg.properties) {
        if (savybe.type !== "Property" || savybe.key.type !== "Identifier") continue;
        if (savybe.key.name !== "actor") continue;
        if (reiksmes(savybe).some((r) => arIdentityNarys(r, laukai))) {
          pazeidimai.push(`${failas}:${savybe.loc.start.line}`);
        }
      }
    }
  }
  assert.deepEqual(pazeidimai, [], `audito \`actor\` neša asmens reikšmę:\n${pazeidimai.join("\n")}`);
});

test("#246 D9 · I2b: `resolveIdentity()` negrąžina asmens reikšmės kaip `actor`", () => {
  /**
   * B KANALAS — ir tai buvo kelias, kurio `setActor` inventorius NEDENGĖ.
   * `middleware/authorize.js` `resolveIdentity()` yra autoritetinis tapatybės
   * sprendėjas: jo `actor` keliauja per `req.authz` į maršrutus ir servisus, o iš
   * jų į auditą. Patikra scope'inama į TĄ funkciją, nes būtent ji nusako, kas
   * laikoma aktoriumi visoje užklausoje.
   */
  const laukai = identifikuojantysLaukai();
  const failas = "middleware/authorize.js";
  const { programa } = analize(fs.readFileSync(path.join(SAKNIS, failas), "utf8"));

  const funkcija = [...eiti(programa)].find(
    (n) =>
      (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") &&
      n.id &&
      n.id.name === "resolveIdentity"
  );
  assert.ok(funkcija, `\`resolveIdentity\` nebeegzistuoja ${failas} — sargo apimtį reikia perskaičiuoti`);

  const pazeidimai = [];
  for (const mazgas of eiti(funkcija.body)) {
    if (mazgas.type !== "Property" || mazgas.key.type !== "Identifier") continue;
    if (mazgas.key.name !== "actor") continue;
    if (reiksmes(mazgas).some((r) => arIdentityNarys(r, laukai))) {
      pazeidimai.push(`${failas}:${mazgas.loc.start.line}`);
    }
  }
  assert.deepEqual(pazeidimai, [], `\`resolveIdentity\` grąžina asmens reikšmę:\n${pazeidimai.join("\n")}`);
});

test("#246 D9 · I3: `details` šablonuose nėra identifikuojančių laukų", () => {
  /**
   * D KANALAS. `routes/auth.js` keturios vietos rašė `username=${…}`.
   * Tikrinamos ir šablono IŠRAIŠKOS (`${identity.username}`), ir tekstas
   * (`username=`), nes vardas gali būti įterptas abiem būdais.
   */
  const laukai = identifikuojantysLaukai();
  const pazeidimai = [];
  for (const { failas, mazgai } of medis()) {
    for (const mazgas of mazgai) {
      if (mazgas.type !== "Property" || mazgas.key.type !== "Identifier") continue;
      if (mazgas.key.name !== "details") continue;

      for (const vidus of eiti(mazgas.value)) {
        if (arIdentityNarys(vidus, laukai)) pazeidimai.push(`${failas}:${mazgas.loc.start.line} (išraiška)`);
        if (
          vidus.type === "TemplateElement" &&
          laukai.some((l) => new RegExp(`\\b${l}\\s*=`, "i").test(vidus.value.raw))
        ) {
          pazeidimai.push(`${failas}:${mazgas.loc.start.line} (tekstas)`);
        }
      }
    }
  }
  assert.deepEqual(pazeidimai, [], `\`details\` neša identity:\n${pazeidimai.join("\n")}`);
});
