# P3-15 live public Git Gateway and abuse-control qualification

Date: 2026-08-08
Issue: [Qualify live public gateway and abuse controls for P3](https://github.com/wms2537/anyam/issues/107)
Protocol: `anyam.public-gateway/v1`
Status: passed with bounded provider residuals

## Question

Can a customer-owned Cloudflare Worker expose a public Git projection and a
public contribution transport while preserving disclosure, canonical-write,
idempotency, provider-retry, moderation, suspension, cleanup, and measured-limit
boundaries?

## Implementation receipt

The reusable boundary is implemented in:

- `src/cloudflare/public-gateway.ts` — provider-neutral coordinator and edge
  decision contract;
- `apps/public-gateway-worker/src/index.ts` — customer-operated Worker and
  Durable Object adapter;
- `apps/public-gateway-worker/wrangler.example.jsonc` — non-production binding
  shape;
- `test/public-gateway.test.ts` — deterministic replay, timeout, moderation,
  cleanup, and edge-authority tests.

The Worker has no Landing or private Source Space authority. It accepts only a
public projection manifest, public Git read routes, and contribution envelopes.
The disposable Worker used one owner-scoped `ADMIN_TOKEN`; caller-provided
actor/role fields were ignored, so the qualification did not create a fake
moderator identity. A production Realm auth adapter remains the boundary for
multiple roles and capabilities.

## Static gates

```text
npm run typecheck — passed
npm run typecheck --workspace=@anyam/public-gateway-worker — passed
npm run build --workspace=@anyam/public-gateway-worker — passed (Wrangler dry-run)
npm test — 114 passed, 0 failed, 0 skipped
git diff --check — clean before commit
```

## Disposable live fixture

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Upstream fixture: https://github.com/wms2537/anyam-p3-public-gateway-20260808
Fixture commit: 9bf2d11859ec07fa8787f1014c3d5ae3eb7dd057
Fixture archive digest: sha256:17cc549fe6ced2792b70fd3bbfd435a19153ec671832a6499c6244d7e290c188
Initial Worker: anyam-p3-public-gateway-20260808
Final qualification Worker: anyam-p3-public-gateway-final2-20260808
Final Worker version: b778885e-d12c-49ab-97bc-4f18ea5717c5
```

The GitHub repository and all three disposable Workers were deleted after the
qualification. No secret value, provider token, or private Source Space was
stored in the repository or receipt.

After the live run, the Worker adapter received a static hardening change that
ignores caller-supplied admin actor/role fields and binds the qualification
secret to the owner identity. The live provider receipt above remains scoped to
the recorded Worker version; the hardening is covered by the 114-test static
gate and is not silently presented as a second live deployment receipt.

## Public Git Gateway receipt

```text
publicGit=anonymous-smart-http-read
gitLsRemote=passed; head=9bf2d11859ec07fa8787f1014c3d5ae3eb7dd057
shallowClone=passed; materializedFiles=1
privatePath=http-404; privateMetadata=not-disclosed
receivePack=http-403; canonicalWrite=false; materialized=false
upstreamProviderUrl=not-disclosed-in-responses
publicSourceSpace=source:gateway-public
landingAuthority=false
```

The clone returned the exact disposable public fixture commit. The Gateway
never returned the upstream GitHub URL as an error or metadata field. A private
path was indistinguishable from a missing public route.

## Logical contribution receipt

```text
policy=policy:public-gateway:project:p3-public-gateway-final2-20260808
logicalLimit=6 public-contribution-requests
logicalReceipt=receipt:p3-public-gateway-logical-tripwire-20260808
logicalMethod=controlled-qualification-acceptance-sample; healthy=4; tripwire=6; retryable-provider-failure-counts-as-request
healthyAccepted=4
retryableProviderFailure=requested=5; materialized=false; recoveryCheckpoint=provider-timeout
sameKeyRetry=requested=6; accepted=true; idempotent=false
changedPayloadReplay=requested=7; denied=true; materialized=false
logicalTripwire=requested=8; configured=6; denied=true
acceptedDisposition=quarantined
landingAuthority=false
```

The successful requests returned quarantine decisions and never created a
canonical write capability. A duplicate completed request returned the stored
decision with `idempotent=true` and did not consume another logical request.

## Moderation and recovery receipt

```text
open=owner receipt:live-open-20260808
suspend=owner receipt:live-suspend-20260808
suspendedRequest=denied; materialized=false
reopen=owner receipt:live-reopen-review-20260808
cleanup=owner receipt:live-cleanup-20260808
finalStatus=closed
finalAccepted=5
preservedContributionIds=contribution-1, contribution-2, contribution-3, contribution-4, contribution-retry
finalAuditCountBeforeEdgeBurst=13
```

After a bounded 120-request edge burst, cleanup still preserved the same five
accepted contribution IDs and produced a final Recovery Checkpoint. The burst
created no accepted contribution.

## Edge provider receipt and residual

The customer-owned Cloudflare Rate Limiting binding was configured as:

```text
edgeLimit=100
period=10 seconds
edgeReceipt=receipt:p3-public-gateway-edge-tripwire-20260808
edgeMethod=controlled-closed-intake-request-burst; observed=20; denials=0; tripwire=100; provider-period=10-seconds
```

The live 120-request burst observed:

```text
edgeAllowed=120
edgeDenied=0
http429=0
logicalLedgerAuthoritative=false
```

This is intentionally not reported as exact edge enforcement. Cloudflare's
Rate Limiting binding is a coarse local/eventual control and its documentation
does not promise accurate accounting. Anyam therefore keeps the Durable Object
ledger authoritative and treats the edge binding as an outer abuse tripwire.
Before a broad anonymous opening, a customer should remeasure the binding under
its own traffic shape and may add WAF, Turnstile server validation, bot scoring,
or another provider-specific adapter. Turnstile tokens, if used, must be
validated server-side and are single-use with a five-minute lifetime.

## Official provider references

- [Workers Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Durable Objects storage options](https://developers.cloudflare.com/workers/platform/storage-options/)
- [Durable Objects SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## Exit decision

The live provider-backed public Gateway boundary is qualified for a bounded P3
route: public reads work through the stable customer-owned URL, public writes
are denied, contribution requests are ledgered and quarantined, replay and
provider recovery are explicit, moderation and cleanup preserve lineage, and
private metadata is not disclosed.

This receipt does **not** claim that the Cloudflare edge binding is an exact
quota, that bot mitigation is complete, or that anonymous public intake should
be enabled for every customer. Opening remains an owner-controlled policy
decision backed by a current workload receipt; the next frontier is provider
specific bot/edge qualification and a real moderation surface if the P3 Stage
Gate requires them.
