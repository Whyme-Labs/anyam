# Phased delivery program

Status: Accepted

## Context

ADR 0020 defines the four capability stages. Issue [#36](https://github.com/Whyme-Labs/anyam/issues/36)
asked how those stages become an implementation-ready program without turning
speculative dates, staffing, provider limits, or throughput into commitments.
The logic prototype on
[`codex/prototype-phased-delivery`](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-phased-delivery)
(`e6d4c17`) was used to exercise the state model: a stage can start only after
its dependencies complete, and it can promote only after its Evidence is
accepted and its risk spikes are retired.

## Decision

Anyam uses a capability-and-evidence delivery program, not a calendar roadmap.
Every work item belongs to a Workstream and a Stage. A Stage remains active
until its exit Evidence is current, its qualification risks have receipts, and
the owner has recorded any Residual Risk. The previous Stage remains usable
while the next one is built.

Dates, headcount, concurrency, latency, storage, and cost figures are planning
hypotheses only. They become commitments only after a receipt from a working
implementation or an explicitly approved external constraint. A planning
assumption is never a Stage Gate and never silently limits a healthy workload.

### Workstreams

The program has six durable Workstreams. A Workstream is a delivery ownership
boundary, not a mandatory microservice or team chart.

| Workstream | Owns | First integration point | Exit signal |
| --- | --- | --- | --- |
| Kernel and Git compatibility | Project model, Source Spaces, Changes, Git objects, RepositoryDriver, exports | Local scaffold and Git round-trip | A local Project can create, inspect, revise, and export a Change without provider authority |
| Identity and trust boundaries | Realm, authentication, Capability Grants, Source Space disclosure, Secret Use, audit | Explicit `anyam connect` and task grant | A caller receives only the permitted View and cannot bypass canonical Landing |
| Execution and delivery | Actions, Verifiers, Evidence, Artifacts, Releases, Targets, Landing, Promotion | Local checks then Worker Target | A Release is built once, promoted by policy, health-verified, and rollbackable |
| Developer and agent experience | TypeScript scaffold, CLI, Git credential helper, MCP, skills, Context Manifest, web companion | Local human and Codex/Claude/Cursor sessions | A technical user or agent can complete the same Change loop through its preferred interface |
| Hosting and recovery | Cloudflare adapters, customer-operated bootstrap, queues/workflows, backups, restore, degraded modes | Customer Realm install and import | A customer can restore and resume without Anyam-operated authority |
| Adoption and ecosystem | GitHub projections, package/release targets, extensions, docs, support, migration | Import and optional bidirectional mirror | Existing Git users can adopt incrementally and leave with complete portable exports |

The Workstreams share contracts but do not share authority. Kernel and trust
boundaries remain authoritative for source and permissions; execution consumes
their commands and produces Evidence; adoption adapters produce proposals or
projections that the kernel validates.

### Dependency-ordered program

The order below is the critical path. Work inside a row may proceed in
parallel, but the exit gate is the integration point for the next row.

```text
P0 contract qualification
  → P1 local K0 loop
  → P2 customer-operated alpha
  → P3 public beta and team adoption
  → P4 open ecosystem and governance expansion
```

#### P0 — contract qualification and risk spikes

P0 is not a customer release. It converts the accepted ADRs into executable
contracts, fixture definitions, and spike receipts before broad implementation.

Work:

- Freeze versioned Project, Source Space, Change, Evidence, Release, Target,
  Capability, Command, Event, export, and extension contracts.
- Build the Worker, TypeScript CLI/library, and hybrid public/private fixtures.
- Define the validation matrix and the exact disclosure projections for each
  fixture.
- Spike the RepositoryDriver boundary, local MCP broker, canonical-write
  denial, public projection, Evidence validity, and customer Realm restore.
- Record receipts for any provider assumption before placing a number or
  qualification gate in the implementation plan.

Exit: each critical trust-boundary question has either a passing receipt, a
named fallback, or an explicitly owned Residual Risk. No implementation lane
may hide an unresolved P0 question behind a calendar milestone.

#### P1 — K0 local product

P1 is the first installable open-source TypeScript product. It is local-first
and terminal-first; cloud connection is explicit.

Work:

- Kernel and Git compatibility: local Project/Workspace/Change state, Git
  clone/fetch/push, RepositoryDriver interface, export, and durable conflict
  representation.
- Developer and agent experience: `npm create anyam`, package-manager aliases,
  `anyam init`, `anyam check`, `anyam connect`, familiar Git commands, local
  stdio MCP, agent skill, and credential-safe handoff.
- Execution and delivery: local Actions/Verifiers, Evidence validity keys,
  candidate outputs, typed Artifacts, and a dry-run Release/Target model.
- Identity and trust: local Realm/Capability contract and no canonical write
  path from an agent or ordinary Git credential.

Exit: a clean machine can scaffold both reference templates, inspect and
check them, create a Change, run a Verifier, publish a non-canonical revision,
and export the Project. The exit receipt includes the exact toolchain and
source state; it does not claim Cloudflare or multi-tenant readiness.

#### P2 — customer-operated private alpha

P2 proves the thesis in one customer-controlled Cloudflare Realm.

Work:

- Hosting and recovery: install/bootstrap, owner enrollment, import staging,
  Recovery Checkpoints, backup/restore, and degraded modes.
- Identity and trust: passkey plus one OIDC path, Source Space disclosure,
  task-scoped grants, Secret Use brokerage, and immutable audit.
- Execution and delivery: bounded Cloudflare execution, Worker preview,
  Release/Promotion/health verification/rollback, and generic release assets.
- Adoption and ecosystem: existing Git import and a minimal Project web
  companion; no forced SaaS account and no mirror requirement.
- Developer and agent experience: local Codex, Claude Code, and Cursor plus a
  bounded hosted-agent path if its provider receipt is sufficient.

Exit requires the Worker, TypeScript CLI/library, and hybrid-source fixtures to
complete the Validation Journeys in ADR 0021, including failed import recovery,
public/private disclosure, agent isolation, Evidence staleness, guarded
Landing, Release/Promotion provenance, and rollback. The customer can restore
the Realm and Project without Anyam-operated authority.

#### P3 — public beta and team adoption

P3 broadens distribution only after P2 Evidence is current and critical trust
boundaries have no unowned Residual Risk.

Work:

- Multiple Realms, teams, review/approval separation, Policy Explanations,
  quotas and receipt-backed usage attribution.
- Qualified Cloudflare RepositoryDriver plus a generic Git-compatible fallback
  or migration path.
- Bidirectional GitHub mirroring as an explicit projection with one Anyam
  canonical authority; inbound divergence becomes a local Change.
- External pull Runner protocol and one qualified non-Cloudflare Runner.
- npm and generic downloadable release Targets.
- Public Project pages, safe contributions, documentation, support, and
  export/import rehearsal.

Exit requires a team Validation Journey, a mirror divergence/recovery Journey,
an external Runner Journey, a package/release Target Journey, and a new
customer-operated installation Journey. Public beta is not a claim of broad
provider, runner, registry, or framework coverage.

#### P4 — open ecosystem and governance expansion

P4 adds open adapters and administration without changing the kernel.

Work includes Governance Profiles, SAML/SCIM adapters, specialized Runners,
additional project-type and Target adapters, extension distribution,
discovery/Pages/discussions, preservation, and federation experiments.

Every P4 capability has its own versioned contract, trust/authority analysis,
qualification gate, export behavior, deprecation path, and rollback behavior.
P4 does not create a proprietary enterprise edition or remove first-party
capability from the open-source server.

### Program integration rules

1. **One canonical authority.** A provider, mirror, queue, workflow, cache,
   read model, or external Runner never becomes authority by observation.
2. **One reusable Change path.** Human, local agent, remote agent, and import
   flows converge on the same Change, Evidence, Landing, Release, and
   Promotion contracts.
3. **One gate vocabulary.** Every exit condition names its Evidence key,
   validity inputs, disclosure projection, and Residual Risk owner.
4. **One visible failure state.** Missing, stale, failed, or indeterminate
   Evidence blocks the relevant gate and reports the budget, limit, or missing
   receipt when a limit is involved.
5. **One recovery story.** Each state-changing integration has a checkpoint,
   idempotency key, reconciliation path, and operator runbook before it is a
   Stage dependency.
6. **One portability boundary.** Cloudflare, GitHub, package registries,
   model providers, and specialized Runners remain adapters behind open
   contracts.

### Work-item decomposition

Implementation tickets should use this shape, rather than calendar epics:

```text
<stage>/<workstream>/<capability>
  contract → spike → implementation → fixture journey → gate receipt
```

For example:

```text
P1/kernel/git-roundtrip
P1/agent/local-mcp-broker
P2/trust/public-projection
P2/delivery/worker-promotion
P3/adoption/github-two-way-mirror
P3/hosting/external-runner
```

Each ticket records: the contract version, owner role, dependencies, exact
fixture or Validation Journey, expected Evidence, recovery behavior, and the
Residual Risk decision. Staffing and concurrency remain hypotheses until the
ticket produces a receipt from actual work.

### Prototype verdict

The throwaway terminal prototype confirmed the program shape is understandable
when it exposes, after every action:

- stage status and dependency blockers;
- current owner, staffing hypothesis, Workstreams, and integrations;
- every Evidence item and risk spike;
- the remaining critical path; and
- a gate message that names the missing receipt or open risk.

It also exposed the important invariant: a Stage may be active while its gate
is blocked, but it cannot promote until all dependencies, Evidence, and risk
spikes are resolved. The prototype is preserved on its branch as a primary
source; only this decision belongs on `main`.

## Consequences

Anyam can be implemented by parallel Workstreams without losing the simple
end-to-end path. A contributor can pick up a capability ticket and see what it
must integrate with, what receipt closes it, and which later Stage depends on
it. The program remains honest about unknown provider limits and staffing.

The cost is that “done” is slower to declare than code compiling. That is
intentional: a Stage is a product capability boundary, not a collection of
merged branches. The program also requires maintaining fixtures, Evidence
validity, recovery runbooks, and Residual Risk ownership as first-class work.
