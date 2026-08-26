import assert from "node:assert/strict";
import test from "node:test";

import observer, { type Env as RepositoryObserverEnv } from "../apps/repository-observer/src/index.ts";
import { parseRepositoryObservationServiceResponse, REPOSITORY_OBSERVATION_PROTOCOL, repositoryObservationDigest } from "../src/portability/repository-observation.ts";

const envBase = { REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "65536", REPOSITORY_OBSERVER_REQUEST_BYTES_RECEIPT: "receipt=observer-request-measurement; source=qualification", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "1000", REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_RECEIPT: "receipt=observer-transport-timeout-measurement; source=qualification" } satisfies RepositoryObserverEnv;

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
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...requestBody(), ignored: "must-not-cross-the-boundary", nested: { secret: "must-not-cross-the-boundary" } }) }), env);
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.protocol, REPOSITORY_OBSERVATION_PROTOCOL);
  assert.equal(value.status, "succeeded");
  assert.equal((value.observation as Record<string, unknown>).repositoryId, "repo:observer");
  assert.equal(parseRepositoryObservationServiceResponse(value).valid, true);
  assert.equal(JSON.stringify(value).includes("token"), false);
  assert.deepEqual(forwarded, requestBody());
});

test("repository observer rejects a non-2xx success-shaped driver response", async () => {
  const observed = await observation();
  const driver = { fetch: async (): Promise<Response> => new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "succeeded", observation: observed, receipt: "driver=qualification; exact=true" }), { status: 503 }) } as unknown as Fetcher;
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: driver });
  assert.equal(response.status, 502);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_driver_transport_failure");
  assert.match(String(value.receipt), /httpStatus=503/u);
  assert.equal(value.observation, undefined);
});

test("repository observer maps a non-2xx blocked driver response without trusting success", async () => {
  const driver = { fetch: async (): Promise<Response> => new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "blocked", code: "repository_driver_snapshot_mismatch", recoveryAction: "publish a fresh snapshot", receipt: "driver=qualification; blocked=true" }), { status: 409 }) } as unknown as Fetcher;
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: driver });
  assert.equal(response.status, 409);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_driver_snapshot_mismatch");
  assert.match(String(value.receipt), /transport=non-2xx/u);
});

test("repository observer rejects malformed, oversized, and credential-bearing driver responses", async () => {
  const malformed = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => new Response("not-json", { status: 200 }) } as unknown as Fetcher });
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json() as Record<string, unknown>).code, "repository_driver_response_invalid");

  const oversized = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_OBSERVER_REQUEST_BYTES_LIMIT: "512", REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "blocked", code: "x", recoveryAction: "y", receipt: "driver=qualification; detail=" + "x".repeat(600) }), { status: 200 }) } as unknown as Fetcher });
  assert.equal(oversized.status, 502);
  const oversizedValue = await oversized.json() as Record<string, unknown>;
  assert.equal(oversizedValue.code, "repository_driver_response_budget_exceeded");
  assert.match(String(oversizedValue.receipt), /requestBudget=512/u);

  const credential = "cfat_should-never-leave-the-boundary";
  const credentialResponse = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => new Response(JSON.stringify({ protocol: REPOSITORY_OBSERVATION_PROTOCOL, status: "blocked", code: "driver_error", recoveryAction: "inspect", receipt: "driver=qualification", token: credential }), { status: 200 }) } as unknown as Fetcher });
  assert.equal(credentialResponse.status, 502);
  const credentialValue = await credentialResponse.json() as Record<string, unknown>;
  assert.equal(credentialValue.code, "repository_driver_response_credential_material");
  assert.equal(JSON.stringify(credentialValue).includes(credential), false);
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

test("repository observer keeps driver timeout and response loss unavailable", async () => {
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => { throw new Error("driver-timeout"); } } as unknown as Fetcher });
  assert.equal(response.status, 503);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_driver_unavailable");
  assert.match(String(value.receipt), /providerInvocation=indeterminate/u);
});

test("repository observer times out a driver that never returns", async () => {
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "20", REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => new Promise<Response>(() => undefined) } as unknown as Fetcher });
  assert.equal(response.status, 503);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_driver_timeout");
  assert.match(String(value.receipt), /transportTimeoutMs=20/u);
});

test("repository observer times out a response body that never completes", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } });
  const response = await observer.fetch(new Request("https://observer.example/observe", { method: "POST", body: JSON.stringify(requestBody()) }), { ...envBase, REPOSITORY_OBSERVER_TRANSPORT_TIMEOUT_MS: "20", REPOSITORY_DRIVER: { fetch: async (): Promise<Response> => new Response(body, { status: 200 }) } as unknown as Fetcher });
  assert.equal(response.status, 502);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "repository_driver_response_timeout");
  assert.match(String(value.receipt), /transportTimeoutMs=20/u);
});
