# 7.0 — ADR: PostgreSQL autoritetas ir konsistencijos modelis

**Statusas:** siūlomas
**Blokuoja:** 7.2 ir visus vėlesnius #155 etapus
**Kontekstas:** #153 (dydžio ribos), #159 (nuosavybė), #154 (fazės) — visos trys
prielaidos įgyvendintos.

---

## Klausimas

Job būsena šiandien persistenti Redis'e per `jobStore`. #155 įveda `jobs`
lentelę su `status`, `phase`, `progress_*`, `version`. **Kuri saugykla po #155
yra autoritetinga?**

Kol tai neatsakyta, 7.2 kodas statomas ant neapibrėžto pagrindo.

---

## Sprendimas

> **PostgreSQL tampa autoritetinga job metaduomenų saugykla. Redis lieka TIK
> BullMQ eilės infrastruktūra ir nustoja būti nepriklausoma job gyvavimo ciklo
> būsenos kopija.**

### Mechanizmas: trečias `jobStore` backend'as, ne lygiagreti saugykla

`jobStore` jau turi backend abstrakciją su 15 metodų ir dviem realizacijomis
(`memoryStore`, `redisStore`). PostgreSQL prisijungia **tuo pačiu keliu**:

```
jobStore (fasadas: nuosavybė, fazės, ištrynimo žymos)
  ├── memoryStore     (testai, desktop)
  ├── redisStore      (paliekamas; nebe numatytasis produkcijai)
  └── postgresStore   (NAUJAS — produkcijos numatytasis)

BullMQ / Redis  → eilė, retry, stalled recovery. `jobStore` gyvavimo ciklo
                  metaduomenų KOPIJOS nesaugo (savo vidinius įrašus su
                  payload ir returnvalue — taip).
```

### Kodėl ne dvigubas rašymas

Sinchroninis rašymas į abi saugyklas reikalautų outbox arba dvifazio patvirtinimo:

```
Postgres UPDATE ✓ → procesas krinta → Redis UPDATE ✗
```

Tai nebe „optimistic locking" klausimas, o dviejų duomenų bazių konsistencija.
Backend'o pakeitimas pašalina **metaduomenų** dubliavimą.

⚠️ **BET VIENOS KONSISTENCIJOS PROBLEMOS JIS NEPAŠALINA.** BullMQ turi SAVO
užbaigimo patvirtinimą, nepriklausomą nuo `jobStore`:

```
workers/index.js:192   finish(COMPLETED, {result})   → PostgreSQL
workers/index.js:198   _cleanupStorage()             → audio ištrinamas
workers/index.js:207   return result                 → BullMQ pažymi completed
```

Kritus **tarp 192 ir 207**: PostgreSQL sako `completed`, BullMQ patvirtinimo
negavo ir kartoja darbą, o `restart()` terminalų įrašą atmeta
(`JOB_ALREADY_TERMINAL`). Klientas mato baigtą job'ą, eilė — nepavykusį, o audio
lieka neišvalytas.

**Tai egzistuoja jau dabar su Redis** — #155 jos neįveda, bet ir neišsprendžia.
Reikia **idempotentiško užbaigimo protokolo**:

| Situacija | Elgesys |
|---|---|
| Retry randa `completed` įrašą su tuo pačiu `result` | laikyti sėkme, ne klaida |
| Retry randa `completed` be `result` | **remontas arba perdirbimas, NE sėkmė** |
| Retry randa `failed` po išnaudotų bandymų | terminalus, nekartoti |

⚠️ **`completed` BE REZULTATO NĖRA SĖKMĖ.** Rezultatai gyvena atskiroje
`job_results` lentelėje. Jei statuso atnaujinimas įsipareigoja, o rezultato
įrašymas nepavyksta arba procesas sustoja tarp jų, „tęsti valymą, tada sėkmė"
ištrintų šaltinio audio ir patvirtintų sėkmę, kai klientas transkripcijos
neturi — negrįžtamai.

**Sprendimas:** `finish(COMPLETED, { result })` atnaujina **abi lenteles vienoje
transakcijoje**. Tai įmanoma tik todėl, kad abi yra toje pačioje DB — dar vienas
argumentas prieš dvi saugyklas.

**DoD (7.5b):** procesas nutraukiamas tarp `finish()` ir `return`; po retry
job'as lieka `completed` SU rezultatu, audio išvalytas, BullMQ nekartoja be
galo. Ir atskirai: `completed` be `job_results` eilutės traktuojamas kaip
remontas, ne sėkmė.

### Kas lieka Redis'e

| | |
|---|---|
| BullMQ eilė, retry, stalled recovery | taip |
| BullMQ vidiniai job įrašai (payload, `attemptsMade`, `returnvalue`) | **taip** |
| `jobStore` gyvavimo ciklo metaduomenų KOPIJA (`status`, `phase`, `progress`, `ownerId`) | **ne** |
| Ištrynimo žymos | **ne** (žr. 7.5a) |

⚠️ **Antra eilutė svarbi ir dažnai pražiūrima.** Redis toliau saugo BullMQ
vidinius įrašus — juose yra `storageKey` ir grąžinta reikšmė su transkripcija.
„Redis nustoja būti metaduomenų saugykla" reiškia `jobStore` kopiją, NE tai, kad
Redis'e nebelieka jautrių duomenų. Ištrynimas ir toliau privalo valyti BullMQ
įrašą (`utils/jobErasure.js` tai jau daro).

`redisStore` **nešalinamas** — jis lieka palaikomas backend'as ir turi savo
kontraktų testus. Bet produkcijos numatytasis tampa `postgresStore`.

---

## ⚠️ Pasekmė: atominės operacijos reikalauja TREČIOS realizacijos

Visas #159 ir #154 atominis darbas yra **Redis-Lua specifinis**:

| Operacija | Redis | PostgreSQL atitikmuo |
|---|---|---|
| `updateOwned` / `removeOwned` | Lua CAS pagal `owner_id` + `owner_kind` | `UPDATE ... WHERE owner_id IS NOT DISTINCT FROM $1 AND owner_kind = $2` |

⚠️ **`IS NOT DISTINCT FROM`, NE `=`.** Desktop (`unowned`) ir bendro rakto
(`api-key`) job'ai turi `owner_id IS NULL`. Su `= $1`, kai `$1` irgi `NULL`,
sąlyga duoda `UNKNOWN`, ir `UPDATE` neatitinka nė vienos eilutės —
`updateOwned()` bei `removeOwned()` lūžtų KIEKVIENAM ne-vartotojo job'ui.
| `reportProgressAtomic` | Lua CAS pagal fazę, `total`, `current` | `UPDATE ... WHERE phase = $1 AND ...` |

SQL atitikmenys techniškai **paprastesni** (transakcijos, `RETURNING`), bet tai
ne migracija — tai trečia nepriklausoma tų pačių invariantų realizacija.

**Todėl 7.2 privalo turėti:** kontraktų testų rinkinį, kuris sukasi prieš
**visus tris** backend'us.

⚠️ **RINKINYS JAU EGZISTUOJA IR JAU RADO DIVERGENCIJĄ.**
`tests/jobStoreBackendContract.integration.test.js` (#154 peržiūros metu) paleidžia
7 scenarijus prieš memory ir Redis. Jo nebuvo, ir backend'ai buvo išsiskyrę:
`reportProgressAtomic()` sugadintam įrašui memory atmesdavo, Redis priimdavo.

⚠️ **RINKINYS NĖRA PARAMETRIZUOTAS IR NEDENGIA VISŲ ATOMINIŲ OPERACIJŲ.**
`jobStoreBackendContract.integration.test.js` turi po ATSKIRĄ testą memory ir
Redis (paruošimas skiriasi), o scenarijai kviečia tik `reportProgressAtomic()` —
`updateOwned()` ir `removeOwned()` ten nėra. Tad 7.2b apima TRIS dalykus:
parametrizuoti rinkinį, PRAPLĖSTI scenarijus nuosavybės operacijomis, ir tik
tada pridėti `postgresStore`.

Sena formuluotė („užduotis yra pridėti `postgresStore` į
esamą `BACKENDAI` sąrašą** ir priversti jį praeiti. Tai konkretus, patikrinamas
kriterijus. Po #154 žinome, kad realizacija gali tyliai praleisti
invariantą, kurį kita saugo — `progressKnown` boolean konversija ir Lua
eksponentinė forma buvo būtent tokie atvejai.

⚠️ **TAI REIŠKIA, KAD CAS NEGALI LIKTI 7.5b.** Ankstesnė šio ADR versija
reikalavo kontraktų testų 7.2 metu, bet atomines operacijas paliko vėlesniam PR.
Prieštaravimas: kontraktų testai apima `updateOwned`, `removeOwned` ir
`reportProgressAtomic`, tad be jų 7.2 arba neturėtų testų, arba turėtų
neveikiantį backend'ą.

Todėl 7.2 skaidomas:

| PR | Turinys |
|---|---|
| **7.2a** | `postgresStore` skeletas: **VISI 12 ne-atominių metodų** + schema |
| **7.2b** | **Atominės operacijos SQL'e** (`updateOwned`, `removeOwned`, `reportProgressAtomic`) + kontraktų testai visiems 3 backend'ams |

7.5b lieka tik tai, kas realiai nauja PostgreSQL kontekste: `version` stulpelis,
optimistic locking API ir konfliktų politika. Tai atskira nuo #159/#154
invariantų perkėlimo.

---

## Cutover: kas nutinka esamiems Redis duomenims

⚠️ **VYKDOMA PROCEDŪRA GYVENA `docs/migrations.md` („Cutover: Redis → PostgreSQL
job metaduomenys"). Čia lieka SPRENDIMAS ir jo priežastys; komandos, patikros ir
žingsnių eiliškumas — ten.**

Jei abu tekstai kada nors išsiskirs, **autoritetas yra operatoriaus dokumentas**:
jį skaito tas, kas procedūrą vykdo. Šis skyrius atsako „kodėl", ne „kaip".

Diegimo metu Redis'e jau bus job metaduomenų ir BullMQ darbų, sukurtų prieš
`postgresStore` tampant autoritetingu. Be aiškios politikos jie taptų
nematomais.

### Sprendimas: TTL nutekėjimas, ne migracija

> Esami Redis job metaduomenys **NĖRA** perkeliami į PostgreSQL.

⚠️ **„TTL NUTEKĖJIMAS" NEVEIKIA VISIEMS ĮRAŠAMS.** `redisStore.js:179` taiko
`EXPIRE` **tik** kai `isFinished(next.status)`. Tad `queued` ir `processing`
įrašai TTL apskritai negauna ir Redis'e lieka **neribotai** — kartu su
`storageKey` ir kitais jautriais metaduomenimis. `sweepExpired()` čia
nepadeda: jis šalina tik indekso įrašus, kurių hash'ai jau dingę.

Todėl cutover procedūra privalo **terminalizuoti arba eksplicitiškai ištrinti**
likusius įrašus, ne laukti TTL:

⚠️ **VYKDOMI ŽINGSNIAI PAŠALINTI IŠ ŠIO DOKUMENTO (§12.1 korekcija).**

Čia buvo shell blokas ir „Diegimo seka" lentelė. Jie **buvo teisingi savo metu** —
parašyti tada, kai vykdomos procedūros dokumento dar nebuvo. Dabar ji yra
(`docs/migrations.md`, „Cutover: Redis → PostgreSQL job metaduomenys"), ir **du
tekstai jau spėjo išsiskirti**:

| Klausimas | Senas ADR blokas | Procedūra |
|---|---|---|
| Paskutinis žingsnis | „Nustatyti `DATABASE_URL`" | **eksplicitinis** `JOB_STORE_BACKEND=postgres` |
| Drain sąlyga | `active + waiting` | **visos** neterminalios, įskaitant `delayed` |
| 3–3b vykdymas | vidinių funkcijų vardai | `node scripts/cutover-terminalize.mjs` |
| `redis-cli` | be `-u` (numatytoji instancija) | per `"$REDIS_URL"` |

⚠️ **PIRMENYBĖS PASTABA NEBŪTŲ APSAUGOJUSI.** Skaitytojas, radęs konkretų shell
bloką, jo nepraleidžia — o ta seka veda prie **destruktyvių veiksmų su neteisinga
konfigūracija**: trynimo ne toje Redis instancijoje ir perjungimo be eksplicitinio
pasirinkimo. Todėl blokas pašalintas, o ne paliktas su nuoroda.

**Kas lieka čia:** kodėl TTL nepakanka, kodėl ne migracija, ir kokios rizikos.
**Kaip tai daroma:** `docs/migrations.md`.

**Kodėl ne migracija:** job metaduomenys yra trumpaamžiai (60 min TTL), o
migracijos skriptas turėtų atkartoti visą `deserialize` logiką, `owner_kind`
semantiką ir fazių invariantus — nemaža rizika dėl duomenų, kurie savaime
išnyksta per valandą.

⚠️ **`JOB_TTL_MINUTES` NĖRA DRAIN TIMEOUT.**

Ankstesnė 2 žingsnio formuluotė sakė „arba iki `JOB_TTL_MINUTES`" — tai
semantiškai klaidinga dviem būdais: tai ne aktyvaus vykdymo riba, o
terminalinių įrašų galiojimas, ir `queued`/`processing` job'ai TTL **apskritai
negauna** (žr. retencijos skyrių). Ilga transkripcija teisėtai gali trukti
ilgiau už bet kokį TTL.

Drain baigiasi, kai `active + waiting` pasiekia **0**. Jei tai viršija
operatoriaus nustatytą maintenance langą, likę job'ai **eksplicitiškai**
terminalizuojami 3 žingsnyje — ne paliekami „pasibaigti savaime".

⚠️ **WORKER'IAI PRIVALO BŪTI SUSTABDYTI PRIEŠ 3 ŽINGSNĮ.**

HTTP job'ų priėmimo sustabdymas (1 žingsnis) **nesustabdo atskirai diegtų worker
konteinerių**. `redisStore.update()` daro skaitymą, o po jo `HSET` — tad
worker'is, perskaitęs įrašą prieš trynimą, gali jį **atkurti PO** 5 žingsnio.
Rezultatas: jautrūs metaduomenys lieka Redis'e jau po to, kai PostgreSQL tapo
autoritetu, ir niekas jų nebeieško.

Todėl 2b nėra atsargumas — be jo 5 ir 6 žingsniai negarantuoja nieko.

⚠️ **`finish(FAILED)` NEIŠLAISVINA AUDIO.**

Terminalizavimas per `finish()` nekviečia `releaseAudio()`. Eilėje laukusiam
transkripcijos job'ui tai reiškia: `jobStore` įrašas su `storageKey` ištrinamas
5 žingsnyje, o **įkeltas audio lieka saugykloje neribotai** — be jokios
`*_pending` vėliavos, tad ir 4 žingsnis jo nepagauna.

Todėl 3b: kiekvienam terminalizuotam job'ui audio išlaisvinamas EKSPLICITIŠKAI,
prieš įrašo trynimą.

⚠️ **`job:*` NEAPIMA JOB INDEKSO.**

`redisStore.js:42` apibrėžia atskirą `jobs:index` — sorted set su kiekvieno
job'o ID ir laiko žyma. Šablonas `job:*` jo **neatitinka** (nėra dvitaškio po
`job`), o perjungus į PostgreSQL Redis sweeper'is jo nebešalina. Metaduomenys
liktų neribotai, o 6 žingsnio patikra praeitų.

⚠️ **KOMANDOS ČIA NEBĖRA (§12.1, trečia tokia vieta).** Ji naudojo `redis-cli` be
`-u`, t. y. rodė į numatytąją `127.0.0.1:6379` DB 0 — Compose diegime tai NE TA
instancija. Vykdoma redakcija su `"$REDIS_URL"`, `set -euo pipefail` ir
nutraukiančia patikra gyvena `docs/migrations.md` (5b žingsnis).

⚠️ **NEPASIBAIGĘ TERMINALŪS ĮRAŠAI TURI SAVO RETENCIJĄ** (§12.1: buvo „`completed`", o `redisStore.update()` tą patį TTL taiko visiems `isFinished()` įrašams — `failed` ir `cancelled` taip pat).

Job'as, baigtas prieš pat 2 žingsnį, gauna ŠVIEŽIĄ `JOB_TTL_MINUTES` langą, o 5b
jį ištrintų iš karto. Repo tą langą dokumentuoja kaip laikotarpį, kuriuo
metaduomenys ir rezultatai lieka pasiekiami — klientas, apklausęs po
priežiūros, gautų „nėra tokio job'o" ir **negrįžtamai prarastų transkripciją**,
kuri dar turėjo būti saugoma.

Tad 5 žingsnis: arba nepasibaigę terminalūs įrašai perkeliami į PostgreSQL,
arba trynimas atidedamas, kol kiekvieno pažadėta retencija pasibaigs.

⚠️ **AKLAS `job:*` TRYNIMAS PRARASTŲ DUOMENIS.** `redisStore.update()`
sąmoningai NUIMA galiojimo laiką terminaliems įrašams su
`audio_cleanup_pending` arba `deletion_pending` — tokie hash'ai gali būti
**vienintelis `storageKey` ir retry būsenos šaltinis**. Juos ištrynus liktų
pakibęs jautrus audio arba nebaigtas ištrynimas, kurio niekas nebeužbaigs.

Todėl 4 žingsnis nėra formalumas: laukiantis valymas privalo pasibaigti (arba
būti perkeltas), ir tai patikrinama prieš trynimą.

⚠️ 3–5 žingsniai NĖRA neprivalomi. `finish()` taiko tik `EXPIRE`, tad
terminalizuotas įrašas dar valandą lieka Redis'e; `queued`/`processing` įrašai
TTL apskritai negauna ir liktų neribotai — kartu su `storageKey`.

⚠️ **Backend'o parinkimas.** Šiandien `jobStore.init()` renkasi pagal
`REDIS_URL` buvimą (`memoryStore`, jei jo nėra). Pridėjus trečią backend'ą
prireiks eksplicitinio prioriteto — `DATABASE_URL` > `REDIS_URL` > memory, arba
atskiro `JOB_STORE_BACKEND`. Tai 7.2a sprendimas, bet jis turi būti
eksplicitinis: tyli pirmenybė reikštų, kad diegimas priklauso nuo to, kurie
kintamieji atsitiktinai nustatyti.

⚠️ **`privacyConfig` TURI PASIKEISTI KARTU.** Šiandien
`utils/privacyConfig.js:85` išveda `persistentStorage` **tik iš `REDIS_URL`**:
atmeta `PERSISTENT_STORAGE=true` be Redis ir praneša saugyklą kaip efemerišką.

7.1 tai TEISINGA — `jobStore` `DATABASE_URL` dar nenaudoja. Bet 7.2a, kai
PostgreSQL taps saugykla, diegimas su `DATABASE_URL` be `REDIS_URL` meluotų apie
savo persistenciją.

**DoD (7.2a):** `persistentStorage` išvedimas, `PERSISTENT_STORAGE=true`
validacija, `PERSISTENT_STORAGE=false` prieštaravimo patikra ir diagnostika
apima `DATABASE_URL` — kad privatumo ir backend'o parinkimo ribos reikštų tą
patį.

⚠️ **BullMQ darbai eilėje yra ATSKIRAS klausimas.** Jie lieka Redis'e ir bus
vykdomi po perjungimo, bet jų `jobId` PostgreSQL'e neegzistuos. Processor'ius
tokiu atveju gaus `null` iš `jobStore.system.get()`.

**DoD:** vykdomas darbas, kurio `jobStore` įrašo nėra, turi baigtis
kontroliuojamai, ne nulūžti.

Repo jau turi artimą kelią: `jobRunner.js:220` ir `workers/index.js:93` žymi
`skipped_deleted`, kai job'as ištrintas. Bet **tai kitas atvejis** — ten yra
ištrynimo žyma, o čia jos nėra ir job'as tiesiog nežinomas. Reikia atskiro
`skipped_orphan`, kad diegimo artefaktas nesimaišytų su GDPR ištrynimu
loguose ir metrikose.

### Grįžimas atgal

⚠️ **ROLLBACK Į REDIS NEPALAIKOMAS.**

Ankstesnė formuluotė („rollback langas yra `JOB_TTL_MINUTES`") neišplaukia iš
cutover procedūros: ji IŠTRINA visus Redis `job:*` hash'us, o po perjungimo
sukurti job'ai gyvena tik PostgreSQL'e. Grįžus atgal jie tampa nematomi **iš
karto**, ne po valandos. Ir atvirkščiai — aktyvūs ar valymo laukiantys
PostgreSQL įrašai gyvuoja ilgiau nei TTL, tad praėjęs laikas nieko neįrodo.

Politika: **atstatoma PostgreSQL iš atsarginės kopijos**, ne grįžtama į Redis.
Tai daro 7.6 restore procedūrą privaloma prieš cutover, ne po jo.

⚠️ Tai priimtina TIK job metaduomenims. Sesijoms (7.3) ir auditui (7.4) tas pats
modelis NETINKA — jų retencija ilgesnė, ir jiems reikia atskiros cutover
politikos tuose PR.

### ⚠️ PAVOJINGAS NE TIK SPRENDIMAS GRĮŽTI, BET IR KONFIGŪRACIJOS PRARADIMAS

Žemiau aprašyta seka prasideda nuo operatoriaus SPRENDIMO. Bet mechanika
sprendimo nereikalauja: rezultatas identiškas, jei `DATABASE_URL` tiesiog
DINGSTA — pamestas Compose faile, neperduotas env kintamasis, klaida
deployment'e, atkurta sena konfigūracija.

Startas pavyksta, `/api/ready` žalias, job'ai nematomi, objektai nepasiekiami. Nė
vienas iš šių žingsnių nereikalauja, kad kas nors būtų nusprendęs grįžti.

⚠️ **IŠ TO SEKA TREČIA AKTYVAVIMO SPRENDIMO KOMPONENTĖ.** Iki šiol sprendimas
formuluotas kaip „ar prielaidos uždarytos" ir „ką darome, jei norėsime atsukti".
Trečias klausimas: **ar diegimo procedūra apsaugo nuo ATSITIKTINIO konfigūracijos
praradimo.**

Jis nebūtinai sprendžiamas prieš atidarymą — bet privalo būti sprendimo TEKSTE,
nes keičia RIZIKĄ, ne tik jos aprašymą. „Ar kas nors nuspręs grįžti" ir „ar per
metus nė karto nedings env kintamasis" yra skirtingos tikimybės.

⚠️ `deployment_identity` lentelė galėtų būti tokios patikros pagrindas, bet sargo
čia SĄMONINGAI nekuriame: riba užrašoma, kad sprendimas būtų priimtas ją žinant.

### ⚠️ KAS NUTINKA MECHANIŠKAI, JEI KAS NORS VIS TIEK GRĮŽTA

Politika („nepalaikoma") atsako, ko NEDARYTI. Ji neatsako, kas įvyksta, jei
operatorius pašalina `DATABASE_URL` — o būtent to klausia žmogus, kuriam po
savaitės paaiškėjo problema. Užrašoma, nes iki #157 atsakymas buvo nemalonus,
o po #157 tapo NEGRĮŽTAMAS.

**1. Perjungimas įvyksta TYLIAI.** `resolveBackendChoice()` renkasi pagal
aplinką: yra `DATABASE_URL` → `postgres`, nėra → `redis`. Nėra nei patikros, ar
PostgreSQL anksčiau buvo autoritetas, nei įspėjimo, nei fail-closed. Startas
pavyksta, `/api/ready` žalias, o job'ai tiesiog nebematomi.

⚠️ Tai NE spraga, kurią reikia skubiai užkalti — tai riba, kurią reikia ŽINOTI:
`deployment_identity` lentelė egzistuoja ir galėtų būti tokios patikros pagrindas
(žr. 7.6c DR koordinatorių), bet šiandien jos niekas tam nenaudoja.

**2. Job'ai tampa nematomi IŠ KARTO,** ne po `JOB_TTL_MINUTES` — tai jau
užrašyta aukščiau. Duomenys PostgreSQL'e lieka; dingsta tik kelias iki jų.

**3. ⚠️ PO #157 GRĮŽIMAS PALIEKA NEPASIEKIAMŲ TRANSKRIPCIJŲ, NE TIK NEMATOMŲ
JOB'Ų. ŠITO ANKSČIAU NEBUVO.**

Po `inline` → external migracijos rezultatai guli failų sistemoje arba S3, o
VIENINTELIS jų adresas yra `job_results.storage_key` ir `job_result_attempts`
eilutės — abi PostgreSQL'e. Erasure kelias ir neįsipareigotų bandymų šlavėjas
skaito būtent jas.

Nustojus skaityti tą duomenų bazę:

- objektai saugykloje LIEKA — niekas jų netrina, nes niekas apie juos nebežino;
- jų nepasiekia nei ištrynimas pagal subjekto prašymą, nei retencijos valymas;
- **jų neįmanoma surasti ir rankiniu būdu**: `list(prefix)` pagal A3 ribą
  neegzistuoja, o raktas (`results/<jobId>/<attemptId>.json`) išvedamas iš
  identifikatorių, kurie buvo tik toje pačioje duomenų bazėje.

Vadinasi grįžimas paverčia transkripcijas objektais be savininko ir be adreso.
Tai jau **ne prieinamumo, o duomenų apsaugos klausimas**: diegimas, gavęs
ištrynimo prašymą, jo įvykdyti nebegalės, ir negalės net parodyti, kas liko.

**4. Ką daryti VIETOJ grįžimo.** Atstatyti PostgreSQL iš kopijos (7.6), kaip sako
politika aukščiau. Jei atsisakoma PostgreSQL sąmoningai ir visam laikui, teisinga
seka yra: pirma **ištrinti** duomenis per veikiantį diegimą (kol erasure dar
pasiekia saugyklą), ir tik paskui keisti konfigūraciją — ne atvirkščiai.

⚠️ **IR TAI YRA ATSAKYMAS Į KLAUSIMĄ „AR ATIDARYTI BARJERĄ".** Atidarymas
vienkryptis ne todėl, kad kas nors taip nusprendė, o todėl, kad po jo atsiranda
duomenų, kurių adresas gyvena tik PostgreSQL'e. Sprendimas atidaryti privalo būti
priimtas kartu su šituo žinojimu, ne po jo.

---

## Kiti sprendimai, kuriuos reikia užrakinti prieš kodą

### 1. `sessions` schema

Dabartinis aprašymas („perkeliama iš atminties") 7.3 implementuotojui
nepakankamas.

> Pilna schema ir kontraktas — **7.3 DoD** (#181). Čia fiksuojamas tik
> SPRENDIMAS: DB saugo `token_hash`, ne token'ą; `session.id` niekada nepatenka
> į cookie; rolė yra snapshot su `revoked_at`.

⚠️ **DB saugomas TIK token'o hash.** DB nutekėjimas neturi automatiškai virsti
aktyvių sesijų perėmimu. Tai tas pats principas kaip `AUTH_USERS` scrypt hash'ai.

⚠️ **RAW TOKEN KONTRAKTAS UŽRAKINAMAS ČIA.**

Dabartinis prisijungimas rašo `sessionStore.create(...).id` tiesiai į cookie, o
`touch()` / `destroy()` priima tą pačią reikšmę. Su nauja schema `id` yra
persistentas UUID: jo naudojimas cookie paverstų DB reikšmę bearer
credential'u, ir hash-only garantija taptų dekoracija.

```js
create(...)        → { session, token }   // `token` grąžinamas VIENĄ kartą
findByToken(token)                        // ieško pagal hash(token), ne pagal id
destroy(token)                            // tas pats raktas
```

`session.id` **niekada** nepatenka į cookie. Tai keičia store API, tad
suderinti `login`, `touch()` ir `destroy()` pakeitimai priklauso 7.3 apimčiai.

⚠️ **`username` NEPERSISTINAMAS.** Sesijoje pakanka `user_id` — vardas yra
`AUTH_USERS` rodinys ir gali pasikeisti. Persistintas jis taptų antra tiesos
kopija, o audite jis nereikalingas: #158 jau naudoja pseudonimizuotą
`subject_id`, ne vardą. Jei UI jį rodo, imamas iš `AUTH_USERS` pagal `user_id`.

⚠️ **Rolė: snapshot ar lookup?** Snapshot reiškia, kad atėmus teises esamos
sesijos jų nepraranda iki galiojimo pabaigos. Lookup reiškia, kad `AUTH_USERS`
pakeitimas veikia iš karto, bet sesija priklauso nuo env, ne nuo DB. **Siūlau
snapshot + `revoked_at`**, nes #158 jau įvedė `destroyAllForUserId()`.

⚠️ **SNAPSHOT LAUŽO ESAMĄ DIEGIMO KONTRAKTĄ.** `docs/auth-deployment.md`
garantuoja: pašalinus vartotoją ar sumažinus rolę `AUTH_USERS` ir perkrovus,
prieiga dingsta **iš karto** — nes sesijos gyvena atmintyje ir restartas jas
naikina. Po 7.3 sesija išgyventų restartą **su sena role** iki galiojimo
pabaigos. Tai tyli saugumo regresija: tas pats operatoriaus veiksmas duotų kitą
rezultatą.

Sprendimas — **startinis suderinimas**: paleidžiant kiekvienai aktyviai sesijai
patikrinti, ar `user_id` vis dar yra `AUTH_USERS` ir ar rolė nepasikeitė;
nesutampa → `revoked_at`.

**DoD (7.3):** vartotojo pašalinimas + restartas → sesija atšaukta; rolės
sumažinimas + restartas → atšaukta; `docs/auth-deployment.md` procedūra
atnaujinta su regresijos testu.

⚠️ **NEŽINOMA `schema_version` ATMETAMA.** Po rollback'o ar mišraus diegimo
senesnis kodas gali perskaityti sesiją, įrašytą naujesnės versijos. Kadangi tas
įrašas neša tapatybę ir rolę, jo priėmimas senąja semantika reikštų
autorizavimą iš būsenos, kurios kodas nesupranta.

```js
// ⚠️ NE TIK NAUJESNĖS. `> PALAIKOMA` praleidžia 0, -1 ar bet kokią
// neatpažintą senesnę reikšmę, o schema jų nedraudžia.
const PALAIKOMOS = new Set([1]);
if (!PALAIKOMOS.has(session.schema_version)) return null;  // fail-closed
```

**DoD:**
- restartas — ta pati cookie, sesija randama DB, `req.user` atkuriamas;
- revokacija tikrinama per **du procesus arba restartą**, ne vien „įrašas DB yra";
- **rollback testas:** atmetamos VISOS neatpažintos versijos — `schema_version + 1`,
  `0`, `-1` ir bet kokia kita už palaikomų aibės ribų.

  ⚠️ Tikrinti tik `+1` nepakanka: realizacija su `schema_version > PALAIKOMA`
  tokį testą praeitų, o `0` ir `-1` toliau autentifikuotų pagal nežinomą
  semantiką. Testas privalo kristi, jei allowlist pakeičiamas į palyginimą.

### 2. `CHECK` constraint'ai #154 invariantams

> Constraint'ų tekstas ir jų testai — **7.2a DoD** (#179). Čia fiksuojamas
> SPRENDIMAS: vienos eilutės invariantai priklauso DB, o perėjimų grafas lieka
> `jobPhase` domenui; DB patikros privalo atitikti `PROGRESS_INVARIANTS`.

⚠️ **Šie constraint'ai turi ATITIKTI `PROGRESS_INVARIANTS`**, eksportuojamus iš
`utils/jobPhase.js`. Priešingu atveju turėsime **ketvirtą** tų pačių taisyklių
kopiją (predikatai, `assertValidProgress`, `normalizeProgress`, SQL).

⚠️ Jei pasirenkamas `numeric`, o ne `double precision`, `Infinity`/`NaN`
problema neatsiranda — bet sprendimas turi būti eksplicitinis, ne numanomas.

**DoD:** testas, tikrinantis, kad DB constraint'ai ir `PROGRESS_INVARIANTS`
neišsiskiria, **įskaitant `Infinity` ir `NaN` atvejus** — bandyti įrašyti kiekvieną invariantą pažeidžiančią reikšmę ir
tikėtis DB atmetimo.

Perėjimų grafas SQL'e **neperrašomas** — jis lieka `jobPhase` domenui. DB saugo
tik vienos eilutės vidinį invariantą.

### 3. `owner_id` / `tenant_id` semantika ir FK

`NULL owner_id` po #159 reiškia **tris** skirtingus dalykus, ir tai jau
išspręsta `owner_kind` lauku. **DB privalo turėti abu**, kitaip semantika vėl
susilies:

| `owner_kind` | `owner_id` | Reikšmė |
|---|---|---|
| `user` | UUID | sesijos vartotojas |
| `api-key` (`OWNER_KIND.API_PRINCIPAL`) | NULL | bendras raktas |
| `unowned` | NULL | desktop |
| NULL | NULL | legacy (iš prieš #159) |

**FK į `users`: NE.** `AUTH_USERS` gyvena env kintamajame, ne DB. FK būtų
neįmanomas, o `ON DELETE SET NULL` sulietų „vartotojas ištrintas" su
„desktop" — tiksliai tai, ko #159 išvengė.

**DB `CHECK`, kad deriniai nesusiliejtų:**

⚠️ **NAIVUS VARIANTAS NEVEIKIA.** PostgreSQL `CHECK` atmeta tik `FALSE`, o
`UNKNOWN` **priima**. Su `(owner_kind = NULL, owner_id = <uuid>)` pirmos trys
šakos duoda `UNKNOWN`, legacy šaka `FALSE`, o visa išraiška — `UNKNOWN`. Tad
apribojimas praleistų nuosavybės derinį, kurio `assertOwnerIdentity()` sukurti
negali.

```sql
CHECK (
  CASE
    WHEN owner_kind = 'user'    THEN owner_id IS NOT NULL
    WHEN owner_kind = 'api-key' THEN owner_id IS NULL
    WHEN owner_kind = 'unowned' THEN owner_id IS NULL
    WHEN owner_kind IS NULL     THEN owner_id IS NULL       -- legacy
    ELSE false                                              -- nežinomas kind
  END
)
```

`CASE` grąžina `true`/`false`, ne `UNKNOWN`, tad `NULL` šaka įvertinama
eksplicitiškai.

**DoD:** testas su `(owner_kind = NULL, owner_id = <uuid>)` — DB privalo
atmesti. Šis konkretus atvejis būtinas, ne tik „legacy ir unowned atskiriami".

Be jo DB priimtų `(user, NULL)` arba `(unowned, <uuid>)` — būsenas, kurių
`assertOwnerIdentity()` sukurti neleidžia. Tai tas pats principas kaip #154
progreso constraint'ai: vienos eilutės vidinis invariantas priklauso DB.

**DoD:** testas, kad `owner_kind` NULL (legacy) ir `unowned` atskiriami DB
lygyje, IR kad kiekvienas neleistinas derinys atmetamas.

### 4. Idempotency UNIQUE kontraktas

⚠️ **NAIVUS VARIANTAS NEVEIKIA.** PostgreSQL `UNIQUE` indekse `NULL` reikšmės
laikomos NELYGIOMIS, o `tenant_id` iki Milestone 2 visada `NULL`. Tad

```sql
-- NEVEIKIA dabartiniame režime:
CREATE UNIQUE INDEX ON jobs (tenant_id, idempotency_key) WHERE ...;
```

leistų dvi eilutes su `(NULL, 'key1')` — apribojimas būtų dekoracija.

**Sprendimas: sentinelis vietoj `NULL`.**

```sql
ALTER TABLE jobs
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000000',
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE UNIQUE INDEX jobs_idempotency
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Vienos nuomos režime visos eilutės turi tą patį sentinelį, tad raktai realiai
konfliktuoja. Milestone 2 pakeis numatytąją reikšmę, o indeksas liks tas pats.

⚠️ **`DEFAULT` NEPAKANKA — REIKIA NORMALIZAVIMO `postgresStore` VIDUJE.**

`newJob()` visada materializuoja `tenantId: null`, tad `INSERT`, serializuojantis
esamą įrašą, siųs **eksplicitinį `NULL`**. Stulpelio `DEFAULT` tokiu atveju
**netaikomas**, ir kiekvienas įprastas `create()` pažeis `NOT NULL`.

Reikia dvipusio vertimo backend'o riboje:

```
rašant:    tenantId === null  →  SENTINELIS
skaitant:  SENTINELIS         →  tenantId = null
```

Taip bendras `jobStore` kontraktas lieka nepakitęs visiems trims backend'ams:
memory ir Redis toliau mato `null`, o SQL invariantas galioja.

**DoD (7.2a):** `create()` be `tenantId` praeina, o `get()` grąžina `null`, ne
sentinelį — kontraktų teste, kad visi trys backend'ai sutaptų.

(Alternatyva — `NULLS NOT DISTINCT`, PG 15+. Sentinelis nepriklauso nuo
versijos ir aiškiau pereina į multi-tenancy.)

**DoD:** testas, įrašantis du job'us su tuo pačiu `idempotency_key` vienos
nuomos režime — antrasis turi būti atmestas DB, ne aplikacijos.

**DoD:** „duplicate write → kontroliuojama klaida" turi pasakyti, **kas** yra
duplicate: tas pats `idempotency_key` toje pačioje nuomoje.

### 5. FK ir `ON DELETE` politika

```sql
job_results.job_id  → jobs.id  ON DELETE CASCADE
erasure_marks.job_id → FK NĖRA
```

⚠️ **`erasure_marks` NEGALI būti `jobs` lifecycle vaikas.** Ištrynus `jobs`
eilutę su `CASCADE` dingtų būtent tombstone, kuris turi atmesti vėluojantį
worker'io darbą — apsauga išnyktų tuo momentu, kai tampa reikalinga.

**DoD:** `jobs` eilutės ištrynimas **neturi** implicitiškai pašalinti ištrynimo
žymos, reikalingos vėluojančiam eilės darbui atmesti.

### 6. Retencija VISOMS lentelėms

| Lentelė | Retencija |
|---|---|
| `job_results` | **susieta su `jobs` šalinimu**, ne savarankiška |
| `jobs` | po TTL + atsarga — **TIK terminaliams be laukiančio valymo** |

⚠️ **RETENCIJA PRIKLAUSO NUO BŪSENOS, ne vien nuo amžiaus.**

Esamos saugyklos tai daro sąmoningai (`redisStore.js:175`): `queued` ir
`processing` įrašai TTL **negauna visai**, o terminaliams su
`audio_cleanup_pending` ar `deletion_pending` galiojimas **nuimamas**
(`persist`). Priežastis — toks įrašas gali būti vienintelis `storageKey` ir
retry būsenos šaltinis.

Besąlygiška „po TTL" taisyklė leistų PostgreSQL sweeper'iui ištrinti **gyvą
job'ą** arba palikti jautrų audio be savininko.

| Būsena | Šalinama |
|---|---|
| `queued` / `processing` | **ne** — kol nebus terminalizuota arba atkurta |
| terminalus su `*_pending` | **ne** — kol valymas pavyks |
| terminalus, valymas baigtas | po TTL + atsarga |

⚠️ **REZULTATAS NEGALI PASIBAIGTI PIRMA UŽ JOB'Ą.** Savarankiškas
`job_results.expires_at` leistų rezultato eilutei dingti anksčiau, paliekant
skaitomą `completed` job'ą BE transkripcijos — būseną, kurią šis pats ADR
aukščiau vadina remontu reikalaujančiu pažeidimu. Ji taip pat skirtųsi nuo
memory ir Redis backend'ų, kur metaduomenys ir rezultatas dingsta kartu.

Abu įrašai šalinami atominiai tuo pačiu terminu, arba `job_results` galiojimas
išvedamas iš tėvinio job'o.
| `sessions` | `expires_at` + revokuotos |
| `audit_log` | N dienų (žr. esamą `privacyConfig`) |
| `erasure_marks` | **≥ maksimalus BullMQ horizontas + atsarga** (žr. skaičiavimą) |

⚠️ Paskutinė eilutė svarbiausia: žymos negalima šalinti anksčiau, nei nebegali
pasirodyti vėluojantis darbas.

**Reikšmė IŠVEDAMA iš `queues/config.js`, ne parenkama:**

| Šaltinis | Numatytoji |
|---|---|
| `QUEUE_MAX_ATTEMPTS` | 3 bandymai |
| `QUEUE_BACKOFF_MS` (eksponentinis) | 5 s → 5 + 10 + 20 = 35 s |
| `removeOnFail.age` | **24 h** — nepavykęs job'as Redis'e laikomas parai |
| Stalled recovery | žr. `WORKER_*` konfigūraciją |

Ribojantis dydis yra `removeOnFail.age` (24 h), ne backoff: nepavykęs job'as
gali būti rankiniu būdu perpaleistas iki tol.

**Bendras invariantas, ne viena reikšmė:**

```
erasure_mark_retention ≥ max(visi eilės prikėlimo horizontai) + atsarga
```

kur „prikėlimo horizontai" apima `removeOnFail.age`, `removeOnComplete.age`,
stalled recovery langą, uždelstus (`delayed`) job'us ir bet kokį būsimą
pakartotinio paleidimo mechanizmą.

⚠️ Kad garantija nebūtų tuščia, sąrašas privalo gyventi **vienoje vietoje** —
`queues/config.js` eksportuoja `revivalHorizonsMs()`, ir retencijos testas
lygina su juo. Naujas mechanizmas, pridėtas ten, ribą pakeičia savaime;
pridėtas kitur — testo nepajudins, todėl to daryti negalima. Šiandien maksimumas yra 24 h, bet formulė
turi būti įrašyta, ne rezultatas — pridėjus naują mechanizmą su ilgesniu
horizontu, riba pasikeis savaime.

**DoD:** testas, kad retencija ≥ **max(visi konfigūruoti horizontai)**, ne tik
`removeOnFail.age`. Šiandien pastarasis ribojantis, bet
`removeOnComplete.age`, stalled recovery langas ar uždelsti job'ai gali jį
viršyti po konfigūracijos pakeitimo — tada testas liktų žalias, o žyma baigtų
galioti anksčiau, nei job'as nebegali būti prikeltas.

> Skaičiavimas ir testas — **7.5a DoD** (#183).
>
> ⚠️ **VIENETAI SKIRIASI:** BullMQ `age` yra SEKUNDĖS, `stalledInterval` —
> MILISEKUNDĖS. `Math.max()` ant neapdorotų reikšmių parinktų klaidingą
> horizontą arba praleistų tikrinimą per kelias eilių tvarkas.
> Skaičiavimas ir testas — **7.5a DoD** (#183). Čia fiksuojamas SPRENDIMAS:
> retencija = `max(visi eilės prikėlimo horizontai) + atsarga`, o sąrašas
> privalo būti išvedamas iš vienos vietos, ne surašomas teste.

### 7. Migracijų suderinamumas — apimtis

> Migracijų suderinamumas taikomas **tik anksčiau išleistoms PostgreSQL schemos
> versijoms**. Esami in-memory sesijų ir audito duomenys **nėra** perkeliami:
> procesui pasibaigus jų nebėra, ir stebuklingo atkūrimo po restarto nėra.

Be šio patikslinimo „ankstesnė palaikoma schema" pirmame PostgreSQL etape
neturi prasmės.

### 8. Backup — **restore** testas, ne instrukcija

Atsarginė kopija, kurios atkūrimas niekada nepatikrintas, yra silpna garantija.

```
pg_dump → ŠIFRAVIMAS (AES-256-GCM) → dešifravimas + autentiškumo patikra →
nauja tuščia DB → restore → schema_version patikra →
keli reprezentatyvūs `jobs` IR `job_results` įrašai sutampa
```

⚠️ **NEŠIFRUOTAS DUMP'AS NETINKA.** `utils/backupEncryption.js` ir
`docs/backup-runbook.md` reikalauja AES-256-GCM su autentikuotu atkūrimu. Kadangi
`job_results` turės transkripcijas, pratybos, tenkinamos paprastu dump'u, tyliai
susilpnintų esamą apsaugą — kriterijus atrodytų įvykdytas, o jautrūs duomenys
gulėtų atviru tekstu.

⚠️ **AUDITAS, SESIJOS IR IŠTRYNIMO ŽYMOS Į ŠĮ KRITERIJŲ NEĮEINA.** Kiekviena
turi savo priežastį:

| Lentelė | Kodėl ne |
|---|---|
| `audit_log` | `utils/backupPolicy.js` jį **sąmoningai išbraukia**: atkūrus, GDPR ištrinti įrašai grįžtų, o naujesni append-only įvykiai būtų perrašyti arba dubliuoti |
| `sessions` | atkūrimas **prikeltų atšauktas sesijas** — klientas ar užpuolikas gali tebeturėti tą pačią cookie, o senas `token_hash` ją vėl padarytų galiojančia |
| `erasure_marks` | atkūrimas **atsuktų ištrynimo žurnalą**: job'as, ištrintas PO kopijos, grįžtų su rezultatu, bet BE tombstone |

**Sprendimai:**

- **`audit_log`** — iš atkūrimo išbrauktas, kaip ir dabar. Restore procedūra tai
  daro eksplicitiškai, ne netyčia.
- **`sessions`** — atkūrus **masiškai atšaukiamos** (`revoked_at = now()`).
  Alternatyva — rotuoti token'ų validacijos paslaptį, kad iki-atkūrimo cookie
  nebeautentifikuotų. Pigiau atšaukti.
- **`erasure_marks`** — ištrynimo žurnalas **išsaugomas už snapshot'o ribų** ir
  sujungiamas po atkūrimo. Kitaip pažeidžiama esama garantija, kad ištrinti
  job'ai negrįžta.

**DoD (7.6):**

- [ ] Testas: job'as ištrintas PO kopijos, PRIEŠ atkūrimą → po restore jo
      **nėra**, o tombstone yra.
- [ ] Testas: sesija atšaukta PO kopijos → po restore ta pati cookie
      **neautentifikuoja**.
- [ ] Testas: prieš kopiją įrašoma **unikaliai atpažįstama** audito eilutė; po
      restore jos **NĖRA**.

      ⚠️ „`audit_log` nesutampa su dump'u" nepakanka: atkūrimas įrašo bent vieną
      naują audito įvykį, tad nesutapimas atsiranda savaime — net jei visos
      senos eilutės buvo neteisingai atkurtos. Testas turi kristi būtent tada,
      kai audito išbraukimas pašalinamas.

Nebūtinai kiekviename CI — gali būti atskiras integracinis workflow.

---

## Perskirstyta struktūra

| PR | Turinys |
|---|---|
| **7.0** | **Šis ADR** — autoritetas, konsistencija, schemos sprendimai |
| 7.1 | Postgres servisas + migracijų karkasas |
| **7.2a** | `postgresStore` skeletas: **VISI 12 ne-atominių metodų** + schema |
| **7.2b** | **3 atominės operacijos + kontraktų rinkinio parametrizavimas ir praplėtimas** |
| 7.3 | Persistentės sesijos |
| 7.4 | Persistentis auditas |
| **7.5a** | **Persistentės ištrynimo žymos** |
| **7.5b** | **`version` stulpelis, optimistic locking API, konfliktų politika** |
| **7.6** | Health, readiness, backup **+ restore** — ⚠️ **ATKŪRIMO DALIS PRIVALO BŪTI PRIEŠ 7.2b AKTYVAVIMĄ** |

## ⚠️ AKTYVAVIMO BARJERAS

Peržiūros rado **šešias** atskiras tvarkos klaidas, ir visos to paties
pavidalo: etapas, kuris PostgreSQL padaro autoritetingu, buvo suplanuotas
anksčiau nei etapas, kuris tą režimą padaro atstatomu.

Vietoj taisymo po vieną — viena išvestinė taisyklė:

> **PostgreSQL negali būti parenkamas, kol neįgyvendinta VISKAS, ko reikia
> negrįžtamam režimui atlaikyti.**

Kadangi ADR sako, kad rollback į Redis nepalaikomas, „atlaikyti" reiškia:
atsistatyti iš kopijos, neprarasti rezultatų ir neprikelti ištrintų duomenų.

| Prielaida | Kodėl PRIEŠ aktyvavimą |
|---|---|
| **Patikrintas restore (7.6)** — ⚠️ **apibrėžimas praplėstas po #157 (§12.1)**: nebeužtenka, kad atsistatytų DB EILUTĖS; `storage_key` privalo rodyti į **vientisą artefaktą** | Buvo užrašyta prieš #157, kai „restore patikrintas" reiškė „bazė atkurta" — tada tai buvo pilnas apibrėžimas. Po #157 external eilutėje `payload` yra `NULL`, o turinys guli UŽ DB ribų: `pg_dump` atkuria NUORODAS, ne turinį, tad atkurta bazė gali turėti `storage_key`, rodantį į nesantį objektą, ir jokia DB patikra to nepamatys. **Įrodymai:** `pgDumpBackup.integration` (#248 — `jobs` IR `job_results` sutampa), `postRestoreReconcile.integration` (#249 — sesijos revokuotos, in-flight terminalizuoti, D4 atsukimas), `drRestore.integration` (#250 — ištrynimas išgyvena atkūrimą iš senesnės kopijos), `artifactRestoreIntegrity.integration` (#333 — trūkstamas, sugadintas, DB `checksum` autoritetas). Visi `postgres` rinkinyje, nepraleidžiami |
| ~~**Persistentės ištrynimo žymos** (7.5a dalis)~~ ✅ **ĮGYVENDINTA (#183)** — ⚠️ **apibrėžimas praplėstas po #157 (§12.1)** | Buvo: `deletionTombstones` yra proceso atmintis — atkūrus naujame procese žymos DINGSTA, tad restore pratybos negali įvykdyti savo pačių ištrinto job'o scenarijaus. Dabar: `erasure_marks` lentelė su būsenų mašina, advisory lock'ais ir retencija pagal prikėlimo horizontą (`utils/deletionTombstones/`, migracija `1755400000000_erasure-marks.js`). Atminties režimas lieka TIK diegimams be `DATABASE_URL` ir starte apie tai garsiai įspėja. ⚠️ **BET PO #157 ŽYMOS PERSISTAVIMO NEBEUŽTENKA:** ištrynimas eina per bandymų registrą ir šalina objektus SAUGYKLOJE, tad barjerui reikia, kad jis išgyventų restartą **IR** pasiektų objektus, kurių adresas yra tik registre. Kodas tai dengia: `jobErasure.BUTINI_SYSTEM_METODAI` apima `deleteResultArtifacts` (#157, PR-5), o `drCoordinator.replay()` paduoda `artifactStores` į `restoredJobStore.paruosti()`, kuris be jų external eilutėms **fail-close'ina**. ⚠️ **ĮRODYMAS BUVO DALIMIS — DABAR NEBĖRA (§12.1, R1).** Ankstesnė šios eilutės redakcija sakė, kad `drRestore.integration` naudoja TIK inline duomenis ir kad external ištrynimas pratyboje neįrodytas. Tai buvo tiesa jos rašymo metu. R1 (#155) tai uždarė: DR pratyba dabar užbaigia pažymėtą job'ą per `rasymoSaugykla`, tikrina, kad objektas realiai guli saugykloje, kad po `eraseJob()` jo failų sistemoje NEBĖRA, ir kad replay atkurtoje bazėje nekrenta ties jau ištrintu objektu |
| **Transakcinis rezultatų įrašymas** (7.5b dalis) | Be jo nutrūkęs procesas palieka `completed` be `job_results`; kitas bandymas atsimuša į `restart()` terminalų sargą, audio lieka, o klientas rezultato niekada negauna. **Įrodymas:** `postgresStore.integration` — „7.2b klaida po job CAS rollbackina job IR result, o connection grįžta pool'ui": sukelta klaida PO job CAS atsuka ABU įrašus, o jungties grąžinimas tikrinamas realiai (ne per `pool.waitingCount`, kuris praeidavo ir nutekėjus klientui). `externalCompletion.integration` tikrina tą pačią ribą external kelyje: nuoroda ir registro įsipareigojimas rašomi vienoje transakcijoje. ✅ **UŽDARYTA** — apibrėžimas po #157 nepasikeitė: klausimas „ar abu įrašai atomiški" nepriklauso nuo to, kur guli turinys |
| **Idempotentiškas užbaigimas su konfliktų sprendimu** (7.5b dalis) — ⚠️ **PERRAŠYTA IŠ MECHANIZMO Į GARANTIJĄ (§12.1)** | **Garantija:** du lygiagretūs užbaigimai nesunaikina vienas kito — vėlesnis rezultatas TYLIAI NEPERRAŠO ankstesnio, o skirtingas rezultatas yra klaida, ne sėkmė. ⚠️ **Ankstesnė redakcija nurodė MECHANIZMĄ** (sąlyginį `UPDATE ... WHERE status = 'processing'`), nors prielaidai reikėjo tik garantijos. Ji buvo teisinga savo metu — rašyta prieš 7.5b, kai mechanizmas dar nebuvo pasirinktas — bet ADR sprendė klausimą, kurio neturėjo spręsti, ir pasenо, kai implementacija pasirinko kitą kelią. Perrašius vėl į mechanizmą, tas pats pasikartotų pakeitus užrakinimo strategiją. **Dabartinė realizacija** (nuoroda, ne reikalavimas): `postgresStore.readJobForUpdate()` — `SELECT ... FOR UPDATE OF j`, pesimistinis eilutės užraktas; antrasis vykdytojas po užrakto mato jau `completed` būseną ir eina idempotencijos keliu per `common.js idempotentiskasAtsakymas()`. ⚠️ **REMONTO IŠIMTIS (#157, PR-4):** „rezultatas lyginamas, o ne perrašomas" galioja PAKARTOJIMUI; kai tas pats `checksum` reiškia REMONTĄ (objekto saugykloje nebėra), nuoroda **PERJUNGIAMA** sąmoningai. Be šios išimties taisyklė aprašo save be svarbiausio atvejo. **Įrodymai:** `externalCompletion.integration` — „DU lygiagretūs `finish()` su SKIRTINGAIS rezultatais: vienas laimi, kitas gauna konfliktą", „su TUO PAČIU: lieka VIENAS objektas", „checksum sutampa, bet objekto NĖRA: tai REMONTAS", „DU lygiagretūs REMONTAI: lieka VIENAS įsipareigotas"; `jobFinishIdempotency` — lygybės taisyklė NEDUBLIUOJAMA, visi trys backend'ai kviečia tą pačią funkciją |
| ~~**Fail-closed startas, patikrintas REALIAI**~~ (7.2a `[F2]`) ✅ **UŽDARYTA (#155, barjero PR, 4 commit'as)** | Buvo: `initializePostgres()` neturi fallback į atmintį, bet kol barjeras uždarytas, funkcija produkcijoje NEPASIEKIAMA — įrodyta tik unit lygmeniu (`_initializePostgresForTests`). Dabar: CI žingsnis paleidžia TIKRĄ `node server.js` su `JOB_STORE_BACKEND=postgres` ir uždaru prievadu, ir reikalauja, kad startas nutrūktų. ⚠️ **EXIT KODO NEPAKANKA — IŠMATUOTA:** su UŽDARYTU barjeru tas pats startas irgi krenta kodu 1, tik dėl kitos priežasties („dar neleidžiamas"), tad patikra, tikrinanti vien kodą, būtų buvusi žalia abiem atvejais ir nematuotų nieko. Todėl tikrinama PRIEŽASTIS (`PostgreSQL neprieinamas`) ir tai, kad job store nebuvo inicijuotas. **Kontrolė:** grąžinus barjerą į `false`, žingsnis krenta ties priežasties asercija — išmatuota prieš commit'ą |
| ~~**Eilės prieinamumo preflight**~~ ✅ **ĮGYVENDINTA (#155, PR-7 prielaida)** | `hasQueueBackend()` vertina TIK konfigūraciją (`jobStore/index.js`), `jobRunner.init()` tikrina tik ar `bullmq` modulį galima `require` (`jobRunner.js:76-82`), o jungtis kuriama LAZY pirmo `add` metu (`transcriptionQueue.js:13-24`). Su PostgreSQL metaduomenimis prie Redis nesijungia NIEKAS, tad `server.js` pažymėtų runner'į ready ir imtų klausytis, o pirmas `enqueue` kabotų ar kristų. Reikia realaus probe prieš pradedant klausytis. **Dabar:** `patikrintiEilesJungti()` (`queues/config.js`) daro `ping()` su riba, `jobRunner.init()` jo reikalauja PRIEŠ pasirinkdamas `bullmq`, o verdiktas matomas `doctor` ir `/api/health/deep` išvestyje per `runSelfChecks()`. Nesėkmė traktuojama kaip `require()` nesėkmė — inline su garsiu įspėjimu, mirtina su `REDIS_REQUIRED=true`. `/api/ready` NEPAPILDYTAS sąmoningai: jo kontraktas reikalauja loginių būsenų be infrastruktūros detalių |

⚠️ **TRANSAKCIJA NEIŠSPRENDŽIA LYGIAGRETUMO.**

Stalled recovery metu BullMQ gali paleisti **du persidengiančius vykdymus**, ir
abu perskaito tą patį `processing` snapshot'ą prieš kuriam nors įrašant.
`jobStore.system.finish()` daro skaitymą, po jo bendrą `update()` — tad abi
užbaigimo transakcijos gali sėkmingai įsipareigoti, o **vėlesnis rezultatas
tyliai perrašo pirmąjį**.

Klientas gautų transkripciją iš to vykdymo, kuris atsitiktinai baigėsi antras.

⚠️ **ŽEMIAU ESANTIS `UPDATE` YRA ISTORINIS PASIŪLYMAS, NE REIKALAVIMAS (§12.1).**
Implementacija pasirinko pesimistinį užraktą (`SELECT ... FOR UPDATE OF j`), ir
garantija ta pati. Paliekama, nes paaiškina, KODĖL transakcijos vienos nepakanka —
bet peržiūrėtojas, ieškantis šio sakinio kode, jo neras ir neturi ieškoti.

Tad barjeras reikalauja ne tik transakcijos, bet ir **sąlyginio užbaigimo**:

```
UPDATE jobs SET status = 'completed', ...
 WHERE id = $1 AND status = 'processing'
RETURNING *
```

Nulis eilučių reiškia, kad kas nors jau baigė — tada rezultatas **lyginamas**, o
ne perrašomas. Skirtingas rezultatas yra klaida, ne sėkmė.

### ⚠️ PRIELAIDOS SKIRSTOMOS Į DVI RŪŠIS

Painioti jas pavojinga: „trūksta įrodymo" ir „trūksta kodo" reikalauja skirtingo
darbo, o antrąją nurašius kaip pirmąją, barjeras būtų atidarytas su spraga.

**A. Neįgyvendintas darbas** — kodo dar nėra:

- patikrintas restore (7.6);
- persistentės ištrynimo žymos (7.5a);
- transakcinis + sąlyginis užbaigimas (7.5b);
- **eilės prieinamumo preflight** (7.2a paliko neįgyvendintą).

**B. Įgyvendintas kodas, kurio negalima patikrinti, kol barjeras uždarytas** —
buvo tik `[F2]` fail-closed startas. `initializePostgres()` fallback'o į atmintį
neturi ir turi baigtinę prisijungimo ribą, bet produkcijoje funkcija buvo
NEPASIEKIAMA, tad įrodyta tik unit lygmeniu.

⚠️ **ŠI KATEGORIJA DABAR TUŠČIA (#155, barjero PR).** Atidarius barjerą, kelias
tapo pasiekiamas, ir CI žingsnis jį vykdo prieš tikrą procesą. Kategorija
paliekama, nes ji įvardija formą, ne konkretų punktą: kodas, kurio negalima
patikrinti, kol neatidarytas barjeras, yra atskira rūšis nuo kodo, kurio dar nėra,
ir sekantis toks punktas turi rasti, kur jį užrašyti.

⚠️ **Eilės preflight priklauso A, ne B.** `hasQueueBackend()` vertina tik
konfigūraciją; nė vienoje vietoje nėra kodo, kuris prieš pradedant klausytis
patikrintų, ar eilė realiai pasiekiama. Klasifikavus jį kaip „laukiantį
išorinio įrodymo", vėlesnė aktyvavimo peržiūra trūkstamą kodą palaikytų
trūkstamu patvirtinimu.

Uždaryti #179 nė viena iš jų neblokuoja, bet abi privalo būti barjerą
atidarančio PR DoD — neišbandytas ar neparašytas gedimo kelias, įsijungiantis
būtent tuo momentu, yra blogesnis nei akivaizdžiai nesantis: jis atrodo
padengtas.

## ⚠️ BARJERAS ATIDARYTAS (#155) — SPRENDIMAS IR JO RIBOS

`POSTGRES_AKTYVAVIMAS_LEISTAS = true` nuo šio leidimo. Penkios iš šešių prielaidų
uždarytos anksčiau; šeštoji (**fail-closed startas, patikrintas REALIAI**) uždaroma
**paskutiniu šio PR commit'u** — kol barjeras buvo uždarytas, `initializePostgres()`
produkcijoje buvo nepasiekiama, tad jos elgesys buvo įrodytas tik unit lygmeniu.
⚠️ **Ne pačiu atidarymu.** Atidarymas kelią padaro PASIEKIAMĄ; įrodymas, kad jis
elgiasi fail-closed, yra atskiras darbas, ir jis eina PO atidarymo, ne kartu su juo.

### ⚠️ ATIDARYMAS NĖRA PERJUNGIMAS

| Aplinka | Prieš | Po |
|---|---|---|
| `DATABASE_URL` | `memory` (barjeras nuleisdavo) | `memory` |
| `DATABASE_URL` + `REDIS_URL` | `redis` (barjeras nuleisdavo) | `redis` |
| `JOB_STORE_BACKEND=postgres` | **klaida** | **`postgres`** |

**Nė vienas esamas diegimas nepersijungia savaime.** Pasikeitė tik tai, kad
eksplicitinis kelias tapo pasiekiamas.

### ⚠️ POLITIKOS PAKEITIMAS: `postgres` RENKAMAS TIK EKSPLICITIŠKAI

Iki šio leidimo `resolveBackendChoice()` turėjo numanomą išvedimą:
`DATABASE_URL` buvimas PATS pasirinkdavo `postgres`. Kol barjeras buvo uždarytas,
to niekas nematė — pasirinkimas būdavo nuleidžiamas atgal.

Atidarius barjerą tas išvedimas būtų perjungęs **kiekvieną** diegimą, turintį
`DATABASE_URL` — įskaitant nustačiusius jį TIK sesijoms (7.3), auditui ar
migracijoms. Jie job'ų perkelti neprašė, o Redis metaduomenys **nėra** migruojami
(žr. „Cutover"), tad jų job'ai tiesiog taptų nematomi.

⚠️ **GRĮŽIMO KRYPTIS NESIMETRIŠKA.** Numanomas pasirinkimas gali būti grąžintas
vėliau **atskiru leidimu su migracijos pastaba**. Atvirkščiai — ne: grįžimas be
pastabos tyliai perjungtų veikiančius diegimus, o tai tiksliai tas gedimas, kurio
šis pakeitimas ir vengia.

⚠️ **`DATABASE_URL` LIEKA REIKŠMINGAS** visoms kitoms ašims: sesijoms, auditui,
migracijoms ir `doctor` patikroms. Pasikeitė tik tai, kad jis nebesprendžia už
operatorių, kur gyvena JOB metaduomenys.

### ⚠️ BARJERAS BUVO NETIESIOGINIS LAIDAS DVIEM DALYKAMS

Atidarant paaiškėjo, kad du testai rėmėsi barjeru ne dėl jo paties:

| Kas | Kuo rėmėsi | Kas liko |
|---|---|---|
| `#280 P1` | `barjeras: true` kaip **paaiškinimas**, kodėl autoritetas nėra PostgreSQL | `nustatytiAsis()` perduoda `priezastis` |
| `#280 II` | barjero **metimas** kaip pigus konfigūracijos klaidos liudytojas | liudytojas pakeistas realistiškesniu |

Abiem atvejais **savybė nepasikeitė** — pasikeitė tik tai, kas ją liudija. Tai ta
pati forma kaip „18 failų, saugių dėl vieno kvietėjo": vėliava buvo atsitiktinai
pakankama, kol priežastis buvo viena.

### Eilės pasirinkimas — 7.2a sąlyga uždaroma iki galo

`canUseQueue()` remiasi `SHARED_BACKENDS` (`redis`, `postgres`), tad nė vienam
deriniui rezultatas nepakito. Bet pasekmė vertesnė už patikrą: **eilės pasirinkimas
nebepriklauso nuo numanomo išvedimo** — jis priklauso nuo `REDIS_URL` ir
eksplicitinio pasirinkimo. Tai suderina praktiką su 7.2a reikalavimu „eilės
pasirinkimas atsiejamas nuo metaduomenų backend'o".

## ⚠️ DB IR RUNTIME AIBĖS PRIVALO SUTAPTI

Atskira taisyklė, išvesta iš trijų iš eilės peržiūros radinių, kurie visi buvo
tas pats defektas skirtingose vietose: `schema_version` priėmė `1`, `type`
priėmė bet ką ne-`processing` eilutėse, `phase` priėmė bet kokį tekstą.

> **Kiekviena uždara aibė, kurią runtime laiko autoritetinga, privalo turėti
> ATITINKAMĄ `CHECK` constraint'ą — ir atitikimas tikrinamas IŠVEDANT sąrašą iš
> runtime konstantos, ne surašant ranka.**

Kryptis svarbi. **Griežtesnė DB** nei runtime atmeta teisėtą įrašą — matoma
iškart ir garsiai. **Laisvesnė DB** yra tyli: eilutė įrašoma sėkmingai, restore
praneša SĖKMĘ, o gedimas išlenda vėliau ir kitoje vietoje — dažniausiai kaip
`UNKNOWN_JOB_TYPE`, `INVALID_STATUS_PHASE` ar `Nepalaikoma job schemaVersion`
ant įrašo, kurio niekas nebegali nei paleisti, nei ištaisyti.

Autoritetai ir jų aibės:

| Aibė | Runtime autoritetas | `CHECK` |
|---|---|---|
| `type` | `JOB_TYPES` (`common.js`) | `jobs_type_values` |
| `status` | `STATUS` (`common.js`) | `jobs_status_values` |
| `phase` | `phasesForType()` (`jobPhase.js`) | `jobs_status_phase` |
| `owner_kind` | `OWNER_KIND` (`common.js`) | `jobs_owner_identity` |
| `schema_version` | `assertSupportedSchemaVersion()` (`jobAuthorization.js`) | `jobs_schema_version_supported` |
| progreso invariantai | `PROGRESS_INVARIANTS` (`jobPhase.js`) | `jobs_progress_invariants` |

Paritetą tikrina `tests/dbRuntimeParity.integration.test.js`. Sąrašai jame
IŠVEDAMI, tad naujas tipas, statusas ar fazė be atitinkamos migracijos krinta
iškart — o ne po to, kai sugadinta kopija bus įrašyta į produkciją.

⚠️ `version` stulpelis ir pilnas optimistic locking lieka 7.5b, bet **ši
konkreti sąlyga** yra aktyvavimo prielaida.

⚠️ **Tai NEKEIČIA etapų turinio** — keičia tik tai, kurios jų dalys turi būti
baigtos prieš perjungiant `DATABASE_URL`. Praktiškai: 7.2b įgyvendina backend'ą,
bet **neaktyvuoja** jo, kol trys prielaidos neįvykdytos.

Alternatyva — sujungti visus etapus į vieną PR — atmesta: peržiūros riba taptų
neaprėpiama, o būtent siauri PR leido šias klaidas pastebėti.

---

⚠️ **ATKŪRIMO PROCEDŪRA NĖRA PASKUTINĖ.**

Šis ADR sako, kad rollback į Redis **nepalaikomas** ir kad atstatoma PostgreSQL
iš kopijos. Bet 7.6, kur ta procedūra atsiranda, sąraše yra paskutinis — tad
7.2b diegimas įjungtų negrįžtamą režimą **neturėdamas savo atsistatymo kelio**.

Todėl 7.6 skaidomas pagal priklausomybę, ne pagal temą:

| | Kada |
|---|---|
| Backup + **patikrintas restore** | **PRIEŠ** 7.2b aktyvavimą |
| Health, readiness, `make doctor` DB eilutė | bet kada po 7.2a |

Alternatyva — palikti PostgreSQL neparenkamą, kol restore pratybos praeis; bet
tada 7.2b nieko neaktyvuoja, ir riba tik persikelia.

⚠️ **7.2 skaidomas, nes kontraktų testai reikalauja atominių operacijų.** Žr.
skyrių apie trečią realizaciją.

⚠️ **7.5 skaidomas iš karto.** Ištrynimo žymos yra saugumo ir gyvavimo ciklo
klausimas, CAS — saugyklos korektiškumo. Skirtingas rizikos profilis, ir po
#154 patirties su CAS peržiūra bus daug aiškesnė atskirai.

---

## Šio dokumento riba

⚠️ **ADR fiksuoja SPRENDIMUS, ne įgyvendinimo specifikaciją.**

Peržiūros metu paaiškėjo, kad dokumentas ėmė augti į dizaino specą: keturi
raundai rado ~35 defektus, ir dauguma jų buvo ne klaidingi sprendimai, o
konkretūs apribojimai, kurių ADR **negali patikrinti** — jis neturi testų.

Pavyzdžiui: „`AUDIT_ID_SALT` turi būti stabili", „`schemaVersion` turi
persistėti", „`job_results` įtraukiami į restore palyginimą". Visi teisingi, bet
jų vieta — **sub-issue DoD**, kur kiekvienas gauna testą ir mutacijos įrodymą.

Todėl:

⚠️ **RIBA TAIKOMA, NE TIK PASKELBTA.** Pirmoji šio skyriaus redakcija ribą
aprašė, bet tame pačiame raunde į ADR buvo pridėta dar detalių — dokumentas
augo 654 → 702 → 737 eilučių. Šeštame raunde schemos, constraint'ų ir
retencijos skaičiavimo tekstai perkelti į sub-issue DoD, palikus čia tik
sprendimus ir nuorodas.

| Čia | Sub-issue DoD |
|---|---|
| Kas yra autoritetingas šaltinis | kokie stulpeliai ir constraint'ai |
| Kodėl ne dual-write | kaip normalizuoti `tenant_id` |
| Kad cutover negali remtis TTL | kokia tiksli komandų seka |
| Kad `completed` be rezultato nėra sėkmė | kaip tai testuojama |

Teiginys ADR'e, kurio niekas netikrina, sensta tyliai — tai ta pati problema,
kurią #154 sprendė dokumentacijos sargais.

---

## Ko šis ADR NESPRENDŽIA

- **Realaus multi-tenant priskyrimo** — Milestone 2. ⚠️ `tenant_id` NĖRA
  `NULL`: pagal idempotency sprendimą jis yra `NOT NULL` su visų nulių
  sentineliu. Atidedamas ne stulpelis, o tikrų nuomų priskyrimas.
- Connection pooling ir apkrovos parametrų — #26.
- `redisStore` pašalinimo — jis lieka palaikomas backend'as.
