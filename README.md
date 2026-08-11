# Anyam

Anyam is an open-source, Git-compatible project SCM for humans and coding
agents. It composes independently governed Source Spaces into Project
Revisions, verifies declared work, and moves immutable Releases through
Targets. Familiar Git objects and operations remain the compatibility surface;
Anyam-specific objects exist only where the semantics exceed Git.

## Product boundary

The repository contains four cooperating layers:

- **Kernel**: Projects, Source Spaces, Project Views, Changes, Evidence,
  Artifacts, Releases, Targets, policy, provenance, and export contracts.
- **Developer and agent interfaces**: the `anyam` CLI, Git credential helper,
  local/remote MCP boundaries, portable agent instructions, and standard Git
  workflows.
- **Cloudflare adapters**: customer-operated Realm, Durable Object
  coordination, Workers, D1, R2, Queues, Workflows, and Sandbox/Container
  execution boundaries.
- **Provider and runner adapters**: replaceable Git providers, public mirrors,
  package/deployment targets, and pull-based runners for workloads Cloudflare
  cannot execute natively.

Anyam itself is open source. A Project may be fully open source, hybrid source
(for example, a public video player with a private codec Source Space), or
closed source. A public Project View is a real projection: inaccessible source
objects and metadata are not reachable from the public Git graph. Anyam does
not claim to prove that a selected public composition is functionally complete;
that remains an owner-declared Project Profile concern.

## Current qualification status

This checkout is a private-alpha implementation and qualification surface, not
a hosted production service. A green local gate means that the checked-in
TypeScript, deterministic tests, package entrypoints, Worker source route
contracts, and Wrangler dry-run bundles passed together. It does **not** prove:

- Cloudflare production capacity, pricing, or SLOs;
- that a provider beta or API is generally available;
- production deployment, domain, secret, or data-migration safety;
- universal support for every project type or runner architecture;
- a security certification, compliance attestation, or independent audit.

Live qualification receipts remain bounded observations. They must not be
turned into Anyam limits without a fresh measurement receipt. Provider facts
are not Anyam budgets.

## Local gate

Use Node.js and the locked npm workspace as the repository-authoritative
development path:

```bash
npm ci
npm run check
```

The gate typechecks kernel code, all checked-in qualification scripts, every
Worker TypeScript entrypoint, runs the repository tests, packs and exercises
the `create-anyam` npm/pnpm/Bun entrypoints, and performs source-plus-bundle
route smoke checks for every deployable Worker. Wrangler runs in dry-run mode;
no Cloudflare deployment or credential is performed by the gate.

For individual surfaces:

```bash
npm run verify:workers
npm run verify:package
npm run build:realm
```

## Start a project

The package is intentionally package-manager friendly:

```bash
npm create anyam demo
cd demo
npm install
npx create-anyam check
```

Use normal Git for source transfer. Use the Anyam CLI/MCP boundary for Change,
Workspace, Run, Evidence, Release, and Target operations. Agents receive
task-scoped authority; they never receive canonical repository write authority
or raw production secrets.

## Repository and issue tracker

The canonical repository is
[`Whyme-Labs/anyam`](https://github.com/Whyme-Labs/anyam). GitHub Issues are the
authoritative implementation tracker. The working vocabulary and engineering
rules are in [`AGENTS.md`](AGENTS.md); the domain vocabulary is in
[`CONTEXT.md`](CONTEXT.md).
