import { createHash } from "node:crypto";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

/**
 * Bounded qualification protocol for customer-owned provider operations.
 *
 * This is deliberately smaller than the Project/Run/Landing API. It exists so
 * a customer-operated Realm can exercise real provider adapters while the
 * Durable Object (or another Anyam-authoritative store) remains the source of
 * truth for operation state.
 */
export const CUSTOMER_PROVIDER_OPERATION_PROTOCOL = "anyam.customer-provider-operation/v1" as const;

export type CustomerProviderSurface = "d1" | "r2" | "queue" | "workflow" | "worker";
export type CustomerProviderFailureMode =
  | "none"
  | "provider-outage"
  | "authorization-revoked"
  | "timeout"
  | "duplicate-delivery"
  | "partial-mutation"
  | "stale-callback";
export type CustomerProviderOperationState = "pending" | "succeeded" | "degraded" | "blocked" | "indeterminate";

export type CustomerProviderOwnerAuthorization = {
  realmId: string;
  principalId: string;
  sessionId: string;
  capability: "provider.qualification";
  authorizationEpoch: string;
  receipt: string;
};

export type CustomerProviderOperationInput = {
  realmId: string;
  installationId: string;
  operationId: string;
  idempotencyKey: string;
  surface: CustomerProviderSurface;
  failureMode?: CustomerProviderFailureMode;
  payloadDigest: string;
  resourceKey?: string;
  authorization: CustomerProviderOwnerAuthorization;
};

export type CustomerProviderOperationCheckpoint = {
  checkpointId: string;
  stateDigest: string;
  state: CustomerProviderOperationState;
  attempts: number;
  acceptedEffects: readonly string[];
  pendingEffects: readonly string[];
  receipt: string;
};

export type CustomerProviderCleanupReceipt = {
  status: "succeeded" | "blocked";
  providerOperationId?: string;
  deletedResourceKeys: readonly string[];
  remainingResourceKeys: readonly string[];
  receipt: string;
  recoveryAction: string;
};

export type CustomerProviderOperationRecord = {
  protocol: typeof CUSTOMER_PROVIDER_OPERATION_PROTOCOL;
  realmId: string;
  installationId: string;
  operationId: string;
  idempotencyKey: string;
  surface: CustomerProviderSurface;
  failureMode: CustomerProviderFailureMode;
  payloadDigest: string;
  resourceKey: string;
  owner: {
    principalId: string;
    sessionId: string;
    authorizationEpoch: string;
  };
  state: CustomerProviderOperationState;
  providerOperationId?: string;
  providerStatus?: string;
  providerReceipt?: string;
  providerPartialEffects: readonly string[];
  outputDigest?: string;
  readBackDigest?: string;
  /**
   * The checkpoint that a deferred provider callback was emitted against.
   * Queue/Workflow transports emit before the coordinator records their
   * indeterminate observation, so this preserves an explicit compare-and-set
   * predecessor rather than weakening stale-callback protection.
   */
  callbackStateDigest?: string | null;
  recoveryAction: string;
  checkpoint: CustomerProviderOperationCheckpoint;
  cleanup?: CustomerProviderCleanupReceipt;
  credentialFree: true;
  canonicalWrite: false;
  createdAt: string;
  updatedAt: string;
  receipt: string;
};

export type CustomerProviderRecoveryBundle = {
  protocol: typeof CUSTOMER_PROVIDER_OPERATION_PROTOCOL;
  version: "recovery-v1";
  realmId: string;
  installationId: string;
  records: readonly CustomerProviderOperationRecord[];
  integrity: {
    digest: string;
    credentialFree: true;
    receipt: string;
  };
};

export type CustomerProviderOperationObservation = {
  status: "accepted" | "failed" | "indeterminate";
  providerOperationId: string;
  providerStatus: string;
  outputDigest?: string;
  partialEffects: readonly string[];
  retryable: boolean;
  recoveryAction: string;
  receipt: string;
};

export type CustomerProviderReadBack = {
  providerOperationId: string;
  status: "present" | "absent" | "indeterminate";
  digest?: string;
  resourceKeys: readonly string[];
  receipt: string;
};

export type CustomerProviderAdapter = {
  execute(input: {
    realmId: string;
    installationId: string;
    operationId: string;
    idempotencyKey: string;
    surface: CustomerProviderSurface;
    failureMode: CustomerProviderFailureMode;
    payloadDigest: string;
    resourceKey: string;
    expectedStateDigest: string;
  }): Promise<CustomerProviderOperationObservation>;
  readBack(input: {
    realmId: string;
    installationId: string;
    operationId: string;
    providerOperationId: string;
    surface: CustomerProviderSurface;
    resourceKey: string;
    expectedDigest?: string;
  }): Promise<CustomerProviderReadBack>;
  cleanup(input: {
    realmId: string;
    installationId: string;
    operationId: string;
    providerOperationId?: string;
    surface: CustomerProviderSurface;
    resourceKey: string;
  }): Promise<CustomerProviderCleanupReceipt>;
};

export type CustomerProviderAdapterSet = Readonly<Record<CustomerProviderSurface, CustomerProviderAdapter>>;

export type CustomerProviderOperationStore = {
  get(operationId: string): Promise<CustomerProviderOperationRecord | undefined>;
  put(record: CustomerProviderOperationRecord, expectedStateDigest?: string): Promise<void>;
  list(): Promise<readonly CustomerProviderOperationRecord[]>;
  restore(records: readonly CustomerProviderOperationRecord[]): Promise<void>;
};

export type CustomerProviderDurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  transaction<T>(closure: (transaction: { get<Value>(key: string): Promise<Value | undefined>; put<Value>(key: string, value: Value): Promise<void> }) => Promise<T>): Promise<T>;
};

export class CustomerProviderOperationError extends Error {
  readonly code: "invalid-request" | "unauthorized" | "idempotency-conflict" | "not-found" | "stale-state" | "recovery-invalid";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: CustomerProviderOperationError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "CustomerProviderOperationError";
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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CustomerProviderOperationError({
      code: "invalid-request",
      message: `${field} is required for a customer-provider qualification operation.`,
      recoveryAction: `provide a non-empty ${field} and retry without changing the operation identity`,
      receipt: `field=${field}; operation=invalid`,
    });
  }
  return value.trim();
}

function assertAuthorization(input: CustomerProviderOperationInput): void {
  required(input.realmId, "realmId");
  required(input.installationId, "installationId");
  required(input.operationId, "operationId");
  required(input.idempotencyKey, "idempotencyKey");
  required(input.payloadDigest, "payloadDigest");
  required(input.authorization.principalId, "authorization.principalId");
  required(input.authorization.sessionId, "authorization.sessionId");
  required(input.authorization.authorizationEpoch, "authorization.authorizationEpoch");
  required(input.authorization.receipt, "authorization.receipt");
  if (input.authorization.realmId !== input.realmId || input.authorization.capability !== "provider.qualification") {
    throw new CustomerProviderOperationError({
      code: "unauthorized",
      message: "The provider qualification operation requires an owner-authorized capability for this Realm.",
      recoveryAction: "authenticate the customer Realm owner and request the bounded provider.qualification capability",
      receipt: `realm=${input.realmId}; authorizationRealm=${input.authorization.realmId}; capability=${input.authorization.capability}; mutation=not-performed`,
    });
  }
  const finding = scanCredentialMaterial(input.authorization, "authorization");
  if (finding) {
    throw new CustomerProviderOperationError({
      code: "invalid-request",
      message: "Provider authorization contains credential material; no provider operation was attempted.",
      recoveryAction: "send only the owner authorization receipt and digest, never a provider credential",
      receipt: `credential-material=reject; field=${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; mutation=not-performed`,
    });
  }
}

function stateDigest(record: CustomerProviderOperationRecord): string {
  return digest({ ...record, checkpoint: { ...record.checkpoint, stateDigest: "pending", receipt: "pending" } });
}

function checkpoint(record: Omit<CustomerProviderOperationRecord, "checkpoint">, previous: CustomerProviderOperationCheckpoint | undefined, acceptedEffects: readonly string[], pendingEffects: readonly string[]): CustomerProviderOperationCheckpoint {
  const checkpointId = `checkpoint:${record.operationId}:${record.state}:${previous?.attempts ?? 0}:${previous?.checkpointId ?? "initial"}`;
  const attempts = previous ? previous.attempts + 1 : 0;
  const provisional = {
    ...record,
    checkpoint: {
      checkpointId,
      stateDigest: "pending",
      state: record.state,
      attempts,
      acceptedEffects: [...acceptedEffects],
      pendingEffects: [...pendingEffects],
      receipt: `operation=${record.operationId}; checkpoint=${checkpointId}; state=${record.state}`,
    },
  } as CustomerProviderOperationRecord;
  const currentDigest = stateDigest(provisional);
  return { ...provisional.checkpoint, stateDigest: currentDigest, receipt: `${provisional.checkpoint.receipt}; stateDigest=${currentDigest}` };
}

function initialRecord(input: CustomerProviderOperationInput, now: string): CustomerProviderOperationRecord {
  const failureMode = input.failureMode ?? "none";
  const resourceKey = input.resourceKey?.trim() || `anyam/qualification/provider/${input.realmId}/${input.installationId}/${input.surface}/${input.operationId}`;
  const recordWithoutCheckpoint = {
    protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL,
    realmId: input.realmId,
    installationId: input.installationId,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    surface: input.surface,
    failureMode,
    payloadDigest: input.payloadDigest,
    resourceKey,
    owner: {
      principalId: input.authorization.principalId,
      sessionId: input.authorization.sessionId,
      authorizationEpoch: input.authorization.authorizationEpoch,
    },
    state: "pending" as const,
    providerPartialEffects: [],
    recoveryAction: "complete the named provider operation and verify its read-back before accepting the result",
    credentialFree: true as const,
    canonicalWrite: false as const,
    createdAt: now,
    updatedAt: now,
    receipt: `operation=${input.operationId}; surface=${input.surface}; state=pending; credentialFree=true; canonicalWrite=false`,
  };
  return { ...recordWithoutCheckpoint, checkpoint: checkpoint(recordWithoutCheckpoint, undefined, [], [resourceKey]) };
}

function sameIdentity(record: CustomerProviderOperationRecord, input: CustomerProviderOperationInput): boolean {
  return record.realmId === input.realmId
    && record.installationId === input.installationId
    && record.idempotencyKey === input.idempotencyKey
    && record.surface === input.surface
    && record.payloadDigest === input.payloadDigest;
}

function nextRecord(record: CustomerProviderOperationRecord, patch: Partial<CustomerProviderOperationRecord>, now: string, acceptedEffects: readonly string[], pendingEffects: readonly string[]): CustomerProviderOperationRecord {
  const withoutCheckpoint: Omit<CustomerProviderOperationRecord, "checkpoint"> = {
    ...record,
    ...patch,
    updatedAt: now,
  };
  return { ...withoutCheckpoint, checkpoint: checkpoint(withoutCheckpoint, record.checkpoint, acceptedEffects, pendingEffects) };
}

export class InMemoryCustomerProviderOperationStore implements CustomerProviderOperationStore {
  private readonly records = new Map<string, CustomerProviderOperationRecord>();

  async get(operationId: string): Promise<CustomerProviderOperationRecord | undefined> {
    const record = this.records.get(operationId);
    return record ? clone(record) : undefined;
  }

  async put(record: CustomerProviderOperationRecord, expectedStateDigest?: string): Promise<void> {
    const current = this.records.get(record.operationId);
    if ((current?.checkpoint.stateDigest ?? undefined) !== expectedStateDigest) {
      throw new CustomerProviderOperationError({
        code: "stale-state",
        message: "The customer-provider operation changed before this transition was persisted; the candidate was not written.",
        recoveryAction: "reopen the operation, inspect its current checkpoint, and retry the same idempotency key",
        receipt: `operation=${record.operationId}; expected=${expectedStateDigest ?? "absent"}; actual=${current?.checkpoint.stateDigest ?? "absent"}; overwritten=false`,
      });
    }
    this.records.set(record.operationId, clone(record));
  }

  async list(): Promise<readonly CustomerProviderOperationRecord[]> {
    return [...this.records.values()].map(clone);
  }

  async restore(records: readonly CustomerProviderOperationRecord[]): Promise<void> {
    this.records.clear();
    for (const record of records) this.records.set(record.operationId, clone(record));
  }
}

export class CustomerProviderDurableObjectOperationStore implements CustomerProviderOperationStore {
  private readonly prefix: string;

  constructor(private readonly storage: CustomerProviderDurableObjectStorage, realmId: string, installationId: string) {
    this.prefix = `anyam/provider-qualification/v1/${realmId}/${installationId}/`;
  }

  private key(operationId: string): string {
    return `${this.prefix}${operationId}`;
  }

  async get(operationId: string): Promise<CustomerProviderOperationRecord | undefined> {
    const record = await this.storage.get<CustomerProviderOperationRecord>(this.key(operationId));
    return record ? clone(record) : undefined;
  }

  async put(record: CustomerProviderOperationRecord, expectedStateDigest?: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<CustomerProviderOperationRecord>(this.key(record.operationId));
      if ((current?.checkpoint.stateDigest ?? undefined) !== expectedStateDigest) {
        throw new CustomerProviderOperationError({
          code: "stale-state",
          message: "The customer-provider operation changed before this Durable Object transition was persisted; the candidate was not written.",
          recoveryAction: "reopen the operation, inspect its current checkpoint, and retry the same idempotency key",
          receipt: `operation=${record.operationId}; expected=${expectedStateDigest ?? "absent"}; actual=${current?.checkpoint.stateDigest ?? "absent"}; overwritten=false`,
        });
      }
      await transaction.put(this.key(record.operationId), clone(record));
    });
  }

  async list(): Promise<readonly CustomerProviderOperationRecord[]> {
    const records = await this.storage.list<CustomerProviderOperationRecord>({ prefix: this.prefix });
    return [...records.values()].map(clone);
  }

  async restore(records: readonly CustomerProviderOperationRecord[]): Promise<void> {
    const current = await this.list();
    const currentById = new Map(current.map((record) => [record.operationId, record]));
    const incomingById = new Map(records.map((record) => [record.operationId, record]));
    const unexpected = current.find((record) => !incomingById.has(record.operationId));
    if (unexpected) {
      throw new CustomerProviderOperationError({
        code: "stale-state",
        message: "The durable provider-operation store contains a record outside the Recovery bundle; restore was not applied.",
        recoveryAction: "export a fresh exact Recovery bundle from the authoritative coordinator and retry restore",
        receipt: `operation=${unexpected.operationId}; recovery=stale; overwritten=false`,
      });
    }
    for (const record of records) {
      const existing = currentById.get(record.operationId);
      if (existing && digest(existing) !== digest(record)) {
        throw new CustomerProviderOperationError({
          code: "stale-state",
          message: "The durable provider-operation store differs from the Recovery bundle; restore was not applied.",
          recoveryAction: "export a fresh exact Recovery bundle from the authoritative coordinator and retry restore",
          receipt: `operation=${record.operationId}; recovery=stale; overwritten=false`,
        });
      }
    }
    await this.storage.transaction(async (transaction) => {
      for (const record of records) {
        if (!currentById.has(record.operationId)) await transaction.put(this.key(record.operationId), clone(record));
      }
    });
  }
}

export class CustomerProviderQualificationCoordinator {
  constructor(private readonly input: {
    realmId: string;
    installationId: string;
    store: CustomerProviderOperationStore;
    adapters: CustomerProviderAdapterSet;
    now?: () => Date;
  }) {}

  private now(): string {
    return (this.input.now ?? (() => new Date()))().toISOString();
  }

  private authorize(record: CustomerProviderOperationRecord, authorization: CustomerProviderOwnerAuthorization): void {
    if (record.realmId !== authorization.realmId || record.owner.principalId !== authorization.principalId || record.owner.sessionId !== authorization.sessionId || record.owner.authorizationEpoch !== authorization.authorizationEpoch || authorization.capability !== "provider.qualification") {
      throw new CustomerProviderOperationError({
        code: "unauthorized",
        message: "The authorization no longer matches the owner-scoped provider operation.",
        recoveryAction: "re-authenticate the customer Realm owner and request a fresh bounded capability",
        receipt: `operation=${record.operationId}; ownerMatch=false; mutation=not-performed`,
      });
    }
  }

  async run(input: CustomerProviderOperationInput): Promise<CustomerProviderOperationRecord> {
    assertAuthorization(input);
    if (input.realmId !== this.input.realmId || input.installationId !== this.input.installationId) {
      throw new CustomerProviderOperationError({
        code: "unauthorized",
        message: "The provider operation is scoped to a different customer Realm installation.",
        recoveryAction: "use the coordinator belonging to the owner-authorized installation",
        receipt: `expectedRealm=${this.input.realmId}; requestedRealm=${input.realmId}; expectedInstallation=${this.input.installationId}; requestedInstallation=${input.installationId}; mutation=not-performed`,
      });
    }
    const existing = await this.input.store.get(input.operationId);
    if (existing) {
      this.authorize(existing, input.authorization);
      if (!sameIdentity(existing, input)) {
        throw new CustomerProviderOperationError({
          code: "idempotency-conflict",
          message: "The operation ID is already bound to a different provider input.",
          recoveryAction: "reuse the original surface, payload digest, and idempotency key, or choose a new operation identity",
          receipt: `operation=${input.operationId}; existingIdempotency=${existing.idempotencyKey}; requestedIdempotency=${input.idempotencyKey}; overwritten=false`,
        });
      }
      return clone(existing);
    }
    const record = initialRecord(input, this.now());
    await this.input.store.put(record);
    return this.execute(record);
  }

  async resume(operationId: string, authorization: CustomerProviderOwnerAuthorization): Promise<CustomerProviderOperationRecord> {
    const record = await this.require(operationId);
    this.authorize(record, authorization);
    if (record.state === "succeeded") return record;
    if (record.state === "pending") return this.execute(record);
    const authorizationRecovery = record.state === "blocked" && record.providerStatus === "401-authorization-revoked";
    if (record.state !== "degraded" && record.state !== "indeterminate" && !authorizationRecovery) {
      throw new CustomerProviderOperationError({
        code: "recovery-invalid",
        message: `Operation ${operationId} is ${record.state} and cannot be automatically resumed.`,
        recoveryAction: record.recoveryAction,
        receipt: `operation=${operationId}; state=${record.state}; resumed=false`,
      });
    }
    const pending = nextRecord(record, { state: "pending", recoveryAction: "retry the same provider operation and verify the existing provider object by digest" }, this.now(), record.checkpoint.acceptedEffects, [record.resourceKey]);
    await this.input.store.put(pending, record.checkpoint.stateDigest);
    return this.execute(pending);
  }

  /**
   * Internal coordinator inspection for provider callbacks. Callers must
   * still enforce the Realm boundary before using the returned owner fields.
   */
  async inspect(operationId: string): Promise<CustomerProviderOperationRecord> {
    return this.require(operationId);
  }

  async acceptCallback(input: { operationId: string; authorization: CustomerProviderOwnerAuthorization; providerOperationId: string; expectedStateDigest: string; outputDigest?: string; receipt: string }): Promise<CustomerProviderOperationRecord> {
    const record = await this.require(input.operationId);
    this.authorize(record, input.authorization);
    if (record.checkpoint.stateDigest !== input.expectedStateDigest && record.callbackStateDigest !== input.expectedStateDigest) {
      return clone(record);
    }
    if (record.providerOperationId && record.providerOperationId !== input.providerOperationId) {
      throw new CustomerProviderOperationError({
        code: "stale-state",
        message: "The callback provider operation identity does not match the accepted operation.",
        recoveryAction: "ignore the callback and reconcile the provider object using the current checkpoint",
        receipt: `operation=${record.operationId}; expectedProviderOperation=${record.providerOperationId}; received=${input.providerOperationId}; overwritten=false`,
      });
    }
    const adapter = this.input.adapters[record.surface];
    const readBack = await adapter.readBack({ realmId: record.realmId, installationId: record.installationId, operationId: record.operationId, providerOperationId: input.providerOperationId, surface: record.surface, resourceKey: record.resourceKey, ...(input.outputDigest ? { expectedDigest: input.outputDigest } : {}) });
    if (readBack.status !== "present" || !readBack.digest) {
      throw new CustomerProviderOperationError({
        code: "stale-state",
        message: "The callback could not be reconciled to a present provider object.",
        recoveryAction: "retain the operation as indeterminate and inspect the provider object before retrying",
        receipt: `operation=${record.operationId}; callback=${input.providerOperationId}; readBack=${readBack.status}; overwritten=false`,
      });
    }
    const completed = nextRecord(record, { state: "succeeded", providerOperationId: input.providerOperationId, providerStatus: "callback-accepted", providerReceipt: input.receipt, ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}), readBackDigest: readBack.digest, callbackStateDigest: null, recoveryAction: "No recovery action is currently required." }, this.now(), [record.resourceKey], []);
    await this.input.store.put(completed, record.checkpoint.stateDigest);
    return completed;
  }

  async cleanup(operationId: string, authorization: CustomerProviderOwnerAuthorization): Promise<CustomerProviderOperationRecord> {
    const record = await this.require(operationId);
    this.authorize(record, authorization);
    if (record.cleanup?.status === "succeeded") return record;
    const cleanup = await this.input.adapters[record.surface].cleanup({ realmId: record.realmId, installationId: record.installationId, operationId: record.operationId, ...(record.providerOperationId ? { providerOperationId: record.providerOperationId } : {}), surface: record.surface, resourceKey: record.resourceKey });
    const next = nextRecord(record, { cleanup, recoveryAction: cleanup.status === "succeeded" ? "No recovery action is currently required." : cleanup.recoveryAction }, this.now(), record.checkpoint.acceptedEffects, record.checkpoint.pendingEffects);
    await this.input.store.put(next, record.checkpoint.stateDigest);
    return next;
  }

  async exportRecovery(): Promise<CustomerProviderRecoveryBundle> {
    const records = await this.input.store.list();
    const unsigned = { protocol: CUSTOMER_PROVIDER_OPERATION_PROTOCOL, version: "recovery-v1" as const, realmId: this.input.realmId, installationId: this.input.installationId, records: records.map(clone) };
    return { ...unsigned, integrity: { digest: digest(unsigned), credentialFree: true, receipt: `realm=${this.input.realmId}; installation=${this.input.installationId}; records=${records.length}; credentials=none` } };
  }

  async restoreRecovery(bundle: CustomerProviderRecoveryBundle): Promise<void> {
    const unsigned = { protocol: bundle.protocol, version: bundle.version, realmId: bundle.realmId, installationId: bundle.installationId, records: bundle.records };
    const finding = scanCredentialMaterial(bundle, "recoveryBundle");
    if (bundle.protocol !== CUSTOMER_PROVIDER_OPERATION_PROTOCOL || bundle.version !== "recovery-v1" || bundle.realmId !== this.input.realmId || bundle.installationId !== this.input.installationId || bundle.integrity.credentialFree !== true || bundle.integrity.digest !== digest(unsigned) || finding) {
      throw new CustomerProviderOperationError({
        code: "recovery-invalid",
        message: "The provider-operation Recovery bundle failed credential-free identity or integrity validation.",
        recoveryAction: "export a fresh exact Recovery bundle from the authoritative coordinator and retry restore",
        receipt: `realm=${this.input.realmId}; installation=${this.input.installationId}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; credentialField=${finding?.path ?? "none"}; authority=resumed=false`,
      });
    }
    await this.input.store.restore(bundle.records);
  }

  private async require(operationId: string): Promise<CustomerProviderOperationRecord> {
    const record = await this.input.store.get(operationId);
    if (!record) throw new CustomerProviderOperationError({ code: "not-found", message: `Provider operation ${operationId} was not found.`, recoveryAction: "use the exact owner-visible operation identity or create a new disposable qualification operation", receipt: `operation=${operationId}; found=false` });
    return record;
  }

  private async execute(record: CustomerProviderOperationRecord): Promise<CustomerProviderOperationRecord> {
    const adapter = this.input.adapters[record.surface];
    let observation: CustomerProviderOperationObservation;
    try {
      observation = await adapter.execute({ realmId: record.realmId, installationId: record.installationId, operationId: record.operationId, idempotencyKey: record.idempotencyKey, surface: record.surface, failureMode: record.failureMode, payloadDigest: record.payloadDigest, resourceKey: record.resourceKey, expectedStateDigest: record.checkpoint.stateDigest });
    } catch (error) {
      observation = {
        status: "indeterminate",
        providerOperationId: `provider:${record.operationId}`,
        providerStatus: "exception",
        partialEffects: [],
        retryable: true,
        recoveryAction: "inspect the provider operation and retry the same idempotency key after the provider recovers",
        receipt: `operation=${record.operationId}; provider=${record.surface}; exception=${error instanceof Error ? error.name : "unknown"}; authoritativeEffect=unknown`,
      };
    }
    if (observation.status !== "accepted") {
      const state: CustomerProviderOperationState = observation.status === "indeterminate" ? "indeterminate" : observation.retryable ? "degraded" : "blocked";
      const failed = nextRecord(record, {
        state,
        providerOperationId: observation.providerOperationId,
        providerStatus: observation.providerStatus,
        providerReceipt: observation.receipt,
        providerPartialEffects: [...observation.partialEffects],
        ...(observation.outputDigest ? { outputDigest: observation.outputDigest } : {}),
        ...(observation.providerStatus === "transport-accepted"
          || observation.providerStatus === "transport-duplicate-or-partial"
          || observation.providerStatus === "instance-created"
          ? { callbackStateDigest: record.checkpoint.stateDigest }
          : {}),
        recoveryAction: observation.recoveryAction,
        receipt: `${record.receipt}; providerStatus=${observation.providerStatus}; state=${state}`,
      }, this.now(), observation.partialEffects, [record.resourceKey]);
      await this.input.store.put(failed, record.checkpoint.stateDigest);
      return failed;
    }
    const providerOperationId = observation.providerOperationId;
    let readBack: CustomerProviderReadBack;
    try {
      readBack = await adapter.readBack({ realmId: record.realmId, installationId: record.installationId, operationId: record.operationId, providerOperationId, surface: record.surface, resourceKey: record.resourceKey, ...(observation.outputDigest ? { expectedDigest: observation.outputDigest } : {}) });
    } catch (error) {
      readBack = { providerOperationId, status: "indeterminate", resourceKeys: [], receipt: `operation=${record.operationId}; readBack=exception; cause=${error instanceof Error ? error.name : "unknown"}` };
    }
    if (readBack.status !== "present" || !readBack.digest || (observation.outputDigest && readBack.digest !== observation.outputDigest)) {
      const indeterminate = nextRecord(record, { state: "indeterminate", providerOperationId, providerStatus: observation.providerStatus, providerReceipt: observation.receipt, providerPartialEffects: [...observation.partialEffects], ...(observation.outputDigest ? { outputDigest: observation.outputDigest } : {}), ...(readBack.digest ? { readBackDigest: readBack.digest } : {}), recoveryAction: "reconcile the provider object by operation identity and digest before retrying", receipt: `${record.receipt}; providerStatus=${observation.providerStatus}; readBack=${readBack.status}; state=indeterminate` }, this.now(), observation.partialEffects, [record.resourceKey]);
      await this.input.store.put(indeterminate, record.checkpoint.stateDigest);
      return indeterminate;
    }
    const completed = nextRecord(record, { state: "succeeded", providerOperationId, providerStatus: observation.providerStatus, providerReceipt: observation.receipt, ...(observation.outputDigest ? { outputDigest: observation.outputDigest } : {}), readBackDigest: readBack.digest, providerPartialEffects: [...observation.partialEffects], recoveryAction: "No recovery action is currently required.", receipt: `${record.receipt}; providerStatus=${observation.providerStatus}; readBack=verified; state=succeeded` }, this.now(), [record.resourceKey], []);
    await this.input.store.put(completed, record.checkpoint.stateDigest);
    return completed;
  }
}

type InMemoryProviderObject = {
  providerOperationId: string;
  digest: string;
  resourceKey: string;
  surface: CustomerProviderSurface;
};

/**
 * Deterministic local adapter set used by the qualification matrix. It models
 * the five provider surfaces without pretending that the local store is a
 * Cloudflare receipt. The same adapter contract is used by real bindings.
 */
export class InMemoryCustomerProviderAdapterSet implements CustomerProviderAdapterSet {
  private readonly objects = new Map<string, InMemoryProviderObject>();
  private readonly failedModes = new Set<string>();
  private authorizationActive = true;

  readonly d1: CustomerProviderAdapter;
  readonly r2: CustomerProviderAdapter;
  readonly queue: CustomerProviderAdapter;
  readonly workflow: CustomerProviderAdapter;
  readonly worker: CustomerProviderAdapter;

  constructor() {
    this.d1 = this.adapter("d1");
    this.r2 = this.adapter("r2");
    this.queue = this.adapter("queue");
    this.workflow = this.adapter("workflow");
    this.worker = this.adapter("worker");
  }

  revokeAuthorization(): void {
    this.authorizationActive = false;
  }

  restoreAuthorization(): void {
    this.authorizationActive = true;
  }

  listProviderObjects(): readonly InMemoryProviderObject[] {
    return [...this.objects.values()].map(clone);
  }

  private adapter(surface: CustomerProviderSurface): CustomerProviderAdapter {
    return {
      execute: async (input) => {
        const providerOperationId = `provider:${surface}:${input.operationId}`;
        const existing = this.objects.get(input.resourceKey);
        if (existing) {
          return {
            status: "accepted",
            providerOperationId: existing.providerOperationId,
            providerStatus: "idempotent",
            outputDigest: existing.digest,
            partialEffects: [],
            retryable: false,
            recoveryAction: "No recovery action is currently required.",
            receipt: `provider=${surface}; operation=${input.operationId}; idempotent=true; duplicateEffect=false`,
          };
        }
        if (!this.authorizationActive || input.failureMode === "authorization-revoked") {
          return {
            status: "failed",
            providerOperationId,
            providerStatus: "401-authorization-revoked",
            partialEffects: [],
            retryable: false,
            recoveryAction: "restore the customer provider authorization and retry the same operation identity",
            receipt: `provider=${surface}; operation=${input.operationId}; authorization=revoked; credentialMaterialStored=false`,
          };
        }
        const failureKey = `${input.operationId}:${input.failureMode}`;
        if ((input.failureMode === "provider-outage" || input.failureMode === "timeout" || input.failureMode === "duplicate-delivery") && !this.failedModes.has(failureKey)) {
          this.failedModes.add(failureKey);
          return {
            status: input.failureMode === "timeout" ? "indeterminate" : "failed",
            providerOperationId,
            providerStatus: input.failureMode === "timeout" ? "timeout" : input.failureMode,
            partialEffects: [],
            retryable: true,
            recoveryAction: "retry the same operation identity after inspecting the authoritative checkpoint",
            receipt: `provider=${surface}; operation=${input.operationId}; failureMode=${input.failureMode}; effect=not-observed`,
          };
        }
        const outputDigest = digest({ surface, operationId: input.operationId, payloadDigest: input.payloadDigest });
        const partial = input.failureMode === "partial-mutation";
        this.objects.set(input.resourceKey, { providerOperationId, digest: outputDigest, resourceKey: input.resourceKey, surface });
        if (partial) {
          return {
            status: "failed",
            providerOperationId,
            providerStatus: "partial-mutation",
            outputDigest,
            partialEffects: [input.resourceKey],
            retryable: true,
            recoveryAction: "inspect the partial provider object and retry the same idempotency key; the adapter must not create a second effect",
            receipt: `provider=${surface}; operation=${input.operationId}; partialMutation=true; resource=${input.resourceKey}`,
          };
        }
        return {
          status: "accepted",
          providerOperationId,
          providerStatus: "accepted",
          outputDigest,
          partialEffects: [],
          retryable: false,
          recoveryAction: "No recovery action is currently required.",
          receipt: `provider=${surface}; operation=${input.operationId}; accepted=true; resource=${input.resourceKey}`,
        };
      },
      readBack: async (input) => {
        const object = this.objects.get(input.resourceKey);
        if (!object) return { providerOperationId: input.providerOperationId, status: "absent", resourceKeys: [], receipt: `provider=${surface}; operation=${input.operationId}; readBack=absent` };
        return { providerOperationId: object.providerOperationId, status: "present", digest: object.digest, resourceKeys: [object.resourceKey], receipt: `provider=${surface}; operation=${input.operationId}; readBack=present; digest=${object.digest}` };
      },
      cleanup: async (input) => {
        const existed = this.objects.delete(input.resourceKey);
        const prefix = `anyam/qualification/provider/${input.realmId}/${input.installationId}/`;
        const remainingResourceKeys = [...this.objects.values()].filter((object) => object.surface === surface && object.resourceKey.startsWith(prefix)).map((object) => object.resourceKey);
        return {
          status: "succeeded",
          ...(input.providerOperationId ? { providerOperationId: input.providerOperationId } : {}),
          deletedResourceKeys: existed ? [input.resourceKey] : [],
          remainingResourceKeys,
          receipt: `provider=${surface}; operation=${input.operationId}; deleted=${existed}; remaining=${remainingResourceKeys.length}; exact=true`,
          recoveryAction: "No recovery action is currently required.",
        };
      },
    };
  }
}

export function verifyCustomerProviderOperationRecord(record: CustomerProviderOperationRecord): { status: "verified" | "failed"; errors: readonly string[]; receipt: string } {
  const errors: string[] = [];
  if (record.protocol !== CUSTOMER_PROVIDER_OPERATION_PROTOCOL) errors.push("unsupported operation protocol");
  if (record.credentialFree !== true || record.canonicalWrite !== false) errors.push("credential or canonical-write boundary is invalid");
  if (record.checkpoint.stateDigest !== stateDigest(record)) errors.push("checkpoint state digest does not match record");
  const finding = scanCredentialMaterial(record, "record");
  if (finding) errors.push(`record contains credential material at ${finding.path}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}`);
  return { status: errors.length === 0 ? "verified" : "failed", errors, receipt: `operation=${record.operationId}; verified=${errors.length === 0}; errors=${errors.length}` };
}
