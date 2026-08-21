---
status: accepted
---

# GitHub Actions OIDC Bridge

The default private-GitHub onboarding path is a customer-owned GitHub Actions
workflow that proves its workload identity to the customer-owned Anyam Realm
through GitHub OIDC. Anyam never receives a standing GitHub credential and
does not require the customer to create a GitHub App. The OIDC assertion is
only an identity claim: the Realm exchanges it for a short-lived capability
bound to one connection, Project, Source Space, operation, repository/owner
IDs, workflow path and SHA, ref, run, audience, and replay identity.

The connection captures the first approved workflow SHA, blocks later workflow
drift until an owner creates a new connection, rejects repository transfers,
audience/issuer/ref/event mismatches, and stores only claim digests and
credential-free receipts. Inbound and outbound capabilities are separate.
GitHub remains an external Mirror; Anyam Landing remains the only canonical
source transition.

This is a provider-neutral trust and qualification seam, not live GitHub OIDC
or JWKS qualification. The GitHub App adapter remains an optional advanced
connector for richer real-time GitHub API behavior, not a setup prerequisite.
