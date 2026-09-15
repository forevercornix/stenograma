# #305.1 — ADR: retencijos nuosavybės riba be claim protokolo

**Statusas:** Priimtas · **Issue:** #305 (punktas 1, PR #348) · **Data:** 2026-09
**Susiję:** #351 (`put()` laiko riba), #157 (PR-5 registras, 4c)

**Sprendimas:** retencijos šlavėjas nuosavybę tikrina **pakartotine patikra ties
destruktyvia riba**, o ne **claim/lock protokolu**. Claim **nedaromas**, ir žemiau
užrašyta, kokiomis sąlygomis šis sprendimas nustoja galioti.

---

## Kontekstas

Retencijos šlavėjas trina objektus, kurių adresus duoda `job_result_attempts`
kandidatų užklausa. Tarp atrankos ir fizinio `delete()` būseną gali pakeisti keli
veikėjai — tai TOCTOU langas, ir jis buvo taisytas **tris kartus**, kiekvieną
kartą **perkeliant**, o ne uždarant:

| Raundas | Langas PO taisymo |
|---|---|
| I | tarp atrankos ir šalinimo |
| II | tarp patikros ir šalinimo |
| III | tarp zondų ir `delete()` |

Ketvirta patikra perkeltų jį dar kartą. Todėl klausimas buvo perkeltas iš
„kiek kartų tikrinti" į „ar reikia koordinavimo protokolo".

## Dvimatis inventorius: 6 veikėjai × 3 intervalai

```
atranka ──L1──► pakartotinė patikra ──L2──► saugyklos zondai ──L3──► delete()
```

| # | Veikėjas | L1 | L2 | L3 | Praranda duomenis |
|---|---|---|---|---|---|
| 1 | svetimas bandymas įsipareigoja | ✅ | ❌ | ❌ | taip |
| 2 | **pati kandidatė įsipareigoja** | ✅ | ❌ | ❌ | taip |
| 3 | `job_results` įgyja nuorodą | ✅ | ❌ | ❌ | taip |
| 4 | naujas bandymas tuo pačiu adresu | ✅ | ❌ | ❌ | taip |
| 5 | lygiagretus šlavėjas kitoje replikoje | — | — | — | **ne** (trynimas idempotentiškas) |
| 6 | erasure / migracijos valymas | — | — | — | **ne** (tik trina) |

**4 praradimo veikėjai × 3 intervalai = 12 langelių; dengta 4, nedengta 8.**

⚠️ Vienmatis inventorius (tik veikėjai) praleido šį vaizdą: pranešime buvo
įvardytas **vienas** veikėjas, o lentelė rodo, kad L2 ir L3 nedengti **visi
keturi**.

## Matavimas: kurie veikėjai pasiekiami NORMALIU keliu

| # | Normalus kelias? | Įrodymas |
|---|---|---|
| 1 | **ne** | raktas `results/<jobId>/<attemptId>.json`; `attemptId` = `crypto.randomUUID()`, generuojamas tiesiog prieš registraciją abiejose produkcinėse vietose (`postgresStore.js`, `artifactMigration.js`). Du bandymai to paties adreso negauna |
| 2 | **TAIP** | kolizijos nereikia — reikia rašytojo, užstrigusio tarp `registruoti()` ir `isipareigoti()` ilgiau nei `laukianciuRibaMs` = **26,19 val.** (`horizonMs` 25,19 + `MAX_RASYMO_TRUKME_MS` 1) |
| 3 | **ne** (išskyrus #2 atvejį) | nuorodą rašo `isipareigoti()` toje pačioje transakcijoje |
| 4 | **ne** | ta pati UUID priežastis |

**Vienas iš keturių pasiekiamas be anomalijos.**

## Kodėl claim NEDAROMAS

⚠️ **Claim nedengia #2 — vienintelio gyvo veikėjo.** `isipareigoti()` yra **du
`UPDATE`** esamai eilutei, ne registracija; claim, kurio klausia `registruoti()`,
kandidatės nuosavo įsipareigojimo **nemato iš principo**.

⚠️ **Claim dengia #1, #3, #4 — pasiekiamus tik per nekonsistentiškus
metaduomenis.** O repo atsakymas tokiai būsenai jau yra, ir jis **kitas**:
`NESAUGU` — atsisakyti ir parodyti, ne inžineriškai saugiai apdoroti. Erasure
pusė meta `NESAUGU`; retencijos pusė praleidžia ir **skaičiuoja**
(`resultAttemptsLiveHeld`).

Claim būtų **lygiagretumo protokolas būsenai, kurios repo sąmoningai
neapdoroja** — neproporcinga.

## Kokia kaina buvo įvertinta (jei sąlyga suveiktų)

| Kaina | Kodėl |
|---|---|
| **Migracija** | `busena` turi `CHECK ... IN ('pending','committed','abandoned')`, tikrinamą starte (`job_result_attempts_busena_allowed`). Nauja būsena → `CHECK` keitimas; stulpelis → `addColumn` |
| **Naujas indeksas** | `(storage_type, storage_key)` indekso **nėra**; be jo registracijos patikra būtų `seq scan` kiekvienam `put()` |
| **Užklausa karštame kelyje** | `registruoti()` dabar yra **vienas `INSERT` be jokio `SELECT`** |
| **Atsisakymo semantika** | ⚠️ **sunkiausia dalis, ne migracija.** `put()`, radęs užimtą adresą, turi būti **pakartojamas, ne prarasti job'ą** — naujas klaidų kelias karštame kelyje, nusipelnantis savo DoD |

**Forma, kuri būtų rinktasi:** `sluojama_iki timestamptz` su CAS
(`WHERE sluojama_iki IS NULL OR sluojama_iki < now()`), **ne nauja būsena**:

- **pabaiga įrašyta pačioje reikšmėje** — šlavėjo kritimas adreso neužrakina
  amžiams (4b pamoka: fail-closed be pabaigos virsta tyliu kaupimu);
- **būsenų mašina nepaliečiama** — `svetimiAdresai()`, `GYVOS_BUSENOS`, `CHECK` ir
  dalinis „vienas `committed`" indeksas lieka tokie patys. Nauja būsena paliestų
  visus keturis.

Trukmė būtų **išvedama** iš `MAX_RASYMO_TRUKME_MS`, ne parinkta — o tai savo
ruožtu reikalauja #351.

## ⚠️ ATIDARYMO SĄLYGA

> **Claim tampa būtinas, jei NORMALUS kelias kada nors duos du gyvus bandymus
> vienu adresu.**

Konkretus būdas tai padaryti — pakeisti raktą į **turinio adresą** (variantas,
kurį PR-4 jau kartą **atmetė**): tada du job'ai su tuo pačiu rezultatu dalytųsi
objektu, ir #1/#3/#4 taptų kasdieniai.

**Sąlyga turi liudytoją:** `attemptRegistry` testas
„ATIDARYMO SĄLYGA: raktas išvedamas iš `attemptId`, NE iš turinio" tikrina, kad
raktas neša `attemptId`, kad funkcija **nemato turinio** (dviejų argumentų
parašas), kad 1000 bandymų duoda 1000 skirtingų adresų, ir kad **abi produkcinės
registracijos vietos** ima `naujasBandymas()`.

Sulaužius jį, šis ADR nustoja galioti — ir tai pamatoma CI'e, ne produkcijoje.

## Kas padaryta vietoj claim

1. **Pakartotinė patikra ties destruktyvia riba** (`arVisDarSluotina()`) — viena
   patikra visiems veikėjams, skaitanti eilutę **iš lentelės**, ne iš snapshot'o.
2. **Zondai perkelti PRIEŠ patikrą**, tad patikra yra **paskutinis žingsnis prieš
   `delete()`**, be jokio I/O tarp jų.

   ⚠️ **Tai ne ketvirtas lango perkėlimas, o protokolo tvarkos panaudojimas:**
   rašytojas visada eina `registruoti() → put()`, t. y. **eilutė atsiranda prieš
   objektą**. Vadinasi DB patikra, esanti paskutinė, pagauna **kiekvieną**
   rašytoją, galėjusį objektą sukurti. Likusiam langui užpildyti rašytojas turi
   spėti **abu** žingsnius; anksčiau pakakdavo vieno, o tarp jų dar gulėjo
   nuotoliniai zondai, galintys trukti sekundes.

## Likutinis gedimas — ir kodėl jis priimtinas

Jei #2 vis dėlto suveiktų, gaunamas `completed` job'as su nuoroda į ištrintą
objektą. **Išmatuota, kad tai NĖRA tyli būsena:**

- skaitymo kelias meta `ArtifactStoreError` / `ARTIFACT_NOT_FOUND`, **ne**
  `result: null`;
- `artifactRestoreIntegrity.integration` ją aptinka („eilutė yra, objekto nėra —
  fail-closed");
- rašymo kelias (`finishAtomic` pakartojimas) aptinka per `head()` ir inicijuoja
  remontą.

Skirtumas esminis: ne „prarandame duomenis nepastebimai", o „gauname **aptinkamą,
remontuotiną** būseną".

⚠️ **Viena riba lieka atvira:** `put()` neturi laiko ribos (`fs` — jokios, `s3` —
SDK numatytosios, repo jų nefiksuoja), tad 26,19 val. yra prielaida apie kada nors
pasibaigiantį rašymą. Tai registruota **#351**, ir tas pats darbas uždaro #157 4c.
