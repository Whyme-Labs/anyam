# Private-alpha Worker Target live qualification supplement

## Provenance

This note records the successful `npm run qualification:worker-target` receipt
supplied by the account owner in the Anyam working session. It is not an
independent rerun from this shell; the provider output is preserved here as
operator-supplied live evidence and remains distinct from the local fixture
qualification in `2026-08-12-private-alpha-journey-qualification.md`.

## Receipt

The selected customer-owned Cloudflare account was:

    account=1e0170aaabc90ecf5f466128d1f0466a

The qualification reported:

    protocol=anyam.cloudflare-worker-target-qualification/v1
    status=succeeded
    scriptName=anyam-worker-target-qualification-20260811
    healthyPromotion.state=healthy
    healthyPromotion.releaseDigest=sha256:ac41d2e8ebf59e04fb36586abc9a3bcbfb051731713942f0f78aadd9922519b1
    failingPromotion.state=rolled-back
    failingPromotion.health=unhealthy
    failingPromotion.rollbackHealth=healthy
    targetReleaseId=release:healthy
    canonicalWrite=false
    credentialValues=not-printed
    providerFactsAreNotAnyamLimits=true

Route-readiness receipt:

    candidate.retryStatuses=[404]
    candidate.maxAttempts=10
    candidate.delayMs=1000
    candidate.retryTransportErrors=true
    rollback.retryStatuses=[404,503]
    rollback.maxAttempts=10
    rollback.delayMs=1000
    rollback.retryTransportErrors=true
    receipt=qualification-tripwire; preview-and-production-route-readiness;
      transient-transport-errors-retried;
      rollback-503-is-transient-only-after-known-good-release;
      remeasure-before-production

Cleanup receipt:

    cleanup.status=succeeded
    cleanup.scriptName=anyam-worker-target-qualification-20260811
    cleanup.attempts=1
    cleanup.maxAttempts=3
    cleanup.delayMs=1000
    cleanup.retryableStatuses=408,409,425,429,5xx
    cleanup.credentialMaterialStored=false

## Boundary

This receipt strengthens the provider-backed Worker Target boundary already
resolved in [Wayfinder #176](https://github.com/Whyme-Labs/anyam/issues/176): a
healthy immutable Release can be promoted, a failing candidate is rolled back,
rollback health is checked, and disposable provider state is cleaned up. It
does not establish universal Cloudflare support, capacity, latency, cost,
availability, or production SLOs. Any future numeric policy must be backed by
a fresh workload measurement receipt.
