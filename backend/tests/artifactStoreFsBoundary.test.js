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

test("gedimas PO `rename` nepalieka objekto, kurio kvietėjas neregistruos", async (t) => {
  /**
   * ⚠️ NESĖKMINGAS `put()` NETURI PALIKTI NEREFERENCUOTO ARTEFAKTO.
   *
   * `rename` jau įvyko, bet katalogo `fsync` krito — `put()` meta, kvietėjas
   * nuorodos nepersistina, o objektas lieka gulėti. DB krypties inventorius
   * (A3) jo NEBERANDA pagal apibrėžimą: tai jautrus turinys be savininko.
   *
   * ⚠️ GEDIMAS ĮTERPIAMAS PER `fsp.open`, nes kito seamo nėra: katalogo `fsync`
   * vyksta saugyklos viduje. Pataisa grąžinama `finally` bloke; `node:test`
   * failus vykdo atskiruose procesuose, tad pataisa neišeina už šio failo.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/nutruko.json";

  const tikrasOpen = fsp.open;
  let sugadinti = true;
  fsp.open = async (kelias, veliavos, ...kita) => {
    if (veliavos === "r" && sugadinti) {
      sugadinti = false;
      const klaida = new Error("suklastotas katalogo `fsync` gedimas");
      klaida.code = "EIO";
      throw klaida;
    }
    return tikrasOpen(kelias, veliavos, ...kita);
  };

  try {
    await assert.rejects(() => saugykla.put(raktas, { text: "nutrūkęs" }), /EIO|suklastotas/);
  } finally {
    fsp.open = tikrasOpen;
  }

  assert.equal(
    await saugykla.head(raktas),
    null,
    "nesėkmingas `put()` privalo nepalikti objekto — kitaip lieka artefaktas be savininko"
  );

  const likuciai = await fsp.readdir(path.join(saknis, "results")).catch(() => []);
  assert.deepEqual(likuciai, [], "nei objekto, nei laikino failo");
});

test("gedimas PO `rename` NENAIKINA objekto, kuris jau buvo tuo adresu", async (t) => {
  /**
   * ⚠️ RIBA UŽRAŠOMA, O NE PRAPLEČIAMA. Jei tuo adresu objektas jau buvo, jo
   * turinys po `rename` jau pakeistas, ir atstatyti jo nebėra iš ko. Trynimas
   * čia prarastų duomenis; paliekamas naujas turinys, o `put()` vis tiek praneša
   * nesėkmę — patvarumo jis patvirtinti negali.
   */
  const { saknis, isvalyti } = await aplinka();
  t.after(isvalyti);

  const saugykla = createFsArtifactStore({ root: saknis });
  const raktas = "results/buvo.json";
  await saugykla.put(raktas, { text: "pirmas" });

  const tikrasOpen = fsp.open;
  let sugadinti = true;
  fsp.open = async (kelias, veliavos, ...kita) => {
    if (veliavos === "r" && sugadinti) {
      sugadinti = false;
      const klaida = new Error("suklastotas katalogo `fsync` gedimas");
      klaida.code = "EIO";
      throw klaida;
    }
    return tikrasOpen(kelias, veliavos, ...kita);
  };

  try {
    await assert.rejects(() => saugykla.put(raktas, { text: "antras" }), /EIO|suklastotas/);
  } finally {
    fsp.open = tikrasOpen;
  }

  assert.ok(await saugykla.head(raktas), "esamas adresas NEIŠVALOMAS — tai būtų duomenų praradimas");
});
