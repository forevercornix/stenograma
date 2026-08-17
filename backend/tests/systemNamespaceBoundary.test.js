const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * #159: PRIVILEGIJUOTO NAMESPACE'O RIBA.
 *
 * `jobStore.system.*` apeina nuosavybės filtrą. Tai teisinga fono keliams
 * (`workers/`, `queues/`, valymas, retencija), kurie VYKDO darbą ir neturi
 * owner konteksto. Bet maršrutų ir servisų sluoksnyje tas pats namespace'as
 * būtų patogus privilege escalation kelias: vienas `jobStore.system.get(id)`
 * grąžintų svetimą įrašą be jokio signalo.
 *
 * KODĖL SARGAS, O NE KONVENCIJA. Konvencija be patikros išsitrina per pirmą
 * skubų PR, o klaida būtų tyli - nė vienas testas nekristų, nes funkcionalumas
 * veiktų. Kristų tik nuosavybės garantija.
 *
 * SARGAS DENGIA VISĄ `jobStore.system`, ne tik `list*`. Būtent
 * `system.get/update/remove` yra tie metodai, kuriais nuosavybę apeiti
 * lengviausia: `list*` grąžina sąrašus, o `system.get(jobId)` duoda tiesioginę
 * prieigą prie konkretaus svetimo įrašo.
 *
 * TIKSLI GARANTIJA (ne stipresnė, nei realiai turima):
 *
 *   `routes/`   – išimčių NĖRA. Užklausą aptarnaujantis kodas niekada
 *                 nenaudoja privilegijuoto namespace'o.
 *   `services/` – leidžiama TIK eksplicitiškai allowlist'intiems operational
 *                 servisams (žr. `IŠIMTYS`).
 *
 * Anksčiau čia buvo parašyta „be išimčių", nors `backupService` privilegijuotą
 * namespace'ą naudoja teisėtai. Dokumentuoti stipresnę garantiją nei turima
 * yra blogiau nei jos neturėti: peržiūrėtojas pasitiki tekstu, ne kodu.
 */

const ROOT = path.resolve(__dirname, "..");
const DRAUDŽIAMI_KATALOGAI = ["routes", "services"];

/**
 * IŠIMTYS leidžiamos TIK operational servisams ir turi būti eksplicitiškai
 * įrašytos šiame sąraše su pagrindimu.
 *
 * `routes/` išimčių NETURI ir negali turėti (žr. atskirą testą žemiau): jei
 * maršrutui prireikia globalaus matymo, logika keliama į servisą, o ne
 * pridedama išimtis. Viena išimtis be pagrindimo greitai tampa dviem.
 */
const IŠIMTYS = new Set([
  /**
   * Atsarginė kopija yra OPERACINĖ funkcija, ne vartotojo užklausa.
   *
   * `createBackup()` ir `countActiveJobs()` privalo matyti VISŲ savininkų
   * job'us – kopija, apimanti tik vieno vartotojo įrašus, būtų netinkama
   * atkūrimui. Nuosavybės filtras čia ne apsaugotų, o sugadintų funkciją.
   *
   * Prieiga prie paties `/api/backup` maršruto ribojama rolėmis
   * (`middleware/authorize.js`) – privilegija suteikiama transporto lygyje,
   * ne apeinant duomenų sluoksnį.
   */
  "services/backupService.js",

  /**
   * Administracinis override (#160).
   *
   * Šis servisas EGZISTUOJA būtent tam, kad privilegija būtų sutelkta vienoje
   * siauroje vietoje, o ne išsibarstytų po maršrutus. Alternatyva – leisti
   * `jobStore.system` `routes/` sluoksnyje – panaikintų patį sargą.
   *
   * Servisas pats pakartotinai tikrina session-admin invariantą
   * (`assertSessionAdmin`) ir audituoja kiekvieną panaudojimą, įskaitant
   * nesėkmingus bandymus.
   */
  "services/adminJobService.js",
]);

function jsFiles(dir) {
  const out = [];
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

test("#159 SARGAS: routes/ ir services/ nenaudoja jobStore.system", () => {
  const pažeidimai = [];

  for (const dir of DRAUDŽIAMI_KATALOGAI) {
    for (const rel of jsFiles(dir)) {
      if (IŠIMTYS.has(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/jobStore\s*\.\s*system\b/.test(line)) {
          pažeidimai.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    pažeidimai,
    [],
    "Privilegijuotas namespace'as maršrutų/servisų sluoksnyje apeitų nuosavybę:\n" +
      pažeidimai.join("\n")
  );
});

test("#159 SARGAS: pats sargas veikia (aptinka dirbtinį pažeidimą)", () => {
  /**
   * Sargas, kuris nieko neaptinka, gali būti sugedęs ir to niekas nepastebės.
   * Čia patikrinama pati aptikimo taisyklė.
   */
  const regex = /jobStore\s*\.\s*system\b/;

  assert.ok(regex.test("const j = await jobStore.system.get(id);"));
  assert.ok(regex.test("jobStore . system . listAll()"), "tarpai neturi apeiti sargo");
  assert.equal(regex.test("await jobStore.get({ jobId, ownerId });"), false);
  assert.equal(regex.test("// jobStoreSystem yra kitas dalykas"), false);
});

test("#159 SARGAS: routes/ neturi NĖ VIENOS išimties", () => {
  /**
   * Servisai gali būti allowlist'inti (operacinės funkcijos), maršrutai – ne.
   * Ši riba yra pati garantijos esmė: jei maršrutui prireikia globalaus
   * matymo, logika keliama į servisą, o ne pridedama išimtis.
   */
  for (const rel of IŠIMTYS) {
    assert.ok(!rel.startsWith("routes/"), `routes/ išimtys draudžiamos: ${rel}`);
  }
});

test("#160 SARGAS: maršrutai nesprendžia 403/404 patys", () => {
  /**
   * Politika turi gyventi VIENOJE vietoje (`utils/jobAccessPolicy.js` +
   * `jobAccessTransport.js`). Jei maršrutas pats vers `FORBIDDEN` į statusą,
   * politika išsiskirs, o skirtumas bus tyli spraga: vienas endpoint'as ims
   * grąžinti 403 ten, kur kitas grąžina 404, ir atsiras egzistavimo orakulas
   * per „lengvesnį" kelią.
   */
  const pažeidimai = [];

  for (const rel of jsFiles("routes")) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/jobStore\s*\.\s*FORBIDDEN/.test(line)) {
        pažeidimai.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    pažeidimai,
    [],
    "Maršrutai neturi tiesiogiai lyginti su jobStore.FORBIDDEN – " +
      "sprendimą priima decideJobAccess():\n" + pažeidimai.join("\n")
  );
});

test("#160 SARGAS: nuosavybės objektai nevadinami `apiKey*` (CodeQL FP prevencija)", () => {
  /**
   * TRETIEJI GRĖBLIAI.
   *
   * CodeQL `js/clear-text-logging` laiko `*Key*` identifikatorius jautriais ir
   * pažymi bet kokį jų kelią į logerį. Nuosavybės scope ir principalo objektai
   * jokios paslapties neturi (`{ ownerId, ownerKind, role }`), bet pavadinus
   * juos `apiKeyScope` (#159) ar `apiKeyAdmin` (#160) CI krito abu kartus.
   *
   * Sargas pigesnis nei kaskart atmetinėti įspėjimą – atmestas įspėjimas dar ir
   * nuslopintų TIKRĄ radinį tame pačiame kelyje. Bendro rakto principalas
   * vadinamas `sharedPrincipal*`.
   */
  /**
   * Tikrinami TIK principalo/scope objektai – t. y. priskyrimai, kurių dešinėje
   * yra `ownerKind`. `apiKeyRole` ar `apiKeyConfigured` yra teisėti vardai
   * (rolė, konfigūracijos vėliava) ir į logerį objektų neveda.
   */
  const pažeidimai = [];
  const šablonas = /\b(const|let|var)\s+(apiKey[A-Za-z]*)\s*=\s*\{[^}]*ownerKind/;

  for (const dir of ["tests", "utils", "services", "routes"]) {
    for (const rel of jsFiles(dir)) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      src.split("\n").forEach((line, i) => {
        const m = šablonas.exec(line);
        if (m) pažeidimai.push(`${rel}:${i + 1}: ${m[2]}`);
      });
    }
  }

  assert.deepEqual(
    pažeidimai,
    [],
    "Nuosavybės/principalo objektų nevadinkite `apiKey*` – naudokite " +
      "`sharedPrincipal*`:\n" + pažeidimai.join("\n")
  );
});

test("#159 SARGAS: kiekviena išimtis turi egzistuoti ir būti pagrįsta", () => {
  /**
   * Neegzistuojantis failas išimčių sąraše reiškia, kad sargas tyliai
   * susilpnėjo: failas pervadintas, o išimtis liko dengti nieko.
   */
  for (const rel of IŠIMTYS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `išimtis rodo į neegzistuojantį failą: ${rel}`);
  }
});
