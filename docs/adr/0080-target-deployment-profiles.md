# Target Deployment Profiles

Status: Accepted

Issue: [#244](https://github.com/Whyme-Labs/anyam/issues/244)

## Context

Anyam intentionally keeps source, Releases, Targets, and Promotion separate.
The existing `anyam.target/v1` contract identifies an adapter and accepted
Artifacts, but it does not identify the runtime, routes, bindings, data
resources, or secret-use aliases owned by that Target. That makes it too easy
for a preview or staging Target to appear separate while silently sharing a
production-sensitive resource.

Cloud providers also distinguish infrastructure environments from release
channels. Anyam must preserve that distinction without importing provider
credentials or treating provider environment names as source branches.

## Decision

Every Authority-created Target carries a credential-free
`anyam.target-deployment/v1` Deployment Profile. Older snapshots are hydrated
with a deterministic isolated custom profile so the migration does not widen
authority or invent provider resources.

The profile records:

- `environment`: `preview`, `development`, `staging`, `production`, or
  `custom`;
- `channel`: `alpha`, `beta`, `stable`, or `custom`;
- audience and runtime identity;
- route, binding, and data-resource identities;
- configuration digests;
- secret-use aliases, never secret values;
- data class;
- resource-sharing mode and, for owner-approved sharing, a policy digest.

The profile digest is computed from the complete normalized profile. The Target
contract digest includes that profile, so a profile change invalidates any
Target-bound Release or Evidence that still carries the prior contract.

Two Targets in one Project cannot share a production-sensitive runtime, route,
binding, data, or secret-use identity across environment boundaries unless both
profiles explicitly carry `owner-approved` sharing and the same sharing-policy
digest. The check is conservative and reports the exact overlapping identity.

Promotion execution binds its immutable handoff digest to the Target Profile.
Provider result projections may omit the profile because the Authority-bound
Target remains the source of truth; when a provider returns one, its digest
must match the Authority profile.

## Consequences

- A Release may be promoted to multiple Targets without conflating their
  environment, audience, or resource boundaries.
- A Target owns its configuration/resource identity while the provider adapter
  owns only provider mechanics.
- Public and agent-facing projections can show profile digests and aliases
  without returning credentials.
- Gradual rollout policy remains a later extension; this profile is the
  prerequisite identity boundary, not a traffic-splitting implementation.

## Rejected alternatives

- **Environment branches:** branches describe source history and must not
  become deployment authority.
- **Provider-specific Wrangler configuration in the kernel:** this couples
  Anyam to one provider and exposes the wrong abstraction to package, device,
  model, and non-web Targets.
- **Credential values in Target state:** credentials belong to a broker and
  are never part of a Project Export, Authority snapshot, or receipt.
- **Silent shared resources:** a healthy preview must never touch production
  data because two Targets happen to use the same default binding.
