# Execution and runner plane qualification

**Research date:** 2026-08-02

**Question:** Which workloads can safely and economically run on Cloudflare's
managed execution plane, which require external pull Runners, and what
portable protocol covers immutable inputs, isolation, caches, networking,
Secret Use, job identity, logs, cancellation, Artifact upload, Evidence,
retry, and hostile-workload limits?

**Evidence policy:** Cloudflare platform claims below come from current
first-party documentation. Portable execution claims are linked to the owning
specification or project. Anyam design choices are labelled as inference or
disposition; they are not claims made by Cloudflare or the standards.

## Executive finding

Cloudflare is a strong default lane for Anyam's control plane and bounded
Linux/AMD64 execution. It is not an honest universal execution substrate for
macOS, Windows, ARM-specific, GPU, hardware-in-the-loop, private-network, or
larger-memory workloads. Anyam therefore needs a portable pull-Runner contract
from the first general-project release.

The safe split is:

```text
Cloudflare Workers / Durable Objects / Queues / Workflows
  → control, dispatch, policy, orchestration

Cloudflare Containers / Sandbox
  → bounded Linux/AMD64 build, test, analysis, agent, and preview work

External pull Runners
  → other operating systems, architectures, devices, networks, and sizes
```

This is an architectural inference from the documented platform capabilities,
not a claim that Cloudflare cannot add larger or different execution options
later.

## Cloudflare execution receipts

### Containers

Cloudflare's [Containers limits documentation](https://developers.cloudflare.com/containers/platform-details/limits/)
was last updated 3 July 2026. The documented `standard-4` instance is 4 vCPU,
12 GiB memory, and 20 GB disk. Custom instance types currently have the same
maximums: 4 vCPU, 12 GiB memory, and 20 GB disk. The documented account limits
include 1,500 concurrent vCPU, 6 TiB concurrent memory, 30 TB concurrent disk,
and 50 GB total image storage. These are platform receipts, not Anyam product
quotas.

The documented Container model is Linux/AMD64, and Container disk is
ephemeral. Anyam must therefore upload authoritative outputs and logs to
durable storage and treat local disk as disposable working space or cache.

### Sandbox outbound traffic and Secret Use

Cloudflare's [Sandbox outbound-traffic guide](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
was last updated 21 April 2026. Internet access is enabled by default, but
`enableInternet = false` enables deny-by-default operation. `allowedHosts` can
make the allowlist explicit. When the internet is disabled, the documented
available network is restricted to ports 80, 443, and DNS; outbound handlers
intercept HTTP/HTTPS, not arbitrary protocols.

The [Sandbox security guide](https://developers.cloudflare.com/sandbox/concepts/security/)
and [proxy-requests guide](https://developers.cloudflare.com/sandbox/guides/proxy-requests/)
document the safer pattern for credentials: the sandbox receives a short-lived
token, a trusted Worker validates it and injects the real credential, and the
real credential never enters the sandbox. The guides also state that the
application—not the platform alone—must implement authentication,
authorization, input validation, and rate limiting.

**Disposition:** Anyam's managed lane is deny-by-default, HTTP/HTTPS-aware, and
uses Secret Use brokers. It must not claim arbitrary TCP/UDP egress policy from
the Sandbox proxy.

### Queues

Cloudflare documents [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
and recommends a unique message ID or idempotency key when duplicate processing
would be unsafe. The [pull-consumer documentation](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
was last updated 1 July 2026 and supports consumers outside Workers that pull
over HTTP, acknowledge, or request redelivery after a visibility timeout.

**Disposition:** Queues is a suitable transport for Run dispatch and external
Runner polling. Queue delivery is not Anyam state authority: messages may be
duplicated or redelivered, and the protocol must carry Run/attempt identity and
use coordinator-side idempotency.

### Workflows

Cloudflare's [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
were last updated 15 June 2026. The paid default active CPU time per step is
30 seconds and is configurable up to 5 minutes. Non-streaming step results and
event payloads are limited to 1 MiB; a paid Workflow instance can persist up to
1 GB of state; large or long-lived outputs should be stored in R2. Workflows
cannot be deployed to Workers for Platforms namespaces.

The [Workflows pricing documentation](https://developers.cloudflare.com/workflows/reference/pricing/)
states that step and storage billing begins 10 August 2026.

**Disposition:** Workflows orchestrates retries, waits, approvals, and
provider operations. The Anyam ledger remains authoritative for accepted Run,
Evidence, Release, and Promotion state; workflow state is not the audit ledger.

## Portable Runner standards and boundaries

[OCI Image Specification](https://github.com/opencontainers/image-spec) and
[OCI Runtime Specification](https://github.com/opencontainers/runtime-spec)
provide portable image and runtime contracts. They do not provide Anyam's
identity, job lease, source disclosure, capability, cancellation, or Evidence
semantics. Anyam may use OCI images as an input or capability identifier, but
must keep the Runner protocol above OCI.

[OAuth 2.0 Token Exchange (RFC 8693)](https://www.rfc-editor.org/rfc/rfc8693)
provides a standard shape for exchanging an enrolled Runner credential for a
narrower, short-lived job credential. Anyam still owns the resource, Project
View, Action, output, and policy constraints in that exchange.

[SLSA provenance](https://slsa.dev/spec/v1.0/provenance) and
[in-toto attestations](https://in-toto.io/) provide useful provenance and
attestation vocabulary. They do not replace Anyam's Change, Project Revision,
Disclosure Projection, Evidence freshness, or Target Promotion model.

**Disposition:** Use these standards at the edges through versioned adapters;
do not make an external standard the source of truth for Anyam authorization or
cross-Source-Space state.

## Anyam Runner protocol inference

An enrolled Runner advertises a versioned capability profile:

```text
operating system and architecture
isolation mechanism
toolchain/image capabilities
resource ceilings and receipts
network protocol and destination controls
Secret Use broker support
cache scope
Artifact/Evidence upload support
Target capabilities
data-location and trust-zone policy
```

The control plane creates the authoritative Run before dispatch. A Runner Job
is a short-lived lease for exactly one Run attempt and contains:

```text
Run and attempt IDs
Project View and immutable input manifest
Manifest, Action/Verifier, toolchain, and dependency digests
permitted output and Evidence locations
network aliases and Secret Use aliases
required Runner capability digest
idempotency key and expiry
```

The external lifecycle is pull-only:

```text
record Run
  → enqueue dispatch message
  → Runner pulls and claims lease
  → exchange enrollment identity for job capability
  → materialize immutable inputs
  → execute in isolated workspace
  → upload logs, Artifacts, and Evidence
  → submit signed result and digests
  → coordinator verifies and finalizes attempt
```

Duplicate messages create no duplicate accepted state. A lease expiry creates a
new attempt; it does not overwrite the old attempt. Cancellation revokes the
job capability, requests cooperative stop, and records whether termination was
cooperative, forced, or unknown. Unknown cleanup quarantines the attempt and
revokes its credentials before retry.

Caches are content-addressed and scoped by Project, Source Space, disclosed
input, Action/Verifier version, toolchain, dependencies, policy, and Runner
capability. Cache hits are recorded in provenance and remain subject to output
digest, Verifier, Evidence, and policy checks. A cache is never authority to
Land, Release, or Promote.

Logs are chunked and uploaded to scoped object storage. They are not the
authoritative ledger, and credential values or inaccessible Project Content
must be redacted or rejected. An external Artifact is accepted as
externally-produced or attested unless its provenance supports an
Anyam-reproducible Build claim.

## Qualification gates

Before a Runner lane is trusted for production Release or Promotion, qualify:

1. input immutability and Project View disclosure;
2. enrollment, key rotation, job-token expiry, replay, and revocation;
3. lease loss, duplicate delivery, duplicate result, retry, and cancellation;
4. process, filesystem, network, and cross-Run isolation;
5. Secret Use broker behavior and log redaction;
6. output digest, attestation, and Evidence validation;
7. cache scope, invalidation, and cache-poisoning resistance;
8. runner health, cleanup, and quarantine behavior;
9. transport interoperability across Cloudflare pull and at least one
   customer-controlled external Runner;
10. visible budget failures naming the budget, configured limit, requested
    amount, and recovery action.

Numeric Anyam limits remain uncommitted until measured receipts exist. Current
Cloudflare platform limits are tripwires for the managed adapter; external
Runner profiles must publish their own measured limits and fail explicitly when
a Run request exceeds them.

