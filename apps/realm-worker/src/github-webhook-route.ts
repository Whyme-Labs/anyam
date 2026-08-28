import { GITHUB_WEBHOOK_INGRESS_PROTOCOL, validateGitHubWebhook, type GitHubWebhookIngressEnvelope } from "../../../src/portability/github-webhook.ts";

export const GITHUB_PRODUCER_CONTEXT_BODY_BYTES_LIMIT = 16_384;
export const GITHUB_PRODUCER_CONTEXT_BODY_SIZING_RECEIPT = "producer-context-bodyBytesLimit=16384; sizing=qualification-tripwire; remeasure-before-production";

/** The small binding surface needed by the public webhook boundary. Keeping
 * this structural type local prevents a route-only test or adapter from
 * importing the full OAuth/Workers runtime graph. */
export type GitHubWebhookEnv = {
  readonly ANYAM_INSTALLATION_ID?: string | undefined;
  readonly ANYAM_GITHUB_APP_REPOSITORY?: string | undefined;
  readonly ANYAM_GITHUB_APP_INSTALLATION_ID?: string | undefined;
  readonly ANYAM_GITHUB_APP_WEBHOOK_SECRET?: string | undefined;
  readonly ANYAM_GITHUB_WEBHOOK_BODY_BYTES_LIMIT?: string | undefined;
  readonly ANYAM_GITHUB_WEBHOOK_BODY_BYTES_RECEIPT?: string | undefined;
  readonly ANYAM_GITHUB_WEBHOOK_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> } | undefined;
  readonly ANYAM_GITHUB_WEBHOOK_RATE_LIMIT_RECEIPT?: string | undefined;
  readonly ANYAM_GITHUB_MIRROR_PRODUCER?: { fetch(request: Request): Promise<Response> } | undefined;
  readonly ANYAM_EVENTS?: { send(message: GitHubWebhookIngressEnvelope): Promise<void> } | undefined;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function webhookConfiguration(env: GitHubWebhookEnv): { limit: number; receipt: string } | undefined {
  const rawLimit = text(env.ANYAM_GITHUB_WEBHOOK_BODY_BYTES_LIMIT);
  const receipt = text(env.ANYAM_GITHUB_WEBHOOK_BODY_BYTES_RECEIPT);
  const limit = rawLimit === undefined ? NaN : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || receipt === undefined) return undefined;
  return { limit, receipt };
}

export async function readBoundedRequestBody(request: Request, limit: number): Promise<{ status: "ok"; body: string; bytes: number } | { status: "too-large"; bytes: number } | { status: "read-failed"; bytes: number }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) return { status: "too-large", bytes: limit + 1 };
    if (declared > limit) return { status: "too-large", bytes: declared };
  }
  if (!request.body) return { status: "ok", body: "", bytes: 0 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      bytes += chunk.byteLength;
      if (bytes > limit) {
        await reader.cancel("github-webhook-body-too-large");
        return { status: "too-large", bytes };
      }
      chunks.push(chunk);
    }
  } catch {
    await reader.cancel("github-webhook-body-read-failed").catch(() => undefined);
    return { status: "read-failed", bytes };
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", body: new TextDecoder().decode(output), bytes };
}

function envelopeForQueue(input: { envelope: Omit<GitHubWebhookIngressEnvelope, "realmId" | "receivedAt" | "receipt">; realmId: string; receipt: string }): GitHubWebhookIngressEnvelope {
  return {
    ...input.envelope,
    realmId: input.realmId,
    receivedAt: new Date().toISOString(),
    receipt: `${input.receipt}; queue=wake-up-hint; providerReinspection=required; credentialMaterialStored=false`,
  };
}

/**
 * Public GitHub App webhook boundary. This endpoint only authenticates and
 * queues a provider wake-up hint; a bound synchronizer must re-inspect GitHub
 * and submit the signed Mirror handoff separately.
 */
export async function handleGitHubWebhookRequest(request: Request, env: GitHubWebhookEnv): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/webhooks/github") return undefined;
  if (request.method !== "POST") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use POST /webhooks/github for GitHub App deliveries.", receipt: "githubWebhook=post-required; providerMutation=false; credentialMaterialStored=false" }, 405);
  const configuration = webhookConfiguration(env);
  if (!configuration) return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "configuration_invalid", recoveryAction: "Configure ANYAM_GITHUB_WEBHOOK_BODY_BYTES_LIMIT and its sizing receipt before accepting provider deliveries.", receipt: "githubWebhook=configuration-invalid; providerMutation=false; credentialMaterialStored=false" }, 503);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "content_type_invalid", recoveryAction: "Send the raw GitHub delivery with Content-Type: application/json.", receipt: `githubWebhook=content-type-invalid; contentType=${contentType ?? "missing"}; providerMutation=false; credentialMaterialStored=false` }, 415);
  const realmId = text(env.ANYAM_INSTALLATION_ID) ? `realm:${text(env.ANYAM_INSTALLATION_ID)}` : undefined;
  if (!realmId) return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "realm_unconfigured", recoveryAction: "Configure ANYAM_INSTALLATION_ID before accepting a GitHub App delivery.", receipt: "githubWebhook=realm-unconfigured; providerMutation=false; credentialMaterialStored=false" }, 503);
  const rateLimiter = env.ANYAM_GITHUB_WEBHOOK_RATE_LIMITER;
  const rateLimitReceipt = text(env.ANYAM_GITHUB_WEBHOOK_RATE_LIMIT_RECEIPT);
  if (!rateLimiter || typeof rateLimiter.limit !== "function" || !rateLimitReceipt) return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "rate_limiter_unconfigured", recoveryAction: "Bind a Cloudflare Rate Limit namespace and configure its measurement receipt before publishing the GitHub App webhook URL.", receipt: `githubWebhook=rate-limiter-unconfigured; realm=${realmId}; providerMutation=false; credentialMaterialStored=false` }, 503);
  const clientKey = text(request.headers.get("cf-connecting-ip") ?? undefined) ?? "unknown";
  let rateLimit: { success: boolean };
  try {
    rateLimit = await rateLimiter.limit({ key: `github-webhook:${realmId}:${clientKey}` });
  } catch {
    return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "rate_limiter_unavailable", recoveryAction: "Retry the same GitHub delivery after the Cloudflare Rate Limit binding is reachable; no provider state was accepted.", receipt: `githubWebhook=rate-limiter-unavailable; realm=${realmId}; rateLimitReceipt=${rateLimitReceipt}; providerMutation=false; credentialMaterialStored=false` }, 503);
  }
  if (!rateLimit.success) return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "rate_limited", recoveryAction: "Wait for the configured Cloudflare Rate Limit window to reset, then let GitHub redeliver the event.", receipt: `githubWebhook=rate-limited; realm=${realmId}; rateLimitReceipt=${rateLimitReceipt}; providerMutation=false; credentialMaterialStored=false` }, 429);
  const body = await readBoundedRequestBody(request, configuration.limit);
  if (body.status === "too-large") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "body_too_large", recoveryAction: "Reduce the GitHub delivery or increase the measured webhook body tripwire after remeasurement.", receipt: `githubWebhook=body-too-large; bodyBytes=${body.bytes}; bodyBytesLimit=${configuration.limit}; sizingReceipt=${configuration.receipt}; providerMutation=false; credentialMaterialStored=false` }, 413);
  if (body.status === "read-failed") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "body_read_failed", recoveryAction: "Retry the same GitHub delivery after the request body can be read completely; no provider state was accepted.", receipt: `githubWebhook=body-read-failed; bodyBytes=${body.bytes}; bodyBytesLimit=${configuration.limit}; providerMutation=false; credentialMaterialStored=false` }, 503);
  const validation = await validateGitHubWebhook({ body: body.body, signature: request.headers.get("x-hub-signature-256"), event: request.headers.get("x-github-event"), deliveryId: request.headers.get("x-github-delivery"), secret: env.ANYAM_GITHUB_APP_WEBHOOK_SECRET, expectedRepository: text(env.ANYAM_GITHUB_APP_REPOSITORY), expectedInstallationId: text(env.ANYAM_GITHUB_APP_INSTALLATION_ID), bodyBytesLimit: configuration.limit, bodyBytesReceipt: configuration.receipt });
  if (validation.status === "ignored") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "ignored", event: validation.event, deliveryId: validation.deliveryId, providerMutation: false, credentialMaterialStored: false, receipt: validation.receipt }, 202);
  if (validation.status === "blocked") {
    const status = validation.code === "signature_invalid" ? 401 : validation.code === "body_too_large" ? 413 : validation.code === "configuration_invalid" || validation.code === "secret_unconfigured" || validation.code === "binding_unconfigured" ? 503 : validation.code === "binding_mismatch" ? 403 : 422;
    return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: validation.code, recoveryAction: validation.recoveryAction, providerMutation: false, credentialMaterialStored: false, receipt: validation.receipt }, status);
  }
  if (!env.ANYAM_GITHUB_MIRROR_PRODUCER || typeof env.ANYAM_GITHUB_MIRROR_PRODUCER.fetch !== "function") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "producer_unconfigured", recoveryAction: "Bind the customer-owned GitHub Mirror producer before configuring the App webhook; no provider state was accepted.", receipt: `githubWebhook=producer-unconfigured; realm=${realmId}; providerMutation=false; credentialMaterialStored=false` }, 503);
  if (!env.ANYAM_EVENTS || typeof env.ANYAM_EVENTS.send !== "function") return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "queue_unconfigured", recoveryAction: "Bind the customer-owned ANYAM_EVENTS Queue before accepting a GitHub App delivery.", receipt: `githubWebhook=queue-unconfigured; realm=${realmId}; providerMutation=false; credentialMaterialStored=false` }, 503);
  const envelope = envelopeForQueue({ envelope: validation.envelope, realmId, receipt: validation.receipt });
  try {
    await env.ANYAM_EVENTS.send(envelope);
  } catch {
    return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "blocked", code: "queue_unavailable", recoveryAction: "Retry the same GitHub delivery after the customer-owned Queue is reachable; no provider state was accepted.", providerMutation: false, credentialMaterialStored: false, receipt: `githubWebhook=queue-send-failed; realm=${realmId}; delivery=${envelope.deliveryId}; bodyDigest=${envelope.bodyDigest}; providerMutation=false; credentialMaterialStored=false` }, 503);
  }
  return json({ protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL, status: "accepted", deliveryId: envelope.deliveryId, repository: envelope.repository, installationId: envelope.installationId, bodyDigest: envelope.bodyDigest, providerReinspection: "required", providerMutation: false, credentialMaterialStored: false, receipt: `${envelope.receipt}; httpStatus=202` }, 202);
}
