# ADR 0077: GitHub Actions Bridge import and reconciliation

Status: Accepted for the controlled internal alpha

Date: 2026-08-22

## Context

The GitHub Actions Bridge removes the need for a standing GitHub credential,
but an OIDC exchange alone is not a source-control integration. A workflow
must transfer a complete Git source package to the customer-operated Realm and
the Realm must decide what that package means relative to its current Project.

The provider is not canonical. A workflow must never turn a GitHub ref into a
silent overwrite of an Anyam Project Revision. A ref-only upload, an
incomplete Git LFS manifest, a caller-supplied ancestry claim, or a replayed
workflow run is not a valid import.

## Decision

The customer Realm exposes four bounded Bridge routes:

```text
POST /api/owner/integrations/github-actions/bridge/connections
POST /api/integrations/github-actions/bridge/exchange
POST /api/integrations/github-actions/bridge/prepare
POST /api/integrations/github-actions/bridge/proposal
POST /api/owner/integrations/github-actions/bridge/activate
POST /api/integrations/github-actions/bridge/outbound/bundle
POST /api/integrations/github-actions/bridge/outbound/complete
```

The owner creates a pending connection bound to the exact Realm, Project,
Source Space, GitHub repository identity, workflow ref, expected branch, event
set, operation set, audience, and expiry. The workflow presents its OIDC token
to the customer-owned verifier binding. Only the verifier sees the token; the
Realm stores the verified claims, replay digest, connection, and capability,
never token material.

The source transfer contract is
`anyam.github-actions-bridge-source/v1`. It contains:

- a complete Git bundle and measured digest/byte count;
- object format, default branch, and the complete ref set;
- every declared Git LFS object with bytes, size, path, and digest;
- exact Project/Source Space/repository/run/capability identities.

The customer-owned RepositoryDriver service inspects the uploaded package and
current canonical refs, then produces the history observation. It is explicitly
marked `source=repository-driver`; the workflow request does not carry or
choose `same`, `github-ahead`, `canonical-ahead`, or `diverged`.

The import coordinator has two operation-specific capabilities:

- `inbound` prepares an empty-Project initialization. It requires explicit
  owner confirmation, quarantines and verifies the package through the
  customer-owned RepositoryDriver/import service, and then asks a separate
  owner-controlled Authority cutover service to initialize the Project.
- `proposal` handles GitHub-ahead history by creating a quarantined Change
  proposal. Landing remains Anyam-authoritative and no canonical write is
  delegated to GitHub.

`same` is a no-transfer ready state. `canonical-ahead` and `diverged` are
blocked reconciliation states. None of these states overwrites either side.

All completed import/proposal operation IDs and Bridge replay digests are
persisted by the Realm coordinator. A retry after coordinator restart is
rejected as a replay or resumed from its named RepositoryDriver checkpoint.

The Realm delegates actual bundle import, canonical initialization, and Change
proposal creation to explicitly bound customer-owned services. An unconfigured
service fails closed; this slice does not claim live GitHub OIDC, Git bundle,
or provider upload qualification.

## Consequences

The workflow has a real one-click connection path without requiring a GitHub
App. It also has more visible steps than a provider-authoritative mirror: the
owner can see the exact package, RepositoryDriver history receipt, checkpoint,
and cutover decision.

The Realm must provision four customer-owned bindings before enabling the
integration: OIDC verifier, RepositoryDriver/import boundary, Authority
cutover boundary, and proposal boundary. These bindings are replaceable and
their receipts are not Anyam universal limits.

The source package is currently transported as a credential-free JSON wire
projection with base64 binary fields. A future streaming transport may replace
that wire shape, but it must preserve the same digest, completeness, and
checkpoint semantics.

## Rejected alternatives

- **GitHub App as the default connector:** it imposes user-created provider
  credentials and is unnecessary for the OIDC workload identity path.
- **Provider-authoritative two-way sync:** it creates a second canonical writer
  and conflicts with the Anyam-canonical Mirror decision in ADR 0075.
- **Ref-only or commit-only import:** it loses tags, objects, object format, or
  LFS completeness and cannot support an exact Project Revision.
- **Caller-provided ancestry state:** it lets the untrusted workflow select a
  reconciliation branch; ancestry remains a RepositoryDriver observation.
