import assert from "node:assert/strict";
import test from "node:test";

import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL, repositoryObservationDigest } from "../src/portability/repository-observation.ts";

const envBase = { REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=observer-request-measurement; source=qualification" } satisfies RepositoryObserverEnv;

function requestBody() {
  return {
    protocol: REPOSITORY_OBSERVATION_PROTOCOL,
    operation: "observe",
    repositoryId: "repo:observer",
    sourceSpaceId: "source:observer",
    workspaceId: "workspace:observer",
    projectViewId: "view:observer",
    expectedCommitOid: "1".repeat(40),
    expectedTreeOid: "2".repeat(40),
    expectedBaseCommitOid: "0".repeat(40),
    expectedObjectFormat: "sha1",
  } as const;
}

async function observation() {
  const claims = {
    protocol: REPOSITORY_OBSERVATION_PROTOCOL,
    repositoryId: "repo:observer",
    sourceSpaceId: "source:observer",
    workspaceId: "workspace:observer",
    projectViewId: "view:observer",
    objectFormat: "sha1" as const,
    symbolicRef: "refs/heads/main",
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    baseCommitOid: "0".repeat(40),
    ancestryVerified: true as const,
    observedAt: "2026-08-26T00:00:00.000Z",
    receipt: "driver=qualification; ancestry=verified; credentialMaterialStored=false",
  };
  return { ...claims, manifestDigest: await repositoryObservationDigest(claims) };
}

test("repository observer verifies delegated driver output and keeps the service credential-free", async () => {
  const observed = await observation();
  let forwarded: unknown;
  const driver = {
    fetch: async (request: Request): Promise<Response> => {
      forwarded = await request.json();
      return new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: observed, receipt: "driver=qualification; exact=true; credentialMaterialStored=false" }), { status: 200 });
    },
  } as unknown as Fetcher;
  const env = { ...envBase, REPOSITORY_DRIVER: driver } satisfies RepositoryObserverEnv;
  const health = await observer.fetch(new Request("https://observer.example/health"), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, "ready");
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody()) }), env);
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.protocol, REPOSITORY_OBSERVATION_PROTOCOL);
  assert.equal(value.status, "succeeded");
  assert.equal((value.observation as Record<string, unknown>).repositoryId, "repo:observer");
  assert.equal(parseRepositoryObservationServiceResponse(value).valid, true);
  assert.equal(JSON.stringify(value).includes("token"), false);
  assert.deepEqual(forwarded, requestBody());
});

test("repository observer rejects forged driver observations before returning them", async () => {
  const observed = await observation();
  const driver = { fetch: async (): Promise<Response> => new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: { ...observed, repositoryId: "repo:other" }, receipt: "driver=qualification; exact=false" })) } as unknown as Fetcher;
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: driver });
  assert.equal(response.status, 409);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_observation_binding_mismatch");
  assert.equal(value.observation, undefined);
});

test("repository observer exposes missing-driver and request-budget failures explicitly", async () => {
  const missingHealth = await observer.fetch(new Request("https://observer.example/health"), envBase);
  assert.equal(missingHealth.status, 503);
  assert.equal((await missingHealth.json() as Record<string, unknown>).code, undefined);
  const oversized = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify({ ...requestBody(), repositoryId: "x".repeat(200) }) }), { ...envBase, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "32" });
  assert.equal(oversized.status, 422);
  assert.equal((await oversized.json() as Record<string, unknown>).code, "request_budget_exceeded");
});
