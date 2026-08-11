# Post-P3: npm package Release Target qualification

**Date:** 8 August 2026
**Ticket:** [#119](https://github.com/Whyme-Labs/anyam/issues/119)
**Related receipts:** [#52](https://github.com/Whyme-Labs/anyam/issues/52), [#85](https://github.com/Whyme-Labs/anyam/issues/85)
**Protocol:** `anyam.npm-release-target-qualification/v1`
**Status:** **not qualified; blocked by npm namespace and authorization**

## Decision

Anyam's package Release and generic Release Target contracts are locally
qualified, but npm publication is not a live-qualified Release Target. This
receipt must not be read as an npm support or production-publication claim.

The safe boundary is:

```text
Anyam owns:
  Project → Run → Evidence → Artifact → immutable Release → Target ledger

npm owns through an adapter:
  package namespace, version admission, registry storage, dist-tags,
  staged approval, deprecation, provenance, and provider authentication
```

The next live qualification requires an owner-controlled npm package namespace,
an authorized npm publisher, a supported credential path, and a disposable
package/version plan. None of those conditions is currently present in this
checkout.

## Question

Can Anyam publish an immutable TypeScript package Release to a real npm
registry Target with scoped credentials, provenance, retry and idempotency,
response-loss recovery, and an honest rollback/deprecation model?

## Current repository and identity boundary

The current package is a local creator/CLI package:

```text
package directory: packages/create-anyam
name:             create-anyam
version:          0.0.0
entrypoints:      create-anyam, anyam, git-credential-anyam
```

`packages/create-anyam/package.json` does not currently declare a `repository`,
`publishConfig`, provenance setting, trusted publisher, or npm-specific release
workflow. The repository's identity screen also says that the exact `@anyam`
scope is occupied and must not be used, and that a registry `404` is not a
reservation. See [Anyam identity knockout screen](2026-08-01-anyam-identity-clearance.md).

This is a release-readiness fact, not a recommendation to publish the current
`create-anyam@0.0.0` package. The package name/scope, legal owner, repository
provenance link, and release version must be settled before a public package is
created.

## Live npm receipts

All commands in this section ran against `https://registry.npmjs.org/` on
**8 August 2026** from the current checkout at commit
`c694b20cd9e34a31448ff6edd65659dc4366608f`.

### Registry reachability

```text
command: npm ping --registry=https://registry.npmjs.org/
result:  PONG
latency: 409 ms (npm notice receipt)
exit:    0
```

The registry is reachable. This does not establish package ownership or write
authority.

### npm identity and credential availability

```text
command: npm whoami --registry=https://registry.npmjs.org/
result:  HTTP 401 Unauthorized
exit:    1
```

No npm credential was read, printed, serialized, or added to the repository.
There is therefore no live publisher identity, package owner, trusted publisher
configuration, token, 2FA session, or billing identity available to this
qualification.

### Point-in-time package-name observations

Unauthenticated registry lookups on the same date returned `404` for:

```text
https://registry.npmjs.org/create-anyam
https://registry.npmjs.org/anyam
https://registry.npmjs.org/@anyam-dev%2fcli
https://registry.npmjs.org/@anyam-dev%2fcreate-anyam
```

These are observations only. A `404` is not a reservation, entitlement, legal
clearance, or proof that a later publish transaction will succeed.

The official npm search endpoint returned three packages in the occupied
`@anyam` scope:

```text
@anyam/npm-boilerplate  1.0.7  modified 2024-10-07T05:13:50.170Z
@anyam/mani             1.0.1  modified 2024-09-18T14:03:07.835Z
@anyam/medium-common    1.0.0  modified 2024-10-05T15:16:24.308Z
```

Source: [npm registry search API](https://registry.npmjs.org/-/v1/search?text=%40anyam&size=100).

## Local package and contract receipts

### Package archive

```text
command: npm pack --dry-run --ignore-scripts --json --workspace=create-anyam
result:  passed
name/version: create-anyam@0.0.0
files: 14
tarball size: 19,366 bytes
unpacked size: 84,354 bytes
shasum: 7c729c4a6ed26c5828f79c5e292117129c53700e
integrity: sha512-RmUw9nZkU4nCp0/O+39LiPEKhH4IefDVUTrSD2bulmpZI40Q3O/qR1rAfXQP/yUxE4vnP2ek4rig/TtQdbGARA==
```

The dry run verifies the local packlist and entrypoint build. It does not send
the tarball to npm, reserve a name/version, create provenance, or exercise
provider authorization.

### Anyam package Release contract

```text
command: npx tsx --test test/library-release.test.ts
result:  3 passed, 0 failed, 0 skipped
```

The local tests qualify:

- deterministic TypeScript `package.archive` Artifact creation;
- Evidence-backed immutable Release sealing;
- generic Target publication with failure, retry, response-state handling, and
  idempotency; and
- portable export of Artifact, Evidence, Release, and Target lineage.

They use `ScriptedPackageAdapter`, not npm. The prior [P3 TypeScript package
Release receipt](2026-08-03-p3-5-typescript-release-target-qualification.md)
qualified a real disposable **GitHub Release asset** Target, not npm.

## Current toolchain receipt

```text
node: v22.23.0
npm:  10.9.8
```

The npm trusted-publishing documentation currently requires npm CLI `11.5.1`
or later and Node `22.14.0` or later. The current Node version satisfies the
documented Node floor, while the current npm CLI does not satisfy the trusted
publishing floor.

Source: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## What the npm provider currently supports

The following are current provider facts from official npm documentation, not
Anyam capabilities:

### Trusted publishing (preferred for automation)

npm trusted publishing uses OIDC to exchange a workflow identity for a
short-lived publish credential. It currently supports GitHub Actions on
GitHub-hosted runners, GitLab CI/CD on GitLab.com shared runners, and CircleCI
cloud. Self-hosted runners are not currently supported. A package has one
trusted-publisher connection at a time. OIDC supports `npm publish` and
`npm stage publish`; interactive stage review/approval commands require
maintainer authentication and 2FA.

Sources: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

For GitHub Actions and GitLab CI/CD, npm automatically generates provenance
attestations when trusted publishing is used only when the repository and
package are public. npm documents no provenance for packages in private
repositories, even when the package is public. This matters for Anyam's
hybrid public/private Source Space model: the public projection and the exact
public build workflow must be selected deliberately.

Source: [npm provenance generation](https://docs.npmjs.com/generating-provenance-statements/).

### Granular access tokens (fallback)

As of November 2025, npm documents only granular access tokens. They can be
limited to packages/scopes, read-only or read/write access, expiration dates,
CIDR ranges, and optional 2FA bypass. They cannot grant more permission than
the user has. npm documents that access to an organization alone does not grant
package publication permission; package ownership or package-level write access
is still required.

Source: [npm access tokens](https://docs.npmjs.com/about-access-tokens/),
[creating and viewing tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

The fallback is not currently available to Anyam because no npm identity or
token exists in the qualification environment. Any future adapter must receive
the credential through a secret broker and must never place it in a Release,
Evidence record, agent context, repository, or log.

### Staged publishing

`npm stage publish` submits a package to a staging area without requiring 2FA;
the maintainer must later review and approve it with 2FA. npm requires the
package to already exist and the publisher to have write access. Trusted
publishers can be restricted to stage-only, which keeps the final proof of
presence with the maintainer.

Sources: [staged publishing](https://docs.npmjs.com/staged-publishing/),
[npm stage CLI](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

### Immutability and rollback semantics

npm states that a `name@version` combination cannot be reused, even if the
version is unpublished. npm recommends deprecation rather than unpublishing
when the goal is to warn users without breaking dependents. The `latest`
dist-tag can be moved to a different existing version with `npm dist-tag add`,
but this is a mutable provider pointer and is not a replacement for immutable
Release lineage.

Sources: [npm publish](https://docs.npmjs.com/cli/publish/),
[npm unpublish policy](https://docs.npmjs.com/policies/unpublish/),
[npm deprecating packages](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/),
[npm dist-tags](https://docs.npmjs.com/cli/dist-tag/).

Therefore an npm “rollback” must be modelled explicitly as one of:

1. repointing a mutable dist-tag to an already-published immutable version;
2. publishing a new fixed version; or
3. deprecating a bad version and directing consumers to a fixed version.

Anyam must not claim that npm can restore or overwrite a previously published
`name@version`.

## Qualification matrix

| Boundary | Current evidence | Status |
| --- | --- | --- |
| Anyam package Artifact and Release sealing | `test/library-release.test.ts`, 3/3 | qualified locally |
| Anyam generic Target state machine | Scripted adapter tests | qualified locally |
| Real package-like provider publication | GitHub Release asset in #85 | qualified for GitHub adapter only |
| npm registry reachability | `npm ping` PONG | provider reachable |
| npm publisher identity | `npm whoami` HTTP 401 | missing |
| Package namespace ownership | `404` observations; `@anyam` occupied | missing/legal decision |
| npm write credential or trusted publisher | none configured | missing |
| npm publish/stage transaction | no transaction attempted | unqualified |
| npm tarball bytes and registry integrity | no registry object | unqualified |
| npm provenance attestation | no publish; current CLI below trusted-publish floor | unqualified |
| npm response-loss reconciliation | local scripted provider only | unqualified |
| npm idempotency/duplicate publish behavior | provider docs only | unqualified live |
| npm dist-tag/deprecation rollback | provider docs only | unqualified live |
| npm rate limits, billing, retention, and support | no account feed | unqualified |
| Customer-operated Anyam control plane publishing to npm | no Anyam npm adapter or deployed auth path | unqualified |

## Required next live qualification

The research decision for [Qualify live npm package publication as a Release Target](https://github.com/Whyme-Labs/anyam/issues/119) is now recorded as **not qualified**. The follow-up task [Provision an owner-controlled npm namespace and trusted publisher](https://github.com/Whyme-Labs/anyam/issues/126) must complete before a live npm transaction is attempted.

Do not attempt the live qualification until a controlled npm namespace and owner decision exist.
The next qualification run should use a unique package version and a
customer-owned package, not `@anyam` or an unowned bare name. It should:

1. record the legal/package owner and exact package name;
2. declare `repository.url` and the public/private provenance boundary;
3. upgrade the publication worker to a documented npm-compatible CLI version;
4. configure one of the supported cloud-hosted trusted publishers, or record a
   narrowly scoped expiring granular-token exception;
5. publish one deterministic Artifact and record the registry package version,
   tarball URL, integrity, dist-tag, and provenance result;
6. simulate or observe provider response loss after the provider commit, then
   reconcile the existing version by checking registry metadata and tarball
   integrity without rebuilding;
7. repeat the same request and record npm's duplicate/version immutability
   response;
8. qualify the chosen staged/direct flow and interactive approval boundary;
9. qualify rollback as dist-tag repointing, a new fixed version, or deprecation;
10. record provider receipts for credential scope, package owner, operation
    IDs where available, timing, limits, cleanup, and cost. Do not unpublish a
    package merely to make the fixture disappear; npm's policy makes that
    irreversible and a version cannot be reused.

If Anyam's own customer-operated Runner is used, that is not automatically a
npm trusted-publishing path: npm's current trusted-publisher support excludes
self-hosted runners. A provider adapter must either use a supported hosted
workflow or use a separately authorized granular token with an explicit
secret-broker boundary.

## Conclusion

```text
localPackageArtifact=qualified
localAnyamReleaseTarget=qualified-with-scripted-adapter
liveGitHubReleaseTarget=qualified (#85)
npmRegistryReachability=passed
npmPublisherAuth=missing (HTTP 401)
npmNamespace=unresolved; @anyam occupied
npmTrustedPublishing=not configured; npm CLI 10.9.8 < documented 11.5.1 floor
npmPublish=not attempted
npmProvenance=not qualified
npmRollback=provider semantics documented, not live-qualified
productionNpmSupport=false
```

[Qualify live npm package publication as a Release Target](https://github.com/Whyme-Labs/anyam/issues/119) is resolved with an explicit unqualified decision; no product code was changed by this research receipt.
