# Piloto charta

Šis dokumentas yra issue #28 (PR1) rezultatas. Jis atsako į vieną klausimą:
**kas yra šis pilotas.**

- Kaip jis vykdomas: #28 PR2
- Kada laikomas sėkmingu ir kas vyksta po jo: #28 PR3

⚠️ **Be užrašytos apimties ribotas pilotas palaipsniui virsta nedokumentuota
produkcijos paslauga** su neaiškia atsakomybe ir nepriimtina rizika. Tai
nutinka ne dėl blogos valios: kiekvienas atskiras praplėtimas atrodo mažas.

---

## 1. Tikslas

Patikrinti, ar automatinis susitikimų transkribavimas ir protokolų rengimas
**kontroliuojamoje aplinkoje** duoda pakankamai naudos, kad būtų verta jį
**plėsti už piloto ribų** — ir kokia kaina.

⚠️ Pilotas **nėra** paslaugos teikimas. Jis yra **matavimas**.

---

## 2. Hipotezės

Pilotas patikrina keturias. Kiekviena suformuluota taip, kad ją būtų galima
**paneigti** — hipotezė, kurios paneigti neįmanoma, nieko netikrina.

| # | Hipotezė | Kaip tikrinama |
|---|---|---|
| H1 | Transkribavimo kokybė lietuvių kalbai pakankama protokolui rengti | [`evaluation-protocol.md`](../evaluation-protocol.md) — metodika **jau apibrėžta** (#23) |
| H2 | Sugeneruotas protokolas sutrumpina rengimo laiką | Laiko matavimas (#28 PR3): **tas pats žmogus**, ta pati užduotis rankiniu būdu |
| H3 | Protokolo turinys pakankamai tikslus, kad taisymas būtų pigesnis nei rašymas iš naujo | Protokolo tikslumo metodika — **dar neįgyvendinta** (#24) |
| H4 | Privatumo kontrolės netrukdo darbui | Naudotojų atsiliepimai, incidentų skaičius |

⚠️ **H3 negali būti vertinama, kol #24 metodikos nėra.** Ji įrašyta čia
sąmoningai — kad hipotezė būtų matoma nuo pradžių, o ne pridėta po to, kai
rezultatai jau žinomi.

Bet **pilotas negali būti laikomas sėkmingu remiantis H3**, kol matavimo būdo
nėra. Tai apibrėžia #28 PR3 kriterijai.

⚠️ **H2 matuojamas tas pats žmogus**, atliekantis tą pačią užduotį rankiniu
būdu. Skirtingų žmonių rezultatai nepalyginami: skirtumas tarp jų dažnai
didesnis nei tarp rankinio ir automatinio būdo.

⚠️ **H1 ir H3 yra skirtingi klausimai.** Gera transkripcija negarantuoja gero
protokolo — todėl #23 ir #24 yra atskiros metodikos.

---

## 3. Kas dalyvauja

⚠️ Įvardytos **rolės, ne asmenys**: dokumentas su vardais pasensta pirmiau nei
bet kuri jo dalis.

| Rolė | Atsakomybė |
|---|---|
| **Piloto savininkas** | Apimtis, sprendimai dėl tęsimo ar stabdymo, komunikacija |
| **Duomenų valdytojo įgaliotas atsakingas** | Sprendimai dėl asmens duomenų, pranešimai (#21) |
| **Techninis atsakingas** | Diegimas, konfigūracija, incidentų sulaikymas |
| **Dalyvaujantys naudotojai** | Sistemos naudojimas pagal šias taisykles |

### Dalyvaujančios organizacijos

Pilote dalyvauja **iš anksto įvardytos** organizacijos ir padaliniai.
Konkretus sąrašas fiksuojamas atskirai — jis keičiasi dažniau nei ši charta —
bet **jam galioja ta pati apimties keitimo tvarka** (§9).

⚠️ Atskiras dokumentas nereiškia laisvesnės tvarkos: priešingu atveju
organizacijas būtų galima pridėti apeinant chartą.

⚠️ **Organizacijos pridėjimas yra apimties pakeitimas** (žr. §9), ne
administracinis veiksmas.

---

## 4. Leidžiami naudojimo atvejai

✅ **Leidžiama:**

- Vidiniai darbiniai susitikimai
- Projektų aptarimai
- Komandos pasitarimai
- Susitikimai, kuriuose **visi dalyviai informuoti** apie įrašymą

❌ **Draudžiama:**

| Atvejis | Kodėl |
|---|---|
| Susitikimai su **ypatingų kategorijų** duomenimis (sveikata, teistumas, religija, politinės pažiūros) | BDAR 9 str. reikalauja atskiro pagrindo, kurio pilotas neturi |
| Drausminiai, etikos ar tyrimo pokalbiai | Poveikis asmeniui neproporcingas piloto naudai |
| Derybos ir sutarčių aptarimai su trečiosiomis šalimis | Komercinė paslaptis; kitos šalies sutikimo nėra |
| Susitikimai su **neinformuotais** dalyviais | Skaidrumo principas |
| Susitikimai, kuriuos įrašyti draudžia teisės aktai ar vidaus tvarka | Akivaizdu, bet turi būti parašyta |
| Bet koks naudojimas **už dalyvaujančių organizacijų ribų** | Už piloto apimties |

⚠️ **Abejojant — nenaudoti.** Sprendimas naudoti sistemą konkrečiame susitikime
priklauso susitikimo organizatoriui, ne piloto komandai.

---

## 5. Leidžiami duomenys

✅ **Leidžiama:**

- Susitikimo garso įrašas
- Dalyvių vardai ir pareigos, kiek jie natūraliai skamba pokalbyje
- Darbiniai dokumentų pavadinimai ir projektų kodai

❌ **Neleidžiama sąmoningai įvesti:**

| Kategorija | Pastaba |
|---|---|
| Asmens kodai, sveikatos duomenys | Redakcija (#4) juos šalina, bet **tai nėra leidimas juos tarti** |
| Slaptažodžiai, API raktai, kredencialai | Jie patektų į transkripciją ir logus |
| Klientų asmens duomenys | Kita teisinio pagrindo sritis |
| Įslaptinta ar riboto naudojimo informacija | Už piloto apimties |
| **Biometriniai identifikatoriai** | ⚠️ Garso įrašas savaime yra biometrinis šaltinis; sąmoningas balso atpažinimo ar tapatybės nustatymo naudojimas yra atskira BDAR 9 str. sritis |

⚠️ **Redakcijos komponentas yra apsauga, ne leidimas.** Jis mažina pasekmes,
kai kas nors pasakoma netyčia — bet nepaverčia to tvarkinga praktika.

---

## 6. Diegimo aplinka

| Parametras | Piloto nustatymas |
|---|---|
| Aplinka | Atskira, **ne bendra su produkcija** |
| `NODE_ENV` | `production` (kitaip apsaugos neveikia — žr. #21) |
| Autentifikacija | Sesijos (`AUTH_USERS`) su rolėmis (#18) |
| Privatumo profilis | Sprendžiamas prieš startą: `standard` arba `local_only` |
| Kopijos | Sprendžiamos prieš startą (#20) |

⚠️ **Dev režime apsaugos nėra**: be autentifikacijos mechanizmų sistema
praleidžia visas užklausas su administratoriaus teisėmis.

---

## 7. Patvirtinti tiekėjai

Sistema palaiko **8 lokalius** ir **9 išorinius** tiekėjus (#22).

| Sprendimas | Ką reiškia |
|---|---|
| **Tik lokalūs** | Duomenys neišeina; `local_only` profilis |
| **Su išoriniais** | Kiekvienas įrašomas į `APPROVED_EXTERNAL_PROVIDERS` |

⚠️ Išorinis tiekėjas **neveiks** be įrašo šiame sąraše, net jei raktas
nustatytas. Bet sąrašas sprendimą **įgyvendina, o ne įrodo** — patvirtinimas
turi būti užfiksuotas atskirai (#22).

⚠️ **Visų išorinių tiekėjų privatumo savybės šiame projekte pažymėtos
`unknown`** — jų regiono, retencijos ir naudojimo modelių mokymui **niekas
netikrino**. Prieš pilotą tai turi padaryti duomenų valdytojas.

Pilnas inventorius: [`provider-governance.md`](provider-governance.md).

---

## 8. Prielaidos

Charta galioja, **kol šios prielaidos teisingos**. Jei kuri nors nustoja
galioti, apimtį reikia peržiūrėti.

| Prielaida | Kas nutinka, jei neteisinga |
|---|---|
| Dalyviai informuoti apie įrašymą | Dingsta teisinis pagrindas |
| Pilote dalyvauja ribotas, žinomas naudotojų ratas | Apimtis nebekontroliuojama |
| Susitikimai neturi ypatingų kategorijų duomenų | Reikia atskiro vertinimo |
| Veikia **vienas** backend procesas | Priežiūros užraktas neveikia keliuose (#21) |
| Sistema nėra kritinė veiklai | Prastova taptų incidentu, ne nepatogumu |

---

## 9. Apimties keitimas

⚠️ **Apimtis yra užšaldyta** piloto metu. Tai pagrindinė apsauga nuo virtimo
nedokumentuota paslauga.

| Pakeitimas | Kas tvirtina |
|---|---|
| Nauja organizacija ar padalinys | Piloto savininkas **ir** duomenų valdytojas |
| Naujas naudojimo atvejis | Tas pats |
| Naujas išorinis tiekėjas | Tas pats + #22 procedūra |
| Privatumo profilio pakeitimas | Tas pats |
| Retencijos pakeitimas | Duomenų valdytojas |
| Techninė konfigūracija be poveikio duomenims | Techninis atsakingas |

**Kiekvienas pakeitimas fiksuojamas** su data, pagrindimu ir tvirtinusiu
asmeniu.

### Skubūs saugumo pakeitimai

⚠️ **Skubus saugumo pataisymas NĖRA apimties pakeitimas.**

Kredencialo atšaukimas, tiekėjo išjungimas, prieigos apribojimas ar
pažeidžiamumo taisymas atliekami **nedelsiant** pagal #21 procedūras, be
išankstinio apimties tvirtinimo.

Priešingu atveju sulaikymas priklausytų nuo tvirtinimo grandinės — o incidento
metu tai reikštų, kad poveikis tęsiasi, kol vyksta administravimas.

Tokie veiksmai **fiksuojami po fakto** ir peržiūrimi kartu su incidentu.

⚠️ **Pakeitimas be įrašo laikomas neįvykusiu.** Priešingu atveju po trijų
mėnesių niekas nebeatsakys, kodėl pilotas apima tai, ką apima.

---

## 10. Žinomos ribos

Šios ribos **nėra trūkumai, kuriuos reikia paslėpti** — jos apibrėžia, ko iš
piloto negalima tikėtis.

| Riba | Šaltinis |
|---|---|
| Auditas gyvena tik atmintyje; restartas jį ištrina | #21 |
| Įkėlimų išjungimo jungiklio nėra | #21 |
| Priežiūros užraktas veikia tik viename procese | #21 |
| Atkūrimo pritaikymas nėra transakcinis | #20 |
| Kopijos nepasiekia jau ištrintų duomenų; kopijų retencija apibrėžia faktinį ištrynimo langą | #19, #20 |
| Vykdomas processor'ius nesustabdomas vidury ištrynimo | #19 |
| Išorinių tiekėjų privatumo savybės nepatikrintos | #22 |
| Tiekėjų valdysena **įgyvendina** patvirtinimą, bet **neįrodo** organizacinio sprendimo | #22 |
| Nuosavybės patikrų nėra — rolė sprendžia veiksmus, ne su kieno duomenimis | #18 |
| Budėjimo 24/7 nėra | #21 |

⚠️ **Kokybės ribos** (WER, protokolo tikslumas) matuojamos atskirai — #23 ir
#24. Jos bus žinomos **prieš** startą, ne po jo.

---

## 11. Ko šis pilotas NEAPIMA

- Bendrų paslaugos teikimo sąlygų
- Diegimo visai organizacijai
- Automatinio perėjimo į produkciją
- Paslaugos lygio įsipareigojimų (SLO/SLA)
- Aukšto pasiekiamumo ar nelaimių atkūrimo garantijų
- Automatinio mastelio keitimo
- Ilgalaikio stebėjimo po piloto
- Formalios reguliacinės sertifikacijos
- Produkcijos palaikymo organizacijos

⚠️ **Piloto pabaiga nėra automatinis perėjimas į produkciją.** Sprendimas
priimamas atskirai, remiantis #28 PR3 kriterijais.
