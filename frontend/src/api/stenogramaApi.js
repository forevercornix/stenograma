// Stenograma backend API sluoksnis - GRYNOS HTTP funkcijos, iškeltos iš App.jsx.
// Jokio React state čia: funkcijos grąžina duomenis arba meta klaidą, o komponentas
// pats valdo state. Progresas perduodamas per callback'us (onProgress), ne setState.
//
// URL/rakto konfigūracija (buvo App.jsx viršuje):
//  1) SANTYKINIS URL (Docker/produkcija): VITE_BACKEND_URL="" -> fetch naudoja "/api/..."
//     ta pati kilmė kaip frontend (reikia reverse proxy).
//  2) ABSOLIUTUS URL (dev): VITE_BACKEND_URL=http://localhost:3001.
//  Jei VITE_BACKEND_URL neapibrėžtas -> dev režime localhost:3001.
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL !== undefined
    ? import.meta.env.VITE_BACKEND_URL
    : import.meta.env.PROD
      ? "" // produkcijos build be aiškaus URL -> santykinis /api (nginx proxy)
      : "http://localhost:3001"; // dev -> tiesioginis backend'as

// VITE_API_KEY: BENDRAS diegimo sekretas, NE galutinio vartotojo autentifikacija.
// Raktas patenka į viešą JS bundle - tinka tik patikimam tinklui (VPN/intranet).
// Žr. DEPLOYMENT_CHECKLIST.md.
const API_KEY = import.meta.env.VITE_API_KEY || "";

export function withApiKeyHeader(headers = {}) {
  return API_KEY ? { ...headers, "x-api-key": API_KEY } : headers;
}

// Saugus atsakymo skaitymas: jei reverse proxy grąžina HTML/tekstą (pvz. 502 Bad
// Gateway), res.json() mestų "Unexpected token '<'" vietoj informatyvios klaidos.
// Šis helperis tikrina content-type ir grąžina prasmingą žinutę.
async function readJsonResponse(res, fallbackMessage) {
  const contentType = res.headers.get("content-type") || "";
  // Priimam ir application/json, ir +json variantus (pvz. application/problem+json -
  // RFC 7807 klaidų formatas). Nuosavas Express backend'as grąžina application/json,
  // bet +json palaikymas apsaugo, jei prieš jį atsirastų proxy/gateway su tokiu formatu.
  const isJson = contentType.includes("application/json") || contentType.includes("+json");

  // Visi šio API SĖKMINGI atsakymai yra JSON. Ne-JSON atsakymas (net su 200 OK) reiškia,
  // kad kažkas ne taip - dažniausiai reverse proxy grąžino HTML (login page, 502 Bad
  // Gateway). Metam klaidą, NE grąžinam {error: html} kaip duomenis (kitaip res.ok=true
  // atveju būtų "sėkmė" su data.protocol=undefined - simetriška sugadinto JSON klaidai).
  if (!isJson) {
    const text = await res.text().catch(() => "");
    const hasBody = Boolean(text); // tik nustatom, ar body netuščias (viso HTML NEišvedam)
    const detail = hasBody ? ": serveris grąžino ne JSON atsakymą" : "";
    throw new Error(`${fallbackMessage} (${res.status})${detail}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    // JSON content-type, bet body tuščias/sugadintas (proxy nutraukė ryšį, dalinis
    // atsakymas). Metam iš karto - kitaip res.ok=true atveju būtų grąžinta kaip sėkmė.
    throw new Error(`${fallbackMessage} (${res.status}): neteisingas JSON atsakymas`);
  }

  if (!res.ok) {
    throw new Error(data?.error || `${fallbackMessage} (${res.status})`);
  }
  return data;
}

// --- Health (LIVENESS - procesas gyvas) ---
export async function fetchHealth() {
  const res = await fetch(`${BACKEND_URL}/api/health`);
  return readJsonResponse(res, "Health nepasiekiamas");
}

// --- Readiness (job store + runner PARUOŠTI) ---
// Naudokite ŠITĄ prieš leidžiant vartotojui pradėti darbą (ne /api/health): health yra
// liveness (procesas gyvas), o /api/ready grąžina 200 tik kai job sistema tikrai paruošta.
export async function fetchReadiness() {
  const res = await fetch(`${BACKEND_URL}/api/ready`);
  return readJsonResponse(res, "Backend dar neparuoštas");
}

// --- Protokolo generavimas (SINCHRONINIS /api/generate) ---
export async function generateProtocol({ title, date, participants, transcript }, { signal } = {}) {
  const res = await fetch(`${BACKEND_URL}/api/generate`, {
    method: "POST",
    headers: withApiKeyHeader({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, date, participants, transcript }),
    signal,
  });
  return readJsonResponse(res, "Generavimo klaida"); // { protocol, meta }
}

// Atšaukiamas delay: setTimeout, kurį galima nutraukti per AbortSignal (kad polling
// laukimas irgi reaguotų į reset/unmount, ne tik fetch). SVARBU: listeneris pašalinamas
// IR po normalaus timeout, IR po abort - kitaip ilgam polling'ui (iki 1200 ciklų) prie
// vieno signalo susikauptų iki 1200 listenerių (atminties nutekėjimas).
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort); // normalus timeout - šalinam listenerį
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Transkribavimas (ASINCHRONINIS /api/transcribe-jobs + polling) ---
// onProgress(job) kviečiamas kiekvieno poll'o metu. signal (AbortSignal) nutraukia IR
// fetch, IR laukimą tarp poll'ų - būtina, kad reset/naujas failas/unmount sustabdytų
// senąjį polling'ą (kitaip senas rezultatas perrašytų naują UI būseną).
export async function transcribeAudioJob({
  audioFile,
  diarize,
  onProgress,
  signal,
  pollIntervalMs = 3000,
  maxPolls = 1200,
}) {
  const form = new FormData();
  form.append("audio", audioFile);
  form.append("language", "lt");
  form.append("diarize", String(diarize));

  const createRes = await fetch(`${BACKEND_URL}/api/transcribe-jobs`, {
    method: "POST",
    headers: withApiKeyHeader(),
    body: form,
    signal,
  });
  const createData = await readJsonResponse(createRes, "Nepavyko pradėti transkribavimo");

  const jobId = createData.jobId;
  let job = createData;

  for (let i = 0; i < maxPolls; i++) {
    await delay(pollIntervalMs, signal); // atšaukiamas laukimas
    const pollRes = await fetch(`${BACKEND_URL}/api/transcribe-jobs/${jobId}`, {
      headers: withApiKeyHeader(),
      signal,
    });
    job = await readJsonResponse(pollRes, "Klaida tikrinant transkribavimo būseną");
    if (typeof onProgress === "function") onProgress(job);
    if (job.status === "completed" || job.status === "failed") break;
  }

  if (job.status === "failed") throw new Error(job.error || "Transkribavimas nepavyko");
  if (job.status !== "completed") throw new Error("Transkribavimas užtruko per ilgai (viršyta laukimo riba).");
  return job; // { status: "completed", result: { text, segments } }
}
