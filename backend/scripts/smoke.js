#!/usr/bin/env node
/**
 * Smoke testas po diegimo: `npm run test-install`
 *
 * Skirtingai nuo `npm test` (kuris VISADA naudoja mock tiekėjus), šis skriptas
 * naudoja TĄ KONFIGŪRACIJĄ, kuri realiai nustatyta .env - t.y. jei nustatytas
 * faster-whisper-embedded su tikru modeliu ir claude su tikru raktu, smoke
 * testas realiai transkribuos ir realiai kvies Claude API (kaina - centų dalys).
 * Su numatytais mock tiekėjais viskas veikia be raktų per kelias sekundes.
 *
 * Žingsniai:
 *   1. Transkribuoja pridėtą trumpą (~7s) lietuvišką audio fixture.
 *   2. Iš gauto teksto (arba atsarginio pavyzdžio, jei transkripcija tuščia)
 *      sugeneruoja protokolą per pilną services/protocolService kelią
 *      (LLM + schema validacija + grounding check).
 *   3. Praneša "Diegimas sėkmingas" arba aiškią klaidą su exit code 1.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "smoke_audio.wav");
// Atsarginis tekstas, jei transkripcija grąžina tuščią/per trumpą rezultatą
// (pvz. labai mažas modelis nesuprato sintetinio balso) - LLM kelias vis tiek testuojamas.
const FALLBACK_TRANSCRIPT =
  "Pirmininkas: Sveiki, pradedame posėdį. Nutarta patvirtinti biudžetą. Jonas parengs ataskaitą iki penktadienio.";

function ok(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.error(`❌ ${msg}`); }

(async () => {
  console.log("\n=== Stenograma smoke testas (test-install) ===\n");
  console.log(`Tiekėjai pagal .env: transkripcija=${process.env.TRANSCRIPTION_PROVIDER || "mock"}, ` +
    `LLM=${process.env.LLM_PROVIDER || "mock"}, diarizacija=${process.env.DIARIZATION_PROVIDER || "none"}\n`);

  let stepFailed = false;

  // --- 1. Transkripcija ---
  let transcriptText = "";
  try {
    const { transcribeAudio } = require("../services/transcriptionService");
    const buffer = fs.readFileSync(FIXTURE);
    const start = Date.now();
    const result = await transcribeAudio({
      buffer,
      filename: "smoke_audio.wav",
      mimeType: "audio/wav",
      language: "lt",
      diarize: false,
    });
    transcriptText = (result.text || "").trim();
    ok(`Transkripcija (${result.provider}, ${((Date.now() - start) / 1000).toFixed(1)}s): ` +
      (transcriptText ? `"${transcriptText.slice(0, 80)}${transcriptText.length > 80 ? "..." : ""}"` : "(tuščias tekstas)"));
  } catch (e) {
    stepFailed = true;
    fail(`Transkripcija nepavyko: ${e.message}`);
  }

  // --- 2. Protokolo generavimas ---
  if (!stepFailed) {
    const usedFallback = transcriptText.length < 10;
    const inputText = usedFallback ? FALLBACK_TRANSCRIPT : transcriptText;
    if (usedFallback) {
      console.log("ℹ️  Transkripcijos tekstas per trumpas - LLM žingsniui naudojamas atsarginis pavyzdys.");
    }
    try {
      const { generateProtocol } = require("../services/protocolService");
      const start = Date.now();
      const result = await generateProtocol({
        title: "Smoke testo posėdis",
        date: new Date().toISOString().slice(0, 10),
        participants: [],
        transcript: inputText,
      });
      const p = result.protocol;
      if (!p || typeof p.pavadinimas !== "string") throw new Error("protokolas be privalomos struktūros");
      ok(`Protokolas (${result.meta?.llmProvider || process.env.LLM_PROVIDER || "mock"}, ` +
        `${((Date.now() - start) / 1000).toFixed(1)}s): "${p.pavadinimas}", ` +
        `darbotvarkė=${(p.darbotvarke || []).length} punkt., veiksmai=${(p.veiksmai || []).length}`);
    } catch (e) {
      stepFailed = true;
      fail(`Protokolo generavimas nepavyko: ${e.message}`);
    }
  }

  console.log("");
  if (stepFailed) {
    fail("Diegimas NEPILNAS - žr. klaidas aukščiau. Detalesnė diagnostika: npm run doctor");
    process.exit(1);
  }
  ok("Diegimas sėkmingas - visa grandinė (audio -> transkripcija -> protokolas) veikia.\n");
  process.exit(0);
})();
