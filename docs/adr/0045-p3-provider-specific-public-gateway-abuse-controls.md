# ADR 0045: P3 provider-specific Public Gateway abuse controls

- Status: Accepted with a qualified Turnstile path and bounded provider residuals
- Date: 2026-08-08
- Issue: [Qualify provider-specific public Gateway bot and edge controls](https://github.com/Whyme-Labs/anyam/issues/109)
- Depends on: [ADR 0043](./0043-p3-public-beta-onboarding-and-abuse-boundary.md), [ADR 0044](./0044-p3-live-public-gateway-and-abuse-boundary.md)

## Context

ADR 0044 qualified a customer-operated public Git Gateway and its Durable
Object Public Intake ledger. It deliberately left the provider-specific bot
and edge layer bounded: Cloudflare Rate Limiting is an outer, provider-owned
tripwire and is not an exact logical quota.

The next layer must improve abuse resistance without changing the authority
boundary. Provider controls can reject or challenge a request, but they must
not become Anyam's source-control authority, private Source Space oracle, or
logical contribution ledger.

## Decision

Anyam exposes a provider-neutral `anyam.public-gateway-abuse/v1` decision
contract. The default is `edge-only`; a customer may opt into
`turnstile-required` by configuring a customer-owned secret binding and a
receipt-backed verification timeout.

```text
public contribution envelope
        ↓
customer-owned edge tripwire (Rate Limiting/WAF/Bot Management)
        ↓
optional server-side Turnstile Siteverify
        ↓
Durable Object Public Intake ledger (authoritative)
        ↓
quarantine / approval / denial
```

### Authority and disclosure invariants

- The Durable Object ledger remains authoritative for request identity,
  idempotency, replay rejection, logical counts, recovery checkpoints, and
  audit history.
- A provider decision is result-only evidence. It never grants canonical write,
  Landing, private Source Space read, or policy-management authority.
- Provider URLs, secrets, raw provider error codes, raw tokens, private Source
  Space identifiers, and private paths are never returned or persisted in a
  public response or ledger receipt.
- A malformed provider decision is fail-closed rather than silently treated as
  an allowed request.
- An accepted request remains quarantined and has `landingAuthority=false`.

### Turnstile adapter

- Siteverify is performed server-side by the customer-owned Worker.
- The secret is sent only to the configured provider endpoint and is never
  included in a decision, digest, receipt, or downstream coordinator request.
- Missing, oversized, rejected, expired/replayed, mismatched, or malformed
  tokens produce a challenge or unavailable result with no materialization.
- Provider HTTP failure, timeout, or runtime/network failure is fail-closed and
  retryable only with a fresh token. A timed-out token is not assumed reusable.
- The adapter records a timeout receipt and configured limit but does not claim
  that the configured timeout is a provider SLA.
- Optional action and hostname checks are performed after a successful
  Siteverify response and are result-only.

### WAF and Bot Management

- Cloudflare WAF rate limiting may be configured by the customer as an outer
  block, challenge, or log action. Its provider characteristics, period,
  counter scope, and overload/fail-open behavior remain provider-specific.
- Bot Management scores, where the customer's plan exposes them, may inform a
  provider-specific rule. Anyam does not assume that the score is available on
  every plan or treat a score as a universal bot verdict.
- Provider observations do not become universal Anyam quotas. Each customer
  must measure its own traffic shape and retain the provider receipt.

## Consequences

### Positive

- Customers can add a real server-side challenge without handing Anyam a
  hosted credential or moving the gateway into Anyam's account.
- Successful and failed provider paths are visible to agents and operators as
  structured, disclosure-safe decisions.
- Provider outages do not silently admit anonymous contributions.
- The same coordinator remains usable with no provider, Turnstile, WAF, Bot
  Management, or a future customer-owned abuse adapter.

### Residuals

- Cloudflare Rate Limiting remains a coarse, eventually consistent edge
  control; a bounded burst receipt is not proof of exact enforcement.
- WAF and Bot Management behavior is plan-, rule-, and traffic-shape-specific
  and requires a separate customer qualification.
- The 2026-08-08 disposable Worker qualified a successful Worker-origin
  Turnstile response using Cloudflare's documented test path and a fail-closed
  missing-token path. Production widget issuance, customer-specific action and
  hostname configuration, and broader WAF/Bot Management coverage remain
  customer-owned operational work.
- Anyam does not claim anonymous public-intake readiness for every customer or
  every provider plan.

## Rejected alternatives

- **Provider Rate Limiting as the logical ledger:** provider accounting and
  consistency are not sufficient for Anyam request identity or quota truth.
- **Bot score as a universal policy:** score availability and interpretation are
  plan-specific; a score cannot replace a customer policy and ledger.
- **Client-only Turnstile validation:** client assertions are not sufficient
  evidence and permit token forgery or replay.
- **Fail-open provider outage:** it would turn an availability problem into an
  anonymous intake authorization.
- **Passing the provider token to the Durable Object:** it creates unnecessary
  replay and disclosure surface; the coordinator receives only a result-only
  decision.
- **One fixed public quota:** a number without a workload receipt is a
  landmine and cannot be transferred between customer projects.

