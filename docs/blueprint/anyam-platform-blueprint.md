# Anyam platform blueprint

Status: implementation-ready planning baseline

This document is the synthesized blueprint for Anyam. It is deliberately a
blueprint, not a promise that every provider, runner, registry, or project type
already works. A capability is ready to implement when its contract, authority
owner, failure behavior, Evidence, recovery path, and Stage Gate are named.

The blueprint incorporates the accepted decisions in
[`CONTEXT.md`](../../CONTEXT.md) and [`docs/adr/`](../adr/). It does not replace
those decisions; the ADRs remain the detailed decision records.

## Executive summary

Anyam is:

> **A Git-compatible project forge for humans and agents.**

Its durable promise is:

> **One coherent Project, multiple Source Space trust boundaries, verified
> Changes, and portable Releases.**

Anyam is fully open source and customer-operable. Cloudflare is the default
control plane, execution lane, and application Target, but Anyam is
Cloudflare-first rather than Cloudflare-hostage. Git remains the familiar
source-object protocol. Anyam adds semantics that ordinary Git does not own:
cross-Source-Space Views, stable Changes, Evidence, Release lineage,
Capability Grants, and Promotion.

The primary users are technical founders, solo developers, and small
engineering teams using multiple coding agents. Non-technical builders use the
same system through progressive agent-guided flows; they do not receive a
weaker or separate safety model.

The first adoption path is alongside GitHub: scaffold or import locally, use
standard Git, optionally mirror bidirectionally, and choose Anyam as canonical
only after the owner has evidence of value. A forced migration is never part of
signup.

## Product contract

### What Anyam owns

Anyam owns the authoritative semantics for:

- Project and Source Space identity;
- authorized Project Views and disclosure projections;
- Change identity, immutable revisions, claims, conflicts, and Landing;
- Action and Verifier contracts;
- Evidence validity, provenance, policy explanation, and audit;
- Artifact, Release, Target, Promotion, and rollback lineage;
- Realm identity, Capability Grants, delegation, and Secret Use policy;
- portable Project Export and recovery metadata;
- extension installation, authority narrowing, and lifecycle.

### What Anyam integrates

Provider and specialist mechanics remain replaceable adapters:

- Git repository storage and drivers;
- Cloudflare Workers, Durable Objects, D1, R2, Queues, Workflows,
  Containers/Sandbox, and Workers for Platforms;
- GitHub, Codeberg, GitLab, and generic Git mirrors;
- external pull Runners;
- package, model, device, infrastructure, and app-store Targets;
- Codex, Claude Code, Cursor, local/custom agents, and model providers;
- SAST, DAST, dependency, secret, fuzz, and provenance tooling;
- enterprise identity providers and governance integrations.

An adapter can propose an operation or return a result. The owning Anyam
context validates authority, state, disclosure, Evidence, and policy before a
protected transition is recorded.

### What Anyam does not promise

Anyam does not initially promise a universal framework matrix, that every
public Profile is functionally complete, arbitrary per-file ACLs inside one
Git object graph, full GitHub Actions compatibility, every package registry,
every CI workload on Cloudflare, or a proprietary coding model. These are
explicit boundaries, not silent omissions.

## Normative principles

1. **Project authority is above repositories.** A Git repository is a source
   data plane for one Source Space or Workspace; it is not the Project's
   complete authority.
2. **Protected transitions have one owner.** Only the owning context can
   decide a canonical Landing, Release, Promotion, visibility change, or
   Capability Grant.
3. **No direct canonical writes from tools.** Humans and agents write a
   Workspace and publish a Change. Landing is the only canonical mutation path.
4. **Inaccessible objects are absent from a View.** A public projection must
   not leak private paths, IDs, object sizes, timing, or metadata through
   permission errors.
5. **Evidence is authority input, not decoration.** Evidence is immutable,
   validity-keyed, disclosure-controlled, and stale when material inputs
   change.
6. **Promotion moves an already verified Release.** A Target is not rebuilt
   from a moving branch during Promotion.
7. **Delegation narrows authority.** An agent, Runner, integration, or model
   never receives the principal's full authority by exchange.
8. **Every limit is visible and receipted.** A budget failure names the
   budget, configured/provider limit, requested amount, receipt, and recovery
   action. No public number is a commitment without a measurement receipt.
9. **Every state-changing integration is recoverable.** It has an idempotency
   key, checkpoint, reconciliation behavior, and runbook before it becomes a
   Stage dependency.
10. **Open-source capability parity.** Hosting, support, or managed capacity
    may vary by mode; first-party capability must not be withheld behind a
    proprietary edition.

## Domain model

### Core entities

| Entity | Meaning | Authority |
| --- | --- | --- |
| Realm | Identity, policy, tenancy, audit, and recovery boundary | Realm context |
| Organization | Membership and team grouping inside a Realm | Organization context |
| Project | Logical product, library, tool, dataset, model, document set, or system | Project context |
| Source Space | Independently versioned source graph with visibility, policy, and retention | Source context |
| Project View | Collision-free composition of Source Spaces permitted to an Actor | View/projection context |
| Snapshot | Immutable content-addressed source state | Source context |
| Project Revision | Atomic manifest of participating Source Space revisions | Project context |
| Workspace | Isolated mutable view based on an exact Project Revision | Workspace context |
| Intent | Desired outcome, issue, request, incident, or hypothesis | Work context |
| Change | Stable unit of proposed transformation | Change context |
| Change Revision | Immutable candidate state for a Change | Change context |
| Run | Execution of an Action or Verifier over exact inputs | Execution context |
| Evidence | Typed assertion produced by a Run, review, policy, or external attestation | Evidence context |
| Artifact | Immutable output such as a package, binary, site, model, report, or image | Artifact context |
| Release | Named collection of Artifacts, configuration, lineage, and Evidence | Release context |
| Target | Destination/channel that accepts a Release | Target context |
| Promotion | Policy-governed transition of a Release into a Target | Promotion context |
| Capability Grant | Narrow, time-bound authority delegated to an Actor | Realm/policy context |
| Audit Event | Immutable fact about a protected operation or decision | Audit context |

### Source composition

A Project may contain several independently protected Source Spaces:

```text
Project: video-player
├── public-player       public
├── private-codec       restricted
├── internal-operations internal
└── sealed-validation   result-only
```

The canonical Project Revision records the exact revision of every participating
Space. An Actor receives a Project View containing only the Spaces and metadata
permitted by its capabilities. Public projections are separately derived
lineages; they never point an unauthorised user at a hidden Git object.

This is how a public video-player repository can be cloneable while a private
codec remains protected. Anyam verifies disclosure integrity, not a universal
claim that the public clone builds or behaves like the complete private Project.

### Change lifecycle

```text
Intent
  → claim/assignment
  → Workspace from exact Project Revision
  → Change created
  → immutable Change Revisions
  → Runs and Evidence
  → review and Integration Cohort
  → Landing compare-and-swap
  → new canonical Project Revision
```

Rebase, conflict resolution, revert, and handoff produce new state. They do
not erase prior revisions or rewrite the Change identity.

### Release lifecycle

```text
Change Revision
  → candidate output
  → verified typed Artifacts
  → immutable Release manifest
  → Target proposal
  → policy decision
  → Promotion
  → health verification
  → current or compensated Target state
```

Source, Artifact, Release, and Target state are distinct. A failed Promotion
must say whether source landed, a Release was created, a Target changed, or a
health check failed. Rollback selects a prior known-good Release; it does not
rewrite source history.

## Functional requirements

These requirements are the implementation contract. `MUST` is normative;
`SHOULD` is a default that needs an explicit decision to override.

### Project and source

- `PRJ-001` A Project MUST support one or more Source Spaces and one or more
  Modules without assuming one repository or one deployable.
- `SRC-001` Each Source Space MUST have an independent source graph, visibility
  policy, contributor policy, retention policy, and export lineage.
- `SRC-002` A Project View MUST be derived from capabilities and MUST omit
  unauthorised objects and metadata rather than returning hidden placeholders.
- `SRC-003` A public projection MUST be cloneable through standard Git when its
  owner enables public read; write and expensive operations remain authorized.
- `SRC-004` A Project Revision MUST atomically identify all participating
  Source Space revisions and their disclosure Profile.
- `GIT-001` Standard clone, fetch, push, commit, branch, tag, diff, merge,
  import, export, and mirror operations MUST remain available where they are
  honest representations of the underlying Git operation.
- `GIT-002` Repository providers MUST implement a replaceable driver contract;
  provider URLs and tokens MUST not leak into the domain model.

### Changes and integration

- `CHG-001` A Change MUST retain a stable identity across revisions, rebases,
  handoffs, review, and Landing.
- `CHG-002` A Workspace MUST be based on an exact Project Revision and MUST
  expose only its authorized Project View.
- `CHG-003` Claims MUST coordinate overlapping work without silently becoming
  hard locks; conflicts remain explicit when work overlaps.
- `CHG-004` Landing MUST compare-and-swap against the expected canonical
  Project Revision and produce a new authoritative revision.
- `CHG-005` Integration MUST classify textual, symbol, contract, schema,
  dependency, infrastructure, behavioral, policy, intent, and disclosure
  conflicts where the relevant analyzer is installed.
- `CHG-006` A failed or stale Change MUST remain inspectable and recoverable;
  no UI action may imply that it landed when it did not.

### Runs, Evidence, and provenance

- `EVD-001` Every required Action and Verifier MUST declare its exact source,
  toolchain, Runner, inputs, network policy, and output contract.
- `EVD-002` Evidence MUST bind to a validity key covering material source,
  Change, dependency, toolchain, Verifier, policy, Target, and disclosure
  inputs.
- `EVD-003` Missing, failed, stale, or indeterminate Evidence MUST block the
  relevant Stage Gate, Landing, Release, or Promotion.
- `EVD-004` Evidence projections MUST redact or summarize restricted inputs
  according to the receiving Actor's View.
- `EVD-005` Provenance MUST distinguish Principal, Actor, client, model,
  session, Task, Workspace, Runner, toolchain, and Promotion authority.

### Artifacts, Releases, and Targets

- `REL-001` Artifacts MUST be immutable, typed, content-addressed, and
  independently exportable.
- `REL-002` A Release MUST enumerate its Project Revision, Artifacts,
  configuration digests, migrations/state assumptions, Evidence, policy
  version, and provenance.
- `REL-003` Targets MUST declare accepted Artifact types, required Evidence,
  state/health observations, and rollback or compensation behavior.
- `REL-004` Promotion MUST be idempotent, policy-governed, and health-verified;
  adapters cannot promote directly without Anyam authority.

### Identity, capabilities, and agents

- `AUTH-001` A Realm MUST own local principal, membership, role,
  relationship, policy, session, grant, and audit state even when identity is
  federated through OIDC, SAML, or Cloudflare Access.
- `AUTH-002` Effective authority MUST be deny-first intersection of role,
  relationship, Source Space policy, task grant, client consent, contextual
  conditions, and explicit denies.
- `AUTH-003` Git, MCP, Runner, integration, deployment, and promotion
  credentials MUST be separate audiences and credential classes.
- `AUTH-004` Refresh credentials MUST stay in an OS keychain or approved
  secret store; access tokens MUST be short-lived and revocable through their
  grant/session.
- `AGT-001` Codex, Claude Code, Cursor, local/custom agents, and future agents
  MUST use the same semantic contracts; Anyam MUST remain model-neutral.
- `AGT-002` Agents MUST write only to an authorized Workspace and Change;
  canonical write and high-risk Promotion remain denied unless an independent
  policy path explicitly permits them.
- `AGT-003` A Context Manifest MUST identify the exact base, accessible
  Modules/Spaces, required Actions, overlapping Changes, capabilities,
  network policy, and budget state visible to the agent.
- `AGT-004` A local MCP broker MUST keep refresh credentials outside model
  context. A remote MCP token MUST not be passed through to Git, Cloudflare,
  or another upstream service.

### Portability, operations, and governance

- `PORT-001` A complete signed Project Export MUST include permitted Git/LFS
  objects, Source Space definitions, Changes, Evidence metadata, Releases,
  policies, audit, mirrors, and recovery material without credentials.
- `PORT-002` Anyam MUST support a single canonical authority when projecting
  to GitHub, Codeberg, GitLab, or another Git remote; remote divergence becomes
  an explicit Change or blocked state.
- `OPS-001` Every authoritative ledger MUST have a recovery checkpoint,
  backup/restore receipt, replay/reconciliation path, and owner-approved
  runbook.
- `OPS-002` Provider outage, queue duplication, workflow stall, stale mirror,
  partial Landing, credential compromise, and provider migration MUST have
  visible degraded modes that never widen authority or claim success.
- `GOV-001` Governance Profiles MUST be versioned, portable, open, and
  capability-neutral. They produce control Evidence; they do not create a
  proprietary edition or a certification claim.
- `EXT-001` Extensions MUST declare version, digest, provenance, requested
  effects, compatibility, and lifecycle. Installation narrows grants; it never
  grants kernel authority.

## User journeys

The following journeys are the acceptance backbone. Each journey uses the
normal interfaces and policy path; it is not a mock-only demonstration.

### J1 — New technical Project

```text
npm create anyam
  → inspect TypeScript scaffold
  → anyam init
  → anyam check
  → anyam connect (explicit Realm/Hosting Mode confirmation)
  → anyam change start
  → anyam check / preview
  → review
  → Landing
  → Release
  → Promotion to a Target
```

The scaffold is local-only by default. It never authenticates, creates a Realm,
provisions resources, or stores credentials implicitly. The same flow is
available through `npx create-anyam`, `pnpm create anyam`, and `bun create
anyam`.

### J2 — Existing Git adoption

```text
anyam clone <git-url>
  → staged/quarantined import
  → inspect Source Spaces and proposed Modules
  → owner confirms mapping
  → Change workflow
```

Import is idempotent, digest-verified, resumable from a Recovery Checkpoint,
and explicit about unsupported or private content. The owner can keep the
existing remote canonical and use Anyam as a projection until ready.

### J3 — Hybrid public/private Project

```text
private Project with public-player + private-codec Source Spaces
  → define public View
  → preview disclosure
  → publish safe public projection
  → accept public Change
  → sealed private verification if enabled
  → return disclosure-safe Evidence
  → owner chooses whether to Land/release
```

Anyam protects the boundary and provenance. It does not force the owner to
assert that the public projection works without the private code.

### J4 — Coding-agent Change

```text
user authenticates to Realm
  → anyam agent setup
  → local stdio MCP broker or project HTTP MCP
  → inspect Intent and Context Manifest
  → task-scoped Capability Grant
  → isolated Workspace
  → agent edits through filesystem/Git
  → MCP publishes Change Revision
  → Runs/Evidence/preview
  → human or policy review
```

The user may choose Codex, Claude Code, Cursor, or another agent. A handoff
creates a fresh Workspace or revision boundary and revokes the prior task
grant; two agents never silently edit the same mutable Workspace.

### J5 — Team Change and GitHub mirror

```text
Change published
  → required reviewers selected from module/Space/Target ownership
  → Integration Cohort composes interacting Changes
  → Evidence and policy explain blockers
  → Landing updates Anyam canonical state
  → outbound GitHub projection
```

Inbound GitHub commits are imported as Changes. Mirror lag, divergence, force
push, loop prevention, and blocked credentials are explicit states. GitHub is
never silently promoted to a second canonical authority.

### J6 — Customer-operated recovery

```text
provider or Realm failure
  → detect and freeze affected authority
  → restore checkpoint/export
  → verify ledger, Project Revision, grants, and disclosure
  → reconcile pending commands/events
  → resume allowed operations
```

The customer must be able to restore without Anyam-operated credentials or
secret transfer. Any unresolved ambiguity remains blocked and visible.

## State models

### Stage and gate state

```text
pending → active → complete
             └──── blocked by missing/stale/failed/indeterminate Evidence
```

Activation requires completed dependencies. Completion requires current
Evidence, retired qualification risks, and a Residual Risk decision. A stage
may be active while its gate is blocked; it may not promote through a blocked
gate.

### Evidence validity

```text
not-run → running → passed → accepted
                    ├──────→ failed
                    ├──────→ indeterminate
                    └──────→ stale when validity inputs change
```

Accepted Evidence is never an eternal green check. Source, dependency,
toolchain, Verifier, policy, Target, disclosure, or runner changes re-evaluate
the validity key.

### Promotion state

```text
proposed → validating → approved → applying → healthy
                │            │           ├── failed
                └────────────┴───────────└── blocked/degraded → rolled-back
```

`failed`, `blocked`, and `degraded` retain the requested Release, expected
Target state, provider response, Evidence, and recovery action. A retry is
idempotent; a health-verified compensation or rollback is a new audited state
transition. The Target pointer changes only after the desired Release is
health-verified; a failed health check leaves the prior known-good Release
serving or leaves the Target explicitly degraded.

## Architecture

### Planes

```text
Experience plane
  Web, anyam CLI, standard Git, REST/SDK, MCP, webhooks, agent skill

Control plane
  Realm/Policy, Project/Change coordinators, authoritative ledgers,
  Command/Event normalization, read models, audit, export

Data plane
  Source Space repositories, Workspace repositories, Git objects, LFS,
  Project Revisions, public projections

Execution plane
  Actions, Verifiers, local/Cloudflare/external Runners, caches, logs,
  Evidence, Artifacts

Delivery plane
  Releases, Target adapters, Promotion workflows, health and rollback
```

### Cloudflare-first mapping

| Anyam responsibility | Default Cloudflare component | Authority rule |
| --- | --- | --- |
| Web/API/Git gateway/MCP | Workers | Validates Realm token and normalizes Commands |
| Project/Change serialization | Durable Objects | Owns ordered transitions and idempotency |
| Search/catalogue/read views | D1 | Rebuildable; never protected authority |
| Source repositories | Artifacts via RepositoryDriver | Provider data plane; driver remains replaceable |
| Evidence/artifacts/exports | R2 | Content-addressed outputs; ledger decides lineage |
| Event fan-out | Queues | Delivery mechanism; not truth |
| Durable multi-step work | Workflows | Orchestrates; coordinator records authority |
| Bounded Linux execution | Sandbox/Containers | Disposable Runner; outputs return through Evidence |
| Customer app Target | Workers/Workers for Platforms | Target adapter; Promotion remains Anyam-owned |

Cloudflare account ownership, service limits, beta/GA status, and execution
coverage are qualification inputs. A Cloudflare component cannot silently
become a required source of Project truth.

### Bounded contexts and authority

| Context | Decides | Consumes | Emits |
| --- | --- | --- | --- |
| Realm/Policy | identity, grants, policy decisions, governance | IdP claims, device/network state | grant/policy/audit events |
| Project/Source | Project, Spaces, Views, Revisions, repositories | driver proposals, imports | source/project events |
| Workspace/Change | workspace leases, Change revisions, claims, conflicts | source revisions, intents | Change/workspace events |
| Execution/Evidence | Runs, verifier results, validity, provenance | Commands, immutable inputs | Run/Evidence events |
| Release/Promotion | Release manifests, Target state, health, rollback | Artifacts, Evidence, adapter proposals | release/promotion events |
| Adoption/Extension | projections, installed adapters, lifecycle | kernel contracts and user grants | proposal/projection events |
| Audit/Export | immutable audit and signed export packages | authoritative events | export/recovery receipts |

Queues, Workflows, D1 views, provider webhooks, and adapter responses are
inputs to these contexts, not substitute authorities.

## Interfaces

### CLI

The CLI is the primary technical interface and uses familiar Git words:

```text
anyam auth login|logout|sessions|revoke
anyam create|init|clone|connect|status|diff|commit|fetch|pull|push
anyam project inspect|export|import
anyam source-space list|view|publish
anyam intent create|claim|release
anyam workspace create|inspect|handoff|destroy
anyam change create|status|publish|review|land|revert
anyam check|run|evidence
anyam preview open|logs
anyam release create|inspect
anyam target list|promote|rollback
anyam mirror configure|sync|inspect
anyam agent setup|start|revoke
anyam policy explain
```

`anyam ship` is a policy-aware convenience command. It may run checks, request
review, Land, create a Release, or stop at the next required approval. It never
implies that source Landing and production Promotion are the same transition.

### Git

Git transfers source objects through an Anyam Git Gateway and credential
helper. Public read can be anonymous when enabled; private read and Workspace
write use short-lived audience-bound credentials. Canonical repositories are
read-only to ordinary users and agents; a trusted Landing service holds the
provider write authority.

### REST/SDK and command envelopes

All transports normalize to versioned Command and Response Envelopes carrying:

```text
Actor, Realm, Project, Source Space/View, Task/grant, operation,
idempotency key, expected aggregate version, disclosure projection,
requested effects, and operation payload
```

Errors are typed and actionable. A budget failure names scope, configured and
provider limits, requested/consumed amount, receipt status, expiry/reset, and
remediation. An authorization failure names the denied capability and safe
next action without revealing hidden resources.

### MCP

Remote MCP is project-scoped and OAuth-protected. Local agents use a stdio
broker launched by the CLI. MCP coordinates semantic operations:

```text
project.inspect
source.search / source.read
intent.create / intent.claim
workspace.create / workspace.inspect
change.create / change.publish_revision / change.inspect
run.start / run.inspect / run.cancel
evidence.inspect
review.submit_finding
integration.simulate
promotion.request
```

MCP is not the source-object data plane. It does not expose unrestricted
`read_every_file`, arbitrary ref writes, secret values, or direct production
Promotion. Remote tokens are audience-bound and exchanged internally for
separate Git, Run, or Target credentials; token passthrough is prohibited.

### Events and webhooks

Domain Events are immutable facts emitted after authoritative state changes.
They include aggregate version, idempotency source, disclosure projection,
and compatibility version. Webhooks and queues deliver projections of events;
retries and duplicates are expected and handled by idempotent consumers.

## Security and authorization

### Identity chain

```text
upstream identity (passkey/OIDC/SAML/Access)
  → Realm principal
  → organization/team relationship
  → Project/Source Space role
  → task Capability Grant
  → client/session/agent/model conditions
  → command policy decision
```

A production application account is never a Forge developer identity. Source
portals use host-only cookies; no privileged `.example.com` cross-subdomain
cookie is shared with a runtime application.

### Credential classes

| Class | Use | Authority |
| --- | --- | --- |
| Browser session | Web portal | host-only session; no raw token in the page |
| CLI refresh/access | Developer commands | Realm session; stored in OS keychain |
| Git credential | clone/fetch or Workspace push | exact repository/Workspace and short-lived |
| MCP access | semantic agent tools | project audience and task capabilities |
| Agent task grant | delegated agent work | View, Workspace, Actions, budget, expiry |
| Runner job token | one execution | exact source, job, outputs, network, expiry |
| App installation token | integration | installed Project/Space and declared effects |
| Promotion credential | Target transition | service-only, Release/Target bound |
| PAT fallback | legacy tools | named, scoped, expiring, revocable; not default |

Secret permissions distinguish `secret.use`, `secret.metadata.read`, and
`secret.value.read`. Most agents and Runs receive only `secret.use` through a
broker that records destination and result without revealing the credential.

### Trust boundaries

The critical qualification gates are:

- canonical Landing and Target Promotion;
- Source Space and cross-Realm disclosure;
- token audience, delegation, replay, and revocation;
- Secret Use and outbound network policy;
- Evidence/provenance integrity and stale Evidence;
- Publication Changes and sealed verifier side channels;
- extension authority and lifecycle;
- customer Realm and provider tenant isolation;
- export, restore, and mirror recovery.

Each gate has a threat, control, executable Journey, Evidence projection,
residual-risk owner, and recovery/runbook pointer in the threat and validation
ADRs.

## Hosting modes and ownership

### Hosted SaaS

Anyam operates the Realm control plane and optional execution capacity. The
customer owns Project Content and can export it completely. No hosted-only
first-party feature is allowed.

### Managed customer-account

Anyam operates the collaboration experience; the customer's Cloudflare account
owns source, runtime, data, secrets, and billing. OAuth/account grants are
narrow, explicit, revocable, and never become permanent user credentials.

### Customer-operated Realm

The customer deploys the open-source server to its own Cloudflare account and
owns the Realm, keys, source, data, execution, recovery, and provider bill.
Anyam may provide documentation, signed releases, support, and optional
managed operations, but the install must remain operable without Anyam service
access.

Migration between modes is a signed Project Export/import operation. It does
not silently repoint a live Project or transfer credentials.

## Operations, recovery, and cost

### Reliability

Reliability is reported separately for serving, mutation correctness,
execution, recovery, and dependency behavior across Hosting Modes and Stages.
No single “uptime” number substitutes for those objectives. Any SLO, error
budget, quota, or retention value requires a receipt from the relevant healthy
workload and provider contract.

### Recovery

Authoritative ledgers, exports, provider snapshots, and recovery metadata are
distinct. Recovery runbooks cover detection, freeze, checkpoint selection,
restore, replay, reconciliation, verification, and resume for:

- queue duplication or loss;
- stalled Workflows;
- partial Landing or Promotion;
- stale or divergent mirrors;
- compromised credentials or grants;
- failed imports and migrations;
- RepositoryDriver/provider migration;
- customer Realm loss or restore.

### Usage and budgets

Anyam records logical work in Usage Receipts and reconciles provider usage in
Provider Cost Receipts. Budget Policies scope Realm → Organization → Project →
Source Space/Target → Task/Run and distinguish warnings, approvals, degraded
behavior, hard provider tripwires, and owner budgets. Provider billing remains
with the customer in customer-account modes and with Anyam only for Hosted SaaS
resources.

## Extensions and governance

`anyam.extension/v1` manifests cover RepositoryDrivers, Actions, Verifiers,
TargetAdapters, project experiences, IDE integrations, AgentSkills, and Apps.
An installation is digest-pinned and Realm/Organization/Project scoped. The
requested effect is intersected with policy and the current Capability Grant;
the extension receives no implicit kernel authority.

Governance Profiles are versioned and portable. They can require stronger
identity, residency, encryption, retention, isolation, separation of duties,
break-glass, and control mapping. They produce Evidence and operational
obligations rather than an Anyam proprietary edition or an unsupported
certification claim.

## Product stages and release gates

The detailed program is in
[`ADR 0027`](../adr/0027-phased-delivery-program.md). The concise path is:

| Stage | Purpose | Exit evidence |
| --- | --- | --- |
| P0 | Freeze contracts and retire critical unknowns | spike receipts, fixtures, validation matrix, named fallbacks/residual risks |
| P1 / K0 | Open-source local TypeScript kernel | scaffold, Git round-trip, Change/agent loop, export |
| P2 / private alpha | Customer-operated Cloudflare thesis | Worker, CLI/library, hybrid Source Space, import recovery, Evidence, Landing, Release, Promotion, rollback |
| P3 / public beta | Team adoption and ecosystem compatibility | multi-Realm team journey, GitHub mirror recovery, external Runner, package/release Target, new customer install |
| P4 / expansion | Open adapters and governance | per-adapter contract, qualification, export, deprecation, rollback |

No Stage is complete because code merged, a dashboard is green, or a date
arrived. Evidence must be current for exact source, policy, toolchain, Runner,
Capability Grant, and disclosure context.

## Risk register and qualification backlog

The blueprint does not hide these risks. Each is a qualification or
implementation work package, not an unowned promise.

| Risk | Earliest resolution | Required proof or fallback |
| --- | --- | --- |
| Cloudflare repository provider changes or remains unavailable | P0/P2 | RepositoryDriver receipt, portable restore, tested generic Git fallback |
| Public projection leaks private graph metadata | P0/P2 | adversarial disclosure Journey and safe projection export |
| Agent bypasses canonical Landing | P0/P1 | denied-write test using each credential class and audit receipt |
| Evidence is stale but still treated as authority | P0/P1 | validity-key mutation Journey and blocked gate receipt |
| GitHub two-way mirror creates two authorities | P3 | canonicality, divergence, loop, force-push, and recovery Journey |
| External Runner exfiltrates source or secrets | P2/P3 | immutable input, network/Secret Use policy, output disclosure, revocation proof |
| Cloudflare-only execution excludes healthy projects | P2/P3 | pull-runner contract and project-type fixture; no false coverage claim |
| Usage/cost limits become developer landmines | P0/P2 | Usage/Provider Cost receipts and visible budget error behavior |
| Open extensions gain unintended authority | P0/P4 | digest/policy/deny tests and revocation lineage |
| Restore cannot resume exact authority | P0/P2 | signed export/import and Recovery Checkpoint rehearsal |
| Brand or domain clearance blocks public Anyam identity | before public launch | formal legal/cultural/company identity gate; identifiers remain rebrandable |

## Traceability

| Blueprint area | Primary decision record |
| --- | --- |
| Source Spaces, Views, revisions | [ADR 0001](../adr/0001-capability-safe-project-view-revisions.md), [ADR 0003](../adr/0003-materialize-composed-workspaces-over-source-spaces.md) |
| Project authority and Git drivers | [ADR 0002](../adr/0002-keep-project-authority-above-replaceable-git-repositories.md), [ADR 0017](../adr/0017-portable-project-exports-and-single-authority-mirrors.md) |
| Bidirectional Repository Mirrors and recovery | [ADR 0017](../adr/0017-portable-project-exports-and-single-authority-mirrors.md), [ADR 0036](../adr/0036-bidirectional-repository-mirrors-and-recovery.md) |
| Publication and sealed verification | [ADR 0004](../adr/0004-publication-changes-and-sealed-verification.md), [ADR 0032](../adr/0032-hybrid-public-private-projections-and-sealed-verifiers.md) |
| Changes, team review, Integration Cohorts, and Landing | [ADR 0005](../adr/0005-stable-changes-and-compare-and-swap-landing.md), [ADR 0035](../adr/0035-team-review-integration-cohorts-and-authority.md) |
| Artifacts, Releases, Targets, Worker and non-web publication | [ADR 0006](../adr/0006-generalize-artifacts-releases-and-targets.md), [ADR 0033](../adr/0033-worker-release-promotion-and-rollback.md), [ADR 0034](../adr/0034-non-web-release-publication-and-portable-artifacts.md) |
| Identity and capability policy | [ADR 0007](../adr/0007-realm-owned-authentication-and-delegation.md), [ADR 0008](../adr/0008-explainable-capability-policy.md), [ADR 0030](../adr/0030-realm-identity-and-capability-policy.md) |
| CLI, Git, MCP, agents | [ADR 0009](../adr/0009-cli-git-mcp-agent-connection.md) |
| Manifests, Actions, Verifiers, Runners | [ADR 0011](../adr/0011-portable-project-manifest-contract.md), [ADR 0012](../adr/0012-cloudflare-default-and-portable-pull-runners.md) |
| External Runner Attempts and generic non-web Target publication | [ADR 0037](../adr/0037-external-pull-runners-and-generic-target-qualification.md), [ADR 0034](../adr/0034-non-web-release-publication-and-portable-artifacts.md) |
| Evidence, threats, Cloudflare architecture | [ADR 0013](../adr/0013-evidence-validity-policy-and-provenance.md), [ADR 0014](../adr/0014-system-threat-model.md), [ADR 0015](../adr/0015-cloudflare-first-architecture-and-provider-boundaries.md) |
| APIs, events, hosting, bootstrap | [ADR 0016](../adr/0016-normalized-service-data-api-and-event-contracts.md), [ADR 0018](../adr/0018-hosting-tenancy-and-ownership-modes.md), [ADR 0019](../adr/0019-bootstrap-onboarding-import-and-recovery.md) |
| Stages, validation, operations, cost | [ADR 0020](../adr/0020-releasable-stages-and-entry-exit-gates.md), [ADR 0021](../adr/0021-evidence-backed-acceptance-and-validation.md), [ADR 0022](../adr/0022-reliability-operations-and-recovery-contract.md), [ADR 0023](../adr/0023-receipt-backed-costs-quotas-and-packaging.md) |
| Governance, extensions, positioning, delivery | [ADR 0024](../adr/0024-open-governance-profiles-and-compliance-boundaries.md), [ADR 0025](../adr/0025-versioned-extension-contracts-and-trust.md), [ADR 0026](../adr/0026-positioning-documentation-and-adoption.md), [ADR 0027](../adr/0027-phased-delivery-program.md) |

## No-fog audit

The resolved decisions now cover the material product and architecture
questions named by the map: category, users, source model, Git compatibility,
Change and Landing semantics, authorization and agent connections, execution,
Evidence, Releases and Targets, Cloudflare/provider boundaries, hosting modes,
portability/mirroring, onboarding, acceptance, reliability/recovery, costs,
governance, extensions, positioning, and staged delivery.

The remaining work is implementation handoff, not a missing product decision:
translate the requirements and journeys into ordered tickets, assign owner
profiles, and define the first approved risk spikes. That is the scope of
[Create the implementation handoff](https://github.com/wms2537/anyam/issues/41).

If handoff discovers a contradiction, it must create a new Wayfinder ticket and
return the blueprint to this audit rather than silently editing a normative
invariant.
