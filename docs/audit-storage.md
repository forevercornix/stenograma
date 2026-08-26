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
| `DATABASE_URL` | be jo eksplicitinis pasirinkimas tyliai virstų atmintimi |
| `AUDIT_ID_SALT` | žr. §2 |
| `AUDIT_ID_SALT_ID` | žr. §3 |
| pritaikytos migracijos | `audit_log`, invariantai, append-only trigeris |

Trūkstant bet kurio — **startas nutrūksta**. Grįžimo į atmintį nėra: jis
reikštų, kad operatorius paprašė persistentinio audito, servisas pakilo, o
žurnalas dingsta per pirmą restartą — ir tai paaiškėtų tik tada, kai audito
prireiks.

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

Biudžetas dalijamas į tris dalis (`utils/auditStore/timeouts.js`):

```
pool'o laukimas   0.2 × T   connectionTimeoutMillis
užklausa          0.7 × T   statement_timeout (DB NUTRAUKIA)
────────────────────────
blogiausiu atveju 0.9 × T   <   T = AUDIT_WRITE_TIMEOUT_MS
```

Lygios reikšmės neveiktų: `suRiba()` skaičiuoja nuo `rasytiAudita()` iškvietimo,
į kurio langą patenka ir laukimas eilėje prie jungties, o `statement_timeout` —
tik nuo užklausos pradžios. Su lygiomis reikšmėmis fasadas visada suveiktų
pirmas, ir DB nespėtų nutraukti nė vienos užklausos: antra gynybos linija taptų
pirmąja, o pirmoji — negaliojančia.

Invariantas tikrinamas vykdymo metu ir starto patikroje, ne komentare.

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

## 11. Kas lieka vėlesniems etapams

| Etapas | Kas |
|---|---|
| **[7.4c]** | rakto rotacija, istoriniai raktai, nauji `GET /api/audit` filtrai (`from`, `to`, `action`, `job_id`) |
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
