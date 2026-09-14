const { parse: parseDsn } = require("pg-connection-string");

/**
 * PostgreSQL JUNGTIES NUSTATYMAI — VIENAS IŠSPRĘSTAS ŠALTINIS (#155, 7.4e / #216).
 *
 * ⚠️ KODĖL ATSKIRAS, NEUTRALUS MODULIS.
 *
 * 7.4e barjeras skaito `erasure_marks` audito jungtimi (`assertNotBarredWithClient`),
 * o žymas rašo `deletionTombstones` savo pool'u. Jei tie du pool'ai atsidurtų
 * SKIRTINGOSE bazėse, barjeras skaitytų tuščią lentelę ir VISADA praleistų — tyliai.
 *
 * Tai nebuvo teorija. Iki 7.4e atranka skyrėsi:
 *
 *   `auditStore/backendSelection.js`  - `AUDIT_BACKEND=postgres` priima `DATABASE_URL`
 *                                       ARBA `PGHOST` (abu kartu - startas krinta);
 *   `deletionTombstones/index.js`     - postgres TIK su `DATABASE_URL`.
 *
 * Dokumentuotame Compose diegime (`PG*`, be `DATABASE_URL`) tai reiškė auditą
 * PostgreSQL'e ir žymas ATMINTYJE. Suderinamumo patikra to neišspręstų: ji
 * reikalautų `DATABASE_URL`, o jį pridėjus kristų `PGHOST` konfliktas — aklavietė.
 *
 * ⚠️ TAPATUMAS PAGAL KONSTRUKCIJĄ, NE PAGAL PALYGINIMĄ. Abu pool'ai statomi iš
 * ŠIOS funkcijos, tad jie negali rodyti į skirtingas bazes. Vykdymo meto zondas
 * (`current_database()`) lieka TRIPWIRE (AGENTS.md §9.2), ne mechanizmas:
 * `inet_server_addr()` per unix socket grąžina `NULL`, tad du klasteriai tame
 * pačiame hoste su vienodu bazės vardu palyginime sutaptų.
 */

/**
 * ⚠️ `connectionString` TIK KAI `DATABASE_URL` REALIAI YRA.
 *
 * Dokumentuotas Compose diegimas perduoda `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/
 * `PGDATABASE`, o ne URL — sąmoningai, nes slaptažodis su URI simboliais
 * (`/`, `?`, `#`, `@`) URL'e reikštų kitką.
 *
 * ⚠️ `PG*` PERSIUNČIAMI EKSPLICITIŠKAI, NE PALIEKAMI `pg` NUOŽIŪRAI.
 *
 * `pg` juos skaito iš `process.env`, o `init(env)` priima konfigūraciją kaip
 * OBJEKTĄ. Įterptinis kvietėjas, perdavęs `PGHOST` tik objekte, atranką praeitų
 * (ji žiūri į tą patį objektą), o pool'as jungtųsi prie GLOBALIOS aplinkos
 * nurodytos — arba numatytosios — bazės. Antrasis skaitytojas čia yra ne mūsų
 * kodas, o pati biblioteka, tad `process.env` tripwire jos nepagauna.
 */
const PG_ATITIKMENYS = Object.freeze({
  PGHOST: "host",
  PGPORT: "port",
  PGUSER: "user",
  PGPASSWORD: "password",
  PGDATABASE: "database",
});

/** Ar ši konfigūracija apskritai nurodo PostgreSQL? */
function arNurodytaPostgres(env = process.env) {
  return Boolean(env.DATABASE_URL || env.PGHOST);
}

/**
 * `{ connectionString }` arba `{ host, port, user, password, database }`.
 *
 * Persiunčiama TIK viena forma: kartu su `connectionString` `pg` taikytų abi, ir
 * pirmenybė taptų neakivaizdi.
 */
function pgJungtiesNustatymai(env = process.env) {
  /**
   * ⚠️ DVIPRASMYBĖ SUSTABDOMA ČIA — TRŪKSTAMAS #245 GABALAS.
   *
   * Pirmoji šio darbo redakcija sargą pastatė TIK trijose vietose:
   * `arTaPatiBaze()` (DR keliai), `resolveAuditBackend()` ir `runSelfChecks()`
   * diagnostikoje. Išmatuota, kad to NEPAKAKO:
   *
   *   DATABASE_URL + PGOPTIONS, be `AUDIT_BACKEND=postgres`  →  0 klaidų,
   *   `deletionTombstones` pasirinkdavo `postgres` ir kildavo.
   *
   * O tai numatytoji konfigūracija: žymos PostgreSQL renkasi AUTOMATIŠKAI, kai
   * PostgreSQL nurodytas. DoD reikalauja „netoleruojamas skirtumas bent vienoje
   * klasėje → startas FAILINA", ir startas nefailindavo.
   *
   * ⚠️ TIKRINAMA ČIA, O NE PENKIUOSE KVIETIMO TAŠKUOSE. Sąrašas, kurį reikia
   * prisiminti pridedant naują pool'ą, jau kartą sugedo: būtent trys tos pačios
   * taisyklės kopijos ir yra #245 priežastis. Šią funkciją apeiti neįmanoma —
   * per ją eina visi keturi produkciniai pool'ai, diagnostinis klientas ir
   * skriptai, tad garantija galioja ir `workers/index.js` procese, kuris
   * `validateConfig()` NEKVIEČIA.
   */
  const skirtumai = jungtiesSemantikosSkirtumai(env);
  if (skirtumai.length > 0) {
    throw new PgConnectionError(dviprasmybesTekstas(skirtumai), "PG_CONNECTION_AMBIGUOUS");
  }

  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };

  const nustatymai = {};
  for (const [envRaktas, poolRaktas] of Object.entries(PG_ATITIKMENYS)) {
    if (env[envRaktas] !== undefined) {
      nustatymai[poolRaktas] = poolRaktas === "port" ? Number(env[envRaktas]) : env[envRaktas];
    }
  }
  return nustatymai;
}

/**
 * DVIPRASMIŠKA JUNGTIES KONFIGŪRACIJA — FAIL-CLOSED (#280, IV tos pačios šeimos raundas).
 *
 * ⚠️ KETURI RAUNDAI TAISĖ PO VIENĄ PARAMETRĄ: `--url` vs `PG*` (7.6a, #264),
 * `?host=`, `PGPORT`, ir `DATABASE_URL` + `PG*` maišymas. Kiekvienas taisymas
 * uždarydavo vieną plyšį ir palikdavo klasę atvirą, nes klausimas buvo ne
 * „kaip parsinti DSN", o „KUR `pg` realiai jungsis".
 *
 * Repo tą sprendimą jau turi priėmęs kitoje vietoje:
 * `auditStore/backendSelection.js` draudžia `DATABASE_URL` ir `PGHOST` kartu -
 * ne dėl estetikos, o todėl, kad prioritetas tampa neakivaizdus. Tas pats
 * principas čia uždaro ir tapatumo, ir dokumentacijos klausimą vienu judesiu:
 * maišymas yra KLAIDA, ne interpretacijos reikalas.
 *
 * ⚠️ RIBA IŠPLĖSTA (#245). Ankstesnė redakcija sakė: „tikrinama TIK ten, kur
 * tapatumas turi teisinę galią (DR keliai); pool'ų konstravimo semantikos visame
 * repo šis modulis NEKEIČIA: tai atskiras sprendimas su kitokia rizika."
 *
 * #245 IR YRA tas atskiras sprendimas. Nuo jo:
 *
 *   - dviprasmybės sargas yra BENDRAS PostgreSQL pool konfigūracijos invariantas.
 *     Jis įgyvendintas `pgJungtiesNustatymai()` VIDUJE, tad galioja visiems
 *     keturiems produkciniams pool'ams, diagnostiniam klientui ir skriptams
 *     pagal konstrukciją — ne pagal tai, ar kvietėjas jį prisiminė iškviesti;
 *   - DR tapatumo patikra (`arTaPatiBaze`) lieka PAPILDOMA sargo paskirtis, ne
 *     vienintelė.
 *
 * ⚠️ IR PATS SARGAS PAKEITĖ PRIGIMTĮ: iš INTENTO į EFEKTĄ. Žr.
 * `arDviprasmiskaKonfiguracija()`.
 */
class PgConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PgConnectionError";
    this.code = code;
  }
}

/**
 * EFEKTYVI JUNGTIES SEMANTIKA — SKAIČIUOJA PATS `pg`, NE MES (#245).
 *
 * ⚠️ ČIA NĖRA IR NEBUS `PG*` SĄRAŠO. Pirmoji šio darbo redakcija turėjo ranka
 * surašytus laukus (`host`, `port`, `database`, `user`, `password`, `ssl`,
 * `options`, `client_encoding`) — ir jau rašymo metu praleido DU, kuriuos `pg`
 * realiai skaito iš aplinkos: `sslnegotiation` (`PGSSLNEGOTIATION`, keičia TLS
 * rankos paspaudimo būdą) ir `replication` (`PGREPLICATION`, keičia patį
 * protokolą). Būtent tai ir yra ta yda, kurią #245 uždaro: sąrašas, aprašantis
 * svetimą paviršių, sensta TYLIAI.
 *
 * `pg` yra `^8.x`. Minoras gali pridėti kintamųjų (`sslnegotiation` atsirado
 * būtent taip), ir rankinis sąrašas apie tai nesužinotų.
 *
 * Todėl semantiką konstruoja `pg` savo klase. `pg/lib/*` yra DEKLARUOTAS
 * paketo `exports` kelias (`pg/package.json`: `"./lib/*": "./lib/*.js"`), ne
 * įsilaužimas į vidų. Ta pati klasė vykdo ir tikrą `new Pool(...)`, tad tai NE
 * modelis to, ką darytų `pg`, o tas pats skaičiavimas.
 *
 * ⚠️ KONSTRAVIMAS NEJUNGIA. `new ConnectionParameters(cfg)` tik apskaičiuoja
 * laukus; jokio socket'o, jokios DNS užklausos. Aplinkos riba (PostgreSQL šioje
 * mašinoje nediegiamas) čia nepažeidžiama.
 */
const ConnectionParameters = require("pg/lib/connection-parameters");

/**
 * ⚠️ `pg` SKAITO `process.env` TIESIOGIAI, NE PERDUOTĄ OBJEKTĄ.
 *
 * `connection-parameters.js:15` — `process.env['PG' + key.toUpperCase()]`. Tad
 * norint sužinoti, ką duotų KITA aplinka, kito kelio nėra: `process.env` reikia
 * laikinai pakeisti.
 *
 * ⚠️ SINCHRONIŠKAI IR TIK SINCHRONIŠKAI. `fn` privalo būti sinchroninė (čia ji
 * visada yra vienas `new ConnectionParameters(...)`): `await` viduje atidarytų
 * langą, kuriame svetimas kodas matytų pakeistą `process.env`. `finally`
 * atstato ir mestos klaidos atveju.
 */
/**
 * ⚠️ ŽINOMA RIBA: TIKRINAMAS PERDUOTAS `env`, O `pg` SKAITO `process.env`.
 *
 * Kai kvietėjas paduoda savo objektą (`init({ DATABASE_URL: ... })`), sargas
 * mato TĄ objektą, o pool'as praleistiems laukams vis tiek ims GLOBALIĄ aplinką.
 * Tada `PGSSLMODE`, likęs `process.env`, perrašytų semantiką sargui to nematant.
 *
 * Nepataisyta sąmoningai: produkcijoje visi penki keliai kviečiami su
 * `process.env` (`server.js` `init()` be argumentų), o „sargas visada tikrina
 * globalą" reikštų, kad testo perduotas `env` nieko nebereiškia. Riba užrašyta,
 * ne užglaistyta (AGENTS.md §14.1).
 */
function suAplinka(env, fn) {
  const tikroji = process.env;
  try {
    process.env = env;
    const rezultatas = fn();

    /**
     * ⚠️ FAIL-CLOSED PRIEŠ ASINCHRONINĮ `fn` (#245 peržiūra, R8).
     *
     * `finally` atstato globalą, kai `fn` GRĮŽTA. Jei `fn` grąžintų `Promise`,
     * atstatymas įvyktų iškart, o pats darbas tęstųsi VĖLIAU — jau su tikrąja
     * aplinka. Blogesnis variantas: tarp `await` taškų kitas įeinantis kelias
     * matytų svetimą `process.env`, ir tai būtų kryžminė užklausų tarša —
     * gedimas, kurio nė vienas dabartinis testas nepagautų, nes jis pasireiškia
     * tik lygiagretumo lange.
     *
     * Šiandien `fn` visada yra vienas `new ConnectionParameters(...)`. Ši
     * asercija saugo ne šiandieną, o refaktoringą: ji paverčia tylią taršą
     * garsiu kritimu inicijavimo metu.
     */
    if (rezultatas !== null && typeof rezultatas === "object" && typeof rezultatas.then === "function") {
      throw new PgConnectionError(
        "`suAplinka()` callback grąžino `Promise`. Globalus `process.env` " +
          "keičiamas TIK sinchroniniam skaičiavimui: asinchroninis kelias " +
          "atstatytų aplinką per anksti ir kitiems kvietėjams rodytų svetimą.",
        "PG_ENV_SWAP_ASYNC"
      );
    }

    return rezultatas;
  } finally {
    process.env = tikroji;
  }
}

/** `null`, kai `pg` tokios konfigūracijos apskritai nepriimtų (pvz. `sslnegotiation=direct` be SSL). */
function pgParametrai(nustatymai, env) {
  if (!nustatymai) return null;
  try {
    return suAplinka(env, () => new ConnectionParameters(nustatymai));
  } catch (klaida) {
    /**
     * ⚠️ PROGRAMAVIMO KLAIDA NEVIRSTA „NEATPAŽINTA KONFIGŪRACIJA" (R8).
     *
     * Šis `catch` egzistuoja vienam dalykui: `pg` atmestai KONFIGŪRACIJAI. Jei
     * jis prarytų ir `PG_ENV_SWAP_ASYNC`, R8 sargas taptų nematomas — grąžintų
     * `null`, sargas praneštų „skirtumų nėra", ir asinchroninis refaktoringas
     * praeitų tyliai. Tiksliai tai, ko sargas turi neleisti.
     */
    if (klaida && klaida.code === "PG_ENV_SWAP_ASYNC") throw klaida;
    return null;
  }
}

/**
 * LAUKAS → KLASĖ. Klasė yra tai, KĄ skirtumas keičia, ne iš kur jis atėjo.
 *
 * ⚠️ NEŽINOMAS LAUKAS PATENKA Į `kita:<laukas>`, O NE IŠKRENTA. Jei `pg`
 * minoras pridės naują iš aplinkos skaitomą parametrą, jis pasirodys klaidoje
 * su savo vardu — garsiai. Numatytoji kryptis yra „reikšminga", nes tyliai
 * praleistas naujas parametras ir yra tas gedimas, kurio ieškom.
 */
const LAUKU_KLASES = Object.freeze({
  host: "taikinys",
  port: "taikinys",
  database: "taikinys",
  isDomainSocket: "taikinys",
  user: "kredencialai",
  password: "kredencialai",
  ssl: "saugumas",
  sslnegotiation: "saugumas",
  options: "sesija",
  replication: "sesija",
});

/**
 * ⚠️ NEREIKŠMINGI — SĄMONINGAS SPRENDIMAS, NE PRALEIDIMAS.
 *
 * `application_name` (`PGAPPNAME`) keičia tik tai, kaip jungtis vadinasi
 * `pg_stat_activity`; `connect_timeout` (`PGCONNECT_TIMEOUT`) yra operacinis
 * parametras. Nė vienas nekeičia taikinio, kredencialų, saugumo ar sesijos
 * namespace, tad startą stabdyti dėl jų reikštų drausti teisėtas konfigūracijas.
 *
 * ⚠️ KODĖL ČIA NĖRA `statement_timeout`, `query_timeout`, `lock_timeout`,
 * `idle_in_transaction_session_timeout`, `fallback_application_name`: `pg` jiems
 * paduoda `val(..., false)` (`connection-parameters.js:120-124`) — aplinkos
 * kintamojo jie NETURI, tad skirtis dėl aplinkos negali IŠ VISO. Jų įrašymas
 * teigtų patikrą, kurios nėra.
 */
const NEREIKSMINGI = Object.freeze([
  "application_name",
  "connect_timeout",
  /**
   * ⚠️ `binary` (`PGBINARY`) — NE „nereikšmingas", O BE VARTOTOJO (Codex, A).
   *
   * Ankstesnė redakcija jį klasifikavo kaip `sesija` su pagrindimu „keičia, kaip
   * serveris koduoja rezultatus". Tai buvo TEIGINYS, ne matavimas. Patikrinta
   * `pg` šaltinyje:
   *
   *   `ConnectionParameters.binary` priskiriamas (`connection-parameters.js:82`),
   *   bet `Client` jo NESKAITO: `client.js:102` ima `c.binary` iš ŽALIOS
   *   konfigūracijos, ne iš `this.connectionParameters.binary`. Kitų vartotojų
   *   JS kelyje nėra (patikrinta `grep "connectionParameters.binary"` — tuščia).
   *
   * Todėl `PGBINARY` su pilnu DSN nekeičia NIEKO, o startas krisdavo. Tai
   * klaidingas teigiamas fail-closed sarge — blogiausia jo kryptis.
   *
   * ⚠️ IR TAI YRA „REIKŠMĖ BE VARTOTOJO" KLASĖ MŪSŲ PAČIŲ NAUJAME KODE — ta
   * pati, kurią #245 gaudė `pg` laukų sąraše ir sarguose. Ji nesibaigia su kodo
   * autoriumi.
   */
  "binary",
  /**
   * ⚠️ `client_encoding` (`PGCLIENT_ENCODING`) — TA PATI KLASĖ KAIP `binary`, IR
   * ŠĮ KARTĄ AUDITAS SUSTOJO TIES PIRMU SKAITYTOJU (Codex V, C).
   *
   * Trečiame raunde PANEIGIAU teiginį, kad laukas nevartojamas: radau
   * `client.js:97` — `encoding: this.connectionParameters.client_encoding ||
   * "utf8"` — ir sustojau. Bet skaitytojas reikšmę PERDUODA, o ne VARTOJA.
   * Patikrinta grandinė iki galo:
   *
   *   `client.js:97`          → `new Connection({ encoding })`
   *   `connection.js:15-38`   → konstruktorius `config.encoding` NESKAITO
   *                             (`grep "encoding" connection.js` → 0 atitikmenų)
   *   `pg-protocol` `BufferReader` → `this.encoding = "utf-8"` FIKSUOTAI,
   *                             su komentaru `TODO(bmc): support non-utf8`
   *   `serializer.js:12`      → startup pakete visada `client_encoding=UTF8`
   *
   * Vadinasi net `LATIN1` runtime semantikos NEKEIČIA, o startas dėl jo krisdavo.
   *
   * ⚠️ TAI SUBTILESNIS „REIKŠMĖS BE VARTOTOJO" PAVIDALAS: vartotojas YRA, bet jis
   * pats jos nevartoja. Ir tai antras kartas, kai suklydau ties TUO PAČIU lauku —
   * pirmą kartą per plačiai („perrašo DSN"), antrą per siaurai („turi vartotoją").
   *
   * ⚠️ LIEKA RIBA: `connection-parameters.js:173` jį įrašo į
   * `getLibpqConnectionString()`, kurį naudoja `pg-native`. Repo `pg-native`
   * NENAUDOJA (patikrinta); atsiradus jam šis įrašas turėtų grįžti į klases.
   */
  "client_encoding",
]);

/**
 * LAUKŲ NORMALIZAVIMAS PRIEŠ PALYGINIMĄ — VIENA TIESA APIE LYGYBĘ (Codex, C/A).
 *
 * ⚠️ IKI ŠITO MODULYJE BUVO DVI TIESOS APIE HOST'Ų LYGYBĘ. `normalizuotiHosta()`
 * egzistuoja nuo #280 ir taikomas rodomai tapatybei, bet dviprasmybės
 * palyginimas lygino ŽALIAS reikšmes. Pasekmė: `PGHOST=LOCALHOST` su DSN be
 * host'o duodavo `LOCALHOST` prieš `localhost` ir STABDYDAVO startą, nors DNS
 * vardai registrui nejautrūs. Sargas, kurio visa prasmė yra fail-closed,
 * blokuodavo teisėtą konfigūraciją — blogiausia kryptis.
 *
 * ⚠️ `client_encoding` ČIA NEBĖRA: jis perkeltas į `NEREIKSMINGI`, nes grandinė
 * `Client` → `Connection` → `pg-protocol` jo NEVARTOJA (žr. ten). Normalizatorius
 * jam būtų antras „be vartotojo" įrašas — šįkart mano paties kode.
 *
 * ⚠️ `isDomainSocket` NENORMALIZUOJAMAS SĄMONINGAI: jis IŠVEDAMAS iš `host`
 * (`connection-parameters.js:117`), tad be `host` skirtumo skirtis negali. JS
 * kelyje jo apskritai niekas neskaito (naudojamas tik `getLibpqConnectionString()`),
 * bet jo palyginimas yra nekenksmingas perteklius, o ne klaidingas teigiamas.
 */
const NORMALIZATORIAI = Object.freeze({
  host: (v) => normalizuotiHosta(v),
});

/** `ssl` gali būti `false`, `true`, `"no-verify"` arba objektas — lyginama forma, ne tapatybė. */
function palyginamaReiksme(reiksme) {
  if (reiksme === null || reiksme === undefined) return "\u0000nera";
  if (typeof reiksme === "object") return JSON.stringify(reiksme);
  return String(reiksme);
}

/**
 * KURIOS SEMANTIKOS KLASĖS SKIRIASI, kai greta `DATABASE_URL` veikia aplinka.
 *
 * Grąžina klasių VARDUS. Reikšmės lieka šios funkcijos viduje ir iš jos
 * neišeina niekada — `password` yra viena iš lyginamų.
 *
 * ⚠️ TIKRINAMA TIK KAI YRA `DATABASE_URL`. Be jo antros interpretacijos nėra:
 * `PG*` yra vienintelė forma, ir „skirtumas nuo DSN" jai neapibrėžtas.
 */
/**
 * ⚠️ `pg` RUNTIME PAVIRŠIUS, KURIO MODELIS NEMATO (Codex IV, B).
 *
 * S2 sprendimas — „semantiką skaičiuoja pats `pg`" — galioja KONSTRAVIMUI:
 * `ConnectionParameters` yra vienas momentas, o `Client` po jo daro daugiau.
 * Konkrečiai: kai slaptažodis lieka tuščias, `Client` kviečia `pgpass`
 * (`client.js:299`), o šis skaito `PGPASSFILE` (`pgpass/lib/helper.js:58`).
 * Modelyje to nėra — `ConnectionParameters` `PGPASSFILE` neskaito, tad
 * palyginimas rodydavo NULĮ skirtumų, nors aplinka realiai duoda kredencialus.
 *
 * ⚠️ TAI NĖRA IŠVEDIMO PAKEITIMAS Į RANKINĮ SĄRAŠĄ. `pg` skaitomų kintamųjų aibė
 * toliau išvedama (R4 tripwire). Čia pridedamas ĮVARDYTAS papildomas paviršius,
 * kurio išvesti neįmanoma: jis gyvena kitoje bibliotekoje ir kitame gyvavimo
 * etape, tad `Proxy` seklys ant `ConnectionParameters` jo nepagauna.
 *
 * ⚠️ PAŽADO RIBA, KURIOS ŠIS SĄRAŠAS NEUŽDARO. `pgpass` numatytai skaito
 * `~/.pgpass` (`HOME` kelias) NET BE jokio aplinkos kintamojo. Failas nėra
 * aplinkos skirtumas — abiem palyginimo pusėms jis tas pats, — ir slaptažodis iš
 * `~/.pgpass` DSN'ui be slaptažodžio yra teisėtas libpq raštas, ne dviprasmybė.
 * Todėl sargas pažada siauriau: kredencialų skirtumai, MATOMI
 * `ConnectionParameters`, plius `PGPASSFILE`. Žr. `CHANGELOG` ir
 * `docs/backup-runbook.md` — ten tas pats pažadas užrašytas ta pačia riba.
 */
const RUNTIME_KREDENCIALAI = Object.freeze(["PGPASSFILE"]);

function jungtiesSemantikosSkirtumai(env = process.env) {
  if (!env.DATABASE_URL) return [];

  const nustatymai = { connectionString: env.DATABASE_URL };
  const suAplinkos = pgParametrai(nustatymai, env);
  const beAplinkos = pgParametrai(nustatymai, {});

  /** Nepriimtinos konfigūracijos klaida yra ne dviprasmybė — ją praneša pats `pg` pool'o statyme. */
  if (!suAplinkos || !beAplinkos) return [];

  const laukai = new Set([...Object.keys(suAplinkos), ...Object.keys(beAplinkos), "password"]);
  const klases = new Set();

  for (const laukas of laukai) {
    if (NEREIKSMINGI.includes(laukas)) continue;

    const normalizuoti = NORMALIZATORIAI[laukas] || ((v) => v);
    const su = palyginamaReiksme(normalizuoti(suAplinkos[laukas]));
    const be = palyginamaReiksme(normalizuoti(beAplinkos[laukas]));

    if (su === be) continue;
    klases.add(LAUKU_KLASES[laukas] || `kita:${laukas}`);
  }

  /**
   * ⚠️ RUNTIME KREDENCIALAI — TIK KAI JIE REALIAI BŪTŲ PANAUDOTI.
   *
   * `Client` `pgpass` kviečia TIK tada, kai slaptažodis liko tuščias. Su DSN,
   * kuriame slaptažodis yra, `PGPASSFILE` įtakos neturi, ir stabdyti startą dėl
   * jo reikštų tą patį klaidingą teigiamą, kurį uždarė `PGBINARY` ir `PGHOST`
   * registro atvejai.
   */
  if (!suAplinkos.password && RUNTIME_KREDENCIALAI.some((raktas) => env[raktas])) {
    klases.add("kredencialai");
  }

  return [...klases].sort();
}

function arDviprasmiskaKonfiguracija(env = process.env) {
  return jungtiesSemantikosSkirtumai(env).length > 0;
}

/**
 * EFEKTYVŪS JUNGTIES PARAMETRAI — „kur `pg` realiai jungsis", ne „kas parašyta".
 *
 * ⚠️ EILIŠKUMAS PAIMTAS IŠ `pg` ŠALTINIO (`lib/connection-parameters.js:5-17`):
 *
 *   val(key, config) = config[key] || process.env["PG" + KEY] || defaults[key]
 *
 * `defaults` yra STATINIAI (`host: "localhost"`, `port: 5432`), ir jie env
 * NESKAITO — env atsargą taiko pats `val()`. Todėl DSN be porto reiškia ne
 * „5432", o „portas iš aplinkos, jei yra". Išmatuota:
 *
 *   postgres://u@host/db      + PGPORT=6543  ->  host:6543/db
 *   postgres://u@host:5432/db + PGPORT=6543  ->  host:5432/db
 *   postgres://vartotojas@host/               ->  host:5432/vartotojas
 *
 * ⚠️ `database` KRENTA Į `user` (`connection-parameters.js:66-68`), ne į tuščią.
 */
/**
 * HOST'O NORMALIZAVIMAS — DNS VARDAI, BET NE SOCKET KELIAI (#280 follow-up).
 *
 * ⚠️ `toLowerCase()` VISAM HOST'UI YRA NETEISINGA.
 *
 * DNS vardai case-insensitive, tad `HOST.example` ir `host.example` yra ta pati
 * mašina. Bet `?host=/Prod` yra FAILŲ SISTEMOS KELIAS iki unix socket katalogo,
 * o failų sistema gali skirti raides: `pg` `/Prod` ir `/prod` laiko skirtingais
 * taikiniais, o tapatumas juos sutapdydavo.
 *
 * ⚠️ VIENAS HELPERIS, NE DVI KOPIJOS. Iki šito normalizavimas gyveno dviejose
 * vietose (`efektyvusJungtiesParametrai` ir `jungtiesTapatybe` diskrečioji šaka),
 * ir taisant vieną pora būtų išsiskyrusi.
 */
function normalizuotiHosta(host) {
  const reiksme = String(host || "").trim();
  if (reiksme.startsWith("/")) return reiksme;
  return reiksme.toLowerCase();
}

/**
 * ⚠️ `options` YRA TAIKINIO DALIS, NE PAPUOŠALAS (#280 follow-up, P1).
 *
 * `pg` `options` perduoda serveriui startup pakete
 * (`connection-parameters.js:83, 151`), o `-csearch_path=…` keičia SCHEMĄ.
 * Visos suderinimo užklausos naudoja NEKVALIFIKUOTUS lentelių vardus, tad du
 * DSN, besiskiriantys tik `options=-csearch_path=prod` vs `…=restore`, rodo į
 * SKIRTINGAS lenteles — o tapatumas juos laikė vienodais.
 *
 * ⚠️ ĮTRAUKIAMA, NE ATMETAMA. Atmesti „namespace keičiančius parametrus" reikštų
 * savo raktažodžių sąrašą greta to, ką supranta `pg` — tiksliai ta antros
 * interpretacijos klasė, kurią šis modulis kaip tik uždarė. `options` imamas iš
 * to paties `val()` eiliškumo (patikrinta: `PGOPTIONS` fallback veikia).
 *
 * ⚠️ Lyginama ŽALIA eilutė: semantiškai lygiavertis, bet kitaip užrašytas
 * `options` duos NESUTAPIMĄ. Tai fail-closed kryptis, ir ji sąmoninga.
 */
function efektyvusJungtiesParametrai(nustatymai, env = process.env) {
  const p = pgParametrai(nustatymai, env);
  if (!p) return null;

  let nurodyta;
  try {
    const parsed = nustatymai.connectionString ? parseDsn(nustatymai.connectionString) : nustatymai;
    /**
     * ⚠️ „AR TAPATYBĖ APSKRITAI YRA" — SĄMONINGAI SIAURIAU UŽ `pg`.
     *
     * `pg` bazės vardui turi dar vieną atsargą: `defaults.user`, t. y. OPERACINĖS
     * SISTEMOS naudotojo vardas (`defaults.js:5`). Jos čia NEPAISOMA: paveldėjus
     * OS naudotoją būtų sukurta tapatybė ten, kur operatorius bazės neįvardijo, ir
     * DR palyginimas gautų ką lyginti vietoj to, kad kristų fail-closed.
     */
    nurodyta = Boolean(parsed.database || env.PGDATABASE || parsed.user || env.PGUSER);
  } catch {
    return null;
  }
  if (!nurodyta) return null;

  const host = normalizuotiHosta(p.host);
  if (!host || !p.database) return null;

  /**
   * ⚠️ RODOMA TAPATYBĖ YRA SIAURESNĖ UŽ PALYGINIMO RINKINĮ (#245).
   *
   * `pgParametrai()` turi `user`, `password`, `ssl`, `sslnegotiation` ir kitus —
   * jie reikalingi konfliktui NUSTATYTI. Grąžinami tik tie keturi laukai, kuriuos
   * saugu rodyti: šis objektas keliauja į `tapatybesTekstas()`, o iš ten į klaidų
   * tekstus, logus ir testų snapshot'us.
   *
   * Išplėtus ŠĮ objektą kredencialais, slaptažodis ten patektų savaime. Todėl
   * rinkiniai atskirti, o ne vienas objektas plečiamas abiem tikslams.
   */
  return {
    host,
    port: String(p.port),
    database: String(p.database),
    options: String(p.options || ""),
  };
}

/**
 * JUNGTIES TAPATYBĖ IŠ NUSTATYMŲ: `{ host, port, database }` arba `null`.
 *
 * ⚠️ VIENAS AUTORITETAS DVIEM KELIAMS (#249, 7.6b). 7.6a `pgDumpBackup.js`
 * turėjo savo kopiją šios logikos; antras darbas, kuriam reikia to paties
 * klausimo („ar tai TA PATI bazė?"), reikštų dvi tiesas apie tapatumą, ir jos
 * ilgainiui išsiskirtų. Palyginimo semantika gyvena ČIA - ten pat, kur jau
 * užrašyta jos riba (žr. `tapatiBaze()`): du klasteriai tame pačiame hoste su
 * vienodu bazės vardu palyginime SUTAMPA.
 */
function jungtiesTapatybe(nustatymai, env = process.env) {
  if (!nustatymai) return null;

  /**
   * ⚠️ ABI FORMOS — VIENA FUNKCIJA (#280 follow-up).
   *
   * `efektyvusJungtiesParametrai()` moka ir DSN (per `pg-connection-string`,
   * tą pačią biblioteką, kurią naudoja `pg`), ir diskrečius `PG*` laukus. Iki
   * šito diskrečioji šaka turėjo SAVO kodą: be `pg` numatytųjų, be
   * `database → user` atsargos ir su savo `toLowerCase()`.
   *
   * ⚠️ ANKSTESNĖ ATASKAITA TEIGĖ, KAD „abi formos eina per tą pačią funkciją".
   * Tai buvo netiesa — vietinis testas tikrino `efektyvusJungtiesParametrai()`
   * TIESIOGIAI, o `arTaPatiBaze()` `PG*` atveju eidavo pro senąją šaką. Pagavo
   * ne peržiūra, o šio darbo 0 žingsnis.
   */
  try {
    return efektyvusJungtiesParametrai(nustatymai, env);
  } catch {
    return null;
  }
}

/** Skaitoma forma klaidos žinutėje - BE kredencialų. */
function tapatybesTekstas(tapatybe) {
  if (!tapatybe) return "<neatpažinta>";

  /** `options` rodomas TIK kai jis yra — kitaip nesutapimo priežastis liktų nematoma. */
  const pagrindas = `${tapatybe.host}:${tapatybe.port}/${tapatybe.database}`;
  return tapatybe.options ? `${pagrindas} (options=${tapatybe.options})` : pagrindas;
}

/**
 * Ar nurodytas URL rodo į TĄ PAČIĄ bazę, kurią naudotų šios aplinkos saugyklos?
 *
 * ⚠️ PALYGINIMAS PAGAL KONSTRUKCIJĄ, ne per vykdymo meto zondą - tai ta pati
 * riba, kurią aprašo šio failo antraštė. Neatpažinta forma reiškia NESUTAPIMĄ
 * (fail-closed), o ne „tikriausiai gerai".
 */
/**
 * ⚠️ TREČIAS ARGUMENTAS — KAI PATIKRA IR VYKDYMAS MATO SKIRTINGĄ APLINKĄ.
 *
 * Iki ketvirto peržiūros raundo jo nereikėjo: visi keliai vykdydavo su ta pačia
 * aplinka, kurią matė patikra. `libpqSvariAplinka()` tai PAKEITĖ — `pg_dump` ir
 * `psql` dabar gauna aplinką BE `PG*`, o patikra `--url` toliau sprendė su
 * pilna. Nesutapimas: patikra patvirtindavo `db.prod:6543`, o vaikinis procesas
 * jungdavosi prie `db.prod:5432`.
 *
 * ⚠️ TAI NE RECIDYVAS, O PATAISOS ŠALUTINIS POVEIKIS. Ankstesnė būsena buvo
 * bloga kitaip (vaikas paveldėdavo `PG*`), bet modelis ir vykdymas SUTAPDAVO.
 * Uždarius paveldėjimą, jie išsiskyrė — ir tai klausimas, kurį reikia užduoti po
 * KIEKVIENO ribos uždarymo: kas dabar mato kitokią tikrovę nei anksčiau?
 *
 * `vykdymoAplinka` liečia TIK `nurodyta` pusę — tą URL, kuris keliauja
 * vykdytojui. `konfiguracija` (mūsų pačių pool'ai) sprendžiama su TIKRA aplinka,
 * nes Node pool'ai `process.env` skaito ir toliau.
 */
function arTaPatiBaze(url, env = process.env, vykdymoAplinka = env) {
  /**
   * ⚠️ DVIPRASMYBĖ TIKRINAMA PIRMA. Su abiem formomis prioritetas priklauso nuo
   * to, kas konstruoja pool'ą, tad „ta pati bazė?" atsakymo apskritai neturi.
   */
  const skirtumai = jungtiesSemantikosSkirtumai(env);
  if (skirtumai.length > 0) {
    throw new PgConnectionError(dviprasmybesTekstas(skirtumai), "PG_CONNECTION_AMBIGUOUS");
  }

  /**
   * ⚠️ TA PATI APLINKA ABIEM PUSĖM. Operatorius `--target` rašo tame pačiame
   * shell'e, kuriame gyvena `PG*`, tad ir jo DSN `pg` interpretuotų su tais
   * pačiais fallback'ais. Skirtingas eiliškumas dviem pusėms būtų trečia
   * interpretacija.
   */
  const konfiguracija = jungtiesTapatybe(pgJungtiesNustatymai(env), env);
  const nurodyta = jungtiesTapatybe({ connectionString: url }, vykdymoAplinka);

  const sutampa =
    konfiguracija !== null &&
    nurodyta !== null &&
    konfiguracija.host === nurodyta.host &&
    konfiguracija.port === nurodyta.port &&
    konfiguracija.database === nurodyta.database &&
    konfiguracija.options === nurodyta.options;

  return { sutampa, nurodyta, konfiguracija };
}

/**
 * TRIPWIRE: ar dvi jungtys realiai rodo į tą pačią bazę?
 *
 * ⚠️ NE KOREKTIŠKUMO MECHANIZMAS — žr. failo viršų. Grąžina `{ sutampa, a, b }`,
 * kad kvietėjas galėtų pranešti KONKREČIAI, kas nesutapo.
 */
async function tapatiBaze(klientasA, klientasB) {
  const uzklausa = "SELECT current_database() AS db, inet_server_port() AS port";

  const [a, b] = await Promise.all([klientasA.query(uzklausa), klientasB.query(uzklausa)]);
  const x = a.rows[0];
  const y = b.rows[0];

  return {
    sutampa: x.db === y.db && String(x.port) === String(y.port),
    a: `${x.db}:${x.port}`,
    b: `${y.db}:${y.port}`,
  };
}

/**
 * KLAIDOS TEKSTAS — TIK KLASĖS, NIEKADA REIKŠMĖS (#245).
 *
 * ⚠️ Įvardyti, pavyzdžiui, „user=prod vs user=restore" būtų patogu, bet
 * `kredencialai` klasė apima ir `password`. Vienas neatsargus formatavimas
 * nuvestų slaptažodį į klaidos tekstą, logus ir testų snapshot'us — todėl
 * reikšmių čia nėra IŠ VISO, o ne „nėra slaptažodžio".
 */
function dviprasmybesTekstas(skirtumai) {
  return (
    "Aplinkoje `DATABASE_URL` ir `PG*` duoda SKIRTINGĄ efektyvią jungties " +
    `semantiką (${skirtumai.join(", ")}) - neaišku, į kurią bazę bus jungiamasi. ` +
    "Palikite VIENĄ formą arba suderinkite reikšmes. " +
    "Vien `PG*` buvimas greta `DATABASE_URL` klaida NĖRA: tikrinama, ar jie keičia " +
    "taikinį, kredencialus, SSL ar sesijos semantiką."
  );
}

module.exports = {
  pgJungtiesNustatymai,
  jungtiesSemantikosSkirtumai,
  dviprasmybesTekstas,
  RUNTIME_KREDENCIALAI,
  LAUKU_KLASES,
  NEREIKSMINGI,
  arNurodytaPostgres,
  tapatiBaze,
  PgConnectionError,
  normalizuotiHosta,
  arDviprasmiskaKonfiguracija,
  efektyvusJungtiesParametrai,
  jungtiesTapatybe,
  tapatybesTekstas,
  arTaPatiBaze,
  PG_ATITIKMENYS,
};
