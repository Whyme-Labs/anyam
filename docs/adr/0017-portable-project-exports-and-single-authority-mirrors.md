# Portable Project Exports and single-authority mirrors

Status: Accepted

## Context

Anyam must be fully open source and customer-operable in a Cloudflare account,
while remaining useful with GitHub, Codeberg, GitLab, generic Git, external
Runners, and future implementations. The user explicitly wants GitHub
mirroring to work in both directions, but a second canonical authority would
make hybrid Source Spaces, Evidence, Releases, and policy impossible to reason
about.

Issue [#25](https://github.com/wms2537/anyam/issues/25) asked for complete
Project export/import, repository mirrors, public contribution loops,
disaster-recovery bundles, portable metadata and attestations, backend
migration, cross-Realm contribution, and the line between early mirroring and
later federation. Primary-source inputs are in the accompanying research note:
[`docs/research/2026-08-02-portability-mirroring-and-federation.md`](../research/2026-08-02-portability-mirroring-and-federation.md).

## Decision

### Anyam has one canonical Project authority

The receiving Anyam Realm and its authoritative Project Revision are the only
canonical authority for a Project. GitHub, Codeberg, GitLab, a customer mirror,
an external Runner, or another Anyam Realm is an external source, proposal,
projection, or recovery copy.

```text
Project Revision
  → canonical Source Space repositories
  → optional public/private mirrors

external commits/refs
  → quarantine and validation
  → local Intent/Change proposal
  → local Evidence/review/Policy/Landing
```

No last-writer-wins rule exists between Anyam and a mirror. Remote force pushes,
deletions, rewrites, tags, and protected-branch changes are explicit proposal
types. Canonical source changes only through Anyam Landing.

### Complete Project Export

`Project Export` is the portability, migration, and disaster-recovery contract.
It is a signed, content-addressed manifest containing, subject to the export
Actor's disclosure authority:

```text
schema versions and export identity
Realm/Organization/Project ownership and configuration
every Source Space repository, object format, refs, and Git bundle/export
LFS and large-object manifests with digests and recovery references
Project Profiles, Views, mounts, disclosure and model policies
Intents, Claims, Changes, Revisions, Cohorts, Conflicts, Landing journals
Project Revision and Project View Revision manifests
Project Manifest, Actions, Verifiers, Runner/Target/Artifact adapters
Runs, Evidence validity keys, stale causes, attestations, and projections
Artifacts, Releases, Targets, Promotions, health and rollback records
mirror mappings, generations, remote identities, and reconciliation status
policies, grants/epochs, approvals, reviews, and immutable Audit Events
event/checkpoint manifests and Read Model rebuild instructions
encrypted object copies, signatures, digests, and retention metadata
```

Git bundles are used for repository refs and reachable objects where suitable;
they are not presented as a complete Project export. The export contains no
active credentials, refresh tokens, secret values, or unbounded bearer URL.

Large external objects require an owner-controlled recovery location and a
verifiable digest. Missing or unverifiable objects make the export explicitly
incomplete rather than silently lossy.

### Import and restore

Import is staged and quarantined:

1. Verify schema, signature, manifest, object digests, repository bundles,
   large objects, and disclosure policy.
2. Map identities into a new or explicitly selected Realm/Project.
3. Materialize repositories and Read Models without activating external
   Targets, Mirrors, or privileged credentials.
4. Rebuild and compare Project Revisions, Change/Evidence/Release identities,
   audit lineage, and public Disclosure Projections.
5. Reconcile provider refs and external Targets as proposed state.
6. Require an explicit owner activation decision.

The imported Project Revision, not a provider's latest ref, is the authority.
Restore failure is a durable blocked/incomplete state with remediation and
Evidence. Import never overwrites an existing Project by name alone.

### Repository portability

The `RepositoryDriver` contract remains the provider boundary. Cloudflare
Artifacts is the preferred driver when qualified; generic Git Smart HTTP,
GitHub, GitLab, Codeberg/Forgejo, and other drivers can store a Source Space.
The driver must preserve Git object identity within the Source Space, expose
capabilities honestly, and support integrity-verified export/import.

Anyam stores `{algorithm, oid}` and does not silently translate SHA-1/SHA-256.
Provider-specific review refs, hooks, LFS, credentials, limits, and event
behavior are capabilities or extension data—not kernel authority.

### Two-way mirror contract

Each Mirror has a stable Anyam `mirrorId`, Source Space mapping, permitted ref
map, disclosure policy, remote identity, generation/OID state, and health
state. The adapter records every operation and uses idempotency and expected
remote state.

#### Outbound

Only verified canonical Source Space refs from a landed Project Revision may
propagate outward. Public mirrors receive only the public Projection. A remote
failure leaves canonical state unchanged and marks the Mirror `lagging`,
`divergent`, `blocked`, or `disabled`.

#### Inbound

Remote commits, branches, pull requests, tags, and deletions are untrusted
proposals. The adapter verifies identity, object integrity, ref policy, and
disclosure, then creates a local Intent/Change. The normal Workspace, Run,
Evidence, review, Cohort, and Landing path remains mandatory.

#### Loop prevention and reconciliation

Mirror operations carry origin Realm/Project/Source Space, mirror ID, operation
ID, Project Revision or remote generation, OID map, delivery ID, and
idempotency key. An adapter suppresses reflected operations, deduplicates
retries, and detects divergence. It never repairs divergence by overwriting a
side without a new auditable reconciliation decision.

### Public contribution loop

Anyam may mirror a public Source Space to GitHub, Codeberg, GitLab, or generic
Git for discovery and ordinary contributor workflow:

```text
public Anyam Source Space
  → read-only/public mirror
  → external commit or pull request
  → inbound adapter
  → local Change proposal
  → Anyam policy, Verifiers, review, Landing
  → verified public Project Revision
  → outbound mirror
```

The public contributor never needs access to a private Source Space. Sealed
verification returns the owner's configured Disclosure Projection. An external
forge App credential is never an Anyam Realm or Target credential.

### Cross-Realm contribution

Realms are independent authorities. Cross-Realm contribution requires an
explicit installed-app or federation grant that narrows resource, disclosure,
operation, and duration. The receiving Realm creates a local proposal and owns
all local policy, review, revocation, Landing, and Promotion. A foreign token,
approval, Evidence, or Project Revision is not local authority without a
versioned attestation/import contract.

### Federation is deferred

Early Anyam ships complete exports, Git-compatible drivers, two-way Mirrors,
public contribution adapters, and installed-app cross-Realm contribution. A
future federation protocol must separately qualify signed instance identity,
capability-scoped discovery/transfer, Project View disclosure, local
moderation, revocation, abuse control, replay/loop prevention, lineage,
attestation negotiation, residency, deletion, and the single-authority rule.

Experimental federation is not a launch dependency. Federation must never
quietly create shared canonical authority.

### Recovery and verification gates

Portability is not complete until the following are exercised:

- full Project Export and clean-Realm restore;
- Git bundle/full-history and LFS round trip;
- object-format and signature preservation;
- missing/corrupt object detection;
- public projection excludes restricted Source Spaces and metadata;
- mirror lag, divergence, remote force update, deletion, webhook duplicate,
  outage, and loop injection;
- inbound proposal cannot directly mutate canonical source;
- outbound mirror cannot expose private source or credentials;
- cross-Realm grant revocation removes access and prevents renewal;
- Read Model rebuild matches authoritative identities and disclosure;
- restore does not promote Targets or activate credentials without approval.

Each gate emits Evidence bound to the exact exporter, driver, schema, policy,
disclosure, and restored state. A passed gate becomes stale after a material
schema, driver, provider, disclosure, or policy change.

## Consequences

- Customers can move repositories and the complete Anyam collaboration graph
  without treating Cloudflare storage as the only recovery path.
- GitHub and Codeberg remain valuable discovery/contribution surfaces without
  becoming hidden Anyam dependencies or authorities.
- Bidirectional mirroring has more explicit states than a simple `git push
  --mirror`, but it is safe for hybrid source and policy-controlled delivery.
- Project Export is larger than a Git clone because it preserves the actual
  product: Changes, Evidence, Releases, policies, and provenance.
- Federation can be added later without making early portability depend on an
  unfinished distributed social protocol.

## Rejected alternatives

- **Two-way multi-primary last writer wins:** loses policy, review, disclosure,
  and cross-space atomicity.
- **Git bundle as the complete backup:** omits Anyam collaboration and
  project-delivery state, and Git documents that it does not include working
  tree or repository configuration.
- **Public mirror of the full hybrid repository:** leaks private Source Space
  objects or metadata; public projections must be separate.
- **Remote pull request equals Anyam approval:** external review state does not
  satisfy local policy, Evidence, or separation of duties.
- **Every Anyam Realm trusts another Realm by default:** creates unbounded
  cross-tenant authority and makes revocation ambiguous.
- **Launch federation before export/mirror recovery works:** distributes
  unresolved identity, moderation, deletion, and disclosure problems.

## References

- [Portability, mirroring, and federation research](../research/2026-08-02-portability-mirroring-and-federation.md)
- [Git compatibility and Repository Drivers](../research/2026-08-02-git-compatibility-and-repository-drivers.md)
- [Cloudflare-first architecture](0015-cloudflare-first-architecture-and-provider-boundaries.md)
- [Publication Changes and sealed verification](0004-publication-changes-and-sealed-verification.md)
- [Evidence validity and provenance](0013-evidence-validity-policy-and-provenance.md)
