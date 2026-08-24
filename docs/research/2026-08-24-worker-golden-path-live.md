# Anyam Cloudflare golden-path live receipt

Date: 2026-08-24

Command:

```text
npm run qualification:cloudflare-golden-path
```

Credential source: owner-only file supplied through
`ANYAM_GOLDEN_API_TOKEN_FILE`; credential material was not printed or
persisted in Anyam state.

Account: `1e0170aaabc90ecf5f466128d1f0466a`

## Result

```text
protocol: anyam.cloudflare-golden-path-qualification/v1
status: succeeded
project: project:worker-golden
release: release:9bc6e0a2-5e61-4480-ab32-80969882e9f5
```

Coverage observed:

- one local build and digest-verified Artifact set;
- additive D1 migration applied and read back on preview, staging, and
  production databases;
- Cloudflare Durable Object migration prepared through a non-versioned Script
  upload and read back as provider migration tag `v1`;
- Worker modules uploaded and read back;
- static asset manifest and content uploaded through the provider JWT flow;
- preview, staging, and production Targets promoted in order;
- 1% then 100% rollout steps accepted by Cloudflare;
- rollout health used a version override to observe the candidate Version;
- release-bound health reached `healthy` on all three Targets;
- all disposable Worker scripts deleted after the run;
- canonical Anyam state was not written.

Target receipts:

| Target | Release digest | Provider Version | Provider Deployment | State |
| --- | --- | --- | --- | --- |
| preview | `sha256:d123b9c21fe2587d7f820975cae9d121ca196f3af12b1e4f46bd5916fdde3809` | `d998e54f-b373-4b0a-885e-5a544d9ad803` | `abf419e4-5a39-4435-8d69-43ae9ee2bc46` | healthy |
| staging | `sha256:73f43ed2c0f24e4bcb9ec41a6cf4b1c1416037c24ee83efb6e7038c26199d21c` | `6d68b6ed-af34-43b7-9b28-e5d86b38fdc3` | `05f47229-aaaa-4a3e-9a5c-466beaa67934` | healthy |
| production | `sha256:deed076a7429780b89c9b13a15d19a53c4fb3177be1f6fa1debbc241e1148f19` | `12fa53ac-a381-45e8-80ea-6117e50998b9` | `5f036f5a-e762-4fbf-abb6-afd07d6d3c4c` | healthy |

## Cleanup

The three disposable Worker scripts were deleted:

```text
anyam-golden-preview-20260824
anyam-golden-staging-20260824
anyam-golden-production-20260824
```

The following customer-owned qualification resources remain intentionally
retained because the qualifier never performs implicit data-resource
destruction:

- three D1 databases;
- three R2 buckets;
- three KV namespaces;
- three Queues;
- three auxiliary service Workers;
- one Workflow host Worker and three Workflow definitions.

The export/restore drill remains open. This receipt proves the live
provider-backed golden path, not production readiness or customer-data safety.
