# Stenograma backend

Serveris, kuris atskiria API raktus nuo naršyklės ir leidžia konfigūracija (ne kodo pakeitimu)
pasirinkti transkribavimo ir LLM tiekėjus.

## Paleidimas

```bash
cp .env.example .env
npm install
npm start
```

Numatytieji nustatymai (`TRANSCRIPTION_PROVIDER=mock`, `LLM_PROVIDER=mock`) veikia iškart,
be jokių API raktų — patikrinta šioje aplinkoje (`/api/health`, `/api/generate`,
`/api/transcribe`, `/api/audit` visi grąžina teisingus atsakymus mock režimu).

Norint įjungti realų tiekėją, pakeiskite tik `.env`:

```
TRANSCRIPTION_PROVIDER=whisper     # arba faster-whisper / azure / google / deepgram
LLM_PROVIDER=claude                # arba gpt / gemini
```

Likusi sistemos logika (schema validacija, prompt versijos, audit log) nesikeičia.

## Saugumas — numatytosios reikšmės

**Šis projektas yra MVP skirtas LOKALIAM/VIDINIAM naudojimui, ne viešas SaaS su
vartotojų valdymu.** `/api/generate` ir `/api/transcribe` kviečia apmokamus išorinius
API - jei diegiate viešai su realiais (nepažįstamais) vartotojais, būtina pridėti
tinkamesnę autentifikaciją (sesijas, OAuth, per-user limitus), ne tik bendrą raktą.

| Kintamasis | Numatyta | Kodėl |
|---|---|---|
| `CORS_ORIGIN` | `http://localhost:5173` | `*` reikalauja sąmoningo pasirinkimo (konsolėje bus įspėjimas), ne numatytoji reikšmė |
| `ALLOW_PROVIDER_OVERRIDE` | `false` | Klientas negali per `/api/generate` ar `/api/transcribe` užklausą perjungti į kitą (potencialiai brangesnį) tiekėją nei serveryje sukonfigūruotas |
| `AUDIT_API_KEY` | tuščia | Jei tuščia ir `NODE_ENV=production`, `/api/audit` uždarytas (503). Dev režime praleidžiama su įspėjimu konsolėje |
| `API_KEY` | tuščia | Apsaugo `/api/generate` ir `/api/transcribe`. Tuščia + `NODE_ENV=production` = endpoint'ai uždaryti (503). Tuščia + dev = atviri su įspėjimu konsolėje (patogu lokaliam darbui) |
| `HEALTH_DETAILS` | pagal `NODE_ENV` | `/api/health` produkcijoje pagal nutylėjimą grąžina TIK `{status:"ok"}` - tiekėjų/modelių pavadinimai nerodomi viešai, nebent `HEALTH_DETAILS=public` arba pateiktas teisingas `x-audit-key` |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MINUTES` | `20` / `15` | `express-rate-limit` ant `/api/generate` ir `/api/transcribe` - apsauga nuo netyčinio ar tyčinio sąskaitos "užpylimo" |
| `MAX_UPLOAD_MB` | `50` | `multer.diskStorage` (ne `memoryStorage`) - failas streamuojamas į laikiną failą, ne laikomas visas atmintyje; laikinas failas ištrinamas po apdorojimo (`finally` bloke) |
| Audio MIME/plėtinio whitelist | mp3/wav/m4a/mp4/webm/ogg/aac/flac | `fileFilter` atmeta bet ką kitą su 400, dar prieš failą pasiekiant diską |
| `API_TIMEOUT_MS` | `90000` | Visi išoriniai API kvietimai (Claude/OpenAI/Deepgram/Azure/Google/pyannote/...) turi `AbortController` timeout + vieną automatinį pakartojimą 5xx/tinklo klaidoms (`utils/httpClient.js`) |
| Prompt injection mitigation (ne "protection" - žr. pastabą žemiau) | `meeting_v3` (numatyta) | Promptas eksplicitiškai nurodo, kad transkripcija yra DUOMENYS, ne instrukcijos (nuo v2) - žr. `prompts/meeting_v3.js` |

### Autentifikacija ir viešas diegimas

`API_KEY` yra **vienas bendras raktas visiems klientams**, ne per-user autentifikacija.
Tai tinka:
- lokaliam kūrimui;
- vidiniam naudojimui uždarame tinkle (intranet, VPN, komandos serveris).

Tai **NETINKA** viešam internetui su nepažįstamais vartotojais, nes:
1. Frontend'as (React SPA naršyklėje) NEGALI saugiai laikyti šio rakto - jei jį
   įdėsite į `VITE_API_KEY`, jis bus įkompiliuotas į viešai atsisiunčiamą JS
   bundle'ą ir matomas bet kam per naršyklės dev tools.
2. Vienas raktas reiškia, kad negalite atskirti/limituoti vartotojų individualiai
   ar atšaukti prieigą vienam žmogui neatšaukiant visiems.

Jei norite šį projektą deployinti viešai su realiais vartotojais, reikalingas
VIENAS iš šių sprendimų:
- **Reverse proxy / backend-for-frontend**, kuris `API_KEY` prideda SERVERIO
  pusėje (naršyklė jo niekada nemato) ir pats autentifikuoja vartotojus (pvz.
  per sesijos cookie) prieš persiųsdamas užklausą į šį backend'ą;
- **Pilna auth sistema** (sesijos, OAuth/OIDC, JWT su per-user limitais) šio
  backend'o viduje, pakeičiant `middleware/apiKeyAuth.js`.

### Streaming / atminties ribos (sąžiningas MVP limitas)

`multer.diskStorage` jau užtikrina, kad ĮKĖLIMO metu (multipart upload) failas
streamuojamas tiesiai į diską, NE laikomas visas atmintyje. Tačiau
`routes/transcribe.js` vėliau vis tiek daro `fs.readFile(req.file.path)` -
perskaito VISĄ failą į atmintį prieš siunčiant tiekėjui, nes dauguma tiekėjų
REST API (Whisper/Deepgram/ir kt.) tikisi viso failo turinio multipart kūne su
žinomu `Content-Length`, ne tikro srauto. Su `MAX_UPLOAD_MB=50` numatytąja
reikšme tai reiškia ne daugiau kaip ~50MB piko atminties vienai užklausai - MVP
apimtyje priimtina, bet NE tikras end-to-end streaming. Daugeliui tikrų
tiekėjų (ypač Deepgram) tikras chunked streaming yra įmanomas per jų
WebSocket/streaming API - tai atskiras, didesnis refaktoringas, neįtrauktas čia.

**Svarbi terminologijos pastaba: `MAX_UPLOAD_MB` riboja FAILO DYDĮ, NE įrašo
TRUKMĘ ar apdorojimo laiką.** 50MB gali būti kelios minutės aukšto bitrate WAV
arba kelios valandos stipriai suspausto (pvz. žemo bitrate mp3/opus) audio.
Reali apdorojimo trukmės (ir taip pat CPU/GPU laiko `faster-whisper-embedded`
profiliui) rizika priklauso nuo trukmės/codec/sample rate, ne vien failo dydžio.
Šis projektas NETIKRINA realios trukmės prieš apdorojimą (tam reikėtų `ffprobe`
ar panašios bibliotekos, pridedančios sistemos lygio priklausomybę) - tai
sąmoningai NEĮGYVENDINTA, žr. Roadmap. Jei jums svarbu apriboti apdorojimo
LAIKĄ, o ne failo DYDĮ, tai yra prioritetinis kitas žingsnis prieš tikrą
production naudojimą su ilgais (>1 val.) įrašais.

## Asinchroninio job API - dvi realizacijos (inline fallback IR tikra BullMQ eilė)

**Atnaujinta po Milestone 1 refaktoringo - žemiau esantis aprašymas pakeičia senesnę
šio skyriaus versiją, kuri vis dar minėdavo `utils/jobStore.js` kaip in-memory `Map`.
Tas failas nebeegzistuoja - jį pakeitė `utils/jobStore/` katalogas su dviem realiais
backend'ais (žr. žemiau). Jei radote ankstesnę šio README kopiją ar senesnį commit'ą,
kuriame parašyta "tai NĖRA job queue tikra prasme" - tai buvo teisinga TADA, bet
nebeatitinka dabartinio kodo.**

Sistema turi DVI vykdymo veiksenas, pasirenkamas automatiškai pagal `REDIS_URL`
(žr. `utils/jobStore/index.js` ir `queues/jobRunner.js`):

| | Be `REDIS_URL` (inline) | Su `REDIS_URL` (BullMQ) |
|---|---|---|
| Kur vykdomas darbas | TAME PAČIAME HTTP procese (`setImmediate`) | ATSKIRAME worker procese (`workers/index.js`) |
| Būsenos saugykla | `utils/jobStore/memoryStore.js` (in-memory `Map`) | `utils/jobStore/redisStore.js` (Redis) |
| HTTP backend restartas vykdymo metu | **PRARANDA** darbą ir būseną (retry nėra) | **NEnutraukia** - darbą baigia worker'is |
| Retry / backoff | Nėra | Taip - `attempts` + eksponentinis backoff (`queues/config.js`) |
| Stalled/crashed worker recovery | Nėra (nėra worker'io) | Taip - BullMQ `stalledInterval`/`maxStalledCount` |
| Tinka | Dev/desktop, vienas vartotojas | Produkcija, keli worker'iai, ilgi (>1 val.) įrašai |

Tai TIKRA job queue Redis/BullMQ prasme, su realiais worker'iais - ne tik asinchroninio
API kontrakto abstrakcija. `bullmq`/`ioredis` yra realios (nors ir `optionalDependencies`)
priklausomybės, ne tik paminėtos planuose.

`POST /api/generate` yra sinchroninis - klientas laiko atvirą HTTP ryšį, kol LLM
baigia. Trumpiems susitikimams tai paprasčiau ir greičiau, bet 1-2 val. įrašui
su ilga transkripcija tai gali reikšti ilgą (ar timeout'inantį) HTTP laukimą.

Sprendimas - `POST /api/jobs` + `GET /api/jobs/:id`:

```bash
# 1) Sukuriamas jobas, atsakymas IŠ KARTO (202 Accepted)
curl -X POST http://localhost:3001/api/jobs -H "Content-Type: application/json" \
  -d '{"title":"Ilgas susitikimas","transcript":"..."}'
# => {"jobId":"...","status":"queued"}

# 2) Klientas pollina rezultatą
curl http://localhost:3001/api/jobs/<jobId>
# => {"jobId":"...","status":"completed","result":{"protocol":{...},"meta":{...}}}
```

Abu keliai (`/api/generate` ir `/api/jobs`) naudoja tą pačią logiką
(`services/protocolService.js`), kad nereikėtų palaikyti dviejų kopijų. Inline ir
BullMQ veiksenos irgi naudoja TĄ PATĮ processor'ių kodą (`queues/processors.js`),
tad elgesys nesiskiria priklausomai nuo to, kuris backend'as aktyvus.

### Redis/BullMQ architektūra (su `REDIS_URL`)

```
HTTP backend  --queue.add()-->  Redis (BullMQ eilė)  <--paima jobą--  worker procesas
     │                                                                        │
     └── grąžina 202 IŠ KARTO                              vykdo processor'ių, rašo
                                                             būseną atgal į jobStore (Redis)
```

- `queues/transcriptionQueue.js`, `queues/protocolQueue.js` - atskiros eilės (galima
  skalauti transkripciją ir protokolo generavimą nepriklausomai).
- `workers/transcriptionWorker.js`, `workers/protocolWorker.js` - ATSKIRI nuo HTTP
  backend'o procesai, IR (Docker aplinkoje) ATSKIRI DU compose servisai -
  `transcription-worker` ir `protocol-worker` (žr. `docker-compose.gpu.yml`,
  `docker-compose.server.yml`). Kiekvieną galima skalauti NEPRIKLAUSOMAI:
  `docker compose ... up --scale transcription-worker=3` arba
  `--scale protocol-worker=3`. (`workers/index.js` egzistuoja kaip patogumas
  paleisti ABU worker'ius viename procese - naudojamas TIK `node workers/index.js`
  rankinio/ne-Docker paleidimo atveju, NE compose servisuose.)
- **Retry + backoff:** `attempts` (numatyta 3) su eksponentiniu backoff
  (`QUEUE_BACKOFF_MS`, numatyta 5000ms) - `queues/config.js`.
- **Stalled recovery:** jei worker'is krenta vykdymo metu neatnaujinęs job lock'o
  per `stalledInterval` (numatyta 30s), BullMQ grąžina jobą į eilę - kitas worker'is
  (ar tas pats po restarto) jį pakartoja, iki `maxStalledCount` (numatyta 2) kartų.
- **"Dead-letter" terminijos patikslinimas:** kodo komentaruose ir anksčiau šiame
  README naudotas terminas "dead-letter queue" yra NETIKSLUS - **NĖRA** atskiros
  dead-letter eilės, į kurią galutinai nepavykę jobai būtų perkeliami. Po visų
  `attempts` išnaudojimo jobas tiesiog lieka pažymėtas `failed` BullMQ eilėje ir
  `jobStore` (su `error`/`error_code`), tik ilgiau saugomas diagnostikai
  (`removeOnFail.age = 24h` vs `removeOnComplete.age = 1h`, žr. `queues/config.js`).
  Tikslesnis apibūdinimas: *"retry + exponential backoff; po visų bandymų jobas
  paliekamas BullMQ `failed` būsenoje 24h diagnostikai"* - ne klasikinė izoliuota DLQ.
- **Audio/storage saugumas retry metu:** transkripcijos audio failas TRINAMAS TIK po
  galutinio statuso (sėkmės arba išnaudotų bandymų `failed`), NE po kiekvieno
  nepavykusio bandymo - kitaip retry neturėtų ką apdoroti (`workers/index.js`
  `_cleanupStorage`, kviečiamas iš `worker.on("failed")` tik kai `attemptsExhausted`).
- **Bendras storage worker'iui:** kadangi worker'is - atskiras procesas/konteineris,
  jis audio failą pasiekia per bendrą `STORAGE_DIR` (Docker volume), NE per HTTP
  backend'o lokalų `/tmp` - žr. `utils/fileStorage.js`.

### Ką TIKRAI reikšia "restartas nenutraukia darbo" (scope patikslinimas)

Teiginys *"HTTP backend restartas nenutraukia vykdomo darbo"* yra TIKSLUS, bet TIK
BullMQ veiksenoje IR TIK HTTP backend konteinerio/proceso atžvilgiu:

- **HTTP backend restartas** (BullMQ režime): jobas saugus Redis'e, worker'is (kuris
  NEbuvo restartuotas) tęsia arba pasiima jį iš eilės. ✅ Darbas nenutrūksta.
- **Worker'io kritimas vykdymo metu**: jobas tampa "stalled", BullMQ grąžina jį į
  eilę, kitas worker'is jį PAKARTOJA. Tai **NĖRA** checkpoint/resume - transkripcija
  (faster-whisper) neturi tarpinio taško, iš kurio tęsti; pakartotas bandymas
  pradeda apdoroti audio NUO PRADŽIŲ. Ilgam (pvz. 4 val.) įrašui tai reiškia visą
  apdorojimo laiką iš naujo, ne tik trumpą "tęsimą".
- **Visos infrastruktūros (Redis + visi worker'iai) išjungimas** (pvz. `docker
  compose down` ar visa mašina išjungiama): darbas nutrūksta kaip ir bet kurioje
  eilės sistemoje - jobas lieka Redis'e (jei Redis duomenys išliko/persistentūs) ir
  bus pakartotas, kai infrastruktūra grįš, bet TAI JAU NE "gyvo proceso tęsimas",
  o "eilės atkūrimas po infrastruktūros grąžinimo".
- **Inline veiksenoje** (be `REDIS_URL`): joks iš aukščiau nurodytų teiginių
  negalioja - HTTP backend restartas ar kritimas vykdymo metu PRARANDA darbą ir
  būseną, retry nėra (žr. `queues/jobRunner.js` komentarą `warnIfInlineInProduction`).

### REDIS_REQUIRED - kada privaloma, kada ne

`REDIS_REQUIRED=true` verčia sistemą griežtai atsisakyti tylaus fallback'o į
in-memory/inline, jei Redis nepasiekiamas per startą (kietas gedimas vietoj tylaus
darbo praradimo). Worker procesas (`workers/index.js`) ELGIASI TAIP VISADA,
nepriklausomai nuo šio env kintamojo - worker'iui nėra prasmingo memory fallback
(jis matytų Redis eilę, bet laikytų būseną savo proceso atmintyje, nematytų HTTP
backend'o sukurtų jobų). **HTTP backend'ui** `REDIS_REQUIRED=true` REKOMENDUOJAMA
GPU/produkcijos Docker profiliuose (`docker-compose.gpu.yml`, `docker-compose.server.yml`)
- be jo backend'as tyliai (su `console.warn`) grįžtų į inline, jei Redis prisijungimas
per startą nepavyktų, o tai reikštų persistencijos praradimą būtent tada, kai ji
labiausiai reikalinga (ilgi GPU įrašai).

### Worker heartbeat ir /api/ready readiness politika

BullMQ režime kiekvienas worker procesas (`transcription-worker`, `protocol-worker`)
periodiškai rašo SAVO TIPO Redis raktą su TTL (`stenograma:worker:<tipas>:lastSeen`,
žr. `utils/workerHeartbeat.js`). `/api/ready` tikrina ABU raktus atskirai ir grąžina:

```json
{
  "ready": false,
  "components": {
    "workerAlive": false,
    "workers": { "transcription": true, "protocol": false }
  }
}
```

**Sprendimas (dabartinis, tyčinis): `workerAlive` reikalauja, kad ABU worker tipai
būtų gyvi** (`transcription && protocol`), NE tik tie, kurie realiai naudojami
konkrečiame diegime. Tai atitinka dabartinius compose profilius
(`docker-compose.gpu.yml`, `docker-compose.server.yml`), kurie VISADA deklaruoja
abu worker servisus kartu.

**Žinoma riba:** jei kada nors atsirastų diegimas, kuris sąmoningai naudoja TIK
vieną worker tipą (pvz. tik transkripcijos servisą, o protokolai generuojami
išimtinai per sinchroninį `/api/generate`), `/api/ready` visada rodytų `503` dėl
trūkstamo (ir nereikalingo) protokolo worker'io heartbeat. Tokiu atveju reikėtų
konfigūruojamo sąrašo (pvz. `REQUIRED_WORKERS=transcription,protocol` env
kintamojo), kuris nurodytų, kurie worker tipai TIKRAI privalomi šiam konkrečiam
diegimui - `getWorkerStatus()` (`utils/workerHeartbeat.js`) jau grąžina abiejų
tipų būseną atskirai, tad tokį filtravimą būtų nesunku pridėti `server.js`
`/api/ready` route'e, nekeičiant pačio heartbeat mechanizmo.

### Testai (Redis/BullMQ specifiniai)

- `tests/jobStore.test.js` - in-memory backend'as (TTL valymas) + Redis backend'o
  perjungimo testai (naudoja MOCK Redis factory, žr. `_setRedisFactoryForTests`).
- `tests/jobStoreRedis.test.js` - **NE su realiu Redis**, nepaisant pavadinimo -
  testuoja `redisStore.js` LOGIKĄ (serializacija/deserializacija, raktų schema,
  sweep) su rankiniu `FakeRedis` klase (in-memory imitacija ioredis API), kad
  veiktų be tikro Redis serverio. Tikrina, kad kodas TEISINGAI naudoja Redis
  komandas, bet NETIKRINA tikro Redis tinklo elgesio.
- `tests/jobRunnerBullmq.test.js` - `jobRunner` BullMQ veiksenos unit testai su
  MOCK `bullmq`/`ioredis` (per `Module._load` perėmimą), taip pat be tikro Redis.
- `tests/queueRecovery.integration.test.js` - naudoja **TIKRĄ** Redis + tikrą
  BullMQ `Queue`/`Worker` (restart recovery, stalled recovery).
- `tests/heartbeatReadiness.integration.test.js` - naudoja **TIKRĄ** Redis:
  worker'io `startHeartbeat()` rašo raktą PER TIKRĄ Redis, `GET /api/ready`
  (per tikrą `server.js` + supertest) TĄ PATĮ raktą TIKRAI perskaito, o raktui
  dingus (imituoja TTL expiry per tiesioginį `DEL`, be realaus 30s laukimo) -
  readiness pereina į 503 su tiksliu `workers.{transcription,protocol}`
  skaidymu. Anksčiau ŠI KONKREČIA grandinė (worker → Redis → /api/ready) buvo
  testuota tik atskirai (heartbeat su mock Redis, arba readiness logika be
  realaus rašymo/skaitymo per tinklą).
  
  Abu šie integraciniai testai PRALEIDŽIAMI be `REDIS_URL` (`skip`, ne fail).
  **SVARBU:** CI TYČIA NEDUODA `REDIS_URL` visam `npm test` žingsniui (tai
  sugadintų route testus, kurie tikisi inline vykdymo be worker'io) - abu šie
  failai paleidžiami ATSKIRU CI žingsniu (`npm run test:redis`) su savo
  `REDIS_URL`, žr. `.github/workflows/ci.yml`.

  Jei reikėtų testo, kuris TIKRAI tikrina `redisStore.js` su realiu Redis (ne
  FakeRedis) - tai būtų atskiras `tests/jobStoreRedis.integration.test.js`,
  kurio šiuo metu NĖRA (galimas kitas žingsnis, jei prireiktų).
- `tests/workerGuard.test.js`, `tests/workerHeartbeat.test.js` - worker paleidimo
  apsauga (`initializeWorkerOrFail`) ir heartbeat mechanizmas (`/api/ready` patikrina,
  kad worker'is GYVAS, ne tik kad Redis pasiekiamas).

## Testai

```bash
npm test        # node --test (built-in) - 1042 testai, mock provideriais, be jokių raktų
npm run check   # node --check kiekvienam .js failui

# #237: ar PR nepašalino testų? Lygina identitetus tarp `git merge-base` ir head'o.
# Reikia git istorijos - CI tam turi ATSKIRĄ `deleted-tests` job'ą su `fetch-depth: 0`.
npm run test:deleted                       # bazė: origin/main
npm run test:deleted -- --base origin/main # eksplicitinė bazė (derinimui)
npm run test:deleted -- --self-test        # tik sargo savipatikra, repo neliečiama
```

- `tests/protocolSchema.test.js` — schema validacija (privalomi laukai, tipai, klaidų pranešimai).
- `tests/prompt.snapshot.test.js` — apsaugo `meeting_v1`/`meeting_v2` prompt šablonus nuo netyčinių pakeitimų + patikrina prompt-injection apsaugos frazes.
- `tests/mockLLMProvider.test.js` — MockLLMProvider ištraukia teisingą transkripcijos bloką iš prompto (regresijos testas klaidai, kai injection-guard tekstas sutrikdydavo naivų `"""` regex).
- `tests/mergeDiarization.test.js` — laiko persidengimu paremtos diarizacijos sujungimo logikos unit testai.
- `tests/generate.route.test.js`, `tests/transcribe.route.test.js` — HTTP lygio testai per `supertest`, įskaitant `ALLOW_PROVIDER_OVERRIDE=false` atmetimo scenarijus.
- `tests/jobs.route.test.js` — asinchroninis `/api/jobs` + `/api/jobs/:id` polling srautas.
- `tests/diarization.route.test.js` — `none`/`inline`/atskiro tiekėjo diarizacijos režimai.
- `tests/providerOverride.route.test.js` — `ALLOW_PROVIDER_OVERRIDE=true` whitelist patikra.
- `tests/security.route.test.js` — `API_KEY` autentifikacija, `/api/health` detalių slėpimas produkcijoje, audio MIME/plėtinio validacija.
- `tests/rateLimit.route.test.js` — `express-rate-limit` realiai suveikia (429 viršijus limitą).
- `tests/audioMagicBytes.test.js` — failo turinio (magic bytes) atpažinimas, įskaitant "pervadinto failo" bandymo atmetimą.
- `tests/errorSanitization.route.test.js` — patikrina, kad tikra tiekėjo/vidinė klaida (pvz. trūkstamas raktas) NEPASIEKIA kliento pilnu tekstu nei per `/api/generate`, nei per `/api/jobs/:id`.
- `tests/groundingCheck.test.js` — leksinio persidengimo grounding check heuristika (`utils/groundingCheck.js`).
- `tests/jobStore.test.js` — job TTL valymo logika (completed/failed jobai pašalinami po TTL, queued/processing - niekada automatiškai).
- `tests/fasterWhisperEmbedded.test.js` — Node↔Python subprocess orkestracija (mock skriptu) - argumentų perdavimas, JSON parsingas, klaidos, timeout, laikino failo išvalymas.
- `tests/transcribeJobs.route.test.js` — asinchroninis `/api/transcribe-jobs` srautas, įskaitant patikrą, kad atsakymas grįžta GREITAI (<2s), nelaukiant viso transkribavimo.
- `tests/concurrencyLimiter.test.js` — `Semaphore` klasės unit testai (acquire/release, eilė, minimali riba).
- `tests/fasterWhisperConcurrency.test.js` — patikrina, kad `FASTER_WHISPER_MAX_CONCURRENCY` REALIAI serializuoja vienalaikes užklausas (matuojama laiko trukme, ne tik loginė patikra).
- `tests/groundingCheck.test.js` — leksinio persidengimo grounding check heuristika (buvęs `factCheck.test.js`, pervadinta terminologijos tikslumui).

CI (`.github/workflows/ci.yml`): `npm ci` → `node --check` → `npm test` (BE
`REDIS_URL` - route testai tikisi inline vykdymo) → **atskiras** žingsnis
`npm run test:redis` SU `REDIS_URL` (tikras Redis servisas CI runner'yje - dabar
paleidžia DU failus: `tests/queueRecovery.integration.test.js` IR
`tests/heartbeatReadiness.integration.test.js`) → realaus serverio smoke testas
prieš `/api/health`. Šis atskyrimas BŪTINAS - jei `REDIS_URL` būtų visam `npm test`,
route testai (pvz. `jobs.route.test.js`), kurie tikisi, kad jobas užsibaigs
INLINE tame pačiame procese, pereitų į BullMQ režimą ir amžinai liktų "queued"
(joks worker'is jų neapdorotų).

## Realaus audio testas (tikras 4 val. posėdžio įrašas)

Vartotojas pateikė tikrą lietuvišką posėdžio įrašą (4 val., 230MB MP3) realiam
sistemos išbandymui - ne sintetinį TTS balsą kaip ankstesniuose testuose. Tai
davė kelis genuine, tik su realiu turiniu atrandamus radinius:

**Modelio dydžio įtaka kokybei (tas pats 3 min lietuviško fragmentas, `tiny` vs `small`):**

| Modelis | Trukmė (3 min fragmentui) | Kokybė |
|---|---|---|
| `tiny` (~75MB) | 88s | Praktiškai nenaudojama - iš esmės haliucinuotas pseudo-lietuviškas tekstas |
| `small` (~484MB) | 127s | Nuoseklus, suprantamas lietuviškas tekstas su nedideliais netikslumais |

**Išvada:** `tiny` modelis NETINKA realiam lietuviškam susitikimui - tik demo/testų
tikslams su labai aiškia, lėta kalba (kaip ankstesnis `espeak-ng` testas). `small`
yra minimalus praktiškai naudotinas dydis lietuvių kalbai. Nebuvo patikrinta su
`medium`/`large-v3` (galėtų būti dar geriau), nei su GPU (`device=cuda`).

**Rastas ir ištaisytas realus prompt/UI trūkumas:** sugeneravus protokolą iš šio
realaus (triukšmingo) fragmento pagal `meeting_v2` taisykles, LLM (čia -
manualiai, laikantis tų pačių taisyklių) natūraliai grąžino `"nutarimai":
["Nenurodyta"]` vietoj tuščio masyvo `[]`, nes v2 promptas neatskyrė, kaip
elgtis su MASYVO laukais, kai nėra ką įrašyti (taisyklė kalbėjo tik apie scalar
laukus). Frontend'o `completeness()` (žr. `frontend/src/utils.js`) tuo metu
skaičiavo BET KOKĮ netuščią masyvą kaip "užpildytą", nepatikrindama turinio -
protokolas be jokio realaus nutarimo/dalyvio rodė klaidinančiai aukštą **80%**
pilnumo balą. Realus rezultatas turėjo būti **60%**.

**Sprendimas (abi pusės - "defense in depth"):**
1. `prompts/meeting_v3.js` (nauja numatyta versija) eksplicitiškai atskiria:
   scalar laukams trūkstant informacijos → `"Nenurodyta"`; masyvo laukams
   (dalyviai/darbotvarke/nutarimai) trūkstant bet ko → tuščias `[]`, NIEKADA
   `["Nenurodyta"]`.
2. `frontend/src/utils.js` `completeness()` dabar tikrina masyvo ELEMENTUS
   (`isMeaningfulValue()`), ne tik ilgį - net jei LLM (ar sena prompt versija)
   vis tiek grąžintų `["Nenurodyta"]`, balas bus teisingas.

Abu pataisymai turi regresijos testus (`tests/prompt.snapshot.test.js` v3 dalis,
`frontend/src/utils.test.js`), kurie PATIKRINTI, kad realiai pagautų seną klaidą
(laikinai grąžinau senąją logiką ir patvirtinau, kad testai subyra).

## Video failai (.mp4/.webm su vaizdo IR garso takeliu) - realiai patikrinta

Vartotojas gali įkelti ne tik gryną audio, bet ir video failą su garso takeliu
(pvz. Zoom/Teams įrašas su vaizdu, ekrano įrašymas). Tai REALIAI patikrinta:

- Sukūriau tikrą `.mp4` (H.264 vaizdas + AAC garsas) ir `.webm` (VP8 vaizdas +
  Opus garsas) su `ffmpeg`, abu su kalbos garso takeliu.
- Abu praėjo `utils/audioMagicBytes.js` patikrą - **MP4/WebM konteineris yra
  struktūriškai identiškas** nepriklausomai nuo to, ar jame yra tik audio, ar
  audio+video (tas pats `ftyp`/EBML antraštės formatas), tad atskirti vien pagal
  failo antraštę NEĮMANOMA (ir nereikia).
- Abu sėkmingai transkribuoti per PILNĄ `/api/transcribe` srautą su
  `faster-whisper-embedded` provideriu ir tikru modeliu - biblioteka (per
  ffmpeg/PyAV) automatiškai ištraukia TIK audio takelį ir ignoruoja vaizdą.

**Dėl to:**
- `ALLOWED_MIME_TYPES` (routes/transcribe.js) eksplicitiškai leidžia `video/mp4`
  ir `video/webm`, ne tik `audio/*` MIME tipus.
- Frontend'o failo pasirinkimo dialogo `accept` atributas praplėstas nuo
  `"audio/*"` iki `"audio/*,video/mp4,video/webm,.mp4,.webm"` - anksčiau griežtas
  `accept="audio/*"` kai kuriose naršyklėse/OS BŪTŲ PASLĖPĘS tikrus video failus
  failo pasirinkimo dialoge, nors backend'as juos realiai apdorotų teisingai.

**Neverifikuota (skirtingi tiekėjai elgiasi skirtingai):**
- OpenAI Whisper API dokumentacija patvirtina mp4/mpeg palaikymą (tikėtina veiks
  analogiškai), bet NEBUVO testuota su realiu raktu šioje aplinkoje.
- Azure/Google/Deepgram/AssemblyAI dažnai reikalauja žaliavinio audio encoding
  (LINEAR16/FLAC/OggOpus ir pan.), NE video konteinerio - tikėtina, kad video
  failą reikėtų pirma konvertuoti (pvz. `ffmpeg -i video.mp4 -vn audio.wav`)
  prieš siunčiant šiems tiekėjams. Nepatikrinta su realiais raktais.

**Praktinė pastaba dėl dydžio:** video takelis prideda nemažai baitų tai pačiai
garso trukmei - `MAX_UPLOAD_MB` (numatyta 50MB) pasieks ribą GREIČIAU su video
failu nei su vien audio tos pačios trukmės. Tai dar viena priežastis, kodėl
dydžio limitas ≠ trukmės kontrolė (žr. skyrių aukščiau apie `ffprobe`).

## Diagnostika ir startup patikros (pridėta po realaus RunPod diegimo)

Po realios diegimo sesijos eksperimentinėje mašinoje (kur pyannote 400 klaida
buvo "akla" - be jokių detalių) pridėta:

- **`npm run doctor`** - pilna aplinkos diagnostika (Node/Python/faster-whisper/
  CUDA/ffmpeg/RAM/diskas/raktai/išorinių servisų pasiekiamumas) su ✅/⚠️/❌
  ataskaita. Realiai patikrinta šioje aplinkoje.
- **Startup konfigūracijos validacija** - serveris NESTARTUOJA su logiškai
  nesuderinta konfigūracija (pvz. `LLM_PROVIDER=claude` be rakto) ir aiškiai
  išvardija, ko trūksta, vietoj kritimo pirmoje užklausoje. Avarinis apėjimas:
  `SKIP_CONFIG_VALIDATION=true`.
- **Startup self-check** - po starto spausdinamos ✅/❌ eilutės kiekvienam
  komponentui (Python importas, pyannote/whisper HTTP pasiekiamumas, raktai).
- **`GET /api/health/deep`** - tie patys patikrinimai per API (monitoringui);
  production'e reikalauja `x-audit-key`.
- **Pyannote klaidos dabar matomos**: 400 (ar kita) atsakymo kūnas pilnai
  loguojamas serveryje ir (apkarpytas) grąžinamas klaidoje kartu su dažniausių
  priežasčių sąrašu; `PYANNOTE_FILE_FIELD` leidžia suderinti multipart lauko
  pavadinimą be kodo keitimo.

## Ilgi įrašai: max_tokens ir deduplikacija (rasta su realiu 4 val. protokolu)

Realus 4 val. posėdžio protokolo generavimas žlugo su kriptiniu "Nepavyko gauti
validaus protokolo iš LLM po pakartotinio bandymo". Dvi TIKROSIOS priežastys:

1. **Hardcoded `max_tokens: 1500`** visuose LLM provideriuose - ilgo protokolo
   JSON nutrūkdavo viduryje, o repair retry (tuo pačiu limitu) nutrūkdavo lygiai
   taip pat. Ištaisyta: `ANTHROPIC_MAX_TOKENS` (num. 8000; ilgiems posėdžiams
   16000), nukirpimas dabar APTINKAMAS per API `stop_reason` ir grąžinama aiški
   klaida su rekomendacija, o ne kriptinė žinutė. Analogiškai GPT/Gemini.
2. **Whisper haliucinacinės kilpos** - realioje transkripcijoje viena frazė
   kartojosi ~280 kartų iš eilės (~2.3 val. tylos po posėdžio); pasikartojimai
   sudarė **28% viso teksto** (realiai išmatuota su vartotojo failu: 374
   fragmentai, ~6200 tokenų). `utils/transcriptDedup.js` sutraukia >=3
   identiškų iš eilės serijas į vieną + žymę "[kartojosi N kartų]" (žymė
   išsaugo prasmę - pvz. balsavimo "Taip." x30). Įjungta pagal nutylėjimą,
   `TRANSCRIPT_DEDUP=false` išjungia. Grounding check lieka su ORIGINALIA
   transkripcija.

## Kontrolinis sąrašas prieš testuojant su GPU / didesniu modeliu

Prieš paleidžiant `faster-whisper-embedded` su `device=cuda` ir/ar `medium`/
`large-v3` modeliu tikroje aplinkoje (ne šioje CPU-only sandbox), šie
pakeitimai jau padaryti kode/konfigūracijoje - bet PATIKRINKITE, ar jie
atitinka jūsų atvejį:

| # | Kas | Kodėl | Būsena |
|---|---|---|---|
| 1 | `MAX_UPLOAD_MB` | Numatyta buvo 50MB - realus 4 val. 128kbps MP3 sveria ~230MB. Padidinta iki 500MB. | ✅ Ištaisyta |
| 2 | `FASTER_WHISPER_EMBEDDED_TIMEOUT_MS` | Numatyta buvo 10 min - per mažai, nes apdorojimo trukmė NENUSPĖJAMA (mūsų testas: tylos segmentas užtruko 3x ilgiau nei kalbos segmentas tos pačios trukmės). Padidinta iki 1 val. | ✅ Ištaisyta |
| 3 | `scripts/requirements.txt` CUDA bibliotekos | `device=cuda` NEVEIKS be `nvidia-cublas-cu12`/`nvidia-cudnn-cu12` (oficialus faster-whisper reikalavimas). Pridėta į requirements.txt. | ✅ Ištaisyta |
| 4 | `LD_LIBRARY_PATH` automatinis nustatymas | Vien `pip install` neužtenka - CUDA bibliotekų kelias turi būti aplinkos kintamajame. `FasterWhisperEmbeddedProvider.js` dabar PATS apskaičiuoja ir nustato tai prieš paleisdamas Python su `device=cuda`, kad vartotojui nereikėtų rankomis `export`'inti. | ✅ Ištaisyta (bet ⚙️ netestuota su realiu GPU) |
| 5 | `FASTER_WHISPER_MAX_CONCURRENCY` GPU kontekste | Architektūra kiekvienai užklausai paleidžia NAUJĄ Python procesą (modelis įkeliamas į VRAM iš naujo, ne persistent serveris). Su concurrency>1 keli procesai vienu metu bandytų dalintis VRAM - rizikinga `medium`/`large-v3` modeliams. **Rekomendacija: nustatykite į 1 pirmam GPU testui.** | ⚠️ Reikalauja jūsų sprendimo (žr. `.env.example` komentarą) |
| 6 | Asinchroninis `/api/transcribe` endpoint'as | `POST /api/jobs` (async) egzistavo TIK protokolo generavimui. Dabar `POST /api/transcribe-jobs` + `GET /api/transcribe-jobs/:id` implementuoti IR frontend'as (`handleAutoTranscribe`) juos naudoja pagal nutylėjimą. **Tai buvo pakelta iš "🚧 roadmap" į "✅ būtina" po realaus radinio: RunPod HTTP proxy turi KIETĄ 100s limitą, nepriklausomą nuo šio backend'o nustatymų - sinchroninis kelias tiesiog neveiktų ilgesniems transkribavimams per tą proxy.** | ✅ Ištaisyta |

### Rate limiting polling endpoint'ams (rasta realiai naudojant su Windows + tikru modeliu)

Iš karto po `/api/transcribe-jobs` įdiegimo, realus testas su vartotoju (Windows,
`faster-whisper-embedded`, `small` modelis) atskleidė: `GET /api/jobs/:id` ir
`GET /api/transcribe-jobs/:id` (polling endpoint'ai, kviečiami kas ~3s) naudojo
TĄ PAČIĄ griežtą `RATE_LIMIT_MAX_REQUESTS=20/15min` ribą kaip brangūs POST
endpoint'ai. Bet kuris jobas, trunkantis ilgiau nei ~1 minutę (20 pollų × 3s =
60s), REALIAI gaudavo `429 Per daug užklausų` iš PATIES stebėjimo proceso - ne
dėl piktnaudžiavimo. Tai NEBUVO pastebėta automatiniais testais (mock provideris
visada baigia per milisekundes, tad niekada nepasiekdavo tiek pollų).

**Ištaisyta:** atskiras `pollRateLimiter` (žr. `middleware/rateLimiter.js`) su
žymiai laisvesne riba (numatyta 120/min, konfigūruojama per
`RATE_LIMIT_POLL_MAX_REQUESTS`), pritaikytas TIK `GET .../:id` maršrutams.
Patikrinta regresijos testu (`tests/rateLimit.route.test.js`), kuris PATVIRTINTA
pagautų seną klaidą (laikinai grąžinau senąją versiją - testas subyrėjo, kaip
ir turėjo).

### RunPod specifika (arba bet koks kitas HTTP proxy su trumpu timeout)

Jei diegiate šioje aplinkoje per RunPod (ar panašią GPU nuomos platformą su HTTP proxy):

1. **Naudokite `POST /api/transcribe-jobs`, NE `POST /api/transcribe`** tiesioginiam
   HTTP proxy pasiekimui (`https://{POD_ID}-{PORT}.proxy.runpod.net`). Frontend'as
   tai jau daro pagal nutylėjimą - jums nereikia nieko papildomai konfigūruoti.
2. **Arba naudokite TCP prievado eksponavimą** vietoj HTTP proxy (RunPod "Expose
   TCP Ports"), jei norite naudoti sinchroninį `/api/transcribe` - tai apeina
   100s limitą visai, bet netenkate automatinio HTTPS ir gaunate kintantį IP/prievadą.
3. **`CORS_ORIGIN`** turės būti nustatytas į jūsų frontend'o RunPod proxy URL
   (ne `http://localhost:5173`), kitaip naršyklė blokuos užklausas.
4. Ši konfigūracija **patikrinta realiai su veikiančiu RunPod pod'u**: pilnas srautas
   (Whisper transkripcija + pyannote diarizacija) apdorojo ~4 val. įrašą iki galutinio
   protokolo. Testo metu rasti ir pataisyti defektai: fiksuotas 90s HTTP timeout (dabar
   proporcingas failo trukmei), portų konfliktas su RunPod nginx, halucinacijų filtras
   ir `numSpeakers` perdavimas. Žinomi apribojimai - žr. `RUNPOD.md`.

**Kaip patikrinti #4 (LD_LIBRARY_PATH) veikia jūsų aplinkoje**, kai turėsite GPU:
```bash
node -e "
const P = require('./providers/transcription/FasterWhisperEmbeddedProvider');
new P({device:'cuda'})._resolveCudaLibraryPath().then(console.log);
"
# Turėtų grąžinti kelią (ne null), jei nvidia-cublas-cu12/nvidia-cudnn-cu12 įdiegti.
```

## Transkribavimo progreso rodymas (realiai patikrinta)

Ilgas transkribavimas (ypač CPU su didesniu modeliu) gali užtrukti minutes be
jokio grįžtamojo ryšio - vartotojas nežino, ar procesas dirba, ar užstrigo.
Tai išspręsta REALIU progreso sekimu, ne fiktyviu sukimosi indikatoriumi:

- `scripts/faster_whisper_transcribe.py` spausdina `PROGRESS:{"current":X,"total":Y}`
  eilutę į stderr po KIEKVIENO segmento (faster-whisper segmentus grąžina
  palaipsniui, ne visus iš karto).
- `FasterWhisperEmbeddedProvider.js` skaito stderr REALIU LAIKU ir, jei
  perduotas `onProgress` callback, iškviečia jį su kiekvienu atnaujinimu.
- `routes/transcribeJobs.js` šį progresą įrašo į `jobStore`, tad
  `GET /api/transcribe-jobs/:id` grąžina einamąjį `progress: {current, total}`.
- Frontend'as (`formatTranscribeProgress()` `utils.js`) tai rodo kaip
  `1:30 / 10:00 · 15%` mygtuke poll'inimo metu.

**Realiai patikrinta** (ne tik teoriškai) su tikru `small` modeliu ir tikru
audio failu - progresas judėjo `20.5s → 46.5s iš 180s` tarp poll'ų, tiksliai
atspindėdamas realų apdorojimo tašką garso įraše.

Kiti tiekėjai (Mock, HTTP-pagrįsti tiekėjai) progreso negrąžina - tokiu atveju
frontend'as tiesiog rodo bendrą "apdorojama..." be tikslaus laiko/procento.

## Faster-Whisper: du diegimo profiliai (desktop vs. server)

Transkribavimo PROVIDERIS slepia vykdymo būdą nuo likusios sistemos - `routes/
transcribe.js` visada tiesiog kviečia `transcriptionProvider.transcribe(...)` ir
negauna jokios informacijos apie tai, kaip konkrečiai vyksta transkribavimas po
šia sąsaja. Tai leidžia turėti DU visiškai skirtingus vykdymo būdus TAM PAČIAM
faster-whisper modeliui, priklausomai nuo diegimo scenarijaus:

| Diegimas | `TRANSCRIPTION_PROVIDER` | Kaip veikia |
|---|---|---|
| **Sekretorės / vieno vartotojo kompiuteris** | `faster-whisper-embedded` | `FasterWhisperEmbeddedProvider.js` paleidžia VIENĄ trumpalaikį Python procesą PER užklausą (`scripts/faster_whisper_transcribe.py`), kuris tiesiogiai kviečia `faster_whisper.WhisperModel(...)`. **Jokio atskiro serviso ar prievado** - vartotojas jo nemato ir jam nereikia nieko papildomai paleisti/stebėti. |
| **Bendras įmonės serveris** | `faster-whisper-server` (arba senas alias `faster-whisper`) | `FasterWhisperProvider.js` tikisi ATSKIRAI paleisto, ilgai gyvenančio HTTP serviso - modelis įkeliamas VIENĄ kartą ir laikomas atmintyje tarp užklausų (efektyviau, kai daug vartotojų dalinasi ta pačia GPU). |

Abu implementuoja TĄ PATĮ `TranscriptionProvider` kontraktą - persijungimas tarp jų
yra tik vienas env kintamojo pakeitimas, jokio kito kodo keisti nereikia.

### "Embedded" profilio paleidimas

```bash
pip install -r scripts/requirements.txt   # faster-whisper Python paketas
```

```bash
TRANSCRIPTION_PROVIDER=faster-whisper-embedded
FASTER_WHISPER_MODEL=small        # tiny/base/small/medium/large-v3 - didesnis = tikslesnis, bet lėtesnis
FASTER_WHISPER_DEVICE=cpu         # arba "cuda", jei yra NVIDIA GPU
FASTER_WHISPER_COMPUTE_TYPE=int8  # int8 (greičiau CPU) arba float16 (GPU)
FASTER_WHISPER_MAX_CONCURRENCY=2  # kiek vienalaikių subprocess'ų leidžiama - apsauga nuo CPU/RAM prisotinimo
```

**Concurrency limiter (patikrinta):** `utils/concurrencyLimiter.js` - paprastas
semaforas, ribojantis vienalaikių Python subprocess'ų skaičių. Papildomos
užklausos LAUKIA eilėje (ne atmetamos), kol atsilaisvina vieta. Patikrinta
automatiniu testu (`tests/fasterWhisperConcurrency.test.js`) - 3 vienalaikės
užklausos su limitu=1 realiai vykdomos IŠ EILĖS, ne lygiagrečiai (išmatuota
laiko trukme). Tai NĖRA tikras worker pool su prioritetais/paskirstymu tarp
mašinų - tik in-process apsauga nuo CPU saturacijos vienoje mašinoje.

**Modelio atsisiuntimas:** TAI JAU YRA įdiegta pačioje `faster-whisper`/
`huggingface_hub` bibliotekoje - `WhisperModel(...)` konstruktorius PATS
patikrina lokalų cache (`~/.cache/huggingface`) ir, jei modelio nėra,
automatiškai jį atsisiunčia pirmo iškvietimo metu. Šis projektas NEIMPLEMENTAVO
jokios papildomos "model manager" logikos - tai jau built-in.

### Sąžiningai apie testavimo apimtį (ATNAUJINTA - realiai patikrinta su tikru modeliu)

- ✅ **Node↔Python subprocess orkestracija PATIKRINTA** automatiniais testais
  (`tests/fasterWhisperEmbedded.test.js`) su MOCK Python skriptu.
- ✅ **Realus transkribavimas su tikru faster-whisper `tiny` modeliu - DABAR PATIKRINTA.**
  Vartotojas atsiuntė konvertuotus CTranslate2 `tiny` modelio failus (`model.bin`,
  `config.json`, `tokenizer.json`, `vocabulary.txt`), kuriuos užkroviau iš LOKALAUS
  katalogo (`WhisperModel("/kelias/iki/modelio", ...)`) - be jokio kreipimosi į
  `huggingface.co`. Rezultatai:
  - Modelis užsikrovė per ~2s.
  - Su `espeak-ng` sugeneruota anglų kalbos garso įrašu ("Hello, this is a test of
    the transcription system...") per **visą HTTP srautą** (`POST /api/transcribe`
    → `FasterWhisperEmbeddedProvider` → Python subprocess → `faster-whisper`)
    gavau: *"Hello, this is a test **on** the Transcription system. We are checking
    if it works correctly."* - beveik tobula (viena žodžio paklaida, tikėtina dėl
    robotizuoto TTS balso ir `tiny` modelio dydžio).
  - **Svarbus radinys:** `routes/transcribe.js` numatytai priverčia `language=lt`,
    jei klientas nenurodo kitaip. Su anglišku audio + priverstiniu `lt` modelis
    bandė girdėti anglų kalbą KAIP lietuvišką ir grąžino iškraipytą pseudo-lietuvišką
    tekstą. Tai NĖRA bug'as - tai tikėtinas elgesys priverčiant neteisingą kalbą.
    Frontend'as/API naudotojas turi nurodyti teisingą `language` parametrą, jei
    audio ne lietuviškas (arba palikti tuščią automatiniam aptikimui - žr. žemiau).
  - `info.language_probability` (mūsų `confidence` lauke) grąžino `1.0`, kai kalba
    nurodyta eksplicitiškai, ir `~0.40` bandant aptikti kalbą iš gryno tono be
    kalbos - abu atrodo teisingi/nuoseklūs signalai.
  - JSON atsakymo forma (`text`, `segments[].start/end/text`, `language`,
    `confidence`) TIKSLIAI atitiko tai, ko tikėjosi `FasterWhisperEmbeddedProvider.js`
    - jokių pakeitimų kode nereikėjo.
- ⚙️ **Ko VIS DAR nepatikrinau:** realios (ne TTS) žmogaus kalbos, lietuvių kalbos
  transkripcijos kokybės, didesnių modelių (`small`/`medium`/`large-v3`), GPU
  (`device=cuda`) veikimo, ilgesnių (>1 min) įrašų, kelių kalbėtojų.
- ⚠️ **`Dockerfile` NEĮTRAUKIA Python/faster-whisper.** `embedded` profilis
  numatytas natūraliam (native) Node paleidimui tiesiog vartotojo kompiuteryje
  (`npm start`), NE per pateiktą Docker image - jei norite `embedded` profilį
  naudoti konteineryje, reikės pridėti Python + `pip install -r scripts/
  requirements.txt` į `backend/Dockerfile` patiems (nepridėta numatytai, kad
  neišpūstų image dydžio tiems, kam `embedded` profilis nereikalingas).

## Diarizacija — nepriklausomas komponentas nuo transkribavimo

Anksčiau `diarize` buvo tik požymis, perduodamas TIESIAI transkribavimo tiekėjui - tai
reiškė, kad diarizacija veikė TIK su tiekėjais, kurie ją patys moka (Azure/Google/
Deepgram/Mock), o Whisper (kuris diarizacijos apskritai nemoka) negalėjo jos gauti
jokiu būdu.

Dabar tai du nepriklausomi komponentai su savo factory ir env kintamuoju:

```
TRANSCRIPTION_PROVIDER=whisper     # transkribavimas - bet koks tiekėjas
DIARIZATION_PROVIDER=pyannote      # diarizacija - VISIŠKAI nepriklausomas pasirinkimas
```

`DIARIZATION_PROVIDER` reikšmės:

| Reikšmė | Ką reiškia |
|---|---|
| `none` (numatyta) | Diarizacijos nėra |
| `inline` | Pasitikima PAČIU `TRANSCRIPTION_PROVIDER`, jei jis moka diarizuoti (Azure/Google/Deepgram/Mock) - vienas API kvietimas, kaip anksčiau |
| `mock` | Testams/demo, be jokio rakto |
| `pyannote` | Atskiras lokalus etapas (savo HTTP serveris) - veikia su BET KOKIU transkribavimo tiekėju, įskaitant Whisper |
| `pyannote-cloud` | pyannote.ai — komercinė, tik diarizacijai skirta API |
| `assemblyai` | AssemblyAI diarizacija (transkripcija atmetama, naudojami tik kalbėtojų intervalai) |

Kai pasirinktas atskiras etapas (bet kas, išskyrus `none`/`inline`), `routes/transcribe.js`:
1. paprašo `TRANSCRIPTION_PROVIDER` GRYNOS transkripcijos (be diarizacijos užklausos jam pačiam);
2. nepriklausomai paprašo `DIARIZATION_PROVIDER` kalbėtojų intervalų iš to paties audio;
3. sujungia abu rezultatus per `utils/mergeDiarization.js` — kiekvienam transkripcijos
   segmentui priskiria kalbėtoją iš diarizacijos intervalo su didžiausiu laiko persidengimu.

Tai patikrinta automatiniais testais (`tests/mergeDiarization.test.js`,
`tests/diarization.route.test.js`) - įskaitant scenarijų, kai atskiras diarizacijos
etapas PERRAŠO transkribavimo tiekėjo pačio (mock) speaker laukus.

## Kas realiai patikrinta veikiant vs. kas yra dokumentuota sąsaja

**Trumpai: `mock`, `Claude` ir `faster-whisper-embedded` yra verifikuoti šiame demo**
(pastarasis - su vartotojo pateiktais tikrais `tiny` ir `small` modeliais, žr. skyrius aukščiau).
Likę tiekėjai yra adapterių pavyzdžiai (adapter examples) pagal jų viešą API
dokumentaciją - jie NEBUVO paleisti su realiu raktu šioje aplinkoje. Kad tai
nebūtų vienoda "juoda dėžė" - žemiau suskirstyta pagal RIZIKOS lygį, ne tik
binariai "veikia/neveikia":

**Tier 1 - Verifikuota:**
| Tiekėjas | Būsena |
|---|---|
| `MockTranscriptionProvider`, `MockLLMProvider`, `MockDiarizationProvider` | ✅ Paleista, patikrinta automatiniais testais šioje aplinkoje |
| `FasterWhisperEmbeddedProvider` ("desktop" profilis) | ✅ Paleista su TIKRU `tiny` modeliu (vartotojo atsiųsti CTranslate2 failai) - pilnas HTTP srautas, teisinga transkripcija patvirtinta |
| `ClaudeProvider` | ✅ Paleista, patikrinta su realiu `ANTHROPIC_API_KEY` |

**Tier 2 - Paprastas, standartinis REST kontraktas (didesnė tikimybė, kad veiks be pakeitimų):**
| Tiekėjas | Būsena |
|---|---|
| `GPTProvider`, `GeminiProvider` | Vienas sinchroninis POST kvietimas, tas pats šablonas kaip verifikuotas `ClaudeProvider` - žemesnė rizika nei async/multi-step tiekėjai žemiau |
| `WhisperProvider` (OpenAI) | Vienas sinchroninis multipart POST, standartinis SDK-lygio kontraktas |
| `DeepgramProvider` | Vienas sinchroninis POST su query parametrais, paprasčiausias ASR REST šioje grupėje |

**Tier 3 - Sudėtingas/asinchroninis kontraktas (didesnė rizika, kad kokia nors detalė neatitiks be jūsų testavimo):**
| Tiekėjas | Būsena |
|---|---|
| `AzureSpeechProvider` | Daugiapakopis submit→poll→fetch srautas, reikalauja iš anksto įkelto audio URL (Blob Storage) |
| `GoogleSpeechProvider` | Sinchroninis, bet tik trumpiems įrašams - ilgesniems reikėtų kito (longrunningrecognize) endpoint'o, kurio čia NĖRA |
| `PyannoteCloudDiarizationProvider` | Asinchroninis submit→poll, reikalauja audio URL |
| `AssemblyAIDiarizationProvider` | Daugiapakopis upload→submit→poll srautas |
| `FasterWhisperProvider`, `PyannoteDiarizationProvider` (lokalūs, "server" profilis) | Reikalauja JŪSŲ atskirai paleisto serverio - kontraktas priklauso nuo TO serverio implementacijos, ne tik šio kodo |

Kiekvienas neverifikuotas tiekėjo failas dabar turi tiesiogiai kode `STATUS:` žymą
(pvz. `STATUS: interface implemented, integration not verified with a real API key
in this environment`), kad techninis skaitytojas nereikėtų pasitikėti vien README.

**Svarbu apie `MockLLMProvider`:** tai NĖRA tikras LLM — tai regex/heuristikos, kurios
ištraukia pavadinimą/datą/dalyvius/veiksmus iš JŪSŲ realiai pateiktos transkripcijos
(žr. `providers/llm/MockLLMProvider.js`), kad demo nerodytų to paties statinio
rezultato nepriklausomai nuo įvesties. Kokybė žymiai prastesnė nei tikro LLM - tinka
demonstruoti architektūrą ir end-to-end srautą, ne kokybę.

## Architektūros sprendimai → jūsų sąrašo punktai

1. **Raktas ne frontend'e** → visi `providers/*` skaito raktus iš `process.env`, niekada iš kliento užklausos. Frontend'as (`stenograma.jsx`) **neturi jokio** tiesioginio LLM kvietimo iš naršyklės — jei backend nepasiekiamas, sąsaja tai parodo ir generavimo mygtukas išjungiamas, jokio "demo fallback" per naršyklę nėra.
2. **Automatinis transkribavimas** → `POST /api/transcribe`, provideris parenkamas per `TRANSCRIPTION_PROVIDER`.
3. **Speaker diarization** → ATSKIRAS komponentas nuo transkribavimo (`providers/diarization/*` + `DIARIZATION_PROVIDER` env + `utils/mergeDiarization.js`) - žr. skyrių „Diarizacija" aukščiau. Leidžia derinius kaip Whisper transkripcija + pyannote diarizacija, kurių anksčiau nebuvo galima sudaryti (Whisper pats diarizuoti nemoka).
4. **Timestamps** → `segments[].start/end`, promptas (`meeting_v1.js`) juos naudoja, jei yra.
5. **Redagavimas prieš eksportą** → frontend'e (žr. `stenograma.jsx`) protokolas po generavimo yra redaguojamų laukų rinkinys, ne statinis tekstas.
6-7. **DOCX/PDF** → frontend generuoja TIKRĄ OOXML `.docx` naršyklėje (`docx` npm paketas, `Packer.toBlob`) - patikrinta, kad rezultatas yra genuinis "Microsoft Word 2007+" formatas (`file` komanda), ne HTML su .doc plėtiniu. Trūksta įmonės logotipo/šablono - tai lengva pridėti (žr. Roadmap). CSV veiksmams jau yra. PDF eksporto dar nėra.
8. **Promptų versijavimas** → `prompts/meeting_v1.js`, registruojama `prompts/index.js`, versija įrašoma į audit log.
9. **Konfigūruojami LLM** → `providers/llm/index.js` factory + `LLM_PROVIDER` env.
10. **Konfigūruojamas transkribavimo variklis** → `providers/transcription/index.js` factory + `TRANSCRIPTION_PROVIDER` env.
11. **JSON Schema validacija** → `schema/protocolSchema.js`, su retry/repair logika `routes/generate.js` viduje (1 pakartotinis bandymas).
12. **Hallucination guard** → promptas eksplicitiškai draudžia spėlioti; PAPILDOMAI, nuo LLM nepriklausomas leksinio persidengimo patikrinimas implementuotas `utils/groundingCheck.js` (žr. punktą 27 žemiau) - pažymi žemo pasitikėjimo veiksmus, bet tai NĖRA semantinis/embedding-based tikrinimas (rekomendacija ateičiai: antras LLM kvietimas su NLI/fact-check promptu, arba embedding similarity).
13. **Kokybės vertinimas** → `confidence` laukas kontrakte ateina iš transkribavimo tiekėjo; protokolo pilnumo % skaičiuojamas frontend'e (kiek laukų = "Nenurodyta").
14. **CSV eksportas** → frontend, `Papa.unparse` veiksmų lentelei.
15. **Audit log** → `utils/auditLog.js`, endpoint'as `GET /api/audit`, apsaugotas `middleware/auditAuth.js` (`x-audit-key` header arba uždarytas produkcijoje). MVP - atmintyje; produkcijai pakeisti į DB lentelę (schema jau atitinka).
16. **Provider override apsauga** → `/api/generate` ir `/api/transcribe` priima `llmProviderOverride`/`provider` laukus tik kai `ALLOW_PROVIDER_OVERRIDE=true`, ir tik iš whitelist (`REGISTRY`/`PROMPTS` raktų) - joks laisvas tekstas.
17. **Upload atmintis** → `multer.diskStorage` vietoj `memoryStorage`, numatytas `MAX_UPLOAD_MB=50`, laikinas failas ištrinamas po apdorojimo.
18. **Endpoint autentifikacija** → `middleware/apiKeyAuth.js` saugo `/api/generate` ir `/api/transcribe` (bendras `API_KEY`, ne per-user auth - žr. įspėjimą aukščiau).
19. **Rate limiting** → `middleware/rateLimiter.js` (`express-rate-limit`), numatyta 20 užklausų / 15 min vienam IP, konfigūruojama per `RATE_LIMIT_*` env.
20. **Health endpoint neatskleidžia infrastruktūros viešai** → `server.js` `/api/health` produkcijoje grąžina tik `{status:"ok"}`, nebent `HEALTH_DETAILS=public` arba teisingas `x-audit-key`.
21. **Upload MIME/plėtinio validacija** → `routes/transcribe.js` `fileFilter` atmeta bet ką, kas nėra mp3/wav/m4a/mp4/webm/ogg/aac/flac (nei pagal mimetype, nei pagal plėtinį).
22. **Timeout + retry išoriniams API** → `utils/httpClient.js` (`fetchWithTimeout`/`fetchWithRetry`), naudojama visuose tiekėjuose (Claude/GPT/Gemini/Whisper/Deepgram/Azure/Google/pyannote/AssemblyAI).
23. **Prompt injection mitigation** → įdiegta `meeting_v2.js`, patobulinta `meeting_v3.js` (dabar numatyta versija) eksplicitiškai nurodo, kad transkripcija yra duomenys, ne instrukcijos; `meeting_v1.js` paliktas nepakeistas atgaliniam suderinamumui. **Terminologijos tikslumas:** tai yra prompt-level *mitigation* (sumažina riziką), NE *protection* (pilna apsaugos garantija) - LLM vis tiek gali būti paveiktas gudriai suformuluotos transkripcijos; tikra apsauga reikalautų output validacijos sluoksnio (dalinai yra - žr. punktą 27, grounding check) arba specializuoto injection-detection modelio priešais LLM kvietimą.
30. **Scalar vs masyvo laukų disambiguacija** → `meeting_v3.js` (rasta testuojant su tikru audio, žr. "Realaus audio testas" skyrių aukščiau) - aiškiai atskiria, kad trūkstant scalar reikšmės rašoma "Nenurodyta", o trūkstant BET KO masyvo lauke grąžinamas tuščias `[]`, ne `["Nenurodyta"]`. Kartu ištaisytas `frontend/src/utils.js` `completeness()`, kad tikrintų masyvo turinį, ne tik ilgį.
24. **Docker demo veikia iš karto** → `docker-compose.yml` numatyta `NODE_ENV=development` (ne `production`), kad `docker compose up` neuž strigtų su 503 dėl tuščio `API_KEY`. Produkcijai reikia sąmoningai perjungti - žr. komentarą compose faile.
25. **Magic bytes / turinio sniffing** → `utils/audioMagicBytes.js` tikrina TIKRĄ failo antraštę (ne tik pavadinimą/mimetype), kad pervadintas `.exe -> .mp3` failas būtų atmestas. Sąžiningai NE antivirusinis skenavimas.
26. **Klaidų sanitizavimas** → `utils/sanitizeError.js` - tikros (500) vidinės/tiekėjo klaidos niekada nepasiekia kliento pilnu tekstu (pvz. trūkstamas raktas, tiekėjo endpoint'o klaida); pilnas tekstas visada logguojamas serveryje. 4xx/502 (validacija, whitelist, LLM schema klaida) lieka detalūs, nes tai saugu ir naudinga.
27. **Grounding check sluoksnis veiksmams** → `utils/groundingCheck.js` - nepriklausomas nuo LLM leksinio persidengimo patikrinimas kiekvienam "veiksmai" įrašui (`_grounding.verified`), rodomas frontend'e kaip įspėjimas. Sąžiningai NE semantinis fact-checking - žr. apribojimus faile.
28. **Job TTL** → `utils/jobStore.js` automatiškai išvalo COMPLETED/FAILED jobus po `JOB_TTL_MINUTES` (numatyta 60 min), kad atmintis nepildytųsi be galo.
29. **Live įrašymo stale closure pataisymas** → `frontend/src/App.jsx` `recognition.onend` anksčiau tikrino `isRecording` state kintamąjį, kuris "įšaldavo" (stale closure) - jei Web Speech API pati nutraukdavo atpažinimą (pvz. po tylos), automatinis restart NEVEIKDAVO patikimai. Dabar naudojamas `isRecordingRef` (sinchroniškai atnaujinamas ref), kuris visada atspindi tikrą būseną.

## Ko sąmoningai NEBUVO daryta (ir kodėl)

- Real Azure/Google/GPT/Gemini/pyannote-cloud/AssemblyAI testai - reikalauja jūsų apmokamų paskyrų raktų.
- **Semantinis** fact-checking (embedding similarity arba antra LLM validacija) - `utils/groundingCheck.js` implementuoja tik LEKSINĮ (žodžių persidengimo) patikrinimą, kuris pagauna akivaizdžiai sugalvotus faktus, bet NE LLM perfrazavimą kitais žodžiais. Semantinė versija - aiškiai pažymėtas kitas žingsnis.
- Įmonės logotipas/šablonas realiame `.docx` eksporte - pats `.docx` generavimas jau implementuotas (`docx` npm paketas naršyklėje), bet firminis stilius (logotipas, spalvos, parašų vietos vietoj paprasto teksto) reikalauja jūsų konkretaus stiliaus, tad palikta kaip aiškiai pažymėta tolimesnio darbo dalis.
- Antivirusinis audio failų skenavimas (ClamAV ir pan.) - `utils/audioMagicBytes.js` tikrina tik failo antraštės signature, ne pilną turinį; realaus turinio skenavimas reikalautų atskiro servizo/infrastruktūros.
- Tikra job queue su retry politika/dead-letter/keliais worker procesais - `utils/jobStore.js` yra tyčia paprasta asinchroninio API abstrakcija su in-memory saugykla ir TTL, NE tikra queue sistema; Redis/BullMQ/SQS migracija paliekama kaip aiškiai pažymėtas kitas žingsnis (sąsaja tam suprojektuota).
- Audit log su retention politika, PII redagavimu, paieška ar eksportu - dabartinis `utils/auditLog.js` yra in-memory masyvas be jokios iš išvardintų savybių; DB schema (SQLite/Postgres) - kitas žingsnis, kai bus aišku, kokie query realiai reikalingi.
