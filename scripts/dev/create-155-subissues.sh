#!/usr/bin/env bash
# #155 sub-issue'ų kūrimas ir atnaujinimas.
#
# PALEIDŽIAMA IŠ REPO ŠAKNIES — spec ieškoma `$PWD/SUBISSUES-155.md`:
#
#   bash scripts/dev/create-155-subissues.sh --dry-run
#   bash scripts/dev/create-155-subissues.sh
#   bash scripts/dev/create-155-subissues.sh --update            # visi body iš spec
#   bash scripts/dev/create-155-subissues.sh --update --only 7.2b
#   bash scripts/dev/create-155-subissues.sh --dry-run --only 7.3
#
# ⚠️ Prieš `--update` — `git pull`. Skriptas skaito DARBINĘ spec kopiją, tad su
#    atsilikusia šaka jis perrašytų GitHub issue SENESNIU tekstu.
#
# ⚠️ `--update` be `--only` perrašo VISŲ sub-issue body. Rankiniai redagavimai
#    GitHub sąsajoje bus prarasti — spec yra vienintelis šaltinis.
#
# Tekstai imami iš SUBISSUES-155.md (vienintelis šaltinis, kaip #152 atveju).
# Idempotentiškas: pakartotinis paleidimas nekuria dublikatų.

set -Eeuo pipefail

REPO="${REPO:-forevercornix/stenograma}"
PARENT=155
MILESTONE="Data Persistence v1"
LABELS="backend,infrastructure,priority:P1"
WORK="$HOME/.steno-issues"
MAP="$WORK/sub155.tsv"
MARK="#155 sub-issue chain"

# `gh issue list` puslapiavimo riba. Peraugus ją paieška pagal pavadinimą tyliai
# nerastų esamo issue ir skriptas sukurtų DUBLIKATĄ, tad riba tikrinama žemiau.
LIMIT=200

DRY=0; UPDATE=0; ONLY=""

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip(){ printf '  \033[33m·\033[0m %s\n' "$*"; }
die() { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

# Argumentai tikrinami, ne ignoruojami: `--updte` anksčiau tyliai nukrisdavo į
# kūrimo režimą ir kiekvieną issue praleisdavo kaip „jau yra" — atrodytų kaip
# sėkmingas paleidimas, nors nebūtų atnaujinta niekas.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --update)  UPDATE=1 ;;
    --only)    shift; [ $# -gt 0 ] || die "--only be reikšmės (pvz. --only 7.2b)"; ONLY="$1" ;;
    --only=*)  ONLY="${1#--only=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *)         die "nežinomas argumentas: $1" ;;
  esac
  shift
done

SPEC="${SPEC:-$PWD/SUBISSUES-155.md}"
mkdir -p "$WORK/bodies"

[ -f "$SPEC" ] || die "nerastas $SPEC (paleiskite iš repo šaknies)"
command -v gh >/dev/null || die "gh nerastas"
command -v python3 >/dev/null || die "python3 nerastas"

say "#155 sub-issue'ai  (repo: $REPO)"
[ "$DRY" = 1 ] && echo "  REŽIMAS: dry-run, nieko nekuriama"
[ "$UPDATE" = 1 ] && echo "  REŽIMAS: update, tik body perrašymas"
[ -n "$ONLY" ] && echo "  FILTRAS: tik $ONLY"

# --- Spec skaidymas į atskirus body failus -----------------------------------
python3 - "$SPEC" "$WORK/bodies" "$MAP" "$ONLY" <<'PY'
import re, sys
from pathlib import Path

spec, outdir, mapfile, only = (
    Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
)
tekstas = spec.read_text(encoding="utf-8")

# `## [7.x] Pavadinimas` ... iki kito `## [`
dalys = re.split(r"^## \[(\d+\.\d+[a-z]?)\] (.+)$", tekstas, flags=re.M)[1:]

visi, eilutes = [], []
for i in range(0, len(dalys), 3):
    kodas, pavadinimas, body = dalys[i], dalys[i + 1].strip(), dalys[i + 2]
    visi.append(kodas)
    if only and kodas != only:
        continue

    # Sekcijos pabaiga yra `\n---\n` skirtukas prieš kitą `## [`.
    body = body.split("\n---\n")[0].strip()

    failas = outdir / f"{kodas}.md"
    failas.write_text(body + "\n", encoding="utf-8")
    eilutes.append(f"{kodas}\t[{kodas}] {pavadinimas}\t{failas}")

visos_antrastes = re.findall(r"^## \[.*$", tekstas, flags=re.M)
if len(visos_antrastes) != len(visi):
    atpazintos = {f"[{k}]" for k in visi}
    nezinomos = [h for h in visos_antrastes
                 if not any(h.startswith(f"## {a}") for a in atpazintos)]
    print(f"  KLAIDA: {len(visos_antrastes)} antrasciu, atpazinta {len(visi)}.",
          file=sys.stderr)
    for h in nezinomos:
        print(f"    neatpazinta: {h}", file=sys.stderr)
    raise SystemExit(1)

if only and not eilutes:
    print(f"  KLAIDA: spec neturi sekcijos [{only}]. Yra: {', '.join(visi)}", file=sys.stderr)
    raise SystemExit(1)

mapfile.write_text("\n".join(eilutes) + "\n", encoding="utf-8")
print(f"  spec: {len(eilutes)} sub-issue (iš viso sekcijų: {len(visi)})")
PY

[ -s "$MAP" ] || die "spec neduoda nė vieno sub-issue"

# --- Esamų issue paieška pagal pavadinimą ------------------------------------
ESAMI="$WORK/esami.json"
gh issue list -R "$REPO" --state all --limit "$LIMIT" \
  --json number,title > "$ESAMI"

# Pasiekus limitą sąrašas nutrūksta, o pavadinimo paieška duotų tuščią rezultatą
# esamam issue — t. y. `gh issue create` sukurtų antrą kopiją.
KIEK="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$ESAMI")"
[ "$KIEK" -lt "$LIMIT" ] || die "gh grąžino $KIEK issue = limitas ($LIMIT); padidinkite LIMIT, kitaip gresia dublikatai"

rasti_numeri() {
  python3 -c '
import json, sys
kelias, pav = sys.argv[1], sys.argv[2]
for i in json.load(open(kelias, encoding="utf-8")):
    if i["title"] == pav:
        print(i["number"])
        break
' "$ESAMI" "$1"
}

# --- Kūrimas / atnaujinimas --------------------------------------------------
say "Sub-issue'ai"
SUKURTA=0; ATNAUJINTA=0; PRALEISTA=0

while IFS=$'\t' read -r KODAS PAVADINIMAS BODY; do
  [ -n "$KODAS" ] || continue
  NUM="$(rasti_numeri "$PAVADINIMAS")"

  if [ -n "$NUM" ]; then
    if [ "$UPDATE" = 1 ]; then
      if [ "$DRY" = 1 ]; then
        ok "(dry-run) #$NUM  $PAVADINIMAS  [$(wc -c < "$BODY") simb.]"
      else
        gh issue edit "$NUM" -R "$REPO" --body-file "$BODY"
        ok "#$NUM  $PAVADINIMAS  (body atnaujintas)"
      fi
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
# Tik po pilno kūrimo: su `--only` lentelė būtų dalinė ir klaidintų.
if [ "$DRY" = 0 ] && [ "$UPDATE" = 0 ] && [ -z "$ONLY" ] && [ "$SUKURTA" -gt 0 ]; then
  say "Nuorodos tėviniame #$PARENT"

  gh issue list -R "$REPO" --state all --limit "$LIMIT" \
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
    echo "Tekstai: \`SUBISSUES-155.md\`. Perrašymas: \`scripts/dev/create-155-subissues.sh --update\`."
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
