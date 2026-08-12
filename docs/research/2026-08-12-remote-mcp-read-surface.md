# Remote MCP read, bootstrap, and delivery-mutation qualification

This note records the private-alpha boundary implemented for [Wayfinder ticket
155](https://github.com/Whyme-Labs/anyam/issues/155), [ticket
158](https://github.com/Whyme-Labs/anyam/issues/158), and [ticket
159](https://github.com/Whyme-Labs/anyam/issues/159), [ticket
160](https://github.com/Whyme-Labs/anyam/issues/160), and [ticket
161](https://github.com/Whyme-Labs/anyam/issues/161), and [ticket
162](https://github.com/Whyme-Labs/anyam/issues/162), [ticket
166](https://github.com/Whyme-Labs/anyam/issues/166), and [ticket
180](https://github.com/Whyme-Labs/anyam/issues/180).

## Qualified surface

The Realm Worker now exposes an OAuth-protected `/mcp` endpoint that accepts a
single JSON-RPC 2.0 request at a time. The qualified methods are:

- `initialize`
- `tools/list`
- `tools/call` for `project.list` and `project.inspect`
- `tools/call` for `workspace.list` and `workspace.inspect` when the OAuth grant includes `workspace.inspect`
- `tools/call` for typed `project.create`, `workspace.create`, and `change.create` when their explicit write scopes are granted
- `tools/call` for typed `landing.apply`, `release.create`, `target.configure`, and `promotion.request` when their matching delivery scope and live OAuth grant handle are present
- `notifications/initialized` as a no-content acknowledgement

The write tools are deliberately narrow typed mutations: `project.create`
requires `project.write`, `workspace.create` requires `workspace.write`, and
`change.create` requires `change.write`; delivery mutations require
`landing.request`, `release.create`, `target.configure`, or
`promotion.request` respectively. They do not transfer source objects or
execute provider operations.

`project.inspect` requires an explicit `projectId`. The authenticated handler
uses the encrypted OAuth grant property `kernelSessionId` to call the existing
Realm Coordinator Authority boundary. The coordinator validates the owner
session, reads the authoritative Project snapshot, and returns the Project,
canonical Project Revision, Source Spaces, and project-scoped counts. Missing
Projects are reported as a safe not-found result and do not disclose hidden
resources.

`project.list` uses the dedicated Coordinator `project.list` query and returns
the same safe summary shape in deterministic Project-identifier order. It does
not expose the Authority snapshot, kernel session identifiers, or credential
material.

`workspace.list` and `workspace.inspect` use one dedicated Coordinator
`workspace.list`/`workspace.inspect` query boundary. Discovery is sorted by
Workspace identifier using code-unit ordering; `workspace.list` may receive a
validated `projectId` filter and `workspace.inspect` requires one validated
`workspaceId`. Both return the same safe Workspace summary: Project identity,
immutable Project Revision and Project View identities, state, optional Change
link, and mount count. Mount paths, Source Space snapshots, source objects,
actor identity, and credentials are deliberately omitted. The dedicated
`workspace.inspect` OAuth scope keeps Workspace reads separate from
`project.read` while the handler still reuses the encrypted kernel session.

The typed `workspace.create` tool uses the same validated Project path and
Coordinator command boundary as the owner REST route. It requires an
`idempotencyKey`, a Project, a Project Revision, and a Source Space set; its
safe result omits mount paths and actor identity.

`change.list` and `change.inspect` use the dedicated `change.inspect` OAuth
scope and one Coordinator query boundary. Change discovery is sorted by Change
identifier using code-unit ordering; list filters are explicit `projectId`
and/or `workspaceId` values. Inspection returns the stable Change identity and
safe immutable Revision summaries ordered by sequence. Revision source-space
snapshots, author/actor identity, origin metadata, source objects, and
credentials are excluded.

`project.create` and `change.create` follow the same typed pattern. The edge
rejects unknown fields and raw Authority envelopes before calling the
Coordinator. Replaying one key and payload returns the original result;
changing the payload for an existing key is a typed conflict. Project creation
reports `canonicalWrite=initialization-only`; Workspace and Change creation do
not advance canonical source.

The owner-authenticated REST routes `GET /api/changes` and
`GET /api/changes/{changeId}` reuse the same Coordinator boundary. Discovery
accepts one optional `projectId` and/or `workspaceId` filter; inspection accepts
the same filters to assert scope. The edge authenticates the owner, decodes one
safe path identifier, rejects duplicate/unsupported/malformed filters, and
does not assemble state from the Durable Object. The response contract and
safe-field exclusions match the MCP Change summaries.

The owner-authenticated REST routes `GET /api/workspaces` and
`GET /api/workspaces/{workspaceId}` reuse the Coordinator Workspace query
boundary. Discovery accepts one optional `projectId` filter; inspection accepts
the same filter to assert scope. The edge decodes one safe path identifier,
rejects duplicate/unsupported/malformed filters, and returns only Project
identity, immutable revision/view identities, state, optional Change link, and
mount count. Mount paths, source snapshots, source objects, actor identity,
sessions, and credentials remain excluded.

## Typed bootstrap mutation boundary

MCP bootstrap arguments are not accepted as an internal command envelope. The
edge derives the REST-compatible resource path, validates the typed body with
the shared `bootstrapCommand` helper, and adds the authenticated kernel
session only on the internal Coordinator request. Callers cannot submit
`protocol`, `command`, `payload`, `sessionId`, actor identity, or credentials.

The response is passed through the credential-free safe projection: source
snapshots, mount paths, author/actor identity, source objects, provider
credentials, and raw Coordinator receipts are omitted. Hidden or missing
resources are reported without echoing their identifiers. Malformed arguments
fail before a Coordinator call.

## Typed delivery-mutation boundary

The four delivery tools reuse the closed REST-compatible command contracts and
the same serialized Coordinator boundary. The grant must contain the
operation-specific scope and a non-empty provider-issued `anyamGrantId`; the
handler also requires the authenticated `kernelSessionId`. The Coordinator
receives only the typed command, payload, idempotency key, optional expected
version, and authenticated session—not bearer tokens or grant handles.

`landing.apply` validates Project, Change, Change Revision, and canonical
Project Revision lineage. `release.create` validates the canonical Project
Revision plus Artifact and passed Evidence bindings. `target.configure`
validates the Project binding. `promotion.request` validates the Project,
Release, and Target bindings. All four return credential-free safe projections
with `canonicalWrite=false`, `typedSurface=mcp`, and
`providerExecution=not-performed`. Replays are deterministic; changed payloads
conflict; stale versions and hidden resources fail closed; malformed fields
are rejected before the Coordinator call.

## Deliberate non-capabilities

The surface does not transfer Git objects, issue task grants, expose secret
values, publish Change Revisions, write canonical refs, or execute provider
Landing, Release, Target, or Promotion operations. Mutation-shaped tool names
outside the documented typed operations return a typed JSON-RPC error with
`canonicalWrite=false`. Unknown methods and malformed requests fail closed
with actionable recovery text.

OAuthProvider remains responsible for bearer validation, resource audience
matching, and encrypted grant properties. Anyam remains responsible for the
operation boundary and calls the coordinator through its internal binding; an
MCP token is never passed through to Git, Cloudflare, or another provider.

## Evidence

`test/realm-mcp.test.ts` covers initialization, scope-filtered tool discovery,
project and Workspace discovery/inspection, authenticated coordinator binding,
deterministic ordering and Project filtering, malformed JSON-RPC, unknown
methods, mutation denial, missing-resource concealment, missing scopes, and
notification acknowledgement. It also covers Change discovery/inspection,
Revision sequence ordering, Project/Workspace filtering, safe omission of
source snapshots and actor identity, typed Project/Workspace/Change bootstrap
mutations, explicit write-scope filtering, idempotent replay/conflict,
malformed-argument rejection before the Coordinator, hidden-resource
concealment, and safe credential-free projections. `test/worker-entrypoint.test.ts` covers
the binding-shaped Coordinator Workspace and Change list/inspect responses,
owner-authenticated REST Project, Workspace, and Change reads, malformed
paths/filters, method errors, hidden resources, and confirms that mounts, source
snapshots, actor identity, and credentials are not returned by the safe
summaries.

This is a private-alpha read, bootstrap, and typed delivery-mutation
qualification, not a claim that the full remote MCP, REST, source transfer,
provider execution/health/rollback, task-grant lifecycle API, web console, or
production-scale service is complete. Those remain explicit Wayfinder fog.

## Generic owner delegation boundary

The next owner-authenticated mutation boundary is deliberately separate from
the read surface and from the disposable qualification routes:

- `POST /api/owner/agent/delegations` accepts one active Project, Workspace,
  Change, mounted Source Space set, agent identity, non-promotional actions and
  effects, coding-agent credential classes, budget, and future expiry.
- The Coordinator validates the complete Authority relationship before it
  touches Realm identity state. It then reuses or enrolls the exact Agent
  metadata, creates the human parent Task/Grant, and derives the Agent
  Session/Task/Grant through `RealmIdentityPolicy.delegateAgent`.
- `POST /api/owner/agent/delegations/revoke` closes that Agent's delegated
  Sessions, Tasks, Grants, and credentials while leaving the human owner
  Session active.

Repeated identical active requests return `already-delegated`; a request that
would change an active delegation's resource, actions, effects, audiences,
budget, or expiry is rejected as an idempotency conflict. Responses contain no
credential values, provider credentials, source objects, or canonical-write
authority. Git/MCP/Realm API credential exchange and provider delivery
execution remain separate follow-up boundaries.

## Explicit generic credential exchange

The generic delegation now has a separate owner-authenticated exchange route:

- `POST /api/owner/agent/delegations/credentials` requires the exact Agent,
  Agent Session, Task, Grant, Project, Workspace, Change, and mounted Source
  Space set returned by delegation.
- The Coordinator rechecks the owner relationship, human-to-Agent session and
  parent Grant chain, active Task/Grant state, exact resource identity, and
  Source Space equality before calling `RealmIdentityPolicy.issueCredential`.
- Requested classes must be a non-empty subset of both the enrolled Agent and
  delegated Grant audiences. The current generic boundary permits only
  `realm-api`, `git`, and `mcp`; deployment, runner, integration, and promotion
  audiences remain separate authority.
- Token material is returned only in the explicit exchange response. The
  persisted Realm snapshot stores only credential digests and the audit event
  records `tokenStored=false`; generic delegation and error receipts remain
  credential-free. Provider tokens are rejected rather than forwarded.

Git and MCP credentials are separate audience credentials. An MCP credential
authorizes the already-qualified MCP resource boundary; delivery mutation
tools additionally require their operation scope, live grant handle, and
authenticated kernel session. None grants canonical-write authority or
provider execution.
