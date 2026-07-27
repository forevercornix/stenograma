# 🎉 Stenograma v1.0.0 — Pirmas stabilus leidimas

Produkcijai orientuota architektūra AI pagalbiniam susitikimų transkribavimui ir
protokolų generavimui: **garsas → transkripcija → struktūruotas protokolas**.

Šis leidimas įtvirtina patikimumą per išsamų kodo įvertinimą ir daugybę pataisymų.

## Funkcijos

- Asinchroniniai transkribavimo jobai (202 + polling)
- BullMQ + Redis eilė su inline fallback
- Lokalus faster-whisper tiekėjas (embedded / server)
- Konfigūruojami LLM tiekėjai (Claude / GPT / Gemini / mock)
- Pasirenkama kalbėtojų diarizacija (pyannote)
- Health & readiness endpointai
- Docker diegimas (demo / cpu / gpu / server / runpod profiliai)
- Provider architektūra (tiekėjai keičiami per `.env`, ne kodą)
- Automatinis temp failų valymas
- Progreso rodymas
- Išsamus testų rinkinys

## Patikimumo pagerinimai

- Startavimo race condition uždaryta (init prieš `listen`)
- jobStore/jobRunner režimo nuoseklumas (be memory + BullMQ maišymo)
- Worker paleidimo apsauga (atsisako startuoti su memory store)
- Readiness + worker heartbeat (readiness nebemeluoja)
- Saugus abort (controller-identity, listener valymas)
- Klaidų apdorojimas (ne-JSON / sugadintas JSON metami, ne tyli sėkmė)
- Failo validacija prieš storage (magic bytes, streaming putFile)
- Orphan valymas (audio + jobo būsena)

## Testai

- Backend unit + route (~160)
- Frontend unit + API (~40)
- Playwright E2E (6, Chromium)
- Python kontraktų testai (pyannote + whisper)
- Docker build + smoke

Visi žali CI'e.

## Sąžiningi apribojimai

GPU keliai (CUDA/Torch su `device=cuda`), BullMQ restart recovery su tikru Redis ir
worker heartbeat srautas per tikrą Redis — logika parašyta ir unit/statiškai patikrinta,
bet ne visi paleisti kūrimo aplinkoje. Žr. `DEPLOYMENT_CHECKLIST.md` prieš production.

---

Tai pirmas stabilus viešas leidimas.
