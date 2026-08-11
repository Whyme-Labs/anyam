import { customerRealmWorkerHealth } from "../../../src/cloudflare/realm-worker.ts";
import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import { anyamRealmOwnerSessionId, requestAnyamRealmCoordinator } from "./passkey-owner.ts";
import type { AnyamRealmOAuthEnv } from "./oauth-provider.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("authority request body must be a JSON object");
  return value as Record<string, unknown>;
}

/**
 * Public Authority Plane edge. The host-only owner session is the current
 * authenticated principal boundary; the Durable Object revalidates the
 * kernel session and owner relationship before applying any command.
 */
export async function handleAuthorityRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/authority")) return undefined;

  const health = customerRealmWorkerHealth(env);
  if (health.status !== "ready") {
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "customer_realm_configuration_invalid", missingConfiguration: health.missingConfiguration, recoveryAction: health.recoveryAction, receipt: `${health.receipt}; authority=blocked; productReady=false` }, 503);
  }

  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before issuing an Authority command.", receipt: "ownerSession=missing-or-invalid; authorityCommand=not-accepted" }, 401);

  try {
    if (url.pathname === "/api/authority/state" && request.method === "GET") return json(await requestAnyamRealmCoordinator(env, "/authority/state/internal", { sessionId }));
    if (url.pathname === "/api/authority/command" && request.method === "POST") return json(await requestAnyamRealmCoordinator(env, "/authority/command/internal", { ...(await readBody(request)), sessionId }));
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, code: "not_found", recoveryAction: "Use GET /api/authority/state or POST /api/authority/command.", receipt: `authorityRoute=${url.pathname}; method=${request.method}; transition=not-started` }, 404);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") || detail.includes("promotion=blocked") ? 409 : 503;
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "authority_coordinator_rejected", recoveryAction: "Inspect the Durable Object receipt and retry only the same idempotent command when safe.", receipt: `authority=coordinator-rejected; detail=${detail}; credentialFree=true` }, status);
  }
}
