# Realm Runner Artifact byte handoff

The hosted Realm completion route now retains signed Runner Artifact bytes in
customer-owned digest-addressed storage before accepting the terminal Run.
This closes the prior gap where Authority recorded an Artifact but the
Promotion executor's `artifacts/<digest>` object was absent.

## User flow and bindings

1. A human or agent requests a Run against an exact Project View and Revision.
2. The enrolled Runner uploads Attempt-scoped output objects, signs its Result
   and closes its Attempt credential through the Runner coordinator.
3. The internal Realm completion route verifies enrollment, signature, context,
   current Attempt, Run inputs, output scope, disclosure and replay identity.
4. Realm reads each Artifact's exact object key through `ANYAM_RUNNER_OUTPUTS`,
   requires the current Attempt as a complete path segment below the assigned
   Artifact root and rehashes the actual body against its signed SHA-256 digest.
5. Realm conditionally creates `artifacts/<digest>` in
   `ANYAM_PROMOTION_ARTIFACTS` and rehashes the stored body. Existing matching
   objects are reused; conflicting objects are rejected without overwrite.
6. Only then does the Realm commit terminal Run, Evidence, Artifact, Attempt,
   accepted detail, idempotency and audit metadata through its Authority store.

Bind `ANYAM_PROMOTION_ARTIFACTS` to the **same customer-owned bucket** used by
`apps/promotion-executor`. Bind `ANYAM_RUNNER_OUTPUTS` to the corresponding
Realm's Runner output bucket. Realm only reads that source binding. Output
paths must contain the exact Attempt as a complete slash-delimited segment;
backslash aliases and substring-only Attempt matches are rejected. The signed
Result selects object keys, never a bucket, endpoint, credential or executor.
Use separate source buckets for independent Realms; this milestone does not
add a shared multi-Realm object-store access broker.

Artifact-bearing completion fails closed when either binding is missing.
Artifact-free completion needs neither binding. Library callers that omit the
trusted custody argument remain explicitly `artifactByteCustody=runner-attested`;
that library mode cannot claim Realm byte custody.

## Interruption and recovery

Source/destination digest mismatch or missing source returns a conflict;
unconfigured bindings block completion. Storage exceptions, missing destination
readback or an unconfirmed Authority commit return a safe, actionable unavailable
response without provider error text. Reconcile storage and retry the **same
signed completion and idempotency key**. An accepted replay returns its original
result without reading expired Attempt objects or copying bytes again.

R2 and Authority storage are separate transactions. If copying succeeds but the
Authority commit does not, verified digest bytes can remain unreferenced. Retry
rehashes the Attempt object, verifies the existing destination and commits the
same completion without overwrite. If Authority committed before a subsequent
storage operation failed, the replay confirms the stored acceptance. This is
not an atomic cross-provider transaction or automatic orphan garbage collector.
Do not delete Attempt objects until the Realm confirms completion. Corrupt
existing destination objects require explicit operator reconciliation; the
handoff never repairs them by silently replacing immutable bytes.

The Evidence receipt distinguishes `artifactByteCustody=realm-verified` from
`outputReadBack=runner-attested`. Only Artifact bodies are retained here; log
and Evidence references remain Runner-attested. Retention does not prove how
the Runner executed an Action or that a failed/indeterminate Run passed.

## Offline evidence and remaining gates

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test test/realm-artifact-handoff.test.mjs
node --import ./node_modules/tsx/dist/loader.mjs --test test/realm-artifact-handoff-runtime.test.mjs
```

The Worker-driving `test/fixtures/realm-artifact-handoff-runtime.ts` is included
in the strict Worker-test project and intentional-error boundary qualifier.
The `.mjs` launcher installs the Node constructor shims and registers cases.

These Node tests call the actual Realm HTTP handler and Authority completion
with real Ed25519 envelopes and raw SHA-256 hashing. They substitute Cloudflare
constructors, authentication state, Authority persistence and R2 bindings with
owned fixtures. They prove boundary ordering, immutable conditional writes,
readback, safe failures, replay, retry and serialized completion. They do not
qualify live workerd, SQLite, R2 conditional-write behavior or deployed services.
The second command separately runs the actual local workerd Realm handler and
SQLite store with Miniflare R2. It covers source tampering, conditional retention,
immutable destination conflict, operator restoration and durable replay after
Attempt cleanup. Its authentication state and process output are synthetic,
and all storage is disposable and local. It is not a live Cloudflare claim.

Required gates are core/Worker/test typechecks, the ordinary full repository
check, the local workerd/R2/SQLite flow and a customer-approved disposable live
Realm/Runner R2 flow. Live qualification requires the existing Realm and Runner
services, their own output bucket, the executor Artifact bucket and explicit
service/bucket bindings; no Cloudflare API credential belongs in Authority or
the completion envelope. This offline change does not create resources,
configure credentials, deploy services, activate Artifacts or invoke providers.

This milestone does not change `runner.output` into `worker.bundle`. A typed
Action output contract is still required before a Runner Artifact can enter a
Worker Release and Promotion. Release policy, typed Artifact lineage, provider
authorization and release-bound health must remain separate gates. No deployment
or end-to-end delivery claim follows from storing the bytes alone.
