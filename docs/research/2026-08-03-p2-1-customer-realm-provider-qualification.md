# P2-1 customer Realm persistence and recovery provider qualification

Date: 2026-08-03
Issue: [Qualify customer-operated Realm persistence and recovery on Cloudflare](https://github.com/wms2537/anyam/issues/78)
Status: passed; disposable resources torn down and post-delete listings empty

## Question

Does the customer-operated Realm persistence and recovery boundary behave as
designed in a customer-owned Cloudflare account, without making D1, R2, Queue,
or Workflow state authoritative and without exposing an unauthenticated
authority route?

## Account and binding receipt

The refreshed Wrangler OAuth session reported:

```text
accountId=1e0170aaabc90ecf5f466128d1f0466a
owner=swmengappdev@gmail.com
credentialsStoredByAnyam=false
```

The account ID supplied before refresh was different and returned API error
10000. The qualification used the exact ID returned by `wrangler whoami`.

Disposable resources:

| Binding | Name or ID | Receipt |
| --- | --- | --- |
| Foundation Worker | `anyam-realm-qualification-20260803` | version `223df7c1-ab91-4dea-88a9-5defb029a231`; `https://anyam-realm-qualification-20260803.swmengappdev.workers.dev` |
| Probe Worker | `anyam-realm-qualification-dev-20260803` | final successful version `2e276af5-4b52-4798-8d3a-5cfec9cf780b`; cron-only |
| D1 read model | `anyam-qualification-20260803-metadata` | database ID `77df7526-c695-4de5-b87c-9264db38cd65` |
| R2 export bucket | `anyam-qualification-20260803-exports` | actual Recovery object store |
| R2 preview bucket | `anyam-qualification-20260803-exports-preview` | dev-preview binding; not authority |
| Queue | `anyam-qualification-20260803-events` | producer binding only |
| Workflow | `anyam-realm-qualification-probe-workflow-20260803` | transport/orchestration binding only |

The deployed foundation health response reported:

```text
status=ready; hostingMode=customer-operated; configured=5; missing=0; credentialFree=true
```

The public qualification Worker returned HTTP 404 for `/qualification/run` and
reported `qualification=scheduled-only; publicMutationRoutes=false`.

## Exact qualification commands

The provider and deployment checks used Wrangler 4.118.0:

```bash
npx wrangler whoami
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler d1 list --json
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 bucket list
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler queues list
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler deploy --config apps/realm-worker/wrangler.qualification.jsonc
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler triggers deploy --config apps/realm-worker/wrangler.qualification-dev.jsonc
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler d1 execute anyam-qualification-20260803-metadata --remote --command "SELECT report_json FROM anyam_qualification_receipts_20260803 WHERE id='anyam-realm/qualification-20260803-r4';" --json
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler r2 object get 'anyam-qualification-20260803-exports/anyam/customer-realm/recovery/v1/sha256:69b79e4dd2166d9e0eb58d12cfcddd3c488c8debd13b532e3715b5ee1519e62f' --remote --file <receipt-file>
```

The first temporary probe revisions failed closed and exposed two harness
issues: an in-memory account fixture mismatch and a reused Durable Object
installation identity across cron invocations. Both were fixed before the
accepted `r4` run. The provider returned the expected checkpoint errors; no
silent overwrite occurred.

## Runtime receipt

The successful scheduled probe wrote one D1 diagnostic row:

```text
protocol=anyam.customer-realm-qualification/v1
status=passed
qualificationId=qualification-20260803-r4
observedAt=2026-08-03T06:19:35.925Z
```

Authority boundaries observed:

```text
publicMutationRoutes=false
credentialsStored=false
durableObjectIsAuthority=true
d1IsReadModel=true
r2IsObjectStore=true
queueAndWorkflowAreTransportOnly=true
```

Durable Object persistence:

```text
save/reopen:
saved=sha256:83f807ad3455c407e037f2a13be647661dcaf6be4353990bdfec8ea02e45cd34
reopened=sha256:83f807ad3455c407e037f2a13be647661dcaf6be4353990bdfec8ea02e45cd34
equal=true

stale CAS:
installation=qualification-20260803-r4
expected=sha256:83f807ad3455c407e037f2a13be647661dcaf6be4353990bdfec8ea02e45cd34
actual=sha256:4ed7c84d09319fff98fecd71c3ff4cccc5e7c319ded9ed5bc9e6acced5f7e5d7
overwritten=false

provider outage and restart:
degradedCheckpoint=sha256:d0d8ad98abde5aaeadccd8f10f8a733bf5f51772a3a99a2ef8a49ac11839751d
recoveredCheckpoint=sha256:b2ce892f9650c927ec3cbd80b45328fe8b622af3e32279b204cfc379e40c4693
sameCheckpointLineage=true

duplicate delivery:
idempotencyKey=qualification-delivery:qualification-20260803-r4
first=applied; duplicate=ignored; authoritativeStore=durable-object
```

R2 Recovery object:

```text
digest=sha256:69b79e4dd2166d9e0eb58d12cfcddd3c488c8debd13b532e3715b5ee1519e62f
key=anyam/customer-realm/recovery/v1/sha256:69b79e4dd2166d9e0eb58d12cfcddd3c488c8debd13b532e3715b5ee1519e62f
bytes=12889
roundTrip=digest matched; credentialFree=true
duplicateWrite=idempotent=true
raw downloaded bytes=12889
raw downloaded SHA-256=01dbeaeb2403249cefe44b00b73e7182f64ebc5e29cd6e01aa70dfd5902d5d5c
```

The object boundary rejected `content-mismatch` with
`recovery_digest_mismatch`, `credential-bearing` with `recovery_invalid`, and
`malformed` with `recovery_invalid`.

Transport receipt:

```text
Queue: sent=2; firstBacklog=3; duplicateBacklog=4; completion=false
Workflow: instance=workflow-qualification-20260803-r4; status=queued; completion=false
```

The Queue backlog counts include messages from failed disposable probe
iterations. They are not a throughput or delivery guarantee. The accepted
receipt establishes that sends succeeded and Anyam did not treat transport
acceptance as authoritative completion.

## Teardown and residual risk

The exact resources were removed in this order:

```bash
npx wrangler workflows delete anyam-realm-qualification-probe-workflow-20260803
npx wrangler workflows delete anyam-realm-qualification-workflow-20260803
npx wrangler delete anyam-realm-qualification-dev-20260803
npx wrangler delete anyam-realm-qualification-20260803
npx wrangler queues delete anyam-qualification-20260803-events
npx wrangler r2 bucket delete anyam-qualification-20260803-exports
npx wrangler r2 bucket delete anyam-qualification-20260803-exports-preview
npx wrangler d1 delete anyam-qualification-20260803-metadata --skip-confirmation
```

The first export-bucket delete was correctly rejected because the bucket was
not empty. A local-only remote R2-binding cleanup probe listed and deleted one
remaining object under `anyam/customer-realm/recovery/v1/`; the bucket then
deleted successfully:

```text
cleanup={"deleted":1,"prefix":"anyam/customer-realm/recovery/v1/"}
Deleted bucket anyam-qualification-20260803-exports.
```

The preview bucket had already been deleted. Post-delete read-only listings
returned no matching names or IDs for:

```text
anyam-qualification-20260803-metadata
anyam-qualification-20260803-exports
anyam-qualification-20260803-exports-preview
anyam-qualification-20260803-events
anyam-realm-qualification-20260803
anyam-realm-qualification-dev-20260803
anyam-realm-qualification-workflow-20260803
anyam-realm-qualification-probe-workflow-20260803
```

The temporary Worker source, cleanup probe, and qualification Wrangler
configs are not production code and were removed from the working tree after
teardown.

Residual provider risk: `wrangler dev --remote` reports SQLite Durable Objects
and Queues as unsupported in remote dev mode, so this qualification used a
deployed cron probe. It does not qualify production auth, Git, Artifacts,
Promotion, quotas, cost, SLOs, residency, or availability.
