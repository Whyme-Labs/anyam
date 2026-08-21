# ADR 0044: P3 live public Git Gateway and abuse boundary

- Status: Accepted with bounded provider residuals
- Date: 2026-08-08
- Issue: [Qualify live public gateway and abuse controls for P3](https://github.com/Whyme-Labs/anyam/issues/107)
- Depends on: [ADR 0015](./0015-cloudflare-first-architecture-and-provider-boundaries.md), [ADR 0023](./0023-receipt-backed-costs-quotas-and-packaging.md), [ADR 0032](./0032-hybrid-public-private-projections-and-sealed-verifiers.md), [ADR 0036](./0036-bidirectional-repository-mirrors-and-recovery.md), [ADR 0043](./0043-p3-public-beta-onboarding-and-abuse-boundary.md)

## Context

ADR 0043 established a provider-neutral Public Intake contract but deliberately
left the live anonymous Git Gateway and edge abuse boundary open. A P3
qualification must prove that a customer-owned Cloudflare deployment can expose
the public Project View without exposing provider URLs or private Source Space
metadata, while contribution requests remain quarantined and recoverable.

The provider boundary must also be honest about limits. Cloudflare's Workers
Rate Limiting binding is a coarse edge control with local/eventual semantics and
is not an authoritative accounting ledger. The logical contribution decision
therefore belongs to a serialized Durable Object coordinator.

## Decision

Anyam uses the following customer-operated boundary for a public Source Space:

```text
anonymous Git Smart HTTP read
        ↓
customer-owned Worker Git Gateway
        ↓
configured public Repository Driver

public contribution envelope
        ↓
coarse edge abuse tripwire (advisory)
        ↓
Durable Object Public Intake ledger (authoritative)
        ↓
quarantine / approval / denial
        ↓
normal Change, Evidence, Landing, Release, and Target policy
```

### Public Git reads

- The Gateway exposes only the configured public Source Space projection.
- `info/refs` and `git-upload-pack` reads may be forwarded to the configured
  Repository Driver.
- `git-receive-pack` is rejected. Anonymous public Git never receives
  canonical-write authority.
- Public Git uses the same stream-bounded Smart HTTP transport as private Git.
  Request and response byte budgets, full body-lifecycle deadlines, and
  concurrency release are therefore one transport policy rather than a
  weaker public-only proxy. The public worker requires measured values and a
  receipt for every configured tripwire; missing configuration closes the
  public Git route.
- The public Gateway binds a customer-owned Durable Object lease coordinator
  for cross-isolate concurrency. A missing binding closes public Git. The
  private Smart HTTP adapter may still use an isolate-local tracker when no
  durable coordinator is configured; that path remains an explicit residual
  and is not a global quota claim.
- Upstream provider URLs, private Source Space IDs, private paths, and provider
  error details are not returned to the caller.
- The Gateway is the stable client URL; a provider can be replaced behind it.

### Contribution envelopes

- Contributions are structured envelopes, not anonymous Git pushes.
- The Worker computes a canonical payload digest from the request ID,
  contribution ID, and envelope. Caller-supplied digest fields are not trusted.
- The Durable Object records request identity, digest, decision, retryability,
  recovery checkpoint, contribution lineage, and audit event before returning.
- Repeating a completed request with the same digest is idempotent. Reusing a
  request ID with a different digest is a replay denial.
- A provider timeout is retryable with the same idempotency key; it never
  materializes a Change input on the timeout path.
- Accepted requests remain `quarantined` and carry `landingAuthority=false`.

### Abuse controls and limits

- Public Intake remains closed until a customer Realm owner opens it.
- Owner/moderator suspension stops new materialization; reopen requires an
  explicit review receipt; cleanup closes intake and preserves lineage.
- The Cloudflare Rate Limiting binding is an outer, coarse abuse tripwire. Its
  result is recorded with `logicalLedger=authoritative=false`.
- The Durable Object logical ledger is the authoritative measured policy. A
  numeric rate limit is valid only with a value, unit, measurement time, method,
  and receipt. Missing measurements fail closed.
- The live qualification observed four healthy accepted envelopes and used a
  six-request logical tripwire for the disposable fixture. A later request was
  denied with the configured limit, requested count, receipt, and recovery
  action visible.
- The live edge configuration used a 100-request/10-second provider tripwire
  after a 20-request closed-intake preflight with no denials. A 120-request
  burst also produced no provider 429. This is recorded as a provider
  observation and does not upgrade the binding into an exact quota or replace
  the logical ledger.

### Customer operation and portability

- The Worker, Durable Object, Rate Limiting binding, and provider credentials
  are customer-owned resources.
- Anyam does not need a hosted account, hosted gateway, provider token, or
  second canonical repository for this path.
- The public Gateway depends on a Repository Driver interface; the live fixture
  used GitHub only as a disposable upstream transport and deleted it after the
  receipt.

## Consequences

- A technical user can publish a public Git clone surface without giving public
  callers canonical write access or a private-source metadata oracle.
- The authoritative request ledger has durable idempotency, replay, timeout,
  suspension, reopen, cleanup, and audit behavior.
- Edge abuse controls remain provider-specific and measurable rather than being
  confused with Anyam policy accounting.
- Anonymous intake is not ready to be opened merely because a Worker deployed;
  the owner must configure a current receipt and can choose approval-only mode.
- A future provider adapter may add Turnstile, WAF, bot scoring, or an external
  abuse classifier, but those controls must return explicit result-only or
  disclosure-safe Evidence and must not become Landing authority.

## Rejected alternatives

- **Anonymous `receive-pack`:** directly grants canonical source mutation and
  collapses Public Intake into Landing.
- **Provider Rate Limiting as the quota ledger:** its documented consistency
  and accounting behavior is not strong enough for logical acceptance counts.
- **A fixed universal anonymous quota:** a number without a workload receipt is
  a landmine and cannot be transferred between customer projects.
- **Provider URL passthrough:** leaks implementation and private topology and
  makes migration unsafe.
- **Deleting request history on cleanup:** destroys recovery, replay defense,
  attribution, and public lineage.
