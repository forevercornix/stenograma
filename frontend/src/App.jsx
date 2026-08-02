import React, { useState, useRef, useEffect } from "react";
import {
  Mic,
  Square,
  Upload,
  ClipboardPaste,
  Sparkles,
  Download,
  RotateCcw,
  FileAudio,
  X,
  Plus,
  AlertCircle,
  Pencil,
  FileSpreadsheet,
  FileType,
  Info,
  Server,
} from "lucide-react";
// HTTP API sluoksnis iškeltas į api/stenogramaApi.js (grynos fetch funkcijos, be React
// state). BACKEND_URL/API_KEY konfigūracija ir jos paaiškinimai - ten. Žr. tą failą dėl
// dviejų deployment režimų (santykinis/absoliutus URL) ir VITE_API_KEY prigimties.
import {
  BACKEND_URL,
  fetchHealth,
  fetchReadiness,
  generateProtocol,
  transcribeAudioJob,
  exportProtocol,
} from "./api/stenogramaApi";


const INK = "#1B2A41";
const PAPER = "#F7F5F0";
const LINE = "#E4DFD3";
const BRASS = "#9C7A34";
const REDINK = "#A83A2E";
const SLATE = "#5B6472";
const GREEN = "#3D6B4A";

import { todayISO, formatDateLT, completeness, formatTranscribeProgress } from "./utils.js";

export default function Stenograma() {
  const [mode, setMode] = useState("record");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayISO());
  const [participants, setParticipants] = useState([]);
  const [participantInput, setParticipantInput] = useState("");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  // recognition.onend yra priskiriamas VIENĄ kartą per startRecording() kvietimą ir
  // niekad nebepriskiriamas iš naujo - jei jo viduje tikrintume tiesiog `isRecording`
  // state kintamąjį, jis "įšaltų" (stale closure) su reikšme, kokia buvo TĄ konkretų
  // render'ą (praktiškai visada `false`, nes onend sukuriamas PRIEŠ setIsRecording(true)
  // pritaikymą). Ref atnaujinamas SINCHRONIŠKAI kartu su state, tad onend visada mato
  // TIKRĄ, dabartinę reikšmę.
  const isRecordingRef = useRef(false);
  const [audioFileName, setAudioFileName] = useState("");
  const [audioURL, setAudioURL] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [diarize, setDiarize] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeProgress, setTranscribeProgress] = useState("");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");

  // Transkribavimo jobId - perduodamas eksporto auditui, kad EXPORT_* įvykiai
  // būtų susieti su tuo pačiu pseudonimu kaip transkripcija.
  const [transcriptionJobId, setTranscriptionJobId] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState("");
  const [protocol, setProtocol] = useState(null);
  const [levels, setLevels] = useState([4, 4, 4, 4, 4, 4, 4, 4]);
  const [stamped, setStamped] = useState(false);
  const [meta, setMeta] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [backendStatus, setBackendStatus] = useState("checking"); // checking | online | offline
  const [backendInfo, setBackendInfo] = useState(null);

  const recognitionRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const transcribeAbortRef = useRef(null); // AbortController transkribavimo polling'ui

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) setSpeechSupported(false);
  }, []);
  useEffect(() => () => {
    stopRecording();
    // Unmount: TIK abort (ne cancelTranscription, nes setState po unmount negalima).
    // Identiteto patikra handleAutoTranscribe finally užtikrina, kad senas rezultatas
    // neįrašomas.
    transcribeAbortRef.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Kiekvieną kartą pasikeitus audioURL (naujas failas arba reset), atlaisviname
  // PREVIOUS blob URL - be šito naršyklė laikytų senus audio duomenis atmintyje
  // visą sesijos laiką (memory leak augantis su kiekvienu naujai įkeltu failu).
  useEffect(() => {
    return () => {
      if (audioURL) URL.revokeObjectURL(audioURL);
    };
  }, [audioURL]);

  useEffect(() => {
    let cancelled = false;
    // "online" reikalauja READINESS (job sistema paruošta), ne vien liveness. health
    // naudojam tik info parodymui (koks tiekėjas). Taip vartotojas negali pradėti darbo,
    // kol job store/runner dar neinicijuoti (žr. /api/ready backend'e).
    Promise.all([
      fetchReadiness(),
      fetchHealth().catch(() => null), // info neprivaloma - jei krinta, tik nerodom detalių
    ])
      .then(([, healthData]) => {
        if (cancelled) return;
        setBackendStatus("online");
        if (healthData) setBackendInfo(healthData);
      })
      .catch(() => {
        if (!cancelled) setBackendStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addParticipant = () => {
    const name = participantInput.trim();
    if (name && !participants.includes(name)) setParticipants([...participants, name]);
    setParticipantInput("");
  };
  const removeParticipant = (name) => setParticipants(participants.filter((p) => p !== name));

  const drawLevels = () => {
    if (!analyserRef.current) return;
    const analyser = analyserRef.current;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const bars = 8;
    const step = Math.floor(data.length / bars);
    const next = [];
    for (let i = 0; i < bars; i++) next.push(Math.max(4, Math.round(((data[i * step] || 0) / 255) * 28)));
    setLevels(next);
    rafRef.current = requestAnimationFrame(drawLevels);
  };

  const startRecording = async () => {
    setError("");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return setSpeechSupported(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;
      drawLevels();
    } catch (e) {
      setError("Nepavyko pasiekti mikrofono. Patikrinkite naršyklės leidimus.");
      return;
    }
    const recognition = new SR();
    recognition.lang = "lt-LT";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalChunk += res[0].transcript + " ";
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) setTranscript((prev) => (prev + " " + finalChunk).trim());
      setInterim(interimChunk);
    };
    recognition.onerror = (e) => {
      if (e.error === "no-speech") return;
      setError("Balso atpažinimo klaida: " + e.error);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition && isRecordingRef.current) {
        try {
          recognition.start();
        } catch (_) {}
      }
    };
    recognitionRef.current = recognition;
    recognition.start();
    isRecordingRef.current = true;
    setIsRecording(true);
  };

  const stopRecording = () => {
    isRecordingRef.current = false;
    setIsRecording(false);
    setInterim("");
    if (recognitionRef.current) {
      const r = recognitionRef.current;
      recognitionRef.current = null;
      try {
        r.onend = null;
        r.stop();
      } catch (_) {}
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setLevels([4, 4, 4, 4, 4, 4, 4, 4]);
  };

  // Centralizuotas transkribavimo nutraukimas + būsenos valymas. Naudojamas visur, kur
  // reikia nutraukti vykstantį polling'ą: naujas failas, reset, unmount. Vienoje vietoje -
  // kad nesidubliuotų ir nebūtų praleista (reviewer pastaba: naujas failas nenutraukdavo).
  const cancelTranscription = () => {
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    setIsTranscribing(false);
    setTranscribeProgress("");
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Naujas failas nutraukia seno failo transkribavimą (kitaip A rezultatas įrašytų
    // tekstą, nors UI jau rodo B failą).
    cancelTranscription();
    setAudioFileName(file.name);
    setAudioFile(file);
    setAudioURL(URL.createObjectURL(file));
  };

  // Naudoja ASINCHRONINĮ /api/transcribe-jobs + polling, NE sinchroninį
  // /api/transcribe. Tai BŪTINA (ne tik gera praktika), kai backend'as pasiekiamas
  // per HTTP proxy su savo trumpu timeout limitu (pvz. RunPod HTTP proxy = kietas
  // 100s limitas, nepriklausomas nuo backend'o nustatymų) - ilgas/GPU transkribavimas
  // per sinchroninį kelią tokiu atveju niekada negrąžintų atsakymo laiku.
  const handleAutoTranscribe = async () => {
    if (!audioFile) return;
    // Nutraukiam ankstesnį polling'ą (jei buvo) - kad senas rezultatas neperrašytų naujo.
    transcribeAbortRef.current?.abort();
    const controller = new AbortController();
    transcribeAbortRef.current = controller;

    setIsTranscribing(true);
    setError("");
    setTranscribeProgress("");
    try {
      // HTTP + polling logika iškelta į transcribeAudioJob. Komponentas valdo TIK state:
      // progresą (onProgress callback -> setTranscribeProgress) ir galutinį rezultatą.
      const job = await transcribeAudioJob({
        audioFile,
        diarize,
        signal: controller.signal,
        onProgress: (j) => {
          // Progresą rašom TIK jei šis controlleris vis dar aktyvus (ne senas).
          if (transcribeAbortRef.current === controller) setTranscribeProgress(formatTranscribeProgress(j));
        },
      });

      // CONTROLLER IDENTITY: jei tuo tarpu prasidėjo naujas transkribavimas (arba reset/
      // naujas failas nutraukė šį), transcribeAbortRef neberodo į mūsų controllerį - tad
      // NErašom seno rezultato į naują būseną. Abort paprastai to neleistų, bet identiteto
      // patikra apsaugo nuo VISŲ vėlyvų rezultatų (ne tik abort'intų).
      if (transcribeAbortRef.current !== controller) return;

      setTranscriptionJobId(job.jobId || null);

      const data = job.result;
      const text = data.segments?.length
        ? data.segments.map((s) => `${s.speaker ? s.speaker + ": " : ""}${s.text}`).join("\n")
        : data.text;
      setTranscript(text);
    } catch (e) {
      // AbortError - vartotojas sąmoningai nutraukė (reset/naujas failas), ne klaida.
      // Klaidą rodom tik jei šis controlleris dar aktyvus (senos užklausos klaida
      // neturi perrašyti naujos būsenos).
      if (e.name !== "AbortError" && transcribeAbortRef.current === controller) {
        setError("Automatinis transkribavimas nepavyko: " + e.message);
      }
    } finally {
      // Būseną valo TIK dabartinis controlleris - senas (jau nutrauktas) NEliečia naujo
      // transkribavimo state (kitaip A.finally išvalytų B progresą ir rodytų "baigta").
      if (transcribeAbortRef.current === controller) {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
        setTranscribeProgress("");
      }
    }
  };

  const canGenerate = transcript.trim().length > 20 && !isGenerating && backendStatus === "online";

  const handleGenerate = async () => {
    setError("");
    setIsGenerating(true);
    setStamped(false);
    try {
      const data = await generateProtocol({
        title,
        date: formatDateLT(date),
        participants,
        transcript,
      });
      setProtocol(data.protocol);
      setMeta({ source: "backend", ...data.meta });
      setTimeout(() => setStamped(true), 200);
    } catch (e) {
      setError("Nepavyko sugeneruoti protokolo: " + e.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReset = () => {
    cancelTranscription(); // nutraukiam vykstantį transkribavimo polling'ą + valom būseną
    stopRecording();
    setTitle("");
    setDate(todayISO());
    setParticipants([]);
    setParticipantInput("");
    setTranscript("");
    setInterim("");
    setAudioFileName("");
    setAudioURL("");
    setAudioFile(null);
    setProtocol(null);
    setMeta(null);
    setStamped(false);
    setError("");
    // Naujas darbas - senas jobId nebeturi būti siejamas su nauju eksportu.
    setTranscriptionJobId(null);
    setExportError("");
  };

  // ── Protokolo redagavimo pagalbinės funkcijos ──
  const updateField = (field, value) => setProtocol((p) => ({ ...p, [field]: value }));
  const updateListLine = (field, index, value) => {
    const arr = [...(protocol[field] || [])];
    arr[index] = value;
    updateField(field, arr);
  };
  const addListLine = (field) => updateField(field, [...(protocol[field] || []), ""]);
  const removeListLine = (field, index) => updateField(field, (protocol[field] || []).filter((_, i) => i !== index));

  const updateKlausimas = (index, key, value) => {
    const arr = [...(protocol.aptarti_klausimai || [])];
    arr[index] = { ...arr[index], [key]: value };
    updateField("aptarti_klausimai", arr);
  };
  const addKlausimas = () =>
    updateField("aptarti_klausimai", [...(protocol.aptarti_klausimai || []), { klausimas: "", santrauka: "" }]);
  const removeKlausimas = (index) =>
    updateField("aptarti_klausimai", (protocol.aptarti_klausimai || []).filter((_, i) => i !== index));

  const updateVeiksmas = (index, key, value) => {
    const arr = [...(protocol.veiksmai || [])];
    arr[index] = { ...arr[index], [key]: value };
    updateField("veiksmai", arr);
  };
  const addVeiksmas = () =>
    updateField("veiksmai", [...(protocol.veiksmai || []), { uzduotis: "", atsakingas: "", terminas: "" }]);
  const removeVeiksmas = (index) => updateField("veiksmai", (protocol.veiksmai || []).filter((_, i) => i !== index));

  // ── Eksportai ──
  // Failus generuoja BACKEND (POST /api/exports), ne naršyklė. Priežastis - GDPR
  // audito reikalavimas: kol .txt/.csv/.docx buvo kuriami čia, serveris apie
  // eksportą nieko nežinojo, tad EXPORT_* įvykių audito žurnale negalėjo būti.
  // Kliento "pranešiau, kad eksportavau" įrašu audite pasitikėti negalima.

  /**
   * EKSPORTAS SU EKSPLICITINIU VARIANTU (GDPR #8).
   *
   * Variantas PRIVALOMAS ir be numatytosios reikšmės.
   *
   * Numatytoji `redacted` atrodytų kaip saugiklis, bet UI ją visada perduoda,
   * tad ji niekada nebūtų vykdoma - netestuojamas saugiklis yra tik įspūdis.
   * Jei kada nors atsirastų kvietimas be varianto, `exportProtocol` mes aiškią
   * klaidą, o ne tyliai pasirinks už vartotoją.
   *
   * Saugesnis kelias vis tiek yra numatytasis VIZUALIAI: redaguota grupė rodoma
   * pirma. Originalas reikalauja atskiro veiksmo IR patvirtinimo - ne dėl to,
   * kad draudžiamas, o dėl to, kad jį dažniausiai pasirenka netyčia, o klaida
   * pastebima tik tada, kai failas jau išsiųstas.
   */
  const runExport = async (format, variant) => {
    if (!protocol || exporting) return;

    if (variant === "original") {
      const confirmed = window.confirm(
        "Eksportuojate NEREDAGUOTĄ protokolą.\n\n" +
          "Faile liks asmens kodai, el. paštai, telefonai ir sąskaitų numeriai, " +
          "jei jie buvo transkripcijoje.\n\nTęsti?"
      );
      if (!confirmed) return;
    }

    setExporting(`${variant}:${format}`);
    setExportError("");

    try {
      const { blob, filename } = await exportProtocol({ format, variant, protocol, jobId: transcriptionJobId });
      saveBlob(blob, filename);
    } catch (e) {
      setExportError(e.message || "Eksportas nepavyko.");
    } finally {
      setExporting(null);
    }
  };

  const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const score = completeness(protocol);

  return (
    <div style={{ background: PAPER, fontFamily: "'IBM Plex Sans', sans-serif", color: INK }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500;8..60,600;8..60,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .serif { font-family: 'Source Serif 4', Georgia, serif; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        @keyframes pulseRec { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        @keyframes stampIn {
          0% { transform: scale(2.2) rotate(-14deg); opacity: 0; }
          60% { transform: scale(0.92) rotate(-8deg); opacity: 1; }
          80% { transform: scale(1.04) rotate(-10deg); }
          100% { transform: scale(1) rotate(-8deg); opacity: 1; }
        }
        .stamp-in { animation: stampIn 0.5s cubic-bezier(.2,.8,.3,1.1) forwards; }
        .paper-lines { background-image: repeating-linear-gradient(to bottom, transparent, transparent 30px, ${LINE} 30px, ${LINE} 31px); }
        .editline { background: transparent; border: none; border-bottom: 1px dashed ${LINE}; outline: none; width: 100%; padding: 2px 0; }
        .editline:focus { border-bottom: 1px solid ${BRASS}; }
        ::selection { background: ${BRASS}33; }
      `}</style>

      <header className="border-b" style={{ borderColor: LINE }}>
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <p className="mono text-[11px] tracking-[0.2em] uppercase flex items-center gap-2" style={{ color: SLATE }}>
              Susitikimų protokolų generatorius
              <span
                className="mono text-[9px] px-1.5 py-0.5 rounded-xs flex items-center gap-1"
                style={{
                  background: backendStatus === "online" ? "#E9F2EA" : backendStatus === "offline" ? "#FBEDEA" : "#F1EADD",
                  color: backendStatus === "online" ? GREEN : backendStatus === "offline" ? REDINK : BRASS,
                }}
              >
                <Server size={10} />
                {backendStatus === "checking" && "Jungiamasi prie backend..."}
                {backendStatus === "online" &&
                  (backendInfo?.llmProvider
                    ? `Backend aktyvus (${backendInfo.llmProvider} / ${backendInfo.transcriptionProvider} / diarizacija: ${backendInfo.diarizationProvider})`
                    : "Backend aktyvus")}
                {backendStatus === "offline" && "Backend nepasiekiamas"}
              </span>
            </p>
            <h1 className="serif text-3xl font-semibold tracking-tight">Stenograma</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAudit((s) => !s)}
              className="flex items-center gap-1.5 text-sm mono px-3 py-1.5 rounded-xs border hover:bg-black/[0.03] transition-colors"
              style={{ borderColor: LINE, color: SLATE }}
            >
              <Info size={13} /> Audit
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 text-sm mono px-3 py-1.5 rounded-xs border hover:bg-black/[0.03] transition-colors"
              style={{ borderColor: LINE, color: SLATE }}
            >
              <RotateCcw size={13} /> Naujas protokolas
            </button>
          </div>
        </div>

        {backendStatus === "offline" && (
          <div className="max-w-6xl mx-auto px-6 pb-4">
            <div role="alert" className="flex gap-2 text-sm p-3 rounded-xs" style={{ background: "#FBEDEA", color: REDINK }}>
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>
                Backend'as ({BACKEND_URL || "santykinis /api"}) nepasiekiamas. Paleiskite jį: <code>cd backend && npm install && npm start</code>.
                Šis frontend'as sąmoningai nekviečia jokio LLM tiesiai iš naršyklės — be backend'o protokolo
                sugeneruoti negalima.
              </span>
            </div>
          </div>
        )}

        {showAudit && (
          <div className="max-w-6xl mx-auto px-6 pb-4">
            <div className="text-xs mono p-3 rounded-xs" style={{ background: "#FCFBF8", border: `1px solid ${LINE}`, color: SLATE }}>
              {meta ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>promptVersion: <b style={{ color: INK }}>{meta.promptVersion}</b></div>
                  <div>llmProvider: <b style={{ color: INK }}>{meta.llmProvider}</b></div>
                  <div>repair bandymai: <b style={{ color: INK }}>{meta.jsonRepairAttempts ?? 0}</b></div>
                  <div>trukmė: <b style={{ color: INK }}>{meta.processingTimeMs} ms</b></div>
                  <div>input tokens: <b style={{ color: INK }}>{meta.usage?.inputTokens ?? "—"}</b></div>
                  <div>output tokens: <b style={{ color: INK }}>{meta.usage?.outputTokens ?? "—"}</b></div>
                  <div>apytikslė kaina: <b style={{ color: INK }}>{meta.estimatedCostUsd != null ? `$${meta.estimatedCostUsd}` : "—"}</b></div>
                  <div>šaltinis: <b style={{ color: INK }}>backend</b></div>
                </div>
              ) : (
                <span>Audit informacija (be pilno log'o — tam žr. backend GET /api/audit) pasirodys čia po protokolo sugeneravimo.</span>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-5 gap-8">
        <section className="lg:col-span-2 space-y-6">
          <div className="space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Susitikimo pavadinimas"
              className="w-full serif text-lg font-medium bg-transparent border-b pb-2 outline-hidden placeholder:text-[#9a9488] focus:border-b-2"
              style={{ borderColor: LINE }}
            />
            <div className="flex items-center gap-3">
              <label className="mono text-xs uppercase tracking-wide" style={{ color: SLATE }}>Data</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mono text-sm bg-transparent border-b pb-1 outline-hidden" style={{ borderColor: LINE }} />
            </div>
            <div>
              <label className="mono text-xs uppercase tracking-wide block mb-1.5" style={{ color: SLATE }}>Dalyviai (nebūtina)</label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {participants.map((p) => (
                  <span key={p} className="mono text-xs px-2 py-1 rounded-xs flex items-center gap-1" style={{ background: "#EFEADF", border: `1px solid ${LINE}` }}>
                    {p}
                    <X size={11} className="cursor-pointer" onClick={() => removeParticipant(p)} />
                  </span>
                ))}
              </div>
              <div className="flex gap-1.5">
                <input
                  value={participantInput}
                  onChange={(e) => setParticipantInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addParticipant())}
                  placeholder="Vardas ir paspauskite Enter"
                  className="flex-1 text-sm bg-transparent border-b pb-1 outline-hidden placeholder:text-[#9a9488]"
                  style={{ borderColor: LINE }}
                />
                <button onClick={addParticipant} className="p-1.5 rounded-xs border hover:bg-black/[0.03]" style={{ borderColor: LINE }} aria-label="Pridėti dalyvį">
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex gap-1 border-b" style={{ borderColor: LINE }}>
            {[
              { id: "record", label: "Įrašyti gyvai", icon: Mic },
              { id: "upload", label: "Įkelti failą", icon: Upload },
              { id: "paste", label: "Įklijuoti tekstą", icon: ClipboardPaste },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setMode(t.id)}
                className="flex items-center gap-1.5 mono text-xs uppercase tracking-wide px-3 py-2.5 -mb-px border-b-2 transition-colors"
                style={{ borderColor: mode === t.id ? BRASS : "transparent", color: mode === t.id ? INK : SLATE }}
              >
                <t.icon size={13} /> {t.label}
              </button>
            ))}
          </div>

          <div className="min-h-[220px]">
            {mode === "record" && (
              <div className="space-y-4">
                {!speechSupported ? (
                  <div className="flex gap-2 text-sm p-3 rounded-xs" style={{ background: "#FBEDEA", color: REDINK }}>
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <span>Jūsų naršyklė nepalaiko balso atpažinimo. Naudokite Chrome/Edge arba „Įklijuoti tekstą".</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={isRecording ? stopRecording : startRecording}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xs text-sm font-medium transition-colors"
                        style={{ background: isRecording ? REDINK : INK, color: PAPER }}
                      >
                        {isRecording ? <Square size={14} /> : <Mic size={14} />}
                        {isRecording ? "Stabdyti įrašymą" : "Pradėti įrašymą"}
                      </button>
                      {isRecording && (
                        <div className="flex items-end gap-[3px] h-7">
                          {levels.map((l, i) => (
                            <div key={i} style={{ width: 3, height: l, background: REDINK, borderRadius: 1, transition: "height 0.08s linear" }} />
                          ))}
                        </div>
                      )}
                      {isRecording && (
                        <span className="mono text-xs flex items-center gap-1.5" style={{ color: REDINK }}>
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: REDINK, display: "inline-block", animation: "pulseRec 1.2s ease-in-out infinite" }} />
                          ĮRAŠOMA
                        </span>
                      )}
                    </div>
                    <div className="text-sm p-3 rounded-xs min-h-[110px] leading-relaxed" style={{ background: "#FCFBF8", border: `1px solid ${LINE}` }}>
                      {transcript || <span style={{ color: "#B3ACA0" }}>Kalbėkite — tekstas rodysis čia realiu laiku…</span>}
                      {interim && <span style={{ color: SLATE }}> {interim}</span>}
                    </div>
                  </>
                )}
              </div>
            )}

            {mode === "upload" && (
              <div className="space-y-4">
                <label className="flex flex-col items-center justify-center gap-2 py-8 rounded-xs border-2 border-dashed cursor-pointer hover:bg-black/[0.02] transition-colors" style={{ borderColor: LINE }}>
                  <FileAudio size={22} style={{ color: SLATE }} />
                  <span className="text-sm" style={{ color: SLATE }}>{audioFileName || "Pasirinkite garso arba video failą (garsas bus ištrauktas)"}</span>
                  <input type="file" accept="audio/*,video/mp4,video/webm,.mp4,.webm" className="hidden" onChange={handleFileUpload} />
                </label>
                {audioURL && <audio controls src={audioURL} className="w-full" style={{ height: 36 }} />}

                <label className="flex items-center gap-2 text-sm" style={{ color: SLATE }}>
                  <input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} />
                  Atskirti kalbėtojus (diarizacija), jei tiekėjas palaiko
                </label>
                <button
                  onClick={handleAutoTranscribe}
                  disabled={!audioFile || isTranscribing || backendStatus !== "online"}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xs text-sm font-medium"
                  style={{ background: INK, color: PAPER, opacity: !audioFile || isTranscribing || backendStatus !== "online" ? 0.4 : 1 }}
                >
                  {isTranscribing ? `Transkribuojama${transcribeProgress ? ` (${transcribeProgress})` : "…"}` : "Transkribuoti automatiškai"}
                </button>
                {backendInfo?.transcriptionProvider === "mock" && (
                  <p className="text-xs" style={{ color: SLATE }}>
                    Backend šiuo metu naudoja <code>mock</code> transkribavimo tiekėją — grąžins pavyzdinį (ne jūsų failo)
                    tekstą. Realiam rezultatui nustatykite <code>TRANSCRIPTION_PROVIDER=whisper</code> (ar kitą) backend'o
                    <code>.env</code> faile.
                  </p>
                )}
                {backendInfo?.diarizationProvider && (
                  <p className="text-xs" style={{ color: SLATE }}>
                    Kalbėtojų atskyrimas: <code>{backendInfo.diarizationProvider}</code> — tai atskiras nuo transkribavimo
                    komponentas (<code>DIARIZATION_PROVIDER</code> backend'o <code>.env</code>), veikiantis nepriklausomai
                    nuo pasirinkto transkribavimo tiekėjo (pvz. Whisper transkripcija + pyannote diarizacija).
                  </p>
                )}
                <textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder="Transkripcija (galite naudoti formatą „Vardas: tekstas” geresniam rezultatui) arba paspauskite „Transkribuoti automatiškai” aukščiau…"
                  className="w-full text-sm p-3 rounded-xs min-h-[140px] leading-relaxed outline-hidden resize-y"
                  style={{ background: "#FCFBF8", border: `1px solid ${LINE}` }}
                />
              </div>
            )}

            {mode === "paste" && (
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="Įklijuokite susitikimo transkripciją (formatas „Vardas: tekstas” padeda tiksliau nustatyti dalyvius)…"
                className="w-full text-sm p-3 rounded-xs min-h-[220px] leading-relaxed outline-hidden resize-y"
                style={{ background: "#FCFBF8", border: `1px solid ${LINE}` }}
              />
            )}
          </div>

          {error && (
            <div className="flex gap-2 text-sm p-3 rounded-xs" style={{ background: "#FBEDEA", color: REDINK }}>
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xs text-sm font-medium transition-opacity"
            style={{ background: INK, color: PAPER, opacity: canGenerate ? 1 : 0.4, cursor: canGenerate ? "pointer" : "not-allowed" }}
            title={backendStatus !== "online" ? "Backend nepasiekiamas" : undefined}
          >
            <Sparkles size={15} />
            {isGenerating ? "Generuojama…" : "Generuoti protokolą"}
          </button>
          {backendInfo?.llmProvider === "mock" && (
            <p className="text-xs -mt-4" style={{ color: SLATE }}>
              Backend šiuo metu naudoja <code>mock</code> LLM tiekėją — protokolas sudaromas paprastomis heuristikomis
              (ne tikru LLM), bet iš JŪSŲ realiai įvestos transkripcijos. Realiam LLM rezultatui nustatykite
              <code>LLM_PROVIDER=claude</code> (ar kitą) backend'o <code>.env</code> faile.
            </p>
          )}
        </section>

        <section className="lg:col-span-3">
          <div className="relative rounded-xs shadow-xs paper-lines" style={{ background: "#FEFEFC", border: `1px solid ${LINE}`, minHeight: 560, padding: "40px 44px" }}>
            {!protocol && !isGenerating && (
              <div className="h-full flex flex-col items-center justify-center text-center py-24">
                <p className="serif text-lg" style={{ color: "#B3ACA0" }}>Dokumentas dar neparengtas</p>
                <p className="text-sm mt-1" style={{ color: "#C4BEB2" }}>Užpildykite duomenis kairėje ir paspauskite „Generuoti protokolą"</p>
              </div>
            )}

            {isGenerating && (
              <div className="h-full flex flex-col items-center justify-center py-24">
                <div className="mono text-xs tracking-widest uppercase" style={{ color: SLATE, animation: "pulseRec 1.4s ease-in-out infinite" }}>
                  Rengiamas protokolas…
                </div>
              </div>
            )}

            {protocol && !isGenerating && (
              <div className="relative">
                {stamped && (
                  <div
                    className="stamp-in absolute -top-2 right-0 select-none"
                    style={{ width: 92, height: 92, borderRadius: 999, border: `3px solid ${BRASS}`, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", transform: "rotate(-8deg)" }}
                  >
                    <span className="mono text-[10px] font-medium tracking-wider leading-tight">PARENGTA<br />AI</span>
                  </div>
                )}

                <div className="flex items-center justify-between pr-24">
                  <p className="mono text-[11px] tracking-[0.2em] uppercase" style={{ color: SLATE }}>Protokolas</p>
                  <span
                    className="mono text-[10px] px-2 py-0.5 rounded-xs"
                    title="Kiek laukų realiai užpildyta (ne 'Nenurodyta')"
                    style={{ background: score >= 70 ? "#E9F2EA" : "#FBEDEA", color: score >= 70 ? GREEN : REDINK }}
                  >
                    Pilnumas {score}%
                  </span>
                </div>

                <input
                  className="editline serif text-2xl font-semibold mt-1"
                  value={protocol.pavadinimas || ""}
                  onChange={(e) => updateField("pavadinimas", e.target.value)}
                />
                <input
                  className="editline mono text-sm mt-1"
                  style={{ color: SLATE, maxWidth: 200 }}
                  value={protocol.data || ""}
                  onChange={(e) => updateField("data", e.target.value)}
                />

                <div className="mt-6">
                  <h3 className="mono text-xs uppercase tracking-wide mb-2" style={{ color: BRASS }}>Dalyviai</h3>
                  <input
                    className="editline text-sm"
                    value={(protocol.dalyviai || []).join(", ")}
                    onChange={(e) => updateField("dalyviai", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                  />
                </div>

                <EditableList title="Darbotvarkė" items={protocol.darbotvarke || []} onChange={(i, v) => updateListLine("darbotvarke", i, v)} onAdd={() => addListLine("darbotvarke")} onRemove={(i) => removeListLine("darbotvarke", i)} ordered />

                <div className="mt-6">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="mono text-xs uppercase tracking-wide" style={{ color: BRASS }}>Aptarti klausimai</h3>
                    <button onClick={addKlausimas} className="text-xs flex items-center gap-1" style={{ color: SLATE }}><Plus size={12} /> pridėti</button>
                  </div>
                  <div className="space-y-3">
                    {(protocol.aptarti_klausimai || []).map((k, i) => (
                      <div key={i} className="group flex gap-2">
                        <div className="flex-1">
                          <input className="editline text-sm font-medium" value={k.klausimas} onChange={(e) => updateKlausimas(i, "klausimas", e.target.value)} placeholder="Klausimas" />
                          <textarea className="editline text-sm mt-1 resize-none" style={{ color: SLATE }} rows={2} value={k.santrauka} onChange={(e) => updateKlausimas(i, "santrauka", e.target.value)} placeholder="Santrauka" />
                        </div>
                        <button onClick={() => removeKlausimas(i)} className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: SLATE }}><X size={14} /></button>
                      </div>
                    ))}
                    {!(protocol.aptarti_klausimai || []).length && <p className="text-sm" style={{ color: SLATE }}>Nenurodyta</p>}
                  </div>
                </div>

                <EditableList title="Nutarimai" items={protocol.nutarimai || []} onChange={(i, v) => updateListLine("nutarimai", i, v)} onAdd={() => addListLine("nutarimai")} onRemove={(i) => removeListLine("nutarimai", i)} ordered />

                <div className="mt-6 mb-2">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="mono text-xs uppercase tracking-wide flex items-center gap-1.5" style={{ color: BRASS }}>
                      Veiksmai
                      {meta?.grounding?.unverifiedActionsCount > 0 && (
                        <span
                          className="mono text-[9px] normal-case px-1.5 py-0.5 rounded-xs"
                          style={{ background: "#FBEDEA", color: REDINK }}
                          title="Šie veiksmai turi žemą leksinį persidengimą su transkripcija (grounding check) - peržiūrėkite prieš pasitikėdami"
                        >
                          {meta.grounding.unverifiedActionsCount}/{meta.grounding.totalActionsCount} nepatvirtinta
                        </span>
                      )}
                    </h3>
                    <button onClick={addVeiksmas} className="text-xs flex items-center gap-1" style={{ color: SLATE }}><Plus size={12} /> pridėti</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b" style={{ borderColor: LINE }}>
                        <th className="mono text-[10px] uppercase font-medium pb-1.5" style={{ color: SLATE }}>Užduotis</th>
                        <th className="mono text-[10px] uppercase font-medium pb-1.5" style={{ color: SLATE }}>Atsakingas</th>
                        <th className="mono text-[10px] uppercase font-medium pb-1.5" style={{ color: SLATE }}>Terminas</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(protocol.veiksmai || []).map((v, i) => (
                        <tr key={i} className="group border-b" style={{ borderColor: LINE }}>
                          <td className="py-1.5 pr-3">
                            <div className="flex items-center gap-1.5">
                              {v._grounding && !v._grounding.verified && (
                                <span title={`Žemas leksinis persidengimas su transkripcija (${Math.round(v._grounding.overlapRatio * 100)}%) - peržiūrėkite`}>
                                  <AlertCircle size={13} style={{ color: REDINK, flexShrink: 0 }} />
                                </span>
                              )}
                              <input className="editline" value={v.uzduotis} onChange={(e) => updateVeiksmas(i, "uzduotis", e.target.value)} />
                            </div>
                          </td>
                          <td className="py-1.5 pr-3"><input className="editline" value={v.atsakingas} onChange={(e) => updateVeiksmas(i, "atsakingas", e.target.value)} /></td>
                          <td className="py-1.5 pr-3"><input className="editline mono" value={v.terminas} onChange={(e) => updateVeiksmas(i, "terminas", e.target.value)} /></td>
                          <td><button onClick={() => removeVeiksmas(i)} className="opacity-0 group-hover:opacity-100" style={{ color: SLATE }}><X size={13} /></button></td>
                        </tr>
                      ))}
                      {!(protocol.veiksmai || []).length && (
                        <tr><td colSpan={4} className="py-1.5 text-sm" style={{ color: SLATE }}>Nenurodyta</td></tr>
                      )}
                    </tbody>
                  </table>
                  {meta?.grounding?.unverifiedActionsCount > 0 && (
                    <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: SLATE }}>
                      <AlertCircle size={11} /> Transcript grounding check (leksinis persidengimas, ne semantinis fact-checking) - peržiūrėkite pažymėtus veiksmus prieš eksportuojant.
                    </p>
                  )}
                </div>

                <p className="text-xs flex items-center gap-1.5 mt-4" style={{ color: SLATE }}>
                  <Pencil size={11} /> Visi laukai redaguojami — spustelėkite ir taisykite prieš eksportuojant.
                </p>
              </div>
            )}
          </div>

          {protocol && !isGenerating && (
            <div className="mt-4">
              {/*
                REDAGUOTAS - numatytasis kelias, pirmas sąraše.

                Grupė turi `role="group"` su pavadinimu, o mygtukų tekstas lieka
                nepakeistas. Alternatyva būtų `aria-label` ant kiekvieno mygtuko,
                bet ji PERRAŠO prieinamą vardą - o nuo jo priklauso ir Playwright
                E2E selektoriai (`getByRole("button", { name: "Word (.docx)" })`).
                Grupė duoda kontekstą nesugriaudama vardų.
              */}
              <p id="export-redacted-label" className="mono text-xs uppercase tracking-wide mb-2" style={{ color: SLATE }}>
                Redaguotas (jautrūs identifikatoriai pašalinti)
              </p>
              {/*
                Etiketė SĄMONINGAI nesako „be asmens duomenų".

                Pagal #4 aprėptį vardai lieka, adresai neaptinkami, o žodžiais
                padiktuoti identifikatoriai gali praslysti. „Be asmens duomenų"
                paskatintų vartotoją persiųsti dokumentą kaip anoniminį - o jis
                toks nėra. Tikslesnis pažadas apsaugo geriau nei griežtesnis
                filtras, kurio nėra.
              */}
              <p className="text-xs mb-2" style={{ color: SLATE }}>
                Pašalinti asmens kodai, el. paštai, telefonai ir sąskaitų numeriai.
                Vardai, adresai ir kiti netiesioginiai identifikatoriai gali likti.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="export-redacted-label">
                {[
                  ["txt", ".txt", Download],
                  ["docx", "Word (.docx)", FileType],
                  ["csv", "Veiksmai .csv", FileSpreadsheet],
                ].map(([format, label, Icon]) => (
                  <button
                    key={`redacted-${format}`}
                    onClick={() => runExport(format, "redacted")}
                    disabled={Boolean(exporting)}
                    className="flex items-center gap-2 mono text-xs uppercase tracking-wide px-4 py-2 rounded-xs border hover:bg-black/[0.03] disabled:opacity-50"
                    style={{ borderColor: LINE, color: SLATE }}
                  >
                    <Icon size={13} /> {exporting === `redacted:${format}` ? "Ruošiama…" : label}
                  </button>
                ))}
              </div>

              {/* ORIGINALAS - atskiras veiksmas su įspėjimu; patvirtinimas runExport viduje. */}
              <p id="export-original-label" className="mono text-xs uppercase tracking-wide mt-4 mb-2" style={{ color: REDINK }}>
                Originalas (visi duomenys)
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="export-original-label">
                {[
                  ["txt", ".txt", Download],
                  ["docx", "Word (.docx)", FileType],
                  ["csv", "Veiksmai .csv", FileSpreadsheet],
                ].map(([format, label, Icon]) => (
                  <button
                    key={`original-${format}`}
                    onClick={() => runExport(format, "original")}
                    disabled={Boolean(exporting)}
                    className="flex items-center gap-2 mono text-xs uppercase tracking-wide px-4 py-2 rounded-xs border hover:bg-black/[0.03] disabled:opacity-50"
                    style={{ borderColor: REDINK, color: REDINK }}
                  >
                    <Icon size={13} /> {exporting === `original:${format}` ? "Ruošiama…" : label}
                  </button>
                ))}
              </div>

              {exportError && (
                <p role="alert" className="mt-2 text-xs" style={{ color: REDINK }}>
                  {exportError}
                </p>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function EditableList({ title, items, onChange, onAdd, onRemove, ordered }) {
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="mono text-xs uppercase tracking-wide" style={{ color: BRASS }}>{title}</h3>
        <button onClick={onAdd} className="text-xs flex items-center gap-1" style={{ color: SLATE }}><Plus size={12} /> pridėti</button>
      </div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="group flex items-center gap-2">
            {ordered && <span className="mono text-xs" style={{ color: SLATE }}>{i + 1}.</span>}
            <input className="editline text-sm flex-1" value={item} onChange={(e) => onChange(i, e.target.value)} />
            <button onClick={() => onRemove(i)} className="opacity-0 group-hover:opacity-100" style={{ color: SLATE }}><X size={13} /></button>
          </div>
        ))}
        {!items.length && <p className="text-sm" style={{ color: SLATE }}>Nenurodyta</p>}
      </div>
    </div>
  );
}
