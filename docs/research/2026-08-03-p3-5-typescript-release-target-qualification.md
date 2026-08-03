# P3 public beta: TypeScript package Release publication to a real Target

**Date:** 3 August 2026
**Ticket:** [#85](https://github.com/wms2537/anyam/issues/85)
**Status:** passed with bounded provider recovery qualification

## Decision

Anyam's non-web TypeScript release path is qualified through a real disposable
GitHub Release asset Target. The qualification proves that a reproducible
TypeScript package Artifact can move through the complete lineage without
rebuilding during retry or rollback:

```text
TypeScript Project
    ↓
Local Run
    ↓
Evidence-backed immutable Release
    ↓
typed package.archive Artifact
    ↓
GitHub Release asset Target
    ↓
provider response-loss recovery
    ↓
immutable Release republish rollback
```

The provider adapter performs GitHub Release mechanics. Anyam's
`ReleasePublicationCoordinator` owns the publication identity, idempotency,
Target pointers, retry state, and release history.

## Live provider receipt

The qualification used a disposable public repository created for this run:

- Repository: [wms2537/anyam-p3-release-20260803](https://github.com/wms2537/anyam-p3-release-20260803)
- Transport: `gh` CLI/API over HTTPS
- Credential material: not read by the harness
- Target adapter: `github.release-assets`
- Provider object: GitHub Release plus `library.archive` asset
- Target source commit: `main`
- Artifact type: `package.archive`
- Artifact size: 75 bytes per GitHub asset metadata

The two real provider objects were:

| Release | GitHub tag | GitHub release ID | Asset ID | Asset |
|---|---|---:|---:|---|
| v1 | `anyam-qualification-library-release-v1` | `364163815` | `499972141` | `library.archive` |
| v2 | `anyam-qualification-library-release-v2` | `364163882` | `499972252` | `library.archive` |

The final harness run produced these Anyam lineage identifiers:

```text
protocol=anyam.live-github-release-target-qualification/v1
status=passed-with-bounded-provider-recovery
firstRelease=release:4cd1346d-f602-4c69-96b0-b47b4e935819
firstReleaseDigest=sha256:89c94397e20de6a67d74418affabd5a9dc49fccc2c8c3bd3712b4ad643851763
firstArtifact=artifact:82923ad7-6e93-47da-aac8-6e67880328c1
firstArtifactDigest=sha256:9524b72b9ee9c6a54b898afdc52a081facae4f55a2eb151ee1315869e203558a
secondRelease=release:40a44e03-65d3-495a-8a6e-3779ad1f457e
secondReleaseDigest=sha256:39835a8afac86ea631fc85e7ddd90d266a007107bbb85205ab10f89e764b91ef
secondArtifact=artifact:4d1b64bf-8526-46fd-ae51-6f99a8c5da03
secondArtifactDigest=sha256:9524b72b9ee9c6a54b898afdc52a081facae4f55a2eb151ee1315869e203558a
```

The package archive digest is stable across the v1 and v2 fixture builds. The
Release digests and Artifact identities remain distinct, preserving immutable
lineage even when the package bytes are equal.

## Recovery and rollback receipt

The live adapter intentionally returned an indeterminate provider outcome after
the first GitHub Release and asset had already been committed and verified. It
therefore exercised the dangerous response-loss boundary rather than only a
pre-commit error:

```text
firstPublication=degraded
retryPublication=published
retryDuplicate=true
secondPublication=published
rollbackPublication=published
rollbackRebuild=false
providerCalls=4
```

The retry inspected the existing GitHub Release asset, verified the downloaded
bytes against the Anyam Artifact digest, and published the same immutable
Release/Artifact. It did not invoke a rebuild. Repeating the retry with the
same idempotency key returned the existing publication without another adapter
call. Repeating the original publication request likewise returned its existing
publication.

The second Release was then published and the first immutable Release was
republished as a rollback:

```text
targetCurrentRelease=release:4cd1346d-f602-4c69-96b0-b47b4e935819
history=release:4cd1346d-f602-4c69-96b0-b47b4e935819,
release:40a44e03-65d3-495a-8a6e-3779ad1f457e,
release:4cd1346d-f602-4c69-96b0-b47b4e935819
```

The downloaded release assets matched the Anyam digest:

```text
artifactBytesVerified=true
releaseAssetDownloadDigestMatches=true
```

The Target pointer changed only through the Anyam coordinator. The GitHub
provider object IDs remained stable and were recorded as:

```text
github-release:364163815:asset:499972141
github-release:364163882:asset:499972252
```

## Deterministic receipt

The provider-independent release suite was run alongside the live harness:

```text
npx tsx --test test/library-release.test.ts
3 tests passed; 0 failed; 0 skipped
```

The full repository gate and package entrypoint smoke were also re-run after the
receipt was prepared:

```text
npm run check
94 tests passed; 0 failed; 0 skipped

npm run verify:package
create-anyam package entrypoint smoke passed for npm exec, npx, pnpm dlx, and bun x
```

## Cost and credential boundary

```text
costReceipt=not-measured
no billing API queried
disposable public repository qualification only
credentialMaterial=not-read-by-harness
```

This receipt makes no claim about GitHub billing, registry pricing, or a
production account's cost. The GitHub Release repository was disposable and
was deleted after the live qualification. The adapter used the already
authenticated `gh` client without reading or serializing its credential
material.

## What this qualifies

- A non-web TypeScript Project can produce a typed package Artifact and an
  Evidence-backed immutable Release.
- A real GitHub Release asset can serve as a Release Target through an adapter.
- Provider response loss after commit can become an explicit `degraded` state
  with a recovery action.
- Recovery can inspect and verify the existing provider object, retry the same
  immutable lineage, and avoid rebuilding.
- Duplicate requests are idempotent at Anyam's publication boundary.
- A later Release can be promoted and an earlier immutable Release can be
  republished as a rollback.
- Release, Artifact, Evidence, Target, publication, and provenance remain
  present in the portable Project Export covered by the deterministic suite.

## What this does not qualify

This is a bounded real-Target qualification, not a production registry launch.
It does not qualify:

- npm, PyPI, Cargo, OCI, or another package-registry provider;
- package signing or trusted-publisher/OIDC exchange;
- production GitHub App installation and credential rotation;
- provider rate limits, billing, retention, or repository quotas;
- a durable remote publication worker or multi-region Target fleet;
- rollback safety for external state such as database migrations;
- a production release domain or customer-owned Target adapter.

Those are separate Stage Gate receipts. The architectural boundary is settled:
Anyam's Target coordinator remains provider-neutral, retries immutable Releases,
and records provider-specific mechanics and receipts without allowing a
provider adapter to rebuild or silently advance canonical lineage.
