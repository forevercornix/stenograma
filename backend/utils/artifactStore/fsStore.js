const fsp = require("node:fs/promises");
const fs = require("node:fs");
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

  async function put(raktas, reiksme) {
    const pilnas = kelias(raktas);
    const paruosta = paruostiReiksme(reiksme);

    await fsp.mkdir(path.dirname(pilnas), { recursive: true });

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
      const katalogas = await fsp.open(path.dirname(pilnas), "r");
      try {
        await katalogas.sync();
      } finally {
        await katalogas.close();
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
    const pilnas = kelias(raktas);

    try {
      const info = await fsp.stat(pilnas);
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
      if (klaida.code === "ENOENT") return null;
      throw klaida;
    }
  }

  async function read(raktas) {
    const pilnas = kelias(raktas);

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
     * ⚠️ EGZISTAVIMAS TIKRINAMAS PRIEŠ SRAUTĄ - BET TAI NE GARANTIJA.
     *
     * `createReadStream` nesančio failo klaidą paduoda ASINCHRONIŠKAI, per
     * `error` įvykį. Ši patikra DAŽNĄ atvejį paverčia tipizuota klaida, tačiau
     * lango neuždaro: objektas gali dingti tarp patikros ir skaitymo.
     *
     * ⚠️ TODĖL KONTRAKTAS NEŽADA „visada tipizuota". Kvietėjas PRIVALO apdoroti
     * ir srauto `error` įvykį; priešingu atveju dokumentacija teigtų daugiau,
     * nei kodas gali (§12.1).
     */
    if ((await head(raktas)) === null) {
      throw new ArtifactStoreError(`FsArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
    }

    return fs.createReadStream(pilnas);
  }

  async function verify(raktas, laukiama = {}) {
    const galva = await head(raktas);
    if (!galva) return { ok: false, exists: false, bytes: null, checksum: null };

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
      return true;
    } catch (klaida) {
      /** `false` = objekto NEBUVO. 7.6c pamoka: tai ne nesėkmė, o kita būsena. */
      if (klaida.code === "ENOENT") return false;
      throw klaida;
    }
  }

  return { backend: "fs", root: saknis, put, read, readStream, head, verify, delete: del };
}

module.exports = { createFsArtifactStore };
