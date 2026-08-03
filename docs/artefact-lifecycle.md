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

## Ko šis etapas NEAPIMA

- **Ištrynimo koordinavimo** – artefaktų registravimo į inventorių realiuose
  keliuose dar nėra; tai kito etapo darbas.
- **Retencijos terminų skaičiavimo** – laukas yra, politika dar netaikoma.
- **Tombstone įrašymo** – būsena modelyje aprašyta, mechanizmo dar nėra.
- **Našlaičių aptikimo** – inventoriaus skenavimas ateis su E2E patikromis.
- **`sourceArtefactId` nuorodų validacijos** – laukas priimamas be patikros,
  nes jai reikia viso inventoriaus konteksto. Kitas etapas privalo patikrinti:
  išvestas tipas **turi** turėti šaltinį, šaknis – **neturi**, nurodytas
  artefaktas egzistuoja tame pačiame inventoriuje, o jo tipas atitinka
  `derivedFrom`. Be dviejų paskutinių punktų ištrynimas apeitų grafą, kurio
  dalis nurodo į niekur – apėjimas „pavyktų", tik nieko nerastų.
- **`meeting` lygio artefaktų** – žr. pastabą prie registro.
