const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * MIGRACIJOS CLI BAIGTYS (#417, D2).
 *
 * ⚠️ KETURIOS BAIGTYS — KETURI KODAI. Iki #417 nutraukta partija patekdavo į `2`, t. y.
 * susiliedavo su „procedūros klaida" (blogas `ARTIFACT_STORE_BACKEND`, nepasiekiama DB).
 * Operatoriui tai skirtingos situacijos: `2` reiškia „net neprasidėjo", `4` — „dalis
 * eilučių JAU perkelta, likusios nepaliestos".
 *
 * ⚠️ TIKRINAMA SUBPROCESU, NE FUNKCIJA. Klausimas yra apie `stdout`/`stderr`
 * atskyrimą ir `process.exitCode` — to funkcijos kvietimas neparodo. `stdout` privalo
 * likti VALIDUS JSON: automatika juo remiasi, ir suvestinė, nukreipta į `stderr`,
 * sulaužytų `pipe`.
 *
 * ⚠️ DB NEREIKIA. CLI daro `import pg from "pg"` (`:35`), tad `NODE_PATH` nepadeda —
 * ESM specifikatorių išrišimas randa `backend/node_modules/pg` anksčiau. Todėl
 * naudojamas `module.register()` krautuvas, nukreipiantis specifikatorių `pg` į dublį.
 * Taip testas lieka `functional` rinkinyje ir neliečia repo `node_modules`.
 */

const SAKNIS = path.resolve(__dirname, "..");

/**
 * Paleidžia CLI su netikru `pg`, kurio N-oji `payload` užklausa sprogsta.
 *
 * @param {number|0} sprogstaTies `0` — nesprogsta; kitaip tos eilės užklausa meta.
 */
function paleistiCli({ eiluciu, sprogstaTies, atrankaSprogsta = false, casNepavyksta = false }) {
  const saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-cli-"));
  const pgDir = path.join(saknis, "pg");
  fs.mkdirSync(pgDir, { recursive: true });

  fs.writeFileSync(
    path.join(pgDir, "index.mjs"),
    `
    const EILUCIU = ${eiluciu};
    const SPROGSTA = ${sprogstaTies};
    const ATRANKA_SPROGSTA = ${atrankaSprogsta};
    const CAS_NEPAVYKSTA = ${casNepavyksta};
    let payloadKvietimu = 0;

    const kandidatai = Array.from({ length: EILUCIU }, (_, i) => ({ job_id: "job-" + (i + 1) }));

    function atsakymas(sql) {
      if (/FROM job_results r/.test(sql)) {
        if (ATRANKA_SPROGSTA) throw new Error("kandidatų atranka krito");
        return { rows: kandidatai, rowCount: kandidatai.length };
      }
      /** CAS perjungimas: \`rowCount !== 1\` duoda domeninį \`EILUTE_PASIKEITE\`. */
      if (CAS_NEPAVYKSTA && /UPDATE job_results/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT\\s+payload/.test(sql)) {
        payloadKvietimu += 1;
        if (payloadKvietimu === SPROGSTA) throw new Error("ryšys nutrūko");
        return { rows: [{ payload: { text: "x" + payloadKvietimu } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }

    class Pool {
      async query(sql) { return atsakymas(String(sql)); }
      async connect() {
        return {
          async query(sql) { return atsakymas(String(sql)); },
          release() {},
        };
      }
      async end() {}
    }

    export default { Pool, Client: Pool };
    export { Pool, Pool as Client };
    `
  );

  const saugyklaSaknis = path.join(saknis, "artefaktai");
  fs.mkdirSync(saugyklaSaknis, { recursive: true });

  /** Krautuvas: `pg` → dublis. Registruojamas per `--import`, tad veikia ESM kelyje. */
  const dublioUrl = "file://" + path.join(pgDir, "index.mjs").replace(/\\/g, "/");
  fs.writeFileSync(
    path.join(saknis, "krautuvas.mjs"),
    `export async function resolve(specifier, context, next) {
       if (specifier === "pg") return { url: ${JSON.stringify(dublioUrl)}, shortCircuit: true };
       return next(specifier, context);
     }`
  );
  fs.writeFileSync(
    path.join(saknis, "registruoti.mjs"),
    `import { register } from "node:module";
     register(${JSON.stringify("file://" + path.join(saknis, "krautuvas.mjs").replace(/\\/g, "/"))});`
  );

  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "file://" + path.join(saknis, "registruoti.mjs").replace(/\\/g, "/"),
      path.join(SAKNIS, "scripts", "migrate-artifacts.mjs"),
      "run",
    ],
    {
      cwd: SAKNIS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: "postgres://zondas@localhost:5432/zondas",
        ARTIFACT_STORE_BACKEND: "fs",
        ARTIFACT_FS_ROOT: saugyklaSaknis,
      },
    }
  );

  fs.rmSync(saknis, { recursive: true, force: true });
  return { kodas: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

test("#417 CLI: nutraukta partija - kodas 4, DALINĖ suvestinė į `stdout`", () => {
  const r = paleistiCli({ eiluciu: 5, sprogstaTies: 3 });

  assert.equal(r.kodas, 4, `laukta 4, gauta ${r.kodas}. stderr: ${r.stderr.slice(0, 300)}`);

  /** ⚠️ VALIDUS JSON — be šito `pipe` sulūžtų. */
  const suvestine = JSON.parse(r.stdout);
  assert.equal(suvestine.nutraukta, true);
  assert.equal(suvestine.apdorota, 2, "perkelta k-1 eilučių");
  assert.equal(suvestine.kandidatai, 5);
  assert.match(suvestine.nutraukimoPriezastis, /ryšys nutrūko/);

  assert.notEqual(r.stderr.trim(), "", "klaidos pranešimas privalo eiti į `stderr`");
  assert.match(r.stderr, /nutraukta/i);
});

/**
 * ⚠️ M4 TAIKINYS: suvienodinus nutraukimo ir domeninio gedimo kodą, operatorius
 * nebeskirtų „dalis liko nepaliesta" nuo „visos apdorotos, kai kurios nepavyko".
 */
test("#417 CLI: sėkminga partija - kodas 0, jokio `stderr` triukšmo", () => {
  const r = paleistiCli({ eiluciu: 2, sprogstaTies: 0 });

  assert.equal(r.kodas, 0, `laukta 0, gauta ${r.kodas}. stderr: ${r.stderr.slice(0, 300)}`);

  const suvestine = JSON.parse(r.stdout);
  assert.equal(suvestine.nutraukta, false);
  assert.equal(suvestine.nutraukimoPriezastis, null);
  assert.equal(suvestine.apdorota, 2);
});


/**
 * ⚠️ KETURIOS BAIGTYS — KETURI TESTAI. Iki šio papildymo failas dengė tik `4` ir `0`, o
 * matricos eilutė tvirtino visą schemą: `2` ir `3` keliai egzistavo (`:164`, `:234`), bet
 * jų niekas nevykdė, tad nutraukimo kodą suvienodinus su bet kuriuo jų NIEKAS nebūtų
 * kritę. Tai tos pačios klasės per didelis teiginys, kurį #417 ir taiso.
 */
test("#417 CLI: partija NET NEPRASIDĖJO - kodas 2, jokios suvestinės", () => {
  const r = paleistiCli({ eiluciu: 3, sprogstaTies: 0, atrankaSprogsta: true });

  assert.equal(r.kodas, 2, `laukta 2, gauta ${r.kodas}. stderr: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.stdout.trim(), "", "suvestinės NĖRA - partija neprasidėjo, nėra ko atsiskaityti");
  assert.match(r.stderr, /kandidatų atranka krito/);
});

/**
 * ⚠️ `3` REIŠKIA PRIEŠINGĄ DALYKĄ NEI `4`: visos kandidatės apdorotos, bet kai kurios
 * nepavyko domeniškai. Čia CAS perjungimas grąžina `rowCount 0` → `EILUTE_PASIKEITE`.
 */
test("#417 CLI: visos apdorotos, dalis nepavyko domeniškai - kodas 3", () => {
  const r = paleistiCli({ eiluciu: 2, sprogstaTies: 0, casNepavyksta: true });

  assert.equal(r.kodas, 3, `laukta 3, gauta ${r.kodas}. stderr: ${r.stderr.slice(0, 300)}`);

  const suvestine = JSON.parse(r.stdout);
  assert.equal(suvestine.nutraukta, false, "domeninė nesėkmė NĖRA nutraukimas");
  assert.equal(suvestine.apdorota, 2, "VISOS kandidatės apdorotos - tuo `3` skiriasi nuo `4`");
  assert.ok(Object.values(suvestine.nepavyko).reduce((a, b) => a + b, 0) > 0);
});
