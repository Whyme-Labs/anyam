import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleGitHubWebhookRequest, type GitHubWebhookEnv } from "../apps/realm-worker/src/github-webhook-route.ts";

const SECRET = "webhook-secret-for-tests";
const INSTALLATION_ID = "155172929";
const REPOSITORY = "Whyme-Labs/anyam-github-app-qualification-20260827";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { full_name: REPOSITORY },
    installation: { id: Number(INSTALLATION_ID) },
    ref: "refs/heads/main",
    after: "0123456789012345678901234567890123456789",
    ...overrides,
  };
}

function signature(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function request(body: string, input: { event?: string; delivery?: string; secret?: string; contentType?: string; method?: string; extraHeaders?: Record<string, string> } = {}): Request {
  const headers = new Headers({
    "content-type": input.contentType ?? "application/json",
    "x-github-event": input.event ?? "push",
    "x-github-delivery": input.delivery ?? "delivery:test-1",
    "x-hub-signature-256": signature(body, input.secret ?? SECRET),
    ...input.extraHeaders,
  });
  const method = input.method ?? "POST";
  return new Request("https://realm.example/webhooks/github", { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) });
}

function environment(overrides: Record<string, unknown> = {}): { env: GitHubWebhookEnv; queued: unknown[] } {
  const queued: unknown[] = [];
  const env = {
    ANYAM_INSTALLATION_ID: "anyam-p3-24-live-20260810",
    ANYAM_GITHUB_APP_REPOSITORY: REPOSITORY,
    ANYAM_GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    ANYAM_GITHUB_APP_WEBHOOK_SECRET: SECRET,
    ANYAM_GITHUB_WEBHOOK_BODY_BYTES_LIMIT: "1024",
    ANYAM_GITHUB_WEBHOOK_BODY_BYTES_RECEIPT: "fixture=github-webhook; bodyBytesLimit=1024",
    ANYAM_GITHUB_WEBHOOK_RATE_LIMIT_RECEIPT: "fixture=github-webhook; limit=100; period=60s",
    ANYAM_GITHUB_WEBHOOK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ANYAM_GITHUB_MIRROR_PRODUCER: { fetch: async () => new Response(JSON.stringify({ status: "succeeded" })) },
    ANYAM_EVENTS: { send: async (value: unknown) => { queued.push(value); } },
    ...overrides,
  } as GitHubWebhookEnv;
  return { env, queued };
}

test("GitHub webhook ingress verifies the raw body, queues a credential-free hint, and does not echo it", async () => {
  const body = JSON.stringify(payload());
  const { env, queued } = environment();
  const response = await handleGitHubWebhookRequest(request(body), env);
  assert.equal(response?.status, 202);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  const responseBody = await response?.json() as Record<string, unknown>;
  assert.equal(responseBody.status, "accepted");
  assert.equal(responseBody.deliveryId, "delivery:test-1");
  assert.equal(responseBody.repository, REPOSITORY);
  assert.equal(responseBody.providerReinspection, "required");
  assert.equal(responseBody.providerMutation, false);
  assert.equal(responseBody.credentialMaterialStored, false);
  assert.equal("body" in responseBody, false);
  assert.equal("signature" in responseBody, false);
  assert.equal(JSON.stringify(responseBody).includes(SECRET), false);
  assert.equal(queued.length, 1);
  const envelope = queued[0] as Record<string, unknown>;
  assert.equal(envelope.protocol, "anyam.github-app-webhook/v1");
  assert.equal(envelope.realmId, "realm:anyam-p3-24-live-20260810");
  assert.equal(envelope.body, body);
  assert.equal(envelope.signature, signature(body));
  assert.equal(envelope.bodyDigest, responseBody.bodyDigest);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
});

test("GitHub webhook ingress rejects an invalid signature before queueing", async () => {
  const body = JSON.stringify(payload());
  const { env, queued } = environment();
  const response = await handleGitHubWebhookRequest(request(body, { secret: "wrong-secret" }), env);
  assert.equal(response?.status, 401);
  assert.equal((await response?.json() as Record<string, unknown>).code, "signature_invalid");
  assert.equal(queued.length, 0);
});

test("GitHub webhook ingress requires the configured repository and App installation binding", async () => {
  const body = JSON.stringify(payload());
  const missing = environment({ ANYAM_GITHUB_APP_REPOSITORY: undefined, ANYAM_GITHUB_APP_INSTALLATION_ID: undefined });
  const missingResponse = await handleGitHubWebhookRequest(request(body), missing.env);
  assert.equal(missingResponse?.status, 503);
  assert.equal((await missingResponse?.json() as Record<string, unknown>).code, "binding_unconfigured");
  assert.equal(missing.queued.length, 0);

  const mismatch = environment({ ANYAM_GITHUB_APP_REPOSITORY: "Whyme-Labs/another-repository" });
  const mismatchResponse = await handleGitHubWebhookRequest(request(body, { delivery: "delivery:binding-mismatch" }), mismatch.env);
  assert.equal(mismatchResponse?.status, 403);
  assert.equal((await mismatchResponse?.json() as Record<string, unknown>).code, "binding_mismatch");
  assert.equal(mismatch.queued.length, 0);
});

test("GitHub webhook ingress requires a delivery identity for accepted events", async () => {
  const body = JSON.stringify(payload());
  const { env, queued } = environment();
  const response = await handleGitHubWebhookRequest(request(body, { extraHeaders: { "x-github-delivery": "" } }), env);
  assert.equal(response?.status, 422);
  assert.equal((await response?.json() as Record<string, unknown>).code, "delivery_missing");
  assert.equal(queued.length, 0);
});

test("GitHub webhook ingress ignores unsupported events and pull-request actions", async () => {
  const pushBody = JSON.stringify(payload());
  const push = environment();
  const unsupported = await handleGitHubWebhookRequest(request(pushBody, { event: "ping" }), push.env);
  assert.equal(unsupported?.status, 202);
  assert.equal((await unsupported?.json() as Record<string, unknown>).status, "ignored");
  assert.equal(push.queued.length, 0);

  const pullRequestBody = JSON.stringify(payload({ action: "labeled" }));
  const pullRequest = environment();
  const ignoredAction = await handleGitHubWebhookRequest(request(pullRequestBody, { event: "pull_request", delivery: "delivery:test-2" }), pullRequest.env);
  assert.equal(ignoredAction?.status, 202);
  assert.equal((await ignoredAction?.json() as Record<string, unknown>).status, "ignored");
  assert.equal(pullRequest.queued.length, 0);
});

test("GitHub webhook ingress blocks malformed provider identity and wrong media types", async () => {
  const malformed = environment();
  const malformedResponse = await handleGitHubWebhookRequest(request(JSON.stringify({ installation: { id: INSTALLATION_ID } })), malformed.env);
  assert.equal(malformedResponse?.status, 422);
  assert.equal((await malformedResponse?.json() as Record<string, unknown>).code, "payload_identity_invalid");
  assert.equal(malformed.queued.length, 0);

  const wrongMedia = environment();
  const wrongMediaResponse = await handleGitHubWebhookRequest(request(JSON.stringify(payload()), { contentType: "application/x-www-form-urlencoded" }), wrongMedia.env);
  assert.equal(wrongMediaResponse?.status, 415);
  assert.equal((await wrongMediaResponse?.json() as Record<string, unknown>).code, "content_type_invalid");
  assert.equal(wrongMedia.queued.length, 0);
});

test("GitHub webhook ingress enforces the body tripwire while streaming a body without Content-Length", async () => {
  const { env, queued } = environment();
  const body = JSON.stringify(payload({ padding: "x".repeat(2_000) }));
  const encoded = new TextEncoder().encode(body);
  const requestWithStream = new Request("https://realm.example/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "delivery:oversized",
      "x-hub-signature-256": signature(body),
    },
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded.slice(0, 1_100)); controller.enqueue(encoded.slice(1_100)); controller.close(); } }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleGitHubWebhookRequest(requestWithStream, env);
  assert.equal(response?.status, 413);
  const responseBody = await response?.json() as Record<string, unknown>;
  assert.equal(responseBody.code, "body_too_large");
  assert.match(String(responseBody.receipt), /bodyBytesLimit=1024/u);
  assert.equal(queued.length, 0);
});

test("GitHub webhook ingress distinguishes a failed body read from an oversized body", async () => {
  const { env, queued } = environment();
  const requestWithError = new Request("https://realm.example/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "delivery:read-error",
      "x-hub-signature-256": signature("unreadable"),
    },
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("body unavailable")); } }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleGitHubWebhookRequest(requestWithError, env);
  assert.equal(response?.status, 503);
  assert.equal((await response?.json() as Record<string, unknown>).code, "body_read_failed");
  assert.equal(queued.length, 0);
});

test("GitHub webhook ingress fails closed when its secret, queue, or realm is not configured", async () => {
  const body = JSON.stringify(payload());
  const missingSecret = environment({ ANYAM_GITHUB_APP_WEBHOOK_SECRET: undefined });
  const secretResponse = await handleGitHubWebhookRequest(request(body), missingSecret.env);
  assert.equal(secretResponse?.status, 503);
  assert.equal((await secretResponse?.json() as Record<string, unknown>).code, "secret_unconfigured");

  const missingQueue = environment({ ANYAM_EVENTS: undefined });
  const queueResponse = await handleGitHubWebhookRequest(request(body), missingQueue.env);
  assert.equal(queueResponse?.status, 503);
  assert.equal((await queueResponse?.json() as Record<string, unknown>).code, "queue_unconfigured");

  const missingRealm = environment({ ANYAM_INSTALLATION_ID: undefined });
  const realmResponse = await handleGitHubWebhookRequest(request(body), missingRealm.env);
  assert.equal(realmResponse?.status, 503);
  assert.equal((await realmResponse?.json() as Record<string, unknown>).code, "realm_unconfigured");

  const missingProducer = environment({ ANYAM_GITHUB_MIRROR_PRODUCER: undefined });
  const producerResponse = await handleGitHubWebhookRequest(request(body), missingProducer.env);
  assert.equal(producerResponse?.status, 503);
  assert.equal((await producerResponse?.json() as Record<string, unknown>).code, "producer_unconfigured");

  const missingRateLimiter = environment({ ANYAM_GITHUB_WEBHOOK_RATE_LIMITER: undefined });
  const rateLimiterResponse = await handleGitHubWebhookRequest(request(body), missingRateLimiter.env);
  assert.equal(rateLimiterResponse?.status, 503);
  assert.equal((await rateLimiterResponse?.json() as Record<string, unknown>).code, "rate_limiter_unconfigured");
});

test("GitHub webhook ingress returns 429 when the Cloudflare Rate Limit binding trips", async () => {
  const { env, queued } = environment({ ANYAM_GITHUB_WEBHOOK_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const response = await handleGitHubWebhookRequest(request(JSON.stringify(payload())), env);
  assert.equal(response?.status, 429);
  assert.equal((await response?.json() as Record<string, unknown>).code, "rate_limited");
  assert.equal(queued.length, 0);
});

test("GitHub webhook ingress reports queue delivery failure without acknowledging the provider", async () => {
  const body = JSON.stringify(payload());
  const { env } = environment({ ANYAM_EVENTS: { send: async () => { throw new Error("queue unavailable"); } } });
  const response = await handleGitHubWebhookRequest(request(body), env);
  assert.equal(response?.status, 503);
  const responseBody = await response?.json() as Record<string, unknown>;
  assert.equal(responseBody.code, "queue_unavailable");
  assert.equal(responseBody.providerMutation, false);
  assert.equal(responseBody.credentialMaterialStored, false);
});

test("GitHub webhook ingress exposes only its exact POST route", async () => {
  const { env } = environment();
  assert.equal(await handleGitHubWebhookRequest(new Request("https://realm.example/other"), env), undefined);
  const method = await handleGitHubWebhookRequest(request("", { method: "GET" }), env);
  assert.equal(method?.status, 405);
});
