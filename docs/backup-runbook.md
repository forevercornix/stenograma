# Atsarginių kopijų ir atkūrimo runbook

Šis dokumentas yra GDPR issue #20 rezultatas. Jis skirtas tam, kas
**eksploatuoja** sistemą — ne tam, kas ją rašo.

Architektūriniai sprendimai ir jų pagrindimas: #20 sprendimų žurnalas.
Ištrynimo garantijos: [`deletion-guarantees.md`](deletion-guarantees.md).

---

## 1. Kas patenka į kopiją

| Artefaktas | Ar kopijuojama |
|---|:---:|
| `source_audio` — įkeltas garso failas | ✅ |
| `transcript` — transkripcija | ✅ |
| `protocol` — sugeneruotas protokolas | ✅ |
| `job_record` — jobo įrašas | ✅ |
| `queue_record` — eilės būsena | ❌ |
| `audit_entry` — audito žurnalas | ❌ |
| `upload_temp`, `conversion_temp` | ❌ |
| `export_redacted`, `export_original` | ❌ |
| `transcript_redacted` | ❌ |

Sąrašas **išvedamas iš #19 artefaktų registro**, ne rašomas atskirai — naujas
artefakto tipas automatiškai gauna teisingą elgesį.

⚠️ **Auditas nekopijuojamas.** Po atkūrimo audito žurnale **nebus** įrašų apie
tai, kas vyko iki kopijos. **Atkuriami duomenys, ne jų istorija.**

⚠️ **Vykdomi darbai neįtraukiami.** Manifeste įrašoma, kiek jų praleista
(`excludedInFlightJobs`) ir kodėl. Kopija su `excludedInFlightJobs: 3` **nėra
sugadinta**.

---

⚠️ **AUDITO RAKTAI: KAM TAIKOMA IR KAM NETAIKOMA** (#155, 7.4f).

Šis skyrius anksčiau teigė, kad „be raktų kopija bevertė". **Aplikacijos kopijai
tai netaikoma**, ir tvirtinimas buvo klaidinantis.

`createBackup()` serializuoja tik `jobs` ir `audio`; `audit_entry` yra
`backupPolicy` **išbrauktųjų** sąraše. Vadinasi, aplikacijos kopijoje audito
eilučių **apskritai nėra** — nei su raktais, nei be jų. Atkūrus tokią kopiją
audito raktų neprireiks, nes nėra ką jais išspręsti.

Reikalavimas galioja **atskirai PILNAI PostgreSQL kopijai** (`pg_dump`, PITR ar
tomo momentinė kopija), kuri `audit_log` lentelę apima. Tokioje kopijoje audito
eilutės yra, o `AUDIT_ID_SALT` ir `AUDIT_ID_SALT_PREVIOUS` — **paslaptys**,
todėl jų ten nėra ir būti negali.

Atkūrus `audit_log` be atitinkamų raktų, jo generacijos tampa
**neišsprendžiamos**: 7.4c startas fail-closed nutraukia paleidimą, o įjungus
`AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` sistema pakyla, bet tų eilučių
`removeBySubjectIdentifier()` **nebepasiekia** — GDPR ištrynimas nebeįmanomas.

**Praktiškai:** darydami **pilną PostgreSQL kopiją**, tuo pačiu metu
užfiksuokite ir tuo metu galiojusius `AUDIT_ID_SALT`, `AUDIT_ID_SALT_ID` bei
`AUDIT_ID_SALT_PREVIOUS` — savo paslapčių saugykloje, ne kopijos faile. Jie
saugomi **atskirai ir atkuriami kartu** su ta kopija.

### ⚠️ `pg_dump` audito duomenų NEIMA (7.4d)

```bash
pg_dump --exclude-table-data=audit_log "$DATABASE_URL" > kopija.sql
```

⚠️ **Be šio parametro kopija paneigia dvi ištrynimo garantijas vienu metu.**
`audit_log` yra įprasta lentelė, tad `pg_dump` ją įtraukia pagal nutylėjimą.
Atkūrus tokį dump'ą grįžta:

- **GDPR ištrinti** įrašai — `removeBySubjectIdentifier()` juos fiziškai
  pašalino, o atkūrimas grąžina;
- **retencijos pašalinti** įrašai — jie dingo pasibaigus `AUDIT_RETENTION_DAYS`,
  ir atkūrimas atsuka tą terminą atgal.

Abiem atvejais sistemoje atsiranda pseudonimizuotų asmens duomenų, kurių ten
neturi būti, ir niekas apie tai nepraneša.

⚠️ **`--exclude-table-data`, NE `--exclude-table`.** Pirmasis praleidžia
duomenis, bet palieka lentelės schemą; antrasis pašalintų ir ją, o atkurta DB
liktų be `audit_log` — startas tada nutrūktų fail-closed, nes `auditStore.init()`
reikalauja lentelės ir jos invariantų.

Schema atkuriama, duomenys — ne: būtent to ir norima, nes auditas yra
atskaitomybės žurnalas, o ne atkuriama būsena (žr. `docs/audit-storage.md` §10).

### ⚠️ PITR ir tomo momentinės kopijos — `--exclude-table-data` NETAIKOMAS

`--exclude-table-data` yra **`pg_dump` parametras**. Kiti pilnos kopijos metodai
jo neturi ir turėti negali:

| Metodas | Ar gali praleisti `audit_log`? |
|---|---|
| `pg_dump` (loginė kopija) | **Taip** — `--exclude-table-data=audit_log` |
| PITR (WAL archyvas + bazinė kopija) | **Ne** — WAL atkuria kiekvieną pakeitimą, įskaitant ištrintų eilučių įrašymą |
| Tomo / disko momentinė kopija | **Ne** — kopijuojami failai, ne lentelės |

Atkūrus PITR arba momentinę kopiją, **GDPR ištrinti ir retencijos pašalinti
audito įrašai grįžta**. Teiginys „pilna kopija turėtų išbraukti šią lentelę"
šiems metodams tiesiog netaikomas, ir tvirtinti priešingai būtų klaidinga.

**Ką daryti vietoj to** — atkūrimo procedūroje, kol servisas dar sustabdytas:

```sql
-- PO PITR ar momentinės kopijos atkūrimo, PRIEŠ paleidžiant servisą.
TRUNCATE audit_log;
```

Jei audito pėdsakas reikalingas, o grąžinti visko negalima, alternatyvos yra dvi,
ir abi reikalauja sprendimo, ne numatytosios elgsenos:

1. **Paleisti su `PRIVACY_MODE=true`** vieną kartą: startas fiziškai išvalo
   lentelę (7.4d), po to vėliava išjungiama ir servisas paleidžiamas iš naujo.
   Rezultatas toks pat kaip `TRUNCATE`, tik per palaikomą kelią.
2. **Pripažinti, kad atkurta kopija turi pasenusius įrašus**, ir dokumentuoti tai
   kaip incidentą — retencija juos pašalins per kitą sweep'ą, bet GDPR ištrinti
   įrašai **negrįš** į ištrintų būseną savaime, nes ištrynimo žymos dengia
   job'us, o audito eilutės saugo pseudonimus.

⚠️ Antrasis variantas nėra „nieko nedaryti" — jis reiškia sąmoningą sprendimą
laikinai turėti duomenis, kurių neturėtų būti. Pirmasis variantas yra
numatytoji rekomendacija.

## 2. Įjungimas

Kopijos numatytai **išjungtos** — jos yra papildoma asmens duomenų saugykla.

```bash
BACKUP_ENABLED=true
BACKUP_RETENTION_DAYS=7

# Šifravimo raktas (64 hex simboliai)
BACKUP_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Šifravimas: **`aes-256-gcm`**, formato versija **`v2`**. GCM pasirinktas dėl
autentiškumo — pakeitus turinį ar manifestą dešifravimas **krinta**, o ne
grąžina šiukšles.

⚠️ Neįjungus, maršrutų **apskritai nėra** — administracinis endpointas, kuris
egzistuoja „tik grąžina 503", vis tiek yra atakos paviršius.

⚠️ **`BACKUP_RETENTION_DAYS` apibrėžia faktinį ištrynimo langą.** #19 ištrynimas
veikia gyvoje sistemoje, o kopijoje esantys duomenys lieka iki jos galiojimo
pabaigos. Šis terminas turi būti privatumo politikoje.

---

## 3. Kopijos kūrimas

```bash
curl -X POST https://<host>/api/admin/backups \
  -b cookies.txt \
  -o stenograma-backup.multipart
```

Reikalinga `backup:create` teisė (**tik administratorius**).

Atsakymas — `multipart/mixed` su dviem dalimis: `manifest.json` ir
`backup.data`. **Serveris kopijų nesaugo.**

Dalis reikia išskirti prieš atkūrimą:

```bash
# Riba iš Content-Type antraštės
BOUNDARY=$(head -c 200 stenograma-backup.multipart | grep -o 'stenograma-backup-[a-z0-9]*' | head -1)
```

⚠️ Tai nepatogiau nei vienas ZIP failas. ZIP atidėtas sąmoningai — jis
reikalautų naujos priklausomybės ir tiekimo grandinės peržiūros.

### Jei kūrimas grąžina 409

`BACKUP_SECRETS_PRESENT` reiškia, kad duomenyse aptikta **sukonfigūruotos
paslapties reikšmė**. Kopija **nesukuriama** sąmoningai: atkūrimo momentas yra
blogiausia vieta pirmą kartą sužinoti, kad kopija neatitinka politikos.

Veiksmai: rasti, kaip paslaptis pateko į duomenis (dažniausiai — įklijuota į
transkripciją), pašalinti ją, **rotuoti tą paslaptį**, tada kartoti.

---

## 4. Atkūrimas

```bash
curl -X POST https://<host>/api/admin/backups/restore \
  -b cookies.txt \
  -F "manifest=@manifest.json" \
  -F "data=@backup.data"
```

Reikalinga `backup:restore` teisė (**tik administratorius**).

### Atkūrimo grandinė

Kiekvienas žingsnis privalo pavykti, kad būtų pereita prie kito:

```
manifestas → formatas → programos versija → kontrolinė suma
  → dešifravimas → turinys → paslaptys → konfigūracija → privatumas
  → TIK TADA pritaikymas
```

Iki paskutinio žingsnio **veikianti sistema nepaliečiama**.

### Atsakymų reikšmės

| Kodas | Ką reiškia | Ką daryti |
|---|---|---|
| `200` | Atkurta | Patikrinti `completedSteps` ir `restored` |
| `400` | Netinkama kopija ar manifestas | Žiūrėti `failedStep` ir `reason` |
| `409` `ACTIVE_JOBS_PRESENT` | Vykdomi darbai | Palaukti, kol baigsis |
| `409` `MAINTENANCE_IN_PROGRESS` | Vyksta kita priežiūra | Palaukti |
| `413` | Failas per didelis | Padidinti `MAX_BACKUP_UPLOAD_MB` arba tikrinti failą |
| `503` | Kopijos išjungtos | `BACKUP_ENABLED=true` |
| `500` | Vidinė serverio klaida | Žiūrėti serverio logus — atsakyme detalių nėra sąmoningai |

### Priežiūros užraktas

Atkūrimo metu **naujų darbų priimti negalima**. Tai ne apribojimas, o
būtinybė: be jo tarp aktyvių darbų patikros ir pritaikymo worker'is spėtų
paimti naują darbą.

Užraktas galioja **ne ilgiau kaip 10 min** — procesui nukritus vidury sistema
kitaip liktų užblokuota, ir vienintelė išeitis būtų restartas.

⚠️ **Užraktas veikia tik viename procese.** Atkūrimą galima saugiai daryti
**tik tada, kai veikia vienas backend procesas.** Keliems worker'iams reikėtų
Redis užrakto.

---

### Audito raktai atkuriant PILNĄ PostgreSQL kopiją

⚠️ **Šis poskyris NĖRA apie `POST /api/backup/restore`.** Aplikacijos kopijoje
audito eilučių nėra (žr. §1), tad jos atkūrimas audito raktų neliečia. Žemiau
aprašytas kelias galioja **pilnos PostgreSQL kopijos** atkūrimui — tik ji
grąžina `audit_log` turinį.

⚠️ **SEKA SVARBI, IR ANKSTESNĖ ŠIO RUNBOOK'O VERSIJA BUVO NETEISINGA.** Ji liepė
patikrinti generacijas *prieš* pakeliant dump'ą. Tuščioje avarinio atkūrimo
duomenų bazėje ta užklausa grąžina **nieko** ir klaidingai patvirtina, kad raktų
žiedas pilnas; startas paskui krenta fail-closed ties generacijomis, kurių
operatorius net nematė — būtent tada, kai klaidos kaina didžiausia.

Teisinga seka:

1. **Servisas SUSTABDYTAS.** Fail-closed startas su nepilnu raktų žiedu nutrauks
   paleidimą, o pusiau pakelta DB kartu su bandančiu kilti procesu tik apsunkina
   diagnostiką.

2. **Pakelkite dump'ą** į tikslinę duomenų bazę.

3. **Tik dabar klauskite, kokios generacijos kopijoje yra** — užklausa
   prasminga tik po žingsnio 2, nes iki tol ji rodo senos arba tuščios lentelės
   turinį:

   ```sql
   SELECT DISTINCT hash_key_id FROM audit_log;
   ```

4. **Surinkite trūkstamus raktus** į `AUDIT_ID_SALT_PREVIOUS` (formatas
   `id:secret`, kableliais). Kiekvienas žingsnio 3 rezultatas privalo turėti
   raktą aktyviame arba istoriniame sąraše.

5. **Tik tada startuokite servisą.** Trūkstant bent vieno rakto, startas
   nutrūks — tai apsauga, ne kliūtis; žr. „Jei raktas prarastas negrįžtamai".

⚠️ **Kodėl ne „fiksuoti generacijų sąrašą kopijos darymo metu".** Toks sąrašas
būtų patogesnis, bet jo negalime garantuoti: pilną PostgreSQL kopiją paprastai
daro DBA įrankiai (`pg_dump`, PITR, tomo momentinė kopija), kurių ši aplikacija
nevaldo, o aplikacijos kopija audito lentelės neapima apskritai. Sąrašas tada
egzistuotų tik dalyje kopijų, ir operatorius negalėtų žinoti, ar jo nebuvimas
reiškia „nėra generacijų", ar „niekas jo neužfiksavo". Žingsnių tvarka veikia su
**bet kokiu** dump'u, iš bet kokio šaltinio, todėl pasirinkta ji. Sąrašo
fiksavimas kopijos metu lieka naudingas **papildomas** patogumas, ne pakaitalas.

### Jei raktas prarastas negrįžtamai

1. Paleiskite su `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true`. Procesas
   pakils; `/api/health` grąžins **200**, o `/api/ready` — **503**. Taip ir
   turi būti: vėliavėlė leidžia *paleisti*, ne deklaruoti sveikatą, o liveness
   lieka, kad orkestruotojas neperkrautų podo cikle ir šis langas apskritai
   atsivertų.

2. Pašalinkite paveiktas eilutes:

   ```sql
   DELETE FROM audit_log WHERE hash_key_id = '<prarasta-generacija>';
   ```

   ⚠️ Tai **negrįžtama** ir reiškia, kad tų įvykių audito pėdsako nebeliks.
   Alternatyvos nėra: be rakto jų `subject_id` neatkuriamas, tad GDPR
   ištrynimas jų vis tiek nebepasiektų.

3. Išjunkite `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS` ir pašalinkite
   generaciją iš `AUDIT_ID_SALT_PREVIOUS`, jei ji ten dar yra.

4. ⚠️ **PERKRAUKITE.** Be šio žingsnio `/api/ready` **liks 503**, nors eilutės
   jau išvalytos.

   Priežastis: neišsprendžiamų generacijų sąrašas yra **starto momento
   snapshot'as**, ne gyva būsena. Jis atsinaujina tik per paleidimą — pilnas
   generacijų skenavimas kiekvieno readiness poll'o metu būtų būtent ta
   operacija, kurios visa schema ir vengia.

   Patikrinkite po perkrovimo:

   ```bash
   curl -s localhost:3000/api/ready | grep -o '"auditKeysResolvable":[a-z]*'
   ```

   Turi būti `true`.

## 5. Ko atkūrimas NEGRĄŽINA

⚠️ **Ištrintų duomenų.** Atkūrimas gerbia #19 žymas: jei jobas buvo ištrintas,
jis **negrįžta**, net jei kopija jį turi. Be to atsarginė kopija taptų būdu
apeiti GDPR ištrynimą.

Tai galioja **ir šifruotoms kopijoms, ir rotacijos keliui**.

⚠️ **Audito istorijos** — žr. 1 skyrių.

⚠️ **Vykdytų darbų** — jie nebuvo įtraukti į kopiją.

⚠️ **Eilės būsenos** — po atkūrimo eilė **tuščia**; nebaigti darbai laikomi
prarastais.

---

⚠️ **Aplikacijos atkūrimas negrąžina audito — nei įrašų, nei raktų.** Audito
eilučių kopijoje nėra (žr. §1), tad raktų klausimas čia neiškyla.

Jis iškyla atkuriant **pilną PostgreSQL kopiją**: praradus raktus kartu su
duomenimis, `audit_log` eilutės lieka fiziškai, bet tampa neišsprendžiamos —
nei paieška pagal `job_id`, nei GDPR ištrynimas jų nebepasiekia.

## 6. Raktų rotacija

```bash
# 1. Naujas raktas
NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. Senasis perkeliamas į PREVIOUS
BACKUP_ENCRYPTION_KEY_PREVIOUS=<senasis>
BACKUP_ENCRYPTION_KEY=$NEW_KEY

# 3. Restartas
```

Naujos kopijos visada šifruojamos **dabartiniu** raktu; senasis naudojamas tik
dešifravimui.

### ⚠️ Kritinė taisyklė: NEROTUOTI DU KARTUS IŠ EILĖS

Palaikomas **tik vienas** ankstesnis raktas. Rotavus antrą kartą, kopijos,
šifruotos prieš dvi rotacijas, taps **neatkuriamos**.

Prieš antrą rotaciją privaloma viena iš sąlygų:

- visos senuoju raktu šifruotos kopijos **pasibaigė** pagal retenciją, **arba**
- jos **peršifruotos** (atkurtos ir sukurtos iš naujo).

### Prieš pašalinant `BACKUP_ENCRYPTION_KEY_PREVIOUS`

Atlikti **atkūrimo testą** su seniausia turima kopija. Jei jis pavyksta
naudojant tik dabartinį raktą — senojo nebereikia.

Jei loguose matote `Atkurta ANKSTESNIU šifravimo raktu`, kopija **dar
nepersišifruota**, ir senojo rakto šalinti negalima.

⚠️ **Rakto ID nėra.** Kopijoje nefiksuojama, kuriuo raktu ji šifruota — tik ar
apskritai šifruota. Tad rotacijos apskaita yra **operatoriaus atsakomybė**.

---

## 7. Paslapčių rotacija

Inventorius: `backend/utils/secretsInventory.js` — **14 paslapčių**, kiekviena
su tuo, ką atrakina ir kaip ją pakeisti.

| Tipas | Kiek | Rotacija |
|---|---|---|
| Vidinės (`API_KEY`, `AUTH_USERS`, kopijų raktai) | 6 | Pakeisti reikšmę + restartas |
| Išorinės (tiekėjų raktai) | 8 | **Atšaukti tiekėjo konsolėje**, tada pakeisti |

⚠️ Išorinės paslapties **neužtenka pakeisti konfigūracijoje** — senasis raktas
lieka galiojantis, kol jo neatšauksite pas tiekėją.

---

## 8. Atkūrimo pratybos

Kopija, kuri niekada nebuvo atkurta, **nėra patikrintas atkūrimo mechanizmas**.

| Kas | Kaip dažnai | Kodėl |
|---|---|---|
| Atkūrimas į izoliuotą aplinką | Ketvirčiui | Vienintelis būdas įsitikinti, kad kopijos veikia |
| Atkūrimas su **seniausia** turima kopija | Ketvirčiui | Tikrina versijų suderinamumą |
| Atkūrimas po rakto rotacijos | Po kiekvienos | Tikrina `PREVIOUS` kelią |
| Sąmoningai sugadintos kopijos bandymas | Metams | Tikrina, kad fail-closed veikia |

**Pratybų įrašas neturi turėti dokumentų turinio** — pakanka manifesto
metaduomenų, žingsnių sąrašo ir rezultato.

---

## 9. Atkūrimo laiko prielaidos (pilotui)

| Etapas | Apytiksliai |
|---|---|
| Kopijos sukūrimas | Sekundės–minutės, priklauso nuo audio kiekio |
| Perkėlimas | Priklauso nuo tinklo ir kopijos dydžio |
| Patikros (iki pritaikymo) | Sekundės |
| Pritaikymas | Sekundės–minutės |

⚠️ Tai **prielaidos, ne SLA.** Realias reikšmes reikia išmatuoti savo aplinkoje
per atkūrimo pratybas — kopijos dydis tiesiogiai priklauso nuo įrašų kiekio ir
trukmės.

⚠️ **Atkūrimas nutraukia paslaugą:** naujų darbų priimti negalima, kol jis
vyksta.

---

## 9a. Šifruota PostgreSQL kopija (`pg_dump`) — 7.6a

Aplikacijos JSON kopija (skyriai 3–4) ir **pilna PostgreSQL kopija** yra du
skirtingi artefaktai. Šis skyrius yra apie antrąjį.

### Procedūra

```bash
# Kopija (šifruojama AES-256-GCM; be rakto procedūra ATSISAKO dirbti)
node backend/scripts/pg-backup.mjs dump --out kopija.json --url "$DATABASE_URL"

# Atkūrimas į TUŠČIĄ bazę
node backend/scripts/pg-backup.mjs restore --in kopija.json --target "$TIKSLO_URL"
```

Exit kodai: `0` sėkmė · `1` naudojimo klaida · `2` procedūros klaida.

### Ką procedūra garantuoja

- **Šifravimą.** `pg_dump` išvestis niekada nerašoma į diską atviru tekstu;
  be `BACKUP_ENCRYPTION_KEY` `dump` komanda krinta su
  `BACKUP_ENCRYPTION_DISABLED`. Tai sąmoninga: `job_results` turi transkripcijas.
- **Fail-closed patikras PRIEŠ pirmą SQL sakinį.** Manifesto validacija, GCM
  žyma (AAD) ir kontrolinė suma tikrinamos prieš `psql` iškvietimą.
- **Atomiškumą.** Atkūrimas vykdomas `psql --single-transaction` su
  `ON_ERROR_STOP=1`: SQL klaida viduryje duoda `ROLLBACK`, ne pusiau atkurtą bazę.
- **Audito neįtraukimą.** `--exclude-table-data=audit_log` (7.4d).

### ⚠️ Po atkūrimo PRIVALOMA patikrinti schemos versiją

```bash
DATABASE_URL="$TIKSLO_URL" node backend/scripts/doctor.mjs
```

`make doctor` per `startupChecks.postgresReachability()` lygina `pgmigrations`
turinį su `backend/migrations/` katalogu ir parodo migracijų **atsilikimą**.
Atkurta bazė gali būti senesnės schemos nei kodas; be šio žingsnio tai
paaiškėtų pirmo `INSERT` metu, gyvame sraute.

⚠️ `/api/ready` migracijų atsilikimo **netikrina** — jis tikrina komponentų
liveness zondus. 7.6a to nekeičia (žr. ataskaitos D5).

### ⚠️ Ši procedūra dar NĖRA erasure-safe

Atkūrimas **prikelia po kopijos ištrintus job'us**. Ištrynimo žymos
(`erasure_marks`, 7.5a) egzistuoja, bet atkūrimo kelias jų dar **netaiko**, o
ištrynimų replay ateis su 7.6c (#250).

Praktinė pasekmė: jei tarp kopijos ir atkūrimo kas nors pasinaudojo teise būti
pamirštam, po atkūrimo jo duomenys grįžta. Iki 7.6c uždarymo atkūrimą galima
vykdyti tik su rankiniu ištrynimų sąrašo patikrinimu.

## 10. Žinomos ribos

| Riba | Poveikis | Kur spręsti |
|---|---|---|
| Užraktas tik viename procese | Atkūrimas saugus tik su vienu backend | Redis užraktas |
| Pritaikymas **nėra transakcinis** | Infrastruktūros gedimas vidury palieka dalinį atkūrimą | Duomenų bazė su rollback |
| Rakto ID nėra | Rotacijos apskaita — rankinė | Kito etapo tema |
| Tik vienas ankstesnis raktas | Dviguba rotacija sunaikina kopijas | Kelių raktų palaikymas |
| ZIP nepalaikomas | Operatoriui mažiau patogu | Priklausomybės peržiūra |
| Paslapčių patikra *best-effort* | Neaptinka rotuotų ar kitos aplinkos paslapčių | Slaptų duomenų skeneris |
| Serveris kopijų nesaugo | Perkėlimas ir saugojimas — operatoriaus | Kopijų saugyklos posistemė |
| **`pg_dump` kopija ribojama `MAX_DUMP_BYTES` (256 MB)** | Didesnė bazė krinta su `PG_DUMP_TOO_LARGE` | Srautinis šifravimas — ne 7.6a |
| **`pg_dump` atkūrimas NĖRA erasure-safe** | Prikelia po kopijos ištrintus job'us | Ištrynimų replay — 7.6c (#250) |

---

## 11. Ką parodyti auditoriui

✅ Kad kopijos šifruotos (`manifest.encrypted`, algoritmas ir versija).
✅ Kad kopijoje nėra eksportų ir redaguotų variantų (politika kildinama iš registro).
✅ Kad atkūrimas **negrąžina ištrintų duomenų** — svarbiausia #20 garantija.
✅ Kad kopijų kūrimas ir atkūrimas audituojami su aktoriumi.
✅ Retencijos terminą, apibrėžiantį faktinį ištrynimo langą.

❌ **Ne** to, kas konkrečiai kopijoje — manifeste tik tipai ir skaičiai.
