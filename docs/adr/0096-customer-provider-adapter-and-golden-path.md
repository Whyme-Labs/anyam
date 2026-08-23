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

## Consequences

- Customer integrations can perform real install/upgrade/destroy mutations
  without teaching the CLI about provider secrets.
- The no-adapter CLI remains safe and honest for offline planning.
- A live provider account and explicit operator authorization are still needed
  to close the golden-path evidence gate; no fixture is promoted to a provider
  claim.

