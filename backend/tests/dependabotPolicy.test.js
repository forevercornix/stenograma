const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");

/**
 * DEPENDABOT POLITIKOS SARGAS (#367).
 *
 * ⚠️ KODĖL ŠIS FAILAS EGZISTUOJA.
 *
 * `.github/dependabot.yml` struktūros netikrino NIEKAS, ir tai turėjo matomą
 * kainą: `numpy` `ignore` blokas atsidūrė PO `github-actions` komentaro. YAML
 * komentarų nemato, tad jis prisirišo prie `whisper-server` — efektas buvo
 * teisingas, bet skaitytojas suprasdavo priešingai, ir niekas nekrito.
 *
 * ⚠️ TAI KONFIGŪRACIJOS, NE ELGSENOS SARGAS. Jis NEGALI įrodyti, ką Dependabot
 * realiai padarys — tik kad konfigūracija išreiškia tai, ką teigia politika.
 * Elgsenos įrodymas ateina tik iš realaus Dependabot ciklo.
 *
 * ⚠️ TRYS IŠ PENKIŲ ASERCIJŲ TIKRINA TEIGINIUS, KURIE KITAIP BŪTŲ TIK KOMENTARAI:
 * „major negali patekti į grupę", „security negrupuojamas", „ML/GPU izoliuota".
 * #367 to eksplicitiškai ir reikalauja — įrodoma konfigūracija, ne deklaracija.
 */

const KELIAS = path.resolve(__dirname, "..", "..", ".github", "dependabot.yml");

function politika() {
  return yaml.parse(fs.readFileSync(KELIAS, "utf8"));
}

function grupes(d) {
  return d.updates.flatMap((u) =>
    Object.entries(u.groups || {}).map(([vardas, cfg]) => ({ u, vardas, cfg }))
  );
}

test("#367: KIEKVIENA grupė ribojama iki `minor`/`patch` — major negali patekti PAGAL KONSTRUKCIJĄ", () => {
  /**
   * ⚠️ DEKLARACIJA AR PAVADINIMŲ KONVENCIJA NEPAKANKA. Grupė be `update-types`
   * priima VISKĄ, įskaitant major — o tada `eslint` 9→10 keliautų kartu su
   * patch'ais, ir lūžtantis pakeitimas pasislėptų grupiniame diff'e.
   */
  const rasta = grupes(politika());
  assert.ok(rasta.length > 0, "prielaida: grupių yra");

  for (const { u, vardas, cfg } of rasta) {
    const tipai = cfg["update-types"];
    assert.ok(Array.isArray(tipai), `${u.directory}/${vardas}: update-types PRIVALOMAS`);
    assert.deepEqual(
      [...tipai].sort(),
      ["minor", "patch"],
      `${u.directory}/${vardas}: major turi būti neįmanomas konstrukcija`
    );
  }
});

test("#367: nė viena grupė NEKEIČIA security PR semantikos", () => {
  /**
   * ⚠️ TIKSLAS - NEĮVESTI SECURITY GRUPAVIMO NETYČIA.
   *
   * `groups:` pagal nutylėjimą taikomas version updates, bet GitHub palaiko
   * `applies-to: security-updates`. Security PR paleidžia advisory, ne
   * `schedule`, ir jiems `open-pull-requests-limit` netaikomas — sugrupavus juos,
   * pažeidžiamumo pataisymas lauktų kitų grupės narių.
   *
   * Todėl reikalaujama EKSPLICITINĖ reikšmė: numatytoji būtų teisinga, bet tyli,
   * ir ateities redagavimas jos nepakeistų matomai.
   */
  for (const { u, vardas, cfg } of grupes(politika())) {
    assert.equal(
      cfg["applies-to"],
      "version-updates",
      `${u.directory}/${vardas}: security PR semantika privalo likti nepakitusi`
    );
  }
});

test("#367: izoliuota runtime infrastruktūra NEPATENKA į backend production grupę", () => {
  /**
   * `bullmq` regresija nepasimato lint'e — ji pasimato kaip pakibęs job'as.
   * `express-rate-limit` yra saugumui jautrus kelias. Grupėje abu dingtų tarp
   * kitų diff'ų.
   */
  const d = politika();
  const backend = d.updates.find((u) => u["package-ecosystem"] === "npm" && u.directory === "/backend");
  assert.ok(backend, "prielaida: backend npm įrašas yra");

  const isimtys = backend.groups["backend-production"]["exclude-patterns"] || [];
  for (const paketas of ["bullmq", "express-rate-limit"]) {
    assert.ok(isimtys.includes(paketas), `${paketas} privalo likti izoliuotas`);
  }
});

test("#367: ML/GPU grandinė negali patekti į Python grupę — TIKRINAMA IR SU BŪSIMAIS PAKETAIS", () => {
  /**
   * ⚠️ SVARBIAUSIA ASERCIJA, IR JI TIKRINA TAISYKLĘ, NE SĄRAŠĄ.
   *
   * Python grupės naudoja LEIDIMO sąrašą (`patterns`), ne draudimo. Skirtumas
   * matomas tik su paketu, kurio ŠIANDIEN NĖRA: `torch` ar `transformers`
   * draudimų sąraše neatsirastų ir tyliai patektų į bendrą grupę. Su leidimo
   * sąrašu jie lieka atskiru PR PAGAL NUTYLĖJIMĄ — fail-closed.
   *
   * Todėl tarp tikrinamų yra ir paketų, kurių repo neturi. Jie čia NE per klaidą.
   */
  const ESAMI = [
    "onnxruntime", "ctranslate2", "tokenizers", "huggingface-hub", "hf_transfer",
    "faster-whisper", "pyannote.audio", "nvidia-cublas-cu12", "nvidia-cudnn-cu12",
    "numpy", "av",
  ];
  const BUSIMI = ["torch", "transformers", "accelerate", "nvidia-cuda-runtime-cu12"];

  for (const { u, vardas, cfg } of grupes(politika())) {
    if (u["package-ecosystem"] !== "pip") continue;

    const sablonai = cfg.patterns;
    assert.ok(
      Array.isArray(sablonai) && sablonai.length > 0,
      `${u.directory}/${vardas}: Python grupė PRIVALO turėti leidimo sąrašą; be jo ji priima viską`
    );
    assert.equal(
      sablonai.includes("*"),
      false,
      `${u.directory}/${vardas}: \`*\` paverstų leidimo sąrašą draudimo sąrašu`
    );

    for (const paketas of [...ESAMI, ...BUSIMI]) {
      assert.equal(
        sablonai.includes(paketas),
        false,
        `${u.directory}/${vardas}: ${paketas} yra ML/inference grandinėje ir privalo likti izoliuotas`
      );
    }
  }
});

test("#367: kiekvienas `ignore` pririštas prie katalogo, kuriame priklausomybė REALIAI yra", () => {
  /**
   * ⚠️ TAI SARGAS TAM DEFEKTUI, KURIS IR DAVĖ #367 ŠĮ PUNKTĄ.
   *
   * Pasiklydęs blokas prisiriša prie gretimo įrašo TYLIAI. Struktūrinė patikra
   * („ar `ignore` yra") to nepagautų — reikia patikrinti, ar ignoruojama
   * priklausomybė to katalogo lock failuose apskritai egzistuoja.
   */
  const d = politika();
  const saknis = path.resolve(__dirname, "..", "..");
  let tikrinta = 0;

  for (const u of d.updates) {
    for (const taisykle of u.ignore || []) {
      const katalogas = path.join(saknis, u.directory);
      const lockFailai = ["requirements-cpu.lock.txt", "requirements-gpu.lock.txt", "requirements.txt"]
        .map((f) => path.join(katalogas, f))
        .filter((f) => fs.existsSync(f));

      assert.ok(lockFailai.length > 0, `${u.directory}: \`ignore\` kataloge be requirements failų`);

      const rasta = lockFailai.some((f) =>
        new RegExp(`^${taisykle["dependency-name"]}\\b`, "mi").test(fs.readFileSync(f, "utf8"))
      );
      assert.ok(
        rasta,
        `${u.directory}: ignoruojamas \`${taisykle["dependency-name"]}\`, bet jo čia NĖRA — ` +
          "blokas greičiausiai prisirišo ne prie to įrašo"
      );
      tikrinta += 1;
    }
  }

  assert.ok(tikrinta >= 3, `prielaida: ignore taisyklių yra (rasta ${tikrinta})`);
});
