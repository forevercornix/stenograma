#!/usr/bin/env python3
"""
Vienintelė šio skripto atsakomybė: priimti audio failo kelią + parametrus per CLI
argumentus, iškviesti faster-whisper TIESIOGIAI (be jokio HTTP serverio) ir
grąžinti rezultatą kaip vieną JSON eilutę į stdout.

Naudojamas iš Node pusės (providers/transcription/FasterWhisperEmbeddedProvider.js)
per child_process.spawn - tai reiškia VIENAS Python procesas VIENAI transkribavimo
užklausai, ne ilgai gyvenantis serveris. "Desktop" diegimo profiliui tai leidžia
vartotojui apskritai nematyti jokio atskiro serviso ar prievado.

Modelio atsisiuntimas: TAI JAU YRA įdiegta pačioje faster-whisper/huggingface_hub
bibliotekoje - WhisperModel(...) konstruktorius automatiškai patikrina lokalų
cache (~/.cache/huggingface) ir, jei modelio nėra, atsisiunčia jį PATS. Šiam
skriptui NEREIKĖJO papildomai to implementuoti - tai nurodyta čia aiškiai, kad
nebūtų įspūdžio, jog "model manager" yra šio skripto nuopelnas.

SĄŽININGA PASTABA: šis skriptas veikė ir buvo testuotas (žr. tests/
fasterWhisperEmbedded.test.js) su MOCK Python skriptu vietoj tikro faster-whisper,
nes ši aplinka neturi prieigos prie huggingface.co (modelio atsisiuntimas
blokuojamas tinklo apribojimų). Pati subprocess orkestracijos logika (argumentų
perdavimas, JSON parsingas, klaidų apdorojimas) IŠBANDYTA. Realus transkribavimas
su tikru modeliu - IŠBANDYTA (žr. backend README "Realaus audio testas").

PROGRESO PRANEŠIMAI: faster-whisper grąžina segmentus PALAIPSNIUI (generator),
ne visus iš karto - tad po kiekvieno segmento į stderr spausdinama eilutė formatu
`PROGRESS:{"current": <sek>, "total": <sek>}`, kad Node pusė (žr.
FasterWhisperEmbeddedProvider.js) galėtų sekti TIKRĄ apdorojimo progresą (kurią
audio sekundę modelis šiuo metu dekoduoja), ne fiktyvų "kraunasi" indikatorių.
stdout naudojamas TIK galutiniam JSON rezultatui - progresas visada į stderr,
kad neišmaišytų su galutiniu atsakymu.
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="faster-whisper CLI wrapper Stenogramai")
    parser.add_argument("audio_path", help="Kelias iki audio failo")
    parser.add_argument("--model", default="small", help="faster-whisper modelio pavadinimas (tiny/base/small/medium/large-v3)")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="Vykdymo įrenginys")
    parser.add_argument("--compute-type", default="int8", help="Skaičiavimo tikslumas (int8/float16/float32 ir pan.)")
    parser.add_argument("--language", default=None, help="ISO kalbos kodas (pvz. 'lt'); jei nenurodyta, aptinkama automatiškai")
    args = parser.parse_args()

    try:
        # Importuojama TIK čia (ne modulio viršuje), kad --help veiktų greitai
        # net jei faster-whisper dar neįdiegtas (aiškesnė klaida žemiau).
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({
            "error": "faster-whisper Python paketas neįdiegtas. Paleiskite: pip install -r scripts/requirements.txt"
        }), file=sys.stdout)
        sys.exit(1)

    try:
        # WhisperModel PATI patikrina lokalų cache ir, jei reikia, atsisiunčia modelį
        # (huggingface_hub biblioteka viduje) - jokios papildomos logikos čia nereikia.
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments_iter, info = model.transcribe(args.audio_path, language=args.language)

        total_duration = getattr(info, "duration", None)

        segments = []
        full_text_parts = []
        for seg in segments_iter:
            text = seg.text.strip()
            segments.append({"start": seg.start, "end": seg.end, "text": text})
            full_text_parts.append(text)

            # Progreso eilutė - viena per segmentą, flush'inama iš karto, kad
            # Node pusė gautų ją REALIU LAIKU, ne tik po viso proceso pabaigos.
            progress = {"current": seg.end, "total": total_duration}
            print(f"PROGRESS:{json.dumps(progress)}", file=sys.stderr, flush=True)

        result = {
            "text": " ".join(full_text_parts),
            "segments": segments,
            "language": info.language,
            "confidence": getattr(info, "language_probability", None),
        }
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
