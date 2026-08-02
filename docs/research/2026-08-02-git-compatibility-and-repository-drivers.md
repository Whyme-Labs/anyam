# Git compatibility and Repository Drivers

**Research date:** 2 August 2026

**Decision status:** Accepted planning baseline for [Define Git compatibility and repository drivers](https://github.com/wms2537/anyam/issues/10). Cloudflare Artifacts remains conditional until the qualification gates in this document pass.

**Evidence policy:** Current official Git, Git LFS, Cloudflare, and GitHub documentation. Documentation establishes contracts and reported capability, not production readiness; every provider still has to pass Anyam's conformance suite.

## Executive decision

Anyam preserves Git as the source-object and compatibility protocol for each Source Space and Workspace. It does not try to encode the Project, Source Space composition, Change identity, cross-space Landing, policy, Evidence, or disclosure model into Git refs, notes, commit messages, or submodules.

The resulting authority split is:

```text
Anyam Project Revision
  authoritative coherent Project state across Source Spaces
             |
             +-- Source Space A Snapshot -> exact Git commit
             +-- Source Space B Snapshot -> exact Git commit
             +-- Source Space C Snapshot -> exact Git commit
                                      |
                                      v
                         canonical Git repositories
                         and ordinary Git refs
                         as repairable projections
```

The core rules are:

1. One Git repository belongs to one Source Space or one isolated Workspace. A repository is never the complete Project.
2. Each Source Space has one canonical repository containing landed source. Humans and agents can read it but cannot write it.
3. Each writable Change uses an isolated Workspace repository. A human or agent may push there with a short-lived grant scoped to that repository and task.
4. Only the Landing service advances the canonical Project Revision and then reconciles canonical Git refs from it.
5. A Repository Driver manages Git repositories; it does not decide Anyam authorization, policy, cross-space atomicity, Change identity, or disclosure.
6. HTTPS Git Smart HTTP is the required transport. SSH is a compatibility adapter, not a required dependency of a Customer-operated Realm.
7. Public Source Spaces must be anonymously cloneable through the Realm without depending on GitHub or another forge. A provider without anonymous read is placed behind the Anyam Git gateway.
8. Git LFS is an Anyam-owned, portable large-object surface backed by a separate Large Object Store. Provider-native LFS is optional and cannot be the only copy.
9. GitHub mirroring is bidirectional but never multi-primary. Remote commits become proposed Changes; only landed refs propagate outward.
10. Cloudflare Artifacts is the preferred driver but is still closed beta. A release may claim customer-operated source hosting only when Artifacts is qualified and available in the customer's account, or an open-source Cloudflare-native driver has passed the same suite. A generic external Git remote is a migration and interoperability driver, not that fallback.

## 1. The compatibility promise

### 1.1 Required Git behavior

An Anyam Git-backed Source Space must preserve, without rewriting object identity:

- commit, tree, blob, and annotated-tag objects;
- commit parentage, author and committer records, messages, and signatures;
- ordinary branches under `refs/heads/*`;
- tags under `refs/tags/*`, including signed and annotated tags;
- notes under `refs/notes/*` when explicitly imported or created by the owner;
- the repository's symbolic `HEAD` and default branch;
- clone, fetch, pull, and push behavior through standard Git clients;
- fast-forward, non-fast-forward, force, delete, and multi-ref push results as advertised by the server;
- protocol capability negotiation rather than client assumptions;
- shallow clone/deepen when the driver advertises it;
- full mirror import and export of owner-controlled refs;
- the repository object format reported by Git.

Git Smart HTTP defines separate discovery and request paths for `git-upload-pack` and `git-receive-pack`. Git protocol v2 improves reference discovery and fetch negotiation, while receive-pack capabilities such as `atomic` are independently advertised. Anyam therefore records capabilities per driver and repository rather than claiming that "Git compatible" means every optional capability. [Git Smart HTTP](https://git-scm.com/docs/gitprotocol-http), [Git protocol v2](https://git-scm.com/docs/gitprotocol-v2), and [Git protocol capabilities](https://git-scm.com/docs/gitprotocol-capabilities) are the normative protocol references.

### 1.2 Compatibility levels

| Level | Required behavior | Product use |
|---|---|---|
| **G0: Read** | `ls-remote`, clone, fetch, branches, tags, exact object identity | Public mirrors, archive and read-only Source Spaces |
| **G1: Workspace** | G0 plus push, create/update/delete refs, force updates, ordinary Git clients | Human and agent Workspace repositories |
| **G2: Canonical** | G1 plus expected-old-OID ref updates, integrity verification, complete export/restore, durable reconciliation | Canonical Source Space repositories |
| **G3: Optimized** | Fork/copy-on-write, native events, atomic multi-ref push, partial clone, bundle URI, native archive | Performance optimizations only |

Every production driver must pass G2. A driver can omit G3 without weakening correctness.

### 1.3 Baseline object format

The initial compatibility baseline is SHA-1 Git repositories because it has the broadest client and provider interoperability. Anyam never truncates or assumes a fixed object-ID length in its own schemas: it stores `{algorithm, oid}` and exposes the driver's `objectFormat` capability.

SHA-256 repositories are accepted only when the selected driver, import source, mirrors, clients, LFS path, bundle format, and restore target all pass round-trip tests. Anyam must not silently translate a repository's object format because commits and signatures would acquire different object identifiers. Git protocol v2 can advertise `object-format`; absent that capability, the protocol assumes SHA-1. [Git protocol v2 object format](https://git-scm.com/docs/gitprotocol-v2) and Git's [hash transition design](https://git-scm.com/docs/hash-function-transition) document the distinction.

### 1.4 Required transports

| Transport | Decision |
|---|---|
| HTTPS Smart HTTP | Required from the first usable version; normal data plane for clone, fetch, and push |
| Anonymous HTTPS read | Required for public Source Spaces at the Realm surface, even when the underlying driver needs an internal read credential |
| HTTPS with OAuth credential helper | Required default for private source and Workspace writes |
| SSH | Planned compatibility adapter; not a correctness or Customer-operated Realm installation requirement |
| Git native unauthenticated protocol | Excluded because it lacks the required modern authentication and policy boundary |
| File/local transport | Supported locally by Git, but not a hosted Realm endpoint |

Cloudflare Artifacts currently documents Smart HTTP, not SSH or anonymous access. Anyam therefore cannot expose the provider URL as its permanent product contract. The Realm-owned Git gateway supplies the stable URL, public-read policy, OAuth-to-driver credential exchange, audit boundary, and provider migration point.

Example addresses:

```text
https://source.customer.example/acme/atlas/community.git
https://source.customer.example/acme/atlas/commercial-core.git
https://source.customer.example/acme/atlas/workspaces/chg-4821.git
```

The physical provider URL remains internal and replaceable.

## 2. What standard Git does not represent

The following are Anyam objects, never Git conventions masquerading as authority:

| Anyam semantic | Why Git is insufficient |
|---|---|
| Project and Source Space | One Git repository has one reachable object graph and cannot safely hide an independently governed subtree |
| Project Profile and Project View | Sparse checkout and partial clone change materialization or transfer, not authorization or disclosure |
| Project Revision | Git cannot atomically identify one coherent state across several repositories |
| Project View Revision | A safe audience-specific identifier must exclude every inaccessible input |
| Change and Change Revision | A branch/ref name does not provide stable identity across rebases, replacements, or several Source Spaces |
| Workspace | It is a composed editable environment and authority lease, not merely a branch |
| Landing | It includes policy, Evidence, cross-space composition, and an authoritative Project transition |
| Capability Grant | Git credentials do not express principal, actor, task, tool, model, budget, or permitted effect |
| Evidence, Release, and Promotion | Git commits and tags do not prove execution or authorize a Target transition |
| Disclosure Projection | Git permission errors and hidden refs can still leak metadata; safe projections require separate identifiers and data |

Git notes may carry an optional portable copy of selected public provenance. Branches and pull-request views may present Changes. Neither becomes the primary database.

## 3. Repository topology

### 3.1 Canonical repositories

Each Git-backed Source Space owns one canonical repository:

```text
Project atlas
  Source Space community        -> canonical repository community
  Source Space commercial-core  -> canonical repository commercial-core
  Source Space restricted-tests -> canonical repository restricted-tests
```

Canonical repositories have these invariants:

- their object graph contains only the owning Source Space;
- their advertised source refs represent landed state;
- only the Landing service receives write credentials;
- humans, agents, CI jobs, mirrors, and integrations never receive canonical write credentials;
- public and private Source Spaces are never branches of the same repository;
- provider-internal identifiers, staging refs, token endpoints, or object IDs from an inaccessible Source Space are never disclosed;
- repository refs are projections of authoritative Project Revisions and can be reconciled idempotently.

The default source channel should use the familiar `refs/heads/main` unless the owner chooses another branch name. Anyam does not require an `anyam/*` branch namespace.

### 3.2 Workspace repositories

A Workspace repository is an isolated writable Git repository materialized from an exact Source Space Snapshot for one Change and bounded task. It may be created by provider-native fork, copy-on-write clone, bundle restore, or trusted Git fetch/push; those are implementation details.

The secure baseline is repository-per-Workspace because Cloudflare Artifacts currently grants repository-wide `read` or `write`, not ref-scoped authority. An optimization may use isolated refs only when the driver proves equivalent access isolation, deletion, quota, and audit behavior.

Workspace rules:

- a grant writes only the assigned Workspace repository;
- ordinary branch names and commits remain usable;
- force pushes produce a new immutable Change Revision rather than erasing review history;
- a Workspace is created from an exact Project Revision, not a moving default branch;
- it is retained through Landing recovery and then expires under policy;
- deletion never deletes the Change, Change Revisions, Project Revisions, Evidence, or accepted commits;
- two simultaneous agents use separate Workspace repositories.

### 3.3 Landing staging

Git has no cross-repository transaction. Landing therefore uses a persisted state machine and a non-public staging repository or equivalent object-staging area:

1. Verify the expected base Project Revision and acquire the Project landing lease.
2. Verify every candidate commit, Source Space ownership, policy decision, and required Evidence.
3. Make every candidate commit durably recoverable in a non-public landing-staging repository or driver staging facility.
4. Record a prepared Landing journal containing expected old and desired new OIDs for every canonical ref.
5. Compare-and-swap the authoritative Project Revision pointer.
6. Reconcile each canonical repository ref from the committed Project Revision using expected-old-OID updates.
7. Verify advertised refs and object reachability.
8. Mark the Landing complete and only then enqueue outbound mirrors, builds, Releases, and public activity.

The Project Revision transition is authoritative. Git refs can lag while reconciliation retries, but they cannot create a second Project truth. If reconciliation is incomplete, the portal and APIs expose a degraded `git_projection_pending` state and later Landing for that Project remains serialized. No external mirror advances until the canonical projection is verified.

This design deliberately prefers an authoritative Project Revision with repairable Git projections over a false claim of distributed Git atomicity.

## 4. Ref policy

### 4.1 Owner-controlled refs

The portable default ref set is:

```text
HEAD
refs/heads/*
refs/tags/*
refs/notes/*
owner-declared custom refs
```

Provider-generated review refs such as pull-request heads are not canonical source refs. They may be imported into a quarantine namespace or collaboration record, but they are not mirror-pushed into the canonical repository by default.

### 4.2 Internal refs

Authoritative Anyam metadata must not live in `refs/anyam/*` or another custom ref namespace. Such refs would be difficult to hide consistently, would contaminate mirrors and exports, and could leak internal Change sequences.

If a backend uses internal refs for mechanics, it must prove that they are never advertised, fetchable, mirrored, indexed, archived, or exposed by object-ID fetch. The portable baseline instead uses a separate landing-staging repository and Anyam's own state store.

### 4.3 Ref updates

Every canonical update includes:

```text
repository
ref name
expected old OID or expected absence
desired new OID or deletion
Project Revision / Landing ID
idempotency key
```

The minimum guarantee is single-ref compare-and-swap. If the server advertises Git's `atomic` push capability, a driver may atomically update several refs in the same repository. That optimization never extends across repositories.

## 5. Repository Driver contract

### 5.1 Responsibility boundary

`RepositoryDriver` owns provider-specific repository lifecycle and Git data-plane access. The Anyam Project kernel owns domain identity, authorization, Landing, disclosure, policy, retries, and audit.

The driver must not:

- accept a human role or OAuth scope as its authorization decision;
- issue credentials directly to an LLM context;
- decide that a Change may Land;
- derive a Project Revision by reading latest repository heads;
- expose provider event order as Project order;
- make an external mirror canonical;
- silently emulate an unsupported capability with weaker behavior.

### 5.2 Normative interface

The language-neutral contract is:

```typescript
interface RepositoryDriver {
  describe(): Promise<RepositoryDriverDescriptor>;
  probe(): Promise<RepositoryDriverHealth>;

  createRepository(input: CreateRepositoryInput): Promise<RepositoryHandle>;
  inspectRepository(input: InspectRepositoryInput): Promise<RepositoryState>;
  deleteRepository(input: DeleteRepositoryInput): Promise<OperationReceipt>;

  createFromSnapshot(input: CreateFromSnapshotInput): Promise<RepositoryHandle>;
  importRepository(input: ImportRepositoryInput): Promise<ImportReceipt>;

  getGitEndpoint(input: GitEndpointInput): Promise<GitEndpoint>;
  issueGitCredential(input: GitCredentialInput): Promise<GitCredential>;
  revokeGitCredential(input: RevokeCredentialInput): Promise<OperationReceipt>;

  listRefs(input: ListRefsInput): Promise<RefMap>;
  compareAndSwapRefs(input: CompareAndSwapRefsInput): Promise<RefUpdateReceipt>;

  exportRepository(input: ExportRepositoryInput): Promise<RepositoryExportReceipt>;
  restoreRepository(input: RestoreRepositoryInput): Promise<RestoreReceipt>;
  verifyRepository(input: VerifyRepositoryInput): Promise<IntegrityReport>;

  reconcileEvents(input: ReconcileEventsInput): AsyncIterable<RepositoryEventHint>;
}
```

Every mutation takes an idempotency key and an expected repository generation. Delete requires the stable repository ID and expected generation, not a mutable name alone.

### 5.3 Capabilities

```typescript
type RepositoryDriverCapabilities = {
  git: {
    smartHttp: boolean;
    fetchProtocolVersions: Array<"v0" | "v1" | "v2">;
    pushProtocolVersions: Array<"v0" | "v1" | "v2">;
    ssh: boolean;
    anonymousRead: boolean;
    shallowFetch: boolean;
    partialCloneFilter: boolean;
    bundleUri: boolean;
    atomicMultiRefPush: boolean;
    pushOptions: boolean;
    signedPushCertificates: boolean;
    objectFormats: Array<"sha1" | "sha256">;
  };
  lifecycle: {
    nativeFork: boolean;
    publicImport: boolean;
    authenticatedImport: boolean;
    serverSideArchive: boolean;
  };
  auth: {
    scopes: Array<"read" | "write">;
    refScopedWrite: boolean;
    minimumTtlSeconds: number;
    maximumTtlSeconds: number;
    revocation: boolean;
  };
  events: {
    push: boolean;
    lifecycle: boolean;
    ordered: boolean;
    replay: boolean;
  };
  limits: {
    maximumRepositoryBytes?: number;
    maximumObjectBytes?: number;
    requestsPerWindow?: number;
  };
};
```

Capabilities are evidence-backed runtime data. They are not compile-time promises. The kernel fails explicitly or selects a documented fallback when a needed capability is absent.

### 5.4 Required behavior versus optimizations

| Contract concern | Required implementation | Permitted optimization |
|---|---|---|
| Create Workspace | Create repository, transfer exact base Snapshot | Provider-native fork |
| Git data transfer | Smart HTTP endpoint | Direct Worker binding reads for small files |
| Canonical ref update | Expected-old-OID CAS | Atomic multi-ref push within one repository |
| Public read | Realm gateway allows anonymous upload-pack | Driver-native anonymous remote |
| Import | Full owner-controlled ref/object transfer | Provider-native public import after equivalence test |
| Export | Complete portable Git data plus manifest | Provider snapshot API |
| Events | Poll/reconcile current refs | Native push/lifecycle events as wake-up hints |
| Recovery | Restore and compare through standard Git | Native snapshot restore |
| Workspace copy | Standard fetch/push or bundle transfer | Copy-on-write fork |

Fork, event, native import, archive, and partial-clone support must never be correctness dependencies.

## 6. Authentication and token granularity

### 6.1 Stable Anyam credential surface

The default client path is:

```text
Git client
  -> git-credential-anyam
  -> Realm OAuth session in OS keychain
  -> short-lived Anyam Git credential
  -> Realm Git gateway
  -> policy check and provider credential exchange
  -> Repository Driver endpoint
```

The Anyam credential is audience-bound to the Realm Git gateway and scoped to one repository plus operation class. It is not an MCP token, Cloudflare API token, driver token, PAT, or canonical-write grant.

Recommended lifetimes remain:

- read: 15 to 30 minutes;
- Workspace write: 10 to 15 minutes;
- Landing write: one Landing attempt, held only by the trusted service;
- one-time import/export: bounded to that operation and revoked on completion.

### 6.2 Provider credentials

Provider credentials remain inside the gateway, trusted runner, or Landing service. A driver with only repository-wide read/write credentials is safe under this topology because the writable repository is already the Workspace boundary.

Cloudflare Artifacts currently documents repository-scoped `read` and `write` tokens, with no ref-scoped variant. Its Git routes accept Bearer or Basic authentication; clone/fetch supports protocol v1 and v2, while push is receive-pack v1. [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) and [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) define that surface.

### 6.3 Public read

Anonymous public clients receive no credential. The gateway authorizes the Source Space as public, obtains or reuses an internal provider read grant, and streams only that repository's upload-pack response. It must not reveal provider repository names, namespaces, token URLs, private Source Spaces, or upstream errors containing those values.

If the gateway cannot stream clone and fetch within Cloudflare limits under load, the driver does not pass the public-read gate. A GitHub mirror may improve discovery and availability, but cannot be the only public clone endpoint.

## 7. Import, export, backup, and restore

### 7.1 Import

Canonical import uses the Git protocol rather than a lowest-common-denominator provider import endpoint:

1. Clone or fetch a complete mirror from the source.
2. Record source URL, fetch time, object format, default branch, advertised refs, shallow state, and LFS endpoint.
3. Reject a shallow source as a complete canonical import unless the owner explicitly accepts an incomplete-history migration.
4. Quarantine provider-owned refs and select the owner-controlled ref set.
5. Fetch every reachable Git LFS object.
6. Run integrity and secret/publication policy checks appropriate to the destination Source Space.
7. Push refs and objects into a new repository without rewriting OIDs.
8. Verify refs, object reachability, signatures, and LFS OID/size maps.
9. Create the initial Project Revision only after verification.

Cloudflare Artifacts' native import currently accepts a public HTTPS URL, optional branch, and optional depth, and may remain asynchronous. That is useful for a Workspace baseline but is not sufficient evidence for a complete canonical mirror import. [Artifacts import](https://developers.cloudflare.com/artifacts/guides/import-repositories/).

### 7.2 Repository export

Every canonical repository export contains:

```text
repository.json
  stable Anyam repository ID
  owning Source Space ID
  object format
  default branch / HEAD
  exported ref allowlist and exact OIDs
  created/exported timestamps
  driver and schema version

source.bundle or bare-repository archive
  every object reachable from exported refs

lfs-manifest.json
  OID, size, media type when known, and object location/digest

integrity.json
  bundle verification, fsck result, ref comparison, object counts
```

Git bundles can carry all objects reachable from selected refs, support full or incremental transfer, and can be verified and cloned without a live server. They do not include the working tree, index, reflogs, hooks, repository configuration, or LFS objects, which is why a Project Export is broader. [Git bundle](https://git-scm.com/docs/git-bundle).

### 7.3 Restore proof

A backup is not accepted until an automated drill:

1. creates an empty repository through a different qualified driver or the generic Git recovery harness;
2. restores the Git bundle or bare repository;
3. restores every reachable LFS object;
4. runs `git bundle verify` where applicable and `git fsck --full` with a versioned exception list for known historical defects;
5. compares the exact ref/OID map, default branch, signed objects, and LFS map;
6. clones the restored public and private endpoints with ordinary Git clients;
7. constructs the same Source Space Snapshot identifiers;
8. records the evidence in the Project Export.

Project metadata, Changes, reviews, policies, Evidence indexes, Releases, and audit records are restored by the broader Project Export contract, not `RepositoryDriver`.

## 8. Git LFS and large objects

### 8.1 Separation from the repository provider

Git LFS stores small pointer files in Git and transfers the referenced content through a separate HTTP API. The v1 pointer includes a SHA-256 OID and byte size. [Git LFS specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).

Anyam therefore defines a separate interface:

```typescript
interface LargeObjectStore {
  authorizeBatch(input: LfsBatchAuthorization): Promise<LfsBatchResponse>;
  put(input: PutLargeObjectInput): Promise<LargeObjectReceipt>;
  get(input: GetLargeObjectInput): Promise<LargeObjectStream>;
  verify(input: VerifyLargeObjectInput): Promise<IntegrityReport>;
  enumerateReachable(input: EnumerateLfsInput): AsyncIterable<LargeObjectRef>;
  export(input: ExportLargeObjectsInput): Promise<LargeObjectExportReceipt>;
  restore(input: RestoreLargeObjectsInput): Promise<RestoreReceipt>;
}
```

The open-source Cloudflare reference uses R2 and the standard [Git LFS Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) with basic HTTP transfers. Provider-native LFS may be adapted only when Anyam can enumerate, verify, export, restore, and authorize objects with the same Source Space boundary.

### 8.2 Security and retention rules

- Authorization follows the owning Source Space and reachable Git refs.
- Content-addressed physical deduplication may exist, but API timing, existence checks, quotas, logs, and errors cannot reveal an object from another Source Space.
- Public LFS objects become anonymously readable only when reachable from a public advertised ref.
- An uploaded object is retained while reachable from a retained Snapshot or Project Export.
- Garbage collection uses a grace period and a complete reachability scan; it never trusts one push event.
- Mirror and Project Export operations include LFS explicitly. GitHub's own mirroring instructions require separate `git lfs fetch --all` and `git lfs push --all`, confirming that `git push --mirror` alone is insufficient. [GitHub repository duplication](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository).
- LFS file locks are a later compatibility capability for binary-heavy Projects, not a prerequisite for source correctness. If implemented, they follow the official locking API and remain Workspace/source policy, not Project Landing authority. [Git LFS locking API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md).

Large build outputs, datasets, model weights, evidence, and release packages that are not part of a working tree are Anyam Artifacts in R2. They should not be forced into Git LFS.

## 9. Bidirectional GitHub and generic Git mirroring

### 9.1 One authority, two directions

Each Repository Mirror has:

```text
remote repository identity
allowed inbound refs
allowed outbound refs
last observed remote OIDs
last exported canonical OIDs
last successful generation
webhook/poll cursor
status and Conflict
```

Inbound flow:

```text
remote webhook or poll
  -> fetch allowed refs into quarantine
  -> compare with last observed/exported OIDs
  -> create or update a proposed Anyam Change
  -> run policy, review, and Evidence
  -> Landing may accept it
```

Outbound flow:

```text
completed Landing
  -> wait for verified canonical Git projection
  -> fetch remote current OIDs
  -> push allowed refs using expected old OIDs
  -> update mirror cursor
```

### 9.2 Divergence rules

| State | Action |
|---|---|
| Remote equals last exported canonical OID | No-op; suppress echo |
| Remote alone advanced from the known base | Create or update proposed Change |
| Anyam alone advanced | Export after Landing |
| Both advanced | Create durable Mirror Conflict; do not overwrite either side |
| Remote ref was force-rewritten or deleted | Import as an explicitly destructive proposal; never silently Land |
| Outbound expected OID no longer matches | Abort push and create Mirror Conflict |

No last-writer-wins synchronization, automatic force push, or "latest timestamp" rule is permitted. Mirror webhooks are hints and reconciliation polls the remote truth. Pull requests, issues, reviews, and comments are synchronized by higher collaboration adapters, not `RepositoryDriver`.

## 10. Events and reconciliation

Repository events wake work; they never prove state.

Handlers must tolerate:

- duplicates;
- missing events;
- out-of-order events;
- delivery after credential revocation;
- retries after the target mutation already succeeded;
- a provider event arriving before its refs are readable;
- a provider event schema or capability version change.

Every event causes a driver `listRefs`/`inspectRepository` reconciliation against the last recorded generation. Polling remains available when native events do not exist.

Cloudflare Artifacts documents repository create/delete/fork/import, push/clone/fetch, and token lifecycle events through Queues, but its public documentation does not establish ordering, exactly-once delivery, or replay. [Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

## 11. Driver implementations and the no-third-party rule

### 11.1 `ArtifactsRepositoryDriver`

Preferred Cloudflare implementation because Artifacts supplies isolated Git repositories, standard Smart HTTP, programmatic create/import/fork, repository-scoped tokens, replication, snapshots, and repository events.

Current documented constraints:

- closed beta;
- 10 GB per repository and 1 TB per account by default;
- 2,000 Git requests per 10 seconds per repository;
- Smart HTTP only; no documented SSH or anonymous read;
- clone/fetch v1 and v2, push v1;
- no `filter` or `include-tag` support;
- repository-wide read/write tokens, not ref-scoped tokens;
- no documented native Git LFS surface;
- native import documented only for public HTTPS sources and can be shallow;
- no documented cross-repository transaction, event replay guarantee, or public SLA.

These facts come from the current [Artifacts overview](https://developers.cloudflare.com/artifacts/), [repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

### 11.2 `GenericGitRepositoryDriver`

Uses an administrator-supplied standard Git Smart HTTP remote and, where available, its management API. It is useful for:

- development before Artifacts access;
- importing from or exporting to GitHub, GitLab, Gitea, Forgejo, or a bare Git server;
- disaster-recovery proof;
- staged customer migration;
- optional external mirrors.

It may lack repository creation, short-lived credentials, events, forks, anonymous-read control, and server-side integrity APIs. Those missing capabilities must be reported, never fabricated.

Crucially, this driver is **not** the fallback that satisfies a Customer-operated Realm. Making GitHub, GitLab, or another forge mandatory would contradict the requirement that the core run in the customer's Cloudflare account without a third-party platform.

### 11.3 `NativeCloudflareRepositoryDriver` contingency

The architecture ticket must qualify the feasibility of an entirely open-source driver running in the customer's Cloudflare account, with a Realm gateway, serialized repository mutation, and durable object storage on Cloudflare primitives.

This is a contingency, not permission to casually reimplement Git. It is triggered when Artifacts is unavailable to customers or fails production qualification. The spike must compare at least:

- a Git Smart HTTP engine in a Cloudflare Container with ephemeral materialization plus durable R2 snapshots and Durable Object serialization;
- a Worker/Wasm Git implementation with Durable Object coordination and R2 pack/object storage;
- any newly available first-party Cloudflare repository primitive.

The spike must prove G2 compatibility, streaming, concurrent fetch/push, bounded memory/disk, crash recovery, public reads, export, restore, costs, and operational behavior before selecting an implementation. Bundling Forgejo/Gitea inside an ephemeral Container is not presumed valid; their persistent filesystem, database, and operational requirements must be demonstrated against the Customer-operated Realm constraints.

### 11.4 Release gate

A release may claim **Customer-operated source hosting** only if:

```text
(ArtifactsRepositoryDriver is generally available in the customer's account
 and passes every mandatory qualification gate)

OR

(NativeCloudflareRepositoryDriver is open source, installable in that account,
 and passes the same gates)
```

In either case, restore into the generic Git recovery harness and complete Project Export remain mandatory. If neither production driver passes, Anyam may continue as an integration preview but must not claim the complete customer-operated product.

## 12. Qualification gates

### RD-01: Protocol matrix

Pass supported Git releases on macOS, Linux, and Windows through clone, fetch, pull, push, tags, notes, deletes, force updates, shallow/deepen, large packfiles, interrupted requests, and capability negotiation. Unsupported optional features must fail clearly.

### RD-02: Object fidelity

Round-trip representative histories containing merge commits, empty commits, unusual paths, submodules, annotated/signed tags, signed commits, notes, executable bits, symbolic links, and owner-declared custom refs. Compare OIDs exactly and run integrity checks.

### RD-03: Authorization isolation

Prove public anonymous read, private denial, cross-Source-Space denial, read-versus-write denial, revoked-token denial, expired-token denial, and that users/agents cannot obtain or use canonical write authority.

### RD-04: Workspace isolation

Run concurrent agents, force pushes, expired Workspace leases, deletion, and handoff. A token from one Workspace must be unusable against every other repository.

### RD-05: Landing and recovery

Inject failure before and after every Landing state transition, provider request, ref CAS, and authoritative Project Revision CAS. Demonstrate idempotent completion, stale-ref repair, no mirror advance before completion, and a usable operator runbook.

### RD-06: Events and reconciliation

Inject duplicate, missing, delayed, reordered, and malformed events. Prove that ref polling/reconciliation converges without duplicate Changes or lost landed state.

### RD-07: Import/export/restore

Import full repositories from two independent servers, export them, restore to another driver, and compare refs/OIDs/LFS objects. Include repositories near provider size and ref-count limits.

### RD-08: LFS and large data

Test Batch API upload/download, range retry, interrupted multipart upload, public/private authorization, cross-space existence probing, mirror migration, retention, GC, and export/restore.

### RD-09: Scale and cost

Measure repository creation/fork time, cold and warm clone, incremental fetch, concurrent fetch/push, 10 GB behavior, many-small-repository behavior, event volume, gateway streaming, provider quotas, and total Cloudflare cost.

### RD-10: Availability and degradation

Exercise provider outage, control-plane outage, queue delay, R2 failure, revoked Cloudflare access, and quota exhaustion. Public reads may degrade independently, but authoritative state cannot split.

### RD-11: Public disclosure

Inspect every public Git response, error, timing class, ref advertisement, archive, LFS response, cache key, event, log, and metric for inaccessible repository names, refs, OIDs, credentials, or Source Space metadata.

### RD-12: Provider migration

Move a live test Project between drivers from a frozen Project Revision, verify it, switch the Realm gateway, then resume Workspace publication and Landing without changing Project, Source Space, Change, or Snapshot identity.

No driver receives production status from documentation alone.

## 13. Product-stage commitments

### Innovation kernel

- Git Smart HTTP clone/fetch/push.
- SHA-1 object fidelity and normal branches/tags.
- canonical repository per Source Space.
- repository per Workspace.
- Landing-only canonical writes.
- short-lived credential helper flow.
- full import/export and integrity verification.
- Realm-hosted anonymous reads for public Source Spaces.
- Artifacts driver behind the contract plus generic recovery harness.

### Credible team product

- Anyam-owned Git LFS Batch API and R2 storage.
- bidirectional GitHub/generic Git mirroring.
- shallow clone qualification and large-repository performance.
- SSH compatibility adapter where deployable without weakening the Realm.
- automated restore drills and provider migration.
- production-qualified Customer-operated driver under the release rule above.

### Later optimization

- partial clone/filter and bundle URI.
- native LFS locks for binary-heavy Projects.
- SHA-256 repository interoperability when the full matrix passes.
- provider-native atomic multi-ref operations, archives, and fork optimization.
- specialized very-large-binary locking workflows.

## 14. Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| One repository containing public and private folders | Git reachability and history do not provide a safe disclosure boundary |
| Public/private branches in one repository | Hidden or protected refs do not remove private objects and metadata from the graph |
| Submodules as the native Project model | They expose coordination and atomicity burden to every developer and still do not provide cross-repository Landing |
| Latest branch head in every repository defines the Project | It can compose a state that never existed or passed policy |
| Store Anyam metadata primarily in Git notes/refs | It leaks implementation state, pollutes mirrors, and cannot safely represent audience projections |
| Let maintainers push canonical `main` | It bypasses Project Revision CAS, cross-space policy, Evidence, and provenance |
| One shared repository with per-agent branches | Repository-wide tokens make it a shared blast radius and ref namespace |
| GitHub as the public source of truth | Contradicts customer operation and turns mirror outages or policy into an Anyam dependency |
| Last-writer-wins bidirectional mirror | Can erase accepted or remote work and makes audit authority ambiguous |
| Provider-native import/export is sufficient | Provider imports may be shallow or partial; Git, LFS, and Project metadata require independent proof |
| Artifacts documentation proves production readiness | It remains closed beta and undocumented behavior is not a guarantee |
| Build a new Git implementation immediately | The priority is the Anyam Project model; a native driver is a gated contingency only if the managed provider cannot qualify |

## 15. Consequences for later tickets

- [Design and qualify the Cloudflare architecture](https://github.com/wms2537/anyam/issues/23) must assign Landing journals, Project Revision CAS, Git projection reconciliation, gateway streaming, staging repositories, and the Native Cloudflare driver contingency to concrete Cloudflare primitives.
- The identity and authorization decision must define Anyam Git credentials, gateway audience checks, provider-token exchange, and Landing service identity separately from MCP and runner tokens.
- The Project Export decision must include the repository and LFS packages defined here and automated cross-driver restore evidence.
- The CLI decision must make `git-credential-anyam` and exact Project View Revision checkout the normal local experience while preserving ordinary `git clone`, `fetch`, and `push` per Source Space.
- The mirroring decision must keep repository refs separate from issue, pull-request, review, and comment synchronization.

## Final answer

Anyam is Git-compatible precisely where Git is strong: immutable commits and trees, normal branches and tags, standard clone/fetch/push, existing IDEs, offline work, mirroring, and portable history.

Anyam is not Git-shaped where Git is insufficient: public/private source composition, stable Changes, capability-scoped Workspaces, cross-space Project Revisions, Evidence, Landing, and safe disclosure.

The boundary is enforced by `RepositoryDriver`, a Realm-owned Git gateway, isolated canonical and Workspace repositories, a separate portable LFS store, complete export/restore, and a launch rule that refuses to disguise an external forge as a self-contained Cloudflare Realm.
