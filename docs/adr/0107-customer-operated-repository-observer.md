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
Worker. It delegates exact repository reads to a customer-owned
`REPOSITORY_DRIVER` service binding using the existing
`anyam.repository-observation/v1` request/response contract. The observer
validates request shape, bounds request and response bodies using a measured
tripwire, rejects credential-bearing receipts, verifies every returned
observation against the authoritative request, and emits only credential-free
responses.

The first reference adapter is deliberately provider-neutral. Customers can
bind an Anyam-native Git, GitHub App, Smart HTTP, or other qualified driver
without changing the Realm or observer contract. The observer has no public
Workers dev or preview route in its example configuration.

## Consequences

- Customer provider credentials never enter the Realm or observer Worker.
- The provider adapter can be replaced without changing hosted Authority code.
- Missing or unhealthy driver configuration fails closed before a Change
  Revision is stored.
- The local qualification proves the service boundary and cleanup semantics;
  live provider and account qualification remain customer-owned evidence.

## Receipt

- Worker typecheck and Wrangler dry-run pass.
- Local qualification verifies healthy, valid, forged, missing-driver, and
  bounded-request paths with `providerMutation=false`.
- Worker smoke includes `/health`, `/observe`, the service binding, and request
  budget configuration.
