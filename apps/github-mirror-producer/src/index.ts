/// <reference types="@cloudflare/workers-types" />

import {
  GITHUB_MIRROR_PRODUCER_CONTEXT_PROTOCOL,
  GITHUB_MIRROR_PRODUCER_PROTOCOL,
  GitHubMirrorProducerError,
  GitHubWebhookMirrorProducer,
  parseGitHubMirrorProducerContext,
  type GitHubMirrorProducerResult,
} from "../../../src/portability/github-webhook-producer.ts";

export type Env = {
  ANYAM_REALM?: Fetcher;
  ANYAM_REALM_ID?: string;
  ANYAM_GITHUB_APP_ID?: string;
  ANYAM_GITHUB_APP_INSTALLATION_ID?: string;
  ANYAM_GITHUB_APP_REPOSITORY?: string;
  ANYAM_GITHUB_APP_PRIVATE_KEY?: string;
  ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS?: string;
  ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT?: string;
  ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS?: string;
  ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT?: string;
  ANYAM_GITHUB_APP_RESPONSE_BYTES_LIMIT?: string;
  ANYAM_GITHUB_APP_RESPONSE_BYTES_RECEIPT?: string;
  ANYAM_GITHUB_APP_REQUEST_TIMEOUT_MS?: string;
  ANYAM_GITHUB_APP_REQUEST_TIMEOUT_RECEIPT?: string;
  ANYAM_MIRROR_HANDOFF_KEY_ID?: string;
  ANYAM_MIRROR_HANDOFF_SECRET?: string;
  ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_MS?: string;
  ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_RECEIPT?: string;
  ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_MS?: string;
  ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_RECEIPT?: string;
  ANYAM_GITHUB_MIRROR_PRODUCER_SECRET?: string;
  ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_LIMIT?: string;
  ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_RECEIPT?: string;
};

const CONTEXT_PATH = "/internal/mirrors/producer-context";
const INGEST_PATH = "/internal/mirrors/ingest";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function required(value: string | undefined, field: string): string {
  const normalized = text(value);
  if (!normalized) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: `${field} is not configured.`, recoveryAction: `configure ${field} on the customer-owned producer Worker before accepting webhook deliveries`, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}; configuration=missing; credentialMaterialStored=false` });
  return normalized;
}

function number(value: string | undefined, field: string): number {
  const parsed = Number(text(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: `${field} must be a positive safe integer.`, recoveryAction: `configure a measured ${field} tripwire before accepting webhook deliveries`, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}; configuration=invalid; credentialMaterialStored=false` });
  return parsed;
}

function nonNegativeNumber(value: string | undefined, field: string): number {
  const parsed = Number(text(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GitHubMirrorProducerError({ code: "configuration_invalid", message: `${field} must be a non-negative safe integer.`, recoveryAction: `configure a measured ${field} tripwire before accepting webhook deliveries`, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; field=${field}; configuration=invalid; credentialMaterialStored=false` });
  return parsed;
}

async function boundedBody(request: Request, limit: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) throw new GitHubMirrorProducerError({ code: "envelope_too_large", message: "The queued webhook envelope exceeds the producer body tripwire.", recoveryAction: "increase the measured producer envelope tripwire only after remeasurement, then retry the same Queue delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelopeBytesLimit=${limit}; declaredBytes=${declared}; providerMutation=false; credentialMaterialStored=false` });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("github-producer-envelope-too-large");
        throw new GitHubMirrorProducerError({ code: "envelope_too_large", message: "The queued webhook envelope exceeds the producer body tripwire.", recoveryAction: "increase the measured producer envelope tripwire only after remeasurement, then retry the same Queue delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelopeBytes=${bytes}; envelopeBytesLimit=${limit}; providerMutation=false; credentialMaterialStored=false` });
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel("github-producer-envelope-read-failed").catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function credentialFreeResult(result: GitHubMirrorProducerResult): Record<string, unknown> {
  return {
    protocol: result.protocol,
    status: result.status,
    deliveryId: result.deliveryId,
    ...(result.code ? { code: result.code } : {}),
    ...(result.duplicate ? { duplicate: true } : {}),
    receipt: result.receipt,
    ...(result.recoveryAction ? { recoveryAction: result.recoveryAction } : {}),
    credentialMaterialStored: false,
    providerCredential: "jit-memory-only",
  };
}

function sharedSecret(env: Env): string {
  return required(env.ANYAM_GITHUB_MIRROR_PRODUCER_SECRET, "ANYAM_GITHUB_MIRROR_PRODUCER_SECRET");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return result === 0;
}

async function realmRequest(env: Env, path: string, body: Record<string, unknown>, options: { allowConflict?: boolean } = {}): Promise<Record<string, unknown>> {
  const realm = env.ANYAM_REALM;
  if (!realm || typeof realm.fetch !== "function") throw new GitHubMirrorProducerError({ code: "realm_unconfigured", message: "The GitHub Mirror producer has no Realm service binding.", recoveryAction: "bind the producer to the owning customer Realm Worker before accepting webhook deliveries", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; realmBinding=missing; providerMutation=false; credentialMaterialStored=false` });
  const response = await realm.fetch(new Request(`https://anyam-realm${path}`, { method: "POST", headers: { "content-type": "application/json", "cache-control": "no-store", "x-anyam-github-mirror-producer-secret": sharedSecret(env) }, body: JSON.stringify(body) }));
  const value: unknown = await response.json().catch(() => undefined);
  if ((!response.ok && !(options.allowConflict && response.status === 409)) || value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubMirrorProducerError({ code: `realm_http_${response.status}`, message: `The customer Realm rejected the producer request ${path}.`, recoveryAction: "inspect the Realm producer receipt and retry the same Queue delivery only after reconciling its Authority state", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; realmOperation=${path}; httpStatus=${response.status}; providerMutation=false; credentialMaterialStored=false` });
  return value as Record<string, unknown>;
}

function configurationHealth(env: Env): Record<string, unknown> {
  const fields = ["ANYAM_REALM", "ANYAM_REALM_ID", "ANYAM_GITHUB_APP_ID", "ANYAM_GITHUB_APP_INSTALLATION_ID", "ANYAM_GITHUB_APP_REPOSITORY", "ANYAM_GITHUB_APP_PRIVATE_KEY", "ANYAM_MIRROR_HANDOFF_KEY_ID", "ANYAM_MIRROR_HANDOFF_SECRET", "ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_MS", "ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_RECEIPT", "ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_MS", "ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_RECEIPT", "ANYAM_GITHUB_MIRROR_PRODUCER_SECRET"] as const;
  const configured = Object.fromEntries(fields.map((field) => [field, field === "ANYAM_REALM" ? Boolean(env[field]) : Boolean(text(env[field as keyof Env] as string | undefined))]));
  const status = Object.values(configured).every(Boolean) ? "ready" : "blocked";
  return { protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status, configured, credentialMaterialStored: false, canonicalWrite: false, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; health=${status}; providerCredential=not-returned; credentialMaterialStored=false` };
}

async function processWebhook(request: Request, env: Env): Promise<Response> {
  let result: GitHubMirrorProducerResult;
  try {
    const envelopeLimit = number(env.ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_LIMIT, "ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_LIMIT");
    const envelopeReceipt = required(env.ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_RECEIPT, "ANYAM_GITHUB_PRODUCER_ENVELOPE_BYTES_RECEIPT");
    const raw = await boundedBody(request, envelopeLimit);
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new GitHubMirrorProducerError({ code: "envelope_invalid", message: "The queued webhook envelope is not valid JSON.", recoveryAction: "retry the original Queue delivery after reconciling its serialization", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelope=json-invalid; envelopeReceipt=${envelopeReceipt}; providerMutation=false; credentialMaterialStored=false` }); }
    const envelope = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (!envelope) throw new GitHubMirrorProducerError({ code: "envelope_invalid", message: "The queued webhook envelope must be a JSON object.", recoveryAction: "retry the original Queue delivery after reconciling its serialization", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; envelope=object-required; providerMutation=false; credentialMaterialStored=false` });
    const contextValue = await realmRequest(env, CONTEXT_PATH, { repository: required(envelope.repository as string | undefined, "repository"), installationId: required(envelope.installationId as string | undefined, "installationId") });
    if (contextValue.protocol !== GITHUB_MIRROR_PRODUCER_CONTEXT_PROTOCOL) throw new GitHubMirrorProducerError({ code: "context_invalid", message: "The customer Realm returned an unsupported producer context.", recoveryAction: "repair the Realm producer-context route and retry the same Queue delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; context=protocol-invalid; providerMutation=false; credentialMaterialStored=false` });
    const context = parseGitHubMirrorProducerContext(contextValue);
    const producer = new GitHubWebhookMirrorProducer({
      api: {
        appId: required(env.ANYAM_GITHUB_APP_ID, "ANYAM_GITHUB_APP_ID"),
        installationId: required(env.ANYAM_GITHUB_APP_INSTALLATION_ID, "ANYAM_GITHUB_APP_INSTALLATION_ID"),
        repository: required(env.ANYAM_GITHUB_APP_REPOSITORY, "ANYAM_GITHUB_APP_REPOSITORY"),
        privateKey: required(env.ANYAM_GITHUB_APP_PRIVATE_KEY, "ANYAM_GITHUB_APP_PRIVATE_KEY"),
        jwtLifetimeSeconds: number(env.ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS, "ANYAM_GITHUB_APP_JWT_LIFETIME_SECONDS"),
        jwtLifetimeReceipt: required(env.ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT, "ANYAM_GITHUB_APP_JWT_SIZING_RECEIPT"),
        clockSkewSeconds: number(env.ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS, "ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SECONDS"),
        clockSkewReceipt: required(env.ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT, "ANYAM_GITHUB_APP_JWT_CLOCK_SKEW_SIZING_RECEIPT"),
        responseBytesLimit: number(env.ANYAM_GITHUB_APP_RESPONSE_BYTES_LIMIT, "ANYAM_GITHUB_APP_RESPONSE_BYTES_LIMIT"),
        responseBytesReceipt: required(env.ANYAM_GITHUB_APP_RESPONSE_BYTES_RECEIPT, "ANYAM_GITHUB_APP_RESPONSE_BYTES_RECEIPT"),
        requestTimeoutMs: number(env.ANYAM_GITHUB_APP_REQUEST_TIMEOUT_MS, "ANYAM_GITHUB_APP_REQUEST_TIMEOUT_MS"),
        requestTimeoutReceipt: required(env.ANYAM_GITHUB_APP_REQUEST_TIMEOUT_RECEIPT, "ANYAM_GITHUB_APP_REQUEST_TIMEOUT_RECEIPT"),
      },
      realmId: required(env.ANYAM_REALM_ID, "ANYAM_REALM_ID"),
      appInstallationId: required(env.ANYAM_GITHUB_APP_INSTALLATION_ID, "ANYAM_GITHUB_APP_INSTALLATION_ID"),
      repository: required(env.ANYAM_GITHUB_APP_REPOSITORY, "ANYAM_GITHUB_APP_REPOSITORY"),
      handoffKeyId: required(env.ANYAM_MIRROR_HANDOFF_KEY_ID, "ANYAM_MIRROR_HANDOFF_KEY_ID"),
      handoffSecret: required(env.ANYAM_MIRROR_HANDOFF_SECRET, "ANYAM_MIRROR_HANDOFF_SECRET"),
      handoffMaxLifetimeMs: number(env.ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_MS, "ANYAM_MIRROR_HANDOFF_MAX_LIFETIME_MS"),
      handoffClockSkewMs: nonNegativeNumber(env.ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_MS, "ANYAM_MIRROR_HANDOFF_CLOCK_SKEW_MS"),
      ingest: async (handoff) => {
        const response = await realmRequest(env, INGEST_PATH, { handoff }, { allowConflict: true });
        const status = response.status === "succeeded" ? "succeeded" : response.code === "conflict" && response.receipt?.toString().includes("handoff-replay") ? "succeeded" : "blocked";
        return { status, ...(status === "succeeded" && response.code === "conflict" ? { duplicate: true as const } : {}), receipt: typeof response.receipt === "string" ? response.receipt : `realm=${INGEST_PATH}; response=unrecognized; credentialMaterialStored=false`, ...(typeof response.recoveryAction === "string" ? { recoveryAction: response.recoveryAction } : {}) };
      },
    });
    result = await producer.process({ envelope, context });
  } catch (error) {
    const typed = error instanceof GitHubMirrorProducerError ? error : new GitHubMirrorProducerError({ code: "producer_exception", message: "The GitHub Mirror producer failed before accepting the delivery.", recoveryAction: "inspect the producer receipt and retry the same Queue delivery", receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; exception=${error instanceof Error ? error.name : "unknown"}; providerMutation=false; credentialMaterialStored=false` });
    result = { protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "blocked", deliveryId: "unknown", code: typed.code, receipt: typed.receipt, recoveryAction: typed.recoveryAction };
  }
  return json(credentialFreeResult(result), result.status === "succeeded" ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health" && request.method === "GET") return json(configurationHealth(env), 200);
    if (pathname !== "/events/github") return json({ protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "blocked", code: "not_found", recoveryAction: "use POST /events/github through the Realm service binding", credentialMaterialStored: false, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; route=not-found; credentialMaterialStored=false` }, 404);
    if (request.method !== "POST") return json({ protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "use POST /events/github through the Realm service binding", credentialMaterialStored: false, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; method=post-required; credentialMaterialStored=false` }, 405);
    const configured = text(env.ANYAM_GITHUB_MIRROR_PRODUCER_SECRET);
    const presented = text(request.headers.get("x-anyam-github-mirror-producer-secret") ?? undefined);
    if (!configured || !presented || !constantTimeEqual(configured, presented)) return json({ protocol: GITHUB_MIRROR_PRODUCER_PROTOCOL, status: "blocked", code: "unauthorized", recoveryAction: "invoke the producer only through the bound customer Realm service with its shared service secret", credentialMaterialStored: false, receipt: `producer=${GITHUB_MIRROR_PRODUCER_PROTOCOL}; authorization=failed; credentialMaterialStored=false` }, 403);
    return processWebhook(request, env);
  },
};
