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
const DEFAULT_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || "90000", 10);

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

module.exports = { fetchWithTimeout, fetchWithRetry, DEFAULT_TIMEOUT_MS };
