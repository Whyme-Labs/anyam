# Evidence-backed acceptance and validation

Status: Accepted

## Context

Anyam's broad model cannot be validated by a single build, a green dashboard,
or an unbounded claim that an arbitrary public Project Profile "works". The
product has to serve solo developers, teams, public contributors, and multiple
coding agents while preserving Source Space disclosure, recovery, portability,
security, accessibility, performance, and operations.

Issue [#29](https://github.com/wms2537/anyam/issues/29) asked for the executable
contract that proves those journeys and permits a Stage to advance. The logic
prototype is preserved on
[`codex/prototype-acceptance-validation`](https://github.com/wms2537/anyam/tree/codex/prototype-acceptance-validation)
at commit [`5dafe8d`](https://github.com/wms2537/anyam/commit/5dafe8d).

The prototype demonstrated that a matrix of explicit Evidence records is more
honest than a checklist: missing, failed, and stale Evidence have different
meanings but all block a Stage Gate; a recovery scenario clears only after a
visible checkpoint resume; and performance is a receipt requirement rather
than an invented quota.

## Decision

Acceptance is a two-level contract:

```text
Validation Journey
  → Acceptance Criterion Evidence
  → Stage Gate decision
```

A Stage Gate is passed only when every required Criterion has current Evidence
and no required Criterion is missing, failed, stale, indeterminate, or hidden
behind a UI-only status. A failed or stale Criterion is not converted into a
warning by the runner.

### Acceptance Criterion

Every Criterion has a stable key and records:

```text
criterion key and version
Stage and risk class
Project/Reference Fixture
Actor, client, and Runner
Source Snapshot or Project Revision
Policy version and authorization epoch
Capability Grant and disclosure context
Action/Verifier/toolchain/dependency identity
preconditions and declared effects
expected invariant
Evidence output and disclosure projection
freshness/invalidating inputs
owner and residual-risk reference
```

The criterion's receipt says what was actually measured or observed. A number
without its receipt is not a gate result. A qualitative invariant still names
the exact fixture, input, actor, and observed result that support it.

### Reference Fixtures

The initial acceptance program uses three deliberately small fixtures:

1. **Worker fixture** — a Cloudflare Worker Project that exercises local
   scaffold, preview, immutable Artifact/Release creation, Target Promotion,
   health verification, and rollback.
2. **CLI/library fixture** — a TypeScript CLI or library that exercises a
   non-web Build, typed Artifact, downloadable release asset, and Release
   lineage without a live runtime.
3. **Hybrid-source fixture** — a Project with a public Source Space and a
   private Source Space, such as a public video player and private codec. The
   fixture proves disclosure integrity and safe public projection. It does not
   attempt to define a universal rule for whether the public projection is
   functionally complete; that remains an owner-declared Project Profile
   concern.

The fixtures are source-controlled and small enough to run locally, in the
Cloudflare default Runner, and through a qualified external Runner when the
Stage requires it. They are not production applications or performance
benchmarks for customer workloads.

### Validation Journeys

The matrix covers these journeys. Each journey has a normal path, at least one
adversarial path, and a disclosed Evidence projection appropriate to its
audience.

#### Local and solo development

```text
create-anyam scaffold
→ inspect generated Project Manifest proposal
→ local check
→ anyam connect (explicit confirmation)
→ clone/edit/commit/push against a Workspace Repository
→ publish Change Revision
→ inspect Evidence and Candidate Output
```

The journey proves no cloud resource or credential is created by scaffolding,
Git vocabulary remains usable, and direct canonical writes are denied.

#### Team review and progressive ceremony

```text
human creates Intent
→ developer claims scope
→ agent or developer publishes revisions
→ reviewer submits finding
→ required approval and separation-of-duty policy evaluates
→ Integration Cohort verifies current base
→ Landing produces a Project Revision
```

The same journey is exercised with solo policy, team policy, and a high-risk
policy. The domain objects do not fork into a separate solo or enterprise
workflow.

#### Multi-agent work

Codex, Claude Code, Cursor, and a model-independent client each receive the
same semantic task through their supported local/remote interface. The
criterion checks that:

- each Actor sees only its Project View and Context Manifest;
- each receives a bounded Workspace Capability Grant;
- Git transfers source objects and MCP/CLI coordinate semantic operations;
- no agent can write canonical source, approve its own Change, or reveal a
  Secret Use value; and
- handoff creates a fresh task session and revokes or expires the prior one.

The test records observable operations and policy decisions, not private model
reasoning.

#### Hybrid-source contribution

An unauthenticated public contributor clones the public projection, proposes a
Change, and receives only the public Disclosure Projection of review and
verifier results. An authorized maintainer composes the Change with private
source and may run a Sealed Verifier. Private object identifiers, paths,
titles, timing, and raw verifier inputs remain undiscoverable.

#### Import and failure recovery

An Import Operation is forced to fail after quarantine and again during
Promotion health verification. The acceptance result must show:

```text
blocked state
checkpoint
partial effects
next remediation
idempotency behavior
safe resume or rollback
```

The operation cannot claim success, create duplicate repositories, rebuild a
Release unnecessarily, or silently discard source/metadata.

#### Portability and provider change

The Project is exported, its signed digest is verified, and it is restored into
another qualified RepositoryDriver or customer-operated Realm. The restored
Project preserves permitted source, Source Spaces, Project Profiles, Changes,
Evidence metadata, Releases, policies, audit history, and recovery refs. No
credential is present in the export.

#### Security qualification

Critical trust-boundary journeys exercise:

- canonical Landing and Target Promotion bypass attempts;
- hidden Source Space and cross-Realm disclosure attempts;
- audience confusion, replay, widening, and stale-grant attempts;
- raw Secret Use access and unauthorized outbound destinations;
- false or mismatched Evidence/provenance;
- unsafe Publication Change and public projection leaks; and
- cross-tenant mutation through API, Git, MCP, Runner, mirror, and provider
  callbacks.

The result is a Qualification Gate Evidence record, not merely a scanner
finding or UI status.

#### Web companion accessibility

The minimal web companion journey is tested with keyboard-only operation,
focus order and restoration, accessible names/roles/values, contrast, reduced
motion, zoom/reflow, error identification, and screen-reader announcements for
blocked gates and Promotion state. The CLI remains the primary authoring path;
the web surface must still be usable for review, approval, preview, and
rollback.

#### Performance and capacity receipts

Performance validation measures healthy reference journeys before declaring a
budget or tripwire. The receipt includes workload shape, source size, object
count, action/toolchain, Runner, memory/CPU observation, wall time, cache
state, and measurement method. Limits are named in errors with configured and
requested values when encountered. The acceptance program does not promote an
unmeasured number into a product promise.

#### Operations and rollback

The Project emits an attributable Audit Event for authority-bearing actions,
retries a delivery operation idempotently, exposes health and current Release,
and rolls back by creating a new guarded Promotion to an earlier Release. A
source Landing failure, Artifact failure, Target failure, queue duplicate, or
stale Evidence result must leave an explicit state that can be resumed or
repaired.

### Evidence shape

The acceptance runner writes normalized Evidence with this minimum shape:

```text
Acceptance Evidence ID
Criterion and contract version
Journey and Reference Fixture
exact Project View/Project Revision or source Snapshot
Action/Verifier and toolchain digest
Runner and Capability Grant identity
policy version, authorization epoch, and disclosure audience
declared inputs/effects and output digests
result: passed | failed | stale | indeterminate
receipt or reproducible observation
safe audience projection
invalidating conditions
owner and residual risk
```

Evidence is immutable and append-only. A rerun produces a new Evidence record;
it does not mutate the old result. A policy, source, dependency, Runner,
disclosure, Target, or verifier change marks the affected result stale.

### Stage mapping

The criteria are mapped to the stages accepted in ADR 0020:

- **K0:** local scaffold/connect, solo Git flow, local agent integration,
  Project Export/restore, and measured performance receipt discipline.
- **Private alpha:** Worker Target, CLI/library Artifact Target, hybrid Source
  Space, import/Promotion recovery, critical security boundaries,
  accessibility, and operations/rollback.
- **Public beta:** team review, public contribution, multiple Realms,
  repository fallback, two-way GitHub mirror, external pull Runner, and npm
  Target.
- **Expansion:** each enterprise or ecosystem adapter receives a new Criterion,
  contract, qualification gate, migration path, and residual-risk owner.

### Acceptance runner behavior

The real acceptance runner should support:

- deterministic fixture setup and teardown;
- CLI, Git HTTPS, REST/SDK, MCP, web, Runner, and provider adapter journeys;
- exact expected-state and idempotency assertions;
- adversarial fault injection at Import, Queue, Landing, Artifact, Target,
  mirror, auth, and disclosure boundaries;
- Evidence projection for public, contributor, maintainer, security, and owner
  audiences;
- replay/recovery from a named Recovery Checkpoint;
- current-stage evaluation that lists missing, failed, stale, or indeterminate
  Criteria and remediation; and
- exportable acceptance reports with source and Evidence digests.

The runner is a validation tool, not an authority service. It cannot approve a
Change, promote a Target, or alter canonical Project state except through the
same policy-governed commands a real Actor would use.

## Consequences

The acceptance program is broad enough to catch the product's defining
failure modes before public beta, but it does not demand every ecosystem or
enterprise integration up front. The matrix makes omissions visible and gives
agents actionable blockers instead of blank failures.

The principal cost is maintaining fixtures and Evidence contracts as the
kernel evolves. That cost is intentional: a Stage without reproducible
Evidence is a marketing label, not a release boundary. The fixture set must
remain small and representative, while customer-scale performance and
provider-specific limits remain separately measured qualifications.
