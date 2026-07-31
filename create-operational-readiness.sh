#!/usr/bin/env bash
set -Eeuo pipefail

REPO="forevercornix/stenograma"
MILESTONE="Operational Readiness v1"

if ! gh api "repos/$REPO/milestones?state=open&per_page=100" \
  --jq '.[].title' | grep -Fxq "$MILESTONE"; then
  echo "KLAIDA: nerastas atviras milestone: $MILESTONE"
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

find_issue() {
  local title="$1"

  gh issue list \
    --repo "$REPO" \
    --state all \
    --limit 500 \
    --json number,title \
    --jq ".[] | select(.title == \"$title\") | .number" |
    head -n 1
}

create_issue() {
  local title="$1"
  local labels="$2"
  local body_file="$3"
  local existing url number

  existing="$(find_issue "$title")"

  if [[ -n "$existing" ]]; then
    echo "Issue jau egzistuoja: #$existing — $title" >&2

    gh issue edit "$existing" \
      --repo "$REPO" \
      --milestone "$MILESTONE" >/dev/null

    echo "$existing"
    return
  fi

  url="$(
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --body-file "$body_file" \
      --milestone "$MILESTONE" \
      --label "$labels"
  )"

  number="${url##*/}"

  echo "Sukurtas issue #$number — $title" >&2
  echo "$number"
}

add_blocked_by() {
  local issue="$1"
  local blocker="$2"

  if gh issue edit "$issue" \
    --repo "$REPO" \
    --add-blocked-by "$blocker" >/dev/null 2>&1; then
    echo "Priklausomybė: #$issue blocked by #$blocker"
  else
    echo "PASTABA: nepavyko pridėti #$issue blocked by #$blocker."
    echo "Gali būti, kad ryšys jau egzistuoja arba reikia naujesnės gh versijos."
  fi
}

cat > "$WORKDIR/authentication.md" <<'EOF'
## Description

Implement mandatory authentication and server-side role-based access control
for pilot deployments.

The application must distinguish ordinary operators from administrators and
must not rely on hidden frontend controls as an authorization mechanism.

## Why this matters

Pilot data may include confidential audio, transcripts, protocols and personal
data. A shared API key is insufficient for determining who viewed, exported,
deleted or reconfigured protected data.

## Functional requirements

- Require authentication in pilot and production modes.
- Define at least two roles:
  - administrator;
  - operator.
- Enforce permissions in backend routes and services.
- Associate security- and privacy-relevant audit events with an authenticated actor.
- Ensure authentication context propagates into asynchronous jobs where needed.
- Prevent anonymous access to protected job, transcript, protocol and export endpoints.
- Define secure session or token expiry and revocation behaviour.
- Avoid storing credentials or tokens in logs.

## Minimum permission model

### Administrator

- Manage users or credentials.
- Change effective privacy and provider configuration.
- View system diagnostics.
- Delete jobs and related artefacts.
- Export original or redacted content, subject to privacy policy.

### Operator

- Create and view permitted jobs.
- Review transcripts and protocols.
- Export redacted content where allowed.
- Must not change system-wide privacy configuration.
- Must not access original content unless explicitly permitted.

## Definition of Done

- [ ] Pilot and production startup fail when authentication is not configured.
- [ ] Development-only anonymous mode remains clearly marked and cannot be enabled
      accidentally in production.
- [ ] Authentication middleware is applied centrally to protected routes.
- [ ] Authorization is enforced server-side.
- [ ] At least administrator and operator roles are implemented.
- [ ] Access to original audio, transcript and exports requires an explicit permission.
- [ ] Privacy configuration changes require an administrator permission.
- [ ] Deletion operations require an explicit permission.
- [ ] Authentication failures return consistent `401` responses.
- [ ] Authorization failures return consistent `403` responses.
- [ ] Protected resources cannot be accessed by changing frontend state or calling
      backend endpoints directly.
- [ ] Actor identity is included in privacy-relevant audit events.
- [ ] Tokens, passwords, cookies and authorization headers are not logged.
- [ ] Authentication context needed by BullMQ workers is represented safely and
      does not expose reusable credentials.
- [ ] Tests cover anonymous, operator, administrator and insufficient-permission cases.
- [ ] README and deployment documentation explain authentication requirements,
      roles and credential rotation.

## Out of scope

- Enterprise SSO or federation with every possible identity provider.
- Fine-grained organization and tenant administration.
- Public self-registration.
EOF

cat > "$WORKDIR/lifecycle.md" <<'EOF'
## Description

Verify the complete lifecycle of source audio, temporary files, transcripts,
protocols, redacted variants, exports, queue records and audit metadata.

Deletion and retention must work through real production paths rather than only
in isolated unit tests.

## Why this matters

A delete endpoint is not sufficient if copies remain in temporary directories,
job stores, exports, Redis payloads, worker state or backup processes.

## Functional requirements

- Maintain an explicit inventory of artefact types created for each job.
- Apply effective retention policy consistently.
- Delete all job-related artefacts through one coordinated lifecycle operation.
- Handle successful, failed, cancelled and abandoned jobs.
- Clean up stale artefacts after application or worker restart.
- Preserve only the minimum audit evidence permitted by policy.
- Report partial deletion failures without silently claiming success.
- Make deletion idempotent.

## Definition of Done

- [ ] All persistent and temporary artefact types are documented.
- [ ] Every artefact can be correlated to a job or meeting identifier.
- [ ] A single lifecycle service coordinates deletion.
- [ ] Deletion covers source audio and uploaded media.
- [ ] Deletion covers transcripts and redacted transcript variants.
- [ ] Deletion covers generated protocols.
- [ ] Deletion covers original and anonymised export artefacts.
- [ ] Deletion covers temporary conversion and processing files.
- [ ] Redis and queue-related records are removed or expired according to policy.
- [ ] Failure, cancellation and timeout paths schedule or execute cleanup.
- [ ] Retention cleanup continues correctly after restart.
- [ ] No-persistence mode leaves no content artefacts after processing completes.
- [ ] Deletion is idempotent and safe to retry.
- [ ] Partial deletion returns a non-success state and identifies the remaining
      artefact category without exposing sensitive paths or content.
- [ ] Audit events record deletion request, actor, result and timestamp without
      retaining deleted content.
- [ ] End-to-end tests create a real job through a production route and verify
      that every related artefact is removed.
- [ ] Tests do not fabricate identifiers or metadata absent from production paths.
- [ ] Tests cover success, failure, cancellation, restart and repeated deletion.
- [ ] Documentation explains retention, deletion guarantees and known limitations.

## Out of scope

- Guaranteed erasure from third-party provider systems beyond documented provider
  capabilities and contractual controls.
- Indefinite forensic retention of deleted content.
EOF

cat > "$WORKDIR/backup.md" <<'EOF'
## Description

Define and test backup, restore and secret/key-management behaviour for pilot
deployments.

The backup design must remain compatible with privacy modes, retention and the
right to deletion.

## Why this matters

A system may correctly delete active data while retaining the same data
indefinitely in backups. A backup that has never been restored is also not a
verified recovery mechanism.

## Functional requirements

- Define which application data is backed up.
- Exclude transient and no-persistence content where required.
- Encrypt backups in transit and at rest.
- Define backup retention and access controls.
- Document how deletion interacts with backup expiry and restoration.
- Test restoration in an isolated environment.
- Keep secrets outside the repository and application logs.
- Define credential and provider-key rotation procedures.
- Prevent restored data from bypassing current privacy configuration.

## Definition of Done

- [ ] A documented backup policy identifies included and excluded data.
- [ ] No-persistence deployments do not back up document content.
- [ ] Temporary upload and processing directories are excluded from backups.
- [ ] Backup retention is documented and bounded.
- [ ] Backup access is restricted and auditable.
- [ ] Backups are encrypted at rest and during transfer where transfer occurs.
- [ ] Encryption keys and provider credentials are not stored in the repository.
- [ ] `.env` and runtime secrets are excluded from source control and content backups.
- [ ] Restore procedure is documented step by step.
- [ ] At least one restore test is successfully completed in an isolated environment.
- [ ] Restore validation confirms application, database/job state and configuration
      compatibility.
- [ ] Restoring an older backup does not silently re-enable forbidden providers,
      original exports or unsafe privacy settings.
- [ ] The handling of data deleted after backup creation is documented.
- [ ] Backup expiry and deletion limitations are clearly communicated.
- [ ] Credential rotation procedure covers API keys, provider keys and application secrets.
- [ ] A lost or exposed credential can be revoked without rebuilding the application.
- [ ] Recovery test evidence is recorded without including real document content.

## Out of scope

- Multi-region disaster recovery.
- Zero-data-loss guarantees.
- Hardware security module integration unless required by the pilot environment.
EOF

cat > "$WORKDIR/incident.md" <<'EOF'
## Description

Create a practical incident-response and operational runbook for controlled
pilot deployments.

The runbook must enable an operator to detect, contain, investigate and recover
from security, privacy and service incidents.

## Why this matters

During a pilot, the important question is not whether every failure can be
prevented, but whether the team can recognize it quickly and respond without
exposing more data or losing evidence.

## Incident classes

- Suspected unauthorized access.
- Exposed or leaked credential.
- Data sent to a disallowed provider.
- Failed or incomplete deletion.
- Unexpected original-content export.
- Sensitive data appearing in logs.
- Worker, Redis or queue failure.
- Disk exhaustion or stalled jobs.
- Corrupt or incomplete output.
- Security scanner finding requiring urgent remediation.

## Definition of Done

- [ ] `docs/operations/INCIDENT_RESPONSE.md` exists.
- [ ] Incident severity levels and examples are defined.
- [ ] Pilot owner and technical response responsibilities are identified by role.
- [ ] The runbook explains how to disable external providers.
- [ ] The runbook explains how to disable uploads and exports.
- [ ] The runbook explains how to revoke and rotate credentials.
- [ ] The runbook explains how to stop workers without corrupting active data.
- [ ] The runbook explains how to preserve privacy-safe evidence.
- [ ] The runbook explains how to inspect audit logs without exposing document content.
- [ ] The runbook includes Redis, worker, storage and provider health checks.
- [ ] The runbook includes rollback and service-restoration steps.
- [ ] Communication and escalation paths are documented.
- [ ] GDPR or contractual notification assessment is included without claiming
      that every incident automatically requires notification.
- [ ] Known service and privacy limitations are documented.
- [ ] At least one tabletop incident exercise is completed.
- [ ] At least one credential-revocation or provider-disable exercise is completed.
- [ ] Exercise findings are converted into follow-up issues where necessary.
- [ ] The runbook contains no real secrets, personal data or internal credentials.

## Out of scope

- A full enterprise SOC or SIEM implementation.
- Legal advice for every possible jurisdiction.
- Automated public-status communication.
EOF

cat > "$WORKDIR/provider-governance.md" <<'EOF'
## Description

Create provider-governance rules and a deployment privacy checklist for every
transcription, diarization and LLM provider supported by Stenograma.

Technical provider configuration must align with the approved pilot data flow.

## Why this matters

A technically functioning provider can still be unsuitable for a pilot because
of data location, retention, training use, subprocessors, access controls or
contractual restrictions.

## Functional requirements

- Maintain an inventory of supported providers and transmitted data.
- Distinguish local and external processing.
- Document whether original or redacted content is sent.
- Record region, retention and training-use assumptions where known.
- Define which providers are permitted in each privacy mode.
- Validate deployment configuration against the approved provider policy.
- Include a pre-deployment checklist.
- Avoid asserting contractual guarantees that have not been verified.

## Definition of Done

- [ ] A provider inventory lists transcription, diarization and LLM providers.
- [ ] Each provider entry describes the categories of data transmitted.
- [ ] Each provider entry states whether data is original, redacted or metadata-only.
- [ ] Local-only mode has an explicit provider allow-list.
- [ ] Privacy-first mode has an explicit provider and artefact policy.
- [ ] External provider use is blocked when required contractual or configuration
      approval is absent.
- [ ] Region and endpoint configuration are documented where applicable.
- [ ] Known provider retention and model-training settings are documented or marked unknown.
- [ ] Required DPA or organizational approval is represented as a deployment prerequisite.
- [ ] Provider selection is validated at startup.
- [ ] Inline and BullMQ worker execution enforce the same provider policy.
- [ ] Diagnostics display the effective provider policy without secrets.
- [ ] A deployment checklist covers authentication, privacy mode, providers,
      retention, exports, logging, backups and incident contacts.
- [ ] The checklist distinguishes verified facts from assumptions and pending decisions.
- [ ] Tests prove that disallowed providers cannot be invoked through routes,
      services or workers.
- [ ] Documentation identifies the data controller/operator decision points and
      avoids presenting technical controls as complete legal compliance.

## Out of scope

- Negotiating provider contracts.
- Certifying providers as GDPR-compliant.
- Supporting every possible regional deployment.
EOF

echo "Kuriami Operational Readiness issue..."

AUTH="$(
  create_issue \
    "Authentication and role-based access control" \
    "backend,security,priority:P0" \
    "$WORKDIR/authentication.md"
)"

LIFECYCLE="$(
  create_issue \
    "End-to-end data lifecycle and deletion verification" \
    "backend,privacy,gdpr,testing,priority:P0" \
    "$WORKDIR/lifecycle.md"
)"

BACKUP="$(
  create_issue \
    "Backup, restore and key management" \
    "operations,security,infrastructure,priority:P1" \
    "$WORKDIR/backup.md"
)"

INCIDENT="$(
  create_issue \
    "Incident response and operational runbook" \
    "operations,security,documentation-only,priority:P1" \
    "$WORKDIR/incident.md"
)"

PROVIDERS="$(
  create_issue \
    "Provider governance and deployment privacy checklist" \
    "privacy,security,documentation,operations,priority:P1" \
    "$WORKDIR/provider-governance.md"
)"

echo
echo "Pridedamos priklausomybės..."

# Esami GDPR issue.
add_blocked_by "$LIFECYCLE" 5

# Backup turi remtis jau apibrėžtu duomenų lifecycle.
add_blocked_by "$BACKUP" "$LIFECYCLE"

# Incidentų procedūra remiasi autentifikacija, auditavimu ir veikiančiu lifecycle.
add_blocked_by "$INCIDENT" "$AUTH"
add_blocked_by "$INCIDENT" "$LIFECYCLE"

# Provider governance remiasi privacy režimu ir autentifikuotu administravimu.
add_blocked_by "$PROVIDERS" 5
add_blocked_by "$PROVIDERS" "$AUTH"

echo
echo "Operational Readiness v1:"
echo "  #$AUTH       Authentication and role-based access control"
echo "  #$LIFECYCLE  End-to-end data lifecycle and deletion verification"
echo "  #$BACKUP     Backup, restore and key management"
echo "  #$INCIDENT   Incident response and operational runbook"
echo "  #$PROVIDERS  Provider governance and deployment privacy checklist"
echo

gh issue list \
  --repo "$REPO" \
  --milestone "$MILESTONE" \
  --limit 100
