# Ištrynimo ir retencijos garantijos

Šis dokumentas yra GDPR issue #19 rezultatas. Jis skirtas tam, kas **eksploatuoja**
sistemą ir turi atsakyti į klausimus: „ar duomenys tikrai ištrinti", „kiek jie
saugomi" ir „ką rodyti auditoriui".

Techninis modelis aprašytas [`artefact-lifecycle.md`](artefact-lifecycle.md);
čia – garantijos ir jų ribos.

---

## 1. Ką ištrynimas garantuoja

`DELETE /api/jobs/:id` ir `DELETE /api/transcribe-jobs/:id` per vieną
koordinuotą operaciją pašalina:

| Artefaktas | Kur gyveno |
|---|---|
| Jobo įrašas | jobStore (atmintis arba Redis) |
| Transkripcija ir protokolas | jobo įrašo viduje |
| Šaltinio audio | failų saugykla |
| Eilės įrašas su payload'u | BullMQ / Redis |
| Audito įrašai, susieti su subjektu | audito žurnalas |

**Patvirtinimas:** `204 No Content`. Nepilno ištrynimo atveju – `503` su
kategorijų sąrašu, o **jobas paliekamas**, kad užklausą būtų galima pakartoti.

✅ Po ištrynimo jobo įrašas nebus atnaujintas – nei rezultatu, nei būsena.
✅ Naujas darbas tuo pačiu ID nebus pradėtas.
✅ Pakartotinis ištrynimas nėra klaida ir duoda tą pačią galutinę būseną.

### ⚠️ Ištrynimo žymos išgyvena restartą – **diegimuose su `DATABASE_URL`** (nuo [7.5a])

Iki 7.5a žymos gyveno tik proceso atmintyje, ir tai buvo įrašyta 2 skyriuje kaip
apribojimas. Nuo 7.5a jos saugomos `erasure_marks` lentelėje, tad:

✅ žyma **išgyvena restartą** – po jo vėluojanti eilės žinutė ištrintam jobui
   artefaktų nesukurs;
✅ žyma **bendra visoms replikoms** – barjeras galioja visame diegime, ne viename
   procese;
✅ barjeras aktyvus nuo **pirmojo ištrynimo žingsnio** (`deletion_pending`), ne tik
   po patvirtinto ištrynimo, ir **nepavykęs** ištrynimas jo **nenuima**;
✅ žyma **neišnyksta anksčiau**, nei job'as nebegali būti prikeltas: terminas
   išvedamas iš faktinių eilės prikėlimo horizontų ir kopijų retencijos, ne
   parenkamas.

⚠️ **Ši garantija galioja TIK ten, kur nustatytas `DATABASE_URL`.** Be jo sistema
sąmoningai grįžta į atmintinį režimą – žr. 2 skyrių. Startas tokiu atveju garsiai
įspėja.

---

## 2. Ko ištrynimas NEGARANTUOJA

Šis sąrašas svarbesnis už pirmąjį: jis apibrėžia, ko **negalima** teigti
auditoriui.

⚠️ **Jau vykdomas processor'ius nesustabdomas vidury.** Iki pirmojo įrašo į jobą
jis gali spėti iškviesti išorinį tiekėją arba parašyti laikiną failą. Rezultatas
į jobą nepateks, bet tarpiniai pėdsakai gali likti, kol juos surinks retencija.

⚠️ **Ištrynimo žymos neišgyvena restarto – BE `DATABASE_URL`.** Atmintiniame
režime jos gyvena tik proceso atmintyje ir nėra bendros replikoms: po restarto
vėluojanti eilės žinutė ištrintam jobui vėl galėtų kurti artefaktus.

Su `DATABASE_URL` šio apribojimo **nebėra** (žr. 1 skyrių, [7.5a]). Apribojimas
paliktas **sąlyginis**, o ne pašalintas: besąlygiškas pašalinimas būtų melagingas
teiginys atmintiniam režimui, kuris tebėra palaikomas ir numatytasis desktop
diegime.

⚠️ **Laikini failai (`upload_temp`, `conversion_temp`) dar neskenuojami.** Jie
turi išnykti patys, bet po kritimo gali „pakibti" iki retencijos ciklo.

⚠️ **Trečiųjų šalių tiekėjai.** Kas nutinka duomenims, jau išsiųstiems į LLM ar
transkribavimo tiekėją, priklauso nuo jų politikos ir sutarties, ne nuo šios
sistemos. Redakcija (#4) mažina, ką jie apskritai gauna, bet ištrynimo iš jų
pusės negarantuoja.

⚠️ **Atsarginės kopijos.** Žr. skyrių 5.

⚠️ **Nuosavybės patikrų nėra** (#18): rolė sprendžia, kokius veiksmus galima
atlikti, bet ne su kieno duomenimis.

---

## 3. Retencija

| Nuostata | Numatyta | Ką valdo |
|---|---|---|
| `JOB_TTL_MINUTES` | 60 | Kiek jobo įrašas gyvena po užbaigimo |
| `AUDIO_RETENTION_HOURS` | 24 | Šaltinio audio saugykloje |
| `AUDIT_RETENTION_DAYS` | 30 | Audito žurnalo įrašai |
| `RETENTION_SWEEP_INTERVAL_MINUTES` | 5 | Kas kiek tikrinama |
| `DELETION_TOMBSTONE_TTL_HOURS` | 72 | Kiek galioja ištrynimo žyma |

✅ **Šios reikšmės tikrinamos automatiškai.** CI lygina šią lentelę su
`backend/.env.example`; išsiskyrus jos, testas krinta. Tad dokumentu galima
remtis planuojant retenciją – jis negali tyliai pasenti.

**Faktinis šalinimas gali vėluoti iki vieno valymo intervalo.** `JOB_TTL_MINUTES=60`
su 5 min intervalu reiškia, kad įrašas dings per 60–65 min, ne tiksliai per 60.

Valymas paleidžiamas **iškart po starto**, ne po pirmojo intervalo – be to po
restarto pasenę duomenys liktų dar visą valandą.

⚠️ `DELETION_TOMBSTONE_TTL_HOURS` **privalo viršyti** ilgiausią eilės įrašo
gyvavimo trukmę (BullMQ užbaigtus jobus laiko iki 24 val.). Priešingu atveju
vėluojanti žinutė ateitų jau po žymos galiojimo.

---

## 4. Auditas ir ištrynimo kvitas

Kiekvienas ištrynimas palieka **du** pėdsakus:

**Kvitas** (`DATA_ERASED`) – be subjekto identifikatoriaus, tik kategorijos:
`queue=deleted storage=none audit=12`. Jis lieka **po** to, kai subjekto įrašai
pašalinti, tad įrodo, kad ištrynimas įvyko, neatkurdamas to, kas ištrinta.

**Gyvavimo ciklo įrašas** (`LIFECYCLE_DELETION`) – aktorius, rezultatas, laikas
ir kategorijų skaičiai.

### Ką galima parodyti auditoriui

✅ Kad ištrynimas įvyko, kada ir kieno iniciatyva.
✅ Kurios kategorijos pašalintos, kurios liko.
❌ **Ne** tai, kas konkrečiai buvo ištrinta – turinio audite nėra sąmoningai.

⚠️ Audito įrašai saugo **pseudonimizuotą** subjekto ID, ne žalią. Ieškant pagal
jobo ID reikia tos pačios `pseudonymizeIdentifier` funkcijos – tiesioginė teksto
paieška nieko neras.

---

## 5. Sąveika su atsarginėmis kopijomis (#20)

⚠️ **Šis modelis atsarginių kopijų nepasiekia.**

Ištrynimas veikia gyvoje sistemoje: jobStore, saugykla, eilės, auditas. Jei
duomenys pateko į atsarginę kopiją **prieš** ištrynimą, jie ten liks iki tos
kopijos galiojimo pabaigos.

Praktinės pasekmės:

- Ištrynimo užklausa **nesukelia** atsarginių kopijų perrašymo.
- Atkūrus iš kopijos, ištrinti duomenys **grįžtų** – ir žymos jų nebesustabdytų,
  nes jos irgi neišgyvena restarto.
- Kriptografinis ištrynimas per raktų valdymą (per-job encryption keys) yra
  **už #19 ribų** ir priklauso [#20](https://github.com/forevercornix/stenograma/issues/20).

**Ką daryti tuo tarpu:** riboti atsarginių kopijų retenciją tiek, kiek leidžia
veiklos poreikiai, ir dokumentuoti tą terminą privatumo politikoje kaip
maksimalų faktinį ištrynimo langą.

---

## 6. Logai, metrikos ir pėdsakai

Ištrynimo įvykiai patenka į:

- **Logus** – `component=lifecycle`, su `status` ir `complete`, be kelių ir raktų
- **Auditą** – žr. skyrių 4
- **HTTP atsakymą** – tik kategorijos

⚠️ **Atsakymuose ir loguose nėra failų kelių, saugyklos raktų, Redis raktų,
tiekėjų atsakymų ar ištrinto turinio.** Iki #19 abu DELETE maršrutai grąžindavo
klaidų tekstus tiesiai klientui, o juose būna kelių ir raktų.

Koreliacijai naudojamas `X-Request-Id` (#17): jis sujungia užklausą, eilę,
worker'į ir ištrynimo įvykius, neatskleisdamas turinio.

---

## 7. Eksploatacijos veiksmai

**Patikrinti, ar ištrynimas pilnas:**

```bash
curl -X DELETE https://<host>/api/jobs/<jobId> -i
# 204 = pilnas
# 503 = dalinis, kartokite; atsakyme bus kategorijos
```

**Pakartoti nepavykusį ištrynimą:** ta pati užklausa. Ji idempotentiška ir
tęsia nuo ten, kur sustota – žyma lieka `deletion_failed`, kol pavyks.

**Jei kartojimas nepadeda** (`nonRetryable` kategorijos): reikia žmogaus.
Dažniausios priežastys – teisių problemos saugykloje ar sugadintas failas.
Klaidos tekstas yra **serverio loguose**, ne atsakyme.

---

## 8. Reguliarios patikros

| Kas | Kaip dažnai | Kodėl |
|---|---|---|
| Ar retencijos valymas veikia | Kas savaitę | Tylus sustojimas nepastebimas – įrašai tiesiog kaupiasi |
| Ar `DELETION_TOMBSTONE_TTL_HOURS` > eilės retencijos | Keičiant BullMQ nuostatas | Priešingu atveju atsiranda atkūrimo langas |
| Atsarginių kopijų retencija | Ketvirčiui | Ji apibrėžia faktinį ištrynimo langą |
| `LIFECYCLE_DELETION` įrašai su `status != deleted` | Kas savaitę | Daliniai ištrynimai, kurių niekas nepakartojo |
