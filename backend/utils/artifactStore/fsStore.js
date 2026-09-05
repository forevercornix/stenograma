const fsp = require("node:fs/promises");
const path = require("node:path");
const { createLogger } = require("../logger");
const crypto = require("node:crypto");

const {
  ArtifactStoreError,
  KLAIDA,
  patikrintiRakta,
  paruostiReiksme,
  atkurtiReiksme,
  nesancioVerdiktas,
  neverifikuojamasVerdiktas,
  normalizuotiLaukima,
  vientisumoVerdiktas,
} = require("./validation");
const { getLimits, LIMIT_KIND } = require("../resultLimits");

const log = createLogger("artifact-fs");

/**
 * `FsArtifactStore` - artefaktai konfigūruotame filesystem kataloge (#157, PR-2).
 *
 * ⚠️ TAI NE `utils/fileStorage.js` PAKAITALAS. Ta saugykla laiko ĮKELTĄ AUDIO
 * (`source_audio`), turi savo generacijas ir savo raktų semantiką. Čia gyvena
 * REZULTATAI, ir jų raktus sudaro `job_results` reference. Suliejus abi, vienas
 * ištrynimo kelias imtų trinti kito artefaktus.
 *
 * ⚠️ RAŠYMAS ATOMINIS: laikinas failas + `fsync` + `rename` + katalogo `fsync`.
 *
 * Vien `rename` apsaugo nuo nutrūkusio PROCESO, bet ne nuo mašinos gedimo: be
 * `fsync` kai kuriose failų sistemose po avarijos lieka NULINIO ILGIO failas su
 * teisingu vardu - blogiau nei pusiau parašytas, nes `head` jį rodo kaip
 * egzistuojantį. Todėl sinchronizuojamas ir failas (prieš `rename`), ir katalogas
 * (po jo): antrasis įpareigoja patį įrašą kataloge.
 *
 * ⚠️ LAIKINAS FAILAS - TAME PAČIAME KATALOGE, ne `os.tmpdir()`. `rename` per
 * įrenginių ribą duotų `EXDEV`, ir atomiškumo nebeliktų iš viso.
 */

function createFsArtifactStore({ root } = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new ArtifactStoreError(
      "FsArtifactStore: reikia `root` katalogo. Be jo saugykla rašytų į nenumatytą vietą.",
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  const saknis = path.resolve(root);

  /**
   * ⚠️ FAILŲ SISTEMOS ŠAKNIS (`/`) ATMETAMA IŠ KARTO (Codex, #290).
   *
   * Su `saknis === "/"` sulaikymo patikra lygintų su `"//"`, ir nė vienas
   * teisėtas raktas jos nepraeitų — saugykla atrodytų veikianti, bet atmestų
   * VISKĄ su `ARTIFACT_KEY_INVALID`. Be to artefaktų šaknis, sutampanti su
   * failų sistemos šaknimi, reikštų, kad `delete()` vaikšto po visą mašiną.
   *
   * Pasirinkta uždrausti, o ne palaikyti: tai konfigūracijos klaida, ir tyliai
   * ją „palaikyti" reikštų priimti diegimą, kurio niekas nenorėjo.
   */
  if (path.dirname(saknis) === saknis) {
    throw new ArtifactStoreError(
      `FsArtifactStore: \`root\` negali būti failų sistemos šaknis ("${saknis}"). ` +
        "Nurodykite atskirą katalogą artefaktams.",
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  /**
   * ⚠️ SULAIKYMAS TIKRINAMAS PER `path.relative`, NE PER EILUČIŲ PREFIKSĄ.
   *
   * Prefiksų palyginimas priklauso nuo to, ar kelias baigiasi skirtuku, ir
   * būtent tai sulaužė šaknies atvejį. `relative` atsako į tikrąjį klausimą:
   * ar kelias yra šaknies palikuonis.
   */
  function viduje(kelias, saknisKelias) {
    const santykis = path.relative(saknisKelias, kelias);
    return santykis === "" || (!santykis.startsWith("..") && !path.isAbsolute(santykis));
  }

  /**
   * ⚠️ ANTRA RIBOS PATIKRA, IR JI SĄMONINGA.
   *
   * `patikrintiRakta()` jau atmetė viską, kas nėra siauras allowlist'as, tad ši
   * niekada neturėtų suveikti. Bet ji kainuoja vieną palyginimą ir gina nuo
   * ateities: jei kas nors kada praplės leistinų raktų aibę, filesystem pusė
   * neturi tapti pirmąja auka. Gynyba gilumoje, ne dubliavimas.
   */
  function leksinisKelias(raktas) {
    const pilnas = path.resolve(saknis, patikrintiRakta(raktas));

    if (!viduje(pilnas, saknis)) {
      throw new ArtifactStoreError(
        "FsArtifactStore: raktas išveda už saugyklos šaknies.",
        KLAIDA.RAKTAS
      );
    }

    return pilnas;
  }

  /**
   * ŠAKNIES GYVAVIMO CIKLAS — PATIKRINAMAS VIENĄ KARTĄ, PRIEŠ BET KURIĄ OPERACIJĄ
   * (Codex, #290).
   *
   * ⚠️ NEGALIOJANTI ŠAKNIS ATRODĖ KAIP PRARASTI DUOMENYS.
   *
   * Kai `ARTIFACT_FS_ROOT` nurodydavo į paprastą FAILĄ, `realpath` mesdavo
   * `ENOTDIR`, o operacijos jį laikydavo „objekto nėra": `head()` grąžindavo
   * `null`, `read()` — `ARTIFACT_NOT_FOUND`, `verify()` — nesančio objekto
   * verdiktą. Konfigūracijos klaida taip apsimeta dingusiais vartotojo duomenimis
   * ir siunčia remontą atkūrimo keliu, nors saugyklos apskritai nėra.
   *
   * ⚠️ TRŪKSTAMA ŠAKNIS SUKURIAMA IR ĮTVIRTINAMA. `mkdir` grąžina sėkmę, kai įrašas
   * dar tik page cache: be tėvo `fsync` maitinimo dingimas po `put()` gali pasiimti
   * VISĄ naujai sukurtą artefaktų šaknį. Todėl sukuriama su `0700` ir sinchronizuo-
   * jamas jos tėvas.
   *
   * ⚠️ REZULTATAS ĮSIMENAMAS, BET KLAIDA — NE: nepavykusi patikra kartojama kitam
   * kvietimui, kad laikina problema nepaverstų saugyklos nuolat sugedusia.
   */
  let saknisParuosta = null;

  async function paruostiSakni() {
    if (saknisParuosta) return saknisParuosta;

    saknisParuosta = (async () => {
      let info = null;
      try {
        info = await fsp.stat(saknis);
      } catch (klaida) {
        if (klaida.code !== "ENOENT" && klaida.code !== "ENOTDIR") throw klaida;
      }

      if (info && !info.isDirectory()) {
        throw new ArtifactStoreError(
          `FsArtifactStore: \`root\` ("${saknis}") nėra katalogas. Tai saugyklos ` +
            "konfigūracijos klaida, o ne dingęs artefaktas.",
          "ARTIFACT_CONFIG_INVALID"
        );
      }

      if (!info) {
        const naujiSaknies = await trukstamosDalys(saknis, path.parse(saknis).root);
        try {
          await fsp.mkdir(saknis, { recursive: true, mode: 0o700 });
        } catch (klaida) {
          if (klaida.code === "ENOTDIR" || klaida.code === "EEXIST") {
            throw new ArtifactStoreError(
              `FsArtifactStore: \`root\` ("${saknis}") sukurti nepavyko: kelyje yra ne katalogas.`,
              "ARTIFACT_CONFIG_INVALID"
            );
          }
          throw klaida;
        }

        /** Ir naujos šaknies įrašas tėve — kitaip ji dingtų kartu su neįrašytu įrašu. */
        for (const naujas of naujiSaknies) {
          await sinchronizuotiKatalaga(path.dirname(naujas));
        }
      }

      return fsp.realpath(saknis);
    })().catch((klaida) => {
      saknisParuosta = null;
      throw klaida;
    });

    return saknisParuosta;
  }

  /**
   * ⚠️ RIBA TIKRINAMA PER ARČIAUSIĄ ESANTĮ PROTĖVĮ (Codex, #290).
   *
   * ⚠️ ANKSTESNĖ REDAKCIJA TIKRINO TIK PATĮ TAIKINĮ. Kai `<šaknis>/results` yra
   * symlink'as į išorę, o `results/job/` dar nėra, `realpath` taikiniui grąžindavo
   * `ENOENT` — riba praleisdavo, `mkdir` sekdavo symlink'ą, ir katalogas
   * atsirasdavo UŽ šaknies dar prieš tai, kai raktas būdavo atmestas. Rašymas
   * nepavykdavo, bet pėdsakas svetimoje vietoje likdavo.
   *
   * Einant nuo taikinio aukštyn iki pirmo ESANČIO kelio elemento, symlink'as
   * pasimato visada — nesvarbu, kiek gilus taikinys ir ar jo dar nėra.
   *
   * ⚠️ PAGRINDINIS ARGUMENTAS — NE ATAKA, O NUOSEKLUMAS (§16):
   * `fileStorage._resolveExisting()` šiame repo jau uždaro tą pačią klasę per
   * `realpath`. Dvi saugyklos ribos su skirtinga traversal semantika yra
   * nenuoseklumas, ir jis pasimato per bendrą volume tarp konteinerių ar restore,
   * ne per ataką.
   *
   * ⚠️ TOCTOU LIEKA. `realpath` riziką sumažina, bet nepašalina: kelias gali
   * pasikeisti tarp patikros ir operacijos. Teigti daugiau, nei kodas daro, būtų
   * §12.1 pažeidimas.
   */
  async function tikrasKelias(pilnas, tikraSaknis) {
    let dabartinis = pilnas;

    for (;;) {
      let tikras;
      try {
        tikras = await fsp.realpath(dabartinis);
      } catch (klaida) {
        /**
         * ⚠️ ŽALIAS `ENAMETOOLONG` NEIŠEINA PRO RIBĄ (Codex, #290).
         *
         * Riba raktų segmentus riboja 255 baitais — tiek leidžia `NAME_MAX` ext4,
         * XFS ir APFS. Bet konkreti failų sistema (ar overlay konteineryje) gali
         * turėti mažesnę ribą, ir tada raktas, kurį kontraktas priima, čia vis tiek
         * neįmanomas. Kvietėjui tai privalo atrodyti kaip rakto atmetimas, o ne
         * kaip svetimo tipo I/O klaida.
         */
        if (klaida.code === "ENAMETOOLONG") {
          throw new ArtifactStoreError(
            "FsArtifactStore: raktas per ilgas šiai failų sistemai (`ENAMETOOLONG`).",
            KLAIDA.RAKTAS
          );
        }

        if (klaida.code !== "ENOENT" && klaida.code !== "ENOTDIR") throw klaida;

        const tevas = path.dirname(dabartinis);
        /** Šaknis egzistuoja (`paruostiSakni`), tad ciklas visada ja ir baigiasi. */
        if (tevas === dabartinis) return pilnas;
        dabartinis = tevas;
        continue;
      }

      if (!viduje(tikras, tikraSaknis)) {
        throw new ArtifactStoreError(
          "FsArtifactStore: raktas per symlink išveda už saugyklos šaknies.",
          KLAIDA.RAKTAS
        );
      }

      return pilnas;
    }
  }

  /**
   * VIENINTELIS KELIO ŠALTINIS - PER JĮ EINA KIEKVIENA OPERACIJA (Codex, #290).
   *
   * ⚠️ ANKSČIAU RIBA BUVO TAIKOMA PER OPERACIJĄ, NE PER VARTUS.
   *
   * `head` ir `put` `realpath` patikrą darė, o `read`, `readStream`, `verify` ir
   * `delete` ėmė LEKSINĮ kelią. Trys iš jų buvo apsaugotos ATSITIKTINAI - jos
   * pirma kviečia `head()`, tad riba suveikdavo joje; `delete` `head()` nekviečia,
   * ir būtent jis symlink'ą per katalogą praleisdavo iki galo, ištrindamas failą
   * UŽ saugyklos šaknies.
   *
   * ⚠️ APSAUGA STRUKTŪRINĖ, NE DRAUSMĖS. `leksinisKelias()` už šios funkcijos ribų
   * nekviečiamas niekur, tad operacija be resolverio kelio paprasčiausiai NETURI.
   * Ji taip pat yra vienintelė vieta, kur laukiama šaknies paruošimo — negaliojanti
   * konfigūracija sustabdo KIEKVIENĄ operaciją, ne tik rašymą.
   */
  async function keliasSaugus(raktas) {
    const tikraSaknis = await paruostiSakni();
    return tikrasKelias(leksinisKelias(raktas), tikraSaknis);
  }

  /**
   * ⚠️ NAUJI KATALOGAI IRGI PRIVALO BŪTI PATVARŪS (Codex, #290).
   *
   * `mkdir(..., { recursive: true })` grąžina sėkmę, kai įrašai dar tik page
   * cache. Po maitinimo dingimo failas gali būti patvarus, o KATALOGAS, kuriame
   * jis guli - ne: rezultatas dingsta kartu su neįrašytu katalogo įrašu.
   *
   * ⚠️ PUSIAU ATLIKTAS PATVARUMAS BLOGESNIS UŽ JOKĮ: `put()` grąžina sėkmę,
   * kurios negali patvirtinti. Todėl sekamos BŪTENT naujai sukurtos dalys, o jau
   * egzistuojantiems katalogams `fsync` nedaromas — nemokamos kainos
   * nedidiname.
   *
   * @returns {string[]} naujai sukurtų katalogų keliai, giliausias pirmas
   */
  async function trukstamosDalys(katalogas, riba) {
    const nauji = [];
    let dabartinis = katalogas;

    /** Randame, kiek kelio dalių dar nėra — nuo giliausios aukštyn. */
    while (dabartinis !== riba && viduje(dabartinis, riba) && path.dirname(dabartinis) !== dabartinis) {
      try {
        await fsp.stat(dabartinis);
        break;
      } catch (klaida) {
        if (klaida.code !== "ENOENT") throw klaida;
        nauji.push(dabartinis);
        dabartinis = path.dirname(dabartinis);
      }
    }

    return nauji;
  }

  async function sukurtiKatalogus(katalogas) {
    const nauji = await trukstamosDalys(katalogas, saknis);

    /** ⚠️ `0700`: artefaktų katalogai neturi būti apeinami kitų vietinių paskyrų. */
    await fsp.mkdir(katalogas, { recursive: true, mode: 0o700 });
    return nauji;
  }

  /** `fsync` katalogui — įpareigoja jo ĮRAŠUS, ne jų turinį. */
  async function sinchronizuotiKatalaga(kelias) {
    const deskriptorius = await fsp.open(kelias, "r");
    try {
      await deskriptorius.sync();
    } finally {
      await deskriptorius.close();
    }
  }

  async function put(raktas, reiksme) {
    const pilnas = await keliasSaugus(raktas);
    const paruosta = paruostiReiksme(reiksme);

    /**
     * ⚠️ RIBA JAU PATIKRINTA PRIEŠ `mkdir` (Codex, #290).
     *
     * `keliasSaugus()` išsprendžia arčiausią ESANTĮ protėvį, tad symlink'as
     * pasimato dar prieš tai, kai atsiranda pirmas naujas katalogas. Ankstesnė
     * redakcija tikrino po `mkdir` — ir palikdavo katalogus UŽ šaknies net tada,
     * kai raktas galiausiai būdavo atmestas.
     */
    const sukurti = await sukurtiKatalogus(path.dirname(pilnas));

    /**
     * ⚠️ AR OBJEKTAS TUO ADRESU JAU BUVO - KLAUSIAMA PRIEŠ `rename`.
     *
     * Nuo atsakymo priklauso, ką daryti su gedimu PO `rename`: šviežią objektą
     * privalu pašalinti (kvietėjas jo neregistruos), o buvusį - palikti, nes
     * atstatyti seno turinio nebėra iš ko.
     */
    const buvoAnksciau = (await head(raktas)) !== null;

    /**
     * ⚠️ LAIKINAS VARDAS NEPRIKLAUSO NUO RAKTO (Codex, #290).
     *
     * `<raktas>.<uuid>.tmp` pridėdavo 41 simbolį prie failo vardo, o failų
     * sistemos riba yra 255 baitai VIENAM vardui. Riba raktą iki 512 simbolių
     * priima, tad `put()` krisdavo su `ENAMETOOLONG` dėl MŪSŲ sufikso, o ne dėl
     * sistemos ribos - išmatuota nuo 214 simbolių segmento.
     *
     * Trumpas nepriklausomas vardas tą klasę pašalina. Kaina: laikinas failas
     * nebenurodo savo rakto — bet `.tmp` likučiai ir taip yra orphan klausimas,
     * sprendžiamas PR-4 kartu su nutrūkusiais bandymais, o ne vardo forma.
     */
    const laikinas = path.join(path.dirname(pilnas), `.${crypto.randomBytes(8).toString("hex")}.tmp`);
    let deskriptorius = null;
    let pervadinta = false;

    try {
      /**
       * ⚠️ `0600`, NE `umask` MALONĖ (Codex, #290).
       *
       * Be eksplicitinio režimo Node naudoja `0o666 & ~umask`; su įprastu `022`
       * galutinis artefaktas lieka `0644` — transkripciją perskaito bet kuri
       * vietinė paskyra ar sidecar, pasiekiantis tą volume. Teisės nustatomos
       * LAIKINAM failui, nes `rename` jas išsaugo: taip turinys niekada, net
       * milisekundę, nebūna platesnis, nei turi būti.
       */
      deskriptorius = await fsp.open(laikinas, "wx", 0o600);
      await deskriptorius.writeFile(paruosta.buferis);
      await deskriptorius.sync();
      await deskriptorius.close();
      deskriptorius = null;

      await fsp.rename(laikinas, pilnas);
      pervadinta = true;

      /**
       * ⚠️ KATALOGO `fsync` PO `rename`.
       *
       * Failo turinys jau patvarus, bet pats ĮRAŠAS kataloge - dar ne. Be šio
       * žingsnio po avarijos objektas gali dingti visai, nors `rename` grąžino
       * sėkmę.
       */
      await sinchronizuotiKatalaga(path.dirname(pilnas));

      /**
       * ⚠️ IR NAUJŲ KATALOGŲ TĖVAI. Grandinė patvari tiek, kiek silpniausia jos
       * grandis: neįrašytas `results/` įrašas pasiima kartu ir visą `<jobId>/`
       * pomedį. Einama nuo giliausio aukštyn, kad kiekvienas įrašas būtų
       * įpareigotas savo tėve.
       */
      for (const naujas of sukurti) {
        await sinchronizuotiKatalaga(path.dirname(naujas));
      }
    } catch (klaida) {
      if (deskriptorius) await deskriptorius.close().catch(() => {});

      /**
       * ⚠️ VALYMAS YRA GARANTIJA, NE GERAS NORAS (Codex, #290).
       *
       * ⚠️ GEDIMAS PO `rename` PALIEKA OBJEKTĄ, KURIO NIEKAS NEREGISTRUOS.
       * `put()` meta, tad kvietėjas nuorodos nepersistina — o objektas lieka
       * gulėti. DB krypties inventorius (A3) jo NEBERANDA pagal apibrėžimą:
       * jautrus turinys be savininko, tiksliai ta orphan klasė, kurią #157
       * uždarinėja.
       *
       * Ankstesnė redakcija darė `rm(...).catch(() => {})`: nesėkmė dingdavo
       * TYLIAI, o pavykęs trynimas likdavo neįtvirtintas — po maitinimo dingimo
       * failas galėjo GRĮŽTI galutiniu vardu, nors `put()` metė. Best-effort
       * valymas ištrynimo garantijų grandinėje yra tas pats, kas jokio valymo.
       *
       * Todėl: trynimas tikrinamas, katalogas po jo sinchronizuojamas, o valymo
       * nesėkmė PRANEŠAMA kvietėjui atskiru kodu — kitaip apie likusį jautrų
       * objektą nesužinotų niekas.
       *
       * ⚠️ BUVĘS OBJEKTAS NENAIKINAMAS. Jei tuo adresu jau kažkas gulėjo, jo
       * turinys po `rename` jau pakeistas, ir atstatyti nebėra iš ko; trynimas
       * prarastų duomenis. Riba užrašoma, o ne praplečiama.
       */
      const valytini = [];
      if (!pervadinta) valytini.push(laikinas);
      if (pervadinta && !buvoAnksciau) valytini.push(pilnas);

      const neisvalyta = [];

      for (const kelias of valytini) {
        try {
          await fsp.rm(kelias, { force: true });
          /** Ir pats IŠTRYNIMAS privalo būti patvarus — kitaip failas grįžta. */
          await sinchronizuotiKatalaga(path.dirname(kelias));
        } catch (valymoKlaida) {
          neisvalyta.push({ kelias, kodas: valymoKlaida.code || valymoKlaida.name });
        }
      }

      if (neisvalyta.length > 0) {
        /**
         * ⚠️ SAUGŪS METADUOMENYS: raktas ir klaidos kodas, jokio turinio. Raktas
         * yra adresas (`results/<jobId>/<attemptId>.json`), tad jis operatoriui
         * ir reikalingas — būtent jį reikės pašalinti rankomis.
         */
        log.error("Artefakto valymas po nepavykusio rašymo NEPAVYKO", {
          stage: "artifact_cleanup",
          backend: "fs",
          raktas,
          neisvalyta: neisvalyta.map((n) => n.kodas),
        });

        throw new ArtifactStoreError(
          `FsArtifactStore: rašymas nepavyko, o po jo likusio objekto "${raktas}" pašalinti ` +
            "nepavyko. Saugykloje gali likti NEREFERENCUOTAS artefaktas — jį reikia pašalinti.",
          KLAIDA.LIKO_ARTEFAKTAS,
          { cause: klaida }
        );
      }

      throw klaida;
    }

    /**
     * ⚠️ `key` IR `reference` YRA DU SKIRTINGI DALYKAI (#157, PR-2).
     *
     * `key` — ADRESAS, kuriuo saugykla randa objektą (`read`, `head`, `delete`).
     * `reference` — tai, kas persistinama į `job_results.storage_key`.
     *
     * Išorinėse saugyklose jie sutampa, tad atskyrimas atrodo perteklinis. Bet
     * `inline` eilutėje `storage_key` PRIVALO būti `NULL` (PR-1 invariantas), o
     * adresas vis tiek reikalingas — vadinasi vienas laukas negali reikšti abiejų.
     * Be šio atskyrimo inline implementacija arba išgalvotų sentinelį, arba
     * kvietėjas turėtų ATSIMINTI jo nerašyti — o tokia atmintis gyvena tol, kol
     * ateina kitas žmogus.
     */
    return { key: raktas, reference: raktas, bytes: paruosta.bytes, checksum: paruosta.checksum };
  }

  async function head(raktas) {
    const pilnas = await keliasSaugus(raktas);

    try {
      const info = await fsp.stat(pilnas);

      /**
       * ⚠️ TIK REGULIARUS FAILAS YRA OBJEKTAS (Codex, #290).
       *
       * `stat()` pavyksta ir katalogui, ir socket'ui, ir įrenginiui. Grąžinus
       * `{ exists: true, bytes: 4096 }` katalogui, orphan patikra (A3: `storage_key`
       * -> `head`) nusiramintų ties eilute, kurios objekto NEBĖRA - t. y.
       * dingęs artefaktas atrodytų esantis. Būtent tam `head` ir naudojamas, tad
       * klaidingas teigiamas čia kainuoja daugiau nei bet kur kitur.
       */
      if (!info.isFile()) return null;

      /**
       * ⚠️ `checksum` NEGRĄŽINAMAS, IR TAI KONTRAKTO DALIS.
       *
       * Filesystem jo metaduomenyse neturi - jį gauti reikštų perskaityti visą
       * objektą, o `head` yra leidžiamas VISUOSE keliuose, įskaitant
       * metadata-only. Vientisumo palyginimui yra `verify()`, kuris savo kainą
       * deklaruoja atvirai.
       */
      return { exists: true, bytes: info.size };
    } catch (klaida) {
      if (klaida.code === "ENOENT" || klaida.code === "ENOTDIR") return null;
      throw klaida;
    }
  }

  async function read(raktas) {
    const pilnas = await keliasSaugus(raktas);

    /**
     * ⚠️ TA PATI REGULIARUMO SĄLYGA KAIP `head()`. Be jos `readFile` katalogui
     * duotų `EISDIR`, o kvietėjas gautų svetimo tipo klaidą vietoj
     * `ARTIFACT_NOT_FOUND`.
     */
    if ((await head(raktas)) === null) {
      throw new ArtifactStoreError(`FsArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
    }

    let buferis;
    try {
      buferis = await fsp.readFile(pilnas);
    } catch (klaida) {
      if (klaida.code === "ENOENT") {
        throw new ArtifactStoreError(
          `FsArtifactStore: objekto "${raktas}" nėra.`,
          KLAIDA.NERASTA
        );
      }
      throw klaida;
    }

    return atkurtiReiksme(buferis, raktas);
  }

  async function readStream(raktas) {
    const pilnas = await keliasSaugus(raktas);

    /**
     * ⚠️ FAILAS ATIDAROMAS ANKSTI, NE `createReadStream` VIDUJE (CI 33909325226).
     *
     * Pirmoji redakcija darė `head()` patikrą ir grąžindavo `fs.createReadStream()`.
     * Tas srautas failą atidaro TINGIAI, jau po grąžinimo, tad objektui dingus
     * tarp patikros ir pirmo skaitymo `ENOENT` iškyla kaip `error` ĮVYKIS - ir,
     * jei tuo metu klausytojo dar nėra, virsta `uncaughtException`. CI būtent tai
     * ir parodė: testas krito ne dėl tvirtinimo, o dėl nesugaunamos klaidos.
     *
     * `fsp.open()` klaidą paduoda per `await`, tad ji tampa tipizuota ir
     * SUGAUNAMA. Grąžinamas srautas kuriamas iš JAU atidaryto deskriptoriaus, tad
     * vėlesnis objekto ištrynimas jo nebeliečia (POSIX: inode gyvas, kol atviras).
     *
     * ⚠️ KONTRAKTAS VIS TIEK NEŽADA „visada tipizuota": srautas gali kristi dėl
     * I/O klaidos jau skaitymo metu. Kvietėjas privalo apdoroti ir srauto klaidą.
     *
     * ⚠️ DESKRIPTORIUS UŽSIDARO SU SRAUTU - išmatuota: po srauto pabaigos
     * `fh.read()` grąžina `EBADF`. Tad nutekėjimo nėra, kol srautas suvartojamas
     * arba sunaikinamas.
     */
    if ((await head(raktas)) === null) {
      throw new ArtifactStoreError(`FsArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
    }

    let deskriptorius;
    try {
      deskriptorius = await fsp.open(pilnas, "r");
    } catch (klaida) {
      if (klaida.code === "ENOENT") {
        throw new ArtifactStoreError(`FsArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
      }
      throw klaida;
    }

    return deskriptorius.createReadStream();
  }

  async function verify(raktas, laukiama = {}) {
    /** `head()` jau atmeta neregiuliarius įrašus, tad `verify` jų nepasiekia. */
    const galva = await head(raktas);
    if (!galva) return nesancioVerdiktas(true);

    /**
     * ⚠️ OBJEKTAS SKAITOMAS SRAUTU, NE Į ATMINTĮ (ta pati klasė kaip S3, Codex #290).
     *
     * Filesystem checksum'o metaduomenyse neturi, tad vientisumą galima patvirtinti
     * tik perskaičius — bet objektas, pakeistas ar sugadintas į daug didesnį už
     * persistintą `bytes`, išsemtų atkūrimo procesą BŪTENT tame kelyje, kuris
     * sugadinimą ir turi aptikti. Codex šią klasę rado S3 pusėje; `fs` turėjo tą pačią.
     *
     * Riba: persistintas lūkestis, o jo nesant — `MAX_RESULT_BYTES`. Būtent dėl šios
     * kainos `verify()` metadata-only keliuose DRAUDŽIAMAS.
     *
     * ⚠️ OBJEKTAS GALI DINGTI TARP `head()` IR SKAITYMO. Langas mažas, bet realus:
     * erasure kelias trina lygiagrečiai. Be šito `verify()` mestų žalią `ENOENT`
     * vietoj dokumentuoto „nėra", ir 7.6 ataskaita nutrūktų vietoj eilutės.
     */
    const lauktas = normalizuotiLaukima(laukiama);
    const riba = lauktas.bytes === null ? getLimits()[LIMIT_KIND.RESULT_BYTES] : lauktas.bytes;

    let deskriptorius;
    try {
      deskriptorius = await fsp.open(await keliasSaugus(raktas), "r");
    } catch (klaida) {
      if (klaida.code === "ENOENT" || klaida.code === "ENOTDIR") return nesancioVerdiktas(true);
      throw klaida;
    }

    const maisa = crypto.createHash("sha256");
    let bytes = 0;
    let perzengta = false;

    try {
      const srautas = deskriptorius.createReadStream();

      for await (const gabalas of srautas) {
        bytes += gabalas.byteLength;

        if (bytes > riba) {
          perzengta = true;
          srautas.destroy();
          break;
        }

        maisa.update(gabalas);
      }
    } catch (klaida) {
      if (klaida.code === "ENOENT") return nesancioVerdiktas(true);
      throw klaida;
    } finally {
      await deskriptorius.close().catch(() => {});
    }

    if (perzengta) return neverifikuojamasVerdiktas(true);

    /**
     * ⚠️ `nepriklausomas: true` — LYGINAMA SU IŠORE ĮRAŠYTU METADUOMENIU.
     *
     * Čia `bytes`/`checksum` perskaičiuojami iš objekto ir lyginami su tuo, ką
     * kvietėjas persistino ATSKIRAI (DB pusėje). Tai tikras vientisumo
     * patvirtinimas. `inline` atveju tokio nepriklausomo metaduomens nėra, tad
     * ten vėliava bus `false` — ir 7.6 restore verifikacija privalo tai matyti,
     * o ne laikyti abu atvejus lygiaverčiais.
     */
    return vientisumoVerdiktas({
      laukiama,
      bytes,
      checksum: maisa.digest("hex"),
      nepriklausomas: true,
    });
  }

  async function del(raktas) {
    const pilnas = await keliasSaugus(raktas);

    /**
     * ⚠️ OBJEKTAS YRA TIK REGULIARUS FAILAS — IR TRYNIMAS TAI ŽINO (Codex, #290).
     *
     * `delete("results")` po `put("results/job/a.json", ...)` mesdavo žalią
     * `EISDIR`, nors `head("results")` tam pačiam raktui sako „objekto nėra", o
     * `inline` ir S3 grąžina `false`. Tas pats įėjimas duodavo tris skirtingus
     * atsakymus, ir bendras kontraktas nustodavo būti bendras.
     */
    if ((await head(raktas)) === null) return false;

    try {
      await fsp.unlink(pilnas);
    } catch (klaida) {
      /** `false` = objekto NEBUVO. 7.6c pamoka: tai ne nesėkmė, o kita būsena. */
      if (klaida.code === "ENOENT" || klaida.code === "ENOTDIR") return false;
      throw klaida;
    }

    /**
     * ⚠️ IŠTRYNIMAS PATVIRTINAMAS TIK PO KATALOGO `fsync` (Codex, #290).
     *
     * Optimistinis `true` čia kerta ištrynimo garantijų grandinę: kvietėjas
     * patvirtina ištrynimą -> DB metaduomenys pašalinami -> maitinimo dingimas
     * grąžina failą. Rezultatas — NEREFERENCUOTAS jautrus objektas, kurio DB
     * kryptimi orientuotas inventorius (A3) NEBERANDA pagal apibrėžimą.
     *
     * Tai ta pati klasė kaip rašymo pusėje, bet sunkesnė: ten prarandamas
     * rezultatas, čia — lieka tai, kas privalėjo dingti.
     */
    await sinchronizuotiKatalaga(path.dirname(pilnas));
    return true;
  }

  /**
   * STARTO PATIKRA — TAS PATS VARDAS KAIP S3 (Codex, #290).
   *
   * ⚠️ FAIL-FAST NEĮVYKDAVO, NES JO NIEKAS NEKVIETĖ. Šaknies patikra buvo tingi:
   * netinkamas `ARTIFACT_FS_ROOT` (esamas failas, nepasiekiamas katalogas)
   * paaiškėdavo tik per pirmą operaciją — t. y. po to, kai tiekėjas jau atliko
   * brangų darbą. PR-2 fail-fast kriterijus reikalauja priešingo.
   *
   * ⚠️ VARDAS BENDRAS SĄMONINGAI: factory laukia `patikrintiSaugykla()` VISIEMS
   * backend'ams, tad naujas backend'as be starto patikros nebeatsiras tyliai —
   * jam tektų arba ją turėti, arba eksplicitiškai deklaruoti, kad tikrinti nėra ko.
   */
  async function patikrintiSaugykla() {
    const tikraSaknis = await paruostiSakni();
    return { backend: "fs", root: tikraSaknis };
  }

  return {
    backend: "fs",
    root: saknis,
    put,
    read,
    readStream,
    head,
    verify,
    delete: del,
    patikrintiSaugykla,
  };
}

module.exports = { createFsArtifactStore };
