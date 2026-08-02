---
status: accepted
---

# Protect hybrid public/private Source Spaces with independent public lineages

Issue [#50](https://github.com/wms2537/anyam/issues/50) asked Anyam to make the
hybrid video-player promise executable: a public player can be cloned and
changed without exposing a private codec, while an owner may run a sealed
compatibility verifier and return only an approved result projection.

## Decision

### Public Project View Revisions

1. A public projection is a new `PublicProjectionRevision`, not a redacted
   `ProjectRevision`.
2. Its `lineageId`, `publicSnapshotId`, and `projectionRevisionId` are derived
   only from the public Project Profile, public Source Space snapshots, and
   disclosed public file content. A private-only canonical revision change must
   not change the public projection identity.
3. The public manifest contains only public Source Space descriptors, public
   snapshot identities, public paths, and public content. It contains no
   canonical Project Revision ID, private Source Space ID, private path, object
   metadata, contributor metadata, or hidden-test metadata.
4. A public clone is materialized into a separate Git repository through the
   `RepositoryDriver`. The destination must be empty, and the materializer
   writes only the authorized projection before creating the public commit.
5. The existing kernel `ProjectView` remains the canonical internal
   change-control view. The public projection contract is separate so internal
   Landing can retain canonical identity without leaking it to a public
   audience.

### Audience-specific Change review

6. A cross-space Change has one authoritative Change Revision but receives an
   audience-specific `AudienceChangeSummary`.
7. A public summary requires the exact public projection it describes. It uses
   a derived public Change and revision identity, a maintainer-supplied public
   summary, public effects, and only public Evidence projections. Private IDs,
   paths, effects, and raw Evidence are omitted.
8. Anyam does not infer or enforce that a public projection is functionally
   complete. The owner supplies the public summary and any Project Profile
   Evidence; disclosure integrity is the invariant owned by this boundary.

### Sealed Verifiers

9. A `SealedVerifierContract` explicitly declares accepted input, private
   Source Spaces, permitted audiences, disclosure class, side-channel policy,
   appeal policy, and contract digests.
10. A Sealed Verifier receives the exact public projection, Change Revision,
    and owner-selected private inputs through a private execution callback.
    Public callers cannot select, inspect, or alter the private implementation
    or fixtures.
11. The returned `SealedVerificationResult` contains only the contract's
    approved status, safe summary, or redacted findings. Private receipts,
    private paths, private input digests, exact timing, exact test counts,
    cache state, and resource usage are not returned to a public audience.
12. The resulting Evidence binds the public projection, Change Revision,
    verifier contract, private input digests, policy, actor, runner, and
    authorization epoch. It becomes stale when any declared input or policy
    changes.
13. Appeals refer to the exact public projection and sealed Run. An appeal may
    request maintainer review or a deterministic rerun, but it cannot escalate
    a public caller to raw private Evidence.

### Publication and revocation

14. A `PublicationChange` creates or extends an independent public lineage with
    curated history by default. It requires a disclosure preview before
    approval and Landing.
15. Publication preview checks structural disclosure only. It carries an
    explicit warning that no universal build, behavioral, or completeness claim
    is being made.
16. Landing makes the public lineage immutable. Revocation blocks future
    distribution but retains the published lineage and cannot erase existing
    clones, mirrors, or previously disclosed history.

## Consequences

- A public contributor can use ordinary Git against a safe public repository.
- A private codec can evolve independently while unchanged public source keeps
  the same public projection identity.
- Public Change review can be useful without treating private implementation
  details as a hidden CI log channel.
- The owner remains responsible for declaring what a public Project Profile
  promises; Anyam enforces the boundary and provenance rather than inventing a
  universal definition of “works.”
- Repository providers remain replaceable because public materialization uses
  the existing `RepositoryDriver` boundary.

## Rejected alternatives

- **Visibility toggle on the canonical repository:** private history and Git
  object reachability make it unsafe and non-reversible.
- **Redacted canonical revision manifest:** the canonical revision identity can
  correlate private-only changes and expose hidden state.
- **Sparse checkout, partial clone, or hidden refs:** these optimize transfer
  or hide UI state; they do not create a safe public object graph.
- **Returning raw private CI output:** paths, test names, timing, and traces
  disclose the private implementation or data.
- **Claiming every public projection must build or work:** Anyam supports
  different project types and owner-declared Profiles; no universal functional
  completeness predicate exists.
- **Making revocation erase the public lineage:** existing clones and mirrors
  cannot be made private after disclosure; revocation is necessarily
  prospective.
