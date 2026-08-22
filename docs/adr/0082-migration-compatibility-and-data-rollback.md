# Migration compatibility and data rollback

Status: Accepted

Issue: [#248](https://github.com/Whyme-Labs/anyam/issues/248)

## Context

An Artifact digest describes a built output, but it does not say whether the
running application can safely overlap with the data schema it is replacing.
Free-form Release assumptions cannot distinguish an application-only rollback
from a data rollback, or prove that two versions can safely coexist during an
expand/contract migration. Treating an unknown migration as production-safe is
therefore a release-boundary landmine.

## Decision

Every Release carries an `anyam.migration/v1` Migration Plan. The plan records:

- strategy: `none`, `expand-contract`, `manual`, or `custom`;
- optional before and after schema digests;
- compatibility: `backward-compatible`, `bidirectional`, `forward-only`,
  `incompatible`, or `unknown`;
- rollback behavior: `safe`, `application-only`, `manual-data-action`, or
  `blocked`;
- exact migration Artifact identities;
- exact required Evidence keys; and
- a digest over the normalized plan.

The default no-migration plan is explicit and digestable. Expand/contract
plans require both schema digests and bidirectional compatibility. Sealing a
Release for a production Target fails closed for unknown or incompatible
compatibility, or for blocked rollback. Non-production Targets may carry an
unknown or application-only state, but the plan remains visible and is never
silently upgraded into production safety.

The plan is provider-neutral. It contains no credentials or provider-specific
database identifiers, and remains separate from the application Artifact and
Promotion pointer.

## Consequences

- Production Promotion has an explicit, inspectable migration safety gate.
- Application-only rollback is visible without pretending that data has been
  restored.
- Migration Artifacts and Evidence are bound to the exact Release lineage.
- Providers can implement migration execution later without changing the
  Release contract.
- Projects that cannot prove compatibility remain usable in non-production
  environments while production remains fail-closed.

## Rejected alternatives

- **Free-form `stateAssumptions`:** cannot be validated or joined to exact
  Evidence and Artifact identities.
- **Provider-specific schema fields:** make the Release non-portable and turn
  one provider's database model into Anyam's authority model.
- **Automatic rollback claims:** an application rollback does not undo data
  writes, so the system must preserve that distinction.
- **Silently blocking all non-production Releases:** would prevent useful
  migration work and previews; the safety boundary belongs at production
  sealing.
