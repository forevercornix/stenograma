const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

/**
 * Bendras failų storage jobams.
 *
 * PROBLEMA, kurią sprendžia: BullMQ režime worker'is yra ATSKIRAS procesas (galbūt
 * atskiras konteineris). Jei HTTP backend įrašo audio į savo lokalų /tmp ir perduoda
 * tą kelią per queue, worker'is jo NEPASIEKS. Sprendimas - bendras storage, kur
 * queue payload'e keliauja tik STORAGE KEY (ne lokalus kelias).
 *
 * DABARTINĖ REALIZACIJA: bendras katalogas (STORAGE_DIR, numatyta ./storage arba
 * Docker volume). Tinka, kai backend ir worker'iai dalinasi tuo pačiu volume
 * (docker-compose). Interfeisas sąmoningai S3/MinIO-suderinamas (put/get/delete
 * pagal raktą), tad 2 etape lengva perjungti į MinIO be routes/worker pakeitimų.
 *
 * ⚠️ Bendras Docker volume tinka MVP/vienai mašinai. Kelioms mašinoms ar tikram
 * horizontaliam skalavimui - MinIO/S3 (2 etapas, FILE-01).
 */

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "..", "storage");

async function _ensureDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

/**
 * Įrašo buferį į storage, grąžina STORAGE KEY (ne lokalų kelią).
 * Raktas: uploads/{uuid}{ext} - unikalus, be kolizijų.
 */
async function put(buffer, { ext = "" } = {}) {
  await _ensureDir();
  const key = `uploads/${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(STORAGE_DIR, key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return key;
}

/**
 * Įrašo TURINĮ NURODYTU raktu (#20 PR2 – atkūrimui).
 *
 * `put()` generuoja naują raktą; atkuriant to negalima – jobo įrašas nurodo
 * KONKRETŲ raktą, ir naujas jį paverstų našlaičiu: failas egzistuotų, bet
 * niekas jo nerastų.
 *
 * ⚠️ Raktas VALIDUOJAMAS: jis ateina iš kopijos failo, tad negali būti
 * pasitikimas. Be patikros `../../etc/passwd` tipo raktas leistų rašyti už
 * saugyklos ribų.
 */
async function putAtKey(key, buffer) {
  await _ensureDir();

  if (typeof key !== "string" || !/^uploads\/[A-Za-z0-9._-]+$/.test(key)) {
    const error = new Error("Netinkamas saugyklos raktas.");
    error.code = "INVALID_STORAGE_KEY";
    throw error;
  }

  const fullPath = path.join(STORAGE_DIR, key);

  // Papildoma apsauga: sunormintas kelias privalo likti saugykloje.
  if (!path.resolve(fullPath).startsWith(path.resolve(STORAGE_DIR))) {
    const error = new Error("Raktas nukreipia už saugyklos ribų.");
    error.code = "INVALID_STORAGE_KEY";
    throw error;
  }

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return key;
}

/**
 * put variantas iš FAILO KELIO (ne buffer'io) - failas nukopijuojamas OS lygmenyje,
 * NEįkeliant viso į Node.js RAM. Būtina dideliems failams (500MB, 4val įrašai): put()
 * su fs.readFile perskaitytų visą failą į atmintį, o keli vienalaikiai įkėlimai
 * lengvai sukeltų OOM. fs.copyFile naudoja OS copy (efektyvu, be user-space buffer'io).
 *
 * PASTABA: dabartinė storage implementacija - lokalus diskas. S3/MinIO atveju čia
 * būtų multipart stream upload (interfeisas suderinamas).
 */
async function putFile(srcPath, { ext = "" } = {}) {
  await _ensureDir();
  const key = `uploads/${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(STORAGE_DIR, key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.copyFile(srcPath, fullPath); // OS-lygmens kopija, be viso failo į RAM
  return key;
}

/**
 * Nuskaito failą pagal storage key -> Buffer. Worker'is tai naudoja audio gauti.
 */
async function get(key) {
  const fullPath = await _resolveExisting(key);

  if (fullPath === null) {
    // Pranešime paliekam ENOENT - tiek `error.code`, tiek tekste, kad
    // iškviečiantis kodas ir logai elgtųsi kaip su įprasta fs klaida.
    const error = new Error(`ENOENT: storage objektas nerastas: ${key}`);
    error.code = "ENOENT";
    throw error;
  }

  return fs.readFile(fullPath);
}

/**
 * Ištrina failą pagal raktą (po apdorojimo ar pagal retention).
 *
 * KLAIDŲ SEMANTIKA (rasta code review): ignoruojamas TIK `ENOENT` - failo nebėra,
 * tad rezultatas jau pasiektas (idempotentiška). VISOS kitos klaidos (EACCES,
 * EROFS, EIO, EPERM...) METAMOS AUKŠTYN. Anksčiau čia buvo `.catch(() => {})`,
 * tad iškviečiantis kodas negalėdavo atskirti "failo nebėra" nuo "failo ištrinti
 * NEPAVYKO" - ir `releaseAudio()` nunulindavo `storageKey`, nors audio likdavo
 * diske. Tai paneigdavo visą "audio tikrai pašalintas" garantiją.
 *
 * @returns {boolean} true - failas realiai ištrintas; false - jo jau nebuvo
 */
async function del(key) {
  const fullPath = await _resolveExisting(key);

  if (fullPath === null) return false;

  try {
    await fs.unlink(fullPath);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Saugus rakto -> kelio konvertavimas (apsauga nuo path traversal `../`).
 *
 * Du pataisyti niuansai:
 *  - STORAGE_DIR normalizuojamas per `path.resolve` ABIEJOSE pusėse. Anksčiau
 *    buvo lyginamas `path.join(...)` (galimai reliatyvus, jei STORAGE_DIR
 *    perduotas kaip reliatyvus env kintamasis) su `path.resolve(...)`.
 *  - ribos tikrinimas su skyrikliu: be jo `/storage-evil` praeidavo `/storage`
 *    patikrą (`startsWith`).
 */
function _resolve(key) {
  const root = path.resolve(STORAGE_DIR);
  const normalized = path.normalize(String(key)).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.resolve(root, normalized);

  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw new Error("Neteisingas storage raktas (path traversal)");
  }

  return fullPath;
}

/**
 * Kaip _resolve(), bet papildomai patikrina REALŲ kelią (`realpath`) - tekstinė
 * patikra neapsaugo nuo simbolinės nuorodos, kuri iš storage katalogo rodo į
 * išorę. Grąžina `null`, jei failo nėra (tada nėra ir ką tikrinti).
 */
async function _resolveExisting(key) {
  const fullPath = _resolve(key);
  const root = path.resolve(STORAGE_DIR);

  let realPath;
  try {
    realPath = await fs.realpath(fullPath);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }

  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch (e) {
    if (e && e.code === "ENOENT") return fullPath;
    throw e;
  }

  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error("Neteisingas storage raktas (symlink už storage katalogo ribų)");
  }

  return realPath;
}

module.exports = { put, putAtKey, putFile, get, del, STORAGE_DIR, _resolve };
