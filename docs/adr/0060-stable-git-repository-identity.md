# ADR 0060: Stable Git Repository identity independent of checkout path

- Status: Accepted
- Date: 2026-08-20
- Scope: local Git inspection, Change metadata, Workspace materialization, export/restore

## Context

The local Git adapter previously derived `repositoryId` from the absolute
checkout path. Moving a checkout or cloning it again therefore changed the
identity of the Repository. The private-alpha qualification also removed
`baseRepositoryId` before publishing, which made the qualification bypass the
binding it was intended to prove.

## Decision

Repository identity is logical, not filesystem-based.

1. A committed Anyam Project manifest may declare a stable `repositoryId`.
2. Existing Git repositories without that field derive a versioned identity
   from object format plus the sorted root-commit lineage.
3. The local checkout path remains an operational attribute and never enters
   the identity digest.
4. Change metadata records the identity basis and receipt. A Change Revision
   must preserve the exact Repository identity, commit, tree, ref, and object
   format observed by its Workspace.
5. Trusted Workspace materialization must explicitly map the canonical logical
   Repository to the Workspace checkout. An unrelated checkout fails closed.

## Consequences

- Moving or recloning a repository preserves its logical identity.
- A repository with no committed root cannot claim a Git-bound identity.
- Manifest identity changes are a source change and therefore create an
  explicit repository-binding mismatch for existing Changes.
- Provider adapters may replace the local identity basis with their own stable
  Repository ID, but must report the basis and receipt.
- Existing path-derived metadata requires an explicit migration or a fresh
  Change; it is never silently treated as equivalent.

## Verification

- Move and reclone fixtures produce the same Repository ID with different
  checkout paths.
- The private-alpha journey preserves `baseRepositoryId` and verifies it
  against the Workspace source.
- An unrelated checkout is rejected before Change Revision publication.
- Export/restore preserves the logical identity and identity basis.
