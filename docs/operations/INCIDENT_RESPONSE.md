# Incidentų valdymo runbook

Šis dokumentas yra issue #21 rezultatas. Jis skirtas **pilotinio diegimo
operatoriui** — ne saugumo skyriui ir ne teisininkui.

Pilotinėje stadijoje svarbu ne tai, ar pavyks išvengti kiekvieno gedimo, o tai,
ar komanda jį **greitai atpažins** ir sureaguos **neatskleisdama daugiau
duomenų** ir **neprarasdama įrodymų**.

Operacinės procedūros (kaip išsaugoti įrodymus, patikrinti atkūrimą, ką
stebėti): [`OPERATIONAL_PROCEDURES.md`](OPERATIONAL_PROCEDURES.md).

⚠️ **Prieš bet kokį restartą** perskaitykite ten esantį įrodymų išsaugojimo
skyrių: audito žurnalas gyvena tik atmintyje.

Susiję dokumentai:
- Ištrynimo garantijos: [`../deletion-guarantees.md`](../deletion-guarantees.md)
- Kopijų ir atkūrimo runbook: [`../backup-runbook.md`](../backup-runbook.md)
- Autentifikacija ir rolės: [`../auth-deployment.md`](../auth-deployment.md)

---

## 1. Atsakomybės

⚠️ Įvardytos **rolės, ne asmenys** — pilote juos dažnai atlieka tas pats žmogus,
o dokumentas su konkrečiais vardais pasensta pirmiau nei bet kuri jo dalis.

| Rolė | Ką sprendžia |
|---|---|
| **Piloto savininkas** | Koordinuoja incidentą, sprendžia dėl piloto stabdymo, eskaluoja duomenų valdytojui, komunikuoja su klientu |
| **Duomenų valdytojo įgaliotas atsakingas** | Priima sprendimą dėl pranešimo priežiūros institucijai ir duomenų subjektams |
| **Techninis atsakingas** | Sulaikymas, įrodymų išsaugojimas, atkūrimas, techninė analizė |

Tas pats žmogus pilote gali atlikti kelias roles, tačiau **kiekvienas sprendimas
turi būti užfiksuotas nurodant, kurios rolės įgaliojimu jis priimtas.**

Taip techninis skubumas nelemia pranešimo sprendimo, o pranešimo neapibrėžtumas
nestabdo sulaikymo — ir postmortem metu matyti, kas ką sprendė.

---

## 2. Incidentų klasės

| Klasė | Signalas, nuo kurio pradėti tyrimą |
|---|---|
| Įtariama neteisėta prieiga | Netikėti `AUTHORIZATION_DENIED` audite; prisijungimai neįprastu metu |
| Nutekėjęs kredencialas | Raktas repozitorijoje, loguose, pokalbyje ar ekrano nuotraukoje |
| Duomenys išsiųsti neleistinam tiekėjui | `LLM_PROVIDER`/`TRANSCRIPTION_PROVIDER` neatitinka sutarto |
| Nepavykęs ar nepilnas ištrynimas | `LIFECYCLE_DELETION` su `status != deleted` |
| Netikėtas originalo eksportas | `export:original` naudojimas be pagrindo |
| Jautrūs duomenys loguose | Transkripcijos fragmentai, vardai, keliai logų sraute |
| Worker, Redis ar eilės gedimas | `/api/ready` grąžina 503; darbai nejuda |
| Disko išnaudojimas ar užstrigę darbai | Darbai `processing` ilgiau nei tikėtasi |
| Sugadinta ar nepilna išvestis | Protokolai be turinio; klaidos generuojant |
| Skaitytuvo radinys, reikalaujantis skubaus taisymo | CodeQL ar `npm audit` HIGH/CRITICAL |

⚠️ **Vienas signalas savaime nepatvirtina incidento.** Jis inicijuoja
klasifikavimą ir poveikio vertinimą. `AUTHORIZATION_DENIED` gali būti paprasta
naudotojo klaida, o skaitytuvo `HIGH` — nepasiekiamame dev priklausomybių
kelyje.

---

## 3. Skubumo lygiai

Lygis nurodo **reagavimo prioritetą**, ne techninį sudėtingumą. Paprastas
gedimas gali būti kritinis, o sudėtingas — žemas.

⚠️ **Ką reiškia „reaguoti".** Terminas skaičiuojamas iki incidento
**pripažinimo**, atsakingo asmens **paskyrimo** ir **pirmojo sulaikymo veiksmo
pradžios** — ne iki galutinio išsprendimo. Priešingu atveju du žmonės tą patį
lygį suprastų skirtingai, ir abu manytų, kad teisingai.

### 🔴 Kritinis — reaguoti **nedelsiant (<15 min)**

- Aktyvi neteisėta prieiga
- Viešai ar neleistinoje vietoje **atskleistas** kredencialas (nelaukiant, ar jis panaudotas)
- Duomenys išsiųsti neleistinam tiekėjui
- Patvirtintas asmens duomenų atskleidimas

### 🟠 Aukštas — reaguoti **per 1 val.**

- Nepavykęs ištrynimas, liečiantis asmens duomenis
- Netikėtas originalo eksportas
- Keli vienu metu vykstantys paslaugos gedimai, darantys poveikį pilotiniams naudotojams

### 🟡 Vidutinis — **tą pačią darbo dieną**

- Worker ar Redis gedimai
- Tiekėjo nepasiekiamumas
- Užstrigusi apdorojimo eilė

### 🟢 Žemas — **kitą planinį priežiūros langą**

- Dokumentacijos klaidos
- Smulkūs operaciniai trūkumai be saugumo ar privatumo poveikio

⚠️ **Abejojant rinkitės aukštesnį lygį.** Sumažinti lygį vėliau pigu; pakelti
jį po to, kai įrodymai jau prarasti — nebeįmanoma.

---

## 4. Reagavimo eiga

Visi incidentai eina tą pačią eigą. Žingsnių tvarka **nėra atsitiktinė**.

```
1. Aptikti ir klasifikuoti
2. Sulaikyti tolesnį poveikį
3. Išsaugoti privatumą saugančius įrodymus
4. Įvertinti saugumo ir privatumo poveikį
5. Atkurti paslaugas
6. Patikrinti atkūrimą prieš grįžtant į normalų darbą
7. Atlikti peržiūrą po incidento
```

### Pradinis įrašas

Pradėjus reagavimą **iškart** užfiksuokite:

- **incidento ID** (pvz. `INC-2026-08-04-01`);
- pirmojo signalo laiką;
- kas incidentą aptiko;
- pradinį skubumo lygį;
- paveiktą aplinką;
- incidento koordinatorių;
- jau atliktus sulaikymo veiksmus.

⚠️ **Be bendro ID** auditai, logai, komunikacija ir vėlesnis postmortem lieka
nesusieti — o incidento metu jų sujungti atgaline data būna sunkiausia.

### Kodėl sulaikymas eina PRIEŠ įrodymų išsaugojimą

Kol poveikis tęsiasi, kiekviena minutė prideda naujų paveiktų duomenų. Bet
sulaikymas turi būti **grįžtamas** ir **nenaikinantis**: išjungti tiekėją,
atšaukti raktą, sustabdyti įkėlimus — taip, ištrinti logus ar perkurti aplinką
— ne.

### Kodėl atkūrimo patikra yra atskiras žingsnis

„Paslauga vėl veikia" ir „paslauga veikia teisingai" nėra tas pats. Po
incidento gali likti išjungta privatumo kontrolė, neveikiantis auditas ar
tiekėjas, grąžinantis šiukšles — ir tai pasimatytų tik po savaitės.

---

## 5. Sulaikymo veiksmai

Žemiau esantys veiksmai parinkti taip, kad **nepašalintų incidento įrodymų**.

Kai įmanoma, naudojami **grįžtami** veiksmai. Viena išimtis sąmoninga:
kompromituoto kredencialo atšaukimas tiekėjo konsolėje **negrįžtamas** — seno
rakto paprastai nebeaktyvuosite. Tai teisingas sulaikymas, bet apie jį reikia
žinoti iš anksto.

### Išjungti išorinius tiekėjus

```bash
# .env – išjungti išorinius tiekėjus (mock/disabled režimas)
LLM_PROVIDER=mock
TRANSCRIPTION_PROVIDER=mock
DIARIZATION_PROVIDER=none
```

**Prieš restartą užfiksuokite aktyvių ir laukiančių darbų sąrašą.**

⚠️ **Konfigūracijos pakeitimas nepakeičia jau veikiančių procesų.** Perkraukite
**visus**, kurie patys inicijuoja tiekėjo kvietimus — įskaitant atskirus worker
konteinerius, jei jie veikia atskirai.

⚠️ **Eilėje esantys darbai po VISŲ worker procesų perkrovimo turėtų būti
vykdomi nauja konfigūracija** — jei tiekėjas parenkamas darbo **vykdymo**, ne
kūrimo metu. Prieš atnaujinant eilę tai patikrinkite konkrečioje diegimo
versijoje.

Aktyviai vykdomi darbai vertinami **atskirai**: kvietimas tiekėjui gali jau būti
išsiųstas.

⚠️ Jau **išsiųstų** duomenų tai negrąžina. Kas su jais nutinka, priklauso nuo
tiekėjo politikos ir sutarties.

⚠️ Mock režimas **nesustabdo įkėlimo priėmimo** ir lokalaus duomenų saugojimo —
tik siuntimą į išorę.

⚠️ **Tai SULAIKYMO režimas, ne normalus paslaugos režimas.** Rezultatai bus
sintetiniai (mock LLM ir transkripcija) arba funkcija išjungta (diarizacija).
Jų **negalima pateikti naudotojams kaip tikrų** — priešingu atveju sulaikymas
sukurtų naują incidentą: „sugadinta ar nepilna išvestis".

### Sustabdyti prieigą

⚠️ **ĮKĖLIMŲ IŠJUNGIMO JUNGIKLIO NĖRA.** Sistema neturi `UPLOADS_ENABLED` ar
panašios nuostatos. Vienintelis būdas sustabdyti naujus darbus — **atimti
prieigą**.

⚠️ **`API_KEY_ROLE=operator` NESUSTABDO įkėlimų.** Operatoriaus rolė **turi**
`job:create` ir `export:redacted`; ji netenka tik `job:delete` ir
`export:original`. Šis pakeitimas apriboja **ištrynimą ir originalo eksportą**,
ne duomenų priėmimą.

**Kas realiai sustabdo prieigą:**

```bash
# 1. Pašalinti vartotojus iš sesijų mechanizmo
AUTH_USERS=

# 2. IR pašalinti bendrą raktą – kitaip jis lieka veikiantis
API_KEY=
```

Perkrauti. Abu žingsniai **būtini**: sistema palaiko abu autentifikacijos
mechanizmus lygiagrečiai, tad vien `AUTH_USERS` išvalymas palieka `API_KEY`
kelią atvirą.

⚠️ Produkcijoje (`NODE_ENV=production`) be nė vieno mechanizmo endpoint'ai
grąžina **503** — tai ir yra sustabdymas. Dev režime be jų sistema
**praleidžia visas užklausas**, tad ten šis metodas **neveikia**.

> **Follow-up:** tikras įkėlimų/eksportų jungiklis (`UPLOADS_ENABLED`,
> `EXPORTS_ENABLED`) yra atskiro darbo tema. Kol jo nėra, šis skyrius sąžiningai
> aprašo, ką sistema **realiai** gali.

### Atšaukti kredencialą

| Kredencialas | Veiksmas |
|---|---|
| `API_KEY` | Pakeisti reikšmę ir perkrauti **visus** ją skaitančius procesus |
| `AUTH_USERS` | Sugeneruoti naujus slaptažodžių maišus (`scripts/hash-password.js`), pakeisti sąrašą, perkrauti |
| **Kopijų šifravimo raktai** | ⚠️ **Tik pagal** [`../backup-runbook.md`](../backup-runbook.md) — išsaugoti palaikomą ankstesnį raktą, kitaip prarasite atkūrimo galimybę |
| **Išoriniai tiekėjų raktai** | **Atšaukti tiekėjo konsolėje**, tada pakeisti reikšmę |



⚠️ Išorinės paslapties **neužtenka pakeisti konfigūracijoje** — senasis raktas
lieka galiojantis, kol jo neatšauksite pas tiekėją.

Incidento metu svarbu žinoti **kuriuos** raktus atšaukti, ne kiek jų yra.
Aktualų sąrašą su rotacijos veiksmais visada rasite
`backend/utils/secretsInventory.js`.

### Sustabdyti worker'ius

**Prieš stabdant užfiksuokite aktyvių darbų būseną** — po sustabdymo jos
nebematysite.

**Pirmiausia nustatykite, kuriuose servisuose veikia darbus vykdantys procesai:**

```bash
docker compose ps      # servisai ir jų būsena
docker compose top     # kokie procesai realiai veikia kiekviename
```

`docker compose ps` parodo servisus, bet ne tai, ką jie vykdo — `top` leidžia
pamatyti, kuriame realiai sukasi worker'is.

Tada sustabdykite **visus** darbus vykdančius servisus:

```bash
# Įrašykite realų Compose serviso vardą
WORKER_SERVICE="worker"

# Siunčia SIGTERM ir laukia nurodytą laiką
docker compose stop -t 120 backend "$WORKER_SERVICE"
```

⚠️ **`docker compose stop backend` gali nepaliesti atskirų worker konteinerių.**
Jei BullMQ worker'iai paleisti atskiru servisu, jie liks veikti ir toliau ims
darbus iš eilės.

⚠️ **`-t 120` yra laukimo LANGAS, ne garantija.** Transkribavimas gali trukti
gerokai ilgiau nei 120 s; pasibaigus laikui Docker procesą nutraukia
**priverstinai**, ir grakštus uždarymas nebeįvyksta.

Ilgiems darbams:

**BullMQ režime** galima pirmiausia sustabdyti naują prieigą, palikti
worker'ius veikti ir laukti, kol aktyvių darbų liks nulis.

⚠️ **Inline režime tokio „drain" nėra.** Prieigos sustabdymas reikalauja
pakeisti `.env` ir **perkrauti backend'ą**, o tai inline režime **nutraukia
aktyvų darbą**. Prieš restartą užfiksuokite darbo būseną ir apsispręskite pagal
incidento riziką: skubus sulaikymas ar leisti darbui pasibaigti.

⚠️ **Elgsena PRIKLAUSO NUO REŽIMO — ir jos nėra vienodos.**

| Režimas | Kas nutinka vykdomam darbui |
|---|---|
| **BullMQ** (`REDIS_URL` nustatytas) | Worker turi SIGTERM apdorojimą ir **laukia vykdomo darbo pabaigos** (`workers/index.js`). Eilėje laukiantys darbai **išlieka** |
| **Inline** (be Redis) | `server.js` SIGTERM **neapdoroja** — vykdomas darbas **nutraukiamas**. Eilės nėra, tad laukiantys darbai prarandami |

⚠️ **Nenaudokite `kill -9` nė viename režime.** Nutraukus procesą vidury, jobas
lieka `processing` būsenoje, o jo audio gali likti saugykloje — atsiranda
„pakibęs" darbas, kurį reikia tvarkyti rankomis.

Eilės vykdymo konfigūracijos klausimas paaiškintas aukščiau („Išjungti
išorinius tiekėjus") — čia jis nekartojamas, kad neatsirastų dvi skirtingo
griežtumo formuluotės.

---

## 6. Komunikacija ir eskalavimas

| Situacija | Kas informuojamas | Kada |
|---|---|---|
| Kritinis incidentas | Piloto savininkas | Nedelsiant, dar sulaikymo metu |
| Patvirtintas asmens duomenų atskleidimas | Piloto savininkas + duomenų valdytojas | Nedelsiant |
| Aukštas | Piloto savininkas | Per 1 val. |
| Vidutinis / žemas | Įrašoma; aptariama planiniame susitikime | — |

### Ką rašyti pranešime

✅ Kas nutiko, kada pastebėta, koks poveikis, kokių veiksmų imtasi.
✅ Ar asmens duomenys paveikti — **arba** kad tai dar tiriama.

❌ **Ne** dokumentų turinį, transkripcijų fragmentų, vardų ar raktų.

⚠️ **Nepatvirtintų teiginių venkite.** „Duomenys nenutekėjo" ankstyvoje
stadijoje dažnai virsta klaidinga informacija — tikslesnis variantas yra
„poveikis dar vertinamas".

---

## 7. GDPR pranešimo vertinimas

⚠️ **Ne kiekvienas incidentas reikalauja pranešimo.** Šis skyrius padeda
apsispręsti, o ne pakeičia teisinę konsultaciją.

Vertinama trimis klausimais:

1. **Ar tai asmens duomenų saugumo pažeidimas?** Ar buvo neteisėtas
   atskleidimas, praradimas ar pakeitimas?
2. **Ar tikėtina rizika asmenų teisėms?** Susitikimų įrašai dažnai turi jautrų
   turinį, tad rizika greičiau bus, nei nebus.
3. **Ar rizika didelė?** Nuo to priklauso, ar pranešti **ir patiems asmenims**.

| Vertinimas | Veiksmas |
|---|---|
| Ne pažeidimas | Įrašoma vidiniame žurnale |
| Pažeidimas, rizika mažai tikėtina | Įrašoma; pranešimas institucijai gali būti nereikalingas |
| Pažeidimas su rizika | **Duomenų valdytojas ar jo įgaliotas atsakingas** sprendžia dėl pranešimo priežiūros institucijai; taikomas BDAR **72 val.** terminas |
| Didelė rizika | **Duomenų valdytojas** papildomai vertina pranešimą duomenų subjektams |

⚠️ **72 val. terminas skaičiuojamas nuo momento, kai duomenų valdytojas turi
pagrįstą tikrumą, kad įvyko asmens duomenų saugumo pažeidimas** — ne nuo tada,
kai jau galutinai nustatytas visas jo mastas, ir **ne** nuo pirmo nepatvirtinto
techninio signalo.

Pirminį įtarimą reikia tirti **nedelsiant** ir užfiksuoti jo gavimo laiką.
Neaiškumas dėl paveiktų asmenų skaičiaus ar visų aplinkybių **nėra pagrindas**
laukti galutinės tyrimo išvados — pranešimą galima papildyti etapais.

⚠️ **Sprendimą dėl pranešimo priima duomenų valdytojas ar jo įgaliotas
atsakingas asmuo.** Pagal BDAR 33 str. atsakomybė tenka **valdytojui**; piloto
savininko pareigybės pavadinimas savaime nesuteikia teisės spręsti jo vardu.

Šis dokumentas padeda **paruošti** vertinimą, bet jo nepakeičia ir už jį
neatsako.

---

## 8. Ko šis runbook NEAPIMA

- Pilnos SOC ar SIEM sistemos
- Teisinės konsultacijos konkrečiai jurisdikcijai
- Automatinės viešos statuso komunikacijos
- Budėjimo 24/7
- Automatizuoto incidentų orkestravimo
- Skaitmeninės ekspertizės, viršijančios operacinį įrodymų išsaugojimą

⚠️ Šiame dokumente **nėra ir negali būti** tikrų paslapčių, asmens duomenų ar
vidinių kredencialų. Jis skirtas viešai repozitorijai.
