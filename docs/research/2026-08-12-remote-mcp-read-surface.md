# Remote MCP read-surface qualification

This note records the private-alpha boundary implemented for [Wayfinder ticket
155](https://github.com/Whyme-Labs/anyam/issues/155).

## Qualified surface

The Realm Worker now exposes an OAuth-protected `/mcp` endpoint that accepts a
single JSON-RPC 2.0 request at a time. The qualified methods are:

- `initialize`
- `tools/list`
- `tools/call` for `project.list` and `project.inspect`
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

`test/realm-mcp.test.ts` covers initialization, tool discovery, project
discovery and inspection, authenticated coordinator binding, deterministic
ordering, malformed JSON-RPC, unknown methods, mutation denial, missing-project
concealment, missing scope, and notification acknowledgement.

This is a read-surface qualification, not a claim that the full remote MCP,
REST, task-grant mutation API, web console, or production-scale service is
complete. Those remain explicit Wayfinder fog.
