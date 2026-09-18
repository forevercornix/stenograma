const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const SKRIPTAS = path.join(__dirname, "..", "scripts", "cutover-terminalize.mjs");

/**
 * CUTOVER SKRIPTO RIBOS (#155, A2) — BE REDIS.
 *
 * ⚠️ KODĖL ŠIS FAILAS APSKRITAI EGZISTUOJA.
 *
 * Skriptas buvo parašytas uždaryti klasę „dokumentuota komanda, kurios niekas
 * negali paleisti" — ir pats atsirado BE TESTO. CI logas tai parodė tiesiai:
 * `cutover-terminalize` jame nepasirodė nė karto. Tai tas pats defektas siauresne
 * forma, tad uždaromas kartu.
 *
 * ⚠️ TIKRINAMOS TIK RIBOS, NE DARBAS. Terminalizavimas reikalauja Redis ir eilės;
 * tai atskiras klausimas. Čia tikrinama tai, kas SAUGO nuo neteisingo paleidimo —
 * ir būtent tai vykdoma dažniausiai: skriptas, paleistas ne ten arba ne taip.
 */

function paleisti(argumentai, env = {}) {
  try {
    const isvestis = execFileSync(process.execPath, [SKRIPTAS, ...argumentai], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "error", REDIS_URL: "", ...env },
    });
    return { kodas: 0, isvestis };
  } catch (klaida) {
    return { kodas: klaida.status, isvestis: `${klaida.stdout || ""}${klaida.stderr || ""}` };
  }
}

/**
 * ⚠️ SVARBIAUSIA RIBA: RAŠYBOS KLAIDA NEGALI TYLIAI DUOTI SAUSO PALEIDIMO.
 *
 * `--vykdyty` be šios patikros būtų priimtas kaip „jokių vėliavų", skriptas
 * atspausdintų sausą ataskaitą ir grįžtų `0`, o operatorius manytų atlikęs
 * žingsnį. Tada 5b ištrintų hash'us job'ams, kurie taip ir liko `queued`.
 */
test("rašybos klaida vėliavoje ATMETAMA, ne traktuojama kaip sausas paleidimas", () => {
  const r = paleisti(["--vykdyty"]);
  assert.equal(r.kodas, 1, `laukta naudojimo klaidos, gauta ${r.kodas}: ${r.isvestis}`);
  assert.match(r.isvestis, /Nežinomi argumentai/);
});

test("nežinomas argumentas ATMETAMAS", () => {
  assert.equal(paleisti(["--force"]).kodas, 1);
});

/**
 * ⚠️ NE-REDIS BACKEND'AS — ATSISAKYMAS, NE ĮSPĖJIMAS.
 *
 * Paleistas prieš PostgreSQL ar atmintį, skriptas terminalizuotų job'us saugykloje,
 * kurios niekas nemigruoja — destruktyvus veiksmas ne toje vietoje.
 */
test("ne `redis` backend'as — atsisakoma dirbti (exit 2)", () => {
  const r = paleisti([], { REDIS_URL: "" });
  assert.equal(r.kodas, 2, r.isvestis);
  assert.match(r.isvestis, /PRIELAIDOS NETENKINAMOS/);
  assert.match(r.isvestis, /ne 'redis'/);
});

/**
 * ⚠️ IR ATSISAKOMA PRIEŠ JUNGTĮ, NE PO JOS.
 *
 * Eilės skaitikliai reikalauja Redis jungties. Patikra, kuri tam, kad atsisakytų,
 * pirma prisijungia, ne-Redis diegime arba kristų su `ECONNREFUSED`, arba — blogiau —
 * pakiltų prie SVETIMOS instancijos. Tikrinama, kad išvestyje NĖRA jungties klaidos.
 */
test("atsisakymas įvyksta PRIEŠ jungtį — jokio `ECONNREFUSED`", () => {
  const r = paleisti([], { REDIS_URL: "" });
  assert.equal(r.kodas, 2);
  assert.doesNotMatch(
    r.isvestis,
    /ECONNREFUSED|ENOTFOUND/,
    "skriptas bandė jungtis prieš patikrindamas backend'ą"
  );
});
