# Worker Release Promotion and rollback

Status: Accepted

Issue: [#51](https://github.com/wms2537/anyam/issues/51)

## Context

The local execution lane now produces a ready `anyam.release/v1` from the
Worker fixture. That Release is a statement about an immutable Project
Revision, typed Artifacts, Evidence, configuration, state assumptions, and
policy. It is not a deployment, and it must not be rebuilt from a moving
branch when a Target changes.

The first Worker Target needs a provider-neutral Promotion contract that can be
qualified locally before it is connected to Cloudflare. The authority must
remain in Anyam: a provider may deploy a version and report health, but it may
not move the authoritative Target pointer, bypass policy, or turn an unverified
provider response into a successful Promotion.

## Decision

### Seal the Release before Promotion

`sealVerifiedRelease` creates a detached `anyam.verified-release/v1` snapshot.
It verifies that:

- the Release is `ready`;
- every declared Artifact and Evidence record is present exactly once;
- every Artifact belongs to the Release's exact Project Revision and is
  accepted by the Worker Target;
- every Release Evidence record passed for that same Project Revision; and
- Target-required Evidence is bound to the Target as well as the revision.

The snapshot carries a digest over the Release, Artifacts, Evidence, Target
contract digest, and Project identity. Adapters receive this snapshot rather
than mutable source or a moving ref. Mutating the caller's Release after it is
sealed cannot change the snapshot or its digest.

### Target state is Anyam-owned

A Worker Target extends the base Target contract with:

- its current Release pointer;
- append-only known-good Release history;
- explicit preview, Promotion, health-check, and rollback capabilities; and
- a Target contract digest.

The coordinator is the only owner of the current Release pointer and Target
health state. The adapter's provider version, deployment ID, and operation ID
are receipts, not authority.

### Promotion is an explicit state machine

The authoritative state transitions are:

```text
proposed → validating → approved → applying → healthy
                                  ├────────→ failed
                                  ├────────→ blocked
                                  └────────→ degraded → rolled-back
```

`failed` means a provider operation failed before Anyam could accept a Target
transition. `blocked` means a declared capability, contract, or policy
precondition is unavailable. `degraded` means the provider may have changed
state or health could not be verified. Every terminal or recoverable state
retains a receipt and recovery action.

Each transition is an append-only Promotion Event carrying the Promotion,
attempt, actor, idempotency key, operation ID, state transition, and provider
operation receipt. A duplicate idempotency key returns the original record and
does not invoke the adapter again.

### Preview and production use the same Release

The adapter must echo the sealed Release digest and Artifact digests in preview
and deployment results. Any mismatch is a provider-result failure; the
coordinator never silently substitutes a rebuilt Artifact. The production path
is therefore:

```text
ready Release
  → preview the sealed Artifact set
  → apply those same Artifact digests
  → health-check that provider version
  → update the Anyam Target pointer
```

There is no branch checkout or rebuild inside Promotion.

### Health failure preserves the previous known-good Release

The coordinator does not update `currentReleaseId` until the desired Release's
health observation is `healthy` and is bound to the desired Target and Release.
If health is `unhealthy`, `unknown`, mismatched, or the health provider fails,
the Target enters `degraded` and the failure remains on the Promotion record.

When a previous known-good Release and rollback capability exist, the
coordinator invokes the adapter's rollback operation and health-checks the
previous Release. Only a healthy rollback produces `rolled-back` and returns
the Target to `healthy`. If rollback or rollback health is not verified, the
Target remains `degraded`; Anyam does not claim recovery merely because a
provider accepted a request.

An explicit operator rollback is a new `kind=rollback` Promotion with its own
idempotency key, Evidence boundary, actor, events, and health check. It never
rewrites Release or Promotion history.

### Retry is a new attempt on the same Promotion

`retryPromotion` is allowed only for `failed`, `blocked`, `degraded`, or
`rolled-back` records. It increments the attempt, rebinds the expected current
Target pointer, requires a new idempotency key, and reuses the same immutable
Release digest. It does not rebuild or mutate the Release.

### Provider adapter boundary

The Worker adapter owns only provider mechanics:

```text
preview(verified Release)
apply(verified Release)
health(provider version)
rollback(previous verified Release)
```

It returns normalized results with provider receipts. It cannot grant source
access, read secrets, approve a Change, move the Anyam Target pointer, or
declare its own operation authoritative. Cloudflare Workers is a future
adapter qualification; the local scripted adapter proves only the Anyam
contract and state machine.

## Consequences

- Source Landing, Release creation, Target mutation, and health state remain
  visibly distinct.
- A failed health check leaves the prior Release serving from Anyam's point of
  view and records the attempted Release, failing observation, rollback result,
  and recovery action.
- Provider retries are safe to reconcile because every operation has an
  idempotency key and an authoritative Promotion record.
- The same Release can later be promoted to more than one Target without
  rebuilding or changing its lineage.
- Cloudflare-specific deployment mechanics remain behind a replaceable adapter
  and require their own qualification receipt before becoming a Stage
  dependency.

## Rejected alternatives

- **Rebuild during Promotion:** breaks immutable Artifact lineage and makes
  preview evidence irrelevant.
- **Let the provider own `currentReleaseId`:** turns an external API response
  into Anyam authority and makes recovery/audit ambiguous.
- **Treat a successful deploy request as healthy:** provider acceptance is not
  runtime health evidence.
- **Rewrite the Target pointer for rollback:** hides the operational event and
  makes rollback impossible to audit or retry.
- **Promise universal rollback:** some Targets or external state are not
  rollbackable; unsupported capabilities must remain explicit.
- **Use local process success as deployment proof:** local execution validates
  the Release assembly, not a Cloudflare Target or production runtime.
