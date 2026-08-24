# Golden-path qualifier operator guide

The owner-run qualifier is:

```sh
export ANYAM_GOLDEN_CONFIG_FILE="$PWD/fixtures/worker-golden/live-config.json"
export ANYAM_GOLDEN_API_TOKEN_FILE=/tmp/anyam-golden-api-token
export ANYAM_GOLDEN_CLEANUP_MODE=retain
npm run qualification:cloudflare-golden-path
```

Start from
`fixtures/worker-golden/live-config.example.json`, copy it to an ignored
local path, and replace every `replace-with-*` value. The file contains no
credential field. It names three disposable Workers, their health URLs,
per-Target D1/R2/KV/Queue/Workflow/service/Durable Object bindings, rollout
steps, migration digests, and the Workers.dev subdomain.

The API token is used for two customer-owned boundaries:

- Worker version upload, read-back, deployment, and rollback;
- D1 migration query and read-back.

The provider token therefore needs the account-scoped Worker Scripts read/write
and D1 read/write permissions required by those operations. Keep the token in
`ANYAM_GOLDEN_API_TOKEN` or an owner-only (`0600`) file named by
`ANYAM_GOLDEN_API_TOKEN_FILE`; it is never written to the config file, receipt,
or Anyam state.

The command:

1. copies the fixture to a disposable Workspace;
2. runs the declared build once and seeds the three empty `anyam-golden-*`
   Worker scripts;
3. applies and reads back the additive D1 migration on all three databases;
4. seals one Release input closure;
5. applies Durable Object migrations through Cloudflare's required
   non-versioned Script upload, reads back the provider migration tag, then
   uploads and reads back the immutable Worker Version modules, assets,
   bindings, and compatibility for each Target;
6. promotes preview, staging, and production in that order;
7. observes the configured rollout steps and release-bound health; and
8. reports a credential-free receipt.

`ANYAM_GOLDEN_CLEANUP_MODE=retain` leaves the disposable resources for owner
inspection. `ANYAM_GOLDEN_CLEANUP_MODE=workers` deletes only the three
`anyam-golden-*` Workers; D1/R2/KV/Queue resources remain for deliberate owner
cleanup. In `workers` mode, a provider failure also triggers best-effort Worker
cleanup. Export/restore is not yet part of this command and remains an open
follow-up in issue #273.

Cloudflare does not accept Durable Object migrations in a Version upload. The
adapter therefore treats migration preparation as a separate, credential-
brokered provider operation and omits `migrations` from the subsequent Version
metadata. This is a provider constraint, not an Anyam limit. See [Workers
multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)
and [Cloudflare's Durable Object deployment guidance](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects).

The follow-up recovery command is:

```sh
export ANYAM_GOLDEN_CONFIG_FILE="$PWD/fixtures/worker-golden/recovery-live-config.json"
export ANYAM_GOLDEN_ORIGINAL_CONFIG_FILE="$PWD/fixtures/worker-golden/live-config.json"
export ANYAM_GOLDEN_API_TOKEN_FILE=/tmp/anyam-golden-api-token
npm run qualification:cloudflare-golden-recovery
```

It exports the exact Project package, verifies and imports it through the
quarantine path, restores Artifact bytes, and rebuilds a fresh recovery cohort.
It injects one lost production Version-upload response and requires exact
provider annotation reconciliation before retrying. The recovery qualifier
does not export mutable Durable Object state or Queue contents.
