# Worker Release Manifest and provider read-back

Status: Accepted

Issue: [#251](https://github.com/Whyme-Labs/anyam/issues/251)

## Context

Cloudflare Worker Versions contain more than one JavaScript file. Version
uploads can also carry compatibility settings, bindings, static assets, and
Durable Object migration metadata. A single Artifact plus a successful upload
response is not enough to prove that the provider accepted the exact Release
configuration.

## Decision

The Cloudflare adapter builds an immutable
`anyam.worker-release-manifest/v1` from the sealed Release. The manifest
contains:

- the main module and every module digest/type;
- application, static-asset, and configuration digests;
- compatibility date and flags;
- provider binding names/kinds and non-secret resource fields;
- Durable Object migration identity; and
- health paths and expected Release identity.

The adapter uploads every manifest module with its declared content type and
uses the supported Worker tag/message annotations to bind the manifest digest
to the provider version. It then fetches the exact version-detail endpoint and
requires read-back of runtime configuration, bindings, asset/migration state
when declared, and the manifest digest before the version can be previewed,
deployed, health-checked, or reused from the version list.

Any missing or mismatched read-back is a blocked/indeterminate provider result;
the adapter never treats a successful upload response as sufficient evidence.

## Consequences

- Multi-module Releases no longer collapse into one arbitrary main file.
- Preview, staging, and production can reuse one verified application manifest.
- Binding or compatibility drift is visible before deployment.
- Provider-specific response normalization remains behind the adapter; missing
  provider fields fail closed rather than being guessed.
- Storage resource state remains a separate migration/Target concern because
  Cloudflare Worker Versions do not include every external data mutation.

## Rejected alternatives

- **Upload only the first Artifact:** silently drops modules and assets.
- **Trust the upload response:** does not prove provider read-back state.
- **Store credentials in the manifest:** resource identity is enough; secret
  values remain broker-owned and excluded.
- **Rebuild per Target:** breaks the same-Artifact promotion invariant.

