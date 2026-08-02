# Terminal-first end-to-end developer experience

Status: Accepted

## Context

Anyam must serve technical users first without making agent-assisted or
non-technical work feel like operating a Git server. The experience spans
Project creation or import, Intent, Workspace editing, Change Revisions,
Candidate Outputs, review, Landing, Releases, Promotion, monitoring, and
rollback. Those states must remain distinct even when a low-risk solo workflow
can pass through them with one command.

Issue [#18](https://github.com/wms2537/anyam/issues/18) asked for a tested
low-fidelity information architecture across solo developers, team developers,
public contributors, maintainers, reviewers, and operations owners. The
throwaway prototype was tested on branch
[`codex/prototype-end-to-end-dx`](https://github.com/wms2537/anyam/tree/codex/prototype-end-to-end-dx),
commit `d4587c5`, with three radically different variants. The owner selected
the terminal-first variant after reviewing the local prototype.

## Decision

### Terminal-first is the primary work surface

Technical users begin with a familiar command and source workflow. Anyam keeps
the active Change, Workspace, revision, checks, Candidate Output, review state,
and delivery state visible without requiring the user to navigate a project
management hierarchy first.

The canonical flow is:

```text
Create or import Project
  → create or select Intent
  → materialize Workspace
  → edit with Git-compatible tools or an agent
  → publish Change Revision
  → run checks and create Candidate Output
  → review
  → Land approved Change Revision
  → create immutable Release
  → Promote Release to Target
  → verify health or create a rollback Promotion
```

The CLI exposes this flow with Git-compatible nouns and explicit state
transitions. Representative commands are:

```text
anyam project create <name>
anyam clone <project-or-view>
anyam change start
anyam change status
anyam change publish
anyam check
anyam preview open
anyam review request
anyam land
anyam release create
anyam promote <target>
anyam rollback <target>
```

The exact command surface may evolve, but a command must not silently combine
Landing, Release creation, and Promotion when the policy or user needs to see
those boundaries. A convenience command may orchestrate them only when it
reports each resulting state and any blocked transition explicitly.

### The web UI is a companion control surface

The web Project view is not a separate workflow or a terminal emulator. It
renders the same state as the CLI and offers the next permitted action beside
the current Change. Its primary surfaces are:

```text
Project
├── Overview
├── Code
├── Changes
├── Deployments
└── Settings
```

Runs, Evidence, Artifacts, Releases, Targets, Workspaces, Source Spaces,
Capability Grants, and agent sessions appear in the relevant Change or
Deployment context. They are not mandatory top-level navigation for ordinary
work.

The selected terminal-first composition uses:

- a visible command/history stream for source-control fluent users;
- a delivery panel showing the current Release, Target health, provenance, and
  rollback readiness;
- shortcuts into Source, Evidence, and Agents;
- an advanced disclosure surface for Source Spaces, grants, Evidence freshness,
  and policy explanations.

The UI must never imply that a `git push`, Change Landing, or Release creation
has already changed a Target. Current canonical source, current Release, and
current Target state remain separately legible.

### Progressive ceremony is policy-driven, not role-specific product modes

The same Project, Intent, Workspace, Change, Evidence, Release, and Target
objects serve every actor. Policy determines the next action:

| Actor | Primary experience |
|---|---|
| Solo developer | Direct low-risk path from an evidenced Change to Landing and Promotion |
| Team developer | Publish a Change Revision and submit it for review and Integration Cohort evaluation |
| Public contributor | Work from a disclosed Project View and open a Change without discovering restricted Source Spaces |
| Maintainer | Inspect the composed Project Revision and Land approved Changes |
| Reviewer | Evaluate Intent, semantic effects, Candidate Output, Evidence, and findings |
| Operations owner | Promote an immutable Release, inspect health, and perform a guarded rollback |

The interface explains the current blocker and the permitted next transition;
it does not hide governance behind a disabled button or require users to learn
an enterprise-specific mode.

### Agents use the same Change surface

Codex, Claude Code, Cursor, and other agents edit the Workspace through their
native interfaces. The Anyam CLI, Git Gateway, and MCP surfaces expose the
same Change state. The web UI shows observable agent activity, revision
history, checks, and policy decisions, not private model reasoning.

A user may hand work from one agent to another only from an accepted Change
Revision. Anyam creates a new task session and revokes the previous session;
agents do not share one mutable Workspace concurrently.

### Advanced primitives remain discoverable

Source Spaces, Project Views, Capability Grants, Evidence freshness, policy
versions, and provenance are essential for correctness but are not the first
screen for ordinary editing. They are reachable from the active Change,
Deployment, or Settings context and are shown when the current operation needs
them.

## Consequences

- Technical users retain a fast, local-first path built around Git, the CLI, and
  their preferred coding agent.
- Less technical users can describe an Intent and inspect a Candidate Output or
  Release through the web companion without learning every Anyam primitive.
- The same state is available through CLI, web, MCP, and API surfaces; no
  surface becomes a second source of truth.
- Landing, Release creation, Promotion, health verification, and rollback must
  remain independently represented in commands, UI labels, audit events, and
  policy explanations.
- The CLI and web UI need a parity contract for Change state, blockers, next
  actions, and provenance before the team product is considered complete.
- Anyam can evolve the web information architecture without changing the
  source and delivery model because the terminal-first choice is an experience
  decision over the canonical domain objects.

## Rejected alternatives

- **Control room as the primary surface:** useful for monitoring and team
  coordination, but it makes the Project dashboard the first-class workbench
  for users who already have an editor and terminal. It remains a valid web
  layout pattern for later overview pages.
- **Lifecycle timeline as the primary surface:** makes the state machine clear,
  but is slower for repeated technical iteration and hides the familiar source
  workflow. It remains useful for onboarding and non-technical explanations.
- **Separate solo, team, and agent modes:** duplicates state machines and makes
  policy transitions surprising. Progressive Ceremony uses one model with
  different required approvals.
- **Top-level navigation for every advanced primitive:** exposes implementation
  concepts before the user needs them and turns the Project into an
  operations console. Contextual disclosure preserves discoverability without
  clutter.
- **One `deploy` action that merges source and changes production:** conflates
  Landing, Build, Release, and Promotion, making provenance and rollback
  ambiguous.

