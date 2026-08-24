# Explicit Preview Strategies

Status: Accepted

Issue: [#256](https://github.com/Whyme-Labs/anyam/issues/256)

## Context

Cloudflare version preview URLs are not available for every Worker, including
Workers that use Durable Objects or Containers. A Promotion path that always
constructs a version URL either fails for valid applications or silently skips
preview evidence.

## Decision

Every Target Deployment Profile carries a discriminated Preview Strategy:

- `version-url` for provider versions that expose a preview URL;
- `isolated-target` for a separate preview Worker/Target and its isolated
  resources;
- `custom-domain-version-override` for an explicitly controlled route; or
- `staging-only` when the required Evidence route is the deliberate preview
  boundary.

The Cloudflare adapter resolves `version-url` only when the provider version
reports preview availability. `isolated-target` and
`custom-domain-version-override` require an explicit route resolver.
`staging-only` is different: it succeeds only when every named
`requiredEvidenceKeys` entry is present as passed Evidence on the immutable
Release. It does not perform a health request against an already-serving
route, so it cannot accidentally certify the previous Release as the
candidate. Missing or unavailable strategy execution is a blocked Promotion,
never an implicit preview skip.

## Consequences

- Durable Object applications can use an isolated preview Target without
  pretending that a version URL exists.
- Preview route, resource, and health identity remain visible in the Target
  contract and receipts.
- A staging-only strategy remains an explicit Evidence obligation rather than a
  green check produced by absence of a URL.

## Rejected alternatives

- **Always derive a workers.dev version URL:** unsupported for some valid Worker
  configurations.
- **Skip preview when unavailable:** removes a required trust boundary without
  telling the operator.
- **Infer a staging route from environment names:** route and resource
  isolation must be explicit and digest-bound.
