# ADR 0064: Runner completion is the only passing execution authority

- Status: Accepted
- Date: 2026-08-21
- Scope: Run, Evidence, Artifact, MCP, and external Runner completion

## Context

The previous remote surfaces let an authenticated MCP or REST caller submit
`status=succeeded`, `outcome=passed`, and output digests as ordinary Authority
mutations. Lineage checks could show that the fields were internally
consistent, but they did not prove that an enrolled Runner executed the
declared Action against the exact Project View.

## Decision

Run completion is a Runner-only transition. Agents and humans may request a
Run and inspect its credential-free status, but they cannot record completion,
passed Evidence, or successful Artifact provenance through MCP or REST.

The local Runner contract signs a canonical Result envelope whose context
contains the Job, Attempt, Runner identity, lease expiry, replay identity,
input manifest, Source Space snapshots, Action and Verifier contract digests,
Project Revision/View, Workspace/Change bindings, policy version,
authorization epoch, and capability grant. The coordinator verifies that
context against its immutable Job and Attempt before checking output scope and
accepting the Result. A finalized Attempt is one-shot; replay and changed
context are rejected.

The external pull-Runner qualification uses the same context-first envelope
shape and verifies the exact read-back output manifest before accepting the
Result. Failed and indeterminate outcomes remain inspectable but cannot
satisfy a Release gate.

## Surface

- `run.request`: creates a queued Run with immutable execution context.
- `run.inspect`: reads safe Run status through the Realm Coordinator.
- `run.record`, `evidence.record`, and `artifact.record`: no longer exposed as
  caller-authoritative MCP tools; the REST record routes fail closed.

## Non-claims

This ADR does not claim a particular external Runner fleet, hardware
attestation, Linux egress implementation, or durable credential store. Those
remain separately qualified boundaries.

## Receipt

- Local Runner tests cover signed context, input/output scope, lease,
  revocation, replay, and indeterminate outcomes.
- Realm MCP tests prove request/inspect exposure and legacy mutation denial.
- Realm Worker tests prove REST mutation denial and coordinator request/status
  routing.
