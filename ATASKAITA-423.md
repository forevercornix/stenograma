# #423 — operatoriaus skriptų exit kodų autoritetas ir sargas

**Bazė:** `main` @ `b04b463`. **Elgesys nepakeistas (D5):** nė vieno skripto exit kodas,
jo reikšmė ar semantika nesikeičia. Pakeista dokumentacija ir pridėtas jos sargas.

---

## §0.0 — lentelės perskaičiavimas

Body lentelė perskaičiuota prieš bet kokį kodą. **Visi jos teiginiai pasitvirtino**, su
viena korekcija:

| Body teigia | Išmatuota | Verdiktas |
|---|---|---|
| `erasure-marks.js:199` teigia, kad kontraktas dokumentuotas | teiginys yra **`:193–194`** | eilutės numeris netikslus, turinys teisingas |
| `erasure-marks.js:141`, `:147` ternarai → `{0,1}` | `return r.changed ? 0 : 1` abiejose | ✓ |
| 15 failų su `process.exit*`; 5 su antrašte | ✓ | ✓ |
| keturi pilni dubliai, vienas prozinis, du nedokumentuoti | ✓ | ✓ |
| `server.js:478` — priešingas signalas dėl `doctor` | ✓ „Deep health ir `doctor` yra operatoriaus paviršius" | ✓ |
| du `scripts/` katalogai | šakninis 9 failai, `backend/scripts/` 19 | ✓ |

## §0.1 — semantinių nesutapimų NĖRA

Visi keturi dubliai atitinka savo antraštes, ir kiekviena antraštė atitinka statiškai
išvedamus kodus. **Tad tai ne klaidos taisymas, o higiena su sargu** — priešingai, nei
§0.1 leido galimybę.

⚠️ Vienintelė rasta netiesa buvo **teiginys apie dokumentaciją**, ne apie kodus:
`erasure-marks.js:193–194` tvirtino, kad „komandos kontraktas (0/1/2) yra
dokumentuotas". Jo nebuvo niekur. Ištaisyta: kontraktas užrašytas antraštėje, o teiginys
pakeistas nuoroda į sargą.

## §0.2 — statinis išvedimas

| Forma | Skriptai | Išvesta |
|---|---|---|
| literalai | `cutover-terminalize` | `{1,2,3}` |
| literalai | `hash-password` | `{1}` |
| ternarai + `return` | `erasure-marks` | `{0,1,2}` |
| vieno lygio apvalkalas `mirti(zinutė, N)` | `dr-restore` | `{1,2,3}` |
| vieno lygio apvalkalas | `pg-backup` | `{1,2}` |
| vieno lygio apvalkalas | `post-restore-reconcile` | `{1,2,3,4}` |
| ⚠️ grąžinimo srautas | `migrate-artifacts` | `{0,2,3,4}` — **kodas `1` nepasiekiamas** |

**Taisyklės riba, ir ji užrašyta sargo komentare (D7):** literalas, gaunamas per runtime
reikšmę, statiškai nepasiekiamas. Vienintelis toks kelias repo —
`migrate-artifacts.mjs`: `process.exitCode = await vykdyti(pool)` ir
`= e instanceof NaudojimoKlaida ? e.kodas : 2`, kur `kodas` ateina iš numatytojo
parametro `klaida(zinute, kodas = 1)`.

⚠️ **Todėl lyginama `išvesti ⊆ antraštė`, ne lygybė.** Lygybė reikštų, kad taisyklė
pilna — o ji nėra. Įtraukimas vis tiek gaudo abi svarbias klaidas: naują kodą be
antraštės įrašo ir antraštėje pakeistą numerį.

⚠️ **Kodas `0` laikomas struktūriniu, ne išvestu.** Sėkmė yra kodo NENUSTATYMAS, tad
literalo dažnai nėra (keturiuose iš penkių). Laikyti tai spraga reikštų keturias
netikras spragas ir paslėptų vienintelę tikrą.

## §0.3 — kodų reikšmių neskaito niekas automatinis

| Vartotojas | Rezultatas |
|---|---|
| CI workflows | **0** operatoriaus skriptų minėjimų |
| runbook'ai | jokio `$?`, jokio šakojimosi pagal kodą |
| skriptas → skriptą | nėra |
| `Makefile` | tik `doctor`/`smoke` per `npm` — skiria tik 0/ne-0 |

Adresatas — **žmogus, skaitantis runbook'ą**. Tai nesumažina įrodymo reikalavimo:
„antraštė ↔ dokumentas" nėra exit elgesio įrodymas, todėl sargas lygina ir su kodu.

## §0.4 — paviršius pagal exit mechanizmą

**15** failų `backend/scripts/` nustato exit kodą. Iš jų **7** operatoriaus, **8**
CI/pagalbiniai. Aibė atrandama iš mechanizmo, ne iš antraštės.

⚠️ **Du operatoriaus skriptai antraštės neturėjo, ir jų kodai nebuvo dokumentuoti
niekur** (`erasure-marks.js`, `hash-password.js`). Tai M3 scenarijus, jau esantis repo —
sargas rado juos **pirmu paleidimu**, dar prieš mutacijas.

## §0.5 — CLI ribos autoritetas; STOP nesuveikė, bet D0 buvo paneigtas ir ištaisytas

Riba = **7**, nustatoma dviem signalais, kurių išsiskyrimas yra pažeidimas.

⚠️ **PIRMOJI ŠIO SARGO REDAKCIJA TURĖJO KLAIDĄ SAVO PAČIOS PRIELAIDOJE**, ir ją pagavo
**M5 kontrolė, ne peržiūra** — realiu, ne sintetiniu atveju:

Signalas 1 buvo skaitomas iš **pirmų 25 FAILO eilučių** ir ieškojo vien žodžio
„operatoriaus". Toks langas klaidingas pagal konstrukciją: jis gaudo bet kurią prozą,
atsitiktinai pataikiusią į rėmą, ir **dokumentacijos pridėjimas gali skriptą iš ribos
tyliai išimti**. Abu gedimai buvo reali būsena:

| Skriptas | Kas buvo |
|---|---|
| `hash-password.js` | žodis buvo `:25` — vėlesniame komentare apie `--user-id`, ne antraštėje. Pridėjus `Exit kodai:` bloką iškrito iš lango, ir sargas ribą paskelbė **neapibrėžta** |
| `cutover-terminalize.mjs` | atitiko tik per „Operatoriui liktų rašyti ad hoc kodą" — formuluotę, kurią bet kuris perrašymas pašalintų |

**Pataisyta:** signalas skaitomas iš **pirmo `/** */` bloko** (struktūrinis vienetas, jo
ribos nekinta nuo pridėtų eilučių) ir reikalauja **deklaracijos formos**
(`OPERATORIAUS ĮĖJIMAS` / `OPERATORIAUS ĮRANKIS`), ne bet kurio paminėjimo. Abiem
skriptams deklaracija užrašyta eksplicitiškai.

Išmatuota po pataisymo: **7/7** operatoriaus, **0/8** ne-operatoriaus.

⚠️ **Signalas yra deklaracija, ne matavimas.** Jo teisingumą gina M5: skriptas,
deklaruojantis save operatoriaus įėjimu, bet niekur nedokumentuotas (ar atvirkščiai),
duoda pažeidimą — tad deklaracija negali tyliai išsiskirti su tikrove.

❌ **Alternatyva „`Naudojimas:` blokas" atmesta MATAVIMU:** pirmame bloke jį turi **3 iš
7** operatoriaus ir **4 iš 8** ne-operatoriaus skriptų (`check-security-matrix`,
`run-tests`, `verify-clean`, `verify-postgres-suite-ran`). ⚠️ Mano ankstesnis teiginys,
kad „`Naudojimas:` yra visuose septyniuose", buvo **neteisingas** — net visame faile tai
4/7. Patikra buvo daryta ne antraštėje.

`doctor.js` ir `smoke.js` — už ribos (kviečiami per `npm run` / `make`; įtraukimas
reikštų trečią autoritetą). ⚠️ Priešingas signalas `server.js:478` užrašytas sargo
dokumentacijoje su priežastimi, ne nutylėtas.

## §0.6 — ką jau įrodo vykdymo testai

`migracijosCliBaigtys.test.js` per tikrą `spawnSync` įrodo `migrate-artifacts` kodus
**0, 2, 3, 4**. Kodas **1** neįrodytas nei statiškai, nei vykdymu.

⚠️ **Tai vienintelė žinoma spraga, ir ji įvardyta, ne nutylėta** (kaip reikalauja issue
„Ribos"). Ji nekritinė: `1` yra naudojimo klaida, o jos kelias (`klaida()` →
`NaudojimoKlaida`) yra tas pats visiems argumentų atvejams.

⚠️ Matuodamas §0.6 **pats pataikiau į D4 klasę**: pirmas grep'as pagal
`scripts/migrate-artifacts` davė 0 testų, nes testas naudoja
`path.join(SAKNIS, "scripts", "migrate-artifacts.mjs")`. Sujungtas kelias praleidžiamas
paieškos pagal eilutę.

---

## D7 — ištraukimo taisyklė, kaip užrašyta kode

Renkami sveikųjų skaičių literalai iš keturių formų: `process.exit(N)` /
`process.exitCode = N`; `return N;`; ternaro **bet kurios pusės** (`? N : M` ir
`? x : N`); vieno lygio apvalkalo kvietimo vietų (funkcija, kurios parametras eina į
`process.exit(param)`). Riba — runtime reikšmės. **Taisyklė ir jos riba aprašytos sargo
komentare, ne skriptų sąrašu** — sąrašas pasentų tyliai.

Dvi taisyklės klaidos, rastos matuojant ir ištaisytos:

| Klaida | Pasekmė | Kaip rasta |
|---|---|---|
| argumentų dalijimas laikė backtick'ą skliaustu ir niekada jo neuždarydavo | `pg-backup` kodai `{1,2}` tyliai iškrisdavo (`mirti("`dump` …", 1)`) | išvesta aibė buvo `{}` |
| ternaro forma tik `? N : M` | `migrate-artifacts` kodas `2` (`? e.kodas : 2`) praleistas | išvesta `{0,3,4}` vietoj `{0,2,3,4}` |

⚠️ **Ir trečia — analizatorius sulūžo nuo savo paties dokumentacijos:** `Exit kodai:`
buvo ieškoma bet kur eilutėje, o `hash-password.js` antraštėje yra paaiškinimas,
minintis `` `Exit kodai:` `` kaip tekstą. `findIndex` pagavo jį, ir skriptas su teisinga
antraište atrodė kaip be jos. Žyma prikabinta prie **komentaro eilutės pradžios**.

## D0 — kaip tikrinamas signalų sutapimas

Sargas kiekvienam iš 15 tikrina abu signalus. `savideklaracija !== dokumentuotas` →
pažeidimas „ribos signalai IŠSISKYRĖ … riba nebeapibrėžta", ir skriptas **toliau
netikrinamas**: aibė, kurios riba neapibrėžta, negali turėti kontrakto.

## D6 — iš kur išvesti kodai

| Skriptas | Antraštė | Pagrindas |
|---|---|---|
| `erasure-marks.js` | `0·1·2` | `return 0` (:122), `return 2` (:130, :135, :157), ternarai → `{0,1}`, `process.exit(1)` |
| `hash-password.js` | `0·1` | `process.exitCode = 1` ×5; `0` — struktūrinė sėkmė |

⚠️ **`erasure-marks.js` `1` ir `2` reikšmės ATVIRKŠČIOS nei kituose šešiuose.** Ten `1` =
naudojimo klaida, `2` = procedūros klaida; čia `2` = naudojimo klaida, o `1` = „niekas
nepasikeitė" (`changed: false`) IR netikėta klaida. Užrašyta, **neliesta** (D5;
„Ko NEAPIMA" — semantikos derinimas).

---

## Apimtis

**Prognozė: 7–9 failai. Faktas: 6.**

| Failas | Kas |
|---|---|
| `backend/tests/operatoriausExitKodai.test.js` | naujas sargas |
| `backend/scripts/erasure-marks.js` | antraštė + `:193` teiginio taisymas |
| `backend/scripts/hash-password.js` | antraštė + savideklaracija |
| `backend/scripts/cutover-terminalize.mjs` | savideklaracija (rasta po STOP) |
| `backend/tests/suites.js` | registracija `functional` |
| `docs/security-test-matrix.md` | trys eilutės |

Mažiau nei prognozuota, nes **`docs/` liko nepakeisti**: visi keturi dubliai jau sutapo
su antraštėmis, tad taisyti nebuvo ko. Vienas failas atsirado neplanuotas
(`cutover-terminalize.mjs`) — jo savideklaracija buvo atsitiktinė proza, ir tai išlindo
tik po D0 pataisymo.

---

## Kontrolė — CI skaičiai

| | `main` `36457489429` | PR `36537351109` | Δ |
|---|---|---|---|
| testai | 2854 | **2860** | **+6 = lygiai nauji** |
| pass | 2843 | **2849** | +6 |
| fail | 0 | **0** | 0 |
| skipped | 11 | **11** | **0 naujų praleidimų** |

⚠️ **Galutinė kontrolė po visų mutacijų grąžinimo: `36542684177` — success**, skaičiai
identiški pradinei bazei (2860 / 2849 / 0 / 11). Tai patvirtina, kad grąžinimas nieko
nepaslėpė ir nieko nepaliko: mutacijų nebeliko, o sargas vis dar vykdomas
(`operatoriausExitKodai (exit 0, 156 ms)`).

Grąžinimas patikrintas **medžio hash'u**, ne `git diff` tyla (#421 pamoka):

    backend/  bazė 9b150d393386   po grąžinimo 9b150d393386   SUTAMPA
    docs/     bazė 0a3b3c1e2f8f   po grąžinimo 0a3b3c1e2f8f   SUTAMPA

Sargas CI'e realiai vykdomas: `operatoriausExitKodai (exit 0, 235 ms)` — t. y. registracija
`suites.js` veikia, ir žalia spalva nėra dėl to, kad testas nepaleistas.

⚠️ **Laiko įtaka išmatuota, ne prielaida.** Sargas pridėtas į `functional`, tad didina
paralelinę apkrovą. Lokaliai pilnas rinkinys šiame įrenginyje davė tris kritimus, tarp jų
`#380 R2` — sieninio laiko asercija (`< 30 000 ms`). CI palyginimas:

| Testas | `main` | PR |
|---|---|---|
| `resursuKruva` (`#380 R2`) | 10 127 ms | **10 123 ms** |
| `suiteDerivation` | 36 831 ms | 37 134 ms |
| `tapLiudytojas` | 66 649 ms | 67 496 ms |

`resursuKruva` skirtumas — **4 ms**, t. y. jokios įtakos. Lokalūs kritimai yra įrenginio
(Termux/PRoot) greičio: `suiteDerivation` ir `tapLiudytojas` davė `FILE_TIMEOUT` per 120 s
ribą, o izoliuotai ir CI'e abu žali; `#380 R2` izoliuotai 12/12.

## Kas liko nepatikrinta ir kodėl

| Kas | Kodėl |
|---|---|
| `migrate-artifacts` kodas `1` | neaprėpia nei statinė taisyklė (runtime reikšmė per numatytąjį parametrą), nei vykdymo testas (`migracijosCliBaigtys` įrodo 0/2/3/4). Įvardyta sargo dokumentacijoje |
| `erasure-marks` `1`/`2` semantikos nesutapimas | UŽRAŠYTAS, ne ištaisytas — taisymas yra elgesio pakeitimas (D5, „Ko NEAPIMA") |
| `doctor.js` / `smoke.js` exit kodų kontraktas | už ribos pagal D0; priešingas signalas `server.js:478` užrašytas sargo dokumentacijoje |
| `migrations.md:159` prozinis `exit 2` | sąmoningai ne dublis — sargas prozos neinterpretuoja, nes tai klaidingų kritimų šaltinis |

---

## Mutacijos — visos vykdytos CI

| # | Mutacija | CI run | Kas krito |
|---|---|---|---|
| **M1** | antraštėje `3` → `9` (`cutover-terminalize`) | `36538381124` ❌ | `kodai {3} nustatomi KODE, bet antraštėje jų nėra` — ⚠️ prieš **kodą**, ne dokumentą |
| **M2a** | dokumente `2` → `9` (`backup-runbook.md:448`) | `36538849561` ❌ | `dublis NESUTAMPA — tik dokumente {9}, tik antraštėje {2}` |
| **M2b** | dokumente **trūksta** kodo | `36539620343` ❌ | `tik dokumente {}, tik antraštėje {2}` |
| **M2c** | dokumente **perteklinis** kodas | `36540172139` ❌ | `tik dokumente {7}, tik antraštėje {}` |
| **M3** | naujas operatoriaus skriptas be antraštės | `36540806118` ❌ | `m3-laikinas.mjs: … antraštės NETURI`; antroji pusė (8 ne-operatoriaus → 0) žalia |
| **M4** | naujas `process.exitCode = 7` (`pg-backup`) | `36541428596` ❌ | `kodai {7} nustatomi KODE, bet antraštėje jų nėra` |
| **M5** | vienas ribos signalas be kito | `36542033664` ❌ | `ribos signalai IŠSISKYRĖ (savideklaracija=false, dokumentuotas=true)` |

⚠️ **M2 trys kryptys duoda TRIS SKIRTINGUS pažeidimo tekstus** — tai ir yra abipusės
lygybės įrodymas: įtraukimo patikra (`Set(dok) ⊆ Set(antraštė)`) būtų praleidusi M2b ir M2c.

⚠️ **M1 krito prieš KODĄ, ne dokumentą.** `cutover-terminalize` dokumento dublio neturi,
tad jo antraštė tikrinama tik prieš kodą. Sargas, lyginantis vien „antraštė ↔ dokumentas",
šios mutacijos nebūtų pamatęs — o tokių skriptų yra trys.

⚠️ **M4 forma pasirinkta LINT-SAUGI iš anksto** (`if (process.env.…)`, ne pliki
nepasiekiami sakiniai). #421 F1 pamoka: mutacija, mirusi `no-unreachable` lint'e, yra
teisingas faktas su neteisinga išvada. Patikrinta prieš push'ą: 0 lint problemų; CI kritimas
— teste.

### ⚠️ Vienas paleidimas NEGALIOJA, ir tai užrašoma

`22ed6bd` (`36539...`) buvo raudonas, bet **ne dėl M2b**. Grąžinimui naudojau `git revert`
ant commit'o, kuris PATS buvo revert'as (`revert M1 + MUTACIJA M2a`) — tad M1 **atsistatė**,
ir paleidimas krito dėl jos. Kaip M2b įrodymas jis netinka.

Tai tiksliai #421 pamoka: `git diff` prieš tėvą buvo **tuščias abiem atvejais**, ir klaidą
pamačiau tik iš pažeidimo TEKSTO (rodė `cutover-terminalize`, ne `backup-runbook`).
Nuo M2b kiekvienos mutacijos apimtis prieš push'ą tikrinama
`git diff --cached e976a40 --stat` — ir M3 atveju ta patikra iškart parodė, kad `backup-runbook.md`
grąžintas teisingai.
