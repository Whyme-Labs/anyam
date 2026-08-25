# ADR 0099: Pull Request compatibility projection

Status: Accepted

Issue: [#280](https://github.com/Whyme-Labs/anyam/issues/280)

## Context

GitHub and other Git hosts use Pull Requests as the familiar review surface.
Anyam must remain usable with those tools without allowing an external forge to
become a second canonical authority. The existing mirror ledger already maps a
provider Pull Request to one stable Change and records successive external
heads, but it did not expose a complete local/provider-compatible lifecycle.

## Decision

Anyam owns a credential-free `PullRequest` compatibility projection. Its stable
identity maps to exactly one Anyam Change; its `revisionIds` record the exact
Change Revisions represented by branch updates and rebases. Provider identity,
remote repository, branch names, and external keys are compatibility metadata.

The authoritative transitions are:

```text
pullRequest.open
pullRequest.update
pullRequest.review
pullRequest.close
pullRequest.reopen
pullRequest.block
pullRequest.merge
```

`pullRequest.merge` is accepted only after the mapped Change is Landed. A
provider mirror proposal of kind `pull-request` materializes or updates the
same projection while preserving its stable identity. Provider status cannot
advance Anyam's canonical Project Revision by itself.

The projection is available through:

- owner-authenticated REST at `/api/pull-requests`;
- scoped MCP tools `pullRequest.list`, `pullRequest.inspect`,
  `pullRequest.open`, `pullRequest.update`, `pullRequest.review`,
  `pullRequest.close`, `pullRequest.reopen`, `pullRequest.block`, and
  `pullRequest.merge`;
- the hosted CLI `anyam pr ...` (with `pull-request` as an explicit alias).

Project Exports carry Pull Request projections and validate their Project,
Change, status, review, disclosure, and identity shape. Public disclosure
omits provider identity and private Change IDs; restricted Pull Requests are
omitted rather than represented by a detectable placeholder.

## Consequences

- Existing Git users get familiar PR vocabulary while Anyam retains authority.
- Branch updates, rebases, review state, close/reopen, block, Landing, and merge
  are observable with one stable PR identity.
- A provider can report that a remote PR merged, but Anyam will keep the
  projection blocked until the mapped Change is safely Landed.
- This is a compatibility adapter, not a promise of GitHub Actions, provider
  availability, or public social features.

## Qualification receipt

The team simulation must produce a verified `pull-request-lifecycle` scenario
covering real branch and rebased commit identities, review state, close/reopen,
blocked/reopen, Landing, merge, and export/restore. The combined
`issue-pr-lifecycle` scenario is verified only when both Intent and Pull Request
receipts pass. Live provider qualification remains separate.
