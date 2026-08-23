# Cloudflare Target operation scopes

Status: Accepted

Issue: [#252](https://github.com/Whyme-Labs/anyam/issues/252)

## Context

Cloudflare Worker version upload is a provider mutation. The previous adapter
classified the high-level `preview` operation as read-only even though a
missing version caused preview to upload one. That made a read credential
look sufficient in fixtures while the real provider correctly required write
authority.

## Decision

The broker distinguishes:

- `version-read`: `workers:read`;
- `version-upload`: `workers:write`;
- `preview`: health observation plus version lookup/upload as separate
  operations;
- `apply`: deployment creation with `workers:write`; and
- `rollback`: deployment rollback with `workers:write`.

The adapter requests `version-upload` only for the upload path. The deployment
and rollback calls retain their own operation identity. Credential sources may
provide separate secrets for each operation, and a read-only source fails
closed before provider mutation.

## Consequences

- Receipts identify the exact provider effect that required write authority.
- Read-only preview lookup cannot accidentally upload a version.
- Customers may still intentionally use one broader provider token through the
  broker, but Anyam no longer labels that token as narrower than observed.

## Rejected alternatives

- **Call all preview read-only:** contradicts the provider API when a version is
  missing.
- **Require write for every preview request:** unnecessarily expands authority
  for a lookup against an existing version.
- **Hide upload under `apply`:** loses the operation-specific audit and scope
  boundary.
