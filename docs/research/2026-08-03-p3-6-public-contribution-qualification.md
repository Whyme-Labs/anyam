# P3 public beta: public contribution through a safe hybrid Source Space projection

**Date:** 3 August 2026
**Ticket:** [#86](https://github.com/Whyme-Labs/anyam/issues/86)
**Status:** passed with bounded public-projection qualification

## Decision

Anyam's public contribution boundary is qualified at the provider-neutral Git
and disclosure layer:

```text
private canonical Project Revision
        ↓
public Project View / independent public lineage
        ↓
public-only Git repository
        ↓
external contributor clone and commit
        ↓
public-only Change Revision
        ↓
safe public Change summary and Sealed Evidence
        ↓
compare-and-swap Landing
        ↓
public snapshot advances; private snapshot is unchanged
```

The contribution is a proposal, not a canonical write. The external commit is
imported as an explicit resulting public Source Space snapshot. The
`LocalChangeCoordinator` now requires an explicit snapshot map to name exactly
the Source Spaces materialized in the Change Workspace; extra, missing, empty,
or restricted entries fail closed.

## Qualification receipt

The fixture used the hybrid video-player Project with:

- public Source Space: `public-player`;
- restricted Source Space: private codec implementation;
- `LocalGitRepositoryDriver` public projection materialization;
- an external contributor clone with no credential supplied to the clone;
- one public file modification and Git commit;
- a public Change with external origin metadata and a public-only Workspace;
- a private Sealed Verifier returning only an approved safe summary; and
- Anyam compare-and-swap Landing.

The final run produced:

```text
protocol=anyam.public-contribution-qualification/v1
status=passed-with-bounded-public-projection
publicRead=anonymous-projection-clone; privateContent=not-materialized
externalCommit=3b7720e58a2c12533d902ac51a2be62f6498d5c7
change=change:d8f97312-d0e2-4ced-a586-5997017e1386
revision=change-revision:1a78992d-ad54-4929-9063-dfc584a161c9
landing=project-revision:8fe1d194-3b52-4195-ba5c-1158e04d0987
canonicalPrivateSnapshotPreserved=true
publicEvidence=passed
boundaryRejection=private-projection-request, private-workspace-mount, and private-revision-snapshot all rejected
universalBuildClaim=false; preview=disclosure-integrity-only
```

The public clone contained only `README.md`, `src/player.ts`, and Git
metadata. Reading `src/codec.ts` failed because the private file was never
materialized. The external commit added a public captions export, and the
resulting Change Revision named only the public Source Space snapshot.

## Safe Evidence receipt

The Sealed Verifier received the exact public candidate projection and private
codec input through its private callback. The public result returned:

- `status=passed`;
- an owner-approved safe summary;
- public Evidence bound to the candidate projection and Change Revision; and
- projection-bound opaque verifier and contract identities.

The public result did not contain the private Source Space ID, private file
path, private input digest, private receipt, or raw verifier contract ID. This
qualification found and fixed a real side channel: returning a private
verifier's descriptive ID or raw contract digest would have disclosed private
metadata even when the status and summary were safe.

## Boundary rejection receipt

The harness rejected all three attempted crossings:

1. requesting a projection containing the restricted Source Space;
2. mounting the restricted Source Space in a public Project View Workspace; and
3. publishing a Change Revision whose explicit snapshot map added a restricted
   Source Space to the public Workspace.

Each rejection preserved an actionable `HybridDisclosureError` or
`ChangeControlError`, did not create a destination Workspace, and omitted the
restricted Source Space ID from the serialized public-facing error.

## Deterministic gates

```text
npx tsx --test test/public-contribution.test.ts
1 test passed; 0 failed; 0 skipped

npm run check
95 tests passed; 0 failed; 0 skipped

npm run verify:package
create-anyam package entrypoint smoke passed for npm exec, npx, pnpm dlx, and bun x
```

## What this qualifies

- Public Source Space projection is an independent, safe Git object graph.
- External contributors can clone and commit against the public projection
  without receiving private Source Space content or metadata.
- Anyam can represent the external commit as a stable Change and immutable
  public-only Change Revision.
- Public Evidence and Change summaries disclose only the permitted audience
  projection.
- Public Sealed Verifier identifiers are opaque and projection-bound.
- Landing advances the public snapshot while preserving the private canonical
  snapshot.
- Boundary-crossing projection, Workspace, and revision requests fail closed.
- Anyam does not make a universal claim that the public projection builds,
  works, or is functionally complete; the owner supplies any such Project
  Profile claim and Evidence.

## What this does not qualify

This is a provider-neutral qualification. It does not claim:

- a live anonymous HTTPS Git gateway;
- a public GitHub/Codeberg contribution provider, webhook, or rate-limit lane;
- identity, abuse, moderation, spam, or quota controls for anonymous users;
- a public contribution build or universal functional-completeness guarantee;
- private verifier process isolation, network policy, or hostile workload
  containment; or
- production durable storage and multi-region Landing.

Those remain separate provider and Stage Gate receipts. The durable decision is
that public contribution is a safe projection-plus-proposal workflow, not a
visibility toggle or direct write path into the private canonical repository.
