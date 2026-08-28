# Customer-operated Realm Worker qualification

This package is the first deployable edge slice for a customer-operated Anyam
Realm. It exposes credential-free health and bootstrap metadata plus the
official Cloudflare Workers OAuth Provider boundary for an MCP resource. The
qualification Worker verifies and durably enrolls a first owner through a
customer-controlled passkey adapter. Its owner-authenticated Authority Plane
vertical slice now records Project, Workspace, Change, Revision, Run, Evidence,
Artifact, Landing, Release, Target, and Promotion state in the Realm
coordinator. It does not yet transfer Git objects or execute a qualified Target
promotion.

Cloudflare Access Managed OAuth is optional. The Worker owns the OAuth/MCP
protocol surface; Anyam owns the Realm identity, consent, capability policy,
and owner-authentication adapter. See [ADR 0048](../../docs/adr/0048-native-workers-oauth-and-optional-access.md)
for the boundary and the conditions under which Access may be added at the
perimeter.

## Local qualification

From the repository root:

```bash
npm run check:realm
```

The command runs the repository checks and Wrangler's local dry-run bundle
qualification using `wrangler.example.jsonc`. It does not contact a customer
Cloudflare account and is not a deployment receipt.

To exercise the browser owner ceremony or OAuth/MCP routes locally, use a
secure local origin because the OAuth provider rejects non-HTTPS issuer
metadata:

```bash
npx wrangler dev --local-protocol https \
  --var ANYAM_REALM_RP_ID:localhost \
  --config wrangler.passkey-qualification.jsonc
```

The `--var` override is required because the checked-in qualification config
uses the deployed `workers.dev` hostname as its WebAuthn relying-party ID.
The credential-free `/health` and owner ceremony routes also remain available
over ordinary `http://localhost` during local development. This is a local
transport convenience only; it does not weaken the deployed HTTPS contract.

## Customer deployment

1. Create or choose the customer's Cloudflare resources for the Realm's
   coordinator, OAuth KV, metadata read model, Project Export/recovery objects,
   event queue, Workflow, and a customer-owned RepositoryDriver observer.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
3. Replace every `replace-with-customer-*` value and the installation/build
   variables with customer-owned values. Do not put API tokens, passkeys,
   refresh tokens, or secret values in this file.
   Generate the current manifest and its digest with
   `npm run realm:installation-manifest`, then set the printed `digest` as
   `ANYAM_INSTALLATION_MANIFEST_DIGEST`.
   Set `ANYAM_REALM_RP_ID` to the exact hostname that serves the owner
   passkey ceremony (for example, `source.customer.example`; do not include a
   scheme or port). The hostname must remain stable for that Realm.
4. Set the one-time first-owner bootstrap secret with
   `npx wrangler secret put ANYAM_OWNER_BOOTSTRAP_TOKEN --config wrangler.jsonc`.
   The secret is held by the customer Worker and is never written to source,
   D1, KV, logs, or an Anyam receipt.
5. Authenticate Wrangler using the customer's own Cloudflare account and run
   `npx wrangler deploy --config wrangler.jsonc`.
6. Check `GET /health`. A `ready` response proves only that the configured
   foundation bindings and customer-owned mode variables are present. It does
   not prove account ownership, owner authentication, Git, Artifacts, durable
   persistence, or Worker Promotion.
7. After owner passkey authentication, check `GET /api/operator/status` and
   `GET /api/operator/preflight`. These are read-only, owner-authenticated
   JSON surfaces. They report the pinned installation-manifest digest,
   release/schema/migration/configuration digests, owner/recovery state,
   binding/provider observations, policy/export/checkpoint observations, and
   explicit next actions. They never create resources, mint credentials,
   write canonical state, or promote a Target.
   `GET /owner/control-room` renders the same status as a state-first board.
   It remains indeterminate until the customer-owned
   `ANYAM_OPERATIONS_LEDGER` contains verified receipts for sustained load,
   queue recovery, Durable Object contention, backup/restore, key rotation,
   authentication throttling, and incident alerting. Provider observations and
   local fixtures are not production SLO receipts.

The current Wrangler configuration uses a SQLite-backed Durable Object export,
which is the current Cloudflare configuration shape for new Durable Object
classes. D1, R2, Queue, and Workflow entries are provider bindings; Anyam's
Realm and Project coordinators remain the source of authority above them.

## Authority Plane vertical slice

After a Realm member completes the configured authentication ceremony, the
public edge exposes policy-scoped Authority routes:

| Route | Purpose |
| --- | --- |
| `GET /api/authority/state` | Read the durable Authority Plane summary |
| `POST /api/authority/command` | Apply one idempotent Authority command |
| `POST /api/projects` | Create a Project and its initial canonical Project Revision through the typed bootstrap boundary |
| `POST /api/projects/{projectId}/workspaces` | Create an isolated Workspace bound to a Project Revision and Source Space set |
| `POST /api/projects/{projectId}/changes` | Create a Change bound to a Project, optional Workspace, and base Project Revision |
| `GET /api/projects` | Discover owner-visible Project summaries through the Authority Coordinator |
| `GET /api/projects/{projectId}` | Read one project-scoped summary through the Authority Coordinator |
| `GET /api/changes` | Discover owner-visible Change summaries through the Authority Coordinator |
| `GET /api/changes/{changeId}` | Read one Change and its immutable Revision summaries through the Authority Coordinator |
| `POST /api/changes/{changeId}/revisions` | Publish one typed Change Revision candidate through the Authority Coordinator |
| `GET /api/workspaces` | Discover owner-visible Workspace summaries through the Authority Coordinator |
| `GET /api/workspaces/{workspaceId}` | Read one Workspace summary through the Authority Coordinator |
| `POST /api/runs` | Record one typed declared-Action Run through the Authority Coordinator |
| `POST /api/evidence` | Record typed Evidence for one successful determinate Run through the Authority Coordinator |
| `POST /api/artifacts` | Record one typed immutable Artifact bound to a Project/Change/Run lineage through the Authority Coordinator |
| `POST /api/landings` | Request one typed single-Change Landing through the Authority Coordinator's compare-and-swap canonical boundary |
| `POST /api/releases` | Create one typed immutable Release from the current canonical Project Revision, exact Artifacts, and passed Evidence |
| `POST /api/targets` | Configure one typed immutable Target adapter bound to a Project; qualification and Promotion remain separate |
| `POST /api/promotions` | Request one typed Promotion of an immutable Release to a configured Target; provider execution, health, and rollback remain separate |
| `POST /api/owner/agent/delegations` | Owner-authenticated, resource-bounded Agent Task delegation for one active Project/Workspace/Change; no credentials are issued |
| `POST /api/owner/agent/delegations/revoke` | Owner-authenticated revocation of one enrolled Agent and its delegated authority; the owner Session remains active |
| `POST /api/owner/agent/delegations/credentials` | Explicit exchange of an exact delegated Agent Session/Task/Grant for short-lived `realm-api`, Git, and/or MCP credentials; token material appears only in this response |
| `POST /mcp/qualification/github-app` | Owner-only, `qualification.github-app`-scoped qualification capability; typed disposable Authority setup/read/recovery operations without exporting an owner cookie |

`GET /api/projects` and `GET /api/projects/{projectId}` are owner-authenticated,
read-only surfaces. The list is sorted by Project identifier using code-unit
ordering and does not invent a pagination or quota limit before a workload
receipt exists. Both routes use the same Project summary shape.

`GET /api/projects/{projectId}` is an owner-authenticated, read-only surface.
The Project identifier is URL-decoded as one path segment and is forwarded to
the Coordinator's `project.inspect` boundary; the edge does not read or
assemble Authority state itself. The response includes the Project, canonical
Project Revision, visible Source Spaces, scoped counts, and a credential-free
receipt. Unknown Projects are deliberately reported as an undiscoverable
not-found result. This route does not create a Project, transfer source, issue
credentials, land a Change, or promote a Release.

The OAuth-protected `/mcp` resource exposes the same Project reads plus the
read-only Workspace tools `workspace.list` and `workspace.inspect` when the
grant includes the dedicated `workspace.inspect` scope. `workspace.list`
accepts an optional validated `projectId` filter; both tools return only a
safe Workspace summary (Project, immutable revision/view identities, state,
Change link when present, and mount count). Mount paths, source snapshots,
source objects, credentials, and mutation authority are not returned. The
Coordinator sorts Workspace discovery by Workspace identifier using code-unit
ordering and owns the single query boundary for list and inspect.

The same MCP resource exposes typed bootstrap tools only when their explicit
write scope is present: owner MCP sessions may use `project.create` with
`project.write`, delegated coding agents cannot advertise or invoke it,
`workspace.create` requires `workspace.write`, and `change.create` requires
`change.write`. Each tool has a closed argument schema, requires an
`idempotencyKey`, and is translated into the validated Coordinator command
boundary; callers cannot submit the internal Authority envelope, arbitrary
commands, or a different Project path. Replaying the same key and payload is
idempotent; reusing a key for a different payload is a typed conflict.

The same resource exposes read-only `change.list` and `change.inspect` when the
grant includes the dedicated `change.inspect` scope. `change.list` accepts
validated `projectId` and `workspaceId` filters; `change.inspect` returns the
safe Change summary and immutable Revision summaries in sequence order.
Revision source snapshots, author/actor identity, origin metadata, source
objects, credentials, and mutation authority are omitted. The Coordinator
owns one query boundary for both operations and reports the deterministic
Change-identifier ordering in its receipt. Typed bootstrap results remain
credential-free projections: Project creation returns only initialization
identities and Source Space metadata; Workspace creation omits mount paths and
actor identity; Change creation omits author/actor identity. These MCP tools do
not transfer Git objects, issue task grants, land, create Releases, or promote
Targets. A grant with `change.write` also exposes the typed
`change.publish_revision` mutation. It requires a Project-, Change-,
Workspace-, and Project View-bound payload plus a non-empty Source Space
snapshot map and declared effects. The Coordinator validates those bindings,
serializes the transition, and keeps replay/conflict handling under the same
idempotency key. The response is a credential-free Revision/Change projection:
source snapshots, authors, mounts, credentials, and raw Coordinator receipts
are omitted. Publication does not transfer Git objects or change the canonical
Project Revision pointer; Landing, Release creation, and Target Promotion
remain separate operations.

The owner-only GitHub App qualification path uses the same OAuth resource but
a separate `qualification.github-app` scope. After passkey-approved OAuth, the
qualifier sends typed requests to `POST /mcp/qualification/github-app`; the
Worker receives only encrypted OAuth props and an opaque kernel session, then
forwards the allowlisted disposable Project/Workspace/Mirror/recovery
operation to the Coordinator. It never accepts provider credentials, exports
an owner cookie, or exposes a generic command proxy. Production Mirror
ingestion remains signed and internal-only; the qualification-only Mirror
mutation endpoint is explicitly labelled and cannot be reached through the
normal REST or MCP mutation surfaces.

The `run.invoke` grant exposes typed `run.request` and `run.inspect` MCP
surfaces. Caller-authoritative `run.record`, `evidence.record`, and
`artifact.record` mutations remain denied: only the internal enrolled Runner
service may submit `runner.complete`. That transition verifies the signed
Runner Result, exact Attempt/Project/View/Workspace/Change/Action/Verifier
lineage, output scope, replay identity, and result digest before atomically
recording the terminal Run, Evidence, Artifacts, Attempt closure, and audit
event. Raw receipts, actor metadata, source snapshots, credentials, logs, and
model prompts are omitted from the MCP result. Landing, Release, and Target
Promotion remain separate operations.

The owner-authenticated REST surface exposes the same Change query boundary at
`GET /api/changes` and `GET /api/changes/{changeId}`. The list accepts optional
single-valued `projectId` and `workspaceId` query filters; the item route may
use the same filters to assert the requested scope. Both routes URL-decode one
safe Change identifier, reject malformed or duplicate filters, preserve the
Coordinator's deterministic ordering, and return only the safe Change and
Revision summaries. They do not create Changes, publish Revisions, transfer
source, issue task grants, land, or promote anything.

The owner-authenticated REST surface also exposes typed
`POST /api/changes/{changeId}/revisions`. The URL-decoded Change identifier is
the authoritative path binding; a body `changeId`, when supplied, must match
it. The JSON body uses the same closed `revision.publish` contract as MCP and
requires Project, Change, Workspace, Project View, Project Revision,
Source-Space snapshot, and declared-effect bindings, plus one
`Idempotency-Key` header. The Coordinator checks the complete Change and
Workspace relationship before accepting the candidate.

The response is a credential-free redacted Revision/Change projection with
`canonicalWrite=false`; source snapshots, mounts, actors, sessions,
credentials, and raw Coordinator receipts are omitted. Identical requests
replay the original safe result and changed payloads conflict. Publication
does not transfer Git objects or advance the canonical Project Revision
pointer; Landing, Release creation, and Target Promotion remain separate.

The owner-authenticated REST surface also exposes the qualified Workspace
summary at `GET /api/workspaces` and `GET /api/workspaces/{workspaceId}`. The
list accepts one optional `projectId` filter; the item route may use the same
filter to assert scope. Both routes decode one safe Workspace identifier,
reject malformed or duplicate/unsupported filters, preserve Coordinator
ordering, and return only Project identity, immutable revision/view identities,
state, optional Change link, and mount count. They do not create Workspaces,
issue task grants, transfer source, or mutate canonical state.

The owner-authenticated REST surface exposes typed `POST /api/runs` and
`POST /api/evidence` recording routes. Each requires the owner host session,
one `Idempotency-Key` header, and a JSON object accepted by the same closed
Run/Evidence contracts used by MCP; a body idempotency key, when supplied,
must match the header. The Run payload binds Project, Project Revision,
Project View, Workspace, Change Revision, Action, Runner, and output digests.
The Evidence payload additionally binds the exact successful Run and its
Action, Runner, output digest, and disclosure policy. The Coordinator rejects
hidden or mismatched resources before mutation, and passing Evidence cannot be
attached to a failed or indeterminate Run.

Responses are credential-free redacted projections with `canonicalWrite=false`.
They omit actor/session metadata, source snapshots, raw receipts, logs,
prompts, credentials, and private verifier inputs. Identical requests replay
the original safe result; changing a payload under the same key is a conflict.
These routes record already-derived facts only: execution, source transfer,
Artifact storage, Landing, Release creation, and Target Promotion remain
separate operations.

The owner-authenticated REST surface exposes typed `POST /api/landings` for
one Change Revision at a time. The closed `landing.apply` body requires the
Project, Change, Change Revision, and expected canonical Project Revision;
an optional new Project Revision and Landing identity may be supplied. The
Coordinator verifies the exact Project/Change/Revision relationship, latest
Revision state, Change base, and compare-and-swap canonical pointer before
advancing canonical state. A requested Project Revision identity cannot
overwrite an existing revision.

The result is a credential-free projection containing the Landing, the new
canonical Project Revision lineage, and the landed Change. Source-space
snapshots, actors, sessions, credentials, and raw Coordinator receipts are
omitted. A successful response is marked `canonicalWrite="landing-only"`;
replays return the original safe result and changed payloads conflict. This
route performs no Git object transfer and does not create a Release or
promote a Target. The remote MCP surface exposes the same typed
`landing.apply` command only when the live OAuth grant includes
`landing.request`; the MCP projection is `canonicalWrite=false` and remains
provider-execution-free.

The legacy `POST /api/runs`, `/api/evidence`, and `/api/artifacts` routes remain
present only as migration tripwires: they return `410 runner_completion_only`
and never mutate Authority. Artifact registration now occurs inside the
internal `runner.complete` transition, where the signed Runner output, digest,
Attempt, and Project lineage are checked together. Landing, Release creation,
and Target Promotion remain separate.

The owner-authenticated REST surface also exposes typed `POST /api/releases`.
It requires the owner host session, one `Idempotency-Key` header, and a closed
`release.create` JSON body containing the Project, current canonical Project
Revision, non-empty Artifact and Evidence identifiers, and policy version. The
Coordinator verifies that the Project Revision belongs to the Project and is
still canonical, every Artifact and passed Evidence is bound to that exact
revision, and an optional Change Revision belongs to the same lineage. A
stale `expectedVersion`, idempotency reuse with a changed payload, missing
lineage, or cross-Project reference fails before mutation.

The response is a credential-free Release projection containing only the
Release identity, Project and Project Revision lineage, Artifact/Evidence
identifiers, policy version, status, and optional safe name/Change Revision.
Configuration digests, state assumptions, provenance, actor/session metadata,
and raw Coordinator receipts are omitted. Release creation has
`canonicalWrite=false`; it does not transfer source, advance canonical state,
configure a Target, or request Promotion. The remote MCP surface exposes the
same typed `release.create` command only with the live `release.create` scope.

The owner-authenticated REST surface also exposes typed `POST /api/targets`.
It requires the owner host session, one `Idempotency-Key` header, and a closed
`target.configure` JSON body containing the Project, optional Target identity,
adapter identity, accepted Artifact types, and required Evidence keys. The
Coordinator verifies that the Project exists before recording the immutable
Project-bound Target configuration. Replays return the original safe result;
changed payloads, duplicate Target identities, stale expected versions, and
cross-Project references fail closed before mutation.

The response is a credential-free Target projection containing only the Target
protocol, identity, Project binding, adapter configuration, accepted Artifact
types, required Evidence keys, and configuration state. Provider qualification,
Release creation, and Promotion remain separate operations. Target configuration
does not transfer source, mutate the canonical Project Revision, or claim that
the adapter is healthy. The remote MCP surface exposes the same typed
`target.configure` command only with the live `target.configure` scope.

The owner-authenticated REST surface also exposes typed `POST /api/promotions`.
It requires the owner host session, one `Idempotency-Key` header, and a closed
`promotion.request` JSON body containing the exact Project, Release, and Target
bindings. An optional Release digest, Promotion identity, and expected current
Release identity are carried as immutable request declarations; the Coordinator
does not infer or mutate provider Target state in this boundary. Exact Project
lineage, idempotency replay, expected Authority version, and hidden-resource
checks fail closed before a Promotion record is created.

The route returns a credential-free safe projection even when the Coordinator
records the request as `blocked`: it exposes only the Promotion state and safe
Project/Release/Target identities, never actor/session data, provider receipts,
health observations, or credentials. Provider qualification, preview/apply,
health verification, rollback, and provider execution remain separate. The
remote MCP surface exposes the same typed `promotion.request` command only
with the live `promotion.request` scope; it records the Authority request but
does not execute or reconcile a provider promotion.

## Authenticated MCP delivery mutations

The remote `/mcp` resource exposes four delivery mutations only to a human
owner-created, project-scoped OAuth Task/Grant with the matching delivery
scope and provider-issued `anyamGrantId` handle. Delegated coding-agent grants
do not advertise these tools in v1 because no privileged release-agent path is
qualified:

| Tool | Scope | Boundary |
|---|---|---|
| `landing.apply` | `landing.request` | Authority Landing request; no Git transfer |
| `release.create` | `release.create` | immutable Release record; no provider build |
| `target.configure` | `target.configure` | Project-bound Target configuration; no qualification |
| `promotion.request` | `promotion.request` | Authority Promotion request; no apply/health/rollback |

Each tool reuses the closed REST-compatible command parser and the
Coordinator's Project/Change/Artifact/Evidence/Release/Target lineage checks.
The request carries the authenticated owner kernel session, expected version
when provided, and idempotency key; the OAuth grant handle is validated at the
Realm delivery boundary and is never forwarded to the Authority command or
returned to the agent. Results use the safe MCP projections with `canonicalWrite=false`,
`credentialFree=true`, and `providerExecution=not-performed`. Replays return
the same projection, changed payloads are conflicts, hidden resources are not
disclosed, and malformed fields fail before a Coordinator call.

The typed bootstrap mutations are the preferred REST entry point for starting
work. Each route requires an owner host session, `POST`, a JSON object containing
only its documented fields, and one `Idempotency-Key` header. The Project path
binds the Project identity for Workspace and Change creation; callers cannot
smuggle a different Project through the body. `expectedVersion` is optional and
is checked by the same serialized Coordinator command boundary when supplied.
Replay of the same key and payload returns the original safe result; reusing a
key for a different payload is a conflict. Malformed fields, paths, missing
resources, and owner authentication failures are explicit fail-closed errors.

Typed bootstrap responses are credential-free projections. They return only the
Project, canonical revision identity, Source Space metadata, Workspace/view
identity, or Change summary needed to continue the flow. They omit source-space
snapshots, Workspace mounts, author/actor metadata, source objects, provider
credentials, and raw Coordinator receipts. Project creation reports
`canonicalWrite=initialization-only`: it establishes the initial canonical
revision as setup. Later source transfer, Change Revision publication, Landing,
Release creation, and Target Promotion remain separate operations, and only
Landing can advance the canonical Project Revision pointer.

The request bodies are deliberately smaller than the internal Authority
envelope:

```http
POST /api/projects
Idempotency-Key: project-create-1
Content-Type: application/json

{"projectId":"project:atlas","name":"Atlas","referenceType":"git","sourceSpaces":[{"id":"source:public","name":"public","classification":"public","snapshotId":"git:base"}]}
```

```http
POST /api/projects/project%3Aatlas/workspaces
Idempotency-Key: workspace-create-1
Content-Type: application/json

{"projectRevisionId":"project-revision:atlas:1","sourceSpaceIds":["source:public"],"mounts":["source"]}
```

```http
POST /api/projects/project%3Aatlas/changes
Idempotency-Key: change-create-1
Content-Type: application/json

{"intentId":"intent:atlas-feature","baseProjectRevisionId":"project-revision:atlas:1","workspaceId":"workspace:atlas"}
```

These routes intentionally do not accept `protocol`, `command`, `payload`,
`sessionId`, actor identity, or credential fields from callers. The edge adds
the internal command protocol and the validated owner session only after the
typed body and path have passed validation.

The owner-authenticated Intent surface provides the Issue-compatible lifecycle
without making an opaque `intentId` do double duty:

```http
POST /api/intents
Idempotency-Key: intent-create-1
Content-Type: application/json

{"projectId":"project:atlas","intentId":"intent:atlas-feature","title":"Add invoice export","description":"Export one invoice as a PDF","disclosure":"project"}
```

```http
GET /api/intents?projectId=project%3Aatlas
GET /api/intents/intent%3Aatlas-feature
POST /api/intents/intent%3Aatlas-feature/assign
POST /api/intents/intent%3Aatlas-feature/comment
POST /api/intents/intent%3Aatlas-feature/close
POST /api/intents/intent%3Aatlas-feature/reopen
```

Mutation paths require one idempotency key and return the safe Intent value;
close and reopen retain the same identity and comment history. A Change created
from an existing Intent is rejected when the Project differs. Legacy Change
callers that provide an unknown Intent ID receive a same-Project
`legacy-materialized` Intent so no orphan relationship is created. Public
disclosure uses a separate audience projection and omits restricted Intents
entirely.

The owner-authenticated Pull Request compatibility surface keeps Git vocabulary
over Anyam-owned Change and Revision state:

```http
POST /api/pull-requests
Idempotency-Key: pull-request-open-1
Content-Type: application/json

{"projectId":"project:atlas","pullRequestId":"pr:atlas-feature","changeId":"change:atlas-feature","provider":"local","headRef":"refs/heads/feature/atlas","baseRef":"refs/heads/main","headCommit":"commit:feature","baseCommit":"commit:base","title":"Add Atlas feature","disclosure":"public","revisionIds":["change-revision:atlas-feature:1"]}
```

```http
GET /api/pull-requests?projectId=project%3Aatlas
GET /api/pull-requests/pr%3Aatlas-feature
POST /api/pull-requests/pr%3Aatlas-feature/update
POST /api/pull-requests/pr%3Aatlas-feature/review
POST /api/pull-requests/pr%3Aatlas-feature/close
POST /api/pull-requests/pr%3Aatlas-feature/reopen
POST /api/pull-requests/pr%3Aatlas-feature/block
POST /api/pull-requests/pr%3Aatlas-feature/merge
```

The projection retains one Pull Request ID across branch updates and rebases.
Merge is rejected until the mapped Change is Landed. Provider mirror proposals
of kind `pull-request` update the same projection, but cannot advance the
canonical Project Revision. Public projections omit provider repository
identity and private Change IDs. Provider sync and reconciliation are not
accepted through the generic Authority or human REST command surface; the
adapter must use the signed internal Mirror handoff after RepositoryDriver
observation.

The handoff is `anyam.mirror-ingestion/v2`. It is an audience-bound capability,
not a Realm-wide bearer message: Realm, installation, issuer/provider,
repository, Mirror, delivery, proposal, issued/expiry window, nonce, and the
typed command are signed together. `/internal/mirrors/ingest` verifies those
bindings against the current Mirror and accepts only the active key or an
explicitly configured rotation-overlap key. Lifetime and clock-skew values
must be configured with receipts; expired nonces are compacted before replay
checks.

The owner-authenticated Agent delegation surface accepts an explicit
Project/Workspace/Change resource, mounted Source Space IDs, agent identity
metadata, non-promotional capabilities/effects, allowed `realm-api`/`git`/`mcp`
credential classes, an optional budget, and a future expiry. The Coordinator
checks that the Authority snapshot contains one coherent active resource chain
before it creates or reuses an enrolled Agent and derives the human parent
Task/Grant into an agent Session/Task/Grant through the same Realm identity
policy kernel used by every other client. Repeating an identical active
delegation returns `already-delegated`; a request that would silently widen it
is rejected. A missing Source Space policy is initialized only for this
owner-bound first delegation from the Authority classification and requested
capability/model boundary; an existing policy must already satisfy the request.

The response is credential-free: it includes only safe Agent, Session, Task,
and Grant metadata plus explicit `credentials=not-issued` and
`canonicalWrite=false` receipts. Git/MCP/Realm API credential exchange remains
a separate follow-up operation. The generic delegation endpoint does not
expose source objects, provider credentials, or provider execution authority;
delivery mutations require the separate live OAuth grant scopes described
above. Revocation closes delegated authority without revoking the human owner
Session.

The explicit credential exchange is `POST /api/owner/agent/delegations/credentials`.
It requires the exact identifiers and Project/Workspace/Change/Source Space set
returned by delegation, revalidates the owner-to-Agent Session/Task/Grant chain,
and accepts only credential classes approved by both the enrolled Agent and the
delegated Grant. It calls the Realm identity kernel for issuance, so credentials
are audience-bound and short-lived; token material is returned only by this
explicit endpoint, while the durable snapshot, audit receipts, and delegation
responses remain credential-free. Git and MCP credentials are separate
audiences, and receiving an MCP credential does not grant MCP mutation authority.

The command envelope is:

```json
{
  "protocol": "anyam.authority-command/v1",
  "command": "project.create",
  "idempotencyKey": "client-generated-key",
  "expectedVersion": 0,
  "payload": {}
}
```

The current public command names are `project.create`, `workspace.create`,
`change.create`, `revision.publish`, `run.request`, `landing.apply`,
`release.create`, `target.configure`, and `promotion.request`. The internal
`runner.complete` transition is available only through the bound Runner
service; it cannot be submitted through the generic command or MCP surfaces.
Commands are serialized by the Realm Durable Object,
persisted as a credential-free snapshot, guarded by optional version checks,
deduplicated by idempotency key, and appended to the audit ledger. Only
`landing.apply` changes the canonical Project Revision pointer. A
`promotion.request` records an explicit `blocked` result until its Target
adapter is separately qualified; it never changes the Target pointer or claims
that deployment occurred.

The hosted command/read path now evaluates Realm relationships and semantic
capabilities for human team sessions; identity/recovery administration remains
owner-only. Git Smart HTTP object transfer and live provider Target adapters are
separate boundaries. The binding-shaped Worker test exercises the complete
Project-to-Promotion path; the Wrangler smoke receipt remains
`wrangler=dry-run; deployment=not-performed` until a customer deployment is
run and independently observed.

## Binding contract

| Binding/variable | Role in this foundation | Authority |
| --- | --- | --- |
| `REALM_COORDINATOR` | Realm/project coordination adapter boundary | Anyam Realm/Project coordinator |
| `OAUTH_KV` | OAuth provider client, authorization-code, token, and grant state | Cloudflare Workers OAuth Provider, governed by Anyam policy |
| `ANYAM_METADATA_DB` | Rebuildable query/read model | Anyam events and exports |
| `ANYAM_EXPORTS` | Customer-owned Project Export and recovery object store | Anyam export manifest and digests |
| `ANYAM_EVENTS` | At-least-once event transport | Anyam authoritative event/state transition |
| `ANYAM_WORKFLOW` | Durable orchestration adapter boundary | Anyam Run/Release/Promotion state |
| `ANYAM_REPOSITORY_OBSERVER` | Customer-owned RepositoryDriver observation boundary for hosted Git revisions | Repository object, ref, tree, and ancestry verification |
| `ANYAM_HOSTING_MODE` | Must be `customer-operated` | Realm policy |
| `ANYAM_INSTALLATION_ID` | Non-secret installation identity | Installation state |
| `ANYAM_PROTOCOL_VERSION` | Must match the Worker protocol | Contract compatibility |
| `ANYAM_REALM_RP_ID` | Exact hostname used for WebAuthn ceremonies; no scheme or port | Realm identity policy |
| `ANYAM_INSTALLATION_MANIFEST_DIGEST` | SHA-256 digest of the versioned installation manifest | Operator preflight pin |
| `ANYAM_RELEASE_DIGEST` | SHA-256 digest of the active Anyam release | Operator status observation |
| `ANYAM_SCHEMA_DIGEST` | SHA-256 digest of the active schema set | Operator status observation |
| `ANYAM_MIGRATION_DIGEST` | SHA-256 digest of the applied migration set | Operator status observation |
| `ANYAM_CONFIGURATION_DIGEST` | SHA-256 digest of the non-secret Worker configuration | Operator status observation |
| `ANYAM_PROVIDER_ACCOUNT_ID` | Non-secret customer provider account reference | Operator status observation |
| `ANYAM_PROVIDER_STATE` | `healthy`, `outage`, or `expired-grant` observation | Operator status observation |
| `ANYAM_PROVIDER_AUTHORIZATION_STATE` | Customer-recorded provider authorization state; no token value | Operator status observation |
| `ANYAM_MIGRATION_STATE` | `current`, `stale`, or `failed` migration observation | Operator status/preflight |
| `ANYAM_RELEASE_STATE` | `compatible`, `incompatible`, or `degraded` release observation | Operator status/preflight |
| `ANYAM_DOMAIN_POLICY_STATE` | Customer-recorded domain policy observation | Operator status/preflight |
| `ANYAM_RESIDENCY_POLICY_STATE` | Customer-recorded residency policy observation | Operator status/preflight |
| `ANYAM_EXPORT_DESTINATION` | Non-secret export destination reference | Operator status/preflight |
| `ANYAM_LAST_EXPORT_DIGEST` | SHA-256 digest of the last verified credential-free export | Operator status/preflight |
| `ANYAM_LAST_CHECKPOINT_DIGEST` | SHA-256 digest of the last verified recovery checkpoint | Operator status/preflight |
| `ANYAM_RESTORE_DRILL_STATE` | `verified` or `failed` customer restore-drill observation | Operator status/preflight |
| `ANYAM_PENDING_OPERATIONS_STATE` | `none`, `pending`, or `stale` operation-ledger observation | Operator status/preflight |
| `ANYAM_OPERATIONS_LEDGER` | Credential-free JSON snapshot of `anyam.production-operations/v1` drill receipts | Operator status/control room |

Configured bindings are reported by name only. The health response never
returns binding values or credentials.

The operator status and preflight responses are similarly disclosure-filtered:
they return identifiers, enum observations, and SHA-256 digests only. An
unobserved provider, migration, policy, export, or pending-operation state is
reported as `indeterminate`, not guessed as healthy. A missing binding or
incompatible/stale release is `blocked`; a provider outage or failed restore
drill is `degraded`. Every non-healthy check includes a receipt and recovery
action.

The current source manifest receipt is generated locally (not a provider
claim): `sha256:d54ea858cdb74e426b775ff69da4c709f092d44888b649b863444d2b8be54c5b`.
Regenerate it whenever the manifest changes; do not copy a stale digest into a
customer deployment.

## Owner passkey qualification surface

The Worker exposes a customer-owned WebAuthn adapter boundary:

| Route | Purpose |
| --- | --- |
| `POST /api/owner/passkey/register/options` | First-owner registration challenge; requires the bootstrap secret header |
| `POST /api/owner/passkey/register/verify` | Verifies the browser registration response, enrolls durable Realm membership, and writes the D1 owner projection |
| `POST /api/owner/passkey/auth/options` | Authentication challenge for an enrolled owner |
| `POST /api/owner/passkey/auth/verify` | Verifies the assertion and issues an opaque host-only owner session |
| `POST /api/owner/session/revoke` | Revokes the current opaque owner session and expires its cookie |
| `POST /api/owner/session/export` | Owner-authenticated same-origin download of the opaque session value as `owner-session.txt`; response is no-store and never JSON/logged |
| `GET /api/operator/status` | Owner-authenticated machine-readable installation status; read-only |
| `GET /api/operator/preflight` | Owner-authenticated read-only binding/migration/policy/export preflight; no provider calls or mutations |
| `GET /owner/control-room` | Owner-authenticated, no-store state-first control room for Change → Evidence → Landing → Release → Target → Deployment → Health |
| `POST /api/owner/agent/delegations` | Creates or reuses one owner-authenticated, non-promotional Agent Task delegation for a real Project/Workspace/Change; credentials are not issued implicitly |
| `POST /api/owner/agent/delegations/revoke` | Revokes one owner-owned Agent and closes its delegated authority without revoking the owner Session |
| `POST /api/owner/agent/delegations/credentials` | Explicitly exchanges the exact generic delegation for short-lived, audience-bound `realm-api`, Git, and/or MCP credentials; provider, deployment, runner, and promotion credentials are rejected |
| `POST /api/owner/qualification/delegate` | Owner-session-protected qualification delegation for an isolated agent Workspace; credentials are not issued implicitly |
| `POST /api/owner/qualification/credentials` | Explicitly exchanges the exact delegated agent Session/Task/Grant for short-lived Git and/or MCP credentials |
| `POST /api/owner/qualification/revoke` | Revokes the qualification agent, delegated Sessions, Tasks, Grants, credentials, and Workspace task |
| `POST /api/owner/qualification/recovery/export` | Exports the current credential-free identity snapshot for the disposable recovery drill |
| `POST /api/owner/qualification/recovery/restore` | Restores that snapshot quarantined, revokes authority, and clears the host session until passkey re-activation |
| `GET /owner/claim` | Serves the browser first-owner WebAuthn ceremony (use `?format=json` for the machine contract) |
| `GET /owner/login` | Serves the browser authentication ceremony (use `?format=json` for the machine contract) |
| `GET /owner/qualification` | Same-origin owner-session qualification controls; credential values are redacted and recovery state remains in page memory |

The production Authority recovery surface is separate from the disposable
identity qualification controls. Configure the non-secret
`ANYAM_AUTHORITY_RECOVERY_KEY_ID` and customer secret
`ANYAM_AUTHORITY_RECOVERY_SECRET`. `POST /api/authority/recovery/export`
returns a signed `anyam.authority-recovery/v1` bundle; restore accepts only
that bundle, checks its expected Authority version and audit-chain digest, and
enters quarantine. `POST /api/authority/recovery/activate` requires a fresh
passkey-authenticated owner session plus the exact quarantined bundle ID and
digest. Normal Authority mutations fail closed while quarantined.

The qualification surface now includes a minimal browser ceremony and retains
the JSON contract for automation. The server-side verifier uses
`@simplewebauthn/server`, stores only public credential material and the
counter in customer D1, and stores short-lived challenges/session handles in
customer KV. It never stores a passkey private key or bootstrap secret.

The verified owner is enrolled through the customer Realm Durable Object before
the D1 projection is written. The live receipt keeps provider and kernel
evidence distinct: `ownerRecord=verified` describes the WebAuthn/D1 adapter,
while `kernelMembership=verified` describes the durable Realm identity
transition. Authentication creates a kernel session first and then an opaque
host-only session; OAuth authorization revalidates the kernel session before
granting the provider's authorization request. Delegation and credential
exchange are separate operations: delegation names the exact child
Session/Task/Grant and available credential classes; explicit exchange returns
Git and/or MCP token values once. The durable snapshot stores only credential
digests. The recovery drill exports a credential-free snapshot, restores it
with all Sessions and Grants revoked, and requires a fresh passkey
authentication before the Realm returns to active status. This is a disposable
proof surface, not yet the production Git Smart HTTP gateway or the complete
agent API.
