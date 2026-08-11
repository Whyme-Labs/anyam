# Anyam execution and runner plane

**Research snapshot:** 2 August 2026
**Ticket:** [#20](https://github.com/Whyme-Labs/anyam/issues/20)
**Status:** Decision-grade platform research. Cloudflare product facts below are receipts from current first-party documentation; Anyam protocol decisions are recommendations and still require implementation qualification.

## Executive decision

Anyam should use a two-lane execution plane:

```text
Cloudflare managed lane
  Containers / Sandbox SDK
  Linux/amd64, bounded resources, Worker-controlled HTTP egress

Portable pull-runner lane
  macOS, Windows, ARM, GPU, hardware, private networks, and oversized jobs
  runner polls for an authorized job and returns logs, Artifacts, and Evidence
```

Cloudflare Queues is a suitable delivery transport for both Worker consumers and external pull consumers. Cloudflare Workflows is suitable for durable orchestration, waits, retries, pause, termination, and compensation. Neither product is Anyam's Run ledger, capability policy, Evidence schema, or runner protocol.

The durable contract is:

```text
Run declared against exact immutable inputs
        ↓
Scheduler selects a runner class
        ↓
Runner proves enrolled workload identity
        ↓
Runner exchanges identity for a Run-scoped job capability
        ↓
Runner pulls immutable inputs and executes the Action
        ↓
Runner uploads logs, Candidate Outputs, Artifacts, and signed Evidence
        ↓
Anyam validates the result and closes or retries the Run idempotently
```

No runner receives canonical source-write authority, approval authority, or unrestricted secret values. A cancellation is a policy state transition plus best-effort process termination; it is not assumed to erase already-observed output or undo external side effects.

## Current product status and receipts

| Product or standard | Current status at snapshot | Receipt |
|---|---|---|
| Cloudflare Containers | GA, announced 13 April 2026 | [Containers and Sandboxes GA announcement](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) |
| Cloudflare Sandbox SDK | Available on Workers Paid; built on Containers; GA announcement covers Sandbox | [Sandbox overview](https://developers.cloudflare.com/sandbox/), [GA announcement](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) |
| Sandbox HTTP/WebSocket transports | Deprecated; Cloudflare said they would be removed from versions released after 9 July 2026 | [Deprecation guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/), [deprecation announcement](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/) |
| Sandbox RPC transport | Recommended replacement, available from SDK 0.9.1 according to the transport guide | [Transport modes](https://developers.cloudflare.com/sandbox/configuration/transport/) |
| Cloudflare Queues | GA since 26 September 2024; available on Workers Free and Paid in the current overview | [Queues changelog](https://developers.cloudflare.com/queues/platform/changelog/), [overview](https://developers.cloudflare.com/queues/) |
| Cloudflare Workflows | GA since 7 April 2025 | [Workflows GA announcement](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/) |
| OCI image specification | v1.1.1 release listed 2 April 2025 | [OCI release notices](https://opencontainers.org/release-notices/overview/), [image spec](https://specs.opencontainers.org/image-spec/?v=v1.1.1) |
| OCI distribution specification | v1.1.1 release listed 1 March 2025 | [OCI release notices](https://opencontainers.org/release-notices/overview/), [distribution spec](https://specs.opencontainers.org/distribution-spec/?v=v1.1.1) |
| OCI runtime specification | v1.3.0 announced 4 November 2025 | [OCI announcement](https://opencontainers.org/posts/blog/2025-11-04-oci-runtime-spec-v1-3/), [OCI overview](https://opencontainers.org/) |
| SLSA | Version 1.2, status Approved | [SLSA specification](https://slsa.dev/spec/v1.2/), [build requirements](https://slsa.dev/spec/v1.2/build-requirements) |
| in-toto Attestation Framework | Latest framework version v1.2; Statement v1 remains the v1 schema | [Framework specification](https://github.com/in-toto/attestation/blob/main/spec/README.md), [Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) |
| SPIFFE Workload API | Stable for X.509-SVID and JWT-SVID profiles; WIT-SVID profile is Incubating | [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/), [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/) |

### Documentation drift is a landmine

Some Cloudflare Sandbox pages last updated before the July transport removal still show HTTP/WebSocket configuration examples. The deprecation guide and transport guide are newer and explicitly direct new deployments to RPC. Anyam must qualify the exact SDK/package/image versions together in CI and use `SANDBOX_TRANSPORT=rpc` (or the equivalent per-sandbox option) for the supported lane. A documentation page showing an old default is not a receipt that the old transport remains available in a version released after the removal date.

## Cloudflare managed execution lane

### Workload fit

Cloudflare describes Sandbox as isolated execution for untrusted code, agents, CI/CD, command execution, files, processes, and preview services. Each Sandbox is backed by a dedicated Linux container and a Durable Object. Containers run in their own VM with separate filesystem, process, and network stacks. These are strong isolation boundaries for ordinary builds and agent work, but they do not make an untrusted workload harmless: network egress, secret use, resource exhaustion, and external side effects still require Anyam policy.

Receipts: [Sandbox overview](https://developers.cloudflare.com/sandbox/), [Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/), [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/).

### Resource receipts

The current documented predefined Container instance types are:

| Instance type | vCPU | Memory | Disk |
|---|---:|---:|---:|
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

Custom types currently have a maximum of 4 vCPU, 12 GiB memory, and 20 GB disk, with a minimum 3 GiB memory per vCPU and maximum 2 GB disk per 1 GiB memory. The documented per-account concurrent ceilings are 6 TiB memory, 1,500 vCPU, and 30 TB disk, with 50 GB total image storage. These are provider limits, not Anyam product quotas; Anyam should measure real workloads before setting user-facing tripwires.

Receipt: [Containers limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/) (last updated 3 July 2026).

Other operational receipts:

- Cloudflare documents Container cold starts as commonly around 1–3 seconds, dependent on image size and entrypoint. This is an observation, not an SLO or a safe user-facing promise. Receipt: [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/).
- Containers should be built for `linux/amd64`; placement may differ from the associated Durable Object. Regional and jurisdictional placement constraints exist, including `eu` and `fedramp` mappings. Receipts: [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), [placement](https://developers.cloudflare.com/containers/platform-details/placement/).
- A Container instance can be explicitly stopped/destroyed and otherwise sleeps after its configured `sleepAfter`; a Sandbox idles after 10 minutes by default. When a Sandbox stops, its files, processes, shell sessions, and environment state are lost unless Anyam persists them or uses backup/restore. Receipts: [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/), [Sandbox lifecycle API](https://developers.cloudflare.com/sandbox/api/lifecycle/).
- All requests to a Container pass through a Worker, so end users cannot make non-HTTP TCP or UDP requests directly to a Container instance. Receipt: [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/).

### Network and secret behavior

Cloudflare's Container and Sandbox outbound handlers intercept HTTP and HTTPS traffic only. With `enableInternet=false`, only explicitly allowed hosts or handlers may leave the workload; ports 80, 443, and DNS remain available, and DNS goes to Cloudflare DNS. `allowedHosts` becomes a deny-by-default allowlist, while `deniedHosts` can remove destinations. HTTPS interception is opt-in for Containers and creates an ephemeral CA that the image must trust at runtime.

Outbound handlers run in trusted Worker code and can attach credentials without placing the real secret in the container. The Sandbox guide explicitly recommends this for agentic workloads. A credential proxy is also documented for S3-compatible mounts: the container receives dummy credentials while the Durable Object signs requests with real credentials. Direct environment-variable injection remains possible, but it exposes a live credential to every process in the container and is therefore not Anyam's default for agent jobs.

Receipts: [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/), [Container outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/), [Sandbox proxy requests](https://developers.cloudflare.com/sandbox/guides/proxy-requests/), [Sandbox credential proxy](https://developers.cloudflare.com/sandbox/guides/mount-buckets/), [Container environment variables and secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).

Anyam's default managed-lane policy should therefore be:

```text
deny public internet by default
allow only declared destinations and methods
route approved secret-backed calls through a trusted Worker broker
record destination, operation, grant, Run, and result metadata
never place production secret values in model context or agent workspaces
```

This does not claim that the HTTP/HTTPS handler is a general L3/L4 firewall. Non-HTTP protocols and arbitrary private network access require an external runner or a separately qualified Cloudflare network integration.

### Transport and state qualification

The Sandbox transport is part of the execution adapter, not the Anyam Action contract. Anyam should:

1. Pin and record the `@cloudflare/sandbox` package and container image versions.
2. Use RPC transport for new deployments after the July 2026 removal boundary.
3. Run a deployment smoke test that executes commands, streams output, transfers a binary larger than the legacy HTTP limit, and reconnects after a Sandbox sleep/restart.
4. Treat the Sandbox filesystem as a cache/workspace, never as authoritative source, Artifact, or Evidence storage.
5. Upload durable outputs to R2 or another Anyam Artifact store using content digests.

The transport guide says RPC multiplexes operations over one persistent connection and removes the HTTP transport's 32 MiB file-transfer limitation. This is a provider receipt, not a reason to put large payloads into Workflow state or queue messages. Receipt: [Sandbox transport modes](https://developers.cloudflare.com/sandbox/configuration/transport/).

## Queues as dispatch transport

Cloudflare Queues provides at-least-once delivery. Duplicate delivery is possible; ordering is not a safe application assumption. Anyam must persist the authoritative Run state before publishing a dispatch message and must make every consumer operation idempotent by Run ID, Attempt ID, or content digest.

Current limits and semantics on the official limits and pull-consumer pages include:

| Property | Current documented value |
|---|---:|
| Queues per account | 10,000 |
| Message size | 128 KB |
| Messages per consumer batch | 100 |
| Messages per `sendBatch` | 100 or 256 KB total |
| Per-queue throughput | 5,000 messages/second |
| Message retries | 100 |
| Paid message retention | Up to 14 days |
| Free-plan message retention | 24 hours |
| Per-queue backlog | 25 GB |
| Push consumer invocations | 250 concurrent |
| Consumer wall time | 15 minutes |
| Consumer CPU time | Configurable up to 5 minutes |
| Pull visibility timeout | Up to 12 hours |
| Send/retry delay | Up to 24 hours |

Pull consumers are HTTP clients outside Workers. A pull request returns a batch with ephemeral message IDs, an attempt count, and a `lease_id`; the consumer must acknowledge or retry each lease, or messages return after the visibility timeout. The documented default visibility timeout is 30 seconds, but Anyam must request a value based on measured job-claim behavior rather than hard-code a universal timeout. A long-running external job should not hold a queue lease for its entire execution; it should claim a Run in Anyam's ledger, acknowledge the dispatch message, and report progress/results through the Run API.

When a message reaches the configured retry limit it is deleted, or sent to a configured dead-letter queue. DLQ messages without an active consumer persist for four days before deletion. That retention is not a substitute for an Anyam durable Run ledger or Evidence store.

Receipts: [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/), [batching/retries/delays](https://developers.cloudflare.com/queues/configuration/batching-retries/), [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [Queues GA changelog](https://developers.cloudflare.com/queues/platform/changelog/).

### Dispatch message shape

The queue message should remain a small pointer, not a source archive or secret:

```json
{
  "schema": "anyam.run-dispatch.v1",
  "dispatch_id": "opaque-id",
  "run_id": "opaque-id",
  "attempt_id": "opaque-id",
  "input_snapshot": { "uri": "r2://...", "digest": "sha256:..." },
  "action_digest": "sha256:...",
  "runner_class": "linux-container",
  "capability_exchange": "https://.../runs/.../credential",
  "output_contract": "https://.../runs/.../outputs",
  "expires_at": "server-issued-time"
}
```

The example is illustrative, not a frozen schema. Queue payload size is a tripwire; large source, dependency caches, logs, and binary outputs belong in content-addressed object storage.

## Workflows as orchestration, not authority

Workflows provides durable steps, retries, sleep, external-event waits, and instance lifecycle control. Current documented instance states include `queued`, `running`, `paused`, `errored`, `terminated`, `complete`, `waiting`, and `waitingForPause`. Instances can be paused, resumed, terminated, or restarted; termination can optionally run registered rollback handlers. A restart cancels in-progress steps, erases intermediate state, and runs again from the beginning or a selected step.

The current paid-plan limits page documents 30 seconds default CPU per step (configurable to 5 minutes), unlimited step wall time, 1 MiB non-stream step results and event payloads, 1 GB persisted state, up to 25,000 steps when configured, 50,000 concurrent instances, 300 starts/second per account, 100 starts/second per Workflow, 2,000,000 queued instances, 30-day completed-state retention, and 10,000 retries per step. The page also contains prose referring to a lower active-instance number; Anyam must use the lower confirmed value until Cloudflare resolves that documentation discrepancy. Every number is a provider receipt, not an Anyam quota.

Workflows step outputs are not the Evidence or Artifact store. Large or long-lived outputs should be written to R2 and represented by a digest/reference. Cloudflare's current changelog says step and storage billing on Workers Paid begins no earlier than 10 August 2026; cost qualification must be rerun before launch.

Receipts: [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [trigger and lifecycle management](https://developers.cloudflare.com/workflows/build/trigger-workflows/), [Workflows pricing changelog](https://developers.cloudflare.com/changelog/product/workflows/).

### Cancellation semantics

Anyam should represent cancellation as a state machine independent of Workflows:

```text
requested → acknowledged → stopping → stopped
                         ↘ unable_to_stop
```

The controller first revokes the Run capability and records a cancellation event. It then sends the provider-specific stop signal. A Cloudflare Workflow may be terminated, but an already-running Container/Sandbox process and an external runner need separate cancellation handling. A queue message can be retried or acknowledged; queue operations do not kill a process that has already claimed work. A runner that loses its lease or capability must stop as soon as it can and upload a terminal status; Anyam must accept late results only if they match the current Run/attempt policy.

This is an inference from the documented boundaries: Cloudflare exposes Workflow instance lifecycle methods and Queue lease acknowledgment, but no single cross-product cancellation transaction. The qualification test must verify stop latency, late-result rejection, duplicate result handling, and external side-effect reporting.

## Portable pull-runner protocol

There is no single current standard that covers job dispatch, leases, cancellation, immutable source inputs, secret brokerage, logs, Artifacts, Evidence, and heterogeneous execution hosts. The standards cover adjacent layers:

| Layer | Use | What it does not define |
|---|---|---|
| OCI Image/Distribution/Runtime | Portable Linux/amd64 container image and runtime input | Anyam job scheduling, credentials, lease, cancellation, or Evidence semantics |
| OAuth/OIDC or SPIFFE SVID | Runner workload identity and proof of possession | Run authorization, Source Space policy, output contract, or revocation semantics |
| SLSA v1.2 | Build provenance and isolation expectations | Queue delivery, runner enrollment, interactive cancellation, or Anyam disclosure policy |
| in-toto v1.2 / Statement v1 | Signed subject-bound attestation envelope and predicate model | Anyam Run lifecycle or target promotion rules |

Receipts: [OCI overview](https://opencontainers.org/), [OCI image spec](https://specs.opencontainers.org/image-spec/?v=v1.1.1), [OCI distribution spec](https://specs.opencontainers.org/distribution-spec/?v=v1.1.1), [OCI runtime release](https://opencontainers.org/posts/blog/2025-11-04-oci-runtime-spec-v1-3/), [SLSA v1.2](https://slsa.dev/spec/v1.2/), [SLSA build requirements](https://slsa.dev/spec/v1.2/build-requirements), [in-toto framework](https://github.com/in-toto/attestation/blob/main/spec/README.md), [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md), [RFC 8693 token exchange](https://www.rfc-editor.org/rfc/rfc8693.html), [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/).

### Runner roles

Anyam should define one open, versioned protocol with adapters for providers:

```text
Runner Registry
  enrollment, declared capabilities, trust domain, region/network class

Dispatcher
  selects runner class and publishes a small dispatch pointer

Runner Agent
  pulls a dispatch, proves identity, claims the Run, and starts an executor

Executor
  runs the normalized Action in a container, VM, host process, GPU job, device lab, or other declared substrate

Collector
  streams logs and uploads Candidate Outputs, Artifacts, and Evidence
```

An external runner may use OCI images when the host supports them. It must also be allowed to run a native macOS, Windows, ARM, GPU, or hardware action where an OCI Linux image is not the right execution unit. The Action contract must describe inputs and outputs without assuming a container.

### Runner enrollment and job identity

The runner enrolls with a public key or workload identity. At job time it proves possession of the enrolled identity and exchanges it for a short-lived Run-scoped capability. RFC 8693 provides the standard token-exchange envelope and supports a subject token, actor token, resource, audience, scope, and requested token type; it does not automatically propagate parent revocation or enforce narrowing, so Anyam must enforce those properties in its Realm policy.

SPIFFE's stable X.509-SVID and JWT-SVID profiles are viable adapters for private runner fleets. SPIFFE recommends X.509-SVID where possible because JWTs are replayable. The WIT-SVID profile is currently incubating and must not be a required v1 dependency.

### Required job protocol states

```text
offered
  → claimed
  → preparing
  → running
  → uploading
  → succeeded | failed | cancelled | expired | lost
```

The protocol must include:

- a unique Run and Attempt identity;
- exact immutable input Snapshot digests and Action digest;
- declared runner class, platform, architecture, region/jurisdiction, network policy, and Secret Use aliases;
- capability audience and expiry from the Anyam Realm;
- claim/lease renewal and a server-visible cancellation/revocation epoch;
- stdout/stderr and structured event streaming with sequence numbers;
- content-addressed output upload and an explicit output manifest;
- signed Evidence that names source, Action, toolchain, runner identity, inputs, outputs, and policy version;
- idempotent result submission and duplicate-result handling;
- a terminal reason that distinguishes process failure, provider failure, policy denial, lease expiry, cancellation, and unknown/lost runner;
- no canonical Source Space write, no policy change, no approval, and no unrestricted secret read.

The protocol should not require a runner to keep a queue lease open while a job executes. The queue transport delivers an offer; the Anyam Run ledger owns the claim and lease. This prevents long jobs from colliding with Queue visibility timeouts and lets a runner reconnect after a transient network failure.

### Network and secret contract

The normalized Action declares network intent as named destinations and operations. The runner adapter maps that to the host's controls:

```text
deny by default
allow exact hosts/services where policy permits
allow Secret Use aliases, not raw secret values
record egress metadata and policy decision
fail closed when network policy is unknown for a high-risk action
```

For Cloudflare, the adapter uses outbound handlers/Workers proxies. For a customer runner, it may use a local egress proxy, mTLS service mesh, firewall, or provider-native secret broker. The kernel only accepts an Evidence record that states what control was actually enforced; it must not claim Cloudflare-style interception on a runner that did not provide it.

### Logs, artifacts, and provenance

Logs are operational output and may be disclosure-filtered; they are not automatically Evidence. Candidate Outputs may be disposable. Artifacts are immutable and digest-addressed. Evidence is signed metadata bound to the Run/Attempt and output digest.

SLSA v1.2 says a build platform is responsible for provenance generation and isolation, and the recommended provenance identifies how an artifact was produced. in-toto v1.2 supplies a subject-bound Statement and predicate model; Statement v1 requires immutable subject digests. Anyam should emit SLSA-compatible build provenance inside an in-toto envelope where the Action is a software build, then attach Anyam-specific predicates for Run, Change, Source Space disclosure, policy, runner capability, and Evidence freshness.

Anyam must not claim a SLSA level merely because a runner returns a JSON file. The Evidence policy must verify signer identity, subject digest, builder identity, input digests, and the fields required by the selected SLSA profile.

## Workload classes

The Action manifest should classify execution by capability rather than by marketing product:

| Class | Default lane | Examples | External runner reason |
|---|---|---|---|
| `sandbox-linux` | Cloudflare Sandbox/Container | tests, linters, static analysis, package builds, agent sessions | not needed when within measured bounds |
| `container-linux` | Cloudflare Container or OCI runner | service builds, integration tests, preview servers | larger image/runtime or customer network |
| `native-macos` | Pull runner | Xcode/iOS/macOS signing and tests | OS requirement |
| `native-windows` | Pull runner | Windows SDK, desktop packaging | OS requirement |
| `arm-device` | Pull runner | ARM cross-builds, device tests | architecture/device access |
| `gpu` | Pull runner | ML training/evaluation, CUDA workloads | GPU requirement |
| `hardware-in-loop` | Pull runner | firmware, robotics, physical peripherals | physical hardware and safety |
| `private-network` | Pull runner | enterprise integration tests | data/network boundary |

These are action capabilities, not hard-coded quotas. The scheduler must route by declared requirements, and the runner must report actual platform capabilities. Anyam must measure cold-start, checkout, cache hit, build, upload, cancellation, and failure behavior for each class before publishing user-facing budgets.

## Caching and persistence

The managed Cloudflare filesystem is an execution cache. A cache hit must never substitute for verifying the exact input digest and Action/toolchain digest. Anyam should use content-addressed caches with a namespace that includes Project/Source Space disclosure policy and platform class; cache reads must not cross an authorization boundary.

Persistent data belongs in:

```text
Source Snapshot → Repository Driver
large inputs/outputs → Artifact store (R2 or another configured provider)
logs/Evidence → Anyam Evidence store
runner-local cache → disposable, digest-keyed, policy-scoped
```

Cloudflare's Sandbox backup/restore and R2 mounts can accelerate workspace setup, but they do not change the rule that source, Artifacts, and Evidence are authoritative outside the ephemeral container.

## Qualification gates

The following are implementation spikes, not promises. Each must publish a receipt before a corresponding capability becomes a default:

| Spike | Measure |
|---|---|
| Cloudflare Sandbox RPC | package/image compatibility, command latency, binary streaming, reconnect after sleep, process cleanup |
| Cloudflare resource envelope | peak memory/vCPU/disk, cold start, checkout time, build time, output upload, failure modes across representative projects |
| Egress broker | deny/allow correctness, HTTPS interception, secret non-disclosure, method/path filtering, DNS behavior, log redaction |
| Queue dispatch | duplicate delivery, lease expiry, retry/DLQ behavior, backpressure, batch handling, message size |
| Workflow orchestration | pause, terminate, restart, rollback handler, waiting event, late completion, state-size and cost behavior |
| External runner | enrollment, capability exchange, claim/reconnect, cancellation, lost runner, duplicate result, revocation, no canonical write |
| OCI lane | image pull, digest pinning, runtime isolation, multi-platform manifest handling, registry failure |
| macOS/Windows/ARM/GPU/hardware | native toolchain, private network, device cleanup, signing boundary, artifact/provenance upload |
| Evidence | in-toto/SLSA verification, signer rotation, disclosure projection, stale-input rejection, subject digest mismatch |

Every measured limit should be recorded as a Receipt and sized as a Tripwire above healthy workloads. Every failure exposed to a developer or agent should name the budget, configured limit, and requested amount when known. Silent truncation, silent retries, and blank runner failure states are prohibited.

## Final recommendation

Implement Anyam's execution plane in this order:

1. Define the provider-neutral Action, Run, Attempt, Runner, Output, and Evidence contracts.
2. Ship a Cloudflare Sandbox/Container adapter using RPC, R2-backed persistence, deny-by-default egress, and trusted secret brokerage.
3. Dispatch asynchronously through Queues and orchestrate long-lived verification/release state with Workflows, while keeping the Run ledger authoritative.
4. Ship a minimal external pull-runner reference implementation that uses the same contracts and can run an OCI Linux Action.
5. Add native-host adapters for macOS, Windows, ARM, GPU, private network, and hardware without changing the kernel contract.
6. Emit in-toto/SLSA-compatible signed Evidence and expose provider-specific receipts honestly.

The architectural boundary is therefore:

> **Cloudflare is Anyam's default managed execution substrate. The pull-runner protocol is Anyam's portability and sovereignty boundary.**

Anyam can remain fully customer-operable on a customer's Cloudflare account while still supporting specialized pull runners. It must not claim that every project runs entirely inside Cloudflare, that Queues provides exactly-once jobs, that Workflows is the source of truth, or that a container secret proxy controls arbitrary non-HTTP traffic.
