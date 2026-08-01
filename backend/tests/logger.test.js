const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";

const { createLogger } = require("../utils/logger");
const { resolveTrustProxy, pseudonymizeIp, truncateIp } = require("../utils/clientIp");
const { runWithContext } = require("../utils/requestContext");

/**
 * GDPR #17: STRUKTŪRUOTAS LOGAS, TRUST PROXY IR IP.
 */

function capture(fn, { level = "debug", format = "json" } = {}) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };

  const savedLevel = process.env.LOG_LEVEL;
  const savedFormat = process.env.LOG_FORMAT;
  process.env.LOG_LEVEL = level;
  process.env.LOG_FORMAT = format;

  for (const channel of Object.keys(original)) {
    console[channel] = (...args) => lines.push(args.join(" "));
  }

  try {
    fn();
  } finally {
    Object.assign(console, original);
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
    if (savedFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = savedFormat;
  }

  return lines;
}

test("STRUKTŪRA: kiekviena eilutė turi ts, level, component ir msg", () => {
  const lines = capture(() => createLogger("testas").info("žinutė"));

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);

  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.level, "info");
  assert.equal(entry.component, "testas");
  assert.equal(entry.msg, "žinutė");
});

test("KONTEKSTAS pridedamas AUTOMATIŠKAI, be kviečiančiojo pastangų", () => {
  const lines = capture(() =>
    runWithContext({ requestId: "req_abc", actor: "key_123456789012", execution: "worker" }, () => {
      createLogger("testas").info("darbas");
    })
  );

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.requestId, "req_abc");
  assert.equal(entry.actor, "key_123456789012");
  assert.equal(entry.execution, "worker");
});

test("be konteksto koreliacijos laukų NĖRA (o ne `null`)", () => {
  const entry = JSON.parse(capture(() => createLogger("testas").info("x"))[0]);

  assert.ok(!("requestId" in entry), "tuščias laukas tik triukšmintų");
  assert.ok(!("actor" in entry));
});

test("PRIVATUMAS: `data` VISADA praleidžiama pro sanitizaciją", () => {
  const lines = capture(() =>
    createLogger("testas").warn("tiekėjo klaida", {
      apiKey: "sk-ant-labai-slaptas",
      email: "jonas@imone.lt",
      phone: "+37060012345",
      jobId: "job-1",
    })
  );

  const raw = lines[0];
  assert.ok(!raw.includes("sk-ant-labai-slaptas"), "raktas negali patekti į logą");
  assert.ok(!raw.includes("jonas@imone.lt"), "el. paštas negali patekti į logą");

  // Nejautrūs laukai išlieka - sanitizacija neturi paversti logo bevertišku.
  assert.equal(JSON.parse(raw).data.jobId, "job-1");
});

test("LYGIAI: žemesnis nei sukonfigūruotas lygis neišvedamas", () => {
  const lines = capture(
    () => {
      const log = createLogger("testas");
      log.debug("nematoma");
      log.info("nematoma");
      log.warn("matoma");
      log.error("matoma");
    },
    { level: "warn" }
  );

  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).level),
    ["warn", "error"]
  );
});

test("FORMATAS: `pretty` skirtas žmogui, bet koreliacijos nepraranda", () => {
  const lines = capture(
    () => runWithContext({ requestId: "req_xyz" }, () => createLogger("testas").info("žinutė")),
    { format: "pretty" }
  );

  // Lygis priekyje pridėtas po peržiūros: pretty prarasdavo `level`, `actor` ir
  // `execution`, tad lokaliai nesimatydavo net vykdymo režimo.
  assert.match(lines[0], /^INFO \[stenograma:testas\] \[req_xyz\] žinutė$/);
});

test("KOMPONENTAS privalomas - eilutė be kilmės nedaug skiriasi nuo laisvo teksto", () => {
  assert.throws(() => createLogger(), /komponento pavadinimas privalomas/);
  assert.throws(() => createLogger(""), /komponento pavadinimas privalomas/);
});

test("TRUST PROXY: numatytai NEPASITIKIMA", () => {
  // Klaidingas pasitikėjimas yra saugumo spraga; klaidingas nepasitikėjimas -
  // nepatogumas, kurį matyti iš karto.
  assert.equal(resolveTrustProxy({}), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "" }), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "   " }), false);
});

test("TRUST PROXY: skaičius, boolean ir CIDR sąrašas", () => {
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "1" }), 1);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "2" }), 2);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "true" }), true);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "false" }), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "10.0.0.0/8" }), "10.0.0.0/8");
});

test("IP: pseudonimas stabilus, bet neatstatomas", () => {
  const env = { AUDIT_ID_SALT: "testine-druska" };
  const a = pseudonymizeIp("192.168.1.42", env);

  assert.match(a, /^ip_[0-9a-f]{12}$/);
  assert.ok(!a.includes("192.168"), "adresas negali būti matomas pseudonime");

  // Tas pats adresas - tas pats pseudonimas (kad piktnaudžiavimą būtų galima grupuoti).
  assert.equal(pseudonymizeIp("192.168.1.42", env), a);
  assert.notEqual(pseudonymizeIp("192.168.1.43", env), a);

  // Kita druska - kitas pseudonimas (neleidžia sugretinti tarp diegimų).
  assert.notEqual(pseudonymizeIp("192.168.1.42", { AUDIT_ID_SALT: "kita" }), a);

  assert.equal(pseudonymizeIp(""), null);
  assert.equal(pseudonymizeIp(null), null);
});

test("IP: sutrumpinimas palieka tinklą, ne klientą", () => {
  assert.equal(truncateIp("192.168.1.42"), "192.168.1.0/24");
  assert.equal(truncateIp("2001:db8:85a3:1:2:3:4:5"), "2001:db8:85a3:1::/64");
  assert.equal(truncateIp("netinkamas"), null);
  assert.equal(truncateIp(""), null);
});

test("REGRESIJA: produkciniame kode nebeliko tiesioginių console kvietimų", () => {
  /**
   * Struktūruotas logas vertingas tik tada, kai jis VIENINTELIS. Viena pamiršta
   * `console.log` eilutė neturi nei koreliacijos, nei sanitizacijos - ir būtent
   * ji nutekins tai, ko visur kitur saugomasi.
   *
   * Išimtys: `scripts/` (CLI įrankiai, skirti žmogui terminale) ir pats logeris.
   */
  const fs = require("fs");
  const path = require("path");

  const offenders = [];
  const skip = new Set(["node_modules", "tests", "scripts", "storage", ".git"]);

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js") && entry.name !== "logger.js") {
        const source = fs.readFileSync(full, "utf8");
        // Komentaruose minėti console leidžiama - tikrinam tik realius kvietimus.
        const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (/\bconsole\.(log|warn|error)\s*\(/.test(withoutComments)) offenders.push(full);
      }
    }
  };

  walk(path.join(__dirname, ".."));

  assert.deepEqual(offenders, [], `naudokite utils/logger.js: ${offenders.join(", ")}`);
});

/**
 * ---------------------------------------------------------------------------
 * PERŽIŪROS METU RASTOS SPRAGOS.
 *
 * Šie testai atsirado tikrinant logerio juodraštį kaip svetimą kodą. Kiekvienas
 * fiksuoja konkretų neatitikimą tarp to, ką kodas deklaravo, ir ką darė.
 * ---------------------------------------------------------------------------
 */

test("msg eilutė SANITIZUOJAMA, ne tik data", () => {
  /**
   * Pirminis projektas sanitizavo tik `data`, laikydamas `msg` „mūsų pačių
   * tekstu". Bet 33 kvietimo vietos interpoliuoja kintamuosius į `msg`, o
   * šešiose - `e.message`, kuriame realiai būna failų kelių.
   */
  const output = capture(() => {
    const log = createLogger("testas");
    log.warn(`Nepavyko: EACCES /tmp/stenograma-storage-abc/uploads/x.wav, jonas@imone.lt, a.k. 39001010000`);
  }).join("\n");
  assert.ok(!output.includes("/tmp/stenograma-storage-abc"), "kelias negali patekti į logą");
  assert.ok(!output.includes("jonas@imone.lt"), "el. paštas negali patekti į logą");
  assert.ok(!output.includes("39001010000"), "asmens kodas negali patekti į logą");
  assert.ok(output.includes("REDACTED"), "turi likti matoma, kad kažkas redaguota");
});

test("STRUKTŪRA: kvietimo vietose nebeliko dubliuoto [stenograma] prefikso", () => {
  // Komponentą prideda pats logeris; prefiksas msg viduje duotų
  // „[stenograma:server] [stenograma] ...".
  const fs = require("fs");
  const path = require("path");

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "tests") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const src = fs.readFileSync(full, "utf8");
        if (/log\.(info|warn|error|debug)\(`\[stenograma\]/.test(src)) offenders.push(full);
      }
    }
  };
  walk(path.join(__dirname, ".."));

  assert.deepEqual(offenders, [], `dubliuotas prefiksas: ${offenders.join(", ")}`);
});

test("IP: rate limito įvykis rašo PSEUDONIMĄ, ne adresą", () => {
  const ip = "203.0.113.42";
  const pseudo = pseudonymizeIp(ip);

  assert.match(pseudo, /^ip_[0-9a-f]{12}$/);
  assert.ok(!pseudo.includes(ip), "adresas negali būti atkuriamas iš pseudonimo");
  assert.equal(pseudonymizeIp(ip), pseudo, "tas pats klientas - tas pats pseudonimas");
  assert.notEqual(pseudonymizeIp("203.0.113.43"), pseudo);
  assert.equal(pseudonymizeIp(""), null);

  // Sutrumpinimas yra ATSKIRA priemonė, ne numatytoji.
  assert.equal(truncateIp("203.0.113.42"), "203.0.113.0/24");
  assert.equal(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::/64");

  // trust proxy numatytai NEPASITIKI.
  assert.equal(resolveTrustProxy({}), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "1" }), 1);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "true" }), true);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "10.0.0.0/8" }), "10.0.0.0/8");
});


test("PRETTY rodo TĄ PATĮ laukų rinkinį kaip JSON", () => {
  /**
   * Pirminė versija pretty režimu prarasdavo `level`, `actor` ir `execution` -
   * kūrėjas lokaliai nematydavo net to, ar eilutė iš worker'io, ar iš inline.
   * Du formatai su skirtinga informacija reiškia, kad dalis klaidų matoma tik
   * produkcijoje, kur jas tirti sunkiausia.
   */
  const context = { requestId: "req_pretty", actor: "key_pretty", execution: "worker" };

  const json = capture(() => {
    runWithContext(context, () => createLogger("komp").info("Pranešimas", { jobId: "j1" }));
  }, { format: "json" }).join("\n");

  const pretty = capture(() => {
    runWithContext(context, () => createLogger("komp").info("Pranešimas", { jobId: "j1" }));
  }, { format: "pretty" }).join("\n");

  for (const value of ["req_pretty", "key_pretty", "worker", "komp", "Pranešimas", "j1"]) {
    assert.ok(json.includes(value), `JSON praranda: ${value}`);
    assert.ok(pretty.includes(value), `PRETTY praranda: ${value}`);
  }

  // Lygis matomas ir vizualiai, ne tik pagal kanalą.
  assert.match(pretty, /^INFO /);
});

test("GREITAS KELIAS: paprastas pranešimas praleidžia sanitizaciją, bet jautrus - ne", () => {
  const output = capture(() => {
    const log = createLogger("greitis");
    log.info("Worker paleistas");
    log.info("Rasta jonas@imone.lt");
  }, { format: "json" }).join("\n");

  // Nekaltas literalas nepakeičiamas.
  assert.ok(output.includes("Worker paleistas"));
  // Jautrus - redaguojamas, nepaisant greito kelio.
  assert.ok(!output.includes("jonas@imone.lt"));
  assert.ok(output.includes("REDACTED"));
});

test("IPv6 sutrumpinimas veikia SUGLAUSTOMS formoms", () => {
  // Pirminė versija darė split(":").slice(0,4) ir suglaustoms formoms duodavo
  // neteisingą atsakymą.
  assert.equal(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::/64");
  assert.equal(truncateIp("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(truncateIp("::1"), "0:0:0:0::/64");
  assert.equal(truncateIp("fe80::1%eth0"), "fe80:0:0:0::/64", "zonos identifikatorius nulupamas");

  // IPv4-mapped adresas traktuojamas kaip IPv4.
  assert.equal(truncateIp("::ffff:127.0.0.1"), "127.0.0.0/24");

  // Netinkamos reikšmės grąžina null, o ne šiukšles.
  for (const bad of ["netikras", "999.1.1.1", "1:2:3", "a::b::c", ""]) {
    assert.equal(truncateIp(bad), null, `turėjo būti null: ${bad}`);
  }
});
