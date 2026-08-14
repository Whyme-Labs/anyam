# Customer-operated team installation and operator journey

**Status:** Decision-grade research  
**Date:** 14 August 2026  
**Ticket:** [#190 — Define the customer-operated team installation and operator journey](https://github.com/Whyme-Labs/anyam/issues/190)  
**Map:** [#182 — Make Anyam credible for a real team](https://github.com/Whyme-Labs/anyam/issues/182)

## Decision

The customer-operated Realm is the reference installation for team adoption.
The customer owns the Cloudflare account, Anyam deployment, Realm data,
source, secrets, domains, Targets, billing, and recovery authority. Anyam's
hosted service is optional support or convenience infrastructure and is never
required to authenticate, recover source, restore the Realm, or promote a
customer-owned Target.

The installation is a versioned, digest-pinned release with a resumable state
machine and one operator-visible status surface. Installation, upgrade,
migration, backup, restore, diagnostics, and mode transition are all Anyam
Changes with receipts. A boolean “installed” flag or a green Worker response
is not an operational proof.

The operator journey is:

```text
preflight account and policy
  → install pinned Anyam release
  → verify bindings and migrations
  → enroll Realm owner and recovery
  → create/export checkpoint
  → create or import Project
  → run team/agent work
  → upgrade through preview and guarded Promotion
  → export and rehearse restore
  → migrate or retire only after owner activation
```

## Ownership and responsibilities

| Responsibility | Customer Realm owner | Project/team owner | Anyam maintainers | Cloudflare/provider |
| --- | --- | --- | --- | --- |
| Cloudflare account, billing, domains | Owns | Consulted | None | Operates platform |
| Installation and bindings | Approves and runs | Consulted | Publishes release and migration docs | Provides APIs/limits |
| Realm identity and recovery | Owns passkeys, recovery, break-glass | Uses delegated roles | No permanent authority | Hosts configured resources |
| Project source and policy | Owns Realm defaults | Owns Project/Source Space policy | Supplies contracts | Stores selected provider data |
| Secrets and production data | Owns values and rotation | Requests approved use | Never receives values by default | Encrypts configured storage |
| Backup/export/restore | Schedules, verifies, approves activation | Verifies Project invariants | Maintains format and tools | Provides storage/PITR primitives |
| Upgrade/migration | Chooses window and approves effects | Reviews Project impact | Signs release and migration | Applies provider mechanics |
| Specialized execution | Enrolls/approves Runner | Approves Action/Verifier use | Maintains protocol | Runs selected service |

Anyam maintainers may provide a signed release, documentation, diagnostics,
and optional scoped support. They do not become a hidden second owner. A
support session requires a customer-approved, expiring, recent-authenticated
break-glass grant and cannot bypass Source Space, canonical Landing, Secret
Use, or Promotion policy.

## Installation state machine

The installer and operator CLI must persist a resumable operation record:

```text
new
→ preflighted
→ account-ready
→ bindings-ready
→ realm-ready
→ owner-ready
→ migration-ready
→ active
```

Any phase may become `blocked`, `degraded`, or `indeterminate`. The record
contains the operation ID, idempotency key, expected prior state, release and
schema digests, partial effects, provider operation IDs, checkpoint, receipt,
owner, and recovery action. Retrying the same input returns the prior result;
reusing an idempotency key with different inputs is a conflict.

### 1. Preflight

The operator selects a Cloudflare account and Hosting Mode and runs a
read-only preflight. It checks account ownership, Wrangler/API authentication,
required product availability, domain/residency policy, billing ownership,
binding names, current installation version, migration history, and whether a
clean export destination exists. The report separates:

```text
provider fact
customer policy
required capability
observed configuration
missing or blocked action
```

No resource, secret, production Target, or permanent integration is created by
preflight. Provider limits are reported as provider facts, not Anyam quotas.

### 2. Install a pinned release

The operator chooses an Anyam release by immutable digest and verifies its
signature/provenance before applying it. The release manifest names the Worker
bundle, schema versions, migration set, required bindings, compatibility
range, default status endpoint, and rollback/recovery instructions.

Wrangler configuration is version controlled. Non-secret vars and bindings are
reviewable; secret names are declared, while values are entered through the
operator's secret manager or Wrangler. Cloudflare documents that `wrangler
secret put` creates a new Worker version and deploys it immediately, while
versioned secret operations can upload without immediate deployment; Anyam
must therefore treat secret changes as release inputs and verify which version
is active ([Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).

### 3. Bind and migrate

The installation creates or adopts only explicitly approved resources:

```text
Realm/Project Durable Objects
D1 read/catalogue database(s)
R2 content, Evidence, and export buckets
Queues and Workflows
Workers/Routes and optional custom domains
optional execution/Target bindings
```

Each binding is recorded by logical name, provider resource identifier,
ownership, region/jurisdiction, expected configuration digest, and disclosure
class. Secret values are never recorded.

Schema migration is a separate, inspectable step. D1 migration files are
versioned and applied in order; Cloudflare records applied migration names in
the `d1_migrations` table ([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)).
Anyam records the migration plan, preflight result, checkpoint, applied result,
and compatibility with the previous release. A failed migration leaves the
installation blocked; it does not mark the new release active.

Durable Object class lifecycle changes are particularly strict: Cloudflare
requires lifecycle reconciliation through deployment, does not support those
changes through `versions upload`, does not support gradual rollout for them,
and cannot roll back across a lifecycle change ([Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).
Anyam must show this as an irreversible or forward-only migration before the
operator approves it and require a restore/recovery path.

### 4. Enroll the first owner

The owner bootstrap creates a Realm owner principal, passkey/WebAuthn
credential, recovery method, device/session record, authorization epoch, and
audit event. There is no default password and no required Anyam global account.
The account-provisioning credential is not a permanent Git, Realm, or Project
credential.

The owner must complete recovery enrollment before protected Project creation,
Source Space visibility changes, policy changes, restricted export, or Target
Promotion. Recovery revokes affected sessions/grants and requires post-recovery
review; it cannot restore plaintext credentials or bypass disclosure policy.

### 5. Activate

Activation requires all of the following to be read back and receipt-bound:

```text
active Anyam release and schema digests
Realm owner and authorization epoch
required bindings and configuration digests
applied migration set
health/readiness result
verified credential-free export checkpoint
operator acknowledgement of billing, domains, and recovery ownership
```

The installation is not active if the Worker responds but a binding, migration,
owner, export, or policy check is missing.

## Operator status and diagnostics

Every installation needs one authenticated, machine-readable status surface,
available through the CLI and web control room. A safe public `/health` may
expose only readiness and a non-secret build/release identity. Detailed status
requires the owner/operator session.

The status document should include:

```text
installation ID and Hosting Mode
active Anyam release, schema, migration, and configuration digests
Realm status, owner/recovery status, authorization epoch
binding inventory and provider reconciliation state (no secret values)
Project/Source Space/RepositoryDriver health
Queue/Workflow/Runner/Target states and pending reconciliation IDs
last verified export/checkpoint and restore-drill status
provider feed freshness and cost reconciliation state
active degraded/blocked/indeterminate operations
last successful upgrade and rollback references
next action, owner, and receipt for every non-ready item
```

`anyam status --json` and `anyam doctor --json` should be deterministic and
redaction-safe. Diagnostics may collect versions, IDs, digests, HTTP status,
provider operation IDs, and timing observations; they must not collect access
tokens, secret values, private source outside the selected disclosure view, or
unbounded logs. A support bundle is an exportable, disclosure-filtered object
with a digest and retention policy, not a raw account dump.

## Upgrade and schema-migration journey

An upgrade is a Change that produces a Release and a guarded Promotion:

```text
inspect current status and export checkpoint
  → verify release signature/digest and compatibility
  → plan migrations and binding changes
  → run local/isolated preflight and restore rehearsal where required
  → upload version without activating it
  → preview and health-check the exact version
  → apply migration/binding changes under explicit operator approval
  → promote the version
  → verify Target health and read-back state
  → record activation receipt
```

Cloudflare Worker versions capture code, assets, bindings, and compatibility
settings, but associated D1/KV/R2/Durable Object state is not contained in the
Worker version. Version upload and deployment can be decoupled for controlled
promotion ([Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)).
Anyam therefore never represents a Worker version as a complete Realm backup.

Rollback is a new guarded Promotion to a known-good immutable version. It does
not rewrite history or automatically roll back D1, KV, R2, or Durable Object
state. Cloudflare notes that rollback can fail when resource bindings were
deleted/changed or a Durable Object lifecycle change intervened ([Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)).
Anyam must display one of:

```text
code-only rollback safe
rollback requires compatible data state
rollback blocked; forward recovery migration required
```

### Upgrade failure outcomes

| Failure | Required state | Operator action |
| --- | --- | --- |
| Signature/digest mismatch | `blocked`, no activation | Obtain the expected release or reject it |
| Missing binding/secret | `blocked`, previous release unchanged | Configure the named dependency, then retry preflight |
| Migration preflight failure | `blocked`, checkpoint retained | Correct or replace the migration |
| Migration partial/unknown | `indeterminate`, writes frozen | Inspect provider state; restore/reconcile before retry |
| Preview/health failure | `failed`, target unchanged | Inspect exact version and logs; retry or abandon |
| Provider timeout/429/outage | `indeterminate` or `degraded` | Reconcile the provider operation; never blindly duplicate |
| Rollback incompatible with state | `blocked` | Run an owner-approved forward recovery or restore |

## Backup, export, and restore

Project Export and installation recovery are different but linked:

- **Project Export** preserves Git/source, Source Spaces, Changes, Evidence,
  Artifacts, Releases, Targets, policies, audit/provenance, and disclosure
  metadata for a Project.
- **Installation recovery export** additionally preserves Realm/installation
  configuration, schema/migration state, binding inventory, provider bookmarks,
  and credential-free coordinator checkpoints.

Both are content-addressed and independently verifiable. Exports contain no
active credentials, secret values, passkeys, or refresh tokens. Credential
restoration always requires fresh owner authentication and new grants.

The operator should create and verify an export before each material upgrade,
on a declared recurring policy, and after recovery. The policy must be
customer-owned; this note intentionally does not choose a retention interval
or RPO/RTO number without a measured business-impact and restore receipt.

Cloudflare primitives are useful but not sufficient alone:

- D1 Time Travel is always on and can restore recent history, but the restore
  overwrites the database in place and cancels in-flight queries; the returned
  bookmark can undo the restore ([D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)).
- R2 bucket locks can prevent deletion/overwrite for a prefix or bucket, but
  retention is not an independent export or availability guarantee ([R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)).
- Workers Logs and Logpush are diagnostic/export channels, not the Anyam
  authoritative ledger. Logpush can send Trace Event Logs to R2, and its
  fields may be truncated or sampled ([Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)).

### Restore runbook

```text
detect and classify incident
  → freeze affected Landing/Promotion/policy mutations
  → export a pre-restore checkpoint and capture provider bookmarks
  → restore into an isolated namespace where possible
  → verify signatures, digests, refs, policies, disclosure, and migrations
  → rebuild D1/search/read projections from authoritative export/ledger
  → reconcile RepositoryDrivers, Mirrors, Queues, Workflows, and Targets
  → run synthetic reads, idempotency checks, and health checks
  → owner approves a Recovery Checkpoint
  → resume reads, then low-risk mutations, then protected Promotion
  → publish impact and follow-up Change
```

Any ambiguous provider effect remains `indeterminate` and blocked. A restored
read model never becomes authority merely because it is complete-looking.

## Degraded modes

Degraded behavior is part of the operator contract and is surfaced identically
in CLI, REST, MCP, and web status:

| Failure | Safe behavior | Forbidden behavior |
| --- | --- | --- |
| Realm auth/DO unavailable | Keep only explicitly safe reads; freeze grants and protected mutations | Mint broad credentials or accept a stale authorization decision |
| D1/read-model unavailable | Rebuild or use coordinator-safe reads where supported | Authorize from stale/empty indexes |
| R2/Evidence unavailable | Keep existing immutable lineage; block new Evidence/export where required | Claim Evidence or backup succeeded |
| Repository provider unavailable | Keep Anyam canonical; queue/reconcile provider work | Promote provider state to canonical or silently switch drivers |
| Queue/Workflow outage | Preserve Run/Attempt/Promotion ledger and retry/reconcile | Treat acknowledgement as business success |
| Runner unavailable | Mark Run unavailable/indeterminate; offer another qualified Runner only by policy | Widen grants or claim the Action completed |
| Target/health unavailable | Leave current Target pointer explicit; Promotion is pending/indeterminate | Claim production health from an HTTP timeout |
| Credential revoked/expired | Reauthenticate and issue fresh scoped grant | Retry a broad or stale token |
| Provider budget/limit reached | Name provider, budget/limit, requested amount, receipt, and recovery | Silently truncate, drop, or retry indefinitely |

## Hosting Mode migration

Moving between Hosted SaaS, Managed Customer-Account, and Customer-operated
Realm uses the same Project Export and activation protocol:

```text
owner requests export and disclosure projection
  → verify repository/object/metadata digests and signatures
  → import into destination quarantine
  → rebuild projections and compare identities
  → reconcile bindings, Mirrors, providers, and Targets as proposals
  → owner activates destination
  → revoke old grants and credentials after confirmation
```

The source mode remains available until explicit owner activation. No mode
transition requires an Anyam global account, and Git object/Project identities
remain portable. A failed import leaves the source intact and the destination
blocked.

## Qualification and implementation boundary

The operator journey is a decision, not a claim that all of it is currently
implemented. Before public team adoption, qualify at least:

1. clean customer-operated install from a pinned release;
2. owner passkey/recovery and device/session revocation;
3. missing binding/secret, denied grant, partial provisioning, and retry;
4. D1 migration failure, Durable Object lifecycle change, and upgrade rollback;
5. credential-free Project/installation export and isolated restore;
6. D1/read-model rebuild and provider/Target reconciliation;
7. public/private disclosure and support-bundle redaction;
8. status/doctor output for healthy, blocked, degraded, and indeterminate
   states; and
9. hosted/managed/customer-operated mode handoff with old-mode retention until
   activation.

Each qualification receipt binds the exact Anyam release, schema, provider
configuration, account, policy, disclosure projection, and operator. A receipt
becomes stale when those inputs change.

## References and existing Anyam decisions

- [`docs/adr/0018-hosting-tenancy-and-ownership-modes.md`](../adr/0018-hosting-tenancy-and-ownership-modes.md) — three Hosting Modes, ownership, support, upgrades, and mode transitions.
- [`docs/adr/0019-bootstrap-onboarding-import-and-recovery.md`](../adr/0019-bootstrap-onboarding-import-and-recovery.md) — resumable bootstrap state machine, owner recovery, imports, and activation.
- [`docs/adr/0015-cloudflare-first-architecture-and-provider-boundaries.md`](../adr/0015-cloudflare-first-architecture-and-provider-boundaries.md) — provider authority, export, recovery, and portability boundaries.
- [`docs/adr/0038-stage-gates-and-operational-receipts.md`](../adr/0038-stage-gates-and-operational-receipts.md) — exact-context Evidence, measured values, and recovery drills.
- [`docs/blueprint/anyam-platform-blueprint.md`](../blueprint/anyam-platform-blueprint.md) — product blueprint and customer-operated recovery target.

## Non-claims

This note does not claim that the current checkout has a complete installer,
operator dashboard, automatic upgrade engine, universal backup service,
customer-wide diagnostic collector, or every Cloudflare binding qualified in
production. It defines the operator contract and the qualification required
before those capabilities are advertised.
