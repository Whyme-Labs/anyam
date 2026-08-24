# Anyam Worker Target live qualification

Date: 2026-08-24
Protocol: `anyam.cloudflare-worker-target-qualification/v1`
Cloudflare account: `1e0170aaabc90ecf5f466128d1f0466a` (`swmengappdev`)
Worker: `anyam-worker-target-qualification-20260824155441`

## Result

The owner-run disposable Cloudflare Worker Target qualification succeeded.

```text
healthyPromotion.state=healthy
failingPromotion.state=rolled-back
failingPromotion.health=unhealthy
failingPromotion.rollbackHealth=healthy
canonicalWrite=false
credentialValues=not-printed
cleanup.status=succeeded
```

Healthy Release digest:

```text
sha256:1ccd5997c93186c04c1dae16282568f23883bafa779a927e82b57ea95a68833f
```

The qualification exercised preview and production route-readiness handling,
transient 404/503 retries, immutable Release promotion, unhealthy candidate
rollback, and health verification of the previous known-good Release.

## Cleanup

```text
scriptName=anyam-worker-target-qualification-20260824155441
cleanup=worker-deleted
attempts=1
maxAttempts=3
retryableStatuses=408,409,425,429,5xx
credentialMaterialStored=false
```

## Boundary

This is a disposable single-Worker provider receipt. It does not qualify the
multi-resource Cloudflare golden path, three isolated Targets, migrations,
export/restore, or production SLOs. Those remain open in issue #273.

## Local follow-up

The repository now has a deterministic multi-resource Worker fixture and
sealed staging/production Target test in
`test/cloudflare-golden-path.test.ts`. The Worker adapter also requires
module/main-module read-back, verifies declared binding and asset fields,
verifies Durable Object migration tags, and supports an explicit
Evidence-gated `staging-only` preview strategy for Workers without version
preview URLs. The deployed Promotion executor can resolve multiple Target
routes from `ANYAM_PROMOTION_TARGET_ROUTES`, with one customer-owned secret
binding per route.

These are local receipts only. The live issue remains open until the same
fixture is run with customer-owned D1/R2/KV/Queue/DO/service resources across
isolated preview, staging, and production Targets, followed by migration,
rollout, rollback, export, restore, and operations evidence.
