# Cursor's Git at any scale and the Anyam boundary

**Research date:** 20 August 2026  
**Decision status:** Input to [#182: Make Anyam credible for a real team](https://github.com/Whyme-Labs/anyam/issues/182)  
**Evidence policy:** Cursor's article and research posts are first-party statements about Cursor's design and experiments. They are not independent benchmarks of Cursor, Git, Cloudflare, or Anyam. Cloudflare documentation describes a provider contract, not an Anyam qualification.

## Executive decision

Cursor's work strengthens the case for separating Anyam's control plane from its
Git data plane. Anyam should not build a new Git storage engine as part of #182.
It should keep `RepositoryDriver` as the provider boundary and focus on the
parts Cursor's storage system does not claim to provide:

- Source Space disclosure and public/private composition;
- delegated authority for humans, agents, Runs, and tools;
- stable Change and Change Revision identity;
- Evidence, policy, and trusted Landing;
- immutable Releases and Target promotion;
- export, restore, and provider reconciliation.

The practical position is:

> Cursor is optimizing the storage and serving of Git activity. Anyam must
> govern how work from any repository provider becomes a verified Project
> Revision and Release.

This does not close #182. Cursor's article provides no receipt for a real Anyam
team using the canonical path, no export and restore result for an Anyam Realm,
and no evidence for Anyam's disclosure, authority, or promotion contracts.

## What Cursor actually reports

### Git hosting becomes a storage and consistency problem

Cursor describes Git hosting at scale as difficult because packfiles are the
unit used for Git storage and transfer. The article says that every push adds
packfile work and that reads become harder as packfiles accumulate. It also
describes the operational cost of keeping replicas consistent and repairing
repository copies. These are Cursor's engineering observations, not a claim
that every Git provider has the same implementation.

Source: [Cursor, "Git at any scale"](https://cursor.com/blog/git-at-any-scale),
sections "What's hard about Git?" and "Spokes and Consistency".

### Continuity uses a write-ahead log as the source of Git storage truth

Cursor says that Continuity stores each push in a write-ahead log in
S3-compatible object storage. It writes the packfile to local NVMe storage and
uploads the WAL entry at the same time. A push becomes visible only after
Continuity records a reference transaction that points to the WAL entry. The
article says this makes pushes linearizable and that it does not acknowledge a
push until the WAL has persisted it.

Cursor also says that the local copy remains a normal Git repository. A primary
performs compaction, while replicas follow WAL and download compacted packs
instead of repacking independently. The routing state is limited to a
repository ID and the current healthy node set; a missing local copy can be
materialized again from the WAL.

These statements describe Continuity's design. They do not establish that
Continuity is open source, available as a standalone product, portable to
Cloudflare, or compatible with Anyam's Project Export contract.

Source: [Cursor, "Git at any scale"](https://cursor.com/blog/git-at-any-scale),
sections "Continuity", "Replication", "Compaction", and "WAL as truth".

### Cursor reports high-throughput measurements

The article reports synthetic tests with up to 100 replicas and linear read
scaling. It reports up to 120 pushes per second with S3 Standard and more than
300 pushes per second with S3 Express One Zone. The article also says that
pushes are persisted before acknowledgement and that clones are fully
consistent.

The receipt for these numbers is Cursor's article and its embedded graphs. The
article does not publish the complete workload, repository history, client
shape, region, cost, confidence interval, or independent reproduction script.
Anyam must record these as **Cursor-reported provider facts**, not as Anyam
limits, SLOs, or capacity assumptions.

Source: [Cursor, "Git at any scale"](https://cursor.com/blog/git-at-any-scale),
sections "Scale" and "WAL as truth".

### Origin is a reliability and scale direction, not an Anyam contract

Cursor presents Origin as the platform built from its experience operating
Git for agent-heavy work. The article names more code, more pull requests, and
more CI runs as consequences of agent use. It describes Origin as a path to
more reliability, performance, and scale, with migration as a design concern.

The article does not specify an Origin API, a public export format, customer
hosting model, source-visibility model, agent-capability model, or
cross-repository Project Revision contract. Anyam must not infer those
properties from the name "Origin" or from Continuity's storage design.

Source: [Cursor, "Git at any scale"](https://cursor.com/blog/git-at-any-scale),
section "Origin".

## The second Cursor result is coordination, not only storage

Cursor's multi-agent research describes a shared coordination file and locks
that failed under concurrent use. Cursor reports that 20 agents degraded to
the effective throughput of two or three because they waited on locks. It then
reports better results from optimistic concurrency and from a planner/worker
pipeline in which planners create work and workers focus on assigned tasks.

Cursor's later swarm post reports a new VCS reaching roughly 1,000 commits per
second in its experiment, compared with roughly 1,000 commits per hour in its
earlier Git-based swarm. The same post says that split-brain design,
contention, merge conflicts, megafiles, and design ossification remained
failure modes. It describes compile-checked design references, a neutral
conflict agent, and a mechanism that flags bloated files.

These are valuable observations about a controlled Cursor workload. They do not
show that one shared branch is safe for every team, project, Source Space, or
regulated workflow. They do show that Anyam must model coordination state as
first-class data and must not use one shared JSON file or one coarse lock as
the team protocol.

Sources:

- [Cursor, "Scaling long-running autonomous coding"](https://cursor.com/blog/scaling-agents)
- [Cursor, "Agent swarms and the new model economics"](https://prod.cursor.com/blog/agent-swarm-model-economics)
- [Anyam's Git compatibility and Repository Driver decision](2026-08-02-git-compatibility-and-repository-drivers.md)

## The data-plane and control-plane split

Anyam should make the following split explicit:

```text
Git data plane
  pack negotiation, object transfer, refs, clone, fetch, and push

Anyam control plane
  identity, Source Spaces, Workspaces, Changes, policy, Landing, and audit

Anyam evidence plane
  Runs, Verifiers, Evidence, provenance, and disclosure decisions

Anyam delivery plane
  Artifacts, Releases, Targets, Promotion, health, and rollback
```

The Git data plane must have a direct fast path. Anyam evaluates the principal,
actor, client, task, Project, Source Space, and Workspace before it issues a
short-lived provider credential. The Git client then transfers objects through
the `RepositoryDriver`. Anyam observes the resulting operation through a
provider event or reconciliation read. Anyam must not execute a Durable Object
round trip for every Git object packet.

The fast path does not weaken authority. It moves authority checks to the
credential and ref boundary, where the result can be audited and revoked.

## What this changes in Anyam's design

### Keep provider mechanics behind `RepositoryDriver`

Cursor's article is a warning about the cost of owning Git storage, replica
repair, packfile compaction, and hot serving. The current Anyam architecture
already puts these concerns behind `RepositoryDriver`. Keep that boundary.

Cloudflare Artifacts remains a plausible customer-operated provider because its
documentation describes Git-compatible versioned storage, programmatic
repositories, and separate repositories for agents, users, branches, or tasks.
Artifacts also documents ArtifactFS for a fast working-tree start: a blobless
clone mounts through FUSE and hydrates file contents on demand. Cloudflare
currently labels Artifacts closed beta, so these facts do not replace Anyam's
provider qualification.

Sources:

- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Cloudflare ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)
- [Anyam's Artifacts provider qualification](2026-08-12-artifacts-provider-qualification.md)

### Treat Workspace throughput as fan-out, not canonical contention

Anyam should not require every agent checkpoint to compete on one canonical
`main` ref. The preferred shape is:

```text
Agent A -> Workspace A
Agent B -> Workspace B
Agent C -> Workspace C
        -> Change Revisions
        -> Integration Cohort
        -> verified Landing
        -> canonical Project Revision
```

Workspace commits may be incomplete or failing. A Change Revision records the
exact snapshot and attribution. A Landable Change Revision has the required
Evidence and approvals. A Release has the Evidence required by its Target.
Only the Landing service advances the canonical Project Revision.

This design avoids making a raw commit rate the product's main scale target. It
also keeps the authority funnel explicit when many agents produce work at
machine speed.

### Measure the complete funnel

Anyam's useful measures are user-visible and receipt-backed:

| Area | Observation |
| --- | --- |
| Workspace | Time to a usable working tree, clone or mount path, and recovery after setup failure |
| Git | Clone, fetch, push, ref inspection, and provider reconciliation |
| Coordination | Active Workspaces, stale-base rate, duplicate work, and conflict classes |
| Evidence | Time from Change Revision to required Evidence and terminal result |
| Landing | Prepared, committed, reconciled, and verified Project Revision transitions |
| Delivery | Release creation, Target health, rollback, and no-rebuild guarantees |
| Recovery | Export, restore, identity comparison, and resume from a provider checkpoint |
| Security | Unauthorized Source Space reads, canonical writes, and credential revocation |
| Economics | Provider-observed operations and cost attributed to the same logical work |

Raw pushes per second remain a provider qualification input. They are not an
Anyam promise. The primary team question is whether a named team can complete
real Changes through the whole path and recover when a provider or Runner
fails.

### Make the agent environment a product

Cursor's sandbox and cloud-environment posts report that agents need a usable
development environment, bounded network access, scoped Git remotes, secret
scanning, secret redaction, and a small CLI that hides fragile setup commands.
Cursor also reports that it uses MCP for environment diagnosis and a recurring
automation that opens fixes for unhealthy environments.

Anyam should carry the same requirement into #182:

- the Workspace must expose the same declared tools a developer needs;
- the CLI must provide obvious commands and visible recovery actions;
- sandbox failures must name the denied capability and the requested effect;
- agents must use brokered Secret Use, not read secret values;
- the agent session, tool, model, network, and source view must remain in the
  Evidence and audit record;
- a failed or stale environment must be recoverable without granting broader
  authority.

Sources:

- [Cursor, "Implementing a secure sandbox for local agents"](https://cursor.com/blog/agent-sandboxing)
- [Cursor, "How we set up our cloud agent environment"](https://cursor.com/blog/cloud-agent-environment)
- [Anyam's execution and Runner plane](2026-08-02-execution-and-runner-plane.md)

## Impact on #182

### What this research supports

The Cursor work supports these existing Anyam decisions:

1. Git remains the compatibility protocol, while Project, Change, Evidence,
   Release, and Target remain Anyam objects.
2. Repository storage stays behind `RepositoryDriver`.
3. Workspaces are isolated by task and can scale independently.
4. Coordination state belongs in the Project and Change authorities, not in a
   shared coordination file.
5. A direct Git path and a semantic MCP path are both required.
6. Agent sandboxes and error messages are part of the developer experience,
   not optional security decoration.
7. Export and restore must work without the provider becoming canonical.

### What remains open before #182 can close

This research does not provide any of the following receipts:

- a named human team using Anyam as the canonical write authority;
- real Changes completed by more than one agent product;
- a measured Workspace and Git workload through the customer-operated Realm;
- a high-concurrency workload with isolated Workspaces and serialized Landing;
- an export and restore into a clean Realm with identity and disclosure checks;
- a provider interruption followed by visible reconciliation and resume;
- a complete agent sandbox qualification for every supported Runner profile.

Therefore #182 remains open. The Cursor article should update the adoption
qualification, not replace it.

## Recommended next qualification slice

After the named-team adoption path starts, run one bounded scaling cohort that
uses the real CLI, Git credential helper, MCP path, RepositoryDriver, Project
Coordinator, Runner, Evidence, and Target path. Keep the cohort separate from
the provider's own throughput claims.

The cohort should compare these two shapes:

```text
many isolated Workspace repositories -> one verified Landing funnel
one shared repository or branch       -> one verified Landing funnel
```

Record the complete receipts, including stale revisions, duplicate events,
provider retries, cleanup, and disclosure decisions. Do not choose a permanent
concurrency budget until the healthy workload and failure envelope have been
measured. If a healthy team touches the tripwire, remeasure instead of hiding
the failure behind a silent queue or lock.

This is a qualification task for the team gate. It is not permission to build
Continuity or to make Cursor Origin a first-party dependency.

## Sources

### Cursor

- [Git at any scale](https://cursor.com/blog/git-at-any-scale)
- [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)
- [Agent swarms and the new model economics](https://prod.cursor.com/blog/agent-swarm-model-economics)
- [Implementing a secure sandbox for local agents](https://cursor.com/blog/agent-sandboxing)
- [How we set up our cloud agent environment](https://cursor.com/blog/cloud-agent-environment)
- [Compile 2026: Origin announcement](https://cursor.com/compile)

### Cloudflare

- [Artifacts](https://developers.cloudflare.com/artifacts/)
- [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)
- [Artifacts provider qualification](2026-08-12-artifacts-provider-qualification.md)

### Anyam

- [Git compatibility and Repository Drivers](2026-08-02-git-compatibility-and-repository-drivers.md)
- [Team adoption reliability and cost receipts](2026-08-14-team-adoption-reliability-cost-receipts.md)
- [Execution and Runner plane](2026-08-02-execution-and-runner-plane.md)
- [Bidirectional Repository Mirrors and Recovery](../adr/0036-bidirectional-repository-mirrors-and-recovery.md)
- [Cloudflare-first architecture and provider boundaries](../adr/0015-cloudflare-first-architecture-and-provider-boundaries.md)
