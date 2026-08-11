# ADR 0051: Realm passkey and OAuth authorization boundaries

## Status

Accepted for the Realm-auth qualification slice.

## Context

The customer-operated Realm worker must authenticate its first owner and issue
OAuth authorization codes without turning a browser request into a durable
authority grant by itself. A challenge or consent form may be replayed, two
first-owner ceremonies may race, and an OAuth provider grant must remain
revocable through Anyam rather than becoming an untracked provider-side record.

## Decision

- Store WebAuthn registration and authentication challenges in the Realm
  coordinator Durable Object. Issue and consume are one-time operations; a
  failed or replayed ceremony requires a fresh challenge.
- Bind OAuth consent to the authenticated Realm session, principal, Realm,
  parsed authorization request, and a coordinator-generated CSRF token. The
  browser form carries only the opaque consent identity and CSRF token.
- Do not complete provider authorization until explicit approval is submitted.
  Requested scopes are intersected with the adapter's allowed scopes, and an
  empty intersection is denied.
- Record the provider grant under an Anyam local grant identity after provider
  persistence is verified. If local recording fails, revoke the provider grant
  before returning an error.
- Revoke through the owner session and coordinator-owned local mapping before
  reporting success. Provider access tokens are never returned by the local
  grant listing.
- The internal coordinator binding requires its routing marker, and the
  passkey verification worker supplies the verified result to the coordinator;
  caller-supplied `verified` values are ignored.
- WebAuthn counters are monotonic in both the D1 projection (conditional
  update) and the serialized Realm identity state.

## Consequences

The authorization path has an extra durable consent round trip, but the next
reader can see exactly where browser input ends and Realm authority begins.
Provider grants may briefly exist before the local record is written; the
failure path revokes them and reports the reconciliation receipt instead of
claiming success. The five-minute consent and five-minute challenge windows
are qualification tripwires, not product limits; production sizing requires
fresh receipts.

## Rejected alternatives

- KV-only challenges: the Realm coordinator would not serialize first-owner,
  replay, and identity transitions together.
- Auto-approving OAuth requests: this hides scope consent and creates grants
  without an explicit owner decision.
- Passing the MCP/OAuth token directly to the provider or repository: token
  audiences and revocation boundaries would be lost.
