# Receipt-backed costs, quotas, billing, and packaging

Status: Accepted

## Context

Anyam's logical work does not map one-to-one to provider billing. One `anyam
check` may create several provider requests, Queue operations, Workflow steps,
container seconds, model calls, log events, and Evidence objects. Conversely,
provider invoices are delayed, may be restricted, and do not provide the
real-time control needed to stop a runaway agent or public mirror.

Issue [#31](https://github.com/wms2537/anyam/issues/31) asked for measurable
cost drivers, abuse surfaces, quotas, budget controls, metering boundaries,
and packaging hypotheses across all Hosting Modes. The primary-source research
is recorded in
[`docs/research/2026-08-02-costs-quotas-billing.md`](../research/2026-08-02-costs-quotas-billing.md).

The current receipts also include a material drift boundary: Cloudflare
Workflows step/storage billing begins no earlier than 10 August 2026, and
Artifacts remains a beta dependency. Provider pricing and limits therefore
remain dated planning inputs rather than immutable Anyam contracts.

## Decision

Anyam meters two related but distinct layers:

```text
Logical Anyam work
  Project, Source Space, Repository, Workspace, Change, Run, Evidence,
  Artifact, Release, Target, Promotion, Mirror, Agent Task

Provider consumption
  requests, CPU, memory, storage, operations, rows, dimensions, steps,
  active container resources, egress, logs, model usage, and API calls
```

Customer-facing budgets use logical Anyam units. Cost attribution and invoice
reconciliation retain provider units and SKUs. A provider request is not a
customer-facing Run, and a customer-facing Run must not hide its provider fan
out.

### Usage Receipt and Provider Cost Receipt

Every billable or budget-relevant operation produces an immutable `UsageReceipt`
with:

```text
receipt ID and schema version
recorded time and usage period
Hosting Mode / Realm / Organization / Project
Source Space / Repository / Workspace
Principal / Actor / Client / Session / Task
Intent / Change / Revision / Run / Attempt
logical unit and provider/adapter resource
provider SKU and consumed/pricing quantity/unit when known
estimated cost, currency, and price-version when known
included allocation applied
retry/duplicate class and source idempotency key
disclosure class
```

A `ProviderCostReceipt` reconciles Anyam Usage Receipts with provider billable
usage or invoice rows. It records provider-measured quantity, Anyam-attributed
quantity, estimated cost, billed cost, included allocation, corrections,
discounts, shared overhead, variance, and provider-feed status. A Usage Receipt
is an attribution claim, not an invoice.

Use a FOCUS-shaped projection for open cost vocabulary where useful, but do not
claim a provider feed is FOCUS-conformant unless it has been qualified.

Metering boundaries are:

1. One Command Envelope and idempotency key produce one logical command outcome.
2. One accepted aggregate transition produces one logical event/usage receipt;
   provider retries remain separate provider observations.
3. Each Run Attempt records its own compute, retry, output, and external cost.
4. Artifact/Evidence bytes, retention, and retrieval are attributed by object
   digest, not only by Release.
5. Target health checks, deployment calls, and external charges belong to the
   Promotion/Target.
6. Model calls carry Task/Run, model/provider, token or Neuron use, and budget
   decision.
7. Mirror synchronization belongs to the Mirror and canonical Change.

Double-counting is explicit: Queue write/read/retry/delete remain provider
operations, not four customer-facing Runs; one Build Run may emit many typed
Artifacts; a CLI command replay with the same idempotency key does not double
charge logical work.

### Cost drivers and abuse surfaces

The first measurement plan covers:

- Git storage, workspace lifecycle, clone/fetch/push/fork/import/export, LFS,
  projection and mirror churn, indexing, and quarantined imports;
- Workers/DO requests and duration, D1 rows/storage, R2 object operations and
  retention, event volume, and live activity sessions;
- Run CPU, memory, disk, wall time, image storage, egress, retries, logs,
  Evidence, model/provider calls, and external Runner time;
- Queue messages, retries, backlog, DLQ, Workflow steps/state/retries,
  health checks, and Target API calls;
- hosted application requests/scripts/CPU when Workers for Platforms is used;
- support, recovery drills, export verification, provider reconciliation, and
  managed operations.

Abuse cases include public clone/fork/import storms, abandoned Workspaces and
previews, retry/Queue/Workflow loops, log/Evidence stuffing, semantic-index or
AI amplification, mirror churn, API 429 storms, malicious Actions/Verifiers,
cryptomining, public preview traffic, and denial-of-wallet attacks against a
shared Hosted SaaS account.

### Budget and quota policy

Budgets are policy objects, not scattered conditionals. Their scope narrows:

```text
Realm → Organization → Project → Source Space/Target → Task/Run
```

The effective budget is the intersection of inherited policy and explicit
denies. Dimensions remain separate:

```text
storage, repository operations, Run compute, concurrency, Queue,
Workflow, logs/Evidence, search/vector dimensions, AI/model use,
provider API automation, mirror sync, and egress
```

Distinguish three boundaries:

- **Provider hard tripwire:** an adapter limit that cannot be exceeded;
- **Anyam safety tripwire:** a measured limit that protects integrity,
  availability, or shared capacity;
- **Owner budget:** a policy choice that warns, pauses for approval, downgrades
  a Runner/model, queues work, or blocks new work.

Every denial or approval request names:

```text
budget name and scope
configured/provider limit and receipt
requested amount
consumed/reserved amount
reset or expiry
uncertainty/reconciliation status
safe remediation or approval action
```

The budget state is explicit:

```text
within_budget
  → near_budget
  → approval_required or degraded
  → exhausted
  → reset / top_up / policy_change / cleanup
```

Thresholds and numeric values are not selected until K0 fixtures produce
distributions, peaks, retry/cleanup lag, and provider receipts. A healthy
workload touching a tripwire triggers remeasurement rather than silent
truncation. Provider budget alerts are a second alarm; Anyam's ledger is the
enforcement path.

### Hosting Mode billing ownership

#### Customer-operated Realm

The customer owns the Cloudflare bill, external Runner, model provider, and
Target costs. Anyam supplies an on-account Usage Receipt ledger, budget
policy, dashboard/export, and optional provider-billing adapter. There is no
required Anyam subscription or SaaS account. Support, upgrades, and recovery
services may be offered without withholding first-party capabilities.

#### Managed Customer-Account

The customer account and Cloudflare invoice remain authoritative for provider
usage. Anyam displays estimated and reconciled usage separately from its
operations/service fee, through explicit revocable grants. Anyam cannot promise
to cap resources that the customer independently creates or controls.

#### Hosted SaaS

Anyam owns the provider account and must attribute shared and direct overhead by
a declared policy. The product may use a pooled allowance for ordinary control
plane work and meter or require approval for expensive execution, hosted
agents/models, retained Evidence/Artifacts, public previews, mirrors,
external Runners, and managed application Targets. External model spend is
pass-through or explicitly budgeted; it is never hidden in an opaque plan.

### Packaging hypotheses

These are hypotheses, not public prices:

1. **Open-source core plus operating modes:** Customer-operated has no license
   fee; Managed has optional operations/support; Hosted is a capacity/service
   offering. All use the same open capabilities.
2. **Pooled ordinary work plus metered expensive work:** basic Project/source/
   Change coordination is predictable; compute, agents, models, large retained
   objects, public previews, and external execution require a budget/approval.
3. **Bring-your-own execution/model keys:** Anyam can operate coordination while
   customers own Cloudflare, Runner, or model-provider bills.
4. **Project budget envelopes:** cost follows Tasks, Runs, Artifacts, and
   Targets rather than seats alone. Seats remain an optional identity/support
   dimension.
5. **Paid operations layer:** upgrade/migration automation, recovery drills,
   managed accounts, policy/compliance assistance, and support are services,
   not proprietary product capability tiers.

Public dollar amounts, free allowances, margins, and overage behavior wait for
the measurement program and a separate commercial decision.

### Measurement and reconciliation

The K0 fixtures are measured in normal and abuse-shaped profiles:

```text
clone/fetch/push/fork/import
Workspace create/abandon/cleanup
Change revisions and reviews
Run success/failure/retry/cancel
preview create/idle/expire
Evidence/log retention and retrieval
mirror sync/divergence/recovery
agent context/model calls
```

Each receipt records Anyam commit/schema/policy, Hosting Mode/Realm/Project,
fixture/workload, provider/SKU/region, raw quantity/unit, included allocation,
price version, identifiers, sample/concurrency/measurement method, outcome,
estimated and billed cost where available.

Reconciliation is:

```text
Anyam Usage Receipts (near real time)
  → provider usage/metrics snapshots
  → provider billing/invoice rows where available
  → variance report
  → rate-card or adapter correction Change
```

Shared Hosted SaaS overhead is allocated by a declared policy and never silently
charged to one Project. Customer-owned provider billing remains customer-owned.

### Stage qualification

#### K0

Open schemas and ledger instrumentation exist for UsageReceipt,
ProviderCostReceipt, BudgetPolicy, BudgetDecision, and Policy Explanation. The
two reference projects and hybrid fixture produce receipts; local use does not
pretend to know future Cloudflare invoices.

#### Private alpha

Customer-operated execution exposes usage, budget decisions, cleanup lag,
retry amplification, and provider-limit errors. Abandoned Workspaces/previews,
agent loops, and cancellation are observable and recoverable. No pricing is
published.

#### Public beta

Hosted and Managed modes show bill ownership clearly, reconcile provider usage
where available, enforce per-Project/Task budgets, and surface customer-safe
usage reports. A public budget or quota is published only with a receipt and a
named owner.

#### Expansion

Packaging, support commitments, retention/residency pricing, external model
pass-through, and enterprise allowances receive their own commercial and
qualification decisions. A provider status or price change triggers a rate-card
update and remeasurement Change.

## Consequences

This model makes cost visible to developers, agents, operators, and customers
without coupling logical product semantics to Cloudflare SKU changes. It
prevents a public Project, mirror, or autonomous agent from spending an
unbounded shared account budget and preserves a credible Customer-operated
path.

The cost is instrumentation and reconciliation work before Anyam can publish
simple pricing. That is intentional: a quota or “unlimited” plan without a
receipt is a landmine, and an opaque denial is worse than an explicit budget
decision with a remediation path.
