# P3-19 live customer-owned R2 replay archive qualification

Date: 2026-08-08
Issue: [Qualify live customer-owned R2 replay archive write/read-back/recovery](https://github.com/Whyme-Labs/anyam/issues/115)
Depends on: [Qualify an archival replay-index adapter beyond the Public Gateway tombstone tripwire](https://github.com/Whyme-Labs/anyam/issues/113)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: blocked by Cloudflare R2 authorization; no provider support claim

## Question

Can the exact replay archive implemented in PR #114 be qualified against a
real customer-owned Cloudflare R2 bucket, including write/read-back,
idempotent exact replay lookup, restart/redeploy recovery, and fail-closed
provider failure behavior?

## Implementation under qualification

The provider-neutral archive boundary is already on `main`:

- `src/cloudflare/public-gateway-replay-archive.ts` — immutable,
  digest-verified one-object-per-request archive with bounded identity keys;
- `src/cloudflare/public-gateway.ts` — export-before-compaction, exact archive
  lookup before acceptance, and fail-closed provider errors;
- `apps/public-gateway-worker/src/index.ts` — optional customer-owned R2
  binding `PUBLIC_GATEWAY_REPLAY_ARCHIVE`;
- `apps/public-gateway-worker/wrangler.example.jsonc` — R2 binding contract.

The local qualification and memory-bucket receipt are recorded in [P3-18
Public Gateway exact replay archive qualification](./2026-08-08-p3-18-public-gateway-exact-replay-archive-qualification.md).

## Live attempt receipt

Authenticated identity and account selection:

```text
identity=swmengappdev@gmail.com
account=1e0170aaabc90ec9a295faad8e519458
wrangler=4.118.0
credential=local Wrangler OAuth profile; token value not recorded
```

The exact provider operations attempted were:

```text
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ec9a295faad8e519458 \
  node node_modules/wrangler/bin/wrangler.js r2 bucket create \
  anyam-p3-18-replay-20260808 --location apac

CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ec9a295faad8e519458 \
  node node_modules/wrangler/bin/wrangler.js r2 bucket list
```

Both calls returned:

```text
Cloudflare API /accounts/1e0170aaabc90ec9a295faad8e519458/r2/buckets
Authentication error [code: 10000]
exit=1
```

`wrangler whoami` succeeds for the account and reports Workers, D1, Queues,
Artifacts, Containers, and other scopes, but the output does not report an R2
scope. The observed output is not enough to distinguish an account entitlement
problem from a missing R2 permission; no stronger cause is claimed.

No bucket, Worker, R2 binding, object, secret, or local live-fixture directory
was created by this ticket. Existing customer buckets were not probed or
mutated because their ownership, contents, and cleanup authority were not
established for this receipt.

## Provider documentation receipt

Cloudflare’s current R2 authentication documentation says that account-level
bucket creation/listing needs the `Workers R2 Storage Write` permission, while
bucket-scoped object permissions are for the S3-compatible API rather than the
Cloudflare REST API:

- [R2 authentication and permissions](https://developers.cloudflare.com/r2/api/tokens/)
- [Create Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)
- [R2 troubleshooting for code 10000](https://developers.cloudflare.com/r2/platform/troubleshooting/)

The documentation receipt explains why this ticket cannot safely infer that a
successful Worker dry-run or local bucket fixture is live R2 qualification.

## Exit decision

The live provider path is **not qualified**. The local archive implementation
remains qualified as a provider boundary, but live R2 write/read-back,
provider-observed bytes/latency, redeploy/restart replay, partial-write
behavior, cleanup, and billing/cost evidence are still open.

To resume, an operator must authenticate an identity with the minimum
customer-account R2 permission, or provide a customer-owned bucket that can be
bound and deleted under an explicit cleanup receipt. After that, rerun the
disposable bucket/Worker fixture; do not publish provider limits or costs from
the local memory-bucket measurement.
