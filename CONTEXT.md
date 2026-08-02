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
