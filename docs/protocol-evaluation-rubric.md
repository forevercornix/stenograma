# Protokolo vertinimo metodika

Šis dokumentas yra issue #24.1 rezultatas. Jis atsako į klausimą: **kaip
matuojame protokolo kokybę.**

- Rezultatai: #24.2
- Sprendimas dėl piloto: #24.3

⚠️ **Protokolas nėra transkripcija.** #23 matuoja, ar žodžiai atpažinti
teisingai; čia matuojama, ar **prasmė** perteikta teisingai. Sistema gali turėti
nepriekaištingą WER ir vis tiek generuoti protokolą su išgalvotu nutarimu.

---

## 1. Kodėl rubrika, o ne automatinė metrika

WER skaičiuojamas mechaniškai: tekstas arba sutampa, arba ne.

Protokolo kokybė tokia **nėra**. „Jonas parengs ataskaitą iki penktadienio" ir
„Jonas pažadėjo ataskaitą savaitės gale" gali reikšti tą patį arba visai kitką —
priklausomai nuo to, kas realiai pasakyta.

Todėl vertina **žmogus, bet pagal iš anksto apibrėžtus kriterijus.** Skirtumas
esminis abiem kryptimis:

- „Man atrodo neblogai" **nėra vertinimas** — jo negalima nei pakartoti, nei
  palyginti.
- Automatinė metrika **neaptiktų prasmės iškraipymo** — sklandus tekstas jai
  atrodo teisingas.

---

## 2. Vertinimo dimensijos

| Dimensija | Į ką atsako |
|---|---|
| `factual_correctness` | Ar teiginiai atitinka tai, kas pasakyta? |
| `completeness` | Ar nepraleisti sprendimai ir užduotys? |
| `no_unsupported_additions` | Ar nepridėta to, ko įraše nebuvo? |
| `attribution` | Ar užduotys priskirtos teisingiems žmonėms? |
| `temporal_accuracy` | Ar terminai ir datos teisingi? |
| `traceability` | Ar svarbius teiginius galima atsekti? |

⚠️ **Dimensijos nesujungiamos į vieną balą.** Protokolas su viena išgalvota
užduotimi ir protokolas su praleista pastraipa yra **visiškai skirtingos
problemos**, nors bendras balas galėtų sutapti.

---

## 3. Klaidų sunkumas

⚠️ **Ne visos klaidos lygios.** Neteisingai užrašytas pavadinimas taisomas per
sekundę; išgalvotas nutarimas gali lemti sprendimą, kurio niekas nepriėmė.

| Sunkumas | Svoris | Ką reiškia |
|---|---|---|
| `critical` | 100 | Keičia prasmę arba sukuria neįvykusį faktą |
| `major` | 10 | Praleista ar iškraipyta reikšminga informacija |
| `minor` | 2 | Netikslumas, kurį matyti, bet kuris neklaidina |
| `cosmetic` | 0,5 | Stiliaus ar formatavimo pastaba |

**Svoriai netiesiniai sąmoningai.** Tiesinė skalė leistų „kompensuoti"
išgalvotą nutarimą tvarkingu formatavimu.

⚠️ **Balo negalima lyginti tarp skirtingo ilgio protokolų.** Trisdešimties
minučių ir penkių valandų susitikimas gali turėti tą patį balą, nors klaidų
tankis visiškai skirtingas.

Balas skirtas **vieno protokolo** priėmimo sprendimui, ne modelių reitingavimui.

### Kritinė klaida yra veto

⚠️ **Viena kritinė klaida reiškia, kad protokolas netinkamas** — nepriklausomai
nuo bendro balo ir nuo to, kiek visa kita tvarkinga.

Balų riba viena to negarantuotų: ilgame, kitur nepriekaištingame protokole
kritinė klaida „prasprūstų".

⚠️ **Veto taikomas PIRMIAU nei balų riba.** Radus kritinę klaidą, balas
apskaičiuojamas ir pateikiamas, bet sprendimo nekeičia.

---

## 4. Atsekamumas

### Teiginių kilmė

| Kilmė | Ką reiškia |
|---|---|
| `transcript_derived` | Tiesiogiai atsekamas iki įrašo fragmento |
| `model_inference` | Modelio išvada — logiška, bet nepasakyta tiesiogiai |
| `unsupported` | Įraše atitikmens **nėra** |

### Kaip nuspręsti, kuri kilmė

⚠️ **Be aiškios taisyklės du vertintojai tą patį teiginį klasifikuotų
skirtingai**, ir rezultatai taptų nepalyginami.

Klausimai užduodami **ta tvarka**:

1. **Ar galiu nurodyti segmentą (-us), iš kurių teiginys kyla?**
   Ne → `unsupported`
2. **Ar teiginys tuose segmentuose pasakytas?** (perfrazavimas leidžiamas, jei
   prasmė ta pati)
   Taip → `transcript_derived`
3. **Ar teiginys išplaukia taip, kad kitas skaitytojas padarytų tą pačią
   išvadą?**
   Taip → `model_inference` · Ne → `unsupported`

| Įraše nuskambėjo | Protokole | Kilmė | Kodėl |
|---|---|---|---|
| „Parengsiu ataskaitą iki penktadienio" | „Jonas parengs ataskaitą iki penktadienio" | `transcript_derived` | Pasakyta; kalbėtojas identifikuotas |
| „Reikėtų kam nors tuo užsiimti" + Jonas: „Gerai" | „Jonas užsiims" | `model_inference` | Neišsakyta tiesiogiai, bet išplaukia |
| Aptartas biudžetas, terminas neminėtas | „Terminas — penktadienis" | `unsupported` | Segmento nurodyti neįmanoma |
| „Turbūt reikės ataskaitos" | „Jonas parengs ataskaitą" | `unsupported` | Nei pasakyta, nei išplaukia (nėra atsakingo) |

⚠️ **Lemiamas skirtumas tarp `model_inference` ir `unsupported` yra ne
tikėtinumas, o ar galima nurodyti pagrindą.**

Todėl **išvada privalo turėti nuorodas į segmentus**, iš kurių ji padaryta —
lygiai kaip tiesioginis teiginys. Išvada be nuorodos praktiškai neatskiriama nuo
prasimanymo, tik pavadinta kitaip.

⚠️ **Nepagrįstas teiginys yra gedimas, ne trūkumas.** Tai pavojingiausia
protokolo klaidų rūšis: jis atrodo lygiai taip pat įtikinamai kaip teisingas.

⚠️ **Modelio išvada privalo būti pažymėta.** Ji gali būti teisinga, bet
skaitytojas turi žinoti, kad tai išvada — priešingu atveju protokole atsiranda
faktų, kurių niekas nepasakė.

### Kuriems laukams nuoroda privaloma

| Laukas | Nuoroda |
|---|---|
| `nutarimai` | ✅ privaloma |
| `uzduotis` | ✅ privaloma |
| `atsakingas` | ✅ privaloma |
| `terminas` | ✅ privaloma |
| `santrauka` | ❌ nereikalinga |
| `dalyviai`, `darbotvarke` | ❌ nereikalinga |

⚠️ **100% atsekamumas ≠ 100% teisingumas.** Protokolas gali būti visiškai
atsekamas ir vis tiek praleisti pusę sprendimų — pilnumas matuojamas atskirai
(`completeness`).

Reikalauti nuorodos santraukai būtų beprasmiška — ji pagal apibrėžimą
apibendrina visą įrašą. Bet **nutarimas be atsekamumo yra teiginys, kurio
niekas negali patikrinti**, o būtent jie lemia veiksmus po susitikimo.

### Nuorodos formatas

⚠️ **Nuoroda yra POZICIJA, ne tekstas** — segmento indeksas arba laiko
intervalas.

Saugant citatą atsekamumo įrašas taptų transkripcijos kopija su visais asmens
duomenimis ir jokia retencija. Poziciją galima patikrinti turint transkripciją;
be jos ji nieko neatskleidžia.

---

## 5. Vertintojo eiga

1. **Perskaityti protokolą be įrašo.** Užsirašyti, kas atrodo neaišku ar
   įtartina — tai imituoja realų skaitytoją.
2. **Peržiūrėti transkripciją.** Kiekvienam `nutarimai` ir `uzduotis` įrašui
   surasti pagrindą.
3. **Pažymėti kilmę** kiekvienam privalomam laukui.
4. **Užrašyti radinius** su dimensija, sunkumu ir protokolo lauku.
5. **Apskaičiuoti balą** ir patikrinti veto sąlygą.
6. **Užfiksuoti vykdymo kontekstą**: prompt versija, modelis, transkripcijos
   šaltinis.

### Ko vertintojas NERAŠO

⚠️ **Radinio aprašyme negali būti susitikimo turinio.**

| Netinkamai | Tinkamai |
|---|---|
| „Modelis parašė, kad Jonas atleidžiamas" | „Išgalvotas nutarimas apie personalo sprendimą" |
| „Praleido diskusiją apie X projektą" | „Praleistas vienas iš trijų aptartų klausimų" |

Vertinimo rezultatai keliauja į ataskaitas ir repozitoriją — kategorinis
aprašymas išsaugo informaciją apie **klaidos rūšį**, neatskleisdamas turinio.

---

## 6. Du vertintojai ir nesutarimai

⚠️ **Metodika, remiantis žmogaus vertinimu, privalo atsakyti, kas nutinka, kai
du vertintojai nesutaria.** Priešingu atveju rezultatas priklauso nuo to, kurio
vertinimas pateko į ataskaitą.

### Kada reikia dviejų

| Rinkinys | Vertintojų |
|---|---|
| Kūrimo (`development`) | Vienas — tikslas rasti klaidas, ne priimti sprendimą |
| **Galutinis (`final`)** | **Du, nepriklausomai** |

Galutinis rinkinys lemia sprendimą dėl piloto, tad vieno žmogaus nuomonė čia
per silpna.

### Nesutarimų sprendimas

Taisyklės **konservatyvios**: abejonė sprendžiama griežtesnės reikšmės naudai.
Piloto kontekste per griežtas vertinimas kainuoja papildomą peržiūrą, o per
švelnus — **netikrą pasitikėjimą**.

| Nesutarimas | Sprendimas |
|---|---|
| Skirtingas sunkumas | Imamas **griežtesnis** |
| Skirtinga kilmė | Imama **konservatyvesnė** (`unsupported` > `model_inference` > `transcript_derived`) |
| Vienas rado, kitas ne | Radinys **įtraukiamas** |
| Skirtinga dimensija | Abi fiksuojamos; skaičiuojama viena (griežtesnė) |

⚠️ **Sprendimas fiksuojamas su pastaba**, kad vėliau būtų matyti, kur vertintojai
nesutarė.

### Sutarimo dalis

Skaičiuojama ir **pateikiama ataskaitoje**.

⚠️ **Tai NĖRA kokybės matas — tai METODIKOS matas.** Žemas sutarimas reiškia,
kad rubrika neaiški, o ne kad protokolas blogas.

**Jei sutarimas žemas, taisyti reikia rubriką, ne rezultatus.**

---

## 7. Prompt versijavimas

Sistema promptus **jau versijuoja** (`meeting_v1` … `meeting_v3`), o versija
grąžinama kartu su rezultatu.

⚠️ **Vertinimo rezultatas privalo fiksuoti prompt versiją.** Skirtingos versijos
duoda skirtingus protokolus iš to paties įrašo — rezultatas be jos
nepalyginamas su niekuo.

⚠️ **Fiksuojama ir konkreti modelio versija**, ne tik tiekėjas.

`claude` ir `gpt` su ta pačia prompt versija duos skirtingus protokolus — bet
taip pat skirsis ir to paties tiekėjo modeliai (`sonnet` vs `opus`, `gpt-4` vs
`gpt-5`). Rezultatas be modelio versijos nepalyginamas net su savimi po
mėnesio.

Minimalus privalomas kontekstas:

| Laukas | Pavyzdys |
|---|---|
| Prompt versija | `meeting_v3` |
| Tiekėjas | `claude` |
| **Modelio versija** | `claude-sonnet-4-5-20250929` |
| Transkripcijos šaltinis | `#23` rezultatų atspaudas |

---

## 7. Determinizmo riba

⚠️ **LLM nėra deterministinis.** Tas pats įrašas su ta pačia prompt versija gali
duoti skirtingus protokolus.

Todėl:

- vertinant tą patį įrašą kelis kartus, rezultatai gali skirtis;
- vienas paleidimas **nėra** modelio kokybės matas;
- regresijos palyginimas prasmingas tik su **keliais** įrašais.

Tai skiriasi nuo #23, kur `faster-whisper` su fiksuotais parametrais
pakartojamas.

---

## 8. Ko ši metodika NEAPIMA

- Automatinio protokolo vertinimo be žmogaus
- Teisinės susitikimo turinio interpretacijos
- Automatinio protokolo perrašymo, kad atitiktų kriterijus
- Automatinio prompt optimizavimo
- Nuolatinio kokybės stebėjimo produkcijoje
- Transkribavimo kokybės (tai #23)
- Verslo procesų teisingumo tikrinimo

⚠️ **Rubrika nepakeičia žmogaus peržiūros prieš protokolo naudojimą.** Ji
matuoja, kiek jos reikia — ne panaikina ją.
