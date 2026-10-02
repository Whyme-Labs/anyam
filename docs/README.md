# Anyam documentation

Anyam is an open, Git-compatible project SCM for people and coding agents. Use
this documentation to move from a local Project to a verified Release without
losing ordinary Git workflows.

## Start here

- [Quickstart](guides/quickstart.md) builds a local TypeScript Project and
  starts a Change.
- [Customer-operated Realm](guides/customer-realm.md) explains how to plan,
  install, inspect, and recover a Realm in your Cloudflare account.
- [Examples](examples/README.md) lists runnable Project examples and the
  qualification fixtures used by the repository gate.

## Work with Anyam

- [Scaffold and CLI](../packages/create-anyam/README.md) covers `npm create
  anyam`, local checks, Changes, agents, GitHub projection, and the hosted
  lifecycle.
- [Git compatibility](adr/0009-cli-git-mcp-agent-connection.md) explains what
  remains ordinary Git and what belongs to Anyam.
- [Source Spaces and public/private Projects](adr/0032-hybrid-public-private-projections-and-sealed-verifiers.md)
  describes structural disclosure.
- [Changes, review, Evidence, and Landing](adr/0035-team-review-integration-cohorts-and-authority.md)
  describes the collaboration path.
- [Releases, Targets, and Promotion](adr/0033-worker-release-promotion-and-rollback.md)
  describes immutable delivery.

## Understand the design

- [Design philosophy](product/design-philosophy.md) states the rules that keep
  source, authority, Evidence, and delivery separate.
- [Architecture](design/architecture.md) maps the Project lifecycle and the
  Cloudflare-first implementation.
- [Product Constitution](product/constitution.md) is the ratified product
  contract.
- [Platform blueprint](blueprint/anyam-platform-blueprint.md) is the complete
  implementation planning baseline.
- [Architecture decision records](adr/) contain the accepted decisions in
  chronological order.
- [Domain vocabulary](../CONTEXT.md) defines the capitalized Anyam terms.

## Operate and extend

- [Production operations and recovery](adr/0092-production-operations-control-room.md)
  explains the state-first operator view and receipt requirements.
- [Repository gate](ci/repository-gate.md) lists the checks that protect the
  repository itself.
- [Artifacts Workspace contracts](qualification/artifacts-workspaces.md) covers
  isolated forks, local evidence and the remaining live demonstration gates.
- [GitHub Actions Bridge](adr/0076-github-actions-oidc-bridge.md) documents
  the no-standing-credential GitHub connection.
- [Site Worker](../apps/site/README.md) explains how to build and deploy the
  static landing, docs, and examples bundle in a customer account.
- [Open-source distribution](research/2026-08-02-open-source-distribution-and-licensing.md)
  records the licensing and portability boundary.

## Reading order for a new contributor

1. Read the [Quickstart](guides/quickstart.md).
2. Read the [Design philosophy](product/design-philosophy.md).
3. Read the [Architecture](design/architecture.md).
4. Pick the relevant guide or ADR from the sections above.
5. Run `npm run check` before opening a Change.

The site at [anyam.whymelabs.com](https://anyam.whymelabs.com) presents the same
path in a shorter form. The repository remains the canonical source for the
documentation.
