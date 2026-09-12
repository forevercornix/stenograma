const { test } = require("node:test");
const assert = require("node:assert/strict");

/**
 * INFORMACINĖ EILUTĖ: POSTGRESQL SUKONFIGŪRUOTAS, JOB'AI ATMINTYJE (#155).
 *
 * ⚠️ RAŠOMA PRIEŠ BARJERĄ, NE PO JO.
 *
 * Ta pati priežastis kaip #157 PR-7 pradžioje: stebėtojas rašomas prieš stebimą
 * dalyką, kitaip pirmas commit'as yra tas, kurio niekas netikrina. Po eksplicitinio
 * pasirinkimo įvedimo ši būsena taps DAŽNA — kiekvienas diegimas, nustatęs
 * `DATABASE_URL` sesijoms ar auditui, ją pamatys.
 *
 * ⚠️ TIKRINAMAS IR NEBUVIMAS, NE TIK BUVIMAS. Eilutė, atsirandanti visada, būtų
 * triukšmas; eilutė, neatsirandanti niekada, būtų negyvas kodas. Abi ribos turi
 * savo atvejį.
 */

function suAplinka(papildoma, veiksmas) {
  const raktai = ["DATABASE_URL", "PGHOST", "JOB_STORE_BACKEND", "REDIS_URL"];
  const buve = Object.fromEntries(raktai.map((r) => [r, process.env[r]]));
  for (const r of raktai) delete process.env[r];
  for (const [r, v] of Object.entries(papildoma)) process.env[r] = v;

  try {
    return veiksmas();
  } finally {
    for (const [r, v] of Object.entries(buve)) {
      if (v === undefined) delete process.env[r];
      else process.env[r] = v;
    }
  }
}

/** `runSelfChecks()` su švariu moduliu — kitaip `jobStore` liktų iš ankstesnio testo. */
async function patikros(env) {
  for (const k of [require.resolve("../utils/startupChecks"), require.resolve("../utils/jobStore")]) {
    delete require.cache[k];
  }
  const { runSelfChecks } = require("../utils/startupChecks");
  return runSelfChecks(env);
}

const rastiEilute = (checks) => checks.find((c) => c.name === "Job metaduomenų saugykla");

test("`DATABASE_URL` + job'ai atmintyje — informacinė eilutė YRA", async () => {
  const checks = await suAplinka({ DATABASE_URL: "postgres://x/y" }, () =>
    patikros({ DATABASE_URL: "postgres://x/y" })
  );
  const eilute = rastiEilute(checks);

  assert.ok(eilute, "eilutė privalo atsirasti — kitaip operatorius sužinotų tik po restarto");
  assert.equal(eilute.ok, true, "tai NE gedimas: procesas daro tai, ko konfigūracija prašo");
  assert.match(eilute.detail, /JOB_STORE_BACKEND=postgres/, "privalo pasakyti, KĄ nustatyti");
});

/**
 * ⚠️ SANITIZACIJA — TIKRINA TESTAS, NE KOMENTARAS (#319 pamoka).
 *
 * `REDIS_URL` atveju kredencialas į `doctor` išvestį pateko todėl, kad priežastis
 * buvo formuojama iš konfigūracijos EILUTĖS. Čia paduodamas DSN su slaptažodžiu, ir
 * reikalaujama, kad nė viena jo dalis neatsirastų.
 */
test("eilutėje NĖRA DSN, host'o ar kredencialų", async () => {
  const dsn = "postgres://vartotojas:slaptazodis@vidinis.lan:5432/stenograma";
  const checks = await suAplinka({ DATABASE_URL: dsn }, () => patikros({ DATABASE_URL: dsn }));
  const tekstas = JSON.stringify(rastiEilute(checks));

  for (const dalis of ["slaptazodis", "vartotojas", "vidinis.lan", "5432", dsn]) {
    assert.equal(tekstas.includes(dalis), false, `eilutėje rasta: ${dalis}`);
  }
});

test("be `DATABASE_URL` eilutės NĖRA — ji būtų triukšmas", async () => {
  const checks = await suAplinka({}, () => patikros({}));
  assert.equal(rastiEilute(checks), undefined);
});

/**
 * ⚠️ KONTROLĖ: `PGHOST` yra ta pati sąlyga kita forma.
 *
 * `arNurodytaPostgres()` priima abu; testas, tikrinęs tik `DATABASE_URL`, praleistų
 * diegimą, kuris naudoja `PG*` kintamuosius — o tokių repo turi (7.4e pastaba).
 */
test("KONTROLĖ: `PGHOST` duoda tą pačią eilutę", async () => {
  const checks = await suAplinka({ PGHOST: "db.vidinis" }, () => patikros({ PGHOST: "db.vidinis" }));
  assert.ok(rastiEilute(checks), "`PGHOST` yra ta pati sąlyga, tik kita forma");
});
