# ADR 0069: Qualified Linux egress boundary

## Status

Accepted as the private-alpha Linux Runner boundary.

## Context

`bwrap` can provide a useful deny-all Linux Workspace, but it cannot safely
turn a host allowlist into an enforced outbound policy by itself. Setting
`HTTP_PROXY` or `HTTPS_PROXY` is not an isolation boundary: a process can open
direct sockets, bypass the variables, or use another resolver. Anyam therefore
must not label a Linux host allowlist as enforced merely because a proxy URL is
present.

## Decision

1. Local Linux `bwrap` remains deny-all. A host allowlist without a qualified
   boundary fails closed before the process starts.
2. Host-allowlisted Actions are assigned to an external Runner whose enrolled
   profile declares either `cloudflare-sandbox` or `customer-egress-proxy`.
3. Runner enrollment requires a `networkBoundaryReceipt` that names the
   actual enforcement mode. A requested allowlist without that receipt cannot
   pull a Job.
4. The reference customer-operated boundary is Cloudflare Sandbox/Containers:
   `enableInternet=false`, `allowedHosts=<exact policy>`, HTTPS interception,
   and a per-Run Sandbox identity. The Worker returns the exact Task,
   Workspace, Run, allowlist, and cleanup receipt.
5. Runner Result contexts include the enrolled enforcement mode and boundary
   receipt, so signed Evidence cannot silently downgrade to a requested-only
   policy.

The implementation lives in:

- `src/execution/cloudflare-sandbox-egress.ts` — typed service-binding client;
- `apps/linux-egress-qualification` — customer-owned Sandbox boundary Worker;
- `src/execution/runner.ts` and `src/kernel/contracts.ts` — enrollment,
  assignment, and signed-result binding;
- `packages/create-anyam/src/workspace-boundary.ts` — local fail-closed lane.

## Consequences

- A Linux host allowlist can be used only through a provider-qualified remote
  boundary, not through a local environment-variable convention.
- Empty network policy remains a local deny-all tripwire.
- Cloudflare Sandbox is a replaceable adapter; the kernel accepts another
  customer egress proxy only when its own qualification receipt names the
  enforced boundary.
- The Sandbox control credential is service-bound and never enters Runner
  results, Evidence, receipts, or Project state.
- Provider limits, throughput, container availability, and universal Linux
  coverage remain non-claims until the customer runs the bounded qualification.

## Qualification matrix

The live boundary qualification must exercise:

| Case | Expected receipt |
|---|---|
| Empty allowlist | `enableInternet=false; allowedHosts=none; status=failed` for an attempted egress probe |
| Allowlisted host | named host succeeds through `cloudflare-sandbox` |
| Denied host | request fails without a successful Run result |
| Boundary/provider failure | `networkEnforcement=cloudflare-sandbox; sandbox=unavailable` |
| Cleanup | Sandbox destroyed or explicitly reported unverified |

Fixture tests prove the contract and fail-closed assignment rules. A live
Cloudflare qualification is a provider receipt, not a fixture claim.
