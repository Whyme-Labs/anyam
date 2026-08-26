import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { REPOSITORY_OBSERVATION_PROTOCOL, repositoryObservationDigest } from "../src/portability/repository-observation.ts";

const protocol = "anyam.repository-observer-qualification/v1" as const;
const request = {
  protocol: REPOSITORY_OBSERVATION_PROTOCOL,
  operation: "observe",
  repositoryId: "repo:observer-qualification",
  sourceSpaceId: "source:observer-qualification",
  workspaceId: "workspace:observer-qualification",
  projectViewId: "view:observer-qualification",
  expectedCommitOid: "1".repeat(40),
  expectedTreeOid: "2".repeat(40),
  expectedBaseCommitOid: "0".repeat(40),
  expectedObjectFormat: "sha1",
} as const;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("qualification response must be an object");
  return Object.fromEntries(Object.entries(value));
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  return object(await response.json());
}

async function validObservation(): Promise<Record<string, unknown>> {
  const claims = {
    protocol: REPOSITORY_OBSERVATION_PROTOCOL,
    repositoryId: request.repositoryId,
    sourceSpaceId: request.sourceSpaceId,
    workspaceId: request.workspaceId,
    projectViewId: request.projectViewId,
    objectFormat: "sha1" as const,
    symbolicRef: "refs/heads/main",
    commitOid: request.expectedCommitOid,
    treeOid: request.expectedTreeOid,
    baseCommitOid: request.expectedBaseCommitOid,
    ancestryVerified: true as const,
    observedAt: "2026-08-26T00:00:00.000Z",
    receipt: "driver=repository-observer-qualification; ancestry=verified; credentialMaterialStored=false",
  };
  return { ...claims, manifestDigest: await repositoryObservationDigest(claims) };
}

async function run(): Promise<void> {
  const observation = await validObservation();
  const driver = {
    async fetch(): Promise<Response> {
      return new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation, receipt: "driver=repository-observer-qualification; exact=true; credentialMaterialStored=false" }), { status: 200 });
    },
  } as unknown as NonNullable<RepositoryObserverEnv["REPOSITORY_DRIVER"]>;
  const env = { REPOSITORY_DRIVER: driver, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=observer-qualification-request-measurement" } satisfies RepositoryObserverEnv;
  const health = await observer.fetch(new Request("https://observer.example/health"), env);
  const healthy = await responseObject(health);
  if (health.status !== 200 || healthy.status !== "ready") throw new Error(`health qualification failed: ${JSON.stringify(healthy)}`);
  const observed = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(request) }), env);
  const observedValue = await responseObject(observed);
  if (observed.status !== 200 || observedValue.status !== "succeeded") throw new Error(`valid observation qualification failed: ${JSON.stringify(observedValue)}`);
  const forged = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(request) }), { ...env, REPOSITORY_DRIVER: { async fetch(): Promise<Response> { return new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...observation, repositoryId: "repo:forged" }, receipt: "driver=repository-observer-qualification; exact=false" }), { status: 200 }); } } as unknown as NonNullable<RepositoryObserverEnv["REPOSITORY_DRIVER"]> });
  const forgedValue = await responseObject(forged);
  if (forged.status !== 409 || forgedValue.code !== "repository_observation_binding_mismatch") throw new Error(`forged observation qualification failed: ${JSON.stringify(forgedValue)}`);
  const { REPOSITORY_DRIVER: _driver, ...missingEnv } = env;
  const missing = await observer.fetch(new Request("https://observer.example/health"), missingEnv);
  if (missing.status !== 503) throw new Error(`missing-driver qualification failed: status=${missing.status}`);
  console.log(JSON.stringify({ protocol, status: "succeeded", scenarios: { health: "verified", validObservation: "verified", forgedObservation: "rejected", missingDriver: "blocked" }, provider: { localDriverFixture: "verified", liveCustomerDriver: "blocked", blocker: "customer-operated-driver-deployment-not-configured", recoveryAction: "deploy the customer RepositoryDriver and bind it through the observer Wrangler configuration before claiming live provider support" }, cleanup: { status: "succeeded", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, receipt: "observer=reference-worker; driver=service-binding; exact-binding=verified; forged-observation=rejected; missing-driver=blocked; live-provider=blocked-by-customer-driver-configuration; request-budget=qualification-tripwire; remeasure-before-production" }, null, 2));
}

try {
  await run();
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), cleanup: { status: "not-attempted", receipt: "cleanup=not-required; providerMutation=false; credentialMaterialStored=false" }, credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named observer or delegated driver receipt and retry the same bounded qualification", receipt: "observer=reference-worker; qualification=blocked; providerFactsAreNotAnyamLimits=true" }, null, 2));
  process.exitCode = 2;
}
