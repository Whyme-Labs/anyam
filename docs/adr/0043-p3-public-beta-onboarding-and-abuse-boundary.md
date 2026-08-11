# ADR 0043: P3 public-beta onboarding and abuse boundary

- Status: Accepted
- Date: 2026-08-08
- Issue: [Prototype the minimum public-beta onboarding and abuse-control journey](https://github.com/Whyme-Labs/anyam/issues/102)
- Depends on: [ADR 0019](./0019-bootstrap-onboarding-import-and-recovery.md), [ADR 0023](./0023-receipt-backed-costs-quotas-and-packaging.md), [ADR 0032](./0032-hybrid-public-private-projections-and-sealed-verifiers.md), [ADR 0039](./0039-customer-operated-installation-control-path.md), [ADR 0040](./0040-realm-owned-agent-actors-and-human-to-agent-delegation.md), [ADR 0042](./0042-p3-realm-local-identity-and-federation-boundary.md)

## Context

P3 needs a technical-user-first path that can be operated by a customer in its
own Cloudflare account. The path must cover installation, recovery, owner claim,
team or agent invitation, public/private Project creation, and contribution
without making Anyam a finished social network or requiring a global account.

Public contribution is a particularly dangerous boundary. An anonymous clone or
contribution request must not become a canonical write, a private Source Space
read, or an unmeasured public quota. A numeric limit without a measurement receipt
would be a landmine; a denial that only says “rate limited” would be unusable by a
developer or agent. Suspension and cleanup must stop abuse while preserving
accepted work, lineage, recovery, and auditability.

The prototype for this decision was validated on the throwaway branch
`codex/prototype-102-public-beta-onboarding` at commit `d72a38c` and explicitly
approved by the project owner. It exercised healthy onboarding, abuse-shaped
traffic, restart/recovery, moderation, and cleanup. The prototype did not claim a
live Cloudflare gateway or a universal definition of functional “works”.

## Decision

P3 public beta uses the following end-to-end path:

```text
customer-operated install
        ↓
visible Recovery Checkpoint and owner claim
        ↓
Realm-local team/agent identity and Capability Grants
        ↓
Project with independently governed public/private Source Spaces
        ↓
explicit Public Intake policy (closed by default)
        ↓
public clone or contribution request at the destination Realm
        ↓
quarantine and disclosure-safe Change input
        ↓
normal Change review, verification, and Landing policy
        ↓
Release and Target promotion remain separate
```

### Onboarding and recovery

The existing `CustomerRealmControlPlane` remains the owner of installation,
provider authorization receipts, Recovery Checkpoints, owner claim, and recovery
activation. A customer-operated installation stores no provider credential. A
restart or recovery restores a visible checkpoint and revoked sessions; it does
not imply that a Project is partially or silently activated. Owner enrollment
requires an adapter-verified passkey or OIDC identity and an external recovery
enrollment receipt.

After owner claim, the Realm owner can invite local principals, teams, and Realm-
owned agent Actors. The existing Realm-local identity and delegation rules apply;
no Federation or Anyam-hosted account is required.

### Public and private Projects

Project creation may include a public Source Space, private Source Space, or both.
The public clone is a safe Project View/projection. It contains no private Source
Space identifiers, paths, object IDs, Change metadata, agent context, or sealed
test implementation. Anyam does not enforce a universal claim that a public
projection “works”; owners declare profiles and actions, and Anyam enforces
disclosure integrity and declared policy.

### Public Intake

`PublicIntakeController` owns only the destination-Realm public contribution
boundary. It is not a second Landing service and does not read private source.
Its protocol is `anyam.public-intake/v1`.

Public Intake is closed until an owner explicitly opens it. It has two policy
modes:

1. **Rate-limited**: requires a positive measured limit, measurement time, method,
   and receipt. The implementation must not invent a launch default. A request
   beyond the configured tripwire is denied without materialization.
2. **Approval-only**: accepts a request envelope into an owner/moderator review
   queue without claiming a numeric quota. Approval is required before it becomes
   an accepted quarantined Change input.

In both modes, an accepted request is quarantined. It may proceed to disclosure
checks and a Change Revision, but it never receives canonical Landing authority.
Landing remains owned by the normal Change coordinator and trusted Landing
service.

Every denial contains the policy/limit or state boundary, configured limit when
applicable, requested and consumed counts, receipt, and next recovery action.
Every missing measured limit fails closed and tells the owner to measure a healthy
workload or select approval-only mode. This is an operational tripwire, not a
claim that the synthetic fixture limit is production capacity.

### Moderation and suspension

An owner or moderator may suspend Public Intake with a reason and receipt. While
suspended, requests are denied and not materialized. Reopening requires an
explicit review receipt. A suspension does not delete accepted Changes,
contribution envelopes, Project lineage, recovery state, or audit events.

### Cleanup and deletion

Cleanup closes Public Intake, clears pending review work, and may delete only
disposable preview, queue, session, or other explicitly ephemeral resources via
idempotent resource-specific cleanup operations. It must preserve canonical
repositories, accepted Changes and Revisions, Project Exports, Recovery
Checkpoints, audit history, and public publication lineage. It must never delete
previously published public history or credentials as a side effect of a public
intake cleanup request.

### Durable ownership boundaries

The implementation keeps state ownership obvious:

| Concern | Existing owner |
| --- | --- |
| Install, owner claim, recovery | `CustomerRealmControlPlane` |
| Public contribution state, moderation, measured policy | `PublicIntakeController` |
| Public/private projection and disclosure | hybrid disclosure / Project View boundary |
| Change quarantine, review, and Landing | `LocalChangeCoordinator` and Landing service |
| Release and Target promotion | release/promotion services |

This avoids duplicating installation, disclosure, or Landing state inside public
intake.

## Consequences

- A technical user can install and recover a customer-operated Realm without a
  hosted Anyam account.
- The first Project can be fully open, hybrid public/private, or closed without
  changing the Git-compatible Project model.
- Public contribution is useful without pretending that anonymous users can write
  canonical refs or inspect private implementation.
- Rate limits are receipt-backed and visible; approval-only mode is available when
  no honest measurement exists yet.
- Moderation and cleanup are reversible at the source-history level and do not
  destroy provenance.
- The protocol is ready for a real gateway adapter, while the current qualification
  remains provider-neutral and deterministic.
- Provider-specific anonymous abuse controls, live edge rate limiting, and a real
  moderation UI remain separate qualification work; they are not silently claimed
  by this contract.

## Rejected alternatives

- **Implicitly open anonymous push:** gives an untrusted request a canonical write
  path and collapses Public Intake into Landing.
- **A fixed launch quota without a receipt:** creates a landmine and makes the
  number untrustworthy across providers and workloads.
- **Require every public contribution to pass a universal “works” test:** Anyam
  cannot formally define functional completeness for every project type; owners
  declare profiles and actions instead.
- **Delete history when suspending or cleaning up:** destroys recovery, attribution,
  and published lineage and cannot make public history private again.
- **Require Realm Federation or a global Anyam account:** expands trust and
  operational scope before the P3 journey needs it.
- **Build a social-network moderation system first:** delays the smallest useful
  technical-user path and is not required to preserve the source-control boundary.
