const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const backupEncryption = require("./backupEncryption");
const backupManifest = require("./backupManifest");
const backupPolicy = require("./backupPolicy");
const { arNurodytaPostgres, arTaPatiBaze, tapatybesTekstas } = require("./pgConnection");
const privacyConfig = require("./privacyConfig");
const tombstones = require("./deletionTombstones");
/**
 * ⚠️ NE DESTRUKTŪRIZUOJAMA. Destruktūrizuota nuoroda užfiksuojama `require` metu,
 * ir integracinis testas nebegalėtų patikrinti, KAD auditas realiai kviečiamas
 * iš šio kelio - liktų tik statinė patikra (§9.2).
 */
const auditWrite = require("./auditWrite");
const { createLogger } = require("./logger");

const vykdyti = promisify(execFile);
const log = createLogger("pg-dump-backup");

/**
 * ŠIFRUOTA PostgreSQL KOPIJA IR JOS ATKŪRIMAS (#155, 7.6a / #248).
 *
 * ⚠️ VIENAS KELIAS OPERATORIUI IR TESTUI (D2).
 *
 * Visa orkestracija — `pg_dump`, manifesto sudarymas, AES-256-GCM šifravimas,
 * patikros prieš atkūrimą ir `psql` iškvietimas — gyvena ČIA. `scripts/pg-backup.mjs`
 * yra plonas apvalkalas, o integracinis testas kviečia tas pačias funkcijas.
 *
 * Testas, kuris pats sudėliotų `pg_dump` → šifravimas → `psql`, tikrintų savo
 * imitaciją, ne procedūrą, kurią vykdo operatorius (§9.2).
 *
 * ⚠️ ARTEFAKTO RŪŠIS GYVENA ŠIFRUOTAME TURINYJE, NE MANIFESTE (D1).
 *
 * Svarstyti trys variantai:
 *
 *   (a) naujas kanoninis `ARTEFACT_TYPES` tipas — ATMESTA. Registras maitina
 *       GDPR ištrynimo inventorių, ne kopijų politiką. `isIncluded()` išvedamas
 *       iš `persistence`, tad persistentinis tipas AUTOMATIŠKAI patektų ir į
 *       aplikacijos JSON kopiją, kur jo semantika netinka; pažymėjus jį
 *       `EXCLUDED_DESPITE_PERSISTENT`, `isIncluded()` grąžintų `false`, o
 *       `createManifest()` tokį `contents` įrašą ATMESTŲ (`backupManifest.js:82`) —
 *       t. y. variantas prieštarauja pats sau. Be to `artefactScanner` reikalauja
 *       skenavimo strategijos KIEKVIENAM registro tipui (gina
 *       `lifecycleE2E.test.js`), o DB dump'as nėra susietas su subjektu, tad
 *       tokios strategijos prasmingai parašyti nėra kaip.
 *
 *   (b) atskira ašis — PASIRINKTA. `ARTEFACT_TYPES` neliečiamas, ištrynimo
 *       inventorius nepajudinamas, `isIncluded()` nekeičiamas. Manifestas
 *       naudojamas toks, koks yra, su TUŠČIU `contents`: DB dump'as nėra
 *       aplikacijos artefaktų inventorius, ir melagingas įrašas ten būtų
 *       blogesnis už tuščią.
 *
 *   (c) naujas manifesto laukas — ATMESTA kaip nepakankamas. Laukas, kurio nėra
 *       `AUTHENTICATED_MANIFEST_FIELDS` sąraše, nėra apsaugotas GCM žyma, o to
 *       sąrašo keitimas reikštų v2 AAD formato keitimą, kurio šis darbas
 *       nedaro.
 *
 * Todėl rūšis ir dump'o formatas rašomi į PATĮ ŠIFRUOJAMĄ TURINĮ — GCM juos
 * autentifikuoja kartu su SQL, ir jokio AAD ar kriptografijos keitimo nereikia.
 */

/** Antraštė, kurią GCM autentifikuoja kartu su SQL. */
const ANTRASTE = "STENOGRAMA-PG-DUMP";
const ANTRASTES_VERSIJA = "v1";

/**
 * ⚠️ `plain` FORMATAS PASIRINKTAS DĖL D4 (atomiškumo).
 *
 * `psql --single-transaction` visą atkūrimą vykdo vienoje transakcijoje: SQL
 * klaida viduryje reiškia `ROLLBACK`, ne pusiau atkurtą bazę. `custom` formatas
 * su `pg_restore` tokios garantijos be papildomų prielaidų neduoda.
 */
const DUMP_FORMATAS = "plain";

/**
 * `pg_dump` argumentai — VIENAS sąrašas, kad jį būtų galima tikrinti.
 *
 * `--exclude-table-data=audit_log` (7.4d): auditas į kopiją nepatenka sąmoningai.
 * `--no-owner`/`--no-privileges`: atkūrimas į kitą bazę neturi reikalauti tų
 * pačių rolių.
 */
const PG_DUMP_ARGUMENTAI = (databaseUrl) => [
  "--exclude-table-data=audit_log",
  "--no-owner",
  "--no-privileges",
  databaseUrl,
];

/** Vėliavos, kurios SULAUŽYTŲ nuoseklų snapshot'ą. Tikrina kontrakto testas. */
const SNAPSHOTA_LAUZANCIOS_VELIAVOS = Object.freeze([
  "--no-synchronized-snapshots",
  "--jobs",
  "-j",
]);

/**
 * KREDENCIALŲ REDAGAVIMAS (Codex P1, #262 peržiūra).
 *
 * ⚠️ IŠMATUOTA, NE NUMANOMA. `execFile` atmetimo žinutė ir `err.cmd` turi VISĄ
 * argumentų eilutę, o joje - `postgres://vartotojas:SLAPTAZODIS@...`:
 *
 *   MSG: Command failed: pg_dump --no-owner postgres://vartotojas:SLAPTAS123@...
 *   CMD: pg_dump --no-owner postgres://vartotojas:SLAPTAS123@...
 *
 * CLI tą žinutę spausdina į stderr, tad be šio filtro slaptažodis atsiduria
 * operatoriaus terminale ir CI žurnale.
 */
/**
 * ⚠️ GODUS `[^/\s]*` IKI PASKUTINIO `@` - IR TAI NE SMULKMENA.
 *
 * Pirmoji redakcija sustodavo ties PIRMU `@`, tad slaptažodis su neekranuotu
 * `@` likdavo pusiau matomas (išmatuota, #262 peržiūra):
 *
 *   postgres://u:SLA@PTA@host/db  ->  postgres://u:***@PTA@host/db
 *
 * `PTA` yra slaptažodžio fragmentas. Būtent tokie slaptažodžiai ir yra
 * priežastis, dėl kurios egzistuoja `PG*` kelias (`utils/pgConnection.js`), tad
 * ši klasė čia nėra teorinė.
 */
const KREDENCIALAI_URL = /\b([a-z][a-z0-9+.\-]*:\/\/)([^/\s]*)@/gi;

/** `u:slaptas` -> `u:***`; `u` (be slaptažodžio) lieka `u`. */
function _redaguotasVartotojas(vartotojoDalis) {
  const dvitaskis = vartotojoDalis.indexOf(":");
  return dvitaskis === -1 ? vartotojoDalis : `${vartotojoDalis.slice(0, dvitaskis)}:***`;
}

/** `postgres://u:slaptas@host:5432/db` -> `postgres://u:***@host:5432/db`. */
function redaguotasUrl(url) {
  if (!url) return "<nenurodyta>";
  return String(url).replace(
    KREDENCIALAI_URL,
    (_, schema, vartotojoDalis) => `${schema}${_redaguotasVartotojas(vartotojoDalis)}@`
  );
}

/**
 * Pašalina kredencialus iš bet kokio teksto, keliaujančio į logą ar klaidą.
 *
 * ⚠️ DVI AŠYS. Bendras šablonas gaudo URL formos kredencialus, o eksplicitiškai
 * perduotas `url` pakeičiamas ir tada, kai jo forma šablono netenkina (pvz.
 * slaptažodis su `@`, dėl kurio `PG*` kelias apskritai egzistuoja).
 */
function bePaslapciu(tekstas, url = null) {
  let t = String(tekstas ?? "");
  if (url) t = t.split(String(url)).join(redaguotasUrl(url));
  return t.replace(
    KREDENCIALAI_URL,
    (_, schema, vartotojoDalis) => `${schema}${_redaguotasVartotojas(vartotojoDalis)}@`
  );
}

/**
 * `psql` stderr BE ATKURTŲ EILUČIŲ TURINIO (Codex P1).
 *
 * ⚠️ `DETAIL:` ir `CONTEXT:` NEŠA DUOMENIS, ne diagnostiką:
 *
 *   psql:<stdin>:42: ERROR:  duplicate key value violates unique constraint
 *   psql:<stdin>:42: DETAIL:  Key (id)=(abc) already exists.
 *   psql:<stdin>:42: CONTEXT:  COPY jobs, line 3: "abc\tTRANSKRIPCIJOS TEKSTAS..."
 *
 * Trečioji eilutė yra transkripcijos fragmentas. `ERROR:` eilutė diagnozei
 * pakanka, tad į klaidos žinutę patenka tik ji.
 */
const DUOMENIS_NESANCIOS = /(^|:\s*)(DETAIL|CONTEXT):/i;

function saugusStderr(stderr, targetUrl = null) {
  const eilutes = String(stderr ?? "").split("\n");
  const paliktos = eilutes.filter((e) => e.trim() && !DUOMENIS_NESANCIOS.test(e));
  const pasalinta = eilutes.filter((e) => e.trim()).length - paliktos.length;

  const tekstas = bePaslapciu(paliktos.join(" | ").trim(), targetUrl).slice(0, 500);
  return pasalinta > 0 ? `${tekstas} [pašalinta ${pasalinta} eil. su duomenimis]` : tekstas;
}

class PgDumpBackupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PgDumpBackupError";
    this.code = code;
  }
}

/** Ar `pg_dump`/`psql` apskritai pasiekiami? Grąžina versijos eilutę arba `null`. */
async function klientoVersija(binaras = "pg_dump") {
  try {
    const { stdout } = await vykdyti(binaras, ["--version"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function _antrasteBaitais(dumpFormatas) {
  return Buffer.from(`${ANTRASTE}\n${ANTRASTES_VERSIJA}\n${dumpFormatas}\n\n`, "utf8");
}

/**
 * Išskiria antraštę iš dešifruoto turinio.
 *
 * ⚠️ FAIL-CLOSED: antraštės nebuvimas ar kita rūšis reiškia, kad tai NE šios
 * procedūros artefaktas, ir SQL vykdyti negalima. Be šios patikros aplikacijos
 * JSON kopija būtų paduota į `psql`.
 */
function _perskaitytiAntraste(plaintext) {
  const riba = plaintext.indexOf("\n\n");
  if (riba === -1) {
    throw new PgDumpBackupError(
      "Dešifruotas turinys neturi dump'o antraštės - tai ne PostgreSQL kopijos artefaktas.",
      "PG_DUMP_HEADER_MISSING"
    );
  }

  const eilutes = plaintext.slice(0, riba).split("\n");
  if (eilutes[0] !== ANTRASTE) {
    throw new PgDumpBackupError(
      `Netikėta artefakto rūšis: ${JSON.stringify(eilutes[0])}.`,
      "PG_DUMP_KIND_MISMATCH"
    );
  }
  if (eilutes[1] !== ANTRASTES_VERSIJA) {
    throw new PgDumpBackupError(
      `Nepalaikoma dump'o antraštės versija: ${JSON.stringify(eilutes[1])}.`,
      "PG_DUMP_HEADER_VERSION"
    );
  }

  return { dumpFormatas: eilutes[2], sql: plaintext.slice(riba + 2) };
}

/**
 * Sukuria ŠIFRUOTĄ `pg_dump` kopiją.
 *
 * ⚠️ `--exclude-table-data=audit_log` (7.4d) — auditas į kopiją NEPATENKA
 * sąmoningai; ta pati taisyklė, kurią jau aprašo runbook'as.
 *
 * @returns {{ manifest: object, envelope: object, dumpBytes: number }}
 */
async function sukurtiSifruotaKopija({ databaseUrl, actor = null, env = process.env } = {}) {
  if (!databaseUrl) {
    throw new PgDumpBackupError("Nenurodytas `databaseUrl`.", "PG_DUMP_NO_URL");
  }

  /**
   * ⚠️ ADMINISTRACINIS JUNGIKLIS TIKRINAMAS PIRMAS (Codex P1).
   *
   * `backupService.js:46` išjungtas kopijas atmeta `BACKUP_DISABLED` klaida. Šis
   * kelias to neklausė, tad `BACKUP_ENABLED=false` diegime operatorius vis tiek
   * pagamindavo šifruotą visos bazės kopiją - t. y. jungiklis reiškė mažiau, nei
   * sako jo vardas.
   *
   * Prieš šifravimo patikrą sąmoningai: „kopijos išjungtos" yra sprendimas, o
   * „nėra rakto" - konfigūracijos trūkumas. Sprendimas turi pirmenybę.
   */
  if (!backupPolicy.isEnabled(env)) {
    throw new PgDumpBackupError("Kopijos išjungtos (`BACKUP_ENABLED`).", "BACKUP_DISABLED");
  }

  if (!backupEncryption.isEnabled(env)) {
    /**
     * ⚠️ NEŠIFRUOTA KOPIJA NĖRA ŠIOS PROCEDŪROS BAIGTIS. `job_results` turi
     * transkripcijas; paprastas `pg_dump` kriterijaus NETENKINA (#248 DoD).
     */
    throw new PgDumpBackupError(
      "Šifravimas neįjungtas: `pg_dump` be AES-256-GCM netenkina 7.6a kriterijaus.",
      "BACKUP_ENCRYPTION_DISABLED"
    );
  }

  /**
   * ⚠️ RAKTAS TIKRINAMAS ČIA, NE `encrypt()` METU (#262 IV raundas).
   *
   * `isEnabled()` tikrina tik NETUŠTUMĄ. Blogai suformatuotas raktas praeidavo
   * visą `pg_dump`, PATVARIAI pastumdavo `backup_horizon` ir tik tada krisdavo
   * ties `encrypt()`. Cron'as su tokia konfigūracija būtų tęsęs žymų retencijos
   * horizontą neišduodamas NĖ VIENO artefakto - GDPR pusėje veikianti pasekmė
   * iš paprastos konfigūracijos klaidos.
   *
   * Griežta 64 hex patikra priklauso TAM PAČIAM „artefakto savybės" žingsniui,
   * kur jau stovi `isEnabled()`: sprendimas -> artefakto savybė -> tapatumas ->
   * darbas. Naudojamas `currentKey()`, o ne savas regex - kriptografinė
   * semantika lieka viename modulyje.
   */
  try {
    backupEncryption.currentKey(env);
  } catch (klaida) {
    throw new PgDumpBackupError(
      `Šifravimo raktas netinkamas: ${klaida.message}`,
      "BACKUP_KEY_INVALID"
    );
  }

  /**
   * ⚠️ TAPATUMAS TIKRINAMAS PRIEŠ `pg_dump`, NE PO JO. Atsisakymas po 200 MB
   * dump'o būtų teisingas, bet brangus, o klaida - ta pati. Tvarka: sprendimas
   * (`BACKUP_ENABLED`) → artefakto savybė (šifravimas) → tapatumas → darbas.
   */
  patikrintiZymuTapatuma(databaseUrl);

  const snapshotTime = Date.now();

  /**
   * ⚠️ ŠALTINIO NUOSEKLUMAS YRA KOPIJOS KOREKTIŠKUMO SĄLYGA, NE DETALĖ.
   *
   * `pg_dump` visą kopiją ima VIENU nuosekliu snapshot'u (`REPEATABLE READ`
   * transakcija), tad `jobs` ir susiję `job_results` NEGALI būti paimti iš
   * skirtingų loginių momentų. Be to atkurta bazė galėtų turėti `job_results`
   * eilutę, kurios `jobs` pusėje nėra — ir tai atrodytų kaip teisingas
   * atkūrimas.
   *
   * ⚠️ TODĖL ARGUMENTŲ SĄRAŠE NĖRA IR NEGALI ATSIRASTI:
   *
   *   `--no-synchronized-snapshots` — atsisako bendro snapshot'o;
   *   `--jobs` / `-j`               — lygiagretus dump'as, kuris be
   *                                   sinchronizuotų snapshot'ų prasmės neturi.
   *
   * Tai gina `pgDumpBackupContract` sargas: vėliavų sąrašas tikrinamas, nes
   * viena netyčia pridėta vėliava tyliai panaikintų garantiją, kuria remiasi
   * atkūrimo testas.
   */
  let sql;
  try {
    ({ stdout: sql } = await vykdyti("pg_dump", PG_DUMP_ARGUMENTAI(databaseUrl), {
      encoding: "utf8",
      maxBuffer: MAX_DUMP_BYTES,
    }));
  } catch (klaida) {
    /**
     * ⚠️ ORIGINALI KLAIDA NEPERDUODAMA. Ir `message`, ir `cmd` turi pilną
     * jungties eilutę su slaptažodžiu; `cause` ją išsaugotų ir CLI ją
     * atspausdintų. Diagnozei paliekamas `stderr` be kredencialų.
     */
    throw new PgDumpBackupError(
      `\`pg_dump\` nepavyko: ${saugusStderr(klaida.stderr || klaida.message, databaseUrl)}`,
      "PG_DUMP_FAILED"
    );
  }

  const plaintext = Buffer.concat([_antrasteBaitais(DUMP_FORMATAS), Buffer.from(sql, "utf8")]).toString("utf8");
  _assertDydis(plaintext);

  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");

  /**
   * ⚠️ `contents: []` — SĄMONINGAI (D1). DB dump'as nėra aplikacijos artefaktų
   * inventorius; melagingas įrašas čia būtų blogesnis už tuščią, o bet koks
   * įrašas privalėtų praeiti `isIncluded()`, kurio DB dump'as netenkina.
   */
  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date(snapshotTime).toISOString();
  manifest.excludedInFlightJobs = 0;

  await _uzfiksuotiHorizonta(manifest, databaseUrl);

  const envelope = backupEncryption.encrypt(plaintext, { env, manifest });

  /**
   * ⚠️ AUDITAS TIK KŪRIMO PUSĖJE - ASIMETRIJA SĄMONINGA.
   *
   * Čia šaltinio bazė gyva ir audito saugykla veikia, tad įrašas kainuoja
   * nedaug. Atkūrimo pusėje rašyti nėra kur: `audit_log` į dump'ą sąmoningai
   * neįtrauktas (7.4d), tikslinė bazė tuščia, aplikacija neveikia, o rašymas į
   * kitą saugyklą reikštų, kad AVARINIS ATKŪRIMAS priklauso nuo audito
   * prieinamumo - fail-closed būtent ten, kur reikia atkurti.
   *
   * Todėl runbook'o §11 eilutė apie atkūrimo auditavimą SUSIAURINTA, o ne
   * paremta kodu, kurio čia negali būti.
   *
   * Kategoriją (`NEBLOKUOJANTIS`) nustato `utils/auditEvents.js`, ne šis
   * call site (#210): audito gedimas kopijos nesunaikina, bet lieka matomas.
   */
  await auditWrite.rasytiAudita({
    event: "PG_DUMP_BACKUP_CREATED",
    success: true,
    actor: actor || undefined,
    details:
      `formatVersion=${manifest.formatVersion} appVersion=${manifest.applicationVersion} ` +
      `dumpBytes=${Buffer.byteLength(sql, "utf8")} expiresAt=${manifest.expiresAt}`,
  });

  log.info("PostgreSQL kopija sukurta ir užšifruota", {
    stage: "pg_dump_encrypted",
    dumpBytes: Buffer.byteLength(sql, "utf8"),
  });

  return { manifest, envelope, dumpBytes: Buffer.byteLength(sql, "utf8") };
}

/**
 * ŽYMŲ SAUGYKLOS IR DUMP'O ŠALTINIO TAPATUMAS - FAIL-CLOSED (Codex P1, #262).
 *
 * ⚠️ HORIZONTAS BE TAPATUMO YRA HORIZONTAS NE TEN.
 *
 * `recordBackupHorizon()` eina per `ensureInit()`, o tas renkasi backend'ą iš
 * GLOBALIOS aplinkos, ne iš `databaseUrl`. Kai jie sutampa - viskas gerai. Kai
 * operatorius nurodo `--url` kitai bazei, horizontas atsiduria aplikacijos
 * bazėje, o artefakte guli KITA: dump'intos bazės retencijos ciklas gali
 * išvalyti žymas, kol artefaktas dar galioja.
 *
 * ⚠️ TAI NE ERGONOMIKA, O #250 D4 PRIELAIDA. Eksportas remiasi TUO PAČIU
 * horizontu, ne sava taisykle. Artefaktas su horizontu kitoje bazėje tą prielaidą
 * paverčia netiesa nuo pat pradžių, o 7.6c ją rastų kaip „kodėl žymos pasibaigė
 * anksčiau nei kopija" - jau su trimis judančiomis dalimis vietoj vienos.
 *
 * ⚠️ RIBA RUNBOOK'E ČIA NETIKTŲ. Dokumentas, sakantis „nenurodykite kitos
 * bazės", saugo nuo klaidos, kurios niekas nesustabdo, o klaidos kaina yra
 * tyliai negaliojanti GDPR garantija, matoma tik po atkūrimo.
 *
 * ⚠️ KODĖL NE `tombstones.init(env)` SU ŠALTINIO NUSTATYMAIS. Bendrame procese
 * tai perimtų globalią saugyklos būseną iš serverio - ta pati „vieno entrypoint'o
 * dvi saugyklos" klasė, kurią kaip tik uždaro CLI inicijavimas.
 *
 * ⚠️ PALYGINIMAS PAGAL KONSTRUKCIJĄ, SU TA PAČIA RIBA KAIP `pgConnection.js`:
 * du klasteriai tame pačiame hoste su vienodu bazės vardu palyginime sutaptų.
 * Tai TRIPWIRE riba, ne mechanizmo skylė - ji užrašyta ir ten, ir čia.
 */
/**
 * Ar žymų saugykla gyvena TOJE PAČIOJE bazėje, kurią dump'iname?
 *
 * ⚠️ TIKRINAMA PRIEŠ `process.env`, NE PRIEŠ INJEKTUOTĄ `env`. Žymų saugykla
 * jungiasi būtent iš globalios aplinkos, tad palyginimas su injektuotu objektu
 * lygintų su tuo, ko saugykla niekada nematė.
 */
function patikrintiZymuTapatuma(databaseUrl, env = process.env) {
  if (!arNurodytaPostgres(env)) {
    throw new PgDumpBackupError(
      "Ištrynimo žymų saugykla nėra PostgreSQL (`DATABASE_URL`/`PGHOST` nenurodyti), " +
        "tad kopijos galiojimas būtų užfiksuotas atmintyje ir dingtų procesui pasibaigus.",
      "PG_BACKUP_HORIZON_NOT_PERSISTENT"
    );
  }

  /**
   * ⚠️ PALYGINIMAS GYVENA `pgConnection.js` (#249). Ten pat užrašyta ir jo riba;
   * dvi kopijos to paties klausimo ilgainiui išsiskirtų.
   */
  /**
   * ⚠️ Dviprasmiška konfigūracija (`DATABASE_URL` IR `PG*`) gauna savo kodą:
   * ten klausimas „ta pati bazė?" atsakymo neturi (#280, IV raundas).
   */
  let palyginimas;
  try {
    palyginimas = arTaPatiBaze(databaseUrl, env);
  } catch (klaida) {
    if (klaida.code === "PG_CONNECTION_AMBIGUOUS") {
      throw new PgDumpBackupError(klaida.message, "PG_BACKUP_CONNECTION_AMBIGUOUS");
    }
    throw klaida;
  }

  const { sutampa, nurodyta: saltinis, konfiguracija: zymos } = palyginimas;

  if (!sutampa) {
    throw new PgDumpBackupError(
      `Dump'o šaltinis (${tapatybesTekstas(saltinis)}) nesutampa su ištrynimo žymų baze ` +
        `(${tapatybesTekstas(zymos)}). Kopijos galiojimas atsidurtų ne toje bazėje, kurios ` +
        "žymas jis privalo saugoti, tad kopija neišduodama.",
      "PG_BACKUP_SOURCE_MISMATCH"
    );
  }
}

/**
 * KOPIJOS GALIOJIMO HORIZONTAS - FAIL-CLOSED (Codex P1).
 *
 * ⚠️ NUO ŠIO ĮRAŠO PRIKLAUSO 7.6c (#250) PRIELAIDA.
 *
 * Manifestas turi `expiresAt`, bet pats savaime jis nieko nesaugo: ištrynimo
 * žymų valymas remiasi `backup_horizon` lentele. Neužfiksavus horizonto,
 * sutrumpinta `BACKUP_RETENTION_DAYS` reikšmė leidžia išvalyti žymas, KOL
 * dump'as dar galioja - ir tada atkūrimas prikelia ištrintus job'us, o replay
 * nebeturi ID sąrašo, kurį galėtų pritaikyti. Prielaida būtų netiesa dar prieš
 * 7.6c atsirandant.
 *
 * ⚠️ SĄMONINGAS NUKRYPIMAS NUO `backupService.js:153`.
 *
 * Ten nesėkmė tik logginama ir kopija grąžinama. Čia - klaida: aplikacijos
 * kopija turi ribotą, politikos filtruotą turinį, o šis artefaktas atkuria
 * VISĄ bazę. Artefaktas, kurio horizontas neužfiksuotas, yra tiksliai tas
 * atvejis, dėl kurio garantija netenka galios, tad jo išduoti negalima.
 */
async function _uzfiksuotiHorizonta(manifest, databaseUrl = null) {
  if (databaseUrl) patikrintiZymuTapatuma(databaseUrl);

  const galiojaIki = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(galiojaIki)) {
    throw new PgDumpBackupError(
      "Manifeste nėra galiojančio `expiresAt` - kopijos horizonto užfiksuoti neįmanoma.",
      "PG_BACKUP_HORIZON_UNRECORDED"
    );
  }

  try {
    await tombstones.recordBackupHorizon(galiojaIki);
  } catch (klaida) {
    throw new PgDumpBackupError(
      `Kopijos galiojimo NEPAVYKO užfiksuoti (${klaida.message}) - kopija neišduodama, ` +
        "nes ištrynimo žymos gali būti pašalintos anksčiau, nei ji nustoja galioti.",
      "PG_BACKUP_HORIZON_UNRECORDED"
    );
  }
}

/**
 * ⚠️ PRAKTINĖ DYDŽIO RIBA YRA ŽEMESNĖ NEI `MAX_CIPHERTEXT_BYTES` (D6).
 *
 * `MAX_CIPHERTEXT_BYTES` yra 2 GB, bet envelope laukai (`iv`, `authTag`,
 * `ciphertext`) yra BASE64 EILUTĖS ATMINTYJE, o V8 eilutės ilgis ribotas
 * (~512 MB 64-bit V8; `String::kMaxLength`). Base64 pailgina 4/3, tad ~512 MB
 * eilutė atitinka ~384 MB ciphertext'o — ir tai dar prieš `JSON.stringify`,
 * kuris envelope padvigubina.
 *
 * Riba čia nustatoma KONSERVATYVIAI ir tikrinama PRIEŠ šifravimą, kad
 * operatorius gautų aiškią klaidą, o ne neaiškų V8 kritimą viduryje.
 *
 * ⚠️ SRAUTINIO ŠIFRAVIMO 7.6a NEĮVEDA. Riba yra ŽINOMA RIBA, ne sprendimas;
 * ji užrašyta runbook'e.
 */
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

function _assertDydis(plaintext) {
  const baitai = Buffer.byteLength(plaintext, "utf8");
  if (baitai > MAX_DUMP_BYTES) {
    throw new PgDumpBackupError(
      `Dump'as per didelis: ${baitai} B > ${MAX_DUMP_BYTES} B. ` +
        "7.6a nešifruoja srautu; žr. docs/backup-runbook.md ribų skyrių.",
      "PG_DUMP_TOO_LARGE"
    );
  }
}

/**
 * Atkuria šifruotą kopiją į TUŠČIĄ tikslinę bazę.
 *
 * ⚠️ VISOS KRIPTOGRAFINĖS IR MANIFESTO PATIKROS ĮVYKSTA PRIEŠ PIRMĄ SQL
 * MUTACIJĄ (D4). `psql` kviečiamas tik po to, kai manifestas galioja, GCM žyma
 * patvirtinta ir kontrolinė suma sutampa.
 *
 * ⚠️ `--single-transaction`: SQL klaida viduryje duoda `ROLLBACK`, ne pusiau
 * atkurtą bazę. „Sėkmingai užbaigto" dalinio atkūrimo būti negali.
 */
/**
 * ⚠️ ŠEIMOS A PERĖJIMAS: `restoreService` GRANDINĖ, ŽINGSNIS PO ŽINGSNIO (#262).
 *
 * Trys peržiūros raundai iš eilės rado tą patį: naujas kelias nepaėmė to, ką
 * `restoreService` jau turi (`checkRestoreCompatibility`, `applicationVersion`,
 * šifravimo metaduomenys). Todėl grandinė pereita VISA, ir kiekvienas žingsnis
 * arba priimtas, arba turi užrašytą priežastį - kad ketvirtos tos pačios šeimos
 * pastabos nebereikėtų.
 *
 *   1. MANIFEST        - PRIIMTA (`validateManifest`).
 *   2. FORMAT          - PRIIMTA (`checkRestoreCompatibility`).
 *   3. APPLICATION     - PRIIMTA (`_patikrintiProgramosVersija`, `unknown` praleidžiamas).
 *   4. CHECKSUM        - SĄMONINGAI KITAIP. `restoreService` maišo TAI, KAS
 *                        SAUGOMA (šifruotą turinį), kad sugadinimą atskirtų nuo
 *                        blogo rakto. Čia suma skaičiuojama nuo DEŠIFRUOTO
 *                        turinio, o ciphertext'o vientisumą dengia GCM žyma:
 *                        abi savybės padengtos, tik kitais mechanizmais.
 *                        Sugadintas artefaktas krinta ties `BACKUP_DECRYPTION_FAILED`,
 *                        ne ties suma - ir tai tikrina integracinis testas.
 *   5. DECRYPTED       - PRIIMTA (`_patikrintiSifravimoMetaduomenis` + AAD +
 *                        `usedPreviousKey` įspėjimas).
 *   6. CONTENT         - PRIIMTA KITU PAVIDALU. Aplikacijos kopijoje tai JSON
 *                        struktūros patikra; čia - `_perskaitytiAntraste()`
 *                        (rūšis, versija, formatas), po kurios SQL vykdomas.
 *   7. CONFIGURATION   - NETAIKOMA. Aplikacijos konfigūracija į `pg_dump` NEPATENKA
 *                        (ji gyvena aplinkoje, ne bazėje), tad atkurti jos
 *                        neįmanoma. Analogas yra privalomas post-restore
 *                        `npm run doctor` žingsnis (D5), aprašytas runbook'e.
 *   8. SECRETS         - SĄMONINGAI SUSIAURINTA. `backupService` skenuoja politikos
 *                        filtruotus artefaktus; pilnas DB dump'as pagal apibrėžimą
 *                        turi VISĄ turinį, tad 256 MB SQL skenavimas duotų
 *                        daugiausia klaidingų teigiamų. Riba - runbook'o §10.
 *   9. PRIVACY         - PRIIMTA (`_patikrintiPrivatumoRezima`).
 *  10. APPLIED         - PRIIMTA (`--single-transaction` + tuštumo preflight).
 *
 * Užrakto `restoreService` neturi, tad ir perimti nėra ko; lygiagrečius
 * atkūrimus į tą patį tikslą stabdo tuštumo preflight.
 */
async function atkurtiSifruotaKopija({ envelope, manifest, targetUrl, env = process.env } = {}) {
  if (!targetUrl) {
    throw new PgDumpBackupError("Nenurodytas `targetUrl`.", "PG_RESTORE_NO_URL");
  }

  const patikra = backupManifest.validateManifest(manifest);
  if (!patikra.valid) {
    throw new PgDumpBackupError(
      `Manifestas negalioja: ${patikra.errors.join("; ")}.`,
      "BACKUP_MANIFEST_INVALID"
    );
  }

  /**
   * ⚠️ FORMATO VERSIJA - FAIL-CLOSED PRIEŠ DEŠIFRAVIMĄ (Codex P1).
   *
   * `validateManifest()` tikrina STRUKTŪRĄ ir `formatVersion` reikšmės
   * sąmoningai nevertina. `restoreService.js:73` dėl to kviečia
   * `backupPolicy.checkRestoreCompatibility()`; šis kelias to nedarė, tad
   * naujesnės versijos artefaktas su tuo pačiu raktu sėkmingai autentifikuotųsi
   * ir jo SQL keliautų į `psql` - nesuprastus laukus prarandant TYLIAI.
   */
  const suderinamumas = backupPolicy.checkRestoreCompatibility(manifest.formatVersion);
  if (!suderinamumas.compatible) {
    throw new PgDumpBackupError(
      `Kopijos formatas nesuderinamas: ${suderinamumas.reason}.`,
      "BACKUP_FORMAT_INCOMPATIBLE"
    );
  }

  /**
   * ⚠️ PROGRAMOS VERSIJA - ATSKIRA AŠIS NUO FORMATO (Codex P2).
   *
   * `restoreService` jas skiria sąmoningai: nepakitęs envelope formatas
   * nereiškia nepakitusios schemos ar dalykinės semantikos. Elgesys perimamas
   * PAŽODŽIUI, ne perprojektuojamas - `unknown` praleidžiamas su įspėjimu
   * (supakuotoje aplinkoje `package.json` gali būti nepasiekiamas, ir atmesta
   * kopija reikštų neįmanomą atkūrimą būtent ten, kur jo labiausiai reikia).
   */
  const versija = _patikrintiProgramosVersija(manifest.applicationVersion);
  if (!versija.compatible) {
    throw new PgDumpBackupError(
      `Kopijos programos versija nesuderinama: ${versija.reason}.`,
      "BACKUP_APPLICATION_VERSION_INCOMPATIBLE"
    );
  }

  /**
   * ⚠️ PRIVATUMO REŽIMAS - PRIIMTA IŠ `restoreService` (šeimos A perėjimas).
   *
   * Eksplicitinis `PERSISTENT_STORAGE=false` reiškia, kad sistema ŽADA nelaikyti
   * turinio. DB dump'o atkūrimas tą žadą laužo dar tiesiogiau nei aplikacijos
   * kopija: PostgreSQL tikslas pagal apibrėžimą yra patvarus, tad transkripcijos
   * atsidurtų diske režime, kuris žada jų neturėti.
   *
   * ⚠️ TIKRINAMA ANKSČIAU NEI `restoreService`, ir sąmoningai: ten patikra yra
   * po turinio validacijos, nes jai reikia turinio; čia sprendimas nuo turinio
   * nepriklauso, o pigus sprendimas turi eiti prieš brangų darbą.
   */
  _patikrintiPrivatumoRezima(env);

  /**
   * ⚠️ ŠIFRAVIMO METADUOMENYS - PRIIMTA IŠ `restoreService` (šeimos A perėjimas).
   *
   * Be šių patikrų manifestas su `encrypted: "yes"` ar nepalaikomu algoritmu
   * būtų dešifruotas ir keliautų į `psql`, nors jo skelbiamas šifravimo
   * kontraktas kitoje sistemos pusėje būtų atmestas. Du atkūrimo kraštai
   * privalo tiems patiems laukams suteikti tą pačią prasmę (§16).
   */
  _patikrintiSifravimoMetaduomenis(manifest);

  /**
   * GCM žyma ir AAD — krinta čia, PRIEŠ bet kokį SQL.
   *
   * ⚠️ `decrypt()` GRĄŽINA `{ plaintext: Buffer, usedPreviousKey }`, NE EILUTĘ.
   *
   * Pirmoji redakcija reikšmę naudojo tiesiogiai, ir `createHash().update()`
   * gaudavo objektą. Vietinis rinkinys to nepagavo: visas šis kelias eina per
   * `pgDumpBackup.integration`, kuriam reikia tikros DB.
   */
  const { plaintext: plaintextBuffer, usedPreviousKey } = backupEncryption.decrypt(envelope, { env, manifest });
  const plaintext = plaintextBuffer.toString("utf8");

  if (usedPreviousKey) {
    /**
     * ⚠️ PRIIMTA IŠ `restoreService`: operatoriui svarbu ŽINOTI, kad panaudotas
     * ankstesnis raktas - kopija dar nepersišifruota, ir pašalinus
     * `BACKUP_ENCRYPTION_KEY_PREVIOUS` ji taps neatkuriama.
     */
    log.warn("Atkurta ANKSTESNIU šifravimo raktu - kopija dar nepersišifruota", {
      formatVersion: manifest.formatVersion,
    });
  }

  const suma = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (suma !== manifest.checksum) {
    throw new PgDumpBackupError(
      "Kontrolinė suma nesutampa - kopija sugadinta.",
      "BACKUP_CHECKSUM_MISMATCH"
    );
  }

  const { sql, dumpFormatas } = _perskaitytiAntraste(plaintext);
  if (dumpFormatas !== DUMP_FORMATAS) {
    throw new PgDumpBackupError(
      `Nepalaikomas dump'o formatas: ${JSON.stringify(dumpFormatas)}.`,
      "PG_DUMP_FORMAT_UNSUPPORTED"
    );
  }

  /**
   * ⚠️ `spawn`, NE `execFile`: SQL paduodamas per STDIN.
   *
   * `execFile` `input` parametro neturi (tai `spawnSync` savybė), o rašyti
   * dump'ą į laikiną failą reikštų dešifruotą turinį diske — būtent tai, ko
   * šifravimas ir vengia.
   */
  /**
   * ⚠️ PASKUTINĖ GRANDIES PAKOPA: kriptografija ir rūšis jau įrodytos, tad
   * pirmasis prisijungimas prie TIKSLO įvyksta tik dabar - ir vis tiek prieš
   * pirmą SQL sakinį.
   */
  await _patikrintiTikslasTuscias(targetUrl);

  await _psqlSuStdin(targetUrl, sql);

  log.info("PostgreSQL kopija atkurta", { stage: "pg_restore_done" });
  return { restoredBytes: Buffer.byteLength(sql, "utf8") };
}

/**
 * PRIVATUMO REŽIMO PATIKRA (`restoreService` 8 žingsnis).
 *
 * ⚠️ TIKRINAMAS EKSPLICITINIS `PERSISTENT_STORAGE=false`, ne `persistentStorage`:
 * pastarasis reiškia „Redis saugykla" ir be `REDIS_URL` yra `false` net įprastame
 * diegime. Ta pati klaida `restoreService` istorijoje jau buvo padaryta ir
 * blokavo daugumą atkūrimų - kartoti jos nereikia.
 */
function _patikrintiPrivatumoRezima(env) {
  let privacy;
  try {
    privacy = privacyConfig.getPrivacyConfig(env);
  } catch (klaida) {
    throw new PgDumpBackupError(
      `Privatumo konfigūracija netinkama: ${klaida.message}`,
      "BACKUP_RESTORE_PRIVACY_INVALID"
    );
  }

  if (privacy.persistentExplicit && !privacy.persistentStorage) {
    throw new PgDumpBackupError(
      "Neišsaugojimo režimas (`PERSISTENT_STORAGE=false`) - atkūrimas jį apeitų: " +
        "PostgreSQL tikslas yra patvarus, tad turinys atsidurtų diske.",
      "BACKUP_RESTORE_PRIVACY_MODE"
    );
  }

  const patikra = privacyConfig.validatePrivacyConfig(env);
  if (patikra && Array.isArray(patikra.errors) && patikra.errors.length > 0) {
    throw new PgDumpBackupError(
      `Privatumo konfigūracija netinkama: ${patikra.errors.length} klaida (-os).`,
      "BACKUP_RESTORE_PRIVACY_INVALID"
    );
  }
}

/**
 * ŠIFRAVIMO METADUOMENŲ NUOSEKLUMAS (`restoreService` 5 žingsnis).
 *
 * ⚠️ `encrypted` PRIVALO BŪTI GRIEŽTAS BOOLEAN. `"yes"`, `"false"`, `0` ar `null`
 * skirtingose vietose interpretuojami skirtingai, o šis laukas sprendžia, ar
 * apskritai dešifruoti - neapibrėžtumas čia reikštų downgrade be klastojimo.
 *
 * ⚠️ `encrypted: false` ŠIAME KELYJE YRA DOWNGRADE PAGAL APIBRĖŽIMĄ. Procedūra
 * nešifruotų artefaktų negamina (`BACKUP_ENCRYPTION_DISABLED`), tad manifestas,
 * teigiantis „nešifruota" prie envelope, yra arba klastotė, arba svetimas
 * artefaktas. `restoreService` tam turi atskirą `_looksLikeEnvelope()` patikrą;
 * čia envelope yra privalomas argumentas, tad sąlyga paprastesnė.
 */
function _patikrintiSifravimoMetaduomenis(manifest) {
  if (typeof manifest.encrypted !== "boolean") {
    throw new PgDumpBackupError(
      "Manifesto `encrypted` privalo būti boolean.",
      "BACKUP_MANIFEST_INCONSISTENT"
    );
  }

  if (!manifest.encrypted) {
    throw new PgDumpBackupError(
      "Manifestas sako `encrypted: false`, bet turinys yra šifruotas envelope - manifesto downgrade.",
      "BACKUP_MANIFEST_INCONSISTENT"
    );
  }

  const palaikomas = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  if (manifest.encryptionAlgorithm !== palaikomas) {
    const senasFormatas = String(manifest.encryptionAlgorithm || "").replace(`${backupEncryption.ALGORITHM}-`, "");
    const paaiskinimas = backupEncryption.UNSUPPORTED_FORMATS[senasFormatas];

    throw new PgDumpBackupError(
      paaiskinimas
        ? `Kopijos formatas "${senasFormatas}" nebepalaikomas: ${paaiskinimas}.`
        : `Nepalaikomas šifravimo algoritmas: ${manifest.encryptionAlgorithm || "nenurodytas"}.`,
      "BACKUP_ENCRYPTION_ALGORITHM_UNSUPPORTED"
    );
  }
}

/** ⚠️ Kopija iš `restoreService._majorOf` - ta pati taisyklė abiejuose keliuose. */
function _majorOf(version) {
  const match = String(version || "").match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function _patikrintiProgramosVersija(backupVersion) {
  if (!backupVersion || backupVersion === "unknown") {
    log.warn("Kopijos programos versija nežinoma - atkuriama be versijos patikros");
    return { compatible: true };
  }

  const dabartine = _majorOf(require("../package.json").version);
  const kopijos = _majorOf(backupVersion);

  if (dabartine === null || kopijos === null) {
    return { compatible: false, reason: `netinkamas versijos formatas: "${backupVersion}"` };
  }

  if (dabartine !== kopijos) {
    return {
      compatible: false,
      reason: `nesuderinama programos versija (kopija ${kopijos}.x, sistema ${dabartine}.x)`,
    };
  }

  return { compatible: true };
}

/**
 * TIKSLINĖS BAZĖS TUŠTUMO PREFLIGHT (#262 peržiūra, #249/#250 sąlyga).
 *
 * ⚠️ PRIEŽASTIS NE ŠIAME ETAPE, O KITUOSE DVIEJUOSE.
 *
 * `--single-transaction` netuščioje bazėje krinta savaime tik tada, kai dump'as
 * bando kurti JAU ESANTĮ objektą. Bet 7.6b (#249) suderinimas ir 7.6c (#250)
 * ištrynimų replay remsis BŪTENT šiuo keliu, o abu prasideda nuo prielaidos
 * „restore pavyko". Atkūrimas į bazę su svetimu turiniu duotų dviejų bazių
 * SĄJUNGĄ, ir nė vienas jų testas to nepagautų - jie tikrintų suderinimą ant
 * jau užterštos būsenos.
 *
 * Kaina - viena užklausa prieš pirmą SQL sakinį, ir ji gula į tą pačią
 * fail-closed grandinę, kuri jau veikia prieš `psql`.
 *
 * ⚠️ TAS PATS `psql`, NE `pg` KLIENTAS. Antras jungimosi mechanizmas reikštų
 * antrą jungties eilutės interpretaciją (slaptažodžiai su URI simboliais - jau
 * žinoma problema, žr. `utils/pgConnection.js`), tad preflight ir atkūrimas
 * privalo jungtis vienodai.
 */
/**
 * ⚠️ KATALOGAI, NE `information_schema.tables` (#262 peržiūra, P2).
 *
 * Pirmoji redakcija skaičiavo tik `information_schema.tables`, o runbook'as
 * žadėjo „objektus ne sisteminėse schemose" - t. y. dokumentas buvo stipresnis
 * už kodą (§12.1). Į tą rodinį NEPATENKA matview'ai, sekos, funkcijos ir tuščios
 * vartotojo schemos, tad tikslinė bazė su likusia seka būdavo laikoma tuščia, o
 * po atkūrimo joje gulėtų dviejų bazių sąjunga - būtent tai, ko preflight ir
 * neleidžia.
 *
 * ⚠️ `pg_type` TIK `typtype IN ('e','d')` - enum'ai ir domenai (#262 IV raundas).
 * Kompozitiniai tipai jau turi `pg_class` įrašą, tad platesnė sąlyga juos
 * skaičiuotų du kartus. Enum'ai ir domenai `pg_class` neturi visai, tad be šios
 * subužklausos bazė su likusiu enum'u atrodė tuščia - o runbook'as jau žadėjo
 * „visus vartotojo objektus".
 *
 * ⚠️ `pg_class` apima ir indeksus - sąmoningai. Klausimas yra „ar bazė tuščia",
 * ne „kiek ten objektų", tad perteklinis skaičiavimas klaidos pusėn yra teisinga
 * kryptis.
 *
 * ⚠️ PATIKRINTA PRIEŠ PLATINANT: mūsų migracijos `CREATE EXTENSION` nenaudoja,
 * tad plėtinių funkcijos `public` schemoje teisėtai tuščios bazės neužblokuoja.
 * Diegimuose, kur plėtinys įdiegtas į `public`, tokia bazė bus laikoma
 * NETUŠČIA - riba užrašyta runbook'e.
 */
const OBJEKTU_UZKLAUSA = `
  SELECT
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_')
  + (SELECT count(*) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_')
  + (SELECT count(*) FROM pg_type ty
       JOIN pg_namespace n ON n.oid = ty.typnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
        AND ty.typtype IN ('e', 'd'))
  + (SELECT count(*) FROM pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public') AND n.nspname !~ '^pg_')
`.replace(/\s+/g, " ").trim();

/**
 * ⚠️ NEPERSKAITOMAS SKAIČIUS = NE TUŠČIA.
 *
 * Tuščia bazė yra TEIGINYS, kurį reikia įrodyti. Neaiški `psql` išvestis to
 * neįrodo, tad ji negali reikšti „galima tęsti" - kitaip preflight'ą apeitų bet
 * koks išvesties formato pokytis.
 */
function perskaitytiObjektuSkaiciu(stdout) {
  const eilute = String(stdout ?? "").trim().split("\n").pop();
  const skaicius = Number.parseInt(eilute, 10);

  if (!Number.isInteger(skaicius) || skaicius < 0 || String(skaicius) !== eilute.trim()) {
    throw new PgDumpBackupError(
      `Nepavyko nustatyti, ar tikslinė bazė tuščia (psql grąžino ${JSON.stringify(String(stdout ?? "").slice(0, 80))}).`,
      "PG_RESTORE_PREFLIGHT_FAILED"
    );
  }

  return skaicius;
}

async function _patikrintiTikslasTuscias(targetUrl) {
  let stdout;
  try {
    ({ stdout } = await vykdyti(
      "psql",
      ["--no-psqlrc", "--quiet", "-At", "-c", OBJEKTU_UZKLAUSA, targetUrl],
      { encoding: "utf8" }
    ));
  } catch (klaida) {
    throw new PgDumpBackupError(
      `Tikslinės bazės patikrinti nepavyko: ${saugusStderr(klaida.stderr || klaida.message, targetUrl)}`,
      "PG_RESTORE_PREFLIGHT_FAILED"
    );
  }

  const kiek = perskaitytiObjektuSkaiciu(stdout);
  if (kiek > 0) {
    throw new PgDumpBackupError(
      `Tikslinė bazė NEtuščia (${kiek} objekt(ai): lentelės, rodiniai, matview'ai, sekos, ` +
        "indeksai, funkcijos, enum'ai/domenai ar ne `public` schemos). " +
        "Atkūrimas į netuščią bazę duotų dviejų bazių sąjungą, ne kopiją.",
      "PG_RESTORE_TARGET_NOT_EMPTY"
    );
  }
}

/**
 * `psql --single-transaction` su SQL per STDIN.
 *
 * ⚠️ `ON_ERROR_STOP=1` BŪTINAS. Be jo `psql` klaidas praneša, bet tęsia ir
 * grąžina 0 — atkūrimas „pavyktų" praleidęs sakinius, ir `--single-transaction`
 * neturėtų ko atsukti.
 */
function _psqlSuStdin(targetUrl, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "psql",
      ["--single-transaction", "--set", "ON_ERROR_STOP=1", "--quiet", "--no-psqlrc", targetUrl],
      /**
       * ⚠️ `stdout: "ignore"`, NE `"pipe"` (Codex P2).
       *
       * Su `"pipe"` ir be skaitytojo `psql` išvestis kaupiasi vamzdyje; jį
       * užpildžius procesas UŽSTRINGA - o atkūrimas užstrigtų vidury
       * transakcijos. Išvestis mums nereikalinga (`--quiet`), tad ji
       * atmetama OS lygyje, o ne buferinama be reikalo.
       */
      { stdio: ["pipe", "ignore", "pipe"] }
    );

    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new PgDumpBackupError(
          `psql grąžino ${code}: ${saugusStderr(stderr, targetUrl)}`,
          "PG_RESTORE_FAILED"
        )
      );
    });

    p.stdin.on("error", reject);
    p.stdin.end(sql, "utf8");
  });
}

module.exports = {
  PG_DUMP_ARGUMENTAI,
  SNAPSHOTA_LAUZANCIOS_VELIAVOS,
  ANTRASTE,
  ANTRASTES_VERSIJA,
  DUMP_FORMATAS,
  MAX_DUMP_BYTES,
  PgDumpBackupError,
  redaguotasUrl,
  bePaslapciu,
  saugusStderr,
  perskaitytiObjektuSkaiciu,
  patikrintiZymuTapatuma,
  klientoVersija,
  /**
   * ⚠️ EKSPORTUOJAMA DĖL TESTO, IR TAI UŽRAŠYTA. Horizonto fiksavimas yra
   * fail-closed sąlyga, o pilnas kelias iki jo reikalauja veikiančio `pg_dump`.
   * Be šio eksporto abi klaidos šakos būtų tikrinamos tik CI'uje; su juo
   * vietinis rinkinys tikrina ŠAKAS, o integracinis testas - kad jos realiai
   * įjungtos į kopijos kūrimą.
   */
  uzfiksuotiHorizonta: _uzfiksuotiHorizonta,
  sukurtiSifruotaKopija,
  atkurtiSifruotaKopija,
};
