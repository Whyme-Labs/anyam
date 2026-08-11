# Cloudflare-default execution with portable pull runners

Status: Accepted

## Context

Anyam needs one execution contract for builds, tests, agent sessions, analysis,
previews, packaging, and Target-specific checks. Cloudflare can operate the
control plane and a useful default Linux execution lane, but no honest
Cloudflare-only promise covers macOS, Windows, ARM, GPUs, hardware-in-the-loop,
private corporate networks, or every large-memory workload.

Issue [#20](https://github.com/Whyme-Labs/anyam/issues/20) asked which workloads
belong on Cloudflare's managed execution plane, which require external pull
runners, and how isolation, immutable inputs, caching, networking, secret
brokerage, job identity, logs, cancellation, artifact upload, Evidence,
retry, and hostile-workload limits should work.

Current Cloudflare facts, maturity, and receipts are recorded in
[`docs/research/2026-08-02-execution-and-runner-plane.md`](../research/2026-08-02-execution-and-runner-plane.md)
and the earlier platform baseline. The current disposition is qualification,
not a promise that every documented limit is a product limit.

## Decision

### Cloudflare is the default execution lane, not the universal lane

| Workload | Default lane | Reason |
|---|---|---|
| Anyam control-plane APIs, dispatch, policy, and orchestration | Workers, Durable Objects, Queues, Workflows | Managed low-latency control and durable coordination |
| Ordinary Linux/AMD64 builds, tests, linters, analysis, agent sessions, docs, and previews | Cloudflare Containers/Sandbox through an execution adapter | Isolated managed execution with R2-backed inputs and outputs |
| macOS/iOS, Windows-native, ARM-specific, GPU, hardware-in-the-loop, private-network, or larger workloads | External pull Runner | The managed lane does not provide the required operating system, architecture, device, network, or resource shape |
| Customer-controlled or on-premises execution | External pull Runner | The control plane remains Anyam-owned while execution stays in the customer's trust boundary |

Cloudflare execution is ephemeral. The authoritative source, inputs, logs,
Artifacts, Evidence, and checkpoints live outside the container or Sandbox;
local disk is a cache and working area, never the source of truth.

### A Runner is an enrolled capability, not a server with broad authority

Each Runner advertises a versioned capability profile:

```text
identity and enrollment state
operating system and architecture
isolation mechanism
toolchain or image capabilities
resource receipts and tripwires
network and protocol capabilities
Secret Use broker support
cache support and scope
Artifact/Evidence upload support
Target capabilities
data-location and trust-zone policy
```

The profile is an upper bound. A Run request must fit the profile and the
Project/Realm policy before it can be dispatched. A Runner never decides
Anyam authorization, Source Space visibility, Landing, or Promotion.

The Cloudflare execution adapter and an external Runner implement the same
capability contract. Provider-specific fields remain extension data and do not
change the normalized Run or Evidence semantics.

### Every Run binds immutable inputs before dispatch

The authoritative Run record is created before a job is placed on a queue. It
binds:

```text
Project, Source Space/View, Project Revision or Change Revision
Project Manifest and Action/Verifier versions
dependency and toolchain digests
declared inputs and expected outputs
network policy and Secret Use aliases
Runner capability requirements
policy version, grant, and authorization epoch
idempotency key and attempt identity
```

The Runner receives an immutable input manifest and content-addressed download
references. It never receives a canonical-source write credential. A run that
cannot reproduce its declared input set is failed or marked indeterminate; it
is not silently upgraded to “latest” source or dependencies.

### External execution uses a pull protocol

External Runners do not expose an inbound service to Anyam. The lifecycle is:

```text
Anyam records Run
  → dispatches an idempotent job message
  → enrolled Runner pulls and claims a matching job lease
  → Runner exchanges its enrollment identity for a short-lived job capability
  → Runner materializes immutable inputs in an isolated workspace
  → Runner executes the declared Action or Verifier
  → Runner uploads logs, Artifacts, and Evidence to scoped locations
  → Runner submits a signed result for coordinator validation
  → Anyam finalizes the Run and emits the next workflow event
```

Cloudflare Queues is a suitable transport, but the protocol is not coupled to
Queues. A Queue delivery is at-least-once and unordered; the job contains the
Run ID, attempt ID, idempotency key, required capability digest, and object
references so duplicate or out-of-order delivery is harmless.

A claim lease, heartbeat, and expiry make ownership observable. Lease expiry
creates a new attempt rather than mutating the old attempt. A duplicate result
for an already finalized attempt is retained as an audit fact and cannot
replace the accepted result.

### Job identity is narrower than Runner identity

Enrollment identifies a Runner. A job capability identifies only:

```text
one Run attempt
one exact input manifest
one Project View
one declared Action or Verifier
permitted output and Evidence locations
permitted network aliases
permitted Secret Use aliases
expiry, lease, and cancellation state
```

The controller-to-Runner exchange preserves Principal, Actor, Session, Task,
Run, and grant provenance while narrowing authority. A job token is not an
MCP token, Git credential, deployment credential, or Realm administrator
credential.

### Isolation and hostile-workload handling are explicit

The managed lane starts a fresh isolated execution context for each attempt;
the external protocol requires the equivalent isolation guarantee from the
Runner profile. A Run may read only its authorized Project View and immutable
inputs. It may write only its attempt logs, declared Artifacts, and Evidence
locations.

The Runner must enforce or report:

- process and filesystem isolation;
- declared CPU, memory, disk, wall-time, and output budgets;
- network allow/deny policy and protocol support;
- cancellation and termination behavior;
- maximum log and upload behavior;
- cleanup of processes, credentials, and working files after completion;
- a visible failure when a tripwire is reached.

Anyam does not set a universal numeric budget before a receipt exists. Runner
profiles and Cloudflare platform limits provide the measured tripwires. Every
budget failure names the budget, configured limit, requested amount when known,
Run attempt, and recovery action. A healthy workload touching a tripwire is a
capacity signal, not a silent truncation or a successful partial result.

### Networking and Secret Use are separate controls

The default Run network is deny-by-default. The Action declares destinations;
Realm policy and the Runner capability determine whether those destinations
are permitted. The Cloudflare Sandbox proxy can broker approved HTTP/HTTPS
requests and inject credentials without exposing secret values to the process,
but it is not treated as a universal arbitrary-protocol firewall.

An external Runner must declare how it enforces network policy. If it cannot
provide the requested isolation, the Run is rejected or explicitly marked as
running in a lower-trust lane; it is never silently treated as equivalent to
the managed lane.

Secret access is always Secret Use through an approved broker or runtime
binding. Raw production secret values do not enter the source Workspace,
manifest, job token, logs, Artifact, Evidence, or model context.

### Caches accelerate Runs but never become authority

Caches are content-addressed and keyed by all declared inputs that affect the
result, including source revision, Manifest/Action/Verifier version,
toolchain, dependencies, relevant policy, and Runner capability. Cache scope
must respect Project, Source Space, disclosure, and trust boundaries.

A cache miss is normal. A cache hit is recorded in the Run and provenance;
cached output remains subject to the same output digest, verifier, Evidence,
and policy checks as a fresh execution. Untrusted or stale cache content cannot
advance canonical source, a Release, or a Target by itself.

### Logs, Artifacts, and Evidence are append-only outputs

Runners upload bounded log chunks, typed Artifacts, and Evidence to scoped
content-addressed locations. The coordinator stores references, digests,
disclosure policy, attempt identity, and upload status in authoritative state.
Logs are not the authoritative event ledger and must be redacted or rejected
when they contain credential values or inaccessible Project Content.

An external result is accepted only when Anyam verifies its job capability,
input digest, output digests, signer/enrollment identity, and declared
Evidence contract. An uploaded Artifact may be retained as externally produced
or attested; it is not called an Anyam-reproducible Build unless the provenance
supports that claim.

### Retry and cancellation are state transitions

Retries create distinct Run attempts with their own lease, Runner identity,
logs, outputs, and Evidence. Idempotency prevents a duplicate attempt from
creating duplicate Landing, Release, or Promotion state. Retrying a side effect
requires an adapter-specific idempotency key and expected-state guard.

Cancellation revokes the job capability, marks the attempt as cancellation
requested, and asks the Runner to stop. The Runner reports cooperative stop,
forced termination, or unknown termination. If the Runner cannot prove cleanup,
the attempt is quarantined and its credentials and Secret Use grants are
revoked; a later retry starts from fresh immutable inputs.

### The protocol remains portable

The external Runner contract is transport-neutral and can use Queue pull,
customer polling, or another authenticated pull channel. It requires:

```text
versioned capability advertisement
enrollment and key rotation
job pull/claim/heartbeat/release
short-lived attempt capability exchange
immutable input manifest and content transfer
scoped output upload
signed result and digest verification
cancellation and lease expiry
replay-safe idempotency
audit and health reporting
```

The first Cloudflare adapter may use Workers, Queues, Workflows, R2,
Containers, and Sandbox. The same Runner protocol must remain usable by
macOS, Windows, ARM, GPU, hardware, private-network, and customer-owned
implementations without requiring those environments to emulate Cloudflare
APIs.

## Consequences

- Anyam can honestly ship a Cloudflare-first execution experience without
  pretending every project belongs in a Linux/AMD64 Sandbox.
- The control plane remains Cloudflare-owned even when a specialized Runner is
  outside Cloudflare.
- Run, Artifact, Evidence, and audit semantics are consistent across execution
  providers.
- Pull-only enrollment avoids requiring inbound firewall exceptions for
  customer networks.
- At-least-once dispatch, leases, attempts, and idempotency add state, but they
  make retries and provider failures explicit instead of corrupting releases.
- Qualification must cover Runner cleanup, network enforcement, credential
  revocation, input immutability, and result verification before external
  execution is treated as a high-trust lane.

## Rejected alternatives

- **Cloudflare-only execution:** excludes important project types and would turn
  documented platform limits into a product landmine.
- **Long-lived PAT in a runner:** grants more authority than one Run needs and
  makes revocation, replay, and provenance unsafe.
- **Inbound callback runner:** requires customer firewall exposure and makes
  private-network adoption harder; pull is the default.
- **Queue delivery as the source of truth:** Queues transports work but does
  not define ordering, exactly-once state, or accepted Evidence.
- **Workflow state as logs or the ledger:** large outputs and authoritative
  history belong in the project ledger and R2; Workflows orchestrates.
- **Shared persistent runner Workspace:** makes cleanup, cross-tenant leakage,
  cache scope, and agent provenance ambiguous.
- **Cache output accepted without revalidation:** a cache is an optimization,
  not Evidence or authorization to Land, Release, or Promote.
- **Silent kill or truncation at a limit:** every tripwire must be visible and
  recoverable, with a named budget and requested amount.

