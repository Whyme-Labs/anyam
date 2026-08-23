# ADR 0093: Explicit Target risk and complete Worker materialization

Status: Accepted

Issue: [#270](https://github.com/Whyme-Labs/anyam/issues/270)

## Context

An omitted or custom Target environment/data classification is not evidence
that the Target is safe. Treating it as a low-risk default would allow a
configuration digest to turn an unknown deployment into a protected
Promotion. The Cloudflare version API also represents a Worker as more than a
single JavaScript file: a version can include modules, assets, bindings,
compatibility settings, and Durable Object migrations.

## Decision

`assertTargetCanPromote` requires both an explicit complete deployment profile
and known environment/data classifications. `custom` is inspectable but not
promotable. Legacy Targets remain exportable and readable; they must receive a
new explicit profile before Promotion.

`WorkerReleaseManifest` is the immutable provider input closure. It can
separate static-asset Artifacts from executable modules, carries compatibility,
bindings, assets, migrations, and health identity, and is checked against the
exact provider version detail. A customer-owned static-asset uploader is an
explicit adapter seam; the Worker adapter refuses to upload a static-asset
Release when that seam is absent. The asset JWT is transient upload material,
never an Anyam receipt or persisted manifest field.

When the provider returns a module list, Anyam compares it with the manifest;
binding, runtime, asset, and migration read-back remains mandatory for the
fields declared by the manifest. The provider version identity and read-back
digest are persisted through the Target identity ledger.

## Consequences

- Unknown Target risk fails closed instead of becoming a silent default.
- A simple Worker remains easy to deploy with one module and no assets.
- General Worker applications have explicit seams for assets and bindings
  rather than a false “single module supports everything” claim.
- Live Cloudflare asset upload and resource provisioning remain provider
  qualification work; local tests prove the boundary, not live capability.

