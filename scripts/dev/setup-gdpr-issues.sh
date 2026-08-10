#!/usr/bin/env bash

set -euo pipefail

REPO="forevercornix/stenograma"
MILESTONE="GDPR compliance v1"

echo "Tikrinamas GitHub prisijungimas..."
gh auth status >/dev/null

echo "Kuriamos arba atnaujinamos etiketės..."

gh label create "gdpr" \
  --repo "$REPO" \
  --color "5319E7" \
  --description "GDPR and personal data protection" \
  --force

gh label create "privacy" \
  --repo "$REPO" \
  --color "0E8A16" \
  --description "Privacy-related functionality" \
  --force

gh label create "priority:P0" \
  --repo "$REPO" \
  --color "B60205" \
  --description "Must be implemented first" \
  --force

gh label create "priority:P1" \
  --repo "$REPO" \
  --color "D93F0B" \
  --description "High-priority improvement" \
  --force

gh label create "backend" \
  --repo "$REPO" \
  --color "1D76DB" \
  --description "Backend functionality" \
  --force

gh label create "frontend" \
  --repo "$REPO" \
  --color "0052CC" \
  --description "Frontend functionality" \
  --force

gh label create "documentation" \
  --repo "$REPO" \
  --color "0075CA" \
  --description "Documentation changes" \
  --force

echo "Tikrinamas Milestone..."

MILESTONE_NUMBER="$(
  gh api \
    --paginate \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title == \"$MILESTONE\") | .number" \
  | head -n 1
)"

if [ -z "$MILESTONE_NUMBER" ]; then
  echo "Kuriamas Milestone: $MILESTONE"

  MILESTONE_NUMBER="$(
    gh api \
      --method POST \
      -H "Accept: application/vnd.github+json" \
      "/repos/$REPO/milestones" \
      -f title="$MILESTONE" \
      -f description="Implementation of GDPR Privacy by Design and Privacy by Default controls." \
      --jq '.number'
  )"
else
  echo "Milestone jau egzistuoja: #$MILESTONE_NUMBER"
fi

create_issue() {
  local title="$1"
  local labels="$2"
  local body="$3"

  local existing
  existing="$(
    gh issue list \
      --repo "$REPO" \
      --state all \
      --limit 200 \
      --search "\"$title\" in:title" \
      --json title,number \
      --jq ".[] | select(.title == \"$title\") | .number" \
    | head -n 1
  )"

  if [ -n "$existing" ]; then
    echo "Issue jau egzistuoja: #$existing – $title"
    return
  fi

  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --label "$labels" \
    --milestone "$MILESTONE"

  echo "Sukurtas Issue: $title"
}

create_issue \
  "Automatic data retention and purge" \
  "gdpr,privacy,priority:P0,backend" \
"## Description

Automatically remove temporary and expired user data according to configurable retention policies.

## Functional requirements

- The retention period must be configurable.
- Expired job data must be removed automatically.
- Temporary processing files must be removed after they are no longer needed.
- Purge operations must be recorded without exposing personal data.

## Definition of Done

- [ ] A configurable retention setting is implemented.
- [ ] Privacy-first default retention values are defined.
- [ ] An automatic purge process is implemented.
- [ ] Audio, transcripts, protocols and temporary files are removed after expiry.
- [ ] Associated database or queue metadata is removed or anonymised.
- [ ] Purge operations are recorded in the audit log.
- [ ] Unit tests are added.
- [ ] Integration tests are added.
- [ ] Configuration and behaviour are documented."

create_issue \
  "Complete job deletion" \
  "gdpr,privacy,priority:P0,backend" \
"## Description

Allow an authorised user to permanently delete a transcription job and all data associated with it.

## Functional requirements

- Provide an API operation for deleting a job.
- Delete all files, generated artefacts and persisted metadata belonging to the job.
- Repeated deletion requests must be handled safely.
- The API must return a clear result.

## Definition of Done

- [ ] A job deletion API endpoint is implemented.
- [ ] Authorisation rules are applied where authentication is enabled.
- [ ] Source audio is deleted.
- [ ] Transcripts and generated protocols are deleted.
- [ ] Redacted copies, exports, cache and temporary files are deleted.
- [ ] Queue and storage metadata are removed or safely anonymised.
- [ ] No orphan files remain after deletion.
- [ ] Repeated deletion is handled consistently.
- [ ] Integration tests cover successful deletion, missing jobs and partial artefacts.
- [ ] API documentation is updated."

create_issue \
  "Automatic PII redaction" \
  "gdpr,privacy,priority:P1,backend" \
"## Description

Detect configured categories of personal data and create a redacted transcript that can be used for privacy-preserving processing and export.

## Functional requirements

- Detect supported personal data categories.
- Replace detected values with understandable placeholders.
- Preserve transcript structure and readability.
- Make redaction behaviour configurable.
- Avoid sending unredacted content to external providers when redaction is required.

## Definition of Done

- [ ] A PII redaction component is implemented behind a clear interface.
- [ ] Supported PII categories are documented.
- [ ] Lithuanian personal codes, email addresses and phone numbers are covered.
- [ ] Person names and addresses have a documented detection strategy and limitations.
- [ ] Redacted text uses consistent placeholders.
- [ ] Speaker labels, timestamps and transcript structure are preserved.
- [ ] Original and redacted versions cannot be confused in storage or API responses.
- [ ] External-provider processing respects the configured redaction mode.
- [ ] Unit tests include positive, negative and false-positive cases.
- [ ] Known limitations are documented."

create_issue \
  "Configurable privacy mode" \
  "gdpr,privacy,priority:P0,backend,documentation" \
"## Description

Provide centrally configurable privacy behaviour with restrictive Privacy by Default settings.

## Functional requirements

- Allow persistent storage to be disabled.
- Allow retention periods to be configured.
- Allow external provider processing to be restricted.
- Validate incompatible or unsafe configurations.
- Make effective privacy settings visible to administrators.

## Definition of Done

- [ ] Privacy configuration options are implemented.
- [ ] Persistent storage can be disabled.
- [ ] Retention can be configured within documented limits.
- [ ] A local-only provider mode can be enforced.
- [ ] Redaction-before-external-processing can be required.
- [ ] Unsafe or contradictory settings fail during startup validation.
- [ ] Defaults minimise storage and external disclosure.
- [ ] Effective non-secret privacy configuration is visible through diagnostics.
- [ ] Configuration examples are added to the environment example file.
- [ ] README documentation is updated.
- [ ] Configuration validation is covered by tests."

create_issue \
  "Privacy-safe audit logging" \
  "gdpr,privacy,priority:P0,backend" \
"## Description

Record security-relevant and lifecycle events without logging transcript content, personal data or secrets.

## Functional requirements

- Record important job lifecycle and privacy events.
- Never record source audio, transcript text, prompts or generated protocol content.
- Avoid direct personal identifiers in log entries.
- Use pseudonymous technical identifiers where necessary.

## Definition of Done

- [ ] A structured audit event format is defined.
- [ ] Job creation, processing, export, deletion and automatic purge events are recorded.
- [ ] Audit events include timestamp, event type, result and pseudonymous job identifier.
- [ ] Transcript and protocol content are excluded.
- [ ] Original filenames, access tokens, API keys and full request bodies are excluded.
- [ ] Error sanitisation prevents provider responses from leaking sensitive content.
- [ ] Automated tests verify that representative PII does not appear in logs.
- [ ] Audit-log retention is documented.
- [ ] Logging guidance is added to the security or privacy documentation."

create_issue \
  "Provider privacy transparency" \
  "gdpr,privacy,priority:P1,documentation" \
"## Description

Document and expose whether each transcription, diarisation and LLM provider processes data locally or sends it to an external service.

## Functional requirements

- Classify every supported provider as local or external.
- Describe what data is transmitted.
- Describe relevant configuration and deployment implications.
- Warn when an external provider is selected.

## Definition of Done

- [ ] Every transcription provider is included in a privacy matrix.
- [ ] Every diarisation provider is included in a privacy matrix.
- [ ] Every LLM provider is included in a privacy matrix.
- [ ] The matrix identifies local versus external processing.
- [ ] The matrix identifies the data categories sent to each provider.
- [ ] Provider selection warnings are shown during startup or diagnostics.
- [ ] Local-only configuration examples are documented.
- [ ] External provider documentation does not make unsupported compliance claims.
- [ ] Subprocessors and data residency are described as deployment-dependent where applicable.
- [ ] README or a dedicated privacy document is updated."

create_issue \
  "Original and anonymised exports" \
  "gdpr,privacy,priority:P1,backend,frontend" \
"## Description

Allow an authorised user to explicitly export either the original result or a redacted version.

## Functional requirements

- Clearly distinguish original and redacted exports.
- Support the same appropriate output formats for both variants.
- Prevent accidental selection of the original version.
- Record export events without logging document content.

## Definition of Done

- [ ] Original export is available only through an explicit action.
- [ ] Redacted export is available as a separate action.
- [ ] The user interface clearly identifies both variants.
- [ ] Privacy-first deployments can disable original export.
- [ ] Exported filenames clearly indicate the selected variant.
- [ ] Supported formats behave consistently for both variants.
- [ ] Missing redacted content is handled with a clear error or generation flow.
- [ ] Export events are recorded in the privacy-safe audit log.
- [ ] Access control is applied where authentication is enabled.
- [ ] Backend tests cover both variants and disabled original export.
- [ ] Frontend tests cover labels and user selection.
- [ ] User documentation is updated."

echo
echo "Baigta."
echo
echo "Milestone:"
echo "https://github.com/$REPO/milestone/$MILESTONE_NUMBER"
echo
echo "Issues:"
gh issue list \
  --repo "$REPO" \
  --milestone "$MILESTONE" \
  --state all \
  --limit 20
