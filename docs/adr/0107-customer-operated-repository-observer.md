# ADR 0107: Customer-operated Repository Observer Worker

Status: Accepted

Issue: [#301](https://github.com/Whyme-Labs/anyam/issues/301)

## Context

The Realm needs a deployable `ANYAM_REPOSITORY_OBSERVER` service, but a
Cloudflare Worker cannot run an arbitrary provider's Git implementation inside
the Realm. Provider access, credentials, and repository lifecycle must remain
replaceable and customer-owned.

## Decision

Ship `apps/repository-observer` as a small, service-binding-only verifier
Worker, paired with the deployable `apps/repository-driver` R2 snapshot
adapter. The driver accepts only private Observer service-binding requests and
reads provider-synchronized, credential-free snapshot manifests. It delegates
provider-specific synchronization to a replaceable GitHub App, Smart-HTTP, or
Anyam-native adapter. The observer and driver use the existing
`anyam.repository-observation/v1` request/response contract. The observer
validates request shape, bounds request and response bodies using a measured
tripwire, rejects credential-bearing receipts, verifies every returned
observation against the authoritative request, and emits only credential-free
responses.

The first reference adapter is deliberately provider-neutral and snapshot
backed. Customers can replace its synchronizer with an Anyam-native Git,
GitHub App, Smart HTTP, or other qualified provider without changing the Realm
or observer contract. Both Workers have no public Workers dev or preview route
in their example configurations.

## Consequences

- Customer provider credentials never enter the Realm or observer Worker.
- The provider adapter can be replaced without changing hosted Authority code.
- Missing or unhealthy driver configuration fails closed before a Change
  Revision is stored.
- The local qualification proves the service boundary and cleanup semantics;
  live provider and account qualification remain customer-owned evidence.

## Receipt

- Worker typecheck and Wrangler dry-run pass.
- RepositoryDriver qualification verifies the R2 snapshot driver and Observer
  composition, valid and non-ancestor heads, revoked and deleted state, the
  private service-binding header, bounded bodies, and credential-free receipts
  with `providerMutation=false`.
- Worker smoke includes `/health`, `/observe`, the service bindings, and request
  budget configuration for both Workers.
