const net = require("node:net");

/**
 * MINIMALUS PostgreSQL LAIDO PROTOKOLO SERVERIS (#342 Codex, P1).
 *
 * ⚠️ KODĖL NEPAKANKA TYLAUS TCP KLAUSYTOJO.
 *
 * `pg` `connectionTimeoutMillis` nuvalomas tik ties `ReadyForQuery`
 * (`pg` 8.23, `client.js:377`). Serveris, kuris jungtį priima ir tyli, būtų
 * pagautas PRISIJUNGIMO ribos - t. y. testas matuotų ne tai, ką teigia.
 *
 * Todėl šis serveris rankos paspaudimą UŽBAIGIA (klientas tampa „prisijungęs",
 * prisijungimo laikmatis nuvalomas) ir tik tada nustoja atsakinėti. Nuo to
 * momento vienintelė riba, galinti nutraukti laukimą, yra `query_timeout` -
 * būtent ta, kurios trūko.
 *
 * ⚠️ TIKRA DB ČIA NEREIKALINGA IR NENAUDOJAMA. Aplinkos riba draudžia diegti
 * PostgreSQL; šis failas yra priežastis, kodėl P1 testas vis tiek yra elgsenos,
 * o ne struktūros patikra.
 */

/** `R` AuthenticationOk: ilgis 8, kodas 0. */
function authenticationOk() {
  const b = Buffer.alloc(9);
  b.write("R", 0, "latin1");
  b.writeInt32BE(8, 1);
  b.writeInt32BE(0, 5);
  return b;
}

/** `Z` ReadyForQuery: ilgis 5, būsena `I` (idle). */
function readyForQuery() {
  const b = Buffer.alloc(6);
  b.write("Z", 0, "latin1");
  b.writeInt32BE(5, 1);
  b.write("I", 5, "latin1");
  return b;
}

/** SSLRequest kodas - klientas jo klausia PRIEŠ startup paketą. */
const SSL_REQUEST = 80877103;

/**
 * Paleidžia serverį, kuris rankos paspaudimą užbaigia, o į užklausas NEATSAKO.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
async function startSilentAfterHandshake() {
  const jungtys = new Set();

  const server = net.createServer((socket) => {
    jungtys.add(socket);
    socket.on("close", () => jungtys.delete(socket));
    /** Klientas jungtį nutraukia pats, kai suveikia jo riba - tai ne testo klaida. */
    socket.on("error", () => {});

    let paspaudimasBaigtas = false;

    socket.on("data", (chunk) => {
      if (paspaudimasBaigtas) {
        /**
         * ⚠️ ČIA IR YRA VISA ESMĖ: atėjo `Q` (Query), ir mes NEATSAKOM.
         * Serveris gyvas, jungtis atvira, rezultato nebus niekada.
         */
        return;
      }

      /** SSLRequest: atsakom „ne", klientas tęsia paprastu tekstu. */
      if (chunk.length >= 8 && chunk.readInt32BE(4) === SSL_REQUEST) {
        socket.write(Buffer.from("N", "latin1"));
        return;
      }

      /** Startup paketas - užbaigiam paspaudimą ir nutylam. */
      paspaudimasBaigtas = true;
      socket.write(Buffer.concat([authenticationOk(), readyForQuery()]));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `postgres://testas:testas@127.0.0.1:${port}/testas`,

    async close() {
      for (const s of jungtys) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startSilentAfterHandshake };
