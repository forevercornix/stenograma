#!/usr/bin/env bash
# #155 sub-issue'ų kūrimas.
#
#   bash create-155-subissues.sh --dry-run
#   bash create-155-subissues.sh
#   bash create-155-subissues.sh --update   # tik perrašo esamų issue body iš spec
#
# Tekstai imami iš SUBISSUES-155.md (vienintelis šaltinis, kaip #152 atveju).
# Idempotentiškas: pakartotinis paleidimas nekuria dublikatų.

set -euo pipefail

REPO="${REPO:-forevercornix/stenograma}"
PARENT=155
MILESTONE="Data Persistence v1"
LABELS="backend,infrastructure,priority:P1"
WORK="$HOME/.steno-issues"
MAP="$WORK/sub155.tsv"
MARK="#155 sub-issue chain"
DRY=0; UPDATE=0

case "${1:-}" in
  --dry-run) DRY=1 ;;
  --update)  UPDATE=1 ;;
esac

SPEC="${SPEC:-$PWD/SUBISSUES-155.md}"
mkdir -p "$WORK/bodies"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip(){ printf '  \033[33m·\033[0m %s\n' "$*"; }
die() { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SPEC" ] || die "nerastas $SPEC"
command -v gh >/dev/null || die "gh nerastas"

say "#155 sub-issue'ai  (repo: $REPO)"
[ "$DRY" = 1 ] && echo "  REŽIMAS: dry-run, nieko nekuriama"
[ "$UPDATE" = 1 ] && echo "  REŽIMAS: update, tik body perrašymas"

# --- Spec skaidymas į atskirus body failus -----------------------------------
python3 - "$SPEC" "$WORK/bodies" "$MAP" <<'PY'
import re, sys
from pathlib import Path

spec, outdir, mapfile = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
tekstas = spec.read_text(encoding="utf-8")

# `## [7.x] Pavadinimas` ... iki kito `## [`
dalys = re.split(r"^## \[(\d+\.\d+[a-z]?)\] (.+)$", tekstas, flags=re.M)[1:]

eilutes = []
for i in range(0, len(dalys), 3):
    kodas, pavadinimas, body = dalys[i], dalys[i + 1].strip(), dalys[i + 2]
    body = body.split("\n---\n")[0].strip()

    failas = outdir / f"{kodas}.md"
    failas.write_text(body + "\n", encoding="utf-8")
    eilutes.append(f"{kodas}\t[{kodas}] {pavadinimas}\t{failas}")

mapfile.write_text("\n".join(eilutes) + "\n", encoding="utf-8")
print(f"  spec: {len(eilutes)} sub-issue")
PY

[ -s "$MAP" ] || die "spec neduoda nė vieno sub-issue"

# --- Esamų issue paieška pagal pavadinimą ------------------------------------
ESAMI="$WORK/esami.json"
gh issue list -R "$REPO" --state all --limit 200 \
  --json number,title > "$ESAMI"

rasti_numeri() {
  python3 -c "
import json,sys
pav=sys.argv[1]
for i in json.load(open('$ESAMI')):
    if i['title']==pav: print(i['number']); break
" "$1"
}

# --- Kūrimas / atnaujinimas --------------------------------------------------
say "Sub-issue'ai"
SUKURTA=0; ATNAUJINTA=0; PRALEISTA=0

while IFS=$'\t' read -r KODAS PAVADINIMAS BODY; do
  [ -n "$KODAS" ] || continue
  NUM="$(rasti_numeri "$PAVADINIMAS")"

  if [ -n "$NUM" ]; then
    if [ "$UPDATE" = 1 ]; then
      [ "$DRY" = 1 ] || gh issue edit "$NUM" -R "$REPO" --body-file "$BODY"
      ok "#$NUM  $PAVADINIMAS  (body atnaujintas)"
      ATNAUJINTA=$((ATNAUJINTA+1))
    else
      skip "#$NUM  $PAVADINIMAS  (jau yra)"
      PRALEISTA=$((PRALEISTA+1))
    fi
    continue
  fi

  if [ "$UPDATE" = 1 ]; then
    skip "$PAVADINIMAS  (nerastas; --update nekuria naujų)"
    continue
  fi

  if [ "$DRY" = 1 ]; then
    ok "(dry-run) kurčiau: $PAVADINIMAS  [$(wc -l < "$BODY") eil.]"
    SUKURTA=$((SUKURTA+1))
    continue
  fi

  URL="$(gh issue create -R "$REPO" \
    --title "$PAVADINIMAS" \
    --body-file "$BODY" \
    --label "$LABELS" \
    --milestone "$MILESTONE")"

  ok "$URL  $PAVADINIMAS"
  SUKURTA=$((SUKURTA+1))
done < "$MAP"

# --- Ryšys su tėviniu --------------------------------------------------------
if [ "$DRY" = 0 ] && [ "$UPDATE" = 0 ] && [ "$SUKURTA" -gt 0 ]; then
  say "Nuorodos tėviniame #$PARENT"

  gh issue list -R "$REPO" --state all --limit 200 \
    --json number,title > "$ESAMI"

  KOM="$WORK/parent-comment.md"
  {
    echo "## $MARK"
    echo
    echo "| Sub-PR | Issue |"
    echo "|---|---|"
    while IFS=$'\t' read -r KODAS PAVADINIMAS _; do
      [ -n "$KODAS" ] || continue
      N="$(rasti_numeri "$PAVADINIMAS")"
      [ -n "$N" ] && echo "| \`$KODAS\` | #$N |"
    done < "$MAP"
    echo
    echo "Tekstai: \`SUBISSUES-155.md\`. Perrašymas: \`create-155-subissues.sh --update\`."
  } > "$KOM"

  if gh issue view "$PARENT" -R "$REPO" --json comments \
       --jq '.comments[].body' | grep -qF "$MARK"; then
    skip "nuorodų komentaras jau yra"
  else
    gh issue comment "$PARENT" -R "$REPO" --body-file "$KOM"
    ok "komentaras pridėtas prie #$PARENT"
  fi
fi

say "Suvestinė"
echo "  sukurta:    $SUKURTA"
echo "  atnaujinta: $ATNAUJINTA"
echo "  praleista:  $PRALEISTA"
echo
echo "  Body failai: $WORK/bodies"
echo "  Žemėlapis:   $MAP"
