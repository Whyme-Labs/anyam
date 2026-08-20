# ADR 0063: Smart HTTP binds Source Space and Git service intent before forwarding

- Status: Accepted
- Date: 2026-08-20
- Scope: Realm-owned Git Smart HTTP gateway

## Context

Repository IDs alone do not identify the disclosure boundary. Git's
`info/refs` endpoint also carries a service query: upload-pack is read intent,
while receive-pack is write intent. Classifying every advertisement as read
can expose a write path to an anonymous-read policy.

## Decision

Every Smart HTTP route resolves a provider Repository to exactly one Source
Space before credential validation or upstream forwarding. Anonymous reads are
allowed only through an explicit per-repository disclosure callback.

`GET info/refs?service=git-receive-pack` is write intent and follows the same
Workspace-only write policy as POST receive-pack. Unknown or unbound mappings
fail closed.

Request/pack budgets and durable credential persistence remain separate
provider qualification work in #210; this boundary does not invent universal
Git limits.

## Verification

- Cross-Source-Space credentials are rejected before upstream invocation.
- Anonymous receive-pack advertisements are rejected.
- Public upload-pack disclosure is explicit and repository-specific.
- Canonical write remains denied before provider mutation.
