const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const TranscriptionProvider = require("./TranscriptionProvider");
const { Semaphore } = require("../../utils/concurrencyLimiter");

// MODULO LYGIO (module-level) semaforas - DALIJAMASI tarp visų providerio
// egzempliorių tame pačiame procese, nes routes/transcribe.js sukuria naują
// `new FasterWhisperEmbeddedProvider()` KIEKVIENAI užklausai (žr.
// providers/transcription/index.js getTranscriptionProvider()). Jei semaforas
// būtų kuriamas konstruktoriuje (per-instance), jis neribotų nieko, nes kiekviena
// užklausa turėtų savo atskirą semaforą su savo skaitliuku.
const sharedSemaphore = new Semaphore(parseInt(process.env.FASTER_WHISPER_MAX_CONCURRENCY || "2", 10));

/**
 * PAVADINIMO TIKSLUMAS: "Embedded" čia reiškia "be atskiro HTTP serviso/prievado
 * vartotojui", NE "vieno OS proceso prasme" - techniškai tai vis tiek yra:
 *
 *   Node.js → spawn Python subprocess → faster-whisper
 *
 * t.y. PRIKLAUSOMA nuo Python runtime, veikianti kaip atskiras procesas per
 * kiekvieną užklausą (ne bendras long-running Python procesas su Node). Jei
 * pavadinimas klaidina, tikslesni alternatyvūs pavadinimai būtų
 * `LocalFasterWhisperProvider` arba `SubprocessFasterWhisperProvider` - šis
 * projektas pasiliko prie `FasterWhisperEmbeddedProvider`/`faster-whisper-embedded`,
 * nes tai jau paviešintas config raktas (žr. .env.example, README), o pervadinimas
 * dabar reikštų breaking change be realios naudos - bet terminologija ČIA
 * (docstring'e) yra tikslus paaiškinimas, ką tiksliai reiškia "embedded".
 *
 * STATUS: Node<->Python subprocess orkestracija IŠBANDYTA (žr.
 * tests/fasterWhisperEmbedded.test.js su mock Python skriptu). Realus
 * transkribavimas su tikru faster-whisper modeliu - IŠBANDYTA (žr. backend
 * README "Realaus audio testas" - `tiny` ir `small` modeliai, tikras 4 val.
 * lietuviškas posėdžio įrašas).
 *
 * "Desktop" diegimo profilis: sekretorės/vartotojo kompiuteryje NĖRA jokio
 * atskiro HTTP serverio ar prievado, kurį reikėtų paleisti/stebėti -
 * providerio transcribe() metodas tiesiog paleidžia VIENĄ trumpalaikį Python
 * procesą per užklausą (scripts/faster_whisper_transcribe.py), kuris pats
 * kviečia faster-whisper Python biblioteką. Modelio atsisiuntimas (jei
 * lokaliai dar nėra) vyksta AUTOMATIŠKAI PAČIOJE faster-whisper/huggingface_hub
 * bibliotekoje pirmo iškvietimo metu - šis providerio kodas to neimplementuoja
 * papildomai, tik perduoda parametrus.
 *
 * PROGRESAS (realiai patikrinta): faster-whisper grąžina segmentus PALAIPSNIUI,
 * ne visus iš karto - scripts/faster_whisper_transcribe.py po kiekvieno
 * segmento spausdina `PROGRESS:{...}` eilutę į stderr. Šis providerio klasė
 * skaito stderr REALIU LAIKU (ne po viso proceso pabaigos) ir, jei perduotas
 * `options.onProgress` callback, iškviečia jį su `{current, total}` (sekundėmis).
 * Naudojama iš routes/transcribeJobs.js, kad GET /api/transcribe-jobs/:id
 * galėtų grąžinti TIKRĄ apdorojimo progresą, ne fiktyvų sukimąsi.
 *
 * Kontrastas su FasterWhisperProvider.js ("server" profilis, žr. tą failą):
 * ten tikimasi ATSKIRAI paleisto, ilgai gyvenančio HTTP serviso (naudinga
 * bendram įmonės serveriui su daug vienalaikių vartotojų ir/ar GPU, kur
 * modelis norima laikyti įkeltą atmintyje tarp užklausų, o ne krauti iš naujo
 * kiekvienam subprocess). Abu implementuoja TĄ PATĮ TranscriptionProvider
 * kontraktą - likusi sistema (routes/transcribe.js) nežino ir nesirūpina,
 * kuris iš jų naudojamas.
 */
class FasterWhisperEmbeddedProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.pythonBin = config.pythonBin || process.env.FASTER_WHISPER_PYTHON_BIN || "python3";
    this.scriptPath = config.scriptPath || path.join(__dirname, "..", "..", "scripts", "faster_whisper_transcribe.py");
    this.model = config.model || process.env.FASTER_WHISPER_MODEL || "small";
    // PASTABA (patikrinta realiai): `this.model` gali būti IR standartinis HF
    // modelio pavadinimas ("tiny"/"small"/...), IR kelias iki lokaliai jau
    // atsisiųsto CTranslate2 modelio katalogo (pvz. "/home/user/faster-whisper-tiny")
    // - abu atvejus WhisperModel(...) apdoroja tą patį, be kodo pakeitimų.
    this.device = config.device || process.env.FASTER_WHISPER_DEVICE || "cpu";
    this.computeType = config.computeType || process.env.FASTER_WHISPER_COMPUTE_TYPE || "int8";
    // Kiek laiko leidžiame Python procesui dirbti - pirmas paleidimas gali
    // reikšti modelio atsisiuntimą (gali užtrukti minutes), todėl numatytasis
    // timeout čia gerokai didesnis nei bendras API_TIMEOUT_MS (tai VIETINIS
    // procesas, ne tinklo kvietimas - resursų sunaudojimo rizika kitokia).
    this.timeoutMs = config.timeoutMs || parseInt(process.env.FASTER_WHISPER_EMBEDDED_TIMEOUT_MS || "600000", 10);
  }

  async transcribe(audioBuffer, options = {}) {
    const tempPath = path.join(os.tmpdir(), `stenograma-embedded-${crypto.randomUUID()}${this._guessExtension(options)}`);
    await fs.writeFile(tempPath, audioBuffer);

    // Laukiame eilėje, jei jau vyksta FASTER_WHISPER_MAX_CONCURRENCY subprocess'ų -
    // apsauga nuo CPU/RAM prisotinimo (saturation), jei keli vartotojai vienu metu
    // transkribuoja lokaliai (žr. utils/concurrencyLimiter.js).
    await sharedSemaphore.acquire();
    try {
      const result = await this._runPython(tempPath, options);
      if (result.error) {
        throw new Error(`FasterWhisperEmbeddedProvider (Python): ${result.error}`);
      }
      return {
        text: result.text || "",
        segments: (result.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: null })),
        language: result.language || options.language || "lt",
        confidence: result.confidence ?? null,
        diarization: false, // faster-whisper pats diarizacijos nemoka - žr. providers/diarization/
        provider: "faster-whisper-embedded",
      };
    } finally {
      sharedSemaphore.release();
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  /**
   * GPU (device=cuda) reikalauja LD_LIBRARY_PATH nukreipto į pip įdiegtas
   * nvidia-cublas-cu12/nvidia-cudnn-cu12 bibliotekas (žr. scripts/requirements.txt
   * komentarą ir oficialią faster-whisper dokumentaciją). Vietoj to, kad
   * vartotojas turėtų pats rankomis `export LD_LIBRARY_PATH=...` prieš paleisdamas
   * backend'ą, apskaičiuojame tai AUTOMATIŠKAI čia, kai device === "cuda".
   *
   * STATUS: ši logika NETESTUOTA su realiu GPU šioje aplinkoje (nėra CUDA prieigos
   * sandbox'e) - patikrinkite lokaliai prieš pasikliaudami. Jei automatinis
   * nustatymas nepavyktų, vis tiek galite nustatyti LD_LIBRARY_PATH rankomis prieš
   * paleisdami `npm start` - tuomet šis automatinis žingsnis tiesiog nieko nekeis
   * (papildomo kelio pridėjimas prie jau nustatyto nepakenkia).
   */
  async _resolveCudaLibraryPath() {
    if (this._cudaLibPathCache !== undefined) return this._cudaLibPathCache;
    try {
      const { execFile } = require("child_process");
      const output = await new Promise((resolve, reject) => {
        execFile(
          this.pythonBin,
          ["-c", "import os,nvidia.cublas.lib,nvidia.cudnn.lib as c2;print(os.path.dirname(nvidia.cublas.lib.__file__)+':'+os.path.dirname(c2.__file__))"],
          { timeout: 15000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        );
      });
      this._cudaLibPathCache = output || null;
    } catch {
      // nvidia-cublas-cu12/nvidia-cudnn-cu12 galbūt neįdiegti arba device=cpu
      // naudojamas ir taip - tai NĖRA klaida, tiesiog automatinis nustatymas negalimas.
      this._cudaLibPathCache = null;
    }
    return this._cudaLibPathCache;
  }

  _guessExtension(options) {
    if (options.filename) {
      const ext = path.extname(options.filename);
      if (ext) return ext;
    }
    return ".audio";
  }

  async _runPython(audioPath, options) {
    const args = [
      this.scriptPath,
      audioPath,
      "--model", this.model,
      "--device", this.device,
      "--compute-type", this.computeType,
    ];
    if (options.language) args.push("--language", options.language);

    const env = { ...process.env };
    if (this.device === "cuda") {
      const cudaLibPath = await this._resolveCudaLibraryPath();
      if (cudaLibPath) {
        env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${cudaLibPath}:${env.LD_LIBRARY_PATH}` : cudaLibPath;
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonBin, args, { env });

      let stdout = "";
      let stderr = "";
      let stderrLineBuffer = ""; // dalinės (nebaigtos) eilutės tarp duomenų blokų
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`FasterWhisperEmbeddedProvider: Python procesas viršijo ${this.timeoutMs}ms limitą.`));
      }, this.timeoutMs);

      proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;

        // PROGRESAS: skriptas spausdina `PROGRESS:{...}` eilutes į stderr REALIU
        // LAIKU (po kiekvieno segmento). Čia jas išparsiname IŠ KARTO, kai jos
        // ateina (galimai ateis dalimis - tad buferiuojame iki paskutinio \n).
        if (typeof options.onProgress === "function") {
          stderrLineBuffer += text;
          const lines = stderrLineBuffer.split("\n");
          stderrLineBuffer = lines.pop(); // paskutinė (galimai nebaigta) eilutė lieka buferyje
          for (const line of lines) {
            if (line.startsWith("PROGRESS:")) {
              try {
                const progress = JSON.parse(line.slice("PROGRESS:".length));
                options.onProgress(progress);
              } catch {
                // nepavykus išparsinti progreso eilutės - nekritinga, tiesiog praleidžiama
              }
            }
          }
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `FasterWhisperEmbeddedProvider: nepavyko paleisti "${this.pythonBin}" (${err.message}). Ar Python įdiegtas ir pasiekiamas PATH?`
          )
        );
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && !stdout.trim()) {
          return reject(
            new Error(`FasterWhisperEmbeddedProvider: Python procesas baigėsi klaidos kodu ${code}. stderr: ${stderr.slice(0, 500)}`)
          );
        }
        try {
          const lastLine = stdout.trim().split("\n").pop(); // ignoruojame galimus stray print'us prieš JSON
          resolve(JSON.parse(lastLine));
        } catch (e) {
          reject(new Error(`FasterWhisperEmbeddedProvider: nepavyko išparsinti Python atsakymo kaip JSON: ${e.message}. stdout: ${stdout.slice(0, 500)}`));
        }
      });
    });
  }
}

module.exports = FasterWhisperEmbeddedProvider;
