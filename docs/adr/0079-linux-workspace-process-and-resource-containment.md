---
status: accepted
---

# Linux Workspace process and resource containment

The enforceable Linux Workspace lane is accepted only when Bubblewrap and
`prlimit` are available and the measured resource policy is supplied. The
Bubblewrap invocation uses a new session, user/PID/IPC/UTS namespaces,
best-effort cgroup namespace isolation, deny-all networking, dropped
capabilities, read-only runtime mounts, and `--die-with-parent`. The command
is wrapped with process-group cleanup so revocation reaches descendants.

Before an enforceable Workspace starts, Anyam measures a healthy Linux runtime
and derives tripwires for process count, address space, CPU seconds, open
files, per-file bytes, Workspace bytes, and monitor interval. The receipt is
carried into the boundary; missing or invalid measurement fails closed. The
runtime monitor reports the named budget, configured limit, and observed ask
for process/address-space/CPU/open-file/Workspace-disk pressure. Kernel
`SIGXFSZ` is translated into the `workspace.file-bytes` budget receipt.

The repository gate probes the same namespace feature set before running the
Linux qualification. The qualification proves PID namespace behavior,
deny-all networking, hostile Git metadata write protection, and cleanup. macOS
`sandbox-exec` and supervised local mode never claim Linux enforcement.

These controls are a host qualification boundary, not universal kernel
hardening. Seccomp completeness, hostile-kernel resistance, and production
multi-tenant isolation require a separately qualified container/runtime path.
