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
