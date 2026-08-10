/// <reference types="@cloudflare/workers-types" />

import {
  type CustomerProviderAdapterSet,
  type CustomerProviderCleanupReceipt,
  type CustomerProviderOperationObservation,
  type CustomerProviderReadBack,
  type CustomerProviderSurface,
} from "../../../src/cloudflare/customer-provider-operation.ts";

export type CloudflareCustomerProviderBindings = {
  metadata: D1Database;
  exports: R2Bucket;
  events: Queue<Record<string, unknown>>;
  workflow: Workflow<Record<string, unknown>>;
  worker?: Fetcher;
  workerUrl?: string;
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

function observationFailure(surface: CustomerProviderSurface, operationId: string, mode: string): CustomerProviderOperationObservation {
  const providerOperationId = `provider:${surface}:${operationId}`;
  return {
    status: mode === "timeout" ? "indeterminate" : "failed",
    providerOperationId,
    providerStatus: mode === "timeout" ? "timeout" : mode === "authorization-revoked" ? "401-authorization-revoked" : mode,
    partialEffects: [],
    retryable: mode !== "authorization-revoked",
    recoveryAction: mode === "authorization-revoked" ? "restore the customer provider authorization and retry the same operation identity" : "retry the same operation identity after inspecting the authoritative checkpoint",
    receipt: `provider=${surface}; operation=${operationId}; injectedFailure=${mode}; credentialMaterialStored=false`,
  };
}

function mutationFailure(input: { surface: CustomerProviderSurface; operationId: string; failureMode: string; providerOperationId: string; outputDigest: string; resourceKey: string }): CustomerProviderOperationObservation {
  return {
    status: "failed",
    providerOperationId: input.providerOperationId,
    providerStatus: input.failureMode,
    outputDigest: input.outputDigest,
    partialEffects: [input.resourceKey],
    retryable: true,
    recoveryAction: "inspect the provider object and retry the same operation identity; the adapter must not create a second effect",
    receipt: `provider=${input.surface}; operation=${input.operationId}; failureMode=${input.failureMode}; partialEffect=${input.resourceKey}; idempotency=required`,
  };
}

function shouldInjectFailure(mode: string): boolean {
  return mode === "provider-outage" || mode === "authorization-revoked" || mode === "timeout" || mode === "duplicate-delivery" || mode === "partial-mutation";
}

async function claimInjectedFailure(bindings: CloudflareCustomerProviderBindings, input: { operationId: string; surface: CustomerProviderSurface; failureMode: string }): Promise<boolean> {
  if (!shouldInjectFailure(input.failureMode)) return false;
  await bindings.metadata.exec("CREATE TABLE IF NOT EXISTS anyam_provider_qualification_failures (failure_key TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
  const failureKey = `${input.surface}:${input.operationId}:${input.failureMode}`;
  const result = await bindings.metadata.prepare("INSERT OR IGNORE INTO anyam_provider_qualification_failures (failure_key, created_at) VALUES (?1, ?2)").bind(failureKey, new Date().toISOString()).run();
  return (result.meta.changes ?? 0) === 1;
}

async function readR2Object(bucket: R2Bucket, key: string): Promise<{ bytes: Uint8Array; digest: string } | undefined> {
  const object = await bucket.get(key);
  if (!object) return undefined;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return { bytes, digest: await digest(bytes) };
}

function cleanupReceipt(input: { surface: CustomerProviderSurface; operationId: string; deletedResourceKeys: readonly string[]; remainingResourceKeys?: readonly string[]; recoveryAction?: string }): CustomerProviderCleanupReceipt {
  return {
    status: "succeeded",
    deletedResourceKeys: [...input.deletedResourceKeys],
    remainingResourceKeys: [...(input.remainingResourceKeys ?? [])],
    receipt: `provider=${input.surface}; operation=${input.operationId}; deleted=${input.deletedResourceKeys.length}; remaining=${input.remainingResourceKeys?.length ?? 0}; exact=true`,
    recoveryAction: input.recoveryAction ?? "No recovery action is currently required.",
  };
}

/**
 * Cloudflare provider adapters for the bounded qualification surface. The
 * adapters never receive Anyam bearer credentials and return provider facts as
 * observations; the Durable Object coordinator remains authoritative.
 */
export function createCloudflareCustomerProviderAdapters(bindings: CloudflareCustomerProviderBindings): CustomerProviderAdapterSet {
  const d1: CustomerProviderAdapterSet["d1"] = {
    execute: async (input) => {
      const injected = await claimInjectedFailure(bindings, input);
      if (injected && ["provider-outage", "authorization-revoked", "timeout"].includes(input.failureMode)) return observationFailure(input.surface, input.operationId, input.failureMode);
      const providerOperationId = `d1:${input.operationId}`;
      const outputDigest = await digest({ surface: input.surface, operationId: input.operationId, payloadDigest: input.payloadDigest });
      await bindings.metadata.exec("CREATE TABLE IF NOT EXISTS anyam_provider_qualification (resource_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, provider_operation_id TEXT NOT NULL, output_digest TEXT NOT NULL, created_at TEXT NOT NULL)");
      await bindings.metadata.prepare("INSERT OR IGNORE INTO anyam_provider_qualification (resource_key, operation_id, provider_operation_id, output_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(input.resourceKey, input.operationId, providerOperationId, outputDigest, new Date().toISOString()).run();
      if (injected && ["duplicate-delivery", "partial-mutation"].includes(input.failureMode)) return mutationFailure({ ...input, providerOperationId, outputDigest });
      return { status: "accepted", providerOperationId, providerStatus: "accepted", outputDigest, partialEffects: [], retryable: false, recoveryAction: "No recovery action is currently required.", receipt: `provider=d1; operation=${input.operationId}; table=anyam_provider_qualification; accepted=true` };
    },
    readBack: async (input) => {
      const row = await bindings.metadata.prepare("SELECT provider_operation_id AS providerOperationId, output_digest AS outputDigest FROM anyam_provider_qualification WHERE resource_key = ?1").bind(input.resourceKey).first<{ providerOperationId: string; outputDigest: string }>();
      if (!row) return { providerOperationId: input.providerOperationId, status: "absent", resourceKeys: [], receipt: `provider=d1; operation=${input.operationId}; readBack=absent` };
      return { providerOperationId: row.providerOperationId, status: "present", digest: row.outputDigest, resourceKeys: [input.resourceKey], receipt: `provider=d1; operation=${input.operationId}; readBack=verified; digest=${row.outputDigest}` };
    },
    cleanup: async (input) => {
      await bindings.metadata.exec("CREATE TABLE IF NOT EXISTS anyam_provider_qualification (resource_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, provider_operation_id TEXT NOT NULL, output_digest TEXT NOT NULL, created_at TEXT NOT NULL)");
      await bindings.metadata.exec("CREATE TABLE IF NOT EXISTS anyam_provider_qualification_failures (failure_key TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
      await bindings.metadata.prepare("DELETE FROM anyam_provider_qualification WHERE resource_key = ?1").bind(input.resourceKey).run();
      await bindings.metadata.prepare("DELETE FROM anyam_provider_qualification_failures WHERE failure_key LIKE ?1").bind(`${input.surface}:${input.operationId}:%`).run();
      const remaining = await bindings.metadata.prepare("SELECT resource_key AS resourceKey FROM anyam_provider_qualification WHERE resource_key = ?1").bind(input.resourceKey).all<{ resourceKey: string }>();
      return cleanupReceipt({ surface: "d1", operationId: input.operationId, deletedResourceKeys: [input.resourceKey], remainingResourceKeys: remaining.results.map((row) => row.resourceKey), recoveryAction: remaining.results.length === 0 ? "No recovery action is currently required." : "The D1 qualification row remains; inspect the exact resource key before deleting the disposable database." });
    },
  };

  const r2: CustomerProviderAdapterSet["r2"] = {
    execute: async (input) => {
      const injected = await claimInjectedFailure(bindings, input);
      if (injected && ["provider-outage", "authorization-revoked", "timeout"].includes(input.failureMode)) return observationFailure(input.surface, input.operationId, input.failureMode);
      const providerOperationId = `r2:${input.operationId}`;
      const bytes = new TextEncoder().encode(JSON.stringify({ protocol: "anyam.customer-provider-operation/v1", operationId: input.operationId, payloadDigest: input.payloadDigest }));
      const outputDigest = await digest(bytes);
      await bindings.exports.put(input.resourceKey, bytes, { customMetadata: { protocol: "anyam.customer-provider-operation/v1", operationId: input.operationId, digest: outputDigest } });
      if (injected && ["duplicate-delivery", "partial-mutation"].includes(input.failureMode)) return mutationFailure({ ...input, providerOperationId, outputDigest });
      return { status: "accepted", providerOperationId, providerStatus: "accepted", outputDigest, partialEffects: [], retryable: false, recoveryAction: "No recovery action is currently required.", receipt: `provider=r2; operation=${input.operationId}; key=${input.resourceKey}; accepted=true` };
    },
    readBack: async (input) => {
      const object = await readR2Object(bindings.exports, input.resourceKey);
      if (!object) return { providerOperationId: input.providerOperationId, status: "absent", resourceKeys: [], receipt: `provider=r2; operation=${input.operationId}; readBack=absent` };
      return { providerOperationId: input.providerOperationId, status: "present", digest: object.digest, resourceKeys: [input.resourceKey], receipt: `provider=r2; operation=${input.operationId}; readBack=verified; digest=${object.digest}` };
    },
    cleanup: async (input) => {
      await bindings.exports.delete(input.resourceKey);
      const remaining = await bindings.exports.head(input.resourceKey);
      return cleanupReceipt({ surface: "r2", operationId: input.operationId, deletedResourceKeys: remaining ? [] : [input.resourceKey], remainingResourceKeys: remaining ? [input.resourceKey] : [], recoveryAction: remaining ? "The R2 qualification object remains; retry exact-key deletion before deleting the disposable bucket." : "No recovery action is currently required." });
    },
  };

  const queue: CustomerProviderAdapterSet["queue"] = {
    execute: async (input) => {
      const injected = await claimInjectedFailure(bindings, input);
      if (injected && ["provider-outage", "authorization-revoked", "timeout"].includes(input.failureMode)) return observationFailure(input.surface, input.operationId, input.failureMode);
      const providerOperationId = `queue:${input.operationId}`;
      const outputDigest = await digest({ surface: input.surface, operationId: input.operationId, payloadDigest: input.payloadDigest });
      const message = { protocol: "anyam.customer-provider-operation/v1", realmId: input.realmId, installationId: input.installationId, operationId: input.operationId, providerOperationId, idempotencyKey: input.idempotencyKey, resourceKey: input.resourceKey, expectedStateDigest: input.expectedStateDigest, outputDigest };
      await bindings.events.send(message, { contentType: "json" });
      if (injected && input.failureMode === "duplicate-delivery") await bindings.events.send(message, { contentType: "json" });
      if (injected && ["duplicate-delivery", "partial-mutation"].includes(input.failureMode)) return { ...mutationFailure({ ...input, providerOperationId, outputDigest }), status: "indeterminate", providerStatus: "transport-duplicate-or-partial", recoveryAction: "wait for the Queue result consumer to reconcile the provider operation and acknowledge only after the coordinator accepts the result envelope" };
      return { status: "indeterminate", providerOperationId, providerStatus: "transport-accepted", outputDigest, partialEffects: [], retryable: true, recoveryAction: "wait for the Queue result consumer to reconcile the provider operation and acknowledge only after the coordinator accepts the result envelope", receipt: `provider=queue; operation=${input.operationId}; transport=accepted; queueAck=deferred` };
    },
    readBack: async (input) => ({ providerOperationId: input.providerOperationId, status: "present", ...(input.expectedDigest ? { digest: input.expectedDigest } : {}), resourceKeys: [input.resourceKey], receipt: `provider=queue; operation=${input.operationId}; readBack=transport-accepted; queueAck=deferred` }),
    cleanup: async (input) => cleanupReceipt({ surface: "queue", operationId: input.operationId, deletedResourceKeys: [], recoveryAction: "Queue messages are immutable transport observations; verify the disposable queue is drained before deleting the queue resource." }),
  };

  const workflow: CustomerProviderAdapterSet["workflow"] = {
    execute: async (input) => {
      const injected = await claimInjectedFailure(bindings, input);
      if (injected && ["provider-outage", "authorization-revoked", "timeout"].includes(input.failureMode)) return observationFailure(input.surface, input.operationId, input.failureMode);
      const providerOperationId = `workflow:${input.operationId}`;
      const outputDigest = await digest({ surface: input.surface, operationId: input.operationId, payloadDigest: input.payloadDigest });
      try {
        await bindings.workflow.create({ id: providerOperationId, params: { protocol: "anyam.customer-provider-operation/v1", realmId: input.realmId, installationId: input.installationId, operationId: input.operationId, providerOperationId, expectedStateDigest: input.expectedStateDigest, payloadDigest: input.payloadDigest, outputDigest } });
      } catch (error) {
        try {
          await bindings.workflow.get(providerOperationId);
        } catch {
          throw error;
        }
      }
      if (injected && ["duplicate-delivery", "partial-mutation"].includes(input.failureMode)) return mutationFailure({ ...input, providerOperationId, outputDigest });
      return { status: "indeterminate", providerOperationId, providerStatus: "instance-created", outputDigest, partialEffects: [], retryable: true, recoveryAction: "wait for the Workflow callback to reconcile the provider operation and accept the result through the Anyam checkpoint", receipt: `provider=workflow; operation=${input.operationId}; instance=${providerOperationId}; created=true; callback=deferred` };
    },
    readBack: async (input) => {
      try {
        const instance = await bindings.workflow.get(input.providerOperationId);
        const status = await instance.status();
        return { providerOperationId: input.providerOperationId, status: "present", ...(input.expectedDigest ? { digest: input.expectedDigest } : {}), resourceKeys: [input.resourceKey], receipt: `provider=workflow; operation=${input.operationId}; instanceStatus=${status.status}; observed=true` };
      } catch (error) {
        return { providerOperationId: input.providerOperationId, status: "indeterminate", resourceKeys: [], receipt: `provider=workflow; operation=${input.operationId}; readBack=exception; cause=${error instanceof Error ? error.name : "unknown"}` };
      }
    },
    cleanup: async (input) => {
      try {
        await bindings.workflow.get(input.providerOperationId ?? `workflow:${input.operationId}`).then((instance) => instance.terminate({ rollback: true }));
      } catch {
        // A complete or already-terminated instance is reconciled by the
        // post-cleanup status check rather than treated as a new mutation.
      }
      return cleanupReceipt({ surface: "workflow", operationId: input.operationId, deletedResourceKeys: [input.providerOperationId ?? `workflow:${input.operationId}`] });
    },
  };

  const worker: CustomerProviderAdapterSet["worker"] = {
    execute: async (input) => {
      const injected = await claimInjectedFailure(bindings, input);
      if (injected && ["provider-outage", "authorization-revoked", "timeout"].includes(input.failureMode)) return observationFailure(input.surface, input.operationId, input.failureMode);
      if (!bindings.worker || !bindings.workerUrl) return { status: "failed", providerOperationId: `worker:${input.operationId}`, providerStatus: "worker-target-unconfigured", partialEffects: [], retryable: false, recoveryAction: "Configure the owner-approved disposable Worker target URL and retry the bounded operation.", receipt: `provider=worker; operation=${input.operationId}; target=missing; mutation=not-performed` };
      const providerOperationId = `worker:${input.operationId}`;
      const response = await bindings.worker.fetch(bindings.workerUrl, { method: "POST", headers: { "content-type": "application/json", "x-anyam-qualification-operation": input.operationId }, body: JSON.stringify({ protocol: "anyam.customer-provider-operation/v1", operationId: input.operationId, payloadDigest: input.payloadDigest }) });
      const body = await response.arrayBuffer();
      const outputDigest = await digest(new Uint8Array(body));
      if (injected && ["duplicate-delivery", "partial-mutation"].includes(input.failureMode)) return mutationFailure({ ...input, providerOperationId, outputDigest });
      return { status: response.ok ? "accepted" : "failed", providerOperationId, providerStatus: `http-${response.status}`, outputDigest, partialEffects: [], retryable: !response.ok && response.status >= 500, recoveryAction: response.ok ? "No recovery action is currently required." : "inspect the disposable Worker target and retry the same operation identity", receipt: `provider=worker; operation=${input.operationId}; status=${response.status}; target=${bindings.workerUrl}` };
    },
    readBack: async (input) => {
      if (!bindings.worker || !bindings.workerUrl) return { providerOperationId: input.providerOperationId, status: "indeterminate", resourceKeys: [], receipt: `provider=worker; operation=${input.operationId}; target=missing` };
      const response = await bindings.worker.fetch(`${bindings.workerUrl}?operationId=${encodeURIComponent(input.operationId)}`, { headers: { "x-anyam-qualification-readback": "true" } });
      const body = await response.arrayBuffer();
      const readBackDigest = await digest(new Uint8Array(body));
      return { providerOperationId: input.providerOperationId, status: response.ok ? "present" : "indeterminate", digest: readBackDigest, resourceKeys: [input.resourceKey], receipt: `provider=worker; operation=${input.operationId}; readBackStatus=${response.status}; digest=${readBackDigest}` };
    },
    cleanup: async (input) => cleanupReceipt({ surface: "worker", operationId: input.operationId, deletedResourceKeys: [], recoveryAction: "Worker qualification targets are immutable observations; delete the disposable target Worker through the owner-controlled deployment account." }),
  };

  return { d1, r2, queue, workflow, worker };
}
