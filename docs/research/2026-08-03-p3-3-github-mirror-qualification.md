# P3 public beta: GitHub mirror qualification receipt

**Date:** 3 August 2026
**Ticket:** [#83](https://github.com/Whyme-Labs/anyam/issues/83)
**Status:** passed with bounded recovery qualification

## Decision

Anyam's bidirectional RepositoryMirror contract is qualified for the
public-beta GitHub contribution path at the transport and coordinator boundary
tested here:

```text
verified public canonical projection
        ↓
GitHub public mirror (mapped refs only)
        ↓
remote fast-forward
        ↓
attributed Anyam Change proposal
        ↓
normal Landing path
        ↓
healthy mirror boundary
```

GitHub remains an external mirror and contribution surface. Anyam remains the
canonical Project Revision authority. A remote commit is never treated as
approval or canonical Landing.

## Live provider receipt

The qualification used a disposable public GitHub repository created for this
run:

- Repository: [Whyme-Labs/anyam-p3-mirror-20260803](https://github.com/Whyme-Labs/anyam-p3-mirror-20260803)
- Transport: git+ssh for Git push; gh api for authenticated GitHub API observation
- Credential material: not read by the harness
- Anyam project: project:video-player
- Anyam Source Space: source:community
- Mirror disclosure: public
- Ref mapping: refs/heads/main → refs/heads/main
- Unmapped canonical ref: refs/heads/private-codec (not forwarded)

The disposable repository was seeded and then exercised through these exact
Git commit generations:

```text
seed:     25be953995f3f3f8d71062f2a53c22502e404b41
outbound: 451ecc09e5648c6f9d5b0a941afb7dc31740cb42
inbound:  180d5642a14ecabd595229bea819c7bca1c44662
```

The live harness produced:

```text
protocol=anyam.live-github-mirror-qualification/v1
status=passed-with-bounded-recovery
outboundState=healthy; remoteHead=451ecc09e5648c6f9d5b0a941afb7dc31740cb42
idempotentOutboundPushes=1
inboundState=lagging; inboundChanges=1; origin=github
duplicateInboundChangeInputs=1
postLandingState=healthy; pendingInbound=0; remoteHead=180d5642a14ecabd595229bea819c7bca1c44662
privateRefsForwarded=false; mappedRefs=refs/heads/main
providerReceipt=github-api; repository=Whyme-Labs/anyam-p3-mirror-20260803; generations=seed->outbound->inbound
```

The inbound Change carried the exact mirror origin:

```text
source=github
remoteRepository=Whyme-Labs/anyam-p3-mirror-20260803
remoteRef=refs/heads/main
remoteCommit=180d5642a14ecabd595229bea819c7bca1c44662
disclosure=public
baseProjectRevisionId=project-revision:outbound
```

The same inbound delivery was submitted twice with the same idempotency key;
the Change sink received one proposal. After the Change was represented as the
new canonical revision, the mirror returned to healthy without an outbound
second push.

The disposable GitHub repository was deleted after the receipt run. It is not
an Anyam production mirror or a retained test fixture.

## Deterministic recovery receipt

The provider-independent coordinator suite was run after the live qualification:

```text
npx tsx --test test/mirror.test.ts
5 tests passed; 0 failed; 0 skipped
```

The five passing cases cover:

1. outbound public-ref projection, private-ref exclusion, loop provenance, and
   idempotency;
2. remote fast-forward becoming an attributable Change that waits for
   Landing;
3. force-push and two-sided divergence becoming durable explicit
   reconciliation states;
4. credential failure retaining a checkpoint and resuming without losing the
   outbound operation;
5. public Mirror and inbound Disclosure-boundary rejection.

These cases qualify the Anyam coordinator and adapter seam. They do not claim
that a live GitHub App, webhook delivery, rate-limit behavior, branch
protection interaction, or provider-side credential failure has been
production-qualified.

## Public-beta boundary

The qualified path is intentionally bounded:

- Anyam owns the canonical Project Revision, Change identity, Disclosure
  policy, Evidence, review, Landing, and recovery state.
- The mirror maps one Source Space and an explicit ref set.
- Outbound state must be a verified public canonical projection.
- Inbound remote state is untrusted and becomes a local Change proposal.
- Remote rewrites, deletions, divergence, and provider failures require an
  explicit reconciliation or resumable recovery action.
- A provider result without an exact generation and receipt is blocked.

The following remain open qualification work rather than hidden assumptions:

- GitHub App installation and webhook delivery using a narrowly scoped
  adapter identity;
- webhook replay, ordering, redelivery, and signature verification;
- GitHub branch-protection and required-check interactions;
- GitHub API and Git transport rate-limit/backoff behavior;
- live provider credential rotation and credential-failure recovery;
- retained mirror recovery after a provider outage or repository recreation.

Those paths must produce their own receipts before Anyam treats them as
production-ready. No unmeasured provider limit is introduced by this result.
