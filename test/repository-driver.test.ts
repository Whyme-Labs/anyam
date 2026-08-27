import assert from "node:assert/strict";
import test from "node:test";

import driver, { repositoryDriverSnapshotDigest, repositoryDriverSnapshotIndexKey, repositoryDriverSnapshotManifestKey, REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, type Env as RepositoryDriverEnv, type RepositoryDriverSnapshotIndex, type RepositoryDriverSnapshotManifest } from "../apps/repository-driver/src/index.ts";
import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL } from "../src/portability/repository-observation.ts";

const baseCommit = "0".repeat(40);
const headCommit = "1".repeat(40);
const treeCommit = "2".repeat(40);
const repositoryId = "repo:driver";
const sourceSpaceId = "source:driver";
const workspaceId = "workspace:driver";
const projectViewId = "view:driver";
const manifestPrefix = "repositories/";

function activeObservedAt(): string {
  return new Date(Date.now() - 1_000).toISOString();
}

function activeExpiresAt(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

class MemoryBucket {
  private readonly values = new Map<string, string>();

  put(key: string, value: string): void {
    this.values.set(key, value);
  }

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const response = new Response(value);
    const body = response.body;
    if (!body) throw new Error("memory_bucket_body_missing");
    return { body };
  }
}

function manifest(state: RepositoryDriverSnapshotManifest["state"] = "active", overrides: Partial<RepositoryDriverSnapshotManifest> = {}): RepositoryDriverSnapshotManifest {
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, repositoryId, sourceSpaceId, context: { kind: "workspace", workspaceId, projectViewId, workspaceRef: "refs/heads/main" }, objectFormat: "sha1", symbolicRef: "refs/heads/main", commitOid: headCommit, treeOid: treeCommit, baseCommitOid: baseCommit, ancestorCommitOids: [baseCommit], generation: 1, state, observedAt: activeObservedAt(), expiresAt: activeExpiresAt(), receipt: "provider=fixture; credentialMaterialStored=false", ...overrides };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://repository-driver.example/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": "anyam.repository-observer/v1" }, body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId, projectViewId, expectedSymbolicRef: "refs/heads/main", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1", ...overrides }) });
}

function env(bucket: MemoryBucket): RepositoryDriverEnv {
  return { REPOSITORY_STATE: bucket as unknown as NonNullable<RepositoryDriverEnv["REPOSITORY_STATE"]>, REPOSITORY_DRIVER_MANIFEST_PREFIX: "repositories/", REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT: "receipt=repository-driver-test-measurement" };
}

async function indexFor(value: RepositoryDriverSnapshotManifest, previousGeneration: number | null = null): Promise<RepositoryDriverSnapshotIndex> {
  const context = value.context;
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, repositoryId: value.repositoryId, sourceSpaceId: value.sourceSpaceId, context, latestGeneration: value.generation, previousGeneration, latestManifestKey: repositoryDriverSnapshotManifestKey(manifestPrefix, value.repositoryId, context, value.generation), latestManifestDigest: await repositoryDriverSnapshotDigest(value), updatedAt: "2099-01-02T00:00:00.000Z", receipt: "provider=fixture; index=monotonic; credentialMaterialStored=false" };
}

async function seed(bucket: MemoryBucket, value: RepositoryDriverSnapshotManifest, indexOverrides: Partial<RepositoryDriverSnapshotIndex> = {}): Promise<void> {
  const index = { ...await indexFor(value), ...indexOverrides };
  bucket.put(repositoryDriverSnapshotManifestKey(manifestPrefix, value.repositoryId, value.context, value.generation), JSON.stringify(value));
  bucket.put(repositoryDriverSnapshotIndexKey(manifestPrefix, value.repositoryId, value.context), JSON.stringify(index));
}

test("customer RepositoryDriver and Observer compose an exact R2-backed observation", async () => {
  const bucket = new MemoryBucket();
  await seed(bucket, manifest());
  const driverEnv = env(bucket);
  const binding = { fetch: (requestValue: Request) => driver.fetch(requestValue, driverEnv) } as unknown as Fetcher;
  const observerEnv: RepositoryObserverEnv = { REPOSITORY_DRIVER: binding, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=repository-observer-test-measurement", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "1000", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT: "receipt=repository-observer-test-timeout-measurement" };
  const response = await observer.fetch(request(), observerEnv);
  assert.equal(response.status, 200);
  const value = await response.json();
  const parsed = parseRepositoryObservationServiceResponse(value);
  assert.equal(parsed.valid, true);
  if (parsed.valid) {
    assert.equal(parsed.response.observation?.repositoryId, repositoryId);
    assert.equal(parsed.response.observation?.ancestryVerified, true);
    assert.match(parsed.response.receipt, /repositoryObserver=anyam\.repository-observer\/v1/u);
  }
});

test("RepositoryDriver rejects invented heads and non-ancestor bases with actionable receipts", async () => {
  const bucket = new MemoryBucket();
  await seed(bucket, manifest());
  const driverEnv = env(bucket);
  const forgedHead = await driver.fetch(request({ expectedCommitOid: "3".repeat(40) }), driverEnv);
  assert.equal(forgedHead.status, 409);
  assert.equal((await forgedHead.json() as Record<string, unknown>).code, "repository_driver_snapshot_mismatch");
  const forgedBase = await driver.fetch(request({ expectedBaseCommitOid: "4".repeat(40) }), driverEnv);
  assert.equal(forgedBase.status, 409);
  const forgedBaseValue = await forgedBase.json() as Record<string, unknown>;
  assert.equal(forgedBaseValue.code, "repository_driver_snapshot_mismatch");
  assert.match(String(forgedBaseValue.receipt), /mismatch=baseCommitOid,ancestry/u);
});

test("RepositoryDriver blocks revoked installations and reports deleted snapshots as unavailable", async () => {
  const revokedBucket = new MemoryBucket();
  await seed(revokedBucket, manifest("revoked"));
  const revoked = await driver.fetch(request(), env(revokedBucket));
  assert.equal(revoked.status, 409);
  assert.equal((await revoked.json() as Record<string, unknown>).code, "repository_driver_installation_revoked");
  const staleBucket = new MemoryBucket();
  await seed(staleBucket, manifest("stale"));
  const stale = await driver.fetch(request(), env(staleBucket));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as Record<string, unknown>).code, "repository_driver_snapshot_stale");
  const missing = await driver.fetch(request(), env(new MemoryBucket()));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json() as Record<string, unknown>).code, "repository_driver_snapshot_index_missing");
});

test("RepositoryDriver requires the private Observer binding and bounds malformed manifests", async () => {
  const bucket = new MemoryBucket();
  await seed(bucket, manifest());
  const noBinding = await driver.fetch(new Request("https://repository-driver.example/observe", { method: "POST", body: JSON.stringify({}) }), env(bucket));
  assert.equal(noBinding.status, 422);
  assert.equal((await noBinding.json() as Record<string, unknown>).code, "observer_protocol_required");
  const oversizedBucket = new MemoryBucket();
  const oversizedManifest = manifest("active", { receipt: "x".repeat(70_000) });
  await seed(oversizedBucket, oversizedManifest);
  const oversized = await driver.fetch(request(), { ...env(oversizedBucket), REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "1024" });
  assert.equal(oversized.status, 502);
  assert.equal((await oversized.json() as Record<string, unknown>).code, "repository_driver_state_budget_exceeded");
});

test("RepositoryDriver binds the requested Workspace, View, ref, expiry, and generation", async () => {
  const contextBucket = new MemoryBucket();
  const mismatchedContext = manifest();
  await seed(contextBucket, mismatchedContext, { context: { kind: "workspace", workspaceId: "workspace:other", projectViewId, workspaceRef: "refs/heads/main" } });
  const contextMismatch = await driver.fetch(request(), env(contextBucket));
  assert.equal(contextMismatch.status, 409);
  assert.equal((await contextMismatch.json() as Record<string, unknown>).code, "repository_driver_context_mismatch");

  const viewBucket = new MemoryBucket();
  await seed(viewBucket, manifest(), { context: { kind: "workspace", workspaceId, projectViewId: "view:other", workspaceRef: "refs/heads/main" } });
  const viewMismatch = await driver.fetch(request(), env(viewBucket));
  assert.equal(viewMismatch.status, 409);
  assert.equal((await viewMismatch.json() as Record<string, unknown>).code, "repository_driver_context_mismatch");

  const validBucket = new MemoryBucket();
  await seed(validBucket, manifest());
  const refMismatch = await driver.fetch(request({ expectedSymbolicRef: "refs/heads/feature" }), env(validBucket));
  assert.equal(refMismatch.status, 409);
  assert.equal((await refMismatch.json() as Record<string, unknown>).code, "repository_driver_snapshot_mismatch");

  const futureBucket = new MemoryBucket();
  const future = manifest("active", { observedAt: "2999-01-01T00:00:00.000Z", expiresAt: "3000-01-01T00:00:00.000Z" });
  await seed(futureBucket, future);
  const futureResponse = await driver.fetch(request(), env(futureBucket));
  assert.equal(futureResponse.status, 409);
  assert.equal((await futureResponse.json() as Record<string, unknown>).code, "repository_driver_snapshot_future");

  const expiredBucket = new MemoryBucket();
  const expired = manifest("active", { observedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" });
  await seed(expiredBucket, expired);
  const expiredResponse = await driver.fetch(request(), env(expiredBucket));
  assert.equal(expiredResponse.status, 409);
  assert.equal((await expiredResponse.json() as Record<string, unknown>).code, "repository_driver_snapshot_expired");

  const generationBucket = new MemoryBucket();
  const generation = manifest("active", { generation: 2 });
  await seed(generationBucket, generation, { latestGeneration: 2, previousGeneration: 2 });
  const invalidGeneration = await driver.fetch(request(), env(generationBucket));
  assert.equal(invalidGeneration.status, 502);
  assert.equal((await invalidGeneration.json() as Record<string, unknown>).code, "repository_driver_snapshot_index_invalid");
});

test("RepositoryDriver keeps concurrent Workspace heads in separate context keys", async () => {
  const bucket = new MemoryBucket();
  const first = manifest();
  const second = manifest("active", { commitOid: "3".repeat(40), treeOid: "4".repeat(40), context: { kind: "workspace", workspaceId: "workspace:second", projectViewId: "view:second", workspaceRef: "refs/heads/feature" }, symbolicRef: "refs/heads/feature" });
  await seed(bucket, first);
  await seed(bucket, second);
  const firstResponse = await driver.fetch(request(), env(bucket));
  assert.equal(firstResponse.status, 200);
  const secondResponse = await driver.fetch(request({ workspaceId: "workspace:second", projectViewId: "view:second", expectedSymbolicRef: "refs/heads/feature", expectedCommitOid: "3".repeat(40), expectedTreeOid: "4".repeat(40) }), env(bucket));
  assert.equal(secondResponse.status, 200);
  const value = await secondResponse.json() as { observation?: { workspaceId?: string; projectViewId?: string; symbolicRef?: string; commitOid?: string } };
  assert.equal(value.observation?.workspaceId, "workspace:second");
  assert.equal(value.observation?.projectViewId, "view:second");
  assert.equal(value.observation?.symbolicRef, "refs/heads/feature");
  assert.equal(value.observation?.commitOid, "3".repeat(40));
});
