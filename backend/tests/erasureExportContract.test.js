const test = require("node:test");
const assert = require("node:assert/strict");

const erasureExport = require("../utils/erasureExport");
const { TOMBSTONE_STATUS, ALLOWED_TRANSITIONS } = require("../utils/deletionTombstones/states");
const memoryStore = require("../utils/deletionTombstones/memoryStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * 7.6c SULIEJIMO TAISYKLĖ BE DUOMENŲ BAZĖS (#155, #250).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Įrodo SPRENDIMĄ: kuris iš dviejų to paties modelio įrašų yra autoritetingas,
 * kas nutinka su svetimu `claim_token`, kaip suliejamas kopijų horizontas ir
 * kurioms žymoms reikia replay. Visa tai yra gryna logika, tad DB čia nieko
 * nepridėtų — o `postgresStore` `updated_at` stamp'inimas serveriu reikštų, kad
 * testas tikrintų DB laikrodį, ne taisyklę.
 *
 * NEĮRODO: kad sulieta žyma realiai atsiduria `erasure_marks`, kad replay šalina
 * eilutes ir kad seka fail-closed — tam reikia tikros DB, ir tai gyvena
 * `drRestore.integration`.
 */

const S = TOMBSTONE_STATUS;

/** Trumpas žymos konstruktorius — laiko reikšmės sąmoningai skaitomos. */
function zyma(jobId, status, updatedAt, extra = {}) {
  return {
    jobId,
    status,
    reason: "user_request",
    actorKind: "user",
    requestedAt: updatedAt - 1000,
    updatedAt,
    completedAt: status === S.DELETED ? updatedAt : null,
    attempts: 0,
    lastFailureKind: status === S.FAILED ? "storage" : null,
    claimToken: null,
    ...extra,
  };
}

test("#250 D1: terminalumas IŠVEDAMAS iš grafo, ir terminalus statusas yra VIENAS", () => {
  /**
   * ⚠️ IŠVEDIMAS, NE SĄRAŠAS. `deleted` laimi ne todėl, kad taip parašyta
   * suliejime, o todėl, kad iš jo grafe nėra kur eiti.
   *
   * ⚠️ ANTRA EILUTĖ YRA TRIPWIRE. Išvedimas per `length === 0` teisingas TIK kol
   * terminalus statusas vienas. Jei `FAILED` kada nors taptų terminalus,
   * `laimiImportuotas()` imtų grąžinti „abu terminalūs" atvejį, kurio taisyklė
   * neapibrėžia — tad pokytis privalo būti SĄMONINGAS, ne tylus.
   */
  assert.equal(erasureExport.arTerminalus(S.DELETED), true);
  assert.equal(erasureExport.arTerminalus(S.PENDING), false);
  assert.equal(erasureExport.arTerminalus(S.FAILED), false);

  assert.deepEqual(erasureExport.terminaliniaiStatusai(), [S.DELETED], "grafe terminalus statusas privalo likti VIENAS");

  /** Kontrolė: grafas tikrai turi ir ne terminalinių — kitaip patikra būtų tuščia. */
  assert.ok(Object.values(ALLOWED_TRANSITIONS).some((i) => i.length > 0));
});

test("#250 D1: `deleted` merge NEPAVERČIA `deletion_pending` — nė viena kryptimi", () => {
  /**
   * ⚠️ ABI KRYPTYS, NES TAI DVI SKIRTINGOS KLAIDOS.
   *
   * Vietinis `deleted` + importuotas `pending` → prikeltume ištrintą subjektą.
   * Vietinis `pending` + importuotas `deleted` → prarastume galutinumo įrodymą.
   * Terminalumas laimi NEPRIKLAUSOMAI nuo to, kurioje pusėje jis yra.
   */
  const vietinesSuDeleted = new Map([["a", zyma("a", S.DELETED, 100)]]);
  const planas = erasureExport.suliejimoPlanas([zyma("a", S.PENDING, 900)], vietinesSuDeleted);

  assert.deepEqual(planas.rasyti, [], "naujesnis `pending` NEGALI perrašyti vietinio `deleted`");
  assert.equal(planas.praleisti[0].jobId, "a");

  const vietinesSuPending = new Map([["a", zyma("a", S.PENDING, 900)]]);
  const atgal = erasureExport.suliejimoPlanas([zyma("a", S.DELETED, 100)], vietinesSuPending);

  assert.equal(atgal.rasyti.length, 1, "senesnis `deleted` PRIVALO laimėti prieš naujesnį `pending`");
  assert.equal(atgal.rasyti[0].status, S.DELETED);
});

test("#250 D1: `pending` vs `failed` sprendžia LAIKAS, ir abi kryptys tikrinamos", () => {
  /**
   * ⚠️ GRAFAS ČIA TYLI: `PENDING → FAILED → PENDING` yra ciklas.
   *
   * Senesnio `pending` importas virš naujesnio `failed` nutrintų gedimo
   * metaduomenis; senesnio `failed` importas virš naujesnio `pending` nuslopintų
   * autorizuotą retry. Abi klaidos tylios, tad abi tikrinamos.
   */
  const naujesnisFailed = new Map([["a", zyma("a", S.FAILED, 900)]]);
  const senesnisPending = erasureExport.suliejimoPlanas([zyma("a", S.PENDING, 100)], naujesnisFailed);
  assert.deepEqual(senesnisPending.rasyti, [], "senesnis `pending` neperrašo naujesnio `failed`");

  const naujesnisPending = new Map([["a", zyma("a", S.PENDING, 900)]]);
  const senesnisFailed = erasureExport.suliejimoPlanas([zyma("a", S.FAILED, 100)], naujesnisPending);
  assert.deepEqual(senesnisFailed.rasyti, [], "senesnis `failed` neslopina naujesnio retry");

  /** ⚠️ KONTROLĖ: naujesnis importas PRIVALO laimėti — kitaip taisyklė būtų visada-„ne". */
  const senesnisVietinis = new Map([["a", zyma("a", S.FAILED, 100)]]);
  const naujesnisImportas = erasureExport.suliejimoPlanas([zyma("a", S.PENDING, 900)], senesnisVietinis);
  assert.equal(naujesnisImportas.rasyti.length, 1);
  assert.equal(naujesnisImportas.rasyti[0].status, S.PENDING);

  /** Lygiosios palieka vietinę: be naujesnio ĮRODYMO pokyčio nėra (D5). */
  const lygiosios = erasureExport.suliejimoPlanas([zyma("a", S.PENDING, 500)], new Map([["a", zyma("a", S.FAILED, 500)]]));
  assert.deepEqual(lygiosios.rasyti, [], "vienodas `updatedAt` nėra įrodymas");
});

test("#250 D1: svetimas `claim_token` NEPERSISTINAMAS, o faktas lieka matomas", () => {
  /**
   * ⚠️ TOKENAS ŽYMI GYVĄ VYKDYTOJĄ, KURIO NEBĖRA.
   *
   * Importavus jį nepakeistą, `lifecycleService` grąžintų `IN_PROGRESS`
   * neribotai (`:338`), ir koordinatorius niekada nebaigtų.
   *
   * ⚠️ NUKERPAMA PRIEŠ RAŠYMĄ, ne per `release()` po jo: `release()` yra
   * `PENDING → FAILED(executor_lost)` — BŪSENOS pokytis, kuris dar ir bumpintų
   * `updated_at`, tad sanitizacija pati pagamintų šviežumą ir galėtų nurungti
   * tikrai naujesnę vietinę žymą.
   */
  const suTokenu = zyma("a", S.PENDING, 900, { claimToken: "pre-restore-vykdytojas" });
  const planas = erasureExport.suliejimoPlanas([suTokenu], new Map());

  assert.equal(planas.rasyti.length, 1);
  assert.equal(planas.rasyti[0].claimToken, null, "svetimas žetonas negali patekti į DB");
  assert.deepEqual(planas.nukirptiClaimai, ["a"], "faktas privalo likti evidencijai, ne dingti tyliai");

  /** ⚠️ KONTROLĖ: žyma BE tokeno į `nukirptiClaimai` nepatenka — kitaip skaičius nieko nesakytų. */
  const beTokeno = erasureExport.suliejimoPlanas([zyma("b", S.PENDING, 900)], new Map());
  assert.deepEqual(beTokeno.nukirptiClaimai, []);

  /** Originalus įrašas nemodifikuojamas: planas yra sprendimas, ne mutacija. */
  assert.equal(suTokenu.claimToken, "pre-restore-vykdytojas");
});

test("#250 D1: kopijų horizontas suliejamas MONOTONIŠKAI", () => {
  /**
   * ⚠️ SENESNIO SNAPSHOT'O ATKŪRIMAS ATSUKA `backup_horizon` ATGAL.
   *
   * Jei po to snapshot'o buvo išleista ilgiau galiojanti kopija, importuotos
   * žymos taptų šalintinos, nors ta kopija dar gali prikelti jų job'us.
   */
  assert.equal(erasureExport.horizontoMaksimumas(500, 900), 900);
  assert.equal(erasureExport.horizontoMaksimumas(900, 500), 900, "eksportuotas horizontas negali būti atsuktas");
  assert.equal(erasureExport.horizontoMaksimumas(null, 700), 700);
  assert.equal(erasureExport.horizontoMaksimumas(700, null), 700);
  assert.equal(erasureExport.horizontoMaksimumas(null, null), null);
});

test("#250 D2: replay apima VISAS žymas, ne tik `deleted`", () => {
  /**
   * ⚠️ BE ŠITO SANITIZACIJA TYLIAI PRARASTŲ IŠTRYNIMĄ.
   *
   * Nukirpus svetimą claim'ą, pagrindinis „pasenusio vykdytojo" atvejis DB guli
   * kaip `deletion_pending`. Replay, imantis tik `deleted`, tokį job'ą paliktų
   * gyvą — o DoD testas „neblokuoja ties `IN_PROGRESS`" vis tiek būtų žalias,
   * nes koordinatorius nebeužstrigtų.
   */
  for (const status of Object.values(S)) {
    assert.equal(erasureExport.arReikiaReplay(status), true, `${status}: žyma reiškia „duomenų būti negali"`);
  }

  /** ⚠️ KONTROLĖ: nežinomas statusas replay NEPATENKA — patikra ne visada-„taip". */
  assert.equal(erasureExport.arReikiaReplay("kazkas_kito"), false);
  assert.equal(erasureExport.arReikiaReplay(undefined), false);
});

test("#250: `listAll()` grąžina `deleted` — ABIEJUOSE backend'uose", async () => {
  /**
   * ⚠️ ŽYMŲ AŠIS TURI SAVO VERDIKTĄ (D7b), TAD ATMINTINIS BACKEND'AS PRIVALO
   * MOKĖTI TĄ PATĮ PAVIRŠIŲ.
   *
   * Tombstone saugyklos, skirtingai nei `jobStore`, pariteto sargo NETURI —
   * patikrinta. Todėl paritetas tikrinamas čia, elgesiu: tas pats rinkinys
   * sukamas prieš abu backend'us, ir `deleted` privalo būti eksporte, nes
   * `listUnresolved()` jos praleidžia.
   */
  const { createErasureMarkStore } = require("../utils/deletionTombstones/postgresStore");

  const eilutes = [];
  const pgStore = createErasureMarkStore({
    query: async (sql) => {
      if (/SELECT .* FROM erasure_marks ORDER BY job_id/s.test(sql)) return { rows: eilutes };
      return { rows: [] };
    },
  });

  memoryStore.clear();
  await memoryStore.mark("a", { reason: "user_request", actorKind: "user" });
  await memoryStore.transition("a", S.DELETED, {});
  await memoryStore.mark("b", { reason: "user_request", actorKind: "user" });

  const atmintyje = memoryStore.listAll();
  assert.deepEqual(
    atmintyje.map((z) => `${z.jobId}:${z.status}`),
    ["a:deleted", "b:deletion_pending"],
    "atmintinis eksportas privalo turėti `deleted`"
  );

  for (const z of atmintyje) {
    eilutes.push({
      job_id: z.jobId,
      status: z.status,
      reason: z.reason,
      actor_kind: z.actorKind,
      marked_at: new Date(z.requestedAt),
      updated_at: new Date(z.updatedAt),
      completed_at: z.completedAt ? new Date(z.completedAt) : null,
      attempts: z.attempts,
      last_failure_kind: z.lastFailureKind,
      claim_token: z.claimToken,
    });
  }

  const postgres = await pgStore.listAll();
  assert.deepEqual(
    postgres.map((z) => `${z.jobId}:${z.status}`),
    atmintyje.map((z) => `${z.jobId}:${z.status}`),
    "abu backend'ai privalo grąžinti tą pačią aibę"
  );

  memoryStore.clear();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TRIPWIRE: RESTORE-SPECIFIC TRYNIMO SQL NĖRA
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#250: DR moduliuose NĖRA nuosavo trynimo SQL — trynimas eina per autoritetą", () => {
  /**
   * ⚠️ APIMTIS IŠVEDAMA IŠ `require` GRAFO, NE IŠ RANKINIO SĄRAŠO (Codex, #288).
   *
   * Pirmoji redakcija turėjo penkių failų sąrašą, ir jame TRŪKO
   * `postRestoreReconcile.js`, nors `drCoordinator` jį tiesiogiai kviečia
   * (`suderinti()` žingsnis). `DELETE FROM jobs` ten būtų praėjęs, o testas
   * likęs žalias — t. y. sargas gynė tai, ką kažkas prisiminė įrašyti.
   *
   * Tai atskira, jau tris kartus šiame repo taisyta KLASĖ: #231 postgres rinkinys
   * (dabar išvedamas iš `postgresGuard` importo), `redis` masyvas (K1) ir
   * `backupDocumentation` ribų sąrašas. Todėl apimtis imama iš to, ką
   * koordinatorius REALIAI importuoja.
   *
   * ⚠️ GYLIS — VIENAS, IR TAI SĄMONINGA. Tranzityvi uždarymo aibė įtrauktų
   * `jobStore`, `auditStore` ir `deletionTombstones` saugyklas, kuriose trynimo
   * SQL yra TEISĖTAS — jos ir yra autoritetai. Taisyklė nėra „niekur nėra
   * `DELETE`", o „DR keliui SPECIFINIAI moduliai savo trynimo neturi".
   *
   * ⚠️ STATINĖ PATIKRA (§9.2): ji NEĮRODO, kad replay šalina — tai daro
   * `erasureReplayContract` ir `drRestore.integration`. Ji saugo nuo ANTROS
   * trynimo semantikos atsiradimo.
   */
  const fs = require("node:fs");
  const path = require("node:path");

  const saknis = path.resolve(__dirname, "..");
  const koordinatorius = fs.readFileSync(path.join(saknis, "utils/drCoordinator.js"), "utf8");

  /**
   * ESAMI AUTORITETAI: jiems trynimo SQL yra darbo dalis, tad jie praleidžiami —
   * bet KIEKVIENAS su priežastimi, ne tyliai.
   */
  const AUTORITETAI = {
    deletionTombstones: "žymų saugykla — jos SQL valdo `erasure_marks` gyvavimo ciklą",
    auditWrite: "audito rašymo politika — trynimo nevykdo, bet priklauso 7.4 autoritetui",
    auditLog: "audito žurnalas — `removeBySubjectIdentifier` yra jo atsakomybė",
    logger: "infrastruktūra",
  };

  const importai = [...koordinatorius.matchAll(/require\("\.\/([\w/-]+)"\)/g)].map((m) => m[1]);
  assert.ok(importai.length >= 7, "importų radimas neturi tyliai susitraukti");

  const tikrinami = importai.filter((vardas) => !AUTORITETAI[vardas.split("/")[0]]);

  /** ⚠️ KONTROLĖ: `postRestoreReconcile` PRIVALO patekti — būtent jo ir trūko. */
  assert.ok(
    tikrinami.includes("postRestoreReconcile"),
    "7.6b suderinimas yra DR kelyje, tad jo apimtis privaloma"
  );

  const failai = [
    ...tikrinami.map((v) => `utils/${v}.js`),
    "utils/drCoordinator.js",
    "scripts/dr-restore.mjs",
  ];

  const DRAUDZIAMA = /\b(DELETE\s+FROM|TRUNCATE\s+TABLE|TRUNCATE\s+\w|DROP\s+TABLE)\b/i;

  function beKomentaru(tekstas) {
    return tekstas.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  for (const santykinis of failai) {
    const turinys = beKomentaru(fs.readFileSync(path.join(saknis, santykinis), "utf8"));

    assert.equal(
      DRAUDZIAMA.test(turinys),
      false,
      `${santykinis}: rastas nuosavas trynimo SQL — DR kelias privalo eiti per ` +
        "`jobErasure.eraseJob()` ir `deletionTombstones`, ne turėti antrą semantiką"
    );
  }

  /** ⚠️ KONTROLĖS: patikra tikrai kažką mato, o komentarų kirpimas nesuėda kodo. */
  assert.equal(DRAUDZIAMA.test("await c.query('DELETE FROM jobs WHERE id = $1')"), true);
  assert.equal(beKomentaru("/* DELETE FROM jobs */ const x = 1;").includes("DELETE"), false);
  assert.ok(
    beKomentaru(fs.readFileSync(path.join(saknis, "utils/erasureReplay.js"), "utf8")).includes("eraseJob"),
    "nukirpus komentarus kodas privalo likti"
  );
});
