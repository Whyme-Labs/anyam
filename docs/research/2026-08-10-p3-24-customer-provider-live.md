# Anyam P3-24 customer-provider live qualification

Date: 2026-08-10  
Installation: `anyam-p3-24-live-20260810`  
Realm: `realm:anyam-p3-24-live-20260810`  
Cloudflare account: `1e0170aaabc90ec9a295faad8e519458` (`swmengappdev`)  
Worker: `anyam-p3-24-live-20260810`  
Target Worker: `anyam-p3-24-target-20260810`  
Config: `apps/realm-worker/wrangler.p3-24-live.jsonc`

## Decision

The owner-authorized customer-provider qualification panel is live and qualified for the five named Cloudflare surfaces:

```text
D1 → R2 → Queue → Workflow → Worker
```

Each operation is owner-session-bound, idempotent by operation identity, read-back verified before success, credential-free in its Anyam record, and permanently prohibited from canonical source writes.

This is a bounded provider qualification receipt. It is not a claim about universal Cloudflare quotas, latency, SLOs, cost, or support for arbitrary customer resources.

## Owner authorization receipt

The qualification used the customer owner’s Safari passkey session on the live Worker. The session was authenticated by WebAuthn with user verification; the kernel membership and owner relationship were verified; the host session remained opaque; and no credential material was stored or displayed.

The owner identity and credential identifiers are intentionally omitted from this public receipt. Provider credentials were never returned by the provider panel.

## Healthy surface matrix

| Surface | Operation identity | Initial result | Recovery action | Final result |
|---|---|---|---|---|
| D1 | `qualification-2f09d80e-7f60-4a2a-bb25-f4e8caa11687` | succeeded | none | succeeded |
| R2 | `qualification-eb73a845-d31c-42e0-aee6-c61c76d5caff` | succeeded | none | succeeded |
| Queue | `qualification-d11380ad-91c6-4cb5-906f-874bf5f09b3e` | indeterminate | resume exact operation | succeeded |
| Workflow | `qualification-7b2837f1-99db-443b-bfd5-a7aa4da4c419` | indeterminate | resume exact operation after callback | succeeded |
| Worker | `qualification-50dc237b-05e0-4dfa-baed-189866e001b1` | succeeded | none | succeeded |

Queue and Workflow are intentionally asynchronous: an accepted/deferred transport may first produce an indeterminate checkpoint. The exact operation identity is resumed and the provider object is read back before the coordinator records success.

## Failure and recovery matrix

| Failure mode | Surface | Operation identity | Initial result | Recovery | Final result |
|---|---|---|---|---|---|
| provider outage | D1 | `qualification-d20df998-9ef0-43bf-8ea6-3621e8e20d88` | degraded | resume exact operation | succeeded |
| authorization revoked | R2 | `qualification-e8489903-98dd-4883-aa55-af1e5f67cf1e` | blocked | restore owner/provider authority, resume exact operation | succeeded |
| timeout | Queue | `qualification-874499a3-f53f-4cc3-9308-f18c0900099b` | indeterminate | resume exact operation after deferred callback | succeeded |
| duplicate delivery | Queue | `qualification-ba5ceb14-926e-45b4-b562-b6e193cc60e6` | succeeded after retry-safe delivery | same operation identity | succeeded |
| partial mutation | Worker | `qualification-7aa8ba4b-8f6d-4e4f-b5ca-9951c0b2fa78` | degraded | read back and resume exact operation | succeeded |

The partial-mutation recovery preserved one provider effect and did not create a second effect. The duplicate-delivery case was accepted idempotently. The authorization case did not expose provider credentials and resumed only after owner authority remained valid.

## Workflow callback qualification

The first live Workflow attempt exposed two implementation landmines:

1. Cloudflare Workflow instance IDs reject the colon in `workflow:${operationId}`. The adapter now uses the provider-safe `workflow-${operationId}` form.
2. A deferred Workflow callback was emitted before the coordinator stored its indeterminate checkpoint. The coordinator now records the callback predecessor digest for `instance-created`, allowing the callback to compare-and-set the exact prior state without weakening stale-callback protection.

Fixes:

- `5cfef6a Fix workflow qualification instance identifiers`
- `a9502f6 Preserve workflow callback checkpoints`

The post-fix Workflow operation above completed after an exact resume, and the provider Workflow instance completed without replacing coordinator authority.

## Redeploy and recovery restore

The provider recovery snapshot was exported from the live owner panel, then the live Worker was redeployed without changing the owner’s Safari session. The first restore attempt correctly failed closed because the durable store treated an exact existing snapshot as a conflicting overwrite. That was a real stale-state landmine, not a provider failure.

The restore contract was corrected to:

- accept an exact existing snapshot idempotently;
- add missing records only when the existing state agrees; and
- reject any durable record outside the bundle or any digest mismatch without overwriting state.

Fixes:

- `ab0f878 Make provider recovery restore idempotent`
- `1fecf98 Expose provider recovery receipts`

After redeploy, a fresh credential-free bundle restored successfully:

```text
status=recovery-restored
recordCount=13
credentials=none
authority=restored
```

The exact partial-mutation operation `qualification-7aa8ba4b-8f6d-4e4f-b5ca-9951c0b2fa78` then resumed as `succeeded` after restore. This proves operation identity and coordinator state survived the redeploy/recovery boundary.

## Verification gates

Passed locally after the restore and receipt fixes:

```text
npm run typecheck --workspace=@anyam/realm-worker
npm test -- --test-name-pattern='customer-provider|passkey'
```

The bounded test run passed all 136 selected tests. The live Worker was redeployed from the pushed branch after each production code change.

## Explicit boundaries

- Provider credentials were never printed, persisted in Anyam records, or returned by the qualification panel.
- Canonical source writes were never granted by the panel.
- The operation record is the Anyam authority; provider callbacks are accepted only after owner authorization and checkpoint comparison.
- Provider effects are disposable and must be cleaned by exact operation identity.
- Network-byte observation was not available in this qualification; no network budget is inferred.
- No provider quota, latency, cost, retention, or global availability number is asserted without a provider receipt.

## Cleanup state

The exact qualification provider effects and the named Cloudflare resources remain live pending explicit owner confirmation for destructive cleanup. Cleanup is not considered complete until each operation reports an exact cleanup receipt and the following resources are verified absent:

```text
Worker: anyam-p3-24-live-20260810
Target Worker: anyam-p3-24-target-20260810
D1: anyam-p3-24-live-20260810-metadata
R2: anyam-p3-24-live-20260810-exports
Queue: anyam-p3-24-live-20260810-events
Workflow: anyam-p3-24-live-20260810-workflow
```

