# First non-web Release Target decision

**Date:** 14 August 2026

**Ticket:** [#188](https://github.com/Whyme-Labs/anyam/issues/188)

**Protocol:** `anyam.first-non-web-release-target/v1`
**Status:** decision recorded; the selected adapter still needs a fresh live qualification

## Decision

Make **immutable release downloads** the first non-web Target path that Anyam
makes familiar and credible. The first-party provider adapter should be
`github.release-assets`, behind the existing provider-neutral
`ReleaseTargetAdapter` and `generic.release-assets` Target contract. npm is a
follow-up adapter, not a second provider folded into the first acceptance gate.

The first journey is therefore:

```text
Project → Run → passed Evidence → package.archive Artifact
        → detached verified Release → immutable release-download Target
```

This is a sequencing decision, not a claim that GitHub is canonical or that
all release providers are supported. Anyam owns the Project, Release lineage,
Target pointer, policy, disclosure, idempotency, and recovery ledger. GitHub
owns release/asset transport and provider object mechanics. npm can later use
the same core contracts after its namespace, credential, provenance, and
duplicate-publication boundaries are live-qualified.

Publishing both in the first slice is rejected: it doubles provider-specific
credential, version, response-loss, rollback, and public/private qualification
without adding core semantics. The existing GitHub receipt gives the smaller
credible path.

## Receipts and current boundary

All local receipts below were re-run against checkout
`e17344cf7be4cfa851047d2becfdd8a114207fe6` on 14 August 2026.

| Boundary | Receipt | Meaning |
| --- | --- | --- |
| TypeScript non-web lineage | `npx tsx --test test/library-release.test.ts` → 3 passed, 0 failed, 0 skipped | Local Artifact, Evidence-backed Release, generic publication state machine, retry/idempotency, and Project Export metadata are qualified. |
| Package bytes | `npm pack --dry-run --ignore-scripts --json --workspace=create-anyam` → `create-anyam@0.0.0`, 18 files, 36,767 bytes, SHA-512 integrity recorded by npm | Packlist/build is reproducible locally; no registry write or namespace reservation occurred. |
| Real download Target | [P3 TypeScript Release receipt](2026-08-03-p3-5-typescript-release-target-qualification.md) → disposable GitHub Release assets, provider response-loss reconciliation, retry, duplicate request, second Release, and rollback without rebuild passed | Strongest existing external Target evidence; bounded to the disposable GitHub qualification. |
| npm | [npm qualification](2026-08-08-post-p3-npm-release-target-qualification.md) → registry ping passed, `npm whoami` returned HTTP 401, namespace/owner and write credential missing, publish and provenance not attempted | npm is not live-qualified in this checkout. |
| Anyam contracts | [`Artifact`, `Release`, and `Target`](../../src/kernel/contracts.ts), [`sealVerifiedRelease`](../../src/delivery/promotion.ts), and [`ReleasePublicationCoordinator`](../../src/delivery/release-publication.ts) | The kernel already separates immutable lineage from provider publication. |

GitHub's official Releases API exposes stable release and asset identities and
an asset `digest`, while separately exposing create, upload, inspect, update,
and delete operations. The adapter must therefore inspect and verify provider
state rather than treat a returned URL as proof of publication: [GitHub REST
release and asset endpoints](https://docs.github.com/en/rest/releases).

GitHub documents an **immutable release** mode in which the tag and attached
assets cannot be changed or deleted after publication and a release attestation
is generated. It recommends creating a draft, attaching all assets, and then
publishing. Availability and enforcement must be checked for the selected
repository/organization; the existing #85 receipt did not qualify GitHub
release immutability or attestation: [GitHub immutable releases](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases),
[preventing release changes](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).

npm's official contract is materially different: a published `name@version`
cannot be reused, even after unpublish, and npm records tarball SHA-1 and
SHA-512 integrity: [npm publish](https://docs.npmjs.com/cli/publish/),
[npm unpublish policy](https://docs.npmjs.com/policies/unpublish/). The current
checkout has Node `22.23.0` but npm `10.9.8`; npm's trusted-publishing docs
require npm CLI `11.5.1+`, Node `22.14.0+`, OIDC, and cloud-hosted runners:
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## First-party adapter boundary

### Anyam-owned

- `Artifact` identity, type, digest, exact Project/Change/Run provenance,
  output path, provenance digest, and `DisclosurePolicyRef`.
- `Release` identity, name, exact Project Revision, Artifact and Evidence
  identities, configuration/state assumptions, policy version, status, and
  provenance. `sealVerifiedRelease` passes only a detached `ready` snapshot
  whose Artifacts and passed Evidence match the Target.
- Target configuration, accepted Artifact types, required Evidence, current
  Release/Artifact pointers, append-only history, publication state, actor,
  idempotency key, expected-current guard, normalized provider result, audit
  events, and recovery action.
- Public/private Disclosure Projection and the rule that publication cannot
  widen the Artifact or Evidence classification.
- Portable Project Export, verification, import quarantine, and credential-free
  recovery. A provider never becomes a second canonical Project authority.

### Adapter-owned

`github.release-assets` may create/find a draft release, upload the exact
selected bytes and manifest, publish it, inspect it, download it for digest
verification, and return provider IDs, URLs, and a redacted provider receipt.
Provider configuration should be versioned adapter data containing the owner,
repository, release/tag naming rule, asset filename/media type, visibility,
and declared capabilities such as `immutableRelease`, `assetDigest`,
`attestation`, and `privateDownload`.

The adapter receives only a detached `ImmutableRelease`, one selected Artifact,
and the Target. It must not rebuild, read a moving branch, write canonical
source, grant Secret Use, approve a Release, or advance Anyam's Target pointer.
Anyam accepts the result only when Target ID, Release ID/digest, Artifact
ID/digest, and provider receipt all match. A mismatch is `degraded`, not an
implicit substitution.

## Artifact, Release, signing, and verification metadata

The current contracts are sufficient for the first boundary, but a credible
download Target needs a versioned provider-neutral descriptor alongside the
existing records:

```text
Artifact: id, type, digest, byte length, media type, filename,
          Project/Change/Run provenance, output path, disclosure,
          attestation/signature references
Release:  id, name, version/channel, Project Revision, Artifact IDs+digests,
          Evidence IDs, config/state/policy digests, release digest,
          disclosure, provider-independent manifest digest
Target:   provider identity/capabilities, visibility, accepted types,
          current pointer, history, and provider object receipt
```

Do not overload the kernel with a GitHub URL or npm package name. Keep those
values in versioned adapter data and normalized publication receipts.

Before publication, policy should require a canonical Release manifest and
checksums; where the Target requires it, sign that manifest/Artifact with a
keyless attestation or owner-controlled signing key. Store signer identity,
attestation type, signature/statement digest, verification result, issuer/key
reference, and verification time—not private keys or secret values. On
download, verify provider bytes against the Artifact digest and verify the
manifest/attestation before accepting the object. ADR 0006 deliberately makes
signing and attestation policy-configurable rather than imposing one universal
cryptographic scheme: [ADR 0006](../adr/0006-generalize-artifacts-releases-and-targets.md).

GitHub's immutable-release attestation may satisfy a configured policy when the
provider capability is observed, but it is not present in the #85 receipt and
must not be inferred. npm provenance is a later concern: npm documents Sigstore
provenance for supported cloud CI and public repository/package combinations,
and provides `npm audit signatures` for verification: [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Credentials and disclosure

The adapter receives a Target-bound capability from Anyam's secret broker. A
GitHub write path should use a narrowly scoped App installation or fine-grained
token with only the repository contents/releases permission needed for the
operation; public downloads may be anonymous, while private downloads require
an explicit read capability. The credential value is never placed in an
Artifact, Release, Evidence, Runner result, log, export, URL, or model
context. The existing #85 receipt used an already authenticated `gh` client
without reading or serializing its credential material; that is not a
production credential-rotation qualification.

For the later npm adapter, prefer npm trusted publishing/OIDC on a supported
cloud-hosted workflow. A granular token fallback must be package/scope-scoped,
read-write only where needed, expiring, and brokered. npm explicitly notes
that organization access alone does not grant package publication access:
[npm access tokens](https://docs.npmjs.com/about-access-tokens/). No
self-hosted Runner should be described as npm trusted publishing.

Public release publication requires a public Target and a Release/Artifact
Disclosure Projection that permits it. A private source or restricted Evidence
must not become public merely because its Artifact is downloadable. Unknown
visibility, provider object access, or Evidence classification blocks
publication. Public projections may expose safe release name/version, bytes,
digests, signatures, and remediation, but not private Source Space names,
inputs, customer identifiers, or restricted Evidence.

## Idempotency, versioning, rollback, and republish

The Anyam coordinator already records a publication idempotency key, expected
current Release, attempt, previous pointer, provider object ID, state, receipt,
and recovery action. Concurrent calls with the same key share one execution;
duplicates return the existing record. A retry uses a new key against the same
immutable Release/Artifact and the current Target pointer. The provider
adapter should additionally derive a deterministic lookup identity from
`Target + Release digest + Artifact digest + asset filename`:

- exact existing provider object and matching digest → reconcile as published;
- same provider identity with a different digest → `degraded` and owner
  reconciliation;
- unknown response after the provider may have committed → inspect/download
  before retrying; never blindly upload a second object;
- provider rejection before commit → `failed` or `blocked` with a named
  recovery action.

For GitHub downloads, create a draft, upload all assets and the signed manifest,
verify metadata and downloaded bytes, then publish. Prefer an immutable release
tag and never overwrite an asset. A provider rollback is not a rebuild: Anyam
promotes the previous known-good immutable Release by changing its own Target
pointer. If a provider object is missing, mismatch, or cannot be inspected,
leave the Target degraded/blocked; create a new provider object only under an
explicit republish policy and retain the original immutable lineage.

For npm later, duplicate `name@version` is a permanent version conflict, not a
retry target. Reconcile the registry tarball/integrity first; a corrected
publication requires a new version and Release. npm `latest`/`beta` and other
dist-tags are mutable pointers, and npm recommends deprecation rather than
unpublish: [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/),
[npm deprecation](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/).
An npm rollback therefore means repointing a dist-tag to an existing good
version, publishing a new fixed version, or deprecating the bad version—not
overwriting the old bytes.

## Portable export

The current local test proves that Artifact, Evidence, Release, and Target
metadata survive `LocalProjectExporter`, that `verifyProjectExportPackage`
passes, and that the export is `credentialFree=true`. The export contract
includes these records and repository/large-object manifests:
[`ProjectExport`](../../src/kernel/contracts.ts), [portable export test](../../test/library-release.test.ts).

There is an important remaining gap: the current exporter copies repository
bundles and declared repository LFS objects; passing Artifact metadata does not
prove that non-web Artifact bytes are copied into the export. A releasable
download path must either include the exact Artifact bytes in an
owner-controlled content-addressed export object (with size/media type/digest
and signature) or mark an external provider reference as explicitly
unavailable/incomplete. Restore must verify those bytes, retain Release and
Target lineage, and activate neither provider credentials nor a Target pointer
without an owner decision. This is a portability requirement, not a reason to
make GitHub or npm canonical.

## Qualification still required

Before calling the first-party adapter qualified, run one owner-controlled,
disposable Target qualification that records:

1. target owner/repository, public or private disclosure, provider capability
   (including immutable-release enforcement), and scoped credential receipt;
2. deterministic fixture Artifact, Release manifest, checksums, signature or
   attestation, provider object IDs, URLs, and downloaded digest match;
3. duplicate request, provider response loss after commit, same-digest
   reconciliation, mismatched-object degradation, and a fresh retry;
4. two immutable Releases, Target pointer rollback, and no rebuild on rollback;
5. public/private read behavior and disclosure projection checks;
6. export/clean restore of metadata and Artifact bytes, signature verification,
   credential-free manifest, and explicit Target activation; and
7. deletion/cleanup of every disposable provider object, with no claim about
   unmeasured limits, cost, retention, or availability.

Only after that receipt should `github.release-assets` be called a qualified
first-party adapter. npm needs a separate owner-controlled namespace and live
publication qualification; the prior npm receipt says not to attempt that
transaction yet.

## Explicit non-claims

This decision does **not** claim npm, PyPI, Cargo, OCI, model, dataset,
firmware, app-store, or every GitHub plan is supported; npm publication,
trusted publishing, provenance, package ownership, billing, rate limits, or
production credential rotation; universal signing; immutable-release
availability on every GitHub account; that #85 qualified provider signing; that
the current Project Export contains non-repository Artifact bytes; automatic
rollback of database/device/external state; or that a provider URL alone proves
publication. It also does not change Anyam's single-authority rule: provider
objects remain replaceable projections and recovery copies.

## Sources

- [ADR 0006: generalize Artifacts, Releases, and Targets](../adr/0006-generalize-artifacts-releases-and-targets.md)
- [ADR 0034: non-web Release publication and portable Artifacts](../adr/0034-non-web-release-publication-and-portable-artifacts.md)
- [TypeScript Release Target qualification](2026-08-03-p3-5-typescript-release-target-qualification.md)
- [npm Release Target qualification](2026-08-08-post-p3-npm-release-target-qualification.md)
- [GitHub Releases REST API](https://docs.github.com/en/rest/releases)
- [GitHub immutable releases](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases)
- [npm publish and version immutability](https://docs.npmjs.com/cli/publish/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm access tokens](https://docs.npmjs.com/about-access-tokens/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm package deprecation](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/)
