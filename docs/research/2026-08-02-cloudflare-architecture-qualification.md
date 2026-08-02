# Anyam Cloudflare architecture qualification research

**Research snapshot:** 2 August 2026  
**Ticket:** [#23](https://github.com/wms2537/anyam/issues/23)  
**Status:** architecture inputs and qualification gates; not a promise that every Cloudflare feature is a production-ready dependency

This note uses current first-party Cloudflare documentation and the earlier
Anyam platform/runner research. Design conclusions are explicitly marked as
Anyam decisions; Cloudflare documentation does not define Anyam's Project,
Source Space, Change, Evidence, Release, or Target semantics.

## Executive conclusion

Cloudflare is a strong control-plane and managed-execution substrate for Anyam:

```text
Workers + Durable Objects + D1 + R2 + Queues + Workflows
       control, coordinate, index, store, dispatch, orchestrate

Containers/Sandbox
       bounded Linux execution

External pull Runners
       other OSes, architectures, devices, GPUs, private networks, and larger jobs
```

The architecture must keep three boundaries explicit:

1. Cloudflare primitives provide mechanics; the Anyam kernel owns authority,
   disclosure, provenance, and protected state transitions.
2. Cloudflare Artifacts is a preferred RepositoryDriver, not a singleton
   assumption while its availability and documented behavior remain conditional.
3. D1, Queues, Workflows, R2, and provider events are not silently promoted to
   a global ordered ledger or cross-provider transaction.

## Current documented receipts

### Workers and Durable Objects

Workers are appropriate for the edge/API, Git Gateway, OAuth/MCP resource,
webhooks, and short-lived policy entry points. Durable Objects provide
addressable stateful compute with strongly consistent attached storage and are
the right authority for serialized Project/Realm aggregates, leases,
idempotency, and authorization epochs. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects overview](https://developers.cloudflare.com/durable-objects/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

The single-threaded aggregate shape means Anyam must shard independent work by
Realm, Project, Change, and Run where appropriate. One global coordinator would
turn unrelated Projects into one hot and failure-prone serialization point.

### D1

D1 is appropriate for catalogues, membership/read models, search, release
indexes, and denormalized activity. D1 is not the source of truth for
cross-Source-Space Landing or high-contention Project coordination. Replicas,
if used, are read optimizations and cannot authorize protected mutations.
[D1 overview](https://developers.cloudflare.com/d1/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

### R2

R2 is appropriate for content-addressed Artifacts, Evidence payloads, logs,
exports, Git bundles, and large assets. The architecture must use immutable
digest keys rather than a mutable hot key. Presigned URLs are bearer
capabilities and may be reused until expiry; they are not one-time authority.
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)

### Queues

Cloudflare Queues provides at-least-once delivery, so duplicate and reordered
messages are expected. Anyam messages must carry immutable aggregate/run IDs,
sequence or version information, idempotency keys, and object references.
Queue delivery alone cannot land source, finalize Evidence, or promote a
Release. [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/), [Queue limits](https://developers.cloudflare.com/queues/platform/limits/)

### Workflows

Workflows is appropriate for durable orchestration, retries, sleeps, and human
approval waits. It is not the immutable audit ledger, and large binary outputs
belong in R2. Any side effect still needs coordinator state, idempotency, and
expected-current-state guards. [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workflows GA](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/)

### Artifacts

Artifacts is a Git-compatible programmable repository service with repository
creation/import/fork, scoped credentials, Workers access, and repository
events. The current Anyam baseline records it as closed beta and documents
important gaps: HTTPS Smart HTTP rather than documented SSH, repository-level
read/write tokens rather than ref-level protection, no documented
cross-repository transaction, and no documented event exactly-once/order
contract. [Artifacts overview](https://developers.cloudflare.com/artifacts/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)

Anyam must put Artifacts behind `RepositoryDriver`, grant agents write access
only to isolated Workspace Repositories, keep canonical writes in Landing, and
maintain generic Git import/export plus a tested secondary provider.

### Containers and Sandbox

Cloudflare Containers/Sandbox is suitable for ordinary bounded Linux/AMD64
builds, tests, static analysis, agent sessions, documentation, and previews.
Container filesystems are ephemeral. Sandbox outbound policy and credential
brokerage are useful, but are primarily HTTP/HTTPS controls; they are not a
universal arbitrary-protocol egress or hostile-workload proof. [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/), [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/), [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)

External pull Runners remain required for macOS/iOS, Windows, ARM, GPU,
hardware-in-the-loop, private networks, larger resource shapes, and
customer-controlled execution. The portable Runner contract is recorded in
ADR-0012 and must be the same normalized Run/Evidence boundary for both lanes.

### Workers for Platforms

Workers for Platforms is an optional hosted-application adapter. It can run
customer Workers in Anyam's account, but it is not the Anyam control plane,
general CI, or authoritative Project state. User applications receive release
manifests and brokered capabilities, never Realm administration or canonical
source-write authority. [Workers for Platforms overview](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/), [architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/), [limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)

## Consistency and failure implications

| Primitive | Anyam meaning | Failure behavior |
|---|---|---|
| Durable Object coordinator | Per-aggregate authority and CAS | Serialize or return pending/indeterminate; never fall back to stale D1 for protected writes |
| D1 | Rebuildable query projection | Serve stale only where policy permits; rebuild from authoritative events/export |
| R2 | Immutable content-addressed payload | Reject digest mismatch; never let mutable key state become authority |
| Queue | At-least-once transport | Deduplicate, tolerate reorder, dead-letter, replay, reconcile |
| Workflow | Durable orchestration | Resume/retry idempotent steps; ledger and compensation remain Anyam-owned |
| Artifacts/provider event | External source/provider signal | Treat as hint; reconcile provider state against Anyam mapping and digest |
| Container/Sandbox | Bounded execution adapter | Fail or downgrade visibly when capability, network, cleanup, or resource claim is not met |
| External Runner | Customer/third-party execution boundary | Short-lived job grant, exact input, scoped outputs, signed result, quarantine on unknown cleanup |

## Qualification gates before production claims

1. Repository provider compatibility, token lifecycle, concurrent push,
   provider event loss/duplication/order, full-history export/import, and a
   generic Git fallback.
2. Multi-Source-Space Project Revision failure injection proving partial
   provider updates remain pending/reconcilable rather than accepted.
3. Coordinator load and hot-aggregate benchmark for solo, team, agent, and
   mirror workloads before setting Anyam tripwires.
4. D1 projection deletion/corruption and full rebuild comparison.
5. R2 digest, presigned-capability, corruption, retention, export, and restore
   qualification.
6. Queue and Workflow duplicate, reorder, retry, timeout, restart, poison,
   and cancellation injection across every state machine.
7. Managed execution hostile workload, network, Secret Use, cleanup,
   cancellation, output signing, and cache-isolation tests for each profile.
8. Residency data-flow trace for source, metadata, logs, model context,
   retries, queues, caches, exports, mirrors, backups, and external Runners.
9. Cost receipt across representative operation classes before pricing,
   quotas, or plan limits are published.
10. Complete Project Export/restore into a clean Customer-operated Realm with
    Git, Change, Evidence, Release, audit, and disclosure identity checks.
11. Workers for Platforms isolation and release/rollback qualification before
    offering hosted customer applications.

## Portability contract

The Anyam kernel depends on these versioned interfaces rather than Cloudflare
object IDs or service-specific semantics:

```text
RepositoryDriver
ExecutionAdapter / Runner protocol
ArtifactStore and EvidenceStore
TargetAdapter
IdentityProvider / Realm adapter
MirrorAdapter
Project Export schema
```

The Cloudflare implementation is the first-party default. A customer can
replace repository storage, execution, identity, or Target mechanics without
changing Project/Change/Evidence/Release semantics or losing a documented
export path.

## Sources

- [Anyam platform and standards assumptions](2026-07-31-platform-and-standards-assumptions.md)
- [Anyam execution and runner plane](2026-08-02-execution-and-runner-plane.md)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [D1](https://developers.cloudflare.com/d1/)
- [R2](https://developers.cloudflare.com/r2/)
- [Queues](https://developers.cloudflare.com/queues/)
- [Workflows](https://developers.cloudflare.com/workflows/)
- [Artifacts](https://developers.cloudflare.com/artifacts/)
- [Containers](https://developers.cloudflare.com/containers/)
- [Sandbox](https://developers.cloudflare.com/sandbox/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
