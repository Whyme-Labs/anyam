# ADR 0096: Customer provider adapter and production-shaped golden path

Status: Accepted

Issue: [#273](https://github.com/Whyme-Labs/anyam/issues/273)

## Context

The customer Realm CLI can plan, checkpoint, export, restore, and report a
provider-pending installation. A local command cannot safely assume Cloudflare
account credentials or claim that a resource was created. The installation
kernel already has a provider adapter boundary with resumable account and
Realm provisioning semantics; the CLI did not expose an equivalent mutation
seam.

## Decision

`realmInstall`, `realmUpgrade`, and `realmDestroy` accept an explicit
customer-owned `RealmProviderAdapter`. The adapter returns a typed operation
status, provider operation identity, credential-free receipt, and recovery
action. When supplied, the CLI persists a checkpoint after the adapter result;
when absent, it preserves the existing `provider-pending`/`upgrade-pending`/
`destroy-pending` state and says exactly what remains external.

The adapter is the only place allowed to hold provider credentials. The CLI
rejects credential-shaped receipt material and never serializes the adapter or
its credentials in `.anyam/realm.json`.

The production-shaped Cloudflare application journey remains a separate live
qualification: modules/assets/bindings, three isolated Targets, migration,
rollout, rollback, export, restore, and operational receipts must be run in a
customer account. The repository's fixture adapter proves checkpoint and
idempotency semantics only.

The owner-run command `npm run qualification:cloudflare-golden-path` now
executes the provider-backed portion from a local non-secret configuration:
one local build, D1 migration/read-back, Cloudflare Durable Object migration
preparation through a non-versioned Script upload, immutable Worker module and
asset upload/read-back, and preview/staging/production promotion. Cloudflare
rejects Durable Object migrations in a Version upload, so the Version metadata
omits `migrations` only after the preflight has read back the expected provider
migration tag. It emits `exportRestore=not-performed` until the separate
export/restore drill is completed; the command does not claim the full issue
closed by itself.

The separate `npm run qualification:cloudflare-golden-recovery` command now
closes that recovery slice without restoring provider snapshots in place. It
exports and verifies the credential-free Project package, restores the Git
bundle and Artifact bytes through quarantine, rebuilds a fresh prefixed
Cloudflare cohort, and injects a lost production Version-upload response. The
replay must locate the accepted provider Version by its exact annotation and
finish healthy. Mutable Durable Object state and Queue contents remain outside
the portable recovery claim.

## Consequences

- Customer integrations can perform real install/upgrade/destroy mutations
  without teaching the CLI about provider secrets.
- The no-adapter CLI remains safe and honest for offline planning.
- A live provider account and explicit operator authorization are still needed
  to close the golden-path evidence gate; no fixture is promoted to a provider
  claim.
