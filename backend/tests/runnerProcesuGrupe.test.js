const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * RUNNER'IS NUŽUDO VISĄ PROCESŲ GRUPĘ, NE TIK SUPERVISOR'IŲ (#380 P1).
 *
 * ⚠️ KĄ TAI TAISO. `spawnSync` `timeout` siunčia signalą TIK tiesioginiam vaikui.
 * `node --test` savo ruožtu leidžia subprocesus (`pg_dump`, `npx node-pg-migrate`,
 * `node -e`), ir jie lieka gyvi laikydami jungtis bei pipe'us. Nužudžius tik
 * supervisor'ių, runner'is grįžta, o našlaičiai toliau sukasi — ir kitas failas
 * susiduria su jų užrakiais.
 *
 * ⚠️ BE DB. Tikrinama proceso medžio semantika, ne SQL.
 */

const SAKNIS = path.resolve(__dirname, "..");

/**
 * ⚠️ „GYVAS" TIKRINAMAS PER `/proc/<pid>/status`, NE `kill -0`.
 *
 * Konteineryje `kill(pid, 0)` ZOMBĮ (`State: Z`) rodo GYVU: PID dar užimtas, kol tėvas
 * jo nesurinko. Testas, remiantis `kill -0`, tada kristų net ir teisingai nužudžius
 * grupę — arba, dar blogiau, praeitų dėl netinkamos priežasties.
 */
function busena(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^State:\s+(\w)/m.exec(t);
    return m ? m[1] : "?";
  } catch {
    return null; // nebėra įrašo — procesas surinktas
  }
}

function gyvas(pid) {
  const b = busena(pid);
  return b !== null && b !== "Z";
}

/**
 * ⚠️ TRUMPAS NUSISTOVĖJIMO LANGAS, KAD MATUOTUME „NEMIRĖ", O NE „DAR NESPĖJO".
 *
 * `SIGKILL` pristatomas asinchroniškai: tarp `process.kill()` ir įrašo dingimo
 * `/proc` praeina planuotojo kvantas. Be lango testas kartais kristų dėl lenktynių,
 * ir tokį kritimą būtų neįmanoma atskirti nuo tikro našlaičio.
 *
 * Langas trumpas sąmoningai: `sleep 600` per dvi sekundes nemirs pats.
 */
function palauktiKolMirs(pid, ms = 2000) {
  const iki = Date.now() + ms;
  while (Date.now() < iki && gyvas(pid)) {
    try {
      spawnSync("sleep", ["0.05"]);
    } catch {
      break;
    }
  }
  return gyvas(pid);
}

test(
  "#380 P1: nutraukus failą NELIEKA nei supervisor'iaus, nei jo subproceso",
  { timeout: 180000 },
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-grupe-"));
    const pidFailas = path.join(tmp, "pids.json");
    const testas = path.join(SAKNIS, "tests", "zzGrupesKabo.test.js");

    /**
     * Kabantis failas: laikmatis laiko event loop'ą, `await` niekada neišsisprendžia, o
     * `sleep` yra ANŪKAS — tiksliai ta klasė, kurios `spawnSync` timeout nepasiekia.
     */
    fs.writeFileSync(
      testas,
      /**
       * ⚠️ ĮTERPTAME ŠABLONE `test(` NERAŠOMAS EILUTĖS PRADŽIOJE. `deletedTestsGuard`
       * skaičiuoja testus dviem nepriklausomais būdais (lekseriu ir eilutiniu šablonu)
       * ir reikalauja, kad skaičiai sutaptų; literalas viduje eilutiniam skaitikliui
       * atrodo kaip antras testas. Naudojamas `bandymas(` vardas — sargas lieka
       * nepaliestas, o šablonas veikia identiškai.
       */
      `const bandymas = require("node:test");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
bandymas("KABA su subprocesu", async () => {
  const vaikas = spawn("sleep", ["600"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(pidFailas)}, JSON.stringify({ supervisor: process.pid, anukas: vaikas.pid }));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`,
      "utf8"
    );

    t.after(() => {
      fs.rmSync(testas, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    /**
     * ⚠️ RIBA PAIMAMA IŠ APLINKOS, NE KEIČIAMA PRODUKCINĖ KONSTANTA. Runner'is ją skaito
     * `FAILO_RIBA_MS` reikšme; testui reikia sekundžių, ne dviejų minučių.
     */
    const r = spawnSync(
      "node",
      [path.join(SAKNIS, "scripts", "run-tests.mjs"), "--failas", testas, `--tap-dir=${tmp}`],
      { cwd: SAKNIS, encoding: "utf8", env: { ...process.env, TESTU_FAILO_RIBA_MS: "6000" } }
    );

    assert.ok(fs.existsSync(pidFailas), `vaikas privalėjo įrašyti PID'us; runner'io išvestis: ${r.stdout}`);
    const { supervisor, anukas } = JSON.parse(fs.readFileSync(pidFailas, "utf8"));

    assert.match(r.stdout, /FILE_TIMEOUT/, "nutrauktas failas privalo gauti `FILE_TIMEOUT` žymą");
    assert.notEqual(r.status, 0, "nutrauktas failas privalo duoti nenulinį exit kodą");

    /**
     * ⚠️ TIKRINAMA PO RUNNER'IO GRĮŽIMO. Jei grupė nužudyta, abu procesai jau mirę arba
     * surinkti; jei nužudytas tik supervisor'ius, `sleep` tebesisuka dar 600 s.
     */
    const anukasGyvas = palauktiKolMirs(anukas);
    const supervisorGyvas = palauktiKolMirs(supervisor);

    /**
     * ⚠️ ANŪKAS TIKRINAMAS PIRMAS. Būtent jis skiria „nužudyta grupė" nuo „nužudytas
     * supervisor'ius": pastarasis miršta abiem atvejais, o `sleep 600` — tik pirmuoju.
     */
    assert.equal(
      anukasGyvas,
      false,
      `ANŪKAS ${anukas} tebegyvas (${busena(anukas)}) — nužudytas tik supervisor'ius?`
    );
    assert.equal(
      supervisorGyvas,
      false,
      `supervisor'ius ${supervisor} tebegyvas (${busena(supervisor)})`
    );
  }
);

test(
  "#380 P1: per didelė išvestis duoda `FILE_OVERFLOW`, ne `FILE_TIMEOUT`",
  { timeout: 180000 },
  (t) => {
    /**
     * ⚠️ DU GEDIMAI, KURIE ATRODO VIENODAI IŠ IŠORĖS. Abu nutraukia procesą ir palieka
     * dalinę išvestį, bet reiškia PRIEŠINGUS dalykus: `FILE_TIMEOUT` — failas nustojo
     * išvesti, `FILE_OVERFLOW` — išvedė per daug. Sulieti juos reikštų siųsti operatorių
     * taisyti ne to: vienu atveju ieškoma pakibusios jungties, kitu — triukšmingo testo.
     *
     * ⚠️ BUFERIO RIBA IMAMA IŠ APLINKOS, NE KEIČIANT KONSTANTĄ. Testas, realiai
     * išvedantis >64 MiB, kainuotų minutes kiekviename CI paleidime ir matuotų `spawn`
     * srautų greitį, ne klasifikaciją. `TESTU_FAILO_BUFERIS` CI nenustatomas.
     */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-ovf-"));
    const testas = path.join(SAKNIS, "tests", "zzSrautoPerpilda.test.js");

    fs.writeFileSync(
      testas,
      `const bandymas = require("node:test");
bandymas("KONTROLĖ: trumpas testas praeina PRIEŠ perpildą", () => {});
bandymas("SPAUSDINA daugiau nei buferis", () => {
  for (let i = 0; i < 400; i += 1) process.stdout.write("# " + "x".repeat(500) + "\\n");
});
`,
      "utf8"
    );

    t.after(() => {
      fs.rmSync(testas, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const r = spawnSync(
      "node",
      [path.join(SAKNIS, "scripts", "run-tests.mjs"), "--failas", testas, `--tap-dir=${tmp}`],
      { cwd: SAKNIS, encoding: "utf8", env: { ...process.env, TESTU_FAILO_BUFERIS: "8192" } }
    );

    assert.match(r.stdout, /FILE_OVERFLOW/, "per didelė išvestis privalo duoti `FILE_OVERFLOW`");
    assert.doesNotMatch(
      r.stdout,
      /FILE_TIMEOUT/,
      "perpilda NĖRA laiko riba — sulieti kodai siųstų taisyti ne to"
    );
    assert.match(r.stdout, /buferis_baitais: 8192/, "žyma privalo skelbti TAIKYTĄ ribą");
    assert.match(r.stdout, /FILE_OVERFLOW zzSrautoPerpilda/, "žyma privalo įvardyti FAILĄ");
    assert.notEqual(r.status, 0, "perpildytas failas privalo duoti nenulinį exit kodą");

    /**
     * ⚠️ DALINĖ IŠVESTIS IŠSAUGOMA — TAI IR YRA DIAGNOSTIKA.
     *
     * Tvirtinama TAP antraštė ir kaupto turinio kiekis, o NE konkreti `ok 1` eilutė:
     * `process.stdout.write` iš testo kūno rašo tiesiai į srautą ir aplenkia reporterio
     * buferį, tad triukšmas išvestyje atsiduria PIRMIAU nei ankstesnio testo `ok`.
     * Pirmoji redakcija to nežinojo ir krito — prielaida apie eiliškumą buvo neteisinga.
     */
    const tap = fs.readFileSync(path.join(tmp, "zzSrautoPerpilda.tap"), "utf8");
    assert.match(tap, /TAP version 13/, "dalinė išvestis privalo prasidėti TAP antrašte");
    assert.ok(tap.length > 4000, `dalinė išvestis per trumpa (${tap.length} B) — ar ji apskritai išsaugota?`);
    assert.match(tap, /FILE_OVERFLOW zzSrautoPerpilda/, "žyma privalo būti prikabinta prie dalinės išvesties");
  }
);
