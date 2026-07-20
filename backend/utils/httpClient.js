/**
 * Visi išoriniai API kvietimai (Claude/OpenAI/Deepgram/Azure/Google/pyannote/...)
 * eina per šį wrapperį, kad:
 *   1) niekada neliktų "pakibę" be galo (AbortController timeout);
 *   2) trumpalaikės tinklo klaidos ar 5xx atsakymai turėtų vieną automatinį pakartojimą.
 *
 * 4xx atsakymai NIEKADA nekartojami (klientas suklydo, kartojimas nepadės).
 *
 * PRIKLAUSOMYBIŲ PASTABA: naudojamas TIK Node embedded `fetch` (globalus nuo
 * Node 18+, o šis projektas reikalauja Node 20+ - žr. package.json "engines").
 * `node-fetch` npm paketas anksčiau buvo naudojamas kaip fallback, bet tai buvo
 * negyvas kodas (Node 20 visada turi global.fetch) - pašalintas iš
 * priklausomybių, kad nereikėtų palaikyti/audituoti papildomo HTTP stack'o.
 */
/**
 * NUMATYTAS timeout. Anksčiau buvo 90s - RASTA REALIAI DIEGIANT (RunPod, 4 val. įrašas):
 * diarizacija/transkripcija ilgiems failams trunka daug ilgiau nei 90s, todėl backend
 * nutraukdavo laukimą KLAIDINGAI, nors pyannote/Whisper realiai užbaigdavo darbą
 * (matėsi "POST /diarize 200 OK" JAU PO timeout'o). Numatytas pakeltas iki 5 min, o
 * ilgiems audio failams naudojamas PROPORCINGAS timeout (žr. timeoutForAudioBytes).
 * Perrašoma per API_TIMEOUT_MS (bendras) ir AUDIO_TIMEOUT_* (proporcingam skaičiavimui).
 */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || "300000", 10);

// Proporcingas timeout audio apdorojimui (transkripcija/diarizacija per HTTP).
// Ilgesnis failas = ilgesnis leidžiamas apdorojimo laikas. Skaičiuojama iš audio
// baitų dydžio (WAV 16kHz mono 16-bit ≈ 32000 baitų/s), su apatine ir viršutine riba.
const AUDIO_TIMEOUT_MIN_MS = parseInt(process.env.AUDIO_TIMEOUT_MIN_MS || "300000", 10); // >=5 min
const AUDIO_TIMEOUT_MAX_MS = parseInt(process.env.AUDIO_TIMEOUT_MAX_MS || "5400000", 10); // <=90 min
// Kiek apdorojimo ms skiriama vienai audio sekundei (konservatyvu: apima ir lėtą
// pyannote diarizaciją ilgiems failams). Perrašoma per AUDIO_TIMEOUT_MS_PER_SEC.
const AUDIO_TIMEOUT_MS_PER_AUDIO_SEC = parseInt(process.env.AUDIO_TIMEOUT_MS_PER_SEC || "4000", 10);
const WAV_BYTES_PER_SEC = 32000; // 16kHz * 1 kanalas * 2 baitai (apytiksliai; MP3 mažesnis, tad timeout bus konservatyvesnis)

/**
 * Apskaičiuoja proporcingą timeout pagal audio buferio dydį baitais.
 * Grąžina reikšmę tarp AUDIO_TIMEOUT_MIN_MS ir AUDIO_TIMEOUT_MAX_MS.
 * Jei API_TIMEOUT_MS nustatytas eksplicitiškai (env), jis turi pirmenybę (grąžinamas jis).
 */
function timeoutForAudioBytes(byteLength) {
  if (process.env.API_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS; // eksplicitiškas override gerbiamas
  if (!byteLength || byteLength <= 0) return AUDIO_TIMEOUT_MIN_MS;
  const approxSeconds = byteLength / WAV_BYTES_PER_SEC;
  const proportional = Math.round(approxSeconds * AUDIO_TIMEOUT_MS_PER_AUDIO_SEC);
  return Math.min(AUDIO_TIMEOUT_MAX_MS, Math.max(AUDIO_TIMEOUT_MIN_MS, proportional));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Užklausa į ${new URL(url).hostname} viršijo ${timeoutMs}ms limitą (timeout).`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, retryDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok || res.status < 500) return res; // 4xx - nekartojame, klaida jau galutinė
      lastError = new Error(`HTTP ${res.status} iš ${new URL(url).hostname}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

module.exports = { fetchWithTimeout, fetchWithRetry, timeoutForAudioBytes, DEFAULT_TIMEOUT_MS };
