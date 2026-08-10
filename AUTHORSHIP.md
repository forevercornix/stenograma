# Autorystė ir kūrimo procesas

Šis dokumentas atsako į klausimus, kuriuos kitaip tektų užduoti: kas šį projektą
sukūrė, kaip jis buvo kuriamas ir kam priklauso teisės. Jis parašytas todėl, kad
git istorijoje matyti kelios skirtingos commit'ų tapatybės, o kūrimo tempas
akivaizdžiai nėra įprastas rankiniam rašymui. Abu dalykai turi paprastą
paaiškinimą, ir geriau, kad jis būtų pateiktas iš karto.

---

## Autorė

**Juliana Vorono-Baranovska** — projekto idėja, specifikacija, architektūros
sprendimai, kūrimo kryptis, priėmimo ir atmetimo sprendimai, dokumentacijos
struktūra ir turinys.

Ji yra originalių, žmogaus autorystę turinčių Stenograma kūrinio dalių autorių
teisių turėtoja, projekto prižiūrėtoja ir vienintelė šalis, galinti išduoti
komercines licencijas (žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)).
Išorinių prisidėjusių asmenų projektas neturi, todėl teisių į projekto kodą
niekas kitas neturi.

---

## Kūrimo procesas

Kodas rašytas naudojant **AI įrankius su žmogaus priežiūra**:

| Vaidmuo | Kas atliko |
|---|---|
| Idėja, dalykinė sritis, reikalavimai | Juliana Vorono-Baranovska |
| Architektūros sprendimai ir kompromisai | Juliana Vorono-Baranovska |
| Kodo generavimas | Claude (Anthropic) |
| Kodo peržiūra ir kritika | ChatGPT (OpenAI) |
| Rezultatų priėmimas, atmetimas, kryptis | Juliana Vorono-Baranovska |
| Realūs testai (4 val. lietuviškas įrašas, RunPod GPU) | Juliana Vorono-Baranovska |

Tai nėra „sugeneruota vienu prompt'u". Projekto struktūra — smulkūs PR'ai,
kiekvienas su paaiškinimu, kodėl sprendimas toks; testai, tikrinantys, kad
dokumentacija atitinka kodą; atskiras „ko sistema NEDARO" registras — yra
kuravimo, ne generavimo rezultatas. Ta pati kryptis matoma ir tose vietose,
kur realus testavimas paneigė pradines prielaidas (pvz. `tiny` modelis
lietuvių kalbai; protokolo pilnumo balo klaida) ir kodas buvo taisomas
pagal rezultatą, ne pagal pradinį planą.

### Teisinė padėtis

Pagal kūrimo metu galiojusias Anthropic ir OpenAI paslaugų sąlygas, santykyje
tarp naudotojo ir tiekėjo teisės į modelio išvestį priskiriamos naudotojui, o
tiekėjas perleidžia jam savo galimas teises į ją. Autorei nėra žinoma apie
jokias trečiųjų šalių pretenzijas į šio projekto kodą.

Iš to **neišplaukia** dvi kitos išvados, kurių šis dokumentas neteigia: kad
konkretus AI įrankiais sukurtas kodo fragmentas turi autorių teisių apsaugą, ir
kad panašumo į trečiųjų šalių kodą rizika yra nulinė.

Kartu sąžininga pasakyti tai, kas dar neišspręsta: ES ir Lietuvos autorių teisė
saugo žmogaus intelektinę kūrybą, o riba, ties kuria AI įrankiais sukurtas
kodas tokia laikomas, teismų praktikoje kol kas nenustatyta. Šis dokumentas
nepateikia teisinės išvados — jis pateikia faktus, kurių reikia, kad tokią
išvadą būtų galima pasidaryti.

---

## Commit'ų tapatybės git istorijoje

Kūrimo eigoje buvo naudojamos kelios git tapatybės — dirbant skirtingose
aplinkose (telefonas/Termux, RunPod pod'as, lokali mašina) ir žymint skirtingas
darbo fazes. **Visos jos priklauso tai pačiai autorei.** Išorinių prisidėjusių
asmenų projektas neturi.

| Tapatybė git istorijoje | Ką reiškia |
|---|---|
| `forevercornix <juliana.vorono@gmail.com>` | pagrindinė autorės tapatybė |
| `forevercornix <...@users.noreply.github.com>` | ta pati autorė, commit'ai per GitHub sąsają |
| `A <a@b.local>` | autorė; minimaliai sukonfigūruota aplinka (Termux/RunPod) |
| `Stenograma Dev <dev@stenograma.local>` | autorė; realaus testavimo fazės pataisos |
| `Code Review <review@stenograma.local>` | autorė; peržiūros metu rastų trūkumų taisymai |
| `Stenograma Assistant <assistant@stenograma.local>` | autorė; audito pataisų serija |
| `dependabot[bot]` | automatinis priklausomybių versijų atnaujinimas |

`dependabot[bot]` commit'ai keičia tik priklausomybių versijų numerius
`package.json` ir lock failuose. Tai automatiniai, nekūrybiniai pakeitimai,
autorių teisių klausimo nekeliantys.

Tapatybės **nėra sunorminamos atgaline data** — git istorija netaisoma. Šis
dokumentas yra tinkamesnis būdas paaiškinti, nei `git filter-branch`.

---

## Išoriniai įnašai

Šiuo metu projektas išorinių įnašų neturi. Ateities įnašams taikomos
[`CONTRIBUTING.md`](CONTRIBUTING.md) įnašų licencijavimo sąlygos, kurios
reikalauja suteikti autorei teisę įnašą naudoti bet kokia licencija — tai
leidžia išsaugoti dvigubos licencijos modelį priimant išorinius įnašus.
Patvirtinimas fiksuojamas PR šablono varnele.

Prisidedantiesiems taip pat privaloma nurodyti, jei kodui generuoti buvo
naudoti AI įrankiai. Tai ne kliūtis, o tas pats skaidrumo standartas, kurio
laikomasi šiame dokumente.

---

## Trečiųjų šalių komponentai

Stenograma naudoja atvirojo kodo bibliotekas ir modelius (faster-whisper,
pyannote.audio, Node ir Python paketus) su savo licencijomis. Šio dokumento
teiginiai apie autorystę taikomi **Stenograma kodui**, ne priklausomybėms.

Kai kurie modeliai (pvz. pyannote „gated" modeliai) reikalauja atskirai priimti
tiekėjo sąlygas — nei EUPL, nei komercinė Stenograma licencija to nepakeičia.

---

## Kontaktai

Klausimai dėl autorystės, licencijavimo ar teisių: **juliana.vorono@gmail.com**
