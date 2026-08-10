#!/usr/bin/env bash
set -Eeuo pipefail

REPO="forevercornix/stenograma"
MILESTONE="Security & Privacy Hardening v1"

echo "Repo:      $REPO"
echo "Milestone: $MILESTONE"
echo

# Patikriname, ar milestone tikrai egzistuoja.
if ! gh api "repos/$REPO/milestones?state=open&per_page=100" \
  --jq '.[].title' | grep -Fxq "$MILESTONE"; then
  echo "KLAIDA: nerastas atviras milestone: $MILESTONE"
  echo "Patikrink tikslų milestone pavadinimą GitHub."
  exit 1
fi

ensure_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  if gh label list --repo "$REPO" --limit 200 \
    --json name --jq '.[].name' | grep -Fxq "$name"; then
    echo "Etiketė jau yra: $name"
  else
    gh label create "$name" \
      --repo "$REPO" \
      --color "$color" \
      --description "$description"
    echo "Sukurta etiketė: $name"
  fi
}

issue_number_from_url() {
  basename "$1"
}

create_issue() {
  local title="$1"
  local labels="$2"
  local body_file="$3"

  local existing
  existing="$(
    gh issue list \
      --repo "$REPO" \
      --state all \
      --limit 200 \
      --search "\"$title\" in:title" \
      --json number,title \
      --jq ".[] | select(.title == \"$title\") | .number" \
      | head -n 1
  )"

  if [[ -n "$existing" ]]; then
    echo "Issue jau egzistuoja: #$existing — $title" >&2
    echo "$existing"
    return
  fi

  local url
  url="$(
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --body-file "$body_file" \
      --milestone "$MILESTONE" \
      --label "$labels"
  )"

  local number
  number="$(issue_number_from_url "$url")"

  echo "Sukurtas issue #$number — $title" >&2
  echo "$number"
}

add_blocked_by() {
  local issue="$1"
  local blocker="$2"

  gh issue edit "$issue" \
    --repo "$REPO" \
    --add-blocked-by "$blocker" >/dev/null

  echo "Ryšys: #$issue blocked by #$blocker"
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Tikrinamos etiketės..."

ensure_label "security"       "B60205" "Security hardening and vulnerability remediation"
ensure_label "privacy"        "7057FF" "Privacy-by-design and privacy controls"
ensure_label "gdpr"           "5319E7" "GDPR compliance work"
ensure_label "backend"        "1D76DB" "Backend changes"
ensure_label "api"            "0E8A16" "API design and implementation"
ensure_label "testing"        "FBCA04" "Automated testing and quality assurance"
ensure_label "ci"             "0052CC" "Continuous integration"
ensure_label "github-actions" "2088FF" "GitHub Actions workflows"
ensure_label "dependencies"   "0366D6" "Dependencies and software supply chain"
ensure_label "observability"  "D4C5F9" "Logging, diagnostics, metrics and tracing"
ensure_label "priority:P0"    "B60205" "Blocking or critical priority"
ensure_label "priority:P1"    "D93F0B" "High priority"

cat > "$WORKDIR/ingestion.md" <<'EOF'
## Description

Implement a secure ingestion and temporary-storage pipeline for uploaded audio
and video files. User-controlled filenames or paths must never determine
filesystem access. Uploaded and derived temporary artefacts must respect the
effective privacy and retention configuration.

## Functional requirements

- Store uploads only in a server-controlled directory.
- Generate storage filenames server-side.
- Validate file size, allowed format, MIME type and available file signature.
- Prevent path traversal, absolute-path injection and symlink escape.
- Separate original filename metadata from the server storage path.
- Clean up temporary files after success, failure, cancellation and interruption.
- Support no-persistence and configured-retention modes.
- Perform stale temporary-file cleanup after restarts.
- Avoid leaking local filesystem paths through API responses or normal logs.

## Definition of Done

- [ ] No production filesystem operation receives a path derived directly from
      request body, query, route parameter, original filename or client MIME data.
- [ ] Upload storage names use UUIDs or cryptographically random identifiers.
- [ ] The resolved path is verified to remain inside the configured upload directory.
- [ ] Symlink-based escape is prevented or the design avoids following symlinks.
- [ ] Maximum upload size is centrally configured and enforced.
- [ ] Allowed media types are centrally documented.
- [ ] Browser-provided MIME type is not the sole validation mechanism.
- [ ] Original filename is normalised and used only as display metadata.
- [ ] Cleanup executes after successful processing.
- [ ] Cleanup executes after validation, provider, queue and processing failures.
- [ ] Cleanup executes after cancellation or interruption where applicable.
- [ ] Restart-safe stale-file cleanup is implemented.
- [ ] No-persistence mode leaves no temporary artefacts after their lifecycle ends.
- [ ] Tests cover traversal, absolute and encoded paths, unsafe filenames,
      oversized uploads, MIME mismatch and cleanup.
- [ ] The CodeQL path-injection alert closes through a real data-flow fix.
- [ ] README and `.env.example` document limits, directories and cleanup behaviour.

## Related GDPR work

- Implements storage enforcement for #5.
- Supports redaction in #4.
- Supports safe exports in #8.
EOF

cat > "$WORKDIR/api-security.md" <<'EOF'
## Description

Create a central API security baseline applied consistently to all routes.
Expensive routes and operations must be protected from abuse, and request data
must be validated through reusable schemas.

## Functional requirements

- Centralise HTTP security middleware.
- Apply route-appropriate rate limiting.
- Configure security headers and CORS.
- Limit JSON and form request sizes.
- Validate body, query and route parameters through reusable schemas.
- Return a consistent, non-sensitive validation error format.
- Define proxy and client-IP handling safely.
- Avoid expensive readiness operations on every unrestricted request.

## Definition of Done

- [ ] A central security middleware module is registered before API routes.
- [ ] Helmet or equivalent security headers are enabled and tested.
- [ ] CORS uses an explicit configurable allow-list.
- [ ] Credentials cannot be combined with a wildcard origin.
- [ ] JSON and URL-encoded body limits are configured and tested.
- [ ] A general API limiter and stricter expensive-route limiters are implemented.
- [ ] `/api/ready` has an appropriate limiter.
- [ ] Readiness Redis operations have a bounded timeout.
- [ ] Readiness reuses a connection or a short bounded cache rather than creating
      uncontrolled Redis connections for every request.
- [ ] Health checks remain lightweight and disclose no sensitive details.
- [ ] One schema system is used for body, query and parameter validation.
- [ ] Reusable validation middleware is implemented.
- [ ] Job IDs, meeting IDs, booleans, provider options and export variants are validated.
- [ ] Unknown-field handling is explicitly defined.
- [ ] Validation errors use one documented format and omit stack traces.
- [ ] Production startup fails when required security configuration is unsafe.
- [ ] Tests cover rate limiting, CORS, body limits, headers and invalid inputs.
- [ ] The CodeQL missing-rate-limiting alert closes.

## Related GDPR work

- Enforces centrally validated settings for #5.
- Supports ingestion, redaction and export endpoints.
EOF

cat > "$WORKDIR/regression-tests.md" <<'EOF'
## Description

Create a dedicated regression suite that proves security and privacy controls
through real production paths. Tests must fail when a vulnerable implementation
or privacy bypass is reintroduced.

## Functional requirements

- Cover backend, frontend, upload, export, provider and configuration boundaries.
- Prefer route and integration tests over self-confirming mocks.
- Include positive, negative and false-positive cases.
- Run automatically in CI.
- Clearly identify tests requiring Redis or other services.

## Definition of Done

- [ ] A documented `test:security` and/or `test:privacy` command exists.
- [ ] CI runs the suite on every pull request.
- [ ] Tests cover path traversal and unsafe upload filenames.
- [ ] Tests cover oversized and mismatched media uploads.
- [ ] Tests cover cleanup after success, failure and cancellation.
- [ ] Tests cover rate limiting, CORS and request-size limits.
- [ ] Tests cover invalid and contradictory privacy configuration.
- [ ] Tests prove local-only mode blocks external providers in inline and BullMQ modes.
- [ ] Tests prove required-redaction mode never sends original content externally.
- [ ] Tests cover XSS payloads in filenames, transcripts, protocols and exports.
- [ ] Tests prove missing redacted content never falls back to original content.
- [ ] Tests prove disabled original export is blocked server-side.
- [ ] Tests verify logs omit content, PII, credentials and API keys.
- [ ] Tests exercise real production paths rather than fabricated fields.
- [ ] Redis-dependent tests run with real Redis in CI and are not silently skipped.
- [ ] Environment-limited tests and known limitations are documented.

## Coverage targets

- GDPR issues #4, #5 and #8.
- Secure ingestion.
- API security baseline.
- Privacy-safe observability.
- GitHub Actions security checks.
EOF

cat > "$WORKDIR/cicd.md" <<'EOF'
## Description

Apply least privilege and dependency and supply-chain controls to GitHub Actions
and repository automation.

## Functional requirements

- Declare explicit `GITHUB_TOKEN` permissions for every workflow.
- Grant write permissions only where required.
- Prevent untrusted pull-request code from accessing secrets.
- Validate workflow syntax and security conventions.
- Scan JavaScript and Python dependencies.
- Keep CodeQL and dependency scanning in the development workflow.

## Definition of Done

- [ ] Every workflow has an explicit `permissions` block.
- [ ] Test-only workflows use `contents: read` unless documented otherwise.
- [ ] No workflow uses `write-all`.
- [ ] Write permissions are isolated to the smallest possible job.
- [ ] `pull_request_target` is not combined with execution of untrusted PR code.
- [ ] Secrets are supplied only to steps that need them.
- [ ] Third-party actions follow an explicit version-pinning policy.
- [ ] Workflow linting is included in CI.
- [ ] JavaScript auditing covers backend and frontend.
- [ ] Python auditing covers backend scripts, pyannote and whisper servers.
- [ ] The CI-blocking severity threshold is documented.
- [ ] CodeQL continues to scan JavaScript/TypeScript and GitHub Actions.
- [ ] Current missing-workflow-permissions alerts close through a shared fix.
- [ ] Security documentation explains how findings are triaged.
EOF

cat > "$WORKDIR/observability.md" <<'EOF'
## Description

Provide request-to-job correlation, structured diagnostics and privacy-safe audit
events without recording transcript, protocol, audio or detected PII content.

## Functional requirements

- Assign and propagate a request ID.
- Correlate HTTP requests with queue jobs and worker execution.
- Produce structured logs with sensitive-field redaction.
- Record privacy-relevant events without document content.
- Expose non-secret effective privacy diagnostics.
- Define privacy-safe handling of IP-derived abuse signals.

## Definition of Done

- [ ] Every request receives a generated or strictly validated request ID.
- [ ] Client request IDs have strict format and length limits.
- [ ] Request ID is returned in a response header.
- [ ] Request ID is propagated into job metadata and worker logs.
- [ ] Logs correlate request, queue, worker, provider and completion events.
- [ ] Logs use a consistent structured format.
- [ ] Transcripts, protocols, audio, PII, cookies, authorisation headers and API
      keys are never logged or are safely redacted.
- [ ] Temporary filesystem paths are not exposed through normal API responses.
- [ ] Export audit events include job ID, variant, format, timestamp, outcome and
      actor identifier where available, but no content.
- [ ] Redaction events record policy/version and outcome without detected values.
- [ ] Rate-limit and rejected-upload events contain no sensitive payload.
- [ ] Full IP addresses are not retained by default in long-lived logs.
- [ ] `trust proxy` is explicitly configured for supported deployments.
- [ ] Effective privacy diagnostics expose only non-secret configuration.
- [ ] Tests verify propagation, redaction and content-free audit events.

## Related GDPR work

- Implements export-audit requirements for #8.
- Supports privacy diagnostics for #5.
- Supports redaction outcome tracking for #4.
EOF

echo
echo "Kuriami issue..."

INGESTION="$(
  create_issue \
    "Secure ingestion and temporary storage lifecycle" \
    "backend,security,privacy,gdpr,priority:P0" \
    "$WORKDIR/ingestion.md"
)"

API_SECURITY="$(
  create_issue \
    "API security baseline and central validation" \
    "backend,security,api,priority:P0" \
    "$WORKDIR/api-security.md"
)"

REGRESSION="$(
  create_issue \
    "Security and privacy regression test suite" \
    "testing,security,privacy,ci,priority:P1" \
    "$WORKDIR/regression-tests.md"
)"

CICD="$(
  create_issue \
    "CI/CD least privilege and supply-chain hardening" \
    "github-actions,security,ci,dependencies,priority:P1" \
    "$WORKDIR/cicd.md"
)"

OBSERVABILITY="$(
  create_issue \
    "Privacy-safe observability and request/job correlation" \
    "backend,observability,privacy,gdpr,priority:P1" \
    "$WORKDIR/observability.md"
)"

echo
echo "Kuriamos priklausomybės..."

# Esami GDPR issue.
add_blocked_by 4 "$INGESTION"
add_blocked_by 8 4
add_blocked_by 8 5
add_blocked_by 8 "$OBSERVABILITY"

# Galutinis regresijos suite priklauso nuo įgyvendinamų kontrolės sluoksnių.
add_blocked_by "$REGRESSION" "$INGESTION"
add_blocked_by "$REGRESSION" "$API_SECURITY"
add_blocked_by "$REGRESSION" "$OBSERVABILITY"
add_blocked_by "$REGRESSION" "$CICD"

echo
echo "Sukurti arba rasti issue:"
echo "  #$INGESTION     Secure ingestion and temporary storage lifecycle"
echo "  #$API_SECURITY  API security baseline and central validation"
echo "  #$REGRESSION    Security and privacy regression test suite"
echo "  #$CICD          CI/CD least privilege and supply-chain hardening"
echo "  #$OBSERVABILITY Privacy-safe observability and request/job correlation"
echo

echo "Milestone issue sąrašas:"
gh issue list \
  --repo "$REPO" \
  --milestone "$MILESTONE" \
  --limit 100
