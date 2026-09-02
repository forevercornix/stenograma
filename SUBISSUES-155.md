# SUBISSUES-155

Vieninteliai sub-issue tekstų šaltinis. `scripts/dev/create-155-subissues.sh` juos skaito.

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

## [7.2c] Tipų normalizavimas ir backend'ų elgsenos paritetas

**Tėvinis:** #155 · **Priklauso nuo:** 7.2b · **Tipas:** duomenų modelio
kontraktas · **Prioritetas:** P1

Tipų konvertavimo aibės (`BOOLEAN_FIELDS`, `NUMBER_FIELDS`) gyvena
`redisStore.js` viduje, nors jos saugo nuo gedimo, kuris kartojasi. Bet po
peržiūros paaiškėjo, kad **problema platesnė nei aibių vieta**: normalizavimo
nėra rašymo kelyje, tad trys backend'ai to paties patch'o rezultatą grąžina
skirtingai — ne tik kitokiu tipu, bet ir kitokia logine reikšme.

## Ar tai pasiekiama ŠIANDIEN

⚠️ **Ne per produkcinius kelius.** Patikrinta prieš `main` (`11fb336`):
produkcinis kodas eilučių į šiuos laukus nesiunčia, o eilutės ateidavo iš Redis,
ne iš kviečiančiųjų. Divergencija pasiekiama tik per tiesioginį `store.update()`
su eilutės reikšme.

Tai apsauga nuo ateities regresijos, ne esamo gedimo taisymas — bet šablonas jau
sprogo **tris kartus**, ir vienas iš jų reiškė duomenų praradimą.

## Įrodymas

`store.update(id, { laukas: "false" })` ir `"0"`, prieš tikrą PostgreSQL:

| Laukas | memory | postgres |
|---|---|---|
| ⚠️ `audio_cleanup_pending` | `"false"` | `true` |
| ⚠️ `deletion_pending` | `"false"` | `true` |
| ⚠️ `progressKnown` | `"false"` | `false` |
| ⚠️ `attempt_count` | `"0"` | `0` |
| ⚠️ `audio_cleanup_attempts` | `"0"` | `0` |
| ⚠️ `deletion_attempts` | `"0"` | `0` |

Du pirmieji pavojingiausi: memory palieka `"false"`, kuris JavaScript'e yra
**truthy**, o PostgreSQL grąžina `true` per `Boolean("false")`. Skiriasi ne tik
tipas, bet ir loginė reikšmė, kurią mato kviečiantysis kodas.

`schemaVersion` (septintas tos pačios aibės laukas) ištaisytas #204.

## Kodėl verta spręsti

`redisStore.js:58-70` komentaras dokumentuoja tris pasekmes:

| Laukas | Pasekmė |
|---|---|
| `audio_cleanup_pending: "false"` | `listByFlag()` grąžindavo VISUS job'us, o `retryPendingAudioCleanups()` trindavo dar apdorojamų job'ų audio |
| `progressKnown: "false"` | `"false"` yra truthy → `progressKnown === false` niekada nesuveikdavo |
| `audio_cleanup_attempts: "0"` | `("0" \|\| 0) + 1 === "01"` → skaitliukas ir alerto riba neveikė |

Tas pats komentaras įvardija šaknį: *„`attempt_count` jau buvo apdorojamas
atskirai — tai buvo užuomina, kad ši spąsta žinoma; naujus laukus reikėjo
pridėti čia iš karto."*

Duomenų praradimas jau įvyko kartą. Ketvirtas kartas kainuos tiek pat, o
šiandien niekas jo nesustabdytų.

## Pasirinktas sprendimas

Kanoninių tipų kontraktas perkeliamas į `common.js`, bet **vien aibių perkėlimo
NEPAKANKA.** Normalizavimas vykdomas bendrame **rašymo** kelyje, prieš
backend'ams gaunant pataisytą objektą:

```
patch
→ common.js validacija / applyPatch()
→ kanoninių boolean/number laukų normalizavimas
→ kanoninis job objektas
→ memory / Redis / PostgreSQL backend
```

Todėl:

- `memoryStore` niekada neišsaugo `"false"` ar `"0"` kanoniniame lauke;
- `redisStore.update()` **tiesioginis** rezultatas jau normalizuotas, dar PRIEŠ
  serialize/deserialize round-trip;
- `postgresStore` negauna `"false"` ir nepaverčia jo per
  `Boolean("false") === true`;
- `redisStore.deserialize()` **išlieka**, nes Redis fiziškai saugo tekstą — bet
  aibę ima iš `common.js`, ne apibrėžia savo.

### ⚠️ `create()` ir `restoreRecord()` — ne tik `update()`

`applyPatch()` dengia atnaujinimus. Bet **`restoreRecord()` priima savavališką
įrašą iš atsarginės kopijos**, o senesnė kopija gali turėti būtent tas tekstines
reikšmes, dėl kurių šis issue egzistuoja. Atkūrimas be normalizavimo grąžintų
gedimą į gyvą sistemą — ir kaip tik tuo momentu, kai niekas neįtaria.

Normalizavimas taikomas **visiems** keliams, kuriais job objektas patenka į
saugyklą: `create()`, `update()`, `restoreRecord()`. Testas kiekvienam.

### Kanoninės konversijos semantika

Normalizavimas **negali** naudoti bendro JavaScript truthiness:

```
"false" → false        NE Boolean("false") → true
"true"  → true
"0"     → 0            (number, ne eilutė)
```

Neaiški ar neleistina reikšmė **negali būti tyliai interpretuojama kaip kita
loginė reikšmė**.

⚠️ **Neleistinos įvesties politika neišrandama iš naujo** — ji išlaiko esamą
`applyPatch()` kontraktą. Bet kad ir kokia ji būtų, ji privalo būti **vienoda
visuose trijuose backend'uose**, ir tai įrodo testas. Priešingu atveju
divergencija tiesiog persikelia iš teisingų reikšmių į neteisingas.

### Dvi normalizavimo vietos negali išsiskirti

Po pataisos jų lieka dvi: rašymo kelias `common.js` ir `redisStore.deserialize()`
skaitymo kelyje. Abi privalo naudoti **tą patį helperį**, ir testas įrodo, kad
tai pačiai įvesčiai jos duoda tapatų rezultatą. Dvi nepriklausomos realizacijos
yra ta pati klasė, kurią šis issue ir šalina.

### Job modelio sargas

`BOOLEAN_FIELDS` ir `NUMBER_FIELDS` lieka **eksplicitinis** kanoninis kontraktas
`common.js`. Bet jų pilnumas **netikrinamas antru rankiniu sąrašu**.

Sargo testas programiškai sukuria `newJob()` ir tikrina:

- kiekvienas laukas, kurio numatytoji reikšmė yra `boolean`, yra
  `BOOLEAN_FIELDS`;
- kiekvienas laukas, kurio numatytoji reikšmė yra `number`, yra `NUMBER_FIELDS`.

Taip naujas typed laukas negali atsirasti `newJob()` pamirštant normalizavimo
kontraktą.

⚠️ **Aibės NEGENERUOJAMOS iš `newJob()`.** `newJob()` yra runtime objektų
konstruktorius, o laukų schema — duomenų modelio kontraktas. Schema neturi būti
netiesiogiai „atrandama" paleidžiant konstruktorių; ji deklaruojama, o
konstruktorius prieš ją tikrinamas.

⚠️ **Sargo riba, kurią reikia įvardyti:** jis mato tik tuos laukus, kurie
egzistuoja `newJob()` išvestyje. Laukas, atsirandantis tik vėliau (pvz. tik
užbaigimo metu), pro jį prasmuktų. Tokie laukai deklaruojami kanoniniame
kontrakte eksplicitiškai, ir ta riba užrašoma sargo komentare — kitaip jis
skelbtų pilnumą, kurio neturi.

### Typed defaults invariantas

Kad sargas būtų patikimas:

- kanoninis boolean laukas `newJob()` turi turėti **boolean** numatytąją reikšmę;
- kanoninis number laukas — **number**;
- naujas boolean/number laukas negali būti inicializuojamas `null` ar
  `undefined` (nes `typeof null === "object"`, ir tipo aptikimas tyliai
  nesuveiktų).

Jei ateityje reikės nullable typed lauko, jo tipas deklaruojamas kanoniniame
kontrakte eksplicitiškai ir sargas praplečiamas — negalima leisti jam tyliai
iškristi iš tikrinimo. Ši taisyklė užrašoma komentaru pačiame `newJob()`.

## DoD

- [ ] `BOOLEAN_FIELDS` ir `NUMBER_FIELDS` apibrėžtos `common.js`; `redisStore`
      savo kopijų nebeturi.
- [ ] `applyPatch()` arba vienas jo naudojamas `common.js` helperis yra
      **autoritetingas rašymo kelio normalizavimo taškas** visiems backend'ams.
- [ ] Normalizavimas taikomas `create()`, `update()` **ir** `restoreRecord()` —
      testas kiekvienam keliui.
- [ ] `"false"` boolean lauke normalizuojamas į `false`, ne per truthiness į
      `true`.
- [ ] `"0"` skaitiniame lauke normalizuojamas į number `0`.
- [ ] Neleistinos įvesties elgesys išlaiko esamą `applyPatch()` kontraktą ir yra
      **vienodas visuose trijuose backend'uose** — testas.
- [ ] `redisStore.deserialize()` ir rašymo kelias naudoja tą patį helperį;
      testas įrodo tapatų rezultatą tai pačiai įvesčiai.
- [ ] ⚠️ **RAŠYMO + SKAITYMO PARITETAS.** Kiekvienam kanoniniam laukui tas pats
      tekstinis patch'as taikomas visiems trims backend'ams, ir testas atskirai
      tikrina:
      **(1)** `await store.update(id, patch)` **tiesioginį** rezultatą;
      **(2)** po to `await store.get(id)` rezultatą.
      Abu turi turėti identišką kanoninę reikšmę IR identišką JavaScript tipą.
      **Vien `get()` patikros nepakanka** — Redis skaitymo kelio `deserialize()`
      paslėptų rašymo kelio regresiją.
- [ ] Paritetų testas **parametrizuotas pagal aibę**, apima VISUS
      `BOOLEAN_FIELDS` ir `NUMBER_FIELDS`, ne tik istorinius šešis laukus.
- [ ] Sargo testas iš `newJob()` nustato visus boolean/number numatytųjų
      reikšmių laukus ir įrodo, kad jie yra atitinkamoje kanoninėje aibėje.
- [ ] Sargo riba (laukai, neegzistuojantys `newJob()` išvestyje) įvardyta
      komentare, ne nutylėta.
- [ ] `newJob()` turi komentarą su typed defaults invariantu.
- [ ] Regresijos testai trims istoriniams atvejams: `listByFlag()` su `"false"`,
      `progressKnown === false` patikra, `attempt_count` didinimas.
- [ ] ⚠️ **Mutacija:** pridėjus naują boolean/number lauką į `newJob()` ir
      neįtraukus jo į kanoninį kontraktą, **sargo testas krinta**.
- [ ] ⚠️ **Mutacija:** pašalinus rašymo kelio normalizavimą, **pariteto testas
      krinta net tada, kai `redisStore.deserialize()` tebeveikia**.
- [ ] `docs/security-test-matrix.md` įrašas: audio valymo vėliavos yra duomenų
      praradimo riba, ne stiliaus klausimas. Eilutė įvardija savo mutaciją.

## Ko NEAPIMA

- `schemaVersion` — ištaisytas #204.
- Redis serializavimo formato keitimo: Redis ir toliau saugo eilutes, keičiasi
  tik tai, kur apibrėžta kanoninė aibė.
- Įvesties validacijos maršrutuose: čia storage-layer kontraktas, ne HTTP.
- Naujų laukų pridėjimo į job modelį.
- Bendro schema framework'o, Zod ar JSON Schema migracijos.

## Kilmė

Rasta klausiant, ar #204 sprendžia pavienį atvejį, ar šabloną. `schemaVersion`
buvo septintas iš septynių tos pačios aibės laukų; likę šeši patikrinti
eksperimentu ir visi elgėsi skirtingai.

Peržiūra parodė, kad tai ne Redis refaktoringas, o rašymo kelio kontrakto
pataisymas — todėl issue pervadintas ir formalizuotas kaip **7.2c**, tiesioginis
7.2b backend kontrakto ekvivalentumo tęsinys.

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
| `7.4d` | #213 | Retencija ir privatumo režimas |
| `7.4e` | #216 | Audito ištrynimo galutinumas |
| `7.4f` | #231 | Readiness, backup ir CI registracija |

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

## [7.4d] Retencija ir privatumo režimas

**Tėvinis:** #155 · **Priklauso nuo:** 7.4b, 7.4f · **Lygiagretus:** 7.4e

Persistentinio audito duomenų gyvavimo ciklo uždarymas: retencija ir
`PRIVACY_MODE`.

⚠️ **APIMTIS SUSIAURINTA.** Readiness, backup/7.6 kabliukas, PostgreSQL CI
registracija, cutover ir operatoriaus dokumentacija įgyvendinti **7.4f (#231)**
ir čia NEKARTOJAMI. Ankstesnė šio issue redakcija juos apėmė; jei kur nors
matote tuos reikalavimus, autoritetas yra #231.

### Užfiksuoti sprendimai

- `AUDIT_MAX_ENTRIES` PostgreSQL režime **NETAIKOMA** kaip retencijos taisyklė.
  Tai buvo apsauga nuo RAM augimo; ribos „palik paskutinius N" į DB
  neperkeliame.
- Retencijos riba: `timestamp < cutoff` → šalinama, `timestamp == cutoff` →
  **lieka**, `timestamp > cutoff` → lieka.
- `PRIVACY_MODE=true` PostgreSQL režime: naujų įrašų nerašo IR starto metu
  fiziškai išvalo esamas `audit_log` eilutes — atitinka dabartinį in-memory
  kontraktą, kuris žada ištrynimą, ne nutildymą.
- Batch dydis **nefiksuojamas skaičiumi šiame issue**. Reikalaujama „ribotas
  batch su viena autoritetinga numatytąja reikšme"; konkretų dydį parenka
  realizacija pagal repo konvencijas ir jį testuoja.

- ⚠️ **Init tvarka:** `PRIVACY_MODE` purge vykdomas ir `await`inamas **PRIEŠ**
  `patikrintiGeneracijas()`. Išvalius eilutes `usedGenerations()` grąžina `[]`,
  tad 7.4c naslaičių patikra nebeturi ko atmesti. Priešinga tvarka sustabdytų
  startą dėl įrašų, kuriuos purge tuoj pat ištrintų.
- Batch kandidatų atranka PostgreSQL režime naudoja `FOR UPDATE SKIP LOCKED`.
  Nukrypti galima tik su eksplicitiniu pagrindimu.

### Retencijos vykdymo kontraktas

- Retencijos autoritetas — esama centralizuota `privacyConfig` /
  `retentionSweeper` architektūra. Auditui nekuriamas atskiras timer'is,
  scheduler'is ar antra retention konfigūracija.
- Cutoff apskaičiuojamas **VIENĄ kartą** sweep ciklo pradžioje iš kontroliuojamo
  laiko šaltinio: `cutoff = now − retention`. Visi to paties sweep batch'ai
  naudoja tą pačią reikšmę. ⚠️ Perskaičiuojant `now()` kiekvienam batch'ui,
  ilgo sweep metu keistųsi naikinamų eilučių aibė.
- Sweep vykdomas ribotais batch'ais. Vienas DB kvietimas pašalina ne daugiau
  nei batch limitas; pilnas sweep kartoja, kol pašalinta mažiau nei limitas
  arba nulis.
- ⚠️ **Batch dydis turi VIENĄ autoritetingą šaltinį** — konstantą arba
  konfigūraciją store/retention sluoksnyje. Ranka įrašyti skirtingi dydžiai
  kode ir teste yra ta pati rankomis palaikomo sąrašo klasė, kurią 7.4f
  pašalino kitur.
- ⚠️ **Kandidatų atranka deterministinė ir indeksu palaikoma.** Negalima
  parsisiųsti visų expired eilučių į Node ir trinti po vieną. PostgreSQL
  `DELETE` neturi paprasto `LIMIT` — reikalingas kandidatų CTE/subquery.
  Issue fiksuoja REZULTATĄ, ne SQL sintaksę.
- ⚠️ **SWEEP CIKLAI NEPERSIDENGIA VIENOJE INSTANCIJOJE.** Jei ankstesnis sweep
  dar vyksta, scheduler'io kitas tick'as nepradeda antro. Įrodoma elgsenos
  testu, ne `isSweeping` kintamojo egzistavimu.
- ⚠️ **Proceso lokali spyna NĖRA multi-instance korektiškumo garantija.** Dvi
  instancijos gali trinti tą pačią expired aibę vienu metu; rezultatas privalo
  likti korektiškas ir idempotentiškas. Jei reikia stipresnio mechanizmo
  (advisory lock), tai eksplicitinis sprendimas su pagrindimu, ne prielaida.

### `PRIVACY_MODE` startup kontraktas

- `PRIVACY_MODE=true` su PostgreSQL yra **STARTUP BARJERAS**, ne foninis
  best-effort valymas.
- Init seka: DB/pool paruoštas → migracijos pritaikytos → audit store
  inicializuotas → `PRIVACY_MODE` RAW valymas **`await`intas** → tik tada
  instancija gali aptarnauti srautą.
- ⚠️ **Valymas negali vykti prieš migracijas ar store init** — kitaip startas
  griūva lenktynėse.
- ⚠️ **Purge nesėkmė → startup FAIL-CLOSED.** Negalima tęsti su
  `PRIVACY_MODE=true` ir senomis eilutėmis DB.
- ⚠️ **VEIKIANTI KLAIDA, NE BŪSIMA SPRAGA.** `auditLog.js:555-559` ir `:619-633`:
  `PRIVACY_MODE=true` metu `record()`, `getAll()` ir `query()` kviečia
  `purgeForPrivacyMode()` → `clear()`, o `postgresStore.clear()` (`:347-357`)
  meta klaidą, kai `NODE_ENV !== "test"`. Produkcijoje su PostgreSQL procesas
  kristų per pirmą audito rašymą. PostgreSQL režime tai privalo būti saugus
  no-op: DB išvaloma starto metu, nauji įrašai nepridedami.
- Kol `PRIVACY_MODE=true`, nauji audit įrašai nepersistinami.
- Režimo keitimas vyksta per proceso restartą / init semantiką. Runtime
  hot-toggle nekuriamas, jei repo kontrakte tokio nėra.
- `true → false` neprikelia ištrintų įrašų; po normalaus starto tiesiog vėl
  leidžiami nauji.

### `DELETE` kelių kontraktas

- Teisėti aukšto lygio šalinimo keliai persistentiniame audite: **subject
  erasure**, **retencija**, **`PRIVACY_MODE` startup purge**.
- ⚠️ **Suderinama su FAKTINE 7.4b append-only apsauga.** 7.4d neapeina jos
  „specialiu raw SQL hack'u". Jei 7.4b pasirinko store-API enforcement — visi
  trys keliai eina per kontroliuojamą store API; jei DB roles/grants — per tam
  skirtą leistiną kelią. Prieš rašant kodą įvardyti, kuris mechanizmas
  faktiškai galioja.
- Bendras produkcinis audit caller'is negauna laisvo `DELETE FROM audit_log`
  primityvo.

### `AUDIT_MAX_ENTRIES`

- Memory backend išlaiko esamą semantiką.
- PostgreSQL backend šio limito nelaiko retencijos taisykle: eilutės netrinamos
  vien todėl, kad jų skaičius viršijo N.
- ⚠️ Testas įrodo **faktinį elgesį**, ne config parse: į DB įrašoma daugiau nei
  `AUDIT_MAX_ENTRIES`, ir eilutės išlieka, kol jų nepaliečia laiko retencija,
  erasure ar privacy purge.

### DoD

**Retencija**

- [ ] ⚠️ Retencijos autoritetas lieka `privacyConfig` / centralizuota
      architektūra. Antras mechanizmas vien auditui nekuriamas.
- [ ] Cutoff apskaičiuojamas vieną kartą sweep ciklui ir tas pats perduodamas
      visiems batch'ams — testas.
- [ ] RAW PostgreSQL ribos testas su kontroliuojamu laiku: `< cutoff`
      pašalinama, `== cutoff` lieka, `> cutoff` lieka.
- [ ] Vienas DB batch kvietimas pašalina ne daugiau nei batch limitas; testas
      įrodo, kad didesnei expired aibei atliekami keli atskiri DB kvietimai.
- [ ] Batch dydis turi vieną autoritetingą šaltinį; testas jį naudoja, o ne
      kartoja skaičių.
- [ ] Vienos instancijos sweep'ai nepersidengia — elgsenos testas, ne vėliavos
      egzistavimas.
- [ ] Dviejų instancijų lygiagretus sweep prieš tą pačią DB nepalieka expired
      eilučių ir nesukelia korektiškumo klaidos. Batch atranka naudoja
      `FOR UPDATE SKIP LOCKED`; dvi lygiagrečios transakcijos baigiasi be
      deadlock'o.
- [ ] ⚠️ `retentionSweeper` **`await`ina** `auditLog.purgeExpired(now)`. Tapus
      async, be `await` sweeper logintų `[object Promise]` vietoj skaičiaus ir
      galėtų palikti neapdorotą rejection. Testas: grąžinamas baigtinis sveikasis
      skaičius abiejuose backend'uose.
- [ ] ⚠️ **RETENCIJA ATRAKINA RAKTO IŠĖMIMĄ.** 7.4c fail-closed taisyklė
      neleidžia pašalinti rakto, kol DB yra jo `hash_key_id` įrašų. Testas
      užbaigia ciklą: retencija pašalina visus `A` generacijos įrašus → `A`
      išimamas iš `AUDIT_ID_SALT_PREVIOUS` → startas sėkmingas.
- [ ] Retencija taikoma vienodai visoms generacijoms — senas `hash_key_id`
      nėra priežastis įrašą palikti ar pašalinti anksčiau.

**`PRIVACY_MODE`**

- [ ] Purge vykdomas tik PO DB/migracijų/store init ir PRIEŠ instancijai tampant
      pasiruošusia aptarnauti srautą.
- [ ] Purge `await`inamas; fire-and-forget nėra.
- [ ] Purge klaida → startup FAIL, procesas nepradeda aptarnauti užklausų.
- [ ] ⚠️ RAW PostgreSQL testas: prieš startą DB turi žinomą sentinel eilutę →
      startas su `PRIVACY_MODE=true` → RAW `audit_log` sentinel eilutės nėra.
- [ ] Tame pačiame scenarijuje audit įvykio generavimas po starto nepalieka
      naujos RAW eilutės.
- [ ] `true → false`: seni įrašai negrįžta, nauji vėl persistinami.
- [ ] ⚠️ Gamybiniame režime (`NODE_ENV !== "test"`) `PRIVACY_MODE=true` su
      PostgreSQL NEsukelia klaidos rašant, skaitant ar užklausiant auditą —
      testas gamybiniu režimu, ne tik `NODE_ENV=test`.
- [ ] Purge `await`inamas PRIEŠ `patikrintiGeneracijas()` — testas: DB turi
      naslaičių generaciją, `PRIVACY_MODE=true`, startas praeina.

**`DELETE` politika ir `AUDIT_MAX_ENTRIES`**

- [ ] Retencija, erasure ir privacy purge integruoti su 7.4b apsauga per
      autoritetingą leistiną kelią; bendras neautorizuotas `DELETE` lieka
      nepasiekiamas — testas.
- [ ] PostgreSQL režime daugiau nei `AUDIT_MAX_ENTRIES` įrašų vien dėl kiekio
      nėra ištrinami — elgsenos testas.
- [ ] Memory `AUDIT_MAX_ENTRIES` elgesys neregresuoja.

**Regresija ir sąveika**

- [ ] 7.4d nedubliuoja ir nekeičia 7.4f readiness/backup/CI/dokumentacijos
      funkcionalumo; 7.4f laikomas prerequisite baseline.
- [ ] ⚠️ **PATIKRINTI PRIEŠ RAŠANT:** `postgresDoctor.integration.test.js`
      turi tripwire (`/job store|sesij|audit/i`), draudžiantį žadėti
      neįgyvendintas integracijas. Jei retencija/privacy keičia doctor
      pranešimą, testas krenta. Nustatyti, ar jis dar galioja po 7.4b/7.4f, ir
      atnaujinti kartu, ne aklai.
- [ ] ⚠️ **`pg_dump` IŠBRAUKIMAS.** `backupPolicy` dirba su artefaktų tipais, o
      `audit_log` yra DB lentelė: fizinė `pg_dump` kopija ją įtrauktų, ir atkūrus
      grįžtų GDPR ištrinti bei pasenę įrašai. `docs/backup-runbook.md` pilnos
      PostgreSQL kopijos skyriuje įrašyti `--exclude-table-data=audit_log` su
      paaiškinimu kodėl.

### Ko NEAPIMA

Readiness, `/api/health`, backup politikos kabliuko, PostgreSQL CI registracijos,
cutover ir operatoriaus dokumentacijos (visa tai — 7.4f/#231). Rakto rotacijos
(7.4c). Ištrynimo galutinumo barjero (7.4e/#216). 7.6 atkūrimo. Job store,
sesijų ir authentication pakeitimų.

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

## [7.4f] Audit readiness, backup ir CI registracija

**Tėvinis:** #155 · **Priklauso nuo:** 7.4b, 7.4c · **Lygiagretus:** 7.4d, 7.4e
· **Blokuoja:** 7.6

Operacinis 7.4 uždarymas: readiness, kabliukas 7.6 atkūrimui, PostgreSQL CI
rinkinio išvedimas ir operatoriaus dokumentacija.

⚠️ **Kodėl atskirai.** Ši apimtis buvo suplanuota kaip 7.4e, bet §7.4e atiteko
audito ištrynimo galutinumui (#216), tad readiness, backup politika ir CI
liko be savo issue — nors nuo `backupPolicy` kabliuko priklauso 7.6 DoD.

### Jau padaryta ankstesniuose etapuose

Šie punktai NĖRA šio darbo dalis; įrašyti, kad nebūtų perdaryti:

- `tests/helpers/postgresGuard.js` su `REQUIRE_POSTGRES=1` — egzistuoja.
- `readiness.auditStore` laukas ir jo nustatymas po `auditStore.init()`
  (`server.js:81`, `:383`) — egzistuoja. Trūksta tik **patikros**.
- `backupPolicy` išbraukia `ARTEFACT_TYPES.AUDIT_ENTRY` su pagrindimu
  (`backupPolicy.js:65-80`) — egzistuoja. Trūksta **išvedamo sąrašo ir testo**.

### Readiness

- [ ] ⚠️ **`/api/ready` TIKRINA `readiness.auditStore`.** Šiandien
      `server.js:305-309` tikrina tik `jobStore && jobRunner &&
      sessionReconcile`. Jei `auditStore.init()` krenta, serveris grąžina 200 ir
      priima srautą — fail-closed audito apsauga apeinama. Tai veikianti klaida,
      ne būsimo darbo spraga.
- [ ] ⚠️ **Aktyvus zondas `probeRuntimeReadiness()` viduje.** Simetriškai
      `sessionStore.probe()`, su `READINESS_TIMEOUT_MS` riba. Be jo DB kritimas
      ar teisių pakeitimas PO starto lieka nepastebėtas, ir instancija toliau
      priima audito generuojančias užklausas (pvz. prisijungimus).
- [ ] ⚠️ **`postgresStore.probe()` tikrina PRIVILEGIJAS, ne `SELECT 1`.**
      Dabartinė realizacija (`auditStore/postgresStore.js:250-253`) įrodo tik
      kad ryšys gyvas. Reikia `has_table_privilege()` patikros `SELECT`,
      `INSERT` ir `DELETE` teisėms ant `audit_log`, pagal
      `sessionStore/postgresStore.js` šabloną. Be `DELETE` GDPR ištrynimas
      lūžtų tyliai.
- [ ] ⚠️ **Zondo rezultatas kešuojamas** (TTL ~2000 ms). Orkestratoriaus
      poll'ai kitaip generuoja SQL kiekvienam kvietimui.
- [ ] ⚠️ **Cache ĮRODOMAS `pool.query` sekimu, ne laiko matavimu.**
      Realizacija su `Date.now()`, bet be faktinio praleidimo, praeitų naivų
      testą. Testas: kelis kartus iš eilės kviečiamas `probe()` kešo lange →
      `pool.query` iškviestas lygiai vieną kartą.
- [ ] ⚠️ **NEIŠSPRENDŽIAMOS GENERACIJOS → NOT READY.** Jei 7.4c raktų
      resolveris nemato rakto DB esančiai `hash_key_id` generacijai,
      `/api/ready` grąžina 503 — net kai procesas paleistas su
      `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true`. Vėliavėlė leidžia
      startuoti, bet nedeklaruoja sveikatos.
- [ ] ⚠️ **BET `/api/health` (liveness) LIEKA 200.** Priešingu atveju
      orkestratorius nuolat perkraudinėtų podą, ir operatorius neturėtų lango
      išvalyti senų eilučių — vėliavėlė netektų prasmės, o atsistatymo kelias
      būtų paneigtas. Testas abiem endpoint'ams tuo pačiu metu.
- [ ] `/api/health` DB ir audit backend detalių produkcijoje pagal nutylėjimą
      NErodo (`HEALTH_DETAILS`, kaip esami tiekėjų pavadinimai).
- [ ] ⚠️ **Secret reikšmės nepatenka į logus, health ar readiness atsakymus** —
      testas, apimantis ir 7.4c raktų validacijos startup klaidas.

### Backup ir 7.6 sąsaja

- [ ] ⚠️ **`excludedTables()` IŠVEDAMAS iš `backupPolicy.js`,** ne surašytas
      teste. Hardcode'intas `audit_log` teste yra rankomis palaikomas sąrašas,
      linkęs tyliai išsiskirti su politika.
- [ ] Testas, kad `audit_log` yra išbraukimų aibėje ir kad aibė gaunama iš
      politikos, ne iš literalo. Tai kabliukas, kurio reikia 7.6 DoD („prieš
      kopiją įrašyta unikali audito eilutė po restore NERANDAMA").
- [ ] ⚠️ **RAKTAI NĖRA KOPIJOJE, BET BE JŲ KOPIJA BEVERTĖ.**
      `docs/backup-runbook.md` skyriuose „Kas patenka į kopiją", „Atkūrimas" ir
      „Ko atkūrimas negrąžina" privalo būti eksplicitiškai: `AUDIT_ID_SALT` ir
      `AUDIT_ID_SALT_PREVIOUS` saugomi ATSKIRAI ir atkuriami kartu. Atkūrus
      `audit_log` be jų, visos generacijos tampa neišsprendžiamos (7.4c
      fail-closed), o GDPR ištrynimas nebeįmanomas.

### PostgreSQL CI

- [ ] ⚠️ **`tests/suites.js` postgres rinkinys IŠVEDAMAS, ne surašomas.**
      Dabar tai fiksuotas vardų sąrašas (`suites.js:210-235`). Naujas
      integracinis testas, kurio kas nors nepridės ranka, niekada nebus
      paleistas — CI liks žalias, o kodas nepatikrintas. Rinkinys sudaromas
      skenuojant `tests/`: failai su `.integration` varde arba importuojantys
      `postgresGuard`.
- [ ] ⚠️ **Įrodymas, kad testai TIKRAI vykdyti.** Su `REQUIRE_POSTGRES=1`
      tikrinama, kad kiekvienam postgres rinkinio failui pasirodė bent vienas
      `ok`. Žalias job'as su praleistais testais nėra sėkmė.
- [ ] Visi 7.4b–7.4e PostgreSQL integration testai patenka į išvestą rinkinį —
      patikrinama faktiniu vykdymu, ne failo egzistavimu.

### Cutover ir dokumentacija

- [ ] ⚠️ **CUTOVER IR ROLLBACK.** Esami in-memory įrašai NEPERKELIAMI. Grįžimas
      `postgres → memory` reiškia, kad seni įrašai lieka DB ir nauji į juos
      nebepatenka — sąmoningas elgesys, įrašytas į diegimo pastabas.
- [ ] `.env.example` ir operatoriaus dokumentacija: `AUDIT_BACKEND`,
      `AUDIT_ID_SALT`, `AUDIT_ID_SALT_ID`, `AUDIT_ID_SALT_PREVIOUS`,
      `AUDIT_WRITE_TIMEOUT_MS`, `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS`.
- [ ] Security/evidence matrix atnaujinta, jei to reikalauja repo sargai.
- [ ] README apribojimų lentelės eilutė ir Roadmap punktas atnaujinti.

### Ko NEAPIMA

Retencijos ir `PRIVACY_MODE` (7.4d), ištrynimo galutinumo barjero (7.4e),
rakto rotacijos realizacijos (7.4c). `postgresGuard.js` kūrimo — jis jau yra.
Job store, sesijų ir authentication pakeitimų.

---

## [7.5a] Persistentės ištrynimo žymos

**Tėvinis:** #155 · **Priklauso nuo:** 7.1 · **Blokuoja:** 7.4e, 7.6

Tiesioginis `docs/deletion-guarantees.md` 2 skyriaus apribojimo pašalinimas.

⚠️ **TAI MIGRACIJA, NE NAUJA SISTEMA.** `backend/utils/deletionTombstones.js` jau
egzistuoja: in-memory `Map` (`:46-52`), sinchroninis `isDeleted()` (`:168-180`) ir
lokalus `setInterval` valymas (`:207-213`). 7.5a perkelia tai į PostgreSQL.

Šis etapas sukuria **vienintelį persistentinį job ištrynimo tombstone autoritetą**,
kurį vėliau naudoja ir 7.4e audito ištrynimo galutinumo barjeras. **7.4e NEKURIA
atskiros audito tombstone lentelės.**

### Užfiksuoti sprendimai

- Barjeras aktyvus nuo `deletion_pending`, ne tik nuo `deleted`.
- `deleted` — terminali būsena; vėlyvas `deletion_failed` jos neperrašo.
- Tombstone retencija: viena formulė (žr. žemiau), ne „arba".
- `reason` allowlist: `user_request`, `retention_policy`, `operator_cleanup`.
- Lygiagretus `DELETE`: `deletion_pending` → HTTP **202**, `deleted` → HTTP **204**.
  Jokio papildomo I/O.
- Be `DATABASE_URL` `deletionTombstones` grįžta į atmintinį `Map` — bet žr.
  „Fallback ir garantijos apimtis" žemiau: tai keičia tai, ką galima teigti dokuose.
- ⚠️ **`revivalHorizonsMs()` NEEGZISTUOJA** — `queues/config.js` šiandien
  eksportuoja tik `QUEUE_NAMES`, `DEFAULT_JOB_OPTIONS`, `WORKER_OPTIONS` ir
  `createQueueConnection`. Ankstesnė redakcija teigė priešingai. Helperio
  sukūrimas įeina į 7.5a apimtį.

### Schema

- [ ] `erasure_marks` — persistentinis vienintelio autoriteto tombstone registras.
      Minimalus loginis kontraktas:
      `job_id` (PRIMARY KEY arba lygiavertė unikalumo garantija);
      `status` (uždara aibė `deletion_pending | deleted | deletion_failed`);
      `marked_at` (pirmojo inicijavimo laikas);
      `updated_at` (paskutinio perėjimo laikas);
      `reason` (allowlist: `user_request`, `retention_policy`, `operator_cleanup`).
- [ ] ⚠️ **`job_id` — stabilus identifikatorius, kurį vėliau naudos 7.4e.**
      Schema negali būti raktuojama laikinu procesu ar pseudonimu. Prieš rašant
      patikrinti, kad tai tas pats identifikatorius, kurį mato audito kelias.
- [ ] `status` invariantas enforce'inamas DB lygiu ir testuojamas tiesioginiu SQL.
- [ ] `marked_at` po sukūrimo nekeičiamas; progresas atnaujina tik `status`,
      `updated_at` ir leidžiamus diagnostinius laukus.
- [ ] ⚠️ **FK į `jobs` NĖRA.** `CASCADE` ištrintų tombstone tuo momentu, kai jis
      tampa reikalingas. Testas: `jobs` eilutės ištrynimas **neturi** pašalinti
      žymos.
- [ ] ⚠️ **`reason` yra allowlist, ne laisvas laukas.** Ta pati klasė kaip 7.4b
      `meta`: tikrinama RAŠANT, nežinoma reikšmė atmetama. Į `erasure_marks`
      nepatenka transkripcija, promptai, audio turinys ar neapdorotos exception
      žinutės. RAW testas su sentinel tekstu.
- [ ] Nauja migracija; jau pritaikytos neredaguojamos.
- [ ] Indeksai tik ten, kur yra realus prieigos kelias.

### Būsenų kontraktas

Leidžiami perėjimai:

- nėra žymos → `deletion_pending`
- `deletion_pending` → `deleted`
- `deletion_pending` → `deletion_failed`
- `deletion_failed` → `deletion_pending` **tik eksplicitiniam retry**
- `deleted` — terminali

- [ ] ⚠️ **`deleted` NEGALI būti perrašyta į `deletion_failed`.** Tai pagrindinė
      daugiaprocesio lenktynių garantija: vėliau užsibaigęs nesėkmingas bandymas
      negali panaikinti jau patvirtinto ištrynimo.
- [ ] Perėjimai vykdomi **sąlyginiais DB `UPDATE`** pagal esamą būseną, ne
      „read → decide JS → unconditional update".
- [ ] RAW SQL testas atmeta nežinomą būseną.
- [ ] `deletion_failed → deletion_pending` leidžiamas tik eksplicitiniam retry,
      ne atsitiktiniam lygiagrečiam kvietėjui.

### Barjero semantika

- [ ] `pending`, `failed`, `deleted` → job užbarjerintas naujiems jautriems
      artefaktams. **Tik žymos nebuvimas reiškia „nėra barjero".**
- [ ] ⚠️ **`deletion_failed` IŠLAIKO barjerą.** Nesėkmingas ištrynimas reiškia,
      kad jautrūs duomenys dar gali egzistuoti; operacija taisoma arba
      kartojama, o ne leidžiama kurti naujus.
- [ ] ⚠️ **UŽSTRIGUSIOS ŽYMOS TURI TURĖTI IŠEITĮ.** Barjeras nuo `pending` plius
      neterminalių žymų nesenėjimas reiškia, kad nuolat nepavykstantis ištrynimas
      užrakina job'ą neribotam laikui. Reikia: (a) operatoriaus kelio žymai
      išspręsti (retry arba dokumentuotas force-resolve su pėdsaku), ir (b)
      matomumo — būdo išvardyti neterminales žymas ir jų amžių. Be to tai ta
      pati fail-closed be išeities spraga, kurią 7.4c turėjo taisyti atskirai.

### Async cutover — P0

- [ ] ⚠️ **`isDeleted()` TAMPA ASYNC, IR TAI LŪŽTA TYLIAI.** DB užklausa
      asinchroninė, o `if (tombstones.isDeleted(jobId))` su Promise visada duoda
      `true` — Promise yra truthy. Pasekmė: **visi job'ai blokuojami ir
      atkūrimas neveikia**, o esami testai praeina.
- [ ] Migruoti VISUS kvietėjus su `await`: `workers/index.js:94`,
      `queues/jobRunner.js:256`, `utils/jobStore/index.js:373`, `:529`, `:768`,
      `:838` (`restoreRecord`), `services/restoreService.js`.
      Sąrašas patvirtinamas paieška, ne kopijuojamas iš čia.
- [ ] `isConfirmedDeleted()` ir kiti sinchroniniai skaitymo keliai — taip pat.
- [ ] ⚠️ **STATINIS ZONDAS TIKRINA `await`, NE PAMINĖJIMĄ.**
      `deletionEnforcement.test.js` šiandien ieško eilutės
      `tombstones.isDeleted(jobId)`; pamiršus `await`, testas praeitų, o kodas
      lūžtų. Patikra keičiama į `/await\s+tombstones\.isDeleted\(/`.
- [ ] ⚠️ **Elgsenos testas priešinga kryptimi:** kai žymos NĖRA, job'as
      NEPRALEIDŽIAMAS. Be jo „viskas blokuojama" praeitų kaip sėkmė.

### Fallback ir garantijos apimtis

- [ ] Be `DATABASE_URL` (atminties/Redis režimas) `deletionTombstones`
      automatiškai naudoja atmintinį `Map`; procesas nelūžta.
- [ ] ⚠️ **FALLBACK REIŠKIA, KAD GARANTIJOS NĖRA.** Atmintiniame režime žymos
      neišgyvena restarto ir nėra bendros replikoms — t.y. tiksliai tas
      apribojimas, kurį 7.5a šalina. Todėl `docs/deletion-guarantees.md`
      2 skyriaus apribojimas šalinamas **sąlyginai**: garantija galioja
      diegimams su `DATABASE_URL`, ir tai užrašoma eksplicitiškai.
      Besąlygiškas pašalinimas būtų melagingas teiginys atminties režimui.
- [ ] Startas atmintiniame režime garsiai įspėja, kad ištrynimo garantija
      neveikia — kaip ir esamas retencijos įspėjimas.
- [ ] Testas abiem režimams: su `DATABASE_URL` žyma išgyvena restartą, be jo —
      ne, ir tai yra dokumentuotas elgesys, ne gedimas.

### Distributed single-flight

- [ ] Vienam `job_id` vienu metu tik vienas procesas yra autoritetingas aktyvaus
      ištrynimo vykdytojas.
- [ ] ⚠️ **Procesui lokalus `Map`, mutex ar `inFlight` NEPAKANKA.** Sprendimas
      veikia tarp atskirų Node procesų, replikų ir DB pool'ų.
- [ ] Leidžiamas row-lock arba advisory-lock modelis, bet **scope per konkretų
      `job_id`**, ne globalus.
- [ ] ⚠️ **Lock negali būti laikomas per nekontroliuojamą išorinį I/O** (failai,
      S3, Redis), jei tai duotų ilgą DB transakciją. Prieš implementuojant
      pateikiamas konkretus koordinavimo modelis: kada lock įgyjamas, kada
      atleidžiamas.
- [ ] ⚠️ **Lock saugo PERĖJIMĄ, žyma saugo DARBO EIGĄ.** Atleidus lock'ą prieš
      baigiantis išoriniam I/O, antram kvietėjui koordinaciją užtikrina
      `deletion_pending` būsena, ne lock'as. Tai užrašoma eksplicitiškai.
- [ ] Antras lygiagretus `DELETE` gauna deterministinį rezultatą pagal
      autoritetingą būseną: `deletion_pending` → **202**, `deleted` → **204**;
      jokio papildomo I/O nepradedama.
- [ ] ⚠️ **LOCK ATLEIDIMAS ĮRODOMAS, NE DEKLARUOJAMAS.** Realizacija, laikanti
      lock'ą per visą ištrynimą vienoje ilgoje transakcijoje, praeitų paprastą
      lenktynių testą, bet produkcijoje išsemtų pool'ą. Testas su dirbtinai
      uždelstu išoriniu I/O įrodo, kad kitos DB operacijos ir nekonfliktuojantys
      ištrynimai tuo metu vykdomi.

### Sąsaja su 7.4e

- [ ] 7.5a pateikia **vieną autoritetingą deletion-state reader / service
      boundary**. 7.4e neturi skaityti `erasure_marks` ad-hoc SQL skirtingose
      vietose.
- [ ] Turi būti įmanoma **atominiu DB keliu** nustatyti, ar `job_id`
      užbarjerintas naujiems subjektiniams įrašams. Tai 7.4e TOCTOU reikalavimo
      prielaida.
- [ ] Audito write barjeras šiame issue **NEĮGYVENDINAMAS**.

### Revival horizon

- [ ] ⚠️ **AUTORITETAS SUKURIAMAS ČIA.** Vienas helperis/registras, išvedantis
      visus konfigūruotus eilių prikėlimo horizontus iš faktinės queue
      konfigūracijos (`DEFAULT_JOB_OPTIONS`, `WORKER_OPTIONS`,
      `removeOnComplete`/`removeOnFail`, `stalledInterval`, `lockDuration`,
      retry/backoff).
- [ ] Testai neturi rankiniu būdu nukopijuoto horizontų sąrašo — reikšmės
      išvedamos iš faktinės konfigūracijos.
- [ ] ⚠️ **VIENETAI NORMALIZUOJAMI PRIEŠ `Math.max`.** BullMQ `age` yra
      **sekundės**, `stalledInterval` — **milisekundės**. Testas įrodo konversiją.
- [ ] ⚠️ **Per-job `delay` negali apeiti garantijos.** Arba autoritetinga
      maksimali leistina `delay` riba, tikrinama enqueue vietoje, arba visi
      producer'iai privalo eiti per bendrą registruotą kelią. Ne dokumentuoti —
      testuoti. Šiandien nė vienas producer'is `delay` neperduoda, tad riba
      įvedama dabar, kol nekainuoja.

### Tombstone retencija

- [ ] `deletion_pending` ir `deletion_failed` **NESENSTA** automatiškai.
- [ ] `deleted` šalinama tik po
      `max(maxRevivalHorizon, backupRetentionHorizon) + safetyMargin`.
- [ ] Visi dydžiai normalizuojami į milisekundes prieš palyginimą.
- [ ] `safetyMargin` turi vieną autoritetingą vietą; testas jos nedubliuoja.
- [ ] ⚠️ **FAIL-SAFE:** jei kurios nors dedamosios negalima patikimai
      apskaičiuoti, rezultatas — **žymos NEŠALINTI**, ne pasirinkti mažesnį TTL.
- [ ] ⚠️ **Tombstone valymas įtraukiamas į ESAMĄ centralizuotą retention kelią**
      (`retentionSweeper`), ne į atskirą timer'į — ta pati taisyklė kaip 7.4d.

### Sąsaja su 7.6

- [ ] ⚠️ **ATKŪRIMAS NEGALI TRINTI AR TRUNCATE'INTI `erasure_marks`.**
      `restoreService.js:401-415` perrašo job'us po vieną; jei atkūrimas
      paliestų žymų lentelę, po kopijos sukurtos žymos dingtų, ir ištrinti
      job'ai grįžtų be tombstone. Testas: žyma sukurta PO kopijos → restore →
      žyma tebėra.
- [ ] ⚠️ **`erasure_marks` IŠ ATSARGINIŲ KOPIJŲ NEIŠBRAUKIAMAS** — priešingai
      nei `audit_log`. 7.6 DoD reikalauja, kad ištrynimo žurnalas išliktų už
      snapshot'o ribų ir būtų sujungtas po atkūrimo; jei žymos dingtų, atkūrus
      job'ai grįžtų be tombstone. Tai užrašoma eksplicitiškai, kad 7.4f/7.6
      backup politika jų atsitiktinai neišbrauktų kartu su auditu.

### Job ir result retencijos invariantai

- [ ] ⚠️ **RETENCIJA PRIKLAUSO NUO BŪSENOS.** `queued`, `processing` ir
      terminalūs su `*_pending` pagal amžių NEŠALINAMI — toks įrašas gali būti
      vienintelis `storageKey` šaltinis (`redisStore.js:175`).
- [ ] `job_results` neturi nepriklausomo TTL, leidžiančio rezultatui išnykti
      anksčiau nei parent job.
- [ ] Testas tikrina stebimą kontraktą: kol `completed` job pasiekiamas, jo
      rezultatas irgi pasiekiamas.
- [ ] Parent job'ui išnykus teisėtu keliu, rezultatas nelieka orphan'u.

### Crash, restart, lenktynės

- [ ] Žyma išgyvena restartą; neišspręsta `pending`/`failed` būsena taip pat.
- [ ] Po restarto vėluojanti eilės žinutė mato barjerą **PRIEŠ** materializuodama
      naujus jautrius artefaktus — end-to-end testas.
- [ ] Po `jobs` eilutės ištrynimo žyma fiziškai lieka RAW `erasure_marks`.
- [ ] Deterministinis, ne tikimybinis lenktynių testas su dviem nepriklausomomis
      jungtimis/procesais:
      **A** — dvi replikos pradeda ištrynimą, tik viena vykdo destruktyvų
      darbą, abi gauna suderinamą galutinį rezultatą;
      **B** — vienas bandymas pasiekia `deleted`, lėtesnis krenta po to,
      `deleted` išlieka;
      **C** — procesas miršta ties `pending`, po restarto barjeras aktyvus ir
      ištrynimą galima tęsti.

### Dokumentacija

- [ ] `docs/deletion-guarantees.md` 2 skyriaus apribojimas **pašalintas**, ne
      perrašytas švelnesniais žodžiais — ir tik tada, kai persistentė žyma,
      paskirstyta koordinacija ir restart E2E įrodyti.
- [ ] Neteigti multi-replica ar restart garantijų, kurioms nėra testų.

### Ko NEAPIMA

Audito write barjero (7.4e). Optimistic locking ir konfliktų politikos (7.5b).
7.6 atkūrimo. 7.4c/7.4d/7.4f darbų. Job store architektūros perprojektavimo,
sesijų ir authentication pakeitimų.

---

## [7.5b] Optimistic locking ir konfliktų politika

**Tėvinis:** #155 · **Priklauso nuo:** 7.2b

`jobs.version` ir konfliktų semantika. Atskirta nuo 7.5a: ta yra saugumo
klausimas, ši — saugyklos korektiškumo. Nuo 7.5a nepriklauso — problemos
ortogonalios.

Trys dalykai: **optimistic version CAS**, **vienas konflikto kontraktas**,
**atominis ir idempotentiškas `completed` + rezultato įsipareigojimas.**

### Užfiksuotas optimistic-lock kontraktas

- `jobs.version` pradinė reikšmė naujam job'ui — **`1`**. Viena reikšmė, vienodai
  visiems PostgreSQL job'ams.
- Kiekviena **sėkminga** autoritetinga `jobs` eilutės mutacija didina `version`
  lygiai `+1`.
- Mutacija, kuri dėl CAS konflikto neatnaujino nė vienos eilutės, `version`
  **nekeičia**.
- Vienos loginės operacijos viduje negali būti kelių nekontroliuojamų
  increment'ų vien todėl, kad ji palietė kelis SQL sakinius.
- `job_results` pakeitimas neturi atskiro optimistic-lock autoriteto; jo
  konsistencija su `jobs` užtikrinama per `finish()` transakciją.

⚠️ **Backend'ų apimtis apibrėžiama eksplicitiškai.** `version` stulpelis yra
PostgreSQL mechanizmas, bet **konflikto kontraktas yra fasado lygmens** ir
galioja visiems backend'ams. Memory ir Redis tų pačių garantijų pasiekia savo
priemonėmis (vienas procesas, Lua CAS). Prieš rašant kodą įvardyti, ką bendras
paritetų rinkinys tikrina visiems, o kas lieka PostgreSQL-specifiška — kitaip
rinkinys arba lūžta, arba tyliai susiaurėja.

### Vienas konflikto rezultato kontraktas

Optimistic-lock konfliktas turi būti aiškiai atskirtas nuo keturių kitų dalykų:

1. job nerastas;
2. owner/authorization neatitiko;
3. lifecycle perėjimas neleistinas;
4. DB/infrastruktūros klaida.

⚠️ **Negalima vienuose metoduose grąžinti `null`, kituose `false`, o trečiuose
mesti generinę klaidą tam pačiam konfliktui.** Vienas autoritetingas
rezultatas / typed error / statuso objektas pagal esamą `jobStore` fasado
kontraktą.

Kvietėjų politika dokumentuota eksplicitiškai:

- progresas, pralaimėjęs versijos CAS → perskaityti naują būseną ir spręsti, ar
  retry dar prasmingas;
- statuso perėjimo konfliktas → **NEretry'inti aklai**;
- idempotentiškas `finish(COMPLETED)` → lyginti galutinę būseną ir rezultatą;
- skirtingas jau įsipareigojęs galutinis rezultatas → consistency error.

### `version` + fazių/statuso CAS

#154 fazių CAS ir `version` **nėra du atskiri round-trip'ai**. Kai operacijai
aktualūs abu invariantai, jie tikrinami VIENAME `UPDATE`:

```
WHERE id = ? AND version = ? AND <status/phase invariant>
```

⚠️ **Nulis eilučių nėra automatiškai „version conflict".** Implementacija privalo
perskaityti autoritetingą būseną ir atskirti: eilutė dingo · version konfliktas ·
status/phase konfliktas. Testas įrodo visus tris atskirai.

### `finish(COMPLETED, { result })` autoritetas

`COMPLETED` reiškia tik tokią būseną, kurioje:

- `jobs.status = 'completed'`;
- egzistuoja atitinkamas `job_results` rezultatas;
- **abu commit'inti vienoje DB transakcijoje.**

Negalima padaryti `jobs=completed`, o `job_results` įrašyti kitu commit'u. Jei
rezultato rašymas nepavyksta — visa `finish` transakcija rollback.

⚠️ **Transakcijos ribos apibrėžiamos.** `finish()` transakcija apima `jobs` ir
`job_results` ir **nieko daugiau**. Audito rašymas, eilės patvirtinimas ir audio
valymas lieka už jos — audito įtraukimas į transakciją reikštų, kad rollback
ištrina audito įrašą, o jo laikymas viduje siektų už 7.5b apimties ribų.

`finish(FAILED, ...)` kelias irgi apibrėžiamas: ar jis rašo į `job_results`, ar
ne. Neapibrėžtas jis taptų antra, netyčine semantika.

### Idempotentiškas užbaigimas

⚠️ **`completed` BE REZULTATO NĖRA SĖKMĖ.**

`workers/index.js:192` įrašo `COMPLETED`, `:198` valo audio, `:207` grąžina
rezultatą. Kritus tarp jų PostgreSQL sako `completed`, BullMQ patvirtinimo negavo
ir kartoja, o `restart()` terminalų įrašą atmeta. Blogiau: rezultatai gyvena
atskiroje `job_results` lentelėje — jei statusas įsipareigojo, o rezultato
įrašymas nepavyko, „tęsti valymą, tada sėkmė" ištrintų šaltinio audio ir
patvirtintų sėkmę, kai klientas transkripcijos neturi. **Negrįžtamai.**

Kai retry randa job'ą jau `completed`:

- rezultatas semantiškai **sutampa** su tuo, kurį retry bando įrašyti →
  idempotentiška sėkmė;
- rezultatas **skiriasi** → consistency conflict, esamas rezultatas
  **NEPERRAŠOMAS**;
- statusas `completed`, bet **rezultato nėra** → korumpuota arba remontuotina
  būsena, NE sėkmė.

⚠️ **„Tas pats rezultatas" lyginamas pagal kanoninę persistentinę
reprezentaciją**, ne pagal JS objekto nuorodą ar nestabilų JSON raktų eiliškumą.
Jei repo turi vieną rezultatų normalizavimo ar hidratavimo autoritetą — naudoti
jį. Antros lygybės taisyklės vien 7.5b poreikiams nekurti; jei autoriteto nėra,
sukurti vieną ir įvardyti kaip tokį.

Praktinė pastaba: rezultatas gali būti kelių valandų transkripcija. Palyginimo
kaina apgalvojama (pvz. kanoninės formos hash), bet lyginimo **teisingumas**
nedera į kompromisą — hash kolizijos atveju elgesys apibrėžiamas.

### Stalled / lygiagretus užbaigimas

⚠️ **SĄLYGINIS UŽBAIGIMAS, ne vien transakcija.** Stalled recovery metu du
persidengiantys vykdymai perskaito tą patį `processing` snapshot'ą, ir abi
transakcijos gali įsipareigoti — vėlesnis rezultatas tyliai perrašo pirmąjį.

Reikia `UPDATE ... WHERE status = 'processing' RETURNING`. Nulis eilučių →
rezultatas **LYGINAMAS**, ne perrašomas.

Lenktynių eiga:

1. abu vykdytojai pradeda nuo to paties `processing` snapshot'o;
2. tik vienas autoritetingai commit'ina `processing → completed`;
3. antras po sąlyginio `UPDATE` su 0 eilučių perskaito įsipareigotą būseną;
4. tas pats rezultatas → idempotentiška sėkmė;
5. skirtingas rezultatas → consistency conflict;
6. **jokiomis aplinkybėmis antras vykdytojas neperrašo pirmojo `job_results`.**

Lenktynių testas **deterministinis**, ne paremtas `sleep()` tikimybe.

### Audio valymo barjeras

Audio šalinimas leidžiamas tik autoritetingai patvirtinus **`completed` +
persistentinis rezultatas**. Vien `jobs.status='completed'` nepakanka.

Aptikus `completed` be rezultato: audio **NEŠALINAMAS**, būsena laikoma
remontuotina pagal esamą recovery politiką, ir testas įrodo, kad šaltinio audio
išlieka.

### DoD

**Version ir konfliktai**

- [ ] Naujo PostgreSQL job'o `version` pradinė reikšmė (`1`) užfiksuota ir
      testuojama.
- [ ] Kiekviena sėkminga `jobs` mutacija didina `version` lygiai `+1`;
      konfliktas ar no-op jos nekeičia.
- [ ] Progreso CAS ir phase/status CAS, kai abu reikalingi, vykdomi **viename**
      `UPDATE`, ne dviem mutacijomis.
- [ ] ⚠️ Nulis `UPDATE` eilučių nėra automatiškai „version conflict": testai
      atskiria not-found, version conflict ir lifecycle conflict.
- [ ] Konflikto rezultatas turi vieną bendrą kontraktą `jobStore` fasado
      lygmenyje; nė vienas metodas negrąžina jam savo formos.
- [ ] Kvietėjo politika dokumentuota: kada retry, kada klaida vartotojui.
- [ ] ⚠️ Backend'ų apimtis įvardyta: kas galioja visiems per bendrą paritetų
      rinkinį, kas lieka PostgreSQL-specifiška. Rinkinys nesusiaurinamas.

**Atominis užbaigimas**

- [ ] `finish(COMPLETED, { result })` atnaujina `jobs` IR `job_results`
      **vienoje transakcijoje**.
- [ ] Transakcija apima tik `jobs` ir `job_results`; auditas, eilės
      patvirtinimas ir audio valymas lieka už jos.
- [ ] `finish(FAILED, ...)` elgesys su `job_results` apibrėžtas ir testuotas.
- [ ] `job_results` persistinimui nepavykus, rollback'inama **visa** transakcija;
      pusinės `completed` būsenos nelieka — testas.

**Idempotentiškumas**

- [ ] Retry prieš jau `completed` su tuo pačiu kanoniniu rezultatu → sėkmė arba
      no-op; `version` ir rezultatas be reikalo neperrašomi.
- [ ] Retry prieš `completed` su **skirtingu** rezultatu → aiškus consistency
      conflict; esamas rezultatas nepakeistas.
- [ ] `completed` be `job_results` → nėra sėkmė; audio **neištrinamas**.
- [ ] Kanoninio palyginimo autoritetas įvardytas; antros lygybės taisyklės nėra.

**Lenktynės ir atsparumas**

- [ ] Deterministinis dviejų nepriklausomų DB jungčių completion lenktynių
      testas: tik vienas įsipareigoja rezultatą, kitas jo neperrašo.
- [ ] Testas: procesas nutraukiamas po sėkmingo `finish` commit'o, bet prieš
      BullMQ patvirtinimą → retry mato `completed` + rezultatą ir baigiasi
      idempotentiškai, neperdirbdamas.
- [ ] Testas: transakcijos gedimas tarp `jobs` ir `job_results` nepalieka
      pusinės `completed` būsenos.

### Ko NEAPIMA

- **Audito persistentinio rašymo ir async klaidų semantikos** — tai 7.4b/7.4e
  audito linijos atsakomybė. 7.5b audito call-site'ų nekeičia ir 7.4a įvykių
  klasifikacijos (blokuojantys / ne-blokuojantys) nesilpnina.
- Persistentinių erasure marks — 7.5a.
- Bendro retry schedulerio ar retention mechanizmo.
- Job store architektūros perprojektavimo, sesijų ir authentication pakeitimų.

⚠️ Ankstesnėje šio issue redakcijoje buvo punktas apie `auditLog.record()`
sinchroniškumą. Jis pašalintas sąmoningai: tas darbas atliktas 7.4a async
cutover metu. Jei kur nors matote seną redakciją — gyva versija laimi.

---

## [7.6] Health, readiness ir backup su restore

**Tėvinis:** #155 · **Tipas:** tracking · **Priklauso nuo:** 7.2a

Šis issue yra **sekimo gijos** viršus. Darbas suskaidytas į tris PR, nes jame
maišėsi trys skirtingos rizikos zonos: kopijos artefakto teisingumas, atkurtų
duomenų korektiškumas ir post-restore suderinimas.

| Sub-PR | Issue | Priklauso nuo |
|---|---|---|
| 7.6a — šifruota kopija + bazinis restore | #248 | 7.2a, 7.4f (#231) |
| 7.6b — post-restore aplikacinis suderinimas | #249 | 7.6a |
| 7.6c — erasure-safe restore + DR pratybos | #250 | 7.5a (#183), 7.6b |

7.6a ir 7.6b nepriklauso nuo 7.5a, tad gali eiti lygiagrečiai su ja. 7.6c laukia
ištrynimo žymų — kitaip tektų kurti antrą tombstone mechanizmą.

### DoD

- [ ] #248 uždarytas
- [ ] #249 uždarytas
- [ ] #250 uždarytas

Detalūs kriterijai gyvena sub-issue'uose, ne čia. README apribojimų lentelė ir
Roadmap `[x]` atnaujinami 7.6c, ne anksčiau.

---

## [7.6a] Šifruota Postgres kopija ir bazinis restore įrodymas

**Tėvinis:** #155 · **Priklauso nuo:** 7.2a, 7.4f

Pirmas iš trijų 7.6 gabalų. Apimtis tik viena: **ar galime patikimai pasidaryti kopiją
ir ją atkurti.** Jokių sesijų, ne-terminalių job'ų ar erasure replay.

---

## Patikrinta AS-IS (`7ce5356`)

Eilučių numeriai sensta — prieš darbą inventorizuok iš naujo. Ši lentelė galioja
įvardytam commit'ui.

| Faktas | Kur | Reikšmė šiam darbui |
|---|---|---|
| `_canonicalContents()` iš `contents` reikalauja tik netuščio `type` string'o ir neneigiamų sveikųjų `count`/`bytes` | `utils/backupEncryption.js:159-176` | **šifravimas tipų registro NEtikrina** |
| Politikos vartai yra manifeste | `utils/backupManifest.js:82` (`createManifest`), `:163` (`validateManifest`) | čia atmetamas tipas, kurio `isIncluded()` nepripažįsta |
| `isIncluded()` yra IŠVEDAMAS: `persistence === PERSISTENT` ir ne `EXCLUDED_DESPITE_PERSISTENT` | `utils/backupPolicy.js:120-126` | naujas persistentinis tipas **automatiškai** patenka ir į aplikacijos JSON kopiją |
| Kiekvienas registro tipas PRIVALO turėti skenavimo strategiją | `utils/artefactScanner.js:15`, gina `tests/lifecycleE2E.test.js:423` | `ARTEFACT_TYPES` yra **GDPR ištrynimo inventorius**, ne kopijų leidimų sąrašas |
| `audit_log` išbrauktas sąmoningai | `utils/backupPolicy.js:45+` (`EXCLUDED_DESPITE_PERSISTENT`) | nekeičiama |
| `MAX_CIPHERTEXT_BYTES = 2 GB`, envelope laukai — **base64 eilutės atmintyje** | `utils/backupEncryption.js:318,356` | žr. D6: praktinė riba gerokai žemesnė nei 2 GB |
| `testDatabaseUrl(suffix)` ir `adminDatabaseUrl()` JAU egzistuoja | `tests/helpers/postgresGuard.js:45,55` | naudojami `sessionStoreBackendContract.integration.test.js:460-465` ir `jobStoreBackendContract.integration.test.js:385` su `CREATE DATABASE` |
| `postgresReachability()` tikrina `pgmigrations` ir lygina su `backend/migrations/` katalogu | `utils/startupChecks.js:504,551-583` | migracijų atsilikimas JAU matomas per `make doctor` |
| `/api/ready` (`probeRuntimeReadiness()`) tikrina komponentų liveness zondus, migracijų atsilikimo — ne | `server.js` | žr. D5 |
| Runbook jau turi `pg_dump --exclude-table-data=audit_log` | `docs/backup-runbook.md:62-95` | procedūra yra, automatikos nėra |
| `backupDocumentation.test.js` turi ~10 sargų, tarp jų „KIEKVIENA žinoma riba įvardyta" | `tests/backupDocumentation.test.js:135` | naujas įspėjimas jungiamas prie ŠIO mechanizmo |
| `backupService`/`restoreService` dengia tik aplikacijos lygio JSON kopijas | `services/` | `pg_dump` kelio repo neturi visai |
| CI: serveris `postgres:16-alpine`, **`postgresql-client` niekur neinstaliuojamas** | `.github/workflows/ci.yml:51` | žr. D7 — be to visas DoD CI'uje neįvykdomas |

---

## Užrakinti sprendimai

### D1 — PostgreSQL dump artefakto kontraktas

7.6a turi apibrėžti, kaip dump'as reprezentuojamas esamame manifesto / šifravimo
formate. Esamos AES-256-GCM + AAD grandinės apeiti negalima vien todėl, kad payload yra
SQL, o ne aplikacijos JSON.

⚠️ **„Užregistruoti naują kanoninį tipą" NĖRA lokalus veiksmas.** `ARTEFACT_TYPES`
registras maitina ištrynimo inventorių, ne tik kopijų politiką, ir turi dvi
automatines pasekmes:

1. `isIncluded()` išvedamas iš `persistence` — naujas **persistentinis** tipas iškart
   tampa įtrauktas ir į aplikacijos JSON kopijos kelią (`includedTypes()`), kur jo
   semantika netinka;
2. `artefactScanner` reikalauja strategijos **kiekvienam** registro tipui, ir
   `lifecycleE2E.test.js:423` tai gina — naujas įrašas iškart sukuria pareigą atsakyti,
   kaip dump'as skenuojamas ir trinamas per GDPR ištrynimą.

Prieš implementaciją apsvarstyti **tris** variantus ir pasirinkimą užrašyti su
priežastimi:

- **(a)** naujas kanoninis tipas (pvz. `POSTGRES_DUMP`) su eksplicitiniu atsakymu į abi
  pasekmes aukščiau;
- **(b)** atskira manifesto **ašis** — artefakto *rūšis* (aplikacijos kopija vs. DB
  dump'as) — kuri nepraplečia `ARTEFACT_TYPES` ir nepaliečia ištrynimo inventoriaus;
- **(c)** kitas variantas, jei kodas pasiūlo geresnį.

Ko **negalima**: laisvinti `backupEncryption.js` kriptografinės semantikos ar v2 AAD
formato vien dėl šio PR. Fail-closed manifesto/šifravimo kontraktas lieka fail-closed.

Naujas dump tipas negali tapti leidimu produkcinės aplikacijos kopijos turiniui ten,
kur jo semantika netinka.

### D2 — vienas vykdomas backup/restore kelias

Turi egzistuoti **vienas** programinis/operatoriaus kelias, kurį naudoja ir integracinis
testas, ir dokumentuota procedūra. Jis atsakingas už:

- `pg_dump` iškvietimą;
- dump artefakto manifesto/metaduomenų sukūrimą;
- AES-256-GCM šifravimą per `utils/backupEncryption.js`;
- prieš restore atliekamą manifesto, checksum ir GCM autentifikacijos patikrą;
- dešifruoto dump'o perdavimą PostgreSQL restore įrankiui;
- aiškius exit kodus ir klaidas.

⚠️ Testas **NETURI** atkurti šios orkestracijos savo atskira imitacija. Konkretūs failų
vardai (`backup-db.js` / `restore-db.js`) **nefiksuojami** — fiksuojamas elgesys ir tai,
kad kelias vienas.

### D3 — izoliuota tikslinė DB

⚠️ **Helperis JAU yra — antro provisioning framework'o nekurti.**
`tests/helpers/postgresGuard.js` teikia `testDatabaseUrl(suffix)` ir
`adminDatabaseUrl()`, o modelis (`CREATE DATABASE` per admin URL + `resourceStack`
teardown) jau naudojamas dviejuose kontraktų testuose. Restore testas eina tuo pačiu
keliu.

### D4 — restore atomiškumas

Kriptografinės ir manifesto klaidos sustabdo procesą **PRIEŠ pirmą SQL mutaciją**.

Jei autentifikuotas dump'as jau pradėtas vykdyti, SQL ar ryšio klaida negali palikti
„sėkmingai užbaigto" dalinio restore. Restore vykdomas režimu, kuris pagal pasirinktą
`pg_dump` formatą duoda maksimaliai atominę fail-closed semantiką (pvz.
single-transaction, jei formatas ir įrankis ją palaiko).

⚠️ Konkreti vėliavėlė (`psql -1` ar kita) **nefiksuojama** — formatas (plain, custom)
dar pasirenkamas. Fiksuojama garantija.

Pastaba: „hard fail PRIEŠ restore" (sugadintas ciphertext, blogas raktas) ir „SQL klaida
jau pradėjus" yra **du skirtingi** reikalavimai; abu privalo turėti testą.

### D5 — readiness / doctor riba

7.6a **neperimplementuoja** 7.4f readiness darbo.

`make doctor` per `startupChecks.postgresReachability()` jau lygina `pgmigrations` su
`backend/migrations/` katalogu, t. y. migracijų atsilikimo signalas **egzistuoja**.
Todėl 7.6a numatytai tik **dokumentuoja jį kaip privalomą post-restore verifikacijos
žingsnį**.

`/api/ready` migracijų atsilikimo patikra šiame PR daroma **TIK** jei be jos negalima
tenkinti jau egzistuojančio 7.6 kontrakto; kitu atveju — atskiras follow-up. Sprendimą
užrašyti, nesvarbu kuris.

### D6 — dydžio riba yra tikra, ir ji žemesnė nei 2 GB

`MAX_CIPHERTEXT_BYTES` yra 2 GB, bet envelope laukai (`iv`, `authTag`, `ciphertext`) yra
**base64 eilutės atmintyje**, o V8 eilutės ilgis ribotas. Praktinė lubos ateina
gerokai anksčiau nei nominalios 2 GB, ir produkcinis dump'as su transkripcijomis prie
jų gali priartėti.

7.6a **neįveda** srautinio šifravimo. Bet riba privalo būti:

- išmatuota arba argumentuotai įvardyta;
- užrašyta runbook'e kaip žinoma riba (kitaip dokumentas teigia daugiau, nei kodas
  gali — §12.1);
- padengta testu ties klaidos keliu (per didelis artefaktas duoda aiškią klaidą, ne
  neaiškų V8 kritimą).

### D7 — `pg_dump` prieinamumas CI'uje

⚠️ Šiandien workflow **neįdiegia jokio** PostgreSQL kliento, o serveris yra
`postgres:16-alpine`. Runner'io numatytasis klientas yra senesnis, o `pg_dump` prieš
naujesnį serverį atsisako dirbti. Be šito visas DoD CI'uje neįvykdomas — ir kris ne dėl
logikos.

- workflow įdiegia suderinamą klientą (`postgresql-client-16` ar lygiavertį), **versija
  pririšama**, ne paliekama runner'io numatytajai, kuri keičiasi be įspėjimo;
- testas turi **atskirą praleidimo ašį** „nėra `pg_dump` binaro", ir ji, kaip
  `skipWithoutPostgres()`, po `REQUIRE_POSTGRES=1` virsta klaida. Tyliai praleistas
  failas apeitų `verify-postgres-suite-ran.mjs` prasmę.

---

## DoD

### Kopija ir šifravimas

- [ ] `pg_dump` procedūra `docs/backup-runbook.md`.
- [ ] Artefaktas šifruojamas per `utils/backupEncryption.js` (AES-256-GCM). Paprastas
      `pg_dump` be šifravimo kriterijaus NETENKINA — `job_results` turi transkripcijas.
- [ ] D1 sprendimas priimtas ir užrašytas; jei pasirinktas naujas kanoninis tipas —
      atsakyta į abi automatines pasekmes (`isIncluded()` išvedimas, `artefactScanner`
      strategijos pareiga), ir `lifecycleE2E.test.js:423` lieka žalias **dėl
      sprendimo**, ne dėl atsitiktinumo.
- [ ] `backupEncryption.js` kriptografinė semantika ir v2 AAD formatas nepakeisti.
- [ ] D6: dydžio riba įvardyta, užrašyta runbook'e ir padengta klaidos keliu.

### Vienas kelias

- [ ] Egzistuoja vienas programinis backup/restore kelias (D2); integracinis testas ir
      dokumentuota procedūra naudoja **jį**, ne dvi realizacijas.
- [ ] Testas neatkuria orkestracijos savo imitacija.
- [ ] Aiškūs exit kodai / klaidos.

### Restore įrodymas

- [ ] Restore į naują **TUŠČIĄ** DB; `schema_version` patikra.
- [ ] ⚠️ Testas naudoja atskirą, unikaliai pavadintą laikiną DB per esamą
      `testDatabaseUrl()` / `adminDatabaseUrl()` ir **niekada** nedaro DROP/restore ant
      bendros `DATABASE_URL` bazės.
- [ ] Testas išvalo **tik SAVO** sukurtą DB; lygiagretus kitų PostgreSQL integracinių
      testų vykdymas nepaveikiamas.
- [ ] ⚠️ Palyginimas **nėra vien `COUNT(*)`**: tikrinami konkretūs `jobs.id`, statusai
      ir jų ryšys su `job_results`, įskaitant reprezentatyvų transcript/protocol
      payload. Procedūra, neatkurianti `job_results`, praeitų `COUNT` patikrą, nors
      kiekvienas baigtas job'as būtų praradęs vartotojui matomą rezultatą.
- [ ] ⚠️ Kopijos šaltinio nuoseklumas: procedūra dokumentuoja ir testas remiasi
      PostgreSQL consistent snapshot semantika — `jobs` ir susiję `job_results` negali
      būti paimti iš skirtingų loginių momentų vien dėl skaitymo sekos.

### Fail-closed

- [ ] Sugadintas ciphertext arba blogas raktas → **hard fail PRIEŠ restore**, ne dalinis
      atkūrimas. Testas abiem atvejais.
- [ ] ⚠️ Neužtenka „grąžina klaidą": prieš ir po bandymo tikslinė **tuščia DB lieka
      semantiškai nepaliesta** (jokių lentelių, jokių įrašų).
- [ ] D4: tyčia sugadintas jau **validžiai dešifruotas** restore payload nepaverčiamas
      sėkmingu restore; dalinės būsenos nelieka.
- [ ] Pasirinktas restore režimas ir jo atomiškumo garantija užrašyti.

### Auditas

- [ ] `audit_log` NEatkuriamas (`utils/backupPolicy.js` tai jau daro sąmoningai).
- [ ] ⚠️ Testas naudoja **unikalų sentinel'į**: prieš kopiją įrašoma unikaliai
      atpažįstama audito eilutė, po restore jos NĖRA. „Nesutampa su dump'u" nepakanka —
      atkūrimas įrašo naujų įvykių, tad nesutapimas atsiranda savaime.

### Dokumentacija ir readiness

- [ ] ⚠️ **RUNBOOK ĮSPĖJA, KAD PROCEDŪRA DAR NE ERASURE-SAFE.** Po šio PR restore veiks,
      bet prikeltų po kopijos ištrintus job'us — tombstone'ai (7.5a) ir replay (7.6c)
      dar neuždaryti. Be įspėjimo dokumentas taptų stipresnis už kodą (§12.1).
- [ ] Testas gina šį įspėjimą, **prijungtas prie esamo** `backupDocumentation.test.js`
      „KIEKVIENA žinoma riba įvardyta" mechanizmo, jei tas sąrašas išvedamas — ne
      vienuoliktas rankinis `assert`.
- [ ] D5 sprendimas užrašytas: `make doctor` signalas dokumentuotas kaip privalomas
      post-restore žingsnis; `/api/ready` keičiamas tik jei būtina.
- [ ] `/api/health` DB būsenos produkcijoje NErodo pagal nutylėjimą (`HEALTH_DETAILS`,
      kaip esami tiekėjų pavadinimai).

### CI

- [ ] D7: workflow įdiegia pririštos versijos PostgreSQL klientą; `pg_dump` CI'uje
      realiai vykdomas.
- [ ] Praleidimo ašis „nėra `pg_dump`" po `REQUIRE_POSTGRES=1` virsta klaida.
- [ ] Testas registruotas `postgres` rinkinyje (per `postgresGuard` importą), tad
      `verify-postgres-suite-ran.mjs` reikalauja neprapleisto `ok`.

---

## Ko NEAPIMA

Sesijų, ne-terminalių job'ų, ištrynimo žymų, erasure replay. Srautinio šifravimo.
Roadmap `[x]` NEdedamas — 7.6 uždaromas tik po 7.6c.

⚠️ Šis nuokrypis nuo bendro 7.6 aprašo `SUBISSUES-155.md` yra **sąmoningas ir
suplanuotas** (pirmas iš trijų). Testų ir kodo komentaruose tai įvardyti, kad nekiltų
painiavos su bendruoju 7.6 DoD.

---

## Pastabos vykdytojui

- **Įrodymo standartas:** AGENTS.md §14. „Testas praėjo" nėra restore korektiškumo
  įrodymas, jei palyginimas paviršinis.
- **Mutacijos:** §9.1. Kiekvienas fail-closed testas privalo kristi, kai atitinkama
  patikra pašalinama.
- **Testų izoliacija:** §9.3. Restore testas liečia DB — izoliacija čia nėra higiena, o
  korektiškumo sąlyga.
- **Dokumentacija:** §12.1. Runbook negali teigti daugiau, nei procedūra gali —
  ypač dėl erasure-safety ir dydžio ribos.
- **Apimties disciplina:** §13. `/api/ready` architektūra, srautinis šifravimas ir
  erasure replay yra už ribos; jei kuris pasirodys būtinas — sustok ir pasakyk.

---

## [7.6b] Post-restore aplikacinis suderinimas

**Tėvinis:** #155 · **Priklauso nuo:** 7.6a

Apimtis: **ką daryti su būsena, kurios DB snapshot vienas pats saugiai atkurti
negali.**

### DoD

- [ ] **Visos atkurtos sesijos masiškai revokuojamos.** Kitaip atkūrimas
      prikeltų atšauktas sesijas: klientas ar užpuolikas gali tebeturėti tą
      pačią cookie, o senas `token_hash` ją vėl padarytų galiojančia. Testas:
      sesija atšaukta PO kopijos → po restore ta cookie neautentifikuoja.
- [ ] `queued` / `processing` eilutės suderinamos. BullMQ būsena į kopiją
      NEPATENKA, tad atkurti nepakeisti jie liktų amžinai ne-terminalūs:
      `sweepExpired()` jų nešalina, o klientai apklausinėtų job'us, kurie
      niekada nepasileis.
- [ ] ⚠️ **ŠIAME PR — TIK TERMINALIZAVIMAS, JOKIO PRIKĖLIMO.** Prikelti job'ą
      galima tik žinant, kad jo duomenys neištrinti, o tombstone merge atsiranda
      7.6c. Prikėlimo kelias atidaromas ten, ne čia.
- [ ] Terminalinės būsenos (`completed` + `result`, `failed`) NEPAŽEIDŽIAMOS —
      testas, kad suderinimas jų neliečia.
- [ ] Cutover leidžiamas tik PO suderinimo; procedūra runbook'e nurodo eiliškumą.

### Ko NEAPIMA

BullMQ eilės rekonstrukcijos ir queue replay architektūros — eksplicitiškai
out of scope. Erasure replay — 7.6c. Roadmap `[x]` NEdedamas.

---

## [7.6c] Erasure-safe restore ir pilnos DR pratybos

**Tėvinis:** #155 · **Priklauso nuo:** 7.5a, 7.6b

Paskutinis 7.6 gabalas. Apimtis tik GDPR galutinumas ir pilnas end-to-end.

### DoD

- [ ] Naudojamos 7.5a persistentės ištrynimo žymos. **Antras tombstone
      mechanizmas NEKURIAMAS** — jei 7.5a neuždarytas, šis darbas laukia.
- [ ] Ištrynimo žurnalas saugomas UŽ snapshot'o ribų ir sujungiamas po atkūrimo.
- [ ] Po kopijos ištrintas job'as po restore NEATSIRANDA; jo `job_results` ir
      kiti priklausomi įrašai taip pat ne.
- [ ] ⚠️ **TOMBSTONE MERGE EINA PIRMAS, PRIEŠ SUDERINIMĄ.** Ištrintas job'as
      kopijoje gali gulėti kaip `queued`. Jei 7.6b suderinimas pamatys jį pirmas,
      jis arba terminalizuos, arba (vėliau) prikels darbą su jau ištrintais
      duomenimis. Teisinga seka: **tombstone merge → sesijos → job'ai.**
- [ ] Pilnas E2E: backup → encrypt → restore → tombstone merge → sesijų
      revokacija → job'ų suderinimas → verify. Gali būti atskiras integracinis
      workflow.
- [ ] 7.6a runbook įspėjimas („dar ne erasure-safe") PAŠALINAMAS kartu su testu,
      kuris jo reikalavo.
- [ ] README apribojimų lentelės eilutės atnaujintos; Roadmap `[x]`.
- [ ] #185 uždaromas.

### Ko NEAPIMA

Queue replay architektūros — ji ir toliau out of scope.
