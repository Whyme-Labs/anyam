# Realm HTTP error diagnostics

The hosted CLI keeps the HTTP status of a rejected Realm response. It uses
the response's `code`, `recoveryAction`, and `receipt` only when the selected
field is a nonempty string without detected credential material or reflection
of the owner-session value actually forwarded in the cookie. An unsafe field
is replaced with its existing fixed HTTP error, inspection/same-key retry,
or missing-receipt fallback before the error message is constructed. Safe
neighbouring fields remain available. The client sends no automatic retry.

An explicitly allowed non-success checkpoint, such as a blocked HTTP 409,
still requires a payload without detected credential material or supported
owner-session reflection. An unsafe checkpoint rejects with a fixed
`realm_authority_response_unsafe` error, retaining the HTTP status and an
explicit unconfirmed-outcome inspection/same-key retry instruction. Safe
allowed checkpoints keep their existing response contract.

The published CLI package owns the same scanner implementation re-exported
by `src/security/credential-material.ts` for provider and persistence users.
Known-pattern scanning retains its existing normalization, recognized token,
assignment, header, private-key, userinfo URL and single-decoding-layer scope.
The scanner's known-text traversal additionally checks reflection of the
forwarded owner-session value, including supported URI/Base64 text forms.
It does not authenticate a remote diagnostic or prove it contains no other
opaque secret, repeated encoding, encryption or unsupported token format.

`test/realm-error-safety.test.ts` checks the client and both actual CLI
entrypoints with synthetic owner sessions and an owned HTTP error fixture.
These observations do not qualify live Realm authentication, server
idempotency, all successful response schemas or live provider operation.
Structurally valid success replies without usable mutation receipts remain
a separate response-contract gap.
