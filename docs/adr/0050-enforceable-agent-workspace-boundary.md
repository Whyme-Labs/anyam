# ADR 0050: Enforceable agent Workspace boundary

## Status

Accepted for the private-alpha local execution lane.

## Decision

Anyam exposes two visibly different local agent modes:

1. **Enforceable** — the normal private-alpha launch path. Anyam materializes a disposable Git Workspace (or an explicitly authorized projection), strips ambient credentials, applies an explicit outbound-host allowlist, and launches the agent through a qualified host sandbox. The Workspace is the only writable source location. The source directory, Anyam authority state, home directory, and excluded paths are denied to the child process.
2. **Supervised** — a developer convenience path for hosts without a qualified sandbox or for interactive local work. It runs in the developer's working tree and retains host authority. Its receipts explicitly say `credentials=ambient-host-not-enforced`; it must never be presented as restricted-source isolation.

The first qualified host adapter is macOS `sandbox-exec`. Linux `bwrap` is used only when the executable is present; unsupported hosts fail closed for enforceable mode. No platform is described as isolated merely because it has a supervised mode.

Linux enforceable mode additionally requires a measured `WorkspaceResourceLimits`
policy. The boundary wraps `bwrap` with `prlimit` and monitors process-group
usage plus Workspace regular-file bytes. Missing `prlimit`, missing policy, or
missing measurement receipt fails closed; namespace qualification alone is not
treated as resource containment.

The child receives a sanitized environment in enforceable mode. `SSH_AUTH_SOCK`, cloud provider credentials, and deployment credentials are empty; `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, and `GIT_CONFIG_SYSTEM` prevent ambient Git configuration. The Workspace Git identity is brokered and context-bound; it cannot write canonical refs or change Anyam authority state.

Revocation marks the Session and Grant revoked, kills the tracked child process, invalidates outstanding Workspace credentials, and removes only a temporary Workspace whose path is proven to remain beneath the system temporary root. A caller-supplied Workspace directory is never deleted implicitly.

Authorized projections copy only tracked paths explicitly named by the caller and always include the Project manifest needed to identify the Action contract. Hidden Source Spaces are not materialized and are not represented by permission-denied placeholders.

## Receipts and tripwires

The boundary reports `policy=workspace-boundary/v1` on every result. The current command timeout and output cap are provisional tripwires, not product guarantees:

```text
command timeout: 120000 ms
combined stdout/stderr cap: 4194304 bytes
receipt: sizing=provisional-tripwire; remeasure-before-production
```

These values require workload measurements before production sizing. Exceeding a tripwire terminates the child and reports the budget name, limit, requested condition, and receipt.

## Consequences

- A normal private-alpha agent launch can be tested against a hostile process without relying on instructions or a cooperative model.
- Local supervised work remains fast and familiar, but its weaker trust boundary is obvious to the next reader and to agents.
- Host sandbox support is an honest adapter seam. Anyam does not claim universal OS isolation until each backend is qualified with receipts.
- A full projected Workspace has a new Git history and is intended for inspection or execution; cross-space revision publication must use the full Workspace or a future Source Space-aware publication path.
