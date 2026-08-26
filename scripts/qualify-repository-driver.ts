import driver, { REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, type Env as RepositoryDriverEnv, type RepositoryDriverSnapshotManifest } from "../apps/repository-driver/src/index.ts";
import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL } from "../src/portability/repository-observation.ts";

const protocol = "anyam.repository-driver-qualification/v1" as const;
const repositoryId = "repo:driver-qualification";
const sourceSpaceId = "source:driver-qualification";
const baseCommit = "0".repeat(40);
const headCommit = "1".repeat(40);
const treeCommit = "2".repeat(40);
const manifestKey = "repositories/repo%3Adriver-qualification.json";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("qualification response must be an object");
  return Object.fromEntries(Object.entries(value));
}

class MemoryBucket {
  private value: string | undefined;

  put(value: string): void {
    this.value = value;
  }

  async get(key: string): Promise<unknown> {
    if (key !== manifestKey || this.value === undefined) return null;
    const response = new Response(this.value);
    const body = response.body;
    if (!body) throw new Error("qualification_bucket_body_missing");
    return { body };
  }
}

function manifest(state: RepositoryDriverSnapshotManifest["state"] = "active"): RepositoryDriverSnapshotManifest {
  return { protocol: REPOSITORY_DRIVER_SNAPSHOT_PROTOCOL, repositoryId, sourceSpaceId, objectFormat: "sha1", symbolicRef: "refs/heads/main", commitOid: headCommit, treeOid: treeCommit, baseCommitOid: baseCommit, ancestorCommitOids: [baseCommit], generation: "generation:driver-qualification:1", state, observedAt: "2026-08-26T00:00:00.000Z", receipt: "provider=qualification; ancestry=verified; credentialMaterialStored=false" };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://repository-driver.example/observe", { method: "POST", headers: { "content-type": "application/json", "x-anyam-repository-observer-protocol": "anyam.repository-observer/v1" }, body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId: "workspace:driver-qualification", projectViewId: "view:driver-qualification", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1", ...overrides }) });
}

function env(bucket: MemoryBucket): RepositoryDriverEnv {
  return { REPOSITORY_STATE: bucket as unknown as NonNullable<RepositoryDriverEnv["REPOSITORY_STATE"]>, REPOSITORY_DRIVER_MANIFEST_PREFIX: "repositories/", REPOSITORY_DRIVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_DRIVER_REQUEST_BYTES_RECEIPT: "receipt=repository-driver-qualification-measurement" };
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  return object(await response.json());
}

async function run(): Promise<void> {
  const bucket = new MemoryBucket();
  bucket.put(JSON.stringify(manifest()));
  const driverEnv = env(bucket);
  const health = await driver.fetch(new Request("https://repository-driver.example/health"), driverEnv);
  const healthValue = await responseObject(health);
  if (health.status !== 200 || healthValue.status !== "ready") throw new Error(`driver health failed: ${JSON.stringify(healthValue)}`);
  const binding = { fetch: (requestValue: Request) => driver.fetch(requestValue, driverEnv) } as unknown as Fetcher;
  const observerEnv: RepositoryObserverEnv = { REPOSITORY_DRIVER: binding, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=repository-observer-qualification-measurement" };
  const observed = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId: "workspace:driver-qualification", projectViewId: "view:driver-qualification", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1" }) }), observerEnv);
  const observedValue = await responseObject(observed);
  if (observed.status !== 200 || observedValue.status !== "succeeded" || !parseRepositoryObservationServiceResponse(observedValue).valid) throw new Error(`observer composition failed: ${JSON.stringify(observedValue)}`);
  const forgedHead = await driver.fetch(request({ expectedCommitOid: "3".repeat(40) }), driverEnv);
  const forgedHeadValue = await responseObject(forgedHead);
  if (forgedHead.status !== 409 || forgedHeadValue.code !== "repository_driver_snapshot_mismatch") throw new Error(`forged head was not rejected: ${JSON.stringify(forgedHeadValue)}`);
  const revokedBucket = new MemoryBucket();
  revokedBucket.put(JSON.stringify(manifest("revoked")));
  const revoked = await driver.fetch(request(), env(revokedBucket));
  const revokedValue = await responseObject(revoked);
  if (revoked.status !== 409 || revokedValue.code !== "repository_driver_installation_revoked") throw new Error(`revoked driver was not blocked: ${JSON.stringify(revokedValue)}`);
  const staleBucket = new MemoryBucket();
  staleBucket.put(JSON.stringify(manifest("stale")));
  const stale = await driver.fetch(request(), env(staleBucket));
  const staleValue = await responseObject(stale);
  if (stale.status !== 409 || staleValue.code !== "repository_driver_snapshot_stale") throw new Error(`stale driver was not blocked: ${JSON.stringify(staleValue)}`);
  const missing = await driver.fetch(request(), env(new MemoryBucket()));
  if (missing.status !== 503) throw new Error(`deleted repository was not unavailable: status=${missing.status}`);
  const lostResponse = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, operation: "observe", repositoryId, sourceSpaceId, workspaceId: "workspace:driver-qualification", projectViewId: "view:driver-qualification", expectedCommitOid: headCommit, expectedTreeOid: treeCommit, expectedBaseCommitOid: baseCommit, expectedObjectFormat: "sha1" }) }), { ...observerEnv, REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => { throw new Error("driver-timeout"); } } as unknown as Fetcher });
  const lostResponseValue = await responseObject(lostResponse);
  if (lostResponse.status !== 503 || lostResponseValue.code !== "repository_driver_unavailable") throw new Error(`driver response loss was not unavailable: ${JSON.stringify(lostResponseValue)}`);
  console.log(JSON.stringify({ protocol, status: "succeeded", driver: { health: "verified", validObservation: "verified", forgedHead: "rejected", revokedInstallation: "blocked", staleSnapshot: "blocked", deletedRepository: "unavailable" }, observer: { serviceBinding: "verified", sanitizedObservation: "verified", responseLoss: "unavailable" }, cleanup: { status: "succeeded", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, receipt: "driver=r2-snapshot; observer=service-binding; valid=verified; forged-head=rejected; revoked=blocked; stale=blocked; deleted=unavailable; response-loss=unavailable; request-budget=qualification-tripwire; remeasure-before-production" }, null, 2));
}

try {
  await run();
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), cleanup: { status: "not-attempted", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named RepositoryDriver and Observer boundary, then retry the same bounded qualification", receipt: "driver=r2-snapshot; qualification=blocked; providerFactsAreNotAnyamLimits=true" }, null, 2));
  process.exitCode = 2;
}
