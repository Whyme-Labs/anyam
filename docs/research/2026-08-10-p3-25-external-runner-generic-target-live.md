# P3-25 live external Runner and generic Target qualification receipt

Date: 2026-08-10

Issue: [#131 Run a live external Runner and generic Target qualification](https://github.com/Whyme-Labs/anyam/issues/131)

Protocol: `anyam.external-runner-qualification/v1`

Status: **complete live matrix passed; disposable resources deleted and verified absent**

## Decision boundary

This receipt qualifies one owner-operated macOS/arm64 Runner process through a
real Cloudflare Queue HTTP pull consumer, owner-bound Project View manifest,
Ed25519 Runner proof, scoped opaque Attempt credentials, customer-owned R2
output, signed Result acceptance, direct R2 read-back, Queue acknowledgement,
and unchanged publication to a disposable GitHub Release Target.

The residual live probes also passed: disclosure denial, duplicate claim,
credential invalidation after Result, owner cancellation, explicit revocation,
and a fresh successful retry. `networkBytes=not-observed` remains an explicit
measurement gap; no Anyam network budget or SLO is inferred.

## Disposable resources

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Queue name: anyam-p3-25-live-20260810-events
Queue ID: 33c7df8ec7464532b7dfe0d19ddc0911
HTTP pull consumer ID: 8086538a8e7c4079a31f4bd4146f2136
R2 bucket: anyam-p3-25-live-20260810-outputs
Coordinator Worker: anyam-p3-25-live-20260810-coordinator
Coordinator endpoint: https://anyam-p3-25-live-20260810-coordinator.swmengappdev.workers.dev
GitHub Target repository: Whyme-Labs/anyam-p3-25-live-20260810-target
GitHub Target tag: anyam-p3-25-live-20260810
GitHub Target asset ID: RA_kwDOTz1rGs4eTUsF
GitHub Target asset: anyam-live-runner.txt
```

No token, credential value, or private key was recorded.

## Primary live run

```text
cohort=anyam-p3-25-live-20260810
jobId=job:live-0ff1b2d0-909c-428a-955d-72d7380064ec
attemptId=attempt:a69610e7-19a2-4a8f-ad15-c7adc86b6f89
runnerId=runner:mac-1d87a892-d00a-430d-bdcb-5ca953d591b7
queueMessageId=b08ab4891a5b1ce5193e34c673b5b477
queueMessageIdDigest=sha256:9f8a8cc94ac84eed6e43339562253b770d8dc97524a6c53bf5a476173533fdda
queueBodyEncoding=json-text
queueAttempts=0
queueBatchSize=10
queueAckCount=1
queueRetryCount=0
queueLeaseId=redacted
queueLeaseIdDigest=sha256:a1399074ab9d9ad488fbcdd4c7d53bde85cc99595f95e7490183ec545bd77457
```

```text
inputManifestDigest=sha256:323db650acc30fa1b719bc1741292dddef84d4a49b90072570d2fd04e38998a2
sourceSnapshotDigest=sha256:c5fe7a07159a94e5756795b684dc3fe6540252f1b0e741616be282a06ec4c33c
projectViewId=project-view:external-runner-qualification
disclosure=project
artifactPath=artifact/anyam-live-runner.txt
artifactBytes=139
artifactDigest=sha256:5acbe3933627b8e3c9e9c5432c527ee47ba26a4f567764e3773a298e682e1b4c
r2ReadBackDigest=sha256:5acbe3933627b8e3c9e9c5432c527ee47ba26a4f567764e3773a298e682e1b4c
resultDigest=sha256:c1084ad9bf8b754b90dc6217bc7b8f6afc4dd207fd418f5c846e2206fe319a57
canonicalWrite=false
credentialFree=true
```

The unchanged GitHub Target publication matched the R2 bytes:

```text
release=https://github.com/Whyme-Labs/anyam-p3-25-live-20260810-target/releases/tag/anyam-p3-25-live-20260810
providerAssetId=RA_kwDOTz1rGs4eTUsF
providerAssetSize=139
providerAssetDigest=sha256:5acbe3933627b8e3c9e9c5432c527ee47ba26a4f567764e3773a298e682e1b4c
downloadedDigest=sha256:5acbe3933627b8e3c9e9c5432c527ee47ba26a4f567764e3773a298e682e1b4c
duplicateUpload=rejected
```

## Residual probe receipts

| Probe | Receipt | Decision |
| --- | --- | --- |
| Unauthorized disclosure | `jobDisclosure=project; maximumDisclosure=project; outputDisclosure=restricted` → `output_disclosure_forbidden` | **passed** |
| Duplicate claim | Same Job replay → `job_already_claimed; status=succeeded`; duplicate Queue message acknowledged | **passed** |
| Post-Result credential invalidation | Reuse of the credential → `credential is invalid or revoked` | **passed** |
| Cancellation | `job:cancel-5899bda5-5861-486e-9c1f-f5ff4c33767c`; status `cancelled`; `credentialRevoked=true` | **passed** |
| Explicit revocation | `job:revoke-f375d20d-4e74-4d75-bd9f-8dc6e33fdaf9`; status `revoked`; stale credential rejected | **passed** |
| Retry | `job:retry-b1dca78e-63a4-49e6-b5db-f5f1d202e991` retried from cancellation and succeeded; R2 read-back digest matched | **passed** |

All residual Queue acknowledgements reported `ackCount=1`, `retryCount=0`,
with no warnings or errors.

## Host and timing receipt

```text
platform=darwin
arch=arm64
release=25.2.0
totalMemoryBytes=17179869184
freeMemoryBeforeBytes=73400320
freeMemoryAfterBytes=123863040
rssBeforeBytes=63832064
rssAfterBytes=96321536
processUserMicros=249869
processSystemMicros=39386
diskAvailableBeforeBytes=789397422080
diskAvailableAfterBytes=789396971520
networkBytes=not-observed
startedAt=2026-08-10T06:20:34.966Z
finishedAt=2026-08-10T06:20:48.828Z
elapsedMs=13862
visibilityTimeoutMs=30000
leaseExpiresAt=2026-08-10T06:50:34Z
```

These values are receipts for this run, not Anyam limits or SLOs. No budget was
added from them.

## Acceptance matrix

| Acceptance item | Decision |
| --- | --- |
| Queue message, lease, acknowledgement, duplicate handling | **passed** |
| Runner enrollment/key proof/scoped credential | **passed** |
| Lease, cancellation, revocation, credential invalidation, retry | **passed** |
| Exact Project View and input digests | **passed** |
| Unauthorized disclosure rejection | **passed** |
| Host CPU/memory/disk/output measurements | **passed; network not observed** |
| Attempt-scoped R2 output, read-back, digest verification | **passed** |
| Unchanged generic Target publication and duplicate upload rejection | **passed** |
| Provider failure/retry behavior | **passed for duplicate publication and fresh Runner retry** |
| Cleanup inventory | **passed; exact resources deleted and verified absent below** |

## Cleanup receipt

The exact disposable resources were deleted after this receipt was committed:

```text
R2 objects deleted:
outputs/job:live-0ff1b2d0-909c-428a-955d-72d7380064ec/artifact/anyam-live-runner.txt
outputs/job:retry-b1dca78e-63a4-49e6-b5db-f5f1d202e991/artifact/anyam-retry-runner.txt

Worker deletion: successful
Queue deletion: successful
R2 bucket deletion: successful
GitHub Target repository deletion: successful

post-delete Worker HTTP=404
post-delete Queue=absent
post-delete R2 bucket=absent
post-delete GitHub Target=absent
post-delete Worker secret list=Worker not found
```

The failed pre-bind Job `job:live-9b6c4fb9-68dc-43b9-bc00-a3616a840960` created
no R2 object; its Queue message was removed with the exact disposable Queue.
No canonical repository, production Target, user project, or credential was
touched.
