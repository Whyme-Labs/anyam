# ADR 0067: Smart HTTP credentials and budgets are explicit adapters

- Status: Accepted
- Date: 2026-08-21
- Scope: Git Smart HTTP transport

## Context

The qualification Smart HTTP authority kept credential records only in a
process-local map, so a restart could accidentally restore access. The gateway
also had no measured request, response, duration, or concurrency tripwires;
adding arbitrary Git limits would create a landmine for healthy repositories.

## Decision

`SmartHttpCredentialAuthority` accepts a `SmartHttpCredentialStore` adapter.
The store persists only credential-free records and token digests. Issue,
expiry, and revoke transitions are saved before their result is returned, so
restarting or replacing the authority preserves revocation. The in-memory store
remains an explicit qualification fixture; a customer Realm must provide its
durable adapter before treating restart-safe credentials as qualified.

Smart HTTP budgets are optional and workload-specific. A configured budget must
carry a measurement/qualification receipt and can name request or write-pack
bytes, provider response bytes, duration, and concurrent operations. Known
limits fail closed with a response naming the budget, limit, ask, receipt, and
recovery action. No universal Git throughput or pack-size claim is made.

## Non-claims

Chunked provider responses without a Content-Length observation are not claimed
to satisfy a response-size budget. The customer durable adapter and provider
qualification must supply that observation before production sizing.

## Receipt

- Smart HTTP restart test: credential validates after authority replacement,
  revocation persists, and a second replacement rejects it.
- Budget test: measured write-pack and concurrency tripwires return visible
  `git_budget_exceeded` receipts.
- Full local gate: 247/247 tests passed; provider bindings remained not-live.
