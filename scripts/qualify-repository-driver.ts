import driver, { repositoryDriverSnapshotDigest, repositoryDriverSnapshotIndexKey, repositoryDriverSnapshotManifestKey, REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, type Env as RepositoryDriverEnv, type RepositoryDriverSnapshotIndex, type RepositoryDriverSnapshotManifest } from "../apps/repository-driver/src/index.ts";
import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL } from "../src/portability/repository-observation.ts";

const protocol = "anyam.repository-driver-qualification/v1" as const;
const repositoryId = "repo:driver-qualification";
const sourceSpaceId = "source:driver-qualification";
const baseCommit = "0".repeat(40);
const headCommit = "1".repeat(40);
const treeCommit = "2".repeat(40);
const manifestPrefix = "repositories/";
const workspaceId = "workspace:driver-qualification";
const projectViewId = "view:driver-qualification";

function activeObservedAt(): string {
  return new Date(Date.now() - 1_000).toISOString();
}

function activeExpiresAt(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("qualification response must be an object");
  return Object.fromEntries(Object.entries(value));
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
    if (!body) throw new Error("qualification_bucket_body_missing");
    return { body };
  }
}

function manifest(state: RepositoryDriverSnapshotManifest["state"] = "active", overrides: Partial<RepositoryDriverSnapshotManifest> = {}): RepositoryDriverSnapshotManifest {
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, repositoryId, sourceSpaceId, context: { kind: "workspace", workspaceId, projectViewId, workspaceRef: "refs/heads/main" }, objectFormat: "sha1", symbolicRef: "refs/heads/main", commitOid: headCommit, treeOid: treeCommit, baseCommitOid: baseCommit, ancestorCommitOids: [baseCommit], generation: 1, state, observedAt: activeObservedAt(), expiresAt: activeExpiresAt(), receipt: "provider=qualification; ancestry=verified; credentialMaterialStored=false", ...overrides };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://repository-driver.example/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": "anyam.repository-observer/v1" }, body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId, projectViewId, expectedSymbolicRef: "refs/heads/main", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1", ...overrides }) });
}

function env(bucket: MemoryBucket): RepositoryDriverEnv {
  return { REPOSITORY_STATE: bucket as unknown as NonNullable<RepositoryDriverEnv["REPOSITORY_STATE"]>, REPOSITORY_DRIVER_MANIFEST_PREFIX: "repositories/", REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT: "receipt=repository-driver-qualification-measurement" };
}

async function indexFor(value: RepositoryDriverSnapshotManifest, previousGeneration: number | null = null): Promise<RepositoryDriverSnapshotIndex> {
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_INDEX_PROTOCOL, repositoryId: value.repositoryId, sourceSpaceId: value.sourceSpaceId, context: value.context, latestGeneration: value.generation, previousGeneration, latestManifestKey: repositoryDriverSnapshotManifestKey(manifestPrefix, value.repositoryId, value.context, value.generation), latestManifestDigest: await repositoryDriverSnapshotDigest(value), updatedAt: "2099-01-02T00:00:00.000Z", receipt: "provider=qualification; index=monotonic; credentialMaterialStored=false" };
}

async function seed(bucket: MemoryBucket, value: RepositoryDriverSnapshotManifest, indexOverrides: Partial<RepositoryDriverSnapshotIndex> = {}): Promise<void> {
  const index = { ...await indexFor(value), ...indexOverrides };
  bucket.put(repositoryDriverSnapshotManifestKey(manifestPrefix, value.repositoryId, value.context, value.generation), JSON.stringify(value));
  bucket.put(repositoryDriverSnapshotIndexKey(manifestPrefix, value.repositoryId, value.context), JSON.stringify(index));
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  return object(await response.json());
}

async function run(): Promise<void> {
  const bucket = new MemoryBucket();
  await seed(bucket, manifest());
  const driverEnv = env(bucket);
  const health = await driver.fetch(new Request("https://repository-driver.example/health"), driverEnv);
  const healthValue = await responseObject(health);
  if (health.status !== 200 || healthValue.status !== "ready") throw new Error(`driver health failed: ${JSON.stringify(healthValue)}`);
  const binding = { fetch: (requestValue: Request) => driver.fetch(requestValue, driverEnv) } as unknown as Fetcher;
  const observerEnv: RepositoryObserverEnv = { REPOSITORY_DRIVER: binding, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=repository-observer-qualification-measurement", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "1000", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT: "receipt=repository-observer-qualification-timeout-measurement" };
  const observed = await observer.fetch(request(), observerEnv);
  const observedValue = await responseObject(observed);
  if (observed.status !== 200 || observedValue.status !== "succeeded" || !parseRepositoryObservationServiceResponse(observedValue).valid) throw new Error(`observer composition failed: ${JSON.stringify(observedValue)}`);
  const forgedHead = await driver.fetch(request({ expectedCommitOid: "3".repeat(40) }), driverEnv);
  const forgedHeadValue = await responseObject(forgedHead);
  if (forgedHead.status !== 409 || forgedHeadValue.code !== "repository_driver_snapshot_mismatch") throw new Error(`forged head was not rejected: ${JSON.stringify(forgedHeadValue)}`);
  const revokedBucket = new MemoryBucket();
  await seed(revokedBucket, manifest("revoked"));
  const revoked = await driver.fetch(request(), env(revokedBucket));
  const revokedValue = await responseObject(revoked);
  if (revoked.status !== 409 || revokedValue.code !== "repository_driver_installation_revoked") throw new Error(`revoked driver was not blocked: ${JSON.stringify(revokedValue)}`);
  const staleBucket = new MemoryBucket();
  await seed(staleBucket, manifest("stale"));
  const stale = await driver.fetch(request(), env(staleBucket));
  const staleValue = await responseObject(stale);
  if (stale.status !== 409 || staleValue.code !== "repository_driver_snapshot_stale") throw new Error(`stale driver was not blocked: ${JSON.stringify(staleValue)}`);
  const missing = await driver.fetch(request(), env(new MemoryBucket()));
  if (missing.status !== 503) throw new Error(`deleted repository was not unavailable: status=${missing.status}`);
  const lostResponse = await observer.fetch(request(), { ...observerEnv, REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => { throw new Error("driver-timeout"); } } as unknown as Fetcher });
  const lostResponseValue = await responseObject(lostResponse);
  if (lostResponse.status !== 503 || lostResponseValue.code !== "repository_driver_unavailable") throw new Error(`driver response loss was not unavailable: ${JSON.stringify(lostResponseValue)}`);
  const contextBucket = new MemoryBucket();
  await seed(contextBucket, manifest(), { context: { kind: "workspace", workspaceId: "workspace:other", projectViewId, workspaceRef: "refs/heads/main" } });
  const contextMismatch = await driver.fetch(request(), env(contextBucket));
  if (contextMismatch.status !== 409 || (await responseObject(contextMismatch)).code !== "repository_driver_context_mismatch") throw new Error("workspace context mismatch was not rejected");
  const viewBucket = new MemoryBucket();
  await seed(viewBucket, manifest(), { context: { kind: "workspace", workspaceId, projectViewId: "view:other", workspaceRef: "refs/heads/main" } });
  const viewMismatch = await driver.fetch(request(), env(viewBucket));
  if (viewMismatch.status !== 409 || (await responseObject(viewMismatch)).code !== "repository_driver_context_mismatch") throw new Error("Project View context mismatch was not rejected");
  const refMismatch = await driver.fetch(request({ expectedSymbolicRef: "refs/heads/feature" }), env(bucket));
  if (refMismatch.status !== 409 || (await responseObject(refMismatch)).code !== "repository_driver_snapshot_mismatch") throw new Error("symbolic ref mismatch was not rejected");
  const concurrent = manifest("active", { commitOid: "3".repeat(40), treeOid: "4".repeat(40), context: { kind: "workspace", workspaceId: "workspace:second", projectViewId: "view:second", workspaceRef: "refs/heads/feature" }, symbolicRef: "refs/heads/feature" });
  await seed(bucket, concurrent);
  const concurrentResponse = await driver.fetch(request({ workspaceId: "workspace:second", projectViewId: "view:second", expectedSymbolicRef: "refs/heads/feature", expectedCommitOid: concurrent.commitOid, expectedTreeOid: concurrent.treeOid }), env(bucket));
  if (concurrentResponse.status !== 200 || (await responseObject(concurrentResponse)).status !== "succeeded") throw new Error("concurrent Workspace context was not independently observed");
  const futureBucket = new MemoryBucket();
  await seed(futureBucket, manifest("active", { observedAt: "2999-01-01T00:00:00.000Z", expiresAt: "3000-01-01T00:00:00.000Z" }));
  const future = await driver.fetch(request(), env(futureBucket));
  if (future.status !== 409 || (await responseObject(future)).code !== "repository_driver_snapshot_future") throw new Error("future snapshot was not rejected");
  const expiredBucket = new MemoryBucket();
  await seed(expiredBucket, manifest("active", { observedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" }));
  const expired = await driver.fetch(request(), env(expiredBucket));
  if (expired.status !== 409 || (await responseObject(expired)).code !== "repository_driver_snapshot_expired") throw new Error("expired snapshot was not rejected");
  const generationBucket = new MemoryBucket();
  const generationManifest = manifest("active", { generation: 2 });
  await seed(generationBucket, generationManifest, { previousGeneration: 2 });
  const invalidGeneration = await driver.fetch(request(), env(generationBucket));
  if (invalidGeneration.status !== 502 || (await responseObject(invalidGeneration)).code !== "repository_driver_snapshot_index_invalid") throw new Error("non-increasing generation index was not rejected");
  console.log(JSON.stringify({ protocol, status: "succeeded", driver: { health: "verified", validObservation: "verified", workspaceContext: "verified", concurrentContext: "verified", symbolicRefMismatch: "rejected", futureSnapshot: "blocked", expiredSnapshot: "blocked", forgedHead: "rejected", revokedInstallation: "blocked", staleSnapshot: "blocked", deletedRepository: "unavailable", generationIndex: "verified" }, observer: { serviceBinding: "verified", sanitizedObservation: "verified", responseLoss: "unavailable" }, cleanup: { status: "succeeded", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, receipt: "driver=r2-context-snapshot; observer=service-binding; context=workspace-and-view-bound; ref=verified; expiry=verified; generation=monotonic-index; valid=verified; forged-head=rejected; revoked=blocked; stale=blocked; deleted=unavailable; response-loss=unavailable; request-budget=qualification-tripwire; recoveryAction=publish-a-fresh-context-bound-snapshot; remeasure-before-production" }, null, 2));
}

try {
  await run();
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), cleanup: { status: "not-attempted", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named RepositoryDriver and Observer boundary, then retry the same bounded qualification", receipt: "driver=r2-snapshot; qualification=blocked; providerFactsAreNotAnyamLimits=true" }, null, 2));
  process.exitCode = 2;
}
