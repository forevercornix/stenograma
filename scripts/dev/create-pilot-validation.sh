#!/usr/bin/env bash
set -Eeuo pipefail

REPO="forevercornix/stenograma"
MILESTONE="Pilot Validation v1"

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
    echo "Ryšys gali jau egzistuoti arba gh versija gali nepalaikyti --add-blocked-by."
  fi
}

cat > "$WORKDIR/transcription-quality.md" <<'EOF'
## Description

Define and validate measurable transcription and speaker diarization quality
criteria for the controlled pilot.

The pilot must not rely only on subjective impressions that the transcript
“looks good”. Quality must be evaluated against representative reference data.

## Why this matters

Generated protocols and extracted decisions depend directly on transcription
and speaker attribution quality. Poor input quality can produce plausible but
incorrect downstream results.

## Functional requirements

- Define a representative pilot evaluation dataset.
- Include different recording durations, audio qualities and speaker counts.
- Include Lithuanian-language material representative of the intended use case.
- Maintain manually verified reference transcripts for evaluation samples.
- Measure transcription accuracy using an appropriate metric such as WER.
- Evaluate speaker diarization separately from transcription.
- Record provider, model, configuration and hardware used for each evaluation.
- Define explicit pilot acceptance thresholds.
- Identify unsupported or high-risk audio conditions.
- Ensure evaluation data is lawful and privacy-safe.

## Definition of Done

- [ ] A documented evaluation dataset and sampling rationale exist.
- [ ] Evaluation includes clean and degraded audio.
- [ ] Evaluation includes overlapping speech.
- [ ] Evaluation includes multiple speakers.
- [ ] Evaluation includes short and long recordings.
- [ ] Reference transcripts are manually verified.
- [ ] Word Error Rate or an equivalent transcription metric is calculated.
- [ ] Speaker attribution accuracy is evaluated separately.
- [ ] Results are reproducible from a documented command or script.
- [ ] Provider, model version and relevant parameters are recorded.
- [ ] Hardware and runtime environment are recorded.
- [ ] Pilot acceptance thresholds are defined before final evaluation.
- [ ] Failed samples and known limitations are documented.
- [ ] No real personal data is committed to the public repository.
- [ ] Evaluation artefacts use synthetic, consented or appropriately protected data.
- [ ] The application clearly communicates when audio quality is insufficient.
- [ ] The final report states whether the quality gate passed or failed.

## Suggested evidence

- Evaluation script.
- Machine-readable result file.
- Human-readable summary.
- Example failure analysis.
- Documented acceptance thresholds.

## Out of scope

- Guaranteeing perfect transcription.
- Supporting every language, dialect or recording environment.
- Replacing domain-expert review of critical documents.
EOF

cat > "$WORKDIR/protocol-quality.md" <<'EOF'
## Description

Evaluate generated protocol accuracy, completeness and traceability against
human-reviewed transcripts and expected outputs.

Every important generated statement should be traceable to the source
transcript or explicitly marked as uncertain.

## Why this matters

A fluent protocol may still omit decisions, invent facts, assign actions to the
wrong person or change the meaning of the meeting.

## Functional requirements

- Define a protocol evaluation rubric.
- Evaluate factual correctness.
- Evaluate omission of decisions and action items.
- Evaluate unsupported additions and hallucinations.
- Evaluate ownership, deadlines and named entities.
- Require evidence references for important generated statements.
- Distinguish transcript-derived content from model inference.
- Define human review and approval requirements.
- Measure quality on representative pilot samples.
- Compare at least one deterministic or mock baseline where useful.

## Definition of Done

- [ ] A documented protocol evaluation rubric exists.
- [ ] The rubric covers factual accuracy.
- [ ] The rubric covers decision completeness.
- [ ] The rubric covers action-item completeness.
- [ ] The rubric covers incorrect additions or hallucinations.
- [ ] The rubric covers responsible-person attribution.
- [ ] The rubric covers deadline attribution.
- [ ] Important statements include transcript evidence or source references.
- [ ] Unsupported claims are rejected or clearly marked.
- [ ] Evaluation uses manually reviewed expected outputs.
- [ ] At least two reviewers assess a representative subset where feasible.
- [ ] Reviewer disagreements and adjudication are documented.
- [ ] Model provider, model name, prompt version and parameters are recorded.
- [ ] Prompt changes are versioned.
- [ ] The final acceptance threshold is documented.
- [ ] Failure examples are retained in a privacy-safe form.
- [ ] Users can review and edit the protocol before final export.
- [ ] The UI does not present an unreviewed AI output as an authoritative final record.
- [ ] The final report states whether the quality gate passed or failed.

## Out of scope

- Autonomous legal approval of meeting protocols.
- Guaranteeing that an AI-generated protocol requires no human review.
EOF

cat > "$WORKDIR/pii-quality.md" <<'EOF'
## Description

Measure the accuracy and safety of automatic PII detection and redaction before
the feature is trusted with pilot data.

The evaluation must consider both missed sensitive data and excessive
redaction that destroys document usefulness.

## Why this matters

A redaction feature may appear to work while missing names, contact details,
identifiers or context-dependent personal information.

## Functional requirements

- Define supported PII categories.
- Build a labelled evaluation dataset.
- Measure detection precision and recall by category.
- Prioritize recall for high-risk identifiers.
- Evaluate both transcript and export redaction.
- Test Lithuanian names, inflections and common identifiers.
- Test false positives in ordinary meeting terminology.
- Verify that original content remains access-controlled.
- Define human-review requirements.
- Define explicit acceptance thresholds.

## Definition of Done

- [ ] Supported PII categories are documented.
- [ ] Unsupported categories are documented.
- [ ] A labelled evaluation dataset exists.
- [ ] The dataset contains Lithuanian-language examples.
- [ ] The dataset includes names and surnames.
- [ ] The dataset includes email addresses.
- [ ] The dataset includes telephone numbers.
- [ ] The dataset includes personal or organizational identifiers where applicable.
- [ ] The dataset includes addresses and contextual location information.
- [ ] Precision is measured by category.
- [ ] Recall is measured by category.
- [ ] False negatives are reviewed manually.
- [ ] False positives are reviewed manually.
- [ ] High-risk identifier thresholds are stricter than low-risk categories.
- [ ] Redacted exports contain no hidden original text or metadata.
- [ ] Original and anonymised export paths remain distinct.
- [ ] Access to original content follows the authorization model.
- [ ] Redaction results can be reviewed and corrected by an authorized user.
- [ ] Evaluation examples committed publicly contain no real personal data.
- [ ] The final report states whether the quality gate passed or failed.

## Out of scope

- Proving that automated redaction can detect every possible type of personal data.
- Replacing a Data Protection Officer or legal assessment.
EOF

cat > "$WORKDIR/resilience.md" <<'EOF'
## Description

Validate pilot-scale load, recovery and resilience across inline execution,
Redis/BullMQ workers and external or local processing providers.

## Why this matters

A system that works for one short sample may fail during long recordings,
parallel jobs, worker restarts, provider outages or low-disk conditions.

## Functional requirements

- Define expected pilot load and concurrency.
- Test representative long recordings.
- Test multiple queued jobs.
- Test worker restart and queue recovery.
- Test cancellation and timeout behaviour.
- Test provider failure and retry behaviour.
- Test Redis interruption where applicable.
- Test insufficient disk and storage cleanup behaviour.
- Verify readiness and health endpoints during failures.
- Confirm that recovery does not duplicate outputs or expose stale data.

## Definition of Done

- [ ] Expected pilot concurrency is documented.
- [ ] Expected maximum recording duration is documented.
- [ ] Expected audio file size range is documented.
- [ ] At least one representative long recording is processed successfully.
- [ ] Multiple queued jobs are tested.
- [ ] Worker restart recovery is verified with real Redis.
- [ ] Stalled-job recovery is verified.
- [ ] Retry and backoff behaviour is verified.
- [ ] Permanent provider failure produces a clear final job state.
- [ ] Job cancellation is tested.
- [ ] Job timeout is tested.
- [ ] Partial temporary artefacts are cleaned after failure.
- [ ] Duplicate processing does not silently produce conflicting final artefacts.
- [ ] Readiness becomes unhealthy when required workers are unavailable.
- [ ] Readiness recovers after worker restoration.
- [ ] Disk-space preflight or failure handling is tested.
- [ ] Sensitive content does not appear in resilience-test logs.
- [ ] Recovery after application restart is documented.
- [ ] Test results and environment specifications are recorded.
- [ ] The final report states whether the resilience gate passed or failed.

## Out of scope

- Internet-scale load testing.
- High-availability multi-region architecture.
- Unlimited recording duration.
EOF

cat > "$WORKDIR/user-acceptance.md" <<'EOF'
## Description

Prepare and execute structured pilot administration and user acceptance testing
with representative users.

The pilot must validate the complete workflow rather than only individual API
or AI components.

## Why this matters

A technically functioning system may still be unsuitable because users cannot
understand status, correct errors, find outputs or safely operate privacy
controls.

## Functional requirements

- Define pilot roles and participants.
- Prepare onboarding and operating instructions.
- Define realistic end-to-end test scenarios.
- Capture usability, usefulness and trust feedback.
- Record defects and improvement requests.
- Distinguish blocking issues from future enhancements.
- Verify that users understand AI limitations and review responsibilities.
- Verify that privacy controls are understandable.
- Define support and escalation routes.
- Obtain explicit pilot completion feedback.

## Definition of Done

- [ ] Pilot participant roles are documented.
- [ ] Test accounts and permissions are prepared.
- [ ] User onboarding material exists.
- [ ] A concise operator guide exists.
- [ ] End-to-end scenarios cover upload through final export.
- [ ] Scenarios cover transcript review and correction.
- [ ] Scenarios cover protocol review and correction.
- [ ] Scenarios cover redacted export.
- [ ] Scenarios cover original export permissions.
- [ ] Scenarios cover deletion.
- [ ] Scenarios cover failure and retry communication.
- [ ] Users are informed that AI outputs require review.
- [ ] Usability feedback is captured systematically.
- [ ] Perceived usefulness is captured systematically.
- [ ] Trust and confidence concerns are captured.
- [ ] Pilot defects are recorded as GitHub issues.
- [ ] Blocking defects are resolved or explicitly accepted before pilot closure.
- [ ] Support and incident contacts are available to participants.
- [ ] Participants provide completion feedback.
- [ ] A user-acceptance summary is produced.
- [ ] The final report states whether user acceptance passed or failed.

## Suggested measures

- Task completion rate.
- Time to complete the core workflow.
- Number of required corrections.
- System Usability Scale or a simpler documented alternative.
- User-reported usefulness.
- User-reported trust and concerns.

## Out of scope

- Large-scale public beta testing.
- Marketing validation.
- Statistical generalization to all potential users.
EOF

cat > "$WORKDIR/pilot-scope.md" <<'EOF'
## Description

Define the controlled pilot scope, operating rules, decision rights and exit
criteria before real data or real users are introduced.

## Why this matters

Without a written scope, a limited pilot can gradually become an undocumented
production service with unclear responsibility and unacceptable risk.

## Functional requirements

- Define pilot purpose and hypotheses.
- Define participating users and organizations.
- Define permitted data categories.
- Define excluded data and use cases.
- Define deployment environment.
- Define approved providers and privacy mode.
- Define recording, consent and access rules.
- Define retention and deletion periods.
- Define support hours and incident contacts.
- Define success, stop and exit criteria.
- Define who can authorize continuation or expansion.
- Define how pilot findings become roadmap decisions.

## Definition of Done

- [ ] A written pilot charter exists.
- [ ] Pilot objectives are explicit.
- [ ] Pilot hypotheses are explicit.
- [ ] Participant count and roles are defined.
- [ ] Permitted use cases are defined.
- [ ] Prohibited use cases are defined.
- [ ] Permitted data categories are defined.
- [ ] Special-category or highly sensitive data handling is explicitly decided.
- [ ] Approved deployment environment is defined.
- [ ] Approved providers are listed.
- [ ] Effective privacy mode is fixed or governed.
- [ ] Access roles and responsibilities are defined.
- [ ] Retention and deletion periods are defined.
- [ ] Backup behaviour is defined.
- [ ] Human review responsibilities are defined.
- [ ] Incident and support contacts are defined by role.
- [ ] Pilot start criteria are defined.
- [ ] Pilot pause or stop criteria are defined.
- [ ] Pilot success criteria are measurable.
- [ ] Pilot exit and data-cleanup procedure is documented.
- [ ] Expansion beyond pilot requires an explicit decision.
- [ ] Legal, privacy and organizational approvals are identified without claiming
      approval where none has been obtained.
- [ ] The final charter is approved by the responsible pilot owner.

## Out of scope

- General production terms of service.
- Organization-wide rollout.
- Automatic transition from pilot to production.
EOF

echo "Kuriami Pilot Validation issue..."

TRANSCRIPTION="$(
  create_issue \
    "Transcription and diarization quality gates" \
    "ai,testing,performance,priority:P0,pilot" \
    "$WORKDIR/transcription-quality.md"
)"

PROTOCOL="$(
  create_issue \
    "Protocol accuracy and traceability" \
    "ai,testing,privacy,priority:P0,pilot" \
    "$WORKDIR/protocol-quality.md"
)"

PII="$(
  create_issue \
    "PII redaction quality evaluation" \
    "ai,privacy,gdpr,testing,priority:P0,pilot" \
    "$WORKDIR/pii-quality.md"
)"

RESILIENCE="$(
  create_issue \
    "Pilot load, recovery and resilience testing" \
    "testing,operations,infrastructure,performance,priority:P1,pilot" \
    "$WORKDIR/resilience.md"
)"

UAT="$(
  create_issue \
    "Pilot administration and user acceptance" \
    "pilot,testing,documentation,priority:P1" \
    "$WORKDIR/user-acceptance.md"
)"

SCOPE="$(
  create_issue \
    "Pilot scope, operating rules and exit criteria" \
    "pilot,operations,privacy,documentation-only,priority:P0" \
    "$WORKDIR/pilot-scope.md"
)"

echo
echo "Pridedamos vidinės priklausomybės..."

add_blocked_by "$PROTOCOL" "$TRANSCRIPTION"
add_blocked_by "$UAT" "$TRANSCRIPTION"
add_blocked_by "$UAT" "$PROTOCOL"
add_blocked_by "$UAT" "$PII"
add_blocked_by "$UAT" "$RESILIENCE"

echo
echo "Pilot Validation v1:"
echo "  #$TRANSCRIPTION  Transcription and diarization quality gates"
echo "  #$PROTOCOL       Protocol accuracy and traceability"
echo "  #$PII            PII redaction quality evaluation"
echo "  #$RESILIENCE     Pilot load, recovery and resilience testing"
echo "  #$UAT            Pilot administration and user acceptance"
echo "  #$SCOPE          Pilot scope, operating rules and exit criteria"
echo

gh issue list \
  --repo "$REPO" \
  --milestone "$MILESTONE" \
  --limit 100
