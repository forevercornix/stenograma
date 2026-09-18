const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { startSilentAfterHandshake } = require("./helpers/fakePostgres");

/**
 * STARTO UŽKLAUSŲ RIBOS (#155, #342 Codex P1).
 *
 * ⚠️ KLAUSIMAS, KURĮ ŠIS FAILAS UŽDARO: kas nutinka, kai PostgreSQL jungtį
 * PRIIMA, bet rezultatų negrąžina?
 *
 * `connectionTimeoutMillis` galioja tik iki jungties gavimo, tad be atskiros
 * užklausos ribos startas kabo NERIBOTAI. Tai ne fail-closed, o FAIL-NEVER:
 * procesas nekrenta, neaptarnauja ir nepraneša.
 *
 * ⚠️ 10 SĄLYGOS CI ŽINGSNIS ŠIO REŽIMO NEDENGIA PAGAL KONSTRUKCIJĄ - jis naudoja
 * UŽDARYTĄ PORTĄ, tad matuoja atsisakymą jungtis. Gedimo režimai du; iki šio
 * failo įrodymas buvo vienas.
 *
 * ⚠️ TIKROS DB NEREIKIA. `helpers/fakePostgres.js` užbaigia laido protokolo
 * rankos paspaudimą ir tada nutyla - žr. ten paaiškinimą, kodėl tylaus TCP
 * klausytojo NEPAKANKA.
 */

/** Testo sava riba: be jos „kabo" pasireikštų kaip kabantis testas, ne kaip kritimas. */
const TESTO_RIBA_MS = 15000;

async function perRiba(pazadas, kasVyksta) {
  let laikmatis;

  const deadline = new Promise((_, reject) => {
    laikmatis = setTimeout(
      () => reject(new Error(`KABO: ${kasVyksta} neužsibaigė per ${TESTO_RIBA_MS} ms`)),
      TESTO_RIBA_MS
    );
  });

  try {
    return await Promise.race([pazadas, deadline]);
  } finally {
    clearTimeout(laikmatis);
  }
}

test("RIBOS: abu starto pool'ai turi VISAS TRIS ribas, ne tik prisijungimo", () => {
  /**
   * ⚠️ STRUKTŪRINĖ PUSĖ (AGENTS.md §9.2) - elgseną tikrina du testai žemiau.
   * Ji čia yra tam, kad nustačius ribą tik viename iš dviejų starto kelių
   * kritimas būtų iškart suprantamas, o ne pasirodytų kaip timeout.
   */
  const env = { DATABASE_URL: "postgres://u:p@h/db" };

  const keliai = {
    jobStore: require("../utils/jobStore").jobPoolNustatymai(env),
    deletionTombstones: require("../utils/deletionTombstones").zymuPoolNustatymai(env),
  };

  for (const [vardas, n] of Object.entries(keliai)) {
    assert.ok(n.connectionTimeoutMillis > 0, `${vardas}: prisijungimo riba`);
    assert.ok(n.statement_timeout > 0, `${vardas}: SERVERIO pusės riba (atlaisvina užraktus)`);
    assert.ok(
      n.query_timeout > 0,
      `${vardas}: KLIENTO pusės riba - vienintelė, kuri padeda, kai serveris nebeatsako`
    );
  }
});

test("RIBOS: reikšmė imama iš `DB_QUERY_TIMEOUT_MS`, o per maža IGNORUOJAMA", () => {
  const jobStore = require("../utils/jobStore");
  const tombstones = require("../utils/deletionTombstones");

  for (const nustatymai of [jobStore.jobPoolNustatymai, tombstones.zymuPoolNustatymai]) {
    assert.equal(
      nustatymai({ DATABASE_URL: "x", DB_QUERY_TIMEOUT_MS: "1500" }).query_timeout,
      1500,
      "operatoriaus reikšmė privalo galioti"
    );

    /** Riba žemiau grindų reikštų startą, krentantį anksčiau nei DB spėja atsakyti. */
    assert.equal(
      nustatymai({ DATABASE_URL: "x", DB_QUERY_TIMEOUT_MS: "5" }).query_timeout,
      5000,
      "per maža reikšmė ignoruojama, o ne priimama"
    );
  }
});

test("FAIL-NEVER: `jobStore` startas su neatsakančiu serveriu NUTRŪKSTA, o ne kabo", async () => {
  /**
   * ⚠️ MATUOJAMAS PRODUKCINIS KELIAS. `_initializePostgresForTests` yra ta pati
   * `initializePostgres()` funkcija, kurią kviečia startas - ne jos kopija.
   */
  const jobStore = require("../utils/jobStore");
  const serveris = await startSilentAfterHandshake();
  const senas = process.env.DATABASE_URL;

  process.env.DATABASE_URL = serveris.url;
  process.env.DB_QUERY_TIMEOUT_MS = "700";

  try {
    const pradzia = Date.now();

    await perRiba(
      assert.rejects(
        () => jobStore._initializePostgresForTests(),
        /PostgreSQL neprieinamas/,
        "startas privalo NUTRŪKTI fail-closed klaida"
      ),
      "jobStore startas"
    );

    /**
     * ⚠️ TIKRINAMA IR TRUKMĖ. Be jos testas praeitų ir tuo atveju, jei kritimą
     * sukeltų kas nors kita po ilgo laukimo - o būtent laukimas ir yra defektas.
     */
    const truko = Date.now() - pradzia;
    assert.ok(truko < 10000, `nutrūko per ${truko} ms - riba privalo veikti, ne baigtis atsitiktinai`);
  } finally {
    delete process.env.DB_QUERY_TIMEOUT_MS;
    if (senas === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = senas;
    await serveris.close();
  }
});

test("FAIL-NEVER: žymų lentelės patikra su neatsakančiu serveriu NUTRŪKSTA, o ne kabo", async () => {
  /**
   * ⚠️ ŠIS KELIAS SVARBESNIS UŽ PIRMĄJĮ.
   *
   * ADR prielaidos 5 matavimas parodė, kad fail-closed elgesį realiai užtikrina
   * BŪTENT ištrynimo žymų lentelės patikra - trečias sluoksnis. Sluoksnis, kuris
   * gali kaboti, fail-closed neduoda.
   */
  const tombstones = require("../utils/deletionTombstones");
  const serveris = await startSilentAfterHandshake();

  try {
    const pradzia = Date.now();

    await perRiba(
      assert.rejects(
        () =>
          tombstones.init({
            DATABASE_URL: serveris.url,
            DB_QUERY_TIMEOUT_MS: "700",
          }),
        /nepasiekiama/i,
        "žymų patikra privalo NUTRŪKTI, ne kaboti"
      ),
      "deletionTombstones.init"
    );

    const truko = Date.now() - pradzia;
    assert.ok(truko < 10000, `nutrūko per ${truko} ms`);
  } finally {
    await tombstones.shutdown().catch(() => {});
    await serveris.close();
  }
});
