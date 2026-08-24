import assert from "node:assert/strict";
import test from "node:test";

import { parsePromotionExecutorTargetRoutes } from "../apps/promotion-executor/src/route-registry.ts";

test("Promotion executor route registry parses multiple installation-owned Target routes without secret material", () => {
  const routes = parsePromotionExecutorTargetRoutes(JSON.stringify([
    {
      targetId: "target:staging",
      accountId: "account:customer",
      scriptName: "atlas-staging",
      previewSubdomain: "customer",
      healthUrl: "https://atlas-staging.customer.workers.dev/health",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_STAGING",
      credentialScopes: ["workers:read", "workers:write"],
      credentialSourceId: "secret:staging:v1",
    },
    {
      targetId: "target:production",
      accountId: "account:customer",
      scriptName: "atlas-production",
      previewSubdomain: "customer",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_PRODUCTION",
      credentialScopes: "workers:read,workers:write",
    },
  ]));

  assert.deepEqual(routes, [
    {
      targetId: "target:staging",
      accountId: "account:customer",
      scriptName: "atlas-staging",
      previewSubdomain: "customer",
      healthUrl: "https://atlas-staging.customer.workers.dev/health",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_STAGING",
      credentialScopes: ["workers:read", "workers:write"],
      credentialSourceId: "secret:staging:v1",
    },
    {
      targetId: "target:production",
      accountId: "account:customer",
      scriptName: "atlas-production",
      previewSubdomain: "customer",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_PRODUCTION",
      credentialScopes: ["workers:read", "workers:write"],
    },
  ]);
});

test("Promotion executor route registry rejects embedded provider credentials", () => {
  assert.throws(
    () => parsePromotionExecutorTargetRoutes(JSON.stringify([{
      targetId: "target:staging",
      accountId: "account:customer",
      scriptName: "atlas-staging",
      previewSubdomain: "customer",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_STAGING",
      credentialScopes: ["workers:read", "workers:write"],
      credentialToken: "cfat_should-never-be-in-route-json",
    }])),
    /provider credentials must remain Worker secret bindings/u,
  );
});

test("Promotion executor route registry rejects duplicate Targets and unsafe secret binding names", () => {
  assert.throws(
    () => parsePromotionExecutorTargetRoutes(JSON.stringify([
      { targetId: "target:staging", accountId: "account", scriptName: "one", previewSubdomain: "customer", credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_ONE", credentialScopes: ["workers:read"] },
      { targetId: "target:staging", accountId: "account", scriptName: "two", previewSubdomain: "customer", credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_TWO", credentialScopes: ["workers:read"] },
    ])),
    /duplicate Target/u,
  );
  assert.throws(
    () => parsePromotionExecutorTargetRoutes(JSON.stringify([{
      targetId: "target:production",
      accountId: "account",
      scriptName: "atlas-production",
      previewSubdomain: "customer",
      credentialBinding: "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN",
      credentialScopes: ["workers:read"],
    }])),
    /credentialBinding must name/u,
  );
});
