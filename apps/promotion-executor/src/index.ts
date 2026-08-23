/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import {
  createPromotionExecutorHandler,
  type PromotionExecutorArtifactStore,
  type PromotionExecutorConfig,
} from "../../../src/cloudflare/promotion-executor.ts";
import { createCloudflareApiTokenCredentialBroker } from "../../../src/cloudflare/promotion-credential-broker.ts";
import { promotionExecutorHealth } from "./health.ts";
import { claimPromotionNonce } from "../../../src/cloudflare/promotion-executor-nonce.ts";
import { createCloudflareWorkerReleaseManifest } from "../../../src/cloudflare/worker-release-manifest.ts";

export interface Env {
  ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID?: string;
  ANYAM_PROMOTION_EXECUTOR_TARGET_ID?: string;
  ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME?: string;
  ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN?: string;
  ANYAM_PROMOTION_EXECUTOR_HEALTH_URL?: string;
  ANYAM_PROMOTION_EXECUTOR_ADAPTER_ID?: string;
  ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN?: string;
  ANYAM_PROMOTION_CREDENTIAL_SCOPES?: string;
  ANYAM_PROMOTION_CREDENTIAL_SOURCE_ID?: string;
  ANYAM_PROMOTION_HANDOFF_KEY_ID?: string;
  ANYAM_PROMOTION_HANDOFF_SECRET?: string;
  ANYAM_PROMOTION_HANDOFF_PREVIOUS_KEY_ID?: string;
  ANYAM_PROMOTION_HANDOFF_PREVIOUS_SECRET?: string;
  /** Secret used only by an internal service binding/operator probe. */
  ANYAM_PROMOTION_HEALTH_TOKEN?: string;
  /** Credential-free receipt produced by the bounded installation/qualification probe. */
  ANYAM_PROMOTION_HEALTH_RECEIPT?: string;
  ANYAM_PROMOTION_NONCE_STORE?: DurableObjectNamespace;
  ANYAM_PROMOTION_ARTIFACTS: R2Bucket;
  ANYAM_PROMOTION_WORKER_COMPATIBILITY_DATE?: string;
  ANYAM_PROMOTION_WORKER_COMPATIBILITY_FLAGS?: string;
}

// Route contract: GET /health is an authenticated operator/service probe;
// POST /execute is the internal anyam.promotion-execution/v1 handoff.
const HEALTH_TOKEN_HEADER = "x-anyam-promotion-health-token";

function required(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function scopes(value: string | undefined): readonly string[] {
  const parsed = (value ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  if (parsed.length === 0) throw new Error("ANYAM_PROMOTION_CREDENTIAL_SCOPES is required and must list the customer-declared provider scopes");
  return parsed;
}

function flags(value: string | undefined): readonly string[] {
  return (value ?? "").split(",").map((flag) => flag.trim()).filter(Boolean);
}

function configFromEnv(env: Env): PromotionExecutorConfig {
  const artifactStore = env.ANYAM_PROMOTION_ARTIFACTS as unknown as PromotionExecutorArtifactStore;
  if (!artifactStore || typeof artifactStore.get !== "function") throw new Error("ANYAM_PROMOTION_ARTIFACTS binding is required");
  const accountId = required(env.ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID, "ANYAM_PROMOTION_EXECUTOR_ACCOUNT_ID");
  const targetId = required(env.ANYAM_PROMOTION_EXECUTOR_TARGET_ID, "ANYAM_PROMOTION_EXECUTOR_TARGET_ID");
  const scriptName = required(env.ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME, "ANYAM_PROMOTION_EXECUTOR_SCRIPT_NAME");
  const credentialToken = required(env.ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN, "ANYAM_PROMOTION_CLOUDFLARE_API_TOKEN");
  const credentialScopes = scopes(env.ANYAM_PROMOTION_CREDENTIAL_SCOPES);
  const credentialSourceId = env.ANYAM_PROMOTION_CREDENTIAL_SOURCE_ID?.trim() || "customer-secret-binding";
  const handoffKeyId = required(env.ANYAM_PROMOTION_HANDOFF_KEY_ID, "ANYAM_PROMOTION_HANDOFF_KEY_ID");
  const handoffSecret = required(env.ANYAM_PROMOTION_HANDOFF_SECRET, "ANYAM_PROMOTION_HANDOFF_SECRET");
  const previousKeyId = env.ANYAM_PROMOTION_HANDOFF_PREVIOUS_KEY_ID?.trim();
  const previousSecret = env.ANYAM_PROMOTION_HANDOFF_PREVIOUS_SECRET?.trim();
  if ((previousKeyId && !previousSecret) || (!previousKeyId && previousSecret)) throw new Error("ANYAM_PROMOTION_HANDOFF_PREVIOUS_KEY_ID and ANYAM_PROMOTION_HANDOFF_PREVIOUS_SECRET must be configured together");
  return {
    accountId,
    targetId,
    scriptName,
    previewSubdomain: required(env.ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN, "ANYAM_PROMOTION_EXECUTOR_PREVIEW_SUBDOMAIN"),
    credentialBroker: createCloudflareApiTokenCredentialBroker({
      accountId,
      scriptName,
      targetId,
      tokenSource: async () => ({ token: credentialToken, sourceId: credentialSourceId, scopes: credentialScopes }),
    }),
    handoffKeys: { active: { id: handoffKeyId, secret: handoffSecret }, ...(previousKeyId && previousSecret ? { previous: { id: previousKeyId, secret: previousSecret } } : {}) },
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
    workerReleaseManifest: ({ release }) => createCloudflareWorkerReleaseManifest({
      release,
      compatibilityDate: required(env.ANYAM_PROMOTION_WORKER_COMPATIBILITY_DATE, "ANYAM_PROMOTION_WORKER_COMPATIBILITY_DATE"),
      compatibilityFlags: flags(env.ANYAM_PROMOTION_WORKER_COMPATIBILITY_FLAGS),
      bindings: [],
      healthPaths: ["/health"],
    }),
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return result === 0;
}

function healthAuthorized(request: Request, env: Env): boolean {
  const configured = env.ANYAM_PROMOTION_HEALTH_TOKEN?.trim();
  const presented = request.headers.get(HEALTH_TOKEN_HEADER)?.trim();
  return Boolean(configured && presented && constantTimeEqual(configured, presented));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      if (!healthAuthorized(request, env)) {
        const decision = promotionExecutorHealth({ authorized: false, configuration: "ready" });
        return json(decision.body, decision.httpStatus);
      }
      let config: PromotionExecutorConfig;
      try {
        config = configFromEnv(env);
      } catch (error) {
        const decision = promotionExecutorHealth({ authorized: true, configuration: "invalid" });
        return json({ ...decision.body, message: error instanceof Error ? error.message : String(error) }, decision.httpStatus);
      }
      const decision = promotionExecutorHealth({ authorized: true, configuration: "ready", ...(env.ANYAM_PROMOTION_HEALTH_RECEIPT === undefined ? {} : { qualificationReceipt: env.ANYAM_PROMOTION_HEALTH_RECEIPT }) });
      return json(decision.body, decision.httpStatus);
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
    if (typeof body.nonce !== "string" || typeof body.expiresAt !== "string") return new Response(null, { status: 422 });
    try {
      const result = await claimPromotionNonce({ nonce: body.nonce, expiresAt: body.expiresAt, storage: this.ctx.storage as unknown as import("../../../src/cloudflare/promotion-executor-nonce.ts").PromotionNonceStorage });
      return new Response(null, { status: result === "claimed" ? 201 : 409 });
    } catch {
      return new Response(null, { status: 422 });
    }
  }
}
