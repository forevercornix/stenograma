const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");

const { paleistiKontrakta } = require("./helpers/artifactStoreContract");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `ArtifactStore` KONTRAKTAS: `fs` BACKEND'AS (#157, PR-2).
 *
 * ⚠️ RINKINYS NEKEIČIAMAS. Jis gyvena `helpers/artifactStoreContract.js` ir yra
 * tie patys vartai `inline` bei `s3` implementacijoms. Šis failas tik paruošia
 * `fs` saugyklą ir po testo išvalo katalogą.
 *
 * ⚠️ KODĖL ŠIS BACKEND'AS TIKRINAMAS VIETOJE. Jam nereikia nei DB, nei tinklo,
 * tad kontrakto pažeidimas matomas per sekundes, o ne per CI raundą. `inline`
 * reikalauja PostgreSQL, `s3` - MinIO; abu gyvena integraciniuose rinkiniuose.
 */

const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");

paleistiKontrakta("fs", async () => {
  const saknis = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-artifacts-"));

  return {
    saugykla: createFsArtifactStore({ root: saknis }),
    isvalyti: () => fs.rm(saknis, { recursive: true, force: true }),
  };
});
