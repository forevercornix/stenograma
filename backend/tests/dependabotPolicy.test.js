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

test("#367: Python grupė priima TIK deklaruotus serviso paketus, be wildcard", () => {
  /**
   * ⚠️ SVARBIAUSIA ASERCIJA, IR JI PERRAŠYTA PO CODEX RAUNDO.
   *
   * Pirmoji redakcija tikrino `patterns.includes(paketas)` prieš ML paketų sąrašą.
   * Ji buvo apeinama VIENA EILUTE: įrašius `torch*` ar `nvidia-*`, Dependabot tuos
   * paketus ATITIKTŲ, o testas liktų žalias — jis atmesdavo tik literalus ir
   * vienišą `*`. Vienintelis politikos liudytojas nukaunamas pakeitimu, kuris
   * atrodo kaip natūralus praplėtimas.
   *
   * ⚠️ TAISYKLĖ DABAR IŠVEDAMA, NE SĄRAŠINĖ, ir ji uždaro klasę, ne atvejus:
   *
   *   1. šablonas privalo būti PAŽODINIS - jokio `*`, `?`, `[`, `]`;
   *   2. leidžiamų vardų aibė privalo būti DEKLARUOTO serviso rinkinio POAIBIS.
   *
   * Iš to seka, kad į grupę negali patekti JOKS paketas, kurio čia nėra - nei
   * `torch`, nei `transformers`, nei toks, kurio dar niekas nežino. ML paketų
   * sąrašo nebereikia, ir tai sąmoningas pasirinkimas: perteklinis sąrašas sensta,
   * o uždara aibė - ne.
   *
   * ⚠️ Išmatuota prieš rašant: dabartinėje konfigūracijoje wildcard'ų yra NULIS,
   * tad draudimas nieko teisėto nelaužo.
   *
   * ⚠️ Pridėjus TEISĖTĄ naują serviso paketą (pvz. `starlette`), šis testas kris.
   * Tai NE trūkumas: jis verčia priimti sąmoningą sprendimą, o ne tyliai praplėsti
   * grupę.
   */
  const SERVISO_PAKETAI = new Set(["fastapi", "uvicorn", "python-multipart", "pytest"]);
  const WILDCARD = /[*?[\]]/;

  let tikrinta = 0;

  for (const { u, vardas, cfg } of grupes(politika())) {
    if (u["package-ecosystem"] !== "pip") continue;

    const sablonai = cfg.patterns;
    assert.ok(
      Array.isArray(sablonai) && sablonai.length > 0,
      `${u.directory}/${vardas}: Python grupė PRIVALO turėti leidimo sąrašą; be jo ji priima viską`
    );

    for (const sablonas of sablonai) {
      /**
       * ⚠️ PRANEŠIMAS NURODO IŠEITĮ, IR TAI NE MANDAGUMAS.
       *
       * Žmogus, pridėjęs teisėtą serviso paketą, pamatys raudoną testą ir turės
       * du kelius: suprasti dviejų žingsnių taisymą arba ĮRAŠYTI WILDCARD.
       * Antrasis yra tiksliai tai, ką ši taisyklė uždaro — ir jis GREITESNIS.
       * Pranešimas nusprendžia, kuriuo keliu jis eis.
       */
      const ISEITIS =
        "Pridedant TEISĖTĄ serviso paketą: įrašyk jį į `SERVISO_PAKETAI` ŠIAME teste " +
        "IR į grupės `patterns` konfigūracijoje. Wildcard NELEIDŽIAMAS - jis įsileistų " +
        "ir ML/inference paketus, kurių niekas nesvarstė.";

      assert.equal(
        WILDCARD.test(sablonas),
        false,
        `${u.directory}/${vardas}: šablonas ${JSON.stringify(sablonas)} turi wildcard - ` +
          `leidimo sąrašas naudoja PAŽODINIUS vardus. ${ISEITIS}`
      );
      assert.ok(
        SERVISO_PAKETAI.has(sablonas),
        `${u.directory}/${vardas}: ${JSON.stringify(sablonas)} nėra deklaruotas serviso paketas - ` +
          `ML/inference grandinė privalo likti izoliuota. ${ISEITIS}`
      );
      tikrinta += 1;
    }
  }

  assert.ok(tikrinta >= 8, `prielaida: Python grupių šablonų yra (rasta ${tikrinta})`);
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
