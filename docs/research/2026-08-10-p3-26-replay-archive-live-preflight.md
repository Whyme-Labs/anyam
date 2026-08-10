# P3-26 replay archive live qualification preflight

Date: 2026-08-10
Issue: [Qualify live customer-owned replay archival beyond the Public Gateway tombstone tripwire](https://github.com/wms2537/anyam/issues/139)
Map: [Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/wms2537/anyam/issues/138)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: blocked before provider mutation by missing Cloudflare R2 account authorization

## Scope

This is a bounded preflight for one disposable customer-owned archive cohort.
No existing customer resource was inspected or mutated. The intended bucket
name is `anyam-p3-26-replay-archive-20260810`; it is disposable and has not
been created.

The live qualification remains responsible for exact tombstone archival,
read-back digest verification, idempotent retry, restart/compaction replay
lookup, archive outage, tamper or mismatched-object rejection, and exact
cleanup. This receipt records only the authorization gate; it does not claim
that any of those provider behaviors passed.

## Identity and provider receipt

```text
identity=swmengappdev@gmail.com
account=1e0170aaabc90ec9a295faad8e519458
wrangler=4.118.0
credential=local Wrangler OAuth profile; token value not recorded
```

Read-only `wrangler whoami` succeeded for the account, but the reported token
permissions did not include an R2 scope. The exact disposable create operation
was then attempted:

```text
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ec9a295faad8e519458 \
  node node_modules/wrangler/bin/wrangler.js r2 bucket create \
  anyam-p3-26-replay-archive-20260810 --location apac
```

Provider result:

```text
HTTP/API result: authentication error [code: 10000]
operation: bucket-create
resource: anyam-p3-26-replay-archive-20260810
provider mutation: not accepted
```

No bucket, Worker, R2 binding, object, secret, or local live-fixture
directory was created by this attempt. No unrelated customer resource was
probed or changed.

## Recovery action

The executing identity must be reauthorized with the minimum account
permission needed to create and later delete the disposable bucket. Cloudflare
documents `Workers R2 Storage Write` for the R2 REST bucket create operation.
After that authority is available, rerun the same named bucket create and
continue the live Worker/binding qualification. Do not substitute the local
memory-bucket receipt for provider evidence, and do not use an existing bucket
without a named owner and explicit cleanup authority.

## Exit decision

The ticket remains open. The provider qualification has not started, and no
R2 support, provider latency, object-size, cost, quota, retention, or SLO claim
is made by this receipt.
