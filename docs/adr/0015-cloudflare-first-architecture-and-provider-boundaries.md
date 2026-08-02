# Cloudflare-first architecture and provider boundaries

Status: Accepted

## Context

Anyam is intended to be customer-operable in a Cloudflare account, while
remaining Git-compatible, portable, and able to run projects that do not fit a
Cloudflare Worker. The platform therefore needs an architecture that uses
Cloudflare's managed primitives where they give a durable advantage without
making a beta product, an undocumented limit, or one provider's execution
shape a hidden load-bearing dependency.

Issue [#23](https://github.com/wms2537/anyam/issues/23) asked how Workers,
Durable Objects, D1, R2, Queues, Workflows, Artifacts, Containers/Sandbox,
Workers for Platforms, and external Runners should be assigned authoritative
state, read models, execution, consistency, scale, cost, availability,
residency, and portability responsibilities. Current platform receipts and
qualification gaps are recorded in
[`docs/research/2026-07-31-platform-and-standards-assumptions.md`](../research/2026-07-31-platform-and-standards-assumptions.md),
[`docs/research/2026-08-02-execution-and-runner-plane.md`](../research/2026-08-02-execution-and-runner-plane.md),
and the Cloudflare architecture research note for this ticket.

## Decision

### Architecture shape

The production topology is:

```text
Git / CLI / IDE / Web / MCP / Webhooks
                    │
             Workers edge/API layer
                    │
       Realm auth + policy + capability checks
                    │
       ┌────────────┼─────────────┐
       │            │             │
 Project          Source        Query/read
 coordinators     gateway       models
 Durable Objects  + Drivers     D1 (rebuildable)
       │            │             │
       └────────────┼─────────────┘
                    │
      R2 content-addressed objects and exports
                    │
          Queues + Workflows orchestration
                    │
       ┌────────────┴────────────┐
       │                         │
 Cloudflare Containers/     External pull
 Sandbox execution         Runners
       │                         │
       └────────────┬────────────┘
                    │
       Evidence / Artifacts / Releases
                    │
             Target adapters
```

Workers, Durable Objects, D1, R2, Queues, and Workflows form the Anyam
control-plane substrate. Artifacts, Containers/Sandbox, Workers for Platforms,
and external services are accessed through explicit provider or execution
adapters. The Anyam kernel owns domain state, authorization, disclosure,
provenance, policy, and protected transitions; adapters own provider mechanics.

### Bounded contexts and authoritative state

| Bounded context | Authority | Cloudflare placement | Deliberate non-authority |
|---|---|---|---|
| Realm identity, sessions, grants, epochs | Realm policy and grant state | Workers entry points + Realm Durable Objects; encrypted provider-backed identity data | Upstream IdP, Access, OAuth library, or token claims |
| Project coordination | Project Revision, Changes, Cohorts, Claims, Landing locks, idempotency, sequence | One or more Project Coordinator Durable Objects, sharded by Project and hot aggregate | D1 read model, queue order, provider event order |
| Source transfer | Git object transport, Source Space mapping, credential exchange, provider reconciliation | Workers Git Gateway + RepositoryDriver; repository provider such as Artifacts or generic Git | Provider token, public mirror, client branch, or raw Git remote |
| Project catalogue and search | Rebuildable denormalized views | D1 shards and FTS/read indexes | Authoritative Landing or Policy state |
| Immutable objects | Content-addressed Artifacts, Evidence, logs, exports, large assets | R2 with immutable digest keys and metadata references | Mutable filenames, presigned URL ownership, cache contents |
| Run dispatch and orchestration | Run state, attempt identity, idempotency, retry/cancel transitions | Durable Object authority; Queues transport; Workflows orchestration | Queue delivery order, Workflow state alone, Runner result alone |
| Execution | Bounded Action/Verifier execution | Containers/Sandbox adapter by default; external pull Runner adapter otherwise | Anyam policy, canonical write, unrestricted secret, or Target authority |
| Evidence and provenance | Validity key, disclosure, attestation normalization, stale state | Project/Run coordinator authority plus R2 payloads | Green status, cache hit, model explanation, imported signature alone |
| Release and Target | Immutable Release and guarded Promotion history | Project coordinator plus Target adapter and Workflows for long operations | Worker version, deployment provider, moving source branch |
| Mirror and integration | Permitted ref reconciliation and proposal import | Workers webhooks/Queue + project coordinator | External repository as second canonical state |
| Audit and export | Append-only attributable events and Project Export manifest | Coordinator event records + R2 export bundles; D1 query projection | Mutable activity feed or provider audit log alone |
| Hosted customer applications | Optional user application isolation and routing | Workers for Platforms adapter | Anyam control-plane state, general CI, or default customer deployment mode |

Each context has one authority. A read model may be stale or unavailable; it
must never be used to authorize a protected mutation. Large data and binary
outputs use R2 or the RepositoryDriver rather than Durable Object or D1 rows.

### Consistency and transaction model

Anyam uses a deliberately explicit consistency hierarchy:

1. **Strong per aggregate:** a Project Coordinator or Realm Coordinator
   serializes protected transitions, auth epochs, leases, idempotency, and
   expected-current-state checks.
2. **Atomic logical Project Revision:** the coordinator records the proposed
   multi-Source-Space revision as one state transition. Repository providers
   may update their own repositories independently; provider failure creates a
   durable pending/reconciliation state, never a silently partial accepted
   Project Revision.
3. **At-least-once asynchronous work:** Queue and Workflow messages carry
   Run/Change/Release/Promotion IDs, aggregate sequence, idempotency key, and
   content references. Duplicate or reordered delivery is normal.
4. **Rebuildable eventual reads:** D1, search, activity feeds, dashboards, and
   public indexes derive from authoritative events and may lag or rebuild.
5. **Immutable object reads:** R2 and provider objects are addressed by digest
   or immutable identity. Mutable keys are never used as authority or shared
   cache truth.

The coordinator uses a compare-and-swap expected state for Landing and
Promotion. No cross-service transaction is assumed. A failed provider call is
represented as an explicit pending, failed, or indeterminate state that can
be reconciled or compensated under policy.

### Coordinator topology and scale

Do not create one global Durable Object or one global D1 database as the
platform's serialization point. The default sharding keys are Realm, Project,
Source Space, Change, and Run as appropriate:

- Realm Coordinator: authorization epoch, installation configuration, and
  membership changes that require serialization.
- Project Coordinator: Project Revision, Landing, Cohorts, Release pointers,
  Target locks, and Project-scoped idempotency.
- Change/Run coordinators: high-volume revision, attempt, lease, and event
  state when a Project's activity would make one object hot.
- D1 shards: catalogue and search partitioned by Realm or installation, with
  rebuildable projections and explicit migration/versioning.

Project Landing remains serialized at its coordinator. Source transfers,
search, Runs, Evidence uploads, and public reads do not all pass through the
same object. If a Project Coordinator becomes a hot spot, split the read and
execution aggregates first; split Landing only through a new explicit
coordination protocol that preserves one compare-and-swap authority.

Cloudflare platform limits are receipts for adapter capability, not Anyam
product quotas. We will not publish Anyam node, byte, timeout, concurrency, or
cost limits until a representative workload benchmark records the measurement.
The resulting limits are tripwires: every failure names the budget, configured
limit, request, aggregate, and recovery action.

### Data residency and customer ownership

Residency is a declared Realm/Project policy, not a marketing assumption.
Before a residency commitment, the deployment must inventory every data class:

```text
source objects, refs, Views, indexes, grants, audit, logs, model context,
cache, queue payloads, Workflow state, Artifacts, Evidence, backups, mirrors,
provider telemetry, and external Runner inputs/outputs
```

The placement policy records allowed regions/jurisdictions and whether a class
may leave the customer's account. A provider capability that cannot prove the
requested placement is rejected or downgraded before data is dispatched; it
is not silently treated as compliant. Customer-operated Realms own the
Cloudflare account, R2/D1/DO data, secrets, domain, and optional Runner
execution. Anyam's hosted service is not required for source recovery.

### Availability and recovery

- Workers provides the stateless edge/API path; it may be redeployed from
  source and configuration export.
- Durable Object state is authoritative for active aggregates and is exported
  through the Project Export path; high-risk recovery never relies on a
  rebuildable read model alone.
- D1 is a query/read model and may be rebuilt from coordinator events and
  export manifests.
- R2 stores immutable objects, Evidence, exports, and recovery bundles; object
  keys are digests and same-key mutation is not used for append-only history.
- Queues and Workflows retry or wait, but every side effect has an Anyam
  idempotency key and expected state.
- Repository Drivers reconcile provider state and support full repository
  export/import. Artifacts remains conditional until its production and
  fallback gates pass.
- External Runners preserve control-plane ownership when managed execution is
  unavailable or the workload requires another operating system, architecture,
  device, GPU, private network, or larger resource shape.

Recovery restores a verified Project Export, replays/rebuilds read models, and
reconciles provider and Target state. It does not rewrite accepted history or
pretend an unverified provider snapshot is canonical.

### Cost and quota discipline

Cloudflare's documented pricing and service limits are inputs to a receipt-
backed cost model, not hard-coded entitlements in the domain model. The model
must measure at least:

- requests and CPU per control-plane operation;
- Durable Object storage/compute and hot-aggregate behavior;
- D1 rows read/written and query contention;
- R2 bytes and operation classes;
- queue messages, retries, and payload size;
- Workflow steps, waits, and state;
- container CPU, memory, disk, wall time, and egress;
- Artifact provider operations and storage;
- external Runner and model-provider cost;
- mirror, export, and recovery throughput.

Cost attribution is per Realm, Project, Source Space, Change, Run, Artifact,
Release, Target, and external integration where the provider supplies a
receipt. Admission policy may reject or require approval for expensive work,
but the error must name the measured budget and requested operation. A healthy
workload touching a tripwire triggers remeasurement rather than silent
truncation.

### Portability seams

The kernel remains portable through these interfaces:

```text
RepositoryDriver
ExecutionAdapter / Runner protocol
ArtifactStore
EvidenceStore
TargetAdapter
IdentityProvider / Realm auth adapter
MirrorAdapter
Project Export schema
```

The first-party Cloudflare adapters are the default implementation, not the
domain model. A generic Git Smart HTTP RepositoryDriver, external pull Runner,
OCI/S3-compatible object path, and documented Project Export are required
fallbacks. Cloudflare-specific bindings, object IDs, queue names, and provider
metadata remain adapter extension data and never leak into Change, Evidence,
Release, or Policy semantics.

### Workers for Platforms boundary

Workers for Platforms is an optional application plane for hosted customer
Workers and previews. It is not used for Anyam's own control plane, general
CI, or authoritative Project state. Customer applications carry a release
manifest and have no source-control write authority. If a hosted application
needs a capability, it uses a Target/deployment adapter and a brokered
credential, not a Realm Owner token.

## Mandatory proof spikes before production claims

The following spikes are launch gates, not optional optimizations:

1. **Repository provider:** qualify Artifacts access, Git clients, token
   expiry/revocation, concurrent push, event loss/duplication/order,
   full-history export/import, and a generic Git fallback.
2. **Project Revision coordination:** inject provider partial failures and
   retries across multiple Source Spaces; prove no partial state is accepted
   and reconciliation is inspectable.
3. **Coordinator load shape:** benchmark ordinary and hot Projects, Change
   bursts, Landing contention, Claim leases, and D1 rebuild. Record receipts
   before setting tripwires or sharding thresholds.
4. **Read-model rebuild:** delete or corrupt D1/search projections and rebuild
   from authoritative events/export; compare identities and disclosure.
5. **Execution qualification:** run hostile Actions and Verifiers in the
   managed lane and every Runner profile; test network, Secret Use, cleanup,
   cancellation, output signing, cache isolation, and cross-tenant access.
6. **Queue/Workflow failure injection:** duplicate, reorder, delay, retry,
   poison, timeout, restart, and cancellation at every state transition.
7. **Residency data-flow:** trace every Project Content class through normal,
   failed, cached, retried, exported, mirrored, and recovery paths; verify the
   declared Realm policy or reject the path.
8. **Cost receipt:** run representative solo, team, agent, mirror, and CI
   workloads; publish per-operation measurements and error behavior before
   pricing or quotas.
9. **Portability/recovery:** export a complete Project, restore it into a
   clean customer-operated Realm, re-import Git, rebuild D1, and verify
   Change/Evidence/Release/Audit identities and disclosure projections.
10. **Hosted application isolation:** if Workers for Platforms is enabled,
    qualify routing, binding isolation, release/rollback behavior, resource
    ownership, and proof that user code cannot reach the Anyam control plane.

## Fallback paths

| Failure or constraint | Required fallback |
|---|---|
| Artifacts unavailable, beta access, or qualification failure | Generic Git Smart HTTP RepositoryDriver plus export/import; preserve Source Space and Change semantics above provider |
| Cloudflare managed execution unavailable or workload incompatible | Enrolled external pull Runner with the same Run/Evidence/job contract |
| D1 lag, corruption, or shard migration | Serve from coordinator-safe views where allowed; rebuild D1 from events/export; never authorize from stale read data |
| Queue delivery failure | Replay/reconcile from authoritative Run/Change state; no direct state transition from a message alone |
| Workflow interruption | Resume or restart idempotent steps from coordinator state; compensate external effects with adapter guard |
| R2 object loss or corruption | Restore verified export/object replicas; reject digest mismatch; retain lineage and failure evidence |
| Cloudflare account/service outage | Customer Project Export, Git mirrors, external Runners, and documented recovery path; do not claim active-active correctness without a receipt |
| Residency not supported by selected provider path | Reject dispatch or select an approved local/customer Runner; do not silently move Project Content |
| Hot coordinator | Split read/Run/Change aggregates with a versioned protocol; Landing authority remains one explicit CAS boundary |

## Consequences

- Cloudflare gives Anyam a strong operational default for control, storage,
  orchestration, and ordinary Linux execution without becoming the product's
  semantic authority.
- The architecture must maintain multiple adapters and a complete export path
  from the first production design; this is intentional portability, not
  speculative abstraction.
- D1, Queues, Workflows, and R2 are valuable but have explicit consistency
  boundaries. The domain model must surface pending, stale, indeterminate,
  duplicate, and reconciliation states.
- Residency and cost claims require measured data-flow and workload receipts;
  they cannot be inferred from a Cloudflare account or service name.
- Workers for Platforms remains optional and does not contaminate the kernel
  with web-app-only assumptions.

## Rejected alternatives

- **One global Durable Object:** creates a predictable serialization and
  availability hot spot and conflates unrelated Realms and Projects.
- **D1 as the source of truth for Landing:** read-model queryability does not
  provide the required per-Project compare-and-swap authority or cross-space
  provider reconciliation.
- **Queues as an ordered event ledger:** documented at-least-once behavior is
  incompatible with implicit ordering and exactly-once state transitions.
- **Workflows as the audit ledger:** orchestration state is not the durable,
  disclosure-safe, append-only Project history.
- **Artifacts as an unconditional singleton:** its maturity and documented
  Git/provider boundaries require a RepositoryDriver and fallback.
- **Containers as every Runner:** their operating-system, resource, network,
  and disk shape excludes important project classes and trust zones.
- **Workers for Platforms as Anyam's core:** hosted customer application
  isolation is a product adapter, not a replacement for Realm/Project
  coordination.
- **Cloudflare account equals tenant authority:** the account is an
  infrastructure boundary; Anyam still needs resource-level capability policy,
  audit, and cross-tenant tests.

## References

- [Cloudflare architecture qualification research](../research/2026-08-02-cloudflare-architecture-qualification.md)
- [Cloudflare platform and standards assumptions](../research/2026-07-31-platform-and-standards-assumptions.md)
- [Execution and runner plane](../research/2026-08-02-execution-and-runner-plane.md)
- [System threat model](0014-system-threat-model.md)
- [Portable Project Manifest](0011-portable-project-manifest-contract.md)
- [Evidence validity and provenance](0013-evidence-validity-policy-and-provenance.md)
