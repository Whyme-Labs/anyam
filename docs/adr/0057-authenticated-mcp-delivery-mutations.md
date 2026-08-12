# ADR 0057: Authenticated MCP delivery mutations

## Status

Accepted for the private-alpha delivery plane.

## Context

The remote MCP resource already supported safe Project, Workspace, Change,
Run, Evidence, and Artifact operations. Delivery state was only reachable
through owner-authenticated REST routes, which forced a coding agent to leave
the semantic MCP boundary for Landing, Release, Target, and Promotion
requests.

The missing capability must not become a second delivery implementation. It
must reuse the closed REST-compatible command contracts and the serialized
Authority Coordinator while preserving the distinction between recording an
Anyam transition and executing a customer provider operation.

## Decision

1. Expose four typed MCP tools: `landing.apply`, `release.create`,
   `target.configure`, and `promotion.request`.
2. Filter each tool by its own OAuth scope: `landing.request`,
   `release.create`, `target.configure`, or `promotion.request`.
3. Require the encrypted OAuth grant to contain the provider-issued opaque
   `anyamGrantId` handle and the authenticated Realm `kernelSessionId`. The
   handler checks that the handle is present; it never forwards or returns the
   handle, bearer token, Git credential, or provider credential.
4. Reuse the REST command parsers, expected-version checks, idempotency keys,
   Authority Project/Change/Artifact/Evidence/Release/Target lineage checks,
   and safe projection functions. MCP projections are marked
   `canonicalWrite=false` and `typedSurface=mcp`.
5. Map malformed input, hidden resources, stale state, idempotency conflicts,
   session failures, and Coordinator failures to typed JSON-RPC errors with an
   actionable recovery action and a credential-free receipt.
6. Keep provider execution, health verification, rollback, source transfer,
   task-grant issuance, and broad web-console behavior outside these tools.
7. Qualify the boundary with a deterministic fixture that checks all four
   tools, replay determinism, malformed-input rejection before the Coordinator,
   hidden-resource concealment, missing-grant denial, credential-free results,
   and `providerExecution=not-performed`.

## Consequences

- Agents can request the complete typed Anyam delivery sequence through MCP
  without imitating REST or browser behavior.
- The Coordinator remains the only mutation authority, and MCP does not become
  a source-transfer or provider-execution channel.
- Existing REST and MCP paths share one contract parser and projection model;
  drift between agent and owner behavior is reduced.
- A live OAuth grant must be reauthorized when a delivery scope or grant handle
  is missing, and the error names that recovery path.
- Provider deployment and reconciliation remain explicit follow-up operations;
  a successful MCP response is not a claim that anything is live or healthy.

## Evidence

```sh
npm run qualification:mcp-delivery-mutations
node --import tsx --test test/realm-mcp.test.ts
```

The qualification is fixture evidence for the Anyam boundary. It makes no
live Cloudflare, Git, or provider deployment claim.
