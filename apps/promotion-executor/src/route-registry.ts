export type PromotionExecutorTargetRouteDefinition = {
  targetId: string;
  accountId: string;
  scriptName: string;
  previewSubdomain: string;
  healthUrl?: string;
  credentialBinding: string;
  credentialScopes: readonly string[];
  credentialSourceId?: string;
};

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function routeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function routeScopes(value: unknown, field: string): readonly string[] {
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values)) throw new Error(`${field} must be a comma-separated string or string array`);
  const normalized = values.map((scope, index) => routeString(scope, `${field}[${index}]`));
  if (normalized.length === 0) throw new Error(`${field} must contain at least one provider scope`);
  return normalized;
}

/**
 * Parse the installation-owned route registry without ever accepting secret
 * material in the JSON document. Secret values are resolved separately from
 * the named Worker secret bindings in the deployed Worker.
 */
export function parsePromotionExecutorTargetRoutes(value: string): readonly PromotionExecutorTargetRouteDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("ANYAM_PROMOTION_TARGET_ROUTES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("ANYAM_PROMOTION_TARGET_ROUTES must be a non-empty JSON array");
  const routes = parsed.map((entry, index) => {
    const route = record(entry, `ANYAM_PROMOTION_TARGET_ROUTES[${index}]`);
    const allowed = new Set(["targetId", "accountId", "scriptName", "previewSubdomain", "healthUrl", "credentialBinding", "credentialScopes", "credentialSourceId"]);
    const unknown = Object.keys(route).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`ANYAM_PROMOTION_TARGET_ROUTES[${index}].${unknown} is not accepted; provider credentials must remain Worker secret bindings`);
    const credentialBinding = routeString(route.credentialBinding, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].credentialBinding`);
    if (!/^ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_[A-Z0-9_]+$/u.test(credentialBinding)) throw new Error(`ANYAM_PROMOTION_TARGET_ROUTES[${index}].credentialBinding must name an ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN_* secret binding`);
    return {
      targetId: routeString(route.targetId, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].targetId`),
      accountId: routeString(route.accountId, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].accountId`),
      scriptName: routeString(route.scriptName, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].scriptName`),
      previewSubdomain: routeString(route.previewSubdomain, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].previewSubdomain`),
      ...(route.healthUrl === undefined ? {} : { healthUrl: routeString(route.healthUrl, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].healthUrl`) }),
      credentialBinding,
      credentialScopes: routeScopes(route.credentialScopes, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].credentialScopes`),
      ...(route.credentialSourceId === undefined ? {} : { credentialSourceId: routeString(route.credentialSourceId, `ANYAM_PROMOTION_TARGET_ROUTES[${index}].credentialSourceId`) }),
    } satisfies PromotionExecutorTargetRouteDefinition;
  });
  const ids = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.targetId)) throw new Error(`ANYAM_PROMOTION_TARGET_ROUTES contains duplicate Target ${route.targetId}`);
    ids.add(route.targetId);
  }
  return routes;
}
