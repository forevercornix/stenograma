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
