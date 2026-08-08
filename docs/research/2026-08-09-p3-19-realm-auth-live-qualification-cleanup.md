# P3-19 Realm authentication qualification cleanup inventory

**Issue:** [Provision a live Realm authentication qualification surface](https://github.com/wms2537/anyam/issues/130)

**Status:** inventory and exact cleanup procedure recorded; deletion is deferred until the authenticated owner lifecycle has produced its receipts.

**Captured:** 2026-08-09 (Asia/Kuala_Lumpur)

## Scope

This is the disposable customer-operated qualification surface for Anyam's
native Workers OAuth provider and Realm owner adapter. It is not production
infrastructure. The owner lifecycle must be completed before deletion so that
the final receipt can distinguish authenticated behavior from unauthenticated
surface probes.

## Account and live worker

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Worker:             anyam-realm-auth-20260808
Hostname:           anyam-realm-auth-20260808.swmengappdev.workers.dev
Latest version:     5003a332-cd3e-4553-8ce5-0ba78eb0768f
```

The latest live version returned `/health` HTTP 200 with `status=ready`,
`configured=6`, `missing=0`, and `credentialFree=true`. Native
`@cloudflare/workers-oauth-provider` owns the MCP/OAuth protocol boundary;
Cloudflare Access Managed OAuth is not configured.

## Bound resources

```text
D1 database:
  name: anyam-realm-auth-20260808-metadata
  id:   c884c0fd-4ddd-44e1-8095-65f22713fffd

R2 buckets:
  anyam-realm-auth-20260808-exports
  anyam-realm-auth-20260808-exports-preview

Queue:
  name: anyam-realm-auth-20260808-events
  id:   1298f669bb2c4419855ebc1b4017a408

Workflow:
  anyam-realm-auth-20260808-workflow

OAuth KV namespace:
  title: anyam-realm-auth-20260808-oauth
  id:    90d9fcecdfad411fa81c13d2e7976fd2

Durable Object:
  binding: REALM_COORDINATOR
  class:   AnyamRealmCoordinator
```

The inventory was obtained from the account-scoped Wrangler listings and the
qualification Wrangler configuration. No secret value was read.

## Required deletion order

Run the following only after the authenticated owner lifecycle receipt has been
attached to issue #130 and the owner has approved deletion. Keep the commands
literal: do not substitute a broad account, namespace, or bucket target.

```bash
export CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a

# Remove the Worker and its secret first.
npx wrangler secret delete ANYAM_OWNER_BOOTSTRAP_TOKEN --name anyam-realm-auth-20260808
npx wrangler delete anyam-realm-auth-20260808 --force

# Remove the orchestration and event resources.
npx wrangler workflows delete anyam-realm-auth-20260808-workflow
npx wrangler queues delete anyam-realm-auth-20260808-events

# Remove the metadata and object stores.
npx wrangler d1 delete anyam-realm-auth-20260808-metadata --skip-confirmation
npx wrangler r2 bucket delete anyam-realm-auth-20260808-exports
npx wrangler r2 bucket delete anyam-realm-auth-20260808-exports-preview

# Remove the disposable OAuth state namespace by exact ID.
npx wrangler kv namespace delete anyam-realm-auth-20260808-oauth \
  --namespace-id 90d9fcecdfad411fa81c13d2e7976fd2 \
  --skip-confirmation
```

Wrangler's current help confirms that workflow deletion also deletes workflow
instances, D1 deletion is remote, R2 bucket deletion is bucket-scoped, and KV
deletion accepts an exact namespace ID. The Worker deletion uses `--force`
because its Durable Object binding is intentionally disposable.

## Post-cleanup receipt

After deletion, rerun account-scoped listings and record:

```text
worker=absent
d1=absent
r2.exports=absent
r2.exports-preview=absent
queue=absent
workflow=absent
oauthKv=absent
secret=absent-or-worker-unreachable
```

If any listing still contains the exact disposable name or ID, cleanup is
`indeterminate`, not successful. Do not broaden deletion to similarly named
resources. The remaining risk is Cloudflare-side deletion propagation and any
provider-retained audit metadata; record those as residual risk rather than
claiming zero retention.

## Current gap

The cleanup procedure is documented and the resource inventory is measured, but
execution remains intentionally deferred. The owner passkey ceremony still
needs explicit browser approval before the authenticated delegation,
credential exchange, revocation, recovery, re-activation, and final cleanup
receipts can be recorded.
