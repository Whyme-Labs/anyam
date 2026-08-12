# Remote MCP read-surface qualification

This note records the private-alpha boundary implemented for [Wayfinder ticket
155](https://github.com/Whyme-Labs/anyam/issues/155), [ticket
158](https://github.com/Whyme-Labs/anyam/issues/158), and [ticket
159](https://github.com/Whyme-Labs/anyam/issues/159), and [ticket
160](https://github.com/Whyme-Labs/anyam/issues/160).

## Qualified surface

The Realm Worker now exposes an OAuth-protected `/mcp` endpoint that accepts a
single JSON-RPC 2.0 request at a time. The qualified methods are:

- `initialize`
- `tools/list`
- `tools/call` for `project.list` and `project.inspect`
- `tools/call` for `workspace.list` and `workspace.inspect` when the OAuth grant includes `workspace.inspect`
- `notifications/initialized` as a no-content acknowledgement

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

`change.list` and `change.inspect` use the dedicated `change.inspect` OAuth
scope and one Coordinator query boundary. Change discovery is sorted by Change
identifier using code-unit ordering; list filters are explicit `projectId`
and/or `workspaceId` values. Inspection returns the stable Change identity and
safe immutable Revision summaries ordered by sequence. Revision source-space
snapshots, author/actor identity, origin metadata, source objects, and
credentials are excluded.

## Deliberate non-capabilities

The surface does not transfer Git objects, issue task grants, expose secret
values, write canonical refs, Land Changes, or Promote Releases. Mutation-shaped
tool names return a typed JSON-RPC error with `canonicalWrite=false`. Unknown
methods and malformed requests fail closed with actionable recovery text.

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
Revision sequence ordering, Project/Workspace filtering, and safe omission of
source snapshots and actor identity. `test/worker-entrypoint.test.ts` covers
the binding-shaped Coordinator Workspace and Change list/inspect responses and
confirms that mounts, source snapshots, and actor identity are not returned by
the safe summaries.

This is a read-surface qualification, not a claim that the full remote MCP,
REST, task-grant mutation API, web console, or production-scale service is
complete. Those remain explicit Wayfinder fog.
