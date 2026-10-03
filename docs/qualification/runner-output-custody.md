# Offline qualification Runner output custody

The existing `apps/runner-qualification` coordinator accepts bytes through the
Attempt credential, stores them under the owner-bound output root in its R2
binding, and verifies the Runner's signed result against accepted references.
The protocol now requires every declared output before a successful result,
unique signed output paths, and exact accepted disclosure/kind/digest/size.
Failed or indeterminate results may contain the exact partial accepted set.
Context, manifest, Attempt, lease and credential restrictions still apply.

Output GETs and result acceptance use the same verified reader. It rereads
the actual object, checks raw SHA-256 and byte length, and serves the verified
buffer rather than an unchecked object body with an old digest header. Missing
or unavailable storage returns 503; changed bytes return 422. A rejected read
or result preserves the active Attempt and performs no Queue acknowledgement.
Storage failures omit provider error details. An unconfirmed object write does
not advance the accepted output manifest. Unavailable coordinator storage
reports an unconfirmed operation: its durable outcome must be read back, not
inferred from the error reply. Restore/reconcile credential-free Job status and
the exact scoped object before retrying the same active Attempt.

Requests to one coordinator are serialized through
`DurableObjectState.blockConcurrencyWhile` across external R2 calls, hashing,
credential checks and terminal state persistence. An upload arriving while a
completion verifies bytes waits until that completion has closed the Attempt
credential. This prevents the coordinator's concurrent uploads from replacing
the just-accepted bytes. It does not prevent another actor with direct R2
write authority from changing objects. Cloudflare documents this external-call
ordering boundary and its platform deadline in the
[Durable Object State API](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile).
Qualifying production artifact size, latency, buffering, deadline/restart
recovery and immutable provider custody remains required; no new application
size/time quota or throughput claim is introduced here.

From a checkout with locked dependencies, Node 22 with synchronous module hooks:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test \
  test/runner-output-custody.test.mjs
```

The test invokes actual production HTTP handlers with real Ed25519 signing and
raw-byte hashes. Only the Cloudflare DurableObject constructor, durable storage,
R2 and concurrency boundary are replaced by explicitly offline fixtures. Tests
cover incomplete success, duplicate signed references, disclosure drift,
healthy verified serve/accept, missing/tampered/previous-Attempt object bytes,
stale signed references/context, current credential/Attempt/path/disclosure
denial, failed partial output, exact-byte recovery, credential-safe storage
failure, closed-credential replay and a deterministic upload/completion race.
`npm test` includes this file. These checks qualify the handler protocol under
the fake provider's guarantees, not live Cloudflare DO/R2 behavior.

The custody boundaries remain distinct:

| Component | Byte responsibility |
| --- | --- |
| Runner process | Produces bytes and signs the result; its claims do not prove Verifier truth or host isolation |
| Qualification coordinator | Hashes uploaded bytes, writes scoped R2 objects, rereads and hashes served/accepted bytes |
| Qualification R2 binding | Stores/serves objects; tests substitute a memory store and do not qualify live durability/consistency |
| Realm Authority `runner.complete` | Verifies enrolled signatures/context and persists Runner-attested references; it does not fetch remote output bytes |
| Customer promotion executor | Fetches `artifacts/<digest>` from its configured store and independently checks the raw digest before Worker upload |

The qualification R2 prefix and promotion executor's digest-addressed store
have no newly implemented handoff. This work adds no independent Authority byte
verification, hosted Runner transport, Queue consumer/ack, live provider/key
custody, production secret, Artifacts activation or public permission route.
See [ADR 0037](../adr/0037-external-pull-runners-and-generic-target-qualification.md)
and [owner Run detail qualification](disclosed-writes-and-owner-run-detail.md).
