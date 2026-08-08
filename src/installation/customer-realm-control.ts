import {
  CustomerRealmInstallation,
  type CustomerRealmCloudflareAdapter,
  type CustomerRealmDeploymentReadiness,
  type CustomerRealmInstallationState,
  type CustomerRealmInstallationStore,
  type CustomerRealmImport,
  type CustomerRealmOwner,
  type CustomerRealmProjectImporter,
  type CustomerRealmProviderAuthorization,
} from "./customer-realm.ts";

export const CUSTOMER_REALM_CONTROL_PROTOCOL = "anyam.customer-realm-control/v1" as const;

export type CustomerRealmControlOperation =
  | "installation.status"
  | "installation.install"
  | "installation.owner-claim"
  | "installation.readiness"
  | "installation.recover"
  | "installation.recovery-restore"
  | "installation.recovery-activate";

export type CustomerRealmControlCapability =
  | "installation.read"
  | "installation.manage"
  | "owner.claim"
  | "recovery.activate";

export type CustomerRealmControlAuthorization = {
  actorId: string;
  capability: CustomerRealmControlCapability;
  receipt: string;
};

export type CustomerRealmControlAuthorizationResult =
  | { status: "authorized"; authorization: CustomerRealmControlAuthorization }
  | { status: "denied"; code: "unauthorized" | "forbidden"; recoveryAction: string; receipt: string };

/**
 * Authentication is deliberately an adapter boundary. A WebAuthn/OIDC
 * implementation verifies the transient proof and returns only identity
 * metadata and an external receipt. The proof is never handed to the
 * installation state machine and is never persisted.
 */
export type CustomerRealmOwnerVerification =
  | {
      status: "verified";
      method: "passkey";
      principalId?: string;
      displayName: string;
      credentialId: string;
      verificationReceipt: string;
    }
  | {
      status: "verified";
      method: "oidc";
      principalId?: string;
      displayName: string;
      issuer: string;
      subject: string;
      clientId: string;
      verificationReceipt: string;
    }
  | {
      status: "retryable" | "failed";
      code: string;
      recoveryAction: string;
      receipt: string;
    };

export type CustomerRealmOwnerAuthenticationAdapter = {
  verifyPasskey(input: { installationId: string; realmId: string; proof: string; displayName?: string }): Promise<CustomerRealmOwnerVerification>;
  verifyOidc(input: { installationId: string; realmId: string; proof: string; displayName?: string }): Promise<CustomerRealmOwnerVerification>;
};

export type CustomerRealmDeploymentReadinessResult =
  | {
      status: "ready";
      operationId: string;
      providerOperationId?: string;
      receipt: string;
      recoveryAction: string;
    }
  | {
      status: "retryable" | "blocked";
      operationId: string;
      providerOperationId?: string;
      errorCode: string;
      receipt: string;
      recoveryAction: string;
    };

export type CustomerRealmDeploymentReadinessAdapter = {
  inspect(input: { installationId: string; accountId: string; operationId: string; authorization?: CustomerRealmProviderAuthorization }): Promise<CustomerRealmDeploymentReadinessResult>;
};

export type CustomerRealmControlPlaneOptions = {
  store?: CustomerRealmInstallationStore;
  cloudflare: CustomerRealmCloudflareAdapter;
  importer: CustomerRealmProjectImporter;
  ownerAuthentication: CustomerRealmOwnerAuthenticationAdapter;
  readiness: CustomerRealmDeploymentReadinessAdapter;
  now?: () => Date;
};

export type CustomerRealmControlResult = {
  protocol: typeof CUSTOMER_REALM_CONTROL_PROTOCOL;
  operation: CustomerRealmControlOperation;
  status: "succeeded" | "retryable" | "blocked";
  installationId: string;
  state?: CustomerRealmInstallationState;
  readiness?: CustomerRealmDeploymentReadiness;
  verificationReceipt?: string;
  recoveryAction: string;
  receipt: string;
};

export class CustomerRealmControlError extends Error {
  readonly code: "invalid_request" | "unauthorized" | "forbidden" | "not_found" | "control_unconfigured";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: CustomerRealmControlError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "CustomerRealmControlError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, recoveryAction: this.recoveryAction, receipt: this.receipt };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CustomerRealmControlError({ code: "invalid_request", message: `${field} is required.`, recoveryAction: `provide a non-empty ${field} and retry`, receipt: `field=${field}; present=false` });
  return value;
}

function providerAuthorization(value: unknown, accountId: string, now = new Date()): CustomerRealmProviderAuthorization | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CustomerRealmControlError({ code: "invalid_request", message: "providerAuthorization must be a receipt-only object.", recoveryAction: "provide the customer provider session digest and receipt, never a provider token", receipt: "providerAuthorization=object-required" });
  const candidate = value as Record<string, unknown>;
  const authorization: CustomerRealmProviderAuthorization = {
    provider: candidate.provider === "cloudflare" ? "cloudflare" : (() => { throw new CustomerRealmControlError({ code: "invalid_request", message: "providerAuthorization.provider is unsupported.", recoveryAction: "use the configured Cloudflare provider adapter", receipt: `provider=${String(candidate.provider)}` }); })(),
    accountId: requiredString(candidate.accountId, "providerAuthorization.accountId"),
    audience: candidate.audience === "cloudflare-api" ? "cloudflare-api" : (() => { throw new CustomerRealmControlError({ code: "invalid_request", message: "providerAuthorization.audience is unsupported.", recoveryAction: "use the customer Cloudflare API audience", receipt: `audience=${String(candidate.audience)}` }); })(),
    authorizationDigest: requiredString(candidate.authorizationDigest, "providerAuthorization.authorizationDigest"),
    expiresAt: requiredString(candidate.expiresAt, "providerAuthorization.expiresAt"),
    receipt: requiredString(candidate.receipt, "providerAuthorization.receipt"),
  };
  if (authorization.accountId !== accountId) throw new CustomerRealmControlError({ code: "forbidden", message: "Provider authorization is not for the requested customer account.", recoveryAction: "authorize the same customer account named by the installation command", receipt: "provider-account-match=false" });
  if (!/^sha256:[0-9a-f]{64}$/.test(authorization.authorizationDigest)) throw new CustomerRealmControlError({ code: "invalid_request", message: "Provider authorization digest is not an immutable SHA-256 receipt.", recoveryAction: "record the provider credential digest without sending the credential to Anyam", receipt: "authorizationDigest=sha256:64-lowercase-hex required" });
  if (!Number.isFinite(Date.parse(authorization.expiresAt))) throw new CustomerRealmControlError({ code: "invalid_request", message: "Provider authorization expiry is not a valid timestamp.", recoveryAction: "renew the customer provider session and retry", receipt: "providerAuthorization.expiresAt=timestamp required" });
  if (Date.parse(authorization.expiresAt) <= now.getTime()) throw new CustomerRealmControlError({ code: "unauthorized", message: "Provider authorization has expired; no customer provider operation was attempted.", recoveryAction: "renew the customer provider session and retry the same command identity", receipt: "providerAuthorization=expired; credentialStoredByAnyam=false" });
  if (Object.keys(candidate).some((key) => /token|password|secret|credential/i.test(key))) throw new CustomerRealmControlError({ code: "invalid_request", message: "Provider authorization contains credential material; no provider credential was accepted.", recoveryAction: "send only the provider authorization digest and receipt", receipt: "credential-material=reject" });
  return authorization;
}

function capabilityFor(operation: CustomerRealmControlOperation): CustomerRealmControlCapability {
  if (operation === "installation.status") return "installation.read";
  if (operation === "installation.owner-claim") return "owner.claim";
  if (operation === "installation.recovery-activate" || operation === "installation.recovery-restore") return "recovery.activate";
  return "installation.manage";
}

function requireCapability(operation: CustomerRealmControlOperation, authorization: CustomerRealmControlAuthorization): void {
  const expected = capabilityFor(operation);
  if (authorization.capability !== expected) throw new CustomerRealmControlError({ code: "forbidden", message: `The ${operation} command requires capability ${expected}.`, recoveryAction: `obtain an explicit customer Realm grant for ${expected} and retry`, receipt: `required=${expected}; presented=${authorization.capability}` });
  if (!authorization.actorId.trim() || !authorization.receipt.trim()) throw new CustomerRealmControlError({ code: "unauthorized", message: "The customer command authorization is incomplete; no mutation was performed.", recoveryAction: "authenticate the customer actor and provide its external authorization receipt", receipt: "actorId and authorization receipt required" });
}

export class CustomerRealmControlPlane {
  constructor(private readonly input: CustomerRealmControlPlaneOptions) {}

  private async open(installationId: string): Promise<CustomerRealmInstallation> {
    const options = {
      installationId,
      ...(this.input.store ? { store: this.input.store } : {}),
      cloudflare: this.input.cloudflare,
      importer: this.input.importer,
      ...(this.input.now ? { now: this.input.now } : {}),
    };
    return CustomerRealmInstallation.open(options);
  }

  async status(input: { installationId: string; authorization: CustomerRealmControlAuthorization }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.status", input.authorization);
    const installation = await this.open(requiredString(input.installationId, "installationId"));
    const state = installation.snapshot;
    return {
      protocol: CUSTOMER_REALM_CONTROL_PROTOCOL,
      operation: "installation.status",
      status: "succeeded",
      installationId: state.installationId,
      state,
      recoveryAction: state.degraded?.safeRecoveryAction ?? "No recovery action is currently required.",
      receipt: `installation=${state.installationId}; phase=${state.phase}; checkpoint=${state.checkpoint.checkpointId}; credentialFree=true`,
    };
  }

  async install(input: { installationId: string; accountId: string; requestedResourceTypes: readonly string[]; ownerConfirmed: boolean; operationId?: string; idempotencyKey?: string; providerAuthorization?: unknown; authorization: CustomerRealmControlAuthorization }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.install", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const accountId = requiredString(input.accountId, "accountId");
    const authorization = providerAuthorization(input.providerAuthorization, accountId, this.input.now?.() ?? new Date());
    if (!authorization) throw new CustomerRealmControlError({ code: "unauthorized", message: "Customer-operated installation requires a provider authorization receipt; no provider mutation was attempted.", recoveryAction: "authorize the customer Cloudflare account through the provider adapter and retry", receipt: "providerAuthorization=required; credentialStoredByAnyam=false" });
    const installation = await this.open(installationId);
    const state = await installation.install({ accountId, requestedResourceTypes: [...input.requestedResourceTypes], ownerConfirmed: input.ownerConfirmed, ...(input.operationId ? { operationId: input.operationId } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}), ...(authorization ? { providerAuthorization: authorization } : {}) });
    return this.result("installation.install", state, state.phase === "degraded" ? "retryable" : state.phase === "blocked" ? "blocked" : "succeeded", state.degraded?.safeRecoveryAction ?? "Complete adapter-verified owner enrollment before creating a Project.", `installation=${state.installationId}; phase=${state.phase}; checkpoint=${state.checkpoint.checkpointId}; providerCredentialStored=false`);
  }

  async ownerClaim(input: { installationId: string; method: "passkey" | "oidc"; proof: string; displayName?: string; principalId?: string; recovery: { method: CustomerRealmOwner["recoveryMethod"]; enrollmentReceipt: string; materialDigest?: string }; authorization: CustomerRealmControlAuthorization }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.owner-claim", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const installation = await this.open(installationId);
    const realmId = installation.snapshot.realmId;
    if (!realmId) throw new CustomerRealmControlError({ code: "invalid_request", message: "Owner claim requires a provisioned Realm identity.", recoveryAction: "complete customer account inspection and Realm provisioning before claiming the owner", receipt: "realmId=missing" });
    const verification = input.method === "passkey"
      ? await this.input.ownerAuthentication.verifyPasskey({ installationId, realmId, proof: requiredString(input.proof, "proof"), ...(input.displayName ? { displayName: input.displayName } : {}) })
      : await this.input.ownerAuthentication.verifyOidc({ installationId, realmId, proof: requiredString(input.proof, "proof"), ...(input.displayName ? { displayName: input.displayName } : {}) });
    if (verification.status !== "verified") return { protocol: CUSTOMER_REALM_CONTROL_PROTOCOL, operation: "installation.owner-claim", status: verification.status === "retryable" ? "retryable" : "blocked", installationId, recoveryAction: verification.recoveryAction, receipt: `installation=${installationId}; ownerVerification=${verification.status}; ${verification.receipt}` };
    const state = await installation.enrollVerifiedOwner({
      displayName: verification.displayName,
      ...(input.principalId ?? verification.principalId ? { principalId: input.principalId ?? verification.principalId } : {}),
      authentication: verification.method === "passkey"
        ? { method: "passkey", credentialId: verification.credentialId, verificationReceipt: verification.verificationReceipt }
        : { method: "oidc", issuer: verification.issuer, subject: verification.subject, clientId: verification.clientId, verificationReceipt: verification.verificationReceipt },
      recovery: input.recovery,
    });
    return this.result("installation.owner-claim", state, "succeeded", "Create or import the first Project after owner recovery enrollment.", `installation=${state.installationId}; phase=${state.phase}; authentication=${verification.method}; adapterVerified=true; providerCredentialStored=false` , verification.verificationReceipt);
  }

  async readiness(input: { installationId: string; operationId: string; authorization: CustomerRealmControlAuthorization; providerAuthorization?: unknown }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.readiness", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const operationId = requiredString(input.operationId, "operationId");
    const installation = await this.open(installationId);
    const state = installation.snapshot;
    if (!state.account) throw new CustomerRealmControlError({ code: "invalid_request", message: "Deployment readiness requires a verified customer account.", recoveryAction: "run the customer-operated install command first", receipt: "account=missing" });
    const authorization = providerAuthorization(input.providerAuthorization, state.account.accountId, this.input.now?.() ?? new Date());
    if (!authorization) throw new CustomerRealmControlError({ code: "unauthorized", message: "Deployment readiness requires a fresh customer provider authorization receipt.", recoveryAction: "renew the customer Cloudflare provider session and retry the same operation identity", receipt: "providerAuthorization=required; credentialStoredByAnyam=false" });
    const result = await this.input.readiness.inspect({ installationId, accountId: state.account.accountId, operationId, ...(authorization ? { authorization } : {}) });
    const recorded = await installation.recordDeploymentReadiness(result);
    const status = result.status === "ready" ? "succeeded" : result.status;
    return this.result("installation.readiness", recorded, status, result.recoveryAction, `installation=${installationId}; operation=${operationId}; status=${result.status}; providerReceipt=${result.receipt}; providerCredentialStored=false`, undefined, recorded.deploymentReadiness);
  }

  async recover(input: { installationId: string; authorization: CustomerRealmControlAuthorization; providerAuthorization?: unknown }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.recover", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const installation = await this.open(installationId);
    const state = installation.snapshot;
    const authorization = providerAuthorization(input.providerAuthorization, state.account?.accountId ?? "", this.input.now?.() ?? new Date());
    if (state.account && !authorization) throw new CustomerRealmControlError({ code: "unauthorized", message: "Recovery requires a fresh customer provider authorization receipt.", recoveryAction: "renew the customer Cloudflare provider session and retry recovery", receipt: "providerAuthorization=required; credentialStoredByAnyam=false" });
    const recovered = await installation.recover(authorization ? { providerAuthorization: authorization } : {});
    return this.result("installation.recover", recovered, recovered.phase === "degraded" ? "retryable" : recovered.phase === "blocked" ? "blocked" : "succeeded", recovered.degraded?.safeRecoveryAction ?? "Inspect the recovered checkpoint and continue owner activation.", `installation=${installationId}; phase=${recovered.phase}; checkpoint=${recovered.checkpoint.checkpointId}; providerCredentialStored=false`);
  }

  async activateRecovery(input: { installationId: string; ownerPrincipalId: string; recoveryReceipt: string; authorization: CustomerRealmControlAuthorization; providerAuthorization?: unknown }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.recovery-activate", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const installation = await this.open(installationId);
    const state = installation.snapshot;
    const authorization = providerAuthorization(input.providerAuthorization, state.account?.accountId ?? "", this.input.now?.() ?? new Date());
    if (state.account && !authorization) throw new CustomerRealmControlError({ code: "unauthorized", message: "Recovery activation requires a fresh customer provider authorization receipt.", recoveryAction: "renew the customer Cloudflare provider session and retry activation", receipt: "providerAuthorization=required; credentialStoredByAnyam=false" });
    const active = await installation.activateRecovery({ ownerPrincipalId: requiredString(input.ownerPrincipalId, "ownerPrincipalId"), recoveryReceipt: requiredString(input.recoveryReceipt, "recoveryReceipt"), ...(authorization ? { providerAuthorization: authorization } : {}) });
    return this.result("installation.recovery-activate", active, active.phase === "degraded" ? "retryable" : active.phase === "blocked" ? "blocked" : "succeeded", active.degraded?.safeRecoveryAction ?? "No recovery action is currently required.", `installation=${installationId}; phase=${active.phase}; freshExternalActivation=true; providerCredentialStored=false`);
  }

  async restoreRecovery(input: { installationId: string; bundle: Parameters<CustomerRealmInstallation["restoreRecovery"]>[0]; authorization: CustomerRealmControlAuthorization }): Promise<CustomerRealmControlResult> {
    requireCapability("installation.recovery-restore", input.authorization);
    const installationId = requiredString(input.installationId, "installationId");
    const installation = await this.open(installationId);
    const restored = await installation.restoreRecovery(input.bundle);
    return this.result("installation.recovery-restore", restored, "succeeded", "Authenticate the recorded owner, reconcile customer resources, and activate the quarantined Recovery state.", `installation=${installationId}; phase=${restored.phase}; credentialsRestored=false; ownerActivationRequired=true`);
  }

  private result(operation: CustomerRealmControlOperation, state: CustomerRealmInstallationState, status: CustomerRealmControlResult["status"], recoveryAction: string, receipt: string, verificationReceipt?: string, readiness?: CustomerRealmDeploymentReadiness): CustomerRealmControlResult {
    return { protocol: CUSTOMER_REALM_CONTROL_PROTOCOL, operation, status, installationId: state.installationId, state: clone(state), ...(verificationReceipt ? { verificationReceipt } : {}), ...(readiness ? { readiness } : {}), recoveryAction, receipt };
  }
}

export type CustomerRealmControlRoute = {
  handle(request: Request): Promise<Response>;
};

export function createCustomerRealmControlRoute(input: { plane: CustomerRealmControlPlane; authorize: (input: { request: Request; operation: CustomerRealmControlOperation; installationId: string }) => Promise<CustomerRealmControlAuthorizationResult> }): CustomerRealmControlRoute {
  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      const operation = operationFor(request.method, segments);
      if (!operation) return json({ code: "not_found", recoveryAction: "Use the documented customer installation command route." }, 404);
      let body: Record<string, unknown> = {};
      if (request.method === "POST") {
        try {
          body = await readJson(request);
        } catch (error) {
          if (error instanceof CustomerRealmControlError) return json(error.toJSON(), 422);
          throw error;
        }
      }
      const bodyInstallationId = typeof body.installationId === "string" ? body.installationId : "";
      const installationId = segments[2] ?? url.searchParams.get("installationId") ?? bodyInstallationId;
      const auth = await input.authorize({ request, operation, installationId });
      if (auth.status === "denied") return json({ code: auth.code, recoveryAction: auth.recoveryAction, receipt: auth.receipt }, auth.code === "unauthorized" ? 401 : 403);
      try {
        const commandBody = body as Record<string, unknown>;
        const operationId = typeof commandBody.operationId === "string" ? commandBody.operationId : undefined;
        const idempotencyKey = typeof commandBody.idempotencyKey === "string" ? commandBody.idempotencyKey : undefined;
        const providerAuth = Object.prototype.hasOwnProperty.call(commandBody, "providerAuthorization") ? commandBody.providerAuthorization : undefined;
        const result = operation === "installation.status"
          ? await input.plane.status({ installationId, authorization: auth.authorization })
            : operation === "installation.install"
            ? await input.plane.install({ installationId, accountId: requiredString(commandBody.accountId, "accountId"), ownerConfirmed: commandBody.ownerConfirmed === true, requestedResourceTypes: arrayOfStrings(commandBody.requestedResourceTypes, "requestedResourceTypes"), ...(operationId ? { operationId } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), ...(providerAuth !== undefined ? { providerAuthorization: providerAuth } : {}), authorization: auth.authorization })
            : operation === "installation.owner-claim"
              ? await input.plane.ownerClaim({ ...(body as Record<string, unknown>), installationId, authorization: auth.authorization, method: bodyValue(body, "method", "passkey") as "passkey" | "oidc", proof: bodyValue(body, "proof", "") as string, recovery: recoveryBody(body) })
              : operation === "installation.readiness"
                ? await input.plane.readiness({ ...(body as Record<string, unknown>), installationId, authorization: auth.authorization, operationId: bodyValue(body, "operationId", "") as string })
                : operation === "installation.recover"
                  ? await input.plane.recover({ ...(body as Record<string, unknown>), installationId, authorization: auth.authorization })
                  : operation === "installation.recovery-restore"
                    ? await input.plane.restoreRecovery({ installationId, authorization: auth.authorization, bundle: commandBody.bundle as Parameters<CustomerRealmInstallation["restoreRecovery"]>[0] })
                    : await input.plane.activateRecovery({ ...(body as Record<string, unknown>), installationId, authorization: auth.authorization, ownerPrincipalId: bodyValue(body, "ownerPrincipalId", "") as string, recoveryReceipt: bodyValue(body, "recoveryReceipt", "") as string });
        return json(result, result.status === "succeeded" ? 200 : result.status === "retryable" ? 409 : 422);
      } catch (error) {
        if (error instanceof CustomerRealmControlError) return json(error.toJSON(), error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 422);
        const message = error instanceof Error ? error.message : "Customer installation command failed.";
        return json({ code: "command_failed", message, recoveryAction: "inspect the customer-owned Recovery Checkpoint and retry the same command identity", receipt: `operation=${operation}; persistedMutation=unknown` }, 422);
      }
    },
  };
}

function operationFor(method: string, segments: readonly string[]): CustomerRealmControlOperation | undefined {
  if (method === "GET" && segments[0] === "api" && segments[1] === "install" && (segments[2] === "status" || segments[2])) return "installation.status";
  if (method !== "POST" || segments[0] !== "api" || segments[1] !== "install") return undefined;
  if (segments.length === 2) return "installation.install";
  if (segments[3] === "owner-claim") return "installation.owner-claim";
  if (segments[3] === "readiness") return "installation.readiness";
  if (segments[3] === "recover") return "installation.recover";
  if (segments[3] === "recovery" && segments[4] === "restore") return "installation.recovery-restore";
  if (segments[3] === "recovery" && segments[4] === "activate") return "installation.recovery-activate";
  return undefined;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new CustomerRealmControlError({ code: "invalid_request", message: "Customer installation commands require a JSON body.", recoveryAction: "send a JSON command body and retry", receipt: "json=parse-failed" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new CustomerRealmControlError({ code: "invalid_request", message: "Customer installation command body must be a JSON object.", recoveryAction: "send named command fields in a JSON object", receipt: "json=object-required" });
  return parsed as Record<string, unknown>;
}

function bodyValue(body: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return body[key] ?? fallback;
}

function arrayOfStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new CustomerRealmControlError({ code: "invalid_request", message: `${field} must be an array of strings.`, recoveryAction: `provide the customer-owned ${field} plan and retry`, receipt: `${field}=array-of-strings-required` });
  return value as string[];
}

function recoveryBody(body: Record<string, unknown>): { method: CustomerRealmOwner["recoveryMethod"]; enrollmentReceipt: string; materialDigest?: string } {
  const value = body.recovery;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CustomerRealmControlError({ code: "invalid_request", message: "Owner claim requires an external recovery enrollment receipt.", recoveryAction: "provide recovery.method and recovery.enrollmentReceipt without recovery material", receipt: "recovery=object-required" });
  const recovery = value as Record<string, unknown>;
  const method = requiredString(recovery.method, "recovery.method") as CustomerRealmOwner["recoveryMethod"];
  const enrollmentReceipt = requiredString(recovery.enrollmentReceipt, "recovery.enrollmentReceipt");
  const materialDigest = recovery.materialDigest === undefined ? undefined : requiredString(recovery.materialDigest, "recovery.materialDigest");
  if (Object.keys(recovery).some((key) => /token|password|secret|credential|code/i.test(key))) throw new CustomerRealmControlError({ code: "invalid_request", message: "Owner recovery input contains recovery material; no recovery secret was accepted.", recoveryAction: "send only the external recovery receipt and optional material digest", receipt: "recovery-material=reject" });
  return { method, enrollmentReceipt, ...(materialDigest ? { materialDigest } : {}) };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
