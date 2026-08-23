# Target promotion safety

Status: Accepted

Source: 2026-08-22 repository audit feedback

## Context

Target deployment profiles are part of Anyam's provider-neutral authority
model. A Target can nevertheless be pointed at a shared route, binding, data
resource, runtime, or secret-use capability. Treating staging as safe merely
because it is not named `production`, or accepting two unrelated approval
digests as equivalent, turns the profile into documentation rather than a
boundary.

Legacy Target records also lack the configuration digest needed to prove that
the provider-facing Target was intentionally assembled.

## Decision

Resource identity overlap is rejected unless both Targets explicitly declare
`resourceSharing=owner-approved` and carry the same non-empty
`sharingPolicyDigest`. The comparison is Realm-wide, not limited to one
Project, because physical provider resources can be shared across Projects.

A Target without a complete profile remains readable for inspection and
recovery, but cannot enter Promotion. A complete profile must carry at least
one configuration digest. Custom environments and data classes remain
explicit metadata; migration and production-safety checks treat them as
unknown risk rather than as safe defaults.

## Consequences

- Isolated preview, staging, and production Targets cannot silently share
  resource identities.
- Owner-approved sharing is a real digest equality check rather than two
  independent declarations.
- Older Targets require an explicit configuration step before Promotion.
- Existing exports remain readable because the profile is not removed from the
  inspection model.

## Rejected alternatives

- **Only compare Targets in one Project:** physical Cloudflare resources can
  cross Project boundaries.
- **Treat non-production as isolated automatically:** staging can contain
  production-shaped data or production bindings.
- **Accept any owner-approved label:** approval is a policy identity and must
  match exactly.
