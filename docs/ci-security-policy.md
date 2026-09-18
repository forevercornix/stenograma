# CI/CD ir tiekimo grandinės politika

Šis dokumentas yra GDPR issue #16 dalis. Jis aprašo taisykles, kurių negalima
išreikšti vien konfigūracija — o be užrašytos taisyklės kiekvienas sprendimas
priimamas iš naujo ir kaskart kitaip.

## GITHUB_TOKEN teisės

⚠️ **Repozitorijos numatytoji reikšmė nustatoma atskirai:**
`Settings → Actions → General → Workflow permissions` turi būti
**„Read repository contents and packages permissions"**. Workflow lygio blokai ją
perrašo, bet jie apsaugo tik tuos workflow, kurie tą bloką turi — o naujas
workflow be jo paveldėtų repo nustatymą. Šito iš kodo patikrinti neįmanoma, tad
tai lieka rankinis punktas diegimo peržiūroje.

**Numatytoji reikšmė kiekviename workflow yra `contents: read`.** Ji nustatoma
workflow lygiu, ne job lygiu, kad naujas job'as paveldėtų saugų numatytąjį — o ne
tada, kai kas nors prisimena jį pridėti.

Rašymo teisės suteikiamos **tik** tam job'ui, kuriam jos realiai reikia, ir tik
tos, kurių reikia. Šiuo metu vienintelė išimtis yra `publish-images.yml`
`build-and-push` job'as su `packages: write` — jis stumia atvaizdus į GHCR.

`write-all` neleidžiamas niekada. Jei atrodo, kad jo reikia, tai reiškia, kad
nežinom, kurios teisės būtinos — ir tada reikia išsiaiškinti, o ne suteikti visas.

## Nepatikimas PR kodas

`pull_request_target` **nenaudojamas**. Jis vykdomas su bazinės šakos teisėmis ir
turi prieigą prie paslapčių, tad kartu su `actions/checkout` ties PR HEAD jis
reiškia, kad svetimas kodas gauna mūsų paslaptis.

Jei kada nors prireiktų (pvz. etiketėms ar komentarams), taisyklė tokia:
`pull_request_target` job'as **niekada** neatsisiunčia ir nevykdo PR kodo —
jokio `checkout` ties PR ref, jokio `npm install`, jokio build'o.

## Paslaptys

Paslaptys perduodamos **tik** tiems žingsniams, kuriems jos reikalingos, per
`with:` arba `env:` ties žingsniu, ne ties job'u. Job lygio `env` su paslaptimi
padaro ją matomą kiekvienam žingsniui, įskaitant trečiųjų šalių action'us.

Fork'ų PR'ai paslapčių negauna — tai GitHub numatytoji elgsena, ir jos nekeičiam.

## Trečiųjų šalių action'ų versijos

| Šaltinis | Politika | Priežastis |
|---|---|---|
| `actions/*` (GitHub oficialūs) | major tag (`@v4`) | GitHub valdo repozitoriją; tag'ų perrašymas būtų incidentas |
| `docker/*` (Docker oficialūs) | major tag (`@v3`) | Ta pati logika; abu yra patikrinti leidėjai |
| `github/*` (pvz. `github/codeql-action`) | major tag | Ta pati GitHub organizacija kaip `actions/*` |
| **Bet kas kitas** | **pilnas commit SHA** | Tag'ą galima perrašyti; SHA — ne |

Sąrašas yra `scripts/check-workflow-policy.mjs` konstantoje `TRUSTED_PUBLISHERS`
ir turi sutapti su šia lentele. Pridedant naują leidėją į vieną vietą, būtina
atnaujinti ir kitą — kitaip dokumentas ir patikra pradės skirtis, o skirtumas
paaiškės tik tada, kai kas nors bandys pridėti action'ą.

Ta pati taisyklė galioja **panaudojamiems workflow** (`jobs.<id>.uses`): jie
vykdomi mūsų kontekste ir gali turėti savo `permissions`, tad nepatikimas
šaltinis prisegamas prie SHA lygiai taip pat kaip action'as.

Dependabot atnaujina abu pavidalus (`github-actions` ekosistema), tad SHA
prisegimas nereiškia, kad atnaujinimai sustos.

Naujas action iš nepatikrinto leidėjo pridedamas **tik** su SHA ir tik po to, kai
peržiūrėta, ką jis daro su `GITHUB_TOKEN`.

## Job'ų laiko ribos

Kiekvienas job turi `timeout-minutes`. Numatytoji GitHub riba yra **6 valandos** —
pakibęs runner'is tiek laiko laikytų eilę užimtą, o gedimo priežastis paaiškėtų
tik po pusdienio.

## Artefaktai

Artefaktai turi eksplicitinę `retention-days` reikšmę. Numatytoji yra 90 dienų —
tai kopija, apie kurią po savaitės niekas nebeprisimena.

Artefaktuose **negali** būti paslapčių ar realių duomenų. Šiuo metu keliamas tik
`playwright-report`, kuriame būna ekrano nuotraukų ir tinklo pėdsakų; E2E naudoja
tik mock tiekėjus ir sintetinį tekstą, tad realių asmens duomenų jame nėra.
**Jei kada nors atsirastų E2E su realiu įrašu, artefaktą reikės išjungti arba
filtruoti** — ne sutrumpinti retenciją.

## Priklausomybių auditas ir CI blokavimo riba

Riba **skiriasi pagal ekosistemą**, ir tai sąmoningas sprendimas, ne neapsižiūrėjimas:

| Ekosistema | Blokuoja CI | Įrankis |
|---|---|---|
| npm (`backend/`, `frontend/`) | `high` ir `critical` | `npm audit --audit-level=high` |
| Python (`backend/scripts/`, `pyannote-server/`, `whisper-server/`) | **bet koks radinys** | `pip-audit` |

**Kodėl Python griežčiau.** `pip-audit` neturi severity slenksčio: `--strict`
keičia priklausomybių surinkimo klaidų traktavimą, o ne sunkumo ribą, ir įrankis
grąžina nesėkmę radęs bet kokį pažeidžiamumą. Suvienodinti ribą reikštų rašyti
apvalkalą, kuris parsintų JSON, susietų advisory su severity ir filtruotų —
o Python advisory šaltiniai sunkumą pateikia nevienodai, tad toks filtras būtų
tikslus tik iš pažiūros.

Griežtesnė taisyklė, pasakyta garsiai, geresnė už tikslią taisyklę, kuria
negalima pasitikėti. Praktinė kaina maža: Python priklausomybių čia nedaug ir jos
keičiasi retai. Kai `low` radinys realiai neaktualus, jis eina per išimčių
procesą — su data ir peržiūra, o ne tyliai praleidžiamas.

**Dependabot šios ribos nepakeičia.** Jis periodiškai siūlo atnaujinimus, bet
nepatikrina PR, kuris **įveda** žinomai pažeidžiamą priklausomybę — toks PR be
`dependency-audit` job'o nusileistų į `main` ir lauktų savaitinio ciklo. Abu
mechanizmai reikalingi ir sprendžia skirtingus dalykus.

Kai npm `moderate` radinys praktiškai svarbus (pvz. pasiekiamas mūsų kelyje),
jis sprendžiamas **konkrečiam paketui** — atnaujinant arba per išimčių procesą,
o ne keliant ribą visam auditui.

## `main` apsauga ir merge kontraktas (#324)

⚠️ **Aktyvu nuo 2026-09-15:** ruleset `main-protection` (`enforcement: active`), privalomas patikrinimas — `required-ci`.

`main` keičiama **tik** per PR, kuriame **visi privalomi patikrinimai sėkmingi**.
Enforcement autoritetas yra **GitHub branch protection / ruleset**, ne šis
dokumentas ir ne repo testas.

⚠️ **Repo sargas NĖRA enforcement.** Testas, tikrinantis apsaugos konfigūraciją,
yra **drift detection**: jei apsauga išjungta, tame pačiame PR paleistas raudonas
sargas pats merge'o uždrausti negali. Tai bootstrap paradoksas, ir jis reiškia,
kad sargo buvimas negali būti apsaugos įrodymas.

### Privalomų patikrinimų aibė

GitHub nustatymuose laikomas **vienas** required check — `required-ci`.
Priklausomybių sąrašas gyvena `ci.yml`, versijų kontrolėje.

**Kodėl vienas vardas.** GitHub nustatymuose įrašytas vardas neturi jokios
apsaugos nuo drift'o: pervadinus job'ą, required check tyliai virsta `missing`.
Repo valdoma priklausomybė elgiasi priešingai — pervadinus `backend` ir
nepataisius `needs:`, GitHub Actions atmeta **visą** workflow („depends on unknown
job"), vartų nėra, ir merge blokuojamas **garsiai**.

Privalomos šakos (9): `backend`, `frontend`, `e2e`, `docker`,
`compose-config-validate`, `workflow-policy`, `deleted-tests`, `pyannote-server`,
`whisper-server`.

⚠️ **Nė vienas `ci.yml` job'as neturi job-lygio `if:`** — sąmoningai conditional
šakų nėra. Todėl gate'e **`skipped` ir `cancelled` yra nesėkmė be išimčių**.
Atsiradus conditional job'ui, jo semantika sprendžiama atskirai ir įrašoma
`required-ci` komentare; aklas pridėjimas į `needs:` paverstų jį privalomu
netyčia.

### Perėjimo kaina: PR, atidaryti PRIEŠ vartus (#324)

⚠️ **`required-ci` galioja tik tiems PR, kuriems jis buvo paleistas.** Vartų job'as
atsirado 2026-09-15; PR, kurių paskutinis CI paleidimas senesnis, `required-ci`
check'o **neturi ir savaime negaus** — GitHub rodo jį kaip `Expected`, ir merge
lieka blokuotas neribotai.

**Išmatuota 2026-09-17:** 23 atviri Dependabot PR, iš jų:

| Būsena | Kiek | `required-ci` | Merge |
|---|---|---|---|
| `BEHIND` | **20** | **nėra** | blokuotas |
| `CLEAN` | 3 | yra | galimas |

Visi 20 turi senosios aibės check'us (10 arba 11, priklausomai nuo PR amžiaus)
ir **nė vieno** `required-ci`.

⚠️ **Jie nėra „žali, tik blokuoti".** Išmatuota: 18 iš 20 neturi nė vieno `fail`,
bet **visi 20** turi `CodeQL skipping` (D4 — patariamasis, ne merge kontrakto
dalis), o du turi tikrus gedimus: **#275** (`docker`) ir **#219** (`e2e`,
`frontend`). Tie du po rebase'o kris ir per `required-ci` — ir teisingai.

**Tai ne yda, o perėjimo kaina, ir ji fail-closed.** Senas žalias PR merginamas
nebūtų — vartai neturi jo rezultato, tad neatsidaro.

**Atrakinimas — po vieną PR:** rebase arba „Update branch". Abu kelia
`synchronize`, tad `required-ci` pasileidžia. Dependabot'ui užtenka komentaro
`@dependabot rebase`.

⚠️ **Masinio atrakinimo nedaryti vienu ypu.** 20 rebase'ų = 20 lygiagrečių CI
paleidimų; `backend` job'as trunka ~5 min, `e2e` daugiau. Eilė užsikimštų, ir
tikrieji PR lauktų už jų.

### `dependency-audit` — patariamasis, su sąlyga

Jis **nėra** `required-ci` dalis. Priežastis išmatuota: per mėnesį jis krito
**tris** kartus, ir visi trys gedimai buvo **nesusiję su PR turiniu** — `npm
audit` 503 (infrastruktūra) ir du advisory prieš **nepakeistas** priklausomybes
(`multer`, `js-yaml`); plius `minio/minio` image pašalinimas iš Docker Hub.

⚠️ **Vartai tikrina repo būseną, o merge gate turėtų klausti apie pakeitimą.** Tai
ta pati klasė kaip kitur: patikra, kurios subjektas nėra peržiūrimas pokytis.
Padarius ją privaloma, bypass virstų kasdienybe — o tada jis nustoja būti
valdomas kelias.

> **Sąlyga, kada jis tampa privalomu:** kai atsakys į klausimą *„ar ŠIS PR įvedė
> pažeidžiamumą"* — t. y. kai bus lyginamas auditas prieš/po PR priklausomybių
> pakeitimų, o repo būsenos auditas persikels į tvarkaraštį.

⚠️ **Priimta rizika, pasakyta garsiai:** #307 (`multer`) buvo padarytas **todėl**,
kad gate'as krito. Patariamuoju jis tokio spaudimo nebedaro. Tai priimtina tik
todėl, kad Dependabot PR toliau ateina savarankiškai — jei jie nustotų, ši eilutė
nustoja galioti.

### CodeQL — signalas, ne merge kontrakto dalis (D4)

**Išmatuota:** `GET /repos/…/code-scanning/default-setup` grąžina
`state: configured`. CodeQL check-runs (`Analyze (actions)`,
`Analyze (javascript-typescript)`, `Analyze (python)` ir agregatas `CodeQL`) kuria
**GitHub default setup**, ne repo workflow — todėl `.github/workflows/` jų failo
nėra ir negali būti.

Iš to seka trys dalykai:

1. jis **negali** būti `required-ci` dalis — `needs:` veikia tik vieno workflow
   ribose;
2. jo check'ų vardai yra **GitHub valdomi**; įrašyti juos į required aibę reikštų
   rankinį sąrašą svetimoje sistemoje, be jokios drift apsaugos — pakeitus kalbų
   rinkinį required check tyliai virstų `missing`;
3. jo aprėptis (savaitinis tvarkaraštis plius PR) skiriasi nuo `ci.yml`.

⚠️ **„Signalas" NEREIŠKIA „niekas neskaito".** CodeQL radiniai eina į **Security
tab** ir generuoja **alerts** — tai jo vartotojas, ir jis įvardijamas čia
sąmoningai. Radinys, kurio niekas neskaito, po metų būtų dar vienas „egzistuoja,
bet nieko nekeičia" atvejis.

**Peržiūros riba:** `critical`/`high` CodeQL alert sprendžiamas kaip bet kuris
saugumo radinys — per issue, ne per merge bloką.

### Stacked-PR politika (D7)

`ci.yml` trigeris lieka `pull_request: branches: [main]`. PR, kurio bazė nėra
`main`, šio CI negauna.

**Kodėl taip.** `main` apsauga saugo **`main`**, ne visas šakas. Filtro
pašalinimas reikštų **pakartotinį CI** kiekvienam tarpiniam PR — kaina be
atitinkamos garantijos.

⚠️ Garantija „joks PR į jokią bazę nemerginamas be CI" yra **platesnis kontraktas
nei D1**, ir jei jo kada nors reikės, jis priimamas atskirai. Šis pasirinkimas
`main` apsaugos nesusilpnina.

#### ⚠️ Retargetas CI NESUKELIA (8 scenarijus, išmatuota)

Ankstesnė šio skyriaus redakcija teigė, kad „kai stacked PR retargetinamas į
`main`, suveikia ir CI, ir vartai". **Pirmoji pusė neteisinga.**

`ci.yml` turi `pull_request:` be `types:`, tad galioja numatytieji —
`opened`, `synchronize`, `reopened`. Bazės keitimas kelia `edited`, kurio tame
sąraše **nėra**. Retargetas naujo CI paleidimo nesukuria.

**Matavimas (PR #357, 2026-09-15, `head_sha` `c4805b9`):**

| Laikas (UTC) | Įvykis | CI |
|---|---|---|
| `20:06:42` | `base_ref_changed` — retarget į `main` | **nepaleista** |
| `20:09:03` | `closed` | — |
| `20:09:08` | `reopened` | — |
| `20:09:10` | — | paleista `run=35017869151`, `event=pull_request` |

CI startavo **2 s po `reopened`**, ne po retarget'o, kuris įvyko 2,5 min anksčiau.

**Ką tai reiškia vartams.** Nieko blogo: `required-ci` niekada nepraneša
rezultato, GitHub jį rodo kaip `Expected`, ir PR lieka **BLOCKED**. Elgsena
**fail-closed** — vartai laiko, o ne praleidžia.

⚠️ **Bet operatoriui tai reiškia veiksmą.** Retargetinus stacked PR, CI reikia
sukelti **atskirai**: `git commit --allow-empty` + push (`synchronize`) arba
PR uždarymas ir atidarymas (`reopened`). Prielaida „retargetinau, palauksiu CI"
baigiasi neribotu laukimu.

⚠️ `types: [..., edited]` pridėjimas šią spragą uždarytų, bet kainuotų CI
paleidimą kiekvienam pavadinimo ar aprašymo redagavimui. Nepriimta; jei
prireiks — sprendžiama atskirai.

### Emergency bypass

**Procedūra** — `docs/operations/OPERATIONAL_PROCEDURES.md` §3a: kada leidžiama,
šeši privalomi laukai, kaip patikrinama, kad įrašas atsirado.

**Registras** — žemiau. ⚠️ Viena vieta, ne dvi: procedūra sako *kaip*, registras
fiksuoja *kas įvyko*. Įrašai dedami **naujausi viršuje**.

#### ⚠️ Dvi įrašų rūšys, ir jos NESUPLAKAMOS

D6 sako: bypass skirtas **išoriniam ar infrastruktūriniam** gedimui. Bet registre
neišvengiamai atsiranda ir kitokių įrašų — netyčinių bei bandomųjų. Jie
**privalo** būti pažymėti, nes kitaip pirmas precedentas išmoko, kad „konfigūracija
buvo per plati" yra priimtina bypass priežastis.

Todėl kiekvienas įrašas turi lauką **„Ar pagrįstas pagal D6"**, ir jis gali būti
`NE`. Neįrašytas bypass yra blogiau nei įrašytas nepagrįstas.

#### Įrašas 2 — acceptance scenarijus 7 (2026-09-15)

| Laukas | Reikšmė |
|---|---|
| **PR/commit** | PR **#358** · merge commit **`43f29a3`** (`43f29a3d65d040718cd297678ca52af6ca77fefb`), 2026-09-15 21:05 UTC |
| **Apeitas check** | `required-ci` — būsena **`failure`** ⚠️ ne `cancelled`, žr. pastabą |
| **Priežastis** | #324 acceptance scenarijus 7: įrodyti, kad bypass kelias veikia ir palieka įrašą |
| **Įrodymas** | CI paleidimas `35022569706` **atšauktas sąmoningai** (`conclusion: cancelled`), ne sugedęs; `backend` ir `docker` — `cancelled` |
| **Patvirtino** | repozitorijos savininkas |
| **Follow-up issue** | nereikia — vienkartinis, acceptance dalis |
| **Ar pagrįstas pagal D6** | ⚠️ **NE** — tai **bandymas**, ne avarija. Įrašomas todėl, kad scenarijus 7 reikalauja įrodyti ne tik „bypass įmanomas", bet ir „bypass palieka pėdsaką" |

⚠️ **Pastaba: atšauktas CI duoda `required-ci: failure`, ne `cancelled`** —
išmatuota, ne prognozuota.

Atšaukus paleidimą, `backend` ir `docker` gavo `cancelled`, bet **gate job vis
tiek įvykdytas** (`if: always()`) ir pats grąžino `failure`, nes jo taisyklė
`cancelled` laiko nesėkme.

Tai **trečias nepriklausomas** to paties patvirtinimas — ir pirmas iš **tikro**
atšaukimo, ne iš sintetinės mutacijos (ankstesni: run `35011861118` su
`if: false`, ir run `35017869151`, kur `docker` praleistas dėl kritusio
`backend`).

Praktinė pasekmė operatoriui: **atšauktas CI merge'o neatrakina** — jis atrodo
kaip nesėkmė, o ne kaip „patikra neįvyko".

#### Įrašas 1 — netyčinis bypass per per platų `bypass_mode` (2026-09-15)

| Laukas | Reikšmė |
|---|---|
| **PR/commit** | `2cba0bd` — tiesioginis push į `main` |
| **Apeitas check** | `pull_request` **ir** `required-ci` — abi taisyklės vienu metu |
| **Priežastis** | ruleset `bypass_actors` turėjo `RepositoryRole 5` su `bypass_mode: always`; savininko push'as taisykles apėjo **tyliai leidžiamas**, ne blokuojamas |
| **Įrodymas** | pakeitus `bypass_mode` į `pull_request`, tas pats push atmestas su **`GH013`** — t. y. priežastis buvo konfigūracija, ne teisių trūkumas |
| **Patvirtino** | repozitorijos savininkas (acceptance scenarijus 6) |
| **Follow-up issue** | **nereikia** — konfigūracija ištaisyta tą pačią dieną |
| **Ar pagrįstas pagal D6** | ⚠️ **NE** — netyčinis. Jokio išorinio gedimo nebuvo |

⚠️ **Ką šis įrašas iš tikrųjų parodė.** Scenarijus 6 buvo skirtas patikrinti, ar
tiesioginis push blokuojamas. Jis parodė daugiau: **`bypass_mode: always` reiškia
„visada", įskaitant `git push`**, ir tokia konfigūracija D5 („tiesioginis push
normaliajame kelyje blokuojamas") **nepatenkina** — savininkui normalus kelias
tampa apėjimu be jokio pranešimo.

`bypass_mode: pull_request` palieka bypass **PR kelyje**, kur jis matomas ir
registruojamas, o tiesioginį push blokuoja. Tai ir yra D6 skirtumas tarp *valdomo
kelio* ir *vartų išjungimo* — tik šįkart išmatuotas, ne aprašytas.

### Kaip operatorius patikrina, kad apsauga TEBĖRA aktyvi

```bash
# 1. Ar ruleset/branch protection egzistuoja ir ką jis reikalauja
gh api repos/forevercornix/stenograma/rulesets --jq '.[] | {id, name, target, enforcement}'

# 2. Privalomų check'ų aibė — turi būti LYGIAI ["required-ci"]
gh api repos/forevercornix/stenograma/rulesets/<ID> \
  --jq '.rules[] | select(.type=="required_status_checks")
        | .parameters.required_status_checks[].context'

# 3. Ar tiesioginis push blokuojamas (turi būti non_fast_forward / pull_request taisyklės)
gh api repos/forevercornix/stenograma/rulesets/<ID> --jq '[.rules[].type]'

# 4. Kas gali apeiti — sąrašas turi būti TRUMPAS ir žinomas
gh api repos/forevercornix/stenograma/rulesets/<ID> --jq '.bypass_actors'
```

⚠️ **Konfigūracijos peržiūra nėra įrodymas.** Ji rodo, kas nustatyta, ne ką
GitHub realiai daro. Vienintelis įrodymas yra PR, kuriame required check raudonas
arba nepasirodė, ir **merge mygtukas užblokuotas**.

## Priklausomybių skenavimas

- **Dependabot**: npm (`/backend`, `/frontend`), pip (`/backend/scripts`,
  `/pyannote-server`, `/whisper-server`) ir `github-actions` (`/`).
- **CodeQL**: JavaScript/TypeScript, Python ir Actions.

⚠️ `dependabot.yml` sintaksės klaida **išjungia visą failą tyliai** — GitHub
neatnaujina nieko ir apie tai nepraneša matomai. Todėl CI tikrina šio failo
sintaksę (žr. `ci.yml` `workflow-policy` job'ą).

## Ką tikrina automatika, o ką — žmogus

`scripts/check-workflow-policy.mjs` tikrina statiškai patikrinamus dalykus:
`permissions` blokai ir write teisės, `pull_request_target`, paslapčių vieta
(`env` workflow ar job lygiu, `secrets: inherit`), `persist-credentials`,
action'ų prisegimas, panaudojami workflow, job'ų laiko ribos, artefaktų retencija
ir `dependabot.yml` poros.

**Rankiniai punktai** — jų iš kodo patikrinti neįmanoma:

1. `Settings → Actions → General → Workflow permissions` = „Read repository
   contents and packages permissions".
2. `Settings → Code security` — CodeQL įjungtas ir apima **JavaScript/TypeScript,
   Python ir Actions**. Konfigūracija gali būti GitHub Default Setup, tad kode jos
   nematyti; prieš uždarant #16 verta patikrinti, kad visos trys kalbos aktyvios
   ir skenavimas praeina.
3. Ar konkrečiam job'ui tikrai reikia jam suteiktos write teisės — allow-list
   `ALLOWED_JOB_WRITES` fiksuoja sprendimą, bet jo nepriima.

## Išimčių procesas

Kai pažeidžiamumas negali būti pataisytas iš karto (nėra pataisos, laužtų
suderinamumą, tiekėjo problema):

1. **Užrašyti** išimtį šiame faile, skiltyje „Galiojančios išimtys" — su CVE ar
   alerto nuoroda, priežastimi ir peržiūros data.
2. **Apriboti poveikį**, jei įmanoma (išjungti funkciją, apriboti prieigą).
3. **Peržiūrėti** ne rečiau kaip kas 90 dienų arba pasirodžius pataisai.
4. **CodeQL alertą** dismiss'inti tik su nuoroda į šį įrašą — niekada „Won't fix"
   be paaiškinimo.

Išimtis be datos ir be atsakymo į klausimą „kada peržiūrėsim" nėra išimtis, o
tiesiog nutylėta problema.

### Galiojančios išimtys

Šiuo metu nėra.
