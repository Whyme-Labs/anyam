# GitHub release-download Target qualification

**Date:** 15 August 2026  
**Ticket:** [#194](https://github.com/Whyme-Labs/anyam/issues/194)  
**Protocol:** `anyam.github-release-assets-qualification/v1`

## Implementation boundary

Anyam now has a provider-neutral `ReleaseAssetTarget` publication path and a
`github.release-assets` adapter. The adapter consumes only a detached verified
`ImmutableRelease` and one selected `Artifact`; it never checks out a branch,
rebuilds bytes, writes canonical source, or advances Anyam's Target pointer.
Provider release/asset identities, URLs, media type, byte length, digest,
disclosure, capability flags, and redacted receipts are retained on the
publication record.

The adapter uses a deterministic release tag derived from the Release digest,
uploads the exact Artifact bytes plus an Anyam release manifest, reconciles
response loss by inspecting the deterministic Release/asset identity, verifies
downloaded bytes before accepting publication, and treats a same-name digest
mismatch as an indeterminate non-retryable degradation. Rollback is a Target
pointer change to a prior known-good Release; it does not rebuild or overwrite
provider bytes.

## Local qualification receipt

Command:

```text
npm run qualification:github-release-assets
```

Receipt from the current checkout:

```json
{
  "protocol": "anyam.github-release-assets-qualification/v1",
  "fixture.status": "succeeded",
  "responseLossReconciled": true,
  "duplicateIdempotent": true,
  "secondReleasePublished": true,
  "rollbackByPointer": true,
  "mismatchDegraded": true,
  "credentialValues": "not-printed",
  "canonicalWrite": false
}
```

The fixture is a contract/state-machine receipt, not a claim about GitHub
availability, plan limits, cost, retention, or production behavior.

## Portable export receipt

`ProjectExport` now carries an optional `artifactFiles` disposition for every
declared non-repository `Artifact`:

- `included` stores the exact bytes under `artifacts/`, records byte length and
  digest, and `verifyProjectExportPackage` re-reads and verifies them.
- `unavailable` records an explicit reason such as
  `bytes-not-provided-to-exporter`; the gap is never hidden behind Artifact
  metadata alone.

Local tests cover both included-byte verification and explicit unavailable
disposition.

## Live qualification boundary

The command will run a live disposable GitHub Release only when all of these
owner-supplied values are present in the invoking environment:

```text
ANYAM_GITHUB_RELEASE_ASSETS_REPOSITORY=owner/disposable-repository
ANYAM_GITHUB_RELEASE_ASSETS_DISPOSABLE_REPOSITORY=owner/disposable-repository
ANYAM_GITHUB_RELEASE_ASSETS_QUALIFICATION_ID=unique-owner-run-id
ANYAM_GITHUB_RELEASE_ASSETS_TOKEN=<short-lived repository-scoped credential>
ANYAM_GITHUB_RELEASE_ASSETS_SCOPES=contents:read,contents:write
ANYAM_GITHUB_RELEASE_ASSETS_TOKEN_EXPIRES_AT=<provider expiry timestamp>
ANYAM_GITHUB_RELEASE_ASSETS_SCOPE_RECEIPT=<redacted provider scope receipt>
ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_BASE_URL=https://customer-realm.example
ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE=/path/to/owner-session.txt
```

Use exactly one of
`ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION` or
`ANYAM_GITHUB_RELEASE_ASSETS_AUTHORITY_OWNER_SESSION_FILE`. The session file
contains only the opaque owner-session value, not a `Cookie:` header. The
qualification exports and verifies an empty credential-free Authority
snapshot, creates a disposable Project/Workspace/Change/Revision/Run/Evidence
lineage, records the selected Artifact, creates the immutable Release and
provider-neutral Target, and records the expected blocked `promotion.request`
handoff. Cleanup restores the exact Authority snapshot and verifies its digest.

The adapter requires an observed immutable-release capability by default. A
missing capability, missing scoped credential receipt, unavailable owner
session, non-empty Authority boundary, or provider response that cannot be
reconciled is a visible qualification blocker. The live path must use an
explicitly disposable repository and clean its deterministic Release before
reporting success. The qualification ID is included in the detached Release
digest so GitHub's permanently reserved immutable-release tags cannot collide
across owner runs; retries within one run remain deterministic. No GitHub
Actions runner is required; the qualification is a local command using the
provider API, so Blacksmith is not part of this gate.

Until that live command succeeds with a current provider and Authority
receipt, `github.release-assets` is locally implemented and contract-qualified
but must not be described as universally or production qualified.
