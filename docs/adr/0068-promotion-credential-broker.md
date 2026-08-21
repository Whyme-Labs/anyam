# ADR 0068: Customer-owned Promotion credential broker

## Status

Accepted for the private-alpha delivery plane.

## Context

The Promotion executor previously wrapped one configured Cloudflare API token
and a locally supplied expiry timestamp. That made the executor the source of
provider authority, could not observe provider-side revocation, and made
rotation a restart/configuration event rather than a provider observation.

The executor must remain the only component that can call the provider, but it
must not invent provider authorization or serialize provider secret material.

## Decision

The executor accepts only a `CloudflareWorkerCredentialBroker`. The broker:

1. reads the current customer-owned credential source for each operation;
2. binds the request to one Account, Worker, Target, operation, and audience;
3. verifies provider token status and provider-reported expiry;
4. probes read access to the configured Worker Target before issuing a
   credential;
5. reports credential ID, customer source ID, declared scopes, expiry,
   provider authorization, rotation state, and a safe provider operation ID;
6. rejects revoked, expired, unauthorized, unavailable, or under-scoped
   credentials before provider mutation;
7. may select operation-specific credential sources where the provider can
   issue narrower credentials;
8. returns the actual token only to the in-memory provider transport call.

The default Cloudflare adapter is `CloudflareApiTokenCredentialBroker`. It
supports a customer callback for secret rotation and a provider verification
endpoint. A customer must provide declared scopes because the Cloudflare token
verification response does not establish a universal operation-scope model;
the broker therefore does not claim to narrow a provider token that the
provider itself does not narrow.

`GET /health` on the Promotion executor now means two things separately:

- configuration is present; and
- provider authorization was successfully observed for the configured Target.

The response exposes only safe credential metadata and receipts. It never
returns a token. Authority, MCP clients, Runner results, releases, exports,
and audit objects remain credential-free.

## Consequences

- Secret rotation is observed on the next issue/probe without a hard-coded
  local expiry value.
- Promotion handoff key rotation is separate from provider credential
  rotation: the executor accepts only the configured active key ID and, during
  a bounded overlap, one explicitly configured previous key ID. The key ID is
  bound into the signed message and unknown IDs are rejected before provider
  invocation.
- A revoked or expired provider token fails before a Worker version upload or
  deployment request and includes an actionable receipt.
- A provider 401/403 after a successful probe remains distinguishable as
  `rejected-after-observation`; reconciliation is required before retrying.
- Provider operation IDs and credential IDs are auditable without secret
  values.
- The provider-specific broker is replaceable: another Target adapter can
  implement the same broker contract without changing Authority.
- `ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN` remains a customer-owned secret input
  for the Cloudflare adapter, not an executor credential field or Authority
  input. Deployments that need stronger isolation can supply a dynamic secret
  source or service-bound broker without changing the executor contract.

## Receipts and non-claims

The qualification tests cover provider expiry, rotation, revocation, target
authorization failure, response loss, retry, and operation-specific sources.
Those are fixture/provider observations, not universal Cloudflare limits.
Any credential lifetime, scope semantics, or rotation guarantee must carry a
provider receipt from the customer's account.

## Rejected alternatives

- Keeping `providerToken` and `providerCredentialExpiresAt` on
  `PromotionExecutorConfig`: makes stale provider authority load-bearing.
- Passing provider tokens through Authority, MCP, Runner, or release state:
  violates the credential-free boundary.
- Assuming a successful config parse means provider authorization: hides
  revoked or under-scoped credentials behind a false healthy signal.
- Claiming every provider can issue per-operation credentials: the interface
  supports it, but only a provider observation can establish it.
