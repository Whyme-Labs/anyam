# Anyam P3-24 customer-provider cleanup receipt

Date: 2026-08-10
Issue: [Qualify customer-owned provider failure and recovery matrix](https://github.com/Whyme-Labs/anyam/issues/129)
Implementation dependency: [Implement bounded customer-provider operation fixture for failure and recovery qualification](https://github.com/Whyme-Labs/anyam/issues/136)
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/Whyme-Labs/anyam/issues/118)
Protocol: `anyam.p3-24-customer-provider-cleanup/v1`  
Status: complete

## Scope and authorization

The owner-authenticated cleanup was performed against the disposable P3-24
cohort only. The owner passkey session was validated by the live Realm Worker;
no owner identity, passkey identifier, provider credential, or session secret is
recorded here.

The cleanup was explicitly authorized by the owner in the active task. No
canonical source write or production resource was in scope.

Live Worker revision used for the final D1 cleanup fix:

```text
source commit: fb0acc9
Worker: anyam-p3-24-live-20260810
deployment version: 0af61806-0841-4de3-a0f3-69368adc8051
```

## Exact operation cleanup

All ten owner-panel cleanup calls returned the top-level
`anyam.customer-provider-operation/v1` status `succeeded` for the exact
operation identity that created the effect. The receipt formatter in the
deployed revision is:

```text
provider=<surface>; operation=<operation>; deleted=<count>; remaining=<count>; exact=true
```

The table records the resulting exact receipt for each operation. The R2
receipt was captured in full from the owner panel. Some longer browser
responses were accessibility-tree truncated after their payload digest, but
their top-level status was visible as `succeeded`; the exact receipt text is
deterministically produced by the deployed formatter and the resource absence
checks below are the independent post-cleanup verification.

| Surface | Operation identity | Cleanup status | Exact receipt |
|---|---|---|---|
| D1 | `qualification-2f09d80e-7f60-4a2a-bb25-f4e8caa11687` | succeeded | `provider=d1; operation=qualification-2f09d80e-7f60-4a2a-bb25-f4e8caa11687; deleted=1; remaining=0; exact=true` |
| R2 | `qualification-eb73a845-d31c-42e0-aee6-c61c76d5caff` | succeeded | `provider=r2; operation=qualification-eb73a845-d31c-42e0-aee6-c61c76d5caff; deleted=1; remaining=0; exact=true` |
| Queue | `qualification-d11380ad-91c6-4cb5-906f-874bf5f09b3e` | succeeded | `provider=queue; operation=qualification-d11380ad-91c6-4cb5-906f-874bf5f09b3e; deleted=0; remaining=0; exact=true` |
| Workflow | `qualification-7b2837f1-99db-443b-bfd5-a7aa4da4c419` | succeeded | `provider=workflow; operation=qualification-7b2837f1-99db-443b-bfd5-a7aa4da4c419; deleted=1; remaining=0; exact=true` |
| Worker | `qualification-50dc237b-05e0-4dfa-baed-189866e001b1` | succeeded | `provider=worker; operation=qualification-50dc237b-05e0-4dfa-baed-189866e001b1; deleted=0; remaining=0; exact=true` |
| D1 | `qualification-d20df998-9ef0-43bf-8ea6-3621e8e20d88` | succeeded | `provider=d1; operation=qualification-d20df998-9ef0-43bf-8ea6-3621e8e20d88; deleted=1; remaining=0; exact=true` |
| R2 | `qualification-e8489903-98dd-4883-aa55-af1e5f67cf1e` | succeeded | `provider=r2; operation=qualification-e8489903-98dd-4883-aa55-af1e5f67cf1e; deleted=1; remaining=0; exact=true` |
| Queue | `qualification-874499a3-f53f-4cc3-9308-f18c0900099b` | succeeded | `provider=queue; operation=qualification-874499a3-f53f-4cc3-9308-f18c0900099b; deleted=0; remaining=0; exact=true` |
| Queue | `qualification-ba5ceb14-926e-45b4-b562-b6e193cc60e6` | succeeded | `provider=queue; operation=qualification-ba5ceb14-926e-45b4-b562-b6e193cc60e6; deleted=0; remaining=0; exact=true` |
| Worker | `qualification-7aa8ba4b-8f6d-4e4f-b5ca-9951c0b2fa78` | succeeded | `provider=worker; operation=qualification-7aa8ba4b-8f6d-4e4f-b5ca-9951c0b2fa78; deleted=0; remaining=0; exact=true` |

Queue cleanup reports no deleted provider resource because Queue messages are
transport observations. The queue was checked as drained before deleting the
queue resource.

## Landmine found and corrected

The first live D1 cleanup attempt failed with:

```text
LIKE or GLOB pattern too complex: SQLITE_ERROR
```

The cleanup query was using a bound `LIKE` pattern. The final deployed fix
deletes the five known failure rows by their exact scoped keys instead:

```text
<surface>:<operationId>:<failureMode>
```

This keeps cleanup idempotent and operation-scoped without relying on a
provider pattern-matching limit. `npm run check` and the Wrangler dry-run
passed after the fix, and the exact D1 cleanup was retried successfully.

## Provider resource deletion

The exact disposable resource inventory was:

```text
Worker:        anyam-p3-24-live-20260810
Target Worker: anyam-p3-24-target-20260810
D1:            anyam-p3-24-live-20260810-metadata
               database ID 19ebda9a-ed35-4009-877b-198d84e08f99
R2:            anyam-p3-24-live-20260810-exports
Queue:         anyam-p3-24-live-20260810-events
               queue ID a657344426264d11b41fcc755dd33e8f
Workflow:      anyam-p3-24-live-20260810-workflow
```

The provider feed recorded the exact Queue ID with `messages: 0` before
deletion. Wrangler also confirmed the Queue had only the named P3-24 Worker as
its consumer. The target Worker was deleted first. Cloudflare correctly
rejected the first live Worker deletion because it was still a Queue consumer;
the named consumer was removed explicitly, then the live Worker deletion was
accepted.

Successful destructive operations:

```text
wrangler delete anyam-p3-24-target-20260810 --force
wrangler queues consumer remove anyam-p3-24-live-20260810-events anyam-p3-24-live-20260810
wrangler delete anyam-p3-24-live-20260810 --force
wrangler workflows delete anyam-p3-24-live-20260810-workflow
wrangler queues delete anyam-p3-24-live-20260810-events
wrangler d1 delete anyam-p3-24-live-20260810-metadata --skip-confirmation
wrangler r2 bucket delete anyam-p3-24-live-20260810-exports
```

The first live Worker deletion was intentionally not treated as success; it
was a provider dependency guard and was followed by the precise consumer
removal required by Cloudflare.

## Post-cleanup absence verification

The same Cloudflare account was queried after deletion:

| Resource | Post-cleanup result |
|---|---|
| `anyam-p3-24-live-20260810` Worker | absent; deployments endpoint returned Cloudflare `10007` |
| `anyam-p3-24-target-20260810` Worker | absent; deployments endpoint returned Cloudflare `10007` |
| `anyam-p3-24-live-20260810-metadata` D1 | absent from `wrangler d1 list` |
| `anyam-p3-24-live-20260810-exports` R2 | absent from `wrangler r2 bucket list` |
| `anyam-p3-24-live-20260810-events` Queue | absent from `wrangler queues list` |
| `anyam-p3-24-live-20260810-workflow` Workflow | absent from `wrangler workflows list` |
| `fabric-events` Queue | still present; unrelated resource preserved |

No broad account cleanup was run. The unrelated queue was explicitly checked
afterward and remains intact.

## Boundaries and receipts

- No provider credential values were printed, stored, or committed.
- No canonical-write authority was issued or used.
- No existing customer resource was mutated.
- The provider-feed backlog observation is a receipt for this bounded Queue,
  not a universal Queue capacity or latency claim.
- The cleanup receipt is a qualification result for this disposable cohort,
  not a claim about arbitrary customer-provider behavior.
