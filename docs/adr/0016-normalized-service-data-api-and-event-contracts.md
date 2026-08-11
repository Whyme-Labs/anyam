# Normalized service, data, API, and event contracts

Status: Accepted

## Context

Anyam has several clients and transports: a terminal-first CLI, Git, a web
portal, REST/SDK integrations, local stdio MCP, remote HTTP MCP, webhooks,
provider callbacks, and external pull Runners. Duplicating domain semantics in
each transport would create inconsistent idempotency, disclosure, errors,
pagination, and authorization behavior.

Issue [#24](https://github.com/Whyme-Labs/anyam/issues/24) asked for an
implementation-level logical architecture and representative schemas without
prematurely splitting every bounded context into a deployed service. The
throwaway contract prototype is preserved on
[`codex/prototype-service-contracts`](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-service-contracts)
at commit [`155bf38`](https://github.com/Whyme-Labs/anyam/commit/155bf38). It
exercised normalized mutation envelopes, duplicate idempotency replay,
idempotency-key conflict, stale expected-version rejection, event emission,
and opaque cursor pagination.

## Decision

### One logical kernel, multiple transport adapters

Anyam defines one domain command/query/event contract. REST, the TypeScript
SDK, CLI, MCP tools, webhooks, and provider adapters translate to or from that
contract. They do not independently decide authority, state transitions,
disclosure, or error meaning.

The first deployment may place several contexts in one Worker/Coordinator
codebase. A Bounded Context is a logical authority boundary, not a mandatory
process or repository boundary. Split deployment only when a measured
throughput, isolation, residency, or ownership receipt justifies it.

```text
Transport adapter
  → authenticate and normalize request
  → command/query handler for one Bounded Context
  → policy and disclosure evaluation
  → authoritative state transition or Read Model query
  → normalized response and/or event
```

### Logical bounded contexts

| Context | Authoritative responsibilities | Consumed contracts |
|---|---|---|
| Realm/Identity | principals, Actors, Sessions, Tasks, grants, epochs, clients, memberships | policy decisions, audit events |
| Project/Source | Project, Source Spaces, Profiles, Views, Project Revisions, repository mappings | repository events, policy decisions |
| Change/Integration | Intents, Changes, Revisions, Claims, Cohorts, Conflicts, Landing | source snapshots, Evidence, approvals |
| Run/Verification | Runs, attempts, Actions, Verifiers, Evidence keys, attestations | Change revisions, Runner results, policy |
| Artifact/Release | Candidate Outputs, Artifacts, Releases, provenance | Run/Evidence, Target capabilities |
| Target/Promotion | Targets, Promotion attempts, health and rollback state | Releases, approvals, adapter results |
| Mirror/Integration | permitted remote refs, reconciliation, imported proposals | Git provider events, Change commands |
| Query/Notification | D1/search projections, subscriptions, notifications | authoritative events only |
| Audit/Export | append-only Audit Events, Project Exports, restore manifests | all authority-bearing events |

The logical contexts communicate through commands, queries, and events. A
context may call another context synchronously only for an explicit authority
check or read required by the current transition. It must not mutate another
context's state directly.

### Canonical identifiers and state

Every durable object has an immutable Anyam ID and, where relevant, an owner-
visible name. Git commit IDs, provider IDs, and user names are external or
compatibility identifiers, not substitutes for Anyam object identity.

Authoritative mutable state is versioned:

```ts
type Version = number; // per aggregate sequence, not a product quota

interface AggregateState {
  id: string;
  version: Version;
  state: string;
  updatedAt: string;
}

interface ProjectRevisionRef {
  projectId: string;
  projectRevisionId: string;
  sourceSpaceSnapshots: Record<string, string>;
}
```

Implementations maintain an aggregate-local version for optimistic concurrency
and may maintain a separate append-only projection sequence for event replay.
The two sequences must not be conflated.

### Normalized command envelope

All mutating transports normalize into this shape. The exact payload is a
versioned operation schema; arbitrary fields are not silently ignored.

```ts
interface CommandEnvelope<TPayload> {
  protocol: 'anyam.command';
  version: 'v1';
  requestId: string;       // one transport attempt
  operationId: string;     // semantic command, e.g. change.publish_revision
  idempotencyKey: string;  // stable across retries of the same command
  actor: ActorRef;
  resource: ResourceRef;
  task?: TaskRef;
  expected?: {
    aggregateId: string;
    version: number;
  };
  payload: TPayload;
}

interface ActorRef {
  principalId: string;
  actorId: string;
  sessionId: string;
  clientId: string;
}

interface ResourceRef {
  realmId: string;
  projectId?: string;
  sourceSpaceId?: string;
  changeId?: string;
  runId?: string;
  releaseId?: string;
  targetId?: string;
}

interface TaskRef {
  taskId: string;
  grantId: string;
  authorizationEpoch: string;
}
```

`requestId` identifies an attempt. `idempotencyKey` identifies the intended
mutation. The server stores the request fingerprint and final response for the
key; replaying the same key/fingerprint returns the original response and
events, while reusing the key for a different operation returns
`idempotency_conflict`.

### Normalized response and error contract

```ts
interface ResponseEnvelope<TResult> {
  protocol: 'anyam.response';
  version: 'v1';
  ok: boolean;
  requestId: string;
  operationId: string;
  result?: TResult;
  error?: AnyamError;
  eventIds: string[];
  policyExplanation?: PolicyExplanation;
}

interface AnyamError {
  code: string;             // stable machine-readable code
  message: string;          // safe human/agent explanation
  retryable: boolean;
  details: Record<string, unknown>;
  remediation?: string;
}
```

The minimum stable error categories are:

```text
unauthorized
forbidden
not_found
validation_failed
stale_version
conflict
idempotency_conflict
rate_limited
unavailable
indeterminate
```

`not_found` is the disclosure-safe response for hidden resources. A visible
policy denial may include a Policy Explanation and remediation, but it must not
reveal hidden identifiers, paths, timing, search results, verifier existence,
or private policy metadata. An indeterminate protected decision fails closed.

HTTP status, CLI exit code, MCP error object, and SDK exception are transport
projections of this envelope. Clients branch on `code` and `retryable`, not on
provider-specific status text.

### Commands and state machines

The initial command set is intentionally small and semantic:

```text
intent.create / intent.update
workspace.create / workspace.refresh
change.create / change.publish_revision
change.claim / change.release_claim
integration.compose / integration.resolve_conflict
run.start / run.cancel
review.submit_finding / review.resolve_finding
promotion.request / promotion.approve / promotion.cancel
landing.request
mirror.reconcile / mirror.import_proposal
export.create / restore.verify
```

Each command has one owning context and an explicit legal-state table. For
example:

```text
Change: draft → active → ready → landed | abandoned
Revision: proposed → verified → superseded | landed
Run: queued → claimed → running → succeeded | failed | cancelled | indeterminate
Evidence: valid ↔ stale (original record is immutable)
Release: proposed → approved → superseded
Promotion: requested → executing → healthy | failed | cancelled | unknown
```

Commands that cause external effects are asynchronous and return an accepted
operation with a durable ID when the final result is not known. A command may
not claim success merely because a Queue message or Workflow instance was
created.

### Event envelope

Events are immutable facts emitted after the owning context records an
authoritative state transition.

```ts
interface DomainEvent<TPayload> {
  protocol: 'anyam.event';
  version: 'v1';
  eventId: string;
  eventType: string;        // e.g. change.revision_published
  aggregate: string;
  aggregateId: string;
  aggregateVersion: number;
  projectionSequence?: string;
  occurredAt: string;
  producer: { context: string; version: string };
  disclosure: DisclosurePolicyRef;
  payload: TPayload;
}

interface DisclosurePolicyRef {
  projectionId: string;
  classification: 'public' | 'project' | 'restricted';
}
```

Events do not contain raw credentials, secret values, private model reasoning,
or inaccessible Project Content. Payloads use Anyam IDs and immutable object
references; consumers fetch a permitted Disclosure Projection when they need
detail.

Delivery is at-least-once and may be reordered. Consumers persist a processed
event ID or projection checkpoint and make handlers idempotent. An event is a
notification of an accepted fact, not an authorization grant. Webhooks are
signed, include event ID and delivery attempt metadata, and are replay-safe;
the receiver must fetch the current permitted projection rather than trusting
an old payload as authority.

### Queries, pagination, and subscriptions

Queries return explicit snapshots and opaque cursors:

```ts
interface Page<T> {
  items: T[];
  nextCursor?: string;
  snapshot?: { projectionSequence?: string; readAt: string };
}
```

Cursors are opaque, audience-bound, query-bound, and may expire. A cursor
created for one Project, filter, sort, or disclosure audience cannot be reused
for another. The server reports `invalid_cursor` or `stale_cursor` with a safe
restart instruction. Offset values and provider pagination tokens never become
public API contracts.

Subscriptions use a durable event stream or webhook delivery record with a
consumer ID, event checkpoint, retry state, and disclosure projection. A
consumer can rebuild from a snapshot plus events; it cannot request hidden
history by changing a cursor.

### REST and SDK mapping

REST is resource-oriented, but each mutation carries the normalized command
fields in headers or the JSON body:

```text
POST /v1/projects/{projectId}/changes
Idempotency-Key: idem_...
If-Match: "project-version"
X-Anyam-Operation: change.create
```

The TypeScript SDK exposes semantic methods and returns typed envelopes:

```ts
const result = await anyam.changes.publishRevision({
  projectId,
  changeId,
  sourceRevision,
  idempotencyKey,
  expectedProjectVersion,
});
```

The SDK does not expose provider credentials or turn a response into a direct
database object. Retries preserve `idempotencyKey`; a stale version requires a
fresh read and deliberate retry with a new expected version.

### MCP and CLI mapping

MCP tools and CLI commands invoke the same semantic operation IDs:

```text
anyam change publish-revision
→ operationId: change.publish_revision

MCP tool: change.publish_revision
→ operationId: change.publish_revision
```

MCP tool schemas expose only the capabilities and Project View allowed by the
active Task. The local stdio broker and remote HTTP resource produce the same
normalized request; remote MCP adds its audience-bound authorization envelope.
The CLI presents safe errors in terminal form and preserves machine-readable
JSON output for agents and scripts.

### Compatibility and versioning

Contracts version at the protocol and operation-schema level. Additive fields
are optional; removing or changing meaning requires a new version. Unknown
required fields fail with `validation_failed`; unknown optional fields may be
ignored only when the schema marks them forward-compatible. Event types are
never reused with new meaning.

Every response and event declares its protocol version and producer/context
version. A compatibility matrix covers CLI, SDK, MCP clients, webhook
consumers, RepositoryDrivers, Runner adapters, and Target adapters. Provider
versions remain extension metadata and cannot change kernel semantics without a
new Anyam contract version.

### Data disclosure and storage rules

The service contract carries a Disclosure Projection reference, not a blanket
"redact later" flag. The owning context decides which fields are visible to
the Actor and model provider. D1/search/read models contain only projections
the audience may discover. R2/object references are exchanged through
short-lived audience-bound capabilities. Audit Events retain authority facts
without credential values or inaccessible content.

### Contract qualification

Before a transport or context is production-qualified, its adapter must pass:

- same command against REST, SDK, CLI, local MCP, and remote MCP produces the
  same state transition, error code, event IDs, and disclosure projection;
- same idempotency key/fingerprint replays the original response, while a
  changed fingerprint is rejected;
- stale `expected` state never mutates authoritative state;
- duplicate and reordered events do not duplicate projections or side effects;
- hidden resources return safe `not_found` across list, get, search, event,
  webhook, cursor, and error paths;
- cursor reuse across queries, audiences, and expired snapshots is rejected;
- schema compatibility tests cover old/new producer and consumer pairs;
- webhook replay, signature failure, endpoint outage, and partial delivery are
  visible and recoverable;
- policy, authorization epoch, Evidence, and disclosure changes invalidate
  affected responses or approvals rather than silently reusing them.

The prototype on the throwaway branch is a smoke test of the core envelope,
not evidence that these production gates have passed.

## Consequences

- A single semantic contract makes the terminal-first user experience and
  agent tooling consistent without making MCP the source-object transport.
- Logical contexts can start in one deployment and split later only when
  receipts justify it; the contract remains stable across that split.
- Events and responses carry more identity and disclosure metadata than a
  conventional REST API, but this is required for replay, audit, and safe
  hybrid-source projections.
- Clients must handle explicit pending, stale, indeterminate, duplicate, and
  reconciliation states rather than assuming every request is synchronous.
- The kernel has to maintain schema compatibility and contract harnesses as a
  first-class product capability.

## Rejected alternatives

- **One bespoke API per client:** produces semantic drift and inconsistent
  authorization/error behavior.
- **Provider-shaped responses as the public contract:** leaks Cloudflare or
  GitHub-specific semantics into the portable kernel.
- **Idempotency by request ID only:** retries commonly have new request IDs;
  the intended mutation needs a separate stable idempotency key.
- **Offset pagination:** exposes storage layout and makes inserts/filters
  unstable; opaque query-bound cursors are safer.
- **Events as commands or authority:** an event records an accepted fact; it
  cannot grant permission or directly authorize a later mutation.
- **One global version counter:** hides aggregate ownership and creates a
  global serialization dependency; aggregate versions and projection sequence
  are separate.
- **Separate deployed service per context from day one:** creates operational
  complexity before a receipt demonstrates the need; logical boundaries are
  sufficient initially.

## References

- [Service-contract prototype](https://github.com/Whyme-Labs/anyam/tree/codex/prototype-service-contracts)
- [Cloudflare-first architecture](0015-cloudflare-first-architecture-and-provider-boundaries.md)
- [Explainable capability policy](0008-explainable-capability-policy.md)
- [Evidence validity and provenance](0013-evidence-validity-policy-and-provenance.md)
- [CLI, Git, MCP, and agent connection](0009-cli-git-mcp-agent-connection.md)
