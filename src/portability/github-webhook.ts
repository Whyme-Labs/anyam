export const GITHUB_WEBHOOK_INGRESS_PROTOCOL = "anyam.github-app-webhook/v1" as const;
export const GITHUB_WEBHOOK_EVENT_TYPES = ["push", "pull_request"] as const;
export type GitHubWebhookEventType = typeof GITHUB_WEBHOOK_EVENT_TYPES[number];

export type GitHubWebhookIngressEnvelope = {
  protocol: typeof GITHUB_WEBHOOK_INGRESS_PROTOCOL;
  realmId: string;
  event: GitHubWebhookEventType;
  action?: string;
  deliveryId: string;
  repository: string;
  installationId: string;
  body: string;
  signature: string;
  bodyDigest: string;
  receivedAt: string;
  receipt: string;
};

export type GitHubWebhookValidation =
  | { status: "accepted"; envelope: Omit<GitHubWebhookIngressEnvelope, "realmId" | "receivedAt" | "receipt">; receipt: string }
  | { status: "ignored"; event: string; deliveryId: string; receipt: string }
  | { status: "blocked"; code: string; recoveryAction: string; receipt: string };

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function requiredHeader(value: string | null, field: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256 || /[\r\n]/u.test(normalized)) return undefined;
  return normalized;
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!/^sha256=[0-9a-f]{64}$/iu.test(signature) || secret.trim().length === 0) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, hexBytes(signature.slice("sha256=".length)).buffer as ArrayBuffer, new TextEncoder().encode(body));
  } catch {
    return false;
  }
}

function payloadObject(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function installationId(payload: Record<string, unknown>): string | undefined {
  const value = (payload.installation as Record<string, unknown> | undefined)?.id;
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function repository(payload: Record<string, unknown>): string | undefined {
  const value = (payload.repository as Record<string, unknown> | undefined)?.full_name;
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256 ? value.trim() : undefined;
}

/**
 * Validate a raw GitHub App delivery before it enters a Queue. The result is
 * only a wake-up hint; a provider synchronizer must re-inspect GitHub state
 * before it can create a signed Anyam Mirror handoff.
 */
export async function validateGitHubWebhook(input: {
  body: string;
  signature: string | null;
  event: string | null;
  deliveryId: string | null;
  secret: string | undefined;
  expectedRepository?: string | undefined;
  expectedInstallationId?: string | undefined;
  bodyBytesLimit: number;
  bodyBytesReceipt: string;
}): Promise<GitHubWebhookValidation> {
  const suppliedDeliveryId = requiredHeader(input.deliveryId, "X-GitHub-Delivery");
  const deliveryId = suppliedDeliveryId ?? "missing";
  if (!Number.isSafeInteger(input.bodyBytesLimit) || input.bodyBytesLimit <= 0 || input.bodyBytesReceipt.trim().length === 0) return { status: "blocked", code: "configuration_invalid", recoveryAction: "configure a positive GitHub webhook body tripwire and its sizing receipt before accepting provider deliveries", receipt: "githubWebhook=configuration-invalid; providerMutation=false; credentialMaterialStored=false" };
  const bodyBytes = new TextEncoder().encode(input.body).byteLength;
  if (bodyBytes > input.bodyBytesLimit) return { status: "blocked", code: "body_too_large", recoveryAction: "reduce the GitHub delivery body or increase the measured webhook body tripwire after remeasurement", receipt: `githubWebhook=body-too-large; bodyBytes=${bodyBytes}; bodyBytesLimit=${input.bodyBytesLimit}; sizingReceipt=${input.bodyBytesReceipt}; providerMutation=false; credentialMaterialStored=false` };
  if (!input.secret?.trim()) return { status: "blocked", code: "secret_unconfigured", recoveryAction: "configure the GitHub App webhook secret in the customer Worker before accepting deliveries", receipt: "githubWebhook=secret-unconfigured; providerMutation=false; credentialMaterialStored=false" };
  if (!input.signature || !(await verifySignature(input.body, input.signature, input.secret))) return { status: "blocked", code: "signature_invalid", recoveryAction: "send the raw GitHub delivery with a valid X-Hub-Signature-256 generated from the configured App webhook secret", receipt: `githubWebhook=signature-invalid; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  const event = requiredHeader(input.event, "X-GitHub-Event");
  if (!event) return { status: "blocked", code: "event_missing", recoveryAction: "send the GitHub event name in X-GitHub-Event and retry the delivery", receipt: `githubWebhook=event-missing; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  if (!suppliedDeliveryId) return { status: "blocked", code: "delivery_missing", recoveryAction: "send the GitHub delivery identity in X-GitHub-Delivery and retry the same provider delivery", receipt: `githubWebhook=delivery-missing; event=${event}; providerMutation=false; credentialMaterialStored=false` };
  if (!GITHUB_WEBHOOK_EVENT_TYPES.includes(event as GitHubWebhookEventType)) return { status: "ignored", event, deliveryId, receipt: `githubWebhook=event-ignored; event=${event}; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  const payload = payloadObject(input.body);
  const action = typeof payload?.action === "string" ? payload.action.trim() : undefined;
  if (event === "pull_request" && action !== undefined && !new Set(["opened", "reopened", "synchronize", "closed"]).has(action)) return { status: "ignored", event, deliveryId, receipt: `githubWebhook=action-ignored; event=${event}; action=${action}; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  const remoteRepository = payload ? repository(payload) : undefined;
  const remoteInstallationId = payload ? installationId(payload) : undefined;
  if (!payload || !remoteRepository || !remoteInstallationId) return { status: "blocked", code: "payload_identity_invalid", recoveryAction: "send a JSON GitHub delivery containing repository.full_name and installation.id; no provider state was accepted", receipt: `githubWebhook=payload-identity-invalid; event=${event}; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  const expectedRepository = input.expectedRepository?.trim();
  const expectedInstallationId = input.expectedInstallationId?.trim();
  if (!expectedRepository || !expectedInstallationId) return { status: "blocked", code: "binding_unconfigured", recoveryAction: "configure the exact selected GitHub repository and App installation identity before accepting provider deliveries", receipt: `githubWebhook=binding-unconfigured; event=${event}; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  if (remoteRepository !== expectedRepository || remoteInstallationId !== expectedInstallationId) return { status: "blocked", code: "binding_mismatch", recoveryAction: "send the delivery to the Realm bound to its selected GitHub repository and App installation; no provider state was accepted", receipt: `githubWebhook=binding-mismatch; expectedRepository=${expectedRepository}; actualRepository=${remoteRepository}; expectedInstallation=${expectedInstallationId}; actualInstallation=${remoteInstallationId}; delivery=${deliveryId}; providerMutation=false; credentialMaterialStored=false` };
  const envelope = {
    protocol: GITHUB_WEBHOOK_INGRESS_PROTOCOL,
    event: event as GitHubWebhookEventType,
    ...(action ? { action } : {}),
    deliveryId,
    repository: remoteRepository,
    installationId: remoteInstallationId,
    body: input.body,
    signature: input.signature,
    bodyDigest: await digest(input.body),
  };
  return { status: "accepted", envelope, receipt: `githubWebhook=signature-verified; event=${event}; repository=${remoteRepository}; installation=${remoteInstallationId}; delivery=${deliveryId}; bodyBytes=${bodyBytes}; bodyBytesLimit=${input.bodyBytesLimit}; sizingReceipt=${input.bodyBytesReceipt}; providerReinspection=required; credentialMaterialStored=false` };
}
