#!/usr/bin/env bash
set -Eeuo pipefail

OWNER="forevercornix"
PROJECT_NUMBER="2"

field_exists() {
  local name="$1"

  gh project field-list "$PROJECT_NUMBER" \
    --owner "$OWNER" \
    --format json \
    --jq ".fields[] | select(.name == \"$name\") | .name" |
    grep -Fxq "$name"
}

create_field() {
  local name="$1"
  local options="$2"

  if field_exists "$name"; then
    echo "✓ Jau yra: $name"
  else
    gh project field-create "$PROJECT_NUMBER" \
      --owner "$OWNER" \
      --name "$name" \
      --data-type SINGLE_SELECT \
      --single-select-options "$options" >/dev/null

    echo "+ Sukurta: $name"
  fi
}

create_field \
  "Priority" \
  "P0 - Critical,P1 - High,P2 - Medium,P3 - Low"

create_field \
  "Area" \
  "Backend,Frontend,AI,API,Security,Privacy,Testing,Operations,Infrastructure,Observability,CI/CD,Documentation"

create_field \
  "Release" \
  "v1.1 GDPR,v1.2 Security,v1.3 Operational Readiness,v1.4 Pilot Validation,v1.5 Pilot Release,v2.0 Production Ready"

echo
echo "Projekto laukai:"
gh project field-list "$PROJECT_NUMBER" --owner "$OWNER"
