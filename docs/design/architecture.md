# Anyam architecture

Anyam separates source objects, semantic authority, execution, and provider
effects. That separation lets a Project use familiar Git while keeping a
production action reviewable and reversible.

## The Project path

```text
Git repository
    ↓
Source Space and Project View
    ↓
Workspace and Change Revision
    ↓
Run and Evidence
    ↓
Landing to a canonical Project Revision
    ↓
Build and immutable Artifact
    ↓
Release
    ↓
Target and Promotion
    ↓
Health, rollback, and reconciliation
```

Each arrow is an authority transition. A successful Git push does not imply a
Landing. A successful build does not imply a Release. A provider HTTP response
does not imply healthy production.

## Source and disclosure

The Project is the managed unit. A Source Space owns one source lineage,
visibility policy, and processing policy. A Project View composes the Source
Spaces that the current Actor may see.

The public/private video-player example models two Source Spaces in one local
checkout. Its build transpiles one public entry point and rejects two private
codec marker strings. It does not demonstrate separate Git histories,
adversarial import handling, or general private-content exclusion. Production
disclosure requires separate public Git lineage and authority enforcement.

## Collaboration and authority

The Realm coordinator serializes semantic mutations for a Project. A Change has
a stable identity across revisions and rebases. A Workspace is bound to an
exact Project Revision and Source Space set.

The policy evaluator checks the same chain for a person, an agent, or a service:

```text
Principal → Actor → Session → Task → Capability Grant → resource operation
```

The grant names the Project, Workspace, Change, Source Spaces, tools, network,
secret uses, effects, and expiry. Explicit denial wins.

## Execution and Evidence

A declared Action runs against immutable inputs. The trusted Runner records the
terminal Run, Evidence, and Artifact together after validating the signed result
and the exact Attempt binding.

The untrusted process never receives canonical write authority. Output ingestion
rejects source overlap, special files, symlink escapes, and oversized objects.
The authority ledger stores digests and observable events, not credentials or
private model reasoning.

## Delivery

A Release closes over the exact Project Revision, Artifact digests, configuration
and dependency digests, migration plan, Target profile, and required Evidence.
The Promotion service resolves provider identities from the authoritative Target
record.

Preview strategy is explicit. A simple Worker may use a version URL. An
application with Durable Objects or stateful bindings uses an isolated Target
with isolated data resources. Anyam does not silently skip preview when a
provider cannot create one.

Health checks bind to the expected Release identity. A failed health check may
roll back application code only when the migration plan permits that action.
Otherwise the Target remains degraded until a human completes the data recovery
step.

## Cloudflare-first mapping

The customer-operated Realm uses Cloudflare primitives behind replaceable
interfaces:

| Responsibility | Default implementation |
| --- | --- |
| Request routing and identity edge | Workers |
| Serialized Project authority | Durable Objects and SQLite-backed state |
| Searchable catalogue | D1 |
| Git and large objects | Repository Driver and R2-backed storage |
| Delivery events | Queues |
| Durable workflows | Workflows |
| Linux execution | Sandbox or Containers |
| Evidence and build outputs | Content-addressed R2 objects |
| Provider deployment | Target adapter and customer-owned executor |

The adapter boundary matters. A customer can replace a Repository Driver,
Runner, Artifact store, or Target without changing the Project and Change
contracts.

## Recovery and export

Exports contain repositories, Project and Change lineage, review and policy
records, Evidence metadata, Artifact indexes, Releases, Audit Events, and schema
versions. Large objects retain a digest and a customer-controlled location.

Recovery is a separate ceremony. A signed export, an integrity checkpoint,
quarantine reconciliation, and owner activation are required before restored
authority becomes active. A provider snapshot is evidence for reconciliation. It
is not the Anyam ledger.

## What this architecture does not claim

- A Git provider is not the whole Project.
- A coding agent is not the authority that approves its own work.
- A provider fixture is not a production SLO.
- A public projection is not promised to be functionally complete.
- A Cloudflare deployment is not qualified until the exact version, bindings,
  routes, health result, and rollback receipt are read back.

Read the [platform blueprint](../blueprint/anyam-platform-blueprint.md) for the
complete contract and the [Product Constitution](../product/constitution.md) for
the rules that make this decomposition non-negotiable.
