# Positioning, documentation, and adoption

Status: Accepted

## Context

Anyam is broad enough to be mistaken for a GitHub clone, a Cloudflare product
wrapper, an AI coding agent, or a deployment platform. Each description hides
the durable value: a project-level change and delivery model that lets humans
and agents work across public/private trust boundaries and produce verified,
portable Releases.

Issue [#34](https://github.com/Whyme-Labs/anyam/issues/34) asked for the category,
differentiation, open-source promise, Cloudflare relationship, developer
workflow, agent neutrality, public/private model, terminology, documentation,
onboarding, and adoption path.

## Decision

### Category

Anyam is:

> **A Git-compatible project forge for humans and agents.**

It is not positioned as “a better GitHub,” “Cloudflare SCM,” or an AI model.
Git remains the compatibility and source-object transfer layer. Anyam adds
Project, Source Space, Change, Evidence, Release, Target, Capability, and
Promotion semantics where a repository/branch/PR workflow is insufficient.

### Primary differentiation

The durable promise is:

> **One coherent Project, multiple Source Space trust boundaries, verified
> Changes, and portable Releases.**

Agent integrations, Cloudflare execution, package registries, and mirrors are
important adoption surfaces, but they are adapters and distribution paths. The
source/control model is the product's durable center.

### Open-source and Cloudflare promise

Anyam's complete first-party platform—server, CLI, web companion, contracts,
schemas, and documentation—is open source and customer-operable on Cloudflare.
There is no proprietary enterprise edition and no hosted-only first-party
capability.

The relationship is:

> **Cloudflare-first, not Cloudflare-hostage.**

Cloudflare is the default control plane, managed execution lane, and optional
application Target. RepositoryDriver, Execution/Runner, Artifact, Target,
Identity, and Project Export boundaries remain portable. Customer recovery must
not depend on an unqualified beta provider or an Anyam-operated account.

### Initial audience and adoption

The primary audience is technical founders, solo developers, and small
engineering teams using multiple coding agents, especially those building
Cloudflare applications, libraries, tools, and hybrid public/private Projects.

Non-technical builders are a first-class secondary audience. They use the same
Project/Change workflow through agent-guided progressive disclosure, not a
separate product or hidden safety model.

Adoption is alongside GitHub before it is replacement:

```text
import existing Git
  → work with standard Git clients
  → mirror GitHub bidirectionally when desired
  → prove Anyam value through Changes/Evidence/Releases
  → make Anyam canonical only when the owner chooses
```

No developer is required to migrate a repository at signup. GitHub, Codeberg,
GitLab, and generic Git remain contribution/discovery or provider projections;
Anyam remains the canonical authority when selected.

### Primary examples

Public documentation leads with three examples:

1. A Cloudflare Worker application: source → Change → preview → verified
   Release → Target Promotion → rollback.
2. A TypeScript CLI or library: source → Build → typed Artifact → release asset
   or npm Target, without assuming a live web runtime.
3. A public video player with a private codec: a hybrid Project whose public
   Source Space is cloneable while the private Source Space remains protected.
   Anyam proves disclosure integrity; the owner decides whether the public
   Profile is functionally complete.

These examples demonstrate generality and the hybrid-source differentiator
without claiming a framework matrix or universal buildability.

### Agent neutrality

Anyam promises:

> **Use the coding agent you already prefer.**

Codex, Claude Code, Cursor, local/custom agents, and future clients use the
same Git, CLI, MCP, Context Manifest, Capability Grant, Workspace, Evidence,
and Change contracts. Anyam owns the trust, workspace, verification, and
delivery path; it does not own the model or private reasoning.

### Onboarding message

The first-run message is:

> **Scaffold locally, connect explicitly, then ship a verified Change.**

The technical path is:

```text
npm create anyam (or npx/pnpm/bun create anyam)
  → inspect local TypeScript scaffold
  → anyam init / anyam check
  → anyam connect (explicit Realm/Hosting Mode confirmation)
  → agent or human creates a Change
  → Evidence and Candidate Output
  → Landing → Release → Promotion
```

Scaffolding never authenticates, creates a Realm, provisions cloud resources,
or stores credentials implicitly.

### Documentation architecture

Docs are organized by user task and trust boundary:

```text
Start Here
Scaffold and anyam CLI
Git compatibility and migration
Agents (Codex / Claude Code / Cursor / custom)
Source Spaces and public/private Projects
Changes, review, Evidence, and policy
Artifacts, Releases, Targets, and Promotion
Customer-operated Cloudflare installation
Operations, recovery, security, and Governance Profiles
Extension and integration reference
Protocol/API/manifest schemas
```

Internal service topology is not the primary navigation. Each guide states
the normal path, hidden authority boundary, failure behavior, and next command.
Advanced surfaces appear when a Project, Change, Target, or Governance Profile
requires them.

### Terminology migration

Use Git words whenever they name exact Git objects or operations: repository,
commit, branch, clone, fetch, push, tag, diff, and merge. Use Anyam terms only
when semantics exceed Git:

| Familiar surface | Anyam meaning |
| --- | --- |
| Pull request | A compatibility view over a Change |
| Branch/worktree | One possible Workspace implementation, not the complete Project Workspace |
| Status check | A view over Run/Evidence, never authority by itself |
| Merge | The participating Git operation inside a Landing |
| Deploy | A Promotion to a runtime Target |
| Private folder | Never a Source Space; use a separate protected source graph |

The CLI uses familiar commands first (`init`, `clone`, `status`, `diff`,
`commit`, `push`, `pull`, `check`, `change`, `ship`) and adds Anyam-specific
verbs only where the operation has no honest Git equivalent.

## Consequences

This narrative lowers adoption cost without reducing the ambition of the
kernel. It gives a technical user an obvious first command, a team a safe
migration path, and an agent a stable semantic interface. It also makes
Cloudflare's value concrete without promising that Cloudflare or Anyam is the
only possible execution/provider path.

The cost is resisting familiar but inaccurate category shortcuts. A product
page that says “AI pull requests on Cloudflare” may convert a click but would
erase the Source Space, Evidence, portability, and open-source commitments that
Anyam must make load-bearing.
