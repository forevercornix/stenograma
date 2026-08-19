# Job gyvavimo ciklas: būsenos, fazės ir progresas

Šis dokumentas atsako į klausimą, kurio iki #154 niekur nebuvo užrašyto:
**kokias būsenas job'as gali turėti, kaip tarp jų juda ir ką reiškia rodomas
progresas.**

Iki #154 `status` buvo vienintelis signalas, o `processing` reiškė bet ką:
validaciją, transkripciją, diarizaciją, sujungimą ar protokolo generavimą.
Vartotojui tai atrodė kaip „kažkas vyksta", o transkripcijai pasiekus 100 % ir
diarizacijai neteikiant progreso — kaip „pakibo ties 100 %".

---

> **Pastaba redaguojantiems.** Fazių grafai apgaubti
> `<!-- PHASE-GRAPH:<tipas> -->` žymėmis. `jobLifecycleDocumentation` testas
> parsina būtent šiuos blokus, paverčia PERĖJIMŲ BRIAUNOMIS ir lygina su
> `transitionsForType()`.
>
> Tikrinamos briaunos, ne fazių aibė: `validating → diarizing → transcribing`
> turi tas pačias fazes kaip teisingas kelias, bet state machine tokį gyvavimo
> ciklą atmeta. Be žymių testas tikrintų tik „fazė kažkur dokumente paminėta".
>
> Grafai yra **PILNI**, ne poaibis: testas tikrina abi kryptis — dokumente
> negali būti perėjimo, kurio kodas neleidžia, IR kodo leidžiamas perėjimas
> negali būti praleistas dokumente. Pridėjus naują briauną `GRAPHS`, dokumentą
> privalu papildyti.

## Duomenų modelis

```
{
  status: "queued" | "processing" | "completed" | "failed" | "cancelled",
  phase: "validating" | "transcribing" | "diarizing" | "merging"
       | "generating_protocol" | null,
  progress: { current: number, total: number } | null,
  progressKnown: boolean
}
```

### `status × phase` invariantas

| `status` | `phase` | `progress` | `progressKnown` |
|---|---|---|---|
| `queued` | `null` | `null` | `false` |
| `processing` | žinoma fazė (privaloma) | pagal fazę ir providerį | pagal fazę ir providerį |
| `completed` / `failed` / `cancelled` | `null` | `null` | `false` |

Tai **store lygio invariantas**, ne UI konvencija. `jobStore.update()` atmeta
neapdorotą `status`, `phase`, `progress` ar `progressKnown` rašymą — perėjimus
valdo `utils/jobPhase.js`, o store juos siūlo per `startPhase()`, `restart()`,
`reportProgress()` ir `finish()`.

⚠️ Naujas writer'is **negali** sukurti `processing + phase=null`. Legacy
įrašams (iš prieš #154) tai read-compatibility klausimas, ne writer'io
kontraktas.

---

## Du atskiri fazių grafai

**Nėra vieno bendro job lifecycle.** `queues/register.js` registruoja du
nepriklausomus processor'ius, ir ASINCHRONINIAME kelyje `generateProtocol()`
kviečiamas tik `protocolProcessor` viduje. Transkripcijos job'as protokolo
negeneruoja.

> **`generateProtocol()` turi ir SINCHRONINĮ kvietėją.** `routes/generate.js`
> kviečia jį tiesiogiai iš `POST /api/generate` — be job'o ir be `onPhase`.
> Tokia užklausa fazių apskritai neturi: atsakymas grąžinamas iš karto, tad
> nėra ko stebėti.
>
> Praktinė pasekmė: `protocolService` **negali** priklausyti nuo eilės ar job
> būsenos. `onPhase` yra neprivalomas (`onPhase?.()`), o šis dokumentas aprašo
> tik asinchroninį kelią.

### `transcription`

<!-- PHASE-GRAPH:transcription -->
```
validating → transcribing → diarizing → merging → completed
validating → transcribing → completed
```
<!-- /PHASE-GRAPH -->

Nelegali fazė: **`generating_protocol`**.

**Kada praleidžiamos `diarizing` ir `merging`.** `transcriptionService.js:140`
sąlyga yra `diarize && mode !== "none" && mode !== "inline"`, tad trumpasis
kelias galioja visais trim atvejais:

| Atvejis | |
|---|---|
| `diarize` neprašyta | užklausoje nėra diarizacijos prašymo |
| `DIARIZATION_PROVIDER=none` | diarizacija išjungta konfigūracijoje |
| `mode = "inline"` | **natyvi** providerio diarizacija — atskiro žingsnio nėra |

⚠️ Trečiasis atvejis lengvai pražiūrimas: provideris sukonfigūruotas, bet
diarizacija vyksta transkripcijos viduje, tad atskiros fazės nėra.

`merging` susieta su diarizacija — `transcriptionService.js` kviečia
`mergeDiarization(segments, turns)`, tad be diarizacijos nėra ko sujungti.
Išjungus ją, praleidžiamos **abi** fazės.

### `protocol`

<!-- PHASE-GRAPH:protocol -->
```
validating → generating_protocol → completed
```
<!-- /PHASE-GRAPH -->

Nelegalios fazės: **`transcribing`**, **`diarizing`**, **`merging`**.

⚠️ Tai state-machine invariantas, ne „tokio perėjimo šiuo metu nekviečiame".
Helperis atmeta neleistiną `(type, phase)` porą.

### Terminalūs perėjimai

Iš **bet kurios** `processing` fazės legalūs:

<!-- TERMINAL-TRANSITIONS -->
```
processing/<bet kuri fazė> → completed | failed | cancelled
queued                     → failed | cancelled        (NE completed)
```
<!-- /TERMINAL-TRANSITIONS -->

`queued → failed` yra realus kelias: `routes/transcribeJobs.js` pažymi job'ą
`failed`, kai `enqueue` nepavyksta. `queued → completed` uždraustas —
nevykdytas darbas negali būti baigtas sėkmingai.

### Perpaleidimas (BullMQ retry)

`restart()` yra **atskira operacija**, ne atgalinis šuolis grafe. Worker'iui
kritus job'as gali būti bet kurioje fazėje, o retry paleidžia processor'ių iš
naujo — tad fazė ir progresas resetinami į grafo pradžią. Legalus iš `queued`
ir `processing`; iš terminalaus — ne.

---

## Progresas

`progress` yra **fazei lokalūs darbo vienetai**. UI jų neinterpretuoja kaip
sekundžių, segmentų ar bet ko konkretaus — jis skaičiuoja tik `current / total`.

Kai `progressKnown = true`, privalo galioti:

| Sąlyga | |
|---|---|
| `Number.isFinite(current)` | baigtinis skaičius |
| `Number.isFinite(total)` | baigtinis skaičius |
| `total > 0` | dalyba prasminga |
| `current >= 0` | |
| `current <= total` | nėra virš 100 % |

### `progressKnown ↔ progress`

| `progressKnown` | `progress` |
|---|---|
| `false` | **privalo** būti `null` |
| `true` | **privalo** būti validus `{current, total}` |

Būsena `progressKnown=true, progress=null` neleidžiama.

`progressKnown` yra **runtime savybė, ne `phase` išvestinė**. Šiandien pyannote
progreso neteikia, tad `diarizing → progressKnown=false`. Bet kitas diarizacijos
provideris ateityje gali jį teikti, tad laukas persistinamas atskirai.

### Monotoniškumas

Galioja **`(jobId, phase)`** ribose, ne visam job'ui:

```
transcribing: 1000 → 2000 → 1500 → 3000     matoma: 1000 → 2000 → 3000
```

`total` **stabilus fazės epochoje**. `50/100 → 60/200` atmetama: `current`
auga, bet UI procentas kristų nuo 50 % iki 30 %.

Pakeitus fazę prasideda **nauja progreso epocha**:

```
transcribing 4420/4420 → diarizing progress=null
```

Tai nėra kritimas nuo 100 % iki 0 % — tai nauja fazė su atskira semantika.

### Pavėlavę įvykiai

Progreso įvykis neša fazę, kuriai priklauso, ir priimamas tik kai
`event.phase === job.phase`:

```
transcribing progress=4000
→ phase=diarizing
→ pavėlavęs transcribing progress=4200     ← ATMETAMAS
```

Redis kelyje ši patikra atliekama **atominiai** (Lua CAS), nes tarp skaitymo ir
rašymo fazė gali pasikeisti — `utils/jobStore/redisStore.js`
`reportProgressAtomic()`.

⚠️ **Tai reikalinga IR memory backend'ui.** Ankstesnis teiginys („CAS čia
nereikalingas, nes `get` ir `update` vyksta be `await` tarp jų") buvo
neteisingas: fasadas daro `await store.get(id)`, ir tas `await` atveria langą.
Lygiagretūs progreso callback'ai abu nuskaito tą patį snapshot'ą — pradžia 50,
vienu metu 60 ir 55, išsaugoma **55**. Progreso kelias yra fire-and-forget, tad
persidengimas vyksta natūraliai.

Abu backend'ai turi `reportProgressAtomic()`, ir jų pašalinimas grąžintų
monotoniškumo regresiją.

---

## ⚠️ Monotoniškumas NĖRA media-level resume

Persistintas `phase=transcribing, progress=1872/4420` **nereiškia**, kad po
worker restarto Whisper tęs nuo 1872 sekundės.

Monotoniškumo tikslas — neleisti pasenusiems ar pakartotiems įvykiams sumažinti
**rodomo** progreso. Realaus apdorojimo atnaujinimo jis negarantuoja. Būtent
todėl `restart()` progresą resetina: palikus jį UI rodytų 42 %, kai darbas yra
ties 0 %.

---

## Kaip tai atrodo vartotojui

| Fazė | Tekstas |
|---|---|
| `validating` | Tikrinami duomenys… |
| `transcribing` | Transkribuojama… *(+ procentas, jei žinomas)* |
| `diarizing` | Atliekama diarizacija… |
| `merging` | Jungiami kalbėtojai su transkripcija… |
| `generating_protocol` | Generuojamas protokolas… |

`progressKnown=false` → procentas **nerodomas**. Ne 0 % ir ne 100 %: abu
klaidinantys, o „užstrigęs 100 %" ir buvo pradinė problema.

Nežinoma fazė duoda bendrą „Apdorojama…" — backend gali pridėti fazę anksčiau
nei frontend'as bus įdiegtas.

---

## Ko šis modelis NEAPIMA

- **Resumable transcription.** Žr. skyrių apie media-level resume.
- **Progreso teikimo diarizacijai.** Tai providerio galimybė; modelis jai jau
  paruoštas (`progressKnown` yra atskiras laukas).
- **Inkrementinio progreso serverio pusėje.** `whisper-server` segmentus kaupia
  pats ir siunčia terminaliame `done` įvykyje, tad kliente inkrementinio
  kaupimo, kurį būtų galima stabdyti, nėra.
- **Progreso vienetų semantikos.** `{current, total}` yra fazei lokalūs
  vienetai. Laiko rodymui reikėtų `unit` lauko ir sprendimo, ar `current` yra
  apdoroto audio laikas, paskutinio segmento `end` ar providerio offset — tai
  atskiras darbas.

---

## Kur tai įgyvendinta

| Sluoksnis | Failas |
|---|---|
| State machine | `backend/utils/jobPhase.js` |
| Store integracija | `backend/utils/jobStore/index.js` |
| Atominis CAS | `backend/utils/jobStore/redisStore.js` |
| Pipeline įvykiai | `backend/queues/processors.js`, `backend/services/` |
| HTTP atsakymas | `backend/utils/jobResponse.js` |
| UI formatavimas | `frontend/src/utils.js` |

Testų garantijos ir mutacijų įrodymai — `docs/security-test-matrix.md`,
skyriai „#154".
