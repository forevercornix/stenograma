const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  RADINIAI,
  ivertintiPrijungima,
  nustatytiReikalingusTipus,
  nustatytiPrijungimoBusena,
} = require("../utils/artifactStore/prijungimoBusena");

/**
 * SAUGYKLŲ PRIJUNGIMO STEBĖTOJAS (#157, PR-7, 3 sąlyga) — BE DUOMENŲ BAZĖS.
 *
 * ⚠️ KODĖL BE JOS.
 *
 * Verdiktas yra trijų aibių palyginimas; nė vienai iš jų realios DB nereikia —
 * `pool` čia dalyvauja tik kaip užklausų vykdytojas, o jo elgesį (įskaitant `42P01`
 * ir tikrą gedimą) dublis atkuria tiksliau nei gyva bazė, kurioje tas šakas reikėtų
 * dar SUKELTI. SQL galiojimą prieš realią schemą tikrina atskiras integracinis
 * failas — ten jis yra vienintelis dalykas, kurio dublis pasakyti negali.
 *
 * ⚠️ PRIEŠ RAŠANT: šis failas BENDROS BŪSENOS NELIEČIA — nei DB, nei `process.env`
 * (aplinka paduodama argumentu), nei `jobStore` singleton'o. Kritęs testas čia
 * negali palikti nieko kitiems. Klausimas užduotas prieš, ne po trijų raundų.
 */

/**
 * Minimalus `pg` pool dublis: atsako pagal SQL fragmentą arba meta.
 *
 * ⚠️ MODELIUOJA IR TRANSAKCIJĄ, NE TIK `query`. Stebėtojas ima klientą, atidaro
 * transakciją ir deda `SET LOCAL statement_timeout` — dublis, mokantis tik `query`,
 * praleistų būtent tai, kas gali NUTEKĖTI į kitą kvietėją (klientas be `release()`
 * arba nustatymas, likęs ant pooled kliento).
 */
function pool(atsakymai, sekiklis = {}) {
  sekiklis.sakiniai = [];
  sekiklis.paimta = 0;
  sekiklis.grazinta = 0;

  return {
    async connect() {
      sekiklis.paimta += 1;
      return {
        async query(sql) {
          sekiklis.sakiniai.push(sql);
          for (const [fragmentas, reiksme] of Object.entries(atsakymai)) {
            if (!sql.includes(fragmentas)) continue;
            if (reiksme instanceof Error) throw reiksme;
            return { rows: reiksme.map((storage_type) => ({ storage_type })) };
          }
          return { rows: [] };
        },
        release() {
          sekiklis.grazinta += 1;
        },
      };
    },
  };
}

function store({ rasymoBackend = null, registruotiTipai = [] } = {}) {
  return { saugykluBusena: () => ({ rasymoBackend, registruotiTipai }) };
}

const klaida = (code) => Object.assign(new Error("dublis"), { code });

test("inline be prijungtos saugyklos — žalia, nes `inline` saugyklos nereikalauja", () => {
  const v = ivertintiPrijungima({ parinktas: "inline", rasymoBackend: null, reikalingiTipai: ["inline"] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.radiniai, []);
});

test("parinkta `s3`, bet rašymas neprijungtas — TYLI spraga tampa matoma", () => {
  const v = ivertintiPrijungima({ parinktas: "s3", rasymoBackend: null });
  assert.deepEqual(v.radiniai, [RADINIAI.RASYMAS_NEPRIJUNGTAS]);
  assert.match(v.santrauka, /rezultatai rašomi 'inline'/);
});

test("parinkta `s3`, prijungta `fs` — rašoma ne ten, kur prašyta", () => {
  const v = ivertintiPrijungima({ parinktas: "s3", rasymoBackend: "fs", registruotiTipai: ["fs"] });
  assert.deepEqual(v.radiniai, [RADINIAI.RASYMAS_NE_TAS]);
});

test("bazėje `s3` eilutės, registruotas tik `fs` — skaitymas kristų, ir tai matoma iš anksto", () => {
  const v = ivertintiPrijungima({
    parinktas: "fs",
    rasymoBackend: "fs",
    registruotiTipai: ["fs"],
    reikalingiTipai: ["fs", "s3"],
  });
  assert.deepEqual(v.radiniai, [RADINIAI.SKAITYMUI_TRUKSTA]);
  assert.deepEqual(v.truksta, ["s3"]);
});

/**
 * ⚠️ DU RADINIAI VIENU METU — TIKROJI PERĖJIMO BŪSENA.
 *
 * Diegimas, perjungtas į `s3` ir NEPRIJUNGTAS, kuriame guli seni `fs` rezultatai,
 * turi abi bėdas. Verdiktas, rodantis tik pirmą, nuvestų operatorių prijungti `s3`
 * ir palikti neperskaitomus `fs` rezultatus — t. y. antras gedimas paaiškėtų tik
 * po pirmo taisymo.
 */
test("abi bėdos matomos kartu, ne po vieną", () => {
  const v = ivertintiPrijungima({ parinktas: "s3", rasymoBackend: null, reikalingiTipai: ["fs"] });
  assert.deepEqual(v.radiniai, [RADINIAI.RASYMAS_NEPRIJUNGTAS, RADINIAI.SKAITYMUI_TRUKSTA]);
});

test("`nezinoma` nėra `ok: false` — neįvykęs stebėjimas nėra radinys", () => {
  const v = ivertintiPrijungima({ parinktas: "inline", nezinoma: true });
  assert.equal(v.nezinoma, true);
  assert.deepEqual(v.radiniai, []);
  assert.match(v.santrauka, /nustatyti nepavyko/);
});

test("reikalingų tipų aibė sudedama iš rezultatų IR bandymų registro", async () => {
  const saltiniai = await nustatytiReikalingusTipus(
    pool({ "FROM job_results": ["s3"], "FROM job_result_attempts": ["fs", "fs"] })
  );
  assert.deepEqual(saltiniai, { rezultatai: ["s3"], bandymai: ["fs"] });
});

/**
 * ⚠️ NEBAIGTAS BANDYMAS BE SAUGYKLOS = NAŠLAITIS SAUGYKLOJE.
 *
 * Jei reikalingi tipai būtų imami tik iš `job_results`, diegimas su `pending` `s3`
 * bandymu ir be `s3` saugyklos atrodytų žalias — o šlavėjas neturėtų kuo ištrinti
 * jau parašyto objekto. Registras egzistuoja būtent tam, kad tokių nebūtų.
 */
test("bandymų registro tipas vienas pats duoda radinį", () => {
  const v = ivertintiPrijungima({ parinktas: "inline", reikalingiTipai: ["s3"] });
  assert.deepEqual(v.radiniai, [RADINIAI.SKAITYMUI_TRUKSTA]);
});

/**
 * ⚠️ KAINOS RIBA IR KLIENTO GRĄŽINIMAS — VIENAME TESTE, NES TAI TA PATI KLAIDA.
 *
 * `storage_type` neindeksuotas, tad abu `SELECT DISTINCT` yra seq scan; be ribos
 * stebėtojas lėtintų KIEKVIENĄ startą. O riba, uždėta ant pooled kliento be
 * transakcijos, galiotų SEKANČIAM kvietėjui — nutekėjimas, matomas tik po apkrovos.
 * Todėl tikrinama: `BEGIN`, `SET LOCAL`, ir kad klientas grąžinamas TIEK KARTŲ,
 * kiek paimtas — įskaitant kelią su klaida.
 */
test("užklausos ribotos laiku, `SET LOCAL` transakcijoje, klientas grąžinamas", async () => {
  const sekiklis = {};
  await nustatytiReikalingusTipus(pool({ "FROM job_results": ["s3"] }, sekiklis), { timeoutMs: 750 });

  assert.equal(sekiklis.paimta, sekiklis.grazinta, "klientas privalo grįžti į pool'ą");
  assert.equal(sekiklis.paimta, 1, "vieno stebėjimo užtenka vieno kliento");
  assert.ok(sekiklis.sakiniai.includes("BEGIN"), "riba privalo gyventi transakcijoje");
  assert.ok(
    sekiklis.sakiniai.some((s) => s.includes("SET LOCAL statement_timeout = 750")),
    `SET LOCAL nerastas: ${sekiklis.sakiniai.join(" | ")}`
  );
  /** `SET`, ne `SET LOCAL`, liktų ant pooled kliento ir galiotų kitam kvietėjui. */
  assert.ok(
    !sekiklis.sakiniai.some((s) => /^SET statement_timeout/.test(s)),
    "besąlyginis `SET` nutekėtų į kitą kvietėją"
  );
});

test("netinkama riba nepaverčia stebėtojo amžinu `nezinoma`", async () => {
  const sekiklis = {};
  const saltiniai = await nustatytiReikalingusTipus(
    pool({ "FROM job_results": ["fs"] }, sekiklis),
    { timeoutMs: Number.NaN }
  );

  /** Netinkama reikšmė duotų netinkamą SQL, o tas kristų kaip stebėjimo gedimas. */
  assert.deepEqual(saltiniai.rezultatai, ["fs"]);
  assert.ok(
    sekiklis.sakiniai.some((s) => s.includes("SET LOCAL statement_timeout = 2000")),
    `riba privalo grįžti į numatytąją: ${sekiklis.sakiniai.join(" | ")}`
  );
});

test("klaidos kelias irgi grąžina klientą ir atsuka transakciją", async () => {
  const sekiklis = {};
  await assert.rejects(
    () => nustatytiReikalingusTipus(pool({ "FROM job_results": klaida("57014") }, sekiklis)),
    /dublis/
  );
  assert.equal(sekiklis.paimta, sekiklis.grazinta, "klientas privalo grįžti ir po klaidos");
  assert.ok(sekiklis.sakiniai.includes("ROLLBACK"), "nutrūkusi transakcija privalo būti atsukta");
});

test("`42P01` (senesnė schema) — tuščia aibė, ne gedimas", async () => {
  const saltiniai = await nustatytiReikalingusTipus(
    pool({ "FROM job_results": ["s3"], "FROM job_result_attempts": klaida("42P01") })
  );
  assert.deepEqual(saltiniai, { rezultatai: ["s3"], bandymai: [] });
});

test("bet kokia kita klaida keliauja toliau — ji virsta `nezinoma`, ne tyliu žaliu", async () => {
  await assert.rejects(
    () => nustatytiReikalingusTipus(pool({ "FROM job_results": klaida("57P01") })),
    /dublis/
  );

  const v = await nustatytiPrijungimoBusena(
    pool({ "FROM job_results": klaida("57P01") }),
    store({ rasymoBackend: "fs", registruotiTipai: ["fs"] }),
    { env: { ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: "/tmp/x" } }
  );
  assert.equal(v.nezinoma, true);
  assert.equal(v.ok, true);
});

test("rezolverio be `saugykluBusena` (memory/Redis) verdiktas neužlūžta", async () => {
  const v = await nustatytiPrijungimoBusena(pool({}), {}, { env: {} });
  assert.equal(v.rasymoBackend, null);
  assert.equal(v.parinktas, "inline");
  assert.equal(v.ok, true);
});

/**
 * ⚠️ SANITIZACIJOS SARGAS (#319 pamoka, pritaikyta prieš įvykį).
 *
 * `REDIS_URL` atveju kredencialas į diagnostiką pateko todėl, kad priežastis buvo
 * formuojama iš konfigūracijos EILUTĖS. Čia verdiktas nešti reikšmių neturi iš viso,
 * bet komentaras to negina — gina šis testas: jis paduoda realias paslaptis per
 * `env` ir reikalauja, kad nė viena neatsirastų nė viename verdikto lauke.
 *
 * Tikrinamos ABI šakos: sėkmingas parinkimas ir KRITĘS parinkimas — antrasis
 * pavojingesnis, nes ten pranešimą formuoja `ArtifactStoreError`, ne šis modulis.
 */
const PASLAPTYS = {
  ARTIFACT_S3_BUCKET: "slaptas-kibiras",
  ARTIFACT_S3_REGION: "eu-north-1",
  ARTIFACT_S3_ACCESS_KEY: "AKIAIOSFODNN7SLAPTAS",
  ARTIFACT_S3_SECRET_KEY: "wJalrXUtnFEMI-K7MDENG-bPxRfiCYSLAPTAS",
  ARTIFACT_S3_ENDPOINT: "https://minio.vidinis.lan:9000",
  ARTIFACT_FS_ROOT: "/srv/slapta/artefaktai",
};

for (const [pavadinimas, env] of [
  ["galiojanti konfigūracija", { ARTIFACT_STORE_BACKEND: "s3", ...PASLAPTYS }],
  [
    "krites parinkimas (trūksta rakto)",
    { ARTIFACT_STORE_BACKEND: "s3", ...PASLAPTYS, ARTIFACT_S3_SECRET_KEY: "" },
  ],
]) {
  test(`verdikte nėra nė vienos konfigūracijos reikšmės — ${pavadinimas}`, async () => {
    const v = await nustatytiPrijungimoBusena(
      pool({ "FROM job_results": ["s3"] }),
      store({ rasymoBackend: "fs", registruotiTipai: ["fs"] }),
      { env }
    );

    const tekstas = JSON.stringify(v);
    for (const [raktas, reiksme] of Object.entries(PASLAPTYS)) {
      if (!reiksme || !env[raktas]) continue;
      assert.equal(
        tekstas.includes(reiksme),
        false,
        `verdikte rasta '${raktas}' reikšmė — diagnostika tapo nutekėjimo keliu (#319)`
      );
    }

    /** Vardai leistini ir būtini: be jų verdiktas nieko nepasako. */
    assert.match(tekstas, /s3|fs|inline/);
  });
}
