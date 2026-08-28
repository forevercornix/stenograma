# SUBISSUES-155

Vieninteliai sub-issue tekstų šaltinis. `create-155-subissues.sh` juos skaito.

Formatas: `## [7.x] Pavadinimas`, tada body iki kito `##`.

---

## [7.0] ADR: PostgreSQL autoritetas ir konsistencijos modelis

**Tėvinis:** #155 · **Tipas:** dokumentacija · **Blokuoja:** 7.1–7.6

Prieš pirmą kodo eilutę reikia atsakyti, **kas po #155 yra autoritetingas job
metaduomenų šaltinis**. Kol tai neatsakyta, 7.2 kodas statomas ant neapibrėžto
pagrindo.

### Sprendimas

PostgreSQL tampa autoritetinga job metaduomenų saugykla per **trečią `jobStore`
backend'ą**. Redis lieka BullMQ eilei ir jos vidiniams įrašams.

### DoD

- [ ] `docs/decisions/155-postgres-authority.md` su pilnu pagrindimu.
- [ ] Įvardyta, kad backend'ų bus **trys**, ne du — `redisStore` jau egzistuoja
      ir yra dabartinis produkcijos backend'as.
- [ ] Aprašytas cutover (TTL nutekėjimas, ne migracija) ir rollback langas.
- [ ] Aprašyta, kad Redis toliau saugo BullMQ vidinius įrašus su `storageKey` ir
      transkripcija — ištrynimas privalo juos valyti.
- [ ] Schemos sprendimai: `sessions` kontraktas, `CHECK` invariantai,
      idempotency sentinelis, FK politika, retencija visoms lentelėms.
- [ ] Nuoroda iš #155 body.

### Ko NEAPIMA

Kodo. Tai sprendimų fiksavimas.

---

## [7.1] Postgres servisas ir migracijų karkasas

**Tėvinis:** #155 · **Priklauso nuo:** 7.0

`postgres:16` servisas, `node-pg-migrate`, migracijų CI.

### DoD

- [ ] `docker-compose.yml`: `postgres:16` + volume, prievadas susietas su
      `127.0.0.1` (kaip esami servisai).
- [ ] `DATABASE_URL` `.env.example` su komentaru, kad be jo viskas veikia kaip
      dabar.
- [ ] `node-pg-migrate` priklausomybė + `npm run migrate:up` / `migrate:down`.
- [ ] Tuščia DB → dabartinė schema (CI testas).
- [ ] Antras `migrate:up` iš eilės = **no-op** (0 pakeitimų, 0 klaidų).
- [ ] CI `services: postgres`; be `DATABASE_URL` migracijų testai praleidžiami su
      aiškiu `skip` (analogiškai `REQUIRE_REDIS=1`).
- [ ] `make doctor` rodo DB būseną.

### Ko NEAPIMA

Lentelių schemos — ji 7.2a. Šis PR paruošia karkasą.

---

## [7.2a] postgresStore skeletas ir jobs schema

**Tėvinis:** #155 · **Priklauso nuo:** 7.1

`postgresStore` su bazinėmis operacijomis ir `jobs` / `job_results` lentelėmis.

### DoD

**Schema**

- [ ] `jobs` su `owner_kind` (be jo `owner_id IS NULL` reikštų tris skirtingus
      dalykus — #159).
- [ ] `CHECK` invariantai: `progress_known ↔ progress_*`, `status × phase`,
      `owner_kind × owner_id`.
- [ ] ⚠️ **`owner_kind × owner_id` per `CASE`, ne `OR` grandinę.** PostgreSQL
      `CHECK` atmeta tik `FALSE`, o `UNKNOWN` **priima** — su
      `(owner_kind = NULL, owner_id = <uuid>)` `OR` variantas praleistų derinį,
      kurio `assertOwnerIdentity()` sukurti negali. DoD testas privalo apimti
      būtent šį atvejį.
- [ ] ⚠️ **LEGACY `processing + phase=NULL` NEATMETAMAS aklai.** #154 tai
      eksplicitiškai laiko realiu pre-#154 atsarginių kopijų formatu, ir
      `finish()` jį terminalizuoja, o `restoreService` perduoda
      `restoreRecord()` nepakeistą. `CHECK`, atmetantis šią būseną be
      migracijos ar `schema_version` normalizavimo, sulaužytų esamą atkūrimo
      kontraktą ir galėtų nutraukti restore per pusę.
- [ ] ⚠️ **Baigtinumas:** `double precision` priima `Infinity` ir `NaN`, o
      `NaN = NaN` PostgreSQL'e yra **TRUE**, tad savilygybės patikra neveikia.
      Reikia `<> 'NaN'::float8` ir `<> 'Infinity'::float8` arba `numeric` tipo —
      sprendimas eksplicitinis.
- [ ] **Testas, kad `CHECK` atitinka `PROGRESS_INVARIANTS`** iš
      `utils/jobPhase.js` — bandoma įrašyti kiekvieną pažeidžiančią reikšmę ir
      tikimasi DB atmetimo. Be jo bus ketvirta tų pačių taisyklių kopija.
- [ ] `job_results` su `storage_type` / `storage_key` iš karto (#157 vėliau
      prideda `s3` be schemos migracijos).
- [ ] `job_results.job_id → jobs.id ON DELETE CASCADE`.
- [ ] ⚠️ **`tenant_id` normalizavimas `postgresStore` VIDUJE.** `newJob()` visada
      materializuoja `tenantId: null`, tad `INSERT` siųs eksplicitinį `NULL`, o
      stulpelio `DEFAULT` tokiu atveju NETAIKOMAS — kiekvienas `create()`
      pažeistų `NOT NULL`. Reikia dvipusio vertimo: rašant `null → SENTINELIS`,
      skaitant `SENTINELIS → null`. Testas: `create()` be `tenantId` praeina,
      `get()` grąžina `null`, ir visi trys backend'ai sutampa.
- [ ] ⚠️ **`status text NOT NULL`.** Ta pati `UNKNOWN` logika kaip
      `progress_known`: su `status = NULL` abi `status × phase` šakos duoda
      `UNKNOWN`, o PostgreSQL priima viską, kas nėra `FALSE`. Eilutė, kurią
      `assertConsistentJobRecord()` atmeta, DB būtų patvirtinta.
- [ ] ⚠️ **`progress_known boolean NOT NULL`.** Be to `(NULL, NULL, NULL)`
      praeitų: abi `CHECK` šakos duotų `UNKNOWN`, o PostgreSQL priima viską, kas
      nėra `FALSE`.
- [ ] Idempotency: `tenant_id` sentinelis (`NOT NULL DEFAULT '00000000-...'`) +
      dalinis `UNIQUE (tenant_id, idempotency_key)`. ⚠️ Su `NULL` neveiktų:
      PostgreSQL `NULL` reikšmes `UNIQUE` indekse laiko nelygiomis.
- [ ] Indeksai `(tenant_id, created_at)`, `(owner_id, status)`.

**Store — VISI 12 ne-atominių metodų**

⚠️ Backend kontraktas turi **15 metodų**. Fasadas besąlygiškai kviečia
`getOwned()` nuosavybės skaitymui, `restoreRecord()` atkūrimui, `size()`
diagnostikai. Backend'as, įgyvendintas pagal trumpesnį sąrašą, lūžtų įprastose
užklausose, o be `listByFlag` / `listReferencedStorageKeys` neveiktų nei
laukiančio valymo paieška, nei retencija.

- [ ] `create`, `restoreRecord`, `get`, `update`, `remove`
- [ ] `getOwned` — nuosavybės skaitymas (ne atominis, bet privalomas)
- [ ] `sweepExpired`, `size`, `listAll`, `listByFlag`,
      `listReferencedStorageKeys`, `close`
- [ ] ⚠️ **`listReferencedStorageKeys()` TIKRINAMAS ELGESIU, ne egzistavimu.**
      Metodų aibės patikra praeitų ir tada, jei PostgreSQL versija besąlygiškai
      grąžintų `[]`. O `retentionSweeper.js:58-96` tą reikšmę traktuoja kaip
      įrodymą, kad **joks gyvas job'as neberodo į seną audio**, ir tuos failus
      IŠTRINA. Kontraktų teste: `queued` ir `processing` job'ai, kurių
      `storageKey` privalo būti grąžinti. `null` lieka fail-safe reikšmė, kai
      surašyti nepavyksta.
- [ ] ⚠️ **REZULTATŲ HIDRATACIJA SKAITANT.** Transkripcijos gyvena `job_results`,
      bet `utils/jobResponse.js` skaito `job.result`. `get()`, `getOwned()` ir
      `listAll()` privalo tą eilutę susieti atgal — kitaip realizacija galėtų
      sėkmingai IŠSAUGOTI transkripciją ir grąžinti `result: null` kiekvienam
      klientui. Kontraktų teste: baigtas job'as skaitomas su rezultatu visuose
      backend'uose.
- [ ] ⚠️ **PROGRESAS NE-`processing` EILUTĖSE.** `status × phase` `CHECK`
      praleidžia `completed + phase=NULL + galiojantis progresas`, nes progreso
      ir statuso patikros nesikerta. Bet gyvavimo ciklas sako, kad terminalūs ir
      `queued` perėjimai progresą IŠVALO. `PROGRESS_INVARIANTS` šio kryžminio
      ryšio neaprėpia, tad paritetu jo nepagausi — reikia atskiro constraint'o.
- [ ] ⚠️ **`numeric` NEIŠSPRENDŽIA baigtinumo.** PostgreSQL `numeric` irgi
      priima `NaN`, o naujesnės versijos — ir begalybes. Baigtinumo patikros
      privalomos BET KURIAM tipui.
- [ ] **Testas:** `postgresStore` deklaruoja TĄ PAČIĄ metodų aibę kaip memory —
      `jobStoreBackendContract` tai jau tikrina dviem backend'ams.

Likę trys (`updateOwned`, `removeOwned`, `reportProgressAtomic`) — 7.2b.

- [ ] ⚠️ **`schemaVersion` PERSISTINAMAS ir grąžinamas.** `newJob()` nustato `2`, o
      `jobAuthorization.resolveCurrentRole()` būtent pagal jį interpretuoja
      sesijos aktorių kaip stabilų UUID. Pametus jį per PostgreSQL round-trip,
      job'as eitų legacy vardo keliu ir jo vykdymas būtų atmestas. Reikia
      stulpelio, `null`/legacy vertimo ir nekintamumo taisyklės.
- [ ] ⚠️ **PostgreSQL NEPARENKAMAS NEI 7.2a, NEI 7.2b.** Šis PR įgyvendina
      12 ne-atominių metodų; nuosavybės mutacijos kviečia
      `updateOwned`/`removeOwned` tiesiogiai, o progresas be
      `reportProgressAtomic` grįžtų į silpnesnį ne-atominį kelią.

      ⚠️ 7.2b UŽBAIGIA atominių operacijų kontraktą, bet AKTYVAVIMO NEĮJUNGIA.
      Barjeras atidaromas tik įvykdžius VISAS ADR prielaidas (žr. ADR
      „AKTYVAVIMO BARJERAS" — sąrašas autoritetingas ten, o ne čia, kad
      dubliuotas skaičius nepasentų). Ankstesnė šio punkto formuluotė
      („parinkimas įjungiamas 7.2b") prieštaravo 7.2b tekstui ir buvo
      klaidinga.
- [ ] ⚠️ **FAIL-CLOSED prisijungimo klaidai.** `jobStore.initializeStore()`
      šiandien iš neprieinamo Redis krenta į memory. Toks pat elgesys su
      PostgreSQL reikštų, kad nauji job'ai rašomi į memory, o autoritetingi
      lieka DB — split-brain, kuris „išnyksta" DB atsistačius. Pasirinkus
      PostgreSQL, prisijungimo klaida privalo nutraukti startą arba readiness,
      ne pereiti kitur.
- [ ] **Backend'o parinkimas eksplicitinis**: `DATABASE_URL` > `REDIS_URL` >
      memory (arba `JOB_STORE_BACKEND`), su testu kiekvienam deriniui.
      ⚠️ Šiandien renkamasi tik pagal `REDIS_URL` buvimą — su trimis
      backend'ais tyli pirmenybė reikštų priklausomybę nuo atsitiktinių env.
- [ ] ⚠️ **AKTYVAVIMO BARJERAS.** `postgresStore` gali būti ĮGYVENDINTAS čia,
      bet **PARENKAMAS** tik įvykdžius visas prielaidas, išvardytas
      `docs/decisions/155-postgres-authority.md` skyriuje „AKTYVAVIMO
      BARJERAS". Kitaip diegimas įjungtų negrįžtamą režimą be atsistatymo kelio.

      ⚠️ SĄRAŠAS ČIA NEDUBLIUOJAMAS SĄMONINGAI. Ankstesnė versija minėjo „tris
      prielaidas"; ADR jų dabar turi daugiau (fail-closed startas, eilės
      preflight), ir fiksuotas skaičius sub-issue tekste pasentų nė vienam kodo
      pakeitimui neįvykus. Autoritetas — ADR.
- [ ] ⚠️ **EILĖS PASIRINKIMAS ATSIEJAMAS NUO METADUOMENŲ BACKEND'O.**
      `server.js:296` įjungia BullMQ tik kai `jobStore.getBackend() === "redis"`.
      Pasirinkus PostgreSQL, vykdymas nukristų į inline režimą: sukurti BullMQ
      job'ai liktų nesuvartoti, o naujas darbas taptų nepatvarus, nors Redis
      veikia. Eilė turi būti renkama pagal `REDIS_URL`, ne pagal metaduomenų
      saugyklą. Testas: `DATABASE_URL` + `REDIS_URL` kartu → BullMQ įjungtas.
- [ ] ⚠️ **`privacyConfig` pasikeičia kartu.** `utils/privacyConfig.js:85` išveda
      `persistentStorage` TIK iš `REDIS_URL`, atmeta `PERSISTENT_STORAGE=true`
      be Redis ir praneša saugyklą kaip efemerišką. Diegimas su `DATABASE_URL`
      be `REDIS_URL` meluotų apie savo persistenciją. Apima išvedimą,
      validaciją, `PERSISTENT_STORAGE=false` prieštaravimą ir diagnostiką.

### Ko NEAPIMA

Atominių operacijų (`updateOwned`, `removeOwned`, `reportProgressAtomic`) —
jos 7.2b kartu su kontraktų testais.

---

## [7.2b] Atominės operacijos SQL'e ir kontrakto ekvivalentumas

**Tėvinis:** #155 · **Priklauso nuo:** 7.2a

⚠️ **AS-IS: PARUOŠIMAS JAU ATLIKTAS `main` ŠAKOJE.**

Šis aprašymas remiasi keturiais dalykais, kurie **jau sumerginti**:

| Prielaida | Kur | PR |
|---|---|---|
| `IMMUTABLE_COLUMNS` su `schema_version` | `postgresStore.js` | #200, #204 |
| `applyPatch()` saugo `tenantId`, `idempotencyKey`, `created_at` | `common.js` | #200 |
| `jobStoreBackendContract.integration` registruotas IR `postgres` rinkinyje | `tests/suites.js` | #207 |
| Pasenęs „trečio atskiro testo" komentaras pašalintas | `jobStoreBackendContract...test.js` | #207 |

7.2b šių apsaugų **nekuria iš naujo** — jis jomis remiasi ir privalo jas
IŠLAIKYTI. Atitinkami DoD punktai žemiau yra REGRESIJOS kriterijai, ne naujas
darbas.

`postgresStore` jau egzistuoja kaip trečias `jobStore` backend'as ir turi visas
15 kontrakto operacijų. Trys atominės operacijos šiuo metu yra sąmoningai
laikinos:

- `updateOwned()`
- `removeOwned()`
- `reportProgressAtomic()`

Jos realizuotos per `SELECT ... FOR UPDATE` transakciją. Tai išlaiko bazinį
korektiškumą, tačiau nėra galutinė 7.2b CAS realizacija.

Šio sub-issue tikslas — pakeisti laikiną locking realizaciją SQL sąlyginiais
atominių mutacijų sakiniais ir įrodyti, kad memory, Redis ir PostgreSQL
backend'ai turi tą patį observable kontraktą, įskaitant concurrency/race
atvejus.

## Funkciniai reikalavimai

### 1. `updateOwned()`

Operacija turi atominiu būdu:

1. nustatyti, ar job egzistuoja;
2. patikrinti `ownerKind` ir `ownerId`;
3. pritaikyti leidžiamą patch;
4. išsaugoti pakeitimą tik jei nuosavybė tebėra ta pati.

PostgreSQL CAS turi naudoti SQL sąlygą, ekvivalenčią:

```sql
owner_id IS NOT DISTINCT FROM $expectedOwnerId
AND owner_kind = $expectedOwnerKind
```

Privaloma `IS NOT DISTINCT FROM`, ne `=`, nes `unowned` ir `api-key` job'ai
teisėtai turi `owner_id IS NULL`.

Rezultato kontraktas turi likti toks pats kaip kituose backend'uose:

- job neegzistuoja → `null`;
- job egzistuoja, bet scope svetimas → `"FORBIDDEN"`;
- scope atitinka ir update pavyko → atnaujintas job objektas.

`null` ir `"FORBIDDEN"` turi būti atskiriami be TOCTOU lango. Negalima daryti
nesaugaus:

1. `UPDATE ...`;
2. jei `rowCount === 0`, atskiro neužrakinto `SELECT`.

⚠️ **PATI MUTACIJA PRIVALO BŪTI SĄLYGINĖ.**

Reikalaujama forma:

```sql
UPDATE jobs
   SET <filtruoti laukai>
 WHERE id = $1
   AND owner_id IS NOT DISTINCT FROM $2
   AND owner_kind = $3
RETURNING *
```

CAS preconditions gyvena `WHERE` sąlygoje, ne JS patikroje prieš rašymą.

**Ko NEPAKANKA:** dabartinis `SELECT ... FOR UPDATE` → JS patikra → BESĄLYGINIS
`UPDATE`. Formaliai tai transakcija su užraktu ir „snapshot semantiką"
garantuoja, tad frazė „arba transakcija/užraktas" leistų teigti, jog kriterijus
įvykdytas NIEKO NEPAKEITUS — o būtent šios realizacijos pakeitimas ir yra 7.2b
tikslas.

**Kas leidžiama papildomai:** užrakinta transakcija aplink sąlyginį sakinį —
bet TIK jei jos reikia `null` vs `"FORBIDDEN"` atskyrimui atominiu būdu
(`UPDATE ... RETURNING` pasako tik tiek, ar eilutė pakeista). Užraktas yra
priedas prie sąlyginės mutacijos, ne jos pakaitalas.

### 2. `removeOwned()`

Ta pati nuosavybės CAS semantika kaip `updateOwned()`.

Rezultato kontraktas:

- job neegzistuoja → `false`;
- job egzistuoja, bet scope svetimas → `"FORBIDDEN"`;
- job priklauso scope ir pašalintas → `true`.

`false` ir `"FORBIDDEN"` taip pat turi būti atskiriami be TOCTOU lango.

⚠️ Ta pati sąlyginės mutacijos taisyklė kaip 1 punkte:
`DELETE FROM jobs WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2 AND
owner_kind = $3 RETURNING id`. `SELECT ... FOR UPDATE` + besąlyginis `DELETE`
nėra galutinis sprendimas.

### 3. `getOwned()` — SKAITYMO KELIAS

⚠️ **Nepamiršti trečios nuosavybės operacijos.**

`getOwned()` nėra atominė mutacija, tad jos CAS keisti nereikia — bet fasadas
ją kviečia **besąlygiškai** kiekvienam nuosavybės skaitymui, ir ji grąžina tą
pačią trišakę (`null` / `"FORBIDDEN"` / job). Jei ji vienintelė liks už
parametrizuoto rinkinio ribų, backend'ai galės išsiskirti būtent DAŽNIAUSIAI
naudojamame kelyje, o mutacijų paritetas to nepagaus.

Bendras rinkinys turi tikrinti:

- owner sutampa → job objektas;
- owner nesutampa → `"FORBIDDEN"`;
- neegzistuojantis job → `null`;
- `ownerId = null` + `unowned` veikia;
- `ownerId = null` + `api-key` NEPRIEINAMAS `unowned` scope'ui (abu turi
  `owner_id IS NULL`, tad be `ownerKind` palyginimo jie susilietų);
- baigtas job'as grąžinamas SU rezultatu visuose backend'uose (PostgreSQL
  rezultatai gyvena atskiroje `job_results` lentelėje).

### 4. Nuosavybė ir kiti immutable laukai

`updateOwned()` negali leisti patch'u pakeisti:

- `id`;
- `ownerId`;
- `ownerKind`;
- `tenantId`;
- `idempotencyKey`;
- `created_at` / `createdAt`;
- `schemaVersion`.

⚠️ `IMMUTABLE_COLUMNS` (`postgresStore.js`) jau egzistuoja ir apima visus šiuos
laukus, įskaitant `schema_version`. 7.2b reikalavimas — kad NAUJI SQL mutacijų
keliai (`UPDATE ... WHERE ... RETURNING`) jos LAIKYTŲSI, o ne kad aibė būtų
sukurta iš naujo. `SET` sąrašas privalo būti generuojamas per tą pačią aibę.

⚠️ **TAS PATS GALIOJA REDIS LUA CAS.** Memory ir Redis nekintamumą gauna TIK
iš `applyPatch()`; PostgreSQL `IMMUTABLE_COLUMNS` yra antras sluoksnis. 7.2b
įveda kelius, kuriuose `applyPatch()` gali nebedalyvauti — Redis Lua skriptas
rašo tiesiai, kaip ir SQL `SET`.

⚠️ **DVI AIBĖS PRIVALO SUTAPTI.** `applyPatch()` saugo camelCase laukus,
`IMMUTABLE_COLUMNS` — snake_case stulpelius. Jei jos išsiskirtų, atsirastų
laukas, kurį vienas backend'as keičia, o kitas ne. Taip jau buvo: `tenantId`,
`idempotencyKey` ir `created_at` buvo nekintami PostgreSQL'e, bet keičiami
memory/Redis pusėje — divergencija patvirtinta eksperimentu ir ištaisyta 7.2a
follow-up PR'e (`tests/jobOwnership.test.js` dabar tikrina aibių sutapimą).

Nekintamumo garantija privalo galioti KIEKVIENAME naujame mutacijos kelyje, ne
tik PostgreSQL. Bendras kontraktų rinkinys tai tikrina vienodai visiems trims:
patch'as, bandantis pakeisti nuosavybę ar erą, negali jos pakeisti nė viename
backend'e.

⚠️ `schemaVersion` NEKEIČIAMAS per įprastą `update`/`updateOwned` kelią. Tai
įrašo ERA (7.2a): `newJob()` nustato `2`, o `jobAuthorization.resolveCurrentRole()`
pagal ją interpretuoja `actor`. Legacy ir atkūrimas eina ATSKIRU keliu
(`restoreRecord()`), kuris erą perduoda nepakeistą — tai vienintelė vieta, kur
lauko reikšmė gali skirtis nuo `2`.

Ši garantija turi galioti pačioje backend'o mutacijoje, o ne vien dėl to, kad
dabartinis `applyPatch()` atsitiktinai ją užtikrina.

SQL `SET` sąrašas negali būti generuojamas tiesiogiai iš nefiltruotų patch
laukų.

### 5. `reportProgressAtomic()`

Rezultato kontraktas turi likti:

- job neegzistuoja → `null`;
- event nebegalioja dabartinei job būsenai → `"REJECTED"`;
- event galioja → atnaujintas job objektas.

Sprendimas ir mutacija turi būti viena atominė operacija dabartinės DB būsenos
atžvilgiu — sąlyginis `UPDATE ... WHERE <perskaitytos reikšmės nepakito>
... RETURNING`, ne užrakinta read-modify-write seka.

CAS turi apsaugoti visas reikšmes, nuo kurių priklauso progreso sprendimas,
įskaitant bent:

- job `type`;
- `status`;
- `phase`;
- esamą `progressKnown`;
- esamą progreso snapshot'ą (`progress_known`, `progress_current`,
  `progress_total`).

⚠️ **PROGRESO SNAPSHOT'AS TIKRINAMAS VISAIS ATVEJAIS, BE IŠLYGŲ.**

Reikalaujama `WHERE` dalis:

```sql
progress_known   IS NOT DISTINCT FROM $expectedProgressKnown
AND progress_current IS NOT DISTINCT FROM $expectedProgressCurrent
AND progress_total   IS NOT DISTINCT FROM $expectedProgressTotal
```

(arba įrodytas semantiškai lygiavertis sprendimas).

Visi TRYS laukai lyginami kiekvienu atveju — įskaitant `progressKnown = false`,
kai snapshot'as yra `(false, NULL, NULL)`. Formuluotė „kai aktualu" NETAIKOMA:
senas event negali būti pritaikytas, jei pasikeitė BET KURI snapshot'o progreso
reikšmė.

⚠️ `IS NOT DISTINCT FROM`, NE `=`. `progress_current` ir `progress_total` yra
`NULL` kiekvienai `progressKnown = false` eilutei, o `= NULL` duoda `UNKNOWN` —
sąlyginis `UPDATE` neatitiktų NĖ VIENOS eilutės, ir PIRMASIS progreso
pranešimas visada grįžtų `"REJECTED"`.

Jeigu kuri nors iš sprendimui naudotų reikšmių pasikeičia tarp bandymų, senas
event negali būti pritaikytas naujai būsenai.

### 6. Progreso invariantai

PostgreSQL elgesys turi sutapti su `jobPhase.reportProgress()` ir kitais
backend'ais:

- svetimo job grafo fazė → reject;
- `processing` be teisėtos fazės → reject pagal dabartinį kontraktą;
- pavėlavęs ankstesnės fazės event → reject;
- `current` regresija → reject;
- pasikeitęs `total` toje pačioje progreso epochoje → reject;
- ne-`processing` job → reject;
- nested metadata neturi būti interpretuojami kaip top-level progress;
- eksponentinė skaičiaus forma išlaikoma;
- skaitinės eilutės nėra tyliai perinterpretuojamos kaip JS skaičiai;
- teisėtas monotoniškas progresas → accepted.

Race testai turi būti deterministiniai.

### 7. Backend kontrakto rinkinys

`tests/jobStoreBackendContract.integration.test.js` turi tapti parametrizuotu
backend kontrakto rinkiniu.

Dabartinėje `main` versijoje yra **visi esami** `reportProgressAtomic()`
scenarijai (`SCENARIJAI` masyvas) ir atskiri memory/Redis testai.

> ⚠️ Scenarijų SKAIČIUS DoD'e nefiksuojamas sąmoningai. Fiksuotas skaičius
> pasensta pridėjus scenarijų, ir kriterijus tampa klaidingas nė vienam kodo
> pakeitimui neįvykus. Reikalavimas — kad **kiekvienas** `SCENARIJAI` elementas
> turėtų APIBRĖŽTĄ baigtinę būseną prieš KIEKVIENĄ backend'ą, o ne kad jų būtų N.

Refaktorizuoti į adapterio modelį, pvz.:

```js
{ name, setup, store, prepareState, cleanup }
```

arba semantiškai lygiavertę struktūrą.

Tas pats scenarijų rinkinys taikomas visiems trims backend'ams:

1. memory;
2. Redis;
3. PostgreSQL.

#### 7a. Baigtinės būsenos: `EXECUTED` / `EXPLICITLY_INAPPLICABLE` / `MISSING`

⚠️ **PATIKSLINTA (Option C).** Ankstesnė formuluotė reikalavo, kad VISI
scenarijai būtų ĮVYKDYTI prieš visus tris backend'us. Ji neįgyvendinama:
`skaitines-eilutes` ir `ideti-metaduomenys` reikalauja pre-būsenų, kurių
PostgreSQL PRODUKCINIS saugojimo modelis atstovauti negali (žr. 7b). Rinktis
tarp „tyliai pakeisti būseną" ir „pakeisti schemą" nereikia: reikalavimas
patikslinamas taip, kad liktų griežtas, skaičiuojamas ir fail-closed.

Kiekvienai privalomai porai `(scenarijus, backend'as)` privalo būti užfiksuota
TIKSLIAI VIENA baigtinė būsena:

1. **`EXECUTED`** — scenarijus realiai įvykdytas prieš tą backend'ą, o
   reikalaujama pre-būsena atstovauta BE semantinio pakeitimo.

2. **`EXPLICITLY_INAPPLICABLE`** — leidžiama TIK tada, kai reikalaujama
   pre-būsena yra struktūriškai neatstovaujama to backend'o **PRODUKCINIAME**
   saugojimo modelyje. Deklaracija privalo:
   - būti eksplicitinė ir susieta su konkrečiu `scenarijaus id`;
   - turėti NETUŠČIĄ, backend'ui specifinę priežastį;
   - įvardyti TIKSLŲ reprezentacijos neatitikimą.

   Ši būsena NEGALI būti naudojama todėl, kad paruošimas nepatogus, realizacija
   nebaigta, testas krinta arba backend'as elgiasi kitaip. Ji NEGALI būti
   nustatoma automatiškai iš testo nesėkmės.

3. **`MISSING`** — nei įvykdyta, nei teisėtai deklaruota neatstovaujama.
   MISSING privalo **KRISTI**.

Fail-closed invariantai:

- `EXECUTED ∪ EXPLICITLY_INAPPLICABLE` privalo padengti VISĄ privalomą
  inventorių; nė viena pora negali likti be būsenos;
- bet kuri `MISSING` pora — nesėkmė;
- tuščia priežastis — nesėkmė;
- nežinomas `scenarijaus id` — nesėkmė;
- nežinomas backend'o vardas — nesėkmė;
- neautorizuotas atsisakymas (vykdymo logika atsisako be deklaracijos) —
  nesėkmė;
- backend'as NEGALI atsisakyti visų privalomų scenarijų;
- scenarijus, kurio pre-būsena YRA atstovaujama, PRIVALO būti įvykdytas —
  atsisakyti jo negalima;
- atstovaujamos būsenos pakeitimas kita būsena ir jos įvykdymas
  **NETENKINA** reikalavimo (tai tylus pakeitimas, ne įvykdymas);
- SINTETINĖS schemos vykdymas yra įrodymas TIK apie sintetinę būseną ir
  **NESKAIČIUOJAMAS** kaip produkcinės schemos `EXECUTED`;
- struktūrinis neatstovaujamumas visada nurodo PRODUKCINĮ saugojimo modelį, ne
  testų aplinką ir ne laikinas realizacijos spragas.

#### 7b. Dabartinės baigtinės būsenos

Memory ir Redis saugo progresą laisvos formos verte, tad visas dabartines
pre-būsenas atstovauja. Todėl jie privalo **ĮVYKDYTI VISUS** privalomus
scenarijus; nė vienas atsisakymas jiems dabar negalioja.

PostgreSQL:

- visi struktūriškai atstovaujami scenarijai privalo būti įvykdyti su
  **NEPAKEISTA PRODUKCINE SCHEMA**;
- `skaitines-eilutes` gali būti `EXPLICITLY_INAPPLICABLE`: `progress_current` ir
  `progress_total` yra `double precision`, tad skaitinė EILUTĖ (`"8"`) negali
  išlikti eilute — tipų riba ją paverstų skaičiumi, o būtent šio skirtumo
  scenarijus ir reikalauja;
- `ideti-metaduomenys` gali būti `EXPLICITLY_INAPPLICABLE`: produkcinėje schemoje
  nėra laisvos formos progreso metaduomenų stulpelio, tad įdėti raktai
  neišvengiamai dingtų;
- abi deklaracijos privalo likti eksplicitinės ir atsparios mutacijai (jų
  pašalinimas privalo paversti scenarijų `MISSING`).

⚠️ **SAUGOJIMO MODELIS NEKEIČIAMAS.** Ši išimtis egzistuoja būtent todėl, kad
PostgreSQL progresas saugomas TIPIZUOTAIS stulpeliais. Invariantas, kurį saugo
šie du scenarijai, yra laisvos formos saugyklos savybė; įvesti JSONB progresą
vien tam, kad skaičiai sutaptų, reikštų susilpninti sąmoningą schemos sprendimą
(žr. `1755000000000_jobs-and-job-results.js` komentarą).

⚠️ **ADAPTERIAI PRIVALO PO SAVĘS SUTVARKYTI.** Trys backend'ai viename faile
reiškia tris išorinių resursų rinkinius. Neuždaryta `pg` pool jungtis ar
`ioredis` klientas laiko event loop'ą gyvą, ir `node --test` procesas
nebesibaigia — testas ne krinta, o KABO, o CI tai parodo kaip timeout'ą be
naudingos žinutės.

- [ ] Kiekvienas adapteris turi `cleanup`, kuris uždaro savo jungtis.
- [ ] Vieno backend'o būsena neteka į kitą (kiekvienas scenarijus pradedamas
      nuo švarios būsenos).
- [ ] Rinkinys užsibaigia be `--force-exit` ar analogiškų priemonių.

⚠️ **AS-IS: komentaras JAU ATNAUJINTAS.** Sena instrukcija („pridėti
PostgreSQL kaip TREČIĄ ATSKIRĄ testą", „`SCENARIJAI` NEKEISTI") pašalinta —
ji tiesiogiai prieštaravo šiam sub-issue.

7.2b kriterijus yra REGRESIJOS: komentaras privalo likti suderintas su
parametrizuotu modeliu ir negali grąžinti senos „trečio atskiro testo"
instrukcijos.

### 8. ⚠️ RINKINYS PRIVALO REALIAI PALEISTI VISUS TRIS CI'E

⚠️ **AS-IS: registracija JAU ATLIKTA.** `jobStoreBackendContract.integration`
šiuo metu registruotas IR `redis`, IR `postgres` rinkiniuose
(`tests/suites.js`) — paruošta iš anksto, kad 7.2b darbas neliktų
nepastebėtas.

7.2b privalo šią registraciją **IŠLAIKYTI** ir pridėti PostgreSQL adapterį
taip, kad `npm run test:postgres` realiai vykdytų visus PostgreSQL
`SCENARIJAI`, o ne juos praleistų.

Kodėl tai svarbu — CI turi DU atskirus žingsnius:

| Žingsnis | Env | Kas vykdoma |
|---|---|---|
| `npm run test:redis` | `REDIS_URL`, `REQUIRE_REDIS=1` | `redis` rinkinys |
| `npm run test:postgres` | `DATABASE_URL`, `REQUIRE_POSTGRES=1` | `postgres` rinkinys |

Failas, iškritęs iš `postgres` rinkinio, PostgreSQL žingsnyje NEBŪTŲ
paleistas, o `redis` žingsnyje `DATABASE_URL` nėra — tad PostgreSQL adapteris
**pats save praleistų**.

Rezultatas: visi 7 punkto kriterijai būtų formaliai įvykdyti, o CI realiai
tikrintų DU backend'us iš trijų. Tyliai — tas pats šablonas, kurį #155 jau du
kartus pagavo (`migrations.integration` prefiksas, matricos įrašai).

- [ ] Registracija abiejuose rinkiniuose IŠLAIKYTA (regresijos kriterijus, ne
      naujas darbas).
- [ ] Praleidimas nėra tylus: be atitinkamo URL adapteris praleidžiamas su
      aiškiu `skip`, o CI naudoja `REQUIRE_REDIS=1` / `REQUIRE_POSTGRES=1`.
- [ ] **Testas:** `npm run test:postgres` išvestyje matomi PostgreSQL
      adapterio scenarijai, ne `skip`.

### 9. Concurrency

Privalomi deterministiniai PostgreSQL integraciniai testai.

Du lygiagretūs konfliktuojantys rašymai turi turėti apibrėžtą rezultatą:

- vienas laimi;
- kitas gauna rezultatą, numatytą ESAMAME tos operacijos kontrakte;
- nėra lost update;
- nėra dalinai įrašytos būsenos;
- job po race tenkina visus DB ir domeno invariantus.

⚠️ **NAUJO VIEŠO `"CONFLICT"` SENTINELIO PRIDĖTI NEGALIMA.**

`updateOwned()` kontraktas turi tris rezultatus (`null` / `"FORBIDDEN"` /
job), `removeOwned()` — (`false` / `"FORBIDDEN"` / `true`),
`reportProgressAtomic()` — (`null` / `"REJECTED"` / job). Ketvirtas sentinelis
pakeistų VIEŠĄ API ir priverstų keisti visus kvietėjus bei kitus du
backend'us.

CAS nesėkmė verčiama į jau egzistuojančią semantiką pagal AKTUALIĄ eilutės
būseną: eilutės nebėra → `null` / `false`; eilutė priklauso kitam → 
`"FORBIDDEN"`; event nebegalioja → `"REJECTED"`. Jei nesėkmės priežastis yra
infrastruktūrinė, o ne domeno — ji keliauja kaip klaida (12 punktas), ne kaip
sentinelis.

Bendras version-conflict kontraktas, jo tipas ir retry politika priklauso
**7.5b**.

⚠️ **7.2b NEĮVEDA `jobs.version` IR BENDRO OPTIMISTIC-LOCKING MECHANIZMO.**

Šiame sub-issue CAS preconditions saugo TIK konkrečios atominės operacijos
sprendimui reikalingą perskaitytą būseną (nuosavybę, fazę, progreso epochą).
Bendras `jobs.version` stulpelis, `WHERE version = $n` semantika, konflikto
tipas ir kvietėjo retry politika yra **7.5b** apimtis — jų realizavimas čia
sukurtų dalinį, netestuotą 7.5b variantą, kurį vėliau reikėtų perdaryti.

`reportProgressAtomic()` race teste privaloma kontroliuojamai įterpti
konkurentinę mutaciją tarp senos būsenos ir CAS bandymo, o ne pasikliauti
schedulerio sėkme.

Bent vienas testas turi keisti job `type` arba kitą progreso sprendimui
reikšmingą lauką prieš CAS ir įrodyti, kad stale event atmetamas.

> ⚠️ **`type` keitimas yra SINTETINIS scenarijus.** `type` produkcijoje
> nekintamas — nė vienas kelias jo nekeičia, ir `updateOwned` jį eksplicitiškai
> saugo (4 punktas). Testas kuria būseną, kurios realiai nebūna, ir tai
> SĄMONINGA: tikrinama, ar CAS remiasi PERSKAITYTA būsena, ar tyliai
> pasikliauja tuo, kad ji nepasikeis. Recenzentas neturi ieškoti realaus kelio —
> jo nėra.
>
> Jei sintetinis scenarijus atrodo per dirbtinis, lygiavertis realus pakaitalas
> yra `phase` pakeitimas (jį keičia `startPhase()`) — bet tada scenarijus
> nebedengia `type` lauko, todėl geriau turėti abu.

### 9b. ⚠️ ĮRODYMAI, KURIŲ REIKALAUJA PRE-REVIEW

Du kriterijai, be kurių DoD galima įvykdyti formaliai, nepakeitus esmės.

**A. CAS saugumas nebesiremia `SELECT ... FOR UPDATE`.**

Nepakanka pridėti `UPDATE ... WHERE ...`, jei prieš jį vis tiek atliekamas
pesimistinis užraktas — tada saugumą teikia užraktas, o sąlyginis sakinys yra
dekoracija, ir 7.2b tikslas nepasiektas.

- [ ] `reportProgressAtomic()` PostgreSQL integracinis concurrency testas
      įrodo, kad operacija NESIREMIA `SELECT ... FOR UPDATE`: konkurentinis
      saugomos būsenos (`status`, `phase` arba progreso tuple) pakeitimas
      PRIEŠ CAS rašymą deterministiškai grąžina `"REJECTED"`.
- [ ] Testas deterministinis: konkurentinė mutacija įterpiama kontroliuojamai
      (pvz. per adapterio hook), ne pasikliaujant scheduler'iu.
- [ ] ⚠️ Testas įrodo MECHANIZMĄ, ne tik rezultatą: konkurentinis pakeitimas
      įterpiamas TARP pradinio skaitymo ir CAS `UPDATE`, ir tikrinama, kad
      `UPDATE` pakeitė **0 eilučių**, o operacija grąžino `"REJECTED"`.
      Vien `"REJECTED"` grąžinimo nepakanka — jį duotų ir JS patikra prieš
      rašymą, t. y. būtent ta realizacija, kurią 7.2b keičia.

**B. PostgreSQL scenarijai realiai įvykdomi, ne praleisti.**

- [ ] Kai `DATABASE_URL` nustatytas, kontrakto rinkinys FAIL-CLOSED patvirtina,
      kad kiekvienas PostgreSQL scenarijus turi baigtinę būseną:
      `įvykdyti + eksplicitiškai neatstovaujami = SCENARIJAI.length`, o
      `MISSING` aibė TUŠČIA (žr. 7a punktą).
- [ ] PostgreSQL adapterio `skip` arba nulis įvykdytų scenarijų su nustatytu
      `DATABASE_URL` yra testo NESĖKMĖ, ne tyli praleistis.
- [ ] Eksplicitiškai neatstovaujamų scenarijų aibė tikrinama POIMENIUI, ne tik
      skaičiumi: deklaracijos pašalinimas privalo paversti scenarijų `MISSING`,
      o atstovaujamo scenarijaus deklaravimas — nesėkme.

⚠️ Skaičiai čia lyginami su `SCENARIJAI.length` DINAMIŠKAI, ne su konstanta —
kitaip kriterijus pasentų pridėjus scenarijų (žr. 7 punktą).

⚠️ Sintetinės schemos vykdymas į `įvykdyti` NESKAIČIUOJAMAS (7a punktas).

### 10. Transakcijų atomika

Jei atominė job mutacija kartu keičia `job_results` ar kitą susietą
persistentinę būseną, visi tos loginės operacijos pakeitimai turi būti vienoje
transakcijoje.

Priverstinai sukėlus klaidą operacijos viduryje:

- transakcija rollbackinama;
- job nelieka dalinai pakeistas;
- `job_results` nelieka nesuderintas su job būsena;
- DB connection grąžinamas pool'ui.

### 11. Idempotency

Tas pats ne-null `idempotencyKey` toje pačioje `tenantId` erdvėje turi duoti
kontroliuojamą `DuplicateJobError` / `DUPLICATE_JOB`.

Kitos PostgreSQL `unique_violation` klaidos negali būti klaidingai pervadintos
į duplicate-job klaidą.

Šis kriterijus tikrinamas kaip bendro PostgreSQL kontrakto regresijos apsauga;
nereikia perrašyti 7.2a jau veikiančios realizacijos, jei ji kriterijų atitinka.

### 12. PostgreSQL klaidų klasifikacija

Laikinas DB/network sutrikimas neturi būti supainiotas su domeno rezultatais:

- negrąžinti `null`;
- negrąžinti `"FORBIDDEN"`;
- negrąžinti `"REJECTED"`.

Klaida keliauja aukštyn kaip klaida — su MAŠININIU požymiu (`code` ir/ar
`cause`), kad kvietėjas galėtų ją atskirti nuo domeno rezultato.

⚠️ **NAUJOS KLAIDŲ HIERARCHIJOS KURTI NEREIKIA.** Repo neturi bendros
`RetryableDatabaseError` klasės, ir jos įvedimas paliestų visus klaidų kelius —
tai atskiras darbas, ne 7.2b. Pakanka arba perduoti originalią `pg` klaidą, arba
ją įvynioti išsaugant `code`/`cause` (kaip daro `DuplicateJobError`).

Vienintelis griežtas reikalavimas: DB sutrikimas NIEKADA netampa domeno
sentineliu.

HTTP atsakymo sanitizacija nėra `postgresStore` atsakomybė; tačiau backend'as
neturi nutekinti DB klaidos kaip domeno rezultato.

### 13. Saugumo testų matrica

⚠️ `scripts/check-security-matrix.mjs` reikalauja, kad KIEKVIENAS rinkinio
testas turėtų įrašą `docs/security-test-matrix.md` — be jo CI krinta
(taip nutiko #199).

Nuosavybės CAS nėra vien korektiškumo klausimas: tai riba, skirianti vieno
vartotojo job'us nuo kito (#159). Neaprašytas testas atrodytų kaip veikianti
apsauga.

- [ ] Matricos įrašai `updateOwned` / `removeOwned` / `getOwned` nuosavybės
      garantijoms — kiekvienas su evidence stulpeliu pagal ESAMĄ matricos
      formatą.
- [ ] Matricos įrašas `reportProgressAtomic` CAS.
- [ ] Matricos įrašas parametrizuoto rinkinio trijų backend'ų ekvivalentumui.

⚠️ „Mutacijos įrodymas" yra matricos stulpelio KONVENCIJA (kas nutiktų, jei
apsauga būtų pašalinta), ne reikalavimas, kad pati operacija būtų mutacija.
`getOwned()` yra skaitymas, ir jo evidence yra atitinkamas: pvz. „mutacija:
grąžinti job'ą nepatikrinus scope → krinta". Sargas
(`scripts/check-security-matrix.mjs`) tikrina TIK ar testas paminėtas — stulpelio
turinys yra dokumentacijos kokybės, ne mašininis reikalavimas.
- [ ] `npm run test:matrix` žalias.

### 14. Backend aktyvavimas

7.2b **NEATIDARO** PostgreSQL aktyvavimo barjero.

`POSTGRES_AKTYVAVIMAS_LEISTAS` lieka `false`, kol įvykdytos ADR nurodytos
vėlesnės prielaidos, įskaitant:

- persistentines deletion tombstones;
- sąlyginį/transakcinį rezultatų užbaigimą;
- patikrintą restore;
- fail-closed starto reikalavimus;
- eilės prieinamumo preflight (ADR: **neįgyvendinta**, ne „neįrodyta").

7.2b gali paruošti backend'ą produkciniam naudojimui, bet negali padaryti
PostgreSQL autoritetingu anksčiau už ADR nustatytą aktyvavimo tašką.

### 15. Queue ir metadata store lieka nepriklausomi

7.2b neturi grąžinti senos priklausomybės:

```
BullMQ ⇔ jobStore backend == redis
```

BullMQ tinkamumas ir toliau nustatomas per `canUseQueue()` — `REDIS_URL` IR
bendras metaduomenų backend'as (`redis` arba `postgres`).

`DATABASE_URL + REDIS_URL` būsimas PostgreSQL režimas turi galėti naudoti:

- PostgreSQL job metaduomenims;
- Redis BullMQ eilei.

PostgreSQL-only režimas be Redis naudoja inline vykdymą; jo restart/recovery
politika nėra sprendžiama apeinant aktyvavimo barjerą šiame sub-issue.

## Definition of Done

**Atominės operacijos**

- [ ] `postgresStore.updateOwned()` turi galutinę SQL CAS realizaciją.
- [ ] `postgresStore.removeOwned()` turi galutinę SQL CAS realizaciją.
- [ ] `postgresStore.reportProgressAtomic()` turi galutinę SQL CAS realizaciją.
- [ ] `owner_id` palyginimui naudojama NULL-safe semantika
      (`IS NOT DISTINCT FROM` arba įrodytas lygiavertis sprendimas).
- [ ] ⚠️ VISOSE TRIJOSE operacijose CAS preconditions yra SQL `WHERE`
      sąlygoje, o mutacija naudoja `RETURNING`. `SELECT ... FOR UPDATE` +
      besąlyginis rašymas NEATITINKA kriterijaus, net jei elgesys teisingas —
      būtent šios formos pakeitimas yra 7.2b tikslas.
- [ ] `postgresStore` nebeturi `SELECT ... FOR UPDATE` kaip VIENINTELĖS
      apsaugos nė vienoje iš trijų operacijų (užraktas leidžiamas tik kaip
      priedas prie sąlyginio sakinio).
- [ ] ⚠️ `reportProgressAtomic()` concurrency testas ĮRODO, kad CAS nesiremia
      `FOR UPDATE`: konkurentinis `status`/`phase`/progreso pakeitimas prieš
      CAS rašymą deterministiškai duoda `"REJECTED"`.
- [ ] ⚠️ Nauji SQL mutacijų keliai laikosi `IMMUTABLE_COLUMNS` aibės
      (`postgresStore.js`) — `SET` generuojamas per ją, o ne per naują sąrašą.
      `schema_version` yra AUTORIZACIJOS laukas
      (`jobAuthorization.resolveCurrentRole()`).
- [ ] ⚠️ Nekintamumas galioja VISUOSE TRIJUOSE backend'uose, ne tik
      PostgreSQL: Redis Lua CAS irgi rašo tiesiai, apeidamas `applyPatch()`.
      Bendras rinkinys tai tikrina vienodai visiems trims.

**Rezultatų kontraktai**

- [ ] `updateOwned`: success / `null` / `"FORBIDDEN"` kontraktas išlaikytas.
- [ ] `removeOwned`: `true` / `false` / `"FORBIDDEN"` kontraktas išlaikytas.
- [ ] `getOwned`: job / `null` / `"FORBIDDEN"` kontraktas išlaikytas.
- [ ] `reportProgressAtomic`: object / `null` / `"REJECTED"` kontraktas
      išlaikytas.
- [ ] `null` ir `"FORBIDDEN"` atskiriami be TOCTOU lango.
- [ ] `updateOwned` negali pakeisti ownership ir kitų immutable identity laukų.

**Race sąlygos**

- [ ] Progreso CAS saugo nuo stale `type`, `status`, `phase` ir progreso
      epochos.
- [ ] Deterministinis concurrent progress testas įrodo monotoniškumą.
- [ ] Deterministinis stale-state race testas atmeta pasenusį event
      (sintetinis `type` scenarijus IR realus `phase` scenarijus).
- [ ] Deterministinis ownership concurrency testas neleidžia mutacijos po
      scope pasikeitimo.
- [ ] Du lygiagretūs teisėti `removeOwned()` bandymai → vienas `true`, kitas
      `false`; antrasis NEGALI virsti `"FORBIDDEN"` vien dėl to, kad pirmasis
      jau ištrynė eilutę.
- [ ] ⚠️ Nė vienas iš dviejų lygiagrečių `removeOwned()` NEMETA klaidos.
      `false` privalo atsirasti iš NULL-safe eilutės nebuvimo, ne iš pagautos
      DB išimties — kitaip TOCTOU langas tebėra, tik paslėptas `catch` bloke.
- [ ] Failed transaction visiškai rollbackinama, connection grąžinamas pool'ui.

**Kontrakto rinkinys**

- [ ] `jobStoreBackendContract.integration.test.js` parametrizuotas.
- [ ] Kiekvienas `SCENARIJAI` elementas turi APIBRĖŽTĄ baigtinę būseną prieš
      memory, Redis ir PostgreSQL: `EXECUTED` arba `EXPLICITLY_INAPPLICABLE`;
      `MISSING` krinta (skaičius nefiksuojamas — žr. 7 ir 7a punktus).
- [ ] Memory ir Redis įvykdo VISUS privalomus scenarijus (jų pre-būsenos
      atstovaujamos).
- [ ] PostgreSQL įvykdo visus struktūriškai atstovaujamus scenarijus su
      nepakeista produkcine schema; `skaitines-eilutes` ir `ideti-metaduomenys`
      deklaruoti `EXPLICITLY_INAPPLICABLE` su tiksliomis priežastimis.
- [ ] Bendras rinkinys papildytas `updateOwned()` scenarijais.
- [ ] Bendras rinkinys papildytas `removeOwned()` scenarijais.
- [ ] Bendras rinkinys papildytas `getOwned()` scenarijais.
- [ ] Visi trys backend'ai deklaruoja tą pačią 15 metodų aibę.
- [ ] `jobStoreBackendContract.integration.test.js` komentaras LIEKA
      suderintas su parametrizuotu modeliu; sena „trečio atskiro testo"
      instrukcija negrąžinama (regresijos kriterijus — komentaras jau
      atnaujintas).

**CI ir matrica**

- [ ] Rinkinys realiai vykdomas IR `test:redis`, IR `test:postgres`
      žingsniuose (žr. 8 punktą).
- [ ] `npm run test:postgres` išvestyje matomi PostgreSQL adapterio
      scenarijai, ne `skip`.
- [ ] ⚠️ `jobStoreBackendContract.integration` LIEKA registruotas IR `redis`,
      IR `postgres` rinkiniuose (`tests/suites.js`). Registracija jau atlikta
      (#207) - tai regresijos kriterijus: iškritus iš `postgres`, adapteris
      PostgreSQL CI žingsnyje pats save praleistų.
- [ ] ⚠️ FAIL-CLOSED vykdymo įrodymas: su nustatytu `DATABASE_URL` įvykdytų
      PostgreSQL `įvykdyti + neatstovaujami` lyginami su `SCENARIJAI.length`
      ir `MISSING` privalo būti tuščias; `skip`
      arba nulis įvykdytų yra NESĖKMĖ.
- [ ] Matricos įrašai nuosavybės CAS garantijoms su mutacijos įrodymais.
- [ ] `npm run test:matrix` žalias.

**Regresijos**

- [ ] Duplicate idempotency write duoda kontroliuojamą `DUPLICATE_JOB`.
- [ ] Laikina PostgreSQL infrastruktūros klaida nėra paverčiama domeno
      rezultatu.
- [ ] Esami #159 ownership kontrakto testai lieka žali.
- [ ] PostgreSQL specifiniai integraciniai testai lieka žali.
- [ ] Memory ir Redis regresijų nėra.
- [ ] `common.js` `applyPatch()` išlaiko `id`, `ownerId`, `ownerKind`,
      `tenantId`, `idempotencyKey`, `schemaVersion` ir kūrimo laiko laukų
      nekintamumą memory/Redis keliuose; bendras kontraktų rinkinys neleidžia
      šiai garantijai išsiskirti tarp backend'ų.
- [ ] `reportProgressAtomic()` CAS VISADA NULL-safe lygina ankstesnius
      `progress_known`, `progress_current` ir `progress_total` su DB būsena —
      įskaitant `(false, NULL, NULL)` snapshot'ą.
- [ ] `POSTGRES_AKTYVAVIMAS_LEISTAS` šiame PR lieka `false`.
- [ ] 7.2b neprideda `jobs.version` ir neįgyvendina 7.5b bendro
      optimistic-locking kontrakto.
- [ ] Nepridėtas naujas viešas `"CONFLICT"` sentinelis nė vienoje iš trijų
      atominių operacijų.
- [ ] Queue/backend selection regresijų nėra (`canUseQueue()` semantika
      nepakitusi).
- [ ] Kiekvienas adapteris uždaro savo jungtis; rinkinys užsibaigia be
      pakibimo ir be `--force-exit`.
- [ ] Vieno backend'o būsena neteka į kitą.
- [ ] `npm test` ir visi privalomi CI scenarijai žali (`check`, `lint`,
      `test:suites`, `test:matrix`, `test:evidence`, `test:clean`).
- [ ] README apribojimų / Roadmap eilutės atnaujintos, jei 7.2b keičia tai, kas
      ten deklaruota apie job saugyklos būseną.

## Ko NEAPIMA

- PostgreSQL aktyvavimo barjero atidarymo.
- Eilės prieinamumo preflight (ADR aktyvavimo prielaida, ne 7.2b).
- `jobs.version`, bendro optimistic locking ir konflikto semantikos — 7.5b.
- Bendros klaidų hierarchijos (`RetryableDatabaseError` ir pan.) įvedimo.
- Persistentinių sesijų — 7.3.
- Audito perkėlimo — 7.4.
- Persistentinių deletion tombstones — 7.5a.
- Galutinio rezultatų užbaigimo / retention darbų, priklausančių 7.5b.
- Restore / disaster-recovery pratybų — 7.6.
- Redis BullMQ pakeitimo PostgreSQL eile.
- Bendro jobStore API perprojektavimo, jei to nereikia aukščiau aprašytam
  trijų backend'ų kontraktui.

## Implementavimo principas

Codex neturi kurti ketvirtos domeno taisyklių kopijos SQL'e.

Kur įmanoma:

- bendros domeno taisyklės lieka `common.js` / `jobPhase.js`;
- PostgreSQL SQL užtikrina atomiką ir CAS preconditions;
- DB constraints užtikrina persistentinės būsenos invariantus;
- parametrizuotas kontraktų rinkinys įrodo observable elgesio ekvivalentumą
  tarp memory, Redis ir PostgreSQL.

⚠️ Jei implementuojant paaiškėja, kad dabartinis memory arba Redis backend'as
neatitinka bendro kontrakto, testas **neturi būti silpninamas** vien tam, kad
visi trys taptų žali. Pirmiausia nustatomas autoritetingas domeno kontraktas ir
pataisoma nukrypstanti realizacija.

---

## [7.3] Persistentinės sesijos

**Tėvinis:** #155 · **Priklauso nuo:** 7.1

Sesijos perkeliamos iš atminties į PostgreSQL.

⚠️ **TAI AUTENTIKACIJOS PAKEITIMAS, NE SAUGYKLOS.** Kiekvienas žemiau esantis
kriterijus saugo nuo konkrečios regresijos, kurią realizacija gali padaryti
formaliai įvykdydama likusius. Ypač: `sessionStore` šiandien turi **du
nepriklausomus** galiojimo langus ir **256 bitų** bearer'į — schema, turinti
vieną `expires_at` ir `uuid` pirminį raktą, abu tyliai susilpnina.

## Schema

```sql
sessions (
  id                uuid primary key,       -- surogatas, NE bearer token
  token_hash        text not null unique,   -- NE pats token'as
  user_id           uuid not null,
  role              text not null,          -- snapshot + revoked_at
  created_at        timestamptz not null,
  expires_at        timestamptz not null,   -- ABSOLIUTUS langas
  idle_expires_at   timestamptz not null,   -- NEVEIKLUMO langas (žr. DoD)
  last_seen_at      timestamptz,
  revoked_at        timestamptz,
  schema_version    int not null default 1,

  constraint sessions_expires_after_created
    check (expires_at > created_at),
  constraint sessions_idle_after_created
    check (idle_expires_at > created_at),
  constraint sessions_last_seen_after_created
    check (last_seen_at is null or last_seen_at >= created_at),
  constraint sessions_revoked_after_created
    check (revoked_at is null or revoked_at >= created_at)
)
```

⚠️ **`idle_expires_at` yra ATSKIRAS stulpelis, ne išvestinis.** Alternatyva —
tikrinti `last_seen_at > now() - <idle>` — reikalauja, kad idle reikšmė būtų
žinoma SQL sakinio sudarymo metu; tai priimtina, bet tada ji privalo ateiti iš
`idleTimeoutMs(env)`, o ne būti įrašyta į migraciją. Pasirinkimas
eksplicitinis, ne paliktas realizacijai.

⚠️ **`last_seen_at <= expires_at` SĄMONINGAI NĖRA `CHECK`.** Paskutinio
naudojimo žyma ir absoliutus galiojimas turi ribinių atvejų (laikrodžio
poslinkis tarp replikų, `touch` ties pat riba), kuriuose constraint'as
atmestų teisėtą įrašą.

## DoD

### Token, hash ir identifikatorius

- [ ] **DB saugomas tik `token_hash`** — testas, kad plikas token'as lentelėje
      nerandamas. Nutekėjimas neturi virsti aktyvių sesijų perėmimu.

- [ ] ⚠️ **`id` ≠ bearer token.** `routes/auth.js:58` šiandien rašo
      `session.id` tiesiai į cookie. Su nauja schema tai paverstų DB pirminį
      raktą bearer token'u ir paneigtų hash-only garantiją. `create()` privalo
      grąžinti `{ session, token }` — suderinti pakeitimai `login`, `touch()`,
      `destroy()`.

- [ ] ⚠️ **ENTROPIJA NESUMAŽĖJA.** Rizika čia nėra vien „ID tapo token'u".
      Dabartinis `generateSessionId()` yra `crypto.randomBytes(32)` —
      **256 bitų** paslaptis, kuri sutampa su DB raktu, bet yra stipri.
      Naujas `id uuid` yra **122 bitai** IR saugoma reikšmė. Bearer token'as
      privalo likti ≥ 256 bitų `crypto.randomBytes`, nepriklausomas nuo `id`.
      Testas: token'o entropija ir formatas tikrinami eksplicitiškai; `uuid`
      formos token'as atmetamas.

- [ ] ⚠️ **TRIJŲ REIKŠMIŲ ATSKYRIMAS ĮRODOMAS.** Nepakanka parodyti, kad DB
      nėra plikojo token'o. Testas privalo patvirtinti, kad cookie reikšmė
      **nėra** `sessions.id` IR **nėra** `token_hash` — kitaip realizacija,
      dedanti hash'ą į cookie, praeitų hash-only kriterijų ir paverstų DB
      turinį tiesiogiai panaudojama paslaptimi.

- [ ] ⚠️ **HASH DETERMINISTINIS IR PLAINTEXT NEPALIEKA AUTH RIBOS.**
      `find`/`touch`/`destroy` gauna bearer token'ą, apskaičiuoja tą patį
      vienkryptį `token_hash` ir ieško PAGAL JĮ; DB užklausa niekada neieško
      pagal plikąjį token'ą. Plikas token'as nepatenka į logus, auditą, klaidų
      metaduomenis ar `support-bundle`. Testas: token'as nerandamas nė viename
      diagnostikos artefakte.

      ⚠️ **`timingSafeEqual()` ČIA NEREIKALINGAS.** Paieška vyksta per
      `WHERE token_hash = $1`, t. y. palyginimą daro DB indeksas — papildomas
      pastovaus laiko sluoksnis JS pusėje nieko neapsaugotų ir tik sudarytų
      įspūdį, kad apsauga yra ten, kur jos nėra. Esminė garantija — kad
      plaintext niekada nepersistinamas ir nepaliekamas už autentikacijos ribos.

- [ ] ⚠️ **SESSION CREATE YRA FAIL-CLOSED.** Jei persistentinės sesijos įrašyti
      nepavyksta, prisijungimas NELAIKOMAS sėkmingu ir `Set-Cookie` su nauju
      bearer token'u NEIŠSIUNČIAMAS.

      ⚠️ Tvarka svarbi: `routes/auth.js` šiandien kviečia `create()`, tada
      `setSessionCookie()`, tada rašo auditą. Realizacija, siunčianti cookie
      prieš patvirtintą DB įrašymą, paliktų klientą su token'u, kurio
      lentelėje nėra — vartotojas atrodytų prisijungęs iki pirmos užklausos.

      Testas: DB rašymo klaida per `create()` → nėra galiojančios cookie, nėra
      dalinės sesijos, o audite įvykis pažymėtas kaip nesėkmė.

- [ ] ⚠️ **`token_hash` ALGORITMAS FIKSUOTAS: SHA-256, LOWERCASE HEX.**

      ```text
      token_hash = SHA-256(raw bearer token)   // crypto.createHash("sha256")
      ```

      Tas pats VIENAS helperis naudojamas visuose sesiją identifikuojančiuose
      keliuose (`create`, `touch`, `destroy`).

      ⚠️ **LĖTI KDF GRIEŽTAI DRAUDŽIAMI — TAI DoS, NE STILIUS.**
      `utils/credentials.js` naudoja `crypto.scryptSync` su
      `SCRYPT_N = 1 << 14` (50–100 ms vienam skaičiavimui). Panaudojus tą patį
      helperį sesijoms, KIEKVIENA autentifikuota užklausa kainuotų 50–100 ms
      CPU, nes `touch()` kviečiamas kiekvienai — thread pool išsektų iš karto.

      Lėti KDF reikalingi MAŽOS entropijos slaptažodžiams. Bearer token'as turi
      ≥256 bitų `crypto.randomBytes` ir yra atsparus brute-force pagal
      konstrukciją, tad jam reikia GREITOS vienkryptės maišos.

      **Testai — TRYS, IR NĖ VIENAS NEMATUOJA `touch()`:**

      1. **Determinizmas:** tas pats token'as visada duoda tą patį hash.
         ⚠️ Šis testas VIENAS jau atmeta `bcrypt`, `argon2` ir įprastą
         `scrypt`: jie naudoja atsitiktinę druską, tad tos pačios įvesties
         rezultatas skiriasi kaskart. Lieka pridengti tik fiksuotos druskos
         atvejį.
      2. **Formatas:** rezultatas yra 64 simbolių lowercase hex (SHA-256
         išvestis). `scryptSync` su projekto parametrais duoda kitokį ilgį.
      3. **Greitis — IZOLIUOTAS HELPERIS, ne `touch()`:** 1000 hash'ų
         skaičiavimų trunka < 100 ms. SHA-256 tai atlieka per kelias
         milisekundes, o `scrypt` su `SCRYPT_N = 1 << 14` — apie 50–100
         SEKUNDŽIŲ. Riba parinkta su ~1000× atsarga sąmoningai.

      ⚠️ **`touch()` TRUKMĖ NEMATUOJAMA.** Ji apima PostgreSQL round-trip, tad
      bet kokia riba būtų flaky CI aplinkoje ir kristų prie TEISINGOS
      realizacijos. Matuojamas tik hash helperis, kur skirtumas tarp SHA-256 ir
      KDF yra keturios eilės, o ne matavimo triukšmas.

      ⚠️ Šaltinio teksto tikrinti („ar nėra `scrypt`") NEREIKIA: trys testai
      aukščiau tikrina ELGESĮ, ir jų neapeis nė viena lėta ar nedeterministinė
      realizacija.

- [ ] ⚠️ **GALUTINIS PUBLIC KONTRAKTAS.**

      ```js
      create(identity, env)        -> { session, token }
      touch(token, env)            -> session | null
      destroy(token)               -> boolean
      destroyAllForUserId(userId)  -> number
      sweepExpired(env)            -> number
      size()                       -> number
      ```

      `create()` grąžinamas `token` yra VIENINTELĖ klientui siunčiama reikšmė.

      PostgreSQL backend'e `destroy(token)` ir `destroyAllForUserId()` reiškia
      LOGINĘ revokaciją per `revoked_at`, ne fizinį `DELETE`; fizinis šalinimas
      priklauso tik retencijos keliui po `expires_at`.

      `destroyAllForUser(username)` lieka tik memory suderinamumui; naujas
      PostgreSQL kodas naudoja stabilų `user_id`.

### Galiojimo langai

- [ ] ⚠️ **IDLE IR ABSOLIUTUS GALIOJIMAS IŠLIEKA ATSKIRI.**

      `sessionStore.touch()` šiandien tikrina DU nepriklausomus langus:

      ```js
      const idleExpired     = now - session.lastSeenAt > idleTimeoutMs(env);
      const absoluteExpired = now - session.createdAt  > absoluteTimeoutMs(env);
      ```

      Vienas `expires_at` išreiškia tik antrąjį. Realizacija, įvykdanti
      sąlyginio `UPDATE` kriterijų pažodžiui, **tyliai prarastų 30 minučių
      neveiklumo timeout'ą**: pavogtas įrenginys su atidaryta sesija liktų
      autorizuotas 12 valandų vietoj 30 minučių.

      Sąlyginis `UPDATE` privalo tikrinti ABU langus.
      **Testas:** sesija, nenaudota ilgiau nei `SESSION_IDLE_TIMEOUT_MINUTES`,
      NEAUTORIZUOJA, nors `expires_at` dar ateityje.

- [ ] ⚠️ **`SESSION_IDLE_TIMEOUT_MINUTES` ir `SESSION_ABSOLUTE_TIMEOUT_HOURS`
      toliau veikia.** Testas kiekvienam atskirai: sumažinta reikšmė realiai
      sutrumpina ATITINKAMĄ langą (ir nepaliečia kito).

- [ ] ⚠️ **`touch` PRATĘSIA IDLE, BET NE ABSOLIUTŲ langą.** Kitaip aktyviai
      naudojama sesija niekada nepasibaigtų, ir absoliutus timeout taptų
      dekoracija. Testas: po daugkartinio `touch` `expires_at` NEPASIKEITĘS.

- [ ] ⚠️ **VIENAS LAIKO ŠALTINIS: DB LAIKRODIS.**

      `expires_at` ir `idle_expires_at` skaičiuojami DB pusėje
      (`now() + $interval`), ne `Date.now()` proceso pusėje.

      Priežastis: atominis `touch` `UPDATE` tikrina `expires_at > now()` ir
      `idle_expires_at > now()` — DB laikrodžiu. Jei reikšmės rašomos proceso
      laikrodžiu, tas pats sprendimas remiasi DVIEM šaltiniais, ir jų poslinkis
      nutrauks sesijas anksčiau ar vėliau nei nustatyta, o daugiaprocesėje
      aplinkoje — nevienodai.

      ⚠️ Poslinkis šiame projekte JAU pripažintas realiu: būtent dėl jo
      `last_seen_at <= expires_at` sąmoningai nėra `CHECK`. Negalima to
      pripažinti viename kriterijuje ir ignoruoti kitame.

      **Testai:** sesija, sukurta procesui su pastumtu laikrodžiu, galioja
      pagal DB laiką; `create()` ir `touch()` naudoja tą patį šaltinį.

### Versijavimas

- [ ] ⚠️ **`schema_version` tikrinama kaip UŽDARA palaikomų versijų AIBĖ.**
      `> PALAIKOMA` praleidžia `0`, `-1` ir bet kokią neatpažintą senesnę
      reikšmę. Reikia `PALAIKOMOS.has(v)`.

      Rollback testas: sesija su `schema_version + 1`, `0`, `-1` IR bet kokia
      kita už palaikomų aibės ribų atmetama. ⚠️ Tikrinti tik `+1` nepakanka:
      realizacija su `schema_version > PALAIKOMA` tokį testą praeitų.

- [ ] ⚠️ **Reikšmė NORMALIZUOJAMA prieš `has()`.** Draiveris gali grąžinti
      `"1"` kaip eilutę, o `PALAIKOMOS.has("1")` yra `false` — galiojanti
      sesija būtų atmesta. Konversija eksplicitinė, su testu abiem tipams.

- [ ] ⚠️ **SESIJŲ PALAIKOMŲ VERSIJŲ AIBĖ YRA `{1}`.**

      Schema nustato `default 1`, tad `PALAIKOMOS` = `{1}` — ne `{2}` ir ne
      „viskas iki dabartinės".

      ⚠️ **NESUSIJĘ SU `jobs.schema_version`.** Tas naudoja `{NULL, 2}` ir žymi
      ĮRAŠO ERĄ (#158, `actor` interpretavimą); sesijų `schema_version` žymi
      SESIJOS EILUTĖS formatą. Dvi nepriklausomos numeracijos — jų suderinimas
      „tvarkos dėlei" sulaužytų vieną iš jų.

### Tapatybė ir revokacija

- [ ] `username` **nepersistinamas** — jis yra `AUTH_USERS` rodinys; auditas
      naudoja pseudonimizuotą `subject_id`.

- [ ] ⚠️ **`req.user.username` IŠVEDAMAS IŠ `user_id`.** Jis naudojamas
      keturiose vietose, įskaitant AUDITO AKTORIŲ:
      `routes/jobs.js:54`, `routes/transcribeJobs.js:64`,
      `routes/auth.js:141`, `middleware/authorize.js:49`.

      Nustojus jį persistinti, kiekviena iš jų privalo gauti vardą iš
      `AUTH_USERS` pagal `user_id`. Vartotojas, pašalintas tarp startinio
      suderinimo ciklų, negali virsti `undefined` aktoriumi audite.
      **Testas:** `authorize.js` aktorius teisingas po vardo pakeitimo
      `AUTH_USERS`; ištrintas vartotojas duoda apibrėžtą reikšmę, ne
      `undefined`.

- [ ] Rolė — snapshot + `revoked_at` (#158 jau turi `destroyAllForUserId()`).

- [ ] ⚠️ **STARTINIS SUDERINIMAS.** `docs/auth-deployment.md` garantuoja, kad
      pašalinus vartotoją iš `AUTH_USERS` ir perkrovus prieiga dingsta IŠ KARTO
      (sesijos atmintyje). Po 7.3 sesija išgyventų restartą su SENA role — tyli
      saugumo regresija. Paleidžiant tikrinti, ar `user_id` vis dar yra
      `AUTH_USERS` ir ar rolė nepasikeitė; nesutampa → `revoked_at`.

- [ ] ⚠️ **STARTINIS SUDERINIMAS YRA READINESS BARJERAS.**

      „Paleidžiant tikrinti" leistų HTTP serveriui pakilti, o suderinimą
      atlikti fone — tame lange sena persistentinė sesija su ATŠAUKTA role dar
      autorizuotų užklausas.

      Karkasas jau yra: `server.js:66` turi `readiness = { jobStore,
      jobRunner }` ir `requireJobSystemReady` middleware. Suderinimui reikia
      TREČIOS vėliavos (pvz. `sessionReconcile`), kurios laukia ir `/api/ready`,
      ir kiekvienas autentifikuojamas maršrutas.

      Nepavykus suderinimui sistema lieka not-ready arba startas nutrūksta —
      sena rolė ar pašalinto vartotojo sesija negali būti autorizuota nė
      trumpam.

      Testas: paleidimo metu DB yra sesija su pasenusia role → iki revokacijos
      autentifikuota užklausa NEAPTARNAUJAMA.

- [ ] Testas: vartotojo pašalinimas + restartas → sesija atšaukta.
- [ ] Testas: rolės sumažinimas + restartas → sesija atšaukta.

- [ ] ⚠️ **LOGOUT / REVOKACIJA YRA GLOBALI.** Atsijungimas viename procese
      nustato PERSISTENTINĘ revokaciją; kitas procesas su ta pačia cookie jos
      nebepriima. Revokacijos rezultatas negali priklausyti nuo proceso
      lokalios atminties ar cache. **Testas: du procesai arba restartas**, ne
      vien „įrašas DB yra".

- [ ] ⚠️ **AUTENTIKACIJA IR `touch()` — VIENA SĄLYGINĖ OPERACIJA.**
      Daugiaprocesėje aplinkoje vienas procesas gali perskaityti sesiją per
      `findByToken()`, kitas tuo metu nustatyti `revoked_at` (atsijungimas,
      administracinė revokacija, startinis suderinimas), o pirmasis atnaujinti
      `last_seen_at` ir autorizuoti pasenusį snapshot'ą.

      Revokacija, absoliutus galiojimas, neveiklumo timeout ir `touch` privalo
      būti VIENAS sąlyginis sakinys:

      ```sql
      UPDATE sessions
         SET last_seen_at = now(), idle_expires_at = now() + <idle>
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()
         AND idle_expires_at > now()
      RETURNING *
      ```

      Testas: lenktynės ties draiverio riba — revokacija privalo suveikti iš
      karto (fail-closed).

- [ ] ⚠️ **`destroy()` KVIETIMO VIETA: `routes/auth.js:81`.**

      Atsijungimas šiandien kviečia `sessionStore.destroy(sessionId)`, kur
      `sessionId` yra cookie reikšmė (dabartinis `session.id`). Po 7.3 cookie
      turės TOKEN'Ą, tad ši vieta privalo būti suderinta kartu su kontraktu.

      Palikus nepakeistą, atsijungimas TYLIAI nustotų veikti: `destroy()`
      gautų token'ą, ieškotų pagal `id`, nerastų eilutės, grąžintų `false`, o
      cookie liktų galiojanti.

      **Testas:** atsijungimas revokuoja sesiją; ta pati cookie po jo
      NEAUTENTIFIKUOJA.

- [ ] ⚠️ **RECONCILIATION SĖKMĖ YRA VISAS CIKLAS, NE DALINĖ BŪSENA.**

      Suderinimas laikomas sėkmingu tik patikrinus VISAS aktualias
      nerevokuotas sesijas. Nutrūkus viduryje, `sessionReconcile` readiness
      NETAMPA `true` ir serveris srauto nepriima.

      Jau atliktos revokacijos gali likti committed — vienos transakcijos
      NEREIKALAUJAMA (dideliam kiekiui ji būtų blogesnė). Reikalaujama, kad
      operacija būtų IDEMPOTENTINĖ, tad pakartotinis startas saugiai užbaigtų
      likusią dalį.

      **Testas:** klaida ciklo viduryje → not-ready arba startas nutrūksta;
      pakartotinis suderinimas vykdomas saugiai.

### Gedimai

- [ ] ⚠️ **SESSION STORE GEDIMAS = FAIL-CLOSED.** Kai PostgreSQL yra sesijų
      autoritetas, DB timeout ar prisijungimo klaida NEGALI sukelti fallback į
      in-memory sesijas ar autorizuoti vartotojo iš lokalaus snapshot'o.
      Užklausa atmetama kontroliuojama klaida, o readiness rodo, kad
      autentikacijos priklausomybė neveikia.

      ⚠️ **KRITERIJUS YRA DRAUDIMAS, ne reikalavimas.** `middleware/sessionAuth.js`
      šiandien neturi `try/catch` aplink `touch()`, tad išimtis virsta 500 —
      elgesys jau beveik teisingas. Tvarkant tą 500 lengva pridėti
      `catch { return null; }`, ir gedimas taptų TYLIU neautorizavimu,
      neatskiriamu nuo „sesijos nėra". To daryti negalima.

      **Testas:** egzistuojanti galiojanti sesija + DB tampa nepasiekiama →
      užklausa NEAUTORIZUOJAMA, atsakymas atskiriamas nuo 401 „nėra sesijos".

- [ ] ⚠️ **`optionalSession` TAIP PAT FAIL-CLOSED, JEI COOKIE YRA.**

      `middleware/sessionAuth.js:110` `optionalSession` daro tą patį
      `await sessionStore.touch(sessionId)` kaip `requireSession`. Semantika
      priklauso nuo to, ar klientas pateikė credential'ą:

      - cookie NĖRA → tęsiama su `req.user = null`;
      - cookie YRA, bet sesija neegzistuoja / pasibaigusi / revokuota →
        tęsiama su `req.user = null` (esamas kontraktas);
      - cookie YRA, bet PostgreSQL NEGALI patikrinti būsenos (timeout,
        connection, query klaida) → **503 `SESSION_STORE_UNAVAILABLE`**.

      DB gedimas NEGALI virsti „vartotojas neprisijungęs": tai paverstų
      autentifikuotą užklausą anonimine ir nukreiptų ją į kitą autorizacijos
      šaką.

      **Testas:** optional maršrutas + galiojanti cookie + DB nepasiekiama →
      503, ne anoniminis vykdymas.

- [ ] ⚠️ **SESIJŲ INVARIANTAI TIKRINAMI INICIJUOJANT.**

      `jobStore` PostgreSQL init'as jau tikrina `REQUIRED_JOB_CONSTRAINTS`
      (#155, 7.2a): lentelės buvimo nepakanka, nes DB su dalimi migracijų
      lenteles turi, o invariantų — ne, ir readiness paskelbtų saugyklą
      pasiruošusia.

      7.3 prideda KETURIS `sessions` `CHECK` invariantus; ta pati spraga
      galioja jiems. Sesijų init'as tikrina savo privalomų constraint'ų
      rinkinį taip pat. Sąrašo pilnumą tikrina testas, IŠVEDANTIS jį iš
      šviežiai migruotos DB (`contype = 'c'` ant `sessions`), ne surašantis
      ranka.

      **Testas:** migracija be sesijų invariantų → startas nutrūksta.

- [ ] ⚠️ **DRAUDIMAS TURI SARGĄ, NE TIK FORMULUOTĘ.**

      Reikalavimas „`sessionAuth` negali naudoti `findByToken()`" be patikros
      yra komentaras: pirmas refaktoringas jį apeis, o TOCTOU langas grįš
      tyliai.

      Priimtinas bet kuris vienas: (1) `findByToken` NEEKSPORTUOJAMAS, tad jo
      panaudoti fiziškai neįmanoma; (2) eksportuojamas su `_`-prefiksu IR yra
      testas, kad `middleware/sessionAuth.js` jo nekviečia.

      **Testas:** autentikacijos kelias atlieka VIENĄ sesijų užklausą; dvi
      (skaitymas + mutacija) yra nesėkmė.

- [ ] ⚠️ **AUTENTIKACIJOS KELYJE NĖRA `findByToken()` → `touch()` SEKOS.**

      `touch(token)` YRA pati autentikacijos operacija: vienu sąlyginiu SQL
      sakiniu ji randa pagal `token_hash`, tikrina `revoked_at IS NULL`,
      absoliutų ir idle galiojimą, pratęsia TIK idle langą ir grąžina per
      `RETURNING *`.

      Draudžiamas modelis:

      ```text
      findByToken(token) -> patikrinti JS -> touch(token) -> autorizuoti
      ```

      Tarp skaitymo ir mutacijos atsiranda revokacijos TOCTOU langas.

- [ ] ⚠️ **`touch()` TIKRINA `AUTH_USERS` DINAMIŠKAI, NE TIK STARTE.**

      Startinis suderinimas dengia TIK restartą. Vartotojas, ištrintas iš
      `AUTH_USERS` arba pažemintas RUNTIME metu, su galiojančia sesija toliau
      autorizuotų užklausas SENA role iki kito restarto — privilegijų
      eskalavimas.

      `middleware/sessionAuth.js:89` ir `middleware/authenticate.js:27` kviečia
      `touch()`; nei jie, nei `sessionStore` šiandien `AUTH_USERS` netikrina.

      Radus sesiją DB, store'as privalo patikrinti `user_id` prieš gyvą
      `loadUsersById()` (`credentials.js:278`). Vartotojo nėra arba rolė
      nesutampa su sesijos snapshot'u → fail-closed: `null` IR
      `revoked_at = now()`.

      **Testas:** vartotojo ištrynimas iš `AUTH_USERS` BE restarto → kitas
      `touch()` grąžina `null`, o DB įrašas pažymimas revokuotu.

- [ ] ⚠️ **`sessionStore` POOL GYVAVIMO CIKLAS.**

      `jobStore/index.js` jau turi modelį: `connectionTimeoutMillis`, o klaidos
      atveju `pool.end().catch(() => {})` prieš metant. Be to paties sesijų
      pusėje nepavykusi inicijacija paliktų atviras jungtis, ir integraciniai
      testai KABOTŲ vietoj kritimo.

      Init'as ir invariantų užklausos apgaubiamos `try/catch` su garantuotu
      pool uždarymu; store'as eksportuoja švarų išjungimo kelią.

### Retencija

- [ ] ⚠️ **RETENCIJOS SEMANTIKA EKSPLICITINĖ.** Vien „`expires_at` +
      revokuotos valomos" leistų `DELETE WHERE revoked_at IS NOT NULL`, t. y.
      fizinį ištrynimą iš karto — ir prarastumėte galimybę atsakyti, ar cookie
      buvo ATŠAUKTA, ar jos niekada nebuvo.

      Politika: revokuota sesija saugoma bent iki savo `expires_at`; po jo
      šalinama kartu su pasibaigusiomis.

- [ ] Testai: aktyvi nepasibaigusi sesija NEŠALINAMA; pasibaigusi šalinama;
      revokuota, bet dar nepasibaigusi, NEŠALINAMA; revokuota ir pasibaigusi
      šalinama. Cleanup **idempotentiškas** (antras paleidimas = 0 pakeitimų).

### Laiko invariantai DB lygiu

- [ ] `expires_at > created_at` — neigiamas DB testas.
- [ ] `idle_expires_at > created_at` — neigiamas DB testas.
- [ ] `last_seen_at IS NULL OR last_seen_at >= created_at` — neigiamas testas.
- [ ] `revoked_at IS NULL OR revoked_at >= created_at` — neigiamas testas.

⚠️ Kiekvienam invariantui reikia atskiro testo, įrašančio pažeidžiančią eilutę
APEINANT store'ą — kitaip tikrinamas JS, ne DB.

- [ ] ⚠️ **`REQUIRED_SESSION_CONSTRAINTS` PILNUMAS IŠVEDAMAS.**

      Testas `tests/migrations.integration.test.js` nuskaito VISUS
      `contype = 'c'` constraint'us ant `sessions` iš šviežiai migruotos DB ir
      lygina su tikrinamu sąrašu per `deepEqual`.

      Tas pats modelis kaip `REQUIRED_JOB_CONSTRAINTS` (#155, 7.2a), kur
      dalinis sąrašas praleido tris invariantus, ir tai pastebėjo tik peržiūra.
      Narystės patikra po vieną tikrintų tik apatinę ribą.

### Suderinamumas ir cutover

- [ ] Restartas: ta pati cookie, sesija randama DB, `req.user` atkuriamas.
- [ ] Esami `sessionAuth` testai praeina **be modifikacijų**.
- [ ] `docs/auth-deployment.md` rotacijos/revokacijos procedūra atnaujinta.
- [ ] Cutover: esamos in-memory sesijos **nėra** perkeliamos — vartotojai
      prisijungia iš naujo. Įrašyta į diegimo pastabas.
- [ ] ⚠️ **SESIJŲ BACKEND'O AKTYVAVIMAS EKSPLICITINIS.**

      Vien `DATABASE_URL` buvimas sesijų režimo NEKEIČIA. Jis gali būti
      įvestas dėl migracijų, audito (7.4) ar bet kurios kitos #155 dalies, ir
      neturi netikėtai pakeisti AUTENTIKACIJOS režimo.

      PostgreSQL sesijos aktyvuojamos tik eksplicitiniu
      `SESSION_STORE_BACKEND=postgres` (vienu aiškiai dokumentuotu jungikliu).
      Nežinoma reikšmė → starto klaida, ne fallback. Pasirinkus PostgreSQL, DB
      inicializacijos klaida → fail-closed, ne in-memory fallback.

      ⚠️ Tai ATSKIRAS jungiklis nuo `JOB_STORE_BACKEND` (#155, 7.2a).
      Sujungus juos vienu kintamuoju, job metaduomenų barjero atidarymas
      automatiškai perjungtų ir autentikaciją — du nesusiję sprendimai taptų
      vienu.

      Testai: `DATABASE_URL` vienas → esamas (in-memory) režimas; eksplicitinis
      `postgres` + veikianti DB → PostgreSQL; eksplicitinis `postgres` +
      neveikianti DB → startas arba readiness krinta.

- [ ] ⚠️ **SESSION AUTHORITY PARUOŠIAMAS PRIEŠ `app.listen()`.**

      `startServer()` jau turi stiprią garantiją: `jobStore.init()` ir
      `jobRunner.init()` baigiami PRIEŠ `app.listen()`. 7.3 įsijungia į tą
      patį modelį:

      ```text
      jobStore.init()
      -> sessionStore.init()
      -> sesijų schemos/invariantų validacija
      -> AUTH_USERS suderinimas
      -> jobRunner.init()
      -> app.listen()
      ```

      Tiksli `jobRunner` pozicija gali keistis, bet `sessionStore.init()` +
      validacija + suderinimas PRIVALO būti sėkmingai baigti prieš `listen()`.

      ⚠️ **VIEN READINESS MIDDLEWARE NEPAKANKA.** `authRoute` prijungtas
      `server.js:86` BE `requireJobSystemReady`, tad middleware sprendimas
      paliktų `/api/auth/login` landą į pusiau inicijuotą sesijų saugyklą.
      Readiness vėliava lieka defense-in-depth, ne pakaitalas.

      **Testas:** kvietimų tvarka įrodo, kad `listen` nevyksta, kol
      suderinimas nebaigtas; suderinimo klaida reiškia, kad `listen`
      apskritai nekviečiamas.

- [ ] ⚠️ **SESIJŲ MIGRACIJA — NAUJAS LAIKO ŽYMĖS FAILAS.**

      `node-pg-migrate` praleidžia failą pagal VARDĄ, tad jau migruotoje DB
      pakeista esama migracija NEBŪTŲ pritaikyta: švarios DB testai praeitų, o
      egzistuojančios liktų be `sessions` — tyliai, nes antras `migrate:up`
      teisėtai yra no-op. Tai jau įvyko #155 darbe (#200).

      **Testas:** atnaujinimas iš dabartinės `main` schemos sukuria `sessions`
      su visais invariantais (ne tik švari DB → pilna schema).

- [ ] ⚠️ **SAUGUMO TESTŲ MATRICA PAPILDYTA.**

      `scripts/check-security-matrix.mjs` reikalauja įrašo KIEKVIENAM
      `security` rinkinio testui — be jo CI krinta (#199).

      Būtini įrašai su evidence stulpeliu: hash-only saugojimas (cookie ≠ `id`
      ir ≠ `token_hash`); autentikacija ir `touch` kaip viena sąlyginė
      operacija; idle IR absoliutus langas; gedimas → 503, ne 401; startinis
      suderinimas kaip readiness barjeras; globali revokacija.

      **Kriterijus:** `npm run test:matrix` žalias.

- [ ] ⚠️ **SESIJŲ BACKEND'Ų KONTRAKTO EKVIVALENTUMAS.**

      `tests/authFoundation.test.js` šiandien tikrina TIK memory. Du atskiri
      keliai be bendro rinkinio išsiskiria tyliai — tai jau įvyko job store
      pusėje (#155: `tenantId`, `idempotencyKey`, `created_at`, tipų
      konvertavimas).

      Reikalingas `sessionStoreBackendContract.integration.test.js` pagal tą
      patį adapterio modelį kaip `jobStoreBackendContract`: identiški
      scenarijai (kūrimas, `touch`, revokacija, idle ir absoliutus
      pasibaigimas, retencija) prieš memory IR PostgreSQL.

      Registruojamas ABIEJUOSE rinkiniuose, kad `test:postgres` jį realiai
      vykdytų; adapteriai po savęs uždaro jungtis.

- [ ] ⚠️ **PostgreSQL SESIJA VISADA TURI STABILŲ `user_id`.**

      `sessions.user_id` yra `NOT NULL`, tad PostgreSQL režimas NEGALI kurti
      sesijos be stabilaus ID. `create(identity)` reikalauja galiojančio
      `identity.id` iš `AUTH_USERS` (#158). Jo nėra ar netinkamas → sesija
      NESUKURIAMA, cookie NEIŠSIUNČIAMA, login nesėkmingas, fail-closed.

      Memory backend'as gali išlaikyti `userId: null` toleranciją tik legacy
      testams; produkciniame PostgreSQL `user_id IS NULL` sesijų NĖRA.

- [ ] ⚠️ **PLIKAS TOKEN'AS NEPATENKA Į LOGUS IR AUDITĄ — TIKRINAMA.**

      Reikalavimas „token'as nerandamas nė viename diagnostikos artefakte" be
      testo yra deklaracija. Testas perima logavimo ir audito išvestį ir
      tikrina, kad plikas token'as niekada neperduodamas — IR sėkmingame, IR
      nesėkmingame autentikacijos kelyje.

- [ ] **SESIJŲ TIMEOUT'Ų KONFIGŪRACIJA VALIDUOJAMA STARTE.**

      `SESSION_IDLE_TIMEOUT_MINUTES` ir `SESSION_ABSOLUTE_TIMEOUT_HOURS`
      tikrinami `utils/startupChecks.js`: neigiamos, nulinės ar ne skaitinės
      reikšmės atmetamos starte, o ne tyliai virsta numatytosiomis ar
      begaliniais langais.

- [ ] **`SESSION_STORE_BACKEND` VALIDUOJAMAS STARTE.**

      `utils/startupChecks.js` šiandien tikrina sesijų timeout'us
      (133–140 eil.), bet nė vieno backend'o jungiklio. Neteisinga reikšmė ar
      `postgres` be `DATABASE_URL` praeitų konfigūracijos patikrą ir kristų
      vėliau, inicijavimo metu — su prastesniu pranešimu ir po to, kai dalis
      sistemos jau pakilusi.

      Validuojama kartu su timeout'ais: reikšmė yra `memory` arba `postgres`;
      pasirinkus `postgres`, `DATABASE_URL` privalomas.

      ⚠️ `JOB_STORE_BACKEND` šiandien irgi nevaliduojamas `startupChecks`, bet
      jo apsauga yra `resolveBackendChoice()` (#155, 7.2a), kuri meta klaidą
      ties nežinoma reikšme. Sesijoms reikia to paties lygio apsaugos — ar
      `startupChecks`, ar analogiškame resolveryje, bet NE tyliai.

- [ ] **`destroyAllForUser(username)` ELGESYS PostgreSQL REŽIME APIBRĖŽTAS.**

      ⚠️ Produkcinis kodas jo NEKVIEČIA — vieninteliai kvietėjai yra
      `tests/authFoundation.test.js` (221, 227, 553, 576 eil.), tarp jų #158
      suderinamumo testas. Tai ne veikianti administracinė funkcija, o
      atgalinio suderinamumo paviršius.

      Todėl reikalavimas yra APIBRĖŽTUMAS, ne funkcionalumas. Priimtinas bet
      kuris vienas, bet pasirinkimas eksplicitinis:

      1. įgyvendinti per `loadUsers(env)` → `user_id` → `revoked_at = now()`;
      2. mesti apibrėžtą klaidą PostgreSQL režime, jei metodas laikomas
         legacy.

      ⚠️ Ko NEGALIMA: tyliai grąžinti `0`. Tai atrodytų kaip „vartotojas
      neturėjo sesijų", o realiai reikštų neįvykusią revokaciją — tas pats
      tylaus nesuveikimo šablonas, kurį #155 gaudė keturis kartus.

      **Testas:** esami `authFoundation` testai praeina prieš PASIRINKTĄ
      semantiką be silpninimo.


## Ko NEAPIMA

Audito perkėlimo (7.4) ir job metaduomenų (7.2a/7.2b). Sesijų lentelė
nepriklausoma nuo `jobs` — FK tarp jų nėra.


---

## [7.4] Persistentinis audit log

Išskaidyta. Darbo tekstai gyvena vaikuose žemiau:

| Sub-PR | Issue | Apimtis |
|---|---|---|
| `7.4a` | #210 | Audit fasado async cutover |
| `7.4b` | #211 | `audit_log` schema ir postgres backend |
| `7.4c` | #212 | Rakto rotacija ir audit užklausos |
| `7.4d` | #213 | Retencija, privatumo režimas, readiness ir CI |

Šioje sekcijoje DoD punktų nebelaikome - kitaip tas pats darbas turėtų
dvi versijas spec'e.

---

## [7.4a] Audit fasado async cutover

**Tėvinis:** #155 · **Priklauso nuo:** — · **Blokuoja:** 7.4b

Mechaninis, bet plataus poveikio žingsnis: `record()` ir `getAll()` tampa async, kad
PostgreSQL backend'as apskritai būtų įmanomas. **Backend'as lieka memory, išorinis
elgesys nesikeičia.** Atskirtas į savo PR'ą, nes liečia kiekvieną call site'ą — kartu
su schema review taptų neįmanomas, o regresija — nepastebima.

### Užfiksuoti sprendimai

Agentas jų NEKEIČIA ir nesirenka alternatyvų:

- Audit write timeout: `AUDIT_WRITE_TIMEOUT_MS`, numatyta `2000`.
- **Blokuojantys įvykiai** (sėkmė negali būti deklaruota prieš patvirtintą write):
  autentikacija/autorizacija, GDPR ištrynimas, provider override, rakto rotacija.
  Klaida arba timeout → veiksmas atmetamas (fail-closed).
- **Neblokuojantys**: job gyvavimo ciklo įvykiai. Klaida → užklausa nekrenta, bet
  logginama `error` lygiu su `request_id` ir didinamas skaitiklis. Niekada nenutylima.
- Trečios kategorijos nėra: kiekvienas `record()` kvietėjas priklauso vienai iš dviejų.

### DoD

- [ ] `record()` ir `getAll()` async; `removeBySubjectIdentifier()` jau async.
- [ ] Visi produkciniai call site'ai migruoti — pilnas sąrašas PR body.
- [ ] ⚠️ **NĖ VIENO fire-and-forget kvietimo.** Testas: backend meta klaidą;
      blokuojančiame kelyje veiksmas atmetamas, neblokuojančiame — sulogginama, ir
      NEI VIENU atveju nekyla `unhandledRejection`. Teste registruojamas
      `process.on("unhandledRejection")` ir tikrinama, kad nesuveikė.
- [ ] ⚠️ **`authorizeJobOrAudit()` ir `lifecycleService.writeAudit()`** šiandien
      kviečia sinchroniškai ir NELAUKIA. Po cutover jie arba `await`, arba
      eksplicitiškai apdoroja klaidą pagal savo kategoriją — tylus tęsimas neleidžiamas.
- [ ] **Vienas autoritetingas įvykių klasifikacijos žemėlapis** (blokuojantis /
      neblokuojantis), ne sprendimas kiekviename call site'e. Testas: kiekvienas
      žinomas audit event turi klasifikaciją; neklasifikuotas → klaida starto metu.
- [ ] Timeout testas: backend kabo ilgiau nei `AUDIT_WRITE_TIMEOUT_MS` → blokuojantis
      kelias atmeta per ribotą laiką, užklausa neužstringa.
- [ ] ⚠️ **Klaidos objektas nepatenka į atsakymą.** Audit gedimo pranešimas klientui
      eina per `utils/sanitizeError.js`; pilnas tekstas tik serverio loge.
- [ ] Nė vieno naujo `catch {}` ar `.catch(() => {})` apie audit kvietimą — grep'as
      PR body.
- [ ] Esami `auditLog.test.js` ir `auditErasure.service.test.js` praeina. Leidžiama
      TIK `await` pridėjimas harness'e; assertion'ų šalinimas ar lūkesčių keitimas — ne.

### Ko NEAPIMA

PostgreSQL. Jokios schemos, jokio `DATABASE_URL`, jokios naujos priklausomybės.

---

## [7.4b] audit_log schema ir postgres backend

**Tėvinis:** #155 · **Priklauso nuo:** 7.1, 7.4a

`audit_log` lentelė, `postgresAuditStore` ir eksplicitinis backend pasirinkimas.
Rotacija, filtrai ir retencija — 7.4c/7.4d.

### Užfiksuoti sprendimai

- Backend renkamas per `AUDIT_BACKEND` (`memory` | `postgres`). Nežinoma
  reikšmė → startup klaida. `postgres` be `DATABASE_URL` → startup klaida.
  Init klaida NIEKADA nekrenta į memory.
- `timestamp` autoritetas — DB `now()` (`DEFAULT now()`), aplikacija jo
  neperduoda. Dvi replikos su prasilenkiančiais laikrodžiais kitaip sulaužytų
  `from`/`to` ir tvarką.
- `hash_key_id` — operatoriaus priskirta etiketė iš `AUDIT_ID_SALT_ID`
  (pvz. `2026-01`), ne išvestinė iš paties rakto. Reversibilumo klausimas taip
  pat neiškyla. Šiame etape užpildomas aktyvaus rakto etikete; istorinių raktų
  logika — 7.4c.

### Schema ir migracija

- [ ] `audit_log` įvedama NAUJU migration failu per 7.1 mechanizmą; jau
      pritaikytos migracijos neredaguojamos.
- [ ] Atskiri indeksuojami stulpeliai: `id`, `timestamp`, `event`,
      `subject_id`, `hash_key_id`, `result`, `request_id`. Likę allowlisted
      laukai — `meta jsonb`.
- [ ] `id` išlaiko globaliai unikalaus UUID semantiką.
- [ ] ⚠️ **Plaintext `job_id` stulpelio NĖRA.** Taip pat nėra transkripcijos,
      prompt'o ar audio turinio laukų.
- [ ] ⚠️ **Filtruojami laukai neindeksuojami per pilną JSONB skenavimą** —
      indeksas ant kiekvieno filtruojamo stulpelio, ne `meta ->> ...`.
- [ ] `audit_log_result_values` CHECK: `result IN ('success', 'failure')`.
- [ ] `audit_log_event_pattern` CHECK ant `event`.
      ⚠️ **Šablonas NEDUBLIUOJAMAS.** 7.4a `EVENT_PATTERN` perkėlė į
      `utils/auditEvents.js` ir tai yra vienintelis autoritetas. Migracijoje
      įrašytas literalas leistinas, BET privalomas paritetо testas: kiekvienas
      `AUDIT_EVENTS` raktas praeina DB CHECK, ir kiekviena runtime atmetama
      reikšmė atmetama ir DB. Be jo runtime priimtų įvykį, kurį DB atmes, ir
      klientas gautų 500 vietoj audito įrašo.
- [ ] ⚠️ **APPEND-ONLY DB LYGMENYJE.** `audit_log_no_update` BEFORE UPDATE
      trigger'is, atmetantis bet kokį `UPDATE` (`RAISE EXCEPTION`). Be jo
      auditas yra žurnalas tik pagal susitarimą.
- [ ] ⚠️ **`DELETE` — SPRENDIMAS EKSPLICITINIS.** `BEFORE UPDATE` trigger'is
      `DELETE` neriboja NIEKAIP, tad formuluotė „DELETE leidžiamas tik
      retencijos/erasure keliu" tuo mechanizmu NEĮGYVENDINAMA. Pasirenkama
      viena: (a) atskira DB rolė su grant'ais, arba (b) dokumentuojama
      sąžiningai — „DELETE DB lygmenyje neribojamas; apribojimas galioja tik
      per store API". Neapibrėžta likti negali.
- [ ] Migration integration testas: švari DB → migrate → schema egzistuoja;
      antras `migrate:up` = teisėtas no-op; reikiami constraint'ai ir indeksai
      egzistuoja.
- [ ] ⚠️ **`REQUIRED_AUDIT_CONSTRAINTS` PILNUMAS IŠVEDAMAS.** Testas nuskaito
      VISUS `contype='c'` constraint'us ant `audit_log` iš šviežiai migruotos DB
      ir lygina pilną aibę per `deepEqual`. Narystės patikra po vieną gina tik
      apatinę ribą.
- [ ] ⚠️ **DB invariantai tikrinami TIESIOGINIU SQL, apeinant store.** Kitaip
      testas įrodo JS validaciją, ne DB garantiją. Kur runtime ir DB turi
      uždaras reikšmių aibes (`event`, `result`), paritetas IŠVEDAMAS iš
      runtime autoriteto, ne dubliuojamas rankiniu sąrašu.

### Backend

- [ ] `postgresAuditStore` deklaruoja tą pačią metodų aibę kaip memory.
- [ ] ⚠️ **`AUDIT_ID_SALT` TAMPA PRIVALOMA.** `auditLog.resolveSalt()`
      sąmoningai generuoja atsitiktinę procesui lokalią druską, kai jos nėra —
      tai saugu TIK atmintyje. Persistuojant restartas ar antra replika
      skaičiuotų kitą pseudonimą, ir `removeBySubjectIdentifier(jobId)` senų
      įrašų neberastų, tad GDPR ištrynimas jų nepasiektų. `postgres` režime be
      jos — startup FAIL. Random fallback lieka galioti TIK memory režimui.
      Startup testas.
- [ ] ⚠️ **VIENAS pool visam procesui**, valdomas centralizuotai ir uždaromas
      per shutdown ir test teardown. Naujas pool kiekvienai audit operacijai —
      ne.
- [ ] ⚠️ **`meta` ALLOWLIST TAIKOMAS RAŠANT**, ne pasitikint kvietėju.
      Nežinomas laukas NUTYLIMAS, ne persistinamas — testas, nes 7.4c/7.4d
      pridės call site'ų. Papildomai: `meta` dydžio riba ir eilučių truncation,
      kad klaidos tekste atsidūręs transkripcijos fragmentas nepatektų į
      lentelę.
- [ ] Backend pasirinkimo logika turi VIENĄ autoritetingą vietą; tie patys env
      kintamieji neinterpretuojami nepriklausomai skirtingose sistemos vietose.
- [ ] ⚠️ **LIMITAS TAIKOMAS SQL'E, NE PO NUSKAITYMO.** Memory versija turi
      maksimalios ribos capping'ą. PostgreSQL atitikmuo negali traukti visos
      lentelės ir tada `slice()` — tas pats kontraktas privalo virsti `LIMIT`
      užklausoje. Filtrai — 7.4c, bet riba privaloma dabar. Testas: didelė
      lentelė, tikrinama, kad į procesą nepatenka daugiau eilučių nei riba.
- [ ] ⚠️ **DETERMINISTINĖ SKAITYMO TVARKA.** `now()` yra TRANSAKCIJOS laikas —
      dvi eilutės vienoje transakcijoje gauna IDENTIŠKĄ `timestamp`, o `id` yra
      UUID, tad rikiavimas pagal jį atsitiktinis. Memory backend'as rikiuoja
      pagal įterpimo tvarką. Be monotoniško stulpelio (`bigserial` seq) arba
      `clock_timestamp()` pariteto reikalavimas dėl `ordering` bus flaky.
      Sprendimas eksplicitinis; testas: N įrašų vienoje transakcijoje → abu
      backend'ai grąžina tą pačią tvarką.

### Async kontraktas ir esamų call-site'ų migracija

- [ ] ⚠️ `postgresAuditStore` operacijos yra asinchroninės, todėl 7.4b
      sąmoningai migruoja audit store kontraktą į async. Bendras `memory` /
      `postgres` kontraktas ir bendras parametrizuotas testų rinkinys naudoja
      `await` visoms store operacijoms. Negalima palikti skirtingos sync/async
      viešo kontrakto semantikos pagal pasirinktą backend'ą.
- [ ] ⚠️ Inventorizuojami ir pritaikomi visi produkciniai `auditLog.getAll()`
      ir kitų read operacijų call-site'ai. Konkrečiai `/api/audit` turi
      `await`inti `auditLog.getAll()`. Negalima PostgreSQL `Promise` perduoti
      tolesnei sinchroninei logikai (`slice()`, filtravimui ir pan.).
- [ ] ⚠️ Inventorizuojami visi produkciniai `auditLog.record()` call-site'ai ir
      aiškiai apibrėžiama write-failure semantika. PostgreSQL write `Promise`
      negali likti neapdorotas ir sukelti `unhandledRejection`. Call-site'as
      arba `await`ina operaciją, arba sąmoningas compatibility boundary pagauna
      klaidą ir ją aiškiai logina. DB write klaidos negalima tyliai
      swallow'inti.
- [ ] ⚠️ Backend paritetas reiškia ne tik vienodą metodų aibę, bet ir vienodą
      observable kontraktą. Bendras parametrizuotas testų rinkinys tikrina
      grąžinamų objektų shape, key naming, reikšmes, `null` / optional laukų
      semantiką, ordering ir bendrą error semantiką. PostgreSQL backend negali
      išleisti raw DB `snake_case` eilučių, jei memory backend viešas
      rezultatas yra kitoks.
- [ ] ⚠️ Pool lifecycle yra proceso lifecycle dalis. Audit PostgreSQL backend
      turi aiškų `shutdown()` / lygiavertį teardown kelią, naudojantį
      centralizuotai valdomo pool uždarymą. Jis prijungiamas prie application
      shutdown ir integration-test teardown. Po testų neturi likti audit
      backend sukurtų atvirų PostgreSQL handle'ų.

### RAW privatumo testai

- [ ] ⚠️ **Plikojo `job_id` nėra NIEKUR.** Testas: sukuriamas žinomas unikalus
      job ID → audit įrašas per REALŲ produkcinį kelią → apeinant fasadą
      nuskaitoma DB eilutė → tikrinami VISI stulpeliai IR rekursyviai `meta`
      JSONB → įrodoma, kad originalaus ID nėra nė vienoje reikšmėje. Patikra,
      kad nėra `job_id` stulpelio, NEPAKANKA.
- [ ] ⚠️ **Transkripcijos sentinel testas** su atpažįstamu tekstu, per realų
      produkcinį kelią, RAW eilutėje ir JSONB. Tikrinama reali DB, ne
      `getAll()`.
- [ ] ⚠️ **RAW `meta` allowlist testas:** sąmoningai perduodami neleistini
      laukai (unikalūs sentinel'ai) ir tiesioginiu SQL patikrinama, kad jų nėra
      persistintame `meta` JSONB.

### Restart, multi-instance, paritetas

- [ ] Integration scenarijus: instancija A → `record()` → A sunaikinama → nauja
      instancija B prieš tą pačią DB → įrašas randamas. Testas negali išlaikyti
      seno process-local `log[]` ir tada teigti, kad įrodė persistenciją.
- [ ] Dvi atskiros store instancijos prieš tą pačią DB mato viena kitos įrašus.
- [ ] Auditas išgyvena `docker compose restart backend`.
- [ ] ⚠️ **Bendras elgesys — VIENAS parametrizuotas rinkinys** prieš `memory` ir
      `postgres`, visiškai asinchroninis. Backend-specific testai lieka tik
      realioms DB savybėms (constraints, indeksai, migracijos, raw-row privacy,
      restart, SQL concurrency). Dubliuoti tą patį elgesį į du nepriklausomus
      rinkinius, kurie vėliau išsiskirs, negalima.
- [ ] ⚠️ **Nėra bendros transakcijos su job store.** Auditas PostgreSQL'e,
      job'as gali būti Redis'e — atominio „veiksmas + auditas" NĖRA. Semantika:
      at-least-once, idempotencija pagal `id`, ir dokumentuota, ką reiškia
      auditas be veiksmo.

### 7.4a paliktos skolos, kurios apmokamos ČIA

- [ ] ⚠️ **`AUDIT_WRITE_TIMEOUT_MS` PERŽIŪRIMAS PRIEŠ REALIĄ DB.** 7.4a nustatė
      2000 ms ir fail-closed blokuojantiems įvykiams, bet atmintyje ta riba
      niekada nesuveikdavo. Su PostgreSQL į tą patį langą telpa jungties
      paėmimas iš pool'o, tad išsemtas pool'as reikštų, kad prisijungimas ima
      grąžinti 503 dėl APKROVOS, ne dėl gedimo. Reikia peržiūrėtos ribos,
      suderinto `statement_timeout` DB pusėje ir testo su realiai išsemtu
      pool'u, ne su fake vėlinimu.
- [ ] ⚠️ **VĖLYVAS ĮRAŠAS PO TIMEOUT.** `Promise.race` rašymo NENUTRAUKIA.
      `LOGIN_SUCCESS` gali įsirašyti jau PO to, kai sesija atšaukta ir grąžinta
      503 — autoritetingas žurnalas tvirtintų įvykus tai, kas atsukta. 7.4a šį
      klausimą eksplicitiškai adresavo į 7.4b. Sprendimas: per-query
      `statement_timeout`, `AbortSignal` arba kompensuojantis įrašas. Jei
      nesprendžiama — perkeliama į 7.4d SU PRIEŽASTIMI, ne paliekama kabanti
      nuoroda.
- [ ] ⚠️ **POST-HOC TVARKOS PAŽADAS PATIKSLINAMAS.** 7.4a atidėjo „auditas
      prieš trynimą" į 7.4b argumentu „atsiras patvarumas ir transakcija". Bet
      bendros transakcijos su job store NĖRA (žr. aukščiau). Tad pažadas
      įvykdomas tik iš dalies. Šis PR privalo pasakyti, kurie iš keturių
      `POST_HOC_IVYKIAI` realiai tampa fail-closed, o kurie lieka post-hoc ir
      kodėl — kitaip 7.4a nuoroda tampa mirusi.
- [ ] ⚠️ **`PRIVACY_MODE` × `postgres` DERINYS APIBRĖŽIAMAS.** 7.4a jį padarė
      EKSPLICITINE blokuojančios garantijos išimtimi (įrašo nėra, veiksmas
      tęsiamas). Pilna režimo logika — 7.4d, bet startinė taisyklė reikalinga
      dabar: ar `PRIVACY_MODE=true` + `AUDIT_BACKEND=postgres` yra
      prieštaravimas (startup klaida), ar leistinas derinys.

### Backup politika

- [ ] ⚠️ **`audit_log` IŠBRAUKIAMAS IŠ ATKŪRIMO TAME PAČIAME PR.** 7.6
      garantuoja, kad atkūrus kopiją GDPR ištrinti audito įrašai NEGRĮŽTA. Iki
      šiol tai galiojo savaime — auditas gyveno atmintyje ir į `pg_dump`
      nepatekdavo. Nuo 7.4b jis lentelėje, tad numatytoji kopija jį ĮTRAUKS, o
      garantija lūš tyliai. `utils/backupPolicy.js` atnaujinamas kartu su
      migracija; testas: prieš kopiją įrašoma unikaliai atpažįstama audito
      eilutė, po restore jos NĖRA.

### Papildomi DoD įrodymai

- [ ] Testas įrodo, kad PostgreSQL write failure iš produkcinio audit kelio
      nesukelia `unhandledRejection` ir nėra tyliai prarandamas.
- [ ] Tiesioginiu SQL vykdomas `UPDATE audit_log ...` ir įrodoma, kad DB
      append-only mechanizmas jį atmeta; store API `update()` metodo nebuvimas
      nelaikomas pakankamu įrodymu.
- [ ] Tiesioginiu SQL bandoma įrašyti neteisingas reikšmes į `result` ir
      `event` ir įrodoma, kad CHECK constraint'ai jas atmeta.
- [ ] PostgreSQL startup testas įrodo, kad `AUDIT_BACKEND=postgres` be
      `AUDIT_ID_SALT` baigiasi startup klaida, o ne random salt fallback.
- [ ] Pool teardown testas / integration teardown įrodo, kad audit PostgreSQL
      resursai korektiškai uždaromi ir testų procesas nelieka kabėti dėl atvirų
      DB jungčių.

### Darbo eigos reikalavimai

- [ ] **APIMTIS UŽŠALDYTA.** Peržiūros radiniai, kurie nėra šio PR paliestų
      kelių regresijos, eina į 7.4c/7.4d, ne į šį diff'ą. Įrašoma į PR body.
- [ ] **KIEKVIENAS DoD PUNKTAS TURI MUTACIJOS PORĄ.** Pateikiama konkreti
      mutacija, kurią atšaukus testas KRINTA. Punktas be jos laikomas
      neįvykdytu.

### Ko NEAPIMA

Rakto rotacijos ir istorinių raktų (7.4c). `GET /api/audit` filtrų (7.4c).
Retencijos, pilnos `PRIVACY_MODE` logikos, readiness (7.4d).

---

## [7.4c] Rakto rotacija ir audit užklausos

**Tėvinis:** #155 · **Priklauso nuo:** 7.4b

`hash_key_id` gyvavimo ciklas, istoriniai raktai, `GET /api/audit` filtrai ir GDPR
ištrynimas per visas dar taikomas rakto generacijas.

### Užfiksuoti sprendimai

Agentas jų NEKEIČIA ir alternatyvų nesirenka:

- Aktyvus raktas — **pora** `AUDIT_ID_SALT_ID` + `AUDIT_ID_SALT`. `AUDIT_ID_SALT_ID`
  yra stabilus operatoriaus suteiktas generacijos ID, persistinamas kaip
  `hash_key_id`. Pats secret'as nepersistinamas niekada.
- Istoriniai raktai — `AUDIT_ID_SALT_PREVIOUS`, kableliais atskirtas `id:secret`
  sąrašas.
- ID formatas: `[A-Za-z0-9_.-]{1,64}`. Secret formatas: base64url arba hex — kablelio
  ir dvitaškio jame būti negali, todėl sąrašo skaidymas yra vienareikšmis.
- ⚠️ **`AUDIT_ID_SALT_ID` PRIVALOMAS TIK `postgres` REŽIME; `memory` ĮSPĖJA.**

  Tai EKSPLICITINIS sprendimas, ne praleistas reikalavimas. Atmintyje
  `hash_key_id` niekur nerašomas, tad generacijos etiketė beprasmė, o
  reikalavimas jos visur sulaužytų esamus atminties diegimus be jokios naudos.
  Simetriška 7.4b taisyklei, kur `AUDIT_ID_SALT` privaloma tik persistentiniam
  backend'ui.

  Bet tylėti negalima: nustačius `AUDIT_ID_SALT` be `AUDIT_ID_SALT_ID`, startas
  rašo `warn`. Tai vienintelė vieta, kur operatorius gali sužinoti IŠ ANKSTO,
  kad perjungus `AUDIT_BACKEND=postgres` sistema nebepakils — kitaip jis tai
  pamatytų tik migracijos metu.
- Rūšiavimas — pagal **7.4b tvarkos autoritetą (`seq`)**, mažėjimo tvarka (naujausi
  pirma). ⚠️ `timestamp` NĖRA tvarkos autoritetas: `now()` vienoje transakcijoje
  visoms eilutėms grąžina tą patį momentą, o lygiagrečios transakcijos gali
  prieštarauti įrašymo eilei. `seq` unikalus ir monotoniškas, tad kursoriui
  atskiro laužtuko nereikia.
- ⚠️ **DESC galioja TIK `query()` / `GET /api/audit`.** `getAll()` ir `list()` lieka
  saugyklos (ASC) tvarka — 7.4b bendras paritetų rinkinys ir jo testai nekeičiami.
- Puslapiavimas — keyset cursor. `OFFSET` po 7.4c nebėra palaikomas.
- Startup gedimas šiame etape reiškia **proceso startą nutraukiantį FAIL**, ne vien
  readiness — simetriškai 7.4b taisyklei, kad init klaida nekrenta į memory.

### Rakto gyvavimo ciklo kontraktas

⚠️ **RIBA IR GDPR TAISYKLĖ NEGALI SUKURTI NEIŠSPRENDŽIAMOS KONFIGŪRACIJOS.**
Naivus derinys „maks. N istorinių" + „rakto negalima pašalinti, kol DB yra jo įrašų"
duoda spąstus: pasukus raktą N+1 kartų greičiau nei suveikia retencija, viršijimas
neleidžia startuoti, o pašalinti nė vieno rakto negalima, nes visi dar turi įrašų.
Backend'as tampa nepaleidžiamas be teisėto išėjimo. Todėl:

- Konfigūracija galioja, jei istorinių raktų **≤ 10 ARBA kiekvienas istorinis raktas
  vis dar turi įrašų DB**. Riba atmeta tik NEBEREIKALINGUS raktus; reikalingo rakto
  ji niekada neatmeta.
- **Fan-out autoritetas yra DB, ne env sąrašo ilgis.** Kandidatinių `subject_id`
  aibę apibrėžia generacijos, faktiškai esančios `audit_log`.

Toliau:

- Aktyvaus `AUDIT_ID_SALT_ID` ir visų istorinių `id` aibė unikali. Kolizija,
  dublikatas, tuščias ID, tuščias secret'as, netinkamas formatas → startup FAIL.
- ⚠️ **RAKTO NEGALIMA PAMIRŠTI, KOL DB YRA JUO PSEUDONIMIZUOTŲ ĮRAŠŲ.** Vien sąrašo
  ilgio ribos GDPR garantijai nepakanka. PostgreSQL backend startup metu nuskaito
  DB naudojamas `hash_key_id` generacijas; radus generaciją, kuriai resolveris
  nebeturi rakto — FAIL-CLOSED. Taip užkertama būsena, kurioje persistentinis įrašas
  egzistuoja, bet `removeBySubjectIdentifier(jobId)` nebegali apskaičiuoti jo
  `subject_id`.
- Raktą iš `AUDIT_ID_SALT_PREVIOUS` išimti leidžiama tik tada, kai DB nebeliko nė
  vieno įrašo su tuo `hash_key_id`.
- ⚠️ **PATIKROS KAINA.** `SELECT DISTINCT hash_key_id` kas startą yra pilnas skenavimas
  ant augančios lentelės. Naudojamas loose index scan (rekursyvus CTE ant
  `hash_key_id` indekso iš 7.4b). Naujos lentelės nekuriama.
- ⚠️ **ATSISTATYMO KELIAS PRIVALOMAS.** Negrįžtamai praradus secret'ą fail-closed
  taisyklė kitaip reikštų amžinai nepaleidžiamą backend'ą. Yra eksplicitinis
  `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true`, kuris paleidžia sistemą, kiekvieno
  starto metu logina `warn` ir yra dokumentuotas kaip **sąmoningas GDPR garantijos
  laužymas**. Numatyta reikšmė — `false`.
- 7.4c retencijos NEĮGYVENDINA (tai 7.4d). 7.4c tik fail-closed būdu neleidžia paleisti
  konfigūracijos, kuri persistentinius įrašus padarytų neberandamus GDPR keliu.

### `/api/audit` filtrų kontraktas

- `action` query parametras filtruoja persistentinį `event` lauką. Atskiras `action`
  DB stulpelis nekuriamas.
- `from` / `to` — griežtai validuojami ISO-8601 date-time. Netinkama reikšmė → 400.
  `from > to` → 400.
- `request_id` filtruoja atskirą `request_id` stulpelį.
- `job_id` niekada nenaudojamas kaip plaintext lookup. Resolveris VIENĄ kartą
  apskaičiuoja kandidatinius `subject_id` aktyviai ir visoms DB esančioms taikomoms
  generacijoms, o užklausa naudoja vieną set-based predikatą
  (`subject_id = ANY($1)`), ne N atskirų.
- Filtrai komponuojami tarpusavyje viename užklausos kelyje, ne vienas kitą pakeičia.

### Cursor kontraktas

- `limit` išlaiko esamą ribojimo/capping kontraktą.
- `cursor` — opaque URL-safe tokenas; klientas jo nekonstruoja ir neinterpretuoja.
- Serveris cursor'e užkoduoja paskutinio grąžinto įrašo **pilną deterministinį sort
  key pagal 7.4b ordering kontraktą**. ⚠️ Jei galutinis 7.4b ordering turi papildomą
  monotonišką tie-breaker, cursor privalo apimti tą patį pilną raktą — aklai naudoti
  `(timestamp, id)` negalima — faktinis 7.4b raktas yra `seq`.
- ⚠️ **CURSOR NĖRA SLĖPTUVĖ FILTRŲ REIKŠMĖMS.** „Opaque" nereiškia „šifruotas".
  Filtrų aibės susiejimas daromas per **HMAC-SHA256 fingerprint** (keyed aktyviu
  `AUDIT_ID_SALT`, trumpinamas iki 16 baitų), o ne per užkoduotas pačias reikšmes.
  Priešingu atveju `job_id` keliautų URL'e ir patektų į nginx access logus. Cursor
  payload'e yra TIK sort key ir fingerprint.
- Cursor su kita filtrų aibe (įskaitant pakeistą rūšiavimo kryptį) → 400.
- Sugadintas, nepilnas ar semantiškai netinkamas cursor → 400, ne 500.
- `next_cursor` — opaque tokenas kitam puslapiui arba `null`. Nustatomas per
  `limit + 1` fetch: `null` grąžinamas tiksliai tada, kai kito puslapio nėra. Tuščias
  paskutinis puslapis neleidžiamas.
- Rotavus aktyvų raktą anksčiau išduoti cursor'ai nustoja galioti (fingerprint
  nebesutampa) → 400. Dokumentuota kaip sąmoningas elgesys.
- ⚠️ **OFFSET TRANSITION.** 7.4c sąmoningai keičia `/api/audit` puslapiavimo kontraktą.
  `offset` po 7.4c atmetamas kaip nepalaikomas parametras; tylaus fallback į OFFSET
  nelieka. ⚠️ Jei `schemas.auditQuery` šiandien nežinomus parametrus tyliai nukerta,
  „`offset` → 400" yra ATSKIRAS validacijos politikos pakeitimas šiam maršrutui, ne
  šalutinis efektas — jį reikia padaryti eksplicitiškai.

### DoD

- [ ] Kiekvienas pseudonimizuotas persistentinis įrašas turi `hash_key_id`.
- [ ] `hash_key_id` nėra pats secret'as ir iš jo secret'o atkurti negalima.
- [ ] ⚠️ **VIENAS autoritetingas raktų resolveris** aktyviam ir istoriniams raktams.
      Sugadintas ar dubliuotų `id` sąrašas → startup klaida, ne tylus praleidimas.
- [ ] Rotacijos scenarijus: `key A` → `record(job X)` → rotacija į `B` → `record`.
      Po rotacijos senas įrašas lieka DB, jo `hash_key_id` lieka `A`, nauji naudoja `B`.
- [ ] ⚠️ **Paieška ir ištrynimas NENAUDOJA tik aktyvaus rakto.** `job_id` filtras
      veikia per `job_id → aktyvus + taikomi istoriniai raktai → candidate
      subject_id[] → užklausa pagal subject_id`.
- [ ] `GET /api/audit?job_id=` randa įrašą, sukurtą PRIEŠ rakto rotaciją.
- [ ] ⚠️ **`job_id` filtras NĖRA priežastis** persistinti plaintext `job_id`, grąžinti
      jį atsakyme ar pridėti plaintext lookup lentelę.
- [ ] `GET /api/audit` filtrai: `from`, `to`, `action`, `request_id`, `job_id` +
      puslapiavimas. Filtrai **komponuojami** tarpusavyje — testas su bent trimis vienu metu.
- [ ] ⚠️ **PUSLAPIAVIMAS STABILUS LYGIAGRETAUS RAŠYMO METU.** `OFFSET` su
      konkurenciniais `INSERT` dubliuoja ir praleidžia eilutes. Testas: puslapiuojama
      per rinkinį, tuo metu rašomi nauji įrašai, ir nė vienas esamas įrašas nedingsta
      ir nepasikartoja.
- [ ] ⚠️ **FAN-OUT RIBOTAS.** N istorinių raktų = N kandidatinių `subject_id` kiekvienai
      užklausai ir kiekvienam ištrynimui. Užklausa vykdoma vienu `WHERE subject_id =
      ANY($1)`, ne N atskirų; riba tikrinama starto metu.
- [ ] GDPR: `record X` su `A` → rotacija → `record X` su `B` →
      `removeBySubjectIdentifier(X)` → RAW DB nebelieka NEI `A`, NEI `B` įrašų.
- [ ] ⚠️ **Rotacija negali sukurti įrašų, kurių GDPR kelias neberanda** — testas
      būtent per RAW eilutes, ne per `getAll()`.
- [ ] `auditErasure.service.test.js` behavioural expectations neišsilpninti.

### Ko NEAPIMA

Retencijos, `PRIVACY_MODE`, `AUDIT_MAX_ENTRIES`, readiness (7.4d).

---

## [7.4d] Retencija, privatumo režimas, readiness ir CI

**Tėvinis:** #155 · **Priklauso nuo:** 7.4b

Operacinis 7.4 uždarymas: retencija, `PRIVACY_MODE`, readiness, kabliukas 7.6 atkūrimui,
CI registracija ir dokumentacija.

### Užfiksuoti sprendimai

- `AUDIT_MAX_ENTRIES` PostgreSQL režime **NETAIKOMA**. Tai buvo apsauga nuo RAM
  augimo; ribos „palik paskutinius N" į DB neperkeliame. Dokumentuojama eksplicitiškai.
- Retencijos riba: `timestamp < cutoff` → šalinama, `timestamp == cutoff` → **lieka**.
- `PRIVACY_MODE=true` PostgreSQL režime: naujų įrašų nerašo IR starto metu išvalo
  esamas `audit_log` eilutes — atitinka dabartinį in-memory kontraktą, kuris žada
  ištrynimą, ne tik nutildymą.

### DoD

- [ ] ⚠️ **Retencijos autoritetas lieka `privacyConfig` / centralizuota retention
      architektūra.** Antras nepriklausomas mechanizmas vien auditui nekuriamas;
      persistentinis auditas įtraukiamas į ESAMĄ retention kelią.
- [ ] Retencijos testas su **kontroliuojamu laiko šaltiniu**: `< cutoff` pašalinamas,
      `== cutoff` lieka, `> cutoff` lieka.
- [ ] ⚠️ **Sweep BATCH'AIS.** Vienas `DELETE` ant išaugusios lentelės laiko ilgą
      lock'ą. Ribotas batch dydis + indeksas ant `timestamp`; testas, kad kelių batch'ų
      ciklas baigiasi ir nepalieka likučių.
- [ ] Retencijos ir append-only sąveika: retencija ir erasure yra vieninteliai
      leidžiami `DELETE` keliai — testas, kad kitas kelias atmetamas.
- [ ] `PRIVACY_MODE` semantika įgyvendinta pagal aukščiau užfiksuotą sprendimą.
      ⚠️ **Privalomas RAW PostgreSQL testas:** negali likti būsenos, kur
      `GET /api/audit` grąžina `[]`, o `audit_log` tebeturi senus įrašus.
- [ ] `AUDIT_MAX_ENTRIES` PostgreSQL semantika testuota ir dokumentuota.
- [ ] ⚠️ **Readiness liečia realų `audit_log`, ne `SELECT 1`.** Scenarijus: DB
      pasiekiama, `audit_log` trūksta arba neprieinama → NOT ready.
- [ ] ⚠️ **Readiness probe nebrangus.** Kviečiamas kas health poll'ą — teisės
      tikrinamos per `has_table_privilege()`, be šiukšlinių eilučių rašymo, su
      rezultato cache trumpam intervalui.
- [ ] `/api/health` DB ir audit backend detalių produkcijoje pagal nutylėjimą NErodo
      (`HEALTH_DETAILS`, kaip esami tiekėjų pavadinimai).
- [ ] ⚠️ **KABLIUKAS 7.6 ATKŪRIMUI.** `utils/backupPolicy.js` jau sąmoningai išbraukia
      auditą iš atkūrimo: atkūrus, GDPR ištrinti įrašai grįžtų, o naujesni append-only
      įvykiai būtų perrašyti. 7.4d privalo `audit_log` į tą politiką užregistruoti —
      kitaip 7.6 DoD („prieš kopiją įrašyta unikali audito eilutė po restore NERANDAMA")
      neįgyvendinamas.
- [ ] ⚠️ **`REQUIRE_POSTGRES=1`** — simetriškas esamam `REQUIRE_REDIS=1`. PostgreSQL
      CI job'e privalomas scenarijus, kuris `skip`'inasi, laikomas GEDIMU, ne sėkme.
- [ ] PostgreSQL integration testai realiai registruoti PostgreSQL CI rinkinyje —
      tikrinamas faktinis vykdymas su `DATABASE_URL`, ne failo egzistavimas.
- [ ] ⚠️ **CUTOVER IR ROLLBACK.** Esami in-memory įrašai NEPERKELIAMI. Grįžimas
      `postgres → memory` reiškia, kad seni įrašai lieka DB ir nauji į juos nebepatenka —
      įrašyta į diegimo pastabas kaip sąmoningas, ne atsitiktinis elgesys.
- [ ] Dokumentacija atnaujinta: `.env.example`, startup/config, privacy/audit dokai,
      security/evidence matrix (jei repo sargai to reikalauja). Aprašyta: kaip
      generuojamas `AUDIT_ID_SALT`, kada privalomas, rotacijos modelis, istorinių raktų
      konfigūracija, `hash_key_id` paskirtis, ką operatorius privalo išsaugoti per
      rotaciją, kokios pasekmės pašalinus istorinį raktą.
- [ ] Secret reikšmės nepatenka į logus ar health/readiness atsakymus — testas.
- [ ] README apribojimų lentelės eilutė ir Roadmap punktas atnaujinti.

### Ko NEAPIMA

Job store architektūros, sesijų persistencijos, authentication redesign, bendros
secrets-management platformos ir kitų #155 etapų acceptance criteria keitimo.

---

## [7.4e] Audito ištrynimo galutinumas

**Tėvinis:** #155 · **Priklauso nuo:** 7.1, 7.4b · **Rasta:** #211 (7.4b) peržiūros metu
**Prioritetas:** P1 (duomenų gyvavimo ciklas / privatumas)

⚠️ **`7.4c` yra SĄLYGINĖ priklausomybė — tik variantui C.** Rakto rotacija
keičia `subject_id`, tad barjeras, raktuotas pagal pseudonimą ir suprojektuotas
rotacijos nežinant, tyliai nustotų veikti. Variantuose A ir B žymos raktuojamos
`job_id`, ir 7.4c šiam darbui neaktualus. Žr. 6 sprendimą.

### Statusas

**NĖRA 7.4b regresija.** Defektas egzistavo iki #211: 7.4a atminties
realizacijoje `removeBySubjectIdentifier()` iteravo masyvą ir šalino matomus
elementus (`log.splice()`), be barjero vėlesniems rašymams. #211 elgesio
nepakeitė — jis pakeitė **pasekmę**.

Perkelta iš #211 sąmoningai: sprendimas liečia naują būseną ir naujus gedimo
režimus, o #211 apimtis buvo užšaldyta.

### Kodėl atskiras [7.4e]

**Ne 7.4d:** ten retencija, privatumo režimas, readiness ir CI. Nauja lentelė su
savo migracija ir gedimo režimais netelpa — tai lygiai tas apimties išsipūtimas,
kurio vengiam.

**Ne 7.5a:** ta sekcija jau turi 14 DoD punktų, o šis pridėtų dar aštuonis.
Svarbiau: sujungus, sąlyginė 7.4c priklausomybė užkabintų VISĄ 7.5a, o variantas
C taptų faktiškai negalimas — architektūrinis sprendimas būtų priimtas issue
struktūra, ne argumentu.

**Ne 7.4c:** ten barjeras natūraliai virstų pseudonimų kalba, t. y. variantu C —
brangiausiu ir tuo, kurio rekomenduojama NESIRINKTI pirmiausia. Be to rotacija
reikalinga savarankiškai (istoriniai raktai, paieška per senus raktus) ir
neturi laukti visai kito klausimo.

**Bet [7.5a] suderinamumas privalo likti eksplicitinis**, ne prielaida: ji jau
įveda `erasure_marks (job_id, marked_at, reason)`, ir dvi tombstone lentelės tam
pačiam GDPR ištrynimui būtų būsima nesuderinamumo vieta — kuri yra autoritetas,
kai jos nesutampa? Žr. DoD.

### Problema

`removeBySubject(subjectId)` ištrina **tik eilutes, matomas ištrynimo momentu**.
Barjero vėlesniems to paties subjekto rašymams nėra.

Scenarijus (`backend/routes/exports.js`):

1. Užklausa išsprendžia `linkedJobId`.
2. Rašomas `EXPORT_STARTED` su tuo `jobId`.
3. Generuojamas eksportas — gali trukti ilgai.
4. **Lygiagrečiai** vykdomas job'o ištrynimas: `removeBySubjectIdentifier()`
   pašalina `EXPORT_STARTED` ir grąžina **204**.
5. Eksportas baigiasi → rašomas `EXPORT_COMPLETED` su **tuo pačiu** subjektu.

Ištrynimas paskelbtas sėkmingu, o subjektas lentelėje vėl turi įrašą.
`EXPORT_*` yra iliustracija: bet kuri ilgai trunkanti operacija, kuri subjektą
išsprendžia anksčiau, nei rašo baigties įvykį, turi tą pačią savybę.

### Ką 7.4b pakeitė (ir ko ne)

**Nepakeitė:** pačių lenktynių vienoje instancijoje.

**Pablogino:**

1. **Likusi eilutė IŠLIEKA.** Atmintyje pralaimėtų lenktynių pasekmė mirdavo su
   procesu. DB ji lieka neribotai — juolab kad persistentinės retencijos iki
   7.4d nėra.
2. **Lenktynės tapo TARP INSTANCIJŲ.** 7.4a `const log = []` buvo procesui
   lokalus, tad ištrynimas ir rašymas privalėjo vykti **tame pačiame** procese.
   Bendroje DB instancija A trina, kol B rašo. Langas realiai išsiplėtė.

**Pagerino:** vėlyvo rašymo po timeout kelią susiaurina #211 įvestas
`statement_timeout` (0.7 × `AUDIT_WRITE_TIMEOUT_MS`) — DB užklausą **nutraukia**.
`rasytiAudita()` pakartojimo kilpos neturi, tad at-least-once / `ON CONFLICT`
naujo vektoriaus nesukuria.

---

## Sprendimo variantai — nuo pigiausio

⚠️ **Pradėti nuo A, ne nuo C.** Brangiausias variantas nėra automatiškai
teisingas, o C įveda naują būseną kiekviename audito rašyme.

### A. Patikra OPERACIJOJE, ne audito sluoksnyje

Ilgai trunkanti operacija prieš rašydama baigties įvykį pasitikrina, ar job'as
dar egzistuoja — per [7.5a] žymą, kuri jau bus.

- Naujos lentelės **nereikia**.
- Audito rašymo kelias lieka nepaliestas: jokios papildomos užklausos, jokio
  naujo gedimo režimo kiekviename `append()`.
- `EXPORT_COMPLETED` ištrintam job'ui yra **klaida ir be audito konteksto** —
  eksportas neturėtų baigtis sėkmingai, jei jo objektas ištrintas.
- Rakto rotacija (6 sprendimas) šiam variantui **negalioja**: patikra remiasi
  `job_id`, ne pseudonimu.

Riba: gina tik tuos kelius, kurie patikrą atlieka. Naujas ilgai trunkantis
kelias ją pamirštų — tad reikia tripwire, analogiško #211 `getAll()` sargybai.

### B. Barjeras `erasure_marks` pagrindu, tikrinamas audito rašyme

Panaudojama [7.5a] žyma; audito `append()` ją tikrina.

- Viena tombstone abstrakcija, ne dvi.
- Žyma raktuojama `job_id`, tad rotacijos problema **išnyksta** (žr. 6).
- Kaina: audito rašymas įgyja priklausomybę nuo job'o būsenos ir naują gedimo
  režimą.

### C. Atskiras audito tombstone, raktuotas pagal `subject_id`

Pilnas barjeras audito sluoksnyje.

- Vienintelis variantas, dengiantis subjektus **be** job'o.
- Kaina didžiausia: nauja lentelė, nauja migracija, nauja būsena kiekviename
  rašyme **ir** rotacijos problema visu ūgiu (t. y. 7.4c tampa kieta
  priklausomybe).

---

## Reikalingi eksplicitiniai sprendimai

Šis issue **nepriima** sprendimo už įgyvendintoją.

1. **Barjero vieta ir forma** — A, B ar C. Jei ne A, pagrindimas, kodėl A
   nepakanka.
2. **Atomiškumas / tvarka tarp ištrynimo ir rašymo.** Ar patikra vyksta prieš
   kiekvieną INSERT (papildoma užklausa), ar užtenka `INSERT ... WHERE NOT
   EXISTS` vienoje operacijoje? Ar reikia serializuojamos izoliacijos?
3. **Elgesys, kai barjero patikra KRINTA** — naujas gedimo režimas, kurio
   šiandien nėra.

   ⚠️ **Politika privalo būti ATSKIRA post-hoc ir pre-veiksmo įvykiams.**
   `utils/auditEvents.js` `POST_HOC_IVYKIAI` (šešiems: keturi ištrynimo keliai,
   `LOGOUT`, `ADMIN_DELETE_OVERRIDE`) fail-closed yra **neįmanomas iš principo** —
   veiksmas jau negrįžtamai įvykęs, tad „atmesti" nebėra ko. Tai tas pats
   skirtumas, kurį 7.4a atskyrė: `BLOKUOJANTIS` („sėkmė nedeklaruojama") ≠
   `fail-closed` („veiksmas atmetamas"). Politika, parašyta tik pre-veiksmo
   įvykiams, post-hoc keliuose arba neveiks, arba blokuos tai, ko blokuoti
   nebeįmanoma.
4. **Ar rašymai po ištrynimo privalo kristi fail-closed** (pre-veiksmo įvykiams).
   Jei subjektas ištrintas, o kodas vis tiek bando rašyti — programos klaida ar
   normali lenktynių baigtis? Nuo to priklauso, ar tai `error` logas, ar
   kvietėjo klaida.

**5–6 taikomi TIK variantams B/C.** Variante A barjero lentelės nėra, tad nei
gyvavimo trukmės, nei rotacijos klausimas nekyla — tada prie jų rašoma
„netaikoma (variantas A)", o ne ieškoma atsakymo.

5. **Barjero gyvavimo trukmė.** Negali galioti amžinai (lentelė augtų), bet
   negali pasibaigti anksčiau nei ilgiausia vykdoma operacija. Riba
   **IŠVEDAMA**, ne surašyta ranka — analogiškai [7.5a] `revivalHorizonsMs()`.
6. **⚠️ SĄVEIKA SU RAKTO ROTACIJA ([7.4c]) — SPRĘSTI KARTU SU 7.4c, NE PO JO.**

   `subject_id` yra HMAC su `AUDIT_ID_SALT`. [7.4c] įveda rotaciją ir istorinius
   raktus. Po rotacijos tas pats job'as duoda kitą `subject_id`, tad barjeras,
   raktuotas pagal `subject_id`, naujų rašymų **nebeblokuotų** — tyliai.
   Ištrynimas liktų paskelbtas sėkmingu, o apsauga dingtų be jokio signalo.

   Variantai: raktuoti pagal `(hash_key_id, subject_id)` porą su paieška per
   visus istorinius raktus, arba raktuoti pagal visus žinomus raktus rašymo
   metu.

   **Pastaba:** variantuose A ir B ši problema **išnyksta**, nes [7.5a]
   `erasure_marks` raktuojama `job_id` — stabiliu identifikatoriumi, kurio
   rotacija neliečia. Tai savarankiškas argumentas prieš C.

---

## DoD

- [ ] Sprendimas 1–4 punktams (ir 5–6, jei pasirinktas B/C) — užrašytas kode ir
      `docs/audit-storage.md`, ne tik issue komentaruose.
- [ ] Jei pasirinktas B/C: barjeras per naują migraciją; esamos nekeičiamos.
- [ ] Jei pasirinktas B/C: barjerą tikrina **abu** backend'ai — kitaip privatumo
      garantija priklausytų nuo `AUDIT_BACKEND` reikšmės (tą pačią klaidą #211
      peržiūroje rado bendras kontrakto rinkinys).
- [ ] Jei pasirinktas A: tripwire, draudžiantis naują ilgai trunkantį kelią be
      patikros — analogiškas #211 `getAll()` sargybai, su tuščiu whitelist'u.
- [ ] ⚠️ **SUDERINAMUMAS SU [7.5a] `erasure_marks` — EKSPLICITINIS.**
      Jei įvedama nauja būsena, DoD privalo pasakyti, kuri žyma yra AUTORITETAS,
      kai jos nesutampa, ir kodėl dviejų reikia. Jei panaudojama esama —
      pasakyti, kad naujos lentelės nėra.
- [ ] ⚠️ **IŠVARDIJAMOS SUBJEKTŲ KLASĖS, KURIŲ BARJERAS NEDENGIA.**

      Variantai A ir B remiasi `job_id`. Kiekvienas subjektas, kuris NĖRA
      job'as, lieka be barjero — ir tai bus SUNKIAU pastebėti nei pradinis
      defektas, nes „ištrynimo galutinumas" atrodys išspręstas.

      `auditLog.record()` subjektą išveda taip:
      `pseudonymizeIdentifier(entry.jobId ?? entry.meetingId ?? null)`.

      Patikrinta #211 peržiūros metu:

      - **`meetingId` atsarginis kelias** — gyvas kodas. Visi APŽIŪRĖTI
        produkciniai kvietėjai (`transcriptionService`, `protocolService`)
        perduoda IR `jobId`, tad šiandien laimi `jobId`. Bet kelias be job'o
        (pvz. inline `/api/generate`) duotų `HMAC(meetingId)` — subjektą, kurio
        `erasure_marks(job_id)` neatpažįsta. **Reikia patikrinti pasiekiamumą,
        ne priimti šios pastabos kaip galutinės.**
      - **`RETENTION_PURGE` ir eksportai be `linkedJobId`** — pasitikrinta:
        subjekto jie NETURI (`subjectId = null`), tad tai NĖRA neapsaugotų
        subjektų klasė. Įtraukta, kad įgyvendintojas jų neieškotų be reikalo.

      DoD: klasės išvardijamos, ir kiekvienai eksplicitiškai patvirtinama, kad
      likti be barjero priimtina, ARBA numatomas atskiras kelias. Tylus
      praleidimas neleistinas.
- [ ] ⚠️ **DETERMINISTINIS lygiagretumo testas.**

      Konkurentinis rašymas įterpiamas **kontroliuojamai, ties draiverio riba**
      (adapterio hook), TARP barjero patikros ir INSERT — ne pasikliaujant
      scheduler'iu ir **ne kartojant iteracijas**.

      Tikimybinis „paleisk 1000 kartų" testas čia netinka: [7.2b] reikalauja
      deterministinių race testų, [7.5b] tą pačią ribą vadina „lenktynės ties
      draiverio riba", o AGENTS.md §14.1 sako, kad vienas sėkmingas
      lygiagretumo testo paleidimas įrodo mažai.

      Testas privalo įrodyti **MECHANIZMĄ**, ne tik rezultatą: kad INSERT po
      ištrynimo realiai atmetamas, o ne kad jis „paprastai nespėja".
- [ ] Tas pats deterministinis testas **tarp-instanciniam** atvejui: du atskiri
      pool'ai toje pačioje DB.
- [ ] Barjero patikros **GEDIMO** kelias padengtas testu — abiem įvykių
      kategorijoms (post-hoc ir pre-veiksmo), ne tik sėkmės kelias.
- [ ] Mutacija: pašalinus barjerą, lygiagretumo testas krinta.
- [ ] `docs/security-test-matrix.md` eilutė su mutacijos įrodymu.

### Apimties riba

Sprendžiamas **tik** audito ištrynimo galutinumas. Retencija, `PRIVACY_MODE`
logika ir readiness lieka 7.4d.

---

## [7.5a] Persistentės ištrynimo žymos

**Tėvinis:** #155 · **Priklauso nuo:** 7.1

Tiesioginis `docs/deletion-guarantees.md` 2 skyriaus apribojimo pašalinimas.

### DoD

- [ ] `erasure_marks (job_id, marked_at, reason)`.
- [ ] ⚠️ **FK į `jobs` NĖRA.** `CASCADE` ištrintų tombstone tuo momentu, kai jis
      tampa reikalingas vėluojančiam darbui atmesti. Testas: `jobs` eilutės
      ištrynimas **neturi** pašalinti žymos.
- [ ] Žyma išgyvena restartą.
- [ ] Po restarto vėluojanti eilės žinutė ištrintam job'ui **NEkuria
      artefaktų** — end-to-end testas.
- [ ] ⚠️ **IŠTRYNIMO KOORDINAVIMAS TARP REPLIKŲ.** Persistentės žymos
      NEPAKEIČIA `lifecycleService` `inFlight` koordinavimo, kuris yra procesui
      lokalus. Du `DELETE` skirtingose replikose abu įvykdytų ištrynimą ir
      lenktyniautų dėl `pending → deleted` / `pending → failed` įrašymo:
      kvietėjai gautų prieštaringus rezultatus, o vėlesnis nesėkmės įrašas
      perrašytų patvirtintą ištrynimą.

      Reikia paskirstyto single-flight (DB eilutės arba advisory lock) ir
      sąlyginių perėjimų (`WHERE status = 'pending'`). Testas: daugiaprocesis
      lygiagretumo scenarijus.
- [ ] ⚠️ **NEIŠSPRĘSTOS ŽYMOS NESENSTA.** Baigtinis horizontas taikomas TIK
      patvirtintoms `deleted` žymoms. `deletion_pending` ir `deletion_failed`
      lieka, kol ištrynimas pavyks arba operatorius išspręs — priešingu atveju
      žymos galiojimo pabaiga pašalintų barjerą tuo metu, kai jautrūs duomenys
      dar laukia valymo.
- [ ] Retencija ≥ **max(visi eilės prikėlimo horizontai) + atsarga**. Šiandien
      ribojantis yra `removeOnFail.age` = 24 h (`queues/config.js:29`).
- [ ] ⚠️ **RETENCIJA PRIKLAUSO NUO BŪSENOS.** `queued`/`processing` įrašai ir
      terminaliai su `*_pending` NEŠALINAMI pagal amžių — esamos saugyklos tai
      daro sąmoningai (`redisStore.js:175`), nes toks įrašas gali būti
      vienintelis `storageKey` šaltinis. Besąlygiška „po TTL" taisyklė leistų
      ištrinti gyvą job'ą arba palikti audio be savininko.
- [ ] ⚠️ **REZULTATAS NEGALI PASIBAIGTI PIRMA UŽ JOB'Ą.** Savarankiškas
      `job_results.expires_at` paliktų skaitomą `completed` job'ą BE
      transkripcijos — būseną, kurią 7.5b vadina remontu reikalaujančia, ir
      kuri skiriasi nuo memory/Redis, kur abu dingsta kartu. Testas: rezultatas
      pasiekiamas tol, kol pasiekiamas job'as.
- [ ] ⚠️ **ATSARGINIŲ KOPIJŲ LANGAS ĮEINA Į APATINĘ RIBĄ.** `BACKUP_RETENTION_DAYS`
      numatytai **7 dienos**, o eilės prikėlimo horizontas ~24 h. Formulė,
      remianti tik eilės horizontu, leistų patvirtintai ištrynimo žymai
      pasibaigti, kol dar egzistuoja PRIEŠ ištrynimą daryta kopija. Ją atkūrus
      nebeliktų ko sujungti, ir ištrintas job'as grįžtų — tiesiogiai
      prieštaraujant 7.6 atkūrimo scenarijui. Riba:
      `max(eilės horizontai, BACKUP_RETENTION_DAYS)` arba negaliojantis
      ištrynimo žurnalas, kol pasibaigs kiekviena jį apimanti kopija.
- [ ] ⚠️ **UŽDELSTI JOB'AI TURI TURĖTI RIBĄ.** `revivalHorizonsMs()` mato tik
      `queues/config.js`; per-job `delay`, perduotas `enqueue` vietoje, jam
      nematomas. Garantija „naujas mechanizmas ribą pakeičia savaime" tokiu
      atveju netiesa. Arba įvedamas MAKSIMALUS leistinas `delay`, tikrinamas
      įdedant, arba registras, per kurį privalo eiti visi producer'iai.
      Šiandien nė vienas producer'is `delay` neperduoda — tad riba įvedama
      dabar, kol nekainuoja.
- [ ] ⚠️ **SĄRAŠAS IŠVEDAMAS, ne surašomas.** Fiksuotas masyvas reiškia, kad
      pridėjus naują prikėlimo mechanizmą testas lieka žalias, kol kas nors
      rankiniu būdu jį papildys — o garantija sako, kad riba pasikeičia SAVAIME.
      `queues/config.js` eksportuoja `revivalHorizonsMs()`, ir tik jis yra
      autoritetas.
- [ ] ⚠️ **VIENETAI NORMALIZUOJAMI.** BullMQ `age` yra **sekundės**, o
      `stalledInterval` — **milisekundės**. `Math.max()` ant neapdorotų reikšmių
      parinktų klaidingą horizontą arba praleistų tikrinimą per kelias eilių
      tvarkas. Testas lygina tik po konversijos į bendrą vienetą.
- [ ] `docs/deletion-guarantees.md` apribojimas pašalintas, ne perrašytas.

---

## [7.5b] Optimistic locking ir konfliktų politika

**Tėvinis:** #155 · **Priklauso nuo:** 7.2b

`jobs.version` ir konfliktų semantika. Atskirta nuo 7.5a: ta yra saugumo
klausimas, ši — saugyklos korektiškumo.

### DoD

- [ ] `jobs.version` stulpelis, didinamas kiekvieno atnaujinimo.
- [ ] Progreso atnaujinimai — `WHERE version = $n`; statuso perėjimai —
      `WHERE status = $expected`.
- [ ] Konflikto rezultatas: aiškus, atskiriamas nuo „nerasta" ir nuo „neleistina".
- [ ] Kvietėjo politika dokumentuota: kada retry, kada klaida vartotojui.
- [ ] Deterministinis lenktynių testas su tikru Postgres.
- [ ] `version` nesikerta su #154 fazių CAS — abu tikrinami tame pačiame
      `UPDATE`, ne dviem.

### Idempotentiškas užbaigimas

⚠️ **`completed` BE REZULTATO NĖRA SĖKMĖ.**

`workers/index.js:192` įrašo `COMPLETED`, `:198` valo audio, `:207` grąžina
rezultatą. Kritus tarp jų PostgreSQL sako `completed`, BullMQ patvirtinimo
negavo ir kartoja, o `restart()` terminalų įrašą atmeta.

Blogiau: rezultatai gyvena atskiroje `job_results` lentelėje. Jei statusas
įsipareigojo, o rezultato įrašymas nepavyko, „tęsti valymą, tada sėkmė"
ištrintų šaltinio audio ir patvirtintų sėkmę, kai klientas transkripcijos
neturi — **negrįžtamai**.

- [ ] `finish(COMPLETED, { result })` atnaujina `jobs` IR `job_results`
      **vienoje transakcijoje**.
- [ ] `completed` be `job_results` eilutės traktuojamas kaip **remontas arba
      perdirbimas**, ne sėkmė.
- [ ] Retry, radęs `completed` su tuo pačiu `result`, laiko tai sėkme (ne
      klaida) — kitaip BullMQ kartotų be galo.
- [ ] ⚠️ **SĄLYGINIS UŽBAIGIMAS, ne vien transakcija.** Stalled recovery metu du
      persidengiantys vykdymai perskaito tą patį `processing` snapshot'ą, ir abi
      transakcijos gali įsipareigoti — vėlesnis rezultatas tyliai perrašo
      pirmąjį. Reikia `UPDATE ... WHERE status = 'processing' RETURNING`; nulis
      eilučių → rezultatas LYGINAMAS, ne perrašomas, o skirtingas rezultatas yra
      klaida. Testas: lenktynės ties draiverio riba.
- [ ] **Testas:** procesas nutraukiamas tarp `finish()` ir `return`; po retry
      job'as lieka `completed` SU rezultatu, audio išvalytas, eilė nekartoja.
- [ ] **Testas:** `completed` be rezultato → audio NEIŠTRINAMAS.
- [ ] ⚠️ **AUDITO RAŠYMO KLAIDOS NEPRARANDAMOS.** `auditLog.record()` šiandien
      sinchroninis, ir kvietėjai (`authorizeJobOrAudit()`,
      `lifecycleService.writeAudit()`) jo NELAUKIA ir negaudo. Pakeitus jį į DB
      įrašymą, gedimas taptų neapdorotu `rejection`, o autorizacijos ar
      ištrynimo srautas tęstųsi — audito įvykis dingtų tyliai. Reikia arba
      `await` ten, kur tinka, arba patvarios eilės su eksplicitiniu klaidų
      pranešimu. Testas: draiverio gedimas prieš teigiant, kad auditas
      persistentis.

---

## [7.6] Health, readiness ir backup su restore

**Tėvinis:** #155 · **Priklauso nuo:** 7.2a

### DoD

- [ ] `make doctor` ir readiness rodo DB būseną (prisijungimas, schemos versija,
      migracijų atsilikimas).
- [ ] `/api/health` DB būsenos NErodo produkcijoje pagal nutylėjimą
      (`HEALTH_DETAILS`, kaip esami tiekėjų pavadinimai).
- [ ] `docs/backup-runbook.md` papildytas Postgres atsarginėmis kopijomis.
- [ ] ⚠️ **RESTORE testas, ne tik instrukcija:** `pg_dump` → nauja tuščia DB →
      restore → `schema_version` patikra → keli reprezentatyvūs **`jobs`** IR
      **`job_results`** įrašai sutampa. Gali būti atskiras integracinis workflow.
- [ ] ⚠️ **PRATYBOS NAUDOJA ŠIFRUOTĄ ARTEFAKTĄ.** `utils/backupEncryption.js`
      reikalauja AES-256-GCM su autentikuotu atkūrimu. Kriterijus, tenkinamas
      paprastu `pg_dump`, tyliai susilpnintų esamą apsaugą — o `job_results`
      turės transkripcijas. Testas: dešifravimas ir autentiškumo patikra prieš
      restore.
- [ ] ⚠️ **`job_results` ĮTRAUKIAMI Į PALYGINIMĄ.** Transkripcijos gyvena
      atskiroje lentelėje; procedūra, kuri jų neatkuria arba sugadina, praeitų
      patikrą, nors kiekvienas baigtas job'as būtų praradęs vartotojui matomą
      rezultatą.
- [ ] ⚠️ **`audit_log` IŠ ATKŪRIMO IŠBRAUKTAS.** `utils/backupPolicy.js` tai jau
      daro sąmoningai: atkūrus, GDPR ištrinti įrašai grįžtų, o naujesni
      append-only įvykiai būtų perrašyti arba dubliuoti. Testas: prieš kopiją
      įrašoma UNIKALIAI ATPAŽĮSTAMA audito eilutė, ir po restore jos NĖRA.
      ⚠️ „Nesutampa su dump'u" nepakanka — atkūrimas įrašo naujų įvykių, tad
      nesutapimas atsiranda savaime.
- [ ] ⚠️ **Sesijos po atkūrimo MASIŠKAI ATŠAUKIAMOS.** Kitaip atkūrimas prikeltų
      atšauktas sesijas: klientas ar užpuolikas gali tebeturėti tą pačią cookie,
      o senas `token_hash` ją vėl padarytų galiojančia. Testas: sesija atšaukta
      PO kopijos → po restore ta cookie neautentifikuoja.
- [ ] ⚠️ **NE-TERMINALĖS EILUTĖS PO ATKŪRIMO SUDERINAMOS.** Kopijoje gali būti
      `queued`/`processing` įrašų, o BullMQ būsena į kopiją NEPATENKA (backup
      politika eilės įrašus išbraukia sąmoningai). Atkūrus juos nepakeistus,
      jie lieka amžinai ne-terminalūs: `sweepExpired()` jų nešalina, ir
      klientai apklausinėja job'us, kurie niekada nepasileis. Restore
      procedūra privalo juos terminalizuoti arba saugiai atkurti eilės darbą.
- [ ] ⚠️ **Ištrynimo žurnalas išsaugomas UŽ snapshot'o ribų** ir sujungiamas po
      atkūrimo. Kitaip job'as, ištrintas po kopijos, grįžtų su rezultatu, bet be
      tombstone. Testas: job'as ištrintas po kopijos → po restore jo NĖRA.
- [ ] README apribojimų lentelės eilutės atnaujintos; Roadmap `[x]`.
