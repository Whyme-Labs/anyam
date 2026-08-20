# ADR 0062: Signed, nonce-bound Promotion executor handoffs

- Status: Accepted
- Date: 2026-08-20
- Scope: Realm Authority to customer-operated Promotion executor

## Context

The service binding separated provider credentials from Authority, but a
protocol header alone did not prove that a request came from Authority. A
publicly routed executor could accept a copied or replayed detached context.

## Decision

Authority signs the exact serialized Promotion execution context with a
customer-owned handoff secret and a fresh nonce/expiry. The executor verifies
the HMAC before provider invocation and claims the nonce in a Durable Object.
The signed message binds the protocol, nonce, expiry, and complete context,
including Realm, Project, Target, Promotion, Release, expected current
Release, execution digest, and authorization epoch.

Reconciliation creates a fresh nonce and signature while preserving the same
immutable execution identity. A consumed nonce cannot be replayed.

The handoff contains no provider credentials. Provider credential brokering is
a separate boundary.

## Consequences

- Knowing the protocol string is insufficient to invoke the executor.
- Changed bodies, expired handoffs, and replayed nonces fail before provider
  invocation.
- The customer must provision the same handoff secret to the Realm and its
  executor, and must retain the nonce Durable Object.
- HMAC is an internal shared-secret boundary; a future asymmetric key
  deployment may replace it without changing the handoff contract.

## Verification

- Missing, altered, and replayed handoffs are rejected in the executor tests.
- The local qualification signs a nonce-bound handoff and completes the
  provider fixture without exposing credentials.
- Health is blocked when handoff or nonce bindings are missing.
