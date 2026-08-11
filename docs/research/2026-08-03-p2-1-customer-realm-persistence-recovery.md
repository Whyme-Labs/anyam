# P2-1 customer-operated Realm persistence and recovery receipt

**Status:** Local contract qualification complete; Cloudflare Durable Object
and R2 provider qualification not claimed.

**Ticket:** [Persist customer-operated Realm state and Recovery Checkpoints](https://github.com/Whyme-Labs/anyam/issues/76)

## Authority boundary

The existing `CustomerRealmInstallation` state machine remains the authority
for installation phase, pending commands, Recovery Checkpoints, degraded state,
and audit lineage. `CustomerRealmDurableObjectInstallationStore` implements its
existing store boundary and adds an expected-checkpoint write. A stale writer
receives a named `stale_state` error and cannot overwrite the winner.

The `CustomerRealmRecoveryObjectStore` is only an immutable R2 object boundary:

```text
Durable Object coordinator  -> authoritative installation state
D1                          -> rebuildable read model (not implemented here)
R2                          -> credential-free Recovery bundle bytes
Queue                       -> at-least-once transport (not completion)
Workflow                    -> orchestration (not the ledger)
```

R2 objects are addressed by the verified bundle digest. Reads re-verify the
bundle, credential-free invariant, and requested digest before returning it.
R2 cannot resume authority by itself.

## Local receipt

Measured on 2026-08-03 in this checkout:

```text
npm run typecheck                         exit 0
npx tsx --test test/customer-realm-persistence.test.ts
                                          4 tests passed, 0 failed
```

The persistence tests cover:

- save/reopen with pending commands and checkpoint digest;
- stale expected-state write with `overwritten=false` receipt;
- provider outage, restart, same operation identity, and recovery;
- duplicate-safe persisted command completion;
- R2 digest-addressed write/read;
- unknown, mismatched, malformed, and credential-bearing recovery objects;
- no unauthenticated Worker authority route.

The `bytes` value in an R2 write receipt is measured from the serialized
payload. It is an observation for that object, not a configured quota.

## Provider qualification still required

This receipt does not claim that a real customer account has been deployed or
that Cloudflare storage semantics, permissions, billing, R2 immutability, or
Durable Object concurrency have been qualified for Anyam. The next provider
spike must exercise a customer-owned Worker and Durable Object with the same
CAS and recovery scenarios, then retain the exact command output and account
configuration receipt.

No passkey/OIDC, Git Gateway, Artifacts, provider credentials, Worker
Promotion, or production Target mutation is included in this ticket.
