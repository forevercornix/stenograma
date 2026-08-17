const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  ACCESS_INPUT: IN,
  ACCESS_DECISION: D,
  OPERATION: OP,
  isSessionAdmin,
  decideJobAccess,
} = require("../utils/jobAccessPolicy");
const { OWNER_KIND } = require("../utils/jobStore/common");

const UID = "11111111-1111-4111-8111-111111111111";

const userActor = { ownerId: UID, ownerKind: OWNER_KIND.USER, role: "operator" };
const adminActor = { ownerId: UID, ownerKind: OWNER_KIND.USER, role: "administrator" };
const apiKeyAdmin = { ownerId: null, ownerKind: OWNER_KIND.API_KEY, role: "administrator" };
const desktopActor = { ownerId: null, ownerKind: OWNER_KIND.UNOWNED, role: "administrator" };

/* ══════════════════════════════════════════════════════════════════════════
 * KAS YRA „ADMIN"
 * ══════════════════════════════════════════════════════════════════════════ */

test("#160 ADMIN: API rakto principalas NĖRA admin, net su administrator role", () => {
  /**
   * KRITINIS NEIGIAMAS ATVEJIS.
   *
   * `middleware/authorize.js:35` – `API_KEY_ROLE` NUMATYTOJI reikšmė yra
   * `administrator`. Todėl patikra vien pagal rolę atidarytų trynimo override
   * kiekvienam bendro rakto turėtojui PAGAL NUTYLĖJIMĄ, be jokios
   * konfigūracijos klaidos.
   */
  assert.equal(apiKeyAdmin.role, "administrator", "prielaida: raktas turi admin rolę");
  assert.equal(isSessionAdmin(apiKeyAdmin), false);

  assert.equal(
    decideJobAccess({ input: IN.FORBIDDEN, actor: apiKeyAdmin, operation: OP.DELETE }),
    D.NOT_FOUND,
    "bendras raktas negauna trynimo override"
  );
  assert.equal(
    decideJobAccess({ input: IN.MISSING, actor: apiKeyAdmin, operation: OP.DELETE }),
    D.NOT_FOUND,
    "bendras raktas negauna našlaičių valymo"
  );
});

test("#160 ADMIN: desktop principalas NĖRA admin", () => {
  assert.equal(isSessionAdmin(desktopActor), false, "no-auth režimas neturi override");
});

test("#160 ADMIN: sesijos vartotojas su administrator role IR stabiliu ID", () => {
  assert.equal(isSessionAdmin(adminActor), true);
  assert.equal(isSessionAdmin(userActor), false, "operator nėra admin");
  assert.equal(isSessionAdmin({ ...adminActor, ownerId: null }), false, "be stabilaus ID – ne");
  assert.equal(isSessionAdmin(null), false);
  assert.equal(isSessionAdmin(undefined), false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * PILNA MATRICA: input × actor × operation
 * ══════════════════════════════════════════════════════════════════════════ */

const MATRICA = [
  // savas job'as – visiems vienodai
  [IN.OWNED, "eilinis", userActor, OP.READ, D.OWNER_ACCESS],
  [IN.OWNED, "eilinis", userActor, OP.EXPORT, D.OWNER_ACCESS],
  [IN.OWNED, "eilinis", userActor, OP.DELETE, D.OWNER_ACCESS],
  [IN.OWNED, "admin", adminActor, OP.READ, D.OWNER_ACCESS],
  [IN.OWNED, "admin", adminActor, OP.EXPORT, D.OWNER_ACCESS],
  [IN.OWNED, "admin", adminActor, OP.DELETE, D.OWNER_ACCESS],

  // svetimas / legacy – egzistuoja, bet ne tavo
  [IN.FORBIDDEN, "eilinis", userActor, OP.READ, D.NOT_FOUND],
  [IN.FORBIDDEN, "eilinis", userActor, OP.EXPORT, D.NOT_FOUND],
  [IN.FORBIDDEN, "eilinis", userActor, OP.DELETE, D.NOT_FOUND],
  [IN.FORBIDDEN, "admin", adminActor, OP.READ, D.DENIED],
  [IN.FORBIDDEN, "admin", adminActor, OP.EXPORT, D.DENIED],
  [IN.FORBIDDEN, "admin", adminActor, OP.DELETE, D.ADMIN_DELETE_OVERRIDE],

  // našlaitis – store'e nėra
  [IN.MISSING, "eilinis", userActor, OP.READ, D.NOT_FOUND],
  [IN.MISSING, "eilinis", userActor, OP.EXPORT, D.NOT_FOUND],
  [IN.MISSING, "eilinis", userActor, OP.DELETE, D.NOT_FOUND],
  [IN.MISSING, "admin", adminActor, OP.READ, D.DENIED],
  [IN.MISSING, "admin", adminActor, OP.EXPORT, D.DENIED],
  [IN.MISSING, "admin", adminActor, OP.DELETE, D.ADMIN_ORPHAN_CLEANUP],
];

test("#160 MATRICA: visos 18 ląstelių", () => {
  for (const [input, kas, actor, operation, laukiama] of MATRICA) {
    assert.equal(
      decideJobAccess({ input, actor, operation }),
      laukiama,
      `${input} × ${kas} × ${operation}`
    );
  }
  assert.equal(MATRICA.length, 18, "matrica turi būti pilna: 3 input × 2 actor × 3 op");
});

test("#160 MATRICA: eilinis vartotojas NIEKADA negauna 403 (jokio egzistavimo orakulo)", () => {
  /**
   * 403 patvirtintų, kad objektas EGZISTUOJA. Jei ID nuspėjamas, tai
   * egzistavimo orakulas – todėl eiliniam vartotojui visi keliai veda į 404.
   */
  for (const [input, kas, actor, operation, laukiama] of MATRICA) {
    if (kas !== "eilinis") continue;
    assert.notEqual(laukiama, D.DENIED, `${input} × ${operation} neturi grąžinti DENIED`);
  }
});

test("#160 MATRICA: admin NEGALI skaityti svetimo job'o", () => {
  /**
   * Override yra OPERACIJOS savybė, ne rolės. Least privilege: svetimo
   * protokolo skaitymas jautresnis nei jo ištrynimas – trynimas turinio
   * nepamato.
   */
  assert.equal(
    decideJobAccess({ input: IN.FORBIDDEN, actor: adminActor, operation: OP.READ }),
    D.DENIED
  );
  assert.equal(
    decideJobAccess({ input: IN.FORBIDDEN, actor: adminActor, operation: OP.EXPORT }),
    D.DENIED
  );
  assert.equal(
    decideJobAccess({ input: IN.FORBIDDEN, actor: adminActor, operation: OP.DELETE }),
    D.ADMIN_DELETE_OVERRIDE,
    "bet trynimas leidžiamas"
  );
});

test("#160 MATRICA: FORBIDDEN ir MISSING duoda SKIRTINGUS admin sprendimus", () => {
  /**
   * Legacy job'as store'e YRA (tik be `ownerKind`), našlaičio NĖRA. Jie negali
   * dalytis viena šaka: skiriasi tai, ką galima įrodyti apie nuosavybę.
   */
  const del = (input) => decideJobAccess({ input, actor: adminActor, operation: OP.DELETE });

  assert.equal(del(IN.FORBIDDEN), D.ADMIN_DELETE_OVERRIDE);
  assert.equal(del(IN.MISSING), D.ADMIN_ORPHAN_CLEANUP);
  assert.notEqual(del(IN.FORBIDDEN), del(IN.MISSING));
});

/* ══════════════════════════════════════════════════════════════════════════
 * GRYNUMAS IR VALIDACIJA
 * ══════════════════════════════════════════════════════════════════════════ */

test("#160 GRYNUMAS: funkcija neturi šalutinio poveikio", () => {
  /**
   * Helperis PRIIMA SPRENDIMĄ, bet nevykdo veiksmo. Kitaip „bendras HTTP
   * mapping helperis" virstų authorization + deletion orchestration moduliu,
   * o lenktynių scenarijus taptų sunku testuoti izoliuotai.
   */
  const actor = { ...adminActor };
  const snapshot = JSON.stringify(actor);

  for (const [input, , , operation] of MATRICA) {
    decideJobAccess({ input, actor, operation });
  }

  assert.equal(JSON.stringify(actor), snapshot, "actor objektas nekeičiamas");

  // Tas pats įėjimas visada duoda tą patį rezultatą (nėra vidinės būsenos).
  const pirmas = decideJobAccess({ input: IN.FORBIDDEN, actor, operation: OP.DELETE });
  const antras = decideJobAccess({ input: IN.FORBIDDEN, actor, operation: OP.DELETE });
  assert.equal(pirmas, antras);
});

test("#160 VALIDACIJA: nežinomas input ar operacija meta klaidą, ne tylų NOT_FOUND", () => {
  /**
   * Tylus `NOT_FOUND` paslėptų kodo klaidą ir atrodytų kaip normalus atsakymas.
   */
  assert.throws(
    () => decideJobAccess({ input: "isgalvota", actor: adminActor, operation: OP.READ }),
    /nežinomas input/
  );
  assert.throws(
    () => decideJobAccess({ input: IN.OWNED, actor: adminActor, operation: "isgalvota" }),
    /nežinoma operacija/
  );
});

test("#160 SAVYBĖ: ne-session principalai NIEKADA negauna DENIED ar override", () => {
  /**
   * PROPERTY-STYLE, ne atskiri atvejai.
   *
   * Politika remiasi principalo RŪŠIMI, tad atskiri testai dengia tik tas
   * ląsteles, kurias kas nors prisiminė parašyti. Ši savybė galioja VISOMS
   * kombinacijoms, ir ji krinta, jei kada nors nukryps viena šaka.
   *
   * Tikrinama su `administrator` role SĄMONINGAI: jei politika kada nors
   * pradėtų remtis vien role, šis testas kris pirmas.
   */
  const neSesijos = [
    ["api-key", { ownerId: null, ownerKind: OWNER_KIND.API_KEY, role: "administrator" }],
    ["desktop", { ownerId: null, ownerKind: OWNER_KIND.UNOWNED, role: "administrator" }],
    ["user be ID", { ownerId: null, ownerKind: OWNER_KIND.USER, role: "administrator" }],
  ];

  const adminSprendimai = [D.DENIED, D.ADMIN_DELETE_OVERRIDE, D.ADMIN_ORPHAN_CLEANUP];

  for (const [vardas, actor] of neSesijos) {
    for (const input of [IN.FORBIDDEN, IN.MISSING]) {
      for (const operation of Object.values(OP)) {
        const sprendimas = decideJobAccess({ input, actor, operation });

        /**
         * VIENINTELĖ EKSPLICITINĖ IŠIMTIS: desktop režimo našlaičių valymas.
         *
         * Tai NĖRA admin override – tai vieno vartotojo režimas, kur kitų
         * vartotojų, nuo kurių reikėtų saugotis, apskritai nėra. Išimtis
         * įrašyta ČIA, o ne praleista tyliai, kad savybė liktų tikrinama.
         */
        const desktopValymas =
          vardas === "desktop" && input === IN.MISSING && operation === OP.DELETE;
        if (desktopValymas) {
          assert.equal(sprendimas, D.DESKTOP_ORPHAN_CLEANUP);
          continue;
        }

        assert.equal(
          sprendimas,
          D.NOT_FOUND,
          `${vardas} × ${input} × ${operation}: turi būti NOT_FOUND`
        );
        assert.ok(
          !adminSprendimai.includes(sprendimas),
          `${vardas} × ${input} × ${operation}: negali gauti admin sprendimo`
        );
      }
    }
  }
});

test("#160 SAVYBĖ: savas job'as prieinamas NEPRIKLAUSOMAI nuo principalo rūšies", () => {
  /**
   * Antra savybės pusė: nuosavybės filtras neturi blokuoti tikrojo savininko.
   * Jei `OWNED` kada nors imtų priklausyti nuo rūšies ar rolės, API-key ir
   * desktop klientai netektų prieigos prie savo pačių job'ų.
   */
  const visi = [
    userActor,
    adminActor,
    apiKeyAdmin,
    desktopActor,
    { ownerId: null, ownerKind: OWNER_KIND.API_KEY, role: "operator" },
  ];

  for (const actor of visi) {
    for (const operation of Object.values(OP)) {
      assert.equal(
        decideJobAccess({ input: IN.OWNED, actor, operation }),
        D.OWNER_ACCESS,
        `${actor.ownerKind}/${actor.role} × ${operation}`
      );
    }
  }
});

test("#160 DESKTOP: bendras API_KEY negauna našlaičių valymo, nors ownerId irgi null", () => {
  /**
   * Desktop išimtis remiasi prielaida „kitų vartotojų nėra". Bendram raktui ji
   * NEGALIOJA: jį gali turėti keli žmonės ar servisai, tad vienas iš jų galėtų
   * ištrinti kito pėdsakus žinodamas job ID.
   *
   * Abu principalai turi `ownerId: null` – skiria TIK rūšis.
   */
  const desktop = { ownerId: null, ownerKind: OWNER_KIND.UNOWNED, role: "operator" };
  const apiKey = { ownerId: null, ownerKind: OWNER_KIND.API_KEY, role: "administrator" };

  assert.equal(
    decideJobAccess({ input: IN.MISSING, actor: desktop, operation: OP.DELETE }),
    D.DESKTOP_ORPHAN_CLEANUP
  );
  assert.equal(
    decideJobAccess({ input: IN.MISSING, actor: apiKey, operation: OP.DELETE }),
    D.NOT_FOUND,
    "bendras raktas – ne vieno vartotojo režimas"
  );
});

test("#160 DESKTOP: išimtis galioja TIK DELETE ir TIK našlaičiams", () => {
  const desktop = { ownerId: null, ownerKind: OWNER_KIND.UNOWNED, role: "administrator" };

  assert.equal(decideJobAccess({ input: IN.MISSING, actor: desktop, operation: OP.READ }), D.NOT_FOUND);
  assert.equal(decideJobAccess({ input: IN.MISSING, actor: desktop, operation: OP.EXPORT }), D.NOT_FOUND);
  assert.equal(
    decideJobAccess({ input: IN.FORBIDDEN, actor: desktop, operation: OP.DELETE }),
    D.NOT_FOUND,
    "svetimas EGZISTUOJANTIS job'as – jokios išimties"
  );
});
