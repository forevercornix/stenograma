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

/**
 * M:SS formatas TIKROMS sekundžių reikšmėms.
 *
 * ⚠️ #154: NENAUDOTI su `job.progress` – jo vienetai NĖRA sekundės, o fazei
 * lokalūs darbo vienetai. Anksčiau šis helperis buvo naudojamas būtent ten ir
 * rodė išgalvotą trukmę (`{current: 42, total: 100}` → „00:42 / 01:40").
 */
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
/**
 * Fazių tekstai (#154).
 *
 * ⚠️ Nežinoma fazė NĖRA klaida. Backend gali pridėti naują fazę anksčiau nei
 * frontend'as bus įdiegtas, ir vartotojas tada turi matyti bendrą tekstą, ne
 * tuščią eilutę ar `undefined`.
 */
const PHASE_TEKSTAI = {
  validating: "Tikrinami duomenys",
  transcribing: "Transkribuojama",
  diarizing: "Atliekama diarizacija",
  merging: "Jungiami kalbėtojai su transkripcija",
  generating_protocol: "Generuojamas protokolas",
};

const APDOROJAMA = "Apdorojama";

/**
 * Job progreso tekstas vartotojui.
 *
 * ⚠️ `progress` yra FAZEI LOKALŪS DARBO VIENETAI, ne sekundės (#154).
 *
 * Ankstesnė versija formatavo juos kaip laiką (`formatSecondsToMMSS`), nors
 * backend siunčia procentinę skalę (`{current: 42, total: 100}`) – vartotojas
 * būtų matęs „00:42 / 01:40", t. y. IŠGALVOTĄ trukmę. Realiai tai nepasireiškė
 * tik todėl, kad backend rašė skaičių, o ne objektą, ir sąlyga visada krisdavo
 * į „apdorojama…".
 *
 * UI vienetų NEINTERPRETUOJA – jis skaičiuoja tik santykį.
 *
 * `progressKnown=false` → procentas NErodomas. Ne 0 % ir ne 100 %: abu būtų
 * klaidinantys, o būtent „užstrigęs 100 %" ir buvo #154 pradinė problema.
 */
export function formatTranscribeProgress(job) {
  if (!job) return "";
  if (job.status === "queued") return "eilėje...";
  if (job.status !== "processing") return "";

  const faze = job.phase ? PHASE_TEKSTAI[job.phase] || APDOROJAMA : APDOROJAMA;

  /**
   * ⚠️ `!== true`, ne `!job.progressKnown`.
   *
   * Truthiness patikra praleistų `"false"`, kuris yra TRUTHY. Frontend Redis
   * nemato – jis gauna HTTP JSON, ir backend riba (`normalizeProgressKnown`)
   * tokią reikšmę atmeta. Bet UI neturi kurti SILPNESNĖS to paties kontrakto
   * interpretacijos: jei ta riba kada nors regresuotų, `progressKnown: "false"`
   * duotų „Atliekama diarizacija... 100 %" – būtent tą klaidingą būseną, nuo
   * kurios #154 saugo.
   *
   * Backend riba: FAIL-FAST (meta klaidą). UI riba: FAIL-CLOSED (nerodo
   * procento). Renderinimo metu mesti klaidą būtų blogiau nei parodyti mažiau.
   */
  if (job.progressKnown !== true) return `${faze}...`;

  const { current, total } = job.progress || {};
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return `${faze}...`;
  }

  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  return `${faze}... ${pct} %`;
}
