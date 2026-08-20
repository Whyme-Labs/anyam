import {
  createCloudflareWorkerRestTransport,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerApiTransport,
  type CloudflareWorkerCredential,
  type CloudflareWorkerCredentialBroker,
  type CloudflareWorkerCredentialObservation,
  type CloudflareWorkerTargetOperation,
} from "./worker-target.ts";

/**
 * The broker is a customer-owned boundary. The Promotion executor can ask for
 * a credential, but it cannot choose a secret, extend its lifetime, or claim
 * provider authorization without the broker's fresh observation.
 */
export const PROMOTION_CREDENTIAL_BROKER_PROTOCOL = "anyam.promotion-credential-broker/v1" as const;

export type CloudflareApiTokenMaterial = {
  token: string;
  /** A secret version, binding name, or provider-managed source identity. */
  sourceId: string;
  /** Customer-declared scopes when the provider does not return them. */
  scopes: readonly string[];
};

export type CloudflareApiTokenSource = (input: {
  accountId: string;
  scriptName: string;
  targetId: string;
  operation: CloudflareWorkerTargetOperation | "probe";
}) => Promise<CloudflareApiTokenMaterial>;

export type CloudflareApiTokenCredentialBrokerConfig = {
  accountId: string;
  scriptName: string;
  targetId: string;
  tokenSource: CloudflareApiTokenSource;
  transport: CloudflareWorkerApiTransport;
  now?: () => string;
  /**
   * Optional operation-specific source. A provider that supports narrow
   * credentials can return a different secret for preview, promotion, and
   * read operations. Without it, the customer explicitly owns the provider's
   * broader token scope; Anyam does not pretend to narrow a provider token.
   */
  operationTokenSource?: Partial<Record<CloudflareWorkerTargetOperation, CloudflareApiTokenSource>>;
};

type CloudflareTokenVerifyResult = {
  id?: unknown;
  status?: unknown;
  expires_on?: unknown;
};

type ObservedCredential = {
  token: string;
  sourceId: string;
  observation: CloudflareWorkerCredentialObservation;
};

export class PromotionCredentialBrokerError extends Error {
  readonly code: "source-unavailable" | "provider-unauthorized" | "provider-revoked" | "provider-expired" | "provider-response-invalid" | "scope-missing";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: PromotionCredentialBrokerError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "PromotionCredentialBrokerError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function safeProviderErrors(response: CloudflareWorkerApiResponse<unknown>): string {
  return [...response.errors, ...response.messages].map((error) => `${error.code ?? "unknown"}:${error.message.replace(/(?:cfat_[A-Za-z0-9]+|bearer\s+[A-Za-z0-9._~-]{8,})/giu, "[redacted]")}`).join(" | ") || `http-${response.status}`;
}

function credentialProviderOperationId(operation: string, credentialId: string, sourceId: string): string {
  return `credential-probe:${operation}:${credentialId}:${sourceId}`;
}

function requiredScopes(operation: CloudflareWorkerTargetOperation): readonly string[] {
  return operation === "apply" || operation === "rollback" ? ["workers:write"] : ["workers:read"];
}

function verifyPath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/tokens/verify`;
}

function versionsPath(accountId: string, scriptName: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/versions?per_page=1`;
}

function observationReceipt(input: {
  operation: string;
  credentialId: string;
  sourceId: string;
  expiresAt: string;
  scopes: readonly string[];
  providerOperationId: string;
  rotation: "initial" | "unchanged" | "observed";
}): string {
  return `credentialBroker=customer-owned; operation=${input.operation}; credentialId=${input.credentialId}; credentialSource=${input.sourceId}; credentialScopes=${input.scopes.join(",") || "none"}; providerCredentialExpiresAt=${input.expiresAt}; providerAuthorization=observed; credentialRotation=${input.rotation}; providerOperationId=${input.providerOperationId}; credentialMaterialStored=false`;
}

function validateTokenMaterial(material: CloudflareApiTokenMaterial): CloudflareApiTokenMaterial {
  const token = requiredString(material.token, "provider token");
  const sourceId = requiredString(material.sourceId, "credential source ID");
  if (!/^[A-Za-z0-9:_./-]+$/u.test(sourceId) || /(?:cfat_|bearer\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=])/iu.test(sourceId)) throw new Error("credential source ID must be a non-secret metadata label");
  if (!Array.isArray(material.scopes) || material.scopes.some((scope) => typeof scope !== "string" || scope.trim().length === 0)) throw new Error("credential source scopes must be non-empty strings");
  return { token, sourceId, scopes: material.scopes.map((scope) => scope.trim()) };
}

function validateFutureExpiry(expiresAt: unknown, now: string, credentialId: string): string {
  const normalized = requiredString(expiresAt, "provider credential expiry");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new PromotionCredentialBrokerError({
      code: "provider-response-invalid",
      message: `Provider credential ${credentialId} returned an invalid expiry observation.`,
      recoveryAction: "repair the broker's provider verification mapping and retry only after a valid provider expiry is observed",
      receipt: `credentialId=${credentialId}; providerCredentialExpiresAt=invalid; providerAuthorization=unobserved; credentialMaterialStored=false`,
    });
  }
  if (parsed <= Date.parse(now)) {
    throw new PromotionCredentialBrokerError({
      code: "provider-expired",
      message: `Provider credential ${credentialId} is expired according to the provider observation.`,
      recoveryAction: "rotate the customer-owned provider credential, re-probe authorization, and retry the same immutable operation",
      receipt: `credentialId=${credentialId}; providerCredentialExpiresAt=${normalized}; providerAuthorization=expired; credentialMaterialStored=false`,
    });
  }
  return normalized;
}

function rotationState(previous: string | undefined, current: string): "initial" | "unchanged" | "observed" {
  if (!previous) return "initial";
  return previous === current ? "unchanged" : "observed";
}

/**
 * Broker for providers that expose an account token verification endpoint.
 * Cloudflare API tokens are intentionally read from a callback on every
 * observation, so secret rotation does not require restarting the executor.
 */
export class CloudflareApiTokenCredentialBroker implements CloudflareWorkerCredentialBroker {
  private readonly now: () => string;
  private lastCredentialId: string | undefined;

  constructor(private readonly config: CloudflareApiTokenCredentialBrokerConfig) {
    requiredString(config.accountId, "accountId");
    requiredString(config.scriptName, "scriptName");
    requiredString(config.targetId, "targetId");
    if (typeof config.tokenSource !== "function") throw new Error("tokenSource is required");
    this.now = config.now ?? (() => new Date().toISOString());
  }

  async probe(input: { accountId: string; scriptName: string; targetId: string }): Promise<CloudflareWorkerCredentialObservation> {
    return (await this.observe({ ...input, operation: "probe" })).observation;
  }

  async issue(input: { accountId: string; scriptName: string; targetId: string; operation: CloudflareWorkerTargetOperation; audience: CloudflareWorkerCredential["audience"] }): Promise<CloudflareWorkerCredential> {
    const observed = await this.observe(input);
    const required = requiredScopes(input.operation);
    const missing = required.filter((scope) => !observed.observation.scopes.includes(scope));
    if (missing.length > 0) {
      throw new PromotionCredentialBrokerError({
        code: "scope-missing",
        message: `Credential ${observed.observation.credentialId} does not declare the required ${input.operation} scope(s): ${missing.join(", ")}.`,
        recoveryAction: "issue a provider credential with the required Target operation scope or configure an operation-specific broker source",
        receipt: `${observed.observation.receipt}; scopeCheck=failed; requiredScopes=${required.join(",")}; missingScopes=${missing.join(",")}; providerMutation=false`,
      });
    }
    return {
      token: observed.token,
      credentialId: observed.observation.credentialId,
      expiresAt: observed.observation.expiresAt,
      audience: input.audience,
      scopes: observed.observation.scopes,
      providerAuthorization: "observed",
      ...(observed.observation.providerOperationId ? { providerOperationId: observed.observation.providerOperationId } : {}),
      receipt: `${observed.observation.receipt}; scopeCheck=passed; providerMutation=not-yet-attempted`,
    };
  }

  private async observe(input: { accountId: string; scriptName: string; targetId: string; operation: CloudflareWorkerTargetOperation | "probe" }): Promise<ObservedCredential> {
    if (input.accountId !== this.config.accountId || input.scriptName !== this.config.scriptName || input.targetId !== this.config.targetId) {
      throw new PromotionCredentialBrokerError({
        code: "provider-unauthorized",
        message: "Credential broker request is not bound to its configured Account, Worker, and Target.",
        recoveryAction: "route the exact Target operation to its customer-owned broker",
        receipt: `credentialBroker=customer-owned; binding=target-mismatch; providerAuthorization=unobserved; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    const source = this.config.operationTokenSource?.[input.operation as CloudflareWorkerTargetOperation] ?? this.config.tokenSource;
    let material: CloudflareApiTokenMaterial;
    try {
      material = validateTokenMaterial(await source({ accountId: input.accountId, scriptName: input.scriptName, targetId: input.targetId, operation: input.operation }));
    } catch (error) {
      throw new PromotionCredentialBrokerError({
        code: "source-unavailable",
        message: "Customer-owned provider credential source is unavailable.",
        recoveryAction: "restore the broker secret source or provider credential binding before retrying the same immutable operation",
        receipt: `credentialBroker=customer-owned; credentialSource=unavailable; providerAuthorization=unobserved; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    let verification: CloudflareWorkerApiResponse<CloudflareTokenVerifyResult>;
    try {
      verification = await this.config.transport.request<CloudflareTokenVerifyResult>({ method: "GET", path: verifyPath(input.accountId), token: material.token });
    } catch {
      throw new PromotionCredentialBrokerError({
        code: "source-unavailable",
        message: "Provider credential authorization probe could not reach the provider verification endpoint.",
        recoveryAction: "inspect provider reachability and retry the same immutable credential observation",
        receipt: `credentialBroker=customer-owned; credentialSource=${material.sourceId}; providerAuthorization=indeterminate; providerOperation=token-verify; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    if (!verification.ok || verification.result === undefined) {
      const status = verification.status === 401 || verification.status === 403 ? "rejected" : "unavailable";
      throw new PromotionCredentialBrokerError({
        code: status === "rejected" ? "provider-unauthorized" : "source-unavailable",
        message: `Provider credential authorization observation failed: ${safeProviderErrors(verification)}.`,
        recoveryAction: status === "rejected" ? "rotate or re-authorize the customer-owned provider credential, then retry after a successful probe" : "inspect provider reachability and retry the same immutable credential observation",
        receipt: `credentialBroker=customer-owned; credentialSource=${material.sourceId}; providerAuthorization=${status}; httpStatus=${verification.status}; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    const credentialId = requiredString(verification.result.id, "provider credential ID");
    if (!/^[A-Za-z0-9:_./-]+$/u.test(credentialId) || /(?:cfat_|bearer\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=])/iu.test(credentialId)) {
      throw new PromotionCredentialBrokerError({
        code: "provider-response-invalid",
        message: "Provider returned an unsafe credential identity.",
        recoveryAction: "repair the provider verification mapping and retry only after a non-secret credential identity is observed",
        receipt: "credentialId=unsafe; providerAuthorization=unobserved; providerMutation=false; credentialMaterialStored=false",
      });
    }
    const status = verification.result.status;
    if (status !== "active") {
      throw new PromotionCredentialBrokerError({
        code: "provider-revoked",
        message: `Provider credential ${credentialId} is not active (${String(status)}).`,
        recoveryAction: "rotate or re-enable the customer-owned provider credential and rerun the provider authorization probe",
        receipt: `credentialId=${credentialId}; providerCredentialStatus=${String(status)}; providerAuthorization=revoked; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    const expiresAt = validateFutureExpiry(verification.result.expires_on, this.now(), credentialId);
    let targetAuthorization: CloudflareWorkerApiResponse<unknown>;
    try {
      targetAuthorization = await this.config.transport.request<unknown>({ method: "GET", path: versionsPath(input.accountId, input.scriptName), token: material.token });
    } catch {
      throw new PromotionCredentialBrokerError({
        code: "source-unavailable",
        message: "Provider credential Target authorization probe could not reach the Worker API.",
        recoveryAction: "inspect provider reachability and retry the same immutable credential observation",
        receipt: `credentialId=${credentialId}; credentialSource=${material.sourceId}; providerAuthorization=indeterminate; providerOperation=target-read; target=${input.targetId}; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    if (!targetAuthorization.ok) {
      const statusKind = targetAuthorization.status === 401 || targetAuthorization.status === 403 ? "rejected" : "unavailable";
      throw new PromotionCredentialBrokerError({
        code: statusKind === "rejected" ? "provider-unauthorized" : "source-unavailable",
        message: `Provider credential is not authorized for the configured Worker Target: ${safeProviderErrors(targetAuthorization)}.`,
        recoveryAction: statusKind === "rejected" ? "grant the broker only the required Worker Target permission or rotate to a correctly scoped credential" : "inspect provider reachability and retry the same immutable credential observation",
        receipt: `credentialId=${credentialId}; credentialSource=${material.sourceId}; providerAuthorization=${statusKind}; target=${input.targetId}; httpStatus=${targetAuthorization.status}; providerMutation=false; credentialMaterialStored=false`,
      });
    }
    const rotation = rotationState(this.lastCredentialId, credentialId);
    this.lastCredentialId = credentialId;
    const providerOperationId = credentialProviderOperationId(input.operation, credentialId, material.sourceId);
    const receipt = observationReceipt({ operation: input.operation, credentialId, sourceId: material.sourceId, expiresAt, scopes: material.scopes, providerOperationId, rotation });
    return {
      token: material.token,
      sourceId: material.sourceId,
      observation: { credentialId, expiresAt, scopes: material.scopes, providerAuthorization: "observed", providerOperationId, receipt },
    };
  }
}

export function createCloudflareApiTokenCredentialBroker(input: Omit<CloudflareApiTokenCredentialBrokerConfig, "transport"> & { transport?: CloudflareWorkerApiTransport; fetch?: typeof fetch }): CloudflareWorkerCredentialBroker {
  return new CloudflareApiTokenCredentialBroker({ ...input, transport: input.transport ?? createCloudflareWorkerRestTransport(input.fetch ? { fetch: input.fetch } : {}) });
}

export function providerAuthorizationReceipt(error: unknown): string {
  if (error instanceof PromotionCredentialBrokerError) return error.receipt;
  return "credentialBroker=customer-owned; providerAuthorization=unobserved; providerMutation=false; credentialMaterialStored=false";
}

function brokerResponseError(body: Record<string, unknown>, status: number): PromotionCredentialBrokerError {
  const code = typeof body.code === "string" ? body.code : "broker_http_error";
  const receipt = typeof body.receipt === "string" ? body.receipt : `credentialBroker=customer-owned; brokerHttpStatus=${status}; providerAuthorization=unobserved; credentialMaterialStored=false`;
  return new PromotionCredentialBrokerError({
    code: code.includes("revoked") ? "provider-revoked" : code.includes("expired") ? "provider-expired" : code.includes("scope") ? "scope-missing" : status === 401 || status === 403 ? "provider-unauthorized" : "source-unavailable",
    message: typeof body.message === "string" ? body.message : `Credential broker rejected the request with HTTP ${status}.`,
    recoveryAction: typeof body.recoveryAction === "string" ? body.recoveryAction : "inspect the customer-owned credential broker and retry the same immutable operation after authorization is observed",
    receipt,
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("credential broker response was not an object");
  return value as Record<string, unknown>;
}

/** Client used by the Promotion executor to call a customer-owned broker Worker service binding. */
export function createPromotionCredentialBrokerClient(fetcher: (request: Request) => Promise<Response>): CloudflareWorkerCredentialBroker {
  async function call(path: "/issue" | "/probe", body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetcher(new Request(`https://anyam-credential-broker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anyam-credential-broker-protocol": PROMOTION_CREDENTIAL_BROKER_PROTOCOL },
      body: JSON.stringify({ protocol: PROMOTION_CREDENTIAL_BROKER_PROTOCOL, ...body }),
    }));
    const parsed = await response.json().catch(() => ({}));
    const object = objectBody(parsed);
    if (!response.ok || object.status !== "succeeded") throw brokerResponseError(object, response.status);
    return object;
  }
  return {
    async issue(input) {
      const object = await call("/issue", input);
      const credential = object.credential;
      if (credential === null || typeof credential !== "object" || Array.isArray(credential)) throw new Error("credential broker issue response omitted credential");
      const value = credential as Record<string, unknown>;
      if (typeof value.token !== "string" || typeof value.credentialId !== "string" || typeof value.expiresAt !== "string" || typeof value.receipt !== "string" || value.providerAuthorization !== "observed" || !Array.isArray(value.scopes)) throw new Error("credential broker issue response was incomplete");
      return {
        token: value.token,
        credentialId: value.credentialId,
        expiresAt: value.expiresAt,
        audience: value.audience as CloudflareWorkerCredential["audience"],
        scopes: value.scopes.filter((scope): scope is string => typeof scope === "string"),
        providerAuthorization: "observed",
        ...(typeof value.providerOperationId === "string" ? { providerOperationId: value.providerOperationId } : {}),
        receipt: value.receipt,
      };
    },
    async probe(input) {
      const object = await call("/probe", input);
      const observation = object.observation;
      if (observation === null || typeof observation !== "object" || Array.isArray(observation)) throw new Error("credential broker probe response omitted observation");
      const value = observation as Record<string, unknown>;
      if (typeof value.credentialId !== "string" || typeof value.expiresAt !== "string" || typeof value.receipt !== "string" || value.providerAuthorization !== "observed" || !Array.isArray(value.scopes)) throw new Error("credential broker probe response was incomplete");
      return {
        credentialId: value.credentialId,
        expiresAt: value.expiresAt,
        scopes: value.scopes.filter((scope): scope is string => typeof scope === "string"),
        providerAuthorization: "observed",
        ...(typeof value.providerOperationId === "string" ? { providerOperationId: value.providerOperationId } : {}),
        receipt: value.receipt,
      };
    },
  };
}
