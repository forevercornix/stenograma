# AGENTS.md

This file defines repository-level instructions for AI coding agents and code-review agents working on `stenograma`.

## 1. General principles

- Treat existing repository behavior, tests, documented contracts, ADRs, and issue acceptance criteria as authoritative.
- Prefer minimal, focused changes over broad refactoring.
- Do not change unrelated behavior unless the issue explicitly requires it.
- Do not weaken existing validation, authorization, security, test coverage, or backward-compatibility guarantees to make a change pass.
- Never assume that code is correct solely because tests pass.
- Distinguish clearly between verified facts, reasonable inferences, and behavior that cannot be verified.

## 2. Issue and Definition of Done review

When reviewing a pull request linked to an issue:

1. Read the linked issue before assessing whether the PR is complete.
2. Read all explicit:
   - acceptance criteria;
   - Definition of Done items;
   - linked sub-issues that are part of the PR scope;
   - architectural decisions or contracts referenced by the issue.
3. Map each criterion to concrete evidence in:
   - implementation;
   - tests;
   - documentation;
   - configuration;
   - CI results, where available.
4. Classify every criterion as:
   - `PASS` — fully implemented and supported by evidence;
   - `PARTIAL` — implemented only in part;
   - `FAIL` — missing or contradicted by the implementation;
   - `UNVERIFIED` — cannot be established from the repository, PR, tests, or available environment.
5. Do not infer completion from the PR title, description, commit message, or issue-closing keyword alone.
6. If any required criterion is `PARTIAL`, `FAIL`, or materially `UNVERIFIED`, do not recommend closing the issue.

## 3. Required review output

For reviews that evaluate issue completion, finish with:

### Issue closure assessment

**DoD / acceptance criteria**
- `[PASS]` criterion — evidence
- `[PARTIAL]` criterion — missing or incomplete part
- `[FAIL]` criterion — reason
- `[UNVERIFIED]` criterion — required external/manual evidence

**Tests**
- Relevant automated tests present
- Important missing coverage
- Negative/error-path coverage
- Integration or environment-specific verification still required
- For each criterion supported by a test: would that test fail if the behavior
  were removed? (§9.1) If not, the criterion is `UNVERIFIED`, not `PASS`.

**Regression and security risks**
- Findings, or `None identified`

**Final verdict**
- `READY TO CLOSE`
- `NOT READY TO CLOSE`

Never use `READY TO CLOSE` while a mandatory DoD item is `PARTIAL`, `FAIL`, or materially `UNVERIFIED`.

## 4. Code review priorities

Prioritize findings that can cause:

1. Security or authorization failures
2. Data loss or cross-user data exposure
3. Incorrect externally visible behavior
4. Race conditions or broken atomicity
5. Backward-compatibility regressions
6. Broken API or persistence contracts
7. Silent failure or incorrect error mapping
8. Missing required validation
9. Incorrect asynchronous/job lifecycle behavior
10. Missing regression tests for changed behavior

Avoid filling reviews with purely stylistic comments unless the style issue creates a correctness or maintainability risk.

## 5. Authorization and ownership

Treat authorization boundaries as security-critical.

- User-owned resources must enforce ownership consistently.
- Route-layer code must not bypass owner-scoped APIs through privileged/system-scoped access.
- System-scoped APIs are for trusted internal workers/services only unless explicitly documented otherwise.
- Never allow ownership fields such as `ownerId` to become mutable through generic patch/update operations.
- Authorization must fail closed when identity, schema version, ownership state, or migration era is unknown.
- Check both positive and negative authorization paths.
- Look for TOCTOU and read-check-write races around ownership-sensitive mutations.
- Prefer atomic authorization-and-mutation semantics where concurrent state changes are possible.

## 6. Backward compatibility and persisted data

Changes affecting persisted jobs, schemas, APIs, configuration, or serialized state must account for older data.

Review explicitly for:

- missing fields in legacy records;
- old schema versions;
- unknown/future schema versions;
- null versus undefined behavior;
- migration assumptions;
- renamed or removed fields;
- API response compatibility;
- old clients or workers interacting with new state.

Unknown or unsupported persisted state must not silently bypass validation or authorization.

## 7. Async jobs, queues, and workers

For changes involving queues, workers, transcription jobs, diarization jobs, polling, cancellation, or recovery:

- Verify legal state transitions.
- Check retry and duplicate-execution behavior.
- Check idempotency where appropriate.
- Check cancellation and cleanup paths.
- Check behavior after worker/process interruption.
- Check race conditions between API requests and workers.
- Ensure errors are surfaced rather than silently swallowed.
- Confirm owner-facing APIs do not expose another user's job state or results.

## 8. External providers

For transcription, diarization, LLM, cloud, or other provider integrations:

- Preserve provider abstraction boundaries.
- Do not hard-code assumptions that apply only to one provider unless the contract explicitly requires it.
- Validate configuration before use.
- Handle provider errors and malformed responses explicitly.
- Avoid leaking secrets, credentials, raw authorization headers, or unnecessary sensitive content into logs.
- Tests should use mocks/fakes where practical and must not depend on paid external services unless explicitly marked as integration tests.

## 9. Tests

For every behavior-changing PR:

- Require tests for the changed contract where automated verification is practical.
- Prefer regression tests that would fail before the fix and pass after it.
- Check:
  - expected success path;
  - invalid input;
  - forbidden/unauthorized path;
  - boundary conditions;
  - relevant failure paths;
  - legacy-state behavior where applicable.
- A test asserting only status code or absence of an exception may be insufficient when payload/state behavior matters.
- Do not treat mocked tests as proof of real external-provider behavior.

### 9.1 Mutation resistance

A passing test is not evidence. The relevant question is whether the test would
**fail if the behavior it claims to protect were removed**.

For each test presented as evidence for a DoD criterion, ask: *if the guard,
branch, or check were deleted, would this test fail?* If the answer is no, the
test does not support the claim.

Common patterns that pass while proving nothing:

- **Spy on a module export that the consumer destructured at import time.**
  `const { fn } = require("./mod")` captures the reference; replacing
  `mod.fn` afterwards does not affect the consumer.
- **Race test that changes state before the fast path runs.** If an in-process
  check rejects the input, the atomic/CAS layer under test is never reached.
  Intercept at the boundary being tested (e.g. the driver call), not before it.
- **Conditional skips that swallow regressions.** `if (res.status !== 200)
  continue` turns 401/403/404/500 into a pass.
- **Assertions that are true for the failure case.** `assert(x !== undefined)`
  passes for `null`; `expect(r).toBeTruthy()` passes for `"false"`.
- **Testing the helper instead of the caller.** Verifying a shared function's
  semantics does not verify that the production path invokes it.
- **Fixed-size text windows.** Searching N characters before a marker breaks
  when a comment grows; scan the whole file or parse structurally.

Where a test's value depends on ordering or interception, state the assumption
in a comment so a later edit cannot silently invalidate it.

### 9.2 Static checks are not behavioral evidence

A `grep`-style assertion over source text proves that a string exists, not that
the code path executes correctly.

- Do not accept a static check as evidence for a behavioral DoD criterion.
- A static check is legitimate as a **tripwire** — cheap, fast feedback for a
  known failure pattern — but it must be labeled as such, and the underlying
  behavior needs its own test.
- Be explicit about scope: a check over four directories' top-level files does
  not justify the claim "no production path does X".
- Watch for static checks that match their own documentation. Strip comments
  and string literals before scanning.

### 9.3 Test isolation

Shared test infrastructure (database, queue, global registry, `process.env`)
creates cross-file coupling that is invisible when a file is run alone.

- Flag any test that clears shared global state (`flushdb`, truncate, registry
  reset) when the runner executes files in parallel.
- Flag assertions on global counts (`listAll().length`, total row counts);
  filter by identifiers the test itself created.
- Flag tests that mutate `process.env` for behavior that other tests observe.
- Verify that registries, providers, processors, and monkey-patched functions
  are restored — and that the restore actually works. A restore guarded by an
  unexported internal (`mod._internal ? ... : undefined`) silently does nothing.
- A test that passes alone but fails in the suite, or whose failure varies
  between runs, indicates coupling, not flakiness to be retried away.

When a DoD requires GPU, RunPod, real audio, real provider credentials, browser/device behavior, or another unavailable environment, classify that requirement as `UNVERIFIED` unless concrete evidence is present.

## 10. Security review

Pay particular attention to:

- authentication and authorization;
- user/job ownership isolation;
- injection risks;
- path traversal;
- unsafe file handling;
- upload validation;
- command execution;
- secrets exposure;
- SSRF;
- insecure provider configuration;
- sensitive logging;
- untrusted LLM/provider output used as trusted instructions or executable data.

Do not report speculative security issues without a plausible execution path.

## 11. API contracts and error handling

When API behavior changes:

- Verify success and failure response contracts.
- Preserve documented HTTP status semantics.
- Distinguish authentication, authorization, not-found, conflict, validation, and server errors.
- Avoid exposing internal implementation details in client-facing errors.
- Ensure errors are consistently mapped across equivalent routes.

## 12. Documentation and architecture

Check whether a code change also requires updates to:

- README or setup documentation;
- environment-variable examples;
- API documentation;
- runbooks;
- ADRs;
- deployment instructions;
- changelog/release notes.

Do not require documentation changes for implementation details that do not affect users, operators, contributors, or architectural contracts.

### 12.1 Documentation must not overstate the code

Comments, docs, and guarantee tables are read as authoritative. A statement
stronger than the implementation is worse than no statement: it stops the next
reader from checking.

Flag as a defect, not a style issue:

- A guarantee described as universal when the implementation has exceptions
  ("no exceptions" next to an allowlist; "all paths" next to a manual list).
- A property described as incremental, atomic, or enforced when it holds only
  under conditions the text omits.
- A comment describing behavior that a later change removed.
- A claim of exhaustiveness that depends on a hand-maintained list. Either
  verify the list against the code in a test, or state that it is partial.
- Naming that implies a stronger contract than the code provides.

Where a hand-maintained list must exist, prefer a test asserting it matches
reality over a comment asking future authors to remember.

If later evidence disproves or materially weakens an earlier claim in a plan, PR
description, checked-in report, guarantee table, or other maintained project
artifact, correct the claim **at the place where it was originally published**.

A later comment, review reply, or follow-up note does not by itself repair an
authoritative or durable statement that remains false or overstated. Where the
original artifact cannot be edited, mark the superseding correction explicitly in
the closest durable source of truth.

## 13. Scope discipline

Flag unrelated changes when they:

- increase regression risk;
- obscure the purpose of the PR;
- alter behavior outside the linked issue;
- make review materially harder.

Small cleanup directly required by the implementation is acceptable.

## 14. Evidence standard

A claim is considered verified only when supported by inspectable evidence.

Acceptable evidence includes:

- code implementing the behavior;
- automated tests;
- repository documentation;
- configuration;
- CI output;
- explicit artifacts or results attached to the issue/PR.

Do not claim that:

- a manual test passed;
- an external service behaved correctly;
- a GPU/provider test succeeded;
- deployment succeeded;
- a performance target was met;

unless such evidence is actually available.

### 14.1 Weak evidence

The following are frequently offered as evidence but do not establish the
claimed behavior:

| Presented as | Actually establishes |
|---|---|
| Suite passes after the change | Nothing about the change, unless a test targets it |
| Test discovery / `--list` / lint | Syntax and structure, not selector or runtime correctness |
| Static source scan | A string exists |
| Test calling the shared helper | Helper semantics, not that production calls it |
| Mocked provider test | Adapter behavior, not provider behavior |
| Single successful run of a concurrency test | Little; races are order-dependent |
| Production code writes a field, marker, status, registry entry, or metadata value | That the value is stored — not that any production behavior reads or depends on it |
| A search by symbol/function/variable name found no other callers | Names and direct references — not an inventory of behavior reached through adapters, wrappers, aliases, arguments, injection, registries, factories, or restored objects |
| A hand-maintained list matches the repository today | A point-in-time match — not that the list stays complete as the repository changes |
| A check, test, validation command, or matrix exists in the repository | That the artifact exists — not that the required CI or verification path executes it |

When a criterion depends on an environment unavailable during review (GPU,
browser, real credentials, production data volume), classify it `UNVERIFIED`
and name the evidence that would settle it — do not soften it to `PASS` because
the code looks right.

## 15. Review severity

Use review findings primarily for actionable defects.

Prefer:

- `P0` — catastrophic/security-critical issue requiring immediate action;
- `P1` — serious correctness, security, or data-integrity defect;
- `P2` — meaningful defect or regression that should be fixed before completion;
- `P3` — lower-impact maintainability or edge-case issue.

Do not escalate severity solely because a test is missing; severity should reflect the risk of the underlying unverified behavior.

## 16. Contract consistency across layers

When a contract is enforced at one boundary, check that other layers do not
implement a weaker version of it.

- A value validated strictly at the API boundary must not be re-interpreted
  loosely downstream. Truthiness checks are a common weakening: `"false"`,
  `"0"`, and `[]` are truthy.
- Where two boundaries handle the same invariant, they may legitimately differ
  in *response* (fail-fast in a service, fail-closed in a UI) but must not
  differ in *meaning*.
- Serializers and response builders should use allowlists, not spread. With
  `{ ...record }`, every field added later becomes public without a decision.
- Field naming and units must carry the same meaning end to end. A field
  documented as opaque work units must not be formatted as seconds by a
  consumer.
- Where the same data is produced by more than one route, service, or store
  backend, verify the contract is identical — divergence usually appears first
  in an optional field that only one path populates.

## 17. Final review rule

A technically sound diff does not automatically mean the linked issue is complete.

Before recommending issue closure, verify:

`requirements → implementation → tests → documented evidence`

If that chain is incomplete, state exactly what remains.

---

## 18. Agent roles and implementation workflow

Sections §18–§21 apply when acting as an **implementation agent**.

When acting only as a **review agent**, §2–§3 and §17 define the review and
closure workflow; do not modify code unless the task explicitly asks you to
implement or repair findings.

Sections §1 and §4–§16 apply to both roles.

### 18.1 Plan before implementation

For non-trivial implementation work, inspect the relevant repository state and
prepare an implementation plan before editing.

The plan must identify:

- scope and, where applicable, PR/stage boundaries;
- contracts and invariants affected;
- persistence and migration implications;
- relevant producers, consumers, callers, and equivalent implementations;
- test and verification strategy;
- rollback/cutover implications where applicable;
- unresolved decisions.

For each unresolved decision, classify whether it can be resolved under §18.2 or
requires human input under §18.3.

**Approval gates are derived from unresolved decisions**, not from task size or a
generic requirement to approve every plan.

- If the plan contains no decision requiring §18.3 human input, proceed with
  implementation without waiting for plan approval.
- If such a decision exists, stop before the first change that depends on it, and
  present the specific decision, alternatives, evidence, and recommendation.
- Do not perform work that **materially constrains** the outcome of a pending
  §18.3 decision, even when that work does not formally depend on it. Presenting a
  decision after building on one of its options is not a decision.
- Do not use a generic "show me the plan" checkpoint when the plan contains no
  decision requiring human approval.

The classification is itself subject to §14.1: a claim that no §18.3 decision
remained is not verifiable unless it can be inspected.

- List **all** unresolved decisions in the plan, including those resolved under
  §18.2, each with its classification and a one-line justification.
- Carry that classification into the completion report so it can be audited after
  the fact.
- If later evidence shows that a decision classified under §18.2 in fact belonged
  to §18.3, correct it under §12.1 — at the place where the original
  classification was published, not only in a later note.

If implementation evidence invalidates a material plan assumption, update the plan
and repeat the same classification. Stop only if the newly discovered decision
falls under §18.3.

### 18.2 Decision authority

Within an approved scope, resolve routine technical decisions from repository
evidence in this order:

1. authoritative issue acceptance criteria and DoD;
2. explicit repository contracts and ADRs;
3. these `AGENTS.md` rules;
4. intentional behavior encoded by tests;
5. repository documentation and operational contracts;
6. established implementation patterns;
7. the narrowest change consistent with the above.

Prefer the solution that preserves existing invariants, changes the smallest
legitimate surface, introduces the least new configuration or abstraction, and is
easiest to verify behaviorally.

Do not invent product requirements to resolve ambiguity.

### 18.3 Mandatory stop conditions

Stop for human input when safe continuation requires:

- resolving contradictory authoritative requirements;
- a product or externally visible behavior decision not established by repository
  evidence;
- a new security, privacy, authorization, retention, or data-governance policy
  decision;
- a material architectural, persistence, migration, compatibility, cutover, or
  rollback decision without an established precedent or approved plan;
- adding a new production dependency — SDK, service client, runtime package,
  hosted service, or equivalent supply-chain commitment — unless explicitly
  authorized by the issue or approved plan;
- violating an explicit hard constraint;
- destructive or irreversible action not explicitly authorized;
- missing permissions, credentials, infrastructure, or evidence that prevents
  implementation itself rather than only preventing verification.

A failing test is not itself a stop condition.

An unavailable verification environment is not a stop condition when the task
defines `UNVERIFIED`, `NOT RUN`, or equivalent handling.

When stopping, state the conflict, the evidence establishing it, work already
completed, viable alternatives, the recommended resolution, and what can continue
without the decision.

---

## 19. Root-cause-driven review and repair

Review findings, CI failures, and test failures are evidence of failure modes, not
an ordered patch queue.

### 19.1 Collect and validate before fixing

Before editing in response to a review round, collect all currently available
relevant findings where practical.

Classify each as:

- `VALID`;
- `VALID — SYMPTOM OF BROADER ROOT CAUSE`;
- `DUPLICATE`;
- `ALREADY RESOLVED`;
- `OUT OF SCOPE`;
- `INCORRECT / NOT APPLICABLE`;
- `REQUIRES HUMAN DECISION`.

Validate automated-review findings independently against the repository and the
authoritative requirements. Do not accept a finding solely because an automated
reviewer produced it, and do not reject one merely because the current behavior
was intentional or the suite is green.

Do not begin fixing finding #1 merely because it appeared first.

### 19.2 Group by root cause

Group related valid findings and identify:

`findings → violated invariant → root cause → affected surface → coherent repair`

Prefer repairing the violated invariant over patching individual symptoms.

A root-cause repair may legitimately touch more code than the originally reported
symptom, but it remains subject to the scope discipline in §13. Root-cause
analysis is not permission for unrelated cleanup or opportunistic refactoring.

### 19.3 Search beyond the reported symptom

Before declaring a root cause resolved, search for other manifestations of the
same failure mode.

Do not treat a symbol-name search as an exhaustive behavioral inventory; apply the
evidence rule in §14.1.

Where practical, derive the affected surface structurally from authoritative
repository structure — registries, exports, filesystem contents, schemas,
configuration, contracts, or backend interfaces.

Where structural derivation is impractical, prefer tests or inverted defaults that
make omitted members fail visibly rather than relying on an assumed-complete
inventory.

If the same root cause exists outside the legitimate PR scope and repairing it
would materially broaden the change, follow §13: document and escalate or split it
rather than silently expanding the PR.

### 19.4 Repair the invariant, not the comment

For each root-cause group:

1. state the root cause;
2. define the invariant that must hold;
3. identify the legitimate affected surface;
4. implement the narrowest coherent repair;
5. add or strengthen regression evidence;
6. apply §9.1 mutation-resistance reasoning;
7. verify relevant equivalent paths and contracts under §16.

A finding is resolved when the underlying supported failure mode is no longer
reachable, or when evidence establishes that the finding was not applicable — not
merely when the originally mentioned line changes.

### 19.5 Properties that look like guarantees

Apply §14.1 when implementation structure appears to establish a guarantee merely
because an artifact exists.

- **Sets should be derived.** For supported keys, backends, tables, scenarios,
  providers, matrix rows, persisted variants, configuration variables, or
  equivalent sets, prefer deriving membership from an authoritative source over
  maintaining a second enumeration. If a manual list is unavoidable, require an
  executable consistency check that fails when reality diverges from it.
- **Written state needs a consumer.** A field, marker, status, registry entry, or
  metadata value does not establish functional behavior merely because production
  code writes it. Identify the production path that reads and acts on it;
  otherwise the claimed behavior is incomplete or `UNVERIFIED`.
- **Existing checks must actually execute.** A test, validation command, matrix,
  or guard present in the repository is not enforcement evidence unless the
  required CI or verification path runs it.

Do not substitute a comment asking future maintainers to preserve these
relationships for executable verification where such verification is practical.

### 19.6 Findings ledger

For a non-trivial review batch, maintain a concise ledger:

`finding → validation → root-cause group → invariant → repair → verification → status`

Use it to distinguish multiple symptoms of one defect, recurrence of a previously
repaired root cause, genuinely new defects, and rejected or out-of-scope findings.

The number of closed review comments is not a quality metric.

---

## 20. Adversarial review

After implementation and required verification, review the complete resulting diff
as if it were an unfamiliar PR written by another developer.

Do not defend the implementation because you authored it. Do not treat a green
suite or the implementation plan as evidence of correctness.

Re-read the authoritative issue and apply §2, §4–§16 and §17 from scratch, against
the final diff rather than the files remembered from implementation.

In addition to those rules, explicitly check:

- whether the reported examples are symptoms of a broader invariant failure;
- TOCTOU and competing-operation orderings where state can change concurrently;
- retry and duplicate-execution behavior where operations may repeat;
- backend parity where multiple implementations expose one contract;
- adapters, wrappers, injected objects, and restored state that a name-based
  inventory may have missed;
- derived versus manually enumerated sets;
- written state that has no production consumer;
- required checks or tests that exist but are not executed by the actual CI path.

Collect the findings from this pass before repairing them, then process them
through §19 — including your own findings.

---

## 21. Repair cycles, review rounds, and communication

### 21.1 Repair loop

A first green suite is not completion.

`implement → verify → adversarial review → root-cause analysis → repair → verify`

Repeat while new in-scope blocking defects are found.

Do not leave a known in-scope `P0`, `P1`, or completion-blocking `P2` unfixed
merely because it was discovered after the first implementation pass.

Any repair that would materially expand the approved PR scope remains governed by
§13 and §19.3; this loop is not permission to absorb a separate issue into the
current PR.

### 21.2 External review batches

When an automated reviewer, CI, or a human reviewer supplies multiple findings:

`collect → validate → group → root cause → derive affected surface → repair → verify → adversarial review`

Treat a proposed reviewer fix as a suggestion: validate the reported defect and
the proposed remedy independently.

Finish collecting the current review round before beginning repairs where
practical, so related findings can be analyzed together.

**In automated review loops this rule applies unchanged.** A round is collected
before repair begins; the appearance of an individual comment is not a trigger to
edit the line it mentions.

### 21.3 Re-review after repair

A later review must verify the repaired root cause, not only the line originally
mentioned.

Ask:

- Is the original failure mode now unreachable?
- Does the invariant hold across the legitimate affected surface?
- Did an adapter, wrapper, alternate backend, restored object, or injected
  dependency preserve the same defect?
- Did the repair introduce another failure mode?
- Does regression evidence protect the invariant?
- Would the relevant test fail if the repair were removed?

If a later finding is another symptom of an earlier root cause, reopen that
root-cause group rather than treating it as an unrelated finding.

### 21.4 Communication and approval checkpoints

Autonomous implementation does not mean silent architectural decision-making.

For a single bounded PR, avoid approval requests for routine implementation
details and ordinary repair cycles.

Report separately and obtain approval when:

- §18.3 requires human input;
- a material architectural decision is discovered or changed;
- an approved multi-stage plan must change materially;
- a legitimate root-cause repair crosses the current PR boundary and requires a
  scope decision;
- a new production dependency is proposed.

Short progress reports are appropriate at meaningful boundaries in multi-stage
work, especially when they expose new architectural information, invalidate an
inventory assumption, or affect later stages.

Do not interrupt merely to narrate routine edits, individual test runs, or each
reviewer comment.

### 21.5 Completion

A task is `COMPLETE` when:

- current in-scope requirements are implemented;
- required locally executable verification has run;
- unavailable evidence is explicitly classified rather than fabricated;
- adversarial review has completed;
- known in-scope blocking defects have been repaired;
- the final diff and repository state have been inspected;
- remaining risks and `UNVERIFIED` / `NOT RUN` items are stated.

Otherwise the task is either still in the repair loop or `BLOCKED` under §18.3.

For each completed PR, provide one concise completion report covering:
implementation, root causes repaired, additional manifestations discovered beyond
the original findings, verification performed and its result, unavailable
evidence, remaining risks, decision classification under §18.1, and the final
repository/commit state.
