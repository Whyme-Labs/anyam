# ADR 0059: Repository Driver consistency and recovery capabilities

**Status:** Accepted

## Context

Git compatibility describes object and ref operations, not the durability or
consistency guarantees of the provider serving them. Cursor's Continuity
article makes the distinction explicit: its system persists pushes to a
write-ahead log before acknowledgement, uses a linearized reference index, and
rebuilds hot local repositories from durable storage. Those are provider-data
plane choices, not properties that Anyam can infer from a successful `git push`.

## Decision

Every `RepositoryDriver` descriptor reports the following consistency and
recovery capabilities with one of three states:

```text
observed     Anyam has a receipt for this driver boundary
unverified   the behavior may exist, but no receipt permits a claim
unsupported  the driver does not provide the behavior
```

The capabilities are:

- durable-before-acknowledgement;
- linearizable reference publication;
- read-after-write;
- replay after local cache loss; and
- exact export/restore.

`unverified` and `unsupported` are visible to callers and qualification gates.
Neither may be silently upgraded to `observed`. A provider acknowledgement is
never an Anyam canonical transition; the driver returns a receipt and Anyam
authority decides whether a Change, Landing, Release, or Promotion advances.

The current descriptors are intentionally conservative:

- Local Git observes local CAS refs, read-after-write, and bundle
  export/restore, but does not claim filesystem durability or replay after
  cache loss.
- Smart HTTP observes only the portable local export/restore path. Provider
  durability, remote linearizability, and remote read-after-write remain
  unverified until a provider conformance receipt exists.

## Consequences

The fast Git data path remains separate from Anyam policy and evidence. A
future Artifacts, Origin, GitHub, GitLab, Forgejo, or customer driver can use
the same descriptor without changing Project, Change, Evidence, Landing,
Release, Target, or export semantics. A driver that cannot satisfy a required
state fails closed with the missing guarantee, observed state, receipt, and
recovery action.

## Non-goals

This ADR does not build a new Git storage engine, choose Cursor Origin as a
provider, qualify Cloudflare Artifacts, define universal capacity limits, or
make provider benchmark numbers Anyam SLOs.

## Source

- [Cursor: Git at any scale](https://cursor.com/blog/git-at-any-scale)
