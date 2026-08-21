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
- [ ] ⚠️ **PostgreSQL NEPARENKAMAS iki 7.2b.** Šis PR įgyvendina 12 ne-atominių
      metodų; nuosavybės mutacijos kviečia `updateOwned`/`removeOwned`
      tiesiogiai, o progresas be `reportProgressAtomic` grįžtų į silpnesnį
      ne-atominį kelią. Diegimas su `DATABASE_URL` po 7.2a arba mestų įprastose
      operacijose, arba prarastų CAS semantiką. Backend'o parinkimas įjungiamas
      7.2b, ne čia.
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
      bet **PARENKAMAS** tik kai baigtos trys prielaidos (žr. ADR „Aktyvavimo
      barjeras"): patikrintas restore, persistentės ištrynimo žymos ir
      transakcinis rezultatų įrašymas. Kitaip diegimas įjungtų negrįžtamą režimą
      be atsistatymo kelio.
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

#159 ir #154 CAS yra Redis-Lua specifiniai. PostgreSQL reikia **trečios
nepriklausomos** tų pačių invariantų realizacijos.

| Operacija | Redis | PostgreSQL |
|---|---|---|
| `updateOwned` / `removeOwned` | Lua CAS | `UPDATE ... WHERE owner_id IS NOT DISTINCT FROM $1 AND owner_kind = $2` |
| `reportProgressAtomic` | Lua CAS | `UPDATE ... WHERE phase = $1 AND ...` |

⚠️ **`IS NOT DISTINCT FROM`, NE `=`.** Desktop (`unowned`) ir bendro rakto
(`api-key`) job'ai turi `owner_id IS NULL`. Su `= $1`, kai `$1` irgi `NULL`,
sąlyga duoda `UNKNOWN`, ir `UPDATE` neatitinka nė vienos eilutės — operacijos
lūžtų KIEKVIENAM ne-vartotojo job'ui.

### DoD

⚠️ **RINKINYS EGZISTUOJA, BET NĖRA PARAMETRIZUOTAS.**

`tests/jobStoreBackendContract.integration.test.js` paleidžia **9 scenarijus**
prieš memory ir Redis, ir jis jau rado keturias divergencijas. Bet:

- backend'ai turi po **atskirą testą** (jų paruošimas skiriasi);
- scenarijai kviečia tik `reportProgressAtomic()` — `updateOwned()` ir
  `removeOwned()` **nedengiami**.

Tad vien adapterio pridėjimas trijų backend'ų atominio pariteto **neįrodytų**.
Užduotis apima tris dalykus:

- [ ] **Parametrizuoti** rinkinį: adapteris `{ paruošti, store }` vietoj
      kopijuoto testo.
- [ ] **Praplėsti scenarijus** `updateOwned` / `removeOwned` atvejais —
      nuosavybės CAS šiandien netikrinamas nė viename backend'e per šį rinkinį.
- [ ] `postgresStore` praeina VISUS scenarijus (9 esamus + naujus nuosavybės).
- [ ] Backend'ai deklaruoja tą pačią metodų aibę (**15**) — esamas testas.
- [ ] Atominis statuso perėjimas: neleistinas atmetamas DB lygmenyje.
- [ ] Concurrent update: du lygiagretūs rašymai → vienas laimi, kitas gauna
      konfliktą, duomenys nesugadinti.
- [ ] Progreso monotoniškumas išlaikomas lenktynių sąlygomis (deterministinis
      testas, ne tikimybinis — žr. #154 patirtį).
- [ ] Duplicate write → kontroliuojama klaida (tas pats `idempotency_key` toje
      pačioje nuomoje).
- [ ] Failed transaction → rollback, dalinio įrašo nelieka.
- [ ] DB laikinai nepasiekiama → retryable klaida, ne 500 su stack trace.
- [ ] 6 nuosavybės testai (#159) praeina su `postgresStore`.
- [ ] ⚠️ **`updateOwned` NEPERDUODA `ownerId`/`ownerKind` į `SET`.** Dabartiniai
      backend'ai tą garantiją gauna iš `applyPatch()`, o esami testai tikrina
      nekintamumą TIK ant to helperio. PostgreSQL realizacija, atvaizduojanti
      patch'o laukus tiesiai į `SET`, galėtų atominiai autorizuoti kaip
      savininkas A ir **perduoti eilutę savininkui B**. Nekintamumą privalo
      užtikrinti pati backend'o operacija; mutacijai atsparus scenarijus —
      trijų backend'ų rinkinyje.
- [ ] ⚠️ **`null` ir `FORBIDDEN` ATSKIRIAMI VIENU SAKINIU.** Fasado kontraktas
      skiria nesantį job'ą (`null` → 404) nuo svetimo (`FORBIDDEN` → 403), o
      `UPDATE ... WHERE owner_id IS NOT DISTINCT FROM $1` pasako tik tiek, ar
      eilutė pakeista. Papildoma egzistavimo užklausa po nulio eilučių įveda
      TOCTOU lenktynes su lygiagrečiu ištrynimu ar atkūrimu. Sprendimas —
      `UPDATE ... RETURNING` kartu su egzistavimo patikra viename sakinyje arba
      užrakintoje transakcijoje. Testas: abu rezultatai lygiagretumo sąlygomis.
- [ ] ⚠️ **DB-ONLY DIEGIMAS REIKALAUJA EILĖS.** BullMQ naudojamas tik kai yra
      `REDIS_URL`; kitaip darbas vykdomas inline. Diegimas su vienu
      `DATABASE_URL` sustojus procesui paliktų `processing` eilutę, kurios
      niekas nebeperims — job'as užstrigtų, nors diagnostika rodytų
      „persistentinė saugykla". Arba reikalauti Redis eilės šiam režimui, arba
      apibrėžti startinį atkūrimą, saugiai perleidžiantį ne-terminalius job'us.

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
