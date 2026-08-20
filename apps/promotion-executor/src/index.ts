/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import {
  createPromotionExecutorHandler,
  type PromotionExecutorArtifactStore,
  type PromotionExecutorConfig,
} from "../../../src/cloudflare/promotion-executor.ts";

export interface Env {
  ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID?: string;
  ANYAM_PROMOTION_EXECUTOR_TARGET_ID?: string;
  ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME?: string;
  ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN?: string;
  ANYAM_PROMOTION_EXECUTOR_HEALTH_URL?: string;
  ANYAM_PROMOTION_EXECUTOR_ADAPTER_ID?: string;
  ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN?: string;
  ANYAM_PROMOTION_CREDENTIAL_EXPIRES_AT?: string;
  ANYAM_PROMOTION_HANDOFF_SECRET?: string;
  ANYAM_PROMOTION_NONCE_STORE?: DurableObjectNamespace;
  ANYAM_PROMOTION_ARTIFACTS: R2Bucket;
}

// Route contract: GET /health is an operator probe; POST /execute is the
// internal anyam.promotion-execution/v1 service-binding handoff.

function required(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function configFromEnv(env: Env): PromotionExecutorConfig {
  const artifactStore = env.ANYAM_PROMOTION_ARTIFACTS as unknown as PromotionExecutorArtifactStore;
  if (!artifactStore || typeof artifactStore.get !== "function") throw new Error("ANYAM_PROMOTION_ARTIFACTS binding is required");
  return {
    accountId: required(env.ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID, "ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID"),
    targetId: required(env.ANYAM_PROMOTION_EXECUTOR_TARGET_ID, "ANYAM_PROMOTION_EXECUTOR_TARGET_ID"),
    scriptName: required(env.ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME, "ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME"),
    previewSubdomain: required(env.ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN, "ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN"),
    providerToken: required(env.ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN, "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN"),
    providerCredentialExpiresAt: required(env.ANYAM_PROMOTION_CREDENTIAL_EXPIRES_AT, "ANYAM_PROMOTION_CREDENTIAL_EXPIRES_AT"),
    handoffSecret: required(env.ANYAM_PROMOTION_HANDOFF_SECRET, "ANYAM_PROMOTION_HANDOFF_SECRET"),
    handoffNonceStore: {
      async claim(input) {
        if (!env.ANYAM_PROMOTION_NONCE_STORE) throw new Error("ANYAM_PROMOTION_NONCE_STORE binding is required");
        const id = env.ANYAM_PROMOTION_NONCE_STORE.idFromName("promotion-handoff-nonces");
        const response = await env.ANYAM_PROMOTION_NONCE_STORE.get(id).fetch("https://nonce-store/claim", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
        return response.status === 201;
      },
    },
    ...(env.ANYAM_PROMOTION_EXECUTOR_HEALTH_URL?.trim() ? { healthUrl: env.ANYAM_PROMOTION_EXECUTOR_HEALTH_URL.trim() } : {}),
    ...(env.ANYAM_PROMOTION_EXECUTOR_ADAPTER_ID?.trim() ? { adapterId: env.ANYAM_PROMOTION_EXECUTOR_ADAPTER_ID.trim() } : {}),
    artifactStore,
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        configFromEnv(env);
        return json({ protocol: "anyam.promotion-executor-health/v1", status: "healthy", handoff: "signed-and-replay-protected", providerCredentials: "brokered-only", canonicalWrite: false, credentialMaterialStored: false });
      } catch (error) {
        return json({ protocol: "anyam.promotion-executor-health/v1", status: "blocked", code: "executor_configuration_invalid", recoveryAction: "configure the signed Authority handoff and durable nonce store before binding the Realm service", receipt: `executor=config-invalid; field=${error instanceof Error ? error.message : "unknown"}; providerInvocation=false; credentialMaterialStored=false` }, 503);
      }
    }
    try {
      const handler = createPromotionExecutorHandler(configFromEnv(env));
      return await handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ protocol: "anyam.promotion-execution/v1", status: "blocked", code: "executor_configuration_invalid", message, recoveryAction: "configure the customer-owned executor bindings and secrets before binding the Realm service", receipt: "executor=config-invalid; providerInvocation=false; credentialMaterialStored=false; canonicalWrite=false" }, 503);
    }
  },
};

export class PromotionExecutorNonceStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") return new Response(null, { status: 404 });
    const body = await request.json() as { nonce?: unknown; expiresAt?: unknown };
    if (typeof body.nonce !== "string" || body.nonce.trim().length === 0 || typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) return new Response(null, { status: 422 });
    const key = `nonce:${body.nonce}`;
    if (await this.ctx.storage.get(key)) return new Response(null, { status: 409 });
    await this.ctx.storage.put(key, { expiresAt: body.expiresAt, claimedAt: new Date().toISOString() });
    return new Response(null, { status: 201 });
  }
}
