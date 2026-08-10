import assert from "node:assert/strict";
import test from "node:test";

import {
  HostedSaaSIsolationStore,
  HostedSaaSRouter,
  HOSTED_SAAS_TOKEN_AUDIENCE,
} from "../src/cloudflare/hosted-saas-isolation.ts";

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function request(input: { host: string; token: string; method: string; path: string; correlationId: string; body?: unknown }): Request {
  return new Request(`https://${input.host}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      "x-anyam-correlation-id": input.correlationId,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

async function createProject(router: HostedSaaSRouter, input: { host: string; token: string; projectId: string; name: string; digest: string }): Promise<Record<string, unknown>> {
  return json(await router.handle(request({
    host: input.host,
    token: input.token,
    method: "POST",
    path: "/api/projects",
    correlationId: `create:${input.projectId}`,
    body: { projectId: input.projectId, name: input.name, contentDigest: input.digest },
  })));
}

test("shared Hosted SaaS router partitions every authority-bearing surface by host-bound Realm", async () => {
  const store = new HostedSaaSIsolationStore();
  store.registerRealm({ realmId: "realm:a", host: "a.hosted.test" });
  store.registerRealm({ realmId: "realm:b", host: "b.hosted.test" });
  const tokenA = store.issueCredential({ realmId: "realm:a", principalId: "principal:a" });
  const tokenB = store.issueCredential({ realmId: "realm:b", principalId: "principal:b" });
  const router = new HostedSaaSRouter(store);

  const createdA = await createProject(router, { host: "a.hosted.test", token: tokenA, projectId: "project:a", name: "A private project", digest: "sha256:a" });
  const createdB = await createProject(router, { host: "b.hosted.test", token: tokenB, projectId: "project:b", name: "B private project", digest: "sha256:b" });
  assert.equal(createdA.status, "accepted");
  assert.equal(createdB.status, "accepted");

  const ownA = await json(await router.handle(request({ host: "a.hosted.test", token: tokenA, method: "GET", path: "/api/projects/project:a", correlationId: "read:a" })));
  assert.equal(ownA.status, "accepted");
  assert.equal((ownA.project as Record<string, unknown>).name, "A private project");

  const ownB = await json(await router.handle(request({ host: "b.hosted.test", token: tokenB, method: "GET", path: "/api/projects/project:b", correlationId: "read:b" })));
  assert.equal(ownB.status, "accepted");
  assert.equal((ownB.project as Record<string, unknown>).name, "B private project");

  const foreignRead = await json(await router.handle(request({ host: "a.hosted.test", token: tokenB, method: "GET", path: "/api/projects/project:b", correlationId: "foreign-read" })));
  assert.equal(foreignRead.status, "not-found");
  assert.equal(JSON.stringify(foreignRead).includes("realm:b"), false);
  assert.equal(JSON.stringify(foreignRead).includes("project:b"), false);
  assert.equal(JSON.stringify(foreignRead).includes("sha256:b"), false);

  const foreignMutation = await json(await router.handle(request({ host: "a.hosted.test", token: tokenB, method: "PATCH", path: "/api/projects/project:a", correlationId: "foreign-mutation", body: { contentDigest: "sha256:tampered" } })));
  assert.equal(foreignMutation.status, "not-found");
  assert.equal(JSON.stringify(foreignMutation).includes("realm:b"), false);
  assert.equal(JSON.stringify(foreignMutation).includes("tampered"), false);

  const afterForeignMutation = await json(await router.handle(request({ host: "a.hosted.test", token: tokenA, method: "GET", path: "/api/projects/project:a", correlationId: "read:a-after-negative" })));
  assert.equal((afterForeignMutation.project as Record<string, unknown>).contentDigest, "sha256:a");

  const listA = await json(await router.handle(request({ host: "a.hosted.test", token: tokenA, method: "GET", path: "/api/projects", correlationId: "list:a" })));
  assert.deepEqual((listA.projects as Record<string, unknown>[]).map((project) => project.projectId), ["project:a"]);
  const listB = await json(await router.handle(request({ host: "b.hosted.test", token: tokenB, method: "GET", path: "/api/projects", correlationId: "list:b" })));
  assert.deepEqual((listB.projects as Record<string, unknown>[]).map((project) => project.projectId), ["project:b"]);

  const foreignExport = await json(await router.handle(request({ host: "a.hosted.test", token: tokenB, method: "POST", path: "/api/projects/project:b/export", correlationId: "foreign-export" })));
  assert.equal(foreignExport.status, "not-found");
  assert.equal(JSON.stringify(foreignExport).includes("project:b"), false);
  assert.equal(JSON.stringify(foreignExport).includes("sha256:b"), false);

  const inspectionA = store.inspect("realm:a");
  const inspectionB = store.inspect("realm:b");
  assert.ok(inspectionA.storageKeys.every((key) => key.includes("/realm:a/")));
  assert.ok(inspectionB.storageKeys.every((key) => key.includes("/realm:b/")));
  assert.equal(inspectionA.storageKeys.some((key) => key.includes("project:b")), false);
  assert.equal(inspectionB.storageKeys.some((key) => key.includes("project:a")), false);
  assert.ok(inspectionA.cacheKeys.every((key) => key.includes("/realm:a/")));
  assert.ok(inspectionB.cacheKeys.every((key) => key.includes("/realm:b/")));
  assert.ok(inspectionA.queueMessageIds.length > 0);
  assert.ok(inspectionB.queueMessageIds.length > 0);
  assert.ok(inspectionA.eventIds.length > 0);
  assert.ok(inspectionB.eventIds.length > 0);
  assert.ok(inspectionA.logRequestIds.every((id) => id !== "foreign-read"));
});

test("Hosted SaaS credentials are audience-bound and epoch revocation survives a coordinator restore", async () => {
  const store = new HostedSaaSIsolationStore();
  store.registerRealm({ realmId: "realm:restore", host: "restore.hosted.test" });
  const token = store.issueCredential({ realmId: "realm:restore", principalId: "principal:restore" });
  assert.equal(store.authenticate(token, "realm:restore").audience, HOSTED_SAAS_TOKEN_AUDIENCE);
  const router = new HostedSaaSRouter(store);
  await createProject(router, { host: "restore.hosted.test", token, projectId: "project:restore", name: "Restored project", digest: "sha256:restore" });

  const snapshot = store.snapshot();
  assert.equal(snapshot.credentialFree, true);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  const restored = new HostedSaaSIsolationStore();
  restored.restore(snapshot);
  const restoredRouter = new HostedSaaSRouter(restored);
  const oldTokenAfterRestore = await json(await restoredRouter.handle(request({ host: "restore.hosted.test", token, method: "GET", path: "/api/projects/project:restore", correlationId: "read:old-token" })));
  assert.equal(oldTokenAfterRestore.status, "not-found");
  assert.equal(JSON.stringify(oldTokenAfterRestore).includes(token), false);

  const replacementAfterRestore = restored.issueCredential({ realmId: "realm:restore", principalId: "principal:restore" });
  const readAfterRestore = await json(await restoredRouter.handle(request({ host: "restore.hosted.test", token: replacementAfterRestore, method: "GET", path: "/api/projects/project:restore", correlationId: "read:restore" })));
  assert.equal(readAfterRestore.status, "accepted");
  assert.equal((readAfterRestore.project as Record<string, unknown>).contentDigest, "sha256:restore");

  restored.revokeRealm("realm:restore");
  const revoked = await json(await restoredRouter.handle(request({ host: "restore.hosted.test", token, method: "GET", path: "/api/projects/project:restore", correlationId: "read:revoked" })));
  assert.equal(revoked.status, "not-found");
  assert.equal(JSON.stringify(revoked).includes("restore"), false);

  const replacement = restored.issueCredential({ realmId: "realm:restore", principalId: "principal:restore" });
  const replacementRead = await json(await restoredRouter.handle(request({ host: "restore.hosted.test", token: replacement, method: "GET", path: "/api/projects/project:restore", correlationId: "read:replacement" })));
  assert.equal(replacementRead.status, "accepted");
});

test("host routing ignores caller-supplied Realm identifiers and fails closed without credentials", async () => {
  const store = new HostedSaaSIsolationStore();
  store.registerRealm({ realmId: "realm:route", host: "route.hosted.test" });
  const token = store.issueCredential({ realmId: "realm:route", principalId: "principal:route" });
  const router = new HostedSaaSRouter(store);
  await createProject(router, { host: "route.hosted.test", token, projectId: "project:route", name: "Route project", digest: "sha256:route" });

  const requestWithForeignHeader = new Request("https://route.hosted.test/api/projects/project:route", { headers: { authorization: `Bearer ${token}`, "x-anyam-realm": "realm:foreign", "x-anyam-correlation-id": "route-header" } });
  const routed = await json(await router.handle(requestWithForeignHeader));
  assert.equal(routed.status, "accepted");
  assert.equal((routed.project as Record<string, unknown>).projectId, "project:route");

  const missingAuth = await json(await router.handle(new Request("https://route.hosted.test/api/projects/project:route")));
  assert.equal(missingAuth.status, "invalid-request");
  assert.equal(JSON.stringify(missingAuth).includes("hosted-token"), false);
  assert.equal(JSON.stringify(missingAuth).includes("project:route"), false);
});

test("Hosted SaaS cleanup removes all synthetic state and returns only counts", async () => {
  const store = new HostedSaaSIsolationStore();
  store.registerRealm({ realmId: "realm:cleanup", host: "cleanup.hosted.test" });
  const token = store.issueCredential({ realmId: "realm:cleanup", principalId: "principal:cleanup" });
  const router = new HostedSaaSRouter(store);
  await createProject(router, { host: "cleanup.hosted.test", token, projectId: "project:cleanup", name: "Disposable project", digest: "sha256:cleanup" });
  const cleanup = store.cleanup();
  assert.equal(cleanup.realms, 1);
  assert.equal(cleanup.projects, 1);
  assert.equal(cleanup.credentials, 1);
  assert.equal(cleanup.receipt.includes("credentialMaterialStored=false"), true);
  assert.deepEqual(store.snapshot().realms, []);
  assert.deepEqual(store.snapshot().projects, []);
  assert.deepEqual(store.snapshot().queue, []);
  assert.deepEqual(store.snapshot().events, []);
  assert.deepEqual(store.snapshot().logs, []);
});
