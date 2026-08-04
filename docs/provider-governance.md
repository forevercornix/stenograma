# Tiekėjų inventorius ir diegimo privatumo sąrašas

Šis dokumentas yra issue #22.1 rezultatas. Jis atsako į vieną klausimą:
**kokia yra mūsų tiekėjų politika.**

Kaip ji vykdoma techniškai — #22.2. Kaip apsaugota nuo regreso — #22.3.

⚠️ **Techniškai veikiantis tiekėjas gali būti netinkamas pilotui** dėl duomenų
vietos, retencijos, naudojimo modelių mokymui, subtiekėjų ar sutartinių
apribojimų. Šis dokumentas skiria vieną nuo kito.

---

## 1. Kertinė taisyklė

⚠️ **NEŽINOMA SAVYBĖ NIEKADA NEREIŠKIA PATVIRTINIMO.**

Tiekėjas, apie kurio retenciją nieko nežinome, **nėra** „tikriausiai
tvarkingas" — jis yra **nepatvirtintas**, kol duomenų valdytojas eksplicitiškai
nenusprendžia kitaip.

Priešingas numatytasis elgesys reikštų, kad **neišsamus dokumentavimas
automatiškai suteikia leidimą** — o tai tiksliai atvirkščiai, nei reikia.

---

## 2. Pasitikėjimo lygiai

Kiekviena savybė pažymėta vienu iš trijų:

| Lygis | Ką reiškia |
|---|---|
| `verified` | **Patikrinta šiame projekte** — kode arba testais |
| `assumed` | Pagrįsta prielaida iš viešos informacijos, **nepatikrinta** |
| `unknown` | Nežinoma. Traktuojama kaip **nepatvirtinta** |

⚠️ **`unknown` ≠ „nesaugu".** Jis reiškia tik tiek, kad **šis projektas savybės
netikrino**. Tiekėjas gali būti visiškai tvarkingas — bet apie tai turi
nuspręsti tas, kas patikrino, ne numatytoji reikšmė.

⚠️ `assumed` šiame projekte nenaudojamas sąmoningai: neturime nė vienos
savybės, kurią galėtume sąžiningai vadinti pagrįsta prielaida. Lygis paliktas
**konkrečiam diegimui**, kur operatorius, perskaitęs sutartį, jį užpildys.

⚠️ **Visų išorinių tiekėjų savybės čia pažymėtos `unknown`.** Tai nėra spraga,
kurią reikia užpildyti spėjimais — tai **tiksli šio projekto būklė**. Įrašyti
`verified` be realaus patikrinimo reikštų teigti neverifikuotas sutartines
garantijas.

Konkretaus diegimo operatorius, patikrinęs tiekėjo sutartį, šias reikšmes
užpildo **savo aplinkoje**.

---

## 3. Transkribavimo tiekėjai

| Tiekėjas | Apdorojimas | Siunčiama | Tiekėjas | Patvirtinimas |
|---|---|---|---|---|
| `mock` | 🟢 lokalus | — | — | nereikalingas |
| `faster-whisper-embedded` | 🟢 lokalus | — | — | nereikalingas |
| `faster-whisper-server` | 🟢 lokalus | — | — | nereikalingas |
| `faster-whisper` | 🟢 lokalus | — | — | nereikalingas |
| `whisper` | 🔴 išorinis | **garso failas** | OpenAI | **reikalingas** |
| `azure` | 🔴 išorinis | **garso failas** | Microsoft Azure | **reikalingas** |
| `google` | 🔴 išorinis | **garso failas** | Google Cloud | **reikalingas** |
| `deepgram` | 🔴 išorinis | **garso failas** | Deepgram | **reikalingas** |

⚠️ `faster-whisper` yra **aliasas**, parenkantis vieną iš dviejų profilių
(`embedded` arba `server`). Abu lokalūs, tad politikos požiūriu skirtumo nėra.

⚠️ Išoriniai transkribavimo tiekėjai gauna **visą garso įrašą** — tai
jautriausia duomenų kategorija sistemoje. Jame yra viskas: vardai, balsai,
šalutiniai pokalbiai.

## 4. Diarizacijos tiekėjai

| Tiekėjas | Apdorojimas | Siunčiama | Tiekėjas | Patvirtinimas |
|---|---|---|---|---|
| `none` | 🟢 išjungta | — | — | nereikalingas |
| `inline` | 🟢 lokalus | — | — | nereikalingas |
| `mock` | 🟢 lokalus | — | — | nereikalingas |
| `pyannote` | 🟢 lokalus | — | — | nereikalingas |
| `pyannote-cloud` | 🔴 išorinis | **garso failas** | pyannote.ai | **reikalingas** |
| `assemblyai` | 🔴 išorinis | **garso failas** | AssemblyAI | **reikalingas** |

⚠️ `inline` reiškia, kad naudojama **transkribavimo tiekėjo** diarizacija —
atskiro siuntimo nėra, bet galioja to tiekėjo savybės.

## 5. LLM tiekėjai

| Tiekėjas | Apdorojimas | Siunčiama | Tiekėjas | Patvirtinimas |
|---|---|---|---|---|
| `mock` | 🟢 lokalus | — | — | nereikalingas |
| `claude` | 🔴 išorinis | **transkripcija** | Anthropic | **reikalingas** |
| `gpt` | 🔴 išorinis | **transkripcija** | OpenAI | **reikalingas** |
| `gemini` | 🔴 išorinis | **transkripcija** | Google | **reikalingas** |

⚠️ LLM tiekėjai gauna **transkripcijos tekstą**, ne garsą. Įjungus redakciją
(#4), jiems siunčiamas **redaguotas** variantas — bet tai atskira nuostata,
kurią reikia įjungti sąmoningai.

---

## 6. Kokie artefaktai siunčiami

| Artefaktas | Kam gali būti siunčiamas |
|---|---|
| `source_audio` | Išoriniams transkribavimo ir diarizacijos tiekėjams |
| `transcript` | Išoriniams LLM tiekėjams |
| `transcript_redacted` | Išoriniams LLM tiekėjams, kai redakcija įjungta |
| `protocol` | **Niekam** — generuojamas ir lieka sistemoje |
| `export_*` | **Niekam** — atsisiunčiami naudotojo |

Artefaktų apibrėžimai: [`artefact-lifecycle.md`](artefact-lifecycle.md).

---

## 7. Privatumo režimai ir leidžiami tiekėjai

| Režimas | Išoriniai tiekėjai | Kada naudoti |
|---|---|---|
| `standard` | Leidžiami **su patvirtinimu** | Įprastas pilotas |
| `local_only` | ❌ **Draudžiami** | Jautrūs įrašai, kurie negali išeiti |

⚠️ `local_only` **nėra** tik rekomendacija — jis blokuoja išorinius tiekėjus
techniškai (#22.2).

### Patvirtinimas

Išorinis tiekėjas leidžiamas **tik** įrašius jį į:

```bash
APPROVED_EXTERNAL_PROVIDERS=claude,whisper
```

⚠️ Šis sąrašas **įgyvendina** jau priimtą duomenų valdytojo sprendimą — jis jo
**neįrodo**.

Kodas negali atskirti apgalvoto sprendimo nuo neatsargaus `.env` pakeitimo:
įrašius `claude`, tiekėjas leidžiamas net tada, kai DPA nepasirašyta, regionas
nepatikrintas, o retencija nežinoma.

**Todėl `.env` failas nėra atitikties įrodymas.** Sprendimas turi būti
užfiksuotas atskirai — kas, kada ir kokiu pagrindu patvirtino (žr. kontrolinį
sąrašą §8).

Be šio įrašo išorinis tiekėjas **neveiks**, net jei raktas nustatytas.

---

## 8. Diegimo privatumo kontrolinis sąrašas

Pildoma **prieš** kiekvieną pilotinį diegimą. Kiekvienam punktui — ne tik
„taip/ne", bet ir **kas tai patvirtino**.

### Autentifikacija

- [ ] `AUTH_USERS` arba `API_KEY` nustatytas
- [ ] Produkcijoje `NODE_ENV=production`
- [ ] Rolės atitinka realius vartotojus (#18)

### Privatumo režimas

- [ ] Pasirinktas režimas (`standard` / `local_only`) ir **užrašyta, kodėl**
- [ ] Jei `local_only` — patikrinta, kad visi tiekėjai lokalūs

### Tiekėjai

- [ ] Kiekvienas išorinis tiekėjas įrašytas į `APPROVED_EXTERNAL_PROVIDERS`
- [ ] **Kiekvienam** iš jų yra DPA ar lygiavertis susitarimas
- [ ] Užrašyta, kas ir kada patvirtino
- [ ] Patikrinta tiekėjo **regiono** nuostata (jei tiekėjas ją turi)
- [ ] Patikrinta, ar tiekėjas **nenaudoja duomenų modelių mokymui**

⚠️ Paskutiniai du punktai yra **operatoriaus atsakomybė** — šis projektas jų
netikrino.

### Retencija

- [ ] `AUDIO_RETENTION_HOURS`, `JOB_TTL_MINUTES`, `AUDIT_RETENTION_DAYS`
      nustatyti sąmoningai
- [ ] `BACKUP_RETENTION_DAYS` atitinka privatumo politikoje deklaruotą
      ištrynimo langą (#20)

### Eksportai

- [ ] Nuspręsta, ar originalo eksportas leidžiamas (`EXPORT_ALLOW_ORIGINAL`)
- [ ] Jei ne — patikrinta, kad redakcijos komponentas veikia

### Logai

- [ ] Patikrinta, kad logai nepatenka į išorines sistemas be sprendimo
- [ ] Žinoma Docker logų rotacijos nuostata (#21)

### Kopijos

- [ ] Nuspręsta, ar kopijos įjungtos (`BACKUP_ENABLED`)
- [ ] Jei taip — `BACKUP_ENCRYPTION_KEY` nustatytas ir saugomas **atskirai**

### Incidentai

- [ ] Žinoma, kas yra duomenų valdytojo įgaliotas atsakingas (#21)
- [ ] Kontaktai užrašyti ir pasiekiami **ne tik** toje pačioje sistemoje

---

## 9. Ko šis dokumentas NEDARO

| Nedaro | Kodėl |
|---|---|
| Netvirtina, kad tiekėjai atitinka BDAR | Tai teisinis vertinimas, ne techninis |
| Netikrina tiekėjų sutarčių | Už šio projekto ribų |
| Neseka tiekėjų politikos pokyčių | Reikia rankinės peržiūros |
| Nepakeičia duomenų valdytojo sprendimo | Techninė kontrolė ≠ teisinė atitiktis |

⚠️ **Techninė kontrolė nėra teisinė atitiktis.** Šis dokumentas padeda
apsispręsti ir užfiksuoti sprendimą, bet jo nepriima.
