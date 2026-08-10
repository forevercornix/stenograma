# 🎉 Stenograma v1.0.0 — Pirmas stabilus leidimas

Produkcijai orientuota architektūra AI pagalbiniam susitikimų transkribavimui ir
protokolų generavimui: **garsas → transkripcija → struktūruotas protokolas**.

## Highlights

- Asinchroniniai transkribavimo jobai (BullMQ + Redis, su inline fallback)
- Konfigūruojama provider architektūra (transkribavimo ir LLM tiekėjai per `.env`)
- Lokalus faster-whisper palaikymas
- Pasirenkama kalbėtojų diarizacija (pyannote)
- Docker diegimas (demo / cpu / gpu / server / runpod profiliai)
- Health & readiness endpointai
- Išsamus automatinių testų rinkinys (backend, frontend, E2E, Python, Docker)

Šis leidimas įtvirtina patikimumą per išsamų kodo auditą: startavimo race condition,
worker inicializacija, klaidų apdorojimas, failo validacija ir konkurencinių užklausų
sauga.

Pilnas pataisymų sąrašas — [`CHANGELOG.md`](./CHANGELOG.md).
Prieš production diegimą — [`DEPLOYMENT_CHECKLIST.md`](./DEPLOYMENT_CHECKLIST.md).

---

Tai pirmas stabilus viešas leidimas.
