# ADR 0038: Stage Gates and operational receipts

- Status: Accepted
- Date: 2026-08-03
- Issue: [#56 — Qualify Stage Gates and operational receipts](https://github.com/Whyme-Labs/anyam/issues/56)
- Depends on: [ADR 0020](./0020-releasable-stages-and-entry-exit-gates.md), [ADR 0021](./0021-evidence-backed-acceptance-and-validation.md), [ADR 0022](./0022-reliability-operations-and-recovery-contract.md), [ADR 0023](./0023-receipt-backed-costs-quotas-and-packaging.md), [ADR 0027](./0027-phased-delivery-program.md), [ADR 0037](./0037-external-pull-runners-and-generic-target-qualification.md)

## Decision

Anyam qualifies a Stage through a versioned `QualificationPlan`. The plan is an executable registry of:

- Stage Gate definitions and their dependency order.
- Acceptance Criteria and Reference Fixtures.
- Qualification Evidence indexed by exact Project Revision, Project View, Source Space snapshots, policy version, authorization epoch, toolchain, dependencies, environment, Runner, Capability Grant, disclosure projection, and validity key.
- Reliability Objectives, Usage Receipts, Provider Cost Receipts, Budget Policies, and Budget Decisions.
- Recovery Drills for the failure and restore boundaries owned by the Stage.
- Residual Risks with owners, mitigations, qualification gates, and explicit accepted or deferred decisions.

The implementation lives in `src/qualification/stages.ts` and is exported through the TypeScript package surface. It is a deterministic in-memory qualification registry for the K0 kernel and test/fixture qualification. A durable service, database schema, and provider-specific receipt adapter are later transport and persistence work; they must preserve this contract rather than replace it.

## Stage model

The implementation keeps the four stages already accepted by the delivery program:

```text
K0 → private-alpha → public-beta → expansion
```

Each Stage Gate declares its predecessor stages, required Acceptance Criteria, operational record identities, Recovery Drill kinds, and Residual Risk identities. A Stage may be activated only after its predecessor stages are complete. Completion evaluates the current registry state and fails closed when any required record is missing or unacceptable.

The registry returns a `QualificationGateDecision` with:

- `ready` or `blocked` status;
- typed blockers for dependencies, criteria, reliability, usage, provider cost, budget, recovery, and risk;
- advisories for an explicitly unavailable provider feed or deferred Residual Risk;
- the Evidence identities considered; and
- a human- and machine-readable receipt.

Every blocker includes a next action. Missing data is not represented by an empty dashboard or an implicit default.

## Exact Evidence context

Qualification Evidence is not interchangeable with an ordinary test result. A record must identify the context in which the observation was made:

```text
Project Revision
Project View
Source Space snapshots
Policy version
Authorization epoch
Toolchain and dependency digests
Environment digest
Runner
Capability Grant
Disclosure projection
Action, Verifier, Change Revision, Target, input, and effect digests when applicable
Validity key
```

A passed record is treated as stale when its expected validity key or expected context no longer matches the active plan. Failed, stale, and indeterminate records block the Stage. Evidence must carry an owner, receipt, and next action; an incomplete passed-looking record becomes indeterminate rather than silently qualifying the Stage.

## Receipts and measurements

Any value used as a reliability target, error budget, usage quantity, provider quantity, cost, budget limit, requested amount, or consumed amount is a `MeasuredQuantity`. It is valid only when it carries:

```text
value
unit
source
method
measuredAt
receipt
```

The contract intentionally does not publish generic platform limits, prices, SLOs, or quotas. Those values are introduced only after a real measurement and receipt are available. Provider feeds may be delayed or unavailable; an explicit Provider Cost Receipt with `feedStatus=unavailable` is visible as an advisory and does not become an invented invoice. A missing usage or provider receipt still blocks a Stage that declares it required.

Budget decisions must name the policy, requested quantity, consumed quantity, known limit when present, uncertainty, and next action. A budget failure is therefore actionable for a developer or agent instead of being a silent runtime cap.

## Recovery qualification

Recovery is qualified as an executable drill, not as a prose promise. The default plan covers:

```text
import
provider outage
partial Landing
partial Promotion
mirror divergence
credential compromise
restore
```

A Recovery Drill records a named Recovery Checkpoint, exact context, expected invariant, observed result, status, owner, receipt, and next action. The latest failed, stale, or indeterminate drill blocks its Stage. A new attempt is a new immutable drill record; it does not erase the failed observation.

The drills qualify the recovery contract and do not claim that every provider or workload has already been tested. Provider-specific recovery remains an adapter qualification obligation.

## Residual Risk

Residual Risk is explicit state, not a comment or a boolean exception. Every risk referenced by a Stage Gate must have:

- an owner;
- a mitigation;
- a named qualification gate;
- a receipt-backed decision; and
- `accepted`, `deferred`, or `open` state.

`open` blocks the Stage. `deferred` is allowed only as a visible advisory with its next action. `accepted` is visible in the decision and receipt. None of these states weakens a Source Space, canonical Landing, Secret Use, or Promotion boundary.

## Consequences

### Positive

- Stage readiness can be reproduced from structured records rather than inferred from UI state.
- Evidence, receipts, drills, and risks share one exact-context vocabulary.
- Missing, stale, failed, and indeterminate qualification produces an actionable failure for humans and agents.
- Operational numbers remain honest: no public limit is emitted without its measurement receipt.
- Cloudflare and other provider facts remain adapters and qualification inputs, not unverified Anyam contracts.
- The same registry can back local fixtures, a hosted service, and a customer-operated Realm when persistence is added.

### Costs

- A Stage cannot be declared complete by a green test alone; operational and recovery records are deliberate work.
- A durable implementation must persist immutable records and preserve their context and disclosure policy.
- Stage plans must be versioned when criteria, dependencies, policies, or recovery obligations change.
- The in-memory registry is a qualification kernel, not a production event store; replacing it with a database without preserving the record semantics would be a landmine.

## Rejected alternatives

### UI-only stage status

Rejected because a status label cannot prove exact source, context, freshness, operational receipt, or recovery behavior.

### One untyped “check” record

Rejected because reliability, usage, cost, budget, recovery, and Residual Risk have different owners, freshness, disclosure, and remediation semantics.

### Public provider quotas as Anyam constants

Rejected because provider limits and prices drift. Anyam records measured observations and provider reconciliation instead of hard-coding unreceipted values.

### Treating an unavailable provider feed as a fabricated bill

Rejected. The ledger remains explicit and usable, but the uncertainty and reconciliation action stay visible.

### Automatically accepting open risks

Rejected because risk acceptance is an authority-bearing decision and must be named, owned, and receipt-backed.

## Qualification boundary

The tests for this ADR prove registry invariants, exact-context staleness, actionable blockers, measured-value receipts, recovery matrix coverage, dependency ordering, and explicit risk decisions. They do not claim a production SLO, Cloudflare invoice accuracy, provider availability, or universal buildability. Those claims require real fixture and provider receipts at the Stage where they are declared.
