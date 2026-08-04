# Peržiūra po incidento ir pratybos

Šis dokumentas užbaigia incidentų valdymo rinkinį:

- [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) — **kas ir kada**
- [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) — **kaip**
- šis dokumentas — **ką darome po to** ir **kaip pasiruošiame iš anksto**

---

## 1. Kada rašoma peržiūra

| Skubumo lygis | Peržiūra |
|---|---|
| 🔴 Kritinis | **Privaloma** |
| 🟠 Aukštas | **Privaloma** |
| 🟡 Vidutinis | Jei kartojasi arba atskleidė ribą |
| 🟢 Žemas | Neprivaloma |

Taip pat **privaloma**, jei incidentas atskleidė, kad runbook'as buvo
neteisingas — tokia peržiūra vertingesnė už bet kurią kitą.

⚠️ **Peržiūra rašoma per 5 darbo dienas.** Vėliau detalės prarandamos, o
atsiminimai tampa rekonstrukcija.

---

## 2. Peržiūros šablonas

Kopijuokite ir pildykite. Skyriai, kurių neužpildote, **paliekami su
paaiškinimu**, kodėl — tuščias skyrius ir sąmoningai praleistas atrodo
vienodai, o reiškia visai kitką.

```markdown
# Peržiūra po incidento: INC-YYYY-MM-DD-NN

## Santrauka

Kas nutiko, vienu sakiniu. Be techninių detalių.

## Poveikis

- Ar asmens duomenys paveikti: taip / ne / tirta ir nenustatyta
- Ar buvo pranešta priežiūros institucijai: taip / ne / nereikėjo
- Paslaugos prastova: <trukmė arba „nebuvo">
- Paveikti naudotojai: <skaičius arba „nenustatyta">

⚠️ Šiame dokumente NERAŠOMI dokumentų turinio fragmentai, vardai ar raktai.

## Laiko juosta (UTC)

| Laikas | Įvykis |
|---|---|
| | Pirmas signalas |
| | Incidentas pripažintas |
| | Pirmas sulaikymo veiksmas |
| | Įrodymai išsaugoti |
| | Priežastis nustatyta |
| | Paslauga atkurta |
| | Atkūrimo patikra baigta |

## Kaip aptikta

Kas pastebėjo ir kaip. Ar tai buvo automatinis signalas, naudotojo pranešimas,
ar atsitiktinis radinys?

⚠️ Jei aptikta atsitiktinai — tai savarankiškas radinys. Reiškia, kad stebėjimas
šios klasės incidento nemato.

## Priežastis

Kas realiai sukėlė incidentą. Ne „žmogiška klaida" — kokia sistemos savybė
leido tai klaidai virsti incidentu.

## Kas veikė gerai

Ką verta išlaikyti. Šis skyrius NĖRA mandagumas: jei kontrolė suveikė, tai
reikia žinoti, kad kitą kartą jos nepašalintume kaip „nereikalingos".

## Kas neveikė

- Kas užtruko ilgiau, nei turėjo
- Kur runbook'as buvo neteisingas ar nepilnas
- Kokių įrodymų trūko

## Veiksmai

| Veiksmas | Atsakingas | Terminas | Būsena |
|---|---|---|---|

⚠️ Veiksmas be atsakingo ir termino yra pageidavimas, ne veiksmas.

## Ar reikia keisti runbook'ą

- [ ] Ne
- [ ] Taip — kokį skyrių ir kodėl

⚠️ Jei incidento metu vykdėte veiksmą, kurio runbook'e nebuvo, **jį reikia
įrašyti**. Kitą kartą tai darys kitas žmogus.
```

---

## 3. Kas peržiūroje NERAŠOMA

| Nerašoma | Kodėl |
|---|---|
| Dokumentų turinio fragmentai | Peržiūra keliauja plačiau nei duomenys |
| Naudotojų vardai ar el. paštai | Tas pats |
| Raktai, slaptažodžiai, `.env` reikšmės | Peržiūros dažnai saugomos ilgiau nei incidentas |
| Kaltinimai konkretiems žmonėms | Slopina pranešimą apie kitus incidentus |

⚠️ **Peržiūra be kaltinimų nėra mandagumo taisyklė.** Jei žmonės tikisi
kaltinimų, jie pradeda pranešti vėliau — ir kitas incidentas bus aptiktas
lėčiau.

---

## 4. Pratybos

Runbook'as, kuris niekada nebuvo išbandytas, **nėra patikrinta procedūra**.

⚠️ Ta pati logika kaip su kopijomis: kopija, kuri niekada nebuvo atkurta, nėra
atkūrimo mechanizmas (žr. [`../backup-runbook.md`](../backup-runbook.md)).

### Ką verta išbandyti

| Pratybos | Kaip dažnai | Ką patikrina |
|---|---|---|
| **Įrodymų išsaugojimas** | Ketvirčiui | Ar komandos veikia jūsų aplinkoje; ar auditas eksportuojamas |
| **Prieigos sustabdymas** | Ketvirčiui | Izoliuotoje `NODE_ENV=production` aplinkoje: ar `AUTH_USERS` + `API_KEY` pašalinimas duoda **503** |
| **Atkūrimo patikra** | Ketvirčiui | Ar visi šeši žingsniai vykdomi ir suprantami |
| **Kopijos atkūrimas** | Ketvirčiui | Žr. [`../backup-runbook.md`](../backup-runbook.md) |
| **Rakto atšaukimas** | Metams | Ar žinote, kur tiekėjo konsolėje tai daroma. ⚠️ Tik **testinis** kredencialas — produkcinių raktų pratyboms neatšaukiama |

### Kaip vykdyti

**Pratybos vykdomos ne gyvoje produkcijos aplinkoje.** Naudokite atskirą aplinką
su testiniais duomenimis.

⚠️ **Bet prieigos sustabdymo pratyboms ta aplinka privalo būti paleista su
`NODE_ENV=production`.** Dev režime, pašalinus `AUTH_USERS` ir `API_KEY`,
sistema užklausas **praleidžia** su `administrator` teisėmis — pratybos parodytų
priešingą rezultatą, ir operatorius klaidingai paskelbtų saugumo gedimą.

1. Pasirinkite scenarijų iš incidentų klasių sąrašo
2. Vykdykite runbook'ą **neatsiminimais, o skaitydami**
3. Fiksuokite, kur sustojote ar suabejojote
4. Kiekvieną tokią vietą taisykite dokumente

⚠️ **Svarbiausias pratybų rezultatas — ne „pavyko", o sąrašas vietų, kur
runbook'as neaiškus.** Sklandžios pratybos, po kurių nieko nepataisyta,
dažniausiai reiškia, kad vykdyta iš atminties, ne pagal dokumentą.

### Pratybų įrašas

Užtenka kelių eilučių:

```markdown
# Pratybos: <data>, scenarijus: <klasė>

Dalyvavo: <rolės>
Trukmė: <laikas>

Kas nesuveikė iš karto:
-

Runbook pakeitimai:
-
```

⚠️ **Pratybų įraše neturi būti dokumentų turinio** — net testinio, jei jis
sukurtas iš tikrų įrašų.

---

## 5. Žinomos incidentų valdymo ribos

Šios ribos galioja **visiems** trims dokumentams. Jos nėra trūkumai, kuriuos
reikia paslėpti — jos apibrėžia, ko iš šio rinkinio **negalima tikėtis**.

| Riba | Poveikis incidento metu |
|---|---|
| **Auditas gyvena tik atmintyje** | Jį būtina išsaugoti **prieš restartą** ar kitą atminties būseną naikinantį veiksmą; nenaikinantis sulaikymas gali vykti anksčiau |
| **Įkėlimų jungiklio nėra** | Priėmimą stabdo tik abiejų autentifikacijos mechanizmų pašalinimas, ir tik produkcijoje |
| **Dev režime apsaugos nėra** | Ten prieigą reikia atimti tinklo ar konteinerio lygiu |
| **Inline režime nėra grakštaus sustabdymo** | Aktyvus darbas nutraukiamas; „drain" negalimas |
| **Automatinių aliarmų nėra** | Aptikimas priklauso nuo rankinės peržiūros arba naudotojo pranešimo |
| **Centralizuoto logų kaupimo nėra** | Logai gyvena konteineriuose ir priklauso nuo Docker rotacijos |
| **Budėjimo 24/7 nėra** | Reagavimo terminai galioja darbo laiku |
| **Automatinės klasifikacijos nėra** | Skubumo lygį nustato žmogus |

⚠️ **Svarbiausia iš jų — audito trumpalaikiškumas.** Jis lemia ne tik tai, ką
turėsite po incidento, bet ir **veiksmų tvarką jo metu**.

Tiksli taisyklė (ta pati kaip
[`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) §1):

- auditą būtina išsaugoti **prieš bet kokį restartą**, konteinerių perkūrimą ar
  kitą atminties būseną naikinantį veiksmą;
- **aktyvų poveikį galima ir reikia nedelsiant sulaikyti** grįžtamais, įrodymų
  nenaikinančiais veiksmais — rakto atšaukimu, tinklo prieigos uždarymu.

⚠️ Tai **nėra** taisyklė „auditas visada pirmas". Vykstant aktyviai
eksfiltracijai laukti audito eksporto būtų klaida.

---

## 6. #21 apimties patikra

Ką šis rinkinys apima:

| Reikalavimas | Kur |
|---|---|
| Incidentų klasifikacija | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §2 |
| Skubumo lygiai ir terminai | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §3 |
| Reagavimo eiga | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §4 |
| Sulaikymas | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §5 |
| Komunikacija ir eskalavimas | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §6 |
| GDPR pranešimo vertinimas | [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) §7 |
| Įrodymų išsaugojimas | [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) §1 |
| Atkūrimo patikra | [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) §2 |
| Operacinės metrikos | [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) §3 |
| Klaidingi teiginiai | [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md) §4 |
| Peržiūros šablonas | šis dokumentas §2 |
| Pratybos | šis dokumentas §4 |
| Žinomos ribos | šis dokumentas §5 |

Ko sąmoningai **nėra** (pagal issue „Out of scope"): SOC/SIEM, teisinė
konsultacija, automatinė viešoji komunikacija, budėjimas 24/7, automatinis
orkestravimas, skaitmeninė ekspertizė.
