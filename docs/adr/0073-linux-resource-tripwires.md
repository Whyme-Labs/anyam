# ADR 0073: Measured Linux Workspace resource tripwires

## Status

Accepted on 2026-08-21.

## Context

Bubblewrap namespaces isolate filesystem and network views, but they do not
automatically contain fork, address-space, CPU, descriptor, or file-growth
pressure. A namespace-only receipt is therefore not a complete hostile-Action
boundary.

## Decision

1. Linux enforceable Workspaces require an explicit `WorkspaceResourceLimits`
   object with a measurement receipt. There are no hidden numeric defaults.
2. The boundary wraps Bubblewrap with `prlimit` for process count, address
   space, CPU seconds, open files, and per-file size.
3. A host-side monitor samples process-group usage and regular-file bytes under
   the Workspace. Exceeding a named tripwire terminates the process group and
   returns the budget, limit, observed ask, and receipt.
4. Missing `prlimit`, missing resource policy, invalid values, or missing
   receipts fail closed before the Action starts.
5. The Linux qualification measures a healthy runtime first, derives its
   disposable tripwires from that receipt, and reports the resulting policy.
6. macOS and supervised modes do not claim these Linux resource controls.

## Non-claims

The host monitor is not a universal disk quota and the process-group tracker
is not a kernel cgroup. A production runner may replace this adapter with a
qualified rootless OCI/cgroup boundary, but Anyam must retain the same typed
resource receipt and fail-closed semantics.
