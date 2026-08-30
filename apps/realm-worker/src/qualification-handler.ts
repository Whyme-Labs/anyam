import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";
import type { AnyamRealmMcpEnv, AnyamRealmMcpProps } from "./mcp-handler.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../../../src/security/credential-material.ts";
import {
  ANYAM_GITHUB_APP_QUALIFICATION_PATH,
  ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL,
  ANYAM_GITHUB_APP_QUALIFICATION_SCOPE,
  type AnyamGitHubAppQualificationOperation,
} from "./qualification-protocol.ts";

const QUALIFICATION_BODY_BYTES_LIMIT = 262_144;
const QUALIFICATION_BODY_SIZING_RECEIPT = "bodyBytesLimit=262144; sizing=qualification-tripwire; remeasure-before-production";

type JsonObject = Record<string, unknown>;

class CoordinatorRejection extends Error {
  readonly httpStatus: number;
  readonly coordinatorCode: string | undefined;
  readonly coordinatorMessage: string | undefined;
  readonly coordinatorRecoveryAction: string | undefined;
  readonly coordinatorReceipt: string | undefined;

  constructor(input: { httpStatus: number; code?: string; message?: string; recoveryAction?: string; receipt?: string }) {
    super(input.code ?? `coordinator-http-${input.httpStatus}`);
    this.name = "CoordinatorRejection";
    this.httpStatus = input.httpStatus;
    this.coordinatorCode = input.code;
    this.coordinatorMessage = input.message;
    this.coordinatorRecoveryAction = input.recoveryAction;
    this.coordinatorReceipt = input.receipt;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field}=required`);
  return value.trim();
}

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}=object-required`);
  return value as JsonObject;
}

async function boundedBody(request: Request): Promise<JsonObject> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > QUALIFICATION_BODY_BYTES_LIMIT) {
        await reader.cancel();
        throw new Error("body-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return object(JSON.parse(new TextDecoder().decode(body)), "body");
  } catch (error) {
    if (error instanceof Error && error.message === "body=object-required") throw error;
    throw new Error("body=json-object-required");
  }
}

async function coordinator(env: AnyamRealmMcpEnv, path: string, body: JsonObject): Promise<JsonObject> {
  const binding = env.REALM_COORDINATOR as { idFromName(name: string): string; get(id: string): { fetch(request: Request): Promise<Response> } } | undefined;
  if (!binding || typeof binding.idFromName !== "function") throw new Error("realm-coordinator-unavailable");
  const realmId = typeof env.ANYAM_INSTALLATION_ID === "string" && env.ANYAM_INSTALLATION_ID.trim().length > 0 ? `realm:${env.ANYAM_INSTALLATION_ID.trim()}` : undefined;
  if (!realmId) throw new Error("realm-installation-unconfigured");
  const response = await binding.get(binding.idFromName(realmId)).fetch(new Request(`https://anyam-realm-coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE },
    body: JSON.stringify(body),
  }));
  const value = await response.json().catch(() => undefined);
  const payload = object(value, "coordinator-response");
  if (!response.ok) {
    throw new CoordinatorRejection({
      httpStatus: response.status,
      ...(typeof payload.code === "string" ? { code: payload.code } : {}),
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
      ...(typeof payload.recoveryAction === "string" ? { recoveryAction: payload.recoveryAction } : {}),
      ...(typeof payload.receipt === "string" ? { receipt: payload.receipt } : {}),
    });
  }
  return payload;
}

function coordinatorFailure(error: unknown, operation: string): Response {
  if (error instanceof CoordinatorRejection) {
    const status = error.httpStatus === 404 ? 404 : error.httpStatus === 409 ? 409 : error.httpStatus === 422 ? 422 : error.httpStatus === 401 || error.httpStatus === 403 ? 403 : 503;
    const errorClass = status === 404 ? "not_found" : status === 409 ? "conflict" : status === 422 ? "invalid_request" : status === 403 ? "session_rejected" : "unavailable";
    const coordinator = {
      httpStatus: error.httpStatus,
      code: error.coordinatorCode ?? "not-returned",
      ...(error.coordinatorMessage ? { message: error.coordinatorMessage } : {}),
      ...(error.coordinatorRecoveryAction ? { recoveryAction: error.coordinatorRecoveryAction } : {}),
      ...(error.coordinatorReceipt ? { receipt: error.coordinatorReceipt } : {}),
    };
    return json({
      protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL,
      status: "blocked",
      code: "qualification_coordinator_rejected",
      recoveryAction: error.coordinatorRecoveryAction ?? (status === 404 ? "verify the disposable qualification Project, Workspace, Mirror, or recovery identity and retry the same operation" : status === 409 ? "read the current qualification checkpoint, reuse the original idempotency key, or start a fresh disposable qualification" : status === 422 ? "correct the typed qualification payload and retry without widening the capability" : status === 403 ? "reauthorize the owner OAuth grant through a current passkey-authenticated Realm session" : "inspect the customer Realm coordinator and retry the same idempotent operation when safe"),
      coordinator,
      receipt: `qualification=github-app; operation=${operation}; errorClass=${errorClass}; coordinatorStatus=${error.httpStatus}; coordinatorCode=${error.coordinatorCode ?? "not-returned"}; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false; canonicalWrite=false`,
    }, status);
  }
  const detail = error instanceof Error ? error.message : "coordinator-rejected";
  const status = detail.includes("not_found") ? 404 : detail.includes("conflict") || detail.includes("stale_state") ? 409 : detail.includes("invalid_request") || detail.includes("required") ? 422 : detail.includes("owner") || detail.includes("session") || detail.includes("unauthorized") ? 403 : 503;
  const errorClass = status === 404 ? "not_found" : status === 409 ? "conflict" : status === 422 ? "invalid_request" : "unavailable";
  return json({
    protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL,
    status: "blocked",
    code: "qualification_coordinator_rejected",
    recoveryAction: status === 404 ? "verify the disposable qualification Project, Workspace, Mirror, or recovery identity and retry the same operation" : status === 409 ? "read the current qualification checkpoint, reuse the original idempotency key, or start a fresh disposable qualification" : status === 422 ? "correct the typed qualification payload and retry without widening the capability" : "inspect the customer Realm coordinator and retry the same idempotent operation when safe",
    receipt: `qualification=github-app; operation=${operation}; errorClass=${errorClass}; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false; canonicalWrite=false`,
  }, status);
}

function commandBody(body: JsonObject, sessionId: string, command: string): JsonObject {
  return {
    protocol: "anyam.authority-command/v1",
    command,
    idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"),
    ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
    payload: object(body.payload, "payload"),
    sessionId,
  };
}

export async function handleAnyamGitHubAppQualificationRequest(request: Request, env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== ANYAM_GITHUB_APP_QUALIFICATION_PATH) return undefined;
  if (request.method !== "POST") return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "use POST for the owner-approved GitHub App qualification capability", receipt: `qualification=github-app; method=post-required; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false` }, 405);
  if (!props.scopes.includes(ANYAM_GITHUB_APP_QUALIFICATION_SCOPE)) return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "scope_denied", recoveryAction: `authorize ${ANYAM_GITHUB_APP_QUALIFICATION_SCOPE} through a fresh passkey-approved OAuth grant`, receipt: `qualification=github-app; scope=${ANYAM_GITHUB_APP_QUALIFICATION_SCOPE}; authorization=denied; credentialMaterialStored=false` }, 403);
  if (!props.kernelSessionId || !props.realmId) return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "session_binding_missing", recoveryAction: "reauthorize the owner OAuth grant so it carries the current opaque Realm session", receipt: `qualification=github-app; session=missing; credentialMaterialStored=false` }, 403);
  const configuredRealm = typeof env.ANYAM_INSTALLATION_ID === "string" && env.ANYAM_INSTALLATION_ID.trim().length > 0 ? `realm:${env.ANYAM_INSTALLATION_ID.trim()}` : undefined;
  if (!configuredRealm || props.realmId !== configuredRealm) return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "realm_binding_mismatch", recoveryAction: "reauthorize the OAuth grant through the customer Realm that issued it", receipt: `qualification=github-app; realm=resource-mismatch; credentialMaterialStored=false` }, 403);
  const expectedResource = new URL("/mcp", request.url).toString();
  if (props.mcpResource !== undefined && props.mcpResource !== expectedResource) return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "resource_binding_mismatch", recoveryAction: "reauthorize the qualification grant for the exact Realm /mcp resource", receipt: `qualification=github-app; resource=audience-mismatch; credentialMaterialStored=false` }, 403);

  let body: JsonObject;
  try {
    body = await boundedBody(request);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "body-too-large";
    return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: tooLarge ? "body_too_large" : "invalid_request", recoveryAction: tooLarge ? "send only the bounded typed qualification operation and payload" : "send one JSON object with the qualification protocol and operation", receipt: `qualification=github-app; body=${tooLarge ? "too-large" : "invalid"}; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false` }, tooLarge ? 413 : 422);
  }

  const credentialFinding = scanCredentialMaterial(body, "qualificationRequest");
  if (credentialFinding) return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "credential_material_rejected", recoveryAction: "remove provider credentials and send only typed qualification identities, digests, and receipts", receipt: `qualification=github-app; field=${credentialFinding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; transition=not-applied; credentialMaterialStored=false` }, 422);

  const operation = body.operation as AnyamGitHubAppQualificationOperation;
  if (body.protocol !== ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL || typeof operation !== "string") return json({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, status: "blocked", code: "invalid_request", recoveryAction: "send the exact qualification protocol and one documented operation", receipt: `qualification=github-app; envelope=invalid; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false` }, 422);
  const sessionId = props.kernelSessionId;
  try {
    let result: JsonObject;
    switch (operation) {
      case "authority.state.inspect":
        result = await coordinator(env, "/authority/state/internal", { sessionId });
        break;
      case "authority.project.inspect":
        result = await coordinator(env, "/authority/project/internal", { sessionId, projectId: requiredString(body.projectId, "projectId") });
        break;
      case "authority.project.create":
        result = await coordinator(env, "/authority/command/internal", commandBody(body, sessionId, "project.create"));
        break;
      case "authority.workspace.create":
        result = await coordinator(env, "/authority/command/internal", commandBody(body, sessionId, "workspace.create"));
        break;
      case "authority.mirror.inspect":
        result = await coordinator(env, "/authority/mirrors/internal", { sessionId, ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}), ...(typeof body.mirrorId === "string" ? { mirrorId: body.mirrorId } : {}) });
        break;
      case "authority.mirror.configure":
        result = await coordinator(env, "/authority/command/internal", commandBody(body, sessionId, "mirror.configure"));
        break;
      case "authority.mirror.mutate": {
        const mirrorOperation = requiredString(body.mirrorOperation, "mirrorOperation");
        if (mirrorOperation !== "sync" && mirrorOperation !== "reconcile") throw new Error("mirrorOperation=unsupported");
        result = await coordinator(env, "/authority/qualification/mirror/internal", { sessionId, idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"), operation: mirrorOperation, payload: object(body.payload, "payload") });
        break;
      }
      case "authority.recovery.export":
        result = await coordinator(env, "/authority/recovery/export/internal", { sessionId });
        break;
      case "authority.recovery.restore":
        result = await coordinator(env, "/authority/recovery/restore/internal", { sessionId, idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"), bundle: object(body.bundle, "bundle") });
        break;
      case "authority.recovery.activate":
        result = await coordinator(env, "/authority/recovery/activate/internal", { sessionId, idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"), bundleId: requiredString(body.bundleId, "bundleId"), bundleDigest: requiredString(body.bundleDigest, "bundleDigest") });
        break;
      default:
        throw new Error("operation=unsupported");
    }
    return json({ ...result, qualificationCapability: ANYAM_GITHUB_APP_QUALIFICATION_SCOPE, qualificationProtocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, credentialValues: "not-printed", canonicalWrite: false, receipt: `${typeof result.receipt === "string" ? result.receipt : "qualification=github-app"}; capability=${ANYAM_GITHUB_APP_QUALIFICATION_SCOPE}; ${QUALIFICATION_BODY_SIZING_RECEIPT}; credentialMaterialStored=false; canonicalWrite=false` }, 200);
  } catch (error) {
    return coordinatorFailure(error, operation);
  }
}
