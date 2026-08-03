import {
  customerRealmRecoveryBundleDigest,
  type CustomerRealmInstallationState,
  type CustomerRealmInstallationStore,
  type CustomerRealmRecoveryBundle,
  verifyCustomerRealmRecoveryBundle,
} from "../installation/customer-realm.ts";

/**
 * The smallest storage surface a customer-owned Realm Durable Object needs.
 * Durable Object invocation serialization supplies the atomicity boundary;
 * the adapter supplies the expected-checkpoint guard and never becomes an
 * HTTP authority by itself.
 */
export type CustomerRealmDurableObjectTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

export type CustomerRealmDurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** Cloudflare Durable Object transactions provide the CAS serialization boundary. */
  transaction<T>(closure: (transaction: CustomerRealmDurableObjectTransaction) => Promise<T>): Promise<T>;
};

export type CustomerRealmPersistenceErrorCode =
  | "stale_state"
  | "installation_mismatch"
  | "recovery_invalid"
  | "recovery_not_found"
  | "recovery_digest_mismatch";

export class CustomerRealmPersistenceError extends Error {
  readonly code: CustomerRealmPersistenceErrorCode;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: CustomerRealmPersistenceErrorCode; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "CustomerRealmPersistenceError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      recoveryAction: this.recoveryAction,
      receipt: this.receipt,
    };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function installationStateKey(installationId: string): string {
  return `anyam/customer-realm/v1/${installationId}/state`;
}

function recoveryObjectKey(digest: string): string {
  return `anyam/customer-realm/recovery/v1/${digest}`;
}

function assertRecoveryDigest(digest: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new CustomerRealmPersistenceError({
      code: "recovery_digest_mismatch",
      message: `Recovery digest ${digest} is not a valid immutable SHA-256 address.`,
      recoveryAction: "use the exact sha256 digest recorded in the owner-visible Recovery receipt",
      receipt: `digest=${digest}; format=sha256:64-lowercase-hex; accepted=false`,
    });
  }
}

function assertInstallation(state: CustomerRealmInstallationState, installationId: string): void {
  if (state.installationId !== installationId || state.hostingMode !== "customer-operated") {
    throw new CustomerRealmPersistenceError({
      code: "installation_mismatch",
      message: `Customer Realm state belongs to ${state.installationId}, not ${installationId}, or is not customer-operated.`,
      recoveryAction: "restore the state under its recorded installation identity and retry the coordinator write",
      receipt: `expected=${installationId}; actual=${state.installationId}; hostingMode=${state.hostingMode}`,
    });
  }
}

/**
 * Durable Object coordinator adapter for the existing installation store
 * boundary. The coordinator owns state transitions; D1, R2, Queues, and
 * Workflows may observe or carry work but cannot replace this authority.
 */
export class CustomerRealmDurableObjectInstallationStore implements CustomerRealmInstallationStore {
  constructor(private readonly storage: CustomerRealmDurableObjectStorage, private readonly installationId: string) {}

  async load(installationId: string): Promise<CustomerRealmInstallationState | undefined> {
    if (installationId !== this.installationId) {
      throw new CustomerRealmPersistenceError({
        code: "installation_mismatch",
        message: `Customer Realm store is scoped to ${this.installationId}, not ${installationId}.`,
        recoveryAction: "open the installation through its owning coordinator",
        receipt: `expected=${this.installationId}; requested=${installationId}`,
      });
    }
    const state = await this.storage.get<CustomerRealmInstallationState>(installationStateKey(this.installationId));
    return state ? clone(state) : undefined;
  }

  async save(state: CustomerRealmInstallationState): Promise<void> {
    assertInstallation(state, this.installationId);
    await this.storage.put(installationStateKey(this.installationId), clone(state));
  }

  async saveIfCurrent(state: CustomerRealmInstallationState, expectedStateDigest?: string): Promise<void> {
    assertInstallation(state, this.installationId);
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<CustomerRealmInstallationState>(installationStateKey(this.installationId));
      const actualStateDigest = current?.checkpoint.stateDigest;
      if (actualStateDigest !== expectedStateDigest) {
        throw new CustomerRealmPersistenceError({
          code: "stale_state",
          message: "Customer Realm state changed before this transition was persisted; the new state was not written.",
          recoveryAction: "reopen the installation, inspect the current Recovery Checkpoint, and retry the operation with its idempotency key",
          receipt: `installation=${this.installationId}; expected=${expectedStateDigest ?? "absent"}; actual=${actualStateDigest ?? "absent"}; overwritten=false`,
        });
      }
      await transaction.put(installationStateKey(this.installationId), clone(state));
    });
  }
}

/**
 * Named coordinator boundary kept small so the Worker Durable Object can
 * construct one store per installation without exposing state routes.
 */
export class CustomerRealmDurableObjectCoordinator {
  constructor(private readonly storage: CustomerRealmDurableObjectStorage) {}

  installationStore(installationId: string): CustomerRealmDurableObjectInstallationStore {
    return new CustomerRealmDurableObjectInstallationStore(this.storage, installationId);
  }
}

export type CustomerRealmR2Object = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type CustomerRealmR2Bucket = {
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<CustomerRealmR2Object | null>;
};

export type CustomerRealmRecoveryObjectReceipt = {
  digest: string;
  key: string;
  bytes: number;
  credentialFree: true;
  authority: "durable-object-coordinator";
  receipt: string;
};

function invalidRecovery(input: { message: string; receipt: string }): CustomerRealmPersistenceError {
  return new CustomerRealmPersistenceError({
    code: "recovery_invalid",
    message: input.message,
    recoveryAction: "restore a verified credential-free Recovery bundle and rerun the recovery check",
    receipt: input.receipt,
  });
}

function assertRecoveryBundle(bundle: CustomerRealmRecoveryBundle): void {
  let verification: ReturnType<typeof verifyCustomerRealmRecoveryBundle>;
  try {
    verification = verifyCustomerRealmRecoveryBundle(bundle);
  } catch (error) {
    throw invalidRecovery({
      message: "Recovery bundle is malformed; authority was not resumed.",
      receipt: `verification=exception; cause=${error instanceof Error ? error.name : "unknown"}`,
    });
  }
  if (verification.status !== "verified") {
    throw invalidRecovery({ message: `Recovery bundle failed verification: ${verification.errors.join("; ")}.`, receipt: verification.receipt });
  }
}

/**
 * Immutable, credential-free R2 object boundary. R2 stores bytes by digest;
 * the Durable Object remains the owner of installation state and references.
 */
export class CustomerRealmRecoveryObjectStore {
  constructor(private readonly bucket: CustomerRealmR2Bucket) {}

  async put(bundle: CustomerRealmRecoveryBundle): Promise<CustomerRealmRecoveryObjectReceipt> {
    assertRecoveryBundle(bundle);
    const digest = customerRealmRecoveryBundleDigest(bundle);
    const payload = JSON.stringify(clone(bundle));
    const bytes = new TextEncoder().encode(payload).byteLength;
    const key = recoveryObjectKey(digest);
    // A content address is write-once from Anyam's perspective. If the key is
    // already present, verify the existing bytes and never replace them.
    if (await this.bucket.get(key)) {
      await this.get(digest);
      return {
        digest,
        key,
        bytes,
        credentialFree: true,
        authority: "durable-object-coordinator",
        receipt: `key=${key}; digest=${digest}; bytes=${bytes}; credentialFree=true; authority=durable-object-coordinator; idempotent=true`,
      };
    }
    await this.bucket.put(key, payload, {
      customMetadata: {
        protocol: bundle.protocol,
        digest,
        credentialFree: "true",
      },
    });
    return {
      digest,
      key,
      bytes,
      credentialFree: true,
      authority: "durable-object-coordinator",
      receipt: `key=${key}; digest=${digest}; bytes=${bytes}; credentialFree=true; authority=durable-object-coordinator`,
    };
  }

  async get(digest: string): Promise<CustomerRealmRecoveryBundle> {
    assertRecoveryDigest(digest);
    const key = recoveryObjectKey(digest);
    const object = await this.bucket.get(key);
    if (!object) {
      throw new CustomerRealmPersistenceError({
        code: "recovery_not_found",
        message: `No Recovery bundle exists for digest ${digest}.`,
        recoveryAction: "restore the owner-visible Recovery bundle at its recorded immutable digest, then retry",
        receipt: `key=${key}; digest=${digest}; found=false`,
      });
    }
    let parsed: unknown;
    try {
      const bytes = await object.arrayBuffer();
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw invalidRecovery({ message: "Recovery object is not readable JSON; authority was not resumed.", receipt: `key=${key}; parse=${error instanceof Error ? error.name : "unknown"}` });
    }
    if (!parsed || typeof parsed !== "object") {
      throw invalidRecovery({ message: "Recovery object is not a bundle object; authority was not resumed.", receipt: `key=${key}; object=not-an-object` });
    }
    const bundle = parsed as CustomerRealmRecoveryBundle;
    assertRecoveryBundle(bundle);
    const actualDigest = customerRealmRecoveryBundleDigest(bundle);
    if (actualDigest !== digest || bundle.integrity.digest !== digest) {
      throw new CustomerRealmPersistenceError({
        code: "recovery_digest_mismatch",
        message: "Recovery object content does not match its requested immutable digest; authority was not resumed.",
        recoveryAction: "restore the exact owner-visible bundle bytes at the declared digest and rerun the recovery check",
        receipt: `key=${key}; expected=${digest}; actual=${actualDigest}; declared=${bundle.integrity.digest}`,
      });
    }
    return clone(bundle);
  }
}
