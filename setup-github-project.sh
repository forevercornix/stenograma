#!/usr/bin/env bash
set -Eeuo pipefail

OWNER="forevercornix"
REPO="forevercornix/stenograma"
PROJECT="Stenograma Roadmap"

echo "Ieškomas projektas..."

NUMBER=$(
gh project list \
  --owner "$OWNER" \
  --format json \
  --jq ".projects[] | select(.title==\"$PROJECT\") | .number"
)

if [ -z "$NUMBER" ]; then
    echo "Kuriamas projektas..."

    NUMBER=$(
      gh project create \
        --owner "$OWNER" \
        --title "$PROJECT" \
        --format json \
        --jq ".number"
    )

    echo "Projektas sukurtas (#$NUMBER)"
else
    echo "Projektas jau egzistuoja (#$NUMBER)"
fi

echo
echo "Susiejamas su repo..."

gh project link "$NUMBER" \
    --owner "$OWNER" \
    --repo "$REPO" || true

echo
echo "Pridedami visi issue..."

gh issue list \
    --repo "$REPO" \
    --limit 500 \
    --json url \
    --jq '.[].url' |
while read URL
do
    gh project item-add "$NUMBER" \
        --owner "$OWNER" \
        --url "$URL" >/dev/null 2>&1 || true
done

echo
echo "======================================="
echo "Projektas paruoštas."
echo "======================================="
echo
echo "Atidaryti:"
echo
echo "gh project view $NUMBER --owner $OWNER --web"
