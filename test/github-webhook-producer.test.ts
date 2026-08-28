import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  GITHUB_MIRROR_PRODUCER_PROTOCOL,
  GitHubWebhookMirrorProducer,
  parseGitHubMirrorProducerContext,
  type GitHubMirrorIngest,
  type GitHubMirrorProducerContext,
} from "../src/portability/github-webhook-producer.ts";
import { verifyMirrorIngestionHandoff } from "../src/portability/mirror-observation.ts";

const repository = "Whyme-Labs/anyam-github-app-qualification-20260827";
const installationId = "155172929";
const appId = "4656104";
const handoffSecret = "mirror-handoff-test-secret";
const baseCommit = "1111111111111111111111111111111111111111";
const headCommit = "2222222222222222222222222222222222222222";
const treeCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { privateKey: generatedPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = generatedPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1PrivateKey = generatedPrivateKey.export({ type: "pkcs1", format: "pem" }).toString();

const context: GitHubMirrorProducerContext = {
  protocol: "anyam.github-mirror-producer-context/v1",
  realmId: "realm:test",
  mirrorId: "mirror:test",
  projectId: "project:test",
  repositoryId: "repository:test",
  sourceSpaceId: "source:test",
  projectViewId: "project-view:test",
  remoteRepository: repository,
  installationId,
  canonicalProjectRevisionId: "project-revision:test:1",
  canonicalRefs: [{ name: "refs/heads/main", oid: baseCommit }],
  refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
  remoteGeneration: "remote:g0",
  remoteRefs: [],
  pendingInboundChangeIds: [],
  disclosure: "public",
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ repository: { full_name: repository }, installation: { id: Number(installationId) }, ref: "refs/heads/main", before: baseCommit, after: headCommit, deleted: false, forced: false, ...overrides });
}

function envelope(value: string, deliveryId = "delivery:producer-test"): Record<string, unknown> {
  return {
    protocol: "anyam.github-app-webhook/v1",
    realmId: "realm:test",
    event: "push",
    deliveryId,
    repository,
    installationId,
    body: value,
    signature: `sha256=${"a".repeat(64)}`,
    bodyDigest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    receivedAt: "2026-08-28T00:00:00.000Z",
    receipt: "fixture=github-webhook; providerReinspection=required; credentialMaterialStored=false",
  };
}

function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === `/app/installations/${installationId}/access_tokens` && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ token: "ghs-jit-token", expires_at: "2099-01-01T00:00:00.000Z" }), { status: 201 }));
  if (url.pathname === `/repos/${repository}/git/ref/heads/main`) return Promise.resolve(new Response(JSON.stringify({ object: { sha: headCommit } }), { status: 200 }));
  if (url.pathname.startsWith(`/repos/${repository}/compare/`)) return Promise.resolve(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }));
  if (url.pathname === `/repos/${repository}/commits/${headCommit}`) return Promise.resolve(new Response(JSON.stringify({ sha: headCommit, commit: { author: { name: "Contributor", email: "contributor@example.test" }, tree: { sha: treeCommit } } }), { status: 200 }));
  return Promise.resolve(new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
}

function pullRequestApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === `/repos/${repository}/pulls/42` && init?.method === "GET") return Promise.resolve(new Response(JSON.stringify({ number: 42, state: "open", merged: false, title: "Add feature", head: { ref: "feature", sha: headCommit }, base: { ref: "main", sha: baseCommit } }), { status: 200 }));
  return apiFetch(input, init);
}

function producer(ingest: GitHubMirrorIngest, key = privateKey) {
  return new GitHubWebhookMirrorProducer({
    api: {
      appId,
      installationId,
      repository,
      privateKey: key,
      jwtLifetimeSeconds: 600,
      jwtLifetimeReceipt: "fixture=github-provider; jwtLifetimeSeconds=600",
      clockSkewSeconds: 30,
      clockSkewReceipt: "fixture=github-provider; clockSkewSeconds=30",
      responseBytesLimit: 64 * 1024,
      responseBytesReceipt: "fixture=github-provider; responseBytesLimit=65536",
      requestTimeoutMs: 5_000,
      requestTimeoutReceipt: "fixture=github-provider; requestTimeoutMs=5000",
      fetchImpl: apiFetch,
    },
    realmId: "realm:test",
    appInstallationId: installationId,
    repository,
    handoffKeyId: "mirror-handoff-v1",
    handoffSecret,
    ingest,
    nowMilliseconds: () => Date.parse("2026-08-28T00:01:00.000Z"),
  });
}

function pullRequestProducer(ingest: GitHubMirrorIngest) {
  return new GitHubWebhookMirrorProducer({
    api: {
      appId,
      installationId,
      repository,
      privateKey,
      jwtLifetimeSeconds: 600,
      jwtLifetimeReceipt: "fixture=github-provider; jwtLifetimeSeconds=600",
      clockSkewSeconds: 30,
      clockSkewReceipt: "fixture=github-provider; clockSkewSeconds=30",
      responseBytesLimit: 64 * 1024,
      responseBytesReceipt: "fixture=github-provider; responseBytesLimit=65536",
      requestTimeoutMs: 5_000,
      requestTimeoutReceipt: "fixture=github-provider; requestTimeoutMs=5000",
      fetchImpl: pullRequestApiFetch,
    },
    realmId: "realm:test",
    appInstallationId: installationId,
    repository,
    handoffKeyId: "mirror-handoff-v1",
    handoffSecret,
    ingest,
    nowMilliseconds: () => Date.parse("2026-08-28T00:01:00.000Z"),
  });
}

test("Worker-compatible GitHub producer re-inspects a push, signs a Mirror handoff, and keeps credentials out of the result", async () => {
  let captured: unknown;
  const value = producer(async (handoff) => {
    captured = handoff;
    return { status: "succeeded", receipt: "fixture=realm-ingest; accepted=true; credentialMaterialStored=false" };
  });
  const result = await value.process({ envelope: envelope(body()), context });
  assert.equal(result.protocol, GITHUB_MIRROR_PRODUCER_PROTOCOL);
  assert.equal(result.status, "succeeded");
  assert.equal(result.deliveryId, "delivery:producer-test");
  assert.equal(result.receipt.includes(handoffSecret), false);
  assert.equal(JSON.stringify(result).includes("ghs-jit-token"), false);
  assert.ok(captured);
  const verified = await verifyMirrorIngestionHandoff({ value: captured, keyId: "mirror-handoff-v1", secret: handoffSecret, now: Date.parse("2026-08-28T00:00:00.000Z") });
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.equal(verified.handoff.command.command, "mirror.sync");
    assert.equal(verified.handoff.command.payload.mirrorId, "mirror:test");
    assert.equal((verified.handoff.command.payload.remoteRefs as Array<{ name: string; oid: string }>)[0]?.oid, headCommit);
  }
});

test("Worker-compatible GitHub producer treats an Authority handoff replay as an acknowledged duplicate", async () => {
  let calls = 0;
  const value = producer(async () => {
    calls += 1;
    return calls === 1
      ? { status: "succeeded", receipt: "fixture=realm-ingest; accepted=true; credentialMaterialStored=false" }
      : { status: "succeeded", duplicate: true, receipt: "fixture=realm-ingest; handoff-replay=true; credentialMaterialStored=false" };
  });
  const first = await value.process({ envelope: envelope(body(), "delivery:duplicate"), context });
  const duplicate = await value.process({ envelope: envelope(body(), "delivery:duplicate"), context });
  assert.equal(first.status, "succeeded");
  assert.equal(duplicate.status, "succeeded");
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 2);
});

test("Worker-compatible GitHub producer imports GitHub's RSA PRIVATE KEY PEM form", async () => {
  const value = producer(async () => ({ status: "succeeded", receipt: "fixture=realm-ingest; accepted=true; credentialMaterialStored=false" }), pkcs1PrivateKey);
  const result = await value.process({ envelope: envelope(body(), "delivery:pkcs1"), context });
  assert.equal(result.status, "succeeded");
});

test("Worker-compatible GitHub producer refuses a forced or deleted push before creating a signed handoff", async () => {
  let ingestCalls = 0;
  const value = producer(async () => {
    ingestCalls += 1;
    return { status: "succeeded", receipt: "unexpected" };
  });
  const forced = await value.process({ envelope: envelope(body({ forced: true }), "delivery:forced"), context });
  assert.equal(forced.status, "blocked");
  assert.equal(forced.code, "force_push_detected");
  const deleted = await value.process({ envelope: envelope(body({ deleted: true }), "delivery:deleted"), context });
  assert.equal(deleted.status, "blocked");
  assert.equal(deleted.code, "ref_deleted");
  assert.equal(ingestCalls, 0);
});

test("Worker-compatible GitHub producer re-inspects pull requests without widening mapped ref state", async () => {
  let captured: Record<string, unknown> | undefined;
  const value = pullRequestProducer(async (handoff) => {
    captured = handoff as unknown as Record<string, unknown>;
    return { status: "succeeded", receipt: "fixture=realm-ingest; accepted=true; credentialMaterialStored=false" };
  });
  const pullRequestBody = body({ action: "opened", number: 42 });
  const result = await value.process({ envelope: { ...envelope(pullRequestBody, "delivery:pull-request"), event: "pull_request", action: "opened" }, context });
  assert.equal(result.status, "succeeded");
  assert.ok(captured);
  const command = captured?.command as Record<string, unknown>;
  const payload = command.payload as Record<string, unknown>;
  assert.deepEqual(payload.remoteRefs, [{ name: "refs/heads/main", oid: headCommit }]);
  assert.equal((payload.externalProposal as Record<string, unknown>).proposalKind, "pull-request");
  assert.equal((payload.externalProposal as Record<string, unknown>).proposalKey, "42");
});

test("Worker-compatible GitHub producer rejects a tampered Queue envelope and mismatched Realm context", async () => {
  const value = producer(async () => ({ status: "succeeded", receipt: "unexpected" }));
  const tampered = envelope(body(), "delivery:tampered");
  tampered.bodyDigest = "sha256:" + "0".repeat(64);
  const digestResult = await value.process({ envelope: tampered, context });
  assert.equal(digestResult.status, "blocked");
  assert.match(digestResult.receipt, /bodyDigest=mismatch/u);

  const mismatch = await value.process({ envelope: envelope(body(), "delivery:mismatch"), context: { ...context, remoteRepository: "Whyme-Labs/other" } });
  assert.equal(mismatch.status, "blocked");
  assert.match(mismatch.receipt, /binding=mismatch/u);
});

test("Worker-compatible GitHub producer context parser rejects incomplete or non-Git identities", () => {
  assert.throws(() => parseGitHubMirrorProducerContext({ ...context, canonicalRefs: [{ name: "refs/heads/main", oid: "not-an-oid" }] }));
  assert.throws(() => parseGitHubMirrorProducerContext({ ...context, protocol: "wrong/v1" }));
});
