# ADR 0041: P3 public-beta Stage Gate and operational receipts

- Status: Accepted
- Date: 2026-08-03
- Issue: [Qualify the P3 public-beta Stage Gate and operational receipts](https://github.com/Whyme-Labs/anyam/issues/87)
- Depends on: [ADR 0038](./0038-stage-gates-and-operational-receipts.md), [ADR 0040](./0040-realm-owned-agent-actors-and-human-to-agent-delegation.md)

## Context

The P3 map now has bounded receipts for multi-Realm identity, Realm-owned
agent delegation, customer-operated installation control, two-way GitHub
mirroring, external pull Runners, package Targets, and public hybrid-source
contribution. The existing Stage Gate registry knew how to require Evidence,
reliability, usage, provider cost, budget, recovery, and Residual Risk records,
but its public-beta criteria did not explicitly name the two newly qualified
trust paths. A green collection of individual tickets must not silently imply
that a public-beta exit has been evaluated.

## Decision

### Public-beta criteria

The default Qualification Plan adds two explicit public-beta criteria:

```text
public-beta:agent-delegation
public-beta:customer-install-control
```

The complete public-beta criterion set is now:

```text
team-review
agent-delegation
public-contribution
multi-realm
customer-install-control
repository-fallback
two-way-mirror
external-runner
npm-target
```

Each criterion remains bound to its fixture identity, Evidence context,
Validity Key, owner, receipt, and next action. The agent criterion binds to
the Realm-owned Actor/Session/Task/Grant receipt. The customer-install
criterion binds to the authenticated control route, adapter-verified owner
claim, readiness checkpoint, and quarantined recovery receipt.

### Operational obligations

The default `public-beta` Stage Gate requires these exact operational record
identities:

```text
Reliability Objective:
  reliability:public-beta:shared-control-plane

Usage Receipt:
  usage:public-beta

Provider Cost Receipt:
  cost:public-beta

Budget Decision:
  budget:public-beta

Recovery Drills:
  mirror-divergence
  credential-compromise
  restore

Residual Risk:
  risk:public-beta:provider-fallback
  risk:public-beta:tenant-isolation
```

Missing, failed, stale, or indeterminate records block the gate. A provider
cost feed marked delayed or unavailable is visible as a provider-feed advisory;
it is not converted into an invented invoice or a hidden success.

### Deferred Residual Risk is visible readiness, not universal coverage

The registry permits an explicit `deferred` Residual Risk to produce a `ready`
decision with an advisory and next action. The P3 qualification harness uses
that state for provider fallback and live tenant/provider-specific coverage.
This means:

```text
Stage Gate status=ready
blockers=0
advisories>0
universal provider/framework support=false
```

The result is a bounded public-beta qualification decision, not a claim that
all providers, runners, registries, or workloads are production-qualified.
The launch owner must review the advisories and residual-risk records before
opening a public cohort.

### Executable qualification

`test/public-beta-stage-gate.test.ts` records every default-plan criterion and
operational obligation, completes `K0` and `private-alpha` first, then
activates and completes `public-beta`. The test asserts:

- no dependency, Evidence, operational, recovery, or risk blocker;
- all nine public-beta Evidence identities are considered;
- one unavailable provider-feed advisory remains explicit; and
- two deferred Residual Risk advisories remain visible.

The receipt is emitted as `anyam.p3-stage-gate-qualification/v1` and includes
the evaluated timestamp, blocker count, advisory count, Evidence count,
bounded provider coverage, and the non-universal-support declaration.

## Consequences

- Completing a P3 capability ticket is necessary but not sufficient; the
  default Stage Gate now names it explicitly.
- The public-beta decision is reproducible from one registry and one receipt,
  rather than a hand-maintained checklist.
- Deferred risks remain actionable for humans and agents through their owner,
  mitigation, qualification gate, and next action.
- Provider-specific receipts can be added without changing the kernel's
  meaning or hard-coding provider limits.
- The Stage Gate remains honest about the boundary between local/fixture
  qualification and live Cloudflare, GitHub, runner, package, identity, or
  tenant-provider execution.

## Rejected alternatives

- **Declare P3 ready from merged issue states:** issue state does not carry
  Evidence context, freshness, operational usage, recovery, or risk decisions.
- **Leave agent and customer-install criteria implicit:** a future reader or
  agent would not know which receipt closes the newly resolved trust paths.
- **Block every stage when a provider feed is unavailable:** this turns a
  provider outage into an unmeasured product limit; the feed state is advisory
  while the uncertainty and reconciliation action remain explicit.
- **Silently accept deferred risks:** a green status without advisories would
  hide the exact residual boundary and invite a universal-support inference.
- **Replace the registry with a dashboard boolean:** dashboards are views;
  the versioned Evidence, operational, recovery, and Residual Risk records are
  the authority for the gate.
