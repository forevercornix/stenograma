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

⚠️ **PRIELAIDA — 7.2a FOLLOW-UP PR PRIVALO BŪTI SUMERGINTAS PIRMA.**

Šis aprašymas remiasi dviem dalykais, kurių `main` šakoje DAR NĖRA:

- `IMMUTABLE_COLUMNS` konstanta (`postgresStore.js`) su `schema_version`;
- `applyPatch()` apsauga `tenantId`, `idempotencyKey` ir `created_at` laukams
  (`common.js`) — be jos memory ir Redis leidžia juos keisti, o PostgreSQL ne.

Abu įvedami 7.2a follow-up PR'e. **Pirmas 7.2b žingsnis — jį sumerginti**, o ne
kurti tas apsaugas iš naujo. Pre-review, paleistas prieš `main`, šias
prielaidas pagrįstai pažymės kaip neįvykdytas.

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
- esamą progreso epochą (`current` / `total`).

⚠️ **BE „KAI JI AKTUALI" IŠLYGOS.** Ankstesnė formuluotė buvo dviprasmiška ir
paliko realizacijai spręsti, kada progreso lauką tikrinti. CAS `WHERE` sąlyga
privalo VISADA lyginti `progress_known`, `progress_current` ir `progress_total`
su perskaityta būsena, naudodama NULL-safe `IS NOT DISTINCT FROM`.

Priežastis: `progress_current` ir `progress_total` yra `NULL` kiekvienai
`progressKnown = false` eilutei, o `= NULL` duoda `UNKNOWN` — sąlyginis
`UPDATE` neatitiktų NĖ VIENOS eilutės, ir pirmasis progreso pranešimas visada
grįžtų `"REJECTED"`.

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
> pakeitimui neįvykus. Reikalavimas — kad **visi** `SCENARIJAI` elementai būtų
> vykdomi prieš visus tris backend'us, o ne kad jų būtų N.

Refaktorizuoti į adapterio modelį, pvz.:

```js
{ name, setup, store, prepareState, cleanup }
```

arba semantiškai lygiavertę struktūrą.

Tas pats scenarijų rinkinys turi būti vykdomas prieš:

1. memory;
2. Redis;
3. PostgreSQL.

⚠️ **ADAPTERIAI PRIVALO PO SAVĘS SUTVARKYTI.** Trys backend'ai viename faile
reiškia tris išorinių resursų rinkinius. Neuždaryta `pg` pool jungtis ar
`ioredis` klientas laiko event loop'ą gyvą, ir `node --test` procesas
nebesibaigia — testas ne krinta, o KABO, o CI tai parodo kaip timeout'ą be
naudingos žinutės.

- [ ] Kiekvienas adapteris turi `cleanup`, kuris uždaro savo jungtis.
- [ ] Vieno backend'o būsena neteka į kitą (kiekvienas scenarijus pradedamas
      nuo švarios būsenos).
- [ ] Rinkinys užsibaigia be `--force-exit` ar analogiškų priemonių.

Pašalinti / atnaujinti dabartinį pasenusį testo komentarą, kuriame nurodoma
PostgreSQL pridėti kaip trečią atskirą testą ir nekeisti `SCENARIJAI`.

### 8. ⚠️ RINKINYS PRIVALO REALIAI PALEISTI VISUS TRIS CI'E

Šiandien `jobStoreBackendContract.integration` yra **tik `redis` rinkinyje**
(`tests/suites.js:35`), o CI turi DU atskirus žingsnius:

| Žingsnis | Env | Kas vykdoma |
|---|---|---|
| `npm run test:redis` | `REDIS_URL`, `REQUIRE_REDIS=1` | `redis` rinkinys |
| `npm run test:postgres` | `DATABASE_URL`, `REQUIRE_POSTGRES=1` | `postgres` rinkinys |

Failas, likęs tik `redis` rinkinyje, PostgreSQL žingsnyje NEBUS paleistas, o
`redis` žingsnyje `DATABASE_URL` nėra — tad PostgreSQL adapteris **pats save
praleis**.

Rezultatas: visi 7 punkto kriterijai būtų formaliai įvykdyti, o CI realiai
tikrintų DU backend'us iš trijų. Tyliai — tas pats šablonas, kurį #155 jau du
kartus pagavo (`migrations.integration` prefiksas, matricos įrašai).

- [ ] Rinkinys registruotas taip, kad KIEKVIENAS backend'as būtų vykdomas
      žingsnyje, kuriame yra jo priklausomybė: arba failas įtraukiamas į abu
      rinkinius, arba suskaidomas pagal backend'ą.
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
      kad įvykdyti VISI PostgreSQL scenarijai: įvykdytų skaičius lyginamas su
      `SCENARIJAI.length`.
- [ ] PostgreSQL adapterio `skip` arba nulis įvykdytų scenarijų su nustatytu
      `DATABASE_URL` yra testo NESĖKMĖ, ne tyli praleistis.

⚠️ Skaičius čia lyginamas su `SCENARIJAI.length` DINAMIŠKAI, ne su konstanta —
kitaip kriterijus pasentų pridėjus scenarijų (žr. 7 punktą).

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
- [ ] VISI esami `SCENARIJAI` vykdomi prieš memory, Redis ir PostgreSQL
      (skaičius nefiksuojamas — žr. 7 punktą).
- [ ] Bendras rinkinys papildytas `updateOwned()` scenarijais.
- [ ] Bendras rinkinys papildytas `removeOwned()` scenarijais.
- [ ] Bendras rinkinys papildytas `getOwned()` scenarijais.
- [ ] Visi trys backend'ai deklaruoja tą pačią 15 metodų aibę.
- [ ] Pasenęs `jobStoreBackendContract.integration.test.js` komentaras
      atnaujintas pagal trijų backend'ų parametrizuotą architektūrą.
      ⚠️ Dabartinis tekstas nurodo PostgreSQL pridėti kaip TREČIĄ ATSKIRĄ
      testą ir `SCENARIJAI` NEKEISTI — tai tiesiogiai prieštarauja šiam
      sub-issue, tad palikus jį Codex gautų du priešingus nurodymus.

**CI ir matrica**

- [ ] Rinkinys realiai vykdomas IR `test:redis`, IR `test:postgres`
      žingsniuose (žr. 8 punktą).
- [ ] `npm run test:postgres` išvestyje matomi PostgreSQL adapterio
      scenarijai, ne `skip`.
- [ ] ⚠️ `jobStoreBackendContract.integration` REGISTRUOTAS `postgres`
      rinkinyje (`tests/suites.js`). Šiandien jis tik `redis` rinkinyje, tad
      vien adapterio pridėjimas testo faile PostgreSQL CI žingsnyje jo
      nepaleistų.
- [ ] ⚠️ FAIL-CLOSED vykdymo įrodymas: su nustatytu `DATABASE_URL` įvykdytų
      PostgreSQL scenarijų skaičius lyginamas su `SCENARIJAI.length`; `skip`
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
