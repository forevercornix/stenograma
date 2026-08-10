#!/usr/bin/env bash
set -Eeuo pipefail

REPO="forevercornix/stenograma"

ensure_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  if gh label list --repo "$REPO" --limit 200 \
    --json name --jq '.[].name' | grep -Fxq "$name"; then
    echo "✓ $name"
  else
    gh label create "$name" \
      --repo "$REPO" \
      --color "$color" \
      --description "$description"

    echo "+ $name"
  fi
}

echo "== Priority =="

ensure_label "priority:P0" "B60205" "Critical"
ensure_label "priority:P1" "D93F0B" "High"
ensure_label "priority:P2" "FBCA04" "Medium"
ensure_label "priority:P3" "0E8A16" "Low"

echo
echo "== Areas =="

ensure_label "backend" "1D76DB" "Backend"
ensure_label "frontend" "5319E7" "Frontend"
ensure_label "api" "006B75" "API"
ensure_label "ai" "7A3EFF" "Artificial Intelligence"
ensure_label "security" "B60205" "Security"
ensure_label "privacy" "6F42C1" "Privacy"
ensure_label "gdpr" "6A4C93" "GDPR"
ensure_label "testing" "FBCA04" "Testing"
ensure_label "operations" "0052CC" "Operations"
ensure_label "observability" "8B5CF6" "Observability"
ensure_label "documentation" "0366D6" "Documentation"
ensure_label "ci" "0E8A16" "Continuous Integration"
ensure_label "github-actions" "2088FF" "GitHub Actions"
ensure_label "dependencies" "C2E0C6" "Dependencies"
ensure_label "performance" "F9D0C4" "Performance"
ensure_label "infrastructure" "005A9C" "Infrastructure"

echo
echo "== Types =="

ensure_label "enhancement" "84B6EB" "New feature"
ensure_label "bug" "D73A4A" "Bug"
ensure_label "technical-debt" "BFDADC" "Technical debt"
ensure_label "refactoring" "C5DEF5" "Refactoring"
ensure_label "documentation-only" "0075CA" "Documentation only"

echo
echo "== Special =="

ensure_label "pilot" "5319E7" "Pilot"
ensure_label "breaking-change" "000000" "Breaking change"
ensure_label "good first issue" "7057FF" "Good first issue"
ensure_label "help wanted" "008672" "Help wanted"

echo
echo "Done."
