# ADR 0095: MCP command-target authorization

Status: Accepted

Issue: [#289](https://github.com/Whyme-Labs/anyam/issues/289)

## Context

The remote MCP edge already validates an Agent/Session/Task/Capability Grant
chain. That validation is not sufficient if the envelope resource and the
embedded Authority command payload can name different Projects, Workspaces,
Changes, Pull Requests, Runs, or Source Spaces.

Anyam's Source Space and Project View boundaries make this a security property,
not a convenience check. A public-source grant must not be able to submit a
payload that influences a restricted Source Space in the same Project.

## Decision

Every generic MCP mutation passes through one pure command-target boundary
before Authority execution. The boundary receives the current authoritative
Authority snapshot, the parsed command, and the validated grant resource/source
set. It:

- resolves opaque Project, Workspace, Change, Pull Request, Intent, Run, and
  Change Revision identities through authoritative state;
- derives the effective Project and affected Source Spaces;
- requires the effective target to remain inside the grant resource;
- requires affected Source Spaces to be both grant-authorized and Project View
  disclosed;
- rejects a payload Capability Grant identity that differs from the live grant;
- returns a sanitized command and target resource for execution.

The Authority executes only the returned command. A target failure is a
credential-free, discoverability-safe rejection and leaves Authority state,
audit, idempotency, and canonical source unchanged.

## Consequences

- Envelope authorization and command authorization cannot silently diverge.
- A mutation that omits a narrower target may still use the grant's explicit
  Project scope, but any target it names must be inside that scope.
- Project View source sets become an executable authorization boundary for
  revision publication and Run requests.
- The pure boundary is independently testable without mocking the Authority
  storage or provider.
- Repository object verification remains a separate follow-up in #290; this
  ADR proves target authority, not Git object existence.

## Receipt

- Cross-Project, cross-Change, cross-Pull-Request, cross-Workspace, hidden
  Source Space, forged Grant, and exact-target tests pass.
- The full repository gate must retain these adversarial cases as a release
  requirement.
- No canonical write or provider invocation occurs in the target boundary.
