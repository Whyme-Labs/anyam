# Anyam platform and standards assumptions

**Research date:** 31 July 2026

**Evidence policy:** Only current first-party Cloudflare documentation, the official MCP specification, IETF Datatracker, and published RFCs are used.

**Decision status:** Architecture baseline for planning. Any item marked **conditional** or **spike** is not a production commitment.

## Executive decision

Anyam can safely use Cloudflare as its control-plane substrate, but it cannot safely make Cloudflare Artifacts or the newest MCP SDK generation an irreplaceable production dependency yet.

The production-safe baseline is:

- Workers for the web, REST, Git-authentication gateway, webhooks, and MCP resource server.
- SQLite-backed Durable Objects for serialized project coordination, idempotency, landing locks, leases, and authorization epochs.
- D1 for queryable catalogues and rebuildable read models.
- R2 for immutable artifacts, evidence, logs, exports, and large objects.
- Queues for at-least-once asynchronous work, with Anyam-owned idempotency and ordering.
- Workflows for durable multi-step orchestration and approval waits, not as the authoritative ledger.
- Containers and the Sandbox SDK for ordinary Linux/AMD64 builds and agent execution, with external pull runners for other operating systems, architectures, hardware, GPUs, larger jobs, and private networks.
- Workers for Platforms for hosted customer applications, not for Anyam's own control plane or general CI.
- An Anyam Realm for identity mapping, project authorization, task delegation, capability grants, consent, revocation, and audit.
- Project-scoped HTTP MCP resources using the 2026-07-28 authorization profile, with a local authenticated stdio broker for local agents.

The conditional baseline is:

- Cloudflare Artifacts is the preferred Git repository provider, but it is still a **closed beta**. It must remain behind `RepositoryDriver`, with a tested generic Git fallback and export path.
- Cloudflare's stateless MCP v2 stack is current but young: the MCP SDK is beta, the old `McpAgent` is deprecated, and client support for the 2026-07-28 protocol must be tested.
- D1 read replication is a public beta optimization, not a correctness dependency.
- Cloudflare Access Managed OAuth is an optional upstream identity and perimeter control, not Anyam's project authorization system.
- OAuth token exchange, Rich Authorization Requests, DPoP, device authorization, and Client ID Metadata Documents are useful standards or drafts, but require interoperability spikes before being promised.

The principal architecture rule is:

> Cloudflare supplies managed infrastructure and OAuth transport. Anyam owns the source model, trust boundaries, authorization decisions, evidence, and protected state transitions.

## Maturity and disposition matrix

| Capability | Documented maturity on 31 Jul 2026 | Anyam disposition |
|---|---|---|
| Workers | Production/GA | Adopt for latency-sensitive APIs and gateways |
| Durable Objects | Production/GA; new namespaces use SQLite storage | Adopt for serialized aggregate authority |
| D1 | GA | Adopt for catalogues and rebuildable read models |
| D1 read replication | Public beta | Optional read optimization only |
| R2 | Production/GA | Adopt for immutable large-object storage |
| Queues | GA | Adopt with at-least-once/idempotent semantics |
| Workflows | GA | Adopt for durable orchestration, not source of truth |
| Containers | GA | Adopt for bounded Linux/AMD64 execution |
| Sandbox SDK | GA product, but API recently migrated and deprecated older transports | Adopt behind an execution adapter with a pinned version |
| Workers for Platforms | Production offering | Adopt only for hosted customer applications |
| Artifacts | **Closed beta** | Conditional provider; fallback and exit path required |
| Workers OAuth Provider library | Maintained implementation library, not a managed identity system | Use as toolkit after hardening spike |
| Access Managed OAuth | Documented Access feature | Optional upstream identity/perimeter layer |
| MCP 2026-07-28 | Current official MCP specification; Cloudflare describes support as release-candidate generation | Implement behind version negotiation and a client matrix |
| Cloudflare Agents SDK MCP v2 | MCP SDK `2.0.0-beta.5`; legacy agent deprecated | Conditional implementation dependency |
| OAuth 2.1 | Active Internet-Draft, not an RFC | Follow its direction; use stable RFCs and RFC 9700 as normative baseline |

## Confirmed Cloudflare platform facts

### Cloudflare Artifacts

**Documented state:** Closed beta.

Artifacts is a programmable, versioned storage service that speaks Git. It documents:

- standard Git Smart HTTP access;
- repository creation, inspection, deletion, import, and fork operations;
- repository-scoped read or write credentials;
- Workers bindings, REST APIs, Git clients, and structured repository events;
- isolated repositories as units of work for an agent, user, branch, session, or task;
- synchronous multi-data-center replication and asynchronous object snapshots.

Current material limits and pricing:

| Item | Documented value |
|---|---:|
| Repository size | 10 GB |
| Account storage | 1 TB by default, raiseable by request |
| Repositories and namespaces | Unlimited |
| Git requests | 2,000 per 10 seconds per repository |
| Control-plane requests | 2,000 per 10 seconds per namespace |
| Included operations | First 10,000 operations/month |
| Additional operations | $0.15 per 1,000 |
| Included storage | First 1 GB-month |
| Additional storage | $0.50 per GB-month |

The documented Git surface has important constraints:

- HTTPS Smart HTTP is documented; native SSH is not.
- Clients must use the exact returned `artifacts.cloudflare.net` remote.
- Bearer authentication is preferred; HTTP Basic is a compatibility fallback.
- REST-created repository credentials accept a TTL from 60 seconds to one year and default to 24 hours.
- Clone/fetch supports Git protocol v1 and v2.
- Push uses `receive-pack` v1; protocol-v2 push is not documented.
- Some optional Git v1 capabilities, including `filter` and `include-tag`, are not supported.
- Repository tokens expose `read` or `write`; ref-level or branch-level token restrictions are not documented.
- Public import is documented for public HTTPS remotes.

Artifacts emits events for repository lifecycle operations, imports, forks, pushes, clones, fetches, and credential changes. The reviewed documentation does not establish event ordering, exactly-once delivery, replay semantics, or a transaction spanning repositories.

**Safe design use**

- Map one Source Space or isolated task workspace to one repository.
- Keep canonical repository write authority inside the trusted landing service.
- Give a human or agent write access only to its task repository.
- Consume events as hints that trigger idempotent reconciliation.
- Preserve Git export and provider portability.

**Not safe to assume**

- anonymous public clone;
- SSH;
- ref-scoped write tokens;
- branch protection, review, rulesets, issues, or a forge layer;
- atomic operations across repositories;
- ordered or exactly-once repository events;
- an availability SLA;
- production access outside the closed beta.

**Required gate**

Artifacts cannot be a launch-blocking singleton. Production qualification requires:

1. access and commercial availability;
2. Git client compatibility tests;
3. token mint, revoke, expiry, and replay tests;
4. push concurrency and failure recovery tests;
5. event duplicate, loss, ordering, and reconciliation tests;
6. faithful full-history export/import;
7. a demonstrated secondary `RepositoryDriver`.

Official sources: [overview](https://developers.cloudflare.com/artifacts/), [limits](https://developers.cloudflare.com/artifacts/platform/limits/), [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), [repository concepts](https://developers.cloudflare.com/artifacts/concepts/repositories/).

### Workers

Workers is appropriate for Anyam's control plane, not for compilation or repository materialization.

Current material limits and pricing include:

| Item | Free | Paid |
|---|---:|---:|
| Requests | 100,000/day | Billed with no documented general request-count cap |
| CPU per request | 10 ms | Up to 5 minutes; default 30 seconds |
| Memory | 128 MB | 128 MB |
| Worker size | 3 MB | 10 MB |
| Subrequests | 50 | 10,000 by default |
| Simultaneous outgoing connections/request | 6 | 6 |
| Request body | 100 MB on Free/Pro plan accounts | 100 MB Pro, 200 MB Business, 500 MB Enterprise |
| Paid minimum | — | $5/month |
| Included paid usage | — | 10 million requests and 30 million CPU-ms/month |
| Additional usage | — | $0.30/million requests and $0.02/million CPU-ms |

HTTP wall time has no hard duration limit while the client remains connected, but that does not make Workers a build runner. `waitUntil` work has a 30-second window after response or disconnect. Queue consumers, cron triggers, and Durable Object alarms can have up to 15 minutes wall time.

**Safe design use**

- portal backend, REST, MCP, OAuth endpoints, webhooks, policy entry point, Git authentication and routing;
- streaming control/data gateway where memory remains bounded;
- issuing short-lived downstream credentials after authorization.

**Not safe to assume**

- enough memory, disk, or CPU for arbitrary Git operations and builds;
- unrestricted concurrent outbound sockets;
- long background work after an HTTP response;
- a single Worker bundle can absorb every provider and product integration.

Official sources: [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/).

### Durable Objects

Durable Objects provide uniquely addressed stateful compute with strongly consistent attached storage. SQLite-backed storage and the SQL API are production features. New Durable Object namespaces must use SQLite storage.

Material limits include:

- unlimited object instances;
- 500 classes on Workers Paid and 100 on Free;
- 10 GB per SQLite-backed object on Paid;
- 2 MB maximum combined key/value size;
- 30 seconds CPU by default, configurable to 5 minutes;
- six simultaneous outgoing connections;
- a soft throughput limit around 1,000 requests/second for one object because an object is single-threaded.

Paid pricing includes 1 million requests and 400,000 GB-seconds monthly, followed by $0.15/million requests and $12.50/million GB-seconds. SQLite storage operations follow row-based charging: 25 billion rows read, 50 million rows written, and 5 GB-month are included; additional rates are $0.001/million rows read, $1/million rows written, and $0.20/GB-month. Hibernating WebSockets avoid duration charges while idle.

**Safe design use**

- one project coordinator or narrowly scoped aggregate authority;
- landing serialization and expected-state checks;
- claim/workspace leases;
- idempotency keys and monotonic sequence allocation;
- active grants, revocation epochs, and high-risk online authorization checks.

**Not safe to assume**

- global catalogue scalability through one object;
- arrival order from Queues or the Internet;
- unlimited per-project throughput;
- arbitrary large rows, logs, or source objects.

Official sources: [overview](https://developers.cloudflare.com/durable-objects/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQLite namespace requirement](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/).

### D1

D1 is GA and suitable for relational query views. It is not the atomic authority for cross-space landing.

Material limits:

| Item | Paid value |
|---|---:|
| Databases/account | 50,000 |
| Size/database | 10 GB hard limit |
| Account storage | 1 TB by default, raiseable |
| Queries/Worker invocation | 1,000 |
| Row/BLOB/string size | 2 MB |
| Query duration | 30 seconds |
| Time Travel retention | 30 days |

Each database is single-threaded. Concurrent queries queue, and overloaded databases can reject work. This makes sharding a design requirement for large installations.

Paid usage includes 25 billion rows read, 50 million rows written, and 5 GB-month per month. Additional usage is $0.001/million rows read, $1/million rows written, and $0.75/GB-month. There is no egress charge.

Read replication remains public beta. Sessions/bookmarks can provide sequential consistency, but replication must not be required for correctness.

**Safe design use**

- organizations, projects, memberships, searchable catalogues, denormalized activity, release indexes;
- read models that can be rebuilt from an authoritative event stream or ledger;
- sharded tenancy where databases approach contention or size limits.

**Not safe to assume**

- multi-database transactions;
- high-contention serialized mutation;
- one global database for unbounded SaaS growth;
- read replication as a GA dependency.

Official sources: [overview](https://developers.cloudflare.com/d1/), [release notes](https://developers.cloudflare.com/d1/platform/release-notes/), [limits](https://developers.cloudflare.com/d1/platform/limits/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 changelog](https://developers.cloudflare.com/changelog/product/d1/).

### R2

R2 is suitable for immutable, content-addressed evidence and build outputs.

Material limits and behavior:

- unlimited stored object count and capacity;
- up to 1,000,000 buckets/account;
- 5 TiB maximum object;
- about 4.995 GiB maximum single-part upload and about 4.995 TiB multipart object;
- 10,000 multipart parts;
- one write/second to the same object key;
- strong global consistency for object reads, writes, deletes, metadata, and listing;
- eventually consistent IAM changes, potentially taking about a minute;
- last-writer-wins behavior on the same key.

Standard storage costs $0.015/GB-month, $4.50/million Class A operations, and $0.36/million Class B operations. The monthly free tier includes 10 GB, 1 million Class A, and 10 million Class B operations. Internet egress is free. Infrequent Access storage is cheaper at rest but adds retrieval and higher operation charges.

Presigned S3 URLs support GET, HEAD, PUT, and DELETE. They can live from one second to seven days and can be reused until expiry. They are bearer capabilities, not one-time links. Presigned URLs use the S3 endpoint, not a custom domain.

Location hints are best effort. Jurisdiction restrictions for the EU and FedRAMP offer stronger placement commitments, but jurisdiction cannot be changed after bucket creation.

R2 has native bucket-lock rules with date-, duration-, or indefinite retention. This is useful for evidence retention, but it must be qualified against Anyam's threat and compliance model. R2's S3 compatibility does not implement the S3 Object Lock configuration API or bucket versioning.

**Safe design use**

- immutable artifacts, evidence bundles, logs, Git bundles, exports, large project assets;
- content hashes as keys, with metadata and authorization in Durable Objects or D1;
- direct bounded upload/download using short-lived presigned URLs.

**Not safe to assume**

- one-time presigned URLs;
- compliance-grade WORM behavior without qualifying native bucket locks, administrative removal, and the surrounding Anyam policy;
- SSD-like random access through mounted object storage;
- immediate propagation of IAM policy changes;
- a mutable hot-key coordination model.

Official sources: [limits](https://developers.cloudflare.com/r2/platform/limits/), [pricing](https://developers.cloudflare.com/r2/pricing/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [data location](https://developers.cloudflare.com/r2/reference/data-location/), [bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

### Queues

Queues is GA. Its contract is at-least-once delivery and no ordering guarantee.

Material limits:

- 10,000 queues/account;
- 128 KB/message;
- 100 messages/batch;
- 5,000 messages/second/queue;
- 100 retries;
- up to 14 days retention on Paid; Free retention is 24 hours;
- 25 GB backlog/queue;
- 12-hour maximum pull-consumer visibility timeout;
- 24-hour maximum delivery delay;
- 15-minute consumer wall time and 5-minute CPU;
- one active consumer configuration per queue.

Pull consumers allow external systems to retrieve jobs over HTTP. Billing is per 64 KB write, read, and delete operation. Paid includes one million operations/month, followed by $0.40/million operations; a normal delivered message commonly incurs three operations.

**Safe design use**

- asynchronous repository-event handling, builds, verification, indexing, fan-out, and external pull runners;
- a message carrying an immutable ID, aggregate sequence, idempotency key, and object pointer.

**Required application behavior**

- tolerate duplicates;
- never depend on delivery order;
- persist authoritative state before publishing;
- reconcile external provider state;
- dead-letter and replay poison work deliberately.

Official sources: [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [how Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/), [limits](https://developers.cloudflare.com/queues/platform/limits/), [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/), [pricing](https://developers.cloudflare.com/queues/platform/pricing/), [GA changelog](https://developers.cloudflare.com/queues/platform/changelog/).

### Workflows

Workflows became GA on 7 April 2025. It provides durable multi-step execution, retries, sleep, and waits for external events.

Material limits:

- 30 seconds CPU per step by default, configurable to 5 minutes;
- unlimited wall time within a step;
- 1 MiB maximum non-streaming step result or event payload;
- 1 GB maximum state/instance on Paid;
- sleeps up to one year;
- 10,000 steps by default, raiseable to 25,000;
- 300 instance starts/second/account and 100/second/workflow;
- 2 million queued instances;
- 30-day completed-instance state retention.

The limits page has an internal discrepancy: its prose references 10,000 active instances while its table lists 50,000. Anyam must plan against the lower number until Cloudflare confirms the effective limit.

Workflows cannot be deployed directly inside Workers for Platforms namespaces. Large state and binary outputs belong in R2 rather than step state.

On 10 August 2026, documented step and storage pricing begins. Paid includes 500,000 steps and 1 GB state, then charges $0.80/100,000 steps and $0.20/GB-month, in addition to Workers request and CPU pricing.

**Safe design use**

- verification and release orchestration;
- human approval waits;
- retrying idempotent provider operations;
- long-lived promotion state machines whose authoritative decisions are also recorded in the project ledger.

**Not safe to assume**

- Workflows is the immutable audit ledger;
- every side effect is exactly once;
- large outputs fit in workflow state;
- workflows can execute inside a customer Workers for Platforms namespace.

Official sources: [GA announcement](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/), [limits](https://developers.cloudflare.com/workflows/reference/limits/), [pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

### Containers and Sandbox SDK

Containers and the Sandbox SDK became GA on 13 April 2026. They are suitable for isolated, bounded Linux workloads.

Confirmed constraints:

- Containers run `linux/amd64`.
- The largest documented standard/custom instance is 4 vCPU, 12 GiB memory, and 20 GB disk.
- Container disk is ephemeral.
- Cold starts are commonly documented around one to three seconds.
- Account-level defaults include 1,500 concurrent vCPU, 6 TiB memory, and 30 TB disk allocation.
- Total image storage is 50 GB.
- Sandbox files, processes, and shell sessions disappear when the Sandbox stops.
- The default Sandbox sleep timeout is 10 minutes.
- Sandbox outbound Internet access is allowed by default unless the application configures a deny-by-default policy.
- The outbound proxy can restrict HTTP/HTTPS hosts and inject credentials without exposing values to the process.
- This interception is not a general arbitrary-protocol egress policy.

Container compute is billed while active in 10 ms increments. Workers Paid includes 25 GiB-hours memory, 375 vCPU-minutes, and 200 GB-hours disk monthly; additional rates are $0.0000025/GiB-second, $0.000020/vCPU-second, and $0.00000007/GB-second. Container egress is regionally priced.

The Sandbox SDK recently changed materially:

- HTTP and WebSocket transports were deprecated and scheduled for removal after 9 July 2026.
- RPC is the supported transport.
- desktop support was removed;
- `exposePort()` was replaced by tunnel APIs;
- session defaults changed;
- some documentation may still describe legacy behavior.

**Safe design use**

- Linux builds, tests, linters, static analysis, coding-agent sessions, documentation generation, and preview processes;
- outbound credential brokerage through a deny-by-default proxy;
- R2-backed immutable inputs and outputs.

**Not safe to assume**

- a persistent filesystem;
- macOS, Windows, ARM, GPUs, hardware access, or private-network access;
- workloads beyond 4 vCPU, 12 GiB memory, or 20 GB disk;
- a mounted R2 backup behaves like a local SSD;
- generic TCP/UDP policy enforcement from the HTTP/HTTPS proxy;
- quick tunnels provide their own independent authentication.

Anyam therefore needs a zero-trust pull-runner protocol from the start. Cloudflare execution is the default lane, not the only lane.

Official sources: [GA announcement](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/), [Containers architecture](https://developers.cloudflare.com/containers/platform-details/architecture/), [Sandbox overview](https://developers.cloudflare.com/sandbox/), [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/), [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/), [outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/), [backup/restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/), [2026 deprecations](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/).

### Workers for Platforms

Workers for Platforms is the suitable hosted-application plane when Anyam runs customer applications in Anyam's account. It provides dispatch namespaces, dynamic dispatch, user Workers, outbound Workers, custom domains, and configurable bindings.

Material constraints:

- unlimited user scripts and Durable Object namespaces are documented;
- Cache API is disabled for namespaced scripts;
- eight tags/script;
- gradual deployments are not supported;
- an uploaded user-worker change deploys 100% at once;
- Cloudflare API quotas include 1,200 calls/five minutes/token and 200/second/IP.

Pricing begins at $25/month and includes 20 million requests, 60 million CPU-ms, and 1,000 deployed scripts. Additional usage is $0.30/million requests, $0.02/million CPU-ms, and $0.02/script.

**Safe design use**

- optional hosted customer Worker applications;
- per-application isolation, routing, outbound controls, and bindings;
- application previews and releases through an Anyam-owned deployment adapter.

**Not safe to assume**

- gradual user-worker rollout;
- Cache API availability inside user scripts;
- direct Workflows support within dispatch namespaces;
- suitability for general CI;
- that Workers for Platforms should host Anyam's control plane.

Official sources: [overview](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/), [architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/), [limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/), [pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/).

## Authentication, authorization, MCP, and OAuth baseline

### Trust model

Neither Cloudflare Access nor an OAuth library supplies Anyam's application authorization model.

The required flow is:

```text
External identity or local passkey
        ↓
Anyam Realm authentication and stable local principal
        ↓
Roles, relationships, Source Space policy, explicit denies
        ↓
Human-to-agent task delegation and consent
        ↓
Audience-bound API or MCP access token
        ↓
Online capability decision
        ↓
Separate short-lived Git, runner, installation, or deployment credential
```

Anyam must own:

- mapping `issuer + subject` to a local principal;
- organization, team, project, Source Space, Change, workspace, and Target authority;
- principal-versus-actor identity;
- model-provider trust policy;
- task capability intersection and budgets;
- high-risk online checks and explicit denies;
- revocation and authorization epochs;
- consent and immutable audit.

### Cloudflare Workers OAuth Provider library

`@cloudflare/workers-oauth-provider` is an implementation toolkit, not a turnkey Realm.

It documents OAuth authorization-server and protected-resource plumbing, RFC 9728 and RFC 8414 metadata, bearer validation, audience checks, pre-registered clients, optional Client ID Metadata Documents, optional dynamic registration, optional RFC 8693 token exchange, and RFC 9207 issuer identification.

Important implementation findings:

- the application still owns login, consent, grants, tenant/resource ownership, and operation authorization;
- tokens, grants, clients, and encrypted application properties are stored through KV by the library;
- `allowPlainPKCE` currently defaults to `true`;
- implicit flow, token exchange, dynamic registration, and Client ID Metadata Documents have independent feature flags;
- the library README cites OAuth 2.1 draft-13 while the current IETF draft is draft-15.

V1 hardening defaults:

```ts
allowPlainPKCE: false
allowImplicitFlow: false
allowTokenExchangeGrant: false
```

Anyam must require S256, exact redirect validation, one exact resource audience, and an online Durable Object grant or authorization-epoch check for high-risk operations. KV propagation must not define the urgent revocation window.

Official source: [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider).

### Cloudflare Access Managed OAuth

Access Managed OAuth can provide browser authentication and OAuth discovery in front of a self-hosted MCP resource. Non-browser requests receive `401`; the origin validates the signed `Cf-Access-Jwt-Assertion`; refresh re-evaluates Access policy.

It is useful for:

- upstream SSO, MFA, device posture, network/location controls;
- coarse application access;
- BYOCF enterprise identity integration.

It does not implement Anyam's fine-grained project, source, agent, Change, verifier, or promotion policy. A single Access application spanning several domains shares policies and token validity across those domains. Project-specific audience isolation may therefore require separate applications or an Anyam-issued internal resource token.

This needs a scale spike before choosing one Access application per Realm versus per project.

Official source: [Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

### Cloudflare service tokens

Access service tokens are static client-ID/client-secret pairs used with Service Auth policies. They identify a service, not a human principal delegating to an agent, and they do not carry a Change, workspace, source view, allowed effect, or budget.

They may establish an outer machine identity for a trusted runner or service. They must then be exchanged for a short-lived Anyam job capability. A service token must never be placed in model context or used directly as an agent task token.

Official source: [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

### Current MCP profile

The official site publishes the 2026-07-28 specification as the current MCP generation. Cloudflare's July release describes its implementation as support for the 2026-07-28 release-candidate generation. This mismatch is a maturity warning, not a reason to invent a private protocol.

For HTTP MCP:

- authorization is optional in MCP overall, but a protected Anyam HTTP resource should implement the OAuth profile;
- the resource server exposes RFC 9728 protected-resource metadata;
- clients discover an authorization server using RFC 8414 or OIDC discovery;
- clients send an RFC 8707 `resource` indicator in authorization and token requests;
- the resource server validates the exact token audience;
- tokens use the `Authorization: Bearer` header, never a query string;
- MCP tokens must not be passed through to upstream services;
- missing or invalid authorization returns `401`; insufficient authority returns `403`;
- refresh tokens are optional;
- RFC 9207 issuer identification should be emitted and validated;
- Client ID Metadata Documents are preferred for new clients, while dynamic registration remains a compatibility path;
- operation-specific scope step-up is possible.

For local stdio MCP:

- do not run the HTTP OAuth flow;
- use `anyam mcp serve --stdio` as a local authenticated broker;
- keep refresh and bearer credentials in the OS keychain/broker, never in project MCP configuration or model context.

The 2026-07-28 protocol also makes material transport changes: it is stateless, removes the former initialization/session requirement, adds discovery/listen behavior, and deprecates several older mechanisms. Cloudflare's stateless handler uses MCP SDK `2.0.0-beta.5`, while `McpAgent` is deprecated and frozen.

Anyam must therefore version-negotiate and test current Codex, Claude Code, Cursor, and SDK clients rather than claim universal compatibility from a spec-compliant server alone.

Official sources: [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/), [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog/), [Cloudflare handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [Cloudflare MCP SDK v2 migration](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/), [Cloudflare July 2026 release](https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/).

### Standards maturity

| Standard | Current status | Anyam decision |
|---|---|---|
| OAuth 2.1 | Active Internet-Draft 15; not an RFC | Follow direction, but cite stable RFCs below |
| OAuth Security BCP | RFC 9700 / BCP 240 | Normative security baseline |
| Native Apps | RFC 8252 / BCP 212 | System browser and loopback redirect for CLI |
| PKCE | RFC 7636 | Require S256 |
| Device Authorization | RFC 8628 | Optional; only after server/client support is verified |
| Resource Indicators | RFC 8707 | Mandatory for project-scoped MCP |
| Authorization Server Metadata | RFC 8414 | Mandatory discovery option |
| Protected Resource Metadata | RFC 9728 | Mandatory for protected MCP |
| Issuer Identification | RFC 9207 | Emit and validate |
| Token Exchange | RFC 8693 | Candidate for human-agent and controller-runner delegation; spike first |
| Rich Authorization Requests | RFC 9396 | Use as an internal grant schema first |
| JWT Access Token Profile | RFC 9068 | Optional internal encoding; opaque client contract |
| DPoP | RFC 9449 | Post-v1 first-party hardening |
| Dynamic Client Registration | RFC 7591 | Compatibility path only |
| Client ID Metadata Documents | Early Internet-Draft | Experimental; compatibility and SSRF spike required |

OAuth 2.1 is not yet an RFC. Anyam's stable baseline must be RFC 9700 plus the relevant individual RFCs:

- authorization code with S256 PKCE;
- exact redirect matching;
- no implicit flow;
- no resource-owner-password flow;
- no bearer tokens in URI query parameters;
- refresh-token rotation or sender constraint for public clients;
- resource/audience restriction and mix-up protection;
- clients treat access tokens as opaque.

Official sources: [OAuth 2.1 draft 15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html), [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html), [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html), [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html), [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html), [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html), [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html), [RFC 9396](https://www.rfc-editor.org/rfc/rfc9396.html), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html), [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html).

## Confirmed missing capabilities and product-owned responsibilities

The following gaps must be visible in the blueprint. They are not hidden implementation details.

| Required Anyam capability | Why the platform does not supply it |
|---|---|
| Source Spaces and capability-composed Project Views | Artifacts credentials stop at repository read/write; Cloudflare has no Anyam source graph |
| Atomic Project Revision across spaces | No documented cross-repository transaction |
| Safe public projection | No documented anonymous/public projection or metadata-redaction layer |
| Stable Change and immutable revisions | Forge/change-control domain is not part of Artifacts |
| Canonical landing policy | No documented ref-level credential/promotion mechanism |
| Agent task delegation | OAuth transport does not define Anyam's authority intersection |
| Model-provider trust zones | Not supplied by Access or MCP |
| Sealed verification and disclosure-controlled evidence | Must be defined in Anyam's verifier/evidence model |
| Typed semantic conflicts | Requires project graph, analyzers, and policy |
| Immutable audit/provenance ledger | Product-owned event and evidence model |
| General releases and Targets | Workflows orchestrates; it does not define release semantics |
| External runner trust protocol | Queues can transport jobs, but Anyam defines enrollment and job capability |
| Immediate high-risk revocation | Must use short lifetimes and online grant/epoch checks |
| Public contribution workflow | Requires projection, mirror/gateway, Change import, and safe feedback |
| Full portability | Git export is only one part; Anyam must export work, review, policy, evidence, and release metadata |

## Architecture decisions now safe to record

1. **Repository provider boundary**
   - `RepositoryDriver` is mandatory.
   - Artifacts is preferred but conditional.
   - A generic Git Smart HTTP provider and full export path are release requirements.

2. **Hard Source Space isolation**
   - Each Source Space maps to an independently protected repository or store.
   - A Project View composes accessible spaces locally.
   - Never hide inaccessible Git objects inside a reachable object graph.

3. **Protected canonical source**
   - Humans and agents get canonical read and task-workspace write authority.
   - Only the landing service writes canonical repositories.
   - Atomic Project Revisions are coordinated and recorded above repository providers.

4. **Authoritative state**
   - Project coordinator Durable Objects serialize protected transitions.
   - D1 is a query/read-model layer.
   - R2 holds immutable large objects.
   - Queues and Workflows are delivery/orchestration, not the source of truth.

5. **Execution portability**
   - Sandbox/Containers is the default Linux/AMD64 lane.
   - Execution is behind `RunnerDriver`.
   - External pull runners are a v1 architecture requirement, even if the first UI ships later.

6. **Application plane separation**
   - Workers for Platforms hosts customer applications only when appropriate.
   - Anyam's control plane stays in ordinary Workers/Durable Objects.
   - Releases are built and verified before deployment to a hosted or customer-owned Target.

7. **Realm-owned authorization**
   - Access can authenticate or gate.
   - Anyam resolves a stable local principal and calculates operation authority.
   - Detailed grants stay online behind a `grant_id`; high-risk actions check current state.

8. **Credential separation**
   - API/MCP, Git, runner, integration, and deployment tokens have distinct audiences.
   - No token passthrough.
   - Cloudflare service tokens are bootstrap identities only.
   - Client contract treats all access tokens as opaque.

9. **MCP integration**
   - Project-scoped HTTP MCP resource for remote agents.
   - Local stdio broker for local tools.
   - MCP is semantic control plane; Git is the source-object data plane.
   - Protocol/client versions are negotiated and audited.

10. **OAuth baseline**
    - Authorization code and S256 PKCE.
    - System browser for CLI.
    - Host-only web sessions.
    - RFC 9728/8707/9207 for project MCP resources.
    - No implicit or password grant.
    - Token exchange, RAR interoperability, device flow, CIMD, and DPoP are conditional.

## Required spike register

These are the unresolved assumptions that can materially change architecture or launch scope.

| ID | Spike | Required proof / exit criteria | Blocks |
|---|---|---|---|
| SP-01 | Artifacts production qualification | Account access, support posture, quotas, commercial terms, documented exit/export, fault test | Artifacts as default production repository |
| SP-02 | Git compatibility | Clone/fetch/push, large history, tags, annotated tags, force/rejected push, shallow clone, partial-clone behavior, LFS strategy across current Git/JJ/IDE clients | Git GA claim |
| SP-03 | Artifacts credential isolation | Mint/revoke/expiry/replay latency; prove workspace token cannot reach canonical/another space; define public-read path | Zero-trust source model |
| SP-04 | Artifacts events and reconciliation | Measure duplicates, loss, order, retry, replay, and delayed events; demonstrate provider-state reconciliation | Event-driven Change updates |
| SP-05 | Secondary repository provider | Run the same contract suite against generic Git; export/import all refs and objects; demonstrate provider switch | Portability and launch contingency |
| SP-06 | Cross-space landing recovery | Inject failure before, during, and after every repository update; prove deterministic completion or compensating state with no false atomicity claim | Project Revision |
| SP-07 | Durable Object hot-project envelope | Load test landing, claims, review activity, presence, and event append; partition auxiliary activity before coordinator saturation | Multi-agent scale |
| SP-08 | D1 tenancy/sharding | Benchmark queries and writes at projected project/event volumes; specify shard key, migration, and rebuild | SaaS scale |
| SP-09 | Queue idempotency | Duplicate, reorder, delay, poison, and replay every job type; no duplicate landing/release/promotion | Async correctness |
| SP-10 | Workflow recovery and limits | Restart/retry/wait/approval and side-effect idempotency; confirm active-instance discrepancy; validate Aug 2026 cost model | Release orchestration |
| SP-11 | Sandbox execution | Cold start, clone, cache, build, output upload, network deny, credential injection, process cleanup, and SDK RPC behavior | Managed runner beta |
| SP-12 | External pull runner | Enrollment key, job lease, immutable input, run token, logs/evidence upload, revocation, replay, and no canonical write | General project support |
| SP-13 | Workers for Platforms release adapter | Upload, bindings, custom domains, failure recovery, rollback, health check, and safe rollout despite no gradual deployment | Hosted app Target |
| SP-14 | Workers OAuth hardening | S256-only, exact redirects, project audience, online grant, authorization epoch, metadata protection, disabled implicit/exchange | Realm OAuth |
| SP-15 | OAuth state/revocation storage | Measure KV propagation and replay window; move active grants/token families/epochs to Durable Objects if needed | Immediate revocation |
| SP-16 | MCP client matrix | Codex, Claude Code, Cursor, and SDK tests for RFC 9728, RFC 8707, RFC 9207, PKCE, refresh, `401/403`, CIMD/DCR/pre-registration, and version fallback | Remote MCP compatibility |
| SP-17 | Managed OAuth topology | One Realm versus project Access apps, vanity domains, audience behavior, quotas, provisioning, and stable identity claims | BYOCF enterprise SSO |
| SP-18 | CLI browser callback | macOS, Windows, Linux, SSH/headless, loopback IP/dynamic port, cancellation, keychain | `anyam login` |
| SP-19 | Device authorization | Selected authorization server and CLI pass RFC 8628 behavior and phishing/rate-limit tests | `anyam login --device` |
| SP-20 | Delegation/token exchange | Authority can only narrow; `sub`/actor preserved; audience cannot widen; parent revocation stops renewal; bounded actor chains | Remote autonomous agents |
| SP-21 | Credential audience isolation | Negative matrix proves MCP, Git, runner, app-installation, and deployment tokens are mutually unusable | Security launch gate |
| SP-22 | Public projection | Anonymous clone through mirror/gateway, zero private object/identifier leakage, reproducible projection, contribution import | Hybrid public/private projects |

### Suggested execution order

Run the spikes in four waves:

1. **Foundation:** SP-01 through SP-06 and SP-14 through SP-16.
2. **Correctness:** SP-07 through SP-10 and SP-21.
3. **Execution/delivery:** SP-11 through SP-13 and SP-18.
4. **Expansion:** SP-17, SP-19, SP-20, and SP-22.

Do not wait for every expansion spike before starting the kernel. The first demonstrable slice can use:

- generic Git or beta Artifacts behind the same driver;
- passkey or one upstream OIDC provider;
- pre-registered first-party CLI/MCP clients;
- local stdio MCP;
- Cloudflare Linux runner;
- one Cloudflare Worker Target.

It must still preserve the hard boundaries: no canonical user/agent write, no cross-audience token reuse, no private-source projection leak, and no false atomicity claim.

## Pricing assumptions for planning

Pricing is usage-based and can change. It must be stored as dated planning input rather than encoded in domain logic.

The low fixed-cost entry point is plausible:

- Workers Paid begins at $5/month.
- Workers for Platforms adds $25/month only when the hosted multi-tenant application plane is used.
- R2, D1, Durable Objects, Queues, and Workflows have meaningful included allowances.
- Containers charge only while active, plus regional egress.
- Artifacts has separate operation and storage charges and is Paid-only.

Cost drivers at scale are likely to be:

1. agent/build container CPU, memory, disk, and egress;
2. retained logs, evidence, release artifacts, and source snapshots;
3. high-volume Durable Object/D1 write paths;
4. Queue retries and fan-out;
5. Artifacts operations and replicated storage;
6. many Workers for Platforms scripts;
7. Workflows steps after 10 August 2026.

Every production workload needs a cost model with:

- project, organization, and Realm attribution;
- budgets and hard limits for agent runs;
- evidence/log retention classes;
- artifact lifecycle policies;
- retry amplification alarms;
- provider price version and effective date.

## Research boundary and maintenance

This brief establishes documented capability, not production behavior. Documentation does not prove latency, failure modes, quota approval, client interoperability, or contractual availability.

Refresh this brief:

- before each architecture freeze;
- before committing to beta/preview dependencies;
- after a Cloudflare SDK or MCP protocol upgrade;
- before publishing pricing;
- at least once per release train while Artifacts and the MCP SDK remain non-GA.

The implementation should record provider capability discovery and version metadata at runtime where possible. Product behavior should fail explicitly when an adapter cannot guarantee a required invariant.

## Final answer to the research question

Anyam can safely design its control plane around Workers, SQLite-backed Durable Objects, D1, R2, Queues, Workflows, and bounded Containers/Sandbox execution. Workers for Platforms is a valid optional customer-application plane. Cloudflare Access and the Workers OAuth Provider library can supply identity and OAuth plumbing, but not Anyam's authorization semantics.

Anyam cannot yet safely depend exclusively on Artifacts, assume full modern Git behavior, assume ordered repository events, expose canonical write credentials, treat D1 or Workflows as the protected mutation authority, promise Cloudflare-only execution for every project, or claim universal MCP client compatibility.

The blueprint should therefore preserve three non-negotiable abstractions:

```text
RepositoryDriver
RunnerDriver
Realm authorization and capability engine
```

With those boundaries and the spike gates above, Cloudflare is a strong serverless substrate for Anyam without becoming an unexamined source of product or security assumptions.
