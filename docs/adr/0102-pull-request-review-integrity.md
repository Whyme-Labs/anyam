# ADR 0102: Pull Request review integrity and terminal merges

Status: Accepted

Issue: [#292](https://github.com/Whyme-Labs/anyam/issues/292)

## Context

The Pull Request object is a Git-compatible projection over Anyam's stable
Change and Change Revision lineage. A review approval is only meaningful for
the exact source state the reviewer inspected. Previously, a Pull Request could
move to a new head while retaining `reviewState=approved`, and a merged
projection could be updated, reviewed, reopened, blocked, or merged again.

## Decision

Each review is an append-only `PullRequestReview` record containing the
reviewer Actor, state, head commit, base commit, canonical Revision-set digest,
review digest, timestamp, and receipt. The Authority derives the Revision-set
digest from the ordered Revision IDs; agents cannot supply an approval as part
of `pullRequest.open` or `pullRequest.update`.

Updating a Pull Request's head ref, base ref, head commit, base commit, or
Revision lineage invalidates the current review projection: the state returns
to `pending`, approval fields are removed, and the history remains available.
`pullRequest.merge` requires the Change to be Landed and the approval metadata
to match the current head, base, and Revision set exactly.

`status=merged` is terminal. Authority, REST, MCP, mirror reconciliation, and
export/restore paths preserve the merged projection and reject later updates,
reviews, close/reopen/block transitions, and repeated merge attempts with an
actionable terminal receipt.

## Consequences

- Approval freshness is explicit rather than inferred from a mutable label.
- Review history remains auditable after a rebase or mirror synchronization.
- A new source state requires a new review; update authority cannot implicitly
  approve it.
- Follow-up work after merge uses a new Change/Pull Request identity.

## Receipt

- Authority tests cover stale approvals, append-only review records, current
  approval requirements, and every merged-terminal transition.
- Mirror, REST, export, and restore tests preserve the same stale/terminal
  projection.
