# ADR 0098: First-class Intent lifecycle

Status: Accepted

Issue: [#279](https://github.com/Whyme-Labs/anyam/issues/279)

## Context

Changes previously carried an opaque `intentId`, but Anyam had no authoritative
Issue-compatible object that users, agents, or exports could inspect and update.
That made assignment, discussion, closure, and reopening depend on an external
tracker and made a Change-to-intent relationship impossible to qualify end to
end.

## Decision

Anyam owns an immutable-identity `Intent` aggregate and an append-only
`IntentComment` history in the Authority Plane. An Intent has explicit `open`
and `closed` states, project ownership, disclosure, assignees, labels, and
credential-free receipts. Closing and reopening retain the same Intent ID.

The authoritative transitions are:

```text
intent.create
intent.assign
intent.comment
intent.close
intent.reopen
```

`change.create` requires an Intent identity. Existing callers that provide an
unknown ID receive a legacy-materialized Intent in the same Project, so older
Git/Change clients cannot create an orphan relationship. New clients should
create the Intent first and then create the Change from that identity.

The lifecycle is exposed through three compatible surfaces:

- owner-authenticated REST at `/api/intents`;
- scoped remote MCP tools `intent.list`, `intent.inspect`, `intent.create`,
  `intent.assign`, `intent.comment`, `intent.close`, and `intent.reopen`;
- the hosted CLI `anyam intent ...`, using an explicit Realm URL and owner
  session. The CLI does not persist bearer material.

Project Exports carry `intents` and `intentComments` as credential-free state.
Public disclosure uses `summarizeIntentForAudience`; non-public Intents are
omitted from a public projection rather than replaced with a metadata-bearing
redaction.

## Consequences

- A Change has a stable, inspectable problem identity before implementation.
- Agent and human clients use idempotent transitions without writing canonical
  Git refs.
- Export/restore preserves the issue history alongside Git refs and Change
  lineage.
- Public projections cannot infer restricted Intent authors, assignees, or
  comments from a placeholder object.
- The pull-request compatibility projection remains a separate follow-up in
  issue #280; Intent is not renamed to PR and does not take on Git hosting
  semantics.

## Qualification receipt

The team simulation must produce a verified `intent-lifecycle` scenario that
observes create, assign, comment, close, reopen, stable Change linkage, and
export/restore retention. REST, MCP, CLI help, Authority, and disclosure tests
must remain green. Live Cloudflare provider qualification is separate.
