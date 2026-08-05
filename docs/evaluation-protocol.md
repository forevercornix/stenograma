# Kokybės vertinimo protokolas

Šis dokumentas yra issue #23.1 rezultatas. Jis apibrėžia **metodologiją** —
kaip matuosime transkribavimo ir kalbėtojų atskyrimo kokybę.

⚠️ **Protokolas rašomas PRIEŠ matavimą.** Apibrėžus metodiką po to, kai
rezultatai jau matomi, ji neišvengiamai pasirenkama taip, kad rezultatai
atrodytų geriau — net be blogos valios.

- Rezultatai: #23.2
- Sprendimas „ar pilotas gali startuoti": #23.3

---

## 1. Ką matuojame ir ko ne

| Matuojame | Nematuojame |
|---|---|
| Transkribavimo tikslumą (WER, CER) | Protokolo turinio kokybę |
| Kalbėtojų priskyrimo tikslumą | LLM sugeneruotų sprendimų teisingumą |
| Gedimų kategorijas | Naudotojų pasitenkinimą |

⚠️ Protokolo kokybė priklauso nuo transkripcijos, bet **nėra tas pats**. Gera
transkripcija negarantuoja gero protokolo — tai #24 tema.

---

## 2. Metrikos

### WER (Word Error Rate)

```
WER = (pakeitimai + įterpimai + praleidimai) / referenciniai žodžiai
```

**Pagrindinė transkribavimo metrika.** Skaičiuojama nuo **referencinio** teksto
ilgio, ne nuo sistemos išvesties: priešingu atveju daug prigeneravusi sistema
gautų dirbtinai mažesnį skaičių.

⚠️ **WER gali viršyti 100%.** Jei sistema prigeneravo daugiau žodžių, nei jų
buvo, įterpimų yra daugiau nei referencinių žodžių. Reikšmė **neapkerpama** —
tai vienintelis būdas pamatyti, kaip stipriai modelis haliucinuoja.

### CER (Character Error Rate)

**Būtina lietuvių kalbai.** WER laiko „biudžetą" ir „biudžeta" visiškai
skirtingais, nors skiriasi viena raidė.

CER atsako į klausimą, kurio WER neatsako: **ar modelis nesupranta žodžio, ar
tik linksniuoja kitaip.** Pirmasis atvejis protokole rimtas, antrasis — dažnai
ne.

### Kalbėtojų priskyrimo tikslumas

```
tikslumas = teisingai priskirti segmentai / palyginti segmentai
```

⚠️ **Tai NĖRA standartinis DER.** Kanoninis DER (NIST) matuoja **laiko**
proporcijas su „forgiveness collar" riba ir optimaliu susiejimu per Vengrijos
algoritmą.

Mūsų referencinės transkripcijos turi kalbėtojų etiketes **segmentams**, ne
milisekundžių ribas — tad matuojame segmentų priskyrimą.

**Rezultatas nepalyginamas su publikuojamais DER skaičiais**, ir taip turi būti
suprantamas ataskaitose.

Kalbėtojų vardai tarp sistemų nesutampa (`SPEAKER_00` vs `Jonas`), tad ieškoma
**optimalaus susiejimo**: iki 6 kalbėtojų išbandomos visos permutacijos.
Daugiau — godus susiejimas, ir rezultatas gali būti **pesimistinis**;
`mappingMethod` grąžinamas, kad ataskaita tai įvardytų.

⚠️ **Vardiklis — didesnis iš dviejų segmentų skaičių.** Trūkstami (sistema
prarado kalbą) ir pertekliniai (suskaidė per smulkiai) segmentai yra **klaidos**,
ne nutylėjimas.

Priešingu atveju sistema, praradusi pusę segmentų, gautų 100% tikslumą —
pagrindinė metrika sakytų „tobula", o pusė kalbos būtų dingusi.

---

## 3. Normalizavimas

⚠️ **Normalizavimas tiesiogiai keičia WER.** Dvi sistemos, normalizuojančios
skirtingai, duoda **nepalyginamus** skaičius — todėl taisyklės yra
metodologijos dalis, ne techninė smulkmena.

| Taisyklė | Sprendimas | Kodėl |
|---|---|---|
| Mažosios raidės | ✅ taikoma | Didžioji raidė sakinio pradžioje nėra atpažinimo kokybė |
| Skyryba šalinama | ✅ taikoma | Modelis ir žmogus deda ją pagal skirtingas taisykles |
| **Brūkšnelis ir apostrofas žodyje** | ❌ paliekami | Jie yra žodžio dalis („penkiasdešimt-šeši") |
| Tarpai suvienodinami | ✅ taikoma | Formatavimo skirtumas |
| **Diakritikai išlaikomi** | ❌ nešalinami | „Šalis" ir „salis" — skirtingi žodžiai |
| **Skaitmenys nekeičiami** | ❌ nenormalizuojami | Protokole data turi būti teisinga |

Paskutiniai du sprendimai **pablogina** mūsų WER, palyginti su sistemomis,
kurios normalizuoja agresyviau. Tai sąmoninga: skaičius turi atspindėti tai, ką
naudotojas realiai pamatys protokole.

---

## 4. Duomenų rinkinys

### Ką privalo apimti

| Kriterijus | Reikalavimas |
|---|---|
| Kalba | **Lietuvių** — sistema skirta jai |
| Garso kokybė | Švarus **ir** triukšmingas |
| Persidengianti kalba | Privaloma — realiuose posėdžiuose ji nuolatinė |
| Kalbėtojų skaičius | Nuo 2 iki 3+ |
| Trukmė | Trumpi (<5 min) **ir** ilgi (>30 min) |

Papildomos sąlygos, kurias manifestas leidžia pažymėti:

| Sąlyga | Ką reiškia |
|---|---|
| `clean` | Švarus artimas mikrofonas |
| `noisy` | Foninis triukšmas |
| `overlapping_speech` | Persidengianti kalba |
| `far_field` | Nutolęs mikrofonas (salės įrašas) |
| `phone_quality` | Telefono kokybės kanalas |

⚠️ `far_field` ir `phone_quality` yra **didesnės rizikos** sąlygos: jos
tikėtinai duos prastesnius rezultatus, ir jų reikia būtent tam, kad riba būtų
matoma, o ne atrasta pilote.

`assessCoverage()` įvardija trūkstamas kategorijas. **Spragos nestabdo
vertinimo, bet privalo būti ataskaitoje:** vertinimas su vienodais įrašais duoda
tikslų skaičių apie siaurą atvejį ir sukuria įspūdį, kad išmatuota kokybė
apskritai.

### Kūrimo ir galutinis rinkiniai

| Rinkinys | Naudojimas |
|---|---|
| `development` | Derinimui, klaidų analizei, kartotinis |
| `final` | **Vieną kartą**, prieš tai apibrėžus ribas |

⚠️ **Derinimas ant galutinio rinkinio paverstų kokybės vartus savimi
patvirtinančiu ritualu.** Bet kurį rezultatą galima „pagerinti", jei matai
atsakymus.

### Duomenų kilmė

Kiekvienas įrašas privalo turėti vieną iš:

- `synthetic` — sugeneruotas, asmens duomenų nėra
- `consented` — realus įrašas su dokumentuotu sutikimu
- `public_dataset` — viešas rinkinys su leidžiama licencija

⚠️ **Įrašas be aiškios kilmės nenaudojamas.** Vertinimo duomenys gyvena ilgai,
keliauja tarp žmonių ir patenka į ataskaitas — neaiški kilmė čia reiškia
neaiškų teisinį pagrindą.

---

## 5. Privatumas

⚠️ **Repozitorijoje NĖRA nei garso, nei transkripcijų.**

Manifestas aprašo, **kokie** įrašai sudaro rinkinį ir kur jų ieškoti; patys
failai lieka už repozitorijos ribų.

Manifestas turi būti:

- **pakankamas atkuriamumui** — kas, kada, kokiomis sąlygomis vertinta;
- **nepakankamas duomenų atkūrimui** — repozitorija vieša.

⚠️ Tai užtikrinama **griežtu allowlist**, ne vien privalomų laukų sąrašu:
`transcript`, `audioBase64`, `participantNames` ir panašūs laukai **atmetami**,
o nežinomi laukai apskritai neleidžiami.

Failų vieta nurodoma **neasmeniniais** raktais (`storageRef`, `referenceRef`),
kurie neatskleidžia nei vietinio kelio, nei dalyvių.

Manifesto kontrolinė suma leidžia susieti rezultatą su konkrečia rinkinio
versija **neturint pačių failų**.

⚠️ Ji **neįrodo**, kad failai nepakito — tik kad manifestas tas pats. Failų
vientisumas sprendžiamas saugykloje.

---

## 6. Ką fiksuoti kiekvienam matavimui

Be šių duomenų rezultatas neatkuriamas ir su niekuo nepalyginamas:

- tiekėjas ir **modelio versija** (`small`, `large-v3`);
- konfigūracija (kalba, `beam_size`, `device`);
- aparatinė įranga (CPU/GPU, modelis);
- programos versija ir data;
- **manifesto atspaudas** (apima ir `origin`, ir `split`);
- rinkinys (`development` / `final`).

⚠️ **Modelio versija svarbiausia.** `tiny` ir `small` lietuvių kalbai duoda
kokybiškai skirtingus rezultatus — jau patikrinta realiu 4 val. įrašu
(žr. `backend/README.md`).

---

## 7. Palyginamumo taisyklės

1. **Visi tiekėjai vertinami tais pačiais įrašais.** Skirtingi rinkiniai duoda
   nepalyginamus skaičius.
2. **Tos pačios normalizavimo taisyklės** visiems.
3. **Ta pati manifesto versija** — kitaip lyginami skirtingi uždaviniai.
4. **Rezultatai mašininiu formatu**, kad regresiją būtų galima palyginti
   automatiškai.

---

## 8. Ko šis protokolas NEAPIMA

- Tobulos transkripcijos garantijos
- Visų kalbų, tarmių ar įrašymo sąlygų
- Domeno eksperto peržiūros pakeitimo
- Parametrų derinimo atskiriems įrašams
- Visų prieinamų tiekėjų palyginimo
- Nuolatinio kokybės stebėjimo produkcijoje
- Automatinio modelio parinkimo pagal rezultatus

### S/I/D skaidymo riba

⚠️ Levenšteino matricoje gali būti **keli vienodo minimalaus atstumo keliai**.
Bendras WER visada teisingas, bet S/I/D pasiskirstymas priklauso nuo pasirinktos
tie-break taisyklės (sutapimas → pakeitimas → įterpimas → praleidimas).

Skaidymas **deterministinis**, bet ne vienintelis galimas. Gedimų analizėje
(#23.2) juo galima remtis kaip tendencija, ne kaip vieninteliu teisingu
skirstiniu.

---

## 9. Ko šis protokolas NEAPIMA

⚠️ **Kokybės vartai matuoja įvestį, ne rezultatą.** Gera transkripcija yra
būtina, bet nepakankama gero protokolo sąlyga.
