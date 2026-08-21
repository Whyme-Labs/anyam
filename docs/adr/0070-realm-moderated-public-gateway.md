# ADR 0070: Realm-moderated Public Gateway

## Status

Accepted for the public contribution boundary.

## Context

The Public Gateway used an `ADMIN_TOKEN` to protect state, moderation,
ledger, and replay-archive operations. That token was owner-scoped but it was
not a Realm Actor, did not express a Project relationship, and made a static
qualification secret the root of public moderation authority.

## Decision

The Public Gateway delegates moderation authorization to the customer Realm:

1. Admin routes require the `PUBLIC_GATEWAY_REALM_AUTHORITY` service binding,
   the Worker-to-Worker service secret, and a caller-provided short-lived Realm
   session handle.
2. The Realm coordinator validates the session, Project, operation, active
   owner/moderator relationship, and authorization epoch.
3. The Realm returns a credential-free authorization projection naming the
   Actor, role, Project, operation, and receipt. The gateway ignores any
   caller-supplied Actor or role.
4. The gateway sends the Realm-authorized Actor and receipt to its Durable
   Object, which remains authoritative for moderation state, quarantine,
   replay, and cleanup.
5. Anonymous public Git reads and contribution submission remain separate from
   moderation authorization. Anonymous users cannot reach the admin path.

`moderator` is now a Realm relationship role with only `public.moderate`,
Project inspection, Change inspection, and Evidence read capabilities. It is
not an owner and cannot grant identity, policy, Landing, Release, or Promotion
authority.

## Consequences

- No static administrator token is required by the public product path.
- Realm revocation and authorization-epoch changes invalidate moderation at
  the next request without rotating a gateway-wide administrator secret.
- The service-binding secret authenticates the Worker-to-Worker channel but is
  not sufficient to moderate; the Realm session and relationship are required.
- Public Gateway state remains in its own Durable Object; Realm authorization
  does not become public-gateway state or canonical source authority.
- The exact Project and operation are visible in every authorization receipt;
  hidden Projects fail without metadata disclosure.

## Non-claims

This boundary does not claim anonymous moderation, a permanent administrator
session, or a general enterprise role model. SAML/SCIM, delegated moderation
teams, and UI issuance of short-lived Realm session handles remain separate
product work.
