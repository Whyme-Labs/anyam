import assert from "node:assert/strict";

import { handleAnyamRealmMcpRequest, type AnyamRealmMcpEnv, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

const protocol = "anyam.mcp-delivery-mutation-qualification/v1" as const;
const sessionId = "kernel-session:mcp-delivery-qualification";
const grantId = "grant:mcp-delivery-qualification";

type JsonObject = Record<string, unknown>;

function safeResponse(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function coordinatorValue(command: string, payload: JsonObject): JsonObject {
  if (payload.projectId === "project:hidden") throw new Error("not_found");
  if (command === "landing.apply") return {
    landing: { protocol: "anyam.landing/v1", id: String(payload.landingId ?? "landing:qualification"), projectId: String(payload.projectId), changeId: String(payload.changeId), changeRevisionId: String(payload.changeRevisionId), previousProjectRevisionId: "project-revision:qualification:1", projectRevisionId: String(payload.projectRevisionId ?? "project-revision:qualification:2") },
    canonicalRevision: { protocol: "anyam.kernel/v1", id: String(payload.projectRevisionId ?? "project-revision:qualification:2"), projectId: String(payload.projectId) },
    change: { protocol: "anyam.change/v1", id: String(payload.changeId), projectId: String(payload.projectId), intentId: "intent:qualification", baseProjectRevisionId: "project-revision:qualification:1", status: "landed", latestRevisionId: String(payload.changeRevisionId) },
  };
  if (command === "release.create") return {
    release: { protocol: "anyam.release/v1", id: String(payload.releaseId ?? "release:qualification"), projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), artifactIds: payload.artifactIds, evidenceIds: payload.evidenceIds, policyVersion: String(payload.policyVersion), status: "ready" },
  };
  if (command === "target.configure") return {
    target: { protocol: "anyam.target/v1", id: String(payload.targetId ?? "target:qualification"), projectId: String(payload.projectId), name: String(payload.name), adapterId: String(payload.adapterId), acceptedArtifactTypes: payload.acceptedArtifactTypes, requiredEvidenceKeys: payload.requiredEvidenceKeys ?? [], state: "configured" },
  };
  if (command === "promotion.request") return {
    promotion: { protocol: "anyam.promotion/v1", id: String(payload.promotionId ?? "promotion:qualification"), projectId: String(payload.projectId), targetId: String(payload.targetId), releaseId: String(payload.releaseId), releaseDigest: String(payload.releaseDigest ?? "sha256:qualification"), previousReleaseId: null, expectedCurrentReleaseId: payload.expectedCurrentReleaseId ?? null, state: "requested", attempt: 1, kind: "request" },
    target: { protocol: "anyam.target/v1", id: String(payload.targetId), projectId: String(payload.projectId), name: "Qualification target", adapterId: "adapter:qualification", state: "configured" },
    release: { protocol: "anyam.release/v1", id: String(payload.releaseId), projectRevisionId: "project-revision:qualification:2", status: "ready" },
  };
  throw new Error("invalid_request");
}

function fixture(): { env: AnyamRealmMcpEnv; calls: JsonObject[] } {
  const calls: JsonObject[] = [];
  const idempotency = new Map<string, { fingerprint: string; result: JsonObject }>();
  const namespace = {
    idFromName: (name: string): string => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const body = await request.json() as JsonObject;
        calls.push(body);
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return safeResponse({ code: "internal_binding_required" }, 403);
        if (body.sessionId !== sessionId) return safeResponse({ code: "session.invalid" }, 403);
        if (new URL(request.url).pathname !== "/authority/command/internal") return safeResponse({ code: "not_found" }, 404);
        const command = String(body.command);
        const payload = body.payload as JsonObject;
        const key = `${command}:${String(body.idempotencyKey)}`;
        const fingerprint = JSON.stringify({ command, payload, expectedVersion: body.expectedVersion });
        const prior = idempotency.get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint) return safeResponse({ code: "idempotency_conflict", receipt: "idempotency=conflict; credentialFree=true; canonicalWrite=false" }, 409);
          return safeResponse(prior.result);
        }
        let value: JsonObject;
        try {
          value = coordinatorValue(command, payload);
        } catch (error) {
          return safeResponse({ code: error instanceof Error && error.message === "not_found" ? "not_found" : "invalid_request", receipt: "resource=hidden; discoverable=false; credentialFree=true" }, error instanceof Error && error.message === "not_found" ? 404 : 422);
        }
        const result = { protocol: "anyam.authority-plane/v1", status: "succeeded", version: 1, value, receipt: `authority=fixture; operation=${command}; credentialFree=true; canonicalWrite=false` };
        idempotency.set(key, { fingerprint, result });
        return safeResponse(result);
      },
    }),
  };
  return { env: { ANYAM_INSTALLATION_ID: "mcp-delivery-qualification", REALM_COORDINATOR: namespace }, calls };
}

function post(value: unknown): Request {
  return new Request("https://qualification.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

async function json(response: Response): Promise<JsonObject> {
  return await response.json() as JsonObject;
}

function assertCredentialFree(value: unknown): void {
  const encoded = JSON.stringify(value);
  assert.equal(/(?:cfat_|bearer\s+|access[_-]?token|secret|password|kernel-session|grant:mcp-delivery)/iu.test(encoded), false, encoded);
}

const props: AnyamRealmMcpProps = { scopes: ["landing.request", "release.create", "target.configure", "promotion.request"], kernelSessionId: sessionId, anyamGrantId: grantId };
const operations = [
  { name: "landing.apply", resource: "landing", args: { idempotencyKey: "qualification:landing", projectId: "project:qualification", changeId: "change:qualification", changeRevisionId: "change-revision:qualification:1", expectedCanonicalProjectRevisionId: "project-revision:qualification:1", projectRevisionId: "project-revision:qualification:2" } },
  { name: "release.create", resource: "release", args: { idempotencyKey: "qualification:release", projectId: "project:qualification", releaseId: "release:qualification", projectRevisionId: "project-revision:qualification:2", artifactIds: ["artifact:qualification"], evidenceIds: ["evidence:qualification"], policyVersion: "policy:qualification" } },
  { name: "target.configure", resource: "target", args: { idempotencyKey: "qualification:target", projectId: "project:qualification", targetId: "target:qualification", name: "Qualification target", adapterId: "adapter:qualification", acceptedArtifactTypes: ["cli.archive"] } },
  { name: "promotion.request", resource: "promotion", args: { idempotencyKey: "qualification:promotion", projectId: "project:qualification", promotionId: "promotion:qualification", releaseId: "release:qualification", targetId: "target:qualification", releaseDigest: "sha256:qualification" } },
] as const;

try {
  const fixtureState = fixture();
  const listed = await json(await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixtureState.env, props));
  const tools = ((listed.result as JsonObject).tools as JsonObject[]).map((tool) => tool.name);
  assert.deepEqual(tools, operations.map((operation) => operation.name));
  const results: JsonObject[] = [];
  for (const [index, operation] of operations.entries()) {
    const response = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: operation.name, arguments: operation.args } }), fixtureState.env, props);
    const body = await json(response);
    const result = body.result as JsonObject;
    const content = result.structuredContent as JsonObject;
    assert.equal(result.isError, false);
    assert.equal(content.protocol, "anyam.remote-mcp/v1");
    assert.equal(content.canonicalWrite, false);
    assert.equal(content.credentialFree, true);
    assert.ok(content[operation.resource]);
    assert.match(String(content.receipt), /typedSurface=mcp;.*grant=validated;.*providerExecution=not-performed/);
    assertCredentialFree(body);
    results.push(content);
    const replay = await json(await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: index + 20, method: "tools/call", params: { name: operation.name, arguments: operation.args } }), fixtureState.env, props));
    assert.deepEqual((replay.result as JsonObject).structuredContent, content);
  }
  const beforeMalformed = fixtureState.calls.length;
  const malformed = await json(await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "landing.apply", arguments: { ...operations[0].args, unsupported: true } } }), fixtureState.env, props));
  assert.equal((malformed.error as JsonObject).code, -32602);
  assert.equal(fixtureState.calls.length, beforeMalformed);
  const hidden = await json(await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "target.configure", arguments: { ...operations[2].args, idempotencyKey: "qualification:hidden", projectId: "project:hidden" } } }), fixtureState.env, props));
  assert.equal((hidden.error as JsonObject).code, -32004);
  assertCredentialFree(hidden);
  const missingGrant = await json(await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "landing.apply", arguments: operations[0].args } }), fixtureState.env, { scopes: props.scopes, kernelSessionId: sessionId }));
  assert.equal((missingGrant.error as JsonObject).code, -32001);
  assert.match(String(((missingGrant.error as JsonObject).data as JsonObject).receipt), /grant=missing/);
  assertCredentialFree(missingGrant);
  console.log(JSON.stringify({ protocol, status: "succeeded", tools, operations: results.map((result) => ({ operation: (result.receipt as string).match(/operation=([^;]+)/)?.[1], status: result.status, canonicalWrite: result.canonicalWrite, credentialFree: result.credentialFree })), replay: "deterministic", malformed: "rejected-before-coordinator", hidden: "not-disclosed", missingGrant: "blocked", credentialValues: "not-printed", providerExecution: "not-performed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, receipt: "scope-filtered; grant-bound; typed-contracts; idempotent; credential-free" }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", canonicalWrite: false, providerExecution: "not-performed", recoveryAction: "inspect the typed MCP fixture boundary and retry the same bounded qualification", receipt: "providerInvocation=fixture-only; no live delivery transition claimed" }, null, 2));
  process.exitCode = 2;
}
