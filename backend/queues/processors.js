const fileStorage = require("../utils/fileStorage");
const { transcribeAudio } = require("../services/transcriptionService");
const { generateProtocol } = require("../services/protocolService");

/**
 * Job processor'iai - bendras vykdymo kodas inline runner'iui IR BullMQ worker'iams.
 * Kad kodas nesidubliuotų, abu keliai (inline ir queue) naudoja būtent šias funkcijas.
 *
 * SVARBU (#2 storage): transkribavimo processor'ius gauna audio iš BENDRO STORAGE
 * pagal storageKey (ne lokalų /tmp kelią), tad ATSKIRAS worker procesas failą
 * pasiekia. Failas ištrinamas po apdorojimo.
 */

async function transcriptionProcessor(payload, jobId) {
  const {
    storageKey,
    filename,
    mimeType,
    language,
    diarize,
    audioUrl,
    numSpeakers,
    transcriptionProviderOverride,
    diarizationModeOverride,
    meetingId,
  } = payload;

  // Gauname audio iš bendro storage pagal raktą (veikia ir atskirame worker'yje).
  // SVARBU: failo ČIA NETRINAM. Jei transkripcija krenta ir BullMQ bando retry,
  // kitas bandymas vėl turi rasti audio. Trynimą atlieka worker/inline PO GALUTINIO
  // statuso (sėkmė ar išnaudoti bandymai) - žr. jobRunner._runInline ir workers/index.js.
  const buffer = await fileStorage.get(storageKey);
  return await transcribeAudio({
    buffer,
    filename,
    mimeType,
    language: language || "lt",
    diarize: diarize === "true" || diarize === true,
    audioUrl,
    numSpeakers: numSpeakers ? parseInt(numSpeakers, 10) : undefined,
    transcriptionProviderOverride,
    diarizationModeOverride,
    meetingId,
  });
}

async function protocolProcessor(payload) {
  // Protokolo generavimas neturi failo - visas payload jau JSON.
  return generateProtocol(payload);
}

module.exports = { transcriptionProcessor, protocolProcessor };
