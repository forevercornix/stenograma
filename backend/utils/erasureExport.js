const crypto = require("node:crypto");

const { TOMBSTONE_STATUS, ALLOWED_TRANSITIONS } = require("./deletionTombstones/states");
const backupEncryption = require("./backupEncryption");
const backupManifest = require("./backupManifest");
const { arNurodytaPostgres, arTaPatiBaze, tapatybesTekstas, jungtiesTapatybe, pgJungtiesNustatymai } = require("./pgConnection");

/**
 * ARTEFAKTO RŪŠIS — TA PATI FORMA KAIP 7.6a (#250).
 *
 * ⚠️ RŪŠIS GYVENA ŠIFRUOJAMAME TURINYJE, NE MANIFESTE. 7.6a taip sprendė
 * tiksliai tą patį klausimą: manifesto laukų aibė yra AAD dalis, tad naujas
 * laukas reikštų v2 formato keitimą. Antraštė ciphertext'e GCM žyma
 * autentifikuojama kartu su turiniu, ir jokios kriptografijos keisti nereikia.
 *
 * ⚠️ SKIRTINGA RŪŠIS NEI DUMP'AS — SĄMONINGAI. `STENOGRAMA-PG-DUMP` ir šis
 * žurnalas eina per TĄ PAČIĄ šifravimo grandinę, tad be rūšies antraštės
 * operatorius galėtų paduoti dump'ą ten, kur laukiamas žurnalas, ir atvirkščiai.
 */
const ANTRASTE = "STENOGRAMA-ERASURE-LEDGER";
const ANTRASTES_VERSIJA = "v1";

/**
 * ⚠️ DYDŽIO RIBA ĮVARDYTA, NE NUMANOMA (tas pats sprendimas kaip 7.6a D6).
 *
 * Žurnalas eina per tą pačią grandinę, kur envelope laukai yra base64 EILUTĖS
 * atmintyje, o `listAll()` skaito visas žymas be `LIMIT`. Žymų lentelė gerokai
 * mažesnė už dump'ą (viena eilutė ~200 B), tad 32 MB atitinka ~150 000 žymų —
 * bet riba turi būti PASAKYTA, kad operatorius gautų aiškią klaidą, o ne neaiškų
 * kritimą viduryje.
 */
const MAX_ZURNALO_BYTES = 32 * 1024 * 1024;

/**
 * IŠTRYNIMO BŪSENOS EKSPORTAS IR MONOTONIŠKAS SULIEJIMAS (#155, 7.6c / #250).
 *
 * ⚠️ VIENAS AUTORITETAS DVIEM TAISYKLĖMS.
 *
 * DB snapshot'as gali būti senas, bet ištrynimo žurnalas negali būti senesnis už
 * ištrynimus, kurių galutinumą žadame. Todėl 7.5a žymos eksportuojamos UŽ
 * snapshot'o ribų ir po atkūrimo suliejamos atgal. Suliejimo taisyklė yra DVIEJŲ
 * DALIŲ, ir abi gyvena ČIA - antra jų kopija SQL'e ar teste būtų ta pati dviejų
 * tiesų klasė, kurią repo jau gaudė keturis kartus.
 *
 * ⚠️ ANTRA ERASURE SEMANTIKA NEKURIAMA. Naudojamas tas pats `TOMBSTONE_STATUS`
 * modelis; šis modulis tik SPRENDŽIA, kuris iš dviejų to paties modelio įrašų
 * yra autoritetingas.
 */

/**
 * 1 DALIS — TERMINALUMAS IŠVEDAMAS IŠ GRAFO, NE SURAŠOMAS.
 *
 * `ALLOWED_TRANSITIONS` sako: `PENDING → [DELETED, FAILED]`, `FAILED → [PENDING]`,
 * `DELETED → []`. Būsena, iš kurios nėra kur eiti, yra terminali — ir būtent ji
 * suliejime laimi visada.
 *
 * ⚠️ IŠVEDIMAS, NE SĄRAŠAS: jei kada nors `FAILED` taptų terminalus, ši funkcija
 * pasikeis kartu su grafu, o `terminaliniaiStatusai()` testas pareikalaus, kad
 * pokytis būtų SĄMONINGAS - grafe terminalus statusas privalo likti VIENAS.
 */
function arTerminalus(status) {
  const isejimai = ALLOWED_TRANSITIONS[status];
  return Array.isArray(isejimai) && isejimai.length === 0;
}

/** Visi terminaliniai statusai grafe — testui, kad jų liktų lygiai vienas. */
function terminaliniaiStatusai() {
  return Object.keys(ALLOWED_TRANSITIONS).filter(arTerminalus).sort();
}

/**
 * 2 DALIS — `pending` vs `failed` YRA LAIKO TAISYKLĖ, NE GRAFO.
 *
 * ⚠️ GRAFAS ČIA TYLI, IR TAI NE SPRAGA. `PENDING → FAILED → PENDING` yra ciklas,
 * tad pasiekiamumas nepasako, kuris įrašas naujesnis. Senesnio `pending` importas
 * virš naujesnio `failed` nutrintų gedimo metaduomenis (`lastFailureKind`,
 * `attempts`), o atvirkščiai — nuslopintų naujesnį autorizuotą retry.
 *
 * ⚠️ RAKTAS IMAMAS IŠ EKSPORTUOTŲ REIKŠMIŲ, NE IŠ RAŠYMO METO.
 *
 * `postgresStore` `updated_at` stamp'ina serveriu (`now()`), tad bet koks
 * sanitizacijos ar suliejimo rašymas pats pagamintų „šviežumą" ir galėtų nurungti
 * tikrai naujesnę vietinę žymą. Sprendimas priimamas PRIEŠ rašymą, iš abiejų
 * pusių `updatedAt`.
 *
 * ⚠️ LYGIOSIOS PALIEKA VIETINĘ. Vienodas `updatedAt` reiškia, kad naujesnio
 * įrodymo nėra; suliejimas be įrodymo yra pokytis be priežasties, o D5 reikalauja,
 * kad antras paleidimas nieko nekeistų.
 */
function laimiImportuotas(importuotas, vietinis) {
  if (!vietinis) return true;

  /** Terminalus visada laimi — nesvarbu, kurioje pusėje jis yra. */
  if (arTerminalus(vietinis.status)) return false;
  if (arTerminalus(importuotas.status)) return true;

  const i = Number(importuotas.updatedAt) || 0;
  const v = Number(vietinis.updatedAt) || 0;

  return i > v;
}

/**
 * ⚠️ SVETIMAS `claim_token` NIEKADA NEPERSISTINAMAS (D1 sprendimas).
 *
 * `claim_token` žymi GYVĄ vykdytoją ir neturi nei lease, nei timeout'o. Po DR bet
 * kuris eksportuotas tokenas priklauso mirusiam pre-restore procesui; importavus
 * jį nepakeistą, `lifecycleService` grąžina `IN_PROGRESS` neribotai, ir
 * koordinatorius niekada nebaigia.
 *
 * ⚠️ VALOMA PRIEŠ RAŠYMĄ, NE PER `release()` PO JO. Issue leidžia abu, tad
 * pasirinkimas užrašomas čia:
 *
 *   · `release()` yra `PENDING → FAILED(executor_lost)` — tai BŪSENOS pokytis,
 *     ne sanitizacija: importuotas `pending` po jo nebebūtų tas, ką eksportavome;
 *   · jis rašo antrą kartą ir bumpina `updated_at`, tad sanitizacija pati
 *     pagamintų šviežumą (žr. `laimiImportuotas`);
 *   · tarp „merge" ir „release" esantis kritimas paliktų DB su gyvu svetimu
 *     tokenu, ir D5 antras paleidimas jo nebematytų kaip importuoto.
 *
 * Todėl tokenas nukerpamas dar eksporto/suliejimo pusėje, o faktas patenka į
 * evidenciją (`nukirptiClaimai`).
 */
function beClaimo(irasas) {
  const { claimToken, ...likusi } = irasas;
  return { ...likusi, claimToken: null, turejoClaima: Boolean(claimToken) };
}

/**
 * Suliejimo SPRENDIMAS be jokio I/O.
 *
 * ⚠️ GRĄŽINA PLANĄ, NE VYKDO JĮ. Taip ta pati taisyklė tikrinama be duomenų bazės
 * (kontraktinis testas) ir vykdoma su ja (koordinatorius) — vienas įėjimo taškas,
 * ne dvi kopijos (#266).
 *
 * @param {Array<object>} importuotos eksportuotos žymos
 * @param {Map<string, object>} vietines `jobId → žyma` iš atkurtos DB
 * @returns {{rasyti: Array<object>, praleisti: Array<object>, nukirptiClaimai: string[]}}
 */
function suliejimoPlanas(importuotos, vietines) {
  const rasyti = [];
  const praleisti = [];
  const nukirptiClaimai = [];

  for (const zalia of importuotos) {
    const importuota = beClaimo(zalia);
    if (importuota.turejoClaima) nukirptiClaimai.push(importuota.jobId);

    const vietine = vietines.get(importuota.jobId) || null;

    if (laimiImportuotas(importuota, vietine)) rasyti.push(importuota);
    else praleisti.push({ jobId: importuota.jobId, priezastis: vietine ? "vietinė naujesnė ar terminali" : "nėra ko rašyti" });
  }

  return { rasyti, praleisti, nukirptiClaimai };
}

/**
 * KOPIJŲ HORIZONTAS SULIEJAMAS MONOTONIŠKAI (D1, #250).
 *
 * ⚠️ SENESNIO SNAPSHOT'O ATKŪRIMAS ATSUKA `backup_horizon` ATGAL.
 *
 * `recordBackupHorizon()` aukščiausią reikšmę saugo TOJE PAČIOJE bazėje, tad
 * atkūrus senesnę kopiją ji tampa senesnė. Jei po to snapshot'o buvo išleista
 * ilgiau galiojanti kopija, importuotos žymos taptų šalintinos, nors ta kopija
 * dar gali prikelti jų job'us.
 *
 * Todėl eksportas neša maksimalią išleistą galiojimo pabaigą, ir ji suliejama
 * PRIEŠ atnaujinant žymų retenciją.
 */
function horizontoMaksimumas(eksportuotas, vietinis) {
  /**
   * ⚠️ `Number(null)` YRA `0`, IR TAI NE TEORIJA — pirmoji redakcija dėl to
   * „neturiu horizonto" pavertė į `1970-01-01`, t. y. į galiojusią, bet seniai
   * pasibaigusią kopiją. Nebuvimas tikrinamas eksplicitiškai.
   */
  const skaicius = (reiksme) => {
    if (reiksme === null || reiksme === undefined || reiksme === "") return null;
    const n = Number(reiksme);
    return Number.isFinite(n) ? n : null;
  };

  const a = skaicius(eksportuotas);
  const b = skaicius(vietinis);

  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * ⚠️ REPLAY APIMA VISAS ŽYMAS, NE TIK `deleted` (D2 pasekmė).
 *
 * Kiekviena egzistuojanti žyma reiškia „šio subjekto duomenų būti neturi":
 * `deleted` — ištrynimas patvirtintas; `deletion_pending` — pradėtas;
 * `deletion_failed` — bandytas ir nepavyko, bet leidimas gyvuoti nuo to
 * neatsiranda.
 *
 * ⚠️ BE ŠITO SANITIZACIJA TYLIAI PRARASTŲ IŠTRYNIMĄ: nukirpus svetimą claim'ą,
 * pagrindinis „pasenusio vykdytojo" atvejis DB guli kaip `deletion_pending` (arba
 * `deletion_failed`, jei kas nors jį atlaisvino). Replay, imantis tik `deleted`,
 * tokį job'ą paliktų gyvą, o DoD testas „neblokuoja ties IN_PROGRESS" vis tiek
 * būtų žalias.
 */
function arReikiaReplay(status) {
  return Object.values(TOMBSTONE_STATUS).includes(status);
}

class ErasureExportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ErasureExportError";
    this.code = code;
  }
}

/**
 * ŠALTINIO TAPATYBĖ — KILMĖS KLAUSIMAS, KURIO TAPATUMO SARGAS NEUŽDARO (#250).
 *
 * ⚠️ TAPATUMO SARGAS GINA „Į KURIĄ BAZĘ RAŠOME", NE „IŠ KUR ŠIS ŽURNALAS".
 *
 * Be kilmės žymos niekas nesustabdytų importo iš KITO diegimo eksporto: žymos yra
 * tik `job_id` reikšmės, o 7.6a manifestas šaltinio tapatybės sąmoningai neneša.
 * Sutapus ID, svetimi job'ai būtų ištrinti tyliai.
 *
 * ⚠️ KODĖL TAI NE PRIVATUMO REGRESIJA. Tapatybė rašoma į ŠIFRUOJAMĄ turinį, ne į
 * manifestą: (1) atviru tekstu ji nematoma; (2) joje nėra kredencialų ir nėra
 * asmens duomenų — tik `host:port/database`; (3) 7.6a ribojimas buvo apie
 * MANIFESTĄ (jis guli šalia artefakto), ir tas pats sprendimas — „rūšis
 * šifruojamame turinyje" — jau ten priimtas.
 */
function saltinioTapatybe(env = process.env) {
  return tapatybesTekstas(jungtiesTapatybe(pgJungtiesNustatymai(env), env));
}

/**
 * FAIL-CLOSED SARGAI PRIEŠ PIRMĄ RAŠYMĄ (D7a, D7b, D7c).
 *
 * ⚠️ ŽYMŲ AŠIS TURI SAVO VERDIKTĄ. „Žymos atmintyje" ir „ne ta bazė" yra DVI
 * skirtingos operatoriaus klaidos: pirmuoju atveju eksportas apskritai neturi ką
 * skaityti (ir dingtų procesui pasibaigus), antruoju — dirbtų ne ten. 7.6b ta pati
 * pora išmokta brangiai.
 */
function patikrintiSargus(targetUrl, env = process.env) {
  if (!targetUrl) {
    throw new ErasureExportError("Nenurodytas tikslinės bazės URL.", "ERASURE_NO_TARGET");
  }

  if (!arNurodytaPostgres(env)) {
    throw new ErasureExportError(
      "Ištrynimo žymos nėra PostgreSQL režime (`DATABASE_URL`/`PGHOST` nenurodyti). " +
        "Eksportas atmintyje neturi ko išsaugoti, o importas dingtų procesui pasibaigus.",
      "ERASURE_MARKS_NOT_PERSISTENT"
    );
  }

  const { sutampa, nurodyta, konfiguracija } = arTaPatiBaze(targetUrl, env);
  if (!sutampa) {
    throw new ErasureExportError(
      `Nurodyta bazė (${tapatybesTekstas(nurodyta)}) nesutampa su ta, prie kurios ` +
        `prisirišusios žymų saugyklos (${tapatybesTekstas(konfiguracija)}).`,
      "ERASURE_TARGET_MISMATCH"
    );
  }

  return { tapatybe: tapatybesTekstas(konfiguracija) };
}

function _antrasteBaitais() {
  return `${ANTRASTE}\n${ANTRASTES_VERSIJA}\n\n`;
}

/**
 * Sudaro ŠIFRUOTĄ žurnalo artefaktą 7.6a kontraktu.
 *
 * @returns {{manifest: object, envelope: object, zymuSkaicius: number}}
 */
function sudarytiArtefakta({ zymos, horizontas, saltinis, deploymentId, env = process.env }) {
  if (!deploymentId) {
    throw new ErasureExportError(
      "Eksportas be diegimo tapatybės neišduodamas: importas negalėtų atskirti savo " +
        "žurnalo nuo svetimo.",
      "ERASURE_DEPLOYMENT_UNKNOWN"
    );
  }

  if (!backupEncryption.isEnabled(env)) {
    throw new ErasureExportError(
      "Šifravimas neįjungtas: ištrynimo žurnale yra `job_id` reikšmės, tad be " +
        "AES-256-GCM jis neišduodamas.",
      "ERASURE_ENCRYPTION_DISABLED"
    );
  }

  const turinys = JSON.stringify({
    /**
     * ⚠️ DIEGIMO TAPATYBĖ, NE VIETA. `saltinis` (`host:port/db`) lieka
     * DIAGNOSTIKAI - žmogui skaitomas kontekstas klaidos pranešime. Sprendimą
     * „ar tai mūsų žurnalas" priima `deploymentId`, nes DR atkuria į kitą vietą,
     * ir vietos palyginimas kristų kiekvienoje tikroje avarijoje.
     */
    deploymentId,
    saltinis,
    eksportuotaMs: Date.now(),
    horizontas: horizontas === null || horizontas === undefined ? null : Number(horizontas),
    zymos,
  });

  const plaintext = `${_antrasteBaitais()}${turinys}`;
  const baitai = Buffer.byteLength(plaintext, "utf8");

  if (baitai > MAX_ZURNALO_BYTES) {
    throw new ErasureExportError(
      `Žurnalas per didelis: ${baitai} B > ${MAX_ZURNALO_BYTES} B.`,
      "ERASURE_LEDGER_TOO_LARGE"
    );
  }

  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  return {
    manifest,
    envelope: backupEncryption.encrypt(plaintext, { env, manifest }),
    zymuSkaicius: zymos.length,
  };
}

/**
 * Fail-closed artefakto validacija PRIEŠ bet kokį suliejimą.
 *
 * ⚠️ VISOS PATIKROS PRIEŠ PIRMĄ RAŠYMĄ (D7c): manifestas, GCM žyma su AAD,
 * kontrolinė suma, rūšies antraštė ir kilmė. Nė viena jų nekeičia DB būsenos.
 */
function perskaitytiArtefakta({ envelope, manifest, env = process.env }) {
  const patikra = backupManifest.validateManifest(manifest);
  if (!patikra.valid) {
    throw new ErasureExportError(
      `Manifestas negalioja: ${patikra.errors.join("; ")}.`,
      "ERASURE_MANIFEST_INVALID"
    );
  }

  let plaintext;
  try {
    const { plaintext: buferis } = backupEncryption.decrypt(envelope, { env, manifest });
    plaintext = buferis.toString("utf8");
  } catch (klaida) {
    throw new ErasureExportError(
      `Žurnalo dešifruoti nepavyko (${klaida.code || "nežinoma"}).`,
      "ERASURE_DECRYPTION_FAILED"
    );
  }

  const suma = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (suma !== manifest.checksum) {
    throw new ErasureExportError("Kontrolinė suma nesutampa - žurnalas sugadintas.", "ERASURE_CHECKSUM_MISMATCH");
  }

  const riba = plaintext.indexOf("\n\n");
  const antraste = riba === -1 ? [] : plaintext.slice(0, riba).split("\n");

  if (antraste[0] !== ANTRASTE) {
    throw new ErasureExportError(
      `Netikėta artefakto rūšis: ${JSON.stringify(antraste[0] || null)}. Šis kelias laukia ištrynimo žurnalo, ne DB kopijos.`,
      "ERASURE_LEDGER_KIND_MISMATCH"
    );
  }
  if (antraste[1] !== ANTRASTES_VERSIJA) {
    throw new ErasureExportError(
      `Nepalaikoma žurnalo versija: ${JSON.stringify(antraste[1] || null)}.`,
      "ERASURE_LEDGER_VERSION"
    );
  }

  let turinys;
  try {
    turinys = JSON.parse(plaintext.slice(riba + 2));
  } catch {
    throw new ErasureExportError("Žurnalo turinys nėra galiojantis JSON.", "ERASURE_LEDGER_MALFORMED");
  }

  if (!Array.isArray(turinys.zymos)) {
    throw new ErasureExportError("Žurnale nėra žymų masyvo.", "ERASURE_LEDGER_MALFORMED");
  }

  return turinys;
}

/**
 * KILMĖS PATIKRA — „ar šis žurnalas iš ŠIO diegimo" (#250).
 *
 * ⚠️ SARGAS, KURIO APĖJIMAS YRA NORMALUS KELIAS, NĖRA SARGAS.
 *
 * Todėl lyginama TAPATYBĖ, ne vieta: tikra DR (kitas hostas, tie patys duomenys)
 * praeina tyliai, nes identifikatorius atkeliauja kartu su `pg_dump`; svetimas
 * žurnalas krenta garsiai.
 *
 * ⚠️ NEŽINOMA TAPATYBĖ NĖRA „LEIDŽIU". Trūkstamas identifikatorius bet kurioje
 * pusėje yra atskira klaida: fail-open būtent ten, kur sprendžiama, ar trinti
 * svetimus duomenis, būtų blogiausia įmanoma numatytoji reikšmė.
 */
function patikrintiKilme(zurnalas, bazesDeploymentId) {
  const zurnaloId = zurnalas && zurnalas.deploymentId;

  if (!zurnaloId || !bazesDeploymentId) {
    throw new ErasureExportError(
      "Diegimo tapatybė nežinoma (žurnale arba bazėje). Importas neįmanomas: " +
        "neįmanoma atskirti savo žurnalo nuo svetimo.",
      "ERASURE_DEPLOYMENT_UNKNOWN"
    );
  }

  if (String(zurnaloId) !== String(bazesDeploymentId)) {
    throw new ErasureExportError(
      `Žurnalas priklauso KITAM diegimui (žurnale ${zurnaloId}, bazėje ${bazesDeploymentId}; ` +
        `žurnalo šaltinis buvo ${zurnalas.saltinis || "nenurodytas"}). Importas sustabdytas: ` +
        "svetimo žurnalo replay ištrintų šios bazės job'us.",
      "ERASURE_FOREIGN_LEDGER"
    );
  }

  return { deploymentId: String(bazesDeploymentId) };
}

module.exports = {
  patikrintiKilme,
  ANTRASTE,
  ANTRASTES_VERSIJA,
  MAX_ZURNALO_BYTES,
  ErasureExportError,
  saltinioTapatybe,
  patikrintiSargus,
  sudarytiArtefakta,
  perskaitytiArtefakta,
  arTerminalus,
  terminaliniaiStatusai,
  laimiImportuotas,
  beClaimo,
  suliejimoPlanas,
  horizontoMaksimumas,
  arReikiaReplay,
};
