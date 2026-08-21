# ADR 0071: Bounded, provider-replaceable repository gates

## Status

Accepted on 2026-08-21.

## Context

The historical private-alpha PR #135 combined many authority-bearing layers. It
was merged before this review, so rewriting its history would be destructive and
would not improve the current release path. The durable correction is to keep
future authority changes in bounded PRs and make the repository gate explain the
runner/provider boundary.

The GitHub-hosted gate for commit `eceac957346e9bdc2c9ea5f5218075270b02b5dc`
did not start. The check annotation said: “The job was not started because
recent account payments have failed or your spending limit needs to be
increased.” That is a provider receipt, not a TypeScript or Anyam gate result.

## Decision

1. The repository gate remains a convenience projection. Anyam authority never
   depends on GitHub Actions or Blacksmith.
2. Every third-party workflow action is pinned to an immutable commit SHA.
3. The local gate runs both `npm audit --audit-level=high` and the workflow-pin
   validator before the type, test, package, and Worker checks.
4. The gate records a provider-neutral runner receipt containing the selected
   provider, runner identity, exact commit, and no credential material.
5. Blacksmith execution is the default. A Realm/organization operator must
   install its GitHub organization integration; the repository variable
   `ANYAM_REPOSITORY_GATE_PROVIDER=github-hosted` or an explicit
   `github-hosted` manual `workflow_dispatch` run is the recovery fallback.
6. The Blacksmith runner label is an adapter fact, not an Anyam limit. The
   provider may be replaced without changing the gate contract.

## Bounded stack map

The following layers are the required review boundaries for future changes. A
PR that crosses more than one authority-bearing layer must explain the crossing
and add the corresponding threat tests and ADR links.

| Layer | Primary paths | Authority introduced |
| --- | --- | --- |
| Contracts | `src/kernel`, `src/harness` | typed state and error contracts |
| Repository identity | `src/repository` | stable repository/project identity |
| Workspace Runner | `src/execution/runner.ts`, `apps/runner-qualification` | isolated execution and leases |
| Realm authentication | `src/identity`, `apps/realm-worker/src/passkey-owner.ts` | principal/session authority |
| Realm policy | `apps/realm-worker/src/authority-edge.ts`, `src/identity/realm.ts` | capability decisions |
| Agent delegation | `apps/realm-worker/src/mcp-delivery-grant.ts` | human-to-agent delegation |
| Runner attestation | `src/execution/runner.ts` | signed completion authority |
| Git gateway | `apps/realm-worker/src/*repository*`, `src/repository` | source transfer authority |
| Delivery executor | `src/delivery`, `apps/promotion-executor` | promotion authority |
| Public gateway | `apps/public-gateway-worker` | public ingress and moderation |
| Qualification/docs | `scripts/qualify-*`, `docs/adr`, `docs/research` | provider receipts only |

This is a review map, not a promise that historical commits can be split
without changing history.

## Consequences

- A failed provider job cannot be reported as a failed Anyam implementation.
- A green remote gate proves the checked revision and runner receipt only; it
  does not prove Cloudflare, GitHub, Blacksmith, or customer-owned authority.
- A local gate can fail closed when dependency advisories or unpinned actions
  appear.
- The next authority-bearing PR can be reviewed against one bounded surface
  instead of a repository-wide integration program.

## Non-claims

This ADR does not claim that Blacksmith is installed for `Whyme-Labs`, that a
remote gate has run successfully after the billing failure, or that GitHub
Actions is Anyam's permanent execution provider.
