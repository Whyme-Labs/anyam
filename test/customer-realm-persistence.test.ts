import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomerRealmDurableObjectCoordinator,
  CustomerRealmPersistenceError,
  CustomerRealmRecoveryObjectStore,
  type CustomerRealmDurableObjectStorage,
  type CustomerRealmR2Bucket,
} from "../src/cloudflare/customer-realm-persistence.ts";
import {
  CustomerRealmInstallation,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmProjectImporter,
  type CustomerRealmCloudflareAdapter,
  type CustomerRealmImportReceipt,
} from "../src/installation/customer-realm.ts";

class MemoryDurableObjectStorage implements CustomerRealmDurableObjectStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)) as T);
  }

  async transaction<T>(closure: (transaction: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }) => Promise<T>): Promise<T> {
    return closure({
      get: <Value>(key: string) => this.get<Value>(key),
      put: <Value>(key: string, value: Value) => this.put(key, value),
    });
  }
}

class MemoryR2Bucket implements CustomerRealmR2Bucket {
  private readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      arrayBuffer: async () => new TextEncoder().encode(value).buffer,
    };
  }

  setRaw(key: string, value: unknown): void {
    this.objects.set(key, JSON.stringify(value));
  }
}

class FailOnceProvisionAdapter implements CustomerRealmCloudflareAdapter {
  private failed = true;

  constructor(private readonly delegate: InMemoryCustomerRealmCloudflareAdapter) {}

  inspectAccount(input: Parameters<CustomerRealmCloudflareAdapter["inspectAccount"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["inspectAccount"]> {
    return this.delegate.inspectAccount(input);
  }

  async provisionRealm(input: Parameters<CustomerRealmCloudflareAdapter["provisionRealm"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["provisionRealm"]> {
    if (this.failed) {
      this.failed = false;
      return {
        status: "failed",
        errorCode: "test.provider_outage",
        message: "Injected provider outage for the persistence recovery test.",
        retryable: true,
        failureKind: "provider-outage",
        affectedObject: input.installationId,
        operationId: input.operationId,
        partialEffects: [],
        recoveryAction: "retry the same provisioning operation after inspecting the customer account",
        receipt: `operation=${input.operationId}; failureKind=provider-outage`,
      };
    }
    return this.delegate.provisionRealm(input);
  }

  inspectProvision(input: Parameters<CustomerRealmCloudflareAdapter["inspectProvision"]>[0]): ReturnType<CustomerRealmCloudflareAdapter["inspectProvision"]> {
    return this.delegate.inspectProvision(input);
  }
}

function importReceipt(): CustomerRealmImportReceipt {
  return {
    projectRevisionId: "project-revision:persistence",
    sourceSpaceIds: [],
    exportDigest: "sha256:unused",
    checkpointId: "checkpoint:persistence",
    state: "verified",
    partialEffects: [],
    receipt: "persistence-test-import=not-used",
  };
}

async function installIntoStore(input: {
  installationId: string;
  store: ReturnType<CustomerRealmDurableObjectCoordinator["installationStore"]>;
  cloudflare?: CustomerRealmCloudflareAdapter;
}): Promise<CustomerRealmInstallation> {
  const installation = new CustomerRealmInstallation({
    installationId: input.installationId,
    store: input.store,
    cloudflare: input.cloudflare ?? new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter(importReceipt()),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  await installation.install({
    accountId: "account:customer",
    requestedResourceTypes: ["d1", "r2"],
    ownerConfirmed: true,
    operationId: `operation:${input.installationId}`,
    idempotencyKey: `idempotency:${input.installationId}`,
  });
  return installation;
}

test("Durable Object coordinator persists and reopens installation state with pending commands and checkpoints", async () => {
  const storage = new MemoryDurableObjectStorage();
  const coordinator = new CustomerRealmDurableObjectCoordinator(storage);
  const store = coordinator.installationStore("installation:persistence");
  const installation = await installIntoStore({ installationId: "installation:persistence", store });
  const saved = installation.snapshot;

  const reopened = await CustomerRealmInstallation.open({
    installationId: "installation:persistence",
    store,
    cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter(importReceipt()),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });

  assert.deepEqual(reopened.snapshot, saved);
  assert.equal(reopened.snapshot.checkpoint.stateDigest, saved.checkpoint.stateDigest);
  assert.equal(reopened.snapshot.pendingCommands.every((command) => command.status === "succeeded"), true);
  assert.match(reopened.snapshot.checkpoint.receipt, /stateDigest=sha256:/);
});

test("stale installation transition fails closed with an actionable CAS receipt and preserves the winner", async () => {
  const storage = new MemoryDurableObjectStorage();
  const coordinator = new CustomerRealmDurableObjectCoordinator(storage);
  const store = coordinator.installationStore("installation:stale");
  await installIntoStore({ installationId: "installation:stale", store });
  const common = {
    installationId: "installation:stale",
    store,
    cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter(importReceipt()),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  } as const;
  const first = await CustomerRealmInstallation.open(common);
  const stale = await CustomerRealmInstallation.open(common);

  await first.enrollOwner({
    displayName: "Realm Owner",
    passkeyCredentialId: "passkey:first",
    passkeyVerified: true,
    recovery: { method: "external-recovery-codes", enrollmentReceipt: "external:first", materialDigest: "sha256:external" },
    principalId: "principal:first",
  });
  await assert.rejects(
    stale.enrollOwner({
      displayName: "Stale Owner",
      passkeyCredentialId: "passkey:stale",
      passkeyVerified: true,
      recovery: { method: "external-recovery-codes", enrollmentReceipt: "external:stale", materialDigest: "sha256:external" },
      principalId: "principal:stale",
    }),
    (error: unknown) => error instanceof CustomerRealmPersistenceError
      && error.code === "stale_state"
      && error.receipt.includes("overwritten=false")
      && error.recoveryAction.includes("reopen"),
  );

  const winner = await store.load("installation:stale");
  assert.equal(winner?.owner?.principalId, "principal:first");
  assert.equal(stale.snapshot.phase, "realm-ready");
});

test("customer provider outage survives restart and resumes the same checkpoint and idempotent operation", async () => {
  const storage = new MemoryDurableObjectStorage();
  const coordinator = new CustomerRealmDurableObjectCoordinator(storage);
  const store = coordinator.installationStore("installation:outage");
  const delegate = new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]);
  const cloudflare = new FailOnceProvisionAdapter(delegate);
  const first = await installIntoStore({ installationId: "installation:outage", store, cloudflare });
  assert.equal(first.snapshot.phase, "degraded");
  const degradedCheckpoint = first.snapshot.degraded?.checkpointId;
  assert.ok(degradedCheckpoint);
  const pending = first.snapshot.pendingCommands.find((command) => command.operation === "realm.provision");
  assert.ok(pending);

  const restarted = await CustomerRealmInstallation.open({
    installationId: "installation:outage",
    store,
    cloudflare,
    importer: new InMemoryCustomerRealmProjectImporter(importReceipt()),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  const recovered = await restarted.recover();
  assert.equal(recovered.phase, "realm-ready");
  assert.equal(recovered.degraded, undefined);
  assert.equal(recovered.pendingCommands.find((command) => command.operation === "realm.provision")?.operationId, pending.operationId);
  assert.equal(recovered.audit.some((event) => event.checkpointId === degradedCheckpoint), true);

  const reopened = await CustomerRealmInstallation.open({
    installationId: "installation:outage",
    store,
    cloudflare: delegate,
    importer: new InMemoryCustomerRealmProjectImporter(importReceipt()),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  assert.equal(reopened.snapshot.phase, "realm-ready");
  assert.equal(reopened.snapshot.pendingCommands.find((command) => command.operation === "realm.provision")?.status, "succeeded");
});

test("R2 Recovery object boundary stores immutable credential-free bundles by digest and fails closed", async () => {
  const storage = new MemoryDurableObjectStorage();
  const coordinator = new CustomerRealmDurableObjectCoordinator(storage);
  const installation = await installIntoStore({ installationId: "installation:recovery-object", store: coordinator.installationStore("installation:recovery-object") });
  const bundle = await installation.exportRecovery({});
  const bucket = new MemoryR2Bucket();
  const objects = new CustomerRealmRecoveryObjectStore(bucket);
  const receipt = await objects.put(bundle);

  assert.equal(receipt.digest, bundle.integrity.digest);
  assert.equal(receipt.credentialFree, true);
  assert.equal(receipt.authority, "durable-object-coordinator");
  assert.equal((await objects.get(receipt.digest)).integrity.digest, receipt.digest);
  assert.match((await objects.put(bundle)).receipt, /idempotent=true/);
  assert.equal(JSON.stringify(bundle).includes("token"), false);
  await assert.rejects(objects.get("sha256:" + "0".repeat(64)), (error: unknown) => error instanceof CustomerRealmPersistenceError && error.code === "recovery_not_found");

  bucket.setRaw("anyam/customer-realm/recovery/v1/sha256:" + "1".repeat(64), bundle);
  await assert.rejects(objects.get("sha256:" + "1".repeat(64)), (error: unknown) => error instanceof CustomerRealmPersistenceError && error.code === "recovery_digest_mismatch");

  bucket.setRaw("anyam/customer-realm/recovery/v1/sha256:" + "2".repeat(64), { ...bundle, token: "credential-material" });
  await assert.rejects(objects.get("sha256:" + "2".repeat(64)), (error: unknown) => error instanceof CustomerRealmPersistenceError && error.code === "recovery_invalid" && error.message.includes("credential"));

  bucket.setRaw("anyam/customer-realm/recovery/v1/sha256:" + "3".repeat(64), { protocol: bundle.protocol, version: bundle.version });
  await assert.rejects(objects.get("sha256:" + "3".repeat(64)), (error: unknown) => error instanceof CustomerRealmPersistenceError && error.code === "recovery_invalid" && error.message.includes("malformed"));
});
