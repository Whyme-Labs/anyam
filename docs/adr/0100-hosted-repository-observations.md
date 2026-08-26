# ADR 0100: Hosted Change Revisions require RepositoryDriver observations

Status: Accepted

Issue: [#290](https://github.com/Whyme-Labs/anyam/issues/290)

## Context

A hosted Change Revision cannot trust a client-provided string such as a Git
commit ID. The string must identify an object that exists in the authoritative
Repository, is reachable from the Workspace base, and is disclosed through the
requested Project View. Otherwise an agent can publish a revision whose
Evidence and later Landing refer to source that was never observed.

## Decision

Every hosted `revision.publish` mutation is passed through a customer-owned
`ANYAM_REPOSITORY_OBSERVER` service binding. The binding implements the
credential-free `anyam.repository-observation/v1` request/response contract and
delegates to the configured RepositoryDriver.

The Realm resolves the Repository identity from the authoritative Source Space;
callers cannot choose the repository or observer target. The observer must
return the exact commit, tree, object format, symbolic ref, and base ancestry
for the requested Workspace and Project View. The Realm verifies the response
shape, every binding field, and the SHA-256 observation manifest digest before
executing the sanitized Authority command.

The resulting observation is stored on the Change Revision. Its digest is
included in safe MCP projections, and Change Revisions are included in Project
Exports, so the observation receipt remains attached through Landing and
recovery.

If the Source Space has no authoritative Repository identity or the observer
binding is absent, hosted publication is blocked. Local, fixture, and legacy
Authority paths may continue to publish unobserved revisions; they are not
treated as hosted trust evidence.

## Consequences

- A caller cannot turn an arbitrary snapshot string into hosted source
  provenance.
- The RepositoryDriver remains provider-neutral and can be implemented for
  local Git, Smart HTTP, Cloudflare Artifacts, or another qualified backend.
- Customer-operated Realms must install and qualify the observer before hosted
  agent publication is enabled.
- The observer boundary is intentionally separate from MCP authorization: the
  grant decides who may publish, and the RepositoryDriver decides what Git
  state actually exists.

## Receipt

- Local Git observations verify commit, tree, object format, ref, and ancestry.
- Malformed, forged, mismatched, and stale observations fail closed.
- The repository gate must retain the exact-object and digest-binding tests.
