/**
 * The credential-free edge contract for a customer-operated Realm.
 *
 * This module deliberately does not perform bootstrap, authentication, source
 * transfer, Landing, or Promotion.  It only makes the deployment boundary
 * inspectable.  The durable Anyam authorities remain behind the adapters named
 * by the binding contract; a binding is never itself an authorization decision.
 */

export const CUSTOMER_REALM_WORKER_PROTOCOL = "anyam.customer-realm-worker/v1" as const;
export const CUSTOMER_REALM_HOSTING_MODE = "customer-operated" as const;

export type CustomerRealmWorkerBindingName =
  | "REALM_COORDINATOR"
  | "OAUTH_KV"
  | "ANYAM_METADATA_DB"
  | "ANYAM_EXPORTS"
  | "ANYAM_EVENTS"
  | "ANYAM_WORKFLOW";

export type CustomerRealmWorkerConfigurationKey = CustomerRealmWorkerBindingName | "ANYAM_HOSTING_MODE" | "ANYAM_INSTALLATION_ID" | "ANYAM_PROTOCOL_VERSION" | "ANYAM_REALM_RP_ID";

export const CUSTOMER_REALM_REQUIRED_BINDINGS: readonly CustomerRealmWorkerBindingName[] = [
  "REALM_COORDINATOR",
  "OAUTH_KV",
  "ANYAM_METADATA_DB",
  "ANYAM_EXPORTS",
  "ANYAM_EVENTS",
  "ANYAM_WORKFLOW",
];

/**
 * Structural types keep the kernel portable while accepting Cloudflare's
 * generated binding types in the Worker package.  No provider API is called by
 * this foundation slice.
 */
export type CustomerRealmWorkerBinding = object;

/** Structural route contract keeps the Worker bundle independent of the
 * Node-backed installation kernel. The customer coordinator supplies this
 * route only after its authentication and provider adapters are qualified. */
export type CustomerRealmWorkerControlRoute = {
  handle(request: Request): Promise<Response>;
};

export type CustomerRealmWorkerEnv = {
  readonly ANYAM_HOSTING_MODE?: string | undefined;
  readonly ANYAM_INSTALLATION_ID?: string | undefined;
  readonly ANYAM_PROTOCOL_VERSION?: string | undefined;
  readonly ANYAM_REALM_RP_ID?: string | undefined;
  readonly ANYAM_BUILD_REVISION?: string | undefined;
  readonly REALM_COORDINATOR?: CustomerRealmWorkerBinding | undefined;
  readonly OAUTH_KV?: CustomerRealmWorkerBinding | undefined;
  readonly ANYAM_METADATA_DB?: CustomerRealmWorkerBinding | undefined;
  readonly ANYAM_EXPORTS?: CustomerRealmWorkerBinding | undefined;
  readonly ANYAM_EVENTS?: CustomerRealmWorkerBinding | undefined;
  readonly ANYAM_WORKFLOW?: CustomerRealmWorkerBinding | undefined;
};

export type CustomerRealmWorkerBindingState = {
  readonly name: CustomerRealmWorkerBindingName;
  readonly configured: boolean;
};

export type CustomerRealmWorkerConfiguration = {
  readonly hostingMode: string | undefined;
  readonly installationId: string | undefined;
  readonly protocolVersion: string;
  readonly buildRevision: string | undefined;
  readonly bindings: readonly CustomerRealmWorkerBindingState[];
  readonly missingBindings: readonly CustomerRealmWorkerBindingName[];
  readonly missingConfiguration: readonly CustomerRealmWorkerConfigurationKey[];
};

export type CustomerRealmWorkerHealth = {
  readonly protocol: typeof CUSTOMER_REALM_WORKER_PROTOCOL;
  readonly status: "ready" | "blocked";
  readonly credentialFree: true;
  readonly authority: "customer-owned";
  readonly hostingMode: string | undefined;
  readonly installationId: string | undefined;
  readonly protocolVersion: string;
  readonly buildRevision: string | undefined;
  readonly configuredBindings: readonly CustomerRealmWorkerBindingName[];
  readonly missingBindings: readonly CustomerRealmWorkerBindingName[];
  readonly missingConfiguration: readonly CustomerRealmWorkerConfigurationKey[];
  readonly capabilities: readonly ["health", "bootstrap-metadata"];
  readonly recoveryAction: string;
  readonly receipt: string;
};

export class CustomerRealmWorkerConfigurationError extends Error {
  readonly code = "customer_realm_configuration_invalid" as const;
  readonly missingConfiguration: readonly CustomerRealmWorkerConfigurationKey[];
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    message: string;
    missingConfiguration: readonly CustomerRealmWorkerConfigurationKey[];
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "CustomerRealmWorkerConfigurationError";
    this.missingConfiguration = [...input.missingConfiguration];
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      missingConfiguration: this.missingConfiguration,
      recoveryAction: this.recoveryAction,
      receipt: this.receipt,
    };
  }
}

function configuredBinding(env: CustomerRealmWorkerEnv, name: CustomerRealmWorkerBindingName): boolean {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "object" && value !== null;
}

export function inspectCustomerRealmWorkerConfiguration(env: CustomerRealmWorkerEnv): CustomerRealmWorkerConfiguration {
  const bindings = CUSTOMER_REALM_REQUIRED_BINDINGS.map((name) => ({ name, configured: configuredBinding(env, name) }));
  const missingBindings = bindings.filter((binding) => !binding.configured).map((binding) => binding.name);
  const missingConfiguration: CustomerRealmWorkerConfigurationKey[] = [
    ...missingBindings,
    ...(env.ANYAM_HOSTING_MODE === CUSTOMER_REALM_HOSTING_MODE ? [] : ["ANYAM_HOSTING_MODE" as const]),
    ...(env.ANYAM_INSTALLATION_ID?.trim() ? [] : ["ANYAM_INSTALLATION_ID" as const]),
    ...((env.ANYAM_PROTOCOL_VERSION ?? CUSTOMER_REALM_WORKER_PROTOCOL) === CUSTOMER_REALM_WORKER_PROTOCOL ? [] : ["ANYAM_PROTOCOL_VERSION" as const]),
  ];
  return {
    hostingMode: env.ANYAM_HOSTING_MODE,
    installationId: env.ANYAM_INSTALLATION_ID,
    protocolVersion: env.ANYAM_PROTOCOL_VERSION ?? CUSTOMER_REALM_WORKER_PROTOCOL,
    buildRevision: env.ANYAM_BUILD_REVISION,
    bindings,
    missingBindings,
    missingConfiguration,
  };
}

export function validateCustomerRealmWorkerConfiguration(env: CustomerRealmWorkerEnv): CustomerRealmWorkerConfiguration {
  const configuration = inspectCustomerRealmWorkerConfiguration(env);
  if (configuration.missingConfiguration.length > 0) {
    const uniqueMissingInputs = [...new Set(configuration.missingConfiguration)];
    throw new CustomerRealmWorkerConfigurationError({
      message: `Customer-operated Realm Worker configuration is incomplete: ${uniqueMissingInputs.join(", ")}.`,
      missingConfiguration: uniqueMissingInputs,
      recoveryAction: "Configure the named customer-owned bindings and variables in the Worker deployment, then retry the health check.",
      receipt: `hostingMode=${configuration.hostingMode ?? "missing"}; installationId=${configuration.installationId ? "configured" : "missing"}; missing=${uniqueMissingInputs.join(",")}`,
    });
  }
  return configuration;
}

function healthFromConfiguration(configuration: CustomerRealmWorkerConfiguration): CustomerRealmWorkerHealth {
  const configuredBindings = configuration.bindings.filter((binding) => binding.configured).map((binding) => binding.name);
  const uniqueMissingInputs = [...new Set(configuration.missingConfiguration)];
  const ready = uniqueMissingInputs.length === 0;
  return {
    protocol: CUSTOMER_REALM_WORKER_PROTOCOL,
    status: ready ? "ready" : "blocked",
    credentialFree: true,
    authority: "customer-owned",
    hostingMode: configuration.hostingMode,
    installationId: configuration.installationId,
    protocolVersion: configuration.protocolVersion,
    buildRevision: configuration.buildRevision,
    configuredBindings,
    missingBindings: configuration.missingBindings,
    missingConfiguration: uniqueMissingInputs,
    capabilities: ["health", "bootstrap-metadata"],
    recoveryAction: ready ? "No action required for the credential-free foundation surface." : "Configure the named customer-owned bindings and variables, then retry the health check.",
    receipt: `status=${ready ? "ready" : "blocked"}; hostingMode=${configuration.hostingMode ?? "missing"}; configured=${configuredBindings.length}; missing=${uniqueMissingInputs.length}; credentialFree=true`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function customerRealmWorkerHealth(env: CustomerRealmWorkerEnv): CustomerRealmWorkerHealth {
  return healthFromConfiguration(inspectCustomerRealmWorkerConfiguration(env));
}

export async function handleCustomerRealmRequest(request: Request, env: CustomerRealmWorkerEnv, controlRoute?: CustomerRealmWorkerControlRoute): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/install")) {
    if (!controlRoute) return jsonResponse({ code: "not_found", recoveryAction: "The customer installation control adapter is not configured in this Worker; use the customer-operated CLI or bind a qualified control coordinator." }, 404);
    return controlRoute.handle(request);
  }
  if (request.method !== "GET") return jsonResponse({ code: "method_not_allowed", recoveryAction: "Use GET for the credential-free foundation surfaces." }, 405);
  if (url.pathname !== "/health" && url.pathname !== "/.well-known/anyam-realm") return jsonResponse({ code: "not_found", recoveryAction: "Use /health or /.well-known/anyam-realm for the foundation surface." }, 404);

  const health = customerRealmWorkerHealth(env);
  return jsonResponse(health, health.status === "ready" ? 200 : 503);
}

export function assertCustomerRealmWorkerConfiguration(env: CustomerRealmWorkerEnv): CustomerRealmWorkerConfiguration {
  return validateCustomerRealmWorkerConfiguration(env);
}
