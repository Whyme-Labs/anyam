/// <reference types="@cloudflare/workers-types" />

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
      return json({ protocol: "anyam.promotion-executor-health/v1", status: "healthy", providerCredentials: "brokered-only", canonicalWrite: false, credentialMaterialStored: false });
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
