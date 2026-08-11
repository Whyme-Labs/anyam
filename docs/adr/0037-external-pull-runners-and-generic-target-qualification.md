# External pull Runners and generic Target qualification

Status: Accepted

Issue: [#55](https://github.com/Whyme-Labs/anyam/issues/55)

## Context

Anyam must support projects whose Actions cannot run in the default Cloudflare
execution lane. A macOS or Windows toolchain, an ARM build, a GPU workload, a
private network, or a hardware-in-the-loop test may require a customer-owned or
specialized execution provider. The control plane must remain Anyam-owned even
when the process runs outside Anyam's infrastructure.

The execution contract already has normalized Actions, Verifiers, Runs,
Evidence, Artifacts, Releases, and generic Targets. What was missing was an
executable qualification of the external pull boundary: Runner identity, job
lease, immutable inputs, scoped outputs, cancellation, provider loss, and
recovery. Without that boundary, an external process could be mistaken for an
authorized executor or a provider result could become an accidental source or
promotion authority.

## Decision

### A Runner is an enrolled capability profile

An external Runner is enrolled in a Realm with:

- an operator-approved identity and public key;
- a declared operating system, architecture, isolation mode, and capabilities;
- an explicit network destination set and Secret Use mode;
- declared Artifact and Evidence upload capabilities;
- a profile digest and enrollment receipt; and
- an explicit lifecycle state: enrolled, active, unavailable, disabled, or
  quarantined.

Enrollment is not authorization to run arbitrary project code. Anyam still
evaluates the Project, Project View, Action or Verifier, Capability Grant,
policy version, authorization epoch, and disclosure policy before enqueueing a
Run. The Runner profile only determines whether the provider can satisfy that
already-authorized job.

### A Runner Job is one immutable Run attempt

The coordinator creates the Run and Runner Job before dispatch. The Job records:

```text
Project and Project View
Project Revision and Source Space snapshots
Action or Verifier
input manifest digest and input digests
effects, dependency, toolchain, and environment digests
network destinations and Secret Use aliases
scoped log, Artifact, and Evidence locations
Capability Grant and authorization epoch
actor, disclosure policy, Target, and recovery state
```

The Job contains no canonical repository write authority. A Runner may write
only the assigned execution workspace and the Job's output locations.

The input manifest digest is calculated before dispatch and is part of the
signed/result validation boundary. A result that names another input set is
rejected while the Job remains recoverable.

### The pull protocol proves Runner identity before issuing the job credential

The transport is pull-based and transport-neutral:

```text
Anyam enqueues an immutable Runner Job
  → an active matching Runner pulls an offer
  → Anyam sends a single-use challenge
  → the Runner proves possession of its enrolled private key
  → Anyam issues an opaque, attempt-scoped job credential
  → the Runner executes the declared Action or Verifier
  → the Runner submits a signed Result
```

The coordinator stores only the digest of the opaque job credential. The
credential is bound to the Job, Attempt, Runner, and lease expiry. It is not a
Git, MCP, deployment, or Realm administration credential and must not be
passed through to another provider.

The production transport can be a Queue pull consumer, a customer poller, or
another provider adapter. This decision fixes the protocol and authority
boundary, not one Cloudflare transport implementation.

### Outputs are scoped to the Run Attempt

The Runner submits typed output references for logs, Artifacts, and Evidence.
Anyam attaches the authoritative Run and Attempt identities after validating
the submission. The coordinator rejects:

- an output path outside the Job's declared root for its kind;
- an Artifact location that is not bound to the current Attempt;
- a disclosure classification broader than the Job's Project View;
- output digests outside the Action's declared output paths; and
- a successful result that omits a declared output.

The Runner can use a brokered Secret Use alias when the Job and Runner profile
permit it. The alias authorizes an operation; it does not disclose the secret
value to the process, logs, Artifact, Evidence, or model context.

### Results are signed and state transitions are explicit

The Runner signs a canonical result envelope containing the Job, Attempt,
status, normalized output, scoped output references, and optional recovery
action. Anyam verifies the signature against the enrolled public key, the
credential, the immutable input set, the output contract, and the current
state before accepting it.

The accepted states are visible in both the Run and the Runner Job/Attempt:

```text
queued → offered → running → succeeded
                         ├── failed
                         ├── indeterminate
                         ├── cancelled
                         ├── expired
                         └── quarantined
```

Cancellation is a two-step state transition. Anyam requests cancellation and
the Runner reports cooperative stop, forced termination, or unknown cleanup.
Unknown cleanup becomes quarantined and indeterminate; it is not silently
treated as a successful stop. Lease expiry, Runner unavailability, and Runner
quarantine revoke the active job credential and retain a recovery action.

Late or duplicate results cannot advance a finalized Attempt. A retry creates a
fresh Attempt with a fresh lease and preserves the previous Attempt as
immutable evidence. Enqueue and retry operations require idempotency keys.

### Generic Target publication remains Anyam-owned

The external Runner only produces the typed Artifact and Evidence needed for a
Release. A generic Target adapter receives a detached verified Release and one
selected Artifact through the existing `ReleasePublicationCoordinator`.

The adapter performs provider mechanics and returns a normalized proposal or
publication result. Anyam validates the exact Release digest, Artifact digest,
Target, provider object identity, and receipt; only Anyam advances the Target
pointer, records publication state, and applies retry/recovery policy.

This makes a CLI archive, package, model, dataset, firmware image, or other
non-web Artifact use the same:

```text
Run → Evidence → Artifact → verified Release → generic Target publication
```

lineage as a Worker deployment. A Target provider never becomes a second
canonical source or Promotion authority.

### Qualification boundary

The TypeScript coordinator and tests are a protocol qualification fixture. They
prove the state machine, signatures, input/output disclosure boundary,
credential revocation, cancellation, expiry, retry, and generic Target
authority boundary using an enrolled non-web Runner profile.

They do not claim that Anyam already operates a production Queue, external
runner fleet, macOS/Windows/GPU isolation service, or package registry. Those
remain replaceable transport and provider adapters behind the contracts in
ADR 0012, ADR 0015, and ADR 0034. A production adapter must add durable
storage, authenticated transport, host cleanup, network enforcement, secret
broker integration, and hostile-workload qualification before it is a releasable
Runner lane.

## Consequences

- A customer can keep specialized execution in its own trust boundary without
  giving the Runner canonical write or Promotion authority.
- External execution preserves the same Run, Evidence, Artifact, Release, and
  Target lineage as local and Cloudflare execution.
- A compromised or unavailable provider becomes visible and recoverable rather
  than silently producing stale or unaudited state.
- The control plane can choose a matching Runner by capability without making
  project Actions platform-specific.
- The protocol can be transported by Cloudflare Queues, a customer puller, or a
  future provider without changing the domain model.
- Generic non-web Targets can be qualified with a TypeScript CLI/library
  fixture before Anyam operates ecosystem-specific registries.

## Rejected alternatives

- **Give an external Runner a repository write token:** this makes the Runner a
  second Landing authority and cannot scope writes to one Run Attempt.
- **Push jobs into an inbound Runner service:** this expands the customer
  network attack surface and makes provider reachability a control-plane
  requirement; pull is safer and works for customer-owned networks.
- **Treat a provider's returned URL or object as publication success:** the
  provider result is untrusted input; Anyam must validate lineage and advance
  the Target pointer itself.
- **Rebuild the Artifact at publication time:** this breaks the reviewed
  Release boundary and can publish bytes different from the Evidence-backed
  Artifact.
- **Treat cancellation or lease expiry as success:** provider cleanup may be
  unknown; the correct state is indeterminate or quarantined with explicit
  recovery.
- **Require every project to run in the default Cloudflare lane:** this would
  exclude healthy non-web and specialized workloads from the general Project
  model.
