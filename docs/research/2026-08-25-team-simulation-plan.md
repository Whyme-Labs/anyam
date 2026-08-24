# Anyam team simulation qualification plan

## Purpose

This qualification checks whether Anyam behaves like a source-and-release
control plane for a small engineering team. It exercises real temporary Git
repositories and the public Anyam coordination seams. It does not turn local
fixtures into Cloudflare support claims.

## Definition of done

The run is `VERIFIED` only when the runner produces a credential-free receipt
for every required scenario:

1. A full-stack Cloudflare Worker Project imports from Git, accepts parallel
   Changes, creates a Release, and records the Target boundary.
2. A TypeScript CLI Project imports from Git, creates branches and tags, and
   preserves the same Change and Landing semantics as the Worker Project.
3. A hybrid Project View exposes the public Source Space without exposing the
   private Source Space or its metadata.
4. Three human actors and two coding-agent actors use separate Workspaces.
5. The run observes an issue-to-Change link, a blocking Review Finding, an
   independent Review Approval, a Landing, and a closed Change.
6. Divergent Git branches produce a real merge conflict. A rebase resolves the
   conflict and the resulting commit is the revision that proceeds.
7. A stale Change is blocked by compare-and-swap and succeeds only after an
   explicit rebase.
8. Bidirectional mirror projection sends public refs outward and turns a remote
   commit into a proposed Change without advancing canonical state.
9. The Worker, CLI, and hybrid Project Exports contain their declared
   repositories, Change history, mirror state, and recovery metadata. Import
   restores exact refs and is idempotent.
10. Any unsupported product capability is reported as `NOT VERIFIED` with a
    concrete issue candidate. It is never represented by a synthetic pass.

The actor and scenario counts above are qualification scope. They are not
Anyam limits, capacity claims, or production SLOs.

## Scenario matrix

| Scenario | Real input | Anyam seam | Required result |
| --- | --- | --- | --- |
| `worker-team` | `fixtures/worker-golden` in a temporary Git repository | Local Git, Workspace, Change, Collaboration, Release input | Git history, parallel Changes, review, Landing, and release lineage stay bound to exact commits |
| `cli-team` | generated TypeScript CLI repository with tests and a tag | Local Git, Workspace, Change, Collaboration, Project Export | CLI source uses the same authority path as Worker source |
| `hybrid-public-private` | `fixtures/hybrid` public player and restricted codec | Project View and public projection | Public clone content contains no private path, ID, or content |
| `git-conflict-rebase` | two branches editing the same line | Git merge, abort, rebase, Local Change rebase | Conflict is durable, resolution is explicit, and the final revision is new |
| `team-review-landing` | three human actors and two agent actors | Collaboration Coordinator | Finding blocks, independent approval unblocks, Landing is canonical-only |
| `github-bidirectional` | scripted remote refs and a remote commit | Mirror Coordinator | Outbound projection is idempotent; inbound commit becomes a Change proposal |
| `export-restore` | Worker, CLI, and hybrid Project packages | Local Project Exporter and Local Git Driver | Export verifies, import activates, restored refs match, and replay does not duplicate state |

## Run order

1. Create a temporary root and record the Git and Node versions.
2. Seed the Worker and CLI repositories with an initial signed-by-test-config
   commit. The test key is local fixture material, not a product credential.
3. Create named branches for the human and agent actors.
4. Make divergent commits, force a merge conflict, abort the merge, rebase,
   resolve, and verify the final graph with `git log` and `git fsck`.
5. Import each repository into its Source Space through the Local Git driver.
6. Create isolated Workspaces and stable Changes from the exact Git snapshots.
7. Create a blocked review state, resolve the finding, obtain an independent
   approval, and Land the exact latest revisions.
8. Build the hybrid public projection and inspect its serialized output for
   restricted names, paths, IDs, and content.
9. Run bidirectional mirror sync, duplicate delivery, and inbound proposal
   reconciliation.
10. Export the Project, verify the package, import it into a fresh destination,
    replay the same idempotency key, and compare repository refs.
11. Emit a JSON receipt and a machine-readable finding list.

## Failure policy

The runner continues after a scenario failure so that one run exposes the full
defect surface. Each finding contains:

- a stable scenario ID;
- `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`;
- the public seam that failed;
- the exact observed error or missing capability;
- a recovery action;
- a GitHub issue candidate only when the finding is product-owned.

Provider, cost, performance, and availability observations stay labelled as
provider facts or local measurements. The runner does not convert them into
universal Anyam limits.

## Expected product gaps to test honestly

The current kernel stores an `intentId` on a Change but does not expose a
first-class issue or Intent lifecycle. The runner must therefore test and
report issue open/close behavior as a product capability instead of pretending
that an identifier string is an issue tracker.

The current CLI exposes Change and Workspace commands but not a complete GitHub
style pull-request lifecycle. The runner must report that gap if it cannot
open, review, close, and reopen a PR through an Anyam interface.

Cloudflare deployment remains a separate provider-backed qualification. The
simulation may bind the Worker Release and Target records, but it must not
claim a live Cloudflare deployment unless the owner runs the golden-path
qualifier with a customer credential.

## Receipts

The development run keeps its append-only decision trail in
`.audit/team-simulation.tsv`. The committed runner emits the final JSON receipt
to stdout so a caller can redirect it to customer-controlled storage. A
successful local run is evidence for the tested seams only. It is not evidence
for a production team, a Cloudflare account, or a general availability claim.
