/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import {
  HOSTED_SAAS_ISOLATION_PROTOCOL,
  HostedSaaSIsolationStore,
  HostedSaaSRouter,
  type HostedSaaSIsolationSnapshot,
} from "../../../src/cloudflare/hosted-saas-isolation.ts";

const HOSTED_SAAS_QUALIFICATION_PROTOCOL = "anyam.p3-22-hosted-saas-qualification/v1" as const;

export interface Env {
  HOSTED_SAAS_COORDINATOR: DurableObjectNamespace;
  ANYAM_BUILD_REVISION?: string;
  ANYAM_HOSTED_SAAS_MODE?: string;
  ANYAM_HOSTED_BOOTSTRAP_TOKEN?: string;
}

type JsonObject = Record<string, unknown>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
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

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function authorized(request: Request, env: Env): boolean {
  const bootstrap = env.ANYAM_HOSTED_BOOTSTRAP_TOKEN?.trim();
  return Boolean(bootstrap && request.headers.get("authorization") === `Bearer ${bootstrap}`);
}

function hostForRoute(segment: string): string {
  return decodeURIComponent(segment).trim().toLowerCase();
}

export class HostedSaaSCoordinatorDO extends DurableObject<Env> {
  private readonly store = new HostedSaaSIsolationStore();
  private readonly router = new HostedSaaSRouter(this.store);
  private readonly initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get<HostedSaaSIsolationSnapshot>("hosted-saas/isolation-snapshot/v1");
      if (snapshot) this.store.restore(snapshot);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);
    try {
      if (url.pathname === "/admin/register-realm" && request.method === "POST") return await this.registerRealm(request);
      if (url.pathname === "/admin/revoke-realm" && request.method === "POST") return await this.revokeRealm(request);
      if (url.pathname === "/admin/state" && request.method === "GET") return this.state(request);
      const routed = this.routeAlias(request);
      const response = await this.router.handle(routed);
      await this.persist();
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "hosted SaaS qualification operation failed";
      return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, code: "invalid_request", recoveryAction: "inspect the named operation and retry without changing the Realm or correlation identity", receipt: `operation=not-accepted; message=${message}` }, 422);
    }
  }

  private routeAlias(request: Request): Request {
    const url = new URL(request.url);
    const prefix = "/r/";
    if (!url.pathname.startsWith(prefix)) return request;
    const remainder = url.pathname.slice(prefix.length);
    const separator = remainder.indexOf("/");
    if (separator < 1) return request;
    const host = hostForRoute(remainder.slice(0, separator));
    const realm = this.store.findRealmByHost(host);
    if (!realm) return request;
    url.hostname = realm.host;
    url.pathname = remainder.slice(separator) || "/";
    return new Request(url, request);
  }

  private async registerRealm(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, code: "unauthorized", recoveryAction: "authenticate the disposable Hosted SaaS owner before registering a Realm", receipt: "ownerAuthorization=missing; realm=not-created" }, 401);
    const body = await bodyObject(request);
    const realm = this.store.registerRealm({ realmId: requiredString(body, "realmId"), host: requiredString(body, "host"), ...(typeof body.policyVersion === "string" ? { policyVersion: body.policyVersion } : {}) });
    const token = this.store.issueCredential({ realmId: realm.realmId, principalId: requiredString(body, "principalId") });
    await this.persist();
    return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, status: "registered", realm, credential: { audience: "aud:anyam:hosted-api", token }, receipt: `realm=${realm.realmId}; credentialMaterialStored=false; canonicalWrite=false` }, 201);
  }

  private async revokeRealm(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, code: "unauthorized", recoveryAction: "authenticate the disposable Hosted SaaS owner before revoking a Realm", receipt: "ownerAuthorization=missing; revocation=not-applied" }, 401);
    const body = await bodyObject(request);
    const realmId = requiredString(body, "realmId");
    this.store.revokeRealm(realmId);
    await this.persist();
    return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, status: "revoked", realmId, receipt: `realm=${realmId}; authorizationEpoch=advanced; credentials=invalidated` });
  }

  private state(request: Request): Response {
    if (!authorized(request, this.env)) return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, code: "unauthorized", recoveryAction: "authenticate the disposable Hosted SaaS owner before reading qualification state", receipt: "ownerAuthorization=missing; state=not-disclosed" }, 401);
    const snapshot = this.store.snapshot();
    return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, status: "ready", credentialFree: snapshot.credentialFree, realms: snapshot.realms.map((realm) => ({ realmId: realm.realmId, host: realm.host, policyVersion: realm.policyVersion, authorizationEpoch: realm.authorizationEpoch })), observations: snapshot.queue.length + snapshot.events.length + snapshot.logs.length, sourceProtocol: HOSTED_SAAS_ISOLATION_PROTOCOL, receipt: "state=owner-visible; credentialMaterialStored=false" });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("hosted-saas/isolation-snapshot/v1", this.store.snapshot());
  }
}

function coordinatorStub(env: Env): DurableObjectStub {
  return env.HOSTED_SAAS_COORDINATOR.get(env.HOSTED_SAAS_COORDINATOR.idFromName("shared-hosted-saas"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const mode = env.ANYAM_HOSTED_SAAS_MODE ?? "hosted-saas";
      return json({ protocol: HOSTED_SAAS_QUALIFICATION_PROTOCOL, status: mode === "hosted-saas" ? "ready" : "blocked", hostingMode: mode, sharedCoordinator: true, buildRevision: env.ANYAM_BUILD_REVISION, credentialMaterialStored: false, canonicalWrite: false, receipt: `hostingMode=${mode}; coordinator=shared; sourceProtocol=${HOSTED_SAAS_ISOLATION_PROTOCOL}` }, mode === "hosted-saas" ? 200 : 503);
    }
    return coordinatorStub(env).fetch(request);
  },
};
