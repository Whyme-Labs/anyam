# P2-0 customer-operated Worker foundation receipt

**Status:** Local contract qualification complete; Cloudflare provider
qualification not claimed.

**Ticket:** [Deploy a customer-operated Cloudflare control-plane foundation](https://github.com/Whyme-Labs/anyam/issues/74)

## What this receipt proves

- A TypeScript Worker entrypoint exists at
  `apps/realm-worker/src/index.ts`.
- The customer-operated configuration contract is explicit for the Realm
  coordinator, D1 read model, R2 Project Export/recovery objects, Queue event
  transport, and Workflow orchestration boundary.
- `/health` and `/.well-known/anyam-realm` are credential-free and report
  configured versus missing inputs without returning binding values.
- Missing configuration is a named, actionable failure. The response includes
  the missing configuration keys, recovery action, and receipt.
- The coordinator and Workflow exports are deliberately non-authority-bearing
  in this slice. They return an explicit blocked response until their bounded
  contracts are qualified.
- The existing in-memory Customer Realm installation remains the local source
  of the bootstrap, ownership, recovery, and Project Export contract.

## Local measurement receipt

Measured on 2026-08-03 in this checkout:

```text
npm run typecheck                         exit 0
npx tsc -p apps/realm-worker/tsconfig.json --noEmit
                                          exit 0
npm test                                  90 tests passed, 0 failed
npm run build:realm                       exit 0
Wrangler 4.118.0 dry-run bundle           5.22 KiB / gzip 1.72 KiB
```

The bundle size is a local dry-run observation, not a Worker limit or an
Anyam quota. It must be remeasured after the entrypoint, dependencies, or
Wrangler version changes.

## Provider references checked

The deployment example follows the current first-party Wrangler configuration
shape for D1, R2, Queues, Workflows, and Durable Objects:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workflow bindings](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

These are provider receipts for configuration syntax only. They are not a
receipt that a customer's account has the resources, permissions, billing,
region, availability, or workload capacity required by Anyam.

## Not proven by this receipt

- Cloudflare account control or OAuth/passkey enrollment.
- Durable production persistence or recovery.
- Anyam Git Gateway or a Repository Driver provider.
- Artifacts availability, Git compatibility, token revocation, or export.
- D1 read-model schema, migrations, or rebuild.
- Queue/Workflow delivery, retries, cancellation, or idempotency.
- Cloudflare Worker preview, Release, Promotion, health, or rollback.
- Production secret brokerage, model policy, or hosted agent execution.
- Any performance, cost, quota, availability, residency, or SLO number.

Those remain explicit P2 tickets and provider qualification gates. A green
local test is not a Cloudflare deployment claim.
