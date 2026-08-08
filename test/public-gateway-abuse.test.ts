import assert from "node:assert/strict";
import test from "node:test";

import {
  TURNSTILE_TOKEN_MAX_LENGTH,
  TurnstilePublicGatewayAbuseProvider,
  type TurnstileSiteverifyResponse,
} from "../src/index.ts";

function provider(fetcher: typeof fetch): TurnstilePublicGatewayAbuseProvider {
  return new TurnstilePublicGatewayAbuseProvider({
    secretKey: "customer-owned-secret",
    timeoutMs: 100,
    timeoutReceipt: "receipt:test-turnstile-timeout",
    expectedAction: "public-contribution",
    expectedHostname: "public.example.test",
    fetcher,
  });
}

function response(body: TurnstileSiteverifyResponse, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Turnstile success is result-only and never exposes the provider secret", async () => {
  let submitted: Record<string, unknown> | undefined;
  const decision = await provider(async (_url, init) => {
    submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({ success: true, action: "public-contribution", hostname: "public.example.test" });
  }).evaluate({ requestId: "request:turnstile-pass", token: "token:valid", clientIp: "203.0.113.10" });

  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.resultOnly, true);
  assert.equal(decision.materialized, false);
  assert.equal(submitted?.secret, "customer-owned-secret");
  assert.doesNotMatch(JSON.stringify(decision), /customer-owned-secret/);
  assert.doesNotMatch(decision.receipt, /token:valid/);
});

test("missing, oversized, rejected, and mismatched tokens challenge without materialization", async () => {
  let calls = 0;
  const check = provider(async () => {
    calls += 1;
    return response({ success: false, "error-codes": ["timeout-or-duplicate"] });
  });

  const missing = await check.evaluate({ requestId: "request:turnstile-missing" });
  assert.equal(missing.outcome, "challenge");
  assert.equal(missing.reason, "token-missing");
  assert.equal(missing.materialized, false);

  const oversized = await check.evaluate({ requestId: "request:turnstile-oversized", token: "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1) });
  assert.equal(oversized.reason, "token-too-long");
  assert.equal(calls, 0);

  const rejected = await check.evaluate({ requestId: "request:turnstile-rejected", token: "token:replayed" });
  assert.equal(rejected.reason, "token-rejected");
  assert.match(rejected.receipt, /token-reused-or-expired/);
  assert.doesNotMatch(rejected.receipt, /timeout-or-duplicate/);

  const mismatch = await provider(async () => response({ success: true, action: "wrong-action", hostname: "public.example.test" })).evaluate({ requestId: "request:turnstile-mismatch", token: "token:mismatch" });
  assert.equal(mismatch.reason, "token-mismatch");
  assert.equal(mismatch.outcome, "challenge");
});

test("provider HTTP failure and timeout are fail-closed and retry with a fresh token", async () => {
  const unavailable = await provider(async () => response({}, 503)).evaluate({ requestId: "request:turnstile-503", token: "token:provider" });
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(unavailable.retryable, true);
  assert.match(unavailable.nextAction, /fresh Turnstile token/);
  assert.match(unavailable.receipt, /failClosed=true/);

  const timedOut = await provider(async (_url, init) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    return response({ success: true });
  }).evaluate({ requestId: "request:turnstile-timeout", token: "token:timeout" });
  assert.equal(timedOut.outcome, "unavailable");
  assert.equal(timedOut.reason, "provider-timeout");
  assert.match(timedOut.receipt, /timeoutReceipt=receipt:test-turnstile-timeout/);
  assert.equal(timedOut.materialized, false);
});
