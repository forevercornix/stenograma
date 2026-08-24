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

**Tėvinis:** #155 · **Priklauso nuo:** 7.1

### DoD

- [ ] `audit_log` su `subject_id`, **be plikojo `job_id`** — testas įrašo job'ą
      ir tikrina, kad jo ID lentelėje nerandamas nė viename stulpelyje ar `meta`
      JSONB lauke.
- [ ] `audit_log` neturi transkripcijos teksto — testas.
- [ ] Esami `auditLog.test.js` ir `auditErasure.service.test.js` praeina su
      `postgresStore` **be modifikacijų**.
- [ ] `hash_key_id` užpildomas; rakto rotacijos testas rodo, kad seni įrašai
      lieka koreliuojami.
- [ ] `GET /api/audit?job_id=` randa įrašą, sukurtą PRIEŠ rakto rotaciją — API
      moka ieškoti ir su istoriniu raktu.
- [ ] `GET /api/audit` filtrai (`from`, `to`, `action`, `request_id`, `job_id`)
      + puslapiavimas. `job_id` filtras pseudonimizuoja gautą ID ir ieško pagal
      `subject_id` — filtras NĖRA priežastis grąžinti plikąjį stulpelį.
- [ ] Auditas išgyvena `docker compose restart backend`.
- [ ] Retencija: N dienų pagal `privacyConfig`.
- [ ] ⚠️ **`AUDIT_ID_SALT` TAMPA PRIVALOMA.** `auditLog.resolveSalt()`
      sąmoningai generuoja atsitiktinę procesui lokalią druską, kai jos nėra —
      tai saugu TIK kol auditas atmintyje. Persistuojant restartas ar antra
      replika skaičiuotų kitą pseudonimą, ir `removeBySubjectIdentifier(jobId)`
      senų įrašų nerastų, tad GDPR ištrynimas jų nepasiektų. Reikia startinės
      validacijos ir migracijos/cutover reikalavimo.

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
