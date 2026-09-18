const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { BUSENA, PRIEZASTIS, KANDIDATAI_SQL, PAYLOAD_SQL, migruoti } = require("../utils/artifactMigration");

process.env.NODE_ENV = "test";

/**
 * MIGRACIJOS KONTRAKTAS BE DB (#157, PR-6).
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS NUO `artifactMigration.integration`.
 *
 * Ta pati priežastis kaip `pgDumpBackupContract` ir `postRestoreReconcileContract`:
 * čia tikrinama tai, kam DB nereikia, ir tikrinama per sekundes. Klausimai, į
 * kuriuos atsako šis failas, yra apie SUTAPIMĄ tarp kodo ir migracijos — o toks
 * nesutapimas yra tylus: abi pusės startuoja, ir tik konkreti eilutė kada nors
 * krinta su `23514`.
 */

const MIGRACIJA = path.join(__dirname, "..", "migrations", "1756600000000_artifact-migration-progress.js");

/** Migracijos tekstas skaitomas, o ne importuojamas — ji yra istorijos įrašas. */
function migracijosSaltinis() {
  return fs.readFileSync(MIGRACIJA, "utf8");
}

/**
 * Išrenka užšaldytą masyvą iš migracijos APIBRĖŽTIES.
 *
 * ⚠️ IŠRENKAMA, NE IMPORTUOJAMA. Importas paverstų abi puses viena, ir testas
 * tikrintų, ar konstanta lygi pati sau. Būtent to nesutapimo, kurį šis testas
 * gina, tada nebūtų kaip padaryti — nei aptikti.
 */
function uzsaldytaAibe(vardas) {
  const saltinis = migracijosSaltinis();
  const m = saltinis.match(new RegExp(`const ${vardas} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `migracijoje nerasta \`${vardas}\` apibrėžtis`);

  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
}

test("PARITETAS: `BUSENA` aibė sutampa su migracijos `BUSENOS_FROZEN`", () => {
  /**
   * ⚠️ AIBĖ LYGINAMA, NE GREP'INAMA (ta pati #157 PR-4 pamoka su `committed`).
   *
   * Pašalinus reikšmę iš vienos pusės, žodis lieka komentare, tad `includes()`
   * praeitų. Lyginamos AIBĖS: ir trūkstama, ir perteklinė reikšmė yra defektai.
   */
  assert.deepEqual(Object.values(BUSENA).sort(), uzsaldytaAibe("BUSENOS_FROZEN"));
});

test("PARITETAS: `PRIEZASTIS` aibė sutampa su migracijos `PRIEZASTYS_FROZEN`", () => {
  assert.deepEqual(Object.values(PRIEZASTIS).sort(), uzsaldytaAibe("PRIEZASTYS_FROZEN"));
});

test("KONTROLĖ: išrinkimas tikrai kažką randa", () => {
  /**
   * Sugedęs `uzsaldytaAibe()` (pakeitus migracijos formatavimą) grąžintų tuščią
   * masyvą, ir abu ankstesni testai kristų — bet jei kristų ABI pusės vienodai,
   * jie praeitų tuščiai teisingi. Todėl netuštumas tvirtinamas atskirai.
   */
  assert.ok(uzsaldytaAibe("BUSENOS_FROZEN").length >= 2);
  assert.ok(uzsaldytaAibe("PRIEZASTYS_FROZEN").length >= 4);
  assert.ok(Object.values(BUSENA).length >= 2);
});

test("ATRANKA praleidžia `failed` tik tada, kai to prašoma", () => {
  /**
   * ⚠️ TIKRINAMAS SQL TEKSTAS, IR TAI SĄMONINGAS KOMPROMISAS.
   *
   * Elgesį įrodo `artifactMigration.integration`; čia tikrinama, kad sąlyga
   * apskritai NEDINGO — atrankos užklausa yra vieta, kur „idempotencija" gyvena,
   * ir jos praradimas neduotų nė vienos klaidos: migracija tiesiog kartotų tą
   * patį darbą kas paleidimą.
   */
  assert.match(KANDIDATAI_SQL, /storage_type = 'inline'/);
  assert.match(KANDIDATAI_SQL, /payload IS NOT NULL/);
  assert.match(KANDIDATAI_SQL, /artifact_migration_progress/);
  assert.match(KANDIDATAI_SQL, /busena = 'failed'/);
});

test("ATRANKA NETRAUKIA `payload` — riba baitinė, ne eilučių", () => {
  /**
   * ⚠️ EILUČIŲ RIBA MATUOJA NE TĄ DYDĮ.
   *
   * `LIMIT 1000` su leidžiamu 20 MiB rezultatu reiškia iki ~20 GiB `payload`
   * atmintyje dar PRIEŠ pirmos eilutės apdorojimą — procesas žūtų nemigravęs
   * nieko, ir tai galiotų vienodai `run` bei `dry-run`.
   *
   * Tikrinama STRUKTŪRIŠKAI, nes tai vienintelis būdas: elgesio testas su 20 GiB
   * CI'uje neįmanomas, o mažesnis nieko neįrodytų. Sąlyga paprasta ir tikrinama —
   * atranka grąžina tik identifikatorius.
   */
  assert.ok(
    !/SELECT[\s\S]*?payload[\s\S]*?FROM job_results/i.test(KANDIDATAI_SQL),
    "atranka traukia `payload` — visa partija patenka į atmintį"
  );
  assert.match(KANDIDATAI_SQL, /SELECT\s+r\.job_id\s+FROM/, "atranka privalo grąžinti tik `job_id`");
});

test("`PAYLOAD_SQL` kartoja atrankos sąlygą — langas uždarytas", () => {
  /**
   * ⚠️ TRAUKIMAS PER EILUTĘ ATVERTŲ NAUJĄ LANGĄ, JEI SĄLYGOS NEBŪTŲ.
   *
   * Tarp atrankos ir traukimo eilutę gali perjungti įprastas užbaigimo kelias.
   * Be `storage_type = 'inline' AND payload IS NOT NULL` traukimas grąžintų jau
   * EXTERNAL eilutės `payload` (t. y. `NULL`) arba svetimą turinį, ir migracija
   * bandytų perkelti tai, kas jau perkelta.
   *
   * Su sąlyga tokia eilutė grąžina 0 įrašų ir praleidžiama — ne `failed`, nes
   * niekas nesugedo.
   */
  assert.match(PAYLOAD_SQL, /storage_type = 'inline'/);
  assert.match(PAYLOAD_SQL, /payload IS NOT NULL/);
  assert.match(PAYLOAD_SQL, /WHERE\s+job_id = \$1/);
});

test("CLI nenaudoja `process.exit()` — išvestis nenukertama", () => {
  /**
   * ⚠️ DVI PROBLEMOS VIENAME KVIETIME.
   *
   * 1. `process.exit()` nutraukia procesą NELAUKDAMAS, kol išsipils stdout. Kai
   *    išvestis nukreipta į failą ar pipe — t. y. kiekvienoje automatikoje —
   *    didelis `console.log` gali būti NUKIRSTAS. Skaitytojas gauna nepilną JSON
   *    ir to nepastebi, nes exit kodas sako „sėkmė". Tylus gedimas.
   *
   * 2. Iš `try` bloko jis dar ir aplenkia `finally`, tad `pool.end()` neįvyksta.
   *
   * Tikrinama tekste, nes tai struktūrinė savybė: nė viena šaka neturi teisės
   * baigti proceso pati. Vienas grįžęs `process.exit()` atkurtų abi problemas.
   */
  const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "migrate-artifacts.mjs"), "utf8");

  /**
   * ⚠️ KOMENTARŲ EILUTĖS IŠMETAMOS — SARGAS PAGAVO PATS SAVE.
   *
   * Pirma redakcija skenavo visą tekstą ir krito dėl TRIJŲ paminėjimų PAČIAME
   * paaiškinime, kodėl `process.exit()` nenaudojamas. Tai #265 klasė („statinės
   * patikros gaudo savo pačių komentarus"), ir ji reali: patikra, kurią tenkina
   * tik nutylėtas paaiškinimas, verčia rinktis tarp sargo ir dokumentacijos.
   *
   * ⚠️ RIBA UŽRAŠOMA: filtruojama pagal eilutės pradžią, tad `process.exit(`
   * daugiaeilėje eilutėje (template literal) būtų palaikytas kvietimu. Tokio
   * kodo čia nėra, o bendra taisyklė yra #265 apimtis — ne šio testo.
   */
  const kodoEilutes = cli
    .split("\n")
    .filter((e) => !/^\s*(\*|\/\/|\/\*)/.test(e))
    .join("\n");

  const kvietimai = [...kodoEilutes.matchAll(/process\.exit\s*\(/g)];
  assert.deepEqual(kvietimai.map((m) => m[0]), [], "CLI kviečia `process.exit()`");

  assert.match(cli, /process\.exitCode\s*=/, "exit kodas privalo būti nustatomas, ne vykdomas");
  assert.match(cli, /finally\s*\{[\s\S]*?pool\.end\(\)/, "`finally` privalo uždaryti pool'ą");
});

test("SCENARIJAI neturi backend'o literalų — kitaip jie perima vieno savybes", () => {
  /**
   * ⚠️ PATIKRINTA, KAD ELGESIO SARGAS ČIA NEPAKANKA.
   *
   * Būtų natūralu manyti, kad tų pačių scenarijų paleidimas prieš DU backend'us
   * pagauna kiekvieną naują `'fs'` literalą. Taip yra tik IŠ DALIES:
   *
   *   TVIRTINIME (`assert.equal(r.storage_type, "fs")`) — pagauna: `s3` raunde
   *     laukiama reikšmė nesutampa, ir testas krenta (taip ir rado pirmas
   *     raundas, CI 34370538544);
   *
   *   SQL SAKINYJE, imituojančiame svetimą procesą — NEPAGAUNA. `UPDATE ... SET
   *     storage_type = 'fs'` yra teisėtas įrašas ir `s3` paleidime:
   *     `job_results_storage_shape` jį priima, o gretimi tvirtinimai tikrina
   *     `storage_key`, ne `storage_type`. Testas lieka žalias, o scenarijus
   *     tyliai grįžta prie vieno backend'o prielaidos.
   *
   * Todėl reikia TEKSTINIO sargo — ne todėl, kad jis stipresnis, o todėl, kad jis
   * dengia būtent tą pusę, kurios elgesio sargas nemato. Be jo teiginys „kode
   * nebeliko nė vieno `'fs'` literalo" būtų konvencija, ne garantija.
   */
  const scenarijai = fs.readFileSync(
    path.join(__dirname, "helpers", "artifactMigrationScenarios.js"),
    "utf8"
  );

  /** ⚠️ Komentarų eilutės išmetamos — #265 klasė; žr. `process.exit()` sargą. */
  const tikKodas = (tekstas) =>
    tekstas
      .split("\n")
      .filter((e) => !/^\s*(\*|\/\/|\/\*)/.test(e))
      .join("\n");

  const rasti = (tekstas) => [...tikKodas(tekstas).matchAll(/['"](fs|s3)['"]/g)].map((m) => m[0]);

  assert.deepEqual(
    rasti(scenarijai),
    [],
    "scenarijuose yra backend'o literalas — naudokite `backendas()`, t. y. `saugykla.backend`"
  );

  /**
   * ⚠️ SAVIPATIKRA. Patikra, kuri niekada nieko nerado, neatskiriama nuo
   * patikros, kuri neveikia — ta pati taisyklė kaip `check-matrix-rows.mjs`.
   */
  assert.equal(
    rasti(scenarijai + "\nassert.equal(r.storage_type, \"fs\");\n").length,
    1,
    "sargas neranda įterpto literalo — jis nieko negina"
  );
});

/**
 * DVIPRASMIŠKAS `COMMIT` — TIKRINAMA BE DB, IR TAI SPRENDIMAS (#157, PR-6).
 *
 * ⚠️ TRYS INTEGRACINIAI RAUNDAI KABO, IR KAINA VIRŠIJO NAUDĄ.
 *
 * Pirmos redakcijos lopė tikro pool'o klientą (tarša išeidavo į gretimus
 * scenarijus), antra bandė lopą nusiimti pačiam, trečia davė `migruoti()` atskirą
 * pool'ą. Visos trys baigėsi `test timed out after 300000ms` (CI 34440571250,
 * 34441688559, 34442823089).
 *
 * ⚠️ IR PATS KLAUSIMAS DB NEREIKALAUJA. „Ar po dviprasmiško `COMMIT` vykdomas
 * valymas" yra KODO ŠAKOS klausimas, ne PostgreSQL elgesio. Tikra DB čia įrodo
 * ne daugiau, o tik lėčiau ir su bendrų resursų rizika — ta pačia, kurią
 * užregistravo #310.
 *
 * Padirbtas pool'as leidžia `COMMIT` „pavykti" ir TIK PASKUI mesti — tiksliai ta
 * seka, kurios tikra DB neduoda deterministiškai.
 */
function padirbtasPool({ commitElgesys }) {
  const irasai = { sakiniai: [], atlaisvinta: 0 };

  const atsakymas = (sql) => {
    if (/FROM job_results r/.test(sql)) return { rows: [{ job_id: "job-1" }], rowCount: 1 };
    if (/SELECT\s+payload/.test(sql)) return { rows: [{ payload: { text: "x" } }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  const client = {
    async query(sql) {
      irasai.sakiniai.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
      if (String(sql).trim().toUpperCase() === "COMMIT") return commitElgesys();
      return atsakymas(String(sql));
    },
    release() {
      irasai.atlaisvinta += 1;
    },
  };

  return {
    irasai,
    async query(sql) {
      irasai.sakiniai.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
      return atsakymas(String(sql));
    },
    async connect() {
      return client;
    },
  };
}

function padirbtaSaugykla() {
  const irasai = { put: 0, verify: 0, delete: [] };

  return {
    irasai,
    backend: "fs",
    async put(raktas) {
      irasai.put += 1;
      return { reference: raktas, bytes: 10, checksum: "e".repeat(64) };
    },
    async verify() {
      irasai.verify += 1;
      return { ok: true, exists: true, bytes: 10, checksum: "e".repeat(64), nepriklausomas: true };
    },
    async head() {
      return { bytes: 10 };
    },
    async delete(raktas) {
      irasai.delete.push(raktas);
      return true;
    },
  };
}

test("DVIPRASMIŠKAS `COMMIT` NEIŠTRINA objekto, į kurį jau rodo nuoroda", async () => {
  /**
   * ⚠️ P1: „NEŽINAU, AR ĮVYKO" NEGALI VIRSTI DESTRUKTYVIU VEIKSMU.
   *
   * PostgreSQL gali įsipareigoti, o atsakymas kliento nepasiekti. Tada `COMMIT`
   * meta, nors transakcija ĮVYKO. Ištrynus objektą tokiu atveju liktų external
   * eilutė be objekto IR be inline kopijos — sunaikinta vienintelė kopija.
   *
   * ⚠️ TA PATI KLASĖ KAIP PR-5 A ŠAKNIS.
   */
  const pool = padirbtasPool({
    commitElgesys: () => {
      throw new Error("simuliuotas ryšio nutrūkimas PO sėkmingo COMMIT");
    },
  });
  const saugykla = padirbtaSaugykla();

  await assert.rejects(() => migruoti(pool, saugykla, {}), /nutrūkimas/);

  assert.deepEqual(
    saugykla.irasai.delete,
    [],
    "objektas IŠTRINTAS po dviprasmiško `COMMIT` — sunaikinta vienintelė kopija"
  );
  assert.ok(pool.irasai.sakiniai.includes("COMMIT"), "kontrolė: `COMMIT` tikrai buvo išsiųstas");
  assert.equal(pool.irasai.atlaisvinta, 1, "jungtis privalo būti atlaisvinta");
});

test("KONTROLĖ: ĮPRASTA nesėkmė objektą VIS TIEK ištrina", async () => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas ir tada, jei valymas dingtų VISAI —
   * o tada pralaimėję bandymai kauptųsi kaip orphan'ai. Skiriasi tik tuo, KADA
   * įvyksta nesėkmė: prieš `COMMIT`, kai baigtis NĖRA dviprasmiška.
   */
  const pool = padirbtasPool({ commitElgesys: () => ({ rows: [], rowCount: 1 }) });
  const saugykla = padirbtaSaugykla();

  saugykla.verify = async () => ({
    ok: false,
    exists: true,
    bytes: 1,
    checksum: "a".repeat(64),
    nepriklausomas: true,
  });

  const s = await migruoti(pool, saugykla, {});

  assert.equal(s.nepavyko.vientisumas_nepatvirtintas, 1);
  assert.equal(saugykla.irasai.delete.length, 1, "aiški nesėkmė privalo išvalyti savo objektą");
});

test("SCHEMOS VARTAI: progreso šalinimas praleidžiamas, kai lentelės nėra (Codex A)", () => {
  /**
   * ⚠️ BESĄLYGINĖ UŽKLAUSA GRIOVĖ DR REPLAY.
   *
   * `restoredJobStore.paruosti()` SĄMONINGAI leidžia senesnę schemą, o
   * `artifact_migration_progress` (`1756600000000`) yra NAUJESNĖ už
   * `job_result_attempts` (`1756300000000`) — tad kopija gali turėti registrą ir
   * neturėti progreso. Besąlyginis `DELETE` tokioje bazėje duotų `42P01` PO to,
   * kai eilė, audio, artefaktai ir auditas jau išvalyti: palaikomas replay
   * virstų DALINAI ĮVYKDYTU GEDIMU.
   *
   * ⚠️ TIKRINAMA STRUKTŪRIŠKAI, nes elgesio testas reikalautų DB su TARPINE
   * schema — o tokios `node-pg-migrate` „up N" riba neduoda be atskiro
   * mechanizmo. Struktūra čia atsako į tą patį klausimą: ar kvietimas eina per
   * vartus, ar aplenkia juos.
   */
  const store = fs.readFileSync(
    path.join(__dirname, "..", "utils", "jobStore", "postgresStore.js"),
    "utf8"
  );

  const eilute = store
    .split("\n")
    .find((e) => e.includes("DELETE FROM artifact_migration_progress"));

  assert.ok(eilute, "progreso šalinimo sakinys dingo");

  const indeksas = store.split("\n").indexOf(eilute);
  const kontekstas = store.split("\n").slice(Math.max(0, indeksas - 3), indeksas).join("\n");

  assert.match(
    kontekstas,
    /if \(migracijosProgresas\)/,
    "šalinimas nepraeina pro schemos vartus — senesnė kopija duotų `42P01` VIDURYJE replay"
  );

  /**
   * ⚠️ IR VARTAI PRIVALO BŪTI IŠVEDAMI, NE PADUODAMI. Kvietėjas negali pasirinkti
   * schemos — tai bazės faktas. Ta pati taisyklė kaip `bandymuRegistras`.
   */
  const restored = fs.readFileSync(path.join(__dirname, "..", "utils", "restoredJobStore.js"), "utf8");
  assert.match(restored, /migracijosProgresas: "isvedama-is-schemos"/);
  assert.match(restored, /42P01/);
});

test("CLI: nežinomas argumentas atmetamas — ir BE brūkšnių (Codex C)", () => {
  /**
   * ⚠️ FILTRAS PRALEIDO SAVO TAIKINĮ.
   *
   * Pirma redakcija paliko tik `-` prasidedančius tokenus, tad `run retry-failed`
   * TYLIAI vykdydavo su `retryFailed === false` — tiksliai tas gedimas, kurį
   * validacija turėjo užkirsti. Filtras, praleidžiantis savo taikinį, blogesnis
   * nei jo nebuvimas: jis sukuria įspūdį, kad argumentai tikrinami.
   *
   * ⚠️ TIKRINAMA PER TIKRĄ PALEIDIMĄ, ne per funkciją: klausimas yra, ką daro
   * KOMANDA, o ne ar egzistuoja filtras. DB nereikia — validacija vyksta PRIEŠ
   * prisijungimą, ir būtent tai yra viena iš tikrinamų savybių.
   */
  const cli = path.join(__dirname, "..", "scripts", "migrate-artifacts.mjs");

  const paleisti = (argumentai) => {
    try {
      execFileSync(process.execPath, [cli, ...argumentai], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DATABASE_URL: "", PGHOST: "" },
      });
      return { kodas: 0, isvestis: "" };
    } catch (e) {
      return { kodas: e.status, isvestis: String(e.stderr || "") };
    }
  };

  for (const argumentai of [["run", "retry-failed"], ["run", "--retry-failed", "typo"], ["run", "--retry-fai"]]) {
    const r = paleisti(argumentai);
    assert.equal(r.kodas, 1, `${argumentai.join(" ")}: privalo būti naudojimo klaida`);
    assert.match(r.isvestis, /Nežinomi argumentai/, `${argumentai.join(" ")}: netinkama priežastis`);
  }

  /**
   * ⚠️ KONTROLĖ: galiojantys argumentai NEATMETAMI. Be jos „viskas atmetama"
   * tenkintų ankstesnius tvirtinimus, o komanda taptų nenaudojama.
   */
  const galiojantys = paleisti(["run", "--retry-failed"]);
  assert.equal(galiojantys.kodas, 1, "be DB komanda vis tiek krenta — bet dėl KITOS priežasties");
  assert.match(
    galiojantys.isvestis,
    /PostgreSQL nenurodyta/,
    "galiojantis argumentas atmestas kaip nežinomas — filtras per platus"
  );
});

test("STRUKTŪRINĖ SARGYBA: CLI neturi savo orkestracijos", () => {
  /**
   * Ta pati taisyklė ir tas pats precedentas kaip `dr-restore.mjs` (#250 D2):
   * operatoriaus kelias kviečia procedūrą, o ne kartoja ją. Antras
   * egzempliorius reikštų, kad testuojama viena versija, o paleidžiama kita.
   */
  const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "migrate-artifacts.mjs"), "utf8");

  assert.ok(cli.includes("artifactMigration"), "CLI privalo kviesti procedūrą iš modulio");
  assert.ok(
    !/UPDATE\s+job_results/i.test(cli),
    "CLI turi savo reference switch — orkestracija išsiskyrė"
  );
  assert.ok(
    !/attemptRegistry/.test(cli),
    "CLI tiesiogiai liečia registrą — tvarka turi gyventi VIENOJE vietoje"
  );
});
