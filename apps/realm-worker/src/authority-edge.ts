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

function projectIdFromPath(pathname: string): { projectId?: string; malformed: boolean } {
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "api" || segments[2] !== "projects") return { malformed: false };
  const encodedProjectId = segments[3];
  if (!encodedProjectId) return { malformed: true };
  try {
    const projectId = decodeURIComponent(encodedProjectId);
    if (!projectId || projectId.includes("/") || projectId.includes("\\") || projectId === "." || projectId === "..") return { malformed: true };
    return { projectId, malformed: false };
  } catch {
    return { malformed: true };
  }
}

async function projectRead(request: Request, env: AnyamRealmOAuthEnv, projectId: string): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before inspecting a Project.", receipt: "ownerSession=missing-or-invalid; projectRead=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/projects/{projectId} for the read-only Project summary.", receipt: `project=${projectId}; method=get-required; canonicalWrite=false` }, 405);
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/project/internal", { sessionId, projectId }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: status === 404 ? "project_not_found" : "authority_coordinator_rejected", recoveryAction: status === 404 ? "Verify the Project identifier without probing undiscoverable resources." : "Inspect the Durable Object receipt and retry the same read only when safe.", receipt: `authority=coordinator-rejected; operation=project.inspect; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, status);
  }
}

/**
 * Public Authority Plane edge. The host-only owner session is the current
 * authenticated principal boundary; the Durable Object revalidates the
 * kernel session and owner relationship before applying any command.
 */
export async function handleAuthorityRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const projectRoute = projectIdFromPath(url.pathname);
  const isProjectRoute = url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/");
  if (!url.pathname.startsWith("/api/authority") && !isProjectRoute) return undefined;

  const health = customerRealmWorkerHealth(env);
  if (health.status !== "ready") {
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "customer_realm_configuration_invalid", missingConfiguration: health.missingConfiguration, recoveryAction: health.recoveryAction, receipt: `${health.receipt}; authority=blocked; productReady=false` }, 503);
  }

  if (isProjectRoute) {
    if (projectRoute.malformed) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_project_path", recoveryAction: "Use GET /api/projects/{projectId} with one URL-encoded Project identifier.", receipt: "projectRead=not-accepted; path=malformed; canonicalWrite=false" }, 400);
    if (!projectRoute.projectId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "project_route_not_found", recoveryAction: "Use GET /api/projects/{projectId}.", receipt: `projectRoute=${url.pathname}; transition=not-started; canonicalWrite=false` }, 404);
    return projectRead(request, env, projectRoute.projectId);
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
