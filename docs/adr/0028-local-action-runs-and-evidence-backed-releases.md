# Local Action Runs and Evidence-backed Releases

Status: Accepted

## Context

Anyam needs a local verification loop before it can safely connect remote
Runners, agent sessions, or Target adapters. A local check must exercise the
same semantic contract that a remote Runner will receive. A green process exit
alone is not enough: a Release must retain the exact source, Change, Action,
Verifier, inputs, outputs, toolchain, dependencies, policy, Target, disclosure,
and actor provenance that made the result valid.

Issue [#46](https://github.com/wms2537/anyam/issues/46) asks for a complete
local loop over the Worker and TypeScript library Reference Fixtures.

## Decision

### Normalize once, execute through a Runner envelope

The anyam.project/v1 manifest is normalized into versioned Action and Verifier
contracts. A local run produces a provider-neutral NormalizedActionInput and
NormalizedActionOutput. Local process execution is only one Runner mechanic;
later Cloudflare or external Runners consume the same semantic input and return
the same output shape.

The input envelope binds:

~~~
Action and Verifier contract digests
Project Revision and Project View
Source Space snapshots
Change Revision and Workspace
declared input and effect digests
dependency, toolchain, and environment digests
policy and authorization epoch
Target and disclosure
Actor, capability grant, and Runner
~~~

The command, network declaration, resource declaration, module root, and
dependency IDs remain part of the normalized Action contract. Manifest
configuration does not grant authority; the Runner and policy boundary still
decide what may execute.

### Runs and Evidence are immutable

Every Action attempt creates a Run and an append-only Evidence record. The
Evidence validity key covers all material input above plus the effective
disclosure projection. A failed command, missing declared input, or missing
declared output produces failed Evidence with an owner-visible receipt. A
stale, missing, failed, or indeterminate record blocks the Release Stage Gate.

### Cache is subordinate to validity

The local cache is keyed by the complete Evidence validity key. A partial
match is a miss. Cached Evidence is reattached to the current ledger only when
its exact record is still valid; the cache does not grant access, extend
approval, or mutate an old record.

### Release assembly is dry-run and immutable

runLocalRelease executes declared Actions, creates typed content-addressed
Artifacts for declared output paths, evaluates required Verifiers, checks
Target Artifact compatibility, and returns an immutable draft or ready Release
manifest. It never deploys or promotes a Target. Production or other Target
mutation remains a later policy-governed adapter operation.

The Release records only the Evidence and Artifacts produced for this assembly,
along with manifest, policy, state-assumption, and provenance digests. Prior
ledger history remains inspectable but is not silently included as current
Release Evidence.

## Consequences

- Worker and CLI/library projects can prove the complete local lifecycle before
  Cloudflare or external Runner qualification.
- Local and remote execution share a stable contract instead of accumulating
  runner-specific manifest formats.
- Developers and agents receive actionable failure receipts naming the affected
  Action, missing input/output, exit result, and recovery direction.
- Release readiness is explicit and fail-closed without pretending that local
  execution proves universal Project correctness.
- The local Runner intentionally does not enforce unmeasured resource limits;
  resource requirements remain declared inputs until a measured qualification
  supplies a receipt.

## Rejected alternatives

- Treating process exit zero as a Release: omits provenance and output lineage.
- Caching by source revision only: ignores Action, Verifier, policy, Target,
  toolchain, dependency, effect, and disclosure changes.
- Rebuilding a Release during promotion: breaks immutable Artifact lineage.
- Returning only a boolean check status: hides missing, stale, and
  indeterminate Evidence from agents and reviewers.
- Creating a local-only Action schema: makes remote Runner parity a later
  migration instead of a load-bearing contract.
