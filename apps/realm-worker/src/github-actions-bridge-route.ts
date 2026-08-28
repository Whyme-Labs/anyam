import { anyamRealmOwnerSessionId, requestAnyamRealmCoordinator } from "./passkey-owner.ts";
import type { AnyamRealmOAuthEnv } from "./oauth-provider.ts";
import { encodeGitHubActionsBridgeHistory, encodeGitHubActionsBridgeSourcePackage, parseGitHubActionsBridgeHistory, parseGitHubActionsBridgeMode, parseGitHubActionsBridgePlan, parseGitHubActionsBridgeSourcePackage } from "./github-actions-bridge-contract.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../../../src/security/credential-material.ts";

const BRIDGE_PROTOCOL = "anyam.github-actions-bridge/v1" as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("body=object-required");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}=string-required`);
  return value.trim();
}

function blocked(code: string, recoveryAction: string, receipt: string, status = 422): Response {
  return json({ protocol: BRIDGE_PROTOCOL, status: "blocked", code, recoveryAction, receipt: `${receipt}; credentialMaterialStored=false; canonicalWrite=false` }, status);
}

function rejectCredentialFields(value: Record<string, unknown>): void {
  const finding = scanCredentialMaterial(value, "body");
  if (finding) throw new Error(`credentialField=${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialMaterial=not-accepted`);
}

async function exchange(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with one connectionId, operation, and GitHub OIDC assertion", "bridge=exchange; method=post-required", 405);
  let value: Record<string, unknown>;
  try { value = await body(request); } catch { return blocked("invalid_request", "send a JSON object containing connectionId, operation, and token", "bridge=exchange; body=object-required"); }
  let connectionId: string;
  let operation: string;
  let token: string;
  try { connectionId = text(value.connectionId, "connectionId"); operation = text(value.operation, "operation"); token = text(value.token, "token"); } catch (error) { return blocked("invalid_request", "send non-empty connectionId, operation, and token fields; token material is never stored", error instanceof Error ? error.message : "bridge=exchange; fields-invalid"); }
  if (operation !== "inbound" && operation !== "outbound" && operation !== "proposal") return blocked("operation_invalid", "use the exact owner-approved inbound, proposal, or outbound Bridge operation", `connection=${connectionId}; operation=${operation}`);
  let connection: Record<string, unknown>;
  try {
    connection = await requestAnyamRealmCoordinator(env, "/github-actions-bridge/audience/internal", { connectionId });
  } catch {
    return blocked("connection_unavailable", "inspect the customer Realm Bridge connection and retry the same workflow run", `connection=${connectionId}; audience=unavailable`, 404);
  }
  const audience = text(connection.audience, "audience");
  const verifier = env.ANYAM_GITHUB_OIDC_VERIFIER;
  if (!verifier) return blocked("oidc_verifier_unconfigured", "bind the customer-owned GitHub OIDC verifier before accepting a workflow assertion", `connection=${connectionId}; verifier=configured=false`, 503);
  let verification: unknown;
  try {
    const response = await verifier.fetch("https://anyam-github-oidc-verifier/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId, audience, token }) });
    verification = await response.json().catch(() => ({}));
    if (!response.ok) return blocked("oidc_verification_failed", "inspect the customer-owned OIDC verifier receipt and request a fresh workflow token", `connection=${connectionId}; verifier=http-${response.status}; capability=not-issued`, 403);
  } catch {
    return blocked("oidc_verification_unavailable", "restore the customer-owned OIDC verifier and retry the same workflow run", `connection=${connectionId}; verifier=unavailable; capability=not-issued`, 503);
  }
  try {
    return json(await requestAnyamRealmCoordinator(env, "/github-actions-bridge/exchange/internal", { connectionId, operation, verification }));
  } catch {
    return blocked("bridge_exchange_rejected", "inspect the credential-free Realm receipt and retry only the same immutable workflow operation", `connection=${connectionId}; exchange=rejected`, 409);
  }
}

async function outboundBundle(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with the outbound capability ID and run observation", "bridge=outbound-bundle; method=post-required", 405);
  try {
    const value = await body(request);
    rejectCredentialFields(value);
    return json(await requestAnyamRealmCoordinator(env, "/github-actions-bridge/outbound/bundle/internal", value));
  } catch (error) {
    return blocked("outbound_bundle_rejected", "request a fresh outbound OIDC capability and inspect the exact Mirror checkpoint", `bridge=outbound-bundle; error=${error instanceof Error ? error.message : "invalid"}`, 409);
  }
}

async function outboundComplete(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with the exact plan, signed bundle, run observation, and provider read-back", "bridge=outbound-complete; method=post-required", 405);
  try {
    const value = await body(request);
    rejectCredentialFields(value);
    return json(await requestAnyamRealmCoordinator(env, "/github-actions-bridge/outbound/complete/internal", value));
  } catch (error) {
    return blocked("outbound_completion_rejected", "inspect the exact outbound Mirror checkpoint and provider read-back; no canonical state changed", `bridge=outbound-complete; error=${error instanceof Error ? error.message : "invalid"}`, 409);
  }
}

async function createConnection(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with the owner-approved GitHub repository and Bridge policy", "bridge=connection-create; method=post-required", 405);
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return blocked("owner_authentication_required", "authenticate the Realm owner before creating a Bridge connection", "bridge=connection-create; ownerSession=missing", 401);
  try {
    const value = await body(request);
    const connection = value.connection ?? value;
    return json(await requestAnyamRealmCoordinator(env, "/github-actions-bridge/connection/create/internal", { sessionId, connection }));
  } catch (error) {
    return blocked("bridge_connection_rejected", "correct the exact repository identity, workflow ref, ref policy, operation set, audience, and future expiry", `bridge=connection-create; error=${error instanceof Error ? error.message : "invalid"}`, 422);
  }
}

async function revokeConnection(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with connectionId and an owner-visible reason", "bridge=connection-revoke; method=post-required", 405);
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return blocked("owner_authentication_required", "authenticate the Realm owner before revoking a Bridge connection", "bridge=connection-revoke; ownerSession=missing", 401);
  try {
    const value = await body(request);
    return json(await requestAnyamRealmCoordinator(env, "/github-actions-bridge/connection/revoke/internal", { sessionId, connectionId: text(value.connectionId, "connectionId"), reason: text(value.reason, "reason") }));
  } catch (error) {
    return blocked("bridge_connection_revoke_rejected", "inspect the connection checkpoint and retry the same owner-authorized revoke", `bridge=connection-revoke; error=${error instanceof Error ? error.message : "invalid"}`, 422);
  }
}

async function parseTransfer(value: Record<string, unknown>): Promise<{ sourcePackage: ReturnType<typeof parseGitHubActionsBridgeSourcePackage>; mode: "initial-import" | "proposal" }> {
  const sourcePackage = parseGitHubActionsBridgeSourcePackage(value.sourcePackage);
  const mode = parseGitHubActionsBridgeMode(value.mode);
  return { sourcePackage, mode };
}

async function inspectHistory(env: AnyamRealmOAuthEnv, sourcePackage: ReturnType<typeof parseGitHubActionsBridgeSourcePackage>): Promise<ReturnType<typeof parseGitHubActionsBridgeHistory>> {
  const importer = env.ANYAM_GITHUB_BRIDGE_IMPORTER;
  if (!importer) throw new Error("repository_driver_history_service_unconfigured");
  const response = await importer.fetch("https://anyam-github-actions-bridge/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "anyam.github-actions-bridge-service/v1", operation: "inspect-history", sourcePackage: encodeGitHubActionsBridgeSourcePackage(sourcePackage) }) });
  const result: unknown = await response.json().catch(() => ({}));
  if (!response.ok || result === null || typeof result !== "object" || Array.isArray(result) || (result as Record<string, unknown>).status !== "succeeded") throw new Error(`repository_driver_history_rejected; httpStatus=${response.status}`);
  return parseGitHubActionsBridgeHistory((result as Record<string, unknown>).history);
}

async function prepare(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with a complete sourcePackage, RepositoryDriver history, and mode", "bridge=prepare; method=post-required", 405);
  try {
    const value = await body(request);
    const transfer = await parseTransfer(value);
    const history = await inspectHistory(env, transfer.sourcePackage);
    const result = await requestAnyamRealmCoordinator(env, "/github-actions-bridge/prepare/internal", { sourcePackage: encodeGitHubActionsBridgeSourcePackage(transfer.sourcePackage), history: encodeGitHubActionsBridgeHistory(history), mode: transfer.mode });
    return json(result);
  } catch (error) {
    return blocked("bridge_prepare_rejected", "correct the complete bundle, refs, object format, LFS manifest, capability binding, and RepositoryDriver history receipt", `bridge=prepare; error=${error instanceof Error ? error.message : "invalid"}`, 422);
  }
}

async function proposal(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with a complete sourcePackage, RepositoryDriver history, and ready proposal plan", "bridge=proposal; method=post-required", 405);
  try {
    const value = await body(request);
    const transfer = await parseTransfer(value);
    const history = await inspectHistory(env, transfer.sourcePackage);
    const plan = parseGitHubActionsBridgePlan(value.plan);
    if (transfer.mode !== "proposal") return blocked("mode_invalid", "use mode=proposal for a GitHub-ahead Change proposal", `bridge=proposal; mode=${transfer.mode}`);
    const result = await requestAnyamRealmCoordinator(env, "/github-actions-bridge/proposal/internal", { sourcePackage: encodeGitHubActionsBridgeSourcePackage(transfer.sourcePackage), history: encodeGitHubActionsBridgeHistory(history), plan });
    return json(result);
  } catch (error) {
    return blocked("bridge_proposal_rejected", "inspect the owner-visible proposal checkpoint and retry only the same immutable operation", `bridge=proposal; error=${error instanceof Error ? error.message : "invalid"}`, 422);
  }
}

async function activate(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  if (request.method !== "POST") return blocked("method_not_allowed", "use POST with a complete sourcePackage, RepositoryDriver history, and awaiting-owner plan", "bridge=activate; method=post-required", 405);
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return blocked("owner_authentication_required", "authenticate the Project owner before confirming the exact empty-Project import", "bridge=activate; ownerSession=missing", 401);
  try {
    const value = await body(request);
    const transfer = await parseTransfer(value);
    const history = await inspectHistory(env, transfer.sourcePackage);
    const plan = parseGitHubActionsBridgePlan(value.plan);
    if (transfer.mode !== "initial-import") return blocked("mode_invalid", "use mode=initial-import for an owner-confirmed empty Project import", `bridge=activate; mode=${transfer.mode}`);
    const result = await requestAnyamRealmCoordinator(env, "/github-actions-bridge/activate/internal", { sessionId, sourcePackage: encodeGitHubActionsBridgeSourcePackage(transfer.sourcePackage), history: encodeGitHubActionsBridgeHistory(history), plan });
    return json(result);
  } catch (error) {
    return blocked("bridge_activation_rejected", "inspect the owner-visible import checkpoint and retry only the same immutable operation", `bridge=activate; error=${error instanceof Error ? error.message : "invalid"}`, 422);
  }
}

export async function handleGitHubActionsBridgeRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/owner/integrations/github-actions/bridge/connections") return createConnection(request, env);
  if (pathname === "/api/owner/integrations/github-actions/bridge/connections/revoke") return revokeConnection(request, env);
  if (pathname === "/api/integrations/github-actions/bridge/exchange") return exchange(request, env);
  if (pathname === "/api/integrations/github-actions/bridge/outbound/bundle") return outboundBundle(request, env);
  if (pathname === "/api/integrations/github-actions/bridge/outbound/complete") return outboundComplete(request, env);
  if (pathname === "/api/integrations/github-actions/bridge/prepare") return prepare(request, env);
  if (pathname === "/api/integrations/github-actions/bridge/proposal") return proposal(request, env);
  if (pathname === "/api/owner/integrations/github-actions/bridge/activate") return activate(request, env);
  return undefined;
}
