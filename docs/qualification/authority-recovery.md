# Authority recovery qualification boundary

The Realm Coordinator restores an exact signed `anyam.authority-recovery/v1`
or v2 bundle after checking its Realm, independent recovery key, snapshot and audit
digests, signature, and expected Authority version. Identity, passkeys, Sessions,
Grants, and provider state remain separate recovery boundaries. A complete bundle
must include every current Authority collection; malformed present collections
are rejected before replacement.

Export selects v2 when either Artifacts auxiliary table has rows. It signs
`authoritySchemaVersion: 2` and an `anyam.artifacts-recovery/v1` checkpoint with
`schemaVersion: 1`. The existing Authority database schema remains version 2;
this adds no migration. Unsupported auxiliary column types, primary keys or
unique constraints fail closed before writing. The v2 envelope requires every
Authority collection and does not apply the historical v1 omissions below.

The checkpoint includes custody rows from `anyam_artifacts_workspaces` and
immutable generation rows from `anyam_artifacts_observations`. It preserves
pending fork/mint effects, blocked status, unknown token inventory and token
IDs, with no credential values. Decoded metadata must match the signed account,
namespace, Source UUID, Workspace, view, exact base and observation generation.
Unknown or credential-bearing fields are refused. The current Realm's known
opaque credential scanner checks both raw strings and decoded payloads/manifests,
so JSON escapes cannot conceal credential values. The original JSON strings
are retained, including whitespace in immutable manifests.
Duplicate decoded JSON member names are rejected in raw custody/manifests,
including escaped key spellings, so earlier shadowed values cannot bypass the
credential and metadata checks.

Restore fills missing rows; it cannot delete or overwrite an existing row.
Every current auxiliary row must occur exactly in the incoming checkpoint.
This check covers new generations and changed custody even though Artifacts
operations do not increment Authority version. A v1 checkpoint cannot restore
over nonempty Artifacts tables. The current recovery binding records the
auxiliary digest, which activation and quarantined restore replay verify.

These are SQL metadata backups. They contain no R2 snapshot objects/indexes,
Git objects/refs, provider repositories or credentials. Back up and qualify
those boundaries separately. Restored pending effects remain pending; neither
restore nor activation retries a fork/mint, renews a credential, reconciles the
provider or upgrades a live qualification claim.

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
transaction covers auxiliary metadata inserts, Authority SQL replacement, legacy KV deletion, quarantine
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

The operator CLI accepts both supported envelopes and exposes
`realm recovery inspect|export|restore|activate` using
only an explicit existing human Session on stdin. Export preserves the signed
bundle in a new private file; restore preserves its exact returned receipt in
another new private file. Activation consumes that receipt's bundle ID/digest
with an explicit idempotency key. It does not automatically retry or activate,
and local installation `realm export/restore` remains a separate record. Follow
the [scoped pilot runbook](../runbooks/scoped-pilot.md) for the file, retry and
cutover procedures. The CLI does not locally attest the HMAC or full backup
coverage; the Coordinator remains the authority.

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
node_modules/.bin/tsx --test --test-concurrency=1 test/artifacts-recovery.test.ts test/artifacts-recovery-runtime.test.mjs
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
Artifacts checks additionally round-trip exact custody and generation bytes,
retain uncertain effects across restart, reject correctly signed malformed or
inconsistent metadata, refuse same-version stale generations, and roll back
auxiliary inserts with SQL/KV faults. The actual operator CLI exports/restores
v2 through private files and activates after reopening the same local storage.
Native regressions also refuse escaped known opaque credentials during export
and signed restore without changing identity, SQL/KV or provider state.

These checks qualify transaction rollback and retry locally. They do not prove
production backup availability, a live restore drill, crash or account disaster
recovery, provider fencing reconstruction, or a passkey authentication ceremony.
Those require exact account, checkpoint, source, provider reconciliation and
owner activation evidence before a live cutover.
