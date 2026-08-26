# Use stable Changes and compare-and-swap Landing

Status: Accepted

## Context

Anyam must coordinate several human or agent workspaces that begin from the same canonical Project Revision and may finish in a different order. A branch name or mutable pull-request head is not enough to preserve the identity of work across review iterations and rebase. A direct push or last-writer-wins merge would allow a stale Workspace to overwrite a newer canonical state.

The state-machine question was exercised by the throwaway TypeScript prototype on branch [`codex/prototype-change-landing-state-machine`](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-change-landing-state-machine), commit `c637c08`, and accepted by the owner after review in ticket [#13](https://github.com/Whyme-Labs/anyam/issues/13).

## Decision

1. An Intent may create a stable Change. A Change may have one Workspace at a time in the prototype, and the Workspace records the exact base Project Revision and Actor.
2. A Change Revision is immutable and records its Change, Workspace, base Project Revision, participating Source Space Snapshots, affected Source Spaces, effects, kind, and parent revision. Publishing a newer revision supersedes the prior candidate for Landing but never erases it.
3. Claims are soft coordination signals over declared scopes. Overlap is visible as a warning and does not automatically lock or block work. Anyam does not pretend a claim is exclusive authority.
4. Reviews attach to the exact latest Change Revision. Publishing or rebasing a new revision invalidates prior approval for that Change until policy-required review is recorded again. A request for changes leaves the Change inspectable and not ready to Land.
5. An Integration Cohort explicitly names Changes, their selected Change Revisions, and one base Project Revision. It detects effect conflicts, stale bases, and overlapping claims. Effect conflicts and stale bases block Landing; claim overlap is a warning unless a Project policy raises the requirement.
6. Landing is an atomic compare-and-swap transition: the cohort base must still equal the canonical Project Revision, all blocking Conflicts must be resolved, and required review, Evidence, and policy decisions must be satisfied. On success, Anyam creates one new canonical Project Revision containing the composed Source Space Snapshots. Canonical Git refs are derived and reconciled afterward; they do not define success.
7. If the canonical Project Revision advanced, Landing fails explicitly and does not partially write any Source Space. Rebase materializes a new Workspace/View, transfers the stable Change to that lineage, and publishes a new Change Revision; it does not mutate the old Workspace or revision or silently repair a stale cohort.
8. A Revert Change is a new Change with new revisions and new review/Landing. It restores selected state without deleting, rewriting, or hiding the original landed Change or its Audit Events.

## Consequences

- The user-facing Change page can preserve discussion, review, and intent while showing each immutable revision and its exact base.
- Concurrent work is allowed; only the transition into canonical state is serialized by the Project Revision compare-and-swap.
- A stale candidate fails loudly and gives the Actor a specific next action—rebase and reverify—rather than silently merging against a different base.
- Integration Cohorts are a first-class place to explain cross-Change effects and warnings before Landing.
- A simple Project can still use a one-Change shortcut, but the underlying state remains Intent → Workspace → Change Revision → review/Evidence → Cohort → Landing.
- Revert has normal review and policy semantics. Operational rollback may use a previously built Release, but source history is never rewritten to simulate recovery.

## Rejected alternatives

- **Mutable Change head as the only record**: loses review provenance and makes force-push/rebase ambiguous.
- **Last-writer-wins Landing**: permits stale Workspaces to overwrite newer canonical state.
- **Claims as hard locks**: blocks useful parallel work and does not resolve semantic conflicts.
- **Agent-selected conflict resolution**: an explanation is not a new Change Revision or policy decision.
- **Destructive revert by deleting or rewriting commits**: breaks auditability, mirrors, and reproducible Project Revisions.
