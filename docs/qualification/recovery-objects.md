# Immutable Recovery object boundary

`CustomerRealmRecoveryObjectStore` stores verified Recovery bundles at their
existing semantic bundle digest. Their producer's `credentialFree=true`
declaration is checked against recognized credential material. Verification and
storage receipts expose `credentialMaterialCheck` with scope `known-patterns`
and `exhaustive=false`; a no-match result does not prove arbitrary data contains
no secrets. R2 metadata records the same bounded scanner scope. See the
[Recovery credential detection contract](recovery-credential-check.md).
The customer storage adapter
must honor atomic R2 conditional creation: `onlyIf: { etagDoesNotMatch: "*" }`.
Cloudflare documents conditional writes and their `null` precondition result in
the [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

Every successful write receipt follows a fresh read and verification of the
retained object. An existing or concurrently created valid bundle is reusable;
its original bytes remain unchanged, and the receipt measures those retained
bytes. A conflicting, malformed or credential-bearing object is preserved and
rejected. The adapter does not delete, repair or overwrite it.

A write acknowledgement alone is insufficient. Missing retained objects fail
with `recovery_not_found`; provider write, lookup or body-read failures produce
the sanitized `recovery_storage_unconfirmed` result. Inspect the object at its
recorded digest before deliberately retrying the same Recovery operation.
There is no automatic retry.

The adapter serializes the input once, then verifies that exact snapshot before
any storage access. Caller mutation or a stateful serialization hook cannot
change its verified payload or credential-free metadata.
Neither storing nor reading a verified bundle resumes Realm authority. Restore
continues to require the existing provider reconciliation and owner activation.

Run the focused contract and local provider checks from the repository root:

```sh
npx tsx --test test/customer-realm-persistence.test.ts test/customer-realm-recovery-object.test.ts test/customer-realm-recovery-runtime.test.mjs
```

The runtime test uses the locked Miniflare/workerd R2 binding with owned local
storage, disabled telemetry, outbound service denied, and cleanup in `finally`.
It covers creation, replay, simultaneous writers, and valid, wrong-digest,
malformed and credential-bearing concurrent winners. Unit controls cover absent
read-back, provider exceptions, caller mutation, and retained-byte measurements.
The normal `npm test` command includes these checks.

This qualifies the persistence adapter locally. It does not establish a live
customer Recovery route, production account permissions or retention policy.
Customer-owned live deployment and an export/restore drill still require their
own exact provider and owner-activation receipts.
