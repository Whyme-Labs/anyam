# Anyam costs, quotas, billing, and unit economics

**Research snapshot:** 2 August 2026
**Ticket:** [#31](https://github.com/Whyme-Labs/anyam/issues/31)
**Status:** Decision-grade research. Provider facts below are receipts from current first-party documentation available at the snapshot date. Anyam quotas, customer-facing prices, and margin targets are recommendations or hypotheses; they are not final commitments.

## Executive decision

Anyam must meter two different things:

```text
1. Logical Anyam work
   Project, Source Space, Repository, Change, Run, Evidence, Artifact,
   Release, Target, Mirror, and Agent Task.

2. Provider consumption
   Requests, CPU time, storage, operations, rows, dimensions, steps,
   active container resources, egress, logs, model usage, and API calls.
```

Customer-facing budgets should be expressed in the first vocabulary. Internal cost attribution and invoice reconciliation must retain the second. A single provider request is not a customer-visible unit, and a single customer command can fan out to several provider SKUs.

The first Anyam release should not publish arbitrary numeric quotas or public prices. It should ship instrumentation and a receipt pipeline, exercise the two K0 reference projects and the hybrid Source Space case, then set tripwires above measured healthy distributions. Every budget failure must name the budget, configured limit, and requested amount. Provider limits are adapter receipts, not Anyam product promises.

The recommended commercial shape is:

| Hosting Mode | Who owns the Cloudflare bill? | Anyam billing hypothesis |
|---|---|---|
| Customer-operated Realm | Customer | No license fee; customer pays Cloudflare and optional external runners. Optional paid support/upgrades may exist without withholding first-party capabilities. |
| Managed Customer-Account | Customer | Anyam service/operations fee can cover the selected control-plane and managed execution work. Cloudflare usage remains visible and billed to the customer account. |
| Hosted SaaS | Anyam | Subscription or usage-backed service with a pooled included allowance, explicit overage or hard budget behavior, and pass-through treatment for external model providers. |

Anyam remains fully open source and capability-complete across modes. Packaging is about who operates and pays for capacity, not a proprietary feature split.

## Current provider facts and receipts

The following are provider facts, not Anyam decisions. Dates are the update dates shown by Cloudflare documentation where available.

| Surface | Current documented fact/status | Cost or quota consequence |
|---|---|---|
| Workers Standard | Workers Paid has a **$5/month minimum account charge**, 10 million included requests/month, 30 million included CPU milliseconds/month, then `$0.30` per additional million requests and `$0.02` per additional million CPU milliseconds. There is no charge for request egress or throughput. The pricing page was last updated 7 July 2026. | Control-plane request volume and CPU are real cost dimensions. Static assets are free and unlimited, but requests invoking Workers and cache-served Worker requests are billable. Receipt: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). |
| Workers limits | Workers Paid documents 128 MB memory, 5-minute maximum CPU per invocation (30 seconds default), 10,000 subrequests/invocation by default, 500 Workers/account, and 250 Cron Triggers/account. Free has 100,000 requests/day and 10 ms CPU/invocation. Last updated 5 July 2026. | Anyam should make command and provider failures explicit rather than treating a provider 1102/1027 response as a generic failure. Receipt: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). |
| Durable Objects | Paid compute is 1 million requests/month included then `$0.15`/million, and 400,000 GB-s/month included then `$12.50`/million GB-s. SQLite-backed storage uses D1-like row rates; KV-backed DO storage has separate 4 KB request units and storage rates. Last updated 19 June 2026. | A hot coordinator or non-hibernating connection can cost more through duration than request count. Aggregate design must avoid idle open connections and accidental per-message work. Receipt: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). |
| Durable Objects limits | SQLite-backed DOs document 500 classes/account on Paid, 10 GB/object, 2 MB combined key/value, and 30 seconds default CPU/request configurable to 5 minutes. Last updated 1 June 2026. | DO classes, object size, SQL row size, and active duration are adapter tripwires. Receipt: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/). |
| D1 | Paid includes 25 billion rows read/month, 50 million rows written/month, and 5 GB storage; overage is `$0.001`/million rows read, `$1.00`/million rows written, and `$0.75`/GB-month. D1 is scale-to-zero and does not charge for idle compute. Last updated 21 April 2026. | Query shape and indexing directly affect cost: rows scanned, not only rows returned, are metered. Anyam read models need measured query receipts. Receipt: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). |
| R2 | Standard storage is `$0.015`/GB-month; Class A operations `$4.50`/million; Class B `$0.36`/million. Infrequent Access is cheaper storage but has retrieval charges. R2 egress is free, including Workers, S3 API, and `r2.dev`. | Evidence, release assets, logs, exports, LFS objects, and caches have storage and operation costs even when network egress is free. Retrieval and repeated list/read patterns need attribution. Receipt: [R2 pricing](https://developers.cloudflare.com/r2/pricing/). |
| R2 limits | R2 documents unlimited bucket storage/objects, up to 1,000,000 buckets/account, 5 TiB maximum object size, 5 GiB single-part upload, 10,000 multipart parts, and one concurrent write/second to the same key. `r2.dev` is test-oriented and throttled. Last updated 8 June 2026. | Large objects belong in R2, not Workflow state or Queue messages. Object-key hot spots and public test endpoints need visible tripwires. Receipt: [R2 limits](https://developers.cloudflare.com/r2/platform/limits/). |
| Artifacts | Paid pricing is first 10,000 operations/month plus `$0.15`/additional 1,000 operations, and first 1 GB-month plus `$0.50`/additional GB-month. Artifacts limits document 2,000 control-plane requests/10 seconds/namespace, 2,000 Git requests/10 seconds/artifact, 10 GB/repository, 1 TB/account by default (raiseable), and unlimited repositories/namespaces. Pricing page last updated 21 April 2026; limits page last updated 4 May 2026. | Every clone, fetch, push, pull, fork, import, and workspace repository lifecycle operation must be attributable. Per-agent repositories are operationally attractive but can multiply operation and storage spend. Receipts: [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/), [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/). |
| Artifacts status | Cloudflare announced Artifacts on 16 April 2026 as a private beta and described a planned public beta. The official blog still labels the launch private beta; the public documentation exposes pricing and limits but does not make a GA guarantee. | Artifacts remains behind `Repository Driver`; Anyam must retain generic Git import/export and a fallback driver. Do not model a public Anyam price on an unqualified beta dependency. Receipt: [Cloudflare Artifacts announcement](https://blog.cloudflare.com/artifacts-git-for-agents-beta/). |
| Queues | Paid includes 1 million operations/month, then `$0.40`/million. Each 64 KB chunk written, read, or deleted is an operation; a normal delivered message commonly costs three operations. Retries add reads; DLQ writes add writes. Paid retention defaults to 4 days and is configurable to 14 days. Last updated 21 April 2026. | Queue retry storms and oversized messages are direct spend multipliers. Queue messages should be pointers to Run/Artifact objects, not source archives or logs. Receipt: [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/). |
| Queues limits | 10,000 queues/account, 128 KB message size, 100-message consumer batch, 5,000 messages/second/queue, 100 retries, 25 GB backlog/queue, 250 concurrent push consumers, and 15-minute consumer wall time. Last updated April 2026. | These are provider boundaries for dispatch; Anyam should meter logical dispatches, retries, bytes, and backlog and surface provider errors verbatim. Receipt: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/). |
| Workflows | Workflows uses Workers request/CPU pricing. Starting **no earlier than 10 August 2026**, Paid billing adds 500,000 steps/month then `$0.80`/additional 100,000 steps, and 1 GB-month state then `$0.20`/GB-month. Last updated 21 July 2026. | Billing is about to change relative to this snapshot. Re-run qualification after the billing start. Step design, retries, retention, and persisted state are cost drivers. Receipt: [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [billing changelog](https://developers.cloudflare.com/changelog/product/workflows/). |
| Workflows limits | Paid documents 1 MiB event/non-stream result, 1 GB persisted state/instance, 25,000 configurable steps, 50,000 concurrent running instances, 300 starts/second/account, 2,000,000 queued instances, 30-day completed-state retention, and 10,000 retries/step. Last updated 15 June 2026. | Workflows is orchestration, not the Anyam ledger or Evidence store. Large outputs must be R2 references. Receipt: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/). |
| Containers/Sandbox | Containers are billed every 10 ms. Paid includes 375 vCPU-minutes, 25 GiB-hours memory, and 200 GB-hours disk; overage is `$0.000020`/vCPU-second, `$0.0000025`/GiB-second, and `$0.00000007`/GB-second. Container egress includes 1 TB North America/Europe, 500 GB Oceania/Korea/Taiwan, or 500 GB elsewhere, with prices from `$0.025` to `$0.05`/GB after allotment. Sandbox also incurs Workers, DO, and optional Workers Logs charges. Receipt: [Workers pricing, Containers section](https://developers.cloudflare.com/workers/platform/pricing/), [Sandbox pricing](https://developers.cloudflare.com/sandbox/platform/pricing/). | Build/preview/agent execution is the largest variable cost in ordinary Anyam workloads. Active duration, instance size, cold-start/image work, disk, egress, retries, and abandoned sandboxes must be metered per Run/Attempt. |
| Container limits | Current predefined types range from `lite` (1/16 vCPU, 256 MiB, 2 GB) to `standard-4` (4 vCPU, 12 GiB, 20 GB). Custom types cap at 4 vCPU/12 GiB/20 GB; account limits document 6 TiB concurrent memory, 1,500 vCPU, 30 TB disk, and 50 GB image storage. Last updated 3 July 2026. | These are capacity receipts, not healthy Anyam quotas. A customer request beyond the provider envelope must become a named qualification failure or external Runner selection. Receipt: [Containers limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/). |
| Workers Logs | Paid includes 20 million log events/month then `$0.60`/million, with 7-day retention; Free includes 200,000/day and 3-day retention. A log is capped at 256 KB, and account daily volume is capped at 5 billion with 1% sampling after the cap. Last updated 29 July 2026. | Logs are a cost and disclosure surface. Sampling can reduce cost but cannot replace unsampled security/audit facts in Anyam's own ledger. Receipt: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/). |
| Vectorize | Paid includes 50 million queried vector dimensions/month and 10 million stored vector dimensions; overage is `$0.01`/million queried dimensions and `$0.05`/100 million stored dimensions. Last updated 21 April 2026. | Semantic indexing can be cheap per query but expensive at high dimensions and ingestion volume. Meter dimensions, not just search requests. Receipt: [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/). |
| Workers AI | Paid usage over 10,000 Neurons/day is `$0.011`/1,000 Neurons. Pricing is model-dependent and the page was last updated 29 July 2026. | If Anyam operates model calls, model/provider/neuron spend is a separate budget from compute. If users bring provider keys, Anyam should preserve usage receipts without claiming the provider invoice is exact. Receipt: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). |
| AI Gateway | Spend limits can block requests at a dollar budget and scope by model, provider, user/team/application metadata. Cloudflare documents that enforcement is eventually consistent and can briefly overshoot under concurrency. Last updated 18 June 2026. | AI Gateway is a useful adapter, not a correctness boundary. Anyam needs its own task budget, an explicit overshoot allowance, and a terminal `budget_exceeded` state. Receipt: [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/). |
| Workers for Platforms | Paid plan is `$25/month`, includes 20 million requests, 60 million CPU ms, and 1,000 scripts; extra scripts are `$0.02` each. One request is charged across the dispatch→user→outbound chain, and custom per-user CPU/subrequest limits are supported. Last updated 21 April 2026. | Hosted SaaS application Targets using WFP need per-Project attribution, custom limits, and explicit handling of scripts created/deleted by users. Receipt: [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/), [custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/). |
| Cloudflare API | Global API rate limit is 1,200 requests per 5 minutes per user/account token; HTTP 429 includes `retry-after`. Account API token quotas are also documented. Last updated 20 April 2026. | Cloudflare account control-plane automation must have a request budget and centralized backoff. A provider 429 is not a license to retry every operation blindly. Receipt: [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/). |
| Cloudflare billing visibility | Cloudflare exposes an account billable-usage API (currently documented as Version 2, Alpha, Restricted) with `ConsumedQuantity`, `ConsumedUnit`, `BilledCost`, `PricingQuantity`, `PricingUnit`, product family, account, and period fields. | Use Anyam's own usage ledger for near-real-time controls and reconcile against the provider's billable-usage records when available. Do not make a restricted alpha billing API the sole launch dependency. Receipt: [Billing API usage](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get/). |
| Cloudflare budget alerts | Pay-as-you-go accounts can configure account-wide budget alerts; they are informational only and do not pause/cap usage. The 20 July 2026 changelog says a `$10` default alert is rolling out to eligible accounts; usage is processed daily, not real time. | Provider alerts are a second alarm, never Anyam's budget enforcement. Customer-facing budget state must be based on Anyam's command/Run ledger and provider reconciliation. Receipts: [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), [default-alert changelog](https://developers.cloudflare.com/changelog/product/billing/). |

## Cost-driver model

### 1. Source and repository plane

The main source costs are:

- Canonical Repository storage and history.
- Workspace Repository creation and deletion.
- Git clone, fetch, push, pull, fork, import, export, and mirror operations.
- Git LFS or other large-object storage and transfer.
- Public projection and two-way mirror churn.
- Search/index extraction and semantic embedding.
- Quarantined imports and retained incomplete Import Operations.

Artifacts' pricing is deliberately operation- and storage-based, not repository-count-based. A repository-per-agent design is therefore operationally attractive but not free: every agent lifecycle creates storage and operation observations. Artifacts' own best-practices page recommends one repository per agent/session/application when isolation matters, so Anyam should retain the isolation model and meter cleanup/retention rather than silently reusing a shared branch namespace. Receipt: [Artifacts best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/).

Anyam customer units:

```text
Repository operation
Workspace Repository lifetime
stored Source Space bytes
stored Project Export bytes
Git transfer bytes (where available)
indexing run
queried/stored vector dimensions
```

### 2. Control and coordination plane

The Project Coordinator and Change state consume Worker requests/CPU, Durable Object request/duration/storage, D1 rows/storage, and R2 event/export objects. Hot aggregates, live activity streams, repeated polling, and oversized event payloads amplify cost. Anyam should prefer event-driven subscriptions and opaque cursor reads over aggressive browser polling; hibernating WebSockets should be qualified before being used for live activity.

Customer units:

```text
command envelope
domain event recorded
aggregate version transition
read-model query page
live activity session
```

A command that is rejected by policy still consumes control-plane work but should be visible as a policy-decision event. Replaying an idempotency key must not double-charge logical work; provider retries remain separate cost observations.

### 3. Execution plane

Builds, tests, verifiers, previews, agent sessions, import scans, publication scans, and mirror reconciliation are Runs. The provider cost envelope includes:

```text
Run active CPU time
Run memory-seconds
Run disk-seconds
container image storage
network egress
subrequests and API calls
retry attempts
logs and Evidence output
external Runner time or pass-through charge
```

An abandoned Preview or Agent Task can continue consuming a Container, Workflow, DO, AI, and log budget after the browser disconnects. Run cancellation must revoke the Capability Grant first, issue best-effort provider cancellation, and record any unable-to-stop state. The cost ledger must include late output and late-provider usage even when Anyam rejects the result.

### 4. Delivery and observability plane

Queue dispatch and retries, Workflow steps and retained state, R2 Evidence/Artifact objects, Workers Logs/traces, and health checks are all metered or storage-bearing. A successful Build can be cheap while its retained logs, preview traffic, and repeated health checks dominate the monthly bill.

Customer units:

```text
Run dispatch
Run attempt
Workflow step
Workflow persisted-state GB-month
Evidence object bytes and retrievals
Candidate Output lifetime
log event / trace event
health probe
```

### 5. Application Target plane

Hosted SaaS may additionally operate user applications through Workers for Platforms. That introduces requests, CPU, scripts, user-worker bindings, preview traffic, custom domains, and per-customer isolation costs. A Customer-operated Realm's deployed app belongs to the customer's Cloudflare account and should not be presented as Anyam-hosted usage. The same Project/Release/Target semantics apply, but billing responsibility changes with Hosting Mode.

### 6. Agent and model plane

Agent costs include model input/output tokens or Neurons, tool calls, MCP/API traffic, context construction, repeated retries, local/remote Runner time, and generated Candidate Outputs. The costly unit is not an “agent message”; it is the complete Task execution graph.

Anyam should attach every provider call to:

```text
Principal → Actor → Session → Task → Intent/Change → Run/Attempt
```

Model provider policy and user authority are separate. A user permitted to read a private Source Space is not thereby permitted to send it to every external model.

## Abuse surfaces and denial-of-wallet controls

### Repository and mirror abuse

| Surface | Abuse | Required control |
|---|---|---|
| Public clone/fetch | Clone storm, repeated shallow/full fetches, automated enumeration | Anonymous public read only on disclosed Project View; edge rate limits; cache immutable refs where safe; account/project attribution for authenticated transfer; abuse suspension without weakening source integrity |
| Fork/import | Fork bomb, repeated import from an external remote, import retry loop | Idempotent Import Operation; staged quarantine; deduplicate by source digest; per-Project and per-Principal operation budget; explicit cleanup/retention policy |
| Agent workspaces | Thousands of abandoned Workspace Repositories | Lease/expiry state, garbage-collection receipts, owner-visible retained bytes and operation counts, no silent deletion of unexported changes |
| Public/private projection | Repeated publication attempts or metadata probing | Publication Change, safe `not_found`, disclosure scan, independent approval, no hidden-object enumeration |
| Two-way mirrors | Oscillation, force-push churn, conflict loops, remote outage retry | Canonical Anyam authority, loop markers, backoff, divergence state, bounded reconciliation work, no last-writer-wins |

### Execution and build abuse

| Surface | Abuse | Required control |
|---|---|---|
| Agent Task | Prompt loop, tool loop, repeated revision spam | Task budget over time, model spend, Run count, revision count, source-write scope, and external side effects; terminal `budget_exceeded` with receipt |
| Build/Verifier | Fork bomb, dependency download storm, intentionally slow tests, huge output | Action-declared resource/network profile, Runner limits, dependency cache quotas, output-byte and log-event budgets, cancellation/revocation, no unrestricted internet by default |
| Preview | Infinite preview instances or high-volume synthetic traffic | Preview lease/idle shutdown, target traffic cap, explicit public/private URL policy, health-check budget, cleanup checkpoint |
| Container | Hold-open memory/disk/CPU, image churn, egress abuse | Per-Run active resource budget, sleep/destroy policy, image retention/GC, egress allowlist, provider custom limits, external Runner escalation for oversized jobs |
| Queue | Poison message, retry storm, DLQ flood, oversized dispatch | Pointer-only messages; dedupe by Run/Attempt; retry budget; DLQ dashboard; queue byte/backlog tripwires; provider error shown with requested amount |
| Workflow | Step/retry explosion, long-lived state, duplicate restart side effects | Idempotent step contracts; R2 references instead of state payloads; per-Run step/retry/state budgets; workflow lifecycle reconciliation |

### Storage, search, and telemetry abuse

- Evidence/log stuffing: cap and meter bytes, object count, and retention; store large outputs in R2 and return digests.
- Vector ingestion/query amplification: meter stored and queried dimensions; cap dimensions and batch size per Action; do not count a query as “one search” when it scans arbitrary dimensions.
- D1 full scans: record `rows_read` and `rows_written` per query; indexes can reduce reads but index writes can increase writes.
- Audit-log injection: privileged audit events are bounded structured records; unbounded model output is an R2 object with disclosure policy, never embedded directly in the ledger.
- Observability sampling: sampled logs/traces are for diagnosis, not proof of authorization or Landing/Promotion.

### External provider and billing abuse

- Cloudflare API token request storms can exhaust the 1,200/5-minute global user/account-token limit and block unrelated administrative work. Centralize provider calls and apply per-Provider request budgets/backoff.
- External model/API calls may have different billing windows, retries, and provider invoices. Model provider credentials must be brokered; Anyam records request metadata and provider response usage but does not promise exact invoice parity without a provider billing feed.
- Customer-owned accounts must not be treated as an Anyam free-resource pool. In Managed Customer-Account and Customer-operated modes, customer budgets and provider billing remain authoritative for Cloudflare usage.

## Recommended metering contract

### Logical usage ledger

Anyam should record one immutable Usage Receipt for every billable or budget-relevant operation:

```text
usage_receipt_id
schema_version
recorded_at / usage_period
hosting_mode / realm / organisation / project
source_space / repository / workspace
principal / actor / client / session / task
intent / change / change_revision / run / attempt
logical_unit
provider / adapter / provider_resource_id
provider_sku (if known)
consumed_quantity / consumed_unit
pricing_quantity / pricing_unit (if known)
estimated_cost / billing_currency / price_version (if known)
included_allocation_applied
retry_or_duplicate_class
disclosure_class
source_event_id / idempotency_key
```

The usage receipt is not an invoice. It is a reproducible attribution claim. A later reconciliation receipt links it to provider billable-usage rows and records variance, corrections, and provider status.

### Metering boundaries

Use the following boundaries:

1. **Command boundary:** one Anyam command envelope (REST, CLI, MCP, web, Git Gateway) has one idempotency key and one logical outcome.
2. **State boundary:** one accepted aggregate transition creates one domain event and one usage receipt for logical work, even if provider retries occur.
3. **Run boundary:** each attempt has its own provider consumption, output, and retry classification.
4. **Artifact boundary:** bytes stored, retrieved, retained, and deleted are tracked by digest/object, not only by Release.
5. **Target boundary:** Target health checks, deployment API calls, and external provider charges are attributed to Promotion/Target.
6. **Model boundary:** every model call carries Task/Run metadata, model/provider, token or Neuron usage, and budget decision.
7. **Mirror boundary:** remote sync work is attributed to a Mirror and canonical Change, never hidden inside generic repository operations.

Avoid double counting:

- A CLI `anyam check` that calls one Run API command should be one logical Run, even if the API retries internally.
- A Queue write, read, retry, and delete remain provider operations; they do not become four customer-facing Runs.
- A Build that emits five Artifacts is one Run with five Artifact objects, each with separate stored bytes and retrieval costs.
- A public clone may be unauthenticated, but Anyam must still meter it at the provider/edge layer for abuse control even if it is not customer-billed.

### Provider reconciliation

Use the Cloudflare billable-usage API where it is available and qualified, but treat it as a delayed/restricted reconciliation source. Cloudflare's usage API exposes consumed and pricing quantities, units, list/effective/billed cost fields, product family, account, and charge periods. The [FinOps Open Cost and Usage Specification (FOCUS)](https://focus.finops.org/focus-specification/v1-3/) provides a useful open vocabulary for `BilledCost`, `ConsumedQuantity`, `PricingQuantity`, `PricingUnit`, billing periods, corrections, and invoice alignment; Anyam should export a FOCUS-shaped projection without claiming Cloudflare's feed is already FOCUS-conformant.

Reconciliation process:

```text
Anyam Usage Receipts (near real time)
        ↓
Provider usage/metrics snapshots (daily or provider-available)
        ↓
Provider billable-usage/invoice rows (when available)
        ↓
Variance report
        ↓
Price/rate-card version or adapter correction Change
```

The report must distinguish:

```text
provider-measured usage
Anyam-attributed usage
estimated cost
provider-billed cost
included allocation
discount/contract correction
unattributed/shared overhead
```

Shared control-plane overhead should never be silently charged to one Project. In Hosted SaaS, allocate shared costs by a declared policy (for example, pooled overhead plus direct usage) and expose the allocation method. In Managed Customer-Account mode, show direct Cloudflare usage from the customer's account and Anyam's managed-service usage separately.

## Quota and budget controls

Anyam should define a budget policy across five scopes:

```text
Realm → Organisation → Project → Source Space/Target → Task/Run
```

Budgets are a set of dimensions, not one universal “requests” limit:

| Dimension | Hard tripwire candidate | Soft/approval budget candidate |
|---|---|---|
| Source storage | Provider repository/object size, total retained bytes | Project/Realm retained-byte allowance and retention class |
| Repository operations | Provider rate and request/body limits | Project/Actor clone/fetch/push/fork/import rate and monthly operation envelope |
| Run compute | CPU, memory, disk, wall time, process count, egress allowlist | Task/Project compute envelope and high-cost Action approval |
| Run concurrency | Provider account and Runner capacity | Project/Actor active Run budget and queue priority |
| Queue | Message size, backlog, retries, retention | Run dispatch/retry budget and DLQ review budget |
| Workflow | State/event result size, steps, starts, retries, retention | Run workflow step/state/retry budget |
| Logs/Evidence | Object/log size and provider retention | Project retention/bytes/events/retrieval allowance |
| Search | Vector dimensions, batch size, top-k, index capacity | Project index storage/query allowance |
| AI | Provider/model request/token/neuron ceilings | Task/Actor/Project dollar or token budget with approval |
| API automation | Cloudflare API rate limit | Provider request pool per operation class and backoff budget |
| Mirror | Remote rate/size limits | Mirror sync frequency, bytes, retries, and divergence repair budget |

Hard tripwires must fail closed for unsafe effects and fail explicitly for ordinary exhaustion. Soft budgets can pause for approval, downgrade to a cheaper Runner/model, or queue work. Every response should include:

```text
budget name
configured limit
requested amount
consumed amount
reset/expiry time
scope (Realm/Project/Task/etc.)
remediation or approval action
```

Do not set default numeric values until receipts exist. The first implementation should record distributions and use provider limits as outer bounds. A later policy Change can choose a tripwire above the measured healthy P99/P99.9 envelope plus an explicit margin, with an owner and receipt link.

Budget state machine:

```text
within_budget
    ↓
near_budget (warning / no behavior change)
    ↓
approval_required or degraded
    ↓
exhausted (new work blocked)
    ↓
reset / top_up / policy_change / cleanup
```

`near_budget` must not be based on an unmeasured percentage. The threshold itself is a policy Change after measurement. Provider budget alerts may be configured as a second safety net but are informational and delayed; Anyam's ledger is the enforcement path.

### Special rules for Hosted SaaS

- Use account-level and per-Project attribution. A customer must never be able to make a shared account pay for an unbounded public workload.
- Public read traffic may be free to the reader, but rate/abuse controls and cost ownership must be explicit.
- Default expensive operations (agent Runs, private verifiers, previews with public ingress, large mirror syncs) to approval or a configured Project budget.
- WFP custom CPU/subrequest limits can protect user applications, but Anyam still needs Run/Target budgets and cleanup.
- If a customer supplies external model credentials, attribute provider usage to the customer's Task and preserve the provider's usage receipt; do not hide pass-through spend inside a generic Anyam subscription.

### Special rules for Managed Customer-Account

- Anyam issues narrow, revocable grants; customer Cloudflare billing remains customer-owned.
- Show estimated and reconciled Cloudflare usage with a clear “Cloudflare invoice is authoritative” label.
- Anyam service fees should cover control-plane operation, managed upgrades, and optional Anyam execution; they must not imply Anyam can cap provider charges after a customer revokes access or operates resources directly.
- A customer can disable Anyam telemetry and still retain Project Content and export semantics; no hidden usage channel may continue to consume a customer's account.

### Special rules for Customer-operated Realm

- Ship an on-account Usage Receipt ledger, dashboard/export, and optional provider-billing adapter; do not require an Anyam SaaS account.
- Customer chooses Cloudflare account, external Runner, model provider, and retention policy.
- The same hard provider limits and visible budget errors apply, but no Anyam subscription or hosted-overhead allocation exists.
- `anyam check` must report provider limits and measured local usage without pretending to know future invoice cost when the provider feed is unavailable.

## Packaging hypotheses (not public prices)

These are product packaging experiments, not final price cards.

### Hypothesis A: open-source core plus three operating modes

This is the default recommendation:

```text
Anyam source and first-party capabilities: open source
Customer-operated Realm: no license fee
Managed Customer-Account: optional operations/support contract
Hosted SaaS: hosted capacity/service subscription plus usage policy
```

It fits the ownership decision and avoids a proprietary enterprise edition. The hosted service must publish what is included, what pauses, what can overage, and how to export/migrate.

### Hypothesis B: pooled control-plane allowance + metered expensive work

Include ordinary Project metadata, Source Space coordination, basic Git operations, and low-cost read access in a pooled allowance. Meter or require approval for:

- Container/Sandbox execution.
- Hosted agent/model calls.
- Large retained Evidence/Artifact storage.
- Public previews and high-volume mirror traffic.
- External Runner orchestration.
- Managed application Targets.

This keeps the product predictable for solo developers while preventing public or autonomous workloads from converting a subscription into an unbounded compute grant.

### Hypothesis C: BYO execution and model keys

Hosted SaaS can operate the control plane while customers bring Cloudflare accounts, external Runners, or model provider keys. Anyam charges for coordination/managed service; provider bills remain directly visible and portable. This is privacy- and margin-friendly but requires strong onboarding and receipt reconciliation.

### Hypothesis D: Project budget envelopes instead of seat-centric plans

Because Anyam work is performed by agents, humans, CI, and mirrors, seats are a poor primary cost proxy. A Project/Realm budget envelope can be delegated across actors and Tasks, with role-based approvals. Seats may still be a commercial dimension for support/identity management, but not the only allocation key.

### Hypothesis E: support and operations as the sustainable paid layer

Customer-operated Realms can remain free and fully capable. Paid services can include:

- Upgrade and migration automation.
- Recovery drills and export verification.
- Dedicated support response.
- Managed Customer-Account operation.
- Multi-account federation/administration.
- Policy packs and compliance assistance.

No service tier may remove the core Source Space, Change, Evidence, Capability, Release, Target, or export semantics.

## Measurement plan before choosing Anyam numbers

### Reference fixtures

Measure the K0 reference projects already selected:

1. Cloudflare Worker application: import, Source Space projection, agent Workspace, Change Revision, Build, Candidate Output, Release, Promotion, health check, rollback.
2. TypeScript CLI/library: package Build, generic downloadable Artifact, npm target adapter, release asset, and no-runtime Release.
3. Hybrid Project: public Source Space plus private Source Space, public projection, Publication Change, sealed verifier, and two-way mirror simulation.

For each fixture, run normal and abuse-shaped workloads:

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

### Receipt schema

Every measurement must include:

```text
receipt_id and timestamp
Anyam commit/schema/policy versions
hosting mode / Realm / Project / Source Space
fixture and workload profile
provider product/SKU/region
raw usage quantity/unit
included allocation and price version
Run/Attempt/Command/Artifact/Release identifiers
sample size and measurement method
success/error/retry/cancel outcome
estimated and, when available, billed cost
```

Do not use averages alone. Capture distributions, peaks, concurrency, idle time, bytes, retries, and cleanup lag. Record provider documentation update dates and rerun when pricing or billing status changes—especially Workflows' 10 August 2026 step/storage billing boundary and Artifacts beta status.

### Qualification gates

Before assigning customer-facing quotas:

- All logical units have one Usage Receipt path.
- Every provider SKU can be reconciled or marked `unreconciled`.
- A budget denial names limit and ask in CLI, REST, MCP, and web responses.
- Run cancellation stops or quarantines provider work and records late cost.
- Workspace and Preview cleanup has an observable checkpoint and recovery path.
- Public read/mirror abuse does not consume unbounded shared account capacity.
- Cost allocation never exposes restricted Project Content.
- Hosted, Managed Customer-Account, and Customer-operated modes show different bill ownership clearly.
- A Project Export contains usage-policy versions and enough receipts to explain historical decisions; it never includes credentials.

## Landmines to avoid

1. **“Unlimited” plans before measurement.** Provider limits and account billing make this unsafe; reserve capacity generously but expose a tripwire before a shared account is harmed.
2. **Metering only Cloudflare invoices.** Invoice data is delayed and may be restricted; real-time budget enforcement needs Anyam receipts.
3. **Metering only logical commands.** One Run can consume many retries, queue operations, container seconds, and log bytes.
4. **Treating R2 egress-free as zero cost.** Storage, Class A/B operations, retrieval (for Infrequent Access), Workers CPU, and public request abuse remain.
5. **Putting source/logs in Queue or Workflow state.** Provider size and storage limits make this fragile and expensive; use digest-addressed R2 objects.
6. **Using provider alerts as caps.** Cloudflare budget alerts are informational and delayed; enforce in Anyam.
7. **Sharing one account budget across tenants without attribution.** A public Project or malicious agent can create a denial-of-wallet incident for unrelated customers.
8. **Charging seats as the only unit.** Agents and CI produce work without human seats; cost attribution must follow Tasks/Runs/Artifacts.
9. **Forcing customer-owned Cloudflare usage through Anyam's hosted meter.** In Managed Customer-Account and Customer-operated modes, the customer account and invoice remain authoritative.
10. **Pricing Artifacts beta as a permanent guarantee.** Keep the Repository Driver/fallback and rerun its price/status qualification before public launch.

## Recommended next implementation boundary

Issue #31 should be considered resolved at the research stage when Anyam has:

```text
UsageReceipt v1 (open schema)
ProviderCostReceipt v1 (open schema)
BudgetPolicy v1 (versioned Change)
BudgetDecision / Policy Explanation integration
Cloudflare usage adapters (Workers, DO, D1, R2, Queues, Workflows, Containers)
External Runner and model-provider receipt adapters
Daily/provider-available reconciliation
CLI + MCP + web budget/error surfaces
Hosted/Managed/Customer-operated billing-owner display
```

Do not finalize public dollar amounts in this ticket. The next decision should be made from the measurement receipts produced by the K0 fixtures and the provider rate-card/status snapshot above.

## Primary sources

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (last updated 7 July 2026)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (last updated 5 July 2026)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (last updated 19 June 2026)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (last updated 1 June 2026)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (last updated 21 April 2026)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (last updated 28 May 2026)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) (last updated 8 June 2026)
- [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) (last updated 21 April 2026)
- [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/) (last updated 4 May 2026)
- [Artifacts announcement/status](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (16 April 2026)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) (last updated 21 April 2026)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) (last updated April 2026)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) (last updated 21 July 2026)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) (last updated 15 June 2026)
- [Containers limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/) (last updated 3 July 2026)
- [Sandbox pricing](https://developers.cloudflare.com/sandbox/platform/pricing/) (last updated 21 April 2026)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (last updated 29 July 2026)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) (last updated 21 April 2026)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (last updated 29 July 2026)
- [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/) (last updated 18 June 2026)
- [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) (last updated 21 April 2026)
- [Workers for Platforms custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/) (last updated April 2026)
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) (last updated 20 April 2026)
- [Cloudflare billing usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get/) (Version 2, Alpha, Restricted at snapshot)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) (last updated 29 May 2026)
- [FOCUS v1.3](https://focus.finops.org/focus-specification/v1-3/) (open cost and usage vocabulary)
