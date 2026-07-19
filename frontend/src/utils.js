// Grynos (pure) pagalbinės funkcijos, ištrauktos iš App.jsx, kad būtų galima
// jas testuoti izoliuotai (Vitest), be React komponento/naršyklės API mock'inimo.

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function formatDateLT(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// Skaičiuoja, kiek % laukų realiai užpildyta (ne "Nenurodyta" / tuščia) — greita pilnumo heuristika.
//
// SVARBI PASTABA (rastas realaus audio testavimo metu - žr. backend/README.md
// "Realaus audio testas"): masyvo laukai (dalyviai/darbotvarke/nutarimai) anksčiau
// buvo skaičiuojami kaip "užpildyti" vien pagal tai, ar masyvas netuščias -
// nepatikrinant TURINIO. Kai LLM (arba senesnė prompt versija) grąžindavo
// `["Nenurodyta"]` vietoj tuščio masyvo `[]`, protokolas be jokio realaus
// nutarimo vis tiek rodydavo aukštą pilnumo procentą - klaidinantis vartotojui.
// Dabar masyvo elementai tikrinami TAIP PAT, kaip scalar laukai.
function isMeaningfulValue(v) {
  if (typeof v !== "string") return true;
  const normalized = v.trim().toLowerCase();
  return normalized !== "" && normalized !== "nenurodyta";
}

export function completeness(protocol) {
  if (!protocol) return 0;
  let total = 0;
  let filled = 0;
  const check = (v) => {
    total++;
    if (Array.isArray(v)) {
      if (v.length > 0 && v.some(isMeaningfulValue)) filled++;
    } else if (typeof v === "string") {
      if (isMeaningfulValue(v)) filled++;
    }
  };
  check(protocol.pavadinimas);
  check(protocol.data);
  check(protocol.dalyviai);
  check(protocol.darbotvarke);
  check(protocol.nutarimai);
  (protocol.veiksmai || []).forEach((v) => {
    ["uzduotis", "atsakingas", "terminas"].forEach((f) => check(v[f]));
  });
  if (total === 0) return 0;
  return Math.round((filled / total) * 100);
}

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// M:SS formatas sekundėms - naudojama transkribavimo progreso rodymui.
export function formatSecondsToMMSS(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Suformuoja žmogui skaitomą progreso eilutę iš /api/transcribe-jobs/:id
// atsakymo. Realus progresas ateina iš faster-whisper-embedded providerio
// (žr. backend FasterWhisperEmbeddedProvider.js) - kiti tiekėjai (mock, HTTP
// tiekėjai) progreso negrąžina, tad tokiu atveju rodomas tik bendras statusas.
export function formatTranscribeProgress(job) {
  if (!job) return "";
  if (job.status === "queued") return "eilėje...";
  if (job.status !== "processing") return "";
  if (!job.progress || job.progress.total == null || job.progress.total <= 0) {
    return "apdorojama...";
  }
  const { current, total } = job.progress;
  const pct = Math.min(100, Math.round((current / total) * 100));
  return `${formatSecondsToMMSS(current)} / ${formatSecondsToMMSS(total)} · ${pct}%`;
}
