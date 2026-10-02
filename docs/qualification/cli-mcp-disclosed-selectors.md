# CLI and delegated MCP disclosed selectors

The hosted workflow uses selectors returned by ordinary Project, Workspace,
Change and Run reads. Developers and agents can create a Workspace, create an
Intent-bound Change, publish its observed revision and request a queued Run
without obtaining canonical IDs or an owner recovery export.

## Human CLI

`anyam realm project|workspace|change|run inspect` requires `--realm`, `--id`
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

## Local evidence and remaining qualification

`npm run qualification:selector-clients-local` runs actual Node CLI processes
and HTTP MCP JSON-RPC against the production handler/Coordinator and local
workerd SQLite. It covers the four-step workflow, native attribution, two
Agents sharing an owner, scoped metadata omission, two-Source containment,
hidden/absent equivalence, hidden-only changes, changed-input replay, parent
and child revocation/cancellation/expiry, stale epoch, model/role/Source deny,
expiry after real observation, safe parse errors and unchanged denied state.

The owned fixture supplies synthetic host authentication, OAuth context,
clock and repository observation; outbound access is denied and telemetry is
disabled. Requested Runs remain queued. This evidence does not qualify a live
credential ceremony, native coding harness, real RepositoryDriver/Runner,
provider execution or deployed service. Node orchestration is run as `.mjs`;
the exact Worker fixture is covered by `typecheck:worker-tests` and an
intentional-error boundary probe. Real provider and native harness qualification
remain product release gates for those offered capabilities.
