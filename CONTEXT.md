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

**Source Space**:
An independently versioned source and object-graph boundary with its own visibility, access, licensing, and model-processing policy. Source outside an Actor's authority is not reachable or discoverable through that boundary.
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
A safe composition of the Source Spaces an Actor is entitled to discover and access, containing no references or metadata from inaccessible Source Spaces.
_Avoid_: Sparse checkout, filtered listing

**Project Profile**:
An owner-declared selection of Source Spaces, modules, actions, outputs, and policies for a particular community, commercial, internal, or other Project configuration. Anyam enforces disclosure integrity for the resulting Project View but does not impose a universal definition of functional completeness.
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
A capability-safe representation of an Intent, Change, review, Run, Evidence, Artifact, Release, Target, or activity record for a particular audience. Restricted titles, identifiers, timing, search data, notifications, and context are omitted rather than exposed as permission errors.
_Avoid_: Redacted object when hidden metadata remains discoverable

**Snapshot**:
An immutable, content-addressed representation of source state within one Source Space. In a Git-backed Source Space, an exact Git commit identifies the Snapshot.
_Avoid_: Working tree

**Project Revision**:
An immutable manifest identifying the exact Snapshots that form one coherent Project state across Source Spaces.
_Avoid_: Commit, release

**Intent**:
A desired outcome, problem, request, or hypothesis that motivates work.
_Avoid_: Ticket when referring to the domain object

**Change**:
A stable unit of proposed work that transforms one Project Revision into another.
_Avoid_: Branch when referring to the stable work identity; a pull request is a valid compatibility view

**Change Revision**:
An immutable version of a Change, identified by the exact participating Git commits or other Source Space Snapshots.
_Avoid_: Force-pushed state, patch overwrite

**Workspace**:
An isolated, mutable local or remote environment based on an exact Project Revision and associated with a Change. A local Workspace supports the routine edit, snapshot, diff, undo, and check loop without continuous Realm connectivity.
_Avoid_: Branch when referring to the complete composed environment; use branch for an actual Git ref

**Integration Cohort**:
A set of Changes composed and verified together against an explicit base Project Revision.
_Avoid_: Merge queue when the cohort spans source boundaries or semantics a Git merge queue cannot represent

**Conflict**:
Durable, inspectable state showing that source, symbols, contracts, schemas, dependencies, infrastructure, behavior, visibility, intent, or policy cannot yet be composed safely. A new Change Revision resolves a Conflict; an agent explanation does not.
_Avoid_: Temporary merge error, silently accepted AI resolution

**Landing**:
The policy-governed creation of a new canonical Project Revision from one or more approved Change Revisions. Only trusted Anyam authority performs Landing; developer tools and coding agents publish Change Revisions instead.
_Avoid_: Direct push; use merge for the participating Git operation and Landing for the complete Project transition

**Run**:
An execution of a declared action against exact, immutable inputs.
_Avoid_: Check when referring to the recorded execution

**Build**:
A Run that produces one or more immutable Artifacts from exact commits, Project Revision, dependencies, toolchain, and declared inputs.
_Avoid_: Release, deployment

**Evidence**:
A structured, reproducible assertion about a Snapshot, Change Revision, Run, Artifact, or Release. An unsupported human or agent explanation is not Evidence.
_Avoid_: Green check

**Artifact**:
An immutable output produced from exact source and execution inputs.
_Avoid_: Release, deployment

**Release**:
A named, approved collection of Artifacts, configuration, and Evidence.
_Avoid_: Build, deployment

**Target**:
A destination or channel to which a Release can be promoted.
_Avoid_: Environment when the destination is not a runtime environment

**Promotion**:
A policy-governed state transition that makes a Release current at a Target.
_Avoid_: Merge, rebuild

**Deployment**:
A Promotion to a runtime Target. Deployment uses the already verified Artifacts in a Release and does not rebuild a branch.
_Avoid_: Merge, build, release

**Publication Change**:
A governed Change that creates or extends a less-restricted source lineage from more-restricted source.
_Avoid_: Visibility toggle

**Sealed Verifier**:
A verifier whose implementation or inputs are restricted while its permitted result is disclosed.
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

**Audit Event**:
An immutable, attributable record of an authority-bearing operation, its policy decision, and its result. Audit Events exclude credential values, private model reasoning, and inaccessible Project Content.
_Avoid_: Mutable activity log, model chain of thought

**Operation Log**:
An ordered history of source-control and Workspace operations that supports inspection and safe undo where practical. Undo creates new state and does not erase accepted history or Audit Events.
_Avoid_: Audit Event, destructive history rewrite

**Context Manifest**:
A revision-addressed record of the project context, constraints, tools, policies, and concurrent work supplied to an agent.
_Avoid_: Prompt
