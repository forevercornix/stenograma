# Pakeitimų istorija

Projekto raidos milestone'ai. Formatas grubiai pagal [Keep a Changelog](https://keepachangelog.com/).

---

## Unreleased

Neišleisti pokyčiai, jau esantys `main` šakoje. Artimiausio `release:` commit'o
metu ši sekcija **suliejama** į naujos versijos sekciją ir ištuštinama – kitaip
ji pasensta ir tampa klaidinanti.

### ⚠️ Destruktyvūs pokyčiai

- **Audito retencija dabar galioja ir PostgreSQL režimui** (#213, 7.4d).
  `AUDIT_RETENTION_DAYS` anksčiau veikė tik atminties žurnalui; nuo šio leidimo
  centralizuotas sweep'as **fiziškai šalina** senesnes `audit_log` eilutes,
  ribotais batch'ais, o riba imama iš DB laikrodžio.

  ⚠️ **Pirmas ciklas paleidžiamas ~5 s po starto ir pašalina viską, kas jau
  viršija terminą — per kelias minutes ir negrįžtamai.** Diegimas, kuriame
  reikšmė buvo nustatyta tuomet, kai ji galiojo tik atminčiai, praras senus
  audito įrašus be atskiro patvirtinimo.

  Prieš atnaujinant: pasitikrinkite `AUDIT_RETENTION_DAYS` (numatyta 30 d.) ir,
  jei senesni įrašai reikalingi, pasidarykite pilną PostgreSQL kopiją —
  aplikacijos kopija audito eilučių neapima. Žr.
  `docs/operations/OPERATIONAL_PROCEDURES.md` §3 ir `docs/backup-runbook.md`.

- **`PRIVACY_MODE=true` su `AUDIT_BACKEND=postgres` nebenutraukia starto**
  (#213, 7.4d). Derinys leidžiamas: starto metu `audit_log` fiziškai išvaloma, o
  nauji įrašai nepersistinami.

  ⚠️ Vėliavos perjungimui reikia **pilno sustabdymo, ne rolling update** —
  senesnė replika gali įrašyti eilutę po to, kai naujoji jau išvalė lentelę.

### Changed

- ⚠️ **`DELETE` atsakymų rinkinys prasiplėtė: 202 ir `tombstone_unresolved`**
  (#183, 7.5a). Abu jobų endpoint'ai (`/api/jobs/:id`, `/api/transcribe-jobs/:id`):

  | Situacija | Anksčiau | Dabar |
  |---|---|---|
  | Ištrynimą jau vykdo kitas procesas ar replika | 204 arba 404 po pakartoto darbo | **202** `in_progress`, jokio darbo nepradedama |
  | Žyma `deletion_failed` | 204 (klaidingai – žyma likdavo `failed`) | **503** `tombstone_unresolved` |
  | Patvirtintai ištrinta | 204 | 204 (nepakito) |

  ⚠️ **Klientai, laikę 204 vieninteliu sėkmės kodu, turi priimti ir 202.** 202
  reiškia „ištrynimas vyksta, pakartokite vėliau", ne klaidą.

  ⚠️ **`deletion_failed` nebekartojamas automatiškai.** Naują bandymą autorizuoja
  operatorius: `node backend/scripts/erasure-marks.js retry <jobId>`. Kietai
  nužudytas procesas gali palikti `deletion_pending` žymą, kuriai visi vėlesni
  `DELETE` atsakys 202 – žr. `docs/deletion-guarantees.md`.

- **Našlaičių 503 atsakyme nebėra klaidų tekstų** (#183). Anksčiau siųstas visas
  `outcome`, įskaitant `errors` su failų keliais ir eilės raktais (#19 tai
  draudžia). Klientas gauna tik tai, kas pašalinta; savininko kelias šios
  taisyklės laikėsi visada.

- **Našlaičių valymas nuo šiol palieka ištrynimo žymą ir yra fail-closed**
  (#183, 7.5a). `adminCleanupOrphan()` ir `desktopCleanupOrphan()` anksčiau
  šalino likusius pėdsakus **nepalikdami barjero** – atkūrimas iš senesnės
  kopijos tą `jobId` vėl priimdavo. Dabar žyma (`reason=orphan_cleanup`)
  rašoma **prieš** šalinimą.

  ⚠️ **Operacinė pasekmė:** jei žymos įrašyti nepavyksta (DB nepasiekiama),
  valymas **atmetamas su klaida**, o ne atliekamas tyliai. Anksčiau ta pati
  operacija būtų pavykusi. Teisingas veiksmas – **pakartoti vėliau**; našlaitis
  be `jobs` eilutės palaukęs nieko nepablogina, o ištrynimas be barjero yra
  negrįžtamas. Žr. `docs/deletion-guarantees.md` §1.

- `AUDIT_MAX_ENTRIES` PostgreSQL režimui **netaikoma** ir netaps retencijos
  taisykle: eilutės nešalinamos vien dėl kiekio. Ji lieka atminties apsauga.

---

## v1.3.0 – Milestone 2: prieiga, duomenų valdymas ir operacinis pasirengimas

Didžiausias leidimas iki šiol: **70 commit'ai** (36 be merge), **145 failai,
+24 013 / −1 376 eilutės**. Backend testų nuo 558 iki **1042**, frontend nuo
55 iki **64**.

Skaičiai matuoti intervale `v1.2.0..v1.3.0`.

Kryptis ta pati, kaip v1.2.0: ne naujos vartotojo funkcijos, o **prielaidų
pavertimas tikrinamomis garantijomis** – tik šįkart ne privatumo, o prieigos,
duomenų gyvavimo ciklo ir operacinio pasirengimo srityse.

### Added – autentifikacija ir prieigos kontrolė

- **Sesijomis paremta autentifikacija** (`routes/auth.js`, `utils/sessionStore.js`,
  `utils/credentials.js`, `middleware/sessionAuth.js`) – scrypt slaptažodžiai,
  sesijos ID rotacija po prisijungimo, vartotojų enumeracijos apsauga.
- **Centralizuota vaidmenimis paremta prieigos kontrolė** (`middleware/authorize.js`,
  `utils/permissions.js`, `utils/jobAuthorization.js`) – leidimai apibrėžti vienoje
  vietoje, ne išbarstyti po maršrutus.
- **Aktoriaus kontekstas perduodamas worker'iams ir audit log'ui**
  (`feat(auth): propagate safe actor context`) – asinchroninis jobas nebepraranda
  informacijos, kas jį inicijavo.
- RBAC frontend'e, regresijos testai (`RolePermissions.test.jsx`) ir diegimo
  dokumentacija (`docs/auth-deployment.md`).

### Added – duomenų gyvavimo ciklas ir GDPR ištrynimas

- **Artefaktų inventorius ir gyvavimo ciklo modelis** (`utils/artefactInventory.js`,
  `utils/artefactScanner.js`, `services/lifecycleService.js`) – kiekvienas sistemoje
  atsirandantis duomenų artefaktas turi įvardytą savininką ir gyvavimo trukmę.
- **Koordinuotas ištrynimas** (`feat(gdpr)`) – ištrynimas vykdomas per visus
  saugojimo sluoksnius vienu metu, su `utils/deletionTombstones.js` žymėmis, kad
  pakartotinis įrašymas po ištrynimo būtų aptinkamas.
- **Sugriežtinta retencija ir valymas po restarto** (`feat(retention)`) – nutrūkęs
  worker'is nebepalieka pakibusių audio failų.
- Garantijos aprašytos `docs/artefact-lifecycle.md` ir `docs/deletion-guarantees.md`,
  padengtos end-to-end testais.

### Added – atsarginės kopijos ir atkūrimas

- **Kopijų politika ir manifesto modelis** (`utils/backupPolicy.js`,
  `utils/backupManifest.js`) – kas į kopiją patenka ir kas sąmoningai nepatenka.
- **Kūrimas, šifravimas ir atkūrimas** (`services/backupService.js`,
  `services/restoreService.js`, `utils/backupEncryption.js`, `routes/backup.js`).
- **Gyvavimo ciklą suprantantis atkūrimas ir raktų valdymas** (`feat(security)`) –
  atkūrimas negrąžina to, kas buvo teisėtai ištrinta. Tai buvo neakivaizdi vieta:
  be jos GDPR ištrynimas būtų atšaukiamas viena „restore" komanda.
- Procedūros: `docs/backup-runbook.md`, end-to-end atkūrimo scenarijų testai.

### Added – tiekėjų valdysena

- **Tiekėjų inventorius ir diegimo privatumo kontrolinis sąrašas**
  (`utils/providerGovernance.js`, `docs/provider-governance.md`) – kuris tiekėjas
  kokius duomenis mato ir kur jie fiziškai keliauja.
- **Politikos taikymas paleidimo metu ir provider factory viduje** – netinkama
  konfigūracija sustabdo startą, o ne tyliai praeina iki pirmos užklausos.
- **Apėjimo apsaugų testai** (`test(governance): prove provider policy cannot be
  bypassed`) – įrodyta, kad politikos negalima apeiti per override mechanizmus.

### Added – kokybės vertinimas

- **Vertinimo karkasas ir benchmark protokolas** (`docs/evaluation-protocol.md`,
  `utils/evaluationManifest.js`, `utils/qualityMetrics.js`) – WER/CER metodika,
  atkuriamumo reikalavimai.
- **Protokolo vertinimo rubrika ir atsekamumo modelis** (`utils/protocolRubric.js`,
  `utils/protocolTraceability.js`, `docs/protocol-evaluation-rubric.md`) – kaip
  vertinti sugeneruoto protokolo kokybę, ne tik transkripcijos tikslumą.

### Added – operacinis pasirengimas

- **Incidentų valdymo karkasas** (`docs/operations/INCIDENT_RESPONSE.md`) –
  klasifikacija, eskalavimas, pranešimo terminai.
- **Įrodymų išsaugojimo ir atkūrimo procedūros**
  (`docs/operations/OPERATIONAL_PROCEDURES.md`).
- **Postmortem šablonas ir pratybos** (`docs/operations/POSTMORTEM_AND_EXERCISES.md`).
- **Piloto chartija** (`docs/pilot/PILOT_CHARTER.md`) – apimtis, ribos ir sąlygos
  pirmajam realiam diegimui.

Šie dokumentai nėra vien tekstas: dalis jų tikrinama automatiniais testais
(`backupDocumentation`, `incidentRunbook`, `operationalProcedures`,
`postmortemTemplate`, `pilotCharter`), kurie lygina dokumentuose nurodytus
skaičius su realiomis kodo konstantomis.

### Changed – licencija

**MIT → EUPL-1.2-or-later.** Nuo šios versijos projektas platinamas pagal European
Union Public Licence 1.2 arba, gavėjo pasirinkimu, vėlesnę Komisijos patvirtintą
EUPL versiją (SPDX identifikatorius `EUPL-1.2`). `LICENSE` tekstas paimtas iš SPDX
license-list-data canonical šaltinio be perrašymo.

**Versijos iki `v1.2.0` imtinai lieka MIT.** Ta licencija neatšaukiama ir toms
versijoms galioja neterminuotai – užfiksuota `LICENSE-HISTORY.md`, originalus
tekstas išsaugotas `LICENSE-MIT`.

**Autorių teisių turėtoja nurodyta tiksliai:** Juliana Vorono-Baranovska. Anksčiau
`LICENSE` faile buvo įrašyta „Stenograma" – subjektas, kuris teisiškai neegzistuoja.

Pridėta: `CONTRIBUTING.md` su įnašų licencijavimo sąlygomis,
`.github/pull_request_template.md` su patvirtinimo varnele, `LICENSE-COMMERCIAL.md`
ir `AUTHORSHIP.md` (kas projektą sukūrė, kaip, ir ką reiškia kelios commit'ų
tapatybės git istorijoje).

### Fixed

- `fix(security)`: klaidų detalės sanitizuojamos ir Python servisuose – anksčiau
  tik Node pusėje.
- `fix(ui)`: laikmatis išvalomas komponentui išsimontuojant.
- `fix(deps)`: `numpy` prisegtas prie 2.4.6 – 2.5+ reikalauja Python 3.12.
- Dokumentacijos skaičiai suderinti su realybe: backend testai `558` → **1042**,
  `backend/README` `107` → **1042**, frontend `24` → **64**, Node.js `20` → **22**
  README ir RUNPOD.md (v1.2.0 CHANGELOG klaidingai teigė, kad Node versija
  pakeista „visose vietose").
- `nanoid` → 3.3.18 (GHSA-2v37-7h3g-55p8, tranzityvi per postcss).

### Security

- Laikina, dokumentuota `PYSEC-2026-3624` (CVE-2026-58659) išimtis pyannote
  priklausomybių audite: `lightning <= 2.6.5` turi RCE spragą
  `load_from_checkpoint` kelyje, tačiau pataisymas egzistuoja tik commit'e
  `d710d68` ir į išleistą PyPI versiją dar nepateko. Pagrindimas ir šalinimo
  sąlyga įrašyti `ci.yml`.

### Housekeeping

Šaknyje gulėję vienkartiniai issue kūrimo skriptai perkelti į `scripts/dev/`,
leidimo pastabos į `docs/releases/`, GitHub diegimo instrukcijos į `docs/`.
Nieko neištrinta.

### Ko šiame leidime NĖRA

Sąžiningai, kad README ir CHANGELOG neklaidintų:

- **Vertinimo karkasas yra, bet realių matavimų rezultatų dar nėra** – WER/CER
  lietuvių kalbai neišmatuoti. Metodika aprašyta, skaičių nėra.
- **PostgreSQL rezultatams ir MinIO/S3 objektams** – vis dar Milestone 2 likutis;
  sesijos ir audit log tebėra atmintyje.
- **Realaus piloto dar nebuvo** – chartija parašyta, diegimo neįvyko.

---

## v1.2.0 – GDPR ir saugumo programa

Šis leidimas nepridėjo naujų vartotojo funkcijų. Jis padarė kitą dalyką: pavertė
esamas privatumo ir saugumo prielaidas **tikrinamomis garantijomis**.

Pradžioje testų buvo 118, dabar **558** (plius 55 frontend ir 11 integracinių su
tikru Redis). Bet svarbesnis skaičius kitas: kiekviena garantija turi mutacijos
įrodymą – patikrinta, kad testas realiai krinta, kai saugoma savybė pašalinama.
Šioje programoje ne kartą pasitaikė testų, kurie praeidavo ir tada, kai
tikrinama savybė buvo pašalinta.

### Added

**PII redakcija (#4)** – `utils/piiRedaction.js`: LT asmens kodai su kontroline
suma, el. paštas, telefonai, IBAN. Konfigūruojamos kategorijos. Redaguotas
turinys keliauja kaip **artefaktas** su `variant`, `policyVersion` ir
`sourceArtefactId` – guard'ai tikrina faktą, ne prielaidą.

**Konfigūruojamas privatumo režimas (#5)** – užšaldyta `privacyPolicy`,
`ALLOW_EXTERNAL_PROVIDERS`, `REQUIRE_REDACTION_BEFORE_EXTERNAL`,
`EXPORT_ALLOW_ORIGINAL`. Netinkama konfigūracija stabdo startą.

**Originalus ir redaguotas eksportas (#8)** – `variant` privalomas, be
numatytosios reikšmės. Politika gali variantą **uždrausti**, bet niekada
nepakeičia kitu. Failo vardas neša variantą. UI rodo abu variantus, originalui –
atskiras veiksmas su patvirtinimu.

**API saugumo bazė (#14)** – `utils/securityBaseline.js`: helmet su
`default-src 'none'`, CORS allow-list su kilmių validacija, kūno limitai,
bendras rate limitas, readiness timeout. Validacija per zod visuose maršrutuose,
vienas klaidų formatas, nežinomi laukai atmetami.

**Observability ir koreliacija (#17)** – `X-Request-Id`, propagavimas į jobus ir
worker'ius per `AsyncLocalStorage`, struktūruotas JSON logas, grandinė
`queued → processing → provider → completed/failed`, IP tik kaip pseudonimas,
aktorius kaip scrypt atspaudas.

**CI ir tiekimo grandinė (#16)** – `docs/ci-security-policy.md` plius
`scripts/check-workflow-policy.mjs`, kuris politiką **vykdo**. PR blokuojantis
priklausomybių auditas (npm + pip).

**Saugumo testų matrica (#15)** – `docs/security-test-matrix.md`: kuris testas
saugo kurią garantiją ir kokia mutacija tai įrodo. Su patikra, kad matrica
nesenstų, ir skyriumi **„Ko ši matrica neapima"**.

### Fixed

Pakeliui rasti ir ištaisyti realūs defektai, ne tik pridėtos apsaugos:

- **`.github/dependabot.yml` buvo sintaksiškai neteisingas** – GitHub jį atmetė
  tyliai, tad nė viena priklausomybė niekada nebuvo tikrinama.
- **`frontend` turėjo `high` pažeidžiamumą** (`brace-expansion`, GHSA-mh99-v99m-4gvg),
  rastą pirmą kartą paleidus auditą.
- **Eksporto guard'as pasitikėjo `redact()` rezultatu**, kai LLM kelias jau
  tikrino artefakto variantą – dviguba standartų sistema ten, kur failas keliauja
  tiesiai vartotojui.
- **Repair retry perrašydavo šaltinio redakcijos metaduomenis** – API rodydavo
  `redactionStats: {}`, nors originale PII buvo pašalinta.
- **`Content-Disposition` ir `X-Request-Id` nebuvo `Access-Control-Expose-Headers`** –
  cross-origin diegime failo vardas tyliai nusileisdavo į bendrinį.
- **Worker'is žymėdavo `failed` ir tarpiniam bandymui**, po kurio jobas dar
  būdavo kartojamas – grandinė rodydavo galutinę nesėkmę ten, kur jos nebuvo.
- **Telefonų aptikimas laikė telefonais sutarčių ir dokumentų numerius**
  (`812345678`, `800000001`), o asmens kodas po brūkšnelio (`AK-39001010000`)
  praeidavo neredaguotas.
- **Testai palikdavo `/tmp/stenograma-test-storage-*`** – rasta pridėjus švaros
  patikrą.

### Changed

- Node 20 → **22** visose vietose (CI, Docker image'ai, `engines`, `.nvmrc`).
- React 18 → **19** kartu su `lucide-react` (atskirai nė vienas neveikia).
- Tailwind 3 → **4** su klasių pervadinimais, kad išvaizda nepasikeistų;
  `outline-none` → `outline-hidden` ištaisė fokuso indikatorių prieinamumą.
- Testai suskirstyti į rinkinius: `test:privacy`, `test:security`,
  `test:functional`, `test:redis`.
- Redis integraciniai testai nebėra „optional": CI nustato `REQUIRE_REDIS=1`, ir
  tylus praleidimas tampa klaida.

### Known limitations

Rezultatas yra **dalinai pseudonimizuotas, ne anonimizuotas**: vardai paliekami
sąmoningai, adresai neaptinkami, žodžiais padiktuoti identifikatoriai praeina.
Pilnas sąrašas – `docs/security-test-matrix.md` skyriuje „Ko ši matrica neapima".

---

## v1.1.0 – GDPR ištrynimas ir audio retencija

*Įrašas pridėtas atgaline data: leidimas buvo pažymėtas tag'u, bet CHANGELOG ir
`package.json` versija liko neatnaujinti. Tai pastebėta ruošiant v1.2.0.*

### Added
- Pilnas jobo ištrynimas: `DELETE /api/jobs/:id` ir `/api/transcribe-jobs/:id`,
  audio pašalinimas, ištrynimo kvitas.
- `audio_cleanup_pending` vėliava ir retry su backoff nepavykusiems trynimams.

### Fixed
- `storageKey` nulinamas tik po **sėkmingo** audio ištrynimo.
- Atskirti `scanned` ir `attempted` skaitliukai retry suvestinėse.

---

## v1.0.3 – BullMQ ryšių uždarymas

*Įrašas pridėtas atgaline data (žr. v1.1.0 pastabą).*

### Fixed
- BullMQ Redis ryšiai korektiškai uždaromi; pridėtas worker shutdown helper.
- Restart recovery testas naudoja trumpą stalled intervalą.

---

## v1.0.2 – GPU build stabilumas + dokumentacijos tikslinimas

### Fixed
- GPU Dockerfile'iuose pridėti `ENV DEBIAN_FRONTEND=noninteractive` ir `ENV TZ=Etc/UTC`.
  Be jų `tzdata` (python3.11 priklausomybė) interaktyviai klausdavo laiko zonos ir
  build'as kabodavo iki workflow timeout'o.
- `publish-images.yml`: timeout 30 -> 60 min (GPU image'ai su CUDA/torch statomi ilgai).

### Changed
- README / `backend/README.md`: pašalinti pasenę „NEBUVO testuota" teiginiai. GPU image'ai
  dabar realiai statomi per GHCR workflow, E2E su Chromium sukasi CI'e, o RunPod srautas
  (Whisper + pyannote, ~4 val. įrašas) patikrintas prieš v1.0.0 relizą.

---

## v1.0.1 – GHCR Docker publish pataisos

Pataisytas `Publish images (GHCR)` workflow, kuris krito statant GPU Docker image'us.

### Fixed
- GPU Dockerfile'iai (backend / whisper / pyannote) naudoja `nvidia/cuda:...-ubuntu22.04`
  bazę, kurios sisteminis pip per senas `--break-system-packages` flag'ui (jis atsirado
  pip 23.0+). Pridėtas `pip install --upgrade pip` prieš priklausomybių diegimą.
- CPU `backend/Dockerfile.whisper` – tas pats pip atnaujinimas prevenciškai (nuoseklumui
  ir ateities CPU image publikavimui).

Įprastas CI (`ci.yml`) buvo ir lieka žalias – jis GPU image'ų nestato; ši problema
pasireiškė tik GHCR publish workflow'e, paleidžiamame su versijos tag'u.

---

## v1.0.0 – Pirmas stabilus leidimas 🎉

Pirmas stabilus viešas leidimas: produkcijai orientuota architektūra AI pagalbiniam
susitikimų transkribavimui ir protokolų generavimui. Detalus techninis pataisymų
aprašas – commit istorijoje; žemiau glaustas apžvalginis sąrašas.

### Added
- Asinchroniniai transkribavimo jobai (202 + polling)
- BullMQ + Redis eilė su inline fallback
- Keli transkribavimo tiekėjai (faster-whisper embedded/server)
- Keli LLM tiekėjai (Claude / GPT / Gemini / mock)
- Pasirenkama kalbėtojų diarizacija (pyannote)
- Health ir readiness endpointai
- Docker diegimas (demo / cpu / gpu / server / runpod)
- Provider architektūra (tiekėjai keičiami per .env)

### Fixed
- Startavimo race condition
- Worker inicializacija ir paleidimo apsauga
- jobStore/jobRunner režimo nuoseklumas
- Failo validacija prieš storage
- Temp/orphan failų valymas
- Klaidų apdorojimas (ne-JSON / sugadinti atsakymai)
- Saugus transkribavimo nutraukimas (abort)

### Testing
- Backend unit + route testai
- Frontend unit + API testai
- Playwright E2E (Chromium)
- Python kontraktų testai (pyannote + whisper)
- Docker build + smoke

### Sąžiningi apribojimai
- GPU keliai, BullMQ restart recovery su tikru Redis ir worker heartbeat srautas per
  tikrą Redis – parašyti ir unit/statiškai patikrinti, bet ne visi paleisti kūrimo
  aplinkoje. Žr. `DEPLOYMENT_CHECKLIST.md` prieš production.

---

## Pataisyta (po realaus RunPod diegimo audito)

- **VAD filtras + automatinis MP3→WAV + upload/inline nuoseklumas (kodo audito radiniai).**
  Iš kritinio kodo įvertinimo ir 4 val. testo:
  - `WHISPER_VAD_FILTER=true` (numatyta): faster-whisper VAD praleidžia tylą - šalina
    halucinacijų PRIEŽASTĮ (ne tik pasekmę kaip post-filtras).
  - `PYANNOTE_AUTO_WAV=true` (numatyta): pyannote-server automatiškai konvertuoja ne-WAV
    į 16kHz mono WAV per ffmpeg prieš pipeline() - išsprendžia ilgo MP3 įstrigimą be
    rankinio konvertavimo.
  - `MAX_UPLOAD_MB` numatytasis suvienodintas (kodas 50 → 500, atitinka .env.example) -
    ilgi failai nebeatmetami be konfigūracijos.
  - Inline job runner produkcijoje (`NODE_ENV=production` be `REDIS_URL`) dabar garsiai
    ĮSPĖJA apie duomenų praradimo/retry nebuvimo riziką.
  - Progreso streaming (SSE) ilgiems failams: whisper-server `/transcribe-stream` +
    backend SSE skaitymas + jobStore progress. EKSPERIMENTINIS, numatyta IŠJUNGTA
    (`WHISPER_STREAM_PROGRESS=false`), NETESTUOTA su realiu GPU.

- **`file`/`audio` laukų nenuoseklumas įkeliant.** `/api/transcribe` ir
  `/api/transcribe-jobs` priimdavo tik `audio` lauką, o `file` metė "Unexpected field"
  (RASTA realiai - natūralu bandyti `-F "file=@..."`). Dabar priimami ABU laukai.
- **Whisper halucinacijų filtras.** Backend'as automatiškai šalina tyloje "prasimanytus"
  YouTube-titrų segmentus (segmentai be kalbėtojo su žinomais šablonais). Konservatyvus -
  realios kalbos neliečia. Išjungiama `FILTER_HALLUCINATIONS=false`, plečiama
  `HALLUCINATION_EXTRA_PATTERNS`. Nauji testai. (4 val. teste tai buvo ~37% segmentų.)

- **Fiksuotas 90s HTTP timeout nutraukdavo ilgų failų apdorojimą (defektas).** Backend'as,
  kviesdamas pyannote/Whisper per HTTP, naudojo fiksuotą 90s timeout. RASTA su 4 val.
  įrašu: diarizacija trunka ilgiau nei 90s, tad backend'as klaidingai pažymėdavo jobą
  `failed` su `viršijo 90000ms limitą`, NORS pyannote realiai užbaigdavo (`POST /diarize
  200 OK` matėsi jau po klaidos). Pataisyta: numatytas timeout pakeltas iki 5 min, o audio
  apdorojimui naudojamas PROPORCINGAS timeout pagal failo dydį (5-90 min), naudojamas ir
  diarizacijoje, ir transkripcijoje. Perrašoma per `API_TIMEOUT_MS` / `AUDIO_TIMEOUT_*`.
  Pridėti regresijos testai (`tests/httpClient.timeout.test.js`). Dokumentuota RUNPOD.md §4b.

- **Hardcodinti portai Makefile (diegimo defektas).** `make gpu`/`make dev`/`make pyannote`
  naudojo fiksuotus portus (backend `3001`, pyannote `8001`), kurie RunPod'e jau užimti
  nginx/proxy - dėl to stackas nepasileidžia net su teisingais raktais. Portai padaryti
  konfigūruojami per Makefile kintamuosius (`BACKEND_PORT`, `PYANNOTE_PORT`,
  `FRONTEND_PORT`), perduodamus ir serveriams, ir jų tarpusavio sąsajai (`PYANNOTE_URL`).
  Naudojimas: `make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001`. Dokumentuota RUNPOD.md.

---

## Milestone 1 – Reliable processing pipeline ✅

Tikslas: paversti veikiantį prototipą patikimu apdorojimo konvejeriu, kuris
nepraranda vartotojo darbo ir turi aiškią sistemos būseną.

- **Persistent job orchestration** – HTTP endpoint'as tik įdeda jobą ir grąžina
  202; darbą vykdo atskiras procesas (ne HTTP handler'is). Su fallback į inline
  režimą, kai nėra Redis.
- **BullMQ workers** – atskiri transkripcijos ir protokolo worker'iai
  (`workers/transcriptionWorker.js`, `protocolWorker.js`) su retry + eksponentiniu
  backoff, dead-letter (failed po visų bandymų), stalled job recovery (worker
  restartavus nebaigtas jobas grąžinamas), atominiu job reservation (du worker'iai
  nepaima to paties jobo). Skaluojami nepriklausomai.
- **Redis-backed state** – pluggable job store (`utils/jobStore/`): su `REDIS_URL`
  job'ų būsena persistuojama Redis'e (atspari restartams, keli procesai), be jo –
  in-memory fallback. Laukai: `attempt_count`, `error_code`, `error_message`,
  `created_at`/`started_at`/`completed_at`. Statusai: queued/processing/completed/
  failed/cancelled.
- **Dedicated Whisper service** – persistentus `whisper-server/` (FastAPI), modelis
  įkeliamas vieną kartą ir laikomas atmintyje/VRAM tarp užklausų (vietoj naujo
  Python proceso kiekvienai užklausai). Concurrency semaforas, chunked upload.
  Simetriška pyannote-server architektūrai.
- **Browser E2E** – Playwright testai su tikra naršykle: (a) įklijuoti tekstą →
  protokolas → DOCX; (b) pilnas audio upload → polling → protokolas → DOCX; plius
  klaidų keliai (netinkamas formatas, backend offline, protokolo jobo klaida su
  paslapčių sanitizacija). Vykdomi CI'e su Chromium.
- **Protocol generation pipeline** – async `/api/jobs` (protokolas) ir
  `/api/transcribe-jobs` (transkripcija) su polling; provider pattern (Claude/GPT/
  Gemini/mock LLM; faster-whisper embedded/server; pyannote diarizacija); JSON
  schema validacija su repair retry; bendras failų storage (worker pasiekia audio
  pagal raktą, ne lokalų /tmp; failas trinamas po galutinio statuso, ne tarp retry).
- **Docker deployment** – profiliais atskirti compose failai (demo/cpu/gpu/server/
  runpod) su literalia provider izoliacija; nginx `/api` proxy (be CORS, universalus
  frontend image); quickstart/preflight/smoke/configure UX skriptai; Redis ir worker
  servisai; RunPod topologija su vienu viešu prievadu.
- **Health/readiness checks** – `/api/health` (backend), `/health?probe=true`
  (whisper-server ir pyannote-server priverstinai įkelia modelį ir grąžina 503 jei
  nepavyksta); Docker healthcheck'ai su `service_healthy` priklausomybėmis
  (backend laukia, kol Redis/pyannote/whisper realiai pasiruošę).

**Testų aprėptis milestone pabaigoje:** 129 backend + 9 pyannote + 8 whisper +
24 frontend + 6 E2E.

**Sąžiningi apribojimai (reikia realios aplinkos, ne sandbox):** GPU keliai
(CUDA/Torch/Whisper/pyannote su `device=cuda`), BullMQ restart recovery su tikru
Redis, ir E2E su tikra naršykle nebuvo paleisti kūrimo aplinkoje – parašyti,
statiškai patikrinti ir paruošti CI'ui / jūsų mašinai. Žr. README skiltį
„Ką realiai patikrina CI vs. kas tikrinta rankiniu būdu".

---

## Kitas: Milestone 2 – Sauga ir duomenų valdymas (planuojama)

OIDC autentifikavimas, organizacijų/rolių multi-tenancy, PostgreSQL + migracijos,
MinIO/S3 failų saugykla, retention/GDPR, audit logas. Žr. README roadmap.

## Žinomi apribojimai (iš realaus RunPod testavimo, taisytini atskirai)

- **SSE progreso cancellation yra COOPERATIVE (ne hard).** Kliento disconnect nutraukia
  darbą TIK tarp Whisper segmentų - vieno ilgo segmento apdorojimo (`model.transcribe`
  iteracijos) nutraukti negalima be atskiro proceso modelio. Temp failą trina worker'is
  savo `finally` bloke (kai TIKRAI baigia), ne event generatorius - tad failas
  neištrinamas, kol thread gyvas. Serverio pusė padengta Python integraciniais testais
  (`whisper-server/test_stream_integration.py`: bendras concurrency, semaforo
  atlaisvinimas, temp valymas). Vis dar EKSPERIMENTINIS - `WHISPER_STREAM_PROGRESS=false`
  numatytai.

- **Whisper halucinacijos tyloje (VAD neįjungtas).** RASTA su 4 val. įrašu: tyliose
  vietose (pauzės, tylus fonas) faster-whisper „prasimano" tekstą - dažniausiai YouTube
  titrų likučius („www.youtube.com" ir pan.). 4 val. teste ~37% segmentų (462 iš 1274)
  buvo tokios halucinacijos. Pyannote joms NEPRISKYRĖ kalbėtojo (`speaker=null`), tad
  jos atskiriamos. Du sprendimai (atskiras darbas): (1) įjungti faster-whisper
  `vad_filter=True` (voice activity detection praleidžia tylą - šalinama priežastis);
  (2) filtruoti segmentus be kalbėtojo su žinomais halucinacijų šablonais prieš protokolą.
  Pagrindinis kalbos turinys NENUKENČIA - halucinacijos tik tyliose vietose.
- **Job progresas ilgiems failams.** `progress` laukas visada `null` iki `completed` -
  kelių valandų įrašui vartotojas nemato „kiek liko". Infrastruktūra paruošta (job
  laukas, frontend rodymas, servisas priima `onProgress`), bet whisper-server → backend
  grandinė neteikia tarpinio progreso (vienas HTTP POST vietoj streaming'o). Sprendimas:
  whisper-server SSE/chunked su progresu → backend rašo į jobStore. Žr. README trade-off'ai.
- **MP3 ilgiems failams + pyannote.** Ilgas MP3 pyannote/torchaudio kelyje sukelia
  begalinį `MPEG_LAYER_III` warning'ų srautą ir įstrigimą; WAV veikia švariai. Kol nėra
  automatinio konvertavimo (planuojama), ilgus MP3 konvertuokite į WAV prieš siunčiant:
  `ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav`.
