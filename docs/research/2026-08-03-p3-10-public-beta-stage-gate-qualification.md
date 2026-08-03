# P3-10 public-beta Stage Gate and operational receipts qualification

Date: 2026-08-03  
Issue: [Qualify the P3 public-beta Stage Gate and operational receipts](https://github.com/wms2537/anyam/issues/87)  
Protocol: `anyam.p3-stage-gate-qualification/v1`  
Status: ready with bounded provider and tenant advisories; not a universal-support claim

## Question

Does the default Qualification Plan name the current P3/public-beta journey,
require the newly qualified customer-install and agent-delegation boundaries,
and produce one executable Stage Gate decision with operational receipts,
recovery drills, measured budgets, and explicit Residual Risk decisions?

## Qualification receipt

```text
protocol=anyam.p3-stage-gate-qualification/v1
stage=public-beta
status=ready
blockers=0
advisories=3
evidence=9
providerFeed=unavailable; advisory-only; invoice-not-invented
residualRisk=provider-fallback:deferred; tenant-isolation:deferred
recovery=mirror-divergence;credential-compromise;restore
budget=within_budget; measured-requested-and-consumed
criteria=team-review;agent-delegation;public-contribution;multi-realm;customer-install-control;repository-fallback;two-way-mirror;external-runner;npm-target
providerCoverage=bounded
universalSupport=false
```

## Qualification method

`test/public-beta-stage-gate.test.ts` instantiates the default
`QualificationRegistry` and records:

- every default K0, private-alpha, and public-beta Acceptance Criterion;
- the public-beta agent-delegation and customer-install-control criteria;
- Reliability Objectives with measured targets, error budgets, sources,
  methods, and receipts;
- Usage Receipts and an explicit unavailable Provider Cost Receipt;
- within-budget Budget Policy and Budget Decision records;
- all default Stage recovery kinds for K0, private-alpha, and public-beta;
- accepted prior-stage risks and deferred public-beta provider/tenant risks.

The harness activates and completes K0, then private-alpha, then public-beta.
The public-beta decision contains nine Evidence IDs, zero blockers, one
provider-feed advisory, and two Residual Risk advisories. The test prints the
receipt so a human or agent can see exactly why the gate is ready and what it
does not claim.

This is a deterministic local qualification registry. It replays the evidence
and operational shape of the preceding P3 receipts; it does not turn a local
fixture into a live GitHub App, Cloudflare account, WebAuthn/OIDC provider,
external Runner host, npm billing feed, or universal tenant-isolation proof.

## Commands run

```text
npx tsx --test test/public-beta-stage-gate.test.ts — 1 passed
npm run typecheck — TypeScript clean
npm test — 105 passed
npm run check:realm — full check and Wrangler Worker dry-run passed
git diff --check — clean
```

## Boundary and residual risk

The Stage Gate is `ready` under the accepted QualificationRegistry policy
because all required records are present and no blocker remains. That status
does not erase the three advisories:

1. provider cost reconciliation is not current in the deterministic harness;
2. provider fallback coverage remains deferred; and
3. live customer-account tenant-isolation qualification remains deferred.

The existing qualification receipts for GitHub mirroring, external pull
Runners, package Targets, public contribution, customer installation control,
multi-Realm identity, and Realm-owned agent delegation remain bounded by their
own provider and adapter boundaries. A public-beta launch must review these
advisories, select the intended customer cohort, and attach live provider
receipts before claiming broader operational coverage.
