/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import {
  PublicGatewayCoordinator,
  PublicGatewayError,
  PUBLIC_GATEWAY_PROTOCOL,
  applyPublicGatewayEdgeLimit,
  parsePublicGatewayLedgerRetentionPolicy,
  parsePublicGatewayProviderOutcome,
  type PublicGatewayState,
  type PublicGatewayStore,
  type PublicGatewayLedgerExport,
} from "../../../src/cloudflare/public-gateway.ts";
import { CloudflarePublicGatewayReplayArchive } from "../../../src/cloudflare/public-gateway-replay-archive.ts";
import {
  createPublicGatewayAbuseProvider,
  type PublicGatewayAbuseMode,
  type PublicGatewayAbuseProvider,
} from "../../../src/cloudflare/public-gateway-abuse.ts";
import {
  CONTRACT_VERSIONS,
  type PublicIntakeMeasuredLimit,
  type PublicIntakePolicy,
} from "../../../src/index.ts";
import { handlePublicGitRequest } from "../../../src/cloudflare/public-git-transport.ts";
import { SmartHttpBudgetTracker, type SmartHttpBudgetPolicy } from "../../../src/portability/smart-http.ts";
import { DurableSmartHttpBudgetCoordinator, emptySmartHttpBudgetCoordinatorState, handleSmartHttpBudgetCoordinatorRequest } from "../../../src/cloudflare/smart-http-budget-coordinator.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../../../src/security/credential-material.ts";

export interface Env {
  PUBLIC_GATEWAY_COORDINATOR: DurableObjectNamespace;
  PUBLIC_GIT_BUDGET_COORDINATOR?: DurableObjectNamespace;
  PUBLIC_GATEWAY_REPLAY_ARCHIVE?: R2Bucket;
  PUBLIC_EDGE_RATE_LIMITER?: RateLimit;
  PUBLIC_PROJECT_ID: string;
  PUBLIC_SOURCE_SPACE_ID: string;
  PUBLIC_SNAPSHOT_ID: string;
  PUBLIC_CONTENT_DIGEST: string;
  PUBLIC_POLICY_RECEIPT: string;
  PUBLIC_EDGE_LIMIT: string;
  PUBLIC_EDGE_LIMIT_UNIT: string;
  PUBLIC_EDGE_LIMIT_RECEIPT: string;
  PUBLIC_EDGE_LIMIT_MEASURED_AT: string;
  PUBLIC_EDGE_LIMIT_METHOD: string;
  PUBLIC_INTAKE_MODE: "rate-limited" | "approval-only";
  PUBLIC_INTAKE_LIMIT?: string;
  PUBLIC_INTAKE_LIMIT_UNIT: string;
  PUBLIC_INTAKE_LIMIT_RECEIPT: string;
  PUBLIC_INTAKE_LIMIT_MEASURED_AT: string;
  PUBLIC_INTAKE_LIMIT_METHOD: string;
  PUBLIC_ENABLE_FIXTURE_FAILURES: string;
  PUBLIC_ABUSE_MODE?: PublicGatewayAbuseMode;
  PUBLIC_TURNSTILE_SECRET_KEY?: string;
  PUBLIC_TURNSTILE_EXPECTED_ACTION?: string;
  PUBLIC_TURNSTILE_EXPECTED_HOSTNAME?: string;
  PUBLIC_TURNSTILE_VERIFY_TIMEOUT_MS?: string;
  PUBLIC_TURNSTILE_VERIFY_TIMEOUT_RECEIPT?: string;
  UPSTREAM_GIT_BASE: string;
  PUBLIC_GIT_REQUEST_BYTES_LIMIT?: string;
  PUBLIC_GIT_RESPONSE_BYTES_LIMIT?: string;
  PUBLIC_GIT_DURATION_MS_LIMIT?: string;
  PUBLIC_GIT_CONCURRENCY_LIMIT?: string;
  PUBLIC_GIT_BUDGET_RECEIPT?: string;
  /** Bound Realm service that validates owner/moderator sessions. */
  PUBLIC_GATEWAY_REALM_AUTHORITY?: Fetcher;
  /** Service-binding secret; never grants moderation by itself. */
  PUBLIC_GATEWAY_REALM_SERVICE_SECRET?: string;
}

type JsonObject = Record<string, unknown>;

class PublicGatewayConfigurationError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Public gateway configuration is incomplete: ${missing.join(", ")}.`);
    this.name = "PublicGatewayConfigurationError";
    this.missing = missing;
  }
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("replace-with")) throw new PublicGatewayConfigurationError([name]);
  return value;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PublicGatewayConfigurationError([name]);
  return parsed;
}

function measuredLimit(input: {
  value: string | undefined;
  unit: string | undefined;
  measuredAt: string | undefined;
  method: string | undefined;
  receipt: string | undefined;
  names: { value: string; unit: string; measuredAt: string; method: string; receipt: string };
}): PublicIntakeMeasuredLimit {
  return {
    value: positiveInteger(input.value, input.names.value),
    unit: required(input.unit, input.names.unit),
    measuredAt: required(input.measuredAt, input.names.measuredAt),
    method: required(input.method, input.names.method),
    receipt: required(input.receipt, input.names.receipt),
  };
}

function abuseConfiguration(env: Env): { mode: PublicGatewayAbuseMode; provider: PublicGatewayAbuseProvider; providerName: string; timeoutMs?: number; timeoutReceipt?: string } {
  const mode = env.PUBLIC_ABUSE_MODE ?? "edge-only";
  if (mode !== "edge-only" && mode !== "turnstile-required") throw new PublicGatewayConfigurationError(["PUBLIC_ABUSE_MODE"]);
  if (mode === "edge-only") return { mode, provider: createPublicGatewayAbuseProvider({ mode }), providerName: "none" };
  const secretKey = required(env.PUBLIC_TURNSTILE_SECRET_KEY, "PUBLIC_TURNSTILE_SECRET_KEY");
  const timeoutMs = positiveInteger(env.PUBLIC_TURNSTILE_VERIFY_TIMEOUT_MS, "PUBLIC_TURNSTILE_VERIFY_TIMEOUT_MS");
  const timeoutReceipt = required(env.PUBLIC_TURNSTILE_VERIFY_TIMEOUT_RECEIPT, "PUBLIC_TURNSTILE_VERIFY_TIMEOUT_RECEIPT");
  return {
    mode,
    provider: createPublicGatewayAbuseProvider({ mode, turnstile: {
      secretKey,
      timeoutMs,
      timeoutReceipt,
      ...(env.PUBLIC_TURNSTILE_EXPECTED_ACTION ? { expectedAction: env.PUBLIC_TURNSTILE_EXPECTED_ACTION } : {}),
      ...(env.PUBLIC_TURNSTILE_EXPECTED_HOSTNAME ? { expectedHostname: env.PUBLIC_TURNSTILE_EXPECTED_HOSTNAME } : {}),
    } }),
    providerName: "cloudflare-turnstile",
    timeoutMs,
    timeoutReceipt,
  };
}

function configuration(env: Env): { policy: PublicIntakePolicy; edgeLimit: PublicIntakeMeasuredLimit; abuse: ReturnType<typeof abuseConfiguration> } {
  const projectId = required(env.PUBLIC_PROJECT_ID, "PUBLIC_PROJECT_ID");
  const sourceSpaceId = required(env.PUBLIC_SOURCE_SPACE_ID, "PUBLIC_SOURCE_SPACE_ID");
  const edgeLimit = measuredLimit({
    value: env.PUBLIC_EDGE_LIMIT,
    unit: env.PUBLIC_EDGE_LIMIT_UNIT,
    measuredAt: env.PUBLIC_EDGE_LIMIT_MEASURED_AT,
    method: env.PUBLIC_EDGE_LIMIT_METHOD,
    receipt: env.PUBLIC_EDGE_LIMIT_RECEIPT,
    names: { value: "PUBLIC_EDGE_LIMIT", unit: "PUBLIC_EDGE_LIMIT_UNIT", measuredAt: "PUBLIC_EDGE_LIMIT_MEASURED_AT", method: "PUBLIC_EDGE_LIMIT_METHOD", receipt: "PUBLIC_EDGE_LIMIT_RECEIPT" },
  });
  const base: PublicIntakePolicy = {
    protocol: CONTRACT_VERSIONS.publicIntake,
    id: `policy:public-gateway:${projectId}`,
    realmId: `realm:gateway:${projectId}`,
    projectId,
    publicSourceSpaceId: sourceSpaceId,
    mode: env.PUBLIC_INTAKE_MODE,
    window: `cloudflare-edge:${edgeLimit.unit}`,
    owner: `realm-owner:${projectId}`,
    receipt: required(env.PUBLIC_POLICY_RECEIPT, "PUBLIC_POLICY_RECEIPT"),
  };
  if (env.PUBLIC_INTAKE_MODE !== "rate-limited" && env.PUBLIC_INTAKE_MODE !== "approval-only") {
    throw new PublicGatewayConfigurationError(["PUBLIC_INTAKE_MODE"]);
  }
  const abuse = abuseConfiguration(env);
  if (env.PUBLIC_INTAKE_MODE === "rate-limited") {
    const logicalLimit = measuredLimit({
      value: env.PUBLIC_INTAKE_LIMIT,
      unit: env.PUBLIC_INTAKE_LIMIT_UNIT,
      measuredAt: env.PUBLIC_INTAKE_LIMIT_MEASURED_AT,
      method: env.PUBLIC_INTAKE_LIMIT_METHOD,
      receipt: env.PUBLIC_INTAKE_LIMIT_RECEIPT,
      names: { value: "PUBLIC_INTAKE_LIMIT", unit: "PUBLIC_INTAKE_LIMIT_UNIT", measuredAt: "PUBLIC_INTAKE_LIMIT_MEASURED_AT", method: "PUBLIC_INTAKE_LIMIT_METHOD", receipt: "PUBLIC_INTAKE_LIMIT_RECEIPT" },
    });
    return { policy: { ...base, configuredLimit: logicalLimit }, edgeLimit, abuse };
  }
  return { policy: base, edgeLimit, abuse };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value, null, 2), { status, headers: responseHeaders });
}

function requestId(body: JsonObject): string {
  const value = body.requestId;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("requestId is required");
  return value;
}

function contributionId(body: JsonObject): string {
  const value = body.contributionId;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("contributionId is required");
  return value;
}

function optionalToken(body: JsonObject): string | undefined {
  const value = body.turnstileToken;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("turnstileToken must be a string when provided");
  return value;
}

const publicGitBudgetTracker = new SmartHttpBudgetTracker("provider=cloudflare-workers; transport=public-git; concurrencyScope=worker-isolate; globalCoordinator=not-qualified");

function publicGitBudget(env: Env): SmartHttpBudgetPolicy {
  const receipt = required(env.PUBLIC_GIT_BUDGET_RECEIPT, "PUBLIC_GIT_BUDGET_RECEIPT");
  if (!/(?:receipt|measure|qualification)/iu.test(receipt)) throw new PublicGatewayConfigurationError(["PUBLIC_GIT_BUDGET_RECEIPT"]);
  return {
    maxRequestBytes: positiveInteger(env.PUBLIC_GIT_REQUEST_BYTES_LIMIT, "PUBLIC_GIT_REQUEST_BYTES_LIMIT"),
    maxResponseBytes: positiveInteger(env.PUBLIC_GIT_RESPONSE_BYTES_LIMIT, "PUBLIC_GIT_RESPONSE_BYTES_LIMIT"),
    maxDurationMs: positiveInteger(env.PUBLIC_GIT_DURATION_MS_LIMIT, "PUBLIC_GIT_DURATION_MS_LIMIT"),
    maxConcurrentRequests: positiveInteger(env.PUBLIC_GIT_CONCURRENCY_LIMIT, "PUBLIC_GIT_CONCURRENCY_LIMIT"),
    receipt: `${receipt}; concurrencyScope=worker-isolate; globalCoordinator=not-qualified`,
  };
}


function envelope(body: JsonObject): JsonObject {
  const value = body.envelope;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("envelope must be a JSON object");
  return value as JsonObject;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}

async function digest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(stable(value)) ?? "null");
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function bodyObject(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("request body must be JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  const body = value as JsonObject;
  const finding = scanCredentialMaterial(body, "request");
  if (finding) throw new Error(`credential material is not accepted at ${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}`);
  return body;
}

function gatewayStub(env: Env): DurableObjectStub {
  const id = env.PUBLIC_GATEWAY_COORDINATOR.idFromName(env.PUBLIC_PROJECT_ID);
  return env.PUBLIC_GATEWAY_COORDINATOR.get(id);
}

async function coordinatorRequest(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return gatewayStub(env).fetch(new Request(`https://coordinator.internal${path}`, init));
}

async function publicGit(request: Request, env: Env): Promise<Response> {
  let upstreamBase: string;
  let publicSourceSpaceId: string;
  try {
    upstreamBase = required(env.UPSTREAM_GIT_BASE, "UPSTREAM_GIT_BASE");
    publicSourceSpaceId = required(env.PUBLIC_SOURCE_SPACE_ID, "PUBLIC_SOURCE_SPACE_ID");
  } catch (error) {
    const missing = error instanceof PublicGatewayConfigurationError ? error.missing.join(",") : "unknown";
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_git_configuration_invalid", recoveryAction: "configure a valid customer-owned HTTPS Repository Driver URL and public Source Space before enabling public reads", receipt: `publicGit=closed; config=${missing}; limit=configuration; asked=missing; providerUrl=not-disclosed; credentialMaterialStored=false` }, 503);
  }
  let budget: SmartHttpBudgetPolicy;
  try {
    budget = publicGitBudget(env);
  } catch (error) {
    const missing = error instanceof PublicGatewayConfigurationError ? error.missing.join(",") : "unknown";
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_git_budget_unavailable", recoveryAction: "measure the public Git workload, configure every named limit and receipt, then retry the same read", receipt: `publicGit=closed; budget=configuration; limit=${missing}; asked=missing; providerUrl=not-disclosed; credentialMaterialStored=false` }, 503);
  }
  if (!env.PUBLIC_GIT_BUDGET_COORDINATOR) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_git_coordinator_unavailable", recoveryAction: "bind the customer-owned Durable Object Smart HTTP budget coordinator before enabling public Git", receipt: "publicGit=closed; coordinator=durable-binding-missing; globalConcurrency=not-enforced; canonicalWrite=false" }, 503);
  try {
    const coordinatorId = env.PUBLIC_GIT_BUDGET_COORDINATOR.idFromName(`public-git:${env.PUBLIC_PROJECT_ID}`);
    const coordinator = new DurableSmartHttpBudgetCoordinator(env.PUBLIC_GIT_BUDGET_COORDINATOR.get(coordinatorId));
    const response = await handlePublicGitRequest(request, { upstreamBase, publicSourceSpaceId, budget, budgetTracker: publicGitBudgetTracker, budgetCoordinator: coordinator });
    return response ?? json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "not_found", recoveryAction: "use the configured public Source Space Git URL", receipt: "publicGitRoute=not-found; privateMetadata=not-disclosed" }, 404);
  } catch {
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_driver_unavailable", recoveryAction: "retain the public projection and retry the provider-backed read after the driver recovers", receipt: "providerUrl=not-disclosed; publicGitRead=unavailable; privateMetadata=not-disclosed" }, 503);
  }
}

export class PublicGitBudgetCoordinatorDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    let response: Response | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReturnType<typeof emptySmartHttpBudgetCoordinatorState>>("state") ?? emptySmartHttpBudgetCoordinatorState();
      const result = await handleSmartHttpBudgetCoordinatorRequest({ request, state });
      await this.ctx.storage.put("state", result.state);
      response = result.response;
    });
    return response ?? json({ protocol: "anyam.smart-http-budget-coordinator/v1", status: "blocked", code: "coordinator_failed", receipt: "coordinator=response-missing; lease=not-applied" }, 503);
  }
}

async function handleAdmin(request: Request, env: Env, action: "state" | "open" | "suspend" | "reopen" | "cleanup" | "ledger-export" | "ledger-compact" | "replay-archive-delete"): Promise<Response> {
  const authority = env.PUBLIC_GATEWAY_REALM_AUTHORITY;
  const serviceSecret = env.PUBLIC_GATEWAY_REALM_SERVICE_SECRET?.trim();
  const realmSession = request.headers.get("x-anyam-realm-session")?.trim();
  if (!authority || typeof authority.fetch !== "function" || !serviceSecret) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "moderation_authority_unavailable", recoveryAction: "bind the customer Realm authority and its service secret before enabling Public Gateway moderation", receipt: "moderationAuthority=not-bound; mutation=false" }, 503);
  if (!realmSession) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "unauthorized", recoveryAction: "authenticate a Realm owner or moderator and send the short-lived Realm session handle", receipt: "moderationAuthorization=realm-session-missing; mutation=false" }, 401);
  const body = request.method === "POST" ? await bodyObject(request) : {};
  let authorization: JsonObject;
  try {
    const response = await authority.fetch(new Request("https://anyam-realm/internal/public-gateway/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anyam-public-gateway-service-secret": serviceSecret },
      body: JSON.stringify({ sessionId: realmSession, projectId: env.PUBLIC_PROJECT_ID, operation: action }),
    }));
    const value: unknown = await response.json().catch(() => ({}));
    authorization = value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
    if (!response.ok || authorization.status !== "authorized") return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "moderation_unauthorized", recoveryAction: "authenticate an active Realm owner or moderator for this Project and retry", receipt: `moderationAuthority=status-${response.status}; mutation=false; privateMetadata=not-disclosed` }, response.status === 503 ? 503 : 403);
  } catch {
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "moderation_authority_unavailable", recoveryAction: "restore the customer Realm service binding and retry the same moderation operation", receipt: "moderationAuthority=unavailable; mutation=false" }, 503);
  }
  const actor = authorization.actor;
  if (actor === null || typeof actor !== "object" || Array.isArray(actor) || typeof (actor as JsonObject).id !== "string" || ((actor as JsonObject).role !== "owner" && (actor as JsonObject).role !== "moderator")) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "moderation_authorization_malformed", recoveryAction: "repair the Realm moderation authorization response before retrying", receipt: "moderationAuthority=malformed; mutation=false" }, 503);
  const path = action === "state" ? "/state" : action === "ledger-export" ? "/ledger/export" : action === "ledger-compact" ? "/ledger/compact" : action === "replay-archive-delete" ? "/ledger/replay-archive/delete-expired" : `/admin/${action}`;
  const coordinatorInit: RequestInit = { method: action === "state" ? "GET" : "POST", headers: { "content-type": "application/json" } };
  if (action !== "state") {
    // The Realm service is the source of actor and role authority. Caller JSON
    // cannot impersonate a moderator or override the authorized Project.
    coordinatorInit.body = JSON.stringify({
      ...body,
      actorId: (actor as JsonObject).id,
      role: (actor as JsonObject).role,
      authorizationReceipt: typeof authorization.receipt === "string" ? authorization.receipt : "realm-moderation-authorized",
    });
  }
  const response = await coordinatorRequest(env, path, coordinatorInit);
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export class PublicGatewayCoordinatorDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    let response: Response | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      response = await this.handle(request);
    });
    return response ?? json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "coordinator_failed", recoveryAction: "retry the same operation identity after inspecting the customer Recovery Checkpoint", receipt: "coordinatorResponse=missing" }, 503);
  }

  private async handle(request: Request): Promise<Response> {
    const env = this.env;
    let configured: ReturnType<typeof configuration>;
    try {
      configured = configuration(env);
    } catch (error) {
      const missing = error instanceof PublicGatewayConfigurationError ? error.missing : ["unknown"];
      return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "configuration_invalid", recoveryAction: "configure the named customer-owned public gateway inputs and retry", receipt: `missing=${missing.join(",")}` }, 503);
    }
    const store: PublicGatewayStore = {
      load: async () => await this.ctx.storage.get<PublicGatewayState>("state"),
      save: async (state) => await this.ctx.storage.put("state", state),
      saveLedgerExport: async (bundle) => await this.ctx.storage.put(`ledger-export:${bundle.exportId}`, bundle),
      loadLedgerExport: async (exportId) => await this.ctx.storage.get<PublicGatewayLedgerExport>(`ledger-export:${exportId}`),
    };
    if (env.PUBLIC_GATEWAY_REPLAY_ARCHIVE) {
      const archive = new CloudflarePublicGatewayReplayArchive(env.PUBLIC_GATEWAY_REPLAY_ARCHIVE, configured.policy.projectId);
      store.archiveReplayTombstone = async (tombstone) => await archive.put(tombstone);
      store.loadReplayTombstone = async (requestId) => await archive.get(requestId);
      store.listReplayTombstones = async () => await archive.list();
      store.deleteReplayTombstone = async (input) => await archive.delete(input.requestId, input.expectedDigest);
    }
    const coordinator = new PublicGatewayCoordinator(configured.policy, store);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/state" && request.method === "GET") return json(await coordinator.snapshot());
      const body = request.method === "POST" ? await bodyObject(request) : {};
      if (url.pathname === "/admin/open" && request.method === "POST") return json(await coordinator.open({ id: String(body.actorId ?? ""), role: body.role === "moderator" ? "moderator" : "owner" }, String(body.receipt ?? "")));
      if (url.pathname === "/admin/suspend" && request.method === "POST") return json(await coordinator.suspend({ id: String(body.actorId ?? ""), role: body.role === "moderator" ? "moderator" : "owner" }, String(body.reason ?? ""), String(body.receipt ?? "")));
      if (url.pathname === "/admin/reopen" && request.method === "POST") return json(await coordinator.reopen({ id: String(body.actorId ?? ""), role: body.role === "moderator" ? "moderator" : "owner" }, String(body.reviewReceipt ?? "")));
      if (url.pathname === "/admin/cleanup" && request.method === "POST") return json(await coordinator.cleanup({ id: String(body.actorId ?? ""), role: body.role === "moderator" ? "moderator" : "owner" }, String(body.cleanupReceipt ?? "")));
      if (url.pathname === "/ledger/export" && request.method === "POST") return json(await coordinator.exportLedger({ actorId: String(body.actorId ?? ""), exportId: String(body.exportId ?? ""), receipt: String(body.receipt ?? "") }));
      if (url.pathname === "/ledger/compact" && request.method === "POST") return json(await coordinator.compactLedger({ actorId: String(body.actorId ?? ""), exportId: String(body.exportId ?? ""), policy: parsePublicGatewayLedgerRetentionPolicy(body.policy), receipt: String(body.receipt ?? "") }));
      if (url.pathname === "/ledger/replay-archive/delete-expired" && request.method === "POST") return json(await coordinator.deleteExpiredReplayArchive({ actor: { id: String(body.actorId ?? ""), role: body.role === "moderator" ? "moderator" : "owner" }, exportId: String(body.exportId ?? ""), legalHold: body.legalHold === "clear" ? "clear" : "active", authorizationReceipt: String(body.authorizationReceipt ?? ""), holdReceipt: String(body.holdReceipt ?? ""), receipt: String(body.receipt ?? "") }));
      if (url.pathname === "/submit" && request.method === "POST") {
        const input = {
          requestId: String(body.requestId ?? ""),
          actorId: String(body.actorId ?? "anonymous"),
          contributionId: String(body.contributionId ?? ""),
          payloadDigest: String(body.payloadDigest ?? ""),
        };
        const provider = parsePublicGatewayProviderOutcome(body.provider);
        return json(await coordinator.submit({ ...input, ...(provider ? { provider } : {}) }));
      }
      return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "not_found", recoveryAction: "use the documented coordinator operation", receipt: `path=${url.pathname}; operation=not-found` }, 404);
    } catch (error) {
      if (error instanceof PublicGatewayError) {
        const status = error.code === "provider-unavailable" ? 503 : error.code === "budget-exceeded" ? 409 : 422;
        return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, ...error.toJSON() }, status);
      }
      const message = error instanceof Error ? error.message : "public gateway coordinator failed";
      return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "coordinator_failed", message, recoveryAction: "inspect the customer Recovery Checkpoint and retry the same operation identity", receipt: `path=${url.pathname}; stateTransition=unknown` }, 422);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let configured: ReturnType<typeof configuration>;
    try {
      configured = configuration(env);
    } catch (error) {
      const missing = error instanceof PublicGatewayConfigurationError ? error.missing : ["unknown"];
      return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, status: "blocked", recoveryAction: "configure the named customer-owned public gateway inputs before enabling public intake", receipt: `missing=${missing.join(",")}; publicIntake=closed` }, 503);
    }
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const stateResponse = await coordinatorRequest(env, "/state", { method: "GET" });
      const state = stateResponse.ok ? await stateResponse.json<PublicGatewayState>() : undefined;
      return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, intakeProtocol: CONTRACT_VERSIONS.publicIntake, status: state?.status ?? "closed", projectId: env.PUBLIC_PROJECT_ID, publicSourceSpaceId: env.PUBLIC_SOURCE_SPACE_ID, snapshotId: required(env.PUBLIC_SNAPSHOT_ID, "PUBLIC_SNAPSHOT_ID"), contentDigest: required(env.PUBLIC_CONTENT_DIGEST, "PUBLIC_CONTENT_DIGEST"), publicProjection: true, privateSourceSpace: "not-discoverable", landingAuthority: false, edgeLimiter: { provider: "cloudflare-workers-rate-limit", configuredLimit: configured.edgeLimit, logicalLedgerAuthoritative: false }, abuseControl: { mode: configured.abuse.mode, provider: configured.abuse.providerName, failOpen: false, timeoutMs: configured.abuse.timeoutMs, timeoutReceipt: configured.abuse.timeoutReceipt }, recoveryAction: state?.recoveryCheckpoint ?? "owner must explicitly open Public Intake", receipt: `gateway=${PUBLIC_GATEWAY_PROTOCOL}; customerOperated=true; policy=${configured.policy.receipt}; providerUrl=not-disclosed` });
    }
    if (url.pathname === "/public/source-manifest" && request.method === "GET") return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, projectId: env.PUBLIC_PROJECT_ID, publicSourceSpaceId: env.PUBLIC_SOURCE_SPACE_ID, snapshotId: required(env.PUBLIC_SNAPSHOT_ID, "PUBLIC_SNAPSHOT_ID"), contentDigest: required(env.PUBLIC_CONTENT_DIGEST, "PUBLIC_CONTENT_DIGEST"), privateSourceSpaces: "not-discoverable", landingAuthority: false, gitUrl: `${url.origin}/projects/public/source.git` });
    if (url.pathname.startsWith("/projects/public/source.git/")) return publicGit(request, env);
    if (url.pathname === "/public/contributions" && request.method === "POST") {
      let body: JsonObject;
      try {
        body = await bodyObject(request);
        const envelopeValue = envelope(body);
        const id = requestId(body);
        const contribution = contributionId(body);
        const edgeKey = `public-contribution:${env.PUBLIC_PROJECT_ID}:${request.headers.get("cf-connecting-ip") ?? "unknown-client"}`;
        if (!env.PUBLIC_EDGE_RATE_LIMITER) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "edge_limiter_unconfigured", recoveryAction: "bind the customer-owned Cloudflare Rate Limiting namespace before opening public intake", receipt: "edgeLimiter=missing; materialized=false" }, 503);
        const edge = await applyPublicGatewayEdgeLimit({ limiter: env.PUBLIC_EDGE_RATE_LIMITER, key: edgeKey, configuredLimit: configured.edgeLimit, requestId: id });
        if (edge.status === "denied") return json(edge, 429);
        const token = optionalToken(body);
        const clientIp = request.headers.get("cf-connecting-ip");
        const abuse = await configured.abuse.provider.evaluate({ requestId: id, ...(token ? { token } : {}), ...(clientIp ? { clientIp } : {}) });
        const payloadDigest = await digest({ requestId: id, contributionId: contribution, envelope: envelopeValue });
        const provider = env.PUBLIC_ENABLE_FIXTURE_FAILURES === "true" && request.headers.get("x-anyam-fixture-provider") === "timeout" ? "timeout" : undefined;
        const providerOutcome = abuse.outcome === "allowed" ? undefined : { status: "abuse" as const, outcome: abuse.outcome, retryable: abuse.retryable, receipt: abuse.receipt };
        const providerInput = providerOutcome ?? (provider ? { status: "timeout" as const, receipt: "provider=fixture-driver; timeout=simulated; retryable=true" } : undefined);
        const response = await coordinatorRequest(env, "/submit", { method: "POST", body: JSON.stringify({ requestId: id, actorId: "anonymous", contributionId: contribution, payloadDigest, ...(providerInput ? { provider: providerInput } : {}) }), headers: { "content-type": "application/json" } });
        const responseBody = await response.json<JsonObject>();
        const abuseStatus = abuse.outcome === "unavailable" ? 503 : abuse.outcome === "challenge" || abuse.outcome === "denied" ? 403 : response.status;
        return json({ ...responseBody, edge, abuse: { ...abuse, receipt: abuse.receipt } }, abuseStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : "public contribution request failed";
        return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "invalid_request", message, recoveryAction: "provide requestId, contributionId, and a JSON envelope, then retry without exposing private Source Space data", receipt: "publicContribution=not-materialized" }, 422);
      }
    }
    if (url.pathname === "/admin/state" && request.method === "GET") return handleAdmin(request, env, "state");
    if (url.pathname === "/admin/open" && request.method === "POST") return handleAdmin(request, env, "open");
    if (url.pathname === "/admin/suspend" && request.method === "POST") return handleAdmin(request, env, "suspend");
    if (url.pathname === "/admin/reopen" && request.method === "POST") return handleAdmin(request, env, "reopen");
    if (url.pathname === "/admin/cleanup" && request.method === "POST") return handleAdmin(request, env, "cleanup");
    if (url.pathname === "/admin/ledger/export" && request.method === "POST") return handleAdmin(request, env, "ledger-export");
    if (url.pathname === "/admin/ledger/compact" && request.method === "POST") return handleAdmin(request, env, "ledger-compact");
    if (url.pathname === "/admin/ledger/replay-archive/delete-expired" && request.method === "POST") return handleAdmin(request, env, "replay-archive-delete");
    if (request.method !== "GET") return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "method_not_allowed", recoveryAction: "use the public read or contribution-envelope routes", receipt: "canonicalWrite=false" }, 405);
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "not_found", recoveryAction: "use /health, /public/source-manifest, /projects/public/source.git, or /public/contributions", receipt: "path=not-found; privateMetadata=not-disclosed" }, 404);
  },
};
