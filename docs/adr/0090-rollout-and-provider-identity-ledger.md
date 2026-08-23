# Rollout policy and provider identity ledger

Status: Accepted

Issue: [#257](https://github.com/Whyme-Labs/anyam/issues/257)

## Context

Worker Promotion previously issued one 100% deployment and rediscovered old
versions from only the first provider page. That made gradual rollout metadata
non-operative and made rollback depend on a moving provider listing.

## Decision

The Cloudflare adapter accepts an explicit rollout policy with increasing
percentages ending at 100%. Intermediate steps require a measured rollout
observer before the next step; observer aborts and response loss remain
indeterminate and preserve the provider deployment receipt. Every step uses
the same verified provider version when version affinity is required.

The adapter also accepts a customer-owned provider identity ledger. It stores
the exact Target, Release digest, provider version ID, deployment ID, and
version read-back digest. Reuse first loads that identity and fetches the exact
version detail; only a missing or stale ledger entry falls back to paginated
provider listing and tag reconciliation.

## Consequences

- A channel or rollout policy now changes provider behavior rather than acting
  as metadata only.
- Response loss is visible with completed rollout steps and exact provider IDs.
- Rollback can target a stored provider version without scanning an arbitrary
  first page.
- The ledger is customer-owned and credential-free; the provider remains a
  receipt source, not Anyam authority.

## Rejected alternatives

- **Always deploy 100%:** no canary or abort boundary.
- **Scan only the newest provider page:** old known-good Releases disappear
  after enough deployments.
- **Treat an observer timeout as healthy:** loses the rollout safety boundary.

