const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { operacijosSuRaktu } = require("./helpers/artifactStoreScenarios");

/**
 * `fs` RIBA IR RAŠYMO PATVARUMAS (#157, PR-2, Codex #290).
 *
 * ⚠️ KODĖL ATSKIRAI NUO KONTRAKTO RINKINIO. Symlink'ai, laikini failai ir
 * katalogų `fsync` yra ŠIO backend'o mechanika. Įdėti juos į bendrą rinkinį
 * reikštų įkoduoti į vartus filesystem prielaidas — būtent tai, ko rinkinys
 * vengia. Kontraktas tikrina ELGESĮ, šis failas — kaip jis pasiekiamas.
 */

async function aplinka() {
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-fs-riba-"));
  const isore = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-fs-isore-"));
  return { saknis, isore, isvalyti: () => Promise.all([
    fsp.rm(saknis, { recursive: true, force: true }),
    fsp.rm(isore, { recursive: true, force: true }),
  ]) };
}

test("symlink riba galioja KIEKVIENAI operacijai, ne tik toms, kurios kviečia `head`", async (t) => {
  const { saknis, isore, isvalyti } = await aplinka();
  t.after(isvalyti);

  /**
   * ⚠️ TAIKINYS - TIKRAS FAILAS UŽ ŠAKNIES. Be jo `delete` gautų `ENOENT` ir
   * grąžintų `false` „teisingai" dėl neteisingos priežasties: riba liktų
   * nepatikrinta, o testas - žalias.
   */
  const svetimas = path.join(isore, "svetimas.json");
  await fsp.writeFile(svetimas, JSON.stringify({ transkripcija: "svetimas turinys" }), "utf8");
  await fsp.symlink(isore, path.join(saknis, "results"));

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/svetimas.json";

  /**
   * ⚠️ OPERACIJOS IŠVEDAMOS IŠ PAVIRŠIAUS. Ranka surašytos, jos praleistų
   * kiekvieną naujai pridėtą — tiksliai taip `delete` ir liko be ribos.
   */
  for (const [vardas, veiksmas] of operacijosSuRaktu(saugykla)) {
    await assert.rejects(
      () => veiksmas(raktas),
      (klaida) => klaida.code === "ARTIFACT_KEY_INVALID",
      `${vardas}: symlink per katalogą privalo būti atmestas ties riba`
    );
  }

  const liko = await fsp.readFile(svetimas, "utf8");
  assert.match(liko, /svetimas turinys/, "svetimas failas privalo LIKTI nepaliestas");
});

test("KONTROLĖ: be symlink'o tos pačios operacijos praeina", async (t) => {
  /**
   * Be jos ankstesnis testas būtų tenkinamas saugyklos, kuri atmeta VISKĄ.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/tikras.json";

  await saugykla.put(raktas, { text: "vidus" });

  assert.ok(await saugykla.head(raktas));
  assert.deepEqual(await saugykla.read(raktas), { text: "vidus" });
  assert.equal(await saugykla.delete(raktas), true);
});

test("laikino failo vardas NEPRIKLAUSO nuo rakto ilgio", async (t) => {
  /**
   * ⚠️ MŪSŲ SUFIKSAS NEGALI ATMESTI RAKTO, KURĮ RIBA PRIĖMĖ.
   *
   * Riba leidžia iki 512 simbolių raktą, o failų sistema - iki 255 baitų VIENAM
   * vardui. Laikinas vardas `<raktas>.<uuid>.tmp` pridėdavo 41 simbolį, tad
   * raktas, kurį saugykla puikiai laiko, krisdavo su `ENAMETOOLONG` — dėl mūsų
   * pačių pasirinkimo, ne dėl sistemos ribos.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = `results/${"a".repeat(214)}.json`;

  const kvitas = await saugykla.put(raktas, { text: "ilgas" });
  assert.ok(kvitas.bytes > 0);
  assert.deepEqual(await saugykla.read(raktas), { text: "ilgas" });
});

/**
 * ⚠️ GEDIMŲ ĮTERPIMAS PER `fsp` MODULIO OBJEKTĄ.
 *
 * `fsStore` naudoja tą patį `require("node:fs/promises")` objektą, tad laikinas
 * metodo pakeitimas pasiekia produkcinį kelią nekeičiant jo formos. Pataisa
 * grąžinama `finally`, o `node:test` failus vykdo atskiruose procesuose.
 *
 * @param {{sugadintiSync?: boolean, sugadintiRm?: boolean, sugadintiRename?: boolean}} kas
 */
async function suGedimu(kas, veiksmas) {
  const tikrasOpen = fsp.open;
  const tikrasRm = fsp.rm;
  const tikrasRename = fsp.rename;

  let syncSugadintas = Boolean(kas.sugadintiSync);

  if (kas.sugadintiSync) {
    fsp.open = async (kelias, veliavos, ...kita) => {
      if (veliavos === "r" && syncSugadintas) {
        syncSugadintas = false;
        const klaida = new Error("suklastotas katalogo `fsync` gedimas");
        klaida.code = "EIO";
        throw klaida;
      }
      return tikrasOpen(kelias, veliavos, ...kita);
    };
  }

  if (kas.sugadintiRm) {
    fsp.rm = async () => {
      const klaida = new Error("suklastotas valymo gedimas");
      klaida.code = "EACCES";
      throw klaida;
    };
  }

  if (kas.sugadintiRename) {
    fsp.rename = async () => {
      const klaida = new Error("suklastotas `rename` gedimas");
      klaida.code = "EXDEV";
      throw klaida;
    };
  }

  try {
    return await veiksmas();
  } finally {
    fsp.open = tikrasOpen;
    fsp.rm = tikrasRm;
    fsp.rename = tikrasRename;
  }
}

test("gedimas PRIEŠ `rename` nepalieka laikino failo", async (t) => {
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.put("results/pirmas.json", { text: "kad šaknis būtų paruošta" });

  await assert.rejects(
    () => suGedimu({ sugadintiRename: true }, () => saugykla.put("results/nutruko.json", { a: 1 })),
    /EXDEV|suklastotas/
  );

  assert.deepEqual(
    await fsp.readdir(path.join(saknis, "results")),
    ["pirmas.json"],
    "nei objekto, nei `.tmp` likučio"
  );
});

test("gedimas PO `rename` nepalieka objekto, kurio kvietėjas neregistruos", async (t) => {
  /**
   * ⚠️ NESĖKMINGAS `put()` NETURI PALIKTI NEREFERENCUOTO ARTEFAKTO.
   *
   * `rename` jau įvyko, bet katalogo `fsync` krito — `put()` meta, kvietėjas
   * nuorodos nepersistina, o objektas lieka gulėti. DB krypties inventorius (A3)
   * jo NEBERANDA pagal apibrėžimą: tai jautrus turinys be savininko.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.put("results/pirmas.json", { text: "kad šaknis būtų paruošta" });

  await assert.rejects(
    () => suGedimu({ sugadintiSync: true }, () => saugykla.put("results/nutruko.json", { a: 1 })),
    (klaida) => klaida.code === "EIO",
    "kvietėjas privalo matyti PIRMINĘ gedimo priežastį, kai valymas pavyko"
  );

  assert.equal(
    await saugykla.head("results/nutruko.json"),
    null,
    "nesėkmingas `put()` privalo nepalikti objekto"
  );
  assert.deepEqual(await fsp.readdir(path.join(saknis, "results")), ["pirmas.json"]);
});

test("VALYMO nesėkmė PRANEŠAMA, o ne nurijama", async (t) => {
  /**
   * ⚠️ BEST-EFFORT VALYMAS IŠTRYNIMO GRANDINĖJE YRA TAS PATS, KAS JOKIO VALYMO
   * (Codex, #290).
   *
   * Ankstesnė redakcija darė `rm(...).catch(() => {})`: jei trynimas nepavyko,
   * jautrus nereferencuotas objektas likdavo saugykloje, o apie tai nesužinodavo
   * NIEKAS — nei kvietėjas, nei operatorius.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.put("results/pirmas.json", { text: "kad šaknis būtų paruošta" });

  const eilutes = [];
  const originalus = console.error;
  console.error = (...args) => {
    eilutes.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  let klaida = null;
  try {
    await suGedimu({ sugadintiSync: true, sugadintiRm: true }, () =>
      saugykla.put("results/liko.json", { transkripcija: "SLAPTAS-PACIENTO-TEKSTAS" })
    );
  } catch (e) {
    klaida = e;
  } finally {
    console.error = originalus;
  }

  assert.ok(klaida, "nesėkmė privalo pasiekti kvietėją");
  assert.equal(klaida.code, "ARTIFACT_ORPHAN_LEFT", "ir turėti SAVO kodą, ne pirminės klaidos");
  assert.equal(klaida.cause && klaida.cause.code, "EIO", "pirminė priežastis išsaugoma `cause`");

  const logas = eilutes.join("\n");
  assert.match(logas, /artifact_cleanup/, "operatorius privalo apie tai sužinoti iš logo");
  assert.match(logas, /results\/liko\.json/, "logas privalo įvardyti, KĄ reikės pašalinti");
  assert.ok(
    !logas.includes("SLAPTAS-PACIENTO-TEKSTAS"),
    "bet turinio jame būti negali - raktas yra adresas, ne duomenys"
  );
});

test("gedimas PO `rename` NENAIKINA objekto, kuris jau buvo tuo adresu", async (t) => {
  /**
   * ⚠️ RIBA UŽRAŠOMA, O NE PRAPLEČIAMA. Jei tuo adresu objektas jau buvo, jo
   * turinys po `rename` jau pakeistas, ir atstatyti jo nebėra iš ko. Trynimas čia
   * prarastų duomenis; paliekamas naujas turinys, o `put()` vis tiek praneša
   * nesėkmę — patvarumo jis patvirtinti negali.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/buvo.json";
  await saugykla.put(raktas, { text: "pirmas" });

  await assert.rejects(
    () => suGedimu({ sugadintiSync: true }, () => saugykla.put(raktas, { text: "antras" })),
    (klaida) => klaida.code === "EIO"
  );

  assert.ok(await saugykla.head(raktas), "esamas adresas NEIŠVALOMAS — tai būtų duomenų praradimas");
});

test("STARTO patikra atskleidžia netinkamą šaknį PRIEŠ pirmą operaciją", async (t) => {
  /**
   * ⚠️ FAIL-FAST NEĮVYKDAVO, NES JO NIEKAS NEKVIETĖ (Codex, #290).
   *
   * Šaknies patikra buvo tingi: netinkamas `ARTIFACT_FS_ROOT` paaiškėdavo tik per
   * pirmą operaciją — jau PO to, kai tiekėjas atliko brangų darbą. PR-2 fail-fast
   * kriterijus reikalauja priešingo.
   */
  const failas = path.join(os.tmpdir(), `stenograma-startas-failas-${process.pid}`);
  await fsp.writeFile(failas, "ne katalogas", "utf8");
  t.after(() => fsp.rm(failas, { force: true }));

  await assert.rejects(
    () => createFsArtifactStore({ root: failas }).patikrintiSaugykla(),
    (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID"
  );

  /** KONTROLĖ: tvarkinga šaknis startą praeina ir grąžina išspręstą kelią. */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const verdiktas = await createFsArtifactStore({ root: saknis }).patikrintiSaugykla();
  assert.equal(verdiktas.backend, "fs");
  assert.ok(verdiktas.root.length > 0);
});

test("šaknis, kuri yra FAILAS, yra konfigūracijos klaida — ne dingę duomenys", async (t) => {
  /**
   * ⚠️ NEGALIOJANTI ŠAKNIS ATRODĖ KAIP PRARASTI VARTOTOJO DUOMENYS.
   *
   * `realpath` tokiu atveju meta `ENOTDIR`, o operacijos jį laikydavo „objekto
   * nėra": `head()` → `null`, `read()` → `ARTIFACT_NOT_FOUND`, `verify()` →
   * nesančio objekto verdiktas. Remontas taip nueina atkūrimo keliu, nors trūksta
   * ne artefakto, o saugyklos.
   */
  const failas = path.join(os.tmpdir(), `stenograma-saknis-failas-${process.pid}`);
  await fsp.writeFile(failas, "ne katalogas", "utf8");
  t.after(() => fsp.rm(failas, { force: true }));

  const saugykla = createFsArtifactStore({ root: failas });

  for (const [vardas, veiksmas] of operacijosSuRaktu(saugykla)) {
    await assert.rejects(
      () => veiksmas("results/a.json"),
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
      `${vardas}: negaliojanti šaknis privalo būti konfigūracijos klaida`
    );
  }
});

test("failų sistemos šaknis (`/`) atmetama iš karto", () => {
  /**
   * ⚠️ Su `saknis === "/"` sulaikymo patikra lygintų su `"//"`, ir saugykla atmestų
   * VISKĄ — atrodytų veikianti, bet nepriimtų nė vieno teisėto rakto. Be to
   * artefaktų šaknis, sutampanti su failų sistemos šaknimi, reikštų `delete()`,
   * vaikštantį po visą mašiną.
   */
  assert.throws(
    () => createFsArtifactStore({ root: "/" }),
    (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID"
  );
});

test("trūkstama šaknis sukuriama su `0700` ir lieka naudojama", async (t) => {
  const tevas = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-nauja-saknis-"));
  t.after(() => fsp.rm(tevas, { recursive: true, force: true }));

  const saknis = path.join(tevas, "artefaktai", "gilu");
  const saugykla = createFsArtifactStore({ root: saknis });

  await saugykla.put("results/a.json", { text: "nauja" });

  const info = await fsp.stat(saknis);
  assert.ok(info.isDirectory(), "šaknis privalo būti sukurta");
  assert.equal(info.mode & 0o777, 0o700, "šaknis nėra apeinama kitų vietinių paskyrų");
  assert.deepEqual(await saugykla.read("results/a.json"), { text: "nauja" });
});

/* ═══ TEISĖS ═══ */

test("artefaktai kuriami `0600`, ne pagal `umask`", async (t) => {
  /**
   * ⚠️ Be eksplicitinio režimo Node naudoja `0o666 & ~umask`; su įprastu `022`
   * galutinis artefaktas lieka `0644` — transkripciją perskaito bet kuri vietinė
   * paskyra ar sidecar, pasiekiantis tą volume.
   *
   * Teisės nustatomos LAIKINAM failui, nes `rename` jas išsaugo: turinys niekada,
   * net milisekundę, nebūna platesnis, nei turi būti.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.put("results/slaptas.json", { text: "transkripcija" });

  assert.equal((await fsp.stat(path.join(saknis, "results/slaptas.json"))).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(path.join(saknis, "results"))).mode & 0o777, 0o700, "ir katalogas");
});

/* ═══ OBJEKTO SEMANTIKA ═══ */

test("katalogas nėra objektas NĖ VIENOJE operacijoje", async (t) => {
  /**
   * ⚠️ `delete("results")` mesdavo žalią `EISDIR`, nors `head("results")` tam pačiam
   * raktui sako „objekto nėra", o `inline` ir S3 grąžina `false`. Tas pats įėjimas
   * duodavo tris skirtingus atsakymus, ir bendras kontraktas nustodavo būti bendras.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.put("results/job/a.json", { text: "gilus" });

  assert.equal(await saugykla.head("results"), null, "`head` prefiksui — `null`");
  assert.equal(await saugykla.delete("results"), false, "`delete` prefiksui — `false`, ne `EISDIR`");
  assert.equal((await saugykla.verify("results", { bytes: 1, checksum: "a".repeat(64) })).ok, false);

  await assert.rejects(
    () => saugykla.read("results"),
    (klaida) => klaida.code === "ARTIFACT_NOT_FOUND"
  );
  await assert.rejects(
    () => saugykla.readStream("results"),
    (klaida) => klaida.code === "ARTIFACT_NOT_FOUND"
  );

  assert.ok(await saugykla.head("results/job/a.json"), "KONTROLĖ: tikras objektas nedingo");
});

/* ═══ SYMLINK PRIEŠ `mkdir` ═══ */

test("symlink'as pastebimas PRIEŠ sukuriant palikuonių katalogus", async (t) => {
  /**
   * ⚠️ ANKSTESNĖ REDAKCIJA TIKRINO TIK PATĮ TAIKINĮ.
   *
   * Kai `<šaknis>/results` yra symlink'as į išorę, o `results/job/` dar nėra,
   * `realpath` taikiniui grąžindavo `ENOENT` — riba praleisdavo, `mkdir` sekdavo
   * symlink'ą, ir katalogas atsirasdavo UŽ šaknies dar prieš tai, kai raktas būdavo
   * atmestas. Rašymas nepavykdavo, bet pėdsakas svetimoje vietoje likdavo.
   */
  const { saknis, isore, isvalyti } = await aplinka();
  t.after(isvalyti);

  await fsp.symlink(isore, path.join(saknis, "results"));
  const saugykla = createFsArtifactStore({ root: saknis });

  await assert.rejects(
    () => saugykla.put("results/job/a.json", { text: "svetur" }),
    (klaida) => klaida.code === "ARTIFACT_KEY_INVALID"
  );

  assert.deepEqual(
    await fsp.readdir(isore),
    [],
    "už šaknies neturi likti NIEKO — nei failo, nei katalogo"
  );
});

/* ═══ VIENTISUMO PATIKRA BE VISO OBJEKTO BUFERINIMO ═══ */

test("`verify()` nutraukia skaitymą peržengus patikimą dydį", async (t) => {
  /**
   * ⚠️ TA PATI KLASĖ KAIP S3 PUSĖJE (Codex rado ten; `fs` turėjo tą pačią).
   *
   * Objektas, pakeistas ar sugadintas į daug didesnį už persistintą `bytes`,
   * išsemtų atkūrimo procesą BŪTENT tame kelyje, kuris sugadinimą ir turi aptikti.
   * Verdiktas fail-closed: `ok: false` be teigiamos sumos.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/isputes.json";

  const kvitas = await saugykla.put(raktas, { text: "mažas" });

  /** Objektas pakeičiamas UŽ saugyklos nugaros — būtent tai `verify()` ir gaudo. */
  await fsp.writeFile(path.join(saknis, raktas), Buffer.alloc(4 * 1024 * 1024, 0x61));

  const verdiktas = await saugykla.verify(raktas, { bytes: kvitas.bytes, checksum: kvitas.checksum });

  assert.equal(verdiktas.ok, false, "išsipūtęs objektas negali būti patvirtintas");
  assert.equal(verdiktas.exists, true, "objektas YRA vietoje");
  assert.equal(verdiktas.checksum, null, "sumos neapskaičiavome, tad jos ir neteigiame");
  assert.equal(verdiktas.nepriklausomas, true);
});

test("KONTROLĖ: nepakitęs objektas ir toliau patvirtinamas", async (t) => {
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const reiksme = { text: "vientisumas", segments: Array.from({ length: 500 }, (_, i) => i) };
  const kvitas = await saugykla.put("results/geras.json", reiksme);

  const verdiktas = await saugykla.verify("results/geras.json", {
    bytes: kvitas.bytes,
    checksum: kvitas.checksum,
  });

  assert.equal(verdiktas.ok, true, "srautinė suma privalo sutapti su kvitu");
  assert.equal(verdiktas.bytes, kvitas.bytes);
});

/* ═══ STARTO ZONDAS: AR ŠAKNIS TINKA RAŠYMUI ═══ */

test("starto patikra ZONDUOJA rašymą ir po savęs nieko nepalieka", async (t) => {
  /**
   * ⚠️ KATALOGAS GALI BŪTI PASIEKIAMAS IR VIS TIEK NETINKAMAS.
   *
   * `stat` ir `realpath` pavyksta ir tada, kai šaknis prijungta tik skaitymui arba
   * priklauso kitai paskyrai (`0555`). Startas skelbdavo backend'ą paruoštą, o
   * pirmas `put()` krisdavo — JAU PO to, kai tiekėjas atliko brangų transkribavimą.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const verdiktas = await saugykla.patikrintiSaugykla();

  assert.equal(verdiktas.backend, "fs");
  assert.deepEqual(
    await fsp.readdir(saknis),
    [],
    "sėkmingas zondas privalo po savęs nepalikti NIEKO"
  );
});

test("nerašoma šaknis SUSTABDO startą, o ne pirmą `put()`", async (t) => {
  /**
   * ⚠️ GEDIMAS ĮTERPIAMAS, NE MODELIUOJAMAS `chmod`.
   *
   * CI gali vykdyti testus kaip `root`, o `root` `0555` katalogą rašo be kliūčių —
   * tada testas žaliuotų nepatikrinęs nieko (§9.2). Įterpimas per `fsp.open`
   * duoda tą patį `EACCES`, kurį duotų tikra tik skaitymui prijungta saugykla,
   * ir nepriklauso nuo to, kas paleido procesą.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });

  const tikrasOpen = fsp.open;
  fsp.open = async (kelias, veliavos, ...kita) => {
    if (veliavos === "wx") {
      const klaida = new Error("suklastota tik skaitymui prijungta saugykla");
      klaida.code = "EACCES";
      throw klaida;
    }
    return tikrasOpen(kelias, veliavos, ...kita);
  };

  try {
    await assert.rejects(
      () => saugykla.patikrintiSaugykla(),
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
      "netinkama rašymui šaknis privalo sustabdyti STARTĄ"
    );

    /** ⚠️ Ir operacijos lieka uždarytos — startas nėra atskiras nuo naudojimo. */
    await assert.rejects(
      () => saugykla.put("results/a.json", { a: 1 }),
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID"
    );
  } finally {
    fsp.open = tikrasOpen;
  }

  assert.deepEqual(
    await fsp.readdir(saknis),
    [],
    "nepavykęs zondas irgi nepalieka pėdsakų"
  );
});

test("zondas NEGALI užkliudyti artefakto: jo vardas raktu neišreiškiamas", () => {
  /**
   * ⚠️ SAUGUMAS ČIA REMIASI RIBA, NE TIKIMYBE.
   *
   * Zondo vardas prasideda tašku, o raktų allowlist'as (`validation.js`) taško
   * segmento pradžioje NELEIDŽIA. Vadinasi jokio teisėto artefakto tokiu vardu
   * nėra ir negali būti — susidūrimas neįmanomas, o ne mažai tikėtinas. (`wx`
   * vėliava yra antra gynybos linija.)
   */
  const { patikrintiRakta } = require("../utils/artifactStore/validation");

  for (const vardas of [".zondas.0123456789abcdef.tmp", ".zondas", "results/.zondas.tmp"]) {
    assert.throws(
      () => patikrintiRakta(vardas),
      (klaida) => klaida.code === "ARTIFACT_KEY_INVALID",
      `${vardas}: tašku prasidedantis segmentas negali būti raktas`
    );
  }
});
