# Authority recovery qualification boundary

The Realm Coordinator restores the exact signed `anyam.authority-recovery/v1`
bundle after checking its Realm, independent recovery key, snapshot and audit
digests, signature, and expected Authority version. Identity, passkeys, Sessions,
Grants, and provider state remain separate recovery boundaries. A complete bundle
must include every current Authority collection; malformed present collections
are rejected before replacement.

Two historical field sets are supported: both `canonicalRefProjections` and
`runDetails` absent, or only `runDetails` absent. Their original signature is
verified before normalization. Acceptance requires an intact current,
schema-qualified SQL snapshot at the same state version. The entire normalized
snapshot must equal that baseline after copying the absent maps from it. Legacy
KV, orphaned SQL rows without metadata, an empty snapshot, and qualification
cleanup permissions cannot substitute for this check. Omitting only
`canonicalRefProjections` is unsupported.

This preserves existing additive records during a compatible restore. It does
not reconstruct lost records or prove their completeness. The v1 envelope has
no signed exporter revision or schema version; `expectedVersion` counts state
transitions. Common Git OIDs cannot reconstruct provider qualification receipts,
fencing epochs, ref bindings, repair challenges, or sealed provider generations.
If the required SQL baseline is lost, retain the signed historical bundle and
recover a complete qualified checkpoint or the original SQL baseline. Do not
invent empty maps or deploy older code against a newer Authority schema.

Restore holds the Durable Object concurrency gate across fresh authorization,
replay inspection, validation, and replacement. One SQLite-backed storage
transaction covers Authority SQL replacement, legacy KV deletion, quarantine
status, the current recovery binding, and the restore receipt. It also covers
complete-bundle initialization
or migration if needed. Activation checks the owner and passkey under the gate,
then commits active status and the activation receipt together. The storage API
[includes SQL and KV in the same transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction).

The current binding uses the existing bundle ID/digest as the recovery generation
and records the normalized restored snapshot's version and digest. Activation
must match that generation and the exact quarantined SQL snapshot. An older
receipt cannot activate a newer restore, even when both have the same version or
identical snapshot content. A superseded restore replay is also rejected without
changing the binding. Current restore and activation replays remain idempotent;
normal mutations after activation do not invalidate its harmless replay.

Older quarantines have no current binding and stay closed. Use the existing
owner export to obtain a fresh signed bundle, restore it, then activate its exact
ID/digest with a passkey Session. The Coordinator does not infer the current
generation from a historical receipt. This adds no new authorization ceremony.

A transaction that cannot be confirmed returns HTTP 503 with `indeterminate`
and an `outcome=unconfirmed` receipt, without exposing the storage exception.
Keep the exact bundle, bundle ID/digest, and idempotency key; retry with a valid
owner Session and inspect the replay receipt. A failed response alone is not
proof of either rollback or successful restore. Quarantine still requires
provider reconciliation and passkey-authenticated activation.

Run the local qualification from the repository root with the installed locked
dependencies:

```sh
node_modules/.bin/tsx --test test/authority-disclosure-runtime.test.mjs
```

The actual Coordinator executes SQLite and KV in isolated Miniflare/workerd
storage. Synthetic keys and identity fixtures remain local; outbound traffic is
denied except the owned failure/concurrency control binding. Faults follow SQL
replacement, KV deletion, quarantine, restore receipt, active status, and
activation receipt writes, including the current binding write, with a
non-storage await between the write and fault.
Checks compare every Authority SQL row, every KV key, operational identity and
credential state, then retry the identical request and verify its replay.
Historical fixtures also cover lost baselines, mismatched state, invalid
signatures, and a competing mutation held behind the real concurrency gate.
Generation regressions cover superseded activation/restore replay, identical
snapshots with distinct bundle identities, changed quarantined SQL state, and
fresh signed restore of an older unbound quarantine.

These checks qualify transaction rollback and retry locally. They do not prove
production backup availability, a live restore drill, crash or account disaster
recovery, provider fencing reconstruction, or a passkey authentication ceremony.
Those require exact account, checkpoint, source, provider reconciliation and
owner activation evidence before a live cutover.
