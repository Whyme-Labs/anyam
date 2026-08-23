import {
  CUSTOMER_REALM_HOSTING_MODE,
  CUSTOMER_REALM_INSTALLATION_MANIFEST_PROTOCOL,
  CUSTOMER_REALM_REQUIRED_BINDINGS,
  CUSTOMER_REALM_WORKER_PROTOCOL,
  inspectCustomerRealmWorkerConfiguration,
  type CustomerRealmWorkerConfiguration,
  type CustomerRealmWorkerEnv,
} from "./realm-worker.ts";
import {
  parseProductionOperationsLedger,
  type ProductionOperationsReadiness,
} from "../operations/production-operations.ts";

export const CUSTOMER_REALM_OPERATOR_PROTOCOL = "anyam.customer-realm-operator/v1" as const;
export const CUSTOMER_REALM_OPERATOR_PREFLIGHT_PROTOCOL = "anyam.customer-realm-preflight/v1" as const;
export const CUSTOMER_REALM_INSTALLATION_MANIFEST_VERSION = "v1" as const;

/**
 * This is the versioned inventory a customer-operated Worker is expected to
 * expose. It is data, not authority: the manifest never creates a resource,
 * mints a credential, or decides whether a protected mutation is allowed.
 */
export const CUSTOMER_REALM_INSTALLATION_MANIFEST = {
  protocol: CUSTOMER_REALM_INSTALLATION_MANIFEST_PROTOCOL,
  version: CUSTOMER_REALM_INSTALLATION_MANIFEST_VERSION,
  workerProtocol: CUSTOMER_REALM_WORKER_PROTOCOL,
  hostingMode: CUSTOMER_REALM_HOSTING_MODE,
  requiredBindings: [...CUSTOMER_REALM_REQUIRED_BINDINGS],
  requiredConfiguration: ["ANYAM_HOSTING_MODE", "ANYAM_INSTALLATION_ID", "ANYAM_PROTOCOL_VERSION"],
  operatorObservations: [
    "ANYAM_RELEASE_DIGEST",
    "ANYAM_INSTALLATION_MANIFEST_DIGEST",
    "ANYAM_SCHEMA_DIGEST",
    "ANYAM_MIGRATION_DIGEST",
    "ANYAM_CONFIGURATION_DIGEST",
    "ANYAM_PROVIDER_ACCOUNT_ID",
    "ANYAM_PROVIDER_STATE",
    "ANYAM_PROVIDER_AUTHORIZATION_STATE",
    "ANYAM_MIGRATION_STATE",
    "ANYAM_RELEASE_STATE",
    "ANYAM_DOMAIN_POLICY_STATE",
    "ANYAM_RESIDENCY_POLICY_STATE",
    "ANYAM_EXPORT_DESTINATION",
    "ANYAM_LAST_EXPORT_DIGEST",
    "ANYAM_LAST_CHECKPOINT_DIGEST",
    "ANYAM_RESTORE_DRILL_STATE",
    "ANYAM_PENDING_OPERATIONS_STATE",
    "ANYAM_OPERATIONS_LEDGER",
  ],
} as const;

export type CustomerRealmOperatorStatusState = "healthy" | "blocked" | "degraded" | "indeterminate";
export type CustomerRealmOperatorObservationState = "verified" | "missing" | "expired" | "degraded" | "blocked" | "not-observed";
export type CustomerRealmOperatorProviderState = "verified" | "degraded" | "expired" | "not-observed";
export type CustomerRealmOperatorPendingState = "none" | "pending" | "stale" | "not-observed";
export type CustomerRealmOperatorRestoreState = "verified" | "failed" | "not-observed";

export type CustomerRealmOperatorEnv = CustomerRealmWorkerEnv & {
  readonly ANYAM_INSTALLATION_MANIFEST_DIGEST?: string | undefined;
  readonly ANYAM_RELEASE_DIGEST?: string | undefined;
  readonly ANYAM_SCHEMA_DIGEST?: string | undefined;
  readonly ANYAM_MIGRATION_DIGEST?: string | undefined;
  readonly ANYAM_CONFIGURATION_DIGEST?: string | undefined;
  readonly ANYAM_PROVIDER_ACCOUNT_ID?: string | undefined;
  readonly ANYAM_PROVIDER_STATE?: string | undefined;
  readonly ANYAM_PROVIDER_AUTHORIZATION_STATE?: string | undefined;
  readonly ANYAM_MIGRATION_STATE?: string | undefined;
  readonly ANYAM_RELEASE_STATE?: string | undefined;
  readonly ANYAM_DOMAIN_POLICY_STATE?: string | undefined;
  readonly ANYAM_RESIDENCY_POLICY_STATE?: string | undefined;
  readonly ANYAM_EXPORT_DESTINATION?: string | undefined;
  readonly ANYAM_LAST_EXPORT_DIGEST?: string | undefined;
  readonly ANYAM_LAST_CHECKPOINT_DIGEST?: string | undefined;
  readonly ANYAM_RESTORE_DRILL_STATE?: string | undefined;
  readonly ANYAM_PENDING_OPERATIONS_STATE?: string | undefined;
  /** Credential-free JSON snapshot of customer-run operational drill receipts. */
  readonly ANYAM_OPERATIONS_LEDGER?: string | undefined;
};

export type CustomerRealmOperatorIdentityObservation = {
  readonly realmId?: string | undefined;
  readonly recoveryStatus?: string | undefined;
  readonly authorizationEpoch?: number | undefined;
  readonly activeOwnerCount?: number | undefined;
  readonly passkeyCount?: number | undefined;
  readonly credentialFree?: boolean | undefined;
  readonly ownerSessionValidated?: boolean | undefined;
};

export type CustomerRealmOperatorCheck = {
  readonly id: string;
  readonly state: CustomerRealmOperatorStatusState;
  readonly observed: Readonly<Record<string, string | number | boolean | null>>;
  readonly receipt: string;
  readonly recoveryAction: string;
};

export type CustomerRealmOperatorStatus = {
  readonly protocol: typeof CUSTOMER_REALM_OPERATOR_PROTOCOL;
  readonly status: CustomerRealmOperatorStatusState;
  readonly manifest: {
    readonly protocol: typeof CUSTOMER_REALM_INSTALLATION_MANIFEST_PROTOCOL;
    readonly version: typeof CUSTOMER_REALM_INSTALLATION_MANIFEST_VERSION;
    readonly digest: string;
    readonly configuredDigest: string | null;
    readonly requiredBindings: readonly string[];
    readonly requiredConfiguration: readonly string[];
  };
  readonly installation: {
    readonly installationId: string | null;
    readonly realmId: string | null;
    readonly hostingMode: string | null;
    readonly protocolVersion: string;
    readonly buildRevision: string | null;
    readonly ownerState: CustomerRealmOperatorObservationState;
    readonly recoveryState: CustomerRealmOperatorObservationState;
    readonly authorizationEpoch: number | null;
  };
  readonly digests: {
    readonly release: string | null;
    readonly schema: string | null;
    readonly migration: string | null;
    readonly configuration: string | null;
  };
  readonly bindings: {
    readonly required: readonly string[];
    readonly configured: readonly string[];
    readonly missing: readonly string[];
    readonly providerState: CustomerRealmOperatorProviderState;
  };
  readonly provider: {
    readonly accountConfigured: boolean;
    readonly authorizationState: CustomerRealmOperatorObservationState;
    readonly state: CustomerRealmOperatorObservationState;
  };
  readonly pendingOperations: {
    readonly state: CustomerRealmOperatorPendingState;
  };
  readonly exportCheckpoint: {
    readonly destinationConfigured: boolean;
    readonly lastVerifiedExportDigest: string | null;
    readonly lastVerifiedCheckpointDigest: string | null;
    readonly restoreDrillState: CustomerRealmOperatorRestoreState;
  };
  readonly operations: ProductionOperationsReadiness;
  readonly checks: readonly CustomerRealmOperatorCheck[];
  readonly nextActions: readonly string[];
  readonly credentialFree: true;
  readonly canonicalWrite: false;
  readonly credentialMinted: false;
  readonly targetPromotion: "not-performed";
  readonly receipt: string;
};

export type CustomerRealmOperatorPreflight = Omit<CustomerRealmOperatorStatus, "protocol"> & {
  readonly protocol: typeof CUSTOMER_REALM_OPERATOR_PREFLIGHT_PROTOCOL;
  readonly operation: "read-only-preflight";
  readonly sideEffects: {
    readonly resourcesCreated: 0;
    readonly secretsCreated: 0;
    readonly canonicalWrite: false;
    readonly credentialMinted: false;
    readonly targetPromotion: "not-performed";
  };
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function customerRealmInstallationManifestDigest(): Promise<string> {
  return digest(CUSTOMER_REALM_INSTALLATION_MANIFEST);
}

function safeDigest(value: string | undefined): string | null {
  return value && /^sha256:[0-9a-f]{64}$/u.test(value.trim()) ? value.trim() : null;
}

function safeReference(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/u.test(value.trim()) ? value.trim() : null;
}

function safeState(value: string | undefined, allowed: readonly string[]): CustomerRealmOperatorObservationState {
  if (!value) return "not-observed";
  if (allowed.includes(value)) return value as CustomerRealmOperatorObservationState;
  return "not-observed";
}

function providerState(value: string | undefined): CustomerRealmOperatorProviderState {
  if (value === "healthy") return "verified";
  if (value === "outage") return "degraded";
  if (value === "expired-grant") return "expired";
  return "not-observed";
}

function pendingState(value: string | undefined): CustomerRealmOperatorPendingState {
  if (value === "none" || value === "pending" || value === "stale") return value;
  return "not-observed";
}

function restoreState(value: string | undefined): CustomerRealmOperatorRestoreState {
  if (value === "verified" || value === "failed") return value;
  return "not-observed";
}

function check(input: Omit<CustomerRealmOperatorCheck, "observed"> & { observed?: CustomerRealmOperatorCheck["observed"] }): CustomerRealmOperatorCheck {
  return { ...input, observed: input.observed ?? {} };
}

function aggregate(checks: readonly CustomerRealmOperatorCheck[]): CustomerRealmOperatorStatusState {
  if (checks.some((item) => item.state === "blocked")) return "blocked";
  if (checks.some((item) => item.state === "degraded")) return "degraded";
  if (checks.some((item) => item.state === "indeterminate")) return "indeterminate";
  return "healthy";
}

function uniqueActions(checks: readonly CustomerRealmOperatorCheck[]): readonly string[] {
  return [...new Set(checks.filter((item) => item.state !== "healthy").map((item) => item.recoveryAction))];
}

function identityState(identity: CustomerRealmOperatorIdentityObservation): { owner: CustomerRealmOperatorObservationState; recovery: CustomerRealmOperatorObservationState } {
  const owner = identity.activeOwnerCount === undefined || identity.passkeyCount === undefined
    ? "not-observed"
    : identity.activeOwnerCount > 0 && identity.passkeyCount > 0 ? "verified" : "missing";
  const recovery = identity.recoveryStatus === undefined
    ? "not-observed"
    : identity.recoveryStatus === "active" ? "verified" : identity.recoveryStatus === "recovery-pending" ? "blocked" : "not-observed";
  return { owner, recovery };
}

function configurationCheck(configuration: CustomerRealmWorkerConfiguration): CustomerRealmOperatorCheck {
  const missing = [...new Set(configuration.missingConfiguration)];
  return missing.length === 0
    ? check({ id: "configuration", state: "healthy", receipt: "configuration=verified; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { missing: null } })
    : check({ id: "configuration", state: "blocked", receipt: `configuration=blocked; missing=${missing.join(",")}; readOnly=true`, recoveryAction: `Configure the named customer-owned variables and retry preflight: ${missing.join(", ")}.`, observed: { missing: missing.join(",") } });
}

function manifestCheck(configuredDigest: string | undefined, manifestDigest: string): CustomerRealmOperatorCheck {
  const observed = safeDigest(configuredDigest);
  if (!observed) return check({ id: "installation-manifest", state: "indeterminate", receipt: "manifest=not-pinned; digest=missing; readOnly=true", recoveryAction: "Set the customer Worker manifest digest to the exact Anyam installation manifest digest, then rerun preflight.", observed: { configuredDigest: null, manifestDigest } });
  if (observed !== manifestDigest) return check({ id: "installation-manifest", state: "blocked", receipt: "manifest=blocked; digest=mismatch; readOnly=true", recoveryAction: "Deploy the release whose installation manifest digest matches the customer Worker configuration, then rerun preflight.", observed: { configuredDigest: observed, manifestDigest } });
  return check({ id: "installation-manifest", state: "healthy", receipt: "manifest=verified; digest=pinned; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { configuredDigest: observed, manifestDigest } });
}

function bindingCheck(configuration: CustomerRealmWorkerConfiguration, env: CustomerRealmOperatorEnv): CustomerRealmOperatorCheck {
  const missing = [...configuration.missingBindings];
  const provider = env.ANYAM_PROVIDER_STATE?.trim();
  if (missing.length > 0) return check({ id: "binding-provider-reconciliation", state: "blocked", receipt: `bindings=blocked; missing=${missing.join(",")}; providerCalls=not-performed`, recoveryAction: `Bind the named customer-owned resources and retry preflight: ${missing.join(", ")}.`, observed: { missing: missing.join(","), providerState: "not-observed" } });
  if (provider === "expired-grant") return check({ id: "binding-provider-reconciliation", state: "blocked", receipt: "bindings=observed; provider=expired-grant; providerCalls=not-performed", recoveryAction: "Renew the customer provider grant, then rerun the same read-only preflight.", observed: { missing: null, providerState: provider } });
  if (provider === "outage") return check({ id: "binding-provider-reconciliation", state: "degraded", receipt: "bindings=observed; provider=outage; providerCalls=not-performed", recoveryAction: "Inspect the customer provider status and retry the same preflight when the provider is reachable.", observed: { missing: null, providerState: provider } });
  if (provider === "healthy") return check({ id: "binding-provider-reconciliation", state: "healthy", receipt: "bindings=observed; provider=healthy; providerCalls=not-performed", recoveryAction: "No recovery action is currently required.", observed: { missing: null, providerState: provider } });
  return check({ id: "binding-provider-reconciliation", state: "indeterminate", receipt: "bindings=observed; provider=reconciliation-not-observed; providerCalls=not-performed", recoveryAction: "Run the customer-operated provider read-only preflight and record its receipt without sending credentials to Anyam.", observed: { missing: null, providerState: "not-observed" } });
}

function providerAuthenticationCheck(env: CustomerRealmOperatorEnv): CustomerRealmOperatorCheck {
  const accountConfigured = Boolean(safeReference(env.ANYAM_PROVIDER_ACCOUNT_ID));
  const authorization = env.ANYAM_PROVIDER_AUTHORIZATION_STATE;
  if (authorization === "expired" || authorization === "revoked") return check({ id: "account-authentication", state: "blocked", receipt: "account=observed; authorization=expired; providerCalls=not-performed", recoveryAction: "Renew the customer provider authorization and rerun the same read-only preflight.", observed: { accountConfigured, authorizationState: "expired" } });
  if (authorization === "blocked") return check({ id: "account-authentication", state: "blocked", receipt: "account=observed; authorization=blocked; providerCalls=not-performed", recoveryAction: "Resolve the customer provider authorization denial before activating the installation.", observed: { accountConfigured, authorizationState: "blocked" } });
  if (!accountConfigured || authorization !== "verified") return check({ id: "account-authentication", state: "indeterminate", receipt: "account-authentication=not-observed; providerCalls=not-performed", recoveryAction: "Run the customer-owned account/authentication preflight and record only its account reference and authorization receipt.", observed: { accountConfigured, authorizationState: authorization ?? "not-observed" } });
  return check({ id: "account-authentication", state: "healthy", receipt: "account=observed; authorization=verified; providerCalls=not-performed", recoveryAction: "No recovery action is currently required.", observed: { accountConfigured: true, authorizationState: "verified" } });
}

function configurationDigestCheck(digestValue: string | null): CustomerRealmOperatorCheck {
  if (!digestValue) return check({ id: "configuration-digest", state: "indeterminate", receipt: "configurationDigest=not-observed; readOnly=true", recoveryAction: "Record the SHA-256 digest of the non-secret Worker configuration and rerun preflight.", observed: { configurationDigest: null } });
  return check({ id: "configuration-digest", state: "healthy", receipt: "configurationDigest=verified; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { configurationDigest: digestValue } });
}

function ownerCheck(identity: CustomerRealmOperatorIdentityObservation, states: ReturnType<typeof identityState>): CustomerRealmOperatorCheck {
  if (states.owner === "missing") return check({ id: "owner-recovery", state: "blocked", receipt: "owner=missing; recovery=not-evaluated; readOnly=true", recoveryAction: "Enroll and authenticate the customer-owned Realm owner passkey before activating the installation.", observed: { activeOwnerCount: identity.activeOwnerCount ?? null, passkeyCount: identity.passkeyCount ?? null } });
  if (states.recovery === "blocked") return check({ id: "owner-recovery", state: "blocked", receipt: "owner=verified; recovery=recovery-pending; readOnly=true", recoveryAction: "Complete the customer-controlled recovery activation ceremony before treating the Realm as active.", observed: { activeOwnerCount: identity.activeOwnerCount ?? null, passkeyCount: identity.passkeyCount ?? null } });
  if (states.owner === "verified" && states.recovery === "verified") return check({ id: "owner-recovery", state: "healthy", receipt: "owner=verified; recovery=active; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { activeOwnerCount: identity.activeOwnerCount ?? null, passkeyCount: identity.passkeyCount ?? null } });
  return check({ id: "owner-recovery", state: "indeterminate", receipt: "owner-recovery=not-observed; readOnly=true", recoveryAction: "Authenticate the owner and read the Durable Object identity status before treating the installation as active.", observed: { activeOwnerCount: identity.activeOwnerCount ?? null, passkeyCount: identity.passkeyCount ?? null } });
}

function releaseCheck(env: CustomerRealmOperatorEnv, digests: CustomerRealmOperatorStatus["digests"]): CustomerRealmOperatorCheck {
  if (env.ANYAM_RELEASE_STATE === "incompatible") return check({ id: "release", state: "blocked", receipt: "release=blocked; compatibility=incompatible; readOnly=true", recoveryAction: "Deploy a release compatible with the recorded installation manifest, then rerun preflight.", observed: { releaseDigest: digests.release, compatibility: "incompatible" } });
  if (env.ANYAM_RELEASE_STATE === "degraded") return check({ id: "release", state: "degraded", receipt: "release=degraded; compatibility=degraded; readOnly=true", recoveryAction: "Inspect the release receipt and keep the last known-good release active until the provider and binding state are reconciled.", observed: { releaseDigest: digests.release, compatibility: "degraded" } });
  if (!digests.release) return check({ id: "release", state: "indeterminate", receipt: "release=not-observed; digest=missing; readOnly=true", recoveryAction: "Record the immutable active release digest in the customer Worker and rerun preflight.", observed: { releaseDigest: null, compatibility: "not-observed" } });
  if (env.ANYAM_RELEASE_STATE !== "compatible") return check({ id: "release", state: "indeterminate", receipt: "release=digest-observed; compatibility=not-observed; readOnly=true", recoveryAction: "Verify the release against the installation manifest and record a compatibility receipt.", observed: { releaseDigest: digests.release, compatibility: "not-observed" } });
  return check({ id: "release", state: "healthy", receipt: "release=verified; compatibility=compatible; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { releaseDigest: digests.release, compatibility: "compatible" } });
}

function migrationCheck(env: CustomerRealmOperatorEnv, digests: CustomerRealmOperatorStatus["digests"]): CustomerRealmOperatorCheck {
  if (env.ANYAM_MIGRATION_STATE === "stale" || env.ANYAM_MIGRATION_STATE === "failed") return check({ id: "schema-migration", state: "blocked", receipt: `migration=blocked; state=${env.ANYAM_MIGRATION_STATE}; readOnly=true`, recoveryAction: "Reconcile the recorded migration checkpoint against the customer D1 and Durable Object state before activating a release.", observed: { schemaDigest: digests.schema, migrationDigest: digests.migration, migrationState: env.ANYAM_MIGRATION_STATE } });
  if (!digests.schema || !digests.migration) return check({ id: "schema-migration", state: "indeterminate", receipt: "migration=not-observed; digest=missing; readOnly=true", recoveryAction: "Record the immutable schema and migration digests, then rerun the read-only preflight.", observed: { schemaDigest: digests.schema, migrationDigest: digests.migration, migrationState: "not-observed" } });
  if (env.ANYAM_MIGRATION_STATE !== "current") return check({ id: "schema-migration", state: "indeterminate", receipt: "migration=digest-observed; state=not-observed; readOnly=true", recoveryAction: "Verify the applied migration set and record a current migration receipt before activation.", observed: { schemaDigest: digests.schema, migrationDigest: digests.migration, migrationState: "not-observed" } });
  return check({ id: "schema-migration", state: "healthy", receipt: "schema=verified; migration=current; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { schemaDigest: digests.schema, migrationDigest: digests.migration, migrationState: "current" } });
}

function policyCheck(env: CustomerRealmOperatorEnv): CustomerRealmOperatorCheck {
  const domain = env.ANYAM_DOMAIN_POLICY_STATE;
  const residency = env.ANYAM_RESIDENCY_POLICY_STATE;
  if (domain === "blocked" || residency === "blocked") return check({ id: "domain-residency-policy", state: "blocked", receipt: `policy=blocked; domain=${domain ?? "not-observed"}; residency=${residency ?? "not-observed"}; readOnly=true`, recoveryAction: "Resolve the named domain or residency policy decision in the customer account before activation.", observed: { domain: domain ?? "not-observed", residency: residency ?? "not-observed" } });
  if (domain === "degraded" || residency === "degraded") return check({ id: "domain-residency-policy", state: "degraded", receipt: `policy=degraded; domain=${domain ?? "not-observed"}; residency=${residency ?? "not-observed"}; readOnly=true`, recoveryAction: "Inspect the customer policy receipt and keep the installation in its last known-good mode until it is reconciled.", observed: { domain: domain ?? "not-observed", residency: residency ?? "not-observed" } });
  if (domain !== "verified" || residency !== "verified") return check({ id: "domain-residency-policy", state: "indeterminate", receipt: "policy=not-observed; domain-residency=indeterminate; readOnly=true", recoveryAction: "Run the customer-owned domain and residency policy preflight and record the result without claiming a provider guarantee.", observed: { domain: domain ?? "not-observed", residency: residency ?? "not-observed" } });
  return check({ id: "domain-residency-policy", state: "healthy", receipt: "policy=verified; domain-residency=verified; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { domain, residency } });
}

function exportCheck(env: CustomerRealmOperatorEnv, digests: CustomerRealmOperatorStatus["digests"]): CustomerRealmOperatorCheck {
  const destination = safeReference(env.ANYAM_EXPORT_DESTINATION);
  const exportDigest = safeDigest(env.ANYAM_LAST_EXPORT_DIGEST);
  const checkpointDigest = safeDigest(env.ANYAM_LAST_CHECKPOINT_DIGEST);
  const restore = env.ANYAM_RESTORE_DRILL_STATE;
  if (restore === "failed") return check({ id: "export-checkpoint", state: "degraded", receipt: "export=degraded; restoreDrill=failed; readOnly=true", recoveryAction: "Create and verify a new credential-free export/checkpoint before relying on recovery.", observed: { destinationConfigured: Boolean(destination), exportDigest, checkpointDigest, restoreDrill: restore } });
  if (!destination || !exportDigest || !checkpointDigest || restore !== "verified") return check({ id: "export-checkpoint", state: "indeterminate", receipt: "export=not-observed; checkpoint-or-restore=missing; readOnly=true", recoveryAction: "Record the customer-owned export destination, verified export/checkpoint digests, and restore-drill receipt.", observed: { destinationConfigured: Boolean(destination), exportDigest, checkpointDigest, restoreDrill: restore ?? "not-observed" } });
  return check({ id: "export-checkpoint", state: "healthy", receipt: "export=verified; checkpoint=verified; restoreDrill=verified; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { destinationConfigured: true, exportDigest, checkpointDigest, restoreDrill: restore } });
}

function pendingCheck(env: CustomerRealmOperatorEnv): CustomerRealmOperatorCheck {
  const state = env.ANYAM_PENDING_OPERATIONS_STATE;
  if (state === "stale") return check({ id: "pending-operations", state: "blocked", receipt: "pendingOperations=stale; readOnly=true", recoveryAction: "Reconcile the named pending operation from its durable checkpoint before accepting new protected work.", observed: { state } });
  if (state === "pending") return check({ id: "pending-operations", state: "degraded", receipt: "pendingOperations=pending; readOnly=true", recoveryAction: "Inspect and resume the pending operation from its checkpoint; do not create a second operation identity.", observed: { state } });
  if (state === "none") return check({ id: "pending-operations", state: "healthy", receipt: "pendingOperations=none; readOnly=true", recoveryAction: "No recovery action is currently required.", observed: { state } });
  return check({ id: "pending-operations", state: "indeterminate", receipt: "pendingOperations=not-observed; readOnly=true", recoveryAction: "Read the customer-owned operation ledger and record whether any pending operation remains.", observed: { state: "not-observed" } });
}

function operationsCheck(env: CustomerRealmOperatorEnv): { readonly readiness: ProductionOperationsReadiness; readonly check: CustomerRealmOperatorCheck } {
  try {
    const readiness = parseProductionOperationsLedger(env.ANYAM_OPERATIONS_LEDGER).evaluate();
    if (readiness.status === "ready") return { readiness, check: check({ id: "production-operations", state: "healthy", receipt: `${readiness.receipt}; readOnly=true`, recoveryAction: "No recovery action is currently required.", observed: { verified: readiness.verifiedKinds.length, required: readiness.requiredKinds.length } }) };
    const state: CustomerRealmOperatorStatusState = readiness.status === "blocked" ? "blocked" : "indeterminate";
    return { readiness, check: check({ id: "production-operations", state, receipt: `${readiness.receipt}; readOnly=true`, recoveryAction: readiness.recoveryAction, observed: { verified: readiness.verifiedKinds.length, required: readiness.requiredKinds.length, missing: readiness.missingKinds.length, failed: readiness.failedKinds.length, indeterminate: readiness.indeterminateKinds.length } }) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "production_operations_ledger_invalid";
    const empty = parseProductionOperationsLedger(undefined).evaluate();
    return {
      readiness: { ...empty, status: "blocked", recoveryAction: "Repair the customer-owned production-operation ledger and rerun the read-only control-room check.", receipt: `operations=blocked; ledger=invalid; detail=${detail}; credentialFree=true` },
      check: check({ id: "production-operations", state: "blocked", receipt: `operations=blocked; ledger=invalid; readOnly=true`, recoveryAction: "Repair the customer-owned production-operation ledger and rerun the read-only control-room check.", observed: { ledger: "invalid" } }),
    };
  }
}

export async function inspectCustomerRealmOperatorStatus(env: CustomerRealmOperatorEnv, identity: CustomerRealmOperatorIdentityObservation = {}): Promise<CustomerRealmOperatorStatus> {
  const configuration = inspectCustomerRealmWorkerConfiguration(env);
  const manifestDigest = await customerRealmInstallationManifestDigest();
  const states = identityState(identity);
  const digests = {
    release: safeDigest(env.ANYAM_RELEASE_DIGEST),
    schema: safeDigest(env.ANYAM_SCHEMA_DIGEST),
    migration: safeDigest(env.ANYAM_MIGRATION_DIGEST),
    configuration: safeDigest(env.ANYAM_CONFIGURATION_DIGEST),
  } as const;
  const operations = operationsCheck(env);
  const checks = [
    manifestCheck(env.ANYAM_INSTALLATION_MANIFEST_DIGEST, manifestDigest),
    configurationCheck(configuration),
    configurationDigestCheck(digests.configuration),
    providerAuthenticationCheck(env),
    bindingCheck(configuration, env),
    ownerCheck(identity, states),
    releaseCheck(env, digests),
    migrationCheck(env, digests),
    policyCheck(env),
    exportCheck(env, digests),
    pendingCheck(env),
    operations.check,
  ] as const;
  const status = aggregate(checks);
  return {
    protocol: CUSTOMER_REALM_OPERATOR_PROTOCOL,
    status,
    manifest: {
      protocol: CUSTOMER_REALM_INSTALLATION_MANIFEST_PROTOCOL,
      version: CUSTOMER_REALM_INSTALLATION_MANIFEST_VERSION,
      digest: manifestDigest,
      configuredDigest: safeDigest(env.ANYAM_INSTALLATION_MANIFEST_DIGEST),
      requiredBindings: [...CUSTOMER_REALM_REQUIRED_BINDINGS],
      requiredConfiguration: [...CUSTOMER_REALM_INSTALLATION_MANIFEST.requiredConfiguration],
    },
    installation: {
      installationId: safeReference(configuration.installationId),
      realmId: safeReference(identity.realmId),
      hostingMode: configuration.hostingMode === CUSTOMER_REALM_HOSTING_MODE ? CUSTOMER_REALM_HOSTING_MODE : null,
      protocolVersion: configuration.protocolVersion,
      buildRevision: safeReference(configuration.buildRevision),
      ownerState: states.owner,
      recoveryState: states.recovery,
      authorizationEpoch: Number.isInteger(identity.authorizationEpoch) && (identity.authorizationEpoch ?? -1) >= 0 ? identity.authorizationEpoch ?? null : null,
    },
    digests,
    bindings: {
      required: [...CUSTOMER_REALM_REQUIRED_BINDINGS],
      configured: configuration.bindings.filter((binding) => binding.configured).map((binding) => binding.name),
      missing: [...configuration.missingBindings],
      providerState: providerState(env.ANYAM_PROVIDER_STATE),
    },
    provider: {
      accountConfigured: Boolean(safeReference(env.ANYAM_PROVIDER_ACCOUNT_ID)),
      authorizationState: env.ANYAM_PROVIDER_AUTHORIZATION_STATE === "verified"
        ? "verified"
        : env.ANYAM_PROVIDER_AUTHORIZATION_STATE === "expired" || env.ANYAM_PROVIDER_AUTHORIZATION_STATE === "revoked"
          ? "expired"
          : env.ANYAM_PROVIDER_AUTHORIZATION_STATE === "blocked" ? "blocked" : "not-observed",
      state: env.ANYAM_PROVIDER_STATE === "healthy"
        ? "verified"
        : env.ANYAM_PROVIDER_STATE === "outage" ? "degraded"
          : env.ANYAM_PROVIDER_STATE === "expired-grant" ? "expired" : "not-observed",
    },
    pendingOperations: { state: pendingState(env.ANYAM_PENDING_OPERATIONS_STATE) },
    exportCheckpoint: {
      destinationConfigured: Boolean(safeReference(env.ANYAM_EXPORT_DESTINATION)),
      lastVerifiedExportDigest: safeDigest(env.ANYAM_LAST_EXPORT_DIGEST),
      lastVerifiedCheckpointDigest: safeDigest(env.ANYAM_LAST_CHECKPOINT_DIGEST),
      restoreDrillState: restoreState(env.ANYAM_RESTORE_DRILL_STATE),
    },
    operations: operations.readiness,
    checks,
    nextActions: uniqueActions(checks),
    credentialFree: true,
    canonicalWrite: false,
    credentialMinted: false,
    targetPromotion: "not-performed",
    receipt: `status=${status}; manifest=${manifestDigest}; readOnly=true; credentialFree=true; canonicalWrite=false; credentialMinted=false; targetPromotion=not-performed`,
  };
}

export async function customerRealmOperatorPreflight(env: CustomerRealmOperatorEnv, identity: CustomerRealmOperatorIdentityObservation = {}): Promise<CustomerRealmOperatorPreflight> {
  const status = await inspectCustomerRealmOperatorStatus(env, identity);
  return {
    ...status,
    protocol: CUSTOMER_REALM_OPERATOR_PREFLIGHT_PROTOCOL,
    operation: "read-only-preflight",
    sideEffects: {
      resourcesCreated: 0,
      secretsCreated: 0,
      canonicalWrite: false,
      credentialMinted: false,
      targetPromotion: "not-performed",
    },
    receipt: `${status.receipt}; providerCalls=not-performed; resourcesCreated=0; secretsCreated=0`,
  };
}
