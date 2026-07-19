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
 * Nuskaito failą pagal storage key -> Buffer. Worker'is tai naudoja audio gauti.
 */
async function get(key) {
  const fullPath = _resolve(key);
  return fs.readFile(fullPath);
}

/**
 * Ištrina failą pagal raktą (po apdorojimo ar pagal retention). Idempotentinis -
 * nesamo failo trynimas neklaida.
 */
async function del(key) {
  const fullPath = _resolve(key);
  await fs.unlink(fullPath).catch(() => {});
}

/**
 * Saugus rakto -> kelio konvertavimas (apsauga nuo path traversal ../).
 */
function _resolve(key) {
  const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.join(STORAGE_DIR, normalized);
  if (!fullPath.startsWith(path.resolve(STORAGE_DIR))) {
    throw new Error("Neteisingas storage raktas (path traversal)");
  }
  return fullPath;
}

module.exports = { put, get, del, STORAGE_DIR };
