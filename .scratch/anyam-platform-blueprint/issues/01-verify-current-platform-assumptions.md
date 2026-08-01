# Verify the current platform and standards assumptions

Type: research
Status: resolved
Blocked by:

## Question

As of the research date, which documented capabilities, limits, pricing, maturity levels, and constraints of Cloudflare Artifacts, Workers, Durable Objects, D1, R2, Queues, Workflows, Containers, Sandbox SDK, Workers for Platforms, OAuth tooling, Access, and relevant MCP/OAuth standards can Anyam safely design against? Produce a source-dated evidence brief that separates confirmed facts, beta dependencies, missing capabilities, and assumptions requiring a spike.

## Answer

The source-dated resolution is recorded in [Anyam platform and standards assumptions](../../../docs/research/2026-07-31-platform-and-standards-assumptions.md).

Cloudflare is a viable control-plane and bounded Linux-execution substrate for Anyam, subject to the following architectural baseline:

- Workers serve the web, REST, Git-authentication gateway, webhooks, and remote MCP resource; they are not the general build runner.
- SQLite-backed Durable Objects serialize protected project transitions, leases, idempotency, landing, and urgent authorization state. D1 is a sharded, rebuildable query layer rather than mutation authority.
- R2 holds immutable evidence, artifacts, logs, exports, and large objects. Queues are at-least-once and unordered, so consumers must reconcile idempotently. Workflows orchestrate retries and approvals but are not the permanent ledger.
- Containers and Sandbox are GA and form the default bounded `linux/amd64` execution lane. `RunnerDriver` plus zero-trust pull runners is required for macOS, Windows, ARM, GPUs, hardware, private networks, and larger workloads.
- Workers for Platforms is an optional hosted customer-application plane. Anyam's control plane remains outside dispatch namespaces, and release design cannot assume gradual user-Worker deployments.
- Cloudflare Artifacts remains a closed beta. It is the preferred repository provider only after qualification; `RepositoryDriver`, a generic Git fallback, full-history export, and a tested migration path are launch requirements. Its current repository-level read/write tokens reinforce the rule that only the landing service writes canonical source.
- Anyam owns Realm identity mapping, authorization, delegation, consent, revocation, and audit. Cloudflare Access and the Workers OAuth Provider library may supply upstream identity, perimeter policy, and OAuth plumbing but cannot replace Source Space, Change, agent, verifier, or Target policy.
- Remote MCP follows the current 2026-07-28 project-scoped HTTP authorization profile; local tools use an authenticated stdio broker. RFC 9728 discovery, RFC 8707 resource indicators, exact audience validation, S256 PKCE, issuer validation, and token non-passthrough are mandatory.
- OAuth token exchange, device authorization, Rich Authorization Requests interoperability, DPoP, Client ID Metadata Documents, D1 read replication, the new MCP SDK generation, and universal MCP-client compatibility remain conditional until their named spikes pass.

The brief defines 22 bounded proof gates covering repository qualification and fallback, cross-space landing recovery, Durable Object and D1 scale, asynchronous idempotency, workflow recovery, managed and external runners, Workers for Platforms delivery, OAuth hardening and revocation, MCP clients, credential audience isolation, and safe public projection. Later tickets must consume those gates rather than restating current documentation as proven runtime behavior.
