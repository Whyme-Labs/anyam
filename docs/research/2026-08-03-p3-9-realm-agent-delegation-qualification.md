# P3-9 Realm-owned agent Actor and human-to-agent delegation qualification

Date: 2026-08-03  
Issue: [Implement Realm-owned agent Actors and human-to-agent delegation](https://github.com/wms2537/anyam/issues/90)  
Protocol: `anyam.agent-delegation-qualification/v1`  
Status: passed with a bounded, Realm-local human-to-agent kernel path

## Question

Can a Realm enroll a first-class agent identity, delegate a bounded Task from a
human Session, issue only narrowed audience credentials, and revoke the full
delegation lineage without weakening cross-Realm isolation or canonical-write
protection?

## Qualification receipt

```text
protocol=anyam.agent-delegation-qualification/v1
status=passed-with-bounded-human-to-agent-kernel
agentProtocol=anyam.agent/v1
delegationProtocol=anyam.delegation/v1
agentRegistry=realm-owned; principal-and-realm-bound
parent=active-human-session-plus-agent.delegate-grant
agentActor=distinct-actor-and-session
task=agentId-and-delegation-lineage-preserved
modelProvider=enrolled-provider-only
credentialAudiences=agent-and-parent-intersection
scope=resource-source-space-action-effect-budget-expiry-narrowing
prohibitedAgentActions=target.promote;policy.manage;identity.manage
canonicalWrite=false
agentRevocation=agent-session-grant-credential-cascade
parentSessionRevocation=descendant-session-task-grant-credential-cascade
humanSessionAfterAgentRevocation=active
crossRealmAgent=denied; no-agent-disclosure
credentialMaterialStored=false
```

## Qualification method

The local `RealmIdentityPolicy` kernel was exercised with separate Realm
instances and deterministic clock receipts. The harness covered:

1. Realm-owned registration of Codex and Claude agents with distinct agent
   clients and allowed credential classes.
2. Human parent Task and Grant with explicit `agent.delegate` authority.
3. Delegation into an agent Actor, Session, Task, and child Grant.
4. Child narrowing for Source Spaces, actions, effects, model provider,
   credential classes, budget, resource, and expiry.
5. Direct agent Grant issuance rejection without a parent Grant.
6. Git and MCP issuance with separate audience validation.
7. Rejection of a provider mismatch and `target.promote` action widening.
8. Agent registration revocation and human parent Session revocation.
9. Cross-Realm agent lookup rejection.
10. Credential-free snapshots and audit lineage.

The passkey authentication used by the fixture is an adapter-style verified
assertion. No live WebAuthn ceremony, OIDC discovery/token endpoint, MCP HTTP
OAuth exchange, Git credential helper, DPoP proof, or external model provider
was exercised by this receipt.

## Commands run

```text
npx tsx --test test/realm-agent-delegation.test.ts — 5 passed
npm run typecheck — TypeScript clean
npm test — 104 passed
git diff --check — clean
```

## Boundary and residual risk

This qualification proves the Realm-owned identity and delegation kernel:
Principal, agent, Actor, Client, Session, Task, parent Grant, child Grant,
credential audience, model provider, revocation lineage, and cross-Realm
boundary are represented and checked together.

It does not claim that Anyam has already qualified production passkeys, OIDC,
MCP OAuth, Git HTTPS credential exchange, provider secret brokering, or live
agent-host execution. Those remain adapter and transport qualifications.

It also does not claim that a public or private Source Space is functionally
complete after a projection. Anyam checks capability and disclosure
boundaries; project authors decide whether the public projection is useful.
