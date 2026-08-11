# P3-18 Public Gateway exact replay archive qualification

Date: 2026-08-08
Issue: [Qualify an archival replay-index adapter beyond the Public Gateway tombstone tripwire](https://github.com/Whyme-Labs/anyam/issues/113)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: passed locally with a live Cloudflare R2 authorization residual

## Question

Can the customer-owned Public Gateway move exact replay identities beyond the
local Durable Object tombstone tripwire, recover them after restart, and fail
closed when the archive is unavailable or unverifiable?

## Implementation receipt

The boundary is implemented in:

- `src/cloudflare/public-gateway-replay-archive.ts` — immutable one-object-per-
  request archive, bounded identity keys, read-back verification, idempotent
  writes, and integrity errors;
- `src/cloudflare/public-gateway.ts` — archive-aware compaction, exact archive
  lookup before acceptance, archived-count/checkpoint metadata, and provider
  failures that do not save coordinator state;
- `apps/public-gateway-worker/src/index.ts` — optional customer-owned R2
  binding `PUBLIC_GATEWAY_REPLAY_ARCHIVE` and visible 503/409 coordinator
  errors;
- `apps/public-gateway-worker/wrangler.example.jsonc` and README — binding
  and operator contract;
- `test/public-gateway.test.ts` — immutable archive, digest tamper, archive
  compaction, restart replay, and archive-outage fixtures.

The archive is never Project, Change, Release, or Landing authority.

## Local qualification receipt

The deterministic fixtures passed:

```text
npm run check — 123 tests passed, 0 failed
npm run typecheck --workspace=@anyam/public-gateway-worker — passed
npm run build --workspace=@anyam/public-gateway-worker — Wrangler dry-run passed
git diff --check — clean
```

The archive fixture proved:

```text
write/read-back digest verification=true
same exact identity write=idempotent
tampered object=integrity failure
local tombstone tripwire exceeded=archive every exact tombstone before state save
restart lookup=same-payload idempotent terminal denial
restart lookup=changed-payload replay denial
archive outage=provider-unavailable; no acceptance
```

## Local growth and latency receipt

The controlled memory-bucket measurement inserted 256 mixed healthy-sized and
abuse-shaped terminal-denial tombstones and read each identity back:

```text
objects=256
bucketObjects=256
totalUnsignedObjectBytes=169498
meanUnsignedObjectBytes=662.1015625
minUnsignedObjectBytes=644
maxUnsignedObjectBytes=695
putLatencyMs.p50=0.143792
putLatencyMs.p95=0.402999
putLatencyMs.max=18.190083
getLatencyMs.p50=0.075750
getLatencyMs.p95=0.114500
getLatencyMs.max=0.412125
receipt=receipt:p3-18-local-memory-archive-20260808
```

These are measurements of the local in-memory adapter and unsigned JSON
representation only. They are not R2 storage, billing, latency, or capacity
claims and must not be used as production tripwires.

## Cloudflare qualification attempt

The Worker dry-run accepted the optional R2 binding and included it in the
compiled Worker binding list. A live disposable R2 bucket could not be created
with the currently authenticated Cloudflare identity:

```text
account=1e0170aaabc90ec9a295faad8e519458
command=wrangler r2 bucket create anyam-p3-18-replay-20260808 --location apac
result=Cloudflare API authentication error code 10000
follow-up=wrangler r2 bucket list returned the same error
```

The active Wrangler OAuth token reports Workers and other scopes but no R2
permission. No bucket, Worker, binding, object, secret, or local live-fixture
directory was created by this failed attempt.

Therefore the following live receipts remain open and are not claimed here:

- R2 create/write/read-back/delete;
- provider-observed object bytes and lookup latency;
- redeploy/restart replay proof with a real R2 binding;
- provider billing/cost measurement;
- archive outage and partial-write behavior against the real provider.

## Exit decision

The provider-neutral exact replay archive boundary is qualified locally: it is
immutable, content-digest verified, restart-readable, idempotent, and
fail-closed. The Cloudflare adapter is wired behind an optional customer-owned
R2 binding and is ready for a credentialed disposable qualification.

The live R2 authorization residual is explicit. It must be resolved with a
customer identity that has R2 permission before Anyam claims Cloudflare R2
production support or publishes provider-specific archive limits/costs.
