# Bidirectional Repository Mirrors and Recovery

Status: Accepted

Issue: [#54](https://github.com/wms2537/anyam/issues/54)

## Context

Anyam's adoption path is alongside GitHub. A Project may need GitHub for public
discovery, ordinary contributor tooling, or a team's existing workflow while
Anyam owns the canonical Project Revision, Source Space disclosure, Change
review, Evidence, Landing, Releases, and audit lineage.

A plain `git push --mirror` is not sufficient. It cannot express which Source
Space is public, which refs are permitted, whether a remote rewrite is a
proposal or authority, how a remote commit becomes a Change, or how a partial
provider failure resumes without duplicating work. A second multi-primary
authority would also make hybrid public/private Projects unsafe.

## Decision

### A Mirror is per Source Space and maps only permitted refs

Each `Repository Mirror` has one Project, one Source Space, one external
provider/repository identity, a bidirectional direction, explicit local-to-
remote ref mappings, a Disclosure policy, and a durable state. The first
qualification uses a GitHub-shaped adapter; the kernel does not depend on the
GitHub API and can use Codeberg, GitLab, generic Git, or a future adapter
through the same seam.

The Mirror's public state contains only the mapped projection. Unmapped refs,
private Source Space identifiers, restricted paths, and restricted commit
metadata are not forwarded to a public remote. A public Mirror is valid only
for a public Source Space and public Disclosure Projection. A Project with a
private codec or other restricted Source Space therefore uses a separate
public Source Space Mirror; it never filters private objects out of one shared
Git object graph at the provider boundary.

### Outbound projection is verified and never canonical

An outbound sync accepts a caller-supplied canonical state only when it names:

- the Mirror's Source Space;
- an exact Project Revision;
- a matching Disclosure classification;
- the permitted mapped refs; and
- a verification receipt proving the Project Revision is eligible for the
  configured projection.

The coordinator projects only mapped refs and calls the provider with the
remote generation and exact expected refs. The provider can push objects and
refs, but it cannot advance Anyam's canonical Project Revision or decide that a
Release, Change, Evidence, or policy is accepted. A provider result must return
the exact remote refs and a verifiable generation; a mismatch is a degraded
reconciliation state, not success.

The outbound operation carries an Anyam operation origin. A later provider
observation with that origin is treated as the reflected result only when the
mapped refs equal the verified canonical projection. Origin metadata suppresses
loops; it never suppresses a differing or unclassified remote state.

### Inbound remote commits become local Changes

Remote refs are untrusted input. The adapter reports the remote generation,
permitted ref updates, exact commit OIDs, authors, disclosure classification,
and a provider receipt. A fast-forward or newly created permitted ref becomes a
local Change proposal through the Change coordinator, based on the current
canonical Project Revision.

The proposal carries a `Change Origin` containing:

```text
provider/source
Mirror ID
remote repository
remote ref
remote commit OID
remote author
Disclosure classification
provider receipt
```

The Change sink must return a Change with the exact same origin, Project, and
base revision. The mirror never calls canonical Landing. The normal Workspace,
Run, Evidence, review, Integration Cohort, and Landing path remains mandatory
for the inbound proposal.

Remote pull requests, tags, deletions, and rewritten history are input facts,
not local approval. A deletion or force push is never silently converted into
a canonical deletion; it enters explicit reconciliation.

### Sync states are durable and visible

The coordinator records a `Mirror Operation` and `Mirror Checkpoint` for every
idempotent attempt. The Mirror state is one of:

```text
healthy
lagging
divergent
force-pushed
blocked
credential-failed
disabled
```

`lagging` means a remote proposal or outbound provider effect is awaiting local
Landing or retry. `divergent` means both sides changed from the last accepted
boundary. `force-pushed` records a remote rewrite or deletion. Credential and
provider failures name their receipt and recovery action. No state is inferred
from a green webhook or a last-writer-wins timestamp.

### Divergence requires an explicit reconciliation choice

When both canonical and remote refs changed, or when a remote rewrite/deletion
is observed, normal sync is blocked. The caller must choose one explicit
reconciliation:

- `remote-as-proposal`: record attributable inbound Changes and leave canonical
  state unchanged; or
- `canonical-wins`: push the verified canonical projection using the current
  remote generation and record the intentional replacement.

The coordinator never overwrites either side simply because an operation was
retried. Remote generation compare-and-swap, idempotency keys, operation origin,
and durable receipts make retries safe. A pending inbound Change blocks an
outbound overwrite until it is Landed, abandoned, or explicitly reconciled.

### Checkpoints resume without duplicating Changes

Every sync starts at a preflight checkpoint and advances through remote
inspection, inbound proposal creation, outbound application, and completion.
If a provider, credential, or Change sink fails, the checkpoint records the
remote generation, permitted refs, completed inbound Change IDs, and recovery
action. Resuming the checkpoint reuses the stable `(Mirror, remote ref, commit
OID)` proposal identity, so a partially created inbound Change is not duplicated.

The operation and checkpoint IDs remain append-only. Project Export may carry
the current Mirror records and Mirror Operation IDs alongside Project Revision,
Change, Release, Evidence, and audit lineage. Restore does not activate a
remote credential, promote a Target, or make GitHub canonical.

## Consequences

- Anyam can be adopted alongside GitHub and later become canonical without
  changing the Project or Change model.
- Public contributors can use a normal GitHub repository without learning
  private Source Space names, refs, or history.
- Remote commits receive the same review, Evidence, Integration Cohort, and
  Landing protections as local work.
- Mirror outages and rewrites are visible, resumable states rather than silent
  data loss or authority changes.
- Provider adapters remain replaceable, while the kernel owns disclosure,
  canonicality, idempotency, lineage, and reconciliation policy.
- A local scripted GitHub-shaped adapter qualifies the contract; it is not a
  claim that live GitHub App/webhook operations are production-qualified.

## Rejected alternatives

- **Two-way last-writer-wins:** creates a second authority and can overwrite
  reviewed canonical state or private/public boundaries.
- **Push every canonical repository ref:** leaks private branches, tags, or
  review refs and ignores the Source Space projection.
- **Treat a remote pull request as local approval:** external reviews do not
  satisfy Anyam's local Evidence, policy, or separation-of-duty contract.
- **Create a Change from only a remote branch name:** loses immutable commit,
  author, provider, and Disclosure provenance.
- **Suppress every provider event from the last operation:** hides a loop that
  changed refs differently; origin suppression is valid only for an exact
  canonical projection match.
- **Retry by rebuilding or resetting the remote:** destroys the recovery
  boundary and makes a provider-side partial write indistinguishable from a
  clean operation.

## Qualification and implementation boundaries

The first qualification covers:

1. verified public outbound projection with private-ref exclusion;
2. inbound fast-forward proposal with exact Change Origin;
3. loop prevention and idempotent retry;
4. visible force-push and divergence with explicit reconciliation;
5. credential failure and checkpoint resume;
6. public Disclosure rejection for restricted canonical or remote state; and
7. Project Export retention of Mirror and operation lineage.

The fixture uses a scripted GitHub-shaped remote. Live GitHub App credentials,
webhooks, rate limits, branch protections, pull-request ingestion, and provider
recovery remain adapter qualification work; they are not silently represented
as complete by the in-memory contract test.
