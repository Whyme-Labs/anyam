# ADR 0072: Signed, quarantined Authority recovery

## Status

Accepted on 2026-08-21.

## Context

Authority recovery previously accepted a credential-free snapshot from an
owner-authenticated route and replaced the stored Authority snapshot. That
snapshot also contained audit and idempotency state, so a compromised owner
session could roll back accepted history or erase the evidence needed to
explain the rollback.

## Decision

1. Authority export returns a signed `anyam.authority-recovery/v1` bundle when
   no Artifacts operational rows exist. Otherwise it returns v2, which also
   signs Authority schema version 2 and an `anyam.artifacts-recovery/v1`
   metadata checkpoint at auxiliary schema version 1.
2. The bundle binds the Realm, exact Authority version, canonical snapshot
   digest, hash-linked audit-chain digest, issuance time, and customer-owned
   recovery key ID.
3. The signing secret is a customer secret binding and is never placed in the
   Authority snapshot, bundle, audit receipt, or owner session.
4. Restore requires the exact signed bundle and an equal current Authority
   version. A stale, tampered, wrong-Realm, wrong-key, or replayed bundle is
   rejected before storage mutation.
5. A successful restore enters `quarantined` status. Normal Authority
   mutations, Runner completion, MCP mutation, and Promotion execution fail
   closed until activation.
6. Activation requires the exact quarantined bundle ID/digest and a fresh
   passkey-authenticated owner session. Activation is idempotent.
7. Realm identity recovery remains a separate ceremony; this protocol does
   not restore or revoke identity, passkeys, sessions, or OAuth grants.
8. On the SQLite-backed Realm Durable Object, restore commits Authority rows,
   legacy KV removal, quarantine status, current bundle/snapshot binding, and
   the replay receipt in one storage transaction. Activation commits active
   status and its receipt together.
   Authorization and state checks remain inside the concurrency gate.
   An unconfirmed transaction returns a sanitized retryable failure; callers
   retain the exact bundle and inspect its replay receipt before continuing.
9. Activation matches the currently bound bundle ID/digest and the exact
   quarantined normalized snapshot version/digest. Superseded receipts and
   unbound older quarantines fail closed. A fresh signed export/restore uses the
   existing owner ceremony to establish a binding; no historical receipt is
   silently promoted to the current recovery generation.
10. The v2 checkpoint covers `anyam_artifacts_workspaces` custody metadata and
    `anyam_artifacts_observations` immutable generation manifests, including
    pending fork/mint effects, unknown inventory, blocked status and token IDs.
    Decoded rows must match the signed Authority source, Workspace, view and
    base bindings. Raw payload/manifest JSON bytes remain unchanged. Credentials
    and unknown fields are refused.
11. Restore fills missing auxiliary rows in the same SQL/KV transaction.
    Existing rows must occur byte-for-byte in the checkpoint; a stale backup
    cannot erase or replace custody or generations even at the same Authority
    version. A v1 restore refuses nonempty auxiliary tables. Activation and
    quarantined replay also match the restored auxiliary digest.
12. This checkpoint contains metadata only. Provider reconciliation, R2 objects
    and indexes, Git objects and refs, credentials and live qualification remain
    separate operator recovery boundaries. Restore performs no provider effect.

The [Authority recovery qualification boundary](../qualification/authority-recovery.md)
documents supported historical field sets and the limits of local rollback tests.

## Consequences

- Recovery is no longer a direct snapshot overwrite controlled by one session.
- The audit chain is integrity-bound to the signed export, while provider
  reconciliation remains an explicit operator step during quarantine.
- The recovery key adapter is customer-owned and replaceable. A KMS/HSM
  guarantee is not inferred without a provider receipt.
- Existing qualification callers must restore the bundle and then activate it;
  raw snapshot restore is intentionally no longer accepted.

## Non-claims

This ADR does not claim that the customer secret binding is an HSM, that an
external audit anchor exists, or that provider state is automatically
reconciled during restore. Those are separate qualified boundaries.
