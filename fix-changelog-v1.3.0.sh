#!/usr/bin/env bash
#
# Stenograma: CHANGELOG v1.3.0 įrašo pataisymas.
#
# KODĖL: v1.3.0 įrašas teigė „Funkcinių pakeitimų nėra". Tai buvo tiesa apie
# licencijos commit'ą, bet NE apie v1.3.0 versiją: nuo v1.2.0 į main sugulė
# 69 commit'ai, iš jų 18 feat/fix - auth/RBAC, gyvavimo ciklas, backup/restore,
# tiekėjų valdysena, vertinimo karkasas, incidentų procedūros.
#
# Paleisti IŠ REPOZITORIJOS ŠAKNIES, esant main šakoje:
#     bash fix-changelog-v1.3.0.sh
#
# Skriptas NIEKO nesiunčia į GitHub ir žymos nejudina.

set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die() { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d .git ] || die "Paleiskite iš repozitorijos šaknies."
[ -f CHANGELOG.md ] || die "Nerandu CHANGELOG.md."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "Nekomituotų pakeitimų sekamuose failuose:"
  git status --short
  die "Sukomituokite arba atstatykite juos ir paleiskite iš naujo."
fi

grep -q "^## v1.3.0" CHANGELOG.md || die "CHANGELOG.md neturi v1.3.0 skyriaus."
grep -q "^## v1.2.0" CHANGELOG.md || die "CHANGELOG.md neturi v1.2.0 skyriaus (reikia ribos)."

if grep -q "Milestone 2: prieiga, duomenų valdymas" CHANGELOG.md; then
  ok "CHANGELOG jau pataisytas — nieko nekeičiama."
  exit 0
fi

cat > .changelog-v130.tmp <<'EOF_ENTRY'
## v1.3.0 – Milestone 2: prieiga, duomenų valdymas ir operacinis pasirengimas

Didžiausias leidimas iki šiol: **145 failai, +24 013 / −1 376 eilutės**. Backend
testų nuo 558 iki **1042**, frontend nuo 55 iki **64**.

Kryptis ta pati, kaip v1.2.0: ne naujos vartotojo funkcijos, o **prielaidų
pavertimas tikrinamomis garantijomis** – tik šįkart ne privatumo, o prieigos,
duomenų gyvavimo ciklo ir operacinio pasirengimo srityse.

### Added – autentifikacija ir prieigos kontrolė

- **Sesijomis paremta autentifikacija** (`routes/auth.js`, `utils/sessionStore.js`,
  `utils/credentials.js`, `middleware/sessionAuth.js`) – scrypt slaptažodžiai,
  sesijos ID rotacija po prisijungimo, vartotojų enumeracijos apsauga.
- **Centralizuota vaidmenimis paremta prieigos kontrolė** (`middleware/authorize.js`,
  `utils/permissions.js`, `utils/jobAuthorization.js`) – leidimai apibrėžti vienoje
  vietoje, ne išbarstyti po maršrutus.
- **Aktoriaus kontekstas perduodamas worker'iams ir audit log'ui**
  (`feat(auth): propagate safe actor context`) – asinchroninis jobas nebepraranda
  informacijos, kas jį inicijavo.
- RBAC frontend'e, regresijos testai (`RolePermissions.test.jsx`) ir diegimo
  dokumentacija (`docs/auth-deployment.md`).

### Added – duomenų gyvavimo ciklas ir GDPR ištrynimas

- **Artefaktų inventorius ir gyvavimo ciklo modelis** (`utils/artefactInventory.js`,
  `utils/artefactScanner.js`, `services/lifecycleService.js`) – kiekvienas sistemoje
  atsirandantis duomenų artefaktas turi įvardytą savininką ir gyvavimo trukmę.
- **Koordinuotas ištrynimas** (`feat(gdpr)`) – ištrynimas vykdomas per visus
  saugojimo sluoksnius vienu metu, su `utils/deletionTombstones.js` žymėmis, kad
  pakartotinis įrašymas po ištrynimo būtų aptinkamas.
- **Sugriežtinta retencija ir valymas po restarto** (`feat(retention)`) – nutrūkęs
  worker'is nebepalieka pakibusių audio failų.
- Garantijos aprašytos `docs/artefact-lifecycle.md` ir `docs/deletion-guarantees.md`,
  padengtos end-to-end testais.

### Added – atsarginės kopijos ir atkūrimas

- **Kopijų politika ir manifesto modelis** (`utils/backupPolicy.js`,
  `utils/backupManifest.js`) – kas į kopiją patenka ir kas sąmoningai nepatenka.
- **Kūrimas, šifravimas ir atkūrimas** (`services/backupService.js`,
  `services/restoreService.js`, `utils/backupEncryption.js`, `routes/backup.js`).
- **Gyvavimo ciklą suprantantis atkūrimas ir raktų valdymas** (`feat(security)`) –
  atkūrimas negrąžina to, kas buvo teisėtai ištrinta. Tai buvo neakivaizdi vieta:
  be jos GDPR ištrynimas būtų atšaukiamas viena „restore" komanda.
- Procedūros: `docs/backup-runbook.md`, end-to-end atkūrimo scenarijų testai.

### Added – tiekėjų valdysena

- **Tiekėjų inventorius ir diegimo privatumo kontrolinis sąrašas**
  (`utils/providerGovernance.js`, `docs/provider-governance.md`) – kuris tiekėjas
  kokius duomenis mato ir kur jie fiziškai keliauja.
- **Politikos taikymas paleidimo metu ir provider factory viduje** – netinkama
  konfigūracija sustabdo startą, o ne tyliai praeina iki pirmos užklausos.
- **Apėjimo apsaugų testai** (`test(governance): prove provider policy cannot be
  bypassed`) – įrodyta, kad politikos negalima apeiti per override mechanizmus.

### Added – kokybės vertinimas

- **Vertinimo karkasas ir benchmark protokolas** (`docs/evaluation-protocol.md`,
  `utils/evaluationManifest.js`, `utils/qualityMetrics.js`) – WER/CER metodika,
  atkuriamumo reikalavimai.
- **Protokolo vertinimo rubrika ir atsekamumo modelis** (`utils/protocolRubric.js`,
  `utils/protocolTraceability.js`, `docs/protocol-evaluation-rubric.md`) – kaip
  vertinti sugeneruoto protokolo kokybę, ne tik transkripcijos tikslumą.

### Added – operacinis pasirengimas

- **Incidentų valdymo karkasas** (`docs/operations/INCIDENT_RESPONSE.md`) –
  klasifikacija, eskalavimas, pranešimo terminai.
- **Įrodymų išsaugojimo ir atkūrimo procedūros**
  (`docs/operations/OPERATIONAL_PROCEDURES.md`).
- **Postmortem šablonas ir pratybos** (`docs/operations/POSTMORTEM_AND_EXERCISES.md`).
- **Piloto chartija** (`docs/pilot/PILOT_CHARTER.md`) – apimtis, ribos ir sąlygos
  pirmajam realiam diegimui.

Šie dokumentai nėra vien tekstas: dalis jų tikrinama automatiniais testais
(`backupDocumentation`, `incidentRunbook`, `operationalProcedures`,
`postmortemTemplate`, `pilotCharter`), kurie lygina dokumentuose nurodytus
skaičius su realiomis kodo konstantomis.

### Changed – licencija

**MIT → EUPL-1.2-or-later.** Nuo šios versijos projektas platinamas pagal European
Union Public Licence 1.2 arba, gavėjo pasirinkimu, vėlesnę Komisijos patvirtintą
EUPL versiją (SPDX identifikatorius `EUPL-1.2`). `LICENSE` tekstas paimtas iš SPDX
license-list-data canonical šaltinio be perrašymo.

**Versijos iki `v1.2.0` imtinai lieka MIT.** Ta licencija neatšaukiama ir toms
versijoms galioja neterminuotai – užfiksuota `LICENSE-HISTORY.md`, originalus
tekstas išsaugotas `LICENSE-MIT`.

**Autorių teisių turėtoja nurodyta tiksliai:** Juliana Vorono-Baranovska. Anksčiau
`LICENSE` faile buvo įrašyta „Stenograma" – subjektas, kuris teisiškai neegzistuoja.

Pridėta: `CONTRIBUTING.md` su įnašų licencijavimo sąlygomis,
`.github/pull_request_template.md` su patvirtinimo varnele, `LICENSE-COMMERCIAL.md`
ir `AUTHORSHIP.md` (kas projektą sukūrė, kaip, ir ką reiškia kelios commit'ų
tapatybės git istorijoje).

### Fixed

- `fix(security)`: klaidų detalės sanitizuojamos ir Python servisuose – anksčiau
  tik Node pusėje.
- `fix(ui)`: laikmatis išvalomas komponentui išsimontuojant.
- `fix(deps)`: `numpy` prisegtas prie 2.4.6 – 2.5+ reikalauja Python 3.12.
- Dokumentacijos skaičiai suderinti su realybe: backend testai `558` → **1042**,
  `backend/README` `107` → **1042**, frontend `24` → **64**, Node.js `20` → **22**
  README ir RUNPOD.md (v1.2.0 CHANGELOG klaidingai teigė, kad Node versija
  pakeista „visose vietose").
- `nanoid` → 3.3.18 (GHSA-2v37-7h3g-55p8, tranzityvi per postcss).

### Security

- Laikina, dokumentuota `PYSEC-2026-3624` (CVE-2026-58659) išimtis pyannote
  priklausomybių audite: `lightning <= 2.6.5` turi RCE spragą
  `load_from_checkpoint` kelyje, tačiau pataisymas egzistuoja tik commit'e
  `d710d68` ir į išleistą PyPI versiją dar nepateko. Pagrindimas ir šalinimo
  sąlyga įrašyti `ci.yml`.

### Housekeeping

Šaknyje gulėję vienkartiniai issue kūrimo skriptai perkelti į `scripts/dev/`,
leidimo pastabos į `docs/releases/`, GitHub diegimo instrukcijos į `docs/`.
Nieko neištrinta.

### Ko šiame leidime NĖRA

Sąžiningai, kad README ir CHANGELOG neklaidintų:

- **Vertinimo karkasas yra, bet realių matavimų rezultatų dar nėra** – WER/CER
  lietuvių kalbai neišmatuoti. Metodika aprašyta, skaičių nėra.
- **PostgreSQL rezultatams ir MinIO/S3 objektams** – vis dar Milestone 2 likutis;
  sesijos ir audit log tebėra atmintyje.
- **Realaus piloto dar nebuvo** – chartija parašyta, diegimo neįvyko.

---

EOF_ENTRY

# Pakeičiame VISKĄ tarp "## v1.3.0" ir "## v1.2.0" nauju įrašu.
awk -v secfile=".changelog-v130.tmp" '
  /^## v1\.3\.0/ && !started {
    while ((getline line < secfile) > 0) print line
    started = 1
    skipping = 1
    next
  }
  skipping && /^## v1\.2\.0/ { skipping = 0 }
  !skipping { print }
' CHANGELOG.md > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md
rm -f .changelog-v130.tmp

grep -q "Milestone 2: prieiga, duomenų valdymas" CHANGELOG.md \
  || die "Pakeitimas nepavyko."
grep -q "^## v1.2.0" CHANGELOG.md \
  || die "Prarastas v1.2.0 skyrius — atstatykite: git checkout CHANGELOG.md"
grep -q "Funkcinių pakeitimų nėra" CHANGELOG.md \
  && die "Senas tekstas vis dar yra — patikrinkite rankiniu būdu."

ok "CHANGELOG.md v1.3.0 įrašas perrašytas"

git add CHANGELOG.md
git commit -q -F - <<'EOF_MSG'
docs(changelog): v1.3.0 įrašas atspindi realią leidimo apimtį

Ankstesnis įrašas teigė „Funkcinių pakeitimų nėra". Tai buvo tiesa apie
licencijos commit'ą, bet ne apie v1.3.0 versiją: nuo v1.2.0 į main sugulė
69 commit'ai (145 failai, +24013/-1376), iš jų 18 feat/fix.

Neišvardyta buvo: sesijomis paremta autentifikacija ir RBAC, artefaktų
gyvavimo ciklas ir koordinuotas GDPR ištrynimas, atsarginės kopijos su
lifecycle-aware atkūrimu, tiekėjų valdysena su startup enforcement,
vertinimo karkasas ir protokolo rubrika, incidentų valdymo procedūros,
piloto chartija.

Pridėtas ir „Ko šiame leidime NĖRA" skyrius: vertinimo karkasas yra, bet
realių WER/CER matavimų dar nėra; PostgreSQL/S3 lieka Milestone 2 likučiu;
realaus piloto dar nebuvo.

Žyma v1.3.0 nejudinama — ji rodo į teisingą commit'ą.
EOF_MSG
ok "Commit sukurtas"

printf '\n'
say "Peržiūrėti:  git show HEAD -- CHANGELOG.md | head -60"
say "Toliau:      git push"
