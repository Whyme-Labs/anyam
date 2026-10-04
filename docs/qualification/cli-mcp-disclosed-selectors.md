# CLI and delegated MCP disclosed selectors

The hosted workflow uses selectors returned by ordinary Project, Workspace,
Change and Run reads. Developers and agents can create a Workspace, create an
Intent-bound Change, publish its observed revision and request a queued Run
without obtaining canonical IDs or an owner recovery export.

## Human CLI

`anyam realm project|workspace|change|revision|run inspect` requires `--realm`, `--id`
and `--session-stdin`. Supply an existing active human host Session on stdin
from a trusted credential helper. The input ends at EOF. These commands do
not perform a login or adapt a stored OAuth token into a human Session.
`--json` emits the current disclosure DTO.
The coarse human Run read uses `GET /api/authority/runs/{encodedRunId}` and
the existing current Run disclosure; signed owner detail remains separate.

The four explicit mutation commands are:

| CLI command | JSON input | Selector origin |
| --- | --- | --- |
| `realm workspace create` | `projectId`, `projectViewRevisionId`, optional `sourceSpaceIds`, `mounts`, `classification` | Project read |
| `realm change create` | `projectId`, `workspaceId`, `baseProjectViewRevisionId`, `intentId` | Workspace read and disclosed Intent |
| `realm revision publish` | `projectId`, `workspaceId`, `changeId`, `baseProjectViewRevisionId`, `sourceSpaceSnapshots`, optional `declaredEffects`, `kind`, `expectedSymbolicRef` | Workspace/Change read and repository candidate |
| `realm run request` | `projectId`, `workspaceId`, `changeRevisionId`, `projectViewRevisionId`, `actionId`, `actionContractDigest`, `inputDigests`, optional verifier/effect/dependency/toolchain/environment digests | Published Change Revision |

Every mutation requires `--realm <url> --input <json-file>` and a stable
`--idempotency-key <key>`, together with `--session-stdin`. Use each option
once. For example, with a payload file populated from the Project read:

```sh
trusted-human-session-helper | anyam realm workspace create \
  --realm https://your-realm.example --input workspace.json \
  --idempotency-key my-workspace-creation --session-stdin --json
```

The helper is illustrative; supply your installation's trusted Session
source. Avoid typing credentials in argv or payload files. This path rejects
unknown fields, duplicate options and malformed input without echoing their
content. Existing local `workspace` commands keep their separate local use.

## Delegated remote MCP

`tools/list` exposes four additional typed tools to fully bound delegated
Agents with the corresponding OAuth scope:

| Tool | OAuth scope | Native capability |
| --- | --- | --- |
| `workspace.create_from_view` | `workspace.write` | `workspace.write` |
| `change.create_from_view` | `change.write` | `change.publish_revision` |
| `change.publish_revision_from_view` | `change.write` | `change.publish_revision` |
| `run.request_from_view` | `run.invoke` | `run.invoke` |

Supply the documented flat payload fields and `idempotencyKey`. Discovery
returns each strict schema. The existing exact-selector tools retain their
names and contracts. No failed request falls back between contracts.

The Agent client must consent to `source.read` and each requested semantic
operation or capability. OAuth scopes alone grant no native authority. Reads
and writes retain the authenticated Agent Actor, client, Session, Task,
Capability Grant and enrolled model provider. Reads disclose only Sources
within that delegation and current role/Source policy. Each contributing
Source requires current read and operation authorization. Every native parent
Task/Grant resource, Source scope, action, effect, model, Session and epoch is
rechecked, including accepted retries. Scoped metadata denies still apply to
the complete Workspace, Change and Run context, including explicit child and
ancestor native Grant metadata denies. No new metadata actions are granted.
The enrolled Agent, active clients and every native parent/child Grant must
currently permit the `mcp` credential audience. Empty or narrowed audiences
deny reads, first writes and cached acceptance; OAuth scope cannot restore them.

Server-created IDs must remain inside the existing Task/Grant boundary. A
Task fixed to an existing Workspace cannot create a different Workspace.
Accepted cache entries bind to the exact Agent/Actor/client/Session/Task/Grant;
two Agents of one owner cannot share an accepted result through the same key.
Repository observation happens once on first acceptance. Authorization is
rechecked after observation; replay makes no new observer call, Task, Grant,
identity audit or Authority transition. Responses use current disclosure
DTOs, including after hidden-only canonical activity. Credential guards and
transaction rollback apply before persistence.

## Review a selected candidate after reconnecting

Use `realm change inspect` to recover its disclosed Revision IDs, then
`anyam realm revision inspect --realm <url> --id <change-revision-id>
--session-stdin --json`. Delegated MCP exposes `change.revision.inspect` with
exactly `{ "changeRevisionId": "<disclosed-revision-id>" }` under the existing
`change.inspect` OAuth scope. Both paths use current native authority and
record-local Source disclosure; selectors do not grant access.

The response contains the selected Revision, stable Change,
`revision.isLatestForChange`, its disclosed `projectViewRevision` with exact
`sourceSpaceSnapshots`, and visible associated `runs`. Each coarse Run has
only its currently visible recorded `evidence` IDs/outcomes. An older selected
candidate retains its own snapshots and reports `isLatestForChange: false`;
an empty Run/Evidence array makes no statement about inaccessible records.
Queued Runs remain queued. Recorded passed/failed/stale/indeterminate outcomes
do not verify signatures, input-manifest or artifact bytes, execution, or
present validity. The accepted signed Realm-owner detail contract remains
separate.

Reads resolve no canonical/global selectors, perform no repository observation,
create no Task/Grant, and cache no result. They require the candidate's whole
current Source/resource closure and existing whole-Change eligibility, because
the response includes current Change/latest metadata. A sibling Revision that
changes that eligibility can remove access to an older selection; unrelated
hidden-only canonical or Evidence activity does not. A Task/Grant limited to a Run, PR, Release or
Target cannot supply broader candidate-level authority. Source read, typed
metadata denies and every native ancestor still apply. Write-only revocation
can preserve an independently authorized read. Hidden, mixed or absent
candidates remain indistinguishable; malformed selectors and unknown caller
authority fields are rejected safely. Human REST is the bounded
`GET /api/authority/revisions/{encodedChangeRevisionId}` route.

Ordinary Workspace, Change, Intent and Pull Request inspect/list projections,
their Project discovery counts and Mirror service reads preserve the same
native resource restrictions. Partial Source closure/Project discovery checks
cannot supply omitted record coordinates to metadata capabilities. An exact
Run-scoped read still exposes that Run and counts its producer-bound
Evidence/Artifacts; it supplies no broader Change or Workspace authority.
Artifacts bound only to a Change preserve the producing Revision's Workspace
for scoped access and metadata denies. The local MCP/Coordinator routing
regression also preserves owner, general Source, Source-specific and
legitimate Workspace/Change reads. Its authentication
state is synthetic; it does not qualify a live OAuth ceremony or provider.

## Inspect accepted signed Run context as a Realm owner

Use `anyam realm run detail --realm <url> --id <run-id> --session-stdin --json`
with the same explicit existing human Session input. This GET uses
`/api/authority/run-details/{encodedRunId}` and returns the existing
`anyam.owner-run-detail/v1` contract without a new audience or policy path.
Only an active human Realm-wide owner with complete current Source access and
Run `evidence.read` authority can read it. Project ownership or complete Project
Source access alone does not qualify. Ordinary Run inspection and delegated
MCP continue to expose coarse status/recorded outcomes.

The server re-verifies the accepted enrolled signature and exact producing
context on each read. Detail includes accepted action/verifier contracts,
producing snapshots, Job/Attempt/Runner identity, digest references and verified
result digest. It omits native credential coordinates, unsigned metadata and
raw logs/provider receipts. This CLI does not independently verify the signature,
recompute manifest/artifact bytes, attest real execution or establish present
Evidence validity. Unknown/unsigned/tampered or inaccessible detail is safely
unavailable; verification/storage failure remains a typed 503. No coarse-read
fallback conceals that failure. Session input is stdin only and is never saved.

The existing disclosed-write workerd/SQLite journey additionally exercises actual
CLI owner detail and exact DTO equality, recovery, non-owner/Project-owner
denial, tampered and credential-bearing proof rejection, current Source/Evidence
and Session revocation, coarse-reader continuity and unchanged read checkpoints.
Its host authentication and producing execution are synthetic; its enrolled
Ed25519 signature verification and Coordinator persistence are real local code.

## Local evidence and remaining qualification

`npm run qualification:selector-clients-local` runs actual Node CLI processes
and HTTP MCP JSON-RPC against the production handler/Coordinator and local
workerd SQLite. It covers the four-step workflow, native attribution, two
Agents sharing an owner, scoped metadata omission, two-Source containment,
hidden/absent equivalence, hidden-only changes, changed-input replay, parent
and child revocation/cancellation/expiry, stale epoch, model/role/Source deny,
expiry after real observation, safe parse errors and unchanged denied state.
Revision review assertions additionally cover exact selected snapshots,
queued versus recorded outcomes, older/latest recovery through both transports,
hidden candidate equivalence, native scope
closure and revocation with peer continuity. Pure projection checks cover
older/latest candidates, malformed producer lineage and hidden-only additions.
Timing diagnostics measure synthetic localhost reads; they are not live-service
latency or a production capacity receipt.

The owned fixture supplies synthetic host authentication, OAuth context,
clock and repository observation; outbound access is denied and telemetry is
disabled. Requested Runs remain queued. This evidence does not qualify a live
credential ceremony, native coding harness, real RepositoryDriver/Runner,
provider execution or deployed service. Node orchestration is run as `.mjs`;
the exact Worker fixture is covered by `typecheck:worker-tests` and an
intentional-error boundary probe. Real provider and native harness qualification
remain product release gates for those offered capabilities.
