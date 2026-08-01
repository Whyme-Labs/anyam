# Anyam

Anyam is a project source-control and software-delivery system in which humans and agents transform governed source state into verified releases.

## Language

**Realm**:
The identity, authorization, policy, and collaboration boundary operated by one Anyam installation.
_Avoid_: Instance account, global account

**Organization**:
A group of principals, teams, and projects governed together inside a Realm.
_Avoid_: Realm, tenant

**Project**:
The logical product, system, library, model, document set, or other body of work managed as one unit.
_Avoid_: Repository, application

**Source Space**:
An independently versioned source domain with its own visibility, access, licensing, and model-processing policy.
_Avoid_: Private folder, hidden branch

**Project View**:
A safe composition of the Source Spaces an actor is entitled to discover and access.
_Avoid_: Sparse checkout, filtered listing

**Snapshot**:
An immutable, content-addressed representation of source state within one Source Space.
_Avoid_: Working tree, branch

**Project Revision**:
An immutable manifest identifying the exact Snapshots that form one coherent Project state across Source Spaces.
_Avoid_: Commit, release

**Intent**:
A desired outcome, problem, request, or hypothesis that motivates work.
_Avoid_: Ticket when referring to the domain object

**Change**:
A stable unit of proposed work that transforms one Project Revision into another.
_Avoid_: Branch, pull request

**Change Revision**:
An immutable version of a Change.
_Avoid_: Force-pushed state, patch overwrite

**Workspace**:
An isolated, mutable environment based on an exact Project Revision and associated with a Change.
_Avoid_: Branch

**Integration Cohort**:
A set of Changes composed and verified together against an explicit base Project Revision.
_Avoid_: Merge queue

**Run**:
An execution of a declared action against exact, immutable inputs.
_Avoid_: Check when referring to the recorded execution

**Evidence**:
A structured, reproducible assertion about a Snapshot, Change Revision, Run, Artifact, or Release.
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
A human, agent, or service that performs an operation.
_Avoid_: User when the performer may be an agent or service

**Session**:
One authenticated execution context through which an Actor operates.
_Avoid_: Account

**Capability Grant**:
Narrow, temporary authority delegated to an Actor for specified resources, effects, and constraints.
_Avoid_: Personal access token, role

**Context Manifest**:
A revision-addressed record of the project context, constraints, tools, policies, and concurrent work supplied to an agent.
_Avoid_: Prompt
