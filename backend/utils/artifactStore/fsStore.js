const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  ArtifactStoreError,
  KLAIDA,
  patikrintiRakta,
  paruostiReiksme,
  atkurtiReiksme,
} = require("./validation");

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
   * ⚠️ ANTRA RIBOS PATIKRA, IR JI SĄMONINGA.
   *
   * `patikrintiRakta()` jau atmetė viską, kas nėra siauras allowlist'as, tad ši
   * niekada neturėtų suveikti. Bet ji kainuoja vieną palyginimą ir gina nuo
   * ateities: jei kas nors kada praplės leistinų raktų aibę, filesystem pusė
   * neturi tapti pirmąja auka. Gynyba gilumoje, ne dubliavimas.
   */
  function kelias(raktas) {
    const pilnas = path.resolve(saknis, patikrintiRakta(raktas));

    if (pilnas !== saknis && !pilnas.startsWith(saknis + path.sep)) {
      throw new ArtifactStoreError(
        "FsArtifactStore: raktas išveda už saugyklos šaknies.",
        KLAIDA.RAKTAS
      );
    }

    return pilnas;
  }

  /**
   * ⚠️ RIBA TIKRINAMA IR PO `realpath`, NE VIEN LEKSIŠKAI (Codex, #290).
   *
   * ⚠️ PAGRINDINIS ARGUMENTAS - NE ATAKA, O NUOSEKLUMAS (§16). Kad
   * `<šaknis>/results` taptų symlink'u, kažkas jau turi rašymo teisę į artefaktų
   * šaknį — o tada jis ir taip pasiekia artefaktus. Tikroji priežastis kita:
   * `fileStorage._resolveExisting()` ŠIAME REPO jau uždaro būtent šią klasę per
   * `realpath`. Dvi saugyklos ribos su skirtinga traversal semantika yra
   * nenuoseklumas, ir jis pasimatys per bendrą volume tarp konteinerių ar
   * restore, ne per ataką.
   *
   * ⚠️ TOCTOU LIEKA. `realpath` riziką sumažina, bet nepašalina: kelias gali
   * pasikeisti tarp patikros ir operacijos. Teigti daugiau, nei kodas daro,
   * būtų §12.1 pažeidimas.
   */
  async function tikrasKelias(pilnas, { katalogas = false } = {}) {
    /**
     * ⚠️ `put()` METU FAILO DAR NĖRA, tad `realpath` taikomas KATALOGUI (jau po
     * `mkdir`). Taikant failui, teisėtas kelias grįžtų su `ENOENT`.
     */
    const taikinys = katalogas ? path.dirname(pilnas) : pilnas;

    let tikras;
    try {
      tikras = await fsp.realpath(taikinys);
    } catch (klaida) {
      /** Nesantis objektas nėra ribos pažeidimas — tai `head`/`read` reikalas. */
      if (klaida.code === "ENOENT" || klaida.code === "ENOTDIR") return pilnas;
      throw klaida;
    }

    const tikraSaknis = await fsp.realpath(saknis);

    if (tikras !== tikraSaknis && !tikras.startsWith(tikraSaknis + path.sep)) {
      throw new ArtifactStoreError(
        "FsArtifactStore: raktas per symlink išveda už saugyklos šaknies.",
        KLAIDA.RAKTAS
      );
    }

    return pilnas;
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
  async function sukurtiKatalogus(katalogas) {
    const nauji = [];
    let dabartinis = katalogas;

    /** Randame, kiek kelio dalių dar nėra — nuo giliausios aukštyn. */
    while (dabartinis !== saknis && dabartinis.startsWith(saknis + path.sep)) {
      try {
        await fsp.stat(dabartinis);
        break;
      } catch (klaida) {
        if (klaida.code !== "ENOENT") throw klaida;
        nauji.push(dabartinis);
        dabartinis = path.dirname(dabartinis);
      }
    }

    await fsp.mkdir(katalogas, { recursive: true });
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
    const pilnas = kelias(raktas);
    const paruosta = paruostiReiksme(reiksme);

    const sukurti = await sukurtiKatalogus(path.dirname(pilnas));
    await tikrasKelias(pilnas, { katalogas: true });

    const laikinas = `${pilnas}.${crypto.randomUUID()}.tmp`;
    let deskriptorius = null;

    try {
      deskriptorius = await fsp.open(laikinas, "wx");
      await deskriptorius.writeFile(paruosta.buferis);
      await deskriptorius.sync();
      await deskriptorius.close();
      deskriptorius = null;

      await fsp.rename(laikinas, pilnas);

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
      await fsp.rm(laikinas, { force: true }).catch(() => {});
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
    const pilnas = await tikrasKelias(kelias(raktas));

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
    const pilnas = kelias(raktas);

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
    const pilnas = kelias(raktas);

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
    if (!galva) return { ok: false, exists: false, bytes: null, checksum: null, nepriklausomas: true };

    /**
     * ⚠️ VISAS OBJEKTAS SKAITOMAS SĄMONINGAI. Filesystem checksum'o
     * metaduomenyse neturi, tad kitaip vientisumo patvirtinti neįmanoma. Būtent
     * dėl šios kainos `verify()` metadata-only keliuose DRAUDŽIAMAS.
     */
    const buferis = await fsp.readFile(kelias(raktas));
    const checksum = crypto.createHash("sha256").update(buferis).digest("hex");
    const bytes = buferis.byteLength;

    const ok = laukiama.bytes === bytes && laukiama.checksum === checksum;

    /**
     * ⚠️ `nepriklausomas: true` — LYGINAMA SU IŠORE ĮRAŠYTU METADUOMENIU.
     *
     * Čia `bytes`/`checksum` perskaičiuojami iš objekto ir lyginami su tuo, ką
     * kvietėjas persistino ATSKIRAI (DB pusėje). Tai tikras vientisumo
     * patvirtinimas. `inline` atveju tokio nepriklausomo metaduomens nėra, tad
     * ten vėliava bus `false` — ir 7.6 restore verifikacija privalo tai matyti,
     * o ne laikyti abu atvejus lygiaverčiais.
     */
    return { ok, exists: true, bytes, checksum, nepriklausomas: true };
  }

  async function del(raktas) {
    const pilnas = kelias(raktas);

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

  return { backend: "fs", root: saknis, put, read, readStream, head, verify, delete: del };
}

module.exports = { createFsArtifactStore };
