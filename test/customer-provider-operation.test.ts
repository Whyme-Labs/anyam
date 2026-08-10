import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomerProviderOperationError,
  CustomerProviderQualificationCoordinator,
  InMemoryCustomerProviderAdapterSet,
  InMemoryCustomerProviderOperationStore,
  verifyCustomerProviderOperationRecord,
  type CustomerProviderOperationInput,
  type CustomerProviderOwnerAuthorization,
  type CustomerProviderSurface,
} from "../src/cloudflare/customer-provider-operation.ts";

const authorization: CustomerProviderOwnerAuthorization = {
  realmId: "realm:provider-qualification",
  principalId: "owner:provider-qualification",
  sessionId: "session:provider-qualification",
  capability: "provider.qualification",
  authorizationEpoch: "epoch:1",
  receipt: "owner-passkey=verified; capability=provider.qualification; credentialFree=true",
};

function makeCoordinator(store = new InMemoryCustomerProviderOperationStore(), adapters = new InMemoryCustomerProviderAdapterSet()): { coordinator: CustomerProviderQualificationCoordinator; store: InMemoryCustomerProviderOperationStore; adapters: InMemoryCustomerProviderAdapterSet } {
  return {
    coordinator: new CustomerProviderQualificationCoordinator({ realmId: authorization.realmId, installationId: "installation:provider-qualification", store, adapters, now: () => new Date("2026-08-10T00:00:00.000Z") }),
    store,
    adapters,
  };
}

function input(surface: CustomerProviderSurface, operationId: string, failureMode: CustomerProviderOperationInput["failureMode"] = "none"): CustomerProviderOperationInput {
  return {
    realmId: authorization.realmId,
    installationId: "installation:provider-qualification",
    operationId,
    idempotencyKey: `idempotency:${operationId}`,
    surface,
    failureMode,
    payloadDigest: `sha256:${surface.padEnd(64, "0")}`,
    authorization,
  };
}

test("the bounded fixture exercises every provider surface and verifies read-back before success", async () => {
  const { coordinator } = makeCoordinator();
  const surfaces: readonly CustomerProviderSurface[] = ["d1", "r2", "queue", "workflow", "worker"];
  for (const surface of surfaces) {
    const record = await coordinator.run(input(surface, `operation:${surface}`));
    assert.equal(record.state, "succeeded");
    assert.equal(record.surface, surface);
    assert.equal(record.credentialFree, true);
    assert.equal(record.canonicalWrite, false);
    assert.equal(record.outputDigest, record.readBackDigest);
    assert.match(record.providerReceipt ?? "", /accepted|idempotent/);
    assert.equal(verifyCustomerProviderOperationRecord(record).status, "verified");
  }
});

test("provider outage remains a durable degraded checkpoint and resumes with the same operation identity", async () => {
  const { coordinator } = makeCoordinator();
  const first = await coordinator.run(input("d1", "operation:outage", "provider-outage"));
  assert.equal(first.state, "degraded");
  assert.match(first.recoveryAction, /retry/);
  const resumed = await coordinator.resume(first.operationId, authorization);
  assert.equal(resumed.state, "succeeded");
  assert.equal(resumed.operationId, first.operationId);
  assert.equal(resumed.idempotencyKey, first.idempotencyKey);
  assert.ok(resumed.checkpoint.attempts > first.checkpoint.attempts);
});

test("provider authorization loss blocks without storing credentials and resumes after owner restores authority", async () => {
  const { coordinator, adapters } = makeCoordinator();
  adapters.revokeAuthorization();
  const blocked = await coordinator.run(input("r2", "operation:auth-loss"));
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.recoveryAction, /authorization/);
  assert.equal(/"(?:token|password|secret)"\s*:/.test(JSON.stringify(blocked)), false);
  adapters.restoreAuthorization();
  const recovered = await coordinator.resume(blocked.operationId, authorization);
  assert.equal(recovered.state, "succeeded");
});

test("partial provider mutation is recorded, retried idempotently, and cleaned exactly", async () => {
  const { coordinator, adapters } = makeCoordinator();
  const partial = await coordinator.run(input("r2", "operation:partial", "partial-mutation"));
  assert.equal(partial.state, "degraded");
  assert.deepEqual(partial.providerPartialEffects, [partial.resourceKey]);
  assert.equal(adapters.listProviderObjects().length, 1);
  const recovered = await coordinator.resume(partial.operationId, authorization);
  assert.equal(recovered.state, "succeeded");
  assert.equal(adapters.listProviderObjects().length, 1);
  const cleaned = await coordinator.cleanup(recovered.operationId, authorization);
  assert.equal(cleaned.cleanup?.status, "succeeded");
  assert.deepEqual(cleaned.cleanup?.deletedResourceKeys, [recovered.resourceKey]);
  assert.deepEqual(cleaned.cleanup?.remainingResourceKeys, []);
  assert.equal(adapters.listProviderObjects().length, 0);
});

test("duplicate operation identity is idempotent while a changed payload is rejected", async () => {
  const { coordinator } = makeCoordinator();
  const first = await coordinator.run(input("queue", "operation:duplicate"));
  const duplicate = await coordinator.run(input("queue", "operation:duplicate"));
  assert.deepEqual(duplicate, first);
  await assert.rejects(
    coordinator.run({ ...input("queue", "operation:duplicate"), payloadDigest: "sha256:changed" }),
    (error: unknown) => error instanceof CustomerProviderOperationError && error.code === "idempotency-conflict" && error.recoveryAction.includes("original surface"),
  );
});

test("late callbacks cannot overwrite a newer authoritative checkpoint", async () => {
  const { coordinator } = makeCoordinator();
  const record = await coordinator.run(input("workflow", "operation:callback"));
  const callback = await coordinator.acceptCallback({ operationId: record.operationId, authorization, providerOperationId: record.providerOperationId ?? "missing", expectedStateDigest: "sha256:stale", ...(record.outputDigest ? { outputDigest: record.outputDigest } : {}), receipt: "workflow-callback=late" });
  assert.deepEqual(callback, record);
  const current = await coordinator.resume(record.operationId, authorization);
  assert.deepEqual(current, record);
});

test("credential-free recovery export can restore records and rejects tampering", async () => {
  const first = makeCoordinator();
  await first.coordinator.run(input("worker", "operation:restore", "timeout"));
  const bundle = await first.coordinator.exportRecovery();
  assert.equal(bundle.integrity.credentialFree, true);
  assert.equal(JSON.stringify(bundle).includes("token"), false);

  const restored = makeCoordinator();
  await restored.coordinator.restoreRecovery(bundle);
  assert.equal((await restored.store.get("operation:restore"))?.state, "indeterminate");

  const tampered = { ...bundle, records: bundle.records.map((record) => ({ ...record, state: "succeeded" as const })) };
  await assert.rejects(
    restored.coordinator.restoreRecovery(tampered),
    (error: unknown) => error instanceof CustomerProviderOperationError && error.code === "recovery-invalid" && error.recoveryAction.includes("fresh exact Recovery"),
  );
});

test("owner authorization is checked before a provider adapter is called", async () => {
  const { coordinator } = makeCoordinator();
  await assert.rejects(
    coordinator.run({ ...input("d1", "operation:unauthorized"), authorization: { ...authorization, realmId: "realm:other" } }),
    (error: unknown) => error instanceof CustomerProviderOperationError && error.code === "unauthorized" && error.receipt.includes("mutation=not-performed"),
  );
});
