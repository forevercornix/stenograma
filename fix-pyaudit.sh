#!/usr/bin/env bash
#
# PYSEC-2026-3624 (CVE-2026-58659) laikina išimtis CI audite.
#
# Paleisti IŠ REPOZITORIJOS ŠAKNIES:  bash fix-pyaudit.sh
#
# Skriptas NIEKO nesiunčia į GitHub.

set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die() { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

CI=".github/workflows/ci.yml"

[ -d .git ] || die "Paleiskite iš repozitorijos šaknies."
[ -f "$CI" ] || die "Nerandu $CI."

if grep -q "PYSEC-2026-3624" "$CI"; then
  ok "Išimtis jau yra — nieko nekeičiama."
  exit 0
fi

OLD='        run: pip-audit --requirement pyannote-server/requirements.txt --strict'
grep -qF -- "$OLD" "$CI" || die "Nerasta tikėtina pyannote audito eilutė. Patikrinkite $CI rankiniu būdu."

cat > .pyaudit-block.tmp <<'EOF_BLOCK'
        # LAIKINA IŠIMTIS: PYSEC-2026-3624 / CVE-2026-58659
        #
        # lightning <= 2.6.5 turi nuotolinio kodo vykdymo spragą
        # `_load_state` funkcijoje: kenkėjiškas checkpoint failas per
        # `_instantiator` hiperparametrus priverčia importuoti ir įvykdyti
        # bet kokį modulį, apeinant `weights_only=True` apsaugą, kai
        # kviečiama `LightningModule.load_from_checkpoint`.
        #
        # KODĖL IŠIMTIS, O NE ATNAUJINIMAS: pataisymas egzistuoja tik
        # commit'e d710d68 (PR Lightning-AI/pytorch-lightning#21832), bet į
        # išleistą versiją dar nepateko. PyPI naujausia `lightning` versija
        # 2026-08-10 tebėra 2.6.5 — atnaujinti NĖRA Į KĄ. Priklausomybė
        # ateina tranzityviai per `pyannote.audio`, ne tiesiogiai.
        #
        # POVEIKIS STENOGRAMA: checkpoint'ai kraunami tik iš konfigūracijoje
        # įvardyto HuggingFace modelio; vartotojas savo checkpoint failo
        # pateikti negali. Tai supply-chain vektorius (jei būtų pakeistas
        # modelis HF pusėje), ne tiesioginis vartotojo įvedamas kelias.
        # Tai rizikos vertinimas, ne garantija.
        #
        # PANAIKINTI, kai bus išleista lightning > 2.6.5. Patikrinti:
        #   curl -s https://pypi.org/pypi/lightning/json \
        #     | grep -o '"version":"[^"]*"' | head -1
        run: |
          pip-audit --requirement pyannote-server/requirements.txt --strict \
            --ignore-vuln PYSEC-2026-3624
EOF_BLOCK

awk -v target="$OLD" -v secfile=".pyaudit-block.tmp" '
  $0 == target { while ((getline line < secfile) > 0) print line; next }
  { print }
' "$CI" > "$CI.new" && mv "$CI.new" "$CI"
rm -f .pyaudit-block.tmp

grep -q "PYSEC-2026-3624" "$CI" || die "Pakeitimas nepavyko."
ok "$CI atnaujintas"

if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
yaml.safe_load(open('$CI'))
print('  \033[32mOK\033[0m  YAML sintaksė validi')
" || die "YAML sintaksės klaida — peržiūrėkite $CI"
fi

git add "$CI"
git commit -q -F - <<'EOF_MSG'
ci: laikina PYSEC-2026-3624 išimtis pyannote audite

lightning <= 2.6.5 turi RCE spragą (CVE-2026-58659) load_from_checkpoint
kelyje. Pataisymas yra tik commit'e d710d68 — į išleistą PyPI versiją dar
nepateko, naujausia tebėra 2.6.5, tad atnaujinti nėra į ką.

Priklausomybė tranzityvi per pyannote.audio. Stenograma checkpoint'us
krauna tik iš įvardyto HF modelio, vartotojo checkpoint failas nepriimamas.

Išimtis LAIKINA ir dokumentuota pačiame ci.yml — panaikinti, kai bus
išleista lightning > 2.6.5.
EOF_MSG
ok "Commit sukurtas"

printf '\n'
say "Peržiūrėti:  git show HEAD"
say "Toliau:      git push -u origin release/v1.3.0"
