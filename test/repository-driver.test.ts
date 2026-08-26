import assert from "node:assert/strict";
import test from "node:test";

import driver, { REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, type Env as RepositoryDriverEnv, type RepositoryDriverSnapshotManifest } from "../apps/repository-driver/src/index.ts";
import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL } from "../src/portability/repository-observation.ts";

const baseCommit = "0".repeat(40);
const headCommit = "1".repeat(40);
const treeCommit = "2".repeat(40);
const repositoryId = "repo:driver";
const sourceSpaceId = "source:driver";

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

function manifest(state: RepositoryDriverSnapshotManifest["state"] = "active"): RepositoryDriverSnapshotManifest {
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, repositoryId, sourceSpaceId, objectFormat: "sha1", symbolicRef: "refs/heads/main", commitOid: headCommit, treeOid: treeCommit, baseCommitOid: baseCommit, ancestorCommitOids: [baseCommit], generation: "generation:driver:1", state, observedAt: "2026-08-26T00:00:00.000Z", receipt: "provider=fixture; credentialMaterialStored=false" };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://repository-driver.example/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": "anyam.repository-observer/v1" }, body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId: "workspace:driver", projectViewId: "view:driver", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1", ...overrides }) });
}

function env(bucket: MemoryBucket): RepositoryDriverEnv {
  return { REPOSITORY_STATE: bucket as unknown as NonNullable<RepositoryDriverEnv["REPOSITORY_STATE"]>, REPOSITORY_DRIVER_MANIFEST_PREFIX: "repositories/", REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT: "receipt=repository-driver-test-measurement" };
}

test("customer RepositoryDriver and Observer compose an exact R2-backed observation", async () => {
  const bucket = new MemoryBucket();
  bucket.put("repositories/repo%3Adriver.json", JSON.stringify(manifest()));
  const driverEnv = env(bucket);
  const binding = { fetch: (requestValue: Request) => driver.fetch(requestValue, driverEnv) } as unknown as Fetcher;
  const observerEnv: RepositoryObserverEnv = { REPOSITORY_DRIVER: binding, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=repository-observer-test-measurement", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "1000", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT: "receipt=repository-observer-test-timeout-measurement" };
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId: "workspace:driver", projectViewId: "view:driver", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1" }) }), observerEnv);
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
  bucket.put("repositories/repo%3Adriver.json", JSON.stringify(manifest()));
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
  revokedBucket.put("repositories/repo%3Adriver.json", JSON.stringify(manifest("revoked")));
  const revoked = await driver.fetch(request(), env(revokedBucket));
  assert.equal(revoked.status, 409);
  assert.equal((await revoked.json() as Record<string, unknown>).code, "repository_driver_installation_revoked");
  const staleBucket = new MemoryBucket();
  staleBucket.put("repositories/repo%3Adriver.json", JSON.stringify(manifest("stale")));
  const stale = await driver.fetch(request(), env(staleBucket));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as Record<string, unknown>).code, "repository_driver_snapshot_stale");
  const missing = await driver.fetch(request(), env(new MemoryBucket()));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json() as Record<string, unknown>).code, "repository_not_found");
});

test("RepositoryDriver requires the private Observer binding and bounds malformed manifests", async () => {
  const bucket = new MemoryBucket();
  bucket.put("repositories/repo%3Adriver.json", JSON.stringify(manifest()));
  const noBinding = await driver.fetch(new Request("https://repository-driver.example/observe", { method: "POST", body: JSON.stringify({}) }), env(bucket));
  assert.equal(noBinding.status, 422);
  assert.equal((await noBinding.json() as Record<string, unknown>).code, "observer_protocol_required");
  const oversizedBucket = new MemoryBucket();
  oversizedBucket.put("repositories/repo%3Adriver.json", JSON.stringify({ ...manifest(), receipt: "x".repeat(70_000) }));
  const oversized = await driver.fetch(request(), { ...env(oversizedBucket), REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "1024" });
  assert.equal(oversized.status, 502);
  assert.equal((await oversized.json() as Record<string, unknown>).code, "repository_driver_state_budget_exceeded");
});
