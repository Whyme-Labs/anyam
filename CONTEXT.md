# Anyam

Anyam is an open, Git-compatible project SCM that lets humans and agents transform independently governed Source Spaces into verified Project Revisions and Releases without exposing inaccessible source or granting broad canonical authority.

Every first-party component required to operate full Anyam is open source. Anyam has no proprietary enterprise edition; commercial services may operate, support, or extend the capacity of the same open system without withholding product capabilities.

## Language

Use familiar Git terms whenever they name an exact Git object or operation: repository, commit, branch, clone, fetch, push, tag, diff, and merge. Use Anyam-specific terms only when the semantics exceed Git. A pull request may present a Change, a merge may participate in Landing, and checks may summarize Evidence, but the compatibility view does not replace the more precise object.

**Realm**:
The identity, authorization, policy, and collaboration boundary operated by one Anyam installation.
_Avoid_: Instance account, global account

**Customer-operated Realm**:
A Realm deployed in and controlled through the customer's own Cloudflare account, with no required Anyam SaaS, third-party forge, customer-managed always-on server, database cluster, shared Git filesystem, or permanent runner. Cloudflare remains its managed infrastructure dependency; specialized execution may use optional pull-based runners.
_Avoid_: Self-hosted when implying independence from Cloudflare

**Hosting Mode**:
One of Anyam's supported operational topologies: Hosted SaaS, Managed Customer-Account, or Customer-operated Realm. Hosting Mode changes responsibility and placement, not Project/API/Export semantics or first-party capability availability.
_Avoid_: Edition, proprietary tier

**Managed Customer-Account**:
A Hosting Mode in which Anyam operates selected collaboration/control-plane services while the customer owns the Cloudflare account, source repositories, applications, data, secrets, domains, and Targets through explicit revocable grants.
_Avoid_: Hosted customer account, shared admin token

**Hosted SaaS**:
A Hosting Mode in which Anyam operates the control plane and selected execution or application Targets in its own qualified Cloudflare account. The customer retains Project Content ownership, policy authority, export rights, and mode-transition rights.
_Avoid_: Anyam-owned source, proprietary product tier

**Bootstrap**:
The idempotent state transition that creates or connects a Realm, enrolls its first owner and recovery path, and establishes the minimum Project/Export authority without activating unreviewed source or production Targets.
_Avoid_: Installer finished, default admin

**Import Operation**:
A staged, provider-bound operation that preflights, quarantines, verifies, and activates Git/source and selected metadata into a Project. An Import Operation has an idempotency key, checkpoint, disclosure decision, and explicit incomplete/blocked state.
_Avoid_: Git clone, one-click copy

**Recovery Checkpoint**:
An owner-visible verified boundary in Bootstrap, Import, migration, or Promotion state from which an operation can resume or safely roll back. A checkpoint records partial effects and never implies that the whole operation succeeded.
_Avoid_: Best-effort retry, hidden progress

**Organization**:
A group of principals, teams, and projects governed together inside a Realm.
_Avoid_: Realm, tenant

**Project**:
A Realm's root managed unit: a logical product, system, library, model, document set, or other body of work that may span multiple Source Spaces, repositories, modules, Artifacts, and Targets. A Project does not imply a web application, runtime, or Deployment.
_Avoid_: Repository, application

**Repository**:
A Git-compatible source-storage and object-transfer unit used by a Source Space or Workspace. It is a compatibility boundary, not the complete Project, Change, or collaboration model.
_Avoid_: Project, Source Space

**Canonical Repository**:
The Git repository containing landed source for one Source Space. Its source refs are repairable projections of canonical Project Revisions, and only the trusted Landing service may write them.
_Avoid_: Project authority, directly writable main repository

**Workspace Repository**:
An isolated writable Git repository materialized from an exact Source Space Snapshot for one Workspace and bounded Change task. A Workspace may span several Workspace Repositories while presenting one composed filesystem.
_Avoid_: Canonical repository, shared agent branch namespace

**Repository Driver**:
The replaceable provider adapter that creates and inspects Git repositories, transfers source, issues credentials, verifies integrity, exports, restores, and reconciles provider state. A Repository Driver reports capabilities but never decides Anyam authorization, policy, Change identity, cross-space atomicity, or disclosure.
_Avoid_: Project repository abstraction, authorization service

**Git Gateway**:
The Realm-owned Smart HTTP boundary that gives clients stable Git URLs, anonymous public reads, short-lived credential exchange, policy enforcement, audit, and provider migration without exposing Repository Driver credentials or endpoints.
_Avoid_: Cloudflare Artifacts remote, public mirror

**Repository Mirror**:
An external Git repository synchronized bidirectionally with an Anyam Source Space for permitted refs and history. Remote commits enter Anyam as proposed Changes; only Landing advances the canonical Project Revision, after which accepted refs may propagate outward.
_Avoid_: Second canonical repository, last-writer-wins synchronization

**Federation**:
An explicit, capability-scoped exchange between independently operated Realms that preserves local authority, disclosure policy, lineage, revocation, and abuse controls. Federation is later than Git-compatible mirroring and never creates shared canonical authority.
_Avoid_: Multi-primary mirror, implicit cross-Realm trust

**Source Space**:
An independently versioned source and object-graph boundary with its own visibility, access, licensing, and model-processing policy. Every Snapshot belongs to one Source Space, and inaccessible source is neither reachable nor discoverable through another Source Space.
_Avoid_: Private folder, hidden branch

**Open-source Project**:
A Project whose source required to build its published Artifacts is publicly disclosed under open-source licenses. Restricted secrets, operational data, or security tests do not by themselves change this classification.
_Avoid_: Public Project when referring only to source licensing

**Hybrid-source Project**:
A Project in which public, open-source Source Spaces coexist with restricted or proprietary Source Spaces.
_Avoid_: Semi-open-source Project

**Closed-source Project**:
A Project whose source required to build its published Artifacts is not publicly disclosed under open-source licenses.
_Avoid_: Private Project when referring only to source licensing

**Project View**:
A collision-free composition selected by a Project Profile from the Source Spaces an Actor and, when applicable, its model provider may discover and access. A Project View contains no references or metadata from inaccessible Source Spaces and never silently weakens a requested Project Profile.
_Avoid_: Sparse checkout, filtered listing

**Project Profile**:
An owner-declared selection of Source Spaces, collision-free mounts, modules, actions, outputs, and policies for a particular community, commercial, internal, or other Project configuration. A Project Profile selects but never grants access; Anyam enforces disclosure integrity without imposing a universal definition of functional completeness.
_Avoid_: Edition when the distinction is only a declared composition

**Project Export**:
A documented, versioned recovery package containing every Project repository plus its Intents, Changes, reviews, policies, Evidence metadata, Artifact index, Releases, audit history, and schema versions. Referenced large objects retain verifiable digests and customer-owned locations.
_Avoid_: Git clone when referring to complete Project portability

**Project Content**:
Source, collaboration records, agent context, Run data, Evidence, Artifacts, Releases, and other material supplied to or generated for a Project. Project Content is not advertising inventory, a data product, or model-training material.
_Avoid_: Telemetry

**Realm Telemetry**:
Minimal operational or usage measurements intentionally emitted outside a Realm to operate or improve an explicitly requested service. Realm Telemetry excludes Project Content by default, must be transparent and disableable, and is disabled by default for a Customer-operated Realm.
_Avoid_: Project Content, hidden analytics

**Disclosure Projection**:
A capability-safe representation of an Intent, Change, review, Run, Evidence, Artifact, Release, Target, or activity record for a particular audience. Its identifiers and metadata derive only from disclosed state; restricted titles, identifiers, timing, search data, notifications, and context are omitted rather than exposed as permission errors.
_Avoid_: Redacted object when hidden metadata remains discoverable

**Snapshot**:
An immutable, content-addressed representation of source state belonging to exactly one Source Space. In a Git-backed Source Space, an exact Git commit identifies the Snapshot.
_Avoid_: Working tree

**Project Revision**:
The authoritative immutable manifest identifying the exact Snapshots that form one coherent Project state across all participating Source Spaces. Restricted audiences receive Project View Revisions rather than a redacted Project Revision or its identifier.
_Avoid_: Commit, release

**Project View Revision**:
An immutable manifest and identifier for the exact disclosed Snapshots in one Project View, derived only from that disclosed state. Project Revisions that differ solely in inaccessible state produce the same Project View Revision for an unchanged audience.
_Avoid_: Redacted Project Revision, partial Project Revision

**Intent**:
A desired outcome, problem, request, or hypothesis that motivates work.
_Avoid_: Ticket when referring to the domain object

**Change**:
A stable unit of proposed work that transforms one Project Revision into another. Its identity survives new Change Revisions, rebase, review iterations, and revert relationships; a Change never requires rewriting an earlier revision to advance.
_Avoid_: Branch when referring to the stable work identity; a pull request is a valid compatibility view

**Change Revision**:
An immutable version of a Change, identified by the exact participating Git commits or other Source Space Snapshots and its base Project Revision. A later revision may supersede an earlier one for Landing, but never erases it; rebase and revert are new revision or Change operations.
_Avoid_: Force-pushed state, patch overwrite

**Workspace**:
An isolated, mutable local or remote environment based on an exact Project Revision and associated with a Change. A multi-Source-Space Workspace materializes one Workspace Repository per authorized Source Space under explicit collision-free mounts and presents one composed filesystem. Editors work against that filesystem; Anyam provides unified status and diff, automatic Snapshots, sync, and undo, while standard Git operations remain valid against the individual Workspace Repositories rather than a synthetic cross-space repository. A local Workspace supports the routine edit, snapshot, diff, undo, and check loop without continuous Realm connectivity.
_Avoid_: Branch when referring to the complete composed environment; use branch for an actual Git ref

**Integration Cohort**:
A set of Changes and exact Change Revisions composed and verified together against an explicit base Project Revision. Effect overlap is a blocking Conflict, claim overlap is a coordination warning, and a cohort cannot Land after its base Project Revision becomes stale.
_Avoid_: Merge queue when the cohort spans source boundaries or semantics a Git merge queue cannot represent

**Conflict**:
Durable, inspectable state showing that source, symbols, contracts, schemas, dependencies, infrastructure, behavior, visibility, intent, or policy cannot yet be composed safely. A new Change Revision resolves a Conflict; an agent explanation does not.
_Avoid_: Temporary merge error, silently accepted AI resolution

**Landing**:
The policy-governed, compare-and-swap creation of a new canonical Project Revision from one or more approved Change Revisions in an Integration Cohort. Landing fails explicitly if the cohort base is stale or required Conflict, review, Evidence, or policy state is unresolved. Only trusted Anyam authority performs Landing; developer tools and coding agents publish Change Revisions instead.
_Avoid_: Direct push; use merge for the participating Git operation and Landing for the complete Project transition

**Claim**:
A time-bounded, inspectable statement that an Actor is working on a declared scope. Claims coordinate overlapping work and may produce warnings, but they are not exclusive locks and do not by themselves block a Change.
_Avoid_: Hard lock, ownership transfer

**Revert Change**:
A new Change whose declared effects restore selected state from a previously landed Change. It creates new revisions and a new Landing; it never deletes or rewrites the landed history.
_Avoid_: History rewrite, destructive rollback

**Run**:
An execution of a declared action against exact, immutable inputs.
_Avoid_: Check when referring to the recorded execution

**Build**:
A Run that produces one or more immutable Artifacts from exact commits, Project Revision, dependencies, toolchain, and declared inputs. An external or imported Artifact may enter through an explicit attestation, but is not represented as an Anyam-reproducible Build unless its provenance supports that claim.
_Avoid_: Release, deployment

**Candidate Output**:
A disposable, pre-Release result linked to a Change Revision, such as a preview, test package, rendered document, model playground, plan, or simulator result. A Candidate Output may expire or be replaced and is never directly promotable.
_Avoid_: Artifact, Release, deployment

**Evidence**:
A structured, reproducible assertion about a Snapshot, Change Revision, Run, Artifact, or Release. Evidence records an exact validity key over its material source, Action/Verifier, toolchain, dependency, effect, policy, Target, disclosure, and provenance inputs; it becomes stale when a declared input or governing policy changes. An unsupported human or agent explanation is not Evidence.
_Avoid_: Green check

**Evidence Key**:
The complete normalized identity of the material inputs that determine whether an Evidence assertion remains valid, including source, Action/Verifier, toolchain, dependencies, effects, policy, Target, disclosure contract, and sealed inputs where applicable. A partial cache match is not an Evidence Key match.
_Avoid_: Source hash alone, cache key without policy

**Effect Declaration**:
A structured statement that a Change or Run may affect an API, contract, database, secret use, infrastructure binding, dependency, toolchain, Target, or other governed surface. Effects drive policy and review but are not proof that an effect occurred.
_Avoid_: Semantic proof, changed-files summary

**Attestation**:
A signed or externally produced statement about an Artifact, Run, source, dependency, or security result that Anyam preserves and normalizes at its boundary without upgrading insufficient provenance into an Anyam-reproducible Build claim.
_Avoid_: Evidence without a producer contract, signature as authority

**Artifact**:
An immutable, content-addressed output produced from exact source and execution inputs, with a typed versioned schema, provenance, disclosure policy, and access policy. Artifact types are extensible; imported outputs retain their external origin and attestation status.
_Avoid_: Release, deployment

**Release**:
A named, immutable, approved manifest of one or more Artifacts, configuration references and digests, and Evidence. Release names are Project-defined while Anyam assigns an immutable identity; a Release may be promoted to many Targets without being rebuilt or mutated.
_Avoid_: Build, deployment

**Target**:
A destination or channel to which a Release can be promoted, with declared capabilities, policy, current Release pointer, health state, and append-only Promotion history. A Target may be a runtime, registry, store, device cohort, publication channel, or other adapter-owned destination.
_Avoid_: Environment when the destination is not a runtime environment

**Promotion**:
A policy-governed, idempotent, expected-state-guarded state transition that makes an existing Release current at a Target. Promotion has explicit execution and verification state, never rebuilds source, and rollback is a new Promotion to an earlier Release subject to Target-specific Evidence.
_Avoid_: Merge, rebuild

**Deployment**:
A Promotion to a runtime Target. Deployment uses the already verified Artifacts in a Release and does not rebuild a branch.
_Avoid_: Merge, build, release

**Publication Change**:
A governed Change that creates or extends a new curated lineage inside an existing less-restricted Source Space from more-restricted source. Publication is a dedicated, previewable, and irreversible disclosure workflow: full history and private metadata require explicit opt-in, structural disclosure failures block it, high-risk cases require independent approval, and later revocation is prospective only.
_Avoid_: Visibility toggle

**Sealed Verifier**:
A verifier that is explicitly opted into external invocation, whose implementation or inputs are restricted while a versioned contract discloses only policy-selected results. Each Run binds to exact source, verifier, toolchain, and owner-controlled inputs; side-channel policy, audience, appeal behavior, and Evidence freshness are part of that contract.
_Avoid_: Private CI job

**Principal**:
The human or organization from which authority originates.
_Avoid_: Actor

**Actor**:
A human, agent, or service that performs an operation through the same Change model. Actor type does not imply authority; identity, policy, and Capability Grants determine it.
_Avoid_: User when the performer may be an agent or service

**Session**:
One authenticated execution context through which an Actor operates.
_Avoid_: Account

**Task**:
The bounded purpose for which a Principal delegates authority to an Actor, normally associated with an Intent, Change, Run, or operational action.
_Avoid_: Issue, Session

**Capability Grant**:
Narrow, temporary, audience-bound authority delegated to an Actor for specified resources, effects, tools, networks, secret use, budgets, and duration. Explicit denial takes precedence over grants.
_Avoid_: Personal access token, role

Anyam's current authentication profile uses WebAuthn/passkeys and authorization-code OIDC/OAuth for browser and CLI identity, the MCP 2026-07-28 HTTP authorization profile for remote MCP, a local authenticated broker for stdio MCP, the Anyam Git Gateway plus `git-credential-anyam` for Git, and distinct audience-bound credentials for Git, MCP, runners, integrations, and Targets. OAuth and enterprise identity standards carry requests; the Realm remains authoritative for Capability Grants and policy.

The CLI and MCP surfaces do not replace Git: Git transfers source objects, while MCP and the CLI coordinate semantic Change, Workspace, Run, Evidence, review, and Promotion operations. Local agents receive task-scoped Workspace authority and publish Change Revisions; canonical repositories remain writable only by trusted Landing authority.

**Secret Use**:
Authority to invoke an approved credential-backed operation while the credential value remains outside the Actor's Workspace, process environment, logs, and model context.
_Avoid_: Secret read, credential injection into an agent

**Progressive Ceremony**:
The policy-driven increase in review, Evidence, separation-of-duty, and approval requirements as collaboration or risk grows, while solo and team work continue to use the same domain objects.
_Avoid_: Separate solo mode, enterprise workflow

**Progressive Configuration**:
The use of familiar Git and project conventions for simple Projects, with explicit, versioned configuration introduced only when the owner needs behavior that cannot be inferred safely.
_Avoid_: Mandatory manifest, hidden convention for advanced behavior

**Policy Explanation**:
A human- and machine-readable account of why an operation is allowed or blocked, which policy and Project state produced the decision, and what permitted action can satisfy it.
_Avoid_: Disabled button, unexplained denial

Every Policy Explanation is `allow`, `deny`, or `indeterminate`, records the policy version and authorization epoch, and exposes only capability-safe operation, resource, blocker, and remediation details. Unknown required context fails closed for protected operations; hidden resources use a safe `not_found` projection.

**Audit Event**:
An immutable, attributable record of an authority-bearing operation, its policy decision, and its result. Audit Events exclude credential values, private model reasoning, and inaccessible Project Content.
_Avoid_: Mutable activity log, model chain of thought

**Operation Log**:
An ordered history of source-control and Workspace operations that supports inspection and safe undo where practical. Undo creates new state and does not erase accepted history or Audit Events.
_Avoid_: Audit Event, destructive history rewrite

**Context Manifest**:
A revision-addressed record of the project context, constraints, tools, policies, and concurrent work supplied to an agent.
_Avoid_: Prompt

**Project Manifest**:
A versioned semantic contract for a Project's modules, dependencies, Actions, declared inputs and outputs, Artifact types, Verifiers, and Target adapter declarations. A Manifest may be derived from disclosed conventions, explicit Project configuration, or both; it describes mechanics and relationships but never grants authority or claims universal buildability.
_Avoid_: Mandatory YAML, CI workflow file when referring to the normalized Project contract

**Action**:
A portable declaration that transforms exact source and declared inputs into named outputs using a command or implementation reference, network destinations, and resource requirements. Local or remote execution selects a runner without changing the normalized Action contract.
_Avoid_: Runner job when referring to the declared operation; Check when referring to the recorded Run

**Verifier**:
A declared assertion producer bound to an Action or Run, with a disclosure policy and required-for declaration. A Verifier defines the Evidence contract; its result is established only by an exact Run and is subject to Evidence freshness and policy.
_Avoid_: Green check, unsupported build claim

**Target Adapter**:
An extension that declares a Target's accepted Artifact types and required capabilities or checks, then performs provider-specific mechanics while Anyam retains Release, Promotion, provenance, policy, disclosure, and audit authority.
_Avoid_: Deployment script, environment-specific kernel logic

**Runner**:
An enrolled execution provider with declared operating-system, architecture, isolation, toolchain, resource, network, Secret Use, cache, output, and Target capabilities. A Runner executes bounded Run attempts but never decides Anyam authorization, Source Space visibility, Landing, or Promotion.
_Avoid_: CI server, canonical executor

**Runner Job**:
A short-lived, lease-bound assignment for one Run attempt, carrying an immutable input manifest, one Project View, one Action or Verifier, scoped output locations, and a narrowed job Capability Grant. A Runner Job is replay-safe and cannot write canonical source.
_Avoid_: PAT, workflow as source of truth

**Threat Model**:
A versioned inventory of protected assets, trust boundaries, adversaries, abuse cases, security requirements, qualification gates, and explicitly accepted residual risks. A Threat Model is updated when a material architecture, provider, Source Space, Runner, verifier, Target, disclosure, or policy boundary changes.
_Avoid_: Security checklist, one-time review

**Trust Boundary**:
A point where untrusted identity, content, execution, provider state, or protocol data enters an Anyam resource or state transition and must be authenticated, authorized, validated, constrained, or projected. Cloudflare account ownership, network location, Runner enrollment, or a valid signature does not remove a Trust Boundary.
_Avoid_: Network perimeter, trusted internal call

**Security Requirement**:
A normative protection for an asset or Trust Boundary, expressed with the authority, disclosure, integrity, availability, or recovery property it preserves and the failure behavior it requires.
_Avoid_: Best practice, security aspiration

**Qualification Gate**:
An executable verification obligation for a Security Requirement, bound to exact source, policy, toolchain, Runner, grant, and disclosure context. A gate produces Evidence; a passed gate becomes stale when material inputs change.
_Avoid_: Green check, informal test

**Residual Risk**:
A known threat that remains after the selected controls and qualification gates, with a named owner, mitigation, and acceptance decision. Residual Risk never authorizes silently weakening a hard boundary.
_Avoid_: Untracked exception, accepted vulnerability

**Bounded Context**:
A domain boundary with one authoritative state model, invariants, and owner. Other contexts consume versioned events or read projections and cannot silently become authority for its protected transitions.
_Avoid_: Microservice, table group

**Authoritative State**:
The state source allowed to decide a protected transition for one resource or aggregate. A cache, read model, queue message, provider event, signature, or workflow instance is not Authoritative State unless the owning context explicitly validates and records it.
_Avoid_: Latest value, database row

**Read Model**:
A rebuildable, query-optimized projection of Authoritative State. Read Models may be stale or unavailable and never authorize protected mutations.
_Avoid_: Source of truth, audit ledger

**Command Envelope**:
A versioned semantic mutation request carrying the Actor, resource, Task/grant context, operation, idempotency key, expected aggregate version, and operation payload. REST, SDK, CLI, and MCP adapters normalize into the same Command Envelope.
_Avoid_: HTTP request, provider API call

**Domain Event**:
An immutable fact emitted after its owning Bounded Context records an authoritative transition. Domain Events are replay-safe notifications with aggregate version and Disclosure Projection metadata; they are not commands or authorization grants.
_Avoid_: Webhook command, queue message as source of truth

**Stage**:
A releasable capability boundary in Anyam's layered delivery sequence: K0 kernel, private alpha, public beta, or enterprise/ecosystem expansion. A Stage adds capability without replacing the canonical Project, Source Space, Change, Evidence, Release, Target, or Capability contracts.
_Avoid_: Calendar milestone, edition

**Stage Gate**:
An observable entry or exit obligation for a Stage, satisfied by exact Evidence over source, policy, toolchain, Runner, Capability Grant, and disclosure context. A Stage Gate becomes stale when a material input changes and cannot be satisfied by a UI status alone.
_Avoid_: Launch date, green check

**Reference Project**:
A deliberately selected project archetype used to qualify the generalized Anyam workflow. The initial references are a Cloudflare Worker application and a TypeScript CLI/library; a hybrid-source project additionally qualifies public/private Source Space boundaries.
_Avoid_: Demo app, supported framework matrix

**Scaffold**:
A local Project starter generated by `create-anyam` or `anyam create`, containing TypeScript source, Project Manifest proposals, and local checks without implicitly authenticating, provisioning cloud resources, or creating a Realm.
_Avoid_: Cloud deployment, installer

**Hosting-mode migration**:
An explicit signed Project Export/import operation that moves a Project between Hosted SaaS, Managed Customer-Account, and Customer-operated Realm while preserving permitted content, lineage, policies, Evidence metadata, Releases, and recovery material without transferring credentials.
_Avoid_: In-place tenant switch, silent repoint

**Acceptance Criterion**:
A versioned, evidence-backed statement that one explicit Project/Reference Fixture journey satisfies an expected invariant under exact source, policy, toolchain, Runner, Capability Grant, and disclosure inputs. Missing, failed, stale, or indeterminate Criteria block the relevant Stage Gate.
_Avoid_: Checklist item, green UI status

**Reference Fixture**:
A small source-controlled Project used to qualify a generalized Anyam workflow: the initial set is a Cloudflare Worker, a TypeScript CLI/library, and a hybrid public/private Source Space Project. A fixture is not a customer workload benchmark or a universal buildability claim.
_Avoid_: Demo app, performance benchmark

**Validation Journey**:
A normal or adversarial end-to-end path across Anyam interfaces and Trust Boundaries, with explicit preconditions, expected invariants, Evidence, disclosure projection, and recovery behavior. A journey exercises the same policy-governed commands as a real Actor.
_Avoid_: Manual click-through, happy path only

**Reliability Objective**:
A Hosting Mode- and Stage-specific user-visible reliability contract expressed through measured SLIs, a declared SLO, an error budget, and an owner. Reliability Objectives cover serving, mutation correctness, execution, recovery, and dependency behavior separately; no numeric target is valid without a receipt.
_Avoid_: Platform uptime number, provider SLA

**Degraded Mode**:
An explicit safe behavior when a dependency or provider is unavailable: allowed reads or pending states, forbidden authority-bearing actions, visible reason, and recovery signal. A Degraded Mode never silently widens authority or claims success.
_Avoid_: Best-effort fallback, generic 500

**Recovery Runbook**:
A versioned, owner-approved procedure for detecting, freezing, restoring, reconciling, verifying, and resuming an Anyam capability from a named Recovery Checkpoint. A Runbook records affected data classes, authority, Evidence, roles, and rollback/compensation behavior.
_Avoid_: Retry script, undocumented operations knowledge

**Usage Receipt**:
An immutable attribution record for logical Anyam work and provider consumption, bound to a Hosting Mode, Realm, Project, Source Space, Task/Run, provider resource, quantity/unit, price version when known, retry class, and idempotency source. A Usage Receipt is not an invoice.
_Avoid_: Cloud provider bill, seat count

**Provider Cost Receipt**:
A reconciliation record linking Usage Receipts to provider usage or invoice rows, with consumed and billed quantities, included allocation, corrections, shared overhead, variance, and feed status. A provider feed may be delayed or unavailable without invalidating the Anyam ledger.
_Avoid_: Estimated charge, raw API metric

**Budget Policy**:
A versioned Realm/Organization/Project/Source Space/Target/Task policy that governs resource dimensions, warnings, approvals, degradation, hard tripwires, and reset/reconciliation behavior. A Budget Policy never silently widens authority or hides a requested amount.
_Avoid_: Provider plan, arbitrary timeout

**Budget Decision**:
An explicit allow, warn, approval-required, degraded, or exhausted result for a Budget Policy evaluation, naming scope, configured/provider limit, requested and consumed amount, receipt, expiry/reset, uncertainty, and remediation.
_Avoid_: Rate-limit error, disabled button

**Billing Owner**:
The Hosting Mode-specific principal responsible for provider usage and invoice authority: the customer for Customer-operated and Managed Customer-Account resources, and Anyam for Hosted SaaS resources. Billing Owner does not change Project Content ownership or Anyam capability parity.
_Avoid_: Account owner when billing and authority differ

**Governance Profile**:
A versioned, portable set of identity, policy, audit, retention, residency, encryption, support, recovery, isolation, and compliance-control requirements applied to the same open-source Anyam model. A Profile tightens obligations and produces Evidence; it does not grant access or create a proprietary edition.
_Avoid_: Enterprise tier, compliance checkbox

**Residency Policy**:
A data-class placement and disclosure policy covering source, metadata, indexes, grants, logs, queues, Evidence, Artifacts, backups, mirrors, Runner inputs/outputs, caches, and model context. A provider path that cannot prove the requested placement is rejected or explicitly downgraded.
_Avoid_: Region label, Cloudflare-only claim

**Control Mapping**:
A versioned mapping from a Governance Profile requirement to Anyam policy, Audit Events, Evidence, operational controls, customer responsibility, and qualification status. A Control Mapping is audit preparation, not a certification or legal guarantee.
_Avoid_: Certification, compliance claim

**Extension Manifest**:
A signed/digested, versioned declaration for a RepositoryDriver, Action, Verifier, TargetAdapter, ProjectExperience, IDE integration, AgentSkill, or installed App. It declares mechanics, compatibility, provenance, and requested effects; it never grants Anyam authority.
_Avoid_: Marketplace listing, permission token

**Extension Installation**:
A Realm/Organization/Project-scoped activation record for an Extension Manifest, including exact package digest, trust/provenance, narrowed Capability Grant, policy decision, lifecycle, and revocation state.
_Avoid_: Global plugin, package download

**Target Proposal**:
A normalized result from a TargetAdapter describing a requested provider-side Promotion. Anyam validates Release, Evidence, policy, disclosure, and expected state before a trusted Promotion service applies it.
_Avoid_: Adapter deploy, direct promotion

**Project Forge**:
Anyam's product category: a Git-compatible Project workflow for humans and agents that adds Source Space, Change, Evidence, Release, Target, Capability, and Promotion semantics without replacing exact Git objects or operations.
_Avoid_: GitHub clone, Cloudflare SCM wrapper

**Adoption Path**:
The sequence by which a Project begins local-first, imports existing Git, uses standard clients and optional bidirectional mirrors, and chooses Anyam as canonical only after the owner has evidence of value. An Adoption Path never requires migration at signup.
_Avoid_: Forced migration, repository lock-in
