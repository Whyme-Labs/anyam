# P3-14 public-beta onboarding and abuse boundary qualification

Date: 2026-08-08
Issue: [Prototype the minimum public-beta onboarding and abuse-control journey](https://github.com/Whyme-Labs/anyam/issues/102)
Protocol: `anyam.p3-public-beta-onboarding-abuse-qualification/v1`
Status: passed for the provider-neutral durable contract; live edge/provider qualification remains open

## Question

Can a technical user install and recover a customer-operated Realm, claim its
owner, create a public/private Project, and accept public contribution requests
without granting anonymous canonical write authority or inventing an unmeasured
quota?

## Qualification receipt

```text
protocol=anyam.p3-public-beta-onboarding-abuse-qualification/v1
status=passed-with-provider-neutral-boundary
ownerApproval=explicit
prototypeBranch=codex/prototype-102-public-beta-onboarding
prototypeCommit=d72a38c
durableProtocol=anyam.public-intake/v1
installation=customer-operated-control-plane
recovery=visible-checkpoint; sessions-revoked; credentials-restored=false
identity=realm-local; federation-required=false
publicProjection=destination-realm; private-source-not-materialized
acceptedContribution=quarantined; landing-authority=false
rateLimit=measured-policy-required; no-launch-default
approvalOnly=available-without-numeric-quota
moderation=suspend-and-review-receipt-before-reopen
cleanup=disposable-only; lineage-export-recovery-audit-preserved
denial=names-boundary-limit-request-receipt-recovery
```

The throwaway prototype exercised:

- a healthy install/owner-claim journey;
- an abuse-shaped contribution sequence and visible tripwire;
- simulated restart and Recovery Checkpoint reopening;
- moderation suspension and review-based reopen; and
- cleanup that closes intake while preserving contribution lineage and recovery.

The durable TypeScript contract keeps those concerns separate: installation and
recovery remain in `CustomerRealmControlPlane`; `PublicIntakeController` only
controls the destination-Realm contribution boundary; disclosure and Landing stay
with their existing owners.

## Commands and receipts

```text
npx tsx --test test/public-intake.test.ts — 4 passed
npx tsx --test test/customer-realm-control.test.ts — 4 passed
npm run typecheck — passed
npm test — 109 passed, 0 failed, 0 skipped
git diff --check — clean
```

The public-intake test fixture uses a measured synthetic tripwire of `3`
public-contribution requests per `fixture:event-window`, with receipt
`receipt:test-public-intake-limit` and method `controlled healthy/abuse fixture`.
That value is a test receipt only; it is not a production quota. Production rate
limits require a new workload measurement and receipt. The provider-authorization
expiry check now consumes the control plane's injected clock, so customer-install
receipts remain deterministic rather than drifting with wall-clock test dates.

## Boundary and residual risk

This qualification proves the TypeScript policy, state, denial, moderation, and
cleanup contracts. It does not prove a live anonymous Git gateway, Cloudflare
edge rate limiter, CAPTCHA/bot mitigation, abuse classifier, public moderation UI,
or provider-specific account quota. Those require a separate live adapter and
operational qualification before a public anonymous endpoint is opened.

The current contract intentionally does not decide whether a public projection is
functionally complete. It enforces disclosure, declared profiles/actions, and
Change/Landing boundaries only.
