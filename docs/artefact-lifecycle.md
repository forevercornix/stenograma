# Artefaktų inventorius ir gyvavimo ciklas

Šis dokumentas yra GDPR issue #19 pirmojo etapo rezultatas. Jis atsako į
klausimą, kurio iki šiol niekur nebuvo užrašyto: **kokie duomenų artefaktai
sukuriami apdorojant vieną susitikimą, kam jie priklauso ir iš ko išvesti.**

⚠️ Šis etapas **nieko netrina**. Ištrynimas jau veikia (`utils/jobErasure.js`,
issue #3), o koordinuotas gyvavimo ciklo ištrynimas ateina kitame etape. Čia
sukuriamas **modelis**, ant kurio jis stovės.

---

## Kodėl inventoriaus reikia, kai ištrynimas jau veikia

Esamas ištrynimas trina tai, ką **žino**: eilę, jobo įrašą, audio, auditą. Bet
tas žinojimas išbarstytas po kodą – audio raktas viename modulyje, eksporto
failai kitame, laikini konversijos failai trečiame.

Kai atsiranda naujas artefakto tipas, **nėra vietos, kur jį reikėtų
užregistruoti**. Todėl jis lieka nematomas ištrynimui – tyliai, be jokio
klaidos pranešimo. Inventorius yra ta vieta.

---

## Persistencijos klasės

| Klasė | Ką reiškia | Ko tikėtis po ištrynimo |
|---|---|---|
| `persistent` | Išgyvena procesą ir restartą | Ištrynimas **privalo** juos pasiekti |
| `temporary` | Gyvena tik apdorojimo metu | Turi išnykti patys; gali „pakibti" po kritimo |
| `ephemeral` | Niekada nesaugomi | Nėra ko trinti – bet reikia **įrodyti**, kad neišlieka |

---

## Artefaktų registras

| Tipas | Klasė | Išvestas iš | Kas tai |
|---|---|---|---|
| `source_audio` | persistent | — | Įkeltas garso/vaizdo failas saugykloje |
| `upload_temp` | temporary | — | Multer laikinas failas įkėlimo metu |
| `conversion_temp` | temporary | `source_audio` | ffmpeg/WAV konversijos tarpinis failas |
| `transcript` | persistent | `source_audio` | Transkripcijos tekstas ir segmentai |
| `transcript_redacted` | **ephemeral** | `transcript` | Redaguota transkripcija – generuojama, nesaugoma |
| `protocol` | persistent | `transcript` | Sugeneruotas protokolas |
| `export_redacted` | **ephemeral** | `protocol` | Redaguotas eksporto failas |
| `export_original` | **ephemeral** | `protocol` | Originalus eksporto failas |
| `queue_record` | persistent | — | BullMQ įrašas su payload'u Redis'e |
| `job_record` | persistent | — | jobStore įrašas |
| `audit_entry` | persistent | — | Audito įrašai, susieti su jobu |

Registras gyvena `backend/utils/artefactInventory.js`.

⚠️ **Visi artefaktai šiuo metu priklauso jobui.** Modelis leidžia ir
`ownerKind: "meeting"` – #19 reikalauja koreliacijos „to a job **or meeting**
identifier", o susitikimo lygio artefaktai (pvz. keli jobai vienam posėdžiui)
yra numatoma kryptis. Bet kol tokių artefaktų nėra, `meeting` yra **tik
galimybė, ne veikiantis kelias**.

### Kodėl eksportai ir redaguota transkripcija yra efemeriški

Jie **perskaičiuojami kiekvienam panaudojimui** ir niekada nesaugomi. Jei būtų
saugomi, atsirastų **antra asmens duomenų kopija**, kurią reikėtų atskirai
trinti – ir apie kurią ištrynimas turėtų žinoti.

Tai reiškia ir kitą dalyką: jų negalima „ištrinti", tad testai turi įrodyti,
kad jie **neišlieka**, o ne kad jie pašalinami.

---

## Išvedimo grafas

```
source_audio
├── conversion_temp
└── transcript
    ├── transcript_redacted
    └── protocol
        ├── export_redacted
        └── export_original
```

Grafas leidžia apeiti **visą** grandinę nuo įkelto failo iki eksporto, o ne
tikėtis, kad kiekvienas artefaktas bus prisimintas atskirai.

---

## Gyvavimo ciklo būsenos

```
active ──► pending_deletion ──► deleted
              │      ▲
              │      └──────────────┐
              ▼                     │
   deletion_failed_retryable ───────┘
              │
              ▼
   deletion_failed_permanent
```

| Būsena | Ką reiškia |
|---|---|
| `active` | Užregistruotas ir egzistuoja |
| `pending_deletion` | Tombstone jau yra, artefaktas dar nepašalintas |
| `deleted` | Patvirtintai pašalintas |
| `deletion_failed_retryable` | Nepavyko; kartojimas gali padėti |
| `deletion_failed_permanent` | Nepavyko; **reikia žmogaus** |

### Dvi taisyklės, kurios yra modelio esmė

**1. Iš `deleted` nėra kelio atgal.** Jei artefaktą būtų galima „atgaivinti",
vėluojantis worker'is ar pakartotinis job'as paverstų ištrynimą laikinu.

**2. Ištrynimas privalo eiti per `pending_deletion`.** Tiesioginis
`active → deleted` reikštų, kad tarp „dar yra" ir „jau nėra" nelieka būsenos,
kurioje worker'is galėtų pamatyti ištrynimo žymą.

Perėjimai yra **deny-by-default**: to, ko nėra `ALLOWED_TRANSITIONS`, negalima.

---

## Inventoriaus įrašo formatas

```js
{
  type: "source_audio",           // registro tipas
  ownerId: "job_abc123",          // su kuo susietas
  ownerKind: "job",               // job | meeting
  persistence: "persistent",
  sourceArtefactId: null,         // iš ko išvestas
  state: "active",
  retentionDeadline: null,        // ms timestamp arba null
  deletedAt: null,
  failureReason: null,
}
```

Inventorius saugomas **jobo įraše** (`artefacts` laukas), ne atskiroje
saugykloje. Taip koreliacija tampa automatinė: artefaktas negali tapti
našlaičiu, nes gyvena kartu su tuo, kam priklauso. Atskira lentelė reikštų dvi
saugyklas, kurios gali išsiskirti būtent tada, kai to labiausiai nenorim –
dalinio ištrynimo metu.

⚠️ `artefacts` yra `JSON_FIELDS` sąraše (`utils/jobStore/redisStore.js`). Be to
Redis režime masyvas grįžtų kaip tuščia eilutė, ir inventorius tyliai dingtų.

---

## Koordinuotas ištrynimas

Vienas įėjimo taškas: `services/lifecycleService.js` →
`deleteJobArtefacts(job, jobId, { actor })`.

Abu DELETE maršrutai (`/api/jobs/:id`, `/api/transcribe-jobs/:id`) kviečia
**jį**, o ne trynimą tiesiogiai. Anksčiau jie turėjo identiškas kopijas to
paties kodo, ir jos galėjo išsiskirti.

### Žymos būsenos

| Būsena | Ar galima kurti artefaktus? | Ar galima trumpinti kelią? |
|---|:---:|:---:|
| `deletion_pending` | ❌ | ❌ – operacija dar vyksta |
| `deletion_failed` | ❌ | ❌ – **reikia kartoti** |
| `deleted` | ❌ | ✅ |

Perėjimai **vienkrypčiai**: `deleted` yra galutinė ir jos atšaukti negalima –
kitaip programavimo klaida paverstų jau įrodytą ištrynimą neapibrėžtu.

⚠️ **`deletion_failed → deleted` UŽDARYTAS** (#183). Ankstesnė šio dokumento
versija teigė priešingai, bet `allowedSources("deleted")` yra `["deletion_pending"]`
ir visada buvo: tiesioginis perėjimas reikštų patvirtintą ištrynimą be jokio
įrodymo, kad antras bandymas apskritai vyko.

Retry kelias nedingo – jis eina per `deletion_pending` ir yra **eksplicitinis
operatoriaus veiksmas** (`erasure-marks retry`, auditas `ERASURE_MARK_RETRIED`).
Automatinis `failed → pending` būtų blogesnis: būsena, kuri išsisprendžia
savaime, nebėra barjeras.

⚠️ **Tik `deleted` leidžia grąžinti `already_deleted`.** Ankstesnė versija turėjo
vieną reikšmę „pažymėta", ir tai laužė retry: po dalinės nesėkmės antras
`DELETE` sustodavo ties žyma ir sakydavo „ištrinta", nors artefaktai liko.

Du klausimai, kuriuos reikia atskirti:

- **„Ar galima kurti artefaktus?"** → ne, jei yra **bet kokia** žyma
- **„Ar galima trumpinti kelią?"** → tik jei ištrynimas **patvirtintas**

### Tvarka: žyma PRIEŠ šalinimą

```
tombstone ──► eraseJob ──► struktūrizuotas rezultatas ──► auditas
```

Jei žyma atsirastų po šalinimo, tarp jų liktų langas, kuriame worker'is dar
nematytų žymos, o duomenų jau nebūtų – ir jis juos atkurtų.

Žymos gyvena **atskirai** nuo jobo įrašo (`utils/deletionTombstones/`), nes turi
atsakyti į klausimą „ar šis ID buvo ištrintas?" **tada, kai įrašo nebėra**.

Nuo 7.5a (#183) jos yra **persistentinės**: `erasure_marks` lentelė su būsenų
mašina ir advisory lock'ais. Be `DATABASE_URL` lieka atminties režimas – jis
neišgyvena restarto, ir startas apie tai garsiai įspėja.

Retencija nebeskaičiuojama fiksuota TTL reikšme: žyma laikoma tol, kol job'as
dar gali būti prikeltas. Horizontas išvedamas iš eilės konfigūracijos
(`revivalHorizonsMs()`), sudedant nuoseklias dedamąsias – `delay`, retry
grandinę ir stalled perėmimą – prie terminalaus laikymo, plius saugos atsargą.
`DELETION_TOMBSTONE_TTL_HOURS` lieka kaip rankinis perrašymas, ne numatytoji
taisyklė.

### Struktūrizuotas rezultatas

```js
{
  jobId, status, actor, complete,
  requestedAt,   // kada PAPRAŠYTA - visada yra
  completedAt,   // kada FAKTIŠKAI baigta - null, jei nepavyko
  categories: {
    deleted:      ["queue_record", "source_audio", "job_record", "transcript", "protocol"],
    remaining:    [],
    retryable:    [],   // verta bandyti dar kartą
    nonRetryable: [],   // kartojimas nepadės, reikia žmogaus
    ephemeral:    ["transcript_redacted", "export_redacted", "export_original"],
    unverified:   ["upload_temp", "conversion_temp"],  // dar netikrinama
  },
}
```

| Statusas | Ką reiškia |
|---|---|
| `deleted` | Viskas pašalinta |
| `already_deleted` | Žyma jau buvo – ištrynimas įvyko anksčiau |
| `partial` | Liko kategorijų, bet gedimai **kartotini** |
| `failed` | Gedimai galutiniai – reikia žmogaus |
| `in_progress` | Ištrynimą jau vykdo **kitas** autoritetingas procesas. HTTP **202**; nė vienas destruktyvus veiksmas nepradedamas |
| `tombstone_unresolved` | Duomenys pašalinti, bet žyma liko `deletion_failed`. HTTP **503** – apskaitą užbaigia operatorius |

⚠️ **`tombstone_unresolved` yra trečias atsakymas sąmoningai.** „Ištrinta"
teigtų patvirtintą ištrynimą, kurio persistentinis įrašas neliudija;
„nepavyko" teigtų, kad duomenys liko. Nė vienas iš dviejų paprastesnių
atsakymų nebūtų tiesa.

**Efemeriškos kategorijos rodomos atskirai** sąmoningai: „nėra ko trinti" ir
„pamiršome ištrinti" turi atrodyti skirtingai. Ta pati logika galioja
`unverified`: „dar nepatikrinta" ir „patikrinta ir švaru" irgi skiriasi.

**Transkripcija ir protokolas seka savo konteinerį.** Jie neturi atskiro fizinio
saugojimo vieneto – gyvena `job.result` viduje, tad pašalinami kartu su
`job_record`. Bet rezultate jie **įvardijami**, nes nutylėti artefaktai
neatskiriami nuo pamirštų.

### Laikai: `requestedAt` ≠ `completedAt`

`requestedAt` yra kada ištrynimo **paprašyta**, `completedAt` – kada jis
**faktiškai baigtas**. Nesėkmės atveju `completedAt` lieka `null`: nepavykęs
trynimas neturi apsimesti turintis ištrynimo laiką.

### Lygiagretūs kvietimai

Antras kvietimas **laukia** pirmojo rezultato, o ne grąžina savo. Be to jis
matytų žymą ir iš karto sakytų „ištrinta", nors pirmasis trynimas dar vyktų ir
galėtų baigtis daline nesėkme – klientas gautų patvirtinimą, kurio niekas
nedavė.

⚠️ Koordinavimas galioja **tik šiam procesui**. Kelioms replikoms reikėtų Redis
užrakto.

## Apsauga nuo atkūrimo po ištrynimo

Žymos ne tik uždedamos – jos **tikrinamos trijose vietose**:

| Vieta | Ką saugo |
|---|---|
| `jobStore.update` | **Vienintelis** kelias, kuriuo jobo įrašas keičiasi |
| BullMQ worker'is | Vėluojanti eilės žinutė nepradeda darbo |
| Inline `jobRunner` | Tas pats be Redis – abu keliai elgiasi vienodai |

Patikra `jobStore.update` viduje yra svarbiausia: ji dengia **visus** kelius –
inline, worker'į ir retenciją. Patikra prie kiekvieno kvietėjo reikštų kelias
dešimtis vietų, iš kurių viena anksčiau ar vėliau būtų pamiršta, ir spraga būtų
tyli.

Ištrynimo keliai turi **eksplicitinį** apėjimą `allowAfterDeletion` – jie privalo
galėti pažymėti jobą prieš jį pašalindami. Apėjimas pavadintas taip, kad jį būtų
matyti peržiūroje.

⚠️ **Worker'is nemeta klaidos** dėl ištrinto jobo. Klaida priverstų BullMQ
kartoti, o kartojimas niekada nepavyks – jobas ištrintas visam laikui. Žinutė
tyliai užbaigiama, kad dingtų iš eilės.

⚠️ **Blokuoja bet kokia žyma**, ne tik `deleted`. Kol ištrynimas vyksta
(`pending`) ar nepavyko (`failed`), artefaktų kurti negalima – priešingu atveju
nepavykęs trynimas prikurtų dar daugiau to, ką bandom pašalinti.

### Ką apsauga TIKSLIAI garantuoja

✅ **Jobo įrašas nebus atnaujintas** po žymos uždėjimo – nei rezultatu, nei
būsena, nei jokiu kitu lauku.

✅ **Naujas darbas nebus pradėtas** – nei worker'yje, nei inline kelyje.

### Ko ji NEGARANTUOJA

⚠️ **Jau pradėtas processor'ius nesustabdomas vidury darbo.** Jei ištrynimas
įvyksta darbo metu, processor'ius gali spėti atlikti šalutinius veiksmus
**iki pirmojo `update`**: iškviesti išorinį tiekėją, parašyti laikiną failą ar
sukurti tarpinę kopiją.

Rezultatas į jobą **nepateks** (`update` bus atmestas), bet tarpiniai pėdsakai
gali likti, kol juos surinks retencijos valymas. Tai riba, ne defektas –
sustabdyti vykdomą operaciją vidury reikėtų atšaukimo mechanizmo pačiuose
tiekėjų adapteriuose.

⚠️ **Žymos gyvena tik atmintyje ir restarto neišgyvena.** Po restarto vėluojanti
eilės žinutė ištrintam jobui vėl galėtų kurti artefaktus. Tai ta pati riba kaip
sesijų saugykloje (#18); restartui atspariam variantui reikia Redis.

### `jobStore.update` grąžina `null` – dvi skirtingos priežastys

`null` reiškia **arba** „jobo nėra", **arba** „atnaujinimas atmestas dėl
ištrynimo žymos". Kvietėjui abi reiškia tą patį – **nerašyk toliau** – tad jos
nesiskiria. Jei kada nors prireiks jas atskirti, reikės atskiro grąžinimo tipo,
ne `null`.

## Artefaktų skenavimas

`utils/artefactScanner.js` eina per **visą** registrą, ne per pasirinktas
saugyklas. Kiekvienas tipas privalo turėti strategiją; be jos
`scanAllArtefacts` meta `INCOMPLETE_SCAN_COVERAGE`.

| Tipas | Kaip skenuojamas |
|---|---|
| `job_record` | Tiesioginė paieška `jobStore` |
| `audit_entry` | Per **pseudonimizuotą** `subjectId` – ta pati funkcija kaip ištrynime |
| `source_audio` | Fizinė saugykla pagal raktą, užfiksuotą **prieš** ištrynimą |
| `queue_record` | BullMQ eilės (inline režime nėra ko tikrinti) |
| `transcript`, `protocol` | Praleidžiami – saugomi `job_record` viduje |
| `*_redacted`, `export_*` | Praleidžiami – efemeriški |
| `upload_temp`, `conversion_temp` | Praleidžiami – **dar neįgyvendinta** |

⚠️ Praleisti tipai **privalo turėti priežastį**. „Nėra ko skenuoti" ir
„pamiršome skenuoti" turi atrodyti skirtingai; praleidimas be priežasties yra
tas pats, kas neskenuoti.

Naujas artefakto tipas be strategijos **sulaužo testą** ir patenka į peržiūrą –
priešingu atveju jis liktų neskenuotas tyliai, o testai ir toliau būtų žali,
nors dengtų mažesnę dalį nei anksčiau.

### `ENOENT` ištrynimo kontekste

„Failo nebėra" trinant reiškia, kad tikslas **jau pasiektas**, ne gedimą.
Klasifikavus jį kaip `permanent`, sėkmingas ištrynimas atrodytų kaip problema,
reikalaujanti žmogaus. Taisyklė **kontekstinė**: tas pats `ENOENT` skaitant failą
būtų tikras gedimas.

⚠️ **Rezultate ir atsakymuose nėra kelių, raktų ar klaidų tekstų.** Iki #19
abu maršrutai grąžindavo `outcome.errors` tiesiai klientui, o juose būna failų
kelių ir Redis raktų. Dabar klientas gauna **tik kategorijas**; pilnas tekstas
lieka serverio loguose.

### Idempotentiškumas

Pakartotinis ištrynimas nėra klaida – tai teisėtas veiksmas (tinklo
pakartojimas, du administratoriai, retry politika). Lygiagretūs kvietimai
konverguoja į vieną galutinę būseną, o **pirmasis `deletedAt` neperrašomas**:
būtent jis atsako, kada duomenys buvo pašalinti.

## Ko šis etapas NEAPIMA

- **Artefaktų registravimo į inventorių realiuose keliuose** – `artefacts`
  laukas yra, bet jo dar niekas nepildo.
- **Retencijos terminų skaičiavimo** – laukas yra, politika dar netaikoma.
- **Žymų persistencijos** – žr. žemiau.
- **Žymų persistencijos** – saugykla tik atmintyje, vienas procesas. Restartas
  žymas praranda, ta pati riba kaip sesijų saugykloje (#18).
- **Našlaičių aptikimo** – inventoriaus skenavimas ateis su E2E patikromis.
- **`sourceArtefactId` nuorodų validacijos** – laukas priimamas be patikros,
  nes jai reikia viso inventoriaus konteksto. Kitas etapas privalo patikrinti:
  išvestas tipas **turi** turėti šaltinį, šaknis – **neturi**, nurodytas
  artefaktas egzistuoja tame pačiame inventoriuje, o jo tipas atitinka
  `derivedFrom`. Be dviejų paskutinių punktų ištrynimas apeitų grafą, kurio
  dalis nurodo į niekur – apėjimas „pavyktų", tik nieko nerastų.
- **`meeting` lygio artefaktų** – žr. pastabą prie registro.
