# P3-28 replay archive workload measurement

Date: 2026-08-10 (provider receipt time)
Issue: [Measure representative replay archive workload and object-size distribution](https://github.com/wms2537/anyam/issues/140)
Map: [Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/wms2537/anyam/issues/138)
Protocol: `anyam.replay-archive-workload-qualification/v1`
Status: passed for a bounded contract-shaped sample; no production tripwire or provider limit is proposed

## Question

What measured replay-object workload distribution should Anyam use before naming its first customer-owned exact replay archive tripwire?

## Scope and ownership

The run used only the owner-authorized disposable Cloudflare account and the owner-created R2 bucket:

```text
account: 1e0170aaabc90ec9a295faad8e519458
bucket:  anyam-p3-26-replay-archive-20260810
project: project:anyam-p3-28-replay-workload-20260811
worker:  anyam-p3-28-replay-workload-20260811
url:     https://anyam-p3-28-replay-workload-20260811.swmengappdev.workers.dev
version: d27224c5-c611-46c8-bac3-b2fe9bbbc96f
source:  dd2d0d147503ab9dfcb0ddbe38dee6a9f5bfeb41
```

The Worker was deployed through the authenticated Wrangler OAuth session. No Cloudflare API token was requested, stored, printed, or committed. Its only qualification secret was a disposable Worker credential, and the receipt does not include its value.

## Workload construction

The measurement tool is [scripts/qualify-replay-archive-workload.ts](../../scripts/qualify-replay-archive-workload.ts), backed by the disposable Worker in [apps/replay-archive-workload-qualification](../../apps/replay-archive-workload-qualification). It submits a deterministic, caller-supplied corpus to the existing `anyam.public-gateway-replay-archive/v1` adapter. The corpus contains 24 denied-request tombstones, stratified as follows:

| Class | Samples | Shape |
| --- | ---: | --- |
| `terminal-denial` | 6 | ordinary terminal-denial receipt |
| `retryable-window` | 6 | retryable retention-class receipt |
| `provider-outcome` | 6 | provider abuse-outcome receipt |
| `long-field-contract-shape` | 6 | deliberately longer request, contribution, and receipt fields |

This is a contract-shaped serialization sample, not observed production traffic. The long-field class is an explicit sensitivity probe, not a claim that those field lengths are provider or Anyam limits. A larger customer traffic-derived population is still required before an operational volume or retention tripwire is selected.

## Measured distribution

The run started at `2026-08-10T16:15:54.340Z` and finished at `2026-08-10T16:16:17.697Z`.

```text
population.count=24
totalBytes=27876
minBytes=1003
maxBytes=1620
meanBytes=1161.5
p50NearestRankBytes=1009
p90NearestRankBytes=1620
p95NearestRankBytes=1620
p99NearestRankBytes=1620
quantileMethod=nearest-rank; rank=ceil(count*percentile); one-based rank
```

Every object was written, read back, and verified by the adapter. The second write of each exact request identity was idempotent and returned the same digest and byte receipt. The complete per-object receipts are recorded below.

| # | Class | Request ordinal | Bytes | Digest |
| ---: | --- | ---: | ---: | --- |
| 1 | `terminal-denial` | `0001` | 1003 | `sha256:8c141bca76418ff6c0ef00a087a51beba6d239bdeb37daa64899245931c4055b` |
| 2 | `terminal-denial` | `0002` | 1003 | `sha256:7043eb1c1dc1e506a975953e3703ccc25f05b359123d1f4546a107be7b62a2bf` |
| 3 | `terminal-denial` | `0003` | 1003 | `sha256:4c25cc4d55b12968a7f71e4fc9fe409aee1e6b467504cafde54dd925ba3167da` |
| 4 | `terminal-denial` | `0004` | 1003 | `sha256:ca0c1412cc12518bf4d9ea56a66f897247849e8e9b661b74e07c9132e389776f` |
| 5 | `terminal-denial` | `0005` | 1003 | `sha256:3e8105a0c7b1121a447be4b02e2ef9227d271485be27a89ddaa5f5190f2fb14f` |
| 6 | `terminal-denial` | `0006` | 1003 | `sha256:296d2cf69be56b744efa7c0603b7a555daf8a2494bde3c0b00d3690f3725939b` |
| 7 | `retryable-window` | `0001` | 1009 | `sha256:7a668ff98559d318904ddfaae409191247d5afd6f93a6932daebadf7701c8ffb` |
| 8 | `retryable-window` | `0002` | 1009 | `sha256:da806304f84435a68576891ef24a44372a1b796c538a6bf687b44b844c962a7f` |
| 9 | `retryable-window` | `0003` | 1009 | `sha256:b35b780031c76930162ddbfbcf6522bb0c1f8b19987a8f664c5dc0c88d5cf362` |
| 10 | `retryable-window` | `0004` | 1009 | `sha256:630c72138490e7c7709ffc5e1afbf30b93c998d3433cffe928a46250335b67bf` |
| 11 | `retryable-window` | `0005` | 1009 | `sha256:3f1e3649e95643b5f85f1f9091e73edf91d7066faa4961324abddb05309d4e31` |
| 12 | `retryable-window` | `0006` | 1009 | `sha256:f72a66d91e9b2dcd32a0fc897d53479080ac1701420433ced11225407bf0fbcc` |
| 13 | `provider-outcome` | `0001` | 1014 | `sha256:92ae3bc0cd21e957a2d44272422627b39e8f7747d6b833ffa0d381f66f37d37f` |
| 14 | `provider-outcome` | `0002` | 1014 | `sha256:2b473d300753d47c3b317e71dd4fd1523bfd9e6280e698fea340e3660d42c75c` |
| 15 | `provider-outcome` | `0003` | 1014 | `sha256:1406f6effbfcb05f976b482526b890a9e939c5ab069081931ecd955ecf1e08ec` |
| 16 | `provider-outcome` | `0004` | 1014 | `sha256:29772a95d1eb1edf448b2a21f2eb1b957537a290f608cc8784acfe5a5112d64f` |
| 17 | `provider-outcome` | `0005` | 1014 | `sha256:f1f7ef2f40ff92e5ca2db9586f20a4eff0aea0f1f895b5e6fdedaf5afe45244f` |
| 18 | `provider-outcome` | `0006` | 1014 | `sha256:33d1b5f7190379e994b84e23c297db793e06ce9a17bab3f4d50fd9860d4a7910` |
| 19 | `long-field-contract-shape` | `0001:<96-r>` | 1620 | `sha256:22a1a4c7c2dfc4c4076f1a67363dd8bab1fa56a3087970007e880d7075c5df67` |
| 20 | `long-field-contract-shape` | `0002:<96-r>` | 1620 | `sha256:08784f74f3504f78e78a7ad93005a7b99a05960198be8ffeec8e26bb8281c178` |
| 21 | `long-field-contract-shape` | `0003:<96-r>` | 1620 | `sha256:0af69cd0aa21a57d8b7954f5d0bbd414b8ea701556ce6931848980578f84c051` |
| 22 | `long-field-contract-shape` | `0004:<96-r>` | 1620 | `sha256:50eafd0e6289003b603704560effe4169dff86046ed402750b2f76568c74c204` |
| 23 | `long-field-contract-shape` | `0005:<96-r>` | 1620 | `sha256:ff4dfa563986087a6bf75d3a9338f317a820b4dd381678553bf2bccae3f59b7b` |
| 24 | `long-field-contract-shape` | `0006:<96-r>` | 1620 | `sha256:e858a6610e862b8ef3bf2a366c9f83b19d249f4ad49bfd655560e27d97162800` |

All 24 objects reported `initialWriteIdempotent=false`, `retryIdempotent=true`, and `lookupVerified=true`.

## Cleanup

The qualification Worker deleted the exact 24 deterministic keys and verified that none remained:

```text
requestedKeys=24
deletedKeys=24
remainingKeys=[]
prefix=anyam/public-gateway/replay-index/v1/
exact=true
```

The disposable Worker was deleted with Wrangler. A subsequent request to its URL returned Cloudflare error `1104` (script not found, HTTP 500). The named R2 bucket was then deleted with the account-bound Wrangler configuration; a post-delete `r2 bucket info` returned Cloudflare error `10006` (bucket does not exist). No unrelated project, bucket, object, secret, or canonical repository was in scope.

## Decision

This receipt establishes a measured serialized-object shape range for the current replay-archive contract. It does **not** justify a production archive volume, retention, or storage tripwire: the population is deterministic and contract-shaped rather than customer traffic observed over time. The next map decision is therefore to choose the retention/deletion policy, while keeping the first operational tripwire configurable and explicitly unselected until a customer supplies a traffic-derived population.

Provider facts are not Anyam limits. Any future tripwire must carry a new workload receipt and must remain visible in the budget failure response.
