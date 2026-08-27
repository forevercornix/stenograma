# Audito saugykla

Šis dokumentas fiksuoja sprendimus, priimtus įgyvendinant #155 / [7.4b] (#211) —
persistentinį audito žurnalą PostgreSQL pagrindu.

Jis aprašo **tai, kas įgyvendinta**. Kur riba sąmoningai palikta vėlesniam
etapui, tai pasakyta eksplicitiškai kartu su etapo numeriu.

---

## 1. Backend'o parinkimas

`AUDIT_BACKEND` = `memory` (numatytai) arba `postgres`.

Tai **trečias nepriklausomas jungiklis** greta `JOB_STORE_BACKEND` ir
`SESSION_STORE_BACKEND`. Vien `DATABASE_URL` audito režimo nekeičia: jis gali
būti įvestas migracijoms ar sesijoms, ir diegimas, pridėjęs jį visai kitam
tikslui, neturi netikėtai pradėti persistinti audito.

`AUDIT_BACKEND=postgres` reikalauja:

| Kintamasis | Kodėl privalomas |
|---|---|
| `DATABASE_URL` **arba** `PG*` | be jų eksplicitinis pasirinkimas tyliai virstų atmintimi |
| `AUDIT_ID_SALT` | žr. §2 |
| `AUDIT_ID_SALT_ID` | žr. §3 |
| pritaikytos migracijos | `audit_log`, invariantai, append-only trigeris |

Trūkstant bet kurio — **startas nutrūksta**. Grįžimo į atmintį nėra: jis
reikštų, kad operatorius paprašė persistentinio audito, servisas pakilo, o
žurnalas dingsta per pirmą restartą — ir tai paaiškėtų tik tada, kai audito
prireiks.

### Dvi lygiavertės prisijungimo formos

DB adresą galima nurodyti **vienu iš dviejų** būdų:

| Forma | Kada | Pastaba |
|---|---|---|
| `DATABASE_URL` | lokaliai, CI | vienas kintamasis, patogu |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Docker Compose | **rekomenduojama produkcijai** |

Compose profiliai naudoja `PG*` **sąmoningai**: slaptažodis su URI simboliais
(`/`, `?`, `#`, `@`) sukonstruotame URL reikštų kitką arba jį sugadintų. `pg`
`PG*` skaito be jokio kodavimo.

⚠️ **ABU KARTU — KLAIDA, ne pirmenybė.** `AUDIT_BACKEND=postgres` su abiem
nustatytais **nutraukia startą**. Priežastis: pool'as teiktų pirmenybę
`DATABASE_URL`, o operatorius, matantis Compose `PG*`, pagrįstai manytų kitaip —
ir auditas rašytųsi į kitą duomenų bazę, nei atrodo. Auditas yra būtent ta
lentelė, apie kurią klausiama po incidento, tad „į kurią DB jis rašė" negali
priklausyti nuo tylios pirmenybės.

⚠️ Įterptiniams kvietėjams: `init(env)` perduoti `PG*` **persiunčiami** į pool'ą,
o ne paliekami `pg` skaityti iš `process.env` — kitaip konfigūracija būtų priimta
iš vieno šaltinio, o jungtis sukurta pagal kitą.

`PRIVACY_MODE=true` kartu su `AUDIT_BACKEND=postgres` taip pat nutraukia startą.
Prašymai prieštarauja: vienas draudžia rašyti auditą, kitas reikalauja jį
išsaugoti patvariai. Tylus leidimas duotų migruotą, sukonfigūruotą ir amžinai
tuščią lentelę, kuri stebint atrodo kaip veikianti sistema. Pilna `PRIVACY_MODE`
semantika lieka **[7.4d]**; čia apibrėžtas tik derinys.

---

## 2. `AUDIT_ID_SALT` tampa privaloma

`auditLog.resolveSalt()` be nustatytos druskos generuoja **procesui lokalią
atsitiktinę** reikšmę. Atmintyje tai nekainuoja — žurnalas ir taip miršta kartu
su procesu.

Persistuojant kaina yra GDPR: po restarto arba kitoje replikoje
`pseudonymizeIdentifier(jobId)` duotų kitą reikšmę, tad
`removeBySubjectIdentifier()` senų įrašų **nerastų**. Asmens duomenų ištrynimas
jų nepasiektų — tyliai, grąžindamas „ištrinta 0".

Todėl `postgres` režimu druska privaloma, o atsitiktinio fallback'o nėra.

---

## 3. `hash_key_id` — operatoriaus etiketė

`audit_log.hash_key_id` (`NOT NULL`) užpildomas iš `AUDIT_ID_SALT_ID` — laisvai
pasirenkamo žymens, pvz. `2026-08`.

Etiketė **nėra išvedama iš pačios druskos**. Išvesta (pvz. jos maiša) ji taptų
orakulu: turintis lentelę galėtų tikrinti druskos spėjimus. Etiketė egzistuoja
tam, kad **[7.4c]** rakto rotacija žinotų, kuris raktas skaičiavo kurį
`subject_id` — tam pakanka nesusijusio žymens.

Pati rotacija ir istorinių raktų paieška yra **[7.4c]**, ne 7.4b.

---

## 4. Append-only ir `DELETE` semantika

### `UPDATE` draudžiamas DB lygiu

`BEFORE UPDATE` trigeris `audit_log_no_update` atmeta **kiekvieną** `UPDATE`.
Apribojimas gyvena duomenų bazėje, o ne store'e, todėl galioja ir tiesioginiam
`psql` prisijungimui — būtent tokiu keliu užpuolikas taisytų įrašą apie savo
veiksmą.

⚠️ **Garantijos ribos tikslus formulavimas.** Tai append-only **`UPDATE`
atžvilgiu**, o ne pilna tamper-resistance. Kadangi `DELETE` lieka neribotas (§
žemiau), aplikacijos DB rolės turėtojas gali eilutę ištrinti arba ištrinti ir
įrašyti pakeistą — trigeris tokio kelio nemato. Teigti daugiau reikštų teiginį,
stipresnį už kodą (AGENTS.md §12.1).

Trigerio buvimas tikrinamas **starto metu**: jis nėra `CHECK`, tad
`REQUIRED_AUDIT_CONSTRAINTS` patikra jo nemato, ir be atskiro barjero DB su
nukritusiu trigeriu startuotų sėkmingai.

### `DELETE` DB lygmenyje **neribojamas**

#211 reikalavo eksplicitinio pasirinkimo tarp (a) atskiros DB rolės su grantais
ir (b) dokumentuoto API lygio apribojimo. Pasirinktas **(b)**.

Priežastis: `removeBySubjectIdentifier()` — GDPR ištrynimo kelias — eilutes
**fiziškai trina**. `DELETE` granto atėmimas sulaužytų būtent tą kelią, kurį
auditas privalo aptarnauti. Variantas (a) tokiu būdu nebuvo realus.

Riba gyvena API lygmenyje: `auditStore` **neeksponuoja** bendro trynimo ar
`TRUNCATE`. Vienintelis produkcinis kelias yra `removeBySubject(subjectId)`,
apribotas vienu subjektu. `clear()` skirtas tik testų valymui.

Formuluotė tiksli: DB lygmenyje `DELETE` **neribojamas**. Tai nėra „leidžiamas
tik retencijos keliu" — jokio DB lygio apribojimo nėra.

---

## 5. Determinuota skaitymo tvarka

Tvarkos autoritetas — `seq BIGSERIAL`, ne `timestamp` ir ne `id`.

- `timestamp` netinka: `now()` **vienoje transakcijoje** visoms eilutėms grąžina
  tą patį momentą, tad tvarka būtų neapibrėžta.
- `id` netinka: `crypto.randomUUID()` nemonotoniškas.

`seq` duoda tiksliai tą tvarką, kurią atmintyje duoda masyvo indeksas — 1:1 su
`memory` backend'u. Bendras kontrakto rinkinys tai tikrina scenarijumi, kuris
įrašo kelias eilutes **vienoje transakcijoje**.

---

## 6. Laiko autoritetas

`timestamp` stulpelis turi `DEFAULT now()`, ir aplikacija jo **neperduoda**.

Programos laikrodis skiriasi tarp replikų. Jei laiką parinktų aplikacija,
sugedęs NTP viename konteineryje sumaišytų viso audito tvarką, o kvietėjas
galėtų laiką pasirinkti pats. `append()` grąžina eilutę iš `RETURNING`, tad
kvietėjas mato tikrąjį įrašytą laiką, ne savo spėjimą.

---

## 7. Stulpeliai ir `meta` allowlist

Stulpeliais tampa **tik filtruojami** laukai: `id`, `timestamp`, `event`,
`subject_id`, `hash_key_id`, `result`, `request_id`. Kiekvienas turi savo
indeksą — filtravimas neturi remtis pilnu JSONB skenavimu.

Likę `auditLog.record()` laukai gyvena `meta` JSONB ir rašomi **pro allowlist**
(`utils/auditStore/fields.js`). Nežinomas laukas **nutylimas**, ne persistinamas.

Tai saugos riba, ne patogumo sąrašas: be jos bet kuris naujas `record()` laukas
automatiškai taptų saugomas — įskaitant tokį, kuris atneštų transkripcijos
turinio, prompt'o ar PII. Allowlist taikomas **abiejuose** backend'uose, kad
privatumo garantija nepriklausytų nuo `AUDIT_BACKEND` reikšmės.

Plikojo `job_id` stulpelio nėra ir nebus — auditas mato tik `subject_id` HMAC
pseudonimą.

---

## 8. Laiko biudžetas ir vėlyvas rašymas

`Promise.race` užklausos **nenutraukia** — jis tik nustoja jos laukti. Todėl
7.4a `suRiba()` vienas negali užtikrinti, kad įrašas neatsiras jau po to, kai
kvietėjui pasakyta „nepavyko".

Biudžetas dalijamas į **tris** dalis (`utils/auditStore/timeouts.js`):

```
pool'o laukimas   0.15 × T   connectionTimeoutMillis
serveris          0.55 × T   statement_timeout   ← DB NUTRAUKIA
klientas          0.70 × T   query_timeout       ← tik jei serveris nebeatsako
─────────────────────────
blogiausiu atveju 0.85 × T   <   T = AUDIT_WRITE_TIMEOUT_MS
```

**Kodėl trys, o ne dvi.** Lygios reikšmės neveiktų dviem skirtingais būdais:

1. **Fasadas vs serveris.** `suRiba()` skaičiuoja nuo `rasytiAudita()`
   iškvietimo, į kurio langą patenka ir laukimas eilėje prie jungties, o
   `statement_timeout` — tik nuo užklausos pradžios. Sulyginus juos, fasadas
   visada suveiktų pirmas, ir DB nespėtų nutraukti nė vienos užklausos: antra
   gynybos linija taptų pirmąja, o pirmoji — negaliojančia.

2. **Klientas vs serveris.** `pg` kliento `query_timeout` pradedamas skaičiuoti,
   kai užklausa IŠSIUNČIAMA, o serverio `statement_timeout` — kai serveris
   pradeda ją VYKDYTI. Sulyginus, klientas suveikia pirmas: `pg` atmeta žadėjimą
   ir nustoja laukti, bet serverio užklausos NENUTRAUKIA. INSERT, spėjęs
   įsirašyti per tą tarpą, kvietėjui praneštas kaip nepavykęs, o `suRiba()`
   vėlyvos sėkmės apdorojimas (logas + skaitiklis) apskritai nepasiekiamas —
   neatitikimas tampa nematomas. Todėl serveris visada turi suspėti pirmas.

Invariantai (`serveris < klientas`, `pool + klientas < T`) tikrinami vykdymo metu
ir starto patikroje, o santykiai — atskiru testu, kuris veikia BE duomenų bazės.
Ankstesnė versija konkrečias reikšmes tikrino tik PostgreSQL teste, ir perdalijus
biudžetą drift'as pasimatė tik CI.

7.4a vėlyvos sėkmės apdorojimas (`error` logas + skaitiklis) lieka kaip antra
gynybos linija tam atvejui, kai DB vis dėlto spėja įrašyti.

---

## 9. Retencija — sąmoningas skirtumas tarp backend'ų

`AUDIT_RETENTION_DAYS` ir `AUDIT_MAX_ENTRIES` galioja **tik `memory` režimui**
(7.4a elgesys, taikomas atminties masyvui).

`postgres` režime įrašai automatiškai **nešalinami**. Persistentinės retencijos
savininkas yra **[7.4d]**; jos įgyvendinimas 7.4b metu būtų scope creep.

Skirtumas dokumentuojamas čia, o ne slepiamas: tylus „retencija veikia visur"
teiginys būtų stipresnis už kodą (AGENTS.md §12.1).

---

## 10. Atsarginės kopijos

`audit_log` **neįtraukiamas** nei į kopiją, nei į atkūrimą.

Atkūrus jį, GDPR ištrinti audito įrašai grįžtų: ištrynimo žymos dengia job'us
pagal ID, o audito įrašai saugo pseudonimus, tad žymų apsauga jų neapsaugotų.
Ankstyvos kopijos galėjo turėti `audit` lauką — jis **praleidžiamas**, ne
atkuriamas.

---

## 13. Rakto rotacija ir istoriniai raktai (7.4c)

### Kodėl rotacija apskritai reikalinga

`subject_id` yra `HMAC(AUDIT_ID_SALT, jobId)`. Nutekėjus druskai, turintis
lentelę galėtų tikrinti spėjimus („ar šis pseudonimas atitinka job X"). Rotacija
tą nutraukia: naujiems įrašams naudojamas naujas secret'as, o senieji lieka su
savo generacija.

### Konfigūracija

| Kintamasis | Reikšmė |
|---|---|
| `AUDIT_ID_SALT_ID` | aktyvios generacijos etiketė, rašoma į `hash_key_id` |
| `AUDIT_ID_SALT` | aktyvus secret'as — **niekada nepersistinamas** |
| `AUDIT_ID_SALT_PREVIOUS` | istoriniai raktai: `id:secret,id:secret` |

ID formatas — `[A-Za-z0-9_.-]{1,64}`; secret'as — base64url arba hex. Kablelio
ir dvitaškio secret'e būti negali, todėl sąrašo skaidymas vienareikšmis.

Aktyvaus ir istorinių ID aibė privalo būti **unikali**: dublikatas reikštų, kad
tas pats `hash_key_id` atitinka du secret'us, ir pseudonimo atkūrimas taptų
neapibrėžtas. Kolizija, tuščias ID, tuščias secret'as ar netinkamas formatas —
**startas nutraukiamas**.

⚠️ **Vienintelis autoritetas — `utils/auditStore/keyRing.js`.**
`AUDIT_ID_SALT_PREVIOUS` niekur kitur neparsinamas. Trys kopijos (užklausa,
ištrynimas, startas) išsiskirtų tyliai, o kaina būtų GDPR: ištrynimas
apskaičiuotų kitą kandidatų aibę nei paieška.

### Rotacijos procedūra

1. Sugeneruokite naują secret'ą: `openssl rand -hex 32`.
2. **Senąjį perkelkite** į `AUDIT_ID_SALT_PREVIOUS` kaip `<senas-id>:<senas-secret>`.
3. Nustatykite naują `AUDIT_ID_SALT` ir naują `AUDIT_ID_SALT_ID`.
4. Perkraukite.

⚠️ **2 žingsnis nėra pasirinktinis.** Praleidus jį, senos generacijos įrašų
`subject_id` nebeįmanoma atkurti, ir GDPR ištrynimas jų nebepasieks. Startas tai
aptinka ir **nutraukiamas** — žr. §14.

### Kada raktą galima išimti

Tik kai DB nebeliko nė vieno įrašo su ta generacija. Patikrinti:

```sql
SELECT COUNT(*) FROM audit_log WHERE hash_key_id = '<generacijos-id>';
```

**Riba — 10 istorinių generacijų, bet ji atmeta tik nebereikalingus raktus.**
Viršijus ją, startas krinta tik jei bent vienas istorinis raktas DB įrašų
nebeturi. Reikalingo rakto riba neatmeta niekada.

> Priežastis: naivus derinys „maks. N" + „negalima pašalinti, kol yra įrašų"
> duotų spąstus. Pasukus raktą N+1 kartų greičiau nei suveikia retencija,
> viršijimas blokuotų startą, o pašalinti nė vieno nebūtų galima — backend'as
> taptų nepaleidžiamas be teisėto išėjimo.

Generacijos skenuojamos **loose index scan** būdu (rekursyvus CTE ant 7.4b
`hash_key_id` indekso): viena eilutė generacijai, ne viena įrašui. Naujos
lentelės nekuriama.

---

## 14. Kai secret'as prarastas negrįžtamai

`AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` leidžia startuoti, kai DB yra
įrašų, kurių generacijos rakto nebeturime. Kiekvieno starto metu rašomas `warn`.

⚠️ **Tai dokumentuotas sąmoningas GDPR garantijos laužymas**, ne konfigūracijos
niuansas. Įjungus jį:

- tų įrašų `removeBySubjectIdentifier()` **nebepasieks**;
- asmens duomenų ištrynimo prašymas jų **nepašalins**, nors atsakymas bus sėkmingas;
- įrašai lieka DB iki retencijos (7.4d).

**Atsistatymo kelias:** jei secret'as dar kur nors yra (slaptažodžių saugykla,
kopijos, kito diegimo `.env`), grąžinkite jį į `AUDIT_ID_SALT_PREVIOUS` ir
išjunkite vėliavą. Alternatyva — palaukti, kol retencija tas eilutes pašalins,
ir tada išimti generaciją.

Vėliava egzistuoja todėl, kad be jos fail-closed taisyklė reikštų **amžinai
nepaleidžiamą backend'ą**.

---

## 15. `GET /api/audit` — filtrai ir kursorius (7.4c)

### Filtrai

| Parametras | Ką filtruoja |
|---|---|
| `action` | persistentinį `event` stulpelį (atskiro `action` stulpelio nėra) |
| `request_id` | `request_id` stulpelį |
| `job_id` | pseudonimizuotą `subject_id` — žr. žemiau |
| `from` / `to` | `timestamp`; ISO-8601, `from > to` → 400 |

Filtrai **komponuojasi** viename užklausos kelyje.

⚠️ **`job_id` niekada netampa plaintext paieška.** Resolveris vieną kartą
apskaičiuoja kandidatinius `subject_id` aktyviai ir visoms DB esančioms
generacijoms, o užklausa naudoja **vieną** set-based predikatą
(`subject_id = ANY($1)`), ne po užklausą generacijai. Todėl `?job_id=` randa ir
įrašus, sukurtus **prieš** rotaciją.

### Kursorius

`OFFSET` po 7.4c **nebepalaikomas** — `offset` grąžina 400. Priežastis: neribotai
augančioje lentelėje jis padarydavo senesnius įrašus nepasiekiamus, o
lygiagrečių įrašymų metu praleisdavo arba dubliuodavo eilutes.

- Rikiavimas — pagal **`seq`** (7.4b tvarkos autoritetas), **mažėjimo** tvarka.
  `timestamp` netinka: `now()` vienoje transakcijoje duoda vienodus laikus.
- ⚠️ **DESC galioja tik `query()` / `GET /api/audit`.** `getAll()` ir `list()`
  lieka saugyklos (ASC) tvarka.
- `next_cursor` — opaque tokenas arba `null`. `null` grąžinamas tiksliai tada,
  kai kito puslapio nėra; tuščio paskutinio puslapio nebūna.
- Sugadintas ar nepilnas kursorius → **400**, ne 500.

⚠️ **Kursoriuje NĖRA filtrų reikšmių.** „Opaque" nereiškia „šifruotas": jis
keliauja URL'e ir patenka į access logus. Filtrų aibė susiejama **HMAC-SHA256
atspaudu** (keyed aktyviu `AUDIT_ID_SALT`, 16 baitų). Payload'e — tik `seq` ir
atspaudas.

⚠️ **Pasukus aktyvų raktą anksčiau išduoti kursoriai nustoja galioti** (atspaudas
nebesutampa) → 400. Sąmoninga pasekmė: alternatyva būtų raktuoti atspaudą kažkuo
nekintančiu, o tokio bendro rakto sistemoje nėra. Klientas pradeda puslapiavimą
iš naujo.

---

## 11. Kas lieka vėlesniems etapams

| Etapas | Kas |
|---|---|
| **[7.4c]** | ✅ įgyvendinta — žr. §13–§15 |
| **[7.4d]** | persistentinė retencija, pilna `PRIVACY_MODE` logika, readiness |
| **[7.5b]** | `POST_HOC_IVYKIAI` perrikiavimas — žr. §12 |

### 12. Kodėl post-hoc įvykiai NETAMPA fail-closed 7.4b metu

`POST_HOC_IVYKIAI` (`utils/auditEvents.js`) yra įvykiai, kurių auditas rašomas
**jau po** negrįžtamo veiksmo: ištrynimai, `LOGOUT`, `ADMIN_DELETE_OVERRIDE`.
Jiems `BLOKUOJANTIS` reiškia „sėkmė nedeklaruojama", o **ne** „veiksmas
atmetamas".

7.4b duoda **patvarumą** — įrašas išgyvena restartą — bet patvarumas nėra tas
pats, kas perrikiavimas. Kad šie įvykiai taptų tikrai fail-closed, auditas
turėtų būti rašomas **prieš** veiksmą, o tai keičia ištrynimo semantiką:
nepavykęs trynimas paliktų melagingą „ištrinta" pėdsaką, jei nebūtų
kompensacinio mechanizmo.

Toks mechanizmas — patvari eilė su eksplicitiniu klaidų pranešimu — yra
**[7.5b]** („audito rašymo klaidos neprarandamos"). Iki tol perrikiavimas
pakeistų vieną gedimo režimą kitu, negaunant realios garantijos.

Sprendimas priimtas 7.4b metu ir užfiksuotas čia bei `utils/auditEvents.js`
komentare, kad jo nereikėtų atkurti iš issue komentarų.
