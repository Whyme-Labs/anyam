# ADR 0110: Keep provider Mirror proposals behind a signed observation boundary

Status: Accepted

Issue: [#310](https://github.com/Whyme-Labs/anyam/issues/310)

## Context

The hosted generic Authority command surface previously accepted
`mirror.sync` and `mirror.reconcile` from a human capability session. An
external proposal could therefore supply a nonexistent head and create a
Change Revision without a RepositoryDriver observation.

The ordinary Workspace observation contract is not the right shape for a
Mirror proposal: a provider proposal has a Mirror, proposal, delivery,
provider, repository, and Project View context but no Workspace.

## Decision

- Generic human, OAuth, MCP, REST, and agent Authority surfaces cannot submit
  provider Mirror sync or reconciliation commands.
- Local mirror fixtures use an explicitly named `anyam-mirror-fixture` seam and
  are not hosted ingestion.
- Hosted ingestion uses a short-lived HMAC-signed `anyam.mirror-ingestion/v1`
  handoff with a one-time nonce.
- A `MirrorRepositoryObservation` records the explicit provider proposal
  context and is required before the internal path creates a Change Revision.
- The Authority stores the verified observation on the Change Revision so
  proposal provenance survives export and recovery.
- The customer RepositoryDriver adapter remains responsible for obtaining the
  observation; the handoff only transports the exact verified result.

## Consequences

Invented or replayed provider claims fail before a Change or Revision is
created. The bidirectional provider adapter must use the internal signed route,
and customer-operated RepositoryDriver deployment remains a separate
qualification step tracked in [#313](https://github.com/Whyme-Labs/anyam/issues/313).
