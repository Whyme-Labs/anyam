# Anyam portability, mirroring, and federation research

**Research snapshot:** 2 August 2026
**Ticket:** [#25](https://github.com/Whyme-Labs/anyam/issues/25)
**Status:** portability and integration baseline; federation remains a later qualification

## Executive findings

1. Git bundles are a real, offline transfer and backup primitive. They can be
   full or incremental and can be verified, but they carry reachable Git refs
   and objects—not a complete Anyam Project, working tree, repository
   configuration, or collaboration ledger. [Git bundle documentation](https://git-scm.com/docs/git-bundle)
2. GitHub's own mirroring documentation uses bare/mirror clones and
   `git push --mirror`, and notes that a mirrored clone follows the source's
   refs. That is useful transport behavior, but it is not a multi-primary
   collaboration protocol. [GitHub: duplicating a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository)
3. Git Smart HTTP remains the interoperable source-object path. Anyam should
   preserve Git object identity per Source Space and put provider-independent
   policy and stable URLs in the Anyam Git Gateway. [Git Smart HTTP](https://git-scm.com/docs/gitprotocol-http)
4. Build provenance formats such as SLSA and in-toto are useful portable
   attestations, but they do not encode Anyam's Source Spaces, Project Views,
   Changes, disclosure, or Promotion authority. Anyam must preserve originals
   and normalize only the fields its policy understands. [SLSA v1.2](https://slsa.dev/spec/v1.2/), [in-toto](https://in-toto.io/)

## Portability guarantee

Anyam is Cloudflare-first, not Cloudflare-hostage. A complete Project Export is
the recovery and migration contract. It contains:

```text
export manifest and schema versions
Realm/Organization/Project identity and ownership metadata
all permitted Source Space repositories and object-format descriptors
Git bundles or equivalent full-history export for every repository/ref set
Git LFS or large-object manifests and content references
Project Profiles, Views, mounts, source mappings, and disclosure policies
Intents, Claims, Changes, Change Revisions, Cohorts, Conflicts, Landing journals
Project Revisions and Project View Revisions
Project Manifest, Actions, Verifiers, Target/Runner/Artifact adapter metadata
Runs, Evidence metadata and payload references, attestations, and stale causes
Artifacts, Releases, Targets, Promotions, health and rollback records
Mirror configurations, ref mappings, reconciliation generations, and status
Policy versions, grants/epoch history, approvals, review findings, and audits
event/checkpoint manifests needed to rebuild Read Models
encrypted recovery objects and digests for every referenced large object
```

The export is a signed, content-addressed manifest. It contains no active
provider credential, refresh token, secret value, or unbounded presigned URL.
External references must include a digest and an owner-controlled recovery
location; an export that cannot verify a required object is incomplete.

### Import and restore rules

Import is a staged operation, never an implicit overwrite:

1. Verify the export signature, manifest schema, object digests, repository
   bundles, LFS/large-object references, and disclosure policy.
2. Map source and provider identities into a new Realm or explicit existing
   Project without assuming names are unique.
3. Recreate repositories and Read Models in quarantine.
4. Rebuild and compare Project Revisions, Change/Evidence/Release identities,
   and public Disclosure Projections.
5. Reconcile external Targets and Mirrors as proposed state; do not promote or
   publish merely because an export names a previous current state.
6. Require an explicit owner decision to activate the restored Project.

Import never accepts a provider's latest ref as authoritative over the exported
Project Revision. A migration that cannot verify all required data becomes an
explicit incomplete/blocked restore with a remediation list.

## Repository and backend migration

`RepositoryDriver` remains the provider seam. A driver must support the
compatibility level required by the Source Space and implement full export,
restore, integrity verification, credential lifecycle, and reconciliation.
The initial provider may be Cloudflare Artifacts, generic Git Smart HTTP,
GitHub, GitLab, Codeberg/Forgejo, or another adapter. The driver does not own
Anyam authorization, Change identity, Project Revision, or cross-space
atomicity.

Object identity is preserved inside each Git Source Space. Anyam stores
`{algorithm, oid}` instead of assuming a fixed hash length. It does not silently
rewrite SHA-1 to SHA-256 or vice versa. A format conversion is a new explicit
migration with round-trip verification, signatures, and mirror impact review.

Provider-specific issues—missing SSH, ref-scoped tokens, hooks, review refs,
LFS behavior, event ordering, limits, or public reads—are capability results.
The kernel rejects an unsupported path or uses a documented fallback; it never
silently weakens a Source Space boundary.

## Two-way mirror model

Mirroring is bidirectional transport, not bidirectional authority.

```text
Anyam canonical Project Revision
        │
        ├── accepted Source Space refs ──→ external mirror
        │                                  (GitHub, Codeberg, GitLab, generic Git)
        │
        └── remote commits/refs ←──────── mirror adapter
             quarantine → imported Change proposal
```

### Anyam to remote

After a Project Revision lands and canonical Git refs are verified, the Mirror
Adapter may push the owner-declared refs to the remote. Public mirrors receive
the safe public Source Space/Project View only. Private Source Spaces are never
included because a mirror is not an authorization boundary.

The outbound operation is bound to:

```text
Project Revision / Source Space Snapshot
mirror ID and configured ref map
expected remote generation or OIDs
mirror operation ID and idempotency key
disclosure projection
```

Remote failure produces `lagging`, `divergent`, `blocked`, or `disabled` state;
it never changes the canonical Project Revision.

### Remote to Anyam

Remote pushes, pull requests, issue links, or imported bundles are untrusted
proposals. The adapter verifies the remote identity, permitted refs, object
integrity, disclosure boundary, and source-space mapping, then creates an
Anyam Change or Intent. Only the normal Workspace, Evidence, review, Cohort,
and Landing path can advance canonical state.

Remote force updates, deletions, rewrites, tags, and protected branches are
explicit proposal types. They are not silently applied as last-writer-wins
state. Remote metadata that has no Anyam equivalent is retained as extension
data or a Disclosure Projection; it cannot create an approval or Promotion.

### Loop and divergence control

Every mirror operation carries:

```text
mirrorId
operationId
originRealm/project/sourceSpace
originProjectRevision or remote generation
source and destination OID map
event/delivery ID
idempotency key
```

The adapter suppresses its own reflected operation, deduplicates retries, and
detects divergence by comparing expected and observed refs/object digests. It
never repairs divergence by overwriting one side without an explicit policy
decision and an auditable reconciliation Change.

Mirror states are explicit:

```text
provisioning → healthy → lagging | divergent | blocked | disabled
```

An external repository is never a second canonical repository. Anyam can be
temporarily unavailable while the mirror remains readable, but a mirror cannot
land source or approve a Release.

## GitHub/Codeberg contribution loops

The first public distribution path should be:

1. Anyam public Source Space is anonymously cloneable through the Anyam Git
   Gateway and optionally mirrored to GitHub, Codeberg, or another forge.
2. A contributor uses the external forge's ordinary Git workflow.
3. The Mirror Adapter imports the selected commit range or pull request as a
   proposed Anyam Change in the public Source Space.
4. Anyam runs its own disclosure, policy, Actions/Verifiers, review, and
   Landing path.
5. The landed public Project Revision is mirrored outward after verification.

This keeps public discovery and community workflow available without making a
third-party forge the source of truth. A contribution to a public Source Space
must not disclose or require access to a private Source Space. If a Change
needs private implementation or sealed tests, the public contributor receives
only the configured result projection.

The GitHub mirror adapter may use a GitHub App or another narrowly installed
integration, but its credential is an adapter identity. It cannot be reused as
an Anyam Realm, Project, Source Space, or Target credential.

## Disaster recovery and mirrors

Mirrors are useful availability and discovery copies, but they are not a
complete disaster-recovery strategy:

- a public mirror intentionally excludes restricted Source Spaces and private
  collaboration metadata;
- a remote forge may alter availability, retention, refs, LFS, or metadata;
- a mirror can lag or be maliciously rewritten;
- Git bundles contain reachable refs/objects but not the Anyam ledger, policies,
  Evidence, Releases, Targets, or audit history.

The recovery baseline is periodic complete Project Exports plus verified Git
bundles, encrypted large-object copies, and tested restore into a clean
Customer-operated Realm. Recovery Evidence records which objects and
projections were restored and which external Targets still need reconciliation.

## Cross-Realm contribution

Realms are independent authorities. A cross-Realm contribution is an explicit
resource-scoped federation or installed-app grant:

```text
contributor Realm authenticates its principal/Actor
        ↓
receiving Realm verifies the external grant and disclosure projection
        ↓
receiving Realm creates a local Intent/Change proposal
        ↓
receiving Realm owns review, policy, revocation, Landing, and Promotion
```

The receiving Realm never treats a foreign token, role, approval, Evidence,
or Project Revision as local authority without a versioned import/attestation
contract. A foreign Realm cannot enumerate hidden Source Spaces or retain
access after the receiving Realm revokes the contribution grant.

## Federation boundary

Federation is deferred until the single-operator mirror and export contracts
are proven. A future federation protocol would need, at minimum:

- signed instance and Project identity with key rotation;
- capability-scoped cross-Realm discovery and object transfer;
- disclosure-safe Project Views and public projections;
- local policy, moderation, rate limits, abuse response, and revocation;
- Change/Review/Evidence/Release lineage that survives instance boundaries;
- loop-safe delivery, replay protection, and divergence repair;
- portable attestation and trust-policy negotiation;
- data residency and deletion semantics;
- an explicit statement that federation never creates shared canonical
  authority.

Forge federation work is a useful ecosystem signal, but Anyam should not make
an experimental federation implementation a launch dependency. Public mirrors,
Project Exports, Git-compatible clients, and installed-app contribution are
enough to provide portability and community reach first.

## Sources

- [Git bundle](https://git-scm.com/docs/git-bundle)
- [Git Smart HTTP](https://git-scm.com/docs/gitprotocol-http)
- [Git protocol v2](https://git-scm.com/docs/gitprotocol-v2)
- [GitHub repository duplication and mirroring](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository)
- [SLSA specification v1.2](https://slsa.dev/spec/v1.2/)
- [in-toto](https://in-toto.io/)
- [Anyam Git compatibility and Repository Drivers](2026-08-02-git-compatibility-and-repository-drivers.md)
- [Anyam open-source distribution and licensing](2026-08-02-open-source-distribution-and-licensing.md)
- [Anyam system threat model](2026-08-02-system-threat-model.md)
