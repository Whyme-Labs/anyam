# Non-web Release publication and portable Artifacts

Status: Accepted

Issue: [#52](https://github.com/Whyme-Labs/anyam/issues/52)

## Context

Anyam's Project model is not a web-runtime model. A TypeScript library or CLI
should be able to move from a verified source revision to a typed package or
downloadable asset without inventing a Worker Target. The existing local
execution lane already normalizes Actions and Verifiers and creates a ready
Release, but its generic `release-assets` Target had no authoritative
publication operation. Project Export also carried an Artifact field while the
local exporter discarded caller-provided Artifacts.

## Decision

### A verified Release is Target-neutral

The verified Release seal validates a ready Release against any Target, not only
a Worker Target. It binds:

- the exact Project Revision;
- the complete declared Artifact set and each Artifact digest/type;
- the complete declared Evidence set and passed validity context;
- Target-required Evidence;
- configuration and state-assumption fields; and
- policy and provenance recorded by Release assembly.

Worker Promotion and generic Artifact publication consume the same detached
verified snapshot. Neither adapter receives a moving branch or mutable caller
object.

### Generic Artifact Targets publish one typed Artifact

`ReleaseAssetTarget` represents a package registry, downloadable release
channel, or another non-web Artifact destination. It declares accepted Artifact
types and keeps current Release, current Artifact, append-only Release history,
publication state, and a Target contract digest.

`ReleaseTargetAdapter` owns only provider mechanics:

```text
publish(verified Release, selected Artifact, Target)
```

The normalized provider result must echo the Target, Release, Artifact, Release
digest, Artifact digest, provider object identity, and a receipt. Any mismatch
is a degraded provider-result failure; Anyam never silently substitutes a
different package or rebuilds the source.

### Publication is an Anyam-owned state machine

```text
proposed → publishing → published
                          ├── failed
                          ├── blocked
                          └── degraded
```

`failed` means a retryable or non-retryable provider failure was reported
without an accepted Target transition. `blocked` means a declared contract or
Target precondition is unavailable. `degraded` means the provider may have
changed state or returned lineage that Anyam cannot verify. Each state retains
the Release digest, Artifact digest, actor, idempotency key, attempt, provider
receipt, and recovery action.

The publication coordinator owns the Target pointers and append-only
`anyam.release-publication/v1` events. A duplicate idempotency key returns the
existing publication and concurrent calls share the same in-flight execution.
Retry creates a new attempt on the same immutable Release and Artifact, uses a
new idempotency key, rebinds the expected current Target pointer, and never
rebuilds.

### Export retains the release lineage

`LocalProjectExporter` accepts caller-provided Artifacts and writes them into
the portable Project Export alongside Evidence, Releases, Targets, repository
bundles, lineage, and recovery metadata. This makes a non-web Release
recoverable outside the publishing provider and preserves the same digest
lineage after migration.

### The TypeScript library fixture is the reference journey

The fixture demonstrates:

```text
manifest with typed package.archive output
  → local check and build
  → reproducible Evidence-backed Release
  → generic.release-assets publication
  → provider failure with recovery action
  → idempotent retry of the same Release/Artifact
  → portable Project Export
```

The adapter in the qualification test is scripted. It proves the Anyam
contract and authority boundary; it is not a claim that Anyam already operates
a public npm or package-registry service.

## Consequences

- TypeScript libraries and CLIs use the same Project → Run → Evidence →
  Artifact → Release lineage as Worker applications.
- Package publication is not confused with source Landing or web deployment.
- Artifact and Release digests remain stable through provider failure and retry.
- Generic targets can be added without making the kernel assume a web runtime.
- Project Export remains a real recovery path for package and downloadable
  releases rather than only a source-repository backup.

## Rejected alternatives

- **Treat `git tag` as publication:** tags do not carry typed Artifact lineage,
  Evidence, Target authority, or provider recovery state.
- **Publish by rebuilding from source:** breaks the verified Release boundary
  and makes the published package differ from the reviewed Artifact.
- **Let a registry adapter update the Target pointer directly:** makes provider
  responses authoritative and prevents Anyam from applying idempotency and
  policy consistently.
- **Store only the Release in Project Export:** loses the Artifact bytes/digest
  relationship needed to recover a package or downloadable asset.
- **Require a web preview:** excludes libraries, CLIs, data, firmware, and
  other non-runtime Projects from the universal delivery model.
