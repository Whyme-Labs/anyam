# Reliability, operations, and recovery contract

Status: Accepted

## Context

Anyam crosses several failure domains: Realm policy, Project coordination,
Git repositories, immutable objects, asynchronous delivery, execution Runners,
Target adapters, and external mirrors. A provider acknowledgement, Queue
acknowledgement, Workflow state, dashboard log, or deployment version is not by
itself an Anyam state transition.

Issue [#30](https://github.com/Whyme-Labs/anyam/issues/30) asked for SLOs, error
budgets, capacity assumptions, observability, audit retention, backups, restore,
RPO/RTO, degraded modes, incident response, support tooling, change management,
and runbooks for provider outages, partial cross-space Landing, queue
duplication, Workflow stalls, credential compromise, and backend migration.
The primary-source research is recorded in
[`docs/research/2026-08-02-reliability-operations-recovery.md`](../research/2026-08-02-reliability-operations-recovery.md).

Cloudflare's current receipts include closed-beta Artifacts, destructive D1
restore behavior, R2 durability that does not equal availability or deletion
protection, sampled/short-retention Workers logs and traces, at-least-once
Queues, non-transactional Worker rollbacks, and provider API rate limits. These
are adapter facts, not Anyam's product contract.

## Decision

Reliability is designed as three related planes:

```text
Control plane
  Project, Source Space, Change, policy, identity, audit, read models

Data plane
  Git source, Project Exports, Evidence, Artifacts, Releases

Execution/delivery plane
  Runs, Runners, Queues, Workflows, previews, Targets, Promotions
```

Anyam owns authoritative state, append-only domain facts, idempotency,
reconciliation, capability policy, provenance, and complete export. Cloudflare
and external products are provider or execution adapters. The reliability
invariant is:

> A provider acknowledgement becomes an Anyam state transition only after the
> owning authoritative context records and validates it.

### Authority and failure domains

| Surface | Authority | Failure behavior |
| --- | --- | --- |
| Realm grants, epochs, and membership | Realm Coordinator | High-risk operations fail closed; existing low-risk reads continue only under explicit session policy |
| Project Revision, Landing, Release, Target pointer | Project Coordinator | No mutation without expected version; pending/partial state is durable and visible |
| D1/search/catalogue | Rebuildable Read Model | Stale or unavailable reads are labeled; they never authorize protected actions |
| R2 Evidence/Artifact/export objects | Digest-addressed immutable object store plus manifest | No Evidence/Artifact is complete until write, read-back, and digest validation succeed |
| Queue delivery | Transport only | Duplicate, reordered, delayed, or dead-lettered messages are replayed from the Run ledger |
| Workflow instance | Orchestration only | Run ledger/checkpoint remains authoritative; stalled instances become recovery attempts |
| Runner/provider result | Attestation input | Result is accepted only for the current Run/Attempt, inputs, grant, and policy |
| Repository Driver/mirror | Source transport/projection | Provider outage or divergence never silently changes canonical Project authority |
| Worker/Target version | Provider output | Anyam Release/Promotion state and connected-resource compatibility decide rollback |

No global Coordinator, Queue order, Workflow state, read cache, provider event,
or remote mirror is promoted to authority by convenience.

### SLI/SLO and error-budget policy

Anyam does not publish one platform-wide uptime number. A Project owner
experiences distinct operations: safe public read, authenticated command,
source transfer, Change integrity, Run completion, Evidence retrieval, Release
creation, Target Promotion, mirror reconciliation, and recovery.

Each Hosting Mode and Stage declares candidate SLIs with a definition,
population, source, aggregation, exclusions, owner, and receipt. Candidate
indicators include:

- successful safe Project View reads and latency percentiles;
- correct idempotent command results and policy outcomes;
- clone/fetch/push completion through the Anyam Git Gateway;
- approved Change Revision to landed Project Revision equality;
- Runs reaching a terminal Evidence-bearing state without duplicate effects;
- Evidence digest retrieval and freshness verification;
- Target current-Release and health agreement;
- successful export/restore verification; and
- complete audit records for authority-bearing commands.

Targets are chosen from measured healthy workloads and user-visible behavior.
Means, provider invocation success, Queue acknowledgement, and sampled traces
are not sufficient substitutes for the relevant SLI.

Error budgets are separate for serving, mutation correctness, execution,
recovery, and dependency/mirror behavior. If a mutation or recovery budget is
exhausted, non-essential Landing, schema, policy, and provider changes pause;
incident mitigation, security response, and budget-restoring work remain
allowed. Numeric targets, windows, quotas, and concurrency limits require a
measurement receipt before they enter public policy or schema.

### Stage and Hosting Mode reliability

#### K0

K0 provides local-first recovery, Project Export, visible errors, and the
acceptance matrix. It makes no hosted availability or cost promise. A clean
scaffold, local check, and explicit connect path must not require a cloud
resource or implicit credential.

#### Private alpha

Customer-operated Realms own their Cloudflare operational availability. Anyam
ships diagnostics, export/restore, provider qualification, fault-injection
journeys, and runbooks. The alpha measures black-box baselines but does not
publish arbitrary SLO numbers.

#### Public beta

Public beta publishes per-surface SLOs and error-budget policy only after
baseline, dependency-outage, and recovery receipts. The same open-source
capability is used in customer-operated and any qualified Hosted SaaS mode;
hosting changes responsibility and placement, not the reliability contract.

#### Enterprise expansion

Enterprise Realms may declare customer-specific RPO/RTO, retention, legal hold,
residency, key, and support requirements. Each declaration has a business
impact analysis, an owner, a tested restore receipt, and an explicit residual
risk. Provider retention windows never become customer commitments by
implication.

### Observability and audit

The authoritative audit path is an append-only Anyam ledger plus
content-addressed Evidence, Artifact, Release, and Project Export objects.
Workers Logs, traces, Analytics, Queue messages, Workflow state, provider
events, and external observability systems are diagnostic telemetry: they may
be sampled, delayed, duplicated, truncated, or unavailable.

Every authority-bearing command and transition carries stable correlation
through HTTP, MCP, CLI, Git Gateway, Queue, Workflow, Runner, Evidence, and
Promotion. The ledger records principal, Actor, client, Session, Task,
Capability Grant, policy decision/version/epoch, expected aggregate version,
provider operation IDs, source/input/output digests, disclosure class, result,
and timestamps. It excludes raw tokens, secret values, inaccessible source,
private model reasoning, and unbounded logs.

Diagnostics are exported to durable customer-controlled storage where policy
allows. Sampled traces can explain a failure; they cannot prove that a
privileged operation happened or did not happen. Retention classes for
operational telemetry, domain events, Evidence, provenance, security audit,
and legal hold are explicit in Realm policy and Project Exports. Bucket locks
or equivalent retention controls are defense in depth, not an independent
backup.

### Backup, restore, RPO, and RTO

Recovery sources are explicit:

| Data | Recovery source |
| --- | --- |
| Source Spaces | Signed Git refs/bundles/LFS objects and Project Export |
| Project/Change/policy ledger | Coordinator storage/checkpoints plus signed exports |
| D1/search | Rebuild from authoritative ledger/export; provider PITR is convenience only |
| Evidence/Artifacts | Digest-addressed objects, manifests, and verified exports |
| Runs/Queue/Workflow | Run ledger, Attempt identity, and Recovery Checkpoints |
| Grants/credentials | Realm policy and revocation state; plaintext credentials are never exported |
| Mirrors | Canonical state, remote inspection, and mirror cursors |

RPO is the permitted loss of acknowledged state. RTO is the time to return a
named capability to service. Both are selected per data class, impact class,
and Hosting Mode after business-impact analysis and a restore exercise. No
Cloudflare retention window is silently adopted as Anyam's RPO/RTO.

The restore runbook is:

```text
detect and classify
  → freeze affected mutation/Landing/Promotion
  → capture provider bookmarks and pre-restore export
  → restore in an isolated recovery namespace where possible
  → verify digests, event sequence, refs, policies, and disclosure
  → rebuild D1/read models and reconcile providers/Targets
  → approve a Recovery Checkpoint
  → resume low-risk reads, then mutations, then high-risk Promotion
  → publish impact and follow-up Changes
```

Restore never rewrites accepted history or resurrects active credentials.

### Degraded modes

Degraded behavior is a visible product contract across CLI, web, MCP, and API:

| Dependency failure | Allowed | Forbidden |
| --- | --- | --- |
| Auth/policy dependency | Safe public projections and explicitly allowed low-risk reads | New high-risk grants, visibility changes, Landing, Promotion |
| Project Coordinator | Last verified read model with mutation-unavailable state | Accepting unversioned mutation or stale authorization |
| D1/search | Stale labeled reads and deferred projection refresh | Using a read model as policy or Promotion authority |
| R2 | Safe existing reads; pause Evidence/Artifact/export writes | Marking durable Evidence complete without read-back |
| Queue | `dispatch_pending`, visible backlog, equivalent approved manual path | Dropping Runs or acknowledging before durable state |
| Workflow | Recovery-pending Run and new idempotent Attempt | Treating Workflow state as business completion |
| Repository Driver | Local work and safe public projection reads; block canonical mutation | Silent provider switch or unverified fallback authority |
| Cloudflare API/rate limit | Backoff using provider receipt and visible retry state | Blind retry loops or duplicate resource creation |
| External Runner | Compatible qualified Runner or pending Run | Unapproved execution or unverifiable Evidence |
| Mirror | Canonical Project continues; remote marked lagging/divergent | Remote state overwriting canonical authority |
| Suspected credential compromise | Revoke, quarantine, rotate, preserve forensics, freeze high-risk operations | Continuing privileged actions while waiting for expiry |

Every failure names the dependency, operation, current state, configured
provider limit where applicable, requested amount, and safe next action.

### Required failure runbooks

#### Queue duplication and redelivery

Persist the Run and dispatch intent before publishing a pointer message. Include
Run/Attempt/dispatch IDs, input and Action digests, and expiry. Deduplicate at
the consumer and every external side-effect boundary. Acknowledge only after
durable acceptance; a long job does not hold a Queue lease for its lifetime.
Redelivery is a replay request, not a second Run. Dead-letter storage is an
operational queue, never the business ledger.

#### Workflow stalls

The Run ledger is authoritative, Workflow is orchestration, Queue is delivery,
Runner is an execution attempt, and Evidence is the immutable result. A
watchdog marks a stalled attempt `recovery_pending`, revokes its capability,
and starts a new idempotent Attempt from a named checkpoint. Late results are
accepted only when they match the current Run/Attempt policy.

#### Partial cross-space Landing

Unless a RepositoryDriver proves a transaction across all participating Source
Spaces, Landing uses an explicit state machine:

```text
planned → checks_passed → apply_requested
  → committed

any failed/unknown apply
  → partial_landing
  → freeze affected Project Revision
  → inspect and reconcile actual refs/digests
  → retry idempotently or create a compensating Change
  → committed or abandoned with a recovery record
```

The public projection is not advanced until required Source Space acknowledgments
and digest checks agree. A partial Landing blocks dependent Promotion and is
visible to maintainers and agents.

#### Credential compromise

The incident sequence is:

```text
detect suspicion
  → freeze high-risk operations
  → revoke grants/sessions/token families and increment auth epoch
  → quarantine Workspace/Runner/Mirror/App installation
  → reject Git/MCP/provider token exchange
  → rotate broker secrets/signing keys as required
  → inspect audit, source, Evidence, and Target events
  → assess disclosure and side effects
  → restore/reconcile if integrity is uncertain
  → re-enable only through a reviewed Change
```

#### Backend/provider migration

Migration is a signed Project Export/import operation, not a configuration
toggle:

```text
freeze affected authority boundary
  → export source, ledger, policy, Evidence, Releases, and recovery refs
  → import into candidate Driver/Store
  → compare refs, digests, versions, policies, and projections
  → run shadow reads and isolated restore drills
  → record migration Change and cutover Checkpoint
  → switch authority with compare-and-swap
  → retain old backend read-only until qualified rollback window ends
  → reconcile late events and mirror cursors
```

No silent dual-write becomes business authority. Credentials are not part of
the migration export.

### Incident response, support, and change management

Anyam adapts the current NIST incident lifecycle:

```text
prepare → detect/analyze → contain → remediate → recover/verify → communicate → improve
```

An Incident record includes impact class, affected Realm/Project/Source
Space/Target, Commander and responders, UTC timeline, provider/request IDs,
customer impact, disclosure/integrity assessment, degraded mode, containment,
recovery Evidence, and follow-up Changes.

Support surfaces include safe diagnostics such as:

```text
anyam doctor
anyam diagnostics collect --redact
anyam status --project <id>
anyam recovery checkpoint create
anyam recovery verify <export>
anyam mirrors reconcile --dry-run
anyam runs reconcile --dry-run
```

Diagnostics include versions, provider health, IDs, state hashes, policy/auth
epochs, Queue/Workflow state, and structured errors; they omit tokens, secret
values, private source, and unrestricted logs.

Reliability-sensitive changes are ordinary Anyam Changes with reviewable
Evidence: schema and Durable Object lifecycle, ledger/event schema, auth and
revocation, RepositoryDriver/provider upgrades, Queue/Workflow state machines,
backup/export/restore, retention/disclosure/audit, Target adapters, and
observability redaction/sampling. A Worker version rollback is never treated as
universal undo for connected data or Targets.

### Stage qualification

Private alpha must exercise command replay, Queue redelivery, Workflow restart,
late-result rejection, export/restore, partial Landing, provider rate-limit and
dependency outage modes, credential revocation/quarantine, and safe
diagnostics.

Public beta must additionally qualify per-surface SLO/error-budget policy,
independent RepositoryDriver export/import, mirror divergence and recovery,
external Runner failure/revocation, audit reconciliation, retention policy,
and recovery in customer-operated and hosted modes separately.

Enterprise expansion adds customer-defined RPO/RTO, retention/legal hold,
residency/key behavior, dedicated isolation, restore attestations, and support
escalation only when each has a tested receipt.

## Consequences

This contract makes availability, integrity, and recoverability explicit without
pretending that a provider's current limit or retention window is an Anyam
promise. It keeps the system useful during read-model, Queue, Workflow, mirror,
and Runner failures while blocking unsafe mutations.

The cost is operational discipline: authoritative events, exports, runbooks,
fault injection, and restore drills must evolve with the kernel. That cost is
load-bearing. A green dashboard without a recoverable ledger, explicit degraded
mode, or receipt-backed SLO is a landmine, not reliability.
