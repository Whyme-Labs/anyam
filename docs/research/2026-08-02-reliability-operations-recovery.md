# Anyam reliability, operations, and recovery

**Research snapshot:** 2 August 2026  
**Ticket:** [#30 Plan reliability, operations, and recovery](https://github.com/wms2537/anyam/issues/30)  
**Status:** Decision-grade research. Cloudflare and standards facts below are receipts from primary documentation available at the snapshot date. Anyam SLO targets, retention periods, quotas, and RPO/RTO values are not chosen here: they require workload measurements, an explicit product decision, and a tested recovery receipt.

## Executive decision

Reliability must be designed as three related but distinct planes:

```text
Control plane
  Project, Source Space, Change, policy, identity, audit, read models

Data plane
  Git source, Project Exports, Evidence, Artifacts, Releases

Execution and delivery plane
  Runs, runners, queues, workflows, previews, Targets, Promotions
```

Anyam owns the authoritative state machine, append-only domain facts, idempotency, reconciliation, capability policy, provenance, and complete export. Cloudflare Workers, Durable Objects, D1, R2, Queues, Workflows, Artifacts, and Containers/Sandbox are provider primitives and adapters; none is the complete Anyam reliability contract.

The central reliability rule is:

> A provider acknowledgement is not an Anyam state transition until the authoritative ledger records and validates it.

This matters because Cloudflare documents at-least-once Queue delivery, destructive database restores, resource-preserving Worker rollbacks, finite observability retention, provider API rate limits, and beta product status. Anyam must turn those facts into visible state, retry-safe commands, degraded modes, recovery checkpoints, and tested runbooks rather than hiding them behind a green status badge.

## Primary-source receipts and current status

| Surface | Current documented status at snapshot | Reliability consequence |
|---|---|---|
| [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) (last updated 5 May 2026) | Closed beta; Git-compatible repositories, imports, forks, scoped tokens, and event-driven automation are documented | Keep Artifacts behind `RepositoryDriver`; qualify access, export, outage behavior, and fallback before treating it as load-bearing |
| [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/) (last updated 4 May 2026) | Documents per-repository storage, account storage, and operation-rate limits | Provider limits are receipts for adapter tripwires, not Anyam product quotas; surface failures with the provider limit and requested amount |
| [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) (last updated 21 April 2026) | Always-on point-in-time recovery for production-backend databases; the page documents a thirty-day Workers Paid and seven-day Workers Free window | Restore is destructive and in-place; export older checkpoints to R2 and rehearse restore plus reconciliation |
| [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (last updated 21 April 2026) | Documents per-database storage, Time Travel windows, restore-operation limits, and a single-threaded per-database execution model | D1 is a read model or bounded aggregate store, not a universal high-throughput event ledger; measure query contention and overload behavior |
| [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) (last updated 27 May 2026) | SQLite-backed Durable Objects expose point-in-time recovery for embedded SQL and KV data; the page documents a thirty-day history | Use SQLite-backed DOs for serialized aggregate authority, but export ledger/checkpoint data independently and test restore in a non-production namespace |
| [Durable Object class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) (last updated 15 July 2026) | `exports` manages create, delete, rename, and transfer; gradual deployment is not supported for lifecycle changes and rollback cannot cross a lifecycle change | Schema/class changes need forward/backward-compatible rollout plans and a separate recovery procedure |
| [R2 durability](https://developers.cloudflare.com/r2/reference/durability/) (last updated 21 April 2026) | R2 is designed for eleven-nines annual durability and documents synchronous persistence; the same page states durability is not availability and cites a 99.9% availability SLA | Replication is not backup, availability, or deletion protection; use content-addressed objects, restricted writers, and bucket locks where retention requires it |
| [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) (last updated 30 April 2026) | Reads, writes, deletes, listings, and metadata are documented as strongly consistent; IAM permission changes are eventually consistent | Use conditional writes/digests and account for permission propagation during credential or incident recovery |
| [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) (last updated 30 April 2026) | Rules can prevent deletion/overwrite for a duration, date, or indefinitely; up to 1,000 rules are documented | Evidence/audit retention can use a locked prefix; lock rules are not a substitute for an independent export |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (last updated 29 July 2026) | Dashboard retention is plan-dependent and documented as three days on Free and seven days on Paid; head-based sampling and per-log truncation are documented | Workers Logs cannot be the authoritative audit trail; export structured telemetry to durable storage |
| [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) (last updated 29 July 2026) | Workers Trace Event Logs can be sent to supported destinations including R2; filtering and sampling are supported | Logpush is an observability export, not a domain-event ledger; verify delivery and retention at the destination |
| [Workers tracing](https://developers.cloudflare.com/workers/observability/traces/) (last updated 16 June 2026) | Automatic binding/fetch/handler tracing is documented; sampling is supported and trace retention follows log quotas | Keep unsampled security/audit facts in the Anyam ledger; sampled traces are diagnostic evidence |
| [Workers gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) (last updated 3 July 2026) | Traffic can be split between versions; version skew can occur within and across Workers; only the last 100 uploaded versions can be used for a gradual deployment | Release compatibility and rollback metadata must be explicit; do not assume a split rollout is a transaction across services |
| [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) (last updated 15 July 2026) | Rollback creates a new deployment, does not change connected resources, is limited to the 100 most recently published versions, and may be rejected after resource or Durable Object lifecycle changes | Anyam rollback is a new Promotion with data/schema compatibility checks, not “restore source and bindings” |
| [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) (last updated 5 July 2026) | Documents Worker CPU, memory, request, subrequest, Queue consumer, and Durable Object alarm limits; Queue consumers and alarms have a fifteen-minute wall-time limit | Anyam actions must be resumable and explicit about provider limits; large/long tasks belong in Workflows or pull runners |
| [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) (last updated 20 April 2026) | Documents a global 1,200 requests per five minutes per user/account token and HTTP 429 responses with `retry-after` | Centralize backoff, budgets, and provider request coalescing; never retry blindly or make rate exhaustion look like data loss |
| [Cloudflare Status](https://developers.cloudflare.com/support/cloudflare-status/) (last updated 23 April 2026) | Cloudflare provides status page, API, incident notifications, webhooks, and PagerDuty integrations | Anyam support tooling should ingest provider status but retain its own impact timeline and customer-visible incident state |
| [Google SRE service-level objectives](https://sre.google/sre-book/service-level-objectives/) | Defines SLI/SLO/SLA distinctions, user-facing indicators, error budgets, percentiles, and the need to avoid unmeasured targets | Start with a small set of user-relevant SLIs; publish targets only after a receipt; use budget burn to govern release risk |
| [NIST SP 800-61r3](https://www.nist.gov/news-events/news/2025/04/nist-revises-sp-800-61-recommendations-and-considerations-for-cybersecurity-risk-management) (finalized 3 April 2025) | Current NIST incident-response guidance supersedes SP 800-61r2 and integrates response with CSF 2.0 risk management | Anyam incident handling should cover preparation, detection/analysis, containment, eradication, recovery, communication, and improvement |
| [NIST SP 800-34 Rev. 1](https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final) (final May 2010) | Contingency-planning guidance covers business impact analysis, recovery strategies, testing/training, and maintenance | Hosting modes need explicit recovery priorities, roles, RPO/RTO decisions, tests, and maintained runbooks; the document is old guidance, not an Anyam target |

## SLO and error-budget framing

Anyam should not publish a single “platform uptime” number. A Project owner experiences different contracts for browsing public source, proposing a Change, running a verifier, landing a revision, building a Release, and promoting a Target. A private alpha can measure these separately without promising a numeric SLO. Public beta can publish targets only after a baseline and failure-injection receipt exist.

Google’s SRE guidance recommends defining indicators from user-visible behavior, using a small number of representative indicators, preferring percentiles to means for long-tailed latency, and using an error budget to decide when release risk must be reduced. It explicitly warns against choosing a target merely from current performance. Anyam should follow that direction, but choose targets per hosting mode and customer contract.

### Candidate indicators

Every SLI needs a written definition, source, population, aggregation window, exclusions, and owner. The following are candidates, not targets:

| Surface | Candidate SLI | Measurement receipt |
|---|---|---|
| Public Project View | Successful safe reads from an external probe, plus latency percentiles | Black-box probes from independent locations; include authorization and projection lookup, not only Worker invocation success |
| Authenticated command API | Commands that return the correct idempotent result or a documented policy outcome | Correlate command envelope, aggregate version, policy decision, and response; separate client errors from service faults |
| Source transfer | Clone/fetch/push completion for declared fixture sizes and providers | Git client probes through the same Gateway and credential helper used by users |
| Change integrity | Landed Project Revision equals the approved Change Revision and expected base | Compare-and-swap outcome plus post-landing ref and digest reconciliation |
| Run lifecycle | Runs that reach a terminal, evidence-bearing state without duplicate side effects | Run ledger, Attempt IDs, Runner result digests, and watchdog reconciliation |
| Evidence availability | Required Evidence can be retrieved and verifies against its immutable input key | R2 object existence, digest, signature/attestation, disclosure projection, and freshness state |
| Release/Promotion correctness | Target points to the requested immutable Release and health verification agrees | Target read-back, Release manifest digest, health check, and Promotion event |
| Recovery | Successful restore/export verification from a clean checkpoint | Independent restore drill with checksums, event replay, projection rebuild, and application-level invariants |
| Audit completeness | Sensitive command has a durable, queryable event with principal, actor, client, task, resource, policy decision, and result | Periodic reconciliation between command receipts, provider logs, and Anyam ledger; no sampled telemetry accepted as proof |
| Mirror health | Remote projection is at the expected landed ref and divergence is explicit | Outbound/inbound mirror cursors, remote ref digest, provider response, and loop-prevention marker |

The SLO unit must be the user-observable operation, not a raw Cloudflare metric. For example, a successful Worker invocation that returns a stale read model is not a successful Project View read. A successful Queue acknowledgement that loses the Run result is not a successful Run.

### Error-budget policy

Error budgets are per capability and per hosting mode:

```text
measure SLI
    ↓
compare with the published SLO
    ↓
calculate budget burn and confidence
    ↓
continue, slow, or freeze risky changes
    ↓
restore budget through reliability work
```

The policy should distinguish:

- **Serving budget:** public read and authenticated command availability.
- **Mutation budget:** Change, Landing, and Promotion correctness.
- **Execution budget:** Run completion and evidence freshness.
- **Recovery budget:** successful export/restore verification.
- **Dependency budget:** provider and mirror-induced failures, shown separately so Anyam does not hide dependency risk.

When a mutation or recovery budget is exhausted, freeze non-essential Landing, policy, schema, and provider changes. Permit only incident mitigation, security response, and changes that directly restore the exhausted budget. This is a policy recommendation derived from the SRE error-budget model, not a Cloudflare guarantee.

Do not choose numeric thresholds in code before the receipt exists. The first release should store observed distributions and measurement metadata. A later policy Change can activate a target once the owning team signs the measurement receipt.

## Observability and audit architecture

### Authority versus telemetry

The authoritative record is an append-only Anyam domain ledger plus content-addressed Evidence/Artifact objects. Workers Logs, traces, Analytics, Queue messages, Workflow state, provider event streams, and external observability systems are telemetry or transport. They may be delayed, sampled, duplicated, truncated, or unavailable.

The ledger must record at least:

```text
event_id, aggregate_id, aggregate_version, event_type, schema_version
realm, organisation, project, source_space
principal, actor, client, session, task, capability_grant
command_id, idempotency_key, expected_version
change, change_revision, project_revision, run, attempt
artifact, release, target, promotion, mirror
policy_decision, policy_version, auth_epoch
provider, provider_operation_id, provider_request_id
source_digest, input_digest, output_digest
occurred_at, recorded_at, result, disclosure_class
```

The event itself must not contain raw access tokens, secret values, private source that the audience cannot read, or unbounded logs. Large payloads are immutable R2 objects referenced by digest and disclosure policy.

### Metrics, logs, and traces

- Emit one correlation context across HTTP, MCP, CLI, Git Gateway, Queue dispatch, Workflow instance, Runner Job, Evidence, and Promotion.
- Keep request/command/event IDs stable through retries; create new Attempt IDs for new execution attempts.
- Treat Workers Logs and traces as short-lived diagnostics. Cloudflare documents head-based sampling, three-day Free and seven-day Paid retention for logs/traces, and truncation/volume limits. Export selected events through [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) to R2 or a customer-selected OpenTelemetry destination, then verify destination delivery.
- Never sample the security/audit path. A sampled trace can explain a failure; it cannot prove that a privileged operation occurred or did not occur.
- Provide black-box synthetic probes for public read, login/session, Project View, Change command, source transfer, Evidence retrieval, and Target health.
- Record provider status and request headers such as `retry-after`, but do not treat provider status as the only detector; Anyam’s impact is measured by its own SLIs.

### Audit retention

Retention is a Project/Realm policy, not a hidden vendor default. Anyam should support retention classes such as operational telemetry, domain events, Evidence, release provenance, security audit, and legal hold. The classes must be explicit in every export and policy explanation.

For hosted and customer-operated modes, the minimum safe design is:

1. Append-only event facts in the authoritative store.
2. Immutable, digest-addressed export bundles in R2.
3. A restricted writer path and separate reader path.
4. Bucket-lock rules for records that must not be deleted or overwritten during their retention period.
5. A periodic export verification that reads the bundle from an independent process and recomputes digests.
6. A redaction policy that removes credentials and disallowed private projections before export.

R2’s documented durability does not prevent an authorised or compromised actor from deleting data. Bucket locks and capability-scoped tokens reduce that risk; they do not remove the need for an independent export or restore test.

## Backup, restore, RPO, and RTO

### Data classes and recovery source

| Data class | Authoritative source | Recovery strategy | Do not assume |
|---|---|---|---|
| Canonical Source Space Git | Repository Driver plus signed Project Export | Export Git refs/bundles/LFS objects and Project metadata; verify refs and object digests on restore | Artifacts beta replication is a portable backup or an exit guarantee |
| Project/Change/policy ledger | SQLite-backed Durable Object aggregate/event store | Use provider PITR as a bounded convenience; continuously or periodically export signed ledger checkpoints to R2; replay into a clean namespace during drills | Workflow state or D1 projection is authoritative |
| D1 catalogue/read model | Rebuildable projection | Rebuild from ledger/export; use D1 Time Travel for operator error and export to R2 for longer retention | D1 Time Travel alone satisfies a customer’s retention or cross-resource RPO |
| Evidence and Artifacts | Content-addressed R2 objects plus manifests | Store digest, size, media type, provenance, disclosure class; use bucket locks where required; verify independent export | R2 durability prevents deletion, corruption of metadata, or availability incidents |
| Queue/Workflow execution state | Anyam Run ledger and checkpoint | Re-enqueue/restart safely from Run/Attempt state; reject duplicate or stale results | Queue messages or Workflow instances are a durable business ledger |
| Credentials and grants | Realm policy/identity store | Revoke by grant/session/auth epoch; rotate secrets and keys; never export plaintext credentials | Backup restoration should resurrect active credentials |
| Mirror cursors and remote refs | Anyam mirror state plus remote inspection | Reconcile remote refs and recreate projections from canonical state | A remote mirror is a second authority |

### RPO/RTO method

RPO is the maximum acceptable loss of acknowledged project state; RTO is the maximum acceptable time to return a named capability to service. They must be selected per data class, impact level, and hosting mode after a business-impact analysis and restore exercise. No provider retention window is an Anyam RPO, and no provider operation duration is an Anyam RTO.

The recovery record must include:

```text
incident/recovery ID
last known authoritative ledger version
last verified export and its digest
provider bookmarks/version IDs
data classes affected
declared RPO/RTO for the affected capability
actual detection, containment, restore, verification, and resume times
loss or duplication observed
operator and approving principal
follow-up Change IDs
```

### Restore runbook shape

```text
detect and classify
    ↓
freeze affected mutations, Landing, and Promotion
    ↓
capture current provider bookmarks and export a pre-restore checkpoint
    ↓
restore into an isolated recovery namespace where possible
    ↓
verify digests, event sequence, Source Space refs, policies, and disclosure boundaries
    ↓
rebuild D1/read projections and reconcile provider refs
    ↓
run synthetic reads, idempotency checks, and release/Target health checks
    ↓
approve a Recovery Checkpoint
    ↓
resume low-risk reads, then mutations, then high-risk Promotion
    ↓
publish impact and post-incident record
```

D1 documents that a Time Travel restore overwrites the database in place, cancels in-flight queries/transactions, and returns a bookmark that can undo the restore. Durable Object PITR is documented for SQLite-backed objects, but local development does not have the durable change log required for PITR. Therefore, restore drills should use isolated production-like namespaces and must preserve the pre-restore bookmark/checkpoint before attempting the operation.

## Degraded modes

Degraded behavior is a product contract. It must be visible in CLI, web, MCP, and API responses and must never silently widen authority or claim success.

| Failure | Safe degraded behavior | Forbidden behavior | Recovery signal |
|---|---|---|---|
| Realm authentication/authorization dependency unavailable | Public safe projections remain readable; existing low-risk read sessions may continue only under explicit session policy | New high-risk grants, Source Space visibility changes, Landing, or Promotion | Auth dependency health and policy epoch reconciliation |
| Project coordinator/DO unavailable | Serve last verified read model; show mutation unavailable; preserve local workspace | Accepting a command without authoritative version or replay-safe receipt | Coordinator health, version continuity, export checkpoint |
| D1 unavailable or overloaded | Use last verified read model/cache; defer projection refresh; keep ledger authority separate | Treating stale query results as current policy or Promotion authority | Read-model catch-up and ledger-to-projection checksum |
| R2 unavailable | Existing source/metadata reads where safe; pause Evidence/Artifact writes and Promotions that require them | Marking Evidence complete without durable object/digest | Object write/read-back and digest verification |
| Queue unavailable or backlog grows | Keep Run in `dispatch_pending`; allow a measured direct/manual execution path only if its capability is equivalent | Dropping a Run, acknowledging before durable state, or claiming completion | Dispatch reconciliation and backlog/lease sweep |
| Workflow instance stalls or provider state is lost | Recover from Run ledger/checkpoint with a new idempotent Attempt | Treating `complete`/`errored` Workflow state as final without ledger reconciliation | Watchdog, attempt terminal event, duplicate-result check |
| Artifacts/Repository Driver unavailable | Public mirrored projection may remain readable; local work can continue; block canonical source mutation and Landing | Writing to an unverified fallback and silently switching authority | Driver health, ref/digest comparison, explicit migration or failback state |
| Cloudflare API rate limited/outage | Keep already-deployed runtime serving; queue provisioning/deployment requests with visible retry state | Tight retry loops, duplicate resource creation, or presenting control-plane failure as source loss | `retry-after`, provider status, request id, idempotency reconciliation |
| External runner unavailable | Route to a compatible Cloudflare runner or leave Run pending; show capability mismatch | Running on an unapproved runner or returning unverifiable Evidence | Runner registry and signed result verification |
| Mirror provider unavailable | Canonical Anyam Project continues; mark remote lagging and retry idempotently | Allowing mirror state to overwrite canonical state | Remote ref inspection and mirror cursor |
| Credential compromise suspected | Revoke grant/session/auth epoch; quarantine workspaces/runners; freeze publication and Promotion as needed; preserve forensics | Continuing privileged operations while “waiting to see” | Revocation propagation, token rejection, secret rotation, audit review |

The UI and machine response must name the affected dependency, operation, current state, retry/recovery action, and any blocked capability. A blank screen, generic `500`, or silent fallback is a landmine.

## Failure-specific runbooks

### Queue duplication and redelivery

Cloudflare documents Queue delivery as at-least-once. Anyam therefore:

1. Writes the Run and dispatch intent to the authoritative ledger before publishing the pointer message.
2. Includes a unique dispatch identifier, Run ID, Attempt ID, input digest, action digest, and expiration in the message.
3. Uses a deduplication record at the consumer and at every external side-effect boundary.
4. Acknowledges the message only after the Run state is durably accepted; a long job does not hold a queue lease for its whole lifetime.
5. Treats a redelivery as a replay request, not a second Run.
6. Uses dead-letter handling as an operational queue, never as the source of truth.
7. Sweeps Run records whose lease/heartbeat expired and creates a new Attempt only after policy evaluation.

The error response must distinguish `duplicate_dispatch`, `stale_attempt`, `lease_expired`, and `run_already_terminal`, including the authoritative Run/Attempt state.

### Workflow stalls and retries

Workflows provides durable orchestration, retries, sleeps, external-event waits, and lifecycle controls. Anyam must keep the business state machine outside the Workflow instance:

```text
Run ledger: authoritative
Workflow: orchestration attempt
Queue: delivery pointer
Runner: execution attempt
Evidence: immutable result
```

A watchdog compares expected step/checkpoint progress with provider state. When a Workflow stalls, Anyam marks the attempt `recovery_pending`, revokes the old capability, and starts a new idempotent attempt from a known checkpoint. Late results are accepted only when they match the current Run/Attempt policy. Compensation handlers can report external side effects but cannot pretend to undo an irreversible side effect.

### Partial cross-space Landing

The Source Space model spans independent repositories and views. Unless a Repository Driver supplies a proven transaction across all affected spaces, Anyam must not call provider-level mutations atomic. Use a coordinated Landing state machine:

```text
planned
  → checks_passed
  → apply_requested
  → applied(space A), applied(space B), ...
  → committed

any failed or unknown apply
  → partial_landing
  → mutation freeze for the affected Project Revision
  → inspect/reconcile actual refs
  → retry idempotently or create a compensating Change
  → committed or abandoned with explicit recovery record
```

The public projection must not be published as if the private space landed until all required acknowledgements and ref/digest checks agree. A partial Landing is visible to maintainers and agents, blocks dependent Promotion, and never gets hidden by a synthetic merge commit. A compensation is a new auditable Change; destructive force-rewrite is not the default recovery action.

### Credential compromise

The incident path is:

```text
detect suspicion
  → freeze high-risk operations
  → revoke grant/session/token family and increment auth epoch
  → quarantine affected Workspace, Runner, Mirror, and App installation
  → reject MCP/Git/provider token exchange
  → rotate broker-backed secrets and signing keys as required
  → inspect audit, source, Evidence, and Target events
  → determine disclosure and side effects
  → restore/reconcile if integrity is uncertain
  → re-enable through a reviewed Change
```

Realm revocation must be online for high-risk operations. Existing short-lived tokens should expire quickly, but revocation cannot rely only on expiry. A compromised token may not be reused to mint a broader provider token; MCP tokens must not be passed through to Git, Cloudflare APIs, or deployment providers.

### Backend/provider migration

Backend migration is a controlled operation, not a configuration toggle:

1. Select the Project/Realm and freeze only the affected authority boundary.
2. Produce a signed Project Export and provider-specific checkpoint.
3. Import into the candidate backend using the versioned RepositoryDriver/StorageDriver contract.
4. Compare source refs, object/manifests, event sequence, aggregate versions, policy versions, Evidence digests, and disclosure projections.
5. Run shadow reads and recovery drills against the candidate; do not silently dual-write business authority.
6. Record a migration Change and explicit cutover Promotion/Checkpoint.
7. Switch the authoritative pointer after compare-and-swap validation.
8. Keep the previous backend read-only for the qualified rollback window, subject to retention and cost policy.
9. Reconcile late events and mirror cursors; then decommission only after an export and owner approval.

Cloudflare’s current provider facts reinforce this discipline: Artifacts is closed beta; D1 production and legacy storage subsystems differ; Durable Object storage type is immutable once a namespace exists; `exports` lifecycle changes cannot be rolled back across; and Worker rollback does not restore connected resources. Anyam must retain its provider abstraction and export format as load-bearing boundaries.

## Incident response and support tooling

NIST finalized SP 800-61r3 on 3 April 2025 and superseded SP 800-61r2. Anyam should adapt its lifecycle to the project’s impact class:

```text
prepare
  → detect and analyze
  → contain
  → eradicate or remediate
  → recover and verify
  → communicate
  → learn and change the system
```

Each incident record needs:

- Incident ID, severity/impact class, affected Realm/Project/Source Space/Target.
- Incident Commander and role-based responders (operations, security, product, communications, customer liaison).
- UTC timeline with detection source, provider status, commands, policy decisions, state transitions, and evidence links.
- Customer impact, data integrity/disclosure assessment, current degraded mode, and next update condition.
- Containment and recovery actions with expected-current-state guards.
- Provider case/status references and Anyam request IDs.
- Post-incident root cause, contributing conditions, missing tripwires, and follow-up Changes.

The CLI should provide safe diagnostics without source or secret leakage:

```text
anyam doctor
anyam diagnostics collect --redact
anyam status --project <id>
anyam recovery checkpoint create
anyam recovery verify <export>
anyam mirrors reconcile --dry-run
anyam runs reconcile --dry-run
```

Diagnostics should include versions, provider health, IDs, state hashes, policy/auth epochs, queue/workflow status, and recent structured errors; it must omit access tokens, secret values, private source, and unrestricted logs. Cloudflare’s support guidance itself asks for UTC timestamps, reproduction details, actual-versus-expected behavior, frequency, screenshots, and example URLs; Anyam should collect equivalent structured fields before opening a provider case.

### Alert classes

Follow the SRE distinction between pages, tickets, and logs:

- **Page:** a human must act now—integrity risk, credential compromise, high-risk Promotion failure, irreversible partial Landing, or recovery budget burn.
- **Ticket:** action is needed within the operating window—mirror lag, repeated runner failures, projection lag, approaching provider quota, or stale export verification.
- **Log:** diagnostic detail retained for investigation but requiring no immediate human action.

Avoid alerting on every provider retry. Page on user-impacting or integrity-impacting symptoms and link the underlying receipts.

## Change management

All reliability-sensitive changes are Anyam Changes with reviewable Evidence:

- schema and Durable Object lifecycle changes;
- Project ledger/event schema changes;
- policy/auth/revocation changes;
- RepositoryDriver/StorageDriver/provider upgrades;
- Queue/Workflow state-machine changes;
- backup/export/restore format changes;
- retention, disclosure, or audit changes;
- Target adapter and deployment changes;
- observability sampling and redaction changes.

The release flow is:

```text
Change declares affected surfaces and recovery plan
  → compatible migration and rollback/compensation evidence
  → isolated restore/chaos qualification
  → progressive deploy where provider semantics allow
  → observe user-facing SLIs and budget burn
  → promote or stop with explicit Policy Explanation
```

Do not rely on a Worker version rollback as the universal undo operation. The release manifest must list source revision, policy version, schema/version state, resource bindings, Evidence digests, and rollback/forward-recovery procedure. Gradual deployment must account for version skew across Worker-to-Worker calls; Durable Object lifecycle changes require their own rollout shape.

## Recovery qualification gates by release stage

### Private alpha

- Measure black-box baselines for the candidate SLIs; do not publish arbitrary numeric SLOs.
- Prove idempotent command replay, Queue redelivery, Workflow restart, and late-result rejection.
- Run a clean export/restore of the authoritative ledger, D1 projection, R2 Evidence, and Source Space refs.
- Exercise partial cross-space Landing and ensure the system blocks unsafe Promotion.
- Exercise provider rate-limit and dependency outage degraded modes.
- Exercise credential revocation/quarantine and verify no high-risk operation succeeds afterward.
- Verify diagnostics are useful and secret-safe.

### Public beta

- Publish per-surface SLOs and error-budget policy with measurement receipts.
- Verify complete Project Export/import and an independent backend/RepositoryDriver path.
- Verify two-way mirror divergence, loop prevention, and recovery.
- Verify external pull-runner failure/revocation and Evidence validation.
- Verify audit/event reconciliation and retention policy implementation.
- Verify recovery drills against customer-operated Cloudflare installation and hosted mode separately.

### Enterprise readiness

- Accept customer-defined RPO/RTO and retention/legal-hold requirements.
- Qualify residency and customer-managed key behavior where offered.
- Offer dedicated isolation and support escalation with tested provider incident communication.
- Produce restore attestations, audit exports, and operational ownership/runbooks for each Realm.

## Qualification matrix

| Qualification | Required invariant | Receipt |
|---|---|---|
| Coordinator loss | No mutation succeeds without authoritative version; recovery resumes from checkpoint | Fault-injection run with command replay and event reconciliation |
| D1 loss/overload | Ledger remains authoritative; stale read model is labeled and rebuildable | Provider error simulation plus projection rebuild |
| R2 loss | No Evidence/Artifact is marked complete without durable digest | Object-store outage test and retry/reconciliation |
| Queue duplication | One dispatch does not create duplicate side effects | Duplicate message test with same dispatch/Attempt IDs |
| Queue backlog/lease expiry | Run remains visible and can be retried without loss | Expired lease and dead-letter replay test |
| Workflow stall/restart | New Attempt is safe; late result is rejected or recorded as stale | Stalled instance and late callback test |
| Partial cross-space Landing | Incomplete apply is visible, frozen, and recoverable | One-space provider failure during Landing |
| Artifacts/provider outage | Canonical authority is not silently moved; fallback is explicit | Driver outage and read-only/mirror behavior test |
| Cloudflare API 429 | Backoff respects `retry-after`; idempotency avoids duplicate resources | Rate-limit simulation |
| Worker deployment failure | Previous Release remains identified; no false “production” state | Failed upload/deploy/health-check test |
| Database restore | Pre-restore checkpoint preserved; replay/projection/data invariants pass | Isolated D1/DO restore drill |
| R2 deletion attempt | Locked records cannot be overwritten/deleted in retention period | Bucket-lock test and audit verification |
| Credential compromise | Grant/session/epoch revocation blocks high-risk use and quarantines execution | Token replay, exchange, runner, and Git/MCP rejection test |
| Mirror divergence | Anyam remains canonical; divergence is explicit and repairable | Force-push/delete/conflicting inbound change test |
| Backend migration | Export/import digests and event/projection semantics match before cutover | Candidate driver shadow-read and restore test |

## Landmines and tripwires

### Landmines

- Calling R2 replication or Artifacts durability a backup, export, or recovery guarantee.
- Treating Workers Logs, traces, Queues, or Workflows as the audit or business ledger.
- Choosing SLO, retention, quota, or RPO/RTO numbers without a measurement receipt.
- Assuming Worker rollback restores D1, R2, Queue, KV, Durable Object, or external Target state.
- Hiding partial cross-space Landing behind a synthetic merge result.
- Retrying provider mutations without idempotency and expected-state guards.
- Letting a stale projection authorize a high-risk operation.
- Reusing a compromised token because its nominal expiry has not elapsed.
- Silently switching RepositoryDriver or StorageDriver during a provider outage.
- Retaining raw secrets or private source in diagnostics, traces, Evidence, or support tickets.

### Tripwires

Every budget/limit error must name:

```text
budget or provider limit
configured value and source receipt
requested value
affected operation/resource
safe next action
```

Examples:

```text
Cloudflare API rate limit reached: provider allows 1,200 requests per five-minute window; request attempted after quota exhaustion. Retry after provider-provided `retry-after`; no resource mutation was acknowledged.

Queue dispatch is stale: Attempt A-123 expired before completion. The Run remains `recovery_pending`; no new side effect has been assumed. Reconcile or start a new Attempt.

Project Revision is partially landed: Source Space `private-core` ref differs from the approved digest. Promotion is blocked; inspect the Landing receipt before retrying.
```

The exact wording is illustrative. The invariant is that failure is actionable for a developer and coding agent, never a blank window or silent fallback.

## Recommendations that are not yet qualified

The following remain explicit qualification gates rather than facts:

- End-to-end SLO target values and error-budget windows.
- Per-tenant and per-Project quotas, concurrency, payload sizes, and retention periods.
- Any cross-region or multi-account recovery objective.
- Hosted SaaS support staffing and response commitments.
- Artifacts suitability as the sole production RepositoryDriver while it remains closed beta.
- Exact R2 export/mirror topology for customer-managed keys and residency.
- Safe compensation for every external Target side effect.
- Recovery of a complete Anyam Realm when Cloudflare account control-plane APIs are unavailable.

Until each has a receipt, it is a landmine to encode it as a public promise or immutable schema constraint.

