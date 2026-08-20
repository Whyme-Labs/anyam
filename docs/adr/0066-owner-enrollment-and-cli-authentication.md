# ADR 0066: Owner enrollment is resumable and CLI auth never exports a session

- Status: Accepted
- Date: 2026-08-21
- Scope: Realm owner bootstrap, passkey enrollment, and CLI authentication

## Context

The owner page previously offered a normal `owner-session.txt` download. That
file contained the host's bearer kernel session and made copying a credential
the documented path into CLI or qualification work. Enrollment also committed
Realm identity before D1 owner/passkey persistence, so an injected failure
could leave a kernel owner with no durable host record.

## Decision

The normal owner UI never downloads a session. The old endpoint remains only as
an explicit 410 migration response that points users to OAuth authorization-code
PKCE or device authorization through the CLI.

The CLI now provides `anyam auth login --realm <url> --client-id <id>`. It opens
the system browser, uses a loopback callback and PKCE S256, validates state,
exchanges the code, and stores the rotated refresh credential in the native OS
keychain. It never writes a plaintext token file or prints token material.

Passkey registration is a durable saga:

1. verified WebAuthn material is written to a pending owner claim;
2. Realm kernel membership is enrolled;
3. D1 owner and passkey rows are persisted idempotently;
4. the pending claim is marked complete.

`/api/owner/passkey/register/resume` retries the same claim after a failure.
The claim identity and credential identity remain unique, and a pending claim
prevents a second first-owner ceremony from starting.

## Non-claims

This does not claim enterprise SAML/SCIM or provider-specific CLI client
registration. The CLI requires an explicitly registered Anyam OAuth client ID.

## Receipt

- `npm run check`: 246/246 tests passed; typechecks and deployable-entrypoint
  verification passed.
- Worker tests prove the former export route is removed from the normal page and
  returns the credential-free migration response.
- CLI tests prove missing OAuth identity fails before browser or credential
  storage is touched.
