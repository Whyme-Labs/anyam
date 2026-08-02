# Materialize composed Workspaces over Source Spaces

Status: Accepted

## Context

Anyam must let a developer or coding agent work on a Project whose source is split across independently governed Source Spaces. A commercial Project may, for example, expose a public player implementation and a private codec implementation as one coherent local filesystem. Flattening those spaces into one Git object graph would weaken the hard visibility boundary, while forcing the developer to coordinate several unrelated working directories would make ordinary editing and agent work needlessly difficult.

The local loop also needs to be fast and recoverable. A developer should see one status and diff, edits should be captured without ceremony, undo should not erase history, and a remote/local divergence must remain inspectable until someone chooses how to resolve it.

The composite filesystem question was exercised by the throwaway TypeScript reducer and terminal prototype on branch [`codex/prototype-composite-local-workspace`](https://github.com/wms2537/anyam/tree/codex/prototype-composite-local-workspace), commit `9afcc9d`, and accepted by the owner after review.

## Decision

1. A multi-Source-Space Workspace is materialized from one Workspace Repository per authorized Source Space, each mounted at an explicit path. A Source Space that is not in the current Project View is not materialized or discoverable through the Workspace.
2. Mounts must be collision-free before materialization. Anyam reports an explicit collision and leaves the existing Workspace unchanged; it does not silently rename, overlay, or merge paths.
3. The editor-facing surface is one composed filesystem. Anyam owns the unified status and diff view, while the underlying Workspace Repositories remain the Git compatibility surfaces for clone, fetch, push, commit, branch, and other repository-scoped operations.
4. A local mutation records an automatic Snapshot. Undo creates a new state and Snapshot and appends to the Operation Log; it never erases accepted history or Audit Events.
5. Synchronization compares each Workspace Repository with its corresponding remote Snapshot. A non-overlapping remote change may advance the Workspace base. A divergent local and remote change creates a durable content Conflict. Synchronization never silently selects local, remote, or an agent suggestion.
6. A Conflict must be explicitly resolved before a Change Revision can be published. The resolution is a new Workspace state and remains inspectable in the Operation Log.
7. Publishing creates a Change Revision containing the participating Source Space Snapshots. Publishing does not write any Canonical Repository; only Landing may create a new canonical Project Revision.
8. Anyam does not promise that a composed Workspace is itself one ordinary Git repository. The compatibility guarantee is familiar Git behavior at each Workspace Repository plus a unified Anyam layer for cross-space operations.

## Consequences

- A developer or agent can use a normal editor against one filesystem without receiving a broad credential for any Canonical Repository.
- The client must maintain a deterministic path-to-Source-Space map and preserve the boundary when it computes status, diff, snapshots, sync, and publication.
- `git status` and `git diff` at a synthetic project root are not assumed to work through stock Git alone. Anyam CLI and IDE integrations must provide the unified view, while repository-scoped Git commands remain available inside each Workspace Repository.
- Cross-space atomicity belongs to Project Revisions and Landing, not to a multi-repository Git commit or a provider-specific multi-ref push.
- Conflict state is durable and explainable, which costs more visible ceremony than an automatic merge but prevents private/public or semantic changes from being silently flattened.
- The prototype intentionally has no persistence or production adapter. A later implementation must preserve these semantics over the selected local filesystem and Repository Driver APIs.

## Rejected alternatives

- **One repository with hidden private paths**: violates the Source Space disclosure boundary and leaks graph or metadata through ordinary Git reachability.
- **Separate developer directories with no composed view**: preserves isolation but makes routine editing, agent context, and cross-space review needlessly hard.
- **Silent mount overlays or generated path renames**: hides a collision and makes the resulting source graph surprising and non-reproducible.
- **Automatic conflict choice by an agent**: explanations and proposed resolutions are not a substitute for an explicit new Change Revision.
- **Direct canonical writes from the Workspace**: bypasses Landing, policy, Evidence, and Project Revision compare-and-swap.
