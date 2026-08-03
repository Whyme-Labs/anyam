import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type Project,
  type ProjectExport,
  type SourceSpace,
} from "../kernel/contracts.ts";
import {
  isProjectExportCredentialFree,
  projectExportDigest,
  verifyProjectExportManifest,
} from "../portability/project-export.ts";
import {
  RealmIdentityPolicy,
  type RealmRecoverySnapshot,
} from "../identity/realm.ts";

export type CustomerRealmInstallationPhase =
  | "new"
  | "account-verifying"
  | "account-ready"
  | "provisioning"
  | "realm-ready"
  | "owner-ready"
  | "project-ready"
  | "importing"
  | "imported"
  | "active"
  | "degraded"
  | "blocked"
  | "recovery-pending";

export type CustomerRealmFailureKind =
  | "provider-outage"
  | "import-failure"
  | "queue-duplicate"
  | "workflow-stall"
  | "partial-mutation"
  | "restore-invalid"
  | "credential-revoked"
  | "unknown";

export type CustomerRealmProviderState = "unverified" | "provisioning" | "verified" | "degraded" | "recovery-pending";
export type CustomerRealmOperationStatus = "pending" | "succeeded" | "blocked" | "degraded";

export type CustomerAccountOwnership = {
  accountId: string;
  owner: "customer";
  billingOwner: "customer";
  sourceOwner: "customer";
  metadataOwner: "customer";
  artifactOwner: "customer";
  secretOwner: "customer";
  recoveryOwner: "customer";
  controlVerified: boolean;
  credentialsStored: false;
  verifiedAt?: string;
};

export type CustomerRealmResources = {
  owner: "customer";
  state: CustomerRealmProviderState;
  resourceIds: readonly string[];
  requestedResourceTypes: readonly string[];
  receipt: string;
};

export type CustomerRealmOwner = {
  principalId: string;
  passkeyCredentialId: string;
  recoveryEnrollmentId: string;
  recoveryMethod: "external-recovery-codes" | "hardware-key" | "enterprise-oidc";
  recoveryDigest?: string;
  recoveryEnrolled: true;
  materialStoredInInstallation: false;
  enrolledAt: string;
};

export type CustomerRealmProject = {
  projectId: string;
  sourceSpaceIds: readonly string[];
  metadataOwner: "customer";
  artifactOwner: "customer";
  secretOwner: "customer";
  state: "ready" | "importing" | "imported";
  projectRevisionId?: string;
  exportDigest?: string;
};

export type CustomerRealmImport = {
  provider: "github" | "gitlab" | "generic-git" | "project-export";
  source: string;
  operationId: string;
  idempotencyKey: string;
  state: CustomerRealmOperationStatus;
  checkpointId: string;
  sourceSpaceIds: readonly string[];
  partialEffects: readonly string[];
  projectRevisionId?: string;
  exportDigest?: string;
  recoveryAction: string;
  receipt: string;
};

export type CustomerRealmPendingCommand = {
  protocol: typeof CONTRACT_VERSIONS.command;
  commandId: string;
  operation: "account.inspect" | "realm.provision" | "project.import" | "realm.recover";
  operationId: string;
  idempotencyKey: string;
  expectedStateDigest: string;
  inputDigest: string;
  status: CustomerRealmOperationStatus;
  providerOperationId?: string;
  recoveryAction: string;
  receipt: string;
};

export type CustomerRealmCheckpoint = {
  protocol: typeof CONTRACT_VERSIONS.recovery;
  checkpointId: string;
  phase: CustomerRealmInstallationPhase;
  stateDigest: string;
  completedSteps: readonly string[];
  partialEffects: readonly string[];
  pendingCommandIds: readonly string[];
  receipt: string;
};

export type CustomerRealmDegradedState = {
  kind: CustomerRealmFailureKind;
  operation: CustomerRealmPendingCommand["operation"];
  dependency: string;
  reason: string;
  checkpointId: string;
  partialEffects: readonly string[];
  retryable: boolean;
  safeRecoveryAction: string;
  receipt: string;
};

export type CustomerRealmAuditEvent = {
  protocol: typeof CONTRACT_VERSIONS.audit;
  id: string;
  installationId: string;
  occurredAt: string;
  phase: CustomerRealmInstallationPhase;
  eventType: string;
  outcome: "succeeded" | "blocked" | "degraded" | "observed";
  operationId?: string;
  principalId?: string;
  projectId?: string;
  checkpointId?: string;
  details: Readonly<Record<string, unknown>>;
};

export type CustomerRealmInstallationState = {
  protocol: typeof CONTRACT_VERSIONS.installation;
  version: "v1";
  installationId: string;
  hostingMode: "customer-operated";
  revision: number;
  phase: CustomerRealmInstallationPhase;
  /** The customer account identifier is safe recovery metadata, never a credential. */
  accountId?: string | undefined;
  account?: CustomerAccountOwnership;
  resources?: CustomerRealmResources | undefined;
  realmId?: string;
  owner?: CustomerRealmOwner;
  project?: CustomerRealmProject;
  import?: CustomerRealmImport;
  realmSnapshot?: RealmRecoverySnapshot | undefined;
  pendingCommands: readonly CustomerRealmPendingCommand[];
  checkpoint: CustomerRealmCheckpoint;
  degraded?: CustomerRealmDegradedState | undefined;
  audit: readonly CustomerRealmAuditEvent[];
};

export type CustomerRealmRecoveryBundle = {
  protocol: typeof CONTRACT_VERSIONS.recovery;
  version: "v1";
  bundleId: string;
  createdAt: string;
  installationId: string;
  hostingMode: "customer-operated";
  state: CustomerRealmInstallationState;
  realmSnapshot: RealmRecoverySnapshot;
  projectExport?: ProjectExport;
  pendingCommands: readonly CustomerRealmPendingCommand[];
  audit: readonly CustomerRealmAuditEvent[];
  integrity: {
    digest: string;
    credentialFree: true;
    receipt: string;
  };
};

export type CustomerRealmRecoveryVerification = {
  status: "verified" | "failed";
  errors: readonly string[];
  recoveryAction: string;
  receipt: string;
};

export type CustomerRealmProviderSuccess<T> = {
  status: "succeeded";
  operationId: string;
  value: T;
  receipt: string;
};

export type CustomerRealmProviderFailure = {
  status: "failed";
  errorCode: string;
  message: string;
  retryable: boolean;
  failureKind: CustomerRealmFailureKind;
  affectedObject: string;
  operationId: string;
  providerOperationId?: string;
  partialEffects: readonly string[];
  recoveryAction: string;
  receipt: string;
};

export type CustomerRealmProviderResult<T> = CustomerRealmProviderSuccess<T> | CustomerRealmProviderFailure;

export type CustomerRealmAccountInspection = {
  accountId: string;
  owner: "customer";
  billingOwner: "customer";
  controlVerified: true;
  receipt: string;
};

export type CustomerRealmProvisionReceipt = {
  accountId: string;
  owner: "customer";
  resourceIds: readonly string[];
  requestedResourceTypes: readonly string[];
  state: "verified";
  receipt: string;
};

export type CustomerRealmImportReceipt = {
  projectRevisionId: string;
  sourceSpaceIds: readonly string[];
  exportDigest: string;
  checkpointId: string;
  state: "verified";
  partialEffects: readonly string[];
  receipt: string;
};

export type CustomerRealmCloudflareAdapter = {
  inspectAccount(input: { accountId: string; operationId: string }): Promise<CustomerRealmProviderResult<CustomerRealmAccountInspection>>;
  provisionRealm(input: { accountId: string; installationId: string; operationId: string; idempotencyKey: string; requestedResourceTypes: readonly string[] }): Promise<CustomerRealmProviderResult<CustomerRealmProvisionReceipt>>;
  inspectProvision(input: { accountId: string; installationId: string; operationId: string; resourceIds: readonly string[] }): Promise<CustomerRealmProviderResult<CustomerRealmProvisionReceipt>>;
};

export type CustomerRealmProjectImporter = {
  startImport(input: { installationId: string; project: CustomerRealmProject; provider: CustomerRealmImport["provider"]; source: string; operationId: string; idempotencyKey: string }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>>;
  resumeImport(input: { installationId: string; project: CustomerRealmProject; import: CustomerRealmImport }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>>;
};

export type CustomerRealmInstallationStore = {
  load(installationId: string): Promise<CustomerRealmInstallationState | undefined>;
  save(state: CustomerRealmInstallationState): Promise<void>;
  /**
   * Persist a state transition only when the store still has the expected
   * checkpoint digest. Implementations may omit this method while the
   * installation remains compatible with the original save-only boundary.
   */
  saveIfCurrent?(state: CustomerRealmInstallationState, expectedStateDigest?: string): Promise<void>;
};

export class CustomerRealmInstallationError extends Error {
  readonly code: "invalid_transition" | "invalid_input" | "ownership_required" | "idempotency_conflict" | "blocked" | "recovery_invalid" | "provider_failure";
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly checkpointId: string | undefined;

  constructor(input: { code: CustomerRealmInstallationError["code"]; message: string; recoveryAction: string; receipt: string; checkpointId?: string }) {
    super(input.message);
    this.name = "CustomerRealmInstallationError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    this.checkpointId = input.checkpointId;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      recoveryAction: this.recoveryAction,
      receipt: this.receipt,
      ...(this.checkpointId ? { checkpointId: this.checkpointId } : {}),
    };
  }
}

export class InMemoryCustomerRealmInstallationStore implements CustomerRealmInstallationStore {
  private readonly states = new Map<string, CustomerRealmInstallationState>();

  async load(installationId: string): Promise<CustomerRealmInstallationState | undefined> {
    const state = this.states.get(installationId);
    return state ? clone(state) : undefined;
  }

  async save(state: CustomerRealmInstallationState): Promise<void> {
    this.states.set(state.installationId, clone(state));
  }

  async saveIfCurrent(state: CustomerRealmInstallationState, expectedStateDigest?: string): Promise<void> {
    const current = this.states.get(state.installationId);
    const actualStateDigest = current?.checkpoint.stateDigest;
    if (actualStateDigest !== expectedStateDigest) {
      throw new Error(`stale customer Realm installation state: expected=${expectedStateDigest ?? "absent"}; actual=${actualStateDigest ?? "absent"}`);
    }
    this.states.set(state.installationId, clone(state));
  }
}

export class InMemoryCustomerRealmCloudflareAdapter implements CustomerRealmCloudflareAdapter {
  private readonly accounts = new Set<string>();
  private readonly provisions = new Map<string, CustomerRealmProvisionReceipt>();

  constructor(accounts: readonly string[] = ["account:test"]) {
    for (const accountId of accounts) {
      this.accounts.add(accountId);
    }
  }

  async inspectAccount(input: { accountId: string; operationId: string }): Promise<CustomerRealmProviderResult<CustomerRealmAccountInspection>> {
    if (!this.accounts.has(input.accountId)) return failure("cloudflare.account_not_found", "provider-outage", input.accountId, input.operationId, true, [], "connect a customer-owned Cloudflare account and retry", `account=${input.accountId}; known=false`);
    return success(input.operationId, { accountId: input.accountId, owner: "customer", billingOwner: "customer", controlVerified: true, receipt: `account=${input.accountId}; control=verified; owner=customer` }, `account=${input.accountId}; control=verified`);
  }

  async provisionRealm(input: { accountId: string; installationId: string; operationId: string; idempotencyKey: string; requestedResourceTypes: readonly string[] }): Promise<CustomerRealmProviderResult<CustomerRealmProvisionReceipt>> {
    if (!this.accounts.has(input.accountId)) return failure("cloudflare.account_not_found", "provider-outage", input.accountId, input.operationId, true, [], "connect a customer-owned Cloudflare account and retry", `account=${input.accountId}; known=false`);
    const key = `${input.accountId}:${input.installationId}`;
    const existing = this.provisions.get(key);
    if (existing && existing.requestedResourceTypes.join("|") === input.requestedResourceTypes.join("|")) return success(input.operationId, { ...existing, state: "verified" }, `${existing.receipt}; idempotent=true`);
    const resourceIds = input.requestedResourceTypes.map((resourceType) => `${input.installationId}:${resourceType}`);
    const receipt: CustomerRealmProvisionReceipt = { accountId: input.accountId, owner: "customer", resourceIds, requestedResourceTypes: [...input.requestedResourceTypes], state: "verified", receipt: `account=${input.accountId}; installation=${input.installationId}; resources=${resourceIds.join(",")}; owner=customer` };
    this.provisions.set(key, receipt);
    return success(input.operationId, receipt, receipt.receipt);
  }

  async inspectProvision(input: { accountId: string; installationId: string; operationId: string; resourceIds: readonly string[] }): Promise<CustomerRealmProviderResult<CustomerRealmProvisionReceipt>> {
    const existing = this.provisions.get(`${input.accountId}:${input.installationId}`);
    if (!existing || existing.resourceIds.some((resourceId) => !input.resourceIds.includes(resourceId))) return failure("cloudflare.provision_incomplete", "partial-mutation", input.installationId, input.operationId, true, existing?.resourceIds ?? [], "inspect the customer account, then resume the same provisioning operation", `account=${input.accountId}; expected=${input.resourceIds.length}; actual=${existing?.resourceIds.length ?? 0}`);
    return success(input.operationId, { ...existing, state: "verified" }, `account=${input.accountId}; installation=${input.installationId}; resources=verified`);
  }
}

export class InMemoryCustomerRealmProjectImporter implements CustomerRealmProjectImporter {
  constructor(private readonly importReceipt: CustomerRealmImportReceipt) {}

  async startImport(input: { installationId: string; project: CustomerRealmProject; provider: CustomerRealmImport["provider"]; source: string; operationId: string; idempotencyKey: string }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>> {
    return success(input.operationId, this.importReceipt, `installation=${input.installationId}; source=${input.source}; import=${this.importReceipt.projectRevisionId}`);
  }

  async resumeImport(input: { installationId: string; project: CustomerRealmProject; import: CustomerRealmImport }): Promise<CustomerRealmProviderResult<CustomerRealmImportReceipt>> {
    return success(input.import.operationId, this.importReceipt, `installation=${input.installationId}; resumed=${input.import.checkpointId}; import=${this.importReceipt.projectRevisionId}`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function success<T>(operationId: string, value: T, receipt: string): CustomerRealmProviderSuccess<T> {
  return { status: "succeeded", operationId, value, receipt };
}

function failure(errorCode: string, failureKind: CustomerRealmFailureKind, affectedObject: string, operationId: string, retryable: boolean, partialEffects: readonly string[], recoveryAction: string, receipt: string): CustomerRealmProviderFailure {
  return { status: "failed", errorCode, message: `Customer Realm provider operation ${operationId} failed for ${affectedObject}.`, retryable, failureKind, affectedObject, operationId, partialEffects: [...partialEffects], recoveryAction, receipt };
}

function initialCheckpoint(state: Omit<CustomerRealmInstallationState, "checkpoint">): CustomerRealmCheckpoint {
  const provisional: CustomerRealmCheckpoint = {
    protocol: CONTRACT_VERSIONS.recovery,
    checkpointId: `checkpoint:${state.phase}:${digest(`${state.installationId}:${state.revision}:${state.phase}`)}`,
    phase: state.phase,
    stateDigest: "pending",
    completedSteps: [],
    partialEffects: [],
    pendingCommandIds: [],
    receipt: `installation=${state.installationId}; phase=${state.phase}`,
  };
  const currentDigest = stateDigest({ ...state, checkpoint: provisional });
  return { ...provisional, stateDigest: currentDigest, receipt: `${provisional.receipt}; stateDigest=${currentDigest}` };
}

function stateDigest(state: CustomerRealmInstallationState): string {
  return digest({ ...state, checkpoint: { ...state.checkpoint, stateDigest: "pending", receipt: "pending" } });
}

function checkpointFor(state: Omit<CustomerRealmInstallationState, "checkpoint">, previous: CustomerRealmCheckpoint, completedSteps: readonly string[], partialEffects: readonly string[], pendingCommandIds: readonly string[]): CustomerRealmCheckpoint {
  const checkpointId = `checkpoint:${state.phase}:${digest(`${state.installationId}:${state.revision}:${state.phase}:${previous.checkpointId}`)}`;
  const provisional: CustomerRealmInstallationState = {
    ...state,
    checkpoint: {
      protocol: CONTRACT_VERSIONS.recovery,
      checkpointId,
      phase: state.phase,
      stateDigest: "pending",
      completedSteps: [...completedSteps],
      partialEffects: [...partialEffects],
      pendingCommandIds: [...pendingCommandIds],
      receipt: `installation=${state.installationId}; phase=${state.phase}; checkpoint=${checkpointId}`,
    },
  };
  const currentDigest = stateDigest(provisional);
  return { ...provisional.checkpoint, stateDigest: currentDigest, receipt: `${provisional.checkpoint.receipt}; stateDigest=${currentDigest}` };
}

function initialState(installationId: string, now: () => Date): CustomerRealmInstallationState {
  const state: Omit<CustomerRealmInstallationState, "checkpoint"> = {
    protocol: CONTRACT_VERSIONS.installation,
    version: "v1",
    installationId,
    hostingMode: "customer-operated",
    revision: 0,
    phase: "new",
    pendingCommands: [],
    audit: [],
  };
  const checkpoint = initialCheckpoint(state);
  return {
    ...state,
    checkpoint: { ...checkpoint, receipt: `${checkpoint.receipt}; createdAt=${nowIso(now)}` },
  };
}

function customerOwnershipValid(account: CustomerAccountOwnership): boolean {
  return account.owner === "customer" && account.billingOwner === "customer" && account.sourceOwner === "customer" && account.metadataOwner === "customer" && account.artifactOwner === "customer" && account.secretOwner === "customer" && account.recoveryOwner === "customer" && account.controlVerified && account.credentialsStored === false;
}

function validateSourceSpaces(project: Project, sourceSpaces: readonly SourceSpace[]): readonly string[] {
  const projectIds = new Set(project.sourceSpaceIds);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const sourceSpace of sourceSpaces) {
    if (!projectIds.has(sourceSpace.id)) problems.push(`Source Space ${sourceSpace.id} is not declared by Project ${project.id}`);
    if (seen.has(sourceSpace.id)) problems.push(`Source Space ${sourceSpace.id} is duplicated`);
    seen.add(sourceSpace.id);
  }
  for (const id of project.sourceSpaceIds) if (!seen.has(id)) problems.push(`Project Source Space ${id} has no policy catalog entry`);
  return problems;
}

export function customerRealmRecoveryBundleDigest(bundle: Omit<CustomerRealmRecoveryBundle, "integrity"> | CustomerRealmRecoveryBundle): string {
  const withoutIntegrity = "integrity" in bundle ? (() => {
    const { integrity: _integrity, ...rest } = bundle;
    return rest;
  })() : bundle;
  return digest(withoutIntegrity);
}

function recoveryBundleDigest(bundle: Omit<CustomerRealmRecoveryBundle, "integrity">): string {
  return customerRealmRecoveryBundleDigest(bundle);
}

export function verifyCustomerRealmRecoveryBundle(bundle: CustomerRealmRecoveryBundle): CustomerRealmRecoveryVerification {
  const errors: string[] = [];
  if (bundle.protocol !== CONTRACT_VERSIONS.recovery || bundle.version !== "v1") errors.push("recovery protocol or version is unsupported");
  if (bundle.hostingMode !== "customer-operated") errors.push("recovery bundle is not for a customer-operated Realm");
  if (bundle.state.installationId !== bundle.installationId) errors.push("installation identity does not match the saved state");
  if (!bundle.state.realmId || bundle.state.realmId !== bundle.realmSnapshot.realm.id) errors.push("Realm identity is missing or does not match the Realm snapshot");
  if (!bundle.state.realmSnapshot || digest(bundle.state.realmSnapshot) !== digest(bundle.realmSnapshot)) errors.push("installation and recovery Realm snapshots do not match");
  if (bundle.integrity.credentialFree !== true || bundle.realmSnapshot.credentialFree !== true) errors.push("recovery bundle is not explicitly credential-free");
  const serialized = JSON.stringify(bundle);
  if (/(?:\"token|\"password|\"secret|\"credentials|\"credential)\"\s*:/i.test(serialized)) errors.push("recovery bundle contains credential material");
  if (!bundle.state.account || !customerOwnershipValid(bundle.state.account)) errors.push("customer ownership or account credential boundary is invalid");
  if (!bundle.state.resources || bundle.state.resources.owner !== "customer" || bundle.state.resources.state === "verified" && bundle.state.resources.resourceIds.length === 0) errors.push("customer resource ownership or verification receipt is invalid");
  if (bundle.state.checkpoint.stateDigest !== stateDigest(bundle.state)) errors.push("installation Recovery Checkpoint digest does not match its state");
  if (digest(bundle.state.pendingCommands) !== digest(bundle.pendingCommands)) errors.push("pending command list does not match installation state");
  if (digest(bundle.state.audit) !== digest(bundle.audit)) errors.push("installation audit list does not match installation state");
  if ("credentials" in (bundle.realmSnapshot as unknown as Record<string, unknown>)) errors.push("Realm recovery snapshot contains a credentials collection");
  if (bundle.projectExport) {
    const verification = verifyProjectExportManifest(bundle.projectExport);
    if (verification.status !== "succeeded") errors.push(`Project Export verification failed: ${verification.errorCode}`);
    if (!isProjectExportCredentialFree(bundle.projectExport)) errors.push("Project Export is not credential-free");
    if (bundle.state.project && bundle.projectExport.project.id !== bundle.state.project.projectId) errors.push("Project Export identity does not match installation state");
    if (bundle.state.project && bundle.projectExport.project.sourceSpaceIds.join("|") !== bundle.state.project.sourceSpaceIds.join("|")) errors.push("Project Export Source Spaces do not match installation state");
    if (bundle.state.project && bundle.projectExport.projectRevisions.length === 0) errors.push("Project Export has no Project Revision lineage to restore");
    if (projectExportDigest(bundle.projectExport) !== bundle.state.project?.exportDigest && bundle.state.project?.exportDigest !== undefined) errors.push("Project Export digest does not match installation state");
  }
  const commandIds = new Set<string>();
  const operationKeys = new Set<string>();
  for (const command of bundle.pendingCommands) {
    if (commandIds.has(command.commandId)) errors.push(`pending command ${command.commandId} is duplicated`);
    if (operationKeys.has(`${command.operation}:${command.idempotencyKey}`)) errors.push(`pending operation ${command.operation} reuses an idempotency key`);
    commandIds.add(command.commandId);
    operationKeys.add(`${command.operation}:${command.idempotencyKey}`);
  }
  const auditIds = new Set<string>();
  for (const event of bundle.audit) {
    if (auditIds.has(event.id)) errors.push(`installation audit event ${event.id} is duplicated`);
    auditIds.add(event.id);
  }
  const principalIds = new Set(Object.keys(bundle.realmSnapshot.principals));
  const sessionIds = new Set(Object.keys(bundle.realmSnapshot.sessions));
  const taskIds = new Set(Object.keys(bundle.realmSnapshot.tasks));
  for (const grant of Object.values(bundle.realmSnapshot.grants)) {
    if (grant.realmId !== bundle.realmSnapshot.realm.id) errors.push(`Grant ${grant.id} belongs to another Realm`);
    if (!principalIds.has(grant.principalId) || !sessionIds.has(grant.sessionId) || !taskIds.has(grant.taskId)) errors.push(`Grant ${grant.id} has an incomplete Principal/Session/Task chain`);
  }
  const { integrity, ...withoutIntegrity } = bundle;
  if (integrity.digest !== recoveryBundleDigest(withoutIntegrity)) errors.push("recovery bundle digest does not match its contents");
  return {
    status: errors.length === 0 ? "verified" : "failed",
    errors,
    recoveryAction: errors.length === 0 ? "restore into a quarantined customer installation, reconcile provider resources, then require owner activation" : "repair the named export, ownership, identity, or pending-command inconsistency and rerun recovery verification",
    receipt: `bundle=${bundle.bundleId}; credentialFree=${bundle.integrity.credentialFree}; errors=${errors.length}`,
  };
}

export class CustomerRealmInstallation {
  private state: CustomerRealmInstallationState;
  private identity: RealmIdentityPolicy | undefined;
  private readonly now: () => Date;

  private persistedState: boolean;

  constructor(private readonly input: { installationId: string; cloudflare: CustomerRealmCloudflareAdapter; importer: CustomerRealmProjectImporter; store?: CustomerRealmInstallationStore; now?: () => Date; realmId?: string; state?: CustomerRealmInstallationState; persistedState?: boolean }) {
    this.now = input.now ?? (() => new Date());
    this.state = clone(input.state ?? initialState(input.installationId, this.now));
    this.persistedState = input.persistedState ?? input.state !== undefined;
    if (this.state.realmSnapshot && this.state.realmId) {
      this.identity = new RealmIdentityPolicy({ realmId: this.state.realmId, now: this.now });
      this.identity.restoreOperationalSnapshot(this.state.realmSnapshot);
    }
  }

  static async open(input: Omit<NonNullable<ConstructorParameters<typeof CustomerRealmInstallation>[0]>, "state">): Promise<CustomerRealmInstallation> {
    const state = await input.store?.load(input.installationId);
    return new CustomerRealmInstallation({ ...input, ...(state ? { state, persistedState: true } : { persistedState: false }) });
  }

  get snapshot(): CustomerRealmInstallationState {
    return clone(this.state);
  }

  get realmPolicy(): RealmIdentityPolicy | undefined {
    return this.identity;
  }

  async install(input: { accountId: string; requestedResourceTypes: readonly string[]; ownerConfirmed: boolean; operationId?: string; idempotencyKey?: string }): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["new"], "install");
    if (!input.ownerConfirmed) throw new CustomerRealmInstallationError({ code: "ownership_required", message: "Customer-operated installation requires explicit confirmation that the account, billing, source, metadata, artifacts, secrets, and recovery material remain customer-owned.", recoveryAction: "confirm customer account ownership before provisioning", receipt: "ownerConfirmed=true required" });
    if (input.requestedResourceTypes.length === 0) throw new CustomerRealmInstallationError({ code: "invalid_input", message: "Customer-operated installation requires an explicit resource plan.", recoveryAction: "choose the Cloudflare bindings the customer account will own, then retry", receipt: "requestedResourceTypes must not be empty" });
    const operationId = input.operationId ?? opaqueId("install-account");
    const idempotencyKey = input.idempotencyKey ?? operationId;
    const accountCommand: CustomerRealmPendingCommand = { protocol: CONTRACT_VERSIONS.command, commandId: opaqueId("command"), operation: "account.inspect", operationId, idempotencyKey: `${idempotencyKey}:account`, expectedStateDigest: this.state.checkpoint.stateDigest, inputDigest: digest({ accountId: input.accountId, operation: "account.inspect" }), status: "pending", recoveryAction: "reinspect the customer-controlled Cloudflare account using the same operation", receipt: `account=${input.accountId}; inspection=pending` };
    const realmProvisionCommand: CustomerRealmPendingCommand = { protocol: CONTRACT_VERSIONS.command, commandId: opaqueId("command"), operation: "realm.provision", operationId, idempotencyKey: `${idempotencyKey}:provision`, expectedStateDigest: this.state.checkpoint.stateDigest, inputDigest: digest({ accountId: input.accountId, requestedResourceTypes: input.requestedResourceTypes, operation: "realm.provision" }), status: "pending", recoveryAction: "inspect or resume the same customer-owned provisioning operation", receipt: `account=${input.accountId}; resources=${input.requestedResourceTypes.join(",")}; provisioning=pending` };
    const plannedResources: CustomerRealmResources = { owner: "customer", state: "provisioning", resourceIds: [], requestedResourceTypes: [...input.requestedResourceTypes], receipt: `account=${input.accountId}; resources=planned; credentials=none` };
    await this.transition("account-verifying", "account.verification.started", { operationId, details: { accountId: input.accountId, ownership: "customer", credentialsStored: false } }, { accountId: input.accountId, resources: plannedResources, pendingCommands: [accountCommand, realmProvisionCommand] });
    const inspection = await this.input.cloudflare.inspectAccount({ accountId: input.accountId, operationId });
    if (inspection.status !== "succeeded") return this.recordProviderFailure("account.inspect", inspection);
    if (inspection.value.accountId !== input.accountId || inspection.value.owner !== "customer" || inspection.value.billingOwner !== "customer" || !inspection.value.controlVerified) return this.recordProviderFailure("account.inspect", failure("cloudflare.account_ownership_unverified", "unknown", input.accountId, operationId, false, [], "use an account the customer controls and rerun account verification", inspection.value.receipt));
    const account: CustomerAccountOwnership = { accountId: input.accountId, owner: "customer", billingOwner: "customer", sourceOwner: "customer", metadataOwner: "customer", artifactOwner: "customer", secretOwner: "customer", recoveryOwner: "customer", controlVerified: true, credentialsStored: false, verifiedAt: nowIso(this.now) };
    const accountVerifiedCommands = this.state.pendingCommands.map((command) => command.operation === "account.inspect" ? { ...command, status: "succeeded" as const, providerOperationId: inspection.operationId, receipt: inspection.value.receipt } : command);
    await this.transition("account-ready", "account.verified", { operationId, details: { accountId: input.accountId, receipt: inspection.value.receipt } }, { account, pendingCommands: accountVerifiedCommands });
    await this.transition("provisioning", "realm.provisioning.started", { operationId, details: { requestedResourceTypes: input.requestedResourceTypes } }, { resources: { ...plannedResources, state: "provisioning" }, pendingCommands: accountVerifiedCommands, degraded: undefined });
    const provisionCommand = this.state.pendingCommands.find((command) => command.operation === "realm.provision" && command.operationId === operationId);
    if (!provisionCommand) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Provisioning command was not persisted before the provider call.", recoveryAction: "restore the installation checkpoint and retry with the same operation", receipt: `operation=${operationId}` });
    const provision = await this.input.cloudflare.provisionRealm({ accountId: input.accountId, installationId: this.state.installationId, operationId, idempotencyKey: provisionCommand.idempotencyKey, requestedResourceTypes: input.requestedResourceTypes });
    if (provision.status !== "succeeded") return this.recordProviderFailure("realm.provision", provision);
    return this.finishProvisioning(input.accountId, input.requestedResourceTypes, provision.value, operationId);
  }

  async enrollOwner(input: { displayName: string; passkeyCredentialId: string; passkeyVerified: boolean; recovery: { method: CustomerRealmOwner["recoveryMethod"]; enrollmentReceipt: string; materialDigest?: string }; principalId?: string }): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["realm-ready"], "owner.enroll");
    if (!input.passkeyVerified || !input.passkeyCredentialId.trim()) throw new CustomerRealmInstallationError({ code: "invalid_input", message: "The first Realm owner must complete a verified passkey enrollment; no default administrator was created.", recoveryAction: "complete passkey enrollment through the customer-controlled Realm origin and retry", receipt: "passkeyVerified=true and credential ID required" });
    if (!input.recovery.enrollmentReceipt.trim()) throw new CustomerRealmInstallationError({ code: "invalid_input", message: "Recovery enrollment requires an owner-visible external receipt; recovery material is never stored in the installation.", recoveryAction: "enroll recovery codes, a hardware key, or the approved enterprise identity path and provide its receipt", receipt: "recovery enrollment receipt required" });
    if (!this.identity || !this.state.realmId) throw new CustomerRealmInstallationError({ code: "blocked", message: "Realm identity policy is not available after provisioning.", recoveryAction: "resume or restore the verified provisioning checkpoint", receipt: "realm policy missing" });
    const principal = this.identity.createPrincipal(input.principalId ? { id: input.principalId, displayName: input.displayName } : { displayName: input.displayName });
    this.identity.registerPasskey({ principalId: principal.id, credentialId: input.passkeyCredentialId });
    this.identity.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id, role: "owner", resource: { realmId: this.state.realmId } });
    const owner: CustomerRealmOwner = {
      principalId: principal.id,
      passkeyCredentialId: input.passkeyCredentialId,
      recoveryEnrollmentId: opaqueId("recovery-enrollment"),
      recoveryMethod: input.recovery.method,
      ...(input.recovery.materialDigest ? { recoveryDigest: input.recovery.materialDigest } : {}),
      recoveryEnrolled: true,
      materialStoredInInstallation: false,
      enrolledAt: nowIso(this.now),
    };
    await this.transition("owner-ready", "realm.owner.enrolled", { principalId: principal.id, details: { passkeyCredentialId: input.passkeyCredentialId, recoveryEnrollmentId: owner.recoveryEnrollmentId, recoveryMethod: owner.recoveryMethod, materialStoredInInstallation: false } }, { owner });
    return this.snapshot;
  }

  async createProject(input: { project: Project; sourceSpaces: readonly SourceSpace[] }): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["owner-ready"], "project.create");
    if (!this.state.owner?.recoveryEnrolled) throw new CustomerRealmInstallationError({ code: "blocked", message: "Project creation is blocked until Realm owner recovery is enrolled.", recoveryAction: "enroll and verify the first owner recovery method, then retry", receipt: "owner.recoveryEnrolled=true required" });
    const problems = validateSourceSpaces(input.project, input.sourceSpaces);
    if (problems.length > 0) throw new CustomerRealmInstallationError({ code: "invalid_input", message: `Project Source Space catalog is invalid: ${problems.join("; ")}.`, recoveryAction: "declare each Project Source Space exactly once and retry", receipt: `project=${input.project.id}; problems=${problems.length}` });
    const project: CustomerRealmProject = { projectId: input.project.id, sourceSpaceIds: [...input.project.sourceSpaceIds], metadataOwner: "customer", artifactOwner: "customer", secretOwner: "customer", state: "ready" };
    await this.transition("project-ready", "project.created", { projectId: project.projectId, details: { sourceSpaceIds: project.sourceSpaceIds, metadataOwner: "customer", artifactOwner: "customer", secretOwner: "customer" } }, { project });
    return this.snapshot;
  }

  async importProject(input: { provider: CustomerRealmImport["provider"]; source: string; operationId: string; idempotencyKey: string }): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["project-ready"], "project.import");
    if (!input.operationId.trim() || !input.idempotencyKey.trim() || !input.source.trim()) throw new CustomerRealmInstallationError({ code: "invalid_input", message: "Project import requires a source, operation ID, and idempotency key.", recoveryAction: "provide stable import identity and retry", receipt: "source, operationId, and idempotencyKey required" });
    const existing = this.state.pendingCommands.find((command) => command.operation === "project.import" && command.idempotencyKey === input.idempotencyKey);
    if (existing && (this.state.import?.operationId !== input.operationId || this.state.import.source !== input.source)) throw new CustomerRealmInstallationError({ code: "idempotency_conflict", message: "Project import idempotency key is already bound to different source input.", recoveryAction: "reuse the original source and operation or choose a new idempotency key", receipt: `existingCommand=${existing.commandId}; requestedOperation=${input.operationId}` });
    const project = this.requireProject();
    const importRecord: CustomerRealmImport = { provider: input.provider, source: input.source, operationId: input.operationId, idempotencyKey: input.idempotencyKey, state: "pending", checkpointId: this.state.checkpoint.checkpointId, sourceSpaceIds: project.sourceSpaceIds, partialEffects: [], recoveryAction: "resume the same import operation after verifying the checkpoint", receipt: `project=${project.projectId}; source=${input.source}` };
    const command: CustomerRealmPendingCommand = { protocol: CONTRACT_VERSIONS.command, commandId: opaqueId("command"), operation: "project.import", operationId: input.operationId, idempotencyKey: input.idempotencyKey, expectedStateDigest: this.state.checkpoint.stateDigest, inputDigest: digest({ project, ...input }), status: "pending", recoveryAction: importRecord.recoveryAction, receipt: importRecord.receipt };
    await this.transition("importing", "project.import.started", { operationId: input.operationId, projectId: project.projectId, details: { provider: input.provider, source: input.source, idempotencyKey: input.idempotencyKey } }, { import: importRecord, pendingCommands: [...this.state.pendingCommands, command], project: { ...project, state: "importing" } });
    const result = await this.input.importer.startImport({ installationId: this.state.installationId, project: this.requireProject(), provider: input.provider, source: input.source, operationId: input.operationId, idempotencyKey: input.idempotencyKey });
    if (result.status !== "succeeded") return this.recordProviderFailure("project.import", result);
    return this.finishImport(result.value, result.operationId);
  }

  async recover(): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["degraded", "blocked"], "recovery.resume");
    const degraded = this.state.degraded;
    if (!degraded) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Installation is marked degraded without a recovery record.", recoveryAction: "restore from a verified customer recovery bundle", receipt: "degraded state missing" });
    if (!degraded.retryable) throw new CustomerRealmInstallationError({ code: "blocked", message: `Automatic recovery is blocked for ${degraded.operation}: ${degraded.reason}.`, recoveryAction: degraded.safeRecoveryAction, receipt: degraded.receipt, checkpointId: degraded.checkpointId });
    if (degraded.operation === "account.inspect") {
      const accountId = this.state.accountId;
      const accountCommand = this.state.pendingCommands.find((command) => command.operation === "account.inspect" && (command.status === "pending" || command.status === "degraded" || command.status === "blocked"));
      if (!accountId || !accountCommand) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Account verification recovery has no durable account identity or command.", recoveryAction: "restore the account verification checkpoint and retry the same operation", receipt: "accountId and account.inspect command required" });
      const inspection = await this.input.cloudflare.inspectAccount({ accountId, operationId: accountCommand.operationId });
      if (inspection.status !== "succeeded") return this.recordProviderFailure("account.inspect", inspection);
      if (inspection.value.accountId !== accountId || inspection.value.owner !== "customer" || inspection.value.billingOwner !== "customer" || !inspection.value.controlVerified) return this.recordProviderFailure("account.inspect", failure("cloudflare.account_ownership_unverified", "unknown", accountId, accountCommand.operationId, false, [], "use an account the customer controls and rerun account verification", inspection.value.receipt));
      const account: CustomerAccountOwnership = { accountId, owner: "customer", billingOwner: "customer", sourceOwner: "customer", metadataOwner: "customer", artifactOwner: "customer", secretOwner: "customer", recoveryOwner: "customer", controlVerified: true, credentialsStored: false, verifiedAt: nowIso(this.now) };
      const accountVerifiedCommands = this.state.pendingCommands.map((command) => command.operation === "account.inspect" ? { ...command, status: "succeeded" as const, providerOperationId: inspection.operationId, receipt: inspection.value.receipt } : command);
      await this.transition("account-ready", "account.verification.recovered", { operationId: accountCommand.operationId, checkpointId: degraded.checkpointId, details: { accountId, receipt: inspection.value.receipt } }, { account, pendingCommands: accountVerifiedCommands, degraded: undefined });
      const resources = this.state.resources;
      const provisionCommand = this.state.pendingCommands.find((command) => command.operation === "realm.provision" && (command.status === "pending" || command.status === "degraded" || command.status === "blocked"));
      if (!resources || !provisionCommand) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Account verification recovered but the provisioning plan is missing.", recoveryAction: "restore the provisioning checkpoint before continuing", receipt: "resources and realm.provision command required" });
      await this.transition("provisioning", "realm.provisioning.recovery_started", { operationId: provisionCommand.operationId, checkpointId: degraded.checkpointId, details: { accountId, requestedResourceTypes: resources.requestedResourceTypes } }, { resources: { ...resources, state: "provisioning" }, degraded: undefined });
      const provision = await this.input.cloudflare.provisionRealm({ accountId, installationId: this.state.installationId, operationId: provisionCommand.operationId, idempotencyKey: provisionCommand.idempotencyKey, requestedResourceTypes: resources.requestedResourceTypes });
      if (provision.status !== "succeeded") return this.recordProviderFailure("realm.provision", provision);
      return this.finishProvisioning(accountId, resources.requestedResourceTypes, provision.value, provision.operationId);
    }
    if (degraded.operation === "project.import") {
      const importRecord = this.state.import;
      if (!importRecord) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Import recovery has no durable import record.", recoveryAction: "restore the import checkpoint or start a new idempotent import", receipt: "import record missing" });
      await this.transition("importing", "project.import.recovery_started", { operationId: importRecord.operationId, checkpointId: degraded.checkpointId, details: { failureKind: degraded.kind, safeRecoveryAction: degraded.safeRecoveryAction } }, { degraded: undefined, import: { ...importRecord, state: "pending", checkpointId: degraded.checkpointId } });
      const result = await this.input.importer.resumeImport({ installationId: this.state.installationId, project: this.requireProject(), import: this.requireImport() });
      if (result.status !== "succeeded") return this.recordProviderFailure("project.import", result);
      return this.finishImport(result.value, result.operationId);
    }
    if (degraded.operation === "realm.provision") {
      const account = this.requireAccount();
      const resources = this.state.resources;
      const operation = this.state.pendingCommands.find((command) => command.operation === "realm.provision" && (command.status === "pending" || command.status === "degraded" || command.status === "blocked"));
      if (!resources || !operation) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Realm provisioning recovery has no durable resource plan or command.", recoveryAction: "restore the installation checkpoint and inspect the customer account", receipt: "provisioning resource plan or command missing" });
      const inspected = resources.resourceIds.length === 0
        ? await this.input.cloudflare.provisionRealm({ accountId: account.accountId, installationId: this.state.installationId, operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, requestedResourceTypes: resources.requestedResourceTypes })
        : await this.input.cloudflare.inspectProvision({ accountId: account.accountId, installationId: this.state.installationId, operationId: operation.operationId, resourceIds: resources.resourceIds });
      if (inspected.status !== "succeeded") return this.recordProviderFailure("realm.provision", inspected);
      return this.finishProvisioning(account.accountId, resources.requestedResourceTypes, inspected.value, operation.operationId);
    }
    throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: `No automatic recovery handler exists for ${degraded.operation}.`, recoveryAction: "create a verified recovery bundle and use owner activation", receipt: `operation=${degraded.operation}` });
  }

  async exportRecovery(input: { projectExport?: ProjectExport }): Promise<CustomerRealmRecoveryBundle> {
    if (!this.identity || !this.state.realmId) throw new CustomerRealmInstallationError({ code: "blocked", message: "A Realm recovery bundle requires a provisioned Realm identity.", recoveryAction: "complete account provisioning before exporting recovery", receipt: "realm identity missing" });
    if (input.projectExport) {
      const verification = verifyProjectExportManifest(input.projectExport);
      if (verification.status !== "succeeded") throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: `Project Export cannot be included in recovery: ${verification.errorCode}.`, recoveryAction: verification.recoveryAction, receipt: verification.budget.receipt });
      if (this.state.project && input.projectExport.project.id !== this.state.project.projectId) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Project Export does not belong to this installation Project.", recoveryAction: "export the same Project identity and retry", receipt: `expected=${this.state.project.projectId}; actual=${input.projectExport.project.id}` });
    }
    await this.transition(this.state.phase, "recovery.exported", { checkpointId: this.state.checkpoint.checkpointId, details: { credentialFree: true, projectExport: input.projectExport ? projectExportDigest(input.projectExport) : undefined } });
    const realmSnapshot = this.identity.getRecoverySnapshot();
    const state = this.snapshot;
    const bundleWithoutIntegrity: Omit<CustomerRealmRecoveryBundle, "integrity"> = {
      protocol: CONTRACT_VERSIONS.recovery,
      version: "v1",
      bundleId: opaqueId("recovery-bundle"),
      createdAt: nowIso(this.now),
      installationId: this.state.installationId,
      hostingMode: "customer-operated",
      state: { ...state, realmSnapshot },
      realmSnapshot,
      ...(input.projectExport ? { projectExport: clone(input.projectExport) } : {}),
      pendingCommands: clone(this.state.pendingCommands),
      audit: clone(this.state.audit),
    };
    const bundle: CustomerRealmRecoveryBundle = { ...bundleWithoutIntegrity, integrity: { digest: recoveryBundleDigest(bundleWithoutIntegrity), credentialFree: true, receipt: `installation=${this.state.installationId}; realm=${this.state.realmId}; credentials=none; pendingCommands=${this.state.pendingCommands.length}; audit=${this.state.audit.length}` } };
    const verification = verifyCustomerRealmRecoveryBundle(bundle);
    if (verification.status !== "verified") throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: `Generated recovery bundle did not pass its own verification: ${verification.errors.join("; ")}.`, recoveryAction: verification.recoveryAction, receipt: verification.receipt });
    return bundle;
  }

  async restoreRecovery(bundle: CustomerRealmRecoveryBundle): Promise<CustomerRealmInstallationState> {
    const verification = verifyCustomerRealmRecoveryBundle(bundle);
    if (verification.status !== "verified") {
      throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Recovery bundle failed verification; authority was not resumed.", recoveryAction: verification.recoveryAction, receipt: verification.receipt });
    }
    this.requirePhase(["new"], "recovery.restore");
    if (bundle.installationId !== this.state.installationId) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Recovery bundle belongs to another installation.", recoveryAction: "restore using the bundle's installation identity or perform a deliberate migration", receipt: `expected=${this.state.installationId}; actual=${bundle.installationId}` });
    if (!bundle.realmSnapshot.realm.id) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Recovery bundle has no Realm identity.", recoveryAction: "regenerate the bundle from a verified Realm", receipt: "realm id missing" });
    this.identity = new RealmIdentityPolicy({ realmId: bundle.realmSnapshot.realm.id, now: this.now });
    this.identity.restoreRecoverySnapshot(bundle.realmSnapshot);
    const restoredState: CustomerRealmInstallationState = { ...clone(bundle.state), phase: "recovery-pending", revision: 0, realmId: bundle.realmSnapshot.realm.id, realmSnapshot: this.identity.getRecoverySnapshot(), resources: bundle.state.resources ? { ...bundle.state.resources, state: "recovery-pending" } : undefined, degraded: undefined, pendingCommands: clone(bundle.pendingCommands), audit: clone(bundle.audit) };
    await this.transition("recovery-pending", "recovery.verified", { checkpointId: bundle.state.checkpoint.checkpointId, details: { bundleId: bundle.bundleId, credentialsRestored: false, pendingCommands: bundle.pendingCommands.length, projectExportVerified: bundle.projectExport !== undefined } }, restoredState);
    return this.snapshot;
  }

  async activateRecovery(input: { ownerPrincipalId: string; recoveryReceipt: string }): Promise<CustomerRealmInstallationState> {
    this.requirePhase(["recovery-pending"], "recovery.activate");
    if (!input.recoveryReceipt.trim() || input.ownerPrincipalId !== this.state.owner?.principalId) throw new CustomerRealmInstallationError({ code: "ownership_required", message: "Recovery activation requires the enrolled Realm owner and a fresh external recovery receipt.", recoveryAction: "authenticate the recorded owner through the customer-controlled recovery path and retry", receipt: "owner principal and recovery receipt mismatch" });
    const account = this.requireAccount();
    const resources = this.state.resources;
    if (!resources) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Recovery activation has no customer resource record to reconcile.", recoveryAction: "restore a bundle containing the customer resource receipt", receipt: "resources missing" });
    const inspected = await this.input.cloudflare.inspectProvision({ accountId: account.accountId, installationId: this.state.installationId, operationId: `recover:${this.state.checkpoint.checkpointId}`, resourceIds: resources.resourceIds });
    if (inspected.status !== "succeeded") return this.recordProviderFailure("realm.recover", inspected);
    if (!this.identity) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "Recovery activation has no Realm policy state.", recoveryAction: "restore the Realm snapshot into the quarantined installation", receipt: "identity policy missing" });
    await this.transition(this.state.project?.state === "imported" ? "active" : this.state.project ? "project-ready" : "owner-ready", "recovery.activated", { principalId: input.ownerPrincipalId, checkpointId: this.state.checkpoint.checkpointId, details: { recoveryReceipt: input.recoveryReceipt, credentialsRestored: false, resourcesVerified: true } }, { resources: { ...resources, state: "verified" }, degraded: undefined, realmSnapshot: this.identity.getRecoverySnapshot() });
    return this.snapshot;
  }

  private requirePhase(phases: readonly CustomerRealmInstallationPhase[], action: string): void {
    if (!phases.includes(this.state.phase)) throw new CustomerRealmInstallationError({ code: "invalid_transition", message: `${action} is not valid while the customer Realm installation is ${this.state.phase}.`, recoveryAction: `continue from the ${phases.join(" or ")} phase or restore a verified checkpoint`, receipt: `phase=${this.state.phase}; allowed=${phases.join(",")}`, checkpointId: this.state.checkpoint.checkpointId });
  }

  private requireAccount(): CustomerAccountOwnership {
    if (!this.state.account || !customerOwnershipValid(this.state.account)) throw new CustomerRealmInstallationError({ code: "ownership_required", message: "Customer account ownership is not verified.", recoveryAction: "verify the customer-controlled Cloudflare account before continuing", receipt: "customer ownership boundary missing" });
    return this.state.account;
  }

  private requireProject(): CustomerRealmProject {
    if (!this.state.project) throw new CustomerRealmInstallationError({ code: "blocked", message: "No Project is attached to this customer Realm installation.", recoveryAction: "create or restore the Project before importing source", receipt: "project missing" });
    return this.state.project;
  }

  private requireImport(): CustomerRealmImport {
    if (!this.state.import) throw new CustomerRealmInstallationError({ code: "recovery_invalid", message: "No durable Project import record exists.", recoveryAction: "restore the import checkpoint or start a new import", receipt: "import record missing" });
    return this.state.import;
  }

  private async finishProvisioning(accountId: string, requestedResourceTypes: readonly string[], receipt: CustomerRealmProvisionReceipt, operationId: string): Promise<CustomerRealmInstallationState> {
    const requestedTypes = [...requestedResourceTypes];
    const returnedTypes = [...receipt.requestedResourceTypes];
    const typesMatch = requestedTypes.length === returnedTypes.length && requestedTypes.every((resourceType, index) => resourceType === returnedTypes[index]);
    if (receipt.accountId !== accountId || receipt.owner !== "customer" || receipt.state !== "verified" || !typesMatch || (requestedTypes.length > 0 && receipt.resourceIds.length === 0)) return this.recordProviderFailure("realm.provision", failure("cloudflare.provision_unverified", "partial-mutation", this.state.installationId, operationId, true, receipt.resourceIds, "inspect the customer account and retry provisioning verification", `${receipt.receipt}; requestedTypes=${requestedTypes.join(",")}; returnedTypes=${returnedTypes.join(",")}; resourceIds=${receipt.resourceIds.length}`));
    const account: CustomerAccountOwnership = { accountId, owner: "customer", billingOwner: "customer", sourceOwner: "customer", metadataOwner: "customer", artifactOwner: "customer", secretOwner: "customer", recoveryOwner: "customer", controlVerified: true, credentialsStored: false, verifiedAt: nowIso(this.now) };
    const resources: CustomerRealmResources = { owner: "customer", state: "verified", resourceIds: [...receipt.resourceIds], requestedResourceTypes: requestedTypes, receipt: receipt.receipt };
    const realmId = this.state.realmId ?? `realm:${this.state.installationId}`;
    this.identity = new RealmIdentityPolicy({ realmId, now: this.now });
    const completed = this.state.pendingCommands.map((command) => command.operation === "realm.provision" ? { ...command, status: "succeeded" as const, providerOperationId: operationId, receipt: receipt.receipt } : command);
    await this.transition("realm-ready", "realm.provisioned", { operationId, details: { accountId, resourceIds: receipt.resourceIds, ownership: "customer", credentialsStored: false } }, { account, resources, realmId, realmSnapshot: this.identity.getRecoverySnapshot(), pendingCommands: completed, degraded: undefined });
    return this.snapshot;
  }

  private async finishImport(receipt: CustomerRealmImportReceipt, operationId: string): Promise<CustomerRealmInstallationState> {
    const project = this.requireProject();
    const sourceIds = new Set(receipt.sourceSpaceIds);
    if (receipt.state !== "verified" || receipt.projectRevisionId.trim() === "" || receipt.exportDigest.trim() === "" || sourceIds.size !== receipt.sourceSpaceIds.length || sourceIds.size !== project.sourceSpaceIds.length || project.sourceSpaceIds.some((sourceSpaceId) => !sourceIds.has(sourceSpaceId))) return this.recordProviderFailure("project.import", failure("import.receipt_unverified", "import-failure", project.projectId, operationId, false, receipt.partialEffects, "verify Source Space identities, Project Revision lineage, and export digest before retrying", receipt.receipt));
    const importRecord = this.requireImport();
    const completedImport: CustomerRealmImport = { ...importRecord, state: "succeeded", checkpointId: receipt.checkpointId, sourceSpaceIds: [...receipt.sourceSpaceIds], partialEffects: [...receipt.partialEffects], projectRevisionId: receipt.projectRevisionId, exportDigest: receipt.exportDigest, recoveryAction: "export the verified Project and retain the customer-owned recovery checkpoint", receipt: receipt.receipt };
    const completedCommands = this.state.pendingCommands.map((command) => command.operationId === importRecord.operationId ? { ...command, status: "succeeded" as const, providerOperationId: operationId, receipt: receipt.receipt } : command);
    await this.transition("imported", "project.import.verified", { operationId, projectId: project.projectId, checkpointId: receipt.checkpointId, details: { projectRevisionId: receipt.projectRevisionId, sourceSpaceIds: receipt.sourceSpaceIds, exportDigest: receipt.exportDigest, partialEffects: receipt.partialEffects } }, { import: completedImport, project: { ...project, state: "imported", projectRevisionId: receipt.projectRevisionId, exportDigest: receipt.exportDigest }, pendingCommands: completedCommands, degraded: undefined });
    return this.snapshot;
  }

  private async recordProviderFailure(operation: CustomerRealmPendingCommand["operation"], result: CustomerRealmProviderFailure): Promise<CustomerRealmInstallationState> {
    const phase: CustomerRealmInstallationPhase = result.retryable ? "degraded" : "blocked";
    const degraded: CustomerRealmDegradedState = { kind: result.failureKind, operation, dependency: operation === "account.inspect" || operation.startsWith("realm") ? "customer-cloudflare" : "project-import-provider", reason: result.message, checkpointId: this.state.checkpoint.checkpointId, partialEffects: [...result.partialEffects], retryable: result.retryable, safeRecoveryAction: result.recoveryAction, receipt: result.receipt };
    const pendingCommands = this.state.pendingCommands.map((command) => command.operation === operation ? { ...command, status: phase === "degraded" ? "degraded" as const : "blocked" as const, ...(result.providerOperationId ? { providerOperationId: result.providerOperationId } : {}), recoveryAction: result.recoveryAction, receipt: result.receipt } : command);
    const currentImport = this.state.import;
    const importState = operation === "project.import" && currentImport ? { ...currentImport, state: phase === "degraded" ? "degraded" as const : "blocked" as const, checkpointId: this.state.checkpoint.checkpointId, partialEffects: [...result.partialEffects], recoveryAction: result.recoveryAction, receipt: result.receipt } : currentImport;
    await this.transition(phase, `operation.${phase}`, { operationId: result.operationId, checkpointId: degraded.checkpointId, details: { errorCode: result.errorCode, failureKind: result.failureKind, affectedObject: result.affectedObject, partialEffects: result.partialEffects, recoveryAction: result.recoveryAction } }, { degraded, pendingCommands, ...(importState ? { import: importState } : {}) });
    return this.snapshot;
  }

  private async transition(phase: CustomerRealmInstallationPhase, eventType: string, event: { operationId?: string; principalId?: string; projectId?: string; checkpointId?: string; details?: Readonly<Record<string, unknown>> }, patch: Partial<CustomerRealmInstallationState> = {}): Promise<void> {
    const nextWithoutCheckpoint: Omit<CustomerRealmInstallationState, "checkpoint"> = {
      ...this.state,
      ...patch,
      phase,
      revision: this.state.revision + 1,
      ...(this.identity ? { realmSnapshot: this.identity.getRecoverySnapshot(), realmId: this.identity.realm.id } : {}),
      audit: [
        ...this.state.audit,
        {
          protocol: CONTRACT_VERSIONS.audit,
          id: opaqueId("installation-audit"),
          installationId: this.state.installationId,
          occurredAt: nowIso(this.now),
          phase,
          eventType,
          outcome: phase === "blocked" ? "blocked" : phase === "degraded" ? "degraded" : "succeeded",
          ...(event.operationId ? { operationId: event.operationId } : {}),
          ...(event.principalId ? { principalId: event.principalId } : {}),
          ...(event.projectId ? { projectId: event.projectId } : {}),
          ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
          details: event.details ?? {},
        },
      ],
    };
    const pendingCommands = nextWithoutCheckpoint.pendingCommands;
    const checkpoint = checkpointFor(nextWithoutCheckpoint, this.state.checkpoint, [eventType], patch.degraded?.partialEffects ?? patch.import?.partialEffects ?? [], pendingCommands.filter((command) => command.status === "pending" || command.status === "degraded" || command.status === "blocked").map((command) => command.commandId));
    const nextState: CustomerRealmInstallationState = { ...nextWithoutCheckpoint, checkpoint };
    if (this.input.store?.saveIfCurrent) {
      await this.input.store.saveIfCurrent(nextState, this.persistedState ? this.state.checkpoint.stateDigest : undefined);
    } else {
      await this.input.store?.save(nextState);
    }
    this.state = nextState;
    this.persistedState = true;
  }
}
