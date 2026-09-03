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
BACKUP_ENABLED=true node backend/scripts/pg-backup.mjs dump \
  --out kopija.json --actor "$USER" --url "$DATABASE_URL"

# Atkūrimas į TUŠČIĄ bazę
node backend/scripts/pg-backup.mjs restore --in kopija.json --target "$TIKSLO_URL"
```

Exit kodai: `0` sėkmė · `1` naudojimo klaida · `2` procedūros klaida.

⚠️ **`BACKUP_ENABLED=true` privalomas.** Išjungtos kopijos reiškia išjungtas ir
šias: `dump` krinta su `BACKUP_DISABLED` dar prieš jungiantis prie bazės.

⚠️ **Auditas inicijuojamas TIK `dump` kelyje.** Be `auditStore.init()` su
`AUDIT_BACKEND=postgres` įrašas nukeliautų į atminties fasadą ir dingtų procesui
pasibaigus — komanda praneštų sėkmę, o audito žurnale įrašo nebūtų.

⚠️ **`restore` audito saugyklos neinicijuoja — sąmoningai.** Kitaip avarinis
atkūrimas priklausytų nuo audito prieinamumo, o §10 kaip tik dėl to atkūrimo
pusės neaudituoja. Tai ne teorija: kai `DATABASE_URL` rodo į **naują tuščią
tikslą** (numatytas 7.6a scenarijus), `audit_log` lentelės ten dar nėra, ir
inicijavimas nutrauktų atkūrimą dar nepradėjus.

⚠️ **`--actor` privalomas `dump` komandai** — juo pasirašomas audito įrašas
`PG_DUMP_BACKUP_CREATED`. Be jo komanda krinta su exit kodu `1`.

⚠️ **Jungties eilučių išvestyje nebus.** Ir sėkmės pranešimas, ir klaidos tekstas
praeina pro kredencialų filtrą: `pg_dump` klaidos žinutėje kitaip atsidurtų visa
argumentų eilutė su slaptažodžiu.

### Ką procedūra garantuoja

- **Šifravimą.** `pg_dump` išvestis niekada nerašoma į diską atviru tekstu;
  be `BACKUP_ENCRYPTION_KEY` `dump` komanda krinta su
  `BACKUP_ENCRYPTION_DISABLED`. Tai sąmoninga: `job_results` turi transkripcijas.
- **Fail-closed patikras PRIEŠ pirmą SQL sakinį.** Manifesto validacija, GCM
  žyma (AAD) ir kontrolinė suma tikrinamos prieš `psql` iškvietimą.
- **Atomiškumą.** Atkūrimas vykdomas `psql --single-transaction` su
  `ON_ERROR_STOP=1`: SQL klaida viduryje duoda `ROLLBACK`, ne pusiau atkurtą bazę.
- **Audito neįtraukimą.** `--exclude-table-data=audit_log` (7.4d).
- **Kopijos galiojimo užfiksavimą.** Prieš išduodant artefaktą jo `expiresAt`
  įrašomas per `deletionTombstones.recordBackupHorizon()`. Nepavykus — kopija
  **neišduodama** (`PG_BACKUP_HORIZON_UNRECORDED`). Be šio įrašo sutrumpinta
  `BACKUP_RETENTION_DAYS` reikšmė leistų išvalyti ištrynimo žymas, kol dump'as
  dar galioja, ir 7.6c replay nebeturėtų ko taikyti.
  ⚠️ **Praktinė pasekmė, išmatuota CI'uje:** bazė be įdiegtos ištrynimo žymų
  infrastruktūros (`erasure_marks`) kopijos **neišduoda** — komanda krinta su
  `PG_BACKUP_HORIZON_UNRECORDED`. Prieš pirmą kopiją paleiskite migracijas.
- **Horizontą TOJE PAT bazėje, kurią dump'iname.** Šaltinis privalo sutapti su
  ištrynimo žymų baze (`DATABASE_URL` arba `PG*`); kitaip komanda atsisako
  dirbti (`PG_BACKUP_SOURCE_MISMATCH`) dar prieš `pg_dump`.
  ⚠️ **Todėl `--url` NĖRA būdas dump'inti svetimą bazę** — jis skirtas nurodyti
  jungtį, kai `DATABASE_URL` neeksportuotas shell'e. Svetimos bazės kopija būtų
  sukurta sėkmingai, o jos galiojimas užfiksuotas KITOS bazės `backup_horizon`
  lentelėje: 7.6c (#250) tai rastų kaip „kodėl žymos pasibaigė anksčiau nei
  kopija". Atmintinė žymų saugykla (be `DATABASE_URL`/`PGHOST`) taip pat
  atmetama — horizontas dingtų procesui pasibaigus
  (`PG_BACKUP_HORIZON_NOT_PERSISTENT`).
- **Programos versijos ribą.** Kito MAJOR'o kopija atmetama prieš `psql`
  (`BACKUP_APPLICATION_VERSION_INCOMPATIBLE`); `unknown` praleidžiama su
  įspėjimu — tas pats elgesys kaip `restoreService`, perimtas pažodžiui.
- **Kūrimo auditą su aktoriumi — kai audito saugykla patvari.**
  `PG_DUMP_BACKUP_CREATED`, atskiras nuo aplikacijos kopijos `BACKUP_CREATED`.
  ⚠️ **Sąlyga įvardyta sąmoningai (#262 IV raundas):** su numatytu
  `AUDIT_BACKEND=memory` įrašas lieka proceso atmintyje ir dingsta komandai
  pasibaigus, tad komanda tokiu atveju išveda matomą įspėjimą. Fail-closed čia
  netaikomas: kitaip diegimas su numatytu backend'u apskritai negalėtų pasidaryti
  kopijos — ta pati priklausomybė, kurios atsisakyta atkūrimo pusėje.
  ⚠️ **Atkūrimo pusėje audito NĖRA** — žr. §10 ir §11.
- **Rakto formato patikrą PRIEŠ darbą.** Netinkamas `BACKUP_ENCRYPTION_KEY`
  krinta su `BACKUP_KEY_INVALID` dar prieš `pg_dump` ir prieš horizonto
  fiksavimą. ⚠️ Anksčiau toks raktas praeidavo visą dump'ą ir **patvariai
  pastumdavo** `backup_horizon`: suplanuota užduotis su klaidinga konfigūracija
  būtų tęsusi žymų retencijos horizontą neišduodama nė vieno artefakto.
- **Šifravimo metaduomenų nuoseklumą.** `encrypted` privalo būti griežtas
  boolean, algoritmas — palaikomas; `encrypted: false` prie envelope yra
  manifesto downgrade ir atmetamas. Tos pačios patikros kaip
  `restoreService` — du atkūrimo kraštai laukams suteikia tą pačią prasmę.
- **Privatumo režimo ribą.** Eksplicitiniame `PERSISTENT_STORAGE=false` režime
  atkūrimas atmetamas (`BACKUP_RESTORE_PRIVACY_MODE`): PostgreSQL tikslas yra
  patvarus, tad turinys atsidurtų diske režime, kuris žada jo neturėti.
- **Tikslinės bazės tuštumą.** Prieš pirmą SQL sakinį katalogai suskaičiuoja
  **visus** vartotojo objektus ne sisteminėse schemose — lenteles, rodinius,
  materializuotus rodinius, sekas, indeksus, funkcijas, enum'us bei domenus ir
  ne`public` schemas;
  radus bent vieną, atkūrimas atmetamas (`PG_RESTORE_TARGET_NOT_EMPTY`).
  ⚠️ **Patikslinta (#262 peržiūra):** pirmoji redakcija skaičiavo tik
  `information_schema.tables`, tad likusi seka ar matview'as praeidavo, nors šis
  skyrius jau žadėjo „visus objektus" — dokumentas buvo stipresnis už kodą.
  ⚠️ **Riba:** diegime, kur plėtinys (pvz. `pgcrypto`) įdiegtas į `public`,
  tokia bazė bus laikoma **netuščia**. Mūsų pačių migracijos `CREATE EXTENSION`
  nenaudoja, tad standartiniam diegimui tai įtakos neturi. ⚠️ Priežastis ne šis etapas: 7.6b (#249)
  suderinimas ir 7.6c (#250) replay remsis BŪTENT šiuo keliu ir abu prasideda
  nuo prielaidos „restore pavyko" — atkūrimas į netuščią bazę duotų dviejų bazių
  **sąjungą**, ir jų testai to nepagautų. Neperskaičius `psql` išvesties
  atkūrimas taip pat atmetamas (`PG_RESTORE_PREFLIGHT_FAILED`): „tuščia" yra
  teiginys, kurį reikia įrodyti.
- **Nesuderinamo formato atmetimą.** `backupPolicy.checkRestoreCompatibility()`
  vykdomas prieš dešifravimą: naujesne versija sukurta kopija atmetama
  (`BACKUP_FORMAT_INCOMPATIBLE`), o ne atkuriama prarandant nesuprastus laukus.

### Šaltinio nuoseklumas

`pg_dump` visą kopiją ima **vienu nuosekliu snapshot'u** (`REPEATABLE READ`),
tad `jobs` ir susiję `job_results` negali būti paimti iš skirtingų loginių
momentų. Procedūra sąmoningai neperduoda `--no-synchronized-snapshots` ir `--jobs`.

⚠️ **Formuluotė patikslinta (#262 peržiūra).** Ankstesnė redakcija teigė, kad abi
vėliavos garantiją panaikintų „tyliai, be jokios klaidos". `plain` formatui tai
netikslu: `pg_dump -j` iškart krinta (lygiagretus dump'as palaikomas tik
`directory` formatu). Sargas testuose lieka — jis gina nuo vėliavos, pridėtos
kartu su formato pakeitimu, kai kritimo nebebūtų.

### ⚠️ Manifestas NEPASAKO, kurią bazę atkuriate

DB dump'o manifeste `contents` yra **tuščias** (dump'as nėra aplikacijos
artefaktų inventorius), tad iš dviejų dump'ų manifestų juos skiria praktiškai tik
`snapshotTime`. Klastojimui tai kelio neatveria — rūšį ir turinį autentifikuoja
GCM žyma — bet **operatorius iš manifesto neatskiria, ką atkuria**.

Todėl: kiekvienam atkūrimui užsirašykite, **kuris artefaktas yra autoritetingas**
(failo vardas, `snapshotTime`, iš kurios aplinkos), ir rollback'o aptikimas
remkitės tuo įrašu, ne vien manifestu. Šviežumo ir kilmės žymėjimas išsamiau —
7.6c (#250).

### ⚠️ Po atkūrimo PRIVALOMA patikrinti schemos versiją

```bash
DATABASE_URL="$TIKSLO_URL" npm --prefix backend run doctor   # arba: make doctor
```

⚠️ **Komanda patikslinta (#262 peržiūra).** Ankstesnė redakcija nurodė
`backend/scripts/doctor.mjs` — **tokio failo nėra**; įėjimas yra
`backend/scripts/doctor.js`, kviečiamas per `npm run doctor` arba `make doctor`.
Ten pat mechanizmas buvo įvardytas kaip `startupChecks.postgresReachability()`:
funkcija egzistuoja, bet yra **privati**, tad iš išorės ji nepasiekiama; viešasis
įėjimas — `startupChecks.runSelfChecks()`.

Patikra lygina `pgmigrations` turinį su `backend/migrations/` katalogu ir parodo
migracijų **atsilikimą**.
Atkurta bazė gali būti senesnės schemos nei kodas; be šio žingsnio tai
paaiškėtų pirmo `INSERT` metu, gyvame sraute.

⚠️ `/api/ready` migracijų atsilikimo **netikrina** — jis tikrina komponentų
liveness zondus. 7.6a to nekeičia (žr. ataskaitos D5).

### ⚠️ Atkūrimas NEBAIGIA procedūros — toliau §9b

Atkurta bazė dar turi **gyvas sesijas ir in-flight job'us** iš snapshot'o momento.
Iki `post-restore-reconcile` (§9b) sėkmės aplikacijos startuoti ir srauto
perjungti negalima.

⚠️ **Šis skyrius pridėtas su 7.6b (#249).** Iki tol §9a apie startą nesakė nieko —
nei „offline", nei „galima" — tad riba egzistavo tik kaip numanoma. Numanoma riba
yra ta pati klasė kaip nedokumentuota: operatorius jos nemato.

### ⚠️ Vien šis žingsnis NĖRA erasure-safe

Atkūrimas **prikelia po kopijos ištrintus job'us**. Ištrynimo žymos
(`erasure_marks`, 7.5a) gyvena toje pačioje bazėje, tad senas snapshot'as
grąžina ir duomenis, IR būseną „ištrynimo nebuvo".

Praktinė pasekmė: jei tarp kopijos ir atkūrimo kas nors pasinaudojo teise būti
pamirštam, po atkūrimo jo duomenys grįžta.

⚠️ **Tai ištaiso §9c, ir tik jis.** `pg-backup.mjs restore` erasure-safe NĖRA ir
netaps — ištrynimų žurnalas gyvena UŽ snapshot'o ribų, tad jį sulieti ir
pakartoti gali tik atskiras žingsnis. Praleidus §9c, atkūrimas lieka tiksliai
toks, koks aprašytas šioje pastraipoje.

## 9b. Post-restore aplikacinis suderinimas — 7.6b

⚠️ **ATKŪRIMAS NĖRA BAIGTAS, KOL ŠIS ŽINGSNIS NEPRAĖJO.** `pg_dump` atkuria
duomenis, bet kartu prikelia ir aplikacinę būseną, kurios prikelti negalima:
**sesijas, kurios autentifikuoja senus cookie**, ir `queued`/`processing` job'us,
kurių niekas nebevykdo.

### Eiliškumas

```bash
# 1. Atkūrimas (§9a)
node backend/scripts/pg-backup.mjs restore --in kopija.json --target "$TIKSLO_URL"

# 2. Schemos patikra
DATABASE_URL="$TIKSLO_URL" npm --prefix backend run doctor

# ⚠️ 2b-4. IŠTRYNIMAI, SUDERINIMAS IR VERIFIKACIJA — VIENA KOMANDA (§9c)
#
#    `dr-restore.mjs run` atlieka juos SEKA: žymų suliejimas → ištrynimų replay →
#    7.6b suderinimas → verifikacija. Tvarka yra kontrakto dalis, ne pasirinkimas:
#    suderinimas PRIEŠ replay terminalizuotų darbą su jau ištrintais duomenimis.
DATABASE_URL="$TIKSLO_URL" node backend/scripts/dr-restore.mjs \
  run --in zurnalas.json --target "$TIKSLO_URL" --actor "$USER"

# 5. Tik dabar — aplikacijos startas ir srauto perjungimas (cutover)
#    ⚠️ TIK jei §9c grąžino 0. Atskiras patikrinimas:
DATABASE_URL="$TIKSLO_URL" node backend/scripts/dr-restore.mjs verify --target "$TIKSLO_URL"
```

### ⚠️ VIENA jungties forma: `DATABASE_URL` **arba** `PG*`, ne abi

Dokumentuotame Compose diegime `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`
jau nustatyti. Prirašius `DATABASE_URL`, aplinkoje atsiduria **abi** formos, ir
tada klausimas „į kurią bazę jungiamasi" atsakymo NETURI: prioritetas priklauso
nuo to, kas konstruoja pool'ą.

⚠️ **Todėl abi formos kartu yra KLAIDA, ne interpretacijos reikalas.** Suderinimas
krinta su `RECONCILE_CONNECTION_AMBIGUOUS`, kopijos kūrimas — su
`PG_BACKUP_CONNECTION_AMBIGUOUS`, dar prieš pirmą mutaciją. Tas pats sprendimas
repo jau galioja auditui (išmatuota):

```
AUDIT_BACKEND=postgres, bet nustatyti IR DATABASE_URL, IR PGHOST.
```

Tokiame diegime `--target` sudaromas iš tų pačių `PG*` reikšmių, o `DATABASE_URL`
**nenustatomas**:

```bash
# PG* diegimas: jungtis paveldima iš aplinkos, tikslas tik PATIKRINAMAS
node backend/scripts/post-restore-reconcile.mjs \
  run --target "postgres://$PGUSER@$PGHOST:$PGPORT/$PGDATABASE" --actor "$USER"
```

⚠️ **ŠIANDIEN `PG*`-only diegimas suderinimo įvykdyti NEGALI.** Suderinimas
reikalauja bent vienos PostgreSQL ašies (D7); job'ų ašį uždaro 7.2a barjeras
(#281), o sesijų ašis reikalauja **būtent** `DATABASE_URL`
(`sessionStore/backendSelection.js` — `PG*` jam netinka, #282). Todėl komanda
atsisako dirbti su `RECONCILE_BACKEND_NOT_POSTGRES`. Iki #282 uždarymo šis kelias
yra dokumentuotas, bet neprieinamas — riba, ne garantija.

⚠️ Tapatumo patikra abi puses sprendžia **tomis pačiomis taisyklėmis kaip `pg`**:

```
val(key, config) = config[key] || process.env["PG" + KEY] || defaults[key]
```

(`pg/lib/connection-parameters.js:5-17`; `defaults` yra STATINIAI ir aplinkos
neskaito). Todėl DSN be porto reiškia ne „5432", o **„portas iš aplinkos, jei
yra"** — praleistas `PGPORT` nėra numatytoji reikšmė, o paveldėta.

Exit kodai: `0` suderinta (arba nieko nereikėjo) · `1` naudojimo klaida ·
`2` procedūros klaida · `3` (`verify`) **bazė dar NĖRA suderinta** ·
`4` **ašis NEPADENGTA** (darbas atliktas, bet gyvas tos ašies autoritetas ne
PostgreSQL — cutover saugiu vadinti negalima).

### ⚠️ Ką suderinimas užtikrina KIEKVIENAI ašiai atskirai

`DATABASE_URL` buvimas **nėra** backend'o sprendimas: aplikacija saugyklas renkasi
per `jobStore/backendSelection` ir `sessionStore/backendSelection`. Todėl komanda
kiekvienai ašiai praneša verdiktą:

| Verdiktas | Kada | Ką reiškia |
|---|---|---|
| `suderinta` | autoritetas PostgreSQL | darbas atliktas ir **skaitosi į „saugu"** |
| `nereikalinga` | autoritetas atmintyje | prikelti nėra ko: atmintinė būsena restarto neišgyvena |
| `nepadengta` | autoritetas Redis | gyva būsena **lieka ten** ir po starto grįš — exit `4` |

⚠️ **Ašies verdiktas ≠ komandos verdiktas.** Jei NĖ VIENA ašis nėra `suderinta`,
komanda **krenta** (`RECONCILE_BACKEND_NOT_POSTGRES`) prieš pirmą mutaciją:
suderinimas, kuriam nereikia nė vienos ašies, neturi ko patvirtinti, o „sėkmė be
darbo" yra tiksliai tas tylus praleidimas, kurio D7 neleidžia.

⚠️ **Šiandien job'ų ašis niekada nėra `suderinta`:** 7.2a aktyvavimo barjeras
(`POSTGRES_AKTYVAVIMAS_LEISTAS = false`) palieka job'ų autoritetą atmintyje arba
Redis'e. Darbas atkurtoje bazėje vis tiek atliekamas — likusios `queued` eilutės
taptų gyvos tą dieną, kai barjeras atsidarys — bet **verdiktas to saugumu
nevadina**. Žr. §10 ir #281.

⚠️ **`--target` privalo sutapti su `DATABASE_URL`.** Jis nenaudojamas jungtis —
jis TIKRINAMAS: suderinimas dirba su ta baze, prie kurios prisirišusios
saugyklos. Nesutapimas duoda `RECONCILE_TARGET_MISMATCH`, o ne PostgreSQL režimas
— `RECONCILE_BACKEND_NOT_POSTGRES`. Abu krenta **prieš pirmą mutaciją**.

### Ką suderinimas garantuoja

- **Visos atkurtos sesijos revokuojamos.** Ne vieno vartotojo — visos: atkurtoje
  bazėje gyvos sesijos reiškia galiojančius senus cookie.
- **`queued`/`processing` job'ai terminalizuojami** per `jobPhase` autoritetą,
  su `error_code = POST_RESTORE_TERMINALIZED`. Prikėlimo NĖRA: prikelti job'ą
  galima tik žinant, kad jo duomenys neištrinti — tai 7.6c (#250).
- **Viena transakcija.** Sesijos ir job'ai commit'inami kartu; bet kuri klaida
  iki commit'o atsuka VISKĄ. „Sesijos revokuotos, o job'ai ne" būsenos nėra.
- **Idempotentiškumas.** Tą pačią komandą saugu paleisti pakartotinai:
  `revoked_at` nepasislenka, terminaliniai job'ai ir jų rezultatai neliečiami.
- **Terminaliniai įrašai neliečiami.** `failed` lieka semantiškai toks pat,
  `completed` išsaugo `job_results` be pakeitimų.
- **Evidencija tik po sėkmės.** `POST_RESTORE_RECONCILED` rašomas PO commit'o;
  atsuktas suderinimas įrašo nepalieka.

### Ribos (⚠️ ne garantijos)

- **Riba yra PROCEDŪRINĖ, ne invariantas (D2a).** Niekas techniškai nesustabdo
  operatoriaus, paleidusio serverį prieš 3–4 žingsnius. `verify` duoda MAŠININĮ
  atsakymą (exit `3`), bet startas jo nereikalauja. Persistentinė suderinimo žyma
  su starto sargu būtų invariantas, bet ji privalo būti susieta su ŠIA restore
  karta — kitaip žyma pati pakliūtų į kitą kopiją ir atkurtų save. Tai atskiras
  darbas (#279).
- **Job'ai su ištrynimo žyma PRALEIDŽIAMI** ir lieka ne terminaliniai. Rašymas į
  įrašą, kurio ištrynimas jau pretenduotas, yra tiksliai tai, ką barjeras
  draudžia. `verify` juos atskiria: jie NĖRA „nesuderinimas".
- **Audio nevalomas, `storageKey` nekeičiamas** (D10). Terminalizuoti job'ai
  išsaugo nuorodą į savo audio; jei tai palieka orphan'ų klasę, ji sprendžiama ne
  čia.
- **Eilių (BullMQ) rekonstrukcijos nėra** — eksplicitiškai už 7.6b ribų.

---

## 9c. Erasure-safe atkūrimas — 7.6c

⚠️ **KODĖL ATSKIRAS ŽINGSNIS, O NE KOPIJOS DALIS.** Ištrynimų žurnalas privalo
gyventi UŽ snapshot'o ribų. Būdamas jo viduje, jis grįžtų kartu su duomenimis —
t. y. atkūrimas atkurtų ir būseną „ištrynimo nebuvo". Todėl žurnalas
eksportuojamas atskirai, PRIEŠ kiekvieną kopiją.

### Eksportas (kartu su kopijos kadencija)

```bash
node backend/scripts/dr-restore.mjs export --out zurnalas.json --actor "$USER"
```

Artefaktas šifruojamas tuo pačiu AES-256-GCM keliu kaip kopija (7.6a) ir neša
**diegimo tapatybę** (`deployment_identity`). `job_id` plaintext'e nėra: žurnalas
yra asmens duomenys.

⚠️ **Eksporto kadencija IR YRA RPO.** Prarandami ištrynimai, įvykę po paskutinio
eksporto. Numatytoji riba — 24 h; senesnį žurnalą koordinatorius atmeta
(`DR_LEDGER_STALE`).

### Atkūrimo seka

```bash
# 1. Atkūrimas į TUŠČIĄ bazę (§9a) ir schemos patikra (§9b, 1-2 žingsniai)
# 2. Pilna seka: suliejimas → replay → suderinimas → verifikacija
DATABASE_URL="$TIKSLO_URL" node backend/scripts/dr-restore.mjs \
  run --in zurnalas.json --target "$TIKSLO_URL" --actor "$USER"

# 3. Cutover leidžiamas tik po 0 exit kodo
DATABASE_URL="$TIKSLO_URL" node backend/scripts/dr-restore.mjs verify --target "$TIKSLO_URL"
```

Exit kodai: `0` sėkmė · `1` naudojimo klaida · `2` procedūros klaida (fail-closed)
· `3` `verify`: dar NESUDERINTA.

### Ką daro suliejimas (D4)

| Situacija | Sprendimas |
|---|---|
| Žyma tik žurnale | Įrašoma į bazę |
| Abi pusės, viena terminali | **Terminali laimi** — ištrynimas neatšaukiamas |
| Abi neterminalės | Laimi vėlesnis **eksporto** `updatedAt`; lygiosios palieka vietinį |
| `claim_token` žurnale | **Nukerpamas** — pretenzija priklausė mirusiam procesui |
| Kopijų horizontas | Imamas **maksimumas** (monotoniškas) |

### ⚠️ Replay vykdomas prieš ATKURTĄ bazę, ne prieš gyvą autoritetą

7.2a barjeras job'ų autoritetu palieka atmintį arba Redis (`JOB_STORE_BACKEND=postgres`
šiandien yra klaida), o ištrintų žmonių duomenys po atkūrimo guli būtent
PostgreSQL'yje. Todėl koordinatorius `eraseJob()` nukreipia į tikslinę bazę
(`utils/restoredJobStore.js`); be to replay būtų **vakuumas** — `jobs` eilutės
liktų neribotai, o kvitas skelbtų sėkmę.

Nukreipiama TIK įrašo vieta. Audio saugykla, eilė ir auditas yra globalūs
posistemiai, tad juos valo tie patys `eraseJob()` kvietimai, o `storageKey`
imamas iš pačios atkurtos eilutės. Nepilna saugykla atmetama **prieš** pirmą
šalinimą: praleistas metodas reikštų dalinį ištrynimą su sėkmės kvitu.

Po suliejimo replay kiekvienam ID vykdo TĄ PATĮ `jobErasure.eraseJob()`, kurį
naudoja gyvas trynimas. `lifecycleService.deleteJobArtefacts()` čia netinka: jo
trys trumpieji keliai (`tombstone_unresolved`, `already_deleted`, `in_progress`)
po DR pataiko būtent į mūsų atvejį ir job'ą **paliktų**.

### ⚠️ Pasenęs žurnalas: kaip tęsti teisėtai

Sargas turi būti įveikiamas teisėtai, kitaip jį apeis neteisėtai. Radęs
`DR_LEDGER_STALE`, `dr-restore.mjs` išveda **mašininį bloką su tiksliomis
reikšmėmis** ir pakartojamą komandą:

```bash
node backend/scripts/dr-restore.mjs run --in zurnalas.json --target "$TIKSLO_URL" \
  --actor "$USER" --allow-stale
```

Priėmimas visada palieka pėdsaką, ir laikmena priklauso nuo režimo:

| Režimas | Pėdsakas | Klaida be jo |
|---|---|---|
| Įprastas | `DR_STALE_LEDGER_ACCEPTED` audito įrašas | `DR_STALE_OVERRIDE_UNRECORDED` |
| `PRIVACY_MODE` | Operatoriaus patvirtinimas **reikšmėmis** | `DR_STALE_OVERRIDE_UNCONFIRMED` |

`PRIVACY_MODE` režime auditas slopinamas sąmoningai, tad pėdsaku tampa
patvirtinimas: reikia perduoti `--confirm-deployment`, `--confirm-checksum` ir
`--confirm-stale-hours` su reikšmėmis iš išvesto bloko. `--yes` tipo vėliavos
nėra: ji neįrodytų, kad operatorius matė pasenimo dydį.

⚠️ **Patvirtinimas lyginamas VALANDOMIS**, tad jis galioja iki valandos pabaigos.
Milisekundžių tikslumas sargą padarytų neįveikiamą teisėtai.

### ⚠️ Kilmės patikra tikrina DUOMENŲ kilmę, ne aplinką

`deployment_identity` keliauja su dump'u, tad atkurta bazė turi ŠALTINIO
tapatybę — būtent todėl tikra avarija (kitas hostas, tie patys duomenys) praeina
tyliai, o svetimas žurnalas krenta (`ERASURE_FOREIGN_LEDGER`).

Iš to seka dvi ribos, kurias operatorius turi žinoti:

- staging, atkurtas iš produkcijos dump'o, turi **produkcijos** tapatybę, tad
  produkcijos žurnalas jam tinka (duomenys tie patys) — aplinkos apsaugos čia
  **nėra**;
- du klonai iš to paties dump'o turi tą patį ID, tad vieno klono žurnalas
  praeina prieš kitą.

### Auditas po atkūrimo

`audit_log` į kopiją neįtraukiamas (`--exclude-table-data`), tad `ERASURE_REPLAYED`
ir `DR_RECOVERY_COMPLETED` gula į **gyvą** audito saugyklą jau po atkūrimo — jų
dump'e nebus. Kvitai rašomi **be `job_id`**: subjektui susieto įrašo apie ką tik
ištrintą subjektą neįsileistų erasure barjeras (7.4e), o ir jį patį pašalintų
kitas to paties job'o ištrynimas. Per-subjekto įrodymas yra `DATA_ERASED`, kurį
rašo pats `eraseJob()`.

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
| **`pg_dump` atkūrimas vienas NĖRA erasure-safe** | Prikelia po kopijos ištrintus job'us, jei praleistas §9c | Sąmoninga konstrukcija: žurnalas gyvena už snapshot'o |
| **Prarandami ištrynimai po paskutinio eksporto** | Numatytoji kadencija — iki 24 h; rečiau eksportuojant daugiau | Dažnesnis `dr-restore.mjs export` |
| **Kilmės patikra tikrina duomenų, ne aplinkos tapatybę** | Produkcijos žurnalas praeina prieš staging'ą, atkurtą iš produkcijos dump'o | Sąmoninga riba — žr. §9c |
| **`pg_dump` ATKŪRIMAS audito žurnale nefiksuojamas** | Atkūrimo faktas lieka tik operatoriaus runbook'o įraše | Sąmoningas sprendimas, ne spraga — žr. žemiau |
| **Paslapčių skeneris `pg_dump` turiniui netaikomas** | Į kopiją patekusi paslaptis neaptinkama | Sąmoningas sprendimas — žr. žemiau |
| **Su `AUDIT_BACKEND=memory` kūrimo auditas neišlieka** | `PG_DUMP_BACKUP_CREATED` dingsta komandai pasibaigus; komanda įspėja | `AUDIT_BACKEND=postgres` |
| **Post-restore suderinimo riba yra procedūrinė** | Serverį galima paleisti nesuderinus — `verify` yra patikra, ne sargas | Suderinimo žyma su starto patikra (#279) |
| **Užbarjeruoti job'ai lieka ne terminaliniai** | `queued`/`processing` su ištrynimo žyma nekeičiami 7.6b žingsnyje | Uždaro §9c replay, vykdomas PRIEŠ suderinimą |
| **Replay be tikslinės bazės kliento neįmanomas** | `DR_REPLAY_STORE_MISSING` — tylaus grįžimo prie fasado nėra | Sąmoningas fail-closed (7.2a barjeras) |
| **Job'ų autoritetas šiandien nėra PostgreSQL** | 7.2a barjeras: suderinimas job'ų ašiai duoda `nereikalinga`/`nepadengta`, ne `suderinta` | 7.2a aktyvavimo barjero atidarymas (#281) |
| **`PG*`-only diegimas neturi nė vienos PostgreSQL ašies** | `post-restore-reconcile` krenta su `RECONCILE_BACKEND_NOT_POSTGRES` | Sesijų atranka turi priimti `PG*` (#282) |
| **`options`/`search_path` skirtumas = kita bazė** | Vienodi DSN su skirtingu `search_path` laikomi SKIRTINGAIS taikiniais | Sąmoninga fail-closed kryptis |

**Kodėl atkūrimas neaudituojamas.** Rašyti nėra kur: `audit_log` į dump'ą
sąmoningai neįtrauktas, tikslinė bazė tuščia, aplikacija neveikia. Rašymas į kitą
saugyklą reikštų, kad **avarinis atkūrimas priklauso nuo audito prieinamumo** —
fail-closed būtent ten, kur reikia atkurti. Todėl atkūrimas fiksuojamas
operatoriaus runbook'o įrašu, ne audito žurnale.

**Kodėl dump'as neskenuojamas paslapčių.** `backupService` skenuoja aplikacijos
artefaktus — ribotą, politikos filtruotą turinį. Pilnas DB dump'as pagal
apibrėžimą turi **visą** turinį, tad 256 MB SQL skenavimas duotų daugiausia
klaidingų teigiamų ir blokuotų teisėtas kopijas. Riba įvardijama, ne dangstoma.

---

## 11. Ką parodyti auditoriui

✅ Kad kopijos šifruotos (`manifest.encrypted`, algoritmas ir versija).
✅ Kad kopijoje nėra eksportų ir redaguotų variantų (politika kildinama iš registro).
✅ Kad **aplikacijos kopijos** atkūrimas negrąžina ištrintų duomenų — svarbiausia
#20 garantija. ⚠️ **`pg_dump` atkūrimui ji dar NEGALIOJA** (§9a, §10): ištrynimų
replay ateina su 7.6c (#250). Iki tol tai eksplicitinė išimtis, ne nutylėjimas.
✅ Kad kopijų **kūrimas** audituojamas su aktoriumi — ir aplikacijos
(`BACKUP_CREATED`), ir `pg_dump` (`PG_DUMP_BACKUP_CREATED`), **kai audito
saugykla patvari** (`AUDIT_BACKEND=postgres`); su numatytu `memory` įrašas
neišlieka, ir komanda apie tai įspėja. ⚠️ **`pg_dump`
atkūrimas audito žurnale nefiksuojamas** (§10): jis fiksuojamas operatoriaus
runbook'o įrašu.
✅ Kad po atkūrimo **visos senos sesijos revokuotos** ir in-flight job'ai
terminalizuoti (`POST_RESTORE_RECONCILED` su aktoriumi, §9b) — **kai audito
saugykla patvari ir prieinama**. ⚠️ Tomis pačiomis sąlygomis kaip kopijų įvykiai:
su `AUDIT_BACKEND=memory` įrašo neliks, `PRIVACY_MODE=true` režimu eilutės gali
nebūti, o įvykis yra NEBLOKUOJANTIS — tad suderinimas gali pavykti BE jo.
Tokiu atveju evidencija yra operatoriaus runbook'o įrašas, ne audito žurnalas.
⚠️ Pats žingsnis yra **procedūrinis**: `verify` pasako, ar jis atliktas, bet
startas jo nereikalauja (§10).
✅ Retencijos terminą, apibrėžiantį faktinį ištrynimo langą.

❌ **Ne** to, kas konkrečiai kopijoje — manifeste tik tipai ir skaičiai.
