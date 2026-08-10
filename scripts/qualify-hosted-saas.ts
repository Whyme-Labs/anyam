import assert from "node:assert/strict";

const baseUrl = process.env.ANYAM_HOSTED_QUALIFICATION_URL?.replace(/\/$/, "");
const bootstrapToken = process.env.ANYAM_HOSTED_QUALIFICATION_TOKEN;

if (!baseUrl || !bootstrapToken) {
  console.error(JSON.stringify({ protocol: "anyam.p3-22-hosted-saas-qualification/v1", status: "blocked", error: "ANYAM_HOSTED_QUALIFICATION_URL and ANYAM_HOSTED_QUALIFICATION_TOKEN are required", credentialValues: "not-printed" }, null, 2));
  process.exit(2);
}

type JsonObject = Record<string, unknown>;
type RealmFixture = { realmId: string; host: string; token: string; projectId: string; digest: string };

const protocol = "anyam.p3-22-hosted-saas-qualification/v1" as const;
const realmA = { realmId: "realm:live-a", host: "realm-a.hosted.invalid", projectId: "project:live-a", digest: "sha256:live-a" };
const realmB = { realmId: "realm:live-b", host: "realm-b.hosted.invalid", projectId: "project:live-b", digest: "sha256:live-b" };
let cleanupResult: JsonObject | undefined;

async function parse(response: Response): Promise<JsonObject> {
  const value = await response.json().catch(() => ({}));
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

async function call(path: string, init: RequestInit = {}): Promise<{ response: Response; body: JsonObject }> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), "cache-control": "no-store" } });
  return { response, body: await parse(response) };
}

async function admin(path: string, body?: JsonObject): Promise<JsonObject> {
  const result = await call(path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${bootstrapToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(result.response.ok, `${path} returned HTTP ${result.response.status}`);
  return result.body;
}

function route(fixture: { host: string }, suffix: string): string {
  return `/r/${encodeURIComponent(fixture.host)}${suffix}`;
}

async function realmRequest(fixture: RealmFixture, method: string, suffix: string, body?: JsonObject, token = fixture.token, extraHeaders: Record<string, string> = {}): Promise<{ response: Response; body: JsonObject }> {
  return call(route(fixture, suffix), {
    method,
    headers: { authorization: `Bearer ${token}`, "x-anyam-correlation-id": `${method.toLowerCase()}:${fixture.realmId}:${suffix}`, ...extraHeaders, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function tokenFrom(body: JsonObject): string {
  const credential = body.credential;
  assert.ok(credential !== null && typeof credential === "object" && !Array.isArray(credential));
  const token = (credential as JsonObject).token;
  assert.equal(typeof token, "string");
  return token as string;
}

function assertNoDisclosure(body: JsonObject, values: readonly string[]): void {
  const serialized = JSON.stringify(body);
  for (const value of values) assert.equal(serialized.includes(value), false, `negative response disclosed ${value}`);
}

async function register(input: typeof realmA): Promise<RealmFixture> {
  const body = await admin("/admin/register-realm", { realmId: input.realmId, host: input.host, principalId: `${input.realmId}:owner` });
  assert.equal(body.status, "registered");
  assert.equal(body.credential && typeof body.credential === "object" ? (body.credential as JsonObject).audience : undefined, "aud:anyam:hosted-api");
  return { ...input, token: tokenFrom(body) };
}

async function create(fixture: RealmFixture): Promise<void> {
  const result = await realmRequest(fixture, "POST", "/api/projects", { projectId: fixture.projectId, name: `${fixture.realmId} project`, contentDigest: fixture.digest });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.status, "accepted");
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const health = await call("/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.hostingMode, "hosted-saas");
  const a = await register(realmA);
  const b = await register(realmB);
  await create(a);
  await create(b);

  const ownA = await realmRequest(a, "GET", `/api/projects/${a.projectId}`);
  const ownB = await realmRequest(b, "GET", `/api/projects/${b.projectId}`);
  assert.equal(ownA.response.status, 200);
  assert.equal(ownB.response.status, 200);

  const mutateA = await realmRequest(a, "PATCH", `/api/projects/${a.projectId}`, { contentDigest: "sha256:live-a-r2" });
  assert.equal(mutateA.response.status, 200);
  const exportA = await realmRequest(a, "POST", `/api/projects/${a.projectId}/export`);
  assert.equal(exportA.response.status, 200);
  const listA = await realmRequest(a, "GET", "/api/projects");
  const listB = await realmRequest(b, "GET", "/api/projects");
  assert.deepEqual((listA.body.projects as JsonObject[]).map((project) => project.projectId), [a.projectId]);
  assert.deepEqual((listB.body.projects as JsonObject[]).map((project) => project.projectId), [b.projectId]);

  const foreignRead = await realmRequest(a, "GET", `/api/projects/${b.projectId}`, undefined, b.token);
  assert.equal(foreignRead.response.status, 404);
  assertNoDisclosure(foreignRead.body, [b.realmId, b.projectId, b.digest, "realm-b"]);
  const foreignMutation = await realmRequest(a, "PATCH", `/api/projects/${a.projectId}`, { contentDigest: "sha256:tampered" }, b.token);
  assert.equal(foreignMutation.response.status, 404);
  assertNoDisclosure(foreignMutation.body, [b.realmId, "sha256:tampered", "private"]);
  const foreignList = await realmRequest(a, "GET", "/api/projects", undefined, b.token);
  assert.equal(foreignList.response.status, 404);
  assertNoDisclosure(foreignList.body, [a.projectId, b.projectId, a.realmId, b.realmId]);
  const foreignExport = await realmRequest(a, "POST", `/api/projects/${b.projectId}/export`, undefined, b.token);
  assert.equal(foreignExport.response.status, 404);
  assertNoDisclosure(foreignExport.body, [b.projectId, b.digest, b.realmId]);

  const headerProbe = await realmRequest(a, "GET", `/api/projects/${a.projectId}`, undefined, a.token, { "x-anyam-realm": b.realmId });
  assert.equal(headerProbe.response.status, 200);
  const missingAuth = await call(route(a, `/api/projects/${a.projectId}`));
  assert.equal(missingAuth.response.status, 400);
  assertNoDisclosure(missingAuth.body, [a.projectId, a.realmId, a.token]);

  const revoked = await admin("/admin/revoke-realm", { realmId: a.realmId });
  assert.equal(revoked.status, "revoked");
  const revokedRead = await realmRequest(a, "GET", `/api/projects/${a.projectId}`);
  assert.equal(revokedRead.response.status, 404);
  assertNoDisclosure(revokedRead.body, [a.projectId, a.realmId, a.digest]);
  const replacementBody = await admin("/admin/issue-credential", { realmId: a.realmId, principalId: `${a.realmId}:owner` });
  const replacement = tokenFrom(replacementBody);
  const replacementRead = await realmRequest(a, "GET", `/api/projects/${a.projectId}`, undefined, replacement);
  assert.equal(replacementRead.response.status, 200);

  const stateBeforeCleanup = await admin("/admin/state");
  assert.equal(stateBeforeCleanup.credentialFree, true);
  assert.equal(JSON.stringify(stateBeforeCleanup).includes(a.token), false);
  assert.equal(JSON.stringify(stateBeforeCleanup).includes(replacement), false);

  cleanupResult = await admin("/admin/cleanup");
  assert.equal(cleanupResult.status, "cleaned");
  const stateAfterCleanup = await admin("/admin/state");
  assert.deepEqual(stateAfterCleanup.realms, []);
  assert.equal(stateAfterCleanup.observations, 0);

  console.log(JSON.stringify({ protocol, status: "succeeded", release: health.body.buildRevision, hostingMode: health.body.hostingMode, realms: [a.realmId, b.realmId], hosts: [a.host, b.host], positive: ["register", "create", "read", "mutate", "enumerate", "export"], negative: ["foreign-read", "foreign-mutation", "foreign-enumeration", "foreign-export", "missing-credential", "caller-header-ignored"], recovery: ["authorization-epoch-revocation", "replacement-credential", "credential-free-state"], cleanup: cleanupResult, startedAt, finishedAt: new Date().toISOString(), credentialValues: "not-printed", physicalIsolation: "not-claimed", anyamLimits: "none-added" }, null, 2));
}

try {
  await run();
} catch (error) {
  let cleanupError: string | undefined;
  try {
    cleanupResult = await admin("/admin/cleanup");
  } catch (cleanupFailure) {
    cleanupError = cleanupFailure instanceof Error ? cleanupFailure.message : "cleanup failed";
  }
  console.error(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : "qualification failed", cleanup: cleanupResult, cleanupError, credentialValues: "not-printed", recoveryAction: "inspect the named operation and verify the exact cohort before retrying" }, null, 2));
  process.exitCode = 1;
}
