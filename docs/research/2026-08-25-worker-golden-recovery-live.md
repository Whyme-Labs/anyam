# Anyam Cloudflare golden recovery live receipt

Date: 2026-08-25

Command:

```text
npm run qualification:cloudflare-golden-recovery
```

The command used the owner-only API token file. Credential material was not
printed or persisted in the export package, recovery bundle, or Anyam state.

## Result

```text
protocol: anyam.cloudflare-golden-recovery-qualification/v1
status: succeeded
project: project:worker-golden
projectExportDigest: cb91e2a20eb20ac73fe0ca4999afcb1f6f34d30cf57711b19859f735195d6c03
release: release:c03f8703-e067-4bcc-8106-eb49d97801c0
```

The recovery package is at:

```text
/var/folders/lm/979cwd7505g81719kl0x166h0000gn/T/anyam-golden-recovery-export-1787590534449
```

Coverage observed:

- Project Export manifest shape, credential-free integrity, and digest verified;
- Git bundle restored into a clean repository and replayed with the same
  idempotency key;
- all four application Artifact byte digests restored from the package;
- D1 migration, Worker modules, assets, bindings, compatibility, and Durable
  Object migration tag verified in a fresh recovery cohort;
- preview, staging, and production recovery Targets reached healthy state;
- production Version upload response loss injected after provider acceptance;
- the accepted Version was found by exact provider annotation read-back and
  replayed without a duplicate upload;
- original qualification resource identities were not used as recovery
  destinations;
- canonical Anyam state was not written.

Recovery Target release digests:

| Target | Release digest | Provider Version | Provider Deployment |
| --- | --- | --- | --- |
| preview | `sha256:820871f14016ea18e707e1e5e25f42ca389e35367354ea94c448e321b2686645` | `4a4d52c8-f8a2-476c-b47b-aafd9438594a` | `5249d88a-26ac-40f3-82ad-9966695f45c2` |
| staging | `sha256:59836d0c45848ba9e3dbcb526eaffeeed21cdd81e4feccb16b652d04d49a2e7b` | `9350ca9b-ff7c-4373-b24e-0c518b30149c` | `39dffe37-cd3a-4309-9bff-5612638e0e48` |
| production | `sha256:4109892c6b09ec8cde77cee578af723f65b6e43a080794767aed1f3e90f2a9a6` | `45368e19-f125-4d83-9cf1-5f439ac23629` | `de2a1a72-7774-4b0f-9a17-eaf88b8417a2` |

## Cleanup

Recovery Worker scripts were deleted. The recovery D1 databases, R2 buckets,
KV namespaces, Queues, auxiliary Workers, Workflow host, and Workflow
definitions remain under the `anyam-golden-recovery-20250825-*` prefix for
explicit owner cleanup.

Mutable Durable Object state and Queue contents were not exported. The receipt
therefore proves rebuild from Anyam-owned source and Artifact inputs, not
arbitrary application-state portability.
