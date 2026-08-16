#!/usr/bin/env bash
#
# Papildymas: CHANGELOG v1.3.0 įraše trūksta commit'ų skaičiaus.
#
# Ankstesnė skripto versija jo neturėjo, o jos commit message nurodė 69.
# Tikras skaičius intervale v1.2.0..v1.3.0 yra 70 (36 be merge).
#
# Paleisti IŠ REPOZITORIJOS ŠAKNIES, main šakoje:
#     bash fix-changelog-counts.sh

set -euo pipefail

ok()  { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die() { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d .git ] || die "Paleiskite iš repozitorijos šaknies."
[ -f CHANGELOG.md ] || die "Nerandu CHANGELOG.md."
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "Yra nekomituotų pakeitimų. Sutvarkykite ir paleiskite iš naujo."

if grep -qF "Skaičiai matuoti intervale" CHANGELOG.md; then
  ok "Jau pataisyta — nieko nekeičiama."
  exit 0
fi

OLD="Didžiausias leidimas iki šiol: **145 failai, +24 013 / −1 376 eilutės**. Backend"
grep -qF -- "$OLD" CHANGELOG.md || die "Nerasta tikėtina eilutė. Patikrinkite CHANGELOG.md rankiniu būdu."

# Tikrinam skaičių pačiu git, o ne pasitikim atmintimi.
if git rev-parse v1.2.0 >/dev/null 2>&1 && git rev-parse v1.3.0 >/dev/null 2>&1; then
  N_ALL="$(git rev-list --count v1.2.0..v1.3.0)"
  N_NOMERGE="$(git rev-list --count --no-merges v1.2.0..v1.3.0)"
  ok "Išmatuota: $N_ALL commit'ai ($N_NOMERGE be merge)"
else
  N_ALL=70; N_NOMERGE=36
  ok "Žymų nerasta (seklus klonas?) — naudojamos patikrintos reikšmės 70/36"
fi

cat > .cl-head.tmp <<EOF_HEAD
Didžiausias leidimas iki šiol: **${N_ALL} commit'ai** (${N_NOMERGE} be merge), **145 failai,
+24 013 / −1 376 eilutės**. Backend testų nuo 558 iki **1042**, frontend nuo
55 iki **64**.

Skaičiai matuoti intervale \`v1.2.0..v1.3.0\`.

EOF_HEAD

awk -v target="$OLD" -v secfile=".cl-head.tmp" '
  $0 == target && !done {
    while ((getline line < secfile) > 0) print line
    done = 1
    skip = 2          # praleidžiam dvi likusias senos pastraipos eilutes
    next
  }
  skip > 0 { skip--; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md
rm -f .cl-head.tmp

grep -qF "Skaičiai matuoti intervale" CHANGELOG.md || die "Pakeitimas nepavyko."
grep -qF "Kryptis ta pati, kaip v1.2.0" CHANGELOG.md || die "Prarasta kita pastraipa — git checkout CHANGELOG.md"
grep -qF "### Added – autentifikacija" CHANGELOG.md || die "Struktūra pažeista — git checkout CHANGELOG.md"
ok "CHANGELOG.md papildytas"

git add CHANGELOG.md
git commit -q -F - <<EOF_MSG
docs(changelog): v1.3.0 įraše nurodomas commit'ų skaičius

Ankstesnis commit'as (d641922) įrašo apimtį aprašė tik failais ir
eilutėmis, o jo aprašyme nurodytas commit'ų skaičius (69) buvo klaidingas:
jis išmatuotas intervale v1.2.0..HEAD prieš release commit'ą, o ne
v1.2.0..v1.3.0.

Tikras skaičius: ${N_ALL} commit'ai (${N_NOMERGE} be merge). Pridėta ir eilutė,
nurodanti, kokiame intervale skaičiai matuoti - kad kitą kartą nereikėtų
spėlioti.
EOF_MSG
ok "Commit sukurtas"

printf '\n'
printf 'Peržiūrėti:  git show HEAD -- CHANGELOG.md\n'
printf 'Toliau:      git push\n'
