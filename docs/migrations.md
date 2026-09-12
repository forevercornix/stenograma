# Migracijos

`node-pg-migrate`, ne ORM — projektas jo neturi ir nereikalauja.

⚠️ **Prievadas gali būti užimtas.** Compose publikuoja PostgreSQL ties
`127.0.0.1:${POSTGRES_HOST_PORT:-5432}`. Jei mašinoje jau veikia kitas
PostgreSQL, nustatykite kitą reikšmę šakniniame `.env` ir atitinkamai pakeiskite
`DATABASE_URL`:

```bash
POSTGRES_HOST_PORT=55432
DATABASE_URL=postgres://stenograma:...@localhost:55432/stenograma
```

⚠️ **Komandos vykdomos `backend/` kataloge.** `migrate:*` skriptai gyvena
`backend/package.json`, o `.node-pg-migraterc` kelias (`dir: "migrations"`)
irgi santykinis jam. Šakninio `package.json` repo neturi.

```bash
cd backend
DATABASE_URL=postgres://... npm run migrate:up
DATABASE_URL=postgres://... npm run migrate:create pavadinimas
```

Arba iš šaknies:

```bash
DATABASE_URL=postgres://... npm --prefix backend run migrate:up
```

⚠️ **`checkOrder: true`** sąmoningai: jei kas nors prideda migraciją su
ankstesne laiko žyme nei jau pritaikyta, `node-pg-migrate` sustos, o ne
pritaikys ją ne eilės tvarka. Tyliai pritaikyta migracija ne eilės tvarka
reikštų, kad dvi aplinkos turi tą pačią `pgmigrations` lentelę, bet skirtingą
schemą.

Schemos turinys — 7.2a (#179). Šis PR pateikia tik karkasą.

---

## ⚠️ Atnaujinant į 7.4e: `PG*` diegimai ir `erasure_marks`

**Kas pasikeitė.** Iki 7.4e ištrynimo žymos rinkosi PostgreSQL **tik** pagal
`DATABASE_URL`. Diegimas, konfigūruotas per `PGHOST`/`PGUSER`/… (dokumentuotas
Compose kelias), tyliai laikė žymas atmintyje, nors auditas jau rašė į duomenų
bazę. Nuo 7.4e `PG*` priimamas lygiai taip pat.

**Ką tai reiškia operatoriui.** `PG*`-only diegime `erasure_marks` lentelė nuo
šiol **privaloma**:

- jei migracijos pritaikytos — nieko daryti nereikia;
- jei ne — `/api/ready` grąžins `503` su `auditBarrierReachable: false`, o
  blokuojantis auditas (pvz. prisijungimas) kris `AUDIT_WRITE_FAILED`.
  Procesas **nekrinta** ir liveness (`/api/health`) lieka `200`, tad langas
  migracijoms pritaikyti išlieka.

**Veiksmas.** Prieš atnaujinant paleiskite migracijas prieš **tą pačią** duomenų
bazę, į kurią rodo audito pool'as:

```bash
cd backend
DATABASE_URL=postgres://... npm run migrate:up
```

⚠️ Aukščiau esančios komandos naudoja `DATABASE_URL`. `PG*`-only diegime
nurodykite jį **laikinai, tik migracijoms** — arba įsitikinkite, kad
`node-pg-migrate` jungiasi prie tos pačios bazės. Migravus į kitą bazę nei
audito, barjeras liktų neveikiantis, o `/api/ready` — teisėtai `503`.

Garantijos formuluotė — `docs/deletion-guarantees.md` §1 ir §2.

---

## ⚠️ Atnaujinant į #157 PR-7: `ARTIFACT_STORE_BACKEND` tapo starto sąlyga

**Kas pasikeitė.** Iki šio leidimo serveris `ARTIFACT_STORE_BACKEND` **netikrino
visai** — diegimas su `ARTIFACT_STORE_BACKEND=s3` ir trūkstamu raktu startuodavo
ir tyliai rašydavo `inline`. Nuo dabar toks diegimas **nepakils**: rezultatai
atsidurtų kitoje saugykloje, nei mano operatorius, ir tai paaiškėtų tik tada, kai
jų prireiktų.

**Kaip atpažinti.** Startas krenta su pranešimu, vardijančiu **trūkstamus
kintamuosius** (ne jų reikšmes). Prieš atnaujinant tą pačią būseną parodo `doctor`:

```bash
cd backend && npm run doctor
# ❌ Artefaktų saugyklų prijungimas (startas): parinkta 's3', bet rašymo saugykla
#    NEPRIJUNGTA — rezultatai rašomi 'inline'
```

Ta pati varnelė matoma ir `/api/health/deep` išvestyje (production'e — su
`x-audit-key`).

**Kaip atsukti.** Pašalinti `ARTIFACT_STORE_BACKEND` iš aplinkos: diegimas grįžta į
`inline` **eksplicitiškai**, ne tyliai, ir startuoja. Kodo atsukti nereikia — tai
konfigūracijos veiksmas, atliekamas per vieną perleidimą.

⚠️ Nustačius `fs` ar `s3`, **grįžimas į `inline` nebeįmanomas tyliai** ir tai
sąmoninga: tylus grįžimas yra būtent tas gedimas, kurį ši riba uždaro.

## ⚠️ Cutover: Redis → PostgreSQL job metaduomenys (#155)

⚠️ **VYKDOMA PROCEDŪRA. Sprendimą ir jo priežastis aprašo
`docs/decisions/155-postgres-authority.md`; čia — tik veiksmai ir patikros.**

⚠️ **ĮSIGALIOJA KARTU SU AKTYVAVIMO BARJERU.** Kol
`POSTGRES_AKTYVAVIMAS_LEISTAS = false`, PostgreSQL job store'u netampa, ir ši
procedūra nevykdoma.

### Kam ji reikalinga

**Esami Redis job metaduomenys NĖRA perkeliami į PostgreSQL** — tai sąmoningas
sprendimas („TTL nutekėjimas, ne migracija"): job metaduomenys trumpaamžiai, o
migracijos skriptas turėtų atkartoti visą `deserialize` logiką, `owner_kind`
semantiką ir fazių invariantus.

⚠️ **BET TTL NEVEIKIA VISIEMS ĮRAŠAMS, IR TAI YRA PROCEDŪROS PRIEŽASTIS.**
`redisStore.update()` taiko `EXPIRE` **tik** terminaliems įrašams
(`redisStore.js:285`). Vadinasi:

| Įrašo būsena | Kas su juo nutinka | Pasekmė |
|---|---|---|
| `queued` / `processing` | TTL **negauna** | lieka Redis'e **neribotai** kartu su `storageKey` |
| terminalus su `audio_cleanup_pending` ar `deletion_pending` | `PERSIST` — TTL **nuimamas** | hash'as gali būti **vienintelis** `storageKey` ir retry būsenos šaltinis |
| terminalus be laukiančio valymo | `EXPIRE` po `JOB_TTL_MINUTES` | dingsta pats |

Po perjungimo naujas autoritetas apie tuos įrašus **nežino**, o Redis sweeper'is
jų nebešalina. Tai GDPR klausimas, ne operacinis: jautrūs metaduomenys lieka
saugykloje, kurios niekas nebeprižiūri.

### Žingsniai

| # | Veiksmas | Kodėl privalomas |
|---|---|---|
| 1 | Nustoti priimti naujus job'us (`503` arba priežiūros režimas) | be to 2 žingsnis niekada nesibaigs |
| 2 | Palaukti, kol `active` + `waiting` pasieks **0** | ⚠️ **`JOB_TTL_MINUTES` NĖRA drain timeout** — tai metaduomenų retencija, ne darbo trukmė |
| 2b | **Sustabdyti visus worker'ius** ir patvirtinti, kad nebedirba | veikiantis worker'is po 3 žingsnio parašytų naują įrašą |
| 3 | Terminalizuoti likusius `queued`/`processing`: `finish(FAILED, "cutover")` | `finish()` šaltinio netikrina, tad veikia ir sugadintiems (#154) |
| 3b | **Išlaisvinti orphan audio** — `releaseAudio(jobId, storageKey)` kiekvienam terminalizuotam | be to audio liktų pakibęs be jokio įrašo |
| 4 | **Palaukti, kol baigsis laukiantis valymas** (`audio_cleanup_pending`, `deletion_pending`) | ⚠️ žr. įspėjimą žemiau — tai ne formalumas |
| 5 | Nepasibaigusius `completed` įrašus **perkelti arba palaukti** jų retencijos | ⚠️ žr. įspėjimą žemiau |
| 5b | Ištrinti hash'us **ir indeksą** | žr. komandą žemiau |
| 6 | Patikrinti: nebeliko nei `job:*`, nei `jobs:index`, nei `*_pending` vėliavų | vienintelė patikra, kuri pagauna 5b praleidimą |
| 7 | Nustatyti **eksplicitinį** `JOB_STORE_BACKEND=postgres` | ⚠️ žr. „Eksplicitinis pasirinkimas" |
| 8 | Paleisti su nauju backend'u | — |

### ⚠️ 5b: aklas `job:*` trynimas PRARASTŲ duomenis

```bash
# Pirma — patikrinti, ar nėra laukiančio valymo (4 žingsnis):
redis-cli --scan --pattern 'job:*' | while read -r k; do
  redis-cli HMGET "$k" audio_cleanup_pending deletion_pending | grep -q true && echo "LAUKIA: $k"
done

# Tik tada:
redis-cli --scan --pattern 'job:*' | xargs -r redis-cli DEL
redis-cli DEL jobs:index
```

⚠️ **`job:*` NEAPIMA INDEKSO.** `jobs:index` yra atskiras sorted set
(`redisStore.js:42`), ir šablonas `job:*` jo **neatitinka** — nėra dvitaškio po
`job`. Perjungus, Redis sweeper'is jo nebešalina, tad metaduomenys liktų
neribotai, o 6 žingsnio patikra be `DEL jobs:index` **praeitų**.

⚠️ **HASH'AI SU `*_pending` YRA VIENINTELIS `storageKey` ŠALTINIS.**
`redisStore.update()` jiems taiko `PERSIST`, ne `EXPIRE`. Ištrynus juos anksčiau
laiko, liktų pakibęs jautrus audio arba nebaigtas ištrynimas, kurio niekas
nebeužbaigs. Todėl 4 žingsnis vykdomas **prieš** 5b, ir tai patikrinama.

### ⚠️ 5: nepasibaigę `completed` įrašai turi savo retenciją

Job'as, baigtas prieš pat 2 žingsnį, gauna **šviežią** `JOB_TTL_MINUTES` langą.
5b jį ištrintų iš karto, o klientas, apklausęs po priežiūros, gautų „nėra tokio
job'o" ir **negrįžtamai prarastų transkripciją**, kuri dar turėjo būti saugoma.

Todėl 5 žingsnis: **arba** nepasibaigę terminalūs įrašai perkeliami į PostgreSQL,
**arba** trynimas atidedamas, kol kiekvieno pažadėta retencija pasibaigs.

### ⚠️ Eksplicitinis pasirinkimas (7 žingsnis)

Perjungimas reikalauja **eksplicitinio** `JOB_STORE_BACKEND=postgres`. Vien
`DATABASE_URL` nepakanka **sąmoningai**: jį diegimai nustato ir sesijoms (7.3),
auditui ar migracijoms, o tylus perjungimas reikštų, kad job metaduomenų saugykla
pasikeitė tiems, kurie to neprašė.

### ⚠️ Restore procedūra privaloma PRIEŠ cutover, ne po jo

5b **ištrina visus** Redis `job:*` hash'us. Po perjungimo atkūrimo šaltinio
nebelieka: PostgreSQL dar tuščias, o Redis jau išvalytas. Tad
`docs/backup-runbook.md` §9a–§9d praeinama **prieš** šią procedūrą.

### Patikra po 6 žingsnio

```bash
redis-cli --scan --pattern 'job:*' | head -1      # tuščia
redis-cli EXISTS jobs:index                        # 0
```

⚠️ **Tuščias `job:*` be `EXISTS jobs:index` NĖRA įrodymas** — indeksas pro tą
šabloną nematomas.

## Artefaktų migracija: `inline` → external (#157, PR-6)

`node-pg-migrate` čia nedalyvauja. Tai **duomenų**, ne schemos migracija, ir ji
vykdoma atskirai, kai schema jau atnaujinta:

```bash
cd backend
DATABASE_URL=postgres://...                     node scripts/migrate-artifacts.mjs dry-run
DATABASE_URL=... ARTIFACT_STORE_BACKEND=fs      node scripts/migrate-artifacts.mjs run --limit 500
DATABASE_URL=...                                node scripts/migrate-artifacts.mjs status
```

Exit kodai: `0` sėkmė · `1` naudojimo klaida · `2` procedūros klaida ·
**`3` dalis eilučių neperkelta — reikia peržiūros** (`status` parodo, kurios ir
kodėl).

Paleidimas saugus kartoti: perkelta eilutė nebėra `inline`, tad atranka jos
nebemato. `--limit` grandinę galima leisti tiek kartų, kiek reikia.

### ⚠️ Ko tikėtis iš srauto — `s3` atveju jis DVIGUBAS

Prieš perjungdama nuorodą, migracija kiekvienai eilutei kviečia
`ArtifactStore.verify()`, o šis **perskaito visą objektą** ir perskaičiuoja
kontrolinę sumą. `s3` (ar bet kurios tinklinės saugyklos) atveju tai reiškia, kad
kiekviena eilutė **parsiunčiama atgal iš karto po įkėlimo**.

Praktinė pasekmė, kurios iš žodžio „migracija" nesitikima:

| | |
|---|---|
| Įkeliama | ~*N* × vidutinis rezultato dydis |
| Parsiunčiama | **tiek pat** |
| Viso srauto | **~2×** duomenų apimtis |

Prie leidžiamo 20 MiB vienos eilutės dydžio ir kelių dešimčių tūkstančių eilučių
tai virsta pralaidumo ir **egress kaštų** klausimu. Planuokite pagal dvigubą
apimtį ir leiskite dalimis (`--limit`), o ne vienu paleidimu.

⚠️ **Tai NĖRA neefektyvumas, kurį reikia pašalinti.** Iš karto po šios patikros
migracija ištrina `payload` — vienintelę galiojančią rezultato kopiją. `head()`
grąžina tik dydį, tad sugadintas **to paties ilgio** objektas ją praeitų, ir
kopija būtų sunaikinta mainais į nepatikrintą prielaidą (išmatuota:
`artifactMigration.integration`, CI 34360090645). Migracija yra vienintelė vieta
repo, kur skaitymo kaina mažesnė už klaidos kainą — kitur `verify()` metadata-only
keliuose sąmoningai **draudžiamas**.

Jei srautas nepriimtinas, teisingas sprendimas yra leisti mažesnėmis dalimis arba
ne piko metu — **ne** išjungti patikrą.
