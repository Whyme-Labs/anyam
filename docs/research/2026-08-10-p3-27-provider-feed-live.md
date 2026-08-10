# Anyam P3-27 provider-feed live observation

Date: 2026-08-10
Wayfinder ticket: [Qualify live provider-feed reconciliation and per-surface reliability](https://github.com/wms2537/anyam/issues/127)
Protocol: `anyam.provider-feed-observation/v1`
Observation status: `succeeded`
Cleanup status: pending under [Qualify customer-owned provider failure and recovery matrix](https://github.com/wms2537/anyam/issues/129)

## Decision

The named provider-feed observation is complete for the disposable P3-24 cohort. The account-scoped analytics credential reached the correct Cloudflare account, the named Worker, R2, D1, Workflow, and Queue feeds returned data for the bounded window, and the Queue feed was bound to the named disposable Queue rather than the unrelated account Queue.

This receipt qualifies an observed account/resource/window measurement and reconciles its operation identities with the owner-authorized customer-provider receipt. It does not assert a platform-wide SLO, quota, cost, capacity, latency budget, retention guarantee, or universal Cloudflare-provider claim.

## Cohort and source

| Field | Value |
|---|---|
| Cloudflare account | `1e0170aaabc90ecf5f466128d1f0466a` (`swmengappdev`) |
| Installation | `anyam-p3-24-live-20260810` |
| Target Worker | `anyam-p3-24-target-20260810` |
| D1 | `anyam-p3-24-live-20260810-metadata` (`19ebda9a-ed35-4009-877b-198d84e08f99`) |
| R2 | `anyam-p3-24-live-20260810-exports` |
| Queue | `anyam-p3-24-live-20260810-events` (`a657344426264d11b41fcc755dd33e8f`) |
| Workflow | `anyam-p3-24-live-20260810-workflow` |
| Config | `apps/realm-worker/wrangler.p3-24-live.jsonc` |
| Anyam build revision | `0954dc2` |
| Hosting mode | `customer-operated` |
| Window start | `2026-08-10T00:00:00Z` |
| Window end | `2026-08-10T12:11:17Z` |

The feed was captured in the local, uncommitted `output.log` supplied for this qualification. The raw file is intentionally not committed as a credential-bearing or authoritative Anyam record; its receipt is:

```text
bytes=54674
lines=1667
sha256=f98ab5eceebef54ab7897859a23d768163146bd374849a68e5f4bf05e0c1afc5
```

The JSON payload begins after the npm preamble. It reports `status=succeeded`, the account above, the bounded window above, ten operation identities, six successful feed responses, and `recoveryAction=No recovery action is currently required.`

## Feed response state

Every named feed returned HTTP 200, `status=observed`, an empty provider error list, and non-null data for this observation:

| Feed | Result |
|---|---|
| `workers:anyam-p3-24-live-20260810` | observed |
| `workers:anyam-p3-24-target-20260810` | observed |
| `r2:anyam-p3-24-live-20260810-exports` | observed |
| `d1:19ebda9a-ed35-4009-877b-198d84e08f99` | observed |
| `workflow:anyam-p3-24-live-20260810-workflow` | observed |
| `queue:a657344426264d11b41fcc755dd33e8f` | observed |

`observed` means that the provider feed query returned data. It does not mean that every runtime row was successful.

## Per-surface observations

### Workers

The live Worker feed returned 80 rows, 88 requests, 1 error, and 70 subrequests. Its status population was:

| Provider status | Rows | Requests | Errors |
|---|---:|---:|---:|
| `success` | 77 | 85 | 0 |
| `clientDisconnected` | 2 | 2 | 0 |
| `scriptThrewException` | 1 | 1 | 1 |

The target Worker returned 2 rows, 2 requests, 0 errors, and 0 subrequests; both rows were `success`.

The live Worker error classes are recorded rather than hidden. This receipt does not infer a failure rate or availability SLO from them.

### R2

All returned R2 operation groups were `actionStatus=success`:

| Action | Requests |
|---|---:|
| `PutBucket` | 1 |
| `HeadBucket` | 14 |
| `GetObject` | 2 |
| `PutObject` | 2 |

### D1

The D1 feed returned one daily group for the named database:

```text
readQueries=38
writeQueries=14
queryBatchTimeMsP90=0.58
```

The p90 value is the provider field returned for this group, not an Anyam latency budget.

### Workflow

The named Workflow feed returned one hourly group:

```text
workflowName=anyam-p3-24-live-20260810-workflow
datetimeHour=2026-08-10T07:00:00Z
count=9
wallTime sum=0
```

### Queue

The named Queue was `a657344426264d11b41fcc755dd33e8f`; it is the disposable P3-24 queue, not the unrelated `fabric-events` Queue. The feed returned:

```text
backlog avg messages=0
backlog avg bytes=536
total operation groups=9
total count=12
billableOperations=12
bytes=8580
```

The action-group counts were three `WriteMessage`, three `ReadMessage`, and three `DeleteMessage` groups. The raw provider `avg.retryCount` value was `0` for every group. The raw provider `avg.lagTime` values were:

```text
0, 6162, 6323, 0, 5768, 6393, 0, 5834, 6095
```

These are provider observation fields for this window. No Anyam Queue latency or retry limit is derived from them.

## Operation and coordinator reconciliation

The feed payload carried these ten owner-qualified operation identities:

```text
qualification-2f09d80e-7f60-4a2a-bb25-f4e8caa11687
qualification-eb73a845-d31c-42e0-aee6-c61c76d5caff
qualification-d11380ad-91c6-4cb5-906f-874bf5f09b3e
qualification-7b2837f1-99db-443b-bfd5-a7aa4da4c419
qualification-50dc237b-05e0-4dfa-baed-189866e001b1
qualification-d20df998-9ef0-43bf-8ea6-3621e8e20d88
qualification-e8489903-98dd-4883-aa55-af1e5f67cf1e
qualification-874499a3-f53f-4cc3-9308-f18c0900099b
qualification-ba5ceb14-926e-45b4-b562-b6e193cc60e6
qualification-7aa8ba4b-8f6d-4e4f-b5ca-9951c0b2fa78
```

The list matches the healthy and failure/recovery operation identities in [the P3-24 customer-provider live receipt](2026-08-10-p3-24-customer-provider-live.md). That receipt is authoritative for owner-session binding, idempotency, checkpoint comparison, read-back before success, failure injection, exact resume, redeploy, credential-free recovery restore, and the prohibition on canonical writes. The provider-feed payload itself contains no coordinator result digests or credential material, so no new digest is invented here.

## Boundaries and cleanup

- The observation population is the provider data returned for the six named feeds and the bounded window above. Rows outside the window and provider surfaces not named above are excluded.
- Provider facts are not Anyam limits. No platform-wide SLO, quota, cost, capacity, retention, or universal provider-support claim is made.
- Network-byte observation was not available in the related P3-24 qualification; no network budget is inferred.
- Credentials are not printed, persisted in this receipt, or included in `output.log`.
- The named Cloudflare resources and disposable provider effects remain live. Exact operation cleanup and absence verification are intentionally owned by [Qualify customer-owned provider failure and recovery matrix](https://github.com/wms2537/anyam/issues/129); this ticket is not a cleanup receipt.

## Verification

The qualification script completed with `status=succeeded` and no feed errors. The local repository gates remained green after the script/schema fixes: `npm run check` passed all 136 tests. The script now fails closed on account mismatch and on a named Queue run without operation identities.
