---
status: accepted
---

# Separate Project Revisions from capability-safe Project View Revisions

A canonical Project Revision is the complete authoritative manifest of exact Source Space Snapshots, while each audience receives a Project View Revision derived only from the Snapshots and metadata it may discover. This prevents private-only state from changing public identifiers, activity, caches, or timing, and lets one cross-space Change land atomically without publishing a redacted full manifest.

## Consequences

- Project View projection is intentionally non-injective: several Project Revisions may produce the same unchanged Project View Revision.
- A named Project Profile is discoverable only when the Actor and, for agents, the model provider may access every selected Source Space; Anyam does not silently return a weaker profile.
- Source Space Git object graphs are hard boundaries, mounts cannot overlap, and inaccessible state is omitted rather than represented by placeholders or permission failures.
- The canonical Project Revision manifest owns cross-space atomicity. Per-repository Git refs, search indexes, caches, and activity views are derived compatibility state that can be repaired idempotently.
- Anyam validates disclosure closure across a Project Profile but does not claim that a universal test can prove the profile useful, complete, or runnable.
- Revocation prevents future access but cannot erase cloned source, and publication creates a reviewed less-restricted lineage rather than toggling access on private history.

## Rejected alternatives

- A redacted full Project Revision or identifier would leak correlation with hidden state.
- Sparse checkout, partial clone, hidden refs, and permission errors do not create a safe public object graph.
- Combining the latest commit from each repository cannot identify one coherent Project state.
- Implicit filesystem overlays make path ownership and cross-space Changes ambiguous.
