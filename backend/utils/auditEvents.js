/**
 * AUDITO ĮVYKIŲ KLASIFIKACIJA (#155, 7.4a).
 *
 * ⚠️ VIENAS AUTORITETAS, NE SPRENDIMAS KIEKVIENAME CALL SITE'E.
 *
 * Iki 7.4a `record()` buvo sinchroninis, tad klausimo „ar laukiam patvirtinimo"
 * nebuvo. Async cutover jį sukuria KIEKVIENAM iš 28 produkcinių kvietimų, ir
 * jei atsakymą rinktųsi call site'as („čia turbūt svarbu, tad await"), semantika
 * priklausytų nuo to, ką tą dieną galvojo autorius. Naujas security įvykis
 * tyliai paveldėtų silpnesnę kategoriją.
 *
 * Todėl kategorija nustatoma ČIA, pagal įvykį, ir call site'as jos nesirenka.
 *
 * ⚠️ KATEGORIJOS TIK DVI. #210: „Trečios kategorijos nėra: kiekvienas
 * `record()` kvietėjas priklauso vienai iš dviejų."
 */

/**
 * ĮVYKIO VARDO KONTRAKTAS.
 *
 * Gyvena ČIA, o ne `auditLog.js`, dėl vienos priežasties: `auditLog` testuose
 * pakeičiamas dubliu (ir per require cache, ir per injekciją), o vardų
 * kontraktas yra sistemos, ne backend'o savybė. Iš dublio jį imant sargyba
 * tyliai nustotų veikti būtent ten, kur ją norim patikrinti.
 */
const EVENT_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

const KATEGORIJA = Object.freeze({
  /**
   * BLOKUOJANTIS: sėkmė negali būti deklaruota anksčiau, nei patvirtintas
   * audito įrašas.
   *
   * ⚠️ DU TERMINAI, KURIUOS BŪTINA SKIRTI - ANKSČIAU JIE ČIA BUVO SULIPĘ.
   *
   *   BLOKUOJANTIS  „sėkmė NEDEKLARUOJAMA be patvirtinto įrašo".
   *                 Tai, ką kodas realiai daro VISUOSE keliuose: klaida ar
   *                 timeout → kvietėjas gauna klaidą, ne 2xx/`true`.
   *
   *   FAIL-CLOSED   „veiksmas ATMETAMAS", t. y. jis apskritai neįvyksta.
   *                 Tai galioja TIK ten, kur auditas rašomas PRIEŠ veiksmą
   *                 (autentikacija, autorizacija).
   *
   * Kur veiksmas negrįžtamas ir jau įvykęs (žr. `POST_HOC_IVYKIAI`), galioja
   * TIK pirmasis. Sulipdžius juos į vieną, skaitytojas pagrįstai suprastų, kad
   * audito gedimas apsaugo DUOMENIS - o jis apsaugo tik ATASKAITĄ.
   */
  BLOKUOJANTIS: "blocking",
  /**
   * NEBLOKUOJANTIS: audito klaida NENUMUŠA pagrindinės operacijos, bet ir
   * NENUTYLIMA - `error` lygio logas su `request_id` ir skaitiklis.
   */
  NEBLOKUOJANTIS: "non-blocking",
});

/**
 * ⚠️ PRISKYRIMO TAISYKLĖ, NE SKONIS.
 *
 * #210 blokuojančių šeimų sąrašas yra BAIGTINIS: autentikacija/autorizacija,
 * GDPR ištrynimas, provider override, rakto rotacija. Kiekvienas žemiau esantis
 * `BLOKUOJANTIS` priskyrimas nurodo, kuriai iš tų šeimų įvykis priklauso;
 * visa kita yra `NEBLOKUOJANTIS`. Sąrašo plėtimas „nes irgi svarbu" būtų
 * kategorijos, o ne įvykio, keitimas - tam reikia keisti #210.
 *
 * ⚠️ `provider override` IR `rakto rotacija` ĮVYKIŲ ŠIAME `main` NĖRA.
 *
 * `ALLOW_PROVIDER_OVERRIDE=false` atmetimas (`services/transcriptionService.js`)
 * meta `HttpError` NIEKO neįrašydamas į auditą, o rakto rotacijos (`hash_key_id`,
 * istoriniai HMAC raktai) mechanizmo dar nėra - tai 7.4b darbas. #210 nuostata
 * dėl jų nustato BŪSIMĄ semantiką, ne leidimą kurti funkciją 7.4a metu, todėl
 * čia jų įrašų nėra. Atsiradus tokiam įvykiui, jis privalo būti pridėtas kaip
 * `BLOKUOJANTIS` - kitaip `record()` jį atmes (žr. `kategorija()`).
 */
const AUDIT_EVENTS = Object.freeze({
  // ── Autentikacija (#210: blokuojanti šeima) ────────────────────────────────
  LOGIN_SUCCESS: KATEGORIJA.BLOKUOJANTIS,
  LOGIN_FAILED: KATEGORIJA.BLOKUOJANTIS,
  LOGOUT: KATEGORIJA.BLOKUOJANTIS,

  // ── Autorizacija (#210: blokuojanti šeima) ─────────────────────────────────
  AUTHORIZATION_DENIED: KATEGORIJA.BLOKUOJANTIS,
  JOB_EXECUTION_DENIED: KATEGORIJA.BLOKUOJANTIS,
  ADMIN_ACCESS_DENIED: KATEGORIJA.BLOKUOJANTIS,
  /**
   * Privilegijuotas nuosavybės apėjimas - tai autorizacijos sprendimas, ne
   * priežiūros darbas. Įrašas be patvirtinimo reikštų, kad administratorius
   * ištrynė svetimą job'ą, o pėdsako nėra.
   */
  ADMIN_DELETE_OVERRIDE: KATEGORIJA.BLOKUOJANTIS,

  // ── GDPR ištrynimas (#210: blokuojanti šeima) ──────────────────────────────
  /**
   * Visi keturi ŠALINA asmens duomenis. Ištrynimas be patvirtinto audito yra
   * būtent tas atvejis, kuriam auditas ir egzistuoja: po jo nebelieka ko
   * tikrinti.
   *
   * ⚠️ BET ČIA JIE YRA POST-HOC - žr. `POST_HOC_IVYKIAI`. Šiuose keturiuose
   * keliuose auditas rašomas JAU PO trynimo, tad audito gedimas neleidžia
   * deklaruoti sėkmės, bet duomenų nebeapsaugo.
   */
  DATA_ERASED: KATEGORIJA.BLOKUOJANTIS,
  LIFECYCLE_DELETION: KATEGORIJA.BLOKUOJANTIS,
  RETENTION_PURGE: KATEGORIJA.BLOKUOJANTIS,
  ADMIN_ORPHAN_CLEANUP: KATEGORIJA.BLOKUOJANTIS,

  /**
   * ⚠️ ŽYMŲ OPERATORIAUS KELIAS - BLOKUOJANTIS IR *NE* POST-HOC (#155, 7.5a / #183).
   *
   * Barjeras nuo `deletion_pending` plius neterminalių žymų nesenėjimas reiškia,
   * kad nuolat nepavykstantis ištrynimas užrakintų job'ą neribotam laikui.
   * Išeitis yra, bet ji privalo palikti pėdsaką.
   *
   * ⚠️ NUO #183 PERŽIŪROS ŠIE ĮVYKIAI YRA POST-HOC, ir tai ATŠAUKIA ankstesnį
   * priskyrimą. Anksčiau čia stovėjo „rašomi PRIEŠ veiksmą: neužfiksavus, KAS
   * nuėmė barjerą, barjeras NENUIMAMAS".
   *
   * Ta tvarka dengė tik vieną gedimo pusę: du lygiagretūs operatoriai abu
   * įrašydavo `success: true`, o sąlyginis perėjimas pavykdavo tik vienam -
   * likdavo patvarus sėkmės įrašas veiksmui, kurio nebuvo. Todėl
   * `erasureMarkService` dabar commit'ina perėjimą PIRMA, o auditą rašo po jo
   * su `success` pagal faktinį rezultatą.
   *
   * Klasifikacija seka realizaciją, ne atvirkščiai: audito gedimas šių perėjimų
   * nebeatšaukia, tad žymėti juos „ne post-hoc" reikštų tvirtinti apsaugą,
   * kurios nebėra. BLOKUOJANTIS lieka - sėkmė be patvirtinto įrašo
   * nedeklaruojama (kvietėjas gauna klaidą), bet duomenų tai nebeapsaugo.
   */
  ERASURE_MARK_RETRIED: KATEGORIJA.BLOKUOJANTIS,
  ERASURE_MARK_FORCE_RESOLVED: KATEGORIJA.BLOKUOJANTIS,
  ERASURE_MARK_RELEASED: KATEGORIJA.BLOKUOJANTIS,

  // ── Job gyvavimo ciklas (#210: neblokuojantys) ─────────────────────────────
  TRANSCRIPTION_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  TRANSCRIPTION_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  PROTOCOL_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  PROTOCOL_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  PROCESSING_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  PROCESSING_FAILED: KATEGORIJA.NEBLOKUOJANTIS,

  // ── Eksportas, įkėlimai, kopijos (#210 blokuojančių šeimų sąraše NĖRA) ─────
  /**
   * Eksporto ir įkėlimo įvykiai fiksuoja ĮVYKUSĮ veiksmą; sprendimą „ar leisti"
   * priima `requirePermission`, kurio atmetimas rašo `AUTHORIZATION_DENIED`
   * (blokuojantis). Todėl audito gedimas čia negali reikšti, kad vartotojo
   * failas dingsta - operacija tęsiasi, o gedimas lieka matomas.
   */
  EXPORT_STARTED: KATEGORIJA.NEBLOKUOJANTIS,
  EXPORT_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  EXPORT_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  UPLOAD_REJECTED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_CREATED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_REJECTED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_RESTORED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_RESTORE_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  /**
   * ⚠️ ATSKIRAS NUO `BACKUP_CREATED` (#248, 7.6a). Aplikacijos kopija turi
   * politikos filtruotą turinį, o `pg_dump` artefaktas - visą bazę; auditoriui
   * tai skirtingi dalykai, ir vienas įvykio vardas juos suplaktų.
   *
   * Atitikmens atkūrimo pusėje NĖRA sąmoningai: ten `audit_log` neįtrauktas į
   * dump'ą, tikslinė bazė tuščia, o rašymas į kitą saugyklą reikštų, kad
   * avarinis atkūrimas priklauso nuo audito prieinamumo.
   */
  PG_DUMP_BACKUP_CREATED: KATEGORIJA.NEBLOKUOJANTIS,
  /**
   * ⚠️ POST-RESTORE SUDERINIMAS (#249, 7.6b). Rašomas TIK po sėkmingo commit:
   * rollback negali palikti įrašo „suderinta", nes tokiu atveju evidencija
   * teigtų daugiau, nei įvyko.
   *
   * NEBLOKUOJANTIS, kaip ir kiti kopijų/atkūrimo įvykiai: audito gedimas
   * nepadaro jau commit'into suderinimo neįvykusio, o jo „atsukti" nebūtų kaip.
   */
  POST_RESTORE_RECONCILED: KATEGORIJA.NEBLOKUOJANTIS,
});

/**
 * ⚠️ `normalizeEvent()` IŠVEDAMŲ ĮVYKIŲ AIBĖ.
 *
 * `auditLog.normalizeEvent()` grąžina šiuos vardus, kai kvietėjas `event`
 * nenurodo (transkripcijos ir protokolo keliai). Jie NĖRA matomi kaip
 * literalai call site'uose, tad statinė call site'ų paieška jų nerastų - o
 * neklasifikuotas įvykis turi kristi, ne praeiti.
 *
 * Sąrašas laikomas ČIA ir tikrinamas paleidimo metu (`validateAuditEvents`)
 * PRIEŠ `AUDIT_EVENTS`, todėl `normalizeEvent` šakos pakeitimas be įrašo
 * klasifikacijoje sustabdo startą.
 */
const IŠVEDAMI_ĮVYKIAI = Object.freeze([
  "TRANSCRIPTION_COMPLETED",
  "TRANSCRIPTION_FAILED",
  "PROTOCOL_COMPLETED",
  "PROTOCOL_FAILED",
  "PROCESSING_COMPLETED",
  "PROCESSING_FAILED",
]);

/**
 * ĮVYKIAI, KURIŲ AUDITAS RAŠOMAS PO NEGRĮŽTAMO VEIKSMO.
 *
 * ⚠️ TAI KONSTRUKCIJOS SAVYBĖ, NE PRALEIDIMAS.
 *
 * Šiuose keliuose destruktyvus darbas jau būna atliktas, kai `rasytiAudita()`
 * kviečiamas:
 *
 *   utils/jobErasure.js          saugykla → audito įrašai → job'as → AUDITAS
 *   services/lifecycleService.js ištrynimas → rezultatas   → AUDITAS
 *   utils/retentionSweeper.js    job'ai → audio → įrašai    → AUDITAS
 *   services/adminJobService.js  eraseOrphanedJobData()     → AUDITAS
 *
 * Todėl jiems galioja BLOKUOJANTIS („sėkmė nedeklaruojama"), bet NEGALIOJA
 * fail-closed („veiksmas atmetamas"): atmesti nebėra ko. Praktinė nauda išlieka
 * reali - `DELETE` grąžina 503 vietoj 204, ir operatorius sužino, kad pėdsako
 * nėra. Bet duomenų tai nebeapsaugo, ir to tvirtinti negalima.
 *
 * ⚠️ PERRIKIAVIMAS SĄMONINGAI ATIDĖTAS, SU ADRESU.
 *
 * Auditas šiandien gyvena ATMINTYJE tame pačiame procese, tad „patvirtintas"
 * įrašas neduoda patvarumo - jį praranda restartas. Rašyti auditą PRIEŠ
 * trynimą dabar reikštų naują gedimo režimą (nepavykęs trynimas paliktų
 * melagingą „ištrinta" pėdsaką) negaunant realios garantijos.
 *
 * ⚠️ 7.4b SPRENDIMAS (#211): PERRIKIAVIMO ČIA NĖRA, IR TAI SĄMONINGA.
 *
 * [7.4b] persistentinį auditą jau įgyvendino - įrašas išgyvena restartą. Bet
 * PATVARUMAS NĖRA PERRIKIAVIMAS. Kad šie įvykiai taptų tikrai fail-closed,
 * auditas turėtų būti rašomas PRIEŠ veiksmą, o tai keičia ištrynimo semantiką:
 * nepavykęs trynimas paliktų melagingą „ištrinta" pėdsaką, jei nebūtų
 * kompensacinio mechanizmo.
 *
 * Toks mechanizmas - patvari eilė su eksplicitiniu klaidų pranešimu - yra
 * SUBISSUES-155.md [7.5b] („AUDITO RAŠYMO KLAIDOS NEPRARANDAMOS"). Iki tol
 * perrikiavimas pakeistų vieną gedimo režimą kitu, negaunant realios garantijos.
 *
 * Pagrindimas užrašytas ČIA ir `docs/audit-storage.md` §12, o ne issue
 * komentare, kad jo nereikėtų atkurti iš išorinių šaltinių.
 */
const POST_HOC_IVYKIAI = Object.freeze([
  "DATA_ERASED",
  "LIFECYCLE_DELETION",
  "RETENTION_PURGE",
  "ADMIN_ORPHAN_CLEANUP",
  /**
   * ⚠️ PRIDĖTA #183 PERŽIŪROJE. Abu operatoriaus keliai commit'ina žymos
   * perėjimą PRIEŠ `rasytiAudita()`, tad audito gedimas jo nebeatšaukia:
   * pakartotinis bandymas grąžins `already_terminal`, ne pakartos veiksmą.
   */
  "ERASURE_MARK_RETRIED",
  "ERASURE_MARK_FORCE_RESOLVED",
  "ERASURE_MARK_RELEASED",
  /**
   * Sesija jau atšaukta ir cookie išvalytas, kai rašomas `LOGOUT`. Atmesti
   * atsijungimo nebegalima - o ir nereikėtų: neatšaukta sesija būtų blogesnė
   * pusė. Kvietėjas vis tiek gauna 503 (sėkmė nedeklaruojama), bet veiksmas
   * jau įvykęs, tad tai post-hoc, ne fail-closed.
   */
  "LOGOUT",
  /**
   * `ADMIN_DELETE_OVERRIDE` rašomas PO `deleteJobArtefacts()` - artefaktai jau
   * pašalinti. Autorizacijos sprendimas čia priimtas anksčiau, bet įrašas apie
   * jį - ne, tad veiksmo atmesti nebegalima.
   */
  "ADMIN_DELETE_OVERRIDE",
]);

/** Ar šio įvykio auditas rašomas jau po negrįžtamo veiksmo? */
function arPostHoc(event) {
  return POST_HOC_IVYKIAI.includes(event);
}

/** Nežinomas įvykis - kontroliuojama klaida, ne numatytoji kategorija. */
/**
 * Eksplicitiškai nurodytas įvykio vardas nesilaiko vardų kontrakto.
 *
 * ⚠️ KODĖL TAI ATSKIRA KLAIDA, O NE TYLUS NUKRITIMAS Į IŠVEDIMĄ (#210).
 *
 * `normalizeEvent()` naudoja `entry.event` tik tada, kai jis atitinka
 * `EVENT_PATTERN`. Neatitinkantis (pvz. `"login_success"` vietoj
 * `"LOGIN_SUCCESS"`) būdavo TYLIAI ignoruojamas, o įvykis išvedamas iš kitų
 * laukų - autentikacijos įvykis su rašybos klaida taip paveldėdavo
 * `PROCESSING_COMPLETED` ir kartu NEBLOKUOJANČIĄ semantiką. Blokuojanti
 * garantija dingdavo be jokio signalo.
 */
class MalformedAuditEventError extends Error {
  constructor(vardas) {
    /**
     * ⚠️ Į žinutę patenka TIPAS, o ne svetima reikšmė.
     *
     * Reikšmė gali ateiti iš dinaminio šaltinio ir nešti naudotojo duomenų, o
     * `JSON.stringify()` ciklinį objektą apskritai mestų - klaidos konstruktorius
     * kristų vietoj to, kad praneštų problemą. Eilutė rodoma pilnai (ji jau
     * neatitinka šablono, tad PII joje netelpa) ir apkarpoma dėl logų higienos.
     */
    const aprasas =
      typeof vardas === "string"
        ? JSON.stringify(vardas.slice(0, 64))
        : vardas === null
          ? "null"
          : `tipas ${typeof vardas}`;

    super(
      `Audito įvykio vardas neatitinka kontrakto: ${aprasas}. ` +
        "Laukiama VERSALIAIS su pabraukimais (pvz. LOGIN_SUCCESS)."
    );
    this.name = "MalformedAuditEventError";
    this.code = "AUDIT_EVENT_MALFORMED";
  }
}

class UnclassifiedAuditEventError extends Error {
  constructor(event) {
    super(
      `Audito įvykis "${event}" neturi klasifikacijos (utils/auditEvents.js). ` +
        "Kiekvienas įvykis privalo būti eksplicitiškai blokuojantis arba neblokuojantis - " +
        "numatytoji kategorija reikštų, kad naujas security įvykis tyliai paveldi silpnesnę semantiką."
    );
    this.name = "UnclassifiedAuditEventError";
    this.code = "AUDIT_EVENT_UNCLASSIFIED";
  }
}

/**
 * @returns {"blocking"|"non-blocking"}
 * @throws {UnclassifiedAuditEventError} nežinomam įvykiui.
 */
function kategorija(event) {
  const rasta = Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, event)
    ? AUDIT_EVENTS[event]
    : undefined;
  if (!rasta) throw new UnclassifiedAuditEventError(event);
  return rasta;
}

function arBlokuojantis(event) {
  return kategorija(event) === KATEGORIJA.BLOKUOJANTIS;
}

/**
 * PALEIDIMO METU: kiekvienas žinomas įvykis turi klasifikaciją.
 *
 * ⚠️ TIKRINAMI IR IŠVEDAMI ĮVYKIAI. Jie neturi literalo nė viename call site'e,
 * tad be šios patikros `normalizeEvent()` galėtų grąžinti vardą, kurio
 * klasifikacijoje nėra, ir gedimas iškiltų tik pirmo tokio job'o metu.
 *
 * @returns {string[]} klaidų sąrašas (tuščias - viskas gerai).
 */
/**
 * PRODUKCINIŲ `rasytiAudita()` KVIETIMŲ ĮVYKIAI - iš ŠALTINIO, ne iš sąrašo.
 *
 * ⚠️ KODĖL TO REIKIA STARTE.
 *
 * Be šios patikros `rasytiAudita({ event: "NAUJAS" })` pridėjimas nesukeltų
 * JOKIOS starto klaidos: validatorius apeidavo tik ranka prižiūrimą išvedamų
 * įvykių sąrašą ir jau esančius `AUDIT_EVENTS` įrašus. Gedimas iškiltų tik tada,
 * kai tas kelias realiai suveiktų - o #210 reikalauja „neklasifikuotas → klaida
 * STARTO metu". CI tripwire testas to nepakeičia: jis nėra paleidimo garantija.
 *
 * ⚠️ NEKRINTA, JEI ŠALTINIŲ NĖRA. Supakuotame ar apkarpytame diegime katalogų
 * gali nebūti; tada patikra tiesiog neturi ką tikrinti ir NEGALI virsti
 * klaidingu starto gedimu.
 */
const PRODUKCINIAI_KATALOGAI = Object.freeze([
  "utils",
  "services",
  "middleware",
  "routes",
  "workers",
  "queues",
]);

/**
 * ⚠️ SAUGYKLOS SLUOKSNIS NĖRA PRODUCER'IS (#155, 7.4b).
 *
 * `utils/auditStore/*` įvykių NEKURIA - jis atvaizduoja jau sukurtą eilutę į DB
 * ir atgal (`event: row.event`, `event: eilute.event`). Skeneriui tai atrodo
 * kaip įvykis, nurodomas per neišsprendžiamą konstantą, ir startas krinta.
 *
 * ⚠️ IŠIMTIS TIKRINAMA, NE PASITIKIMA. Katalogas išbraukiamas tik tol, kol
 * jame realiai nėra nė vieno rašymo kvietimo; tai tikrina
 * `tests/auditStoreFields.test.js`. Be tokios sargybos išimtis taptų vieta,
 * kurioje klasifikacijos patikra tyliai nustotų galioti.
 */
const NE_PRODUCER_KELIAI = Object.freeze(["auditStore"]);

/**
 * ⚠️ KOMENTARAI PAŠALINAMI PRIEŠ SKENUOJANT (AGENTS.md §9.2).
 *
 * Be to patikra pagauna SAVO PAČIOS dokumentaciją: šio failo komentare yra
 * pavyzdys `rasytiAudita({ event: "NAUJAS" })`, ir startas kristų dėl įvykio,
 * kurio nė vienas call site'as nerašo. Tai patikrinta - būtent taip ir nutiko.
 *
 * Šalinami blokiniai komentarai ir eilutės, prasidedančios `*` arba `//`;
 * kodo eilučių neliečiam, kad `event: "X"` literalai išliktų.
 */
function beKomentaru(turinys) {
  return turinys
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((eilutė) => {
      const t = eilutė.trim();
      return !t.startsWith("*") && !t.startsWith("//");
    })
    .join("\n");
}

/**
 * Randa `IDENT.PROP` reikšmę to paties failo `const IDENT = Object.freeze({...})`
 * (arba paprasto objekto) deklaracijoje.
 *
 * ⚠️ SĄMONINGAI PAPRASTA. Tikslas - padengti repo naudojamą formą, ne parašyti
 * JS parserį. Ko neišsprendžia, tas patenka į `nezinomiSaltiniai` ir tampa
 * MATOMA starto klaida, o ne tyliu praleidimu.
 */
function konstantosReiksme(turinys, identifikatorius, laukas) {
  const dekl = new RegExp(
    `(?:const|let|var)\\s+${identifikatorius}\\s*=\\s*(?:Object\\.freeze\\()?\\{`,
    "m"
  ).exec(turinys);
  if (!dekl) return null;

  let gylis = 0;
  let pradzia = -1;
  for (let i = dekl.index; i < turinys.length; i++) {
    if (turinys[i] === "{") {
      if (gylis === 0) pradzia = i;
      gylis++;
    } else if (turinys[i] === "}") {
      gylis--;
      if (gylis === 0) {
        const kunas = turinys.slice(pradzia, i + 1);
        const m = new RegExp(`\\b${laukas}\\s*:\\s*"([A-Z_0-9]+)"`).exec(kunas);
        return m ? m[1] : null;
      }
    }
  }
  return null;
}

function producerIvykiai() {
  const fs = require("node:fs");
  const path = require("node:path");
  const saknis = path.resolve(__dirname, "..");
  const rasti = new Set();
  const nezinomiSaltiniai = new Set();

  for (const katalogas of PRODUKCINIAI_KATALOGAI) {
    const dir = path.join(saknis, katalogas);
    let irasai;
    try {
      irasai = fs.readdirSync(dir, { recursive: true });
    } catch {
      continue; // katalogo nėra - žr. komentarą aukščiau
    }
    for (const irasas of irasai) {
      if (!String(irasas).endsWith(".js")) continue;
      if (NE_PRODUCER_KELIAI.some((k) => String(irasas).startsWith(`${k}/`))) continue;
      const kelias = path.join(dir, String(irasas));
      let turinys;
      try {
        turinys = fs.readFileSync(kelias, "utf8");
      } catch {
        continue;
      }
      const svarus = beKomentaru(turinys);

      /** Tiesioginiai literalai: `event: "DATA_ERASED"`. */
      for (const m of svarus.matchAll(/event:\s*"([A-Z_0-9]+)"/g)) rasti.add(m[1]);

      /**
       * ⚠️ PER KONSTANTĄ NURODOMI ĮVYKIAI: `event: ADMIN_EVENT.ACCESS_DENIED`.
       *
       * Be šito startas jų NEMATYTŲ: keturi administraciniai call site'ai
       * naudoja būtent šią formą, tad pakeitus `ADMIN_EVENT` reikšmę į
       * neklasifikuotą `validateConfig()` praeitų, o gedimas iškiltų tik per
       * pirmą administracinę operaciją.
       *
       * Reikšmė išvedama iš PAČIOS konstantos deklaracijos, ne iš ranka
       * prižiūrimo sąrašo - todėl naujas konstantos šaltinis padengiamas
       * automatiškai, be jokio įrašo čia.
       */
      /**
       * ⚠️ `(?![\w$])(?!\s*\()` SKIRIA KONSTANTOS NUORODĄ NUO FUNKCIJOS KVIETIMO.
       *
       * `(?![\w$])` PRIVALOMAS: be jo regex atgaliniu sekimu sutrumpina
       * identifikatorių (`nullish` → `nullis`), kad antrasis lookahead
       * pavyktų - ir klaidingas teigiamas grįžta kitu pavidalu. Patikrinta.
       *
       * `middleware/validate.js` Zod schemoje yra `event: identifier.nullish()` -
       * be šio patikslinimo jis patektų į „nežinomų šaltinių" sąrašą ir
       * SUSTABDYTŲ STARTĄ dėl lauko, kuris su auditu neturi nieko bendra.
       * Patikrinta - būtent taip ir nutiko.
       */
      for (const m of svarus.matchAll(
        /event:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)(?![\w$])(?!\s*\()/g
      )) {
        const reiksme = konstantosReiksme(svarus, m[1], m[2]);
        if (reiksme) rasti.add(reiksme);
        else nezinomiSaltiniai.add(`${m[1]}.${m[2]}`);
      }
    }
  }
  return { rasti, nezinomiSaltiniai };
}

function validateAuditEvents() {
  const klaidos = [];

  const { rasti, nezinomiSaltiniai } = producerIvykiai();

  for (const šaltinis of nezinomiSaltiniai) {
    klaidos.push(
      `Audito įvykis nurodomas per konstantą "${šaltinis}", kurios reikšmės nepavyko išvesti. ` +
        "Klasifikacijos pilnumo patikrinti neįmanoma - perkelkite reikšmę į literalą arba papildykite `konstantosReiksme()`."
    );
  }

  for (const įvykis of rasti) {
    if (!Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, įvykis)) {
      klaidos.push(
        `Audito įvykis "${įvykis}" rašomas produkciniame call site'e, bet neklasifikuotas utils/auditEvents.js.`
      );
    }
  }

  for (const įvykis of IŠVEDAMI_ĮVYKIAI) {
    if (!Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, įvykis)) {
      klaidos.push(
        `Audito įvykis "${įvykis}" išvedamas normalizeEvent(), bet neklasifikuotas utils/auditEvents.js.`
      );
    }
  }

  for (const [įvykis, kat] of Object.entries(AUDIT_EVENTS)) {
    if (kat !== KATEGORIJA.BLOKUOJANTIS && kat !== KATEGORIJA.NEBLOKUOJANTIS) {
      klaidos.push(`Audito įvykis "${įvykis}" turi nežinomą kategoriją "${kat}".`);
    }
  }

  return klaidos;
}

module.exports = {
  EVENT_PATTERN,
  MalformedAuditEventError,
  KATEGORIJA,
  AUDIT_EVENTS,
  IŠVEDAMI_ĮVYKIAI,
  UnclassifiedAuditEventError,
  POST_HOC_IVYKIAI,
  arPostHoc,
  kategorija,
  arBlokuojantis,
  validateAuditEvents,
  producerIvykiai,
  NE_PRODUCER_KELIAI,
  /**
   * Eksportuojama testams: statinės patikros PRIVALO nuskusti komentarus, kitaip
   * jos pagauna savo pačių dokumentaciją (taip jau nutiko #210 eigoje).
   */
  beKomentaru,
};
