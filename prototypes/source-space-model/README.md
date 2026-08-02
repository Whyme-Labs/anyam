# PROTOTYPE — Source Space state model

This throwaway logic prototype asks one question:

> Can an immutable manifest across hard-isolated Git object graphs provide one coherent Project state while every Actor receives a non-leaking Project View, including when public and private source change together?

The repository has no application runtime yet, so this prototype uses only the Python 3 standard library. It does not select Anyam's implementation language.

Run it with:

```bash
python3 prototypes/source-space-model/tui.py
```

The terminal lets you switch between a public visitor, internal developer, external agent, and enterprise agent; request community, commercial, and security profiles; land public-only, private-only, and cross-space changes; and inject metadata or mount leaks. The full internal state and the selected Actor's safe projection render after every action.

## Concrete Project

The prototype models a hybrid-source video player:

```text
Project: Loom Player

Source Spaces
├── player              public, Apache-2.0
├── codec-contracts     public, Apache-2.0
├── commercial-codec    private, proprietary
└── compatibility-lab   restricted, proprietary test material

Project Profiles
├── community           player + codec-contracts
├── commercial          player + codec-contracts + commercial-codec
└── security            all four Source Spaces
```

The public player depends on the public codec contract. The private codec implements that contract. The restricted compatibility suite may test all of them while disclosing only policy-approved Evidence later. Public source does not contain a private repository URL, object identifier, path, or gitlink.

The community profile is deliberately marked as having no asserted build result. Anyam validates disclosure integrity, not the philosophical or functional claim that a profile “works.” Owners and Verifiers may declare and test build expectations separately.

## Formal model

Let:

```text
P  = Project
S  = independently protected Source Space
σ  = immutable Snapshot belonging to exactly one S
R  = immutable Project Revision
A  = Actor operating through a Session
C  = Capability Grant and Source Space policy effective for A
M  = model-processing policy, when A delegates source to an agent/model
F  = owner-declared Project Profile
V  = Project View
```

A Project Revision is the authoritative internal manifest:

```text
R = hash(
  project identity,
  parent Project Revision,
  sorted(Source Space identity → Snapshot identity),
  manifest schema version
)
```

The mapping includes exact Snapshots, not branches or “latest” pointers. A Snapshot may already exist before Landing, but it is not part of canonical Project state until a Project Revision referring to it becomes canonical.

A Project View is a capability-safe composition:

```text
eligible(A, S) =
  may_discover(A, S)
  ∧ may_read(A, S)
  ∧ model_allowed(A.model, S) when A is an agent

spaces(V) = spaces(F) ∩ { S | eligible(A, S) }
```

In practice, Anyam does not silently return a partial named profile. A profile is discoverable to an Actor only when the Actor may discover every Source Space selected by that profile. Requesting an inaccessible or nonexistent profile returns the same `not_found` result.

The Project View revision identifier is derived only from disclosed inputs:

```text
view_revision(V) = hash(
  Project View schema version,
  disclosed profile identity and version,
  sorted(disclosed mount → disclosed Source Space handle → Snapshot identity)
)
```

It does **not** hash, wrap, truncate, or expose the full Project Revision identifier. Therefore:

```text
project(public state A + private state X)
project(public state A + private state Y)
```

produce the same public Project View revision. Projection is intentionally non-injective: several internal states may have one identical public representation.

## Normative invariants

### 1. Hard object-graph isolation

Every Snapshot belongs to one Source Space. Objects reachable from a disclosed Git commit must be authorized in that same Source Space. A public commit cannot have a private parent, gitlink, tree entry, note, alternate-object reference, or pack negotiation path.

Physical storage may deduplicate bytes internally only if authorization, enumeration, timing, error behavior, and object retrieval remain Source-Space scoped. A global content hash is not a global read capability.

### 2. Omission, not denial

An inaccessible Source Space contributes no name, identifier, count, mount, Snapshot, commit message, author, timestamp, Change title, activity event, search term, notification, or policy error to a Project View. It is omitted rather than represented by a placeholder or `403`.

### 3. View identifiers contain no hidden state

The full Project Revision identifier is not exposed through a restricted Project View. View identifiers, ETags, cache keys, URLs, pagination cursors, and signatures are derived from disclosed inputs only.

### 4. Exact composition

A Project View resolves every included Source Space to the exact Snapshot named by one Project Revision. It never combines “latest” from several repositories. Local materialization verifies every Snapshot digest against the manifest.

### 5. Canonical atomicity lives at the Project manifest

Landing makes one complete Project Revision canonical with compare-and-swap against its declared base. All referenced Snapshots must already be durable and policy-approved. Failure before the canonical pointer moves leaves unreachable candidate Snapshots; failure after it moves leaves repairable derived Git refs or indexes, never a second canonical state.

Standard Git refs are compatibility projections of canonical Project state. A lone Git client can observe and manipulate one Source Space, but only Anyam can assert an atomic transition spanning several Source Spaces.

### 6. Profiles select; capabilities authorize

A Project Profile cannot grant access. It selects from Source Spaces already authorized for the Actor and, for agents, permitted for the model/provider. Possessing human read authority does not automatically authorize sending that source to a model.

### 7. Mounts are explicit and collision-free

Each Project Profile declares where included Source Spaces materialize. Two spaces cannot claim the same path or ancestor/descendant mount in one View. There is no implicit overlay or “last writer wins.” Moving a path between Source Spaces is an explicit cross-space Change.

### 8. Disclosure closure, not functional completeness

A disclosed source graph must not accidentally reference inaccessible source metadata. Cross-profile dependencies must use an intentionally disclosed contract, package, service, Artifact, or owner-declared external dependency.

Anyam may run owner-declared builds and warn about undeclared dependencies, but it does not reject a Project Profile merely because no universal test proves the result useful, complete, or runnable.

### 9. Activity projection follows source projection

A private-only Landing does not create a public activity stub or advance the public View revision. A cross-space Landing creates one internal Change but each audience receives only its allowed Disclosure Projection. Public timing must not reveal a hidden companion revision beyond intentionally published activity.

### 10. Publication is a new less-restricted lineage

Making private source public is a Publication Change. It creates a safe public Snapshot and history under explicit disclosure review. Changing an access flag on the private object graph is invalid, and making previously public source private cannot retract disclosed history.

### 11. Revocation is prospective

Revocation prevents new discovery, reads, fetches, tokens, Runs, and context construction. It cannot erase source already cloned or remembered by an Actor. Policies and UI must not imply retroactive secrecy.

### 12. Git remains truthful

Every public Git repository is a genuine cloneable lineage containing only its Source Space. Anyam must not advertise sparse checkout, partial clone, hidden refs, or server-side `403` responses as public/private separation.

## Projection algorithm

For an authenticated request or anonymous public request:

1. Resolve the Realm and public Project handle without enumerating undisclosed Projects.
2. Resolve the requested Project Profile through the Actor's discoverable-profile index.
3. If the profile is absent from that index, return the same `not_found` response used for a nonexistent profile.
4. Evaluate read authority and, for agents, model-processing authority for every selected Source Space.
5. Load one canonical Project Revision internally.
6. Select exact Snapshots for the profile's included Source Spaces.
7. Validate mount uniqueness and disclosure closure.
8. Build a manifest containing only disclosed handles, mounts, Snapshots, public dependencies, and permitted activity.
9. Derive the Project View revision, ETag, cache key, and signature from that disclosed manifest.
10. Materialize or fetch each Source Space with a separate audience- and repository-bound credential where authentication is required.

Any authorization failure after step 3 is logged internally with full context, but the external response still follows the disclosure policy.

## Landing examples

### Public-only Change

```text
Before: player@p1 + contracts@a1 + codec@c1 + tests@t1
After:  player@p2 + contracts@a1 + codec@c1 + tests@t1
```

The full Project Revision and the community View revision both advance.

### Private-only Change

```text
Before: player@p2 + contracts@a1 + codec@c1 + tests@t1
After:  player@p2 + contracts@a1 + codec@c2 + tests@t1
```

The full Project Revision advances. The community View manifest, identifier, Git refs, caches, activity, and timestamps remain unchanged.

### Atomic cross-space Change

```text
Before: player@p2 + contracts@a1 + codec@c2 + tests@t1
After:  player@p3 + contracts@a2 + codec@c3 + tests@t2
```

One Change Revision proposes all four exact Snapshots. Landing accepts the complete manifest or none of it. The public Disclosure Projection may say “extend the codec contract” and expose only `player@p3` and `contracts@a2`; it does not reveal that proprietary implementation and restricted tests changed in the same operation.

## Required failure behavior

| Failure | Required behavior |
|---|---|
| Public commit reaches a private Git object | Reject the candidate before publication or Landing. |
| Profile requests a hidden Source Space | Omit the profile from discovery; explicit request returns `not_found`. |
| Two Source Spaces mount to overlapping paths | Reject the profile as ambiguous. |
| Public manifest names a hidden repository, path, Snapshot, or private package unintentionally | Reject the projection under disclosure closure. |
| Public profile has no successful declared build | Allow the profile; show the owner-declared build/Evidence state without claiming it “works.” |
| Private-only Change lands | Do not advance or emit observable public state. |
| One Snapshot upload succeeds and another fails | Do not advance the canonical Project Revision; garbage-collect unreachable candidates later. |
| Canonical manifest advances but a derived Git ref/index update fails | Canonical state remains the manifest; repair the projection idempotently and surface an operator incident. |
| Actor loses access after cloning | Revoke future authority; do not claim the prior clone is erased. |
| Private source becomes public | Require a Publication Change that creates reviewed public history. |
| Public source later becomes private | Stop future publication if desired, but retain the already disclosed lineage and warn that secrecy cannot be restored. |
| Agent's model provider is prohibited for one selected space | The profile is unavailable to that agent session even if its human Principal can read the space. |

## Decisions this prototype is asking the owner to validate

1. A full Project Revision is internal authority; restricted audiences receive a separately derived Project View revision, not a redacted full manifest.
2. A named Project Profile is all-or-nothing for discovery. Anyam does not silently remove inaccessible Source Spaces from a requested profile.
3. Mount collisions and cross-space Git reachability are rejected; no overlay semantics exist.
4. Disclosure closure is enforced, but buildability or functional completeness is owner-declared and Evidence-backed rather than universally required.
5. Private-only Landings cause no public revision or activity change.
6. Cross-space atomicity belongs to Anyam's canonical manifest; per-repository Git refs are derived compatibility state.
7. Revocation cannot retract cloned source, and Publication cannot be reversed into secrecy.

## Deliberately deferred

This prototype does not decide:

- the concrete RepositoryDriver transaction protocol;
- Git ref namespaces or mirror conflict handling;
- Workspace filesystem layout and local operation log;
- Change Revision wire format or Landing recovery implementation;
- Publication review UX or history-curation policy;
- sealed Evidence disclosure;
- database tables, Durable Object layout, APIs, or event schemas.

Those belong to the subsequent source, Git, Workspace, Publication, Change, security, and service-contract tickets.
