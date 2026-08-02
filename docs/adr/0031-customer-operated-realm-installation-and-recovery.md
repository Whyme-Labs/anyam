# Customer-operated Realm installation and recovery

Status: Accepted

## Context

Anyam is fully open source and must be operable as a Customer-operated Realm
inside a customer's own Cloudflare account. The customer owns the Cloudflare
account, source repositories, Realm metadata, Project Content, Artifacts,
secrets, Targets, billing relationship, and recovery material. Anyam may be
used as an optional control-plane service in another Hosting Mode, but this
path must not require Anyam SaaS access, a third-party forge, or an
always-on customer-managed server.

Bootstrap crosses two external boundaries before a customer can use the
Realm:

1. the customer must prove control of the requested Cloudflare account; and
2. the installation must provision the Realm resources without creating a
   hidden or default administrator.

Imports and restores then cross provider, Queue, Workflow, Repository Driver,
Project Export, and identity boundaries. Provider acknowledgements are not
Anyam authority. A restore that brings back an active Session, Capability
Grant, or credential without owner activation would turn an unverified
checkpoint into authority.

## Decision

`src/installation/customer-realm.ts` owns the framework-neutral installation
state machine. Cloudflare, Project import, and durable-state implementations
are adapters around it. The state machine does not store provider credentials,
recovery codes, secret values, or Anyam SaaS credentials.

### Explicit customer ownership

Customer-operated Bootstrap requires an explicit owner confirmation. A
successful account inspection records all ownership dimensions:

```text
account, billing, source, metadata, Artifacts, secrets, recovery material
```

The persisted state records `credentialsStored=false`; it does not record the
credential that established control. A Realm reaches `realm-ready` only after
the provider returns a verified resource receipt. The first owner is enrolled
later through a verified passkey (or an adapter-verified equivalent) and an
owner-visible external recovery receipt. There is no default admin and no
default password.

### Resumable Bootstrap and Import Operation

Every provider-side mutation is preceded by a durable command with:

- operation identity;
- idempotency key;
- expected state digest;
- input digest;
- current status;
- provider operation ID when known;
- owner-visible receipt and safe recovery action.

The installation phases are explicit:

```text
new
  → account-verifying
  → account-ready
  → provisioning
  → realm-ready
  → owner-ready
  → project-ready
  → importing
  → imported / active
```

Provider outage, duplicate delivery, Workflow stall, import failure, or
partial mutation transitions to `degraded` when retryable or `blocked` when
automatic retry is unsafe. The state records the dependency, operation,
Recovery Checkpoint, partial effects, receipt, and safe next action. Recovery
reuses the persisted operation and idempotency identity; it never invents a
new command because a provider call failed.

An empty planned resource set is not a verified provisioning receipt. Recovery
must call the idempotent provision operation when no resource receipt exists,
and may inspect an existing provider receipt only after resource IDs have been
recorded.

### Customer-owned Project Export and restore

`exportRecovery()` produces a credential-free Recovery bundle containing:

- installation and Hosting Mode state;
- Realm identity, principals, Actors, Sessions, Tasks, Relationships, Source
  Space policy, Grants, and audit lineage;
- Project, Source Space, Project Revision, Import Operation, and pending
  command state;
- an optional verified Project Export with repository, lineage, Evidence,
  Artifact, Release, Target, policy, and checkpoint metadata;
- a content digest and explicit `credentialFree=true` receipt.

The bundle is verified before restore. Verification fails closed when the
protocol/version, ownership boundary, Realm identity, state digest, command
list, audit list, Project Export digest, lineage, or credential-free property
does not match. Unknown credentials are not silently ignored.

Restore has two separate transitions:

```text
verified bundle
  → recovery-pending
  → provider reconciliation
  → owner activation
  → active / project-ready / owner-ready
```

`RealmIdentityPolicy.restoreRecoverySnapshot()` restores identity metadata but
always clears credential records, revokes restored Sessions and Grants, closes
Tasks, and advances the Realm authorization epoch. The installation remains
`recovery-pending` until the recorded owner supplies a fresh external recovery
receipt and the customer provider adapter verifies the customer-owned
resources. Recovery never resumes authority merely because a bundle parsed or
its digest matched.

### Adapter boundary

The Cloudflare adapter exposes account inspection, idempotent Realm
provisioning, and provider reconciliation. The Project importer exposes
staged start/resume operations. Neither interface accepts or returns a raw
credential. The customer-operated installation can therefore run, persist,
export, and restore with a local durable store and customer-owned provider
adapters even when Anyam-operated services are unavailable.

The adapter may report provider-specific receipts, but it never decides:

- Capability policy;
- Change or Project Revision identity;
- Source Space disclosure;
- Landing or Promotion authority; or
- whether an unverified provider result is safe to activate.

### Failure and audit behavior

All state transitions append an installation audit event and create a new
Recovery Checkpoint. Audit events record operation, Project/Principal context,
failure kind, partial effects, and provider receipt; they exclude token values,
secret values, and private model reasoning. A checkpoint is a resumable
boundary, not a claim that the provider completed the whole operation.

## Consequences

- Customer-operated installation is a real supported Hosting Mode, not a
  shell script that assumes a hosted Anyam account.
- Bootstrap and Import Operation failure is inspectable in the UI, CLI, REST,
  and MCP projections because the durable state names the operation and safe
  action.
- Project Export and Realm recovery share the credential-free, digest-verified
  restore boundary; a provider outage cannot silently become authority.
- The in-memory kernel remains portable. Cloudflare Durable Objects, D1,
  R2, Queues, Workflows, and provider APIs can be added behind adapters while
  preserving the same state transitions and receipts.
- A customer can recover without Anyam SaaS access, but a production adapter
  still needs qualification for Cloudflare account ownership, passkey/OIDC
  verification, durable storage, and provider-side resource reconciliation.

## Rejected alternatives

- **Default administrator credentials:** unsafe to ship, impossible to audit
  reliably, and incompatible with customer-controlled identity.
- **Retrying from the last UI step:** UI state is not authoritative and can
  duplicate provider mutations.
- **Treating a provider acknowledgement as completion:** it loses partial
  mutation and reconciliation semantics.
- **Restoring active credentials from a backup:** a stolen or stale export
  would become a privileged login.
- **One adapter-owned database as the recovery source:** provider state is not
  the Anyam ledger and may be unavailable, duplicated, or stale.
- **A single account-wide provisioning map:** multiple customer Realms in one
  Cloudflare account would overwrite one another; resource receipts are keyed
  by account and installation.
