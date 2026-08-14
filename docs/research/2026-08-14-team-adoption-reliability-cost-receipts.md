# Team adoption reliability and cost receipts

**Status:** Decision-grade research  
**Date:** 14 August 2026  
**Ticket:** [#189 — Measure team adoption reliability and cost receipts](https://github.com/Whyme-Labs/anyam/issues/189)  
**Map:** [#182 — Make Anyam credible for a real team](https://github.com/Whyme-Labs/anyam/issues/182)

## Decision

Anyam will not publish team-adoption latency, quota, concurrency, cost,
retention, availability, or SLO numbers from a single qualification run or
from a provider's documented limit. The next team gate is a receipt program:
measure representative user-visible workloads, preserve the exact observation
context, reconcile provider usage where possible, and only then choose a
tripwire or Reliability Objective.

The existing qualification contracts are the source of truth. They already
define `MeasuredQuantity`, `ReliabilityObjective`, `UsageReceipt`,
`ProviderCostReceipt`, `BudgetPolicy`, `BudgetDecision`, and `RecoveryDrill` in
[`src/qualification/stages.ts`](../../src/qualification/stages.ts). This ticket
defines the measurement cohorts and operating rules; it does not add a second
receipt schema.

The adoption gate is a cohort acceptance criterion, not a public platform SLO.
The existing credible-team gate remains the authority for the cohort: named
human users, real Changes with Evidence, at least one verified Release, and
complete export/restore evidence. The number of people, Changes, days, and
other stage criteria are gate inputs with receipts, not promises to every
Anyam installation.

## Measurement cohorts

Each cohort is an immutable workload profile with a source revision, manifest,
policy, fixture, and observation method. Do not report an “average user”
without naming the workload that produced it.

| Cohort | User-visible journey | Required observations |
| --- | --- | --- |
| `local-development` | Scaffold/import, inspect, edit, snapshot, `check`, build, and package | source size and object shape, cache state, wall time, CPU/memory when available, failure and recovery behavior |
| `team-mutation` | Intent/Change, Workspace, revision publish, review, Integration Cohort, Landing | idempotency key, aggregate versions, conflict/policy outcomes, queue/workflow fan-out, duplicate side effects, terminal state |
| `agent-run` | Capability grant, Context Manifest, agent Run, verifier, Evidence, cancellation/revocation | principal/actor/client/session/task, exact view, grant expiry, tool/network use, input/output digests, model/compute usage, secret-use without value disclosure |
| `mirror-projection` | Anyam Landing to a remote projection and an inbound external proposal | canonical and remote refs/generations, delivery cursor, reconciliation attempts, divergence/force-push state, disclosure projection, loop prevention |
| `external-runner` | Queue offer, lease, signed attempt, immutable input, output upload, result acceptance | job/attempt/lease IDs, runner identity/profile, input and output digests, queue retry/ack, lease expiry, signature and output read-back, cleanup |
| `release-promotion` | Build Artifact, create Release, Target preview/apply/health, rollback | Release/Artifact/Target IDs and digests, provider operation IDs, health observations, route readiness, rollback lineage, no rebuild on rollback |
| `recovery` | Export, independent verification, restore into an isolated namespace, projection rebuild, resume | checkpoint/bookmark, export digest, restored refs and policy epoch, lost/duplicated effects, detection/restore/resume times, approval and follow-up Change |
| `provider-usage-cost` | Reconcile Anyam logical work to Cloudflare, Git, Runner, registry, model, and Target provider usage | raw provider quantity/unit/SKU, Anyam attribution, price version, feed status, estimate versus bill, variance and correction receipt |

The first two reference projects and the hybrid public/private Source Space
fixture should exercise the cohorts. A local or scripted fixture can prove
contract behavior; it cannot prove a customer-facing SLO or provider invoice.

## Receipt shape and attribution

Every observation must be attributable to the exact operation and context. At
minimum, retain:

```text
receipt/schema version
Anyam commit, contract, policy, and authorization epoch
Hosting Mode / Realm / Organization / Project / Source Space
Intent / Change / Revision / Project Revision / Workspace
Run / Attempt / Artifact / Release / Target / Promotion / Mirror
principal / actor / client / session / task / capability grant
fixture/workload profile and measurement method
source, input, effect, and output digests
startedAt / finishedAt / recordedAt and usage period
provider / adapter / region / provider operation ID
result: succeeded | failed | blocked | degraded | indeterminate | unknown
retry, duplicate, redelivery, cancellation, and cleanup observations
quantity/unit, resource usage, estimated cost, billed cost, and uncertainty
freshness/validity key, disclosure class, owner, and recovery action
```

The raw receipt must never contain access tokens, secret values, private source
outside its disclosure projection, or unbounded logs. Large evidence is a
content-addressed object referenced by digest.

Logical attribution and provider attribution remain separate. One Anyam
command may fan out to many provider requests; a Queue retry is not another
customer-facing Run; and a provider bill is not inferred from a local timer.
`ProviderCostReceipt.feedStatus=unavailable` is an explicit reconciliation
advisory, not a fabricated invoice.

Aggregate reports must retain the dimensions that explain cost and reliability:
Realm, Project, Source Space, Change, Run/Attempt, Artifact/Release/Target,
Actor/client, Runner, provider, and retry class. Do not average away private
versus public work, agent retries, mirror churn, or provider-induced failures.

## Measurement method

For every cohort:

1. Pin the exact Anyam revision, project manifest, fixture inputs, toolchain,
   dependency lock, environment, Runner profile, policy version, and disclosure
   projection.
2. Run a healthy baseline and an abuse-shaped/failure-shaped case. Record all
   attempts, including blocked and indeterminate results.
3. Use the same CLI, Git credential helper, MCP path, Gateway, and Target path
   that a user would use. A unit test of an adapter is not a black-box user
   measurement.
4. Preserve distributions and sample metadata. Use percentiles only when the
   receipt names the sample, population, observation window, and aggregation
   method. Do not convert a small fixture into a universal percentile.
5. Reconcile Anyam Usage Receipts against provider usage or billing rows when a
   supported feed exists. Keep estimated, provider-observed, billed, delayed,
   and unavailable states distinct.
6. Publish a tripwire only after the measured healthy distribution and failure
   envelope are reviewed by the owner. If a healthy workload touches the
   tripwire, remeasure rather than silently truncating it.

The user-visible SLI is the complete operation, not a raw Worker invocation or
Queue acknowledgement. For example, a successful invocation returning a stale
Project View is not a successful read, and an acknowledged queue message that
loses a Run result is not a successful Run.

## Freshness, uncertainty, and invalidation

Receipts are valid only for their declared validity key and context. Invalidate
or remeasure when any of these change:

- Anyam code, contract, schema, policy, authorization epoch, or disclosure
  projection;
- source fixture, Project Manifest, dependency lock, toolchain, Runner profile,
  region, or execution image;
- provider API, feature gate, pricing, limit, billing period, or service
  behavior;
- architecture, retry/cleanup behavior, cache strategy, or Target adapter;
- a new project type, hosting mode, model provider, registry, or Runner;
- an incident, provider outage, data-disclosure change, or observed tripwire.

There is no universal receipt TTL until freshness has been measured. A stale,
missing, failed, or indeterminate required receipt blocks the relevant gate;
it is not silently downgraded to a green dashboard. A delayed provider feed is
shown as delayed and carries its reconciliation next action.

## Reliability and adoption policy

Reliability Objectives are introduced per capability and Hosting Mode only
after the receipt program establishes a baseline. Candidate indicators include
safe Project View reads, authenticated command outcomes, Git transfer
completion, Change integrity, terminal Run/Evidence state, Release/Promotion
correctness, mirror health, audit completeness, and successful restore.

Error budgets are per capability, not one platform-wide uptime number. When a
mutation or recovery budget is exhausted, the safe policy is to freeze
non-essential Landing, schema, policy, and provider changes while allowing
incident mitigation, security response, and changes that restore the budget.
The threshold itself remains a later, receipt-backed policy Change.

The team adoption receipt should answer:

```text
Which named people and agent products used the canonical Anyam path?
Which real Changes reached Evidence and Landing?
Which Release/Target was verified?
Could the Project and provenance be exported and restored independently?
Were failures, provider outages, retries, and manual interventions visible?
Did the team continue using Anyam after the guided adoption window?
```

This is a decision gate for the credible-team map, not a claim that every
future project will meet one fixed time, cost, or availability target.

## Blacksmith and GitHub Actions boundary

The repository's GitHub Actions workflows remain a convenience CI projection,
not Anyam authority. If GitHub-hosted runner minutes are exhausted, Blacksmith
can be evaluated as an optional GitHub-integrated execution provider for this
repository. Its official quickstart requires a GitHub organization integration
and selecting Blacksmith `runs-on` labels; it is not a customer-operated Anyam
control plane or a replacement for the provider-neutral External Runner
contract ([Blacksmith quickstart](https://docs.blacksmith.sh/introduction/quickstart),
[GitHub Actions documentation](https://docs.github.com/en/actions)).

Therefore:

- do not make Blacksmith a prerequisite for #189 or for Anyam adoption;
- do not treat a Blacksmith/GitHub workflow receipt as proof of Anyam Runner,
  Target, Authority, or customer-owned recovery behavior;
- if selected later, qualify it through the same external Runner adapter:
  immutable input, narrowed job capability, signed result, output read-back,
  lease/expiry, retry/duplicate handling, provider cost, and cleanup;
- keep local checks and customer-owned pull Runners available so GitHub or
  Blacksmith availability never becomes the canonical path.

## Existing primary-source and repository receipts

- [Google SRE: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/) — define user-facing SLIs and error budgets from observed behavior rather than choosing targets from current performance.
- [Cloudflare API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) — provider rate limits and `retry-after` are adapter facts, not Anyam promises.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), and [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) — provider billable dimensions that must be reconciled rather than copied into Anyam quotas.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) — diagnostic retention/sampling limits; logs are not the authoritative audit ledger.
- [`docs/adr/0021-evidence-backed-acceptance-and-validation.md`](../adr/0021-evidence-backed-acceptance-and-validation.md) — performance is a receipt requirement and the three reference fixtures.
- [`docs/adr/0023-receipt-backed-costs-quotas-and-packaging.md`](../adr/0023-receipt-backed-costs-quotas-and-packaging.md) — logical versus provider metering, cost attribution, and budget policy.
- [`docs/adr/0038-stage-gates-and-operational-receipts.md`](../adr/0038-stage-gates-and-operational-receipts.md) — exact-context freshness, typed blockers, measured quantities, and recovery drills.
- [`docs/research/2026-08-02-reliability-operations-recovery.md`](2026-08-02-reliability-operations-recovery.md) — provider outage, observability, recovery, and hosting-mode boundaries.

## Non-claims

This note does not claim that Anyam currently has a production telemetry
pipeline, provider invoice reconciliation for every service, a Blacksmith
integration, a universal SLO, or a measured team adoption result. Those are
separate implementation or qualification tasks with their own receipts.
