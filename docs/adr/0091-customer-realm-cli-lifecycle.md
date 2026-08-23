# Customer Realm CLI lifecycle

Status: Accepted

Issue: [#258](https://github.com/Whyme-Labs/anyam/issues/258)

## Context

The customer-operated Realm state machine and Worker control route already
provide checkpointed install, owner claim, readiness, recovery, and export
operations. The local CLI did not expose a safe plan/doctor/lifecycle surface,
so installation remained manual and operators could not inspect a resumable
checkpoint before invoking provider mutations.

## Decision

The `anyam realm` CLI exposes:

```text
realm plan
realm install
realm upgrade
realm doctor
realm export
realm restore
realm destroy
```

Plans are read-only and digest-bound. Install and upgrade persist atomic,
0600, credential-free checkpoints and return `blocked` until a customer-owned
provider adapter performs the corresponding mutation. Doctor verifies the
checkpoint and local Project checks. Export and restore preserve the
credential-free state and require explicit owner/provider activation later.
Destroy records a pending provider-deletion checkpoint; the CLI never deletes
customer Cloudflare resources implicitly.

## Consequences

- The customer can inspect permissions, resources, domains, secret locations,
  migration, rollback, destruction, and cost-estimation status before install.
- A crashed or interrupted lifecycle resumes from an explicit state file rather
  than re-provisioning blindly.
- No provider cost or capability is claimed without a provider receipt.
- Provider mutation remains behind the existing customer Realm control route.

## Rejected alternatives

- **CLI-only fake install success:** would turn a local file into a false
  provider receipt.
- **Delete state on destroy:** loses recovery and audit lineage.
- **Store provider tokens in the checkpoint:** violates the customer-owned
  credential boundary.

