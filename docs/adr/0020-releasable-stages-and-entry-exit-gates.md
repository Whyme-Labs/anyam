# Releasable stages and entry/exit gates

Status: Accepted

## Context

Anyam has a deliberately broad product thesis: a fully open-source,
Git-compatible project SCM for humans and coding agents, with independently
governed Source Spaces, verified Changes, general Artifacts and Releases, and
customer-operated Cloudflare deployment. The breadth creates a landmine if the
project attempts to ship every hosting mode, runner, registry, mirror, and
enterprise feature at once.

Issue [#28](https://github.com/wms2537/anyam/issues/28) asked for a releasable
sequence that preserves the long-term model while identifying the smallest
end-to-end product, stage gates, omissions, migration paths, and risk
retirement. The prior decisions establish the domain model, provider
boundaries, auth/capability policy, execution contract, portability model,
hosting modes, and bootstrap/recovery behavior. This decision turns those
contracts into a delivery sequence.

The sequence is intentionally capability-based rather than calendar-based.
Calendar dates and capacity limits are not commitments until they have a
receipt from a working implementation. A healthy workload must not be rejected
by an invented budget; a measured limit must be visible to the developer and
agent that encounters it.

## Decision

Anyam grows through four releasable stages:

```text
K0 kernel
  → private alpha
  → public beta
  → enterprise and ecosystem expansion
```

Each stage must leave the previous stage working. A later stage adds adapters,
policy, tenancy, or distribution; it does not replace the canonical Project,
Source Space, Change, Evidence, Release, Target, or Capability contracts.

### K0 — open-source kernel

K0 is the first installable, open-source product and the minimum contract that
the alpha can exercise. It is TypeScript-first and terminal-first.

K0 includes:

- Project, Source Space, Project View, Snapshot, Project Revision, Workspace,
  Intent, Change, Change Revision, Run, Evidence, Artifact, Release, Target,
  Promotion, Capability Grant, and Audit Event contracts.
- Standard Git vocabulary and HTTPS compatibility for clone, fetch, push,
  commit, branch, tag, diff, and merge where those are the actual Git
  operations. Anyam-specific terms remain for semantics that cross Git
  repositories or govern disclosure, policy, evidence, or promotion.
- Public and private Source Spaces composed into an authorized Project View.
  K0 enforces disclosure integrity; it does not assert that a declared public
  Profile is functionally complete or universally buildable.
- Stable Changes with immutable Change Revisions, Workspaces, compare-and-swap
  Landing, typed durable Conflicts, and no direct canonical writes from
  developer tools or agents.
- A versioned TypeScript Project Manifest and portable Action/Verifier/Target
  contracts. Conventional project detection proposes configuration; explicit
  configuration remains available for advanced projects.
- `anyam` CLI, REST/SDK contract, local stdio MCP broker, remote-MCP contract,
  `git-credential-anyam`, and a shared agent skill/instruction surface.
- Local integration with Codex, Claude Code, and Cursor through
  `anyam agent setup`; the broker keeps refresh credentials outside model
  context and grants only the active task capability.
- Typed Evidence, provenance, policy explanations, Project Export, and the
  RepositoryDriver boundary. K0 may qualify one repository driver, but the
  domain model must not leak provider-specific authority or URLs.
- `npm create anyam`, `npx create-anyam`, `pnpm create anyam`, and
  `bun create anyam` as package-manager entry points. The generated projects
  are package-manager-neutral TypeScript projects.
- Two scaffold templates only: a Cloudflare Worker project and a generic
  TypeScript CLI/library project.
- Local-only scaffolding by default. Cloud connection, Realm selection,
  authentication, and resource provisioning begin only through an explicit
  `anyam connect` or equivalent confirmation flow.
- Familiar commands such as `anyam init`, `anyam clone`, `anyam status`,
  `anyam diff`, `anyam commit`, `anyam push`, `anyam pull`, `anyam change`,
  `anyam check`, and `anyam ship`, with Anyam semantics exposed alongside
  rather than instead of Git.

K0 deliberately does not claim multi-tenant SaaS scale, external runner
  coverage, GitHub synchronization, full GitHub Actions compatibility, or
  enterprise identity. Those are later qualification surfaces.

### Private alpha — prove the thesis end to end

The private alpha is a narrow, customer-operated qualification of the kernel.
Its authoritative deployment is an Anyam Realm installed in the customer's
Cloudflare account. Hosted SaaS may be used as a convenience path during
development, but the alpha cannot require an Anyam-operated service or a
third-party forge.

The alpha includes:

- One Realm per installation and one initial customer-operated deployment.
- Realm-owned passkeys plus one OIDC provider for browser and CLI identity.
- Realm-owned capability policy, audit, recovery, and owner enrollment.
- The Worker reference Project: preview, Worker Artifact/Release, Cloudflare
  Target Promotion, health verification, and rollback to an earlier Release.
- The CLI/library reference Project: a non-web Build, downloadable Artifact,
  Release, and generic release-asset Target. It must not require a live web
  runtime.
- One hybrid-source reference Project with a public Source Space and a private
  Source Space, such as a public video player with a private codec. Anyam
  protects the boundary and public projection; the owner decides whether the
  public Profile is useful or functionally complete.
- Both new-project and existing-code onboarding. Local-directory and generic
  Git URL imports are staged, quarantined, idempotent, digest-verified, and
  resumable from visible Recovery Checkpoints.
- A minimal web companion for Project overview, Change review, checks and
  Evidence, preview, Ship, Promotion state, and rollback. The CLI remains the
  primary authoring and local-development interface.
- Managed Cloudflare execution for ordinary Linux actions, with no claim that
  every platform-specific workload runs in the alpha.
- Hosted remote agent execution as bounded alpha infrastructure, while local
  Codex/Claude/Cursor integration remains the portable developer path.

Private-alpha exit is correctness-first. It requires the two reference
projects, hybrid Source Space disclosure, scaffold/connect flow, agent task
isolation, import recovery, Evidence freshness, guarded Landing, Release and
Promotion provenance, and rollback behavior to work end to end. It does not
use arbitrary scale or latency numbers as gates. Any future capacity budget
must have a receipt from measured healthy workloads and must be visible when
hit.

### Public beta — prove team and ecosystem compatibility

Public beta opens the same open-source capability set to broader developers and
teams only after the alpha exit criteria and critical trust-boundary gates are
qualified.

Public beta adds:

- Multiple isolated Realms per installation. Cross-Realm trust remains denied
  by default; explicit federation or installed-app exchange is required for
  any cross-Realm contribution.
- Multiple human members, teams, Source Space permissions, agent task grants,
  review/approval separation, Policy Explanations, and complete auditable
  Change-to-Release history.
- A Cloudflare-native RepositoryDriver plus a generic Git-compatible fallback
  or migration path. Repository-provider mechanics remain behind the driver.
- Two-way GitHub mirroring as a projection adapter. Anyam remains the sole
  canonical Project authority; outbound refs are landed verified projections,
  inbound remote commits become local Changes, and divergence, force pushes,
  loops, lag, and blocked sync are explicit states.
- The portable external pull-runner protocol and one qualified non-Cloudflare
  runner. macOS, Windows, ARM, GPU, hardware-in-the-loop, private-network,
  and large-memory fleets remain later adapters.
- Typed Artifact/Release/Target flows beyond a Worker, including one npm
  package Target and generic downloadable release assets. Other registries and
  stores remain adapters.
- Public Project pages, safe public projections, issue/Intent intake,
  contribution Changes, and the local/remote agent interfaces.
- Critical qualification gates for canonical-write isolation, Source Space
  disclosure, token audience and replay, Secret Use brokerage, Evidence
  integrity, and cross-tenant mutation isolation.

Public beta does not require social discovery, stars/followers, marketplace
economics, federation, a broad package-registry matrix, or a browser IDE.

### Enterprise and ecosystem expansion

After public beta demonstrates the kernel, team workflow, and portability
boundaries, Anyam can add adapters and administrative surfaces without changing
the core contracts:

- SAML, SCIM, enterprise-managed identities, device posture, advanced network
  policy, and organization-wide administration.
- Retention, legal hold, residency, customer-managed keys, compliance exports,
  dedicated isolation, and formal external penetration testing.
- macOS/Windows/GPU/ARM/hardware/private-network runner fleets.
- Broad package registries, mobile stores, model registries, infrastructure
  Targets, and specialized project-type extensions.
- GitHub Actions import/translation and compatibility experiments. Anyam's
  native manifest remains authoritative.
- Public discovery, Pages, discussions, service desk, marketplace economics,
  federation, and community-governed deployment surfaces.

These are not proprietary capabilities. They use the same open-source server,
CLI, contracts, and adapters. Managed services may operate capacity or support
them, but no first-party feature is withheld behind a proprietary edition.

## Stage gates

Entry and exit are defined by observable behavior and Evidence, not dates.

| Stage | Entry gate | Exit gate |
| --- | --- | --- |
| K0 | Normative contracts, open-source install path, CLI/MCP/Git surfaces, and two scaffold templates exist | A clean local scaffold can be inspected, checked, and connected explicitly without implicit cloud credentials |
| Private alpha | Customer-operated install/bootstrap, RepositoryDriver qualification, auth/capability policy, runner and Target paths are available | Both reference projects, hybrid Source Space, import recovery, agent isolation, Evidence, guarded Landing, Release/Promotion, and rollback pass end to end |
| Public beta | Alpha Evidence is current; critical trust-boundary qualification gates pass; export/recovery and provider fallback are qualified | Team Realms, two-way GitHub projection, second repository path, external runner, package/release target, and public contribution flow are usable |
| Expansion | Beta production receipts and named residual-risk owners exist | Each adapter or enterprise feature has its own contract, qualification gate, migration path, and rollback behavior |

No stage gate may be satisfied by a green UI indicator alone. The gate records
exact source, policy, toolchain, Runner, Capability Grant, disclosure context,
and Evidence key. Stale Evidence reopens the gate.

## Hosting-mode migration

Changing from Hosted SaaS to Managed Customer-Account or Customer-operated
Realm is an explicit signed Project Export/import operation. It transfers the
permitted repositories, Source Space definitions, Project Profiles, Changes,
Evidence metadata, Releases, Targets, policies, audit history, and recovery
material without transferring credentials. A live Project is never silently
repointed to a new authority or storage provider.

## Explicit non-goals for the first stages

Anyam will not initially:

- invent a new Git object database or wire protocol;
- enforce a universal claim that a public Profile "works";
- grant agents direct canonical repository write access;
- rebuild Releases during Promotion;
- make an AI explanation stand in for Evidence;
- implement every package registry, scanner, runner, or store;
- promise full GitHub Actions compatibility;
- require a hosted Anyam account for a customer-operated Realm;
- build social discovery, marketplace economics, or federation before the
  source/change model is qualified.

## Consequences

The sequence gives developers a useful local tool early, preserves ordinary Git
operations, and proves the hybrid-source thesis before Anyam takes on ecosystem
scale. It also leaves several visible qualification obligations: Repository
Driver behavior, Cloudflare account limits, hosted-agent execution, external
runner security, two-way mirror divergence, and public-projection usefulness.

Those obligations are intentionally named rather than hidden in a “beta” label.
Each becomes a later ticket with a receipt, gate, and residual-risk owner.

The principal risk is perceived slowness from the number of gates. The counter-
measure is Progressive Ceremony: the same Project and Change objects are used
by a solo developer, a team, and a regulated organization, while policy adds
only the review and Evidence required by the declared risk.
