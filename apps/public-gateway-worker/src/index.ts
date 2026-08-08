/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import {
  PublicGatewayCoordinator,
  PUBLIC_GATEWAY_PROTOCOL,
  applyPublicGatewayEdgeLimit,
  parsePublicGatewayLedgerRetentionPolicy,
  parsePublicGatewayProviderOutcome,
  type PublicGatewayState,
  type PublicGatewayStore,
  type PublicGatewayLedgerExport,
} from "../../../src/cloudflare/public-gateway.ts";
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

export interface Env {
  PUBLIC_GATEWAY_COORDINATOR: DurableObjectNamespace;
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
  ADMIN_TOKEN: string;
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
  return value as JsonObject;
}

function adminAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected || expected.includes("replace-with")) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function gatewayStub(env: Env): DurableObjectStub {
  const id = env.PUBLIC_GATEWAY_COORDINATOR.idFromName(env.PUBLIC_PROJECT_ID);
  return env.PUBLIC_GATEWAY_COORDINATOR.get(id);
}

async function coordinatorRequest(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return gatewayStub(env).fetch(new Request(`https://coordinator.internal${path}`, init));
}

async function publicGit(request: Request, env: Env): Promise<Response> {
  const prefix = "/projects/public/source.git/";
  const url = new URL(request.url);
  const suffix = url.pathname.slice(prefix.length);
  if (suffix.length === 0 || suffix.includes("..") || suffix.includes("\\") || suffix.includes("\0")) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "not_found", recoveryAction: "use the configured public Source Space Git URL", receipt: "publicGitPath=invalid; privateMetadata=not-disclosed" }, 404);
  if (suffix.endsWith("git-receive-pack")) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "canonical_write_denied", recoveryAction: "create a public Change contribution envelope; anonymous Git receive-pack is never enabled", receipt: "publicGitOperation=receive-pack; canonicalWrite=false; materialized=false" }, 403);
  if (request.method !== "GET" && !(request.method === "POST" && suffix.endsWith("git-upload-pack"))) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "method_not_allowed", recoveryAction: "use public Git upload-pack reads or the contribution envelope endpoint", receipt: `publicGitOperation=${request.method}; canonicalWrite=false` }, 405);

  let upstream: URL;
  try {
    const upstreamBase = new URL(required(env.UPSTREAM_GIT_BASE, "UPSTREAM_GIT_BASE"));
    if (upstreamBase.protocol !== "https:" && upstreamBase.protocol !== "http:") throw new Error("unsupported provider protocol");
    if (upstreamBase.username || upstreamBase.password || upstreamBase.hash) throw new Error("provider URL must not contain credentials or a fragment");
    upstream = new URL(suffix + url.search, upstreamBase.toString().endsWith("/") ? upstreamBase : `${upstreamBase}/`);
  } catch {
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_driver_unavailable", recoveryAction: "configure a valid customer-owned public Repository Driver URL and retry the provider-backed read", receipt: "providerUrl=not-disclosed; providerConfiguration=invalid; privateMetadata=not-disclosed" }, 503);
  }
  const headers = new Headers();
  for (const name of ["accept", "content-type", "content-encoding", "git-protocol"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    const upstreamInit: RequestInit = { method: request.method, headers };
    if (request.method !== "GET") upstreamInit.body = request.body;
    response = await fetch(upstream, upstreamInit);
  } catch {
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_driver_unavailable", recoveryAction: "retain the public projection and retry the provider-backed read after the driver recovers", receipt: "providerUrl=not-disclosed; publicGitRead=unavailable; privateMetadata=not-disclosed" }, 503);
  }
  if (!response.ok) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "public_driver_unavailable", recoveryAction: "inspect the provider adapter and retry the same public read", receipt: `providerStatus=${response.status}; providerUrl=not-disclosed; privateMetadata=not-disclosed` }, 503);
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-encoding", "etag", "last-modified", "cache-control", "vary"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-anyam-public-projection", "true");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

async function handleAdmin(request: Request, env: Env, action: "state" | "open" | "suspend" | "reopen" | "cleanup" | "ledger-export" | "ledger-compact"): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "unauthorized", recoveryAction: "authenticate the customer Realm owner or moderator; no public gateway mutation was performed", receipt: "adminAuthorization=missing-or-invalid; mutation=false" }, 401);
  const body = request.method === "POST" ? await bodyObject(request) : {};
  const path = action === "state" ? "/state" : action === "ledger-export" ? "/ledger/export" : action === "ledger-compact" ? "/ledger/compact" : `/admin/${action}`;
  const coordinatorInit: RequestInit = { method: action === "state" ? "GET" : "POST", headers: { "content-type": "application/json" } };
  if (action !== "state") {
    // The qualification adapter has one owner-scoped secret. Do not let a
    // caller-controlled JSON field impersonate a moderator or another actor;
    // a future Realm auth adapter must supply richer role/capability claims.
    coordinatorInit.body = JSON.stringify({
      ...body,
      actorId: `realm-owner:${env.PUBLIC_PROJECT_ID}`,
      role: "owner",
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
    if (request.method !== "GET") return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "method_not_allowed", recoveryAction: "use the public read or contribution-envelope routes", receipt: "canonicalWrite=false" }, 405);
    return json({ protocol: PUBLIC_GATEWAY_PROTOCOL, code: "not_found", recoveryAction: "use /health, /public/source-manifest, /projects/public/source.git, or /public/contributions", receipt: "path=not-found; privateMetadata=not-disclosed" }, 404);
  },
};
