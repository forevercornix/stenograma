# Operacinės incidentų procedūros

Šis dokumentas tęsia [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md): ten
aprašyta **kas ir kada**, čia — **kaip**.

Po incidento:
[`POSTMORTEM_AND_EXERCISES.md`](POSTMORTEM_AND_EXERCISES.md) — peržiūros
šablonas, pratybos ir žinomų ribų santrauka.

Skirtas pilotinio diegimo operatoriui.

Kode minimi endpoint'ai, audito įvykiai ir sistemos elgsenos teiginiai
**tikrinami CI**. Shell komandų veikimas priklauso nuo aplinkos ir automatiškai
nevykdomas — juos patikrinkite savo diegime prieš incidentą, ne jo metu.

⚠️ **Komandos parašytos Linux shell (bash) aplinkai su Docker Compose** — taip,
kaip diegiama pilote. Kitose aplinkose (Windows PowerShell, macOS su BSD
įrankiais) `grep`, `sed` ir `date` elgesys skiriasi.

---

## 1. Įrodymų išsaugojimas

### ⚠️ Kritinė riba, kurią būtina žinoti iš karto

**Audito žurnalas gyvena tik atmintyje.** Jis **nerašomas į diską**. Tai
reiškia:

- **restartas jį ištrina visą**;
- `docker compose restart` incidento metu **sunaikina įrodymus**;
- procesui nukritus jie prarandami be jokio pėdsako.

**Todėl auditą būtina išsaugoti PRIEŠ bet kokį restartą** ar kitą veiksmą,
naikinantį atminties būseną.

⚠️ Tai **nereiškia**, kad negalima anksčiau atlikti **nenaikinančio** sulaikymo:
atšaukti tiekėjo raktą, uždaryti prieigą tinklo lygiu ar atjungti išorinį
integraciją galima ir reikia iš karto, jei poveikis tęsiasi.

Draudžiama tik tai, kas **ištrina atminties būseną** — restartas, perkūrimas,
`docker compose down`.

### Žingsnis 1: išsaugoti auditą

```bash
# Administratoriaus sesija arba x-audit-key
curl --fail-with-body --show-error --silent -b cookies.txt \
  "https://<host>/api/audit?limit=1000" \
  -o "incident-audit-$(date -u +%Y%m%dT%H%M%SZ).json"

echo "curl kodas: $?"   # 0 = pavyko; kitaip failas NEGALIOJA
```

⚠️ **Be `--fail-with-body` `curl` tyliai išsaugo ir klaidos atsakymą.** Gavus
401, 403 ar 500 failas atrodytų sukurtas, o jame būtų klaidos JSON — ir
operatorius manytų, kad auditas išsaugotas.

**Patikrinkite failą prieš laikydami jį įrodymu:**

```bash
head -c 200 incident-audit-*.json
```

Kartokite su `offset`, kol grąžinama mažiau įrašų nei `limit`.

⚠️ Audito įrašai turi **pseudonimizuotą** `subjectId`, ne žalią jobo ID.
Ieškant konkretaus jobo reikia tos pačios `pseudonymizeIdentifier` funkcijos —
tiesioginė teksto paieška nieko neras.

### Žingsnis 2: išsaugoti sistemos būseną

```bash
curl --fail-with-body --show-error --silent "https://<host>/api/health/deep" \
  -o "incident-health-$(date -u +%Y%m%dT%H%M%SZ).json"

docker compose ps > "incident-services-$(date -u +%Y%m%dT%H%M%SZ).txt"

# BE --since: paimami VISI turimi logai
docker compose logs --no-color \
  > "incident-logs-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

⚠️ **`--since` naudokite tik sąmoningai.** `--since 24h` paima **tik**
paskutines 24 val. — jei incidentas prasidėjo anksčiau, dalies įrodymų
tiesiog nebus, o failas atrodys pilnas.

Intervalą trumpinkite tik tada, kai **žinote** incidento pradžią ir logų
apimtis yra problema:

```bash
# Pavyzdys: incidentas prasidėjo prieš ~3 dienas
docker compose logs --no-color --since 72h > incident-logs.txt
```

⚠️ Docker saugo logus pagal savo rotacijos nustatymus. Jei jie riboti,
**seniausių įrašų gali nebūti nepriklausomai nuo `--since`** — tai patikrinkite
pirmiausia.

⚠️ **Logai gali turėti asmens duomenų.** Juos saugokite tokioje pat apsaugotoje
vietoje kaip ir pačius duomenis, ir taikykite tą pačią retenciją.

### Žingsnis 3: užfiksuoti konfigūraciją BE paslapčių

```bash
# Skaito PATĮ .env failą; reikšmių neatskleidžia
awk -F= '/^[A-Z_][A-Z0-9_]*=/ {
  name = $1
  sub(/^[^=]*=/, "")
  gsub(/^[ \t]+|[ \t]+$/, "")
  gsub(/^"|"$/, "")
  print name "=" (length($0) ? "<nustatyta>" : "<tuščia>")
}' .env > "incident-config-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

⚠️ **Ši komanda rodo `.env` FAILO būseną**, o ne tai, su kokiomis reikšmėmis
realiai paleisti veikiantys konteineriai. Jie galėjo būti paleisti anksčiau, su
kita `.env` versija arba su `environment:` reikšmėmis iš `docker-compose.yml`.

Norėdami užfiksuoti **veikiančio** konteinerio konfigūraciją (irgi be reikšmių):

```bash
docker compose exec backend printenv \
  | awk -F= '/^[A-Z_][A-Z0-9_]*=/ { print $1 "=" (length($2) ? "<nustatyta>" : "<tuščia>") }' \
  > "incident-runtime-config-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

⚠️ **Niekada nekopijuokite `.env` failo į incidento įrašus.** Jame yra tikros
paslaptys, o incidento medžiaga dažnai keliauja per el. paštą ir pokalbius.

### Ko NEDARYTI

| Veiksmas | Kodėl |
|---|---|
| `docker compose restart` prieš išsaugant auditą | **Sunaikina visą audito žurnalą** |
| `docker compose down -v` | Ištrina Redis duomenis ir eilę |
| Trinti „nereikalingus" jobus | Jie gali būti incidento įrodymas |
| Perkurti aplinką iš naujo | Prarandama viskas, kas leistų suprasti priežastį |
| Redaguoti logus „kad būtų aiškiau" | Įrodymų vientisumas dingsta |

---

## 2. Atkūrimo patikra

**„Paslauga vėl veikia" ir „paslauga veikia teisingai" nėra tas pats.**

Po incidento gali likti išjungta privatumo kontrolė, neveikiantis auditas ar
tiekėjas, grąžinantis šiukšles — ir tai pasimatytų tik po savaitės.

### Patikros seka

Vykdyti **iš eilės**. Nepavykus bet kuriam žingsniui — negrįžti į normalų darbą.

**1. Konfigūracija atkurta**

```bash
curl -s "https://<host>/api/health" | grep -o '"llmProvider":"[^"]*"'
```

Patikrinkite, kad tiekėjai **nebe `mock`**, jei sulaikymo metu buvo perjungti.

⚠️ Šis žingsnis dažniausiai pamirštamas: sistema veikia, bet grąžina
**sintetinius** rezultatus.

**2. Autentifikacija veikia**

```bash
# Be kredencialų – turi būti 401 (arba 503, jei mechanizmai dar nepridėti)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<host>/api/jobs" \
  -H "Content-Type: application/json" -d '{"transcript":"testas"}'
```

**3. Rolės veikia**

Prisijunkite operatoriaus paskyra ir patikrinkite, kad originalo eksportas
grąžina **403**. Jei grąžina 200 — RBAC neveikia.

**4. Auditas rašomas**

```bash
curl -s -b cookies.txt "https://<host>/api/audit?limit=5"
```

Turi būti matomi **nauji** įrašai su dabartiniais laikais.

**5. Ištrynimas veikia**

Sukurkite testinį jobą, ištrinkite jį ir patikrinkite, kad `DELETE` grąžina
**204**, o vėlesnis `GET` — **404**.

**6. Darbai realiai apdorojami**

Sukurkite testinį jobą ir palaukite, kol pasieks `completed`. Užstrigimas ties
`processing` reiškia, kad worker'iai neveikia, nors `/api/health` rodo `ok`.

### Baigiamoji taisyklė

⚠️ **Jei bent vienas žingsnis nepraeina — incidentas nelaikomas uždarytu.**

Paslaugą galima grąžinti naudotojams tik tada, kai **visi šeši** žingsniai
praėjo. Dalinis rezultatas reiškia, kad kažkuri kontrolė neveikia — ir tai
pasimatys vėliau kaip naujas incidentas, kurio priežastis atrodys nesusijusi.

### Ką užrašyti

Kiekvieno žingsnio **rezultatą ir laiką**. Be to vėliau neįmanoma atsakyti,
ar patikra buvo atlikta, ar tik suplanuota.

---

## 3. Operacinės metrikos

⚠️ **Automatinio metrikų rinkimo pilotinėje versijoje nėra.** Žemiau — ką
galima pamatyti turimomis priemonėmis.

| Ką stebėti | Kur | Ką reiškia nukrypimas |
|---|---|---|
| Paslaugos būsena | `/api/health` | `degraded` — kažkuris komponentas neveikia |
| Priklausomybės | `/api/health/deep` | Redis, saugykla, tiekėjai |
| Atmestos užklausos | Auditas: `UPLOAD_REJECTED` | Formatas, dydis ar validacija |
| Atmesta prieiga | Auditas: `AUTHORIZATION_DENIED` | Klaida arba bandymas viršyti teises |
| Nepavykę darbai | Auditas: `JOB_EXECUTION_DENIED` | Revokacija arba priežiūros užraktas |
| Nepilni ištrynimai | Auditas: `LIFECYCLE_DELETION` su `status != deleted` | **Reikalauja pakartojimo** |
| Retencijos valymas | Auditas: `RETENTION_PURGE` | Jei nutrūko — duomenys kaupiasi |
| Kopijų būklė | Auditas: `BACKUP_CREATED`, `BACKUP_RESTORE_FAILED` | Žr. [`../backup-runbook.md`](../backup-runbook.md) |

### Kas verta reguliaraus žvilgsnio

| Kas | Kaip dažnai | Kodėl |
|---|---|---|
| `LIFECYCLE_DELETION` su `status != deleted` | Kas savaitę | Daliniai ištrynimai, kurių niekas nepakartojo |
| `RETENTION_PURGE` buvimas | Kas savaitę | Tylus valymo sustojimas nepastebimas |
| `AUTHORIZATION_DENIED` dažnio pokytis | Kas savaitę | Staigus šuolis — arba klaida, arba zondavimas |
| `/api/health/deep` | Kasdien | Anksti parodo tiekėjų problemas |

⚠️ **Audito retencija priklauso nuo `AUDIT_BACKEND`.**

- **`memory`** (numatytasis): audito retencija — 30 d. pagal
  `AUDIT_RETENTION_DAYS`. Senesnių įvykių analizei reikia iš anksto išsaugotų
  kopijų.
- **`postgres`**: `AUDIT_RETENTION_DAYS` **NEGALIOJA** – `audit_log` eilutės
  automatiškai nešalinamos, ir lentelė auga neribotai (persistentinę retenciją
  įgyvendina [7.4d]). Startas įspėja `warn` lygiu.

  **Operatoriaus veiksmas:** iki 7.4d reikalinga IŠORINĖ valymo politika.
  Priešingu atveju asmens duomenys audite išliks neribotai, nors konfigūracijoje
  matoma 30 dienų reikšmė – tiesioginė GDPR saugojimo ribojimo rizika.

---

## 4. Klaidingi teiginiai ir neteisingos diagnozės

Ne kiekvienas signalas yra incidentas. Šie atvejai **atrodo** kaip incidentai,
bet dažniausiai jais nėra.

| Signalas | Dažniausia nekalta priežastis | Kaip atskirti |
|---|---|---|
| `AUTHORIZATION_DENIED` serija | Operatorius bando administratoriaus veiksmą | Ar tas pats aktorius? Ar veiksmas atitinka jo rolę? |
| 401 po diegimo | Sesijos nutrūko dėl restarto | Ar sutampa su diegimo laiku? |
| Darbai „užstrigę" | Ilgas įrašas apdorojamas normaliai | Ar `processing` trukmė proporcinga įrašo ilgiui? |
| `/api/ready` grąžina 503 | Startas dar nebaigtas | Ar praeina po 30–60 s? |
| Nepavykęs ištrynimas su `ENOENT` | Failas jau buvo išvalytas retencijos | `already_absent` — tai **sėkmė**, ne gedimas |
| `npm audit` HIGH dev priklausomybėje | Nepasiekiama produkcijoje | Ar tai `devDependency`? Ar kelias pasiekiamas? |
| Kopija atkurta „ankstesniu raktu" | Vyksta raktų rotacija | Ar sutampa su planine rotacija? |

### Kaip elgtis abejojant

⚠️ **Klasifikuokite aukščiau, tirkite ramiai.** Sumažinti lygį po patikrinimo
pigu; pakelti jį po to, kai įrodymai jau prarasti — nebeįmanoma.

Bet **klaidingas teigimas irgi turi kainą**: jei kiekvienas signalas taps
incidentu, komanda išmoks juos ignoruoti. Todėl kiekvieną klaidingą teigimą
**užrašykite** — tai leidžia ateityje atskirti greičiau.

---

## 5. Ko šios procedūros NEAPIMA

- Automatinio metrikų rinkimo ir aliarmų
- Centralizuoto logų kaupimo
- Audito žurnalo išsaugojimo tarp restartų
- Automatinės incidentų klasifikacijos
- Skaitmeninės ekspertizės

⚠️ Svarbiausia riba: **auditas neišgyvena restarto**. Kol tai nepakeista,
įrodymų išsaugojimas yra **rankinis pirmas žingsnis**, o ne kažkas, ką galima
padaryti vėliau.
