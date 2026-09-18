const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { skipWithoutPostgres } = require("./helpers/postgresGuard");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { paleistiMigracijosScenarijus } = require("./helpers/artifactMigrationScenarios");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `inline` → external MIGRACIJA prieš `fs` (#157, PR-6).
 *
 * ⚠️ ŠIS FAILAS SCENARIJŲ NETURI IR NETURI TURĖTI.
 *
 * Visas rinkinys gyvena `helpers/artifactMigrationScenarios.js` ir paleidžiamas
 * NEKEIČIAMAS prieš `fs` bei `s3`. Jei kuri nors saugykla pareikalautų išimties,
 * tai reiškia, kad migracijos kontraktas neapibrėžtas — ne kad rinkinys per
 * griežtas. Ta pati taisyklė ir tas pats precedentas kaip `paleistiKontrakta`
 * (PR-2).
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL.
 */

let saknis = null;

paleistiMigracijosScenarijus("fs", {
  dbSuffix: "artifactmigration",
  praleisti: skipWithoutPostgres(),

  async paruostiSaugykla() {
    saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-migracija-"));

    return {
      saugykla: createFsArtifactStore({ root: saknis }),

      /**
       * ⚠️ RAŠOMA TIESIAI Į FAILŲ SISTEMĄ, APLENKIANT SAUGYKLĄ.
       *
       * Per `put()` sugadinti neįmanoma — jis perskaičiuotų `checksum`, ir
       * scenarijus tikrintų ne tai, ką teigia. Sugadinimas privalo atrodyti taip,
       * lyg objektas pasikeistų PO mūsų rašymo.
       */
      async sugadinti(raktas) {
        const kelias = path.join(saknis, raktas);
        const baitai = await fsp.readFile(kelias);
        const priesIlgis = baitai.length;

        /** Viena raidė reikšmės viduje: ilgis nekinta, JSON lieka galiojantis. */
        const i = baitai.findIndex((b, idx) => idx > 10 && b >= 0x61 && b <= 0x7a);
        if (i < 0) throw new Error("fs fixture: kanoninėje eilutėje nerasta mažoji raidė");
        baitai[i] = baitai[i] === 0x7a ? 0x79 : baitai[i] + 1;

        await fsp.writeFile(kelias, baitai);
        return priesIlgis;
      },

      async objektuKiekis() {
        const irasai = await fsp.readdir(saknis).catch(() => []);
        return irasai.length;
      },

      async isvalyti() {
        if (saknis) await fsp.rm(saknis, { recursive: true, force: true }).catch(() => {});
        saknis = null;
      },
    };
  },
});
