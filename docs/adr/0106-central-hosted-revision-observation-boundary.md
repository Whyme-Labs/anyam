# ADR 0106: Central hosted revision observation boundary

Status: Accepted

Issue: [#300](https://github.com/Whyme-Labs/anyam/issues/300)

## Context

ADR 0100 required RepositoryDriver observation for hosted Change Revisions,
but the first implementation enforced it only in the MCP Durable Object path.
Owner REST and generic Authority routes could still submit `revision.publish`
with caller-provided snapshot strings and no server observation.

That split made the trust boundary depend on which client surface happened to
be used. A human client, CLI bug, or future route could create a Revision that
did not correspond to an observed Git object.

## Decision

All hosted revision entrypoints call
`prepareHostedRevisionPublish(...)` before the Authority coordinator executes
`revision.publish`:

- owner REST revision publication;
- generic hosted Authority commands;
- delegated MCP revision publication; and
- future remote CLI adapters that use the hosted command boundary.

The boundary derives Project, Change, Workspace, Project View, base Project
Revision, Source Spaces, and Repository identities from the Authority snapshot.
It ignores caller-supplied observations, invokes the customer-owned observer
for every Source Space disclosed by the exact Project View, verifies the
returned object/ref/tree/ancestry/repository binding and digest, then executes
only a sanitized command containing the verified observations.

Local coordinator fixtures remain available through direct in-process
Authority tests. They are not hosted trust evidence and never pass through a
customer-operated Realm route.

## Consequences

- REST, MCP, generic Authority, and future CLI surfaces share one fail-closed
  source-provenance boundary.
- A missing observer, missing Repository identity, incomplete Source Space set,
  forged observation, or stale base blocks before a Change Revision is stored.
- The observer service remains a replaceable customer-owned adapter; Anyam
  retains canonical authority and stores only credential-free observations.
- The same verification runs at the service response boundary and again at the
  central publication boundary, making the seam explicit for future adapters.

## Receipt

- The hosted boundary test proves client-supplied observations are ignored,
  valid observations are derived from the authoritative snapshot, and missing
  or forged observations fail before execution.
- The full repository gate must retain the observation, REST, MCP, and generic
  Authority route coverage.
