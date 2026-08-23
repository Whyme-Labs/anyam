# Migration-aware rollback

Status: Accepted

Issue: [#253](https://github.com/Whyme-Labs/anyam/issues/253)

## Context

A Worker health failure does not prove that the data state is compatible with
the previous application Release. Automatically restoring old code and then
marking the Target healthy can hide a partially applied migration.

## Decision

Promotion recovery evaluates the candidate Release's Migration Plan before
attempting an automatic application rollback:

- `safe` permits automatic rollback;
- `application-only` permits it only for `backward-compatible` or
  `bidirectional` compatibility;
- `manual-data-action` keeps the Target degraded until the required recovery
  Evidence exists; and
- `blocked` never permits automatic rollback.

The decision and plan digest are recorded in the Promotion receipt. A blocked
decision leaves the Target degraded and names the human recovery action. A
successful application rollback is not presented as data rollback.

## Consequences

- Health recovery cannot turn an incompatible data state into a false healthy
  Target.
- Migration policy remains provider-neutral while providers can add a separate
  idempotent migration executor later.
- Existing no-migration Releases use the explicit safe default.

## Rejected alternatives

- **Always rollback old code:** application health does not establish data
  compatibility.
- **Treat HTTP health as sufficient:** an old endpoint can answer successfully
  while reading a schema it no longer understands.
- **Delete automatic rollback entirely:** safe and proven-compatible
  application rollback is still valuable when the plan explicitly permits it.
