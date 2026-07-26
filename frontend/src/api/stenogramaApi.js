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

// --- Health ---
export async function fetchHealth() {
  const res = await fetch(`${BACKEND_URL}/api/health`);
  if (!res.ok) throw new Error(`Health grąžino ${res.status}`);
  return res.json();
}

// --- Protokolo generavimas (SINCHRONINIS /api/generate) ---
export async function generateProtocol({ title, date, participants, transcript }) {
  const res = await fetch(`${BACKEND_URL}/api/generate`, {
    method: "POST",
    headers: withApiKeyHeader({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, date, participants, transcript }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Generavimo klaida");
  return data; // { protocol, meta }
}

// --- Transkribavimas (ASINCHRONINIS /api/transcribe-jobs + polling) ---
// onProgress(job) kviečiamas kiekvieno poll'o metu (komponentas formatuoja tekstą).
// Grąžina galutinį completed job'ą arba meta klaidą.
export async function transcribeAudioJob({ audioFile, diarize, onProgress, pollIntervalMs = 3000, maxPolls = 1200 }) {
  const form = new FormData();
  form.append("audio", audioFile);
  form.append("language", "lt");
  form.append("diarize", String(diarize));

  const createRes = await fetch(`${BACKEND_URL}/api/transcribe-jobs`, {
    method: "POST",
    headers: withApiKeyHeader(),
    body: form,
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error || "Nepavyko pradėti transkribavimo");

  const jobId = createData.jobId;
  let job = createData;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollRes = await fetch(`${BACKEND_URL}/api/transcribe-jobs/${jobId}`, {
      headers: withApiKeyHeader(),
    });
    job = await pollRes.json();
    if (!pollRes.ok) throw new Error(job.error || "Klaida tikrinant transkribavimo būseną");
    if (typeof onProgress === "function") onProgress(job);
    if (job.status === "completed" || job.status === "failed") break;
  }

  if (job.status === "failed") throw new Error(job.error || "Transkribavimas nepavyko");
  if (job.status !== "completed") throw new Error("Transkribavimas užtruko per ilgai (viršyta laukimo riba).");
  return job; // { status: "completed", result: { text, segments } }
}
