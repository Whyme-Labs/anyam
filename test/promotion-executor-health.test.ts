import assert from "node:assert/strict";
import test from "node:test";

import { promotionExecutorHealth } from "../apps/promotion-executor/src/health.ts";
import { claimPromotionNonce, type PromotionNonceStorage } from "../src/cloudflare/promotion-executor-nonce.ts";

test("unauthenticated executor health denies without probing provider credentials", () => {
  const result = promotionExecutorHealth({ authorized: false, configuration: "ready" });
  assert.equal(result.httpStatus, 404);
  assert.match(String(result.body.receipt), /providerProbe=not-performed/);
  assert.equal(JSON.stringify(result).includes("credentialId"), false);
  assert.equal(JSON.stringify(result).includes("providerOperation"), false);
});

test("service-bound health is useful only with a credential-free installation receipt", () => {
  const missing = promotionExecutorHealth({ authorized: true, configuration: "ready" });
  assert.equal(missing.httpStatus, 503);
  assert.equal(missing.body.code, "provider_qualification_receipt_missing");
  const unsafe = promotionExecutorHealth({ authorized: true, configuration: "ready", qualificationReceipt: "token=secret" });
  assert.equal(unsafe.httpStatus, 503);
  const healthy = promotionExecutorHealth({ authorized: true, configuration: "ready", qualificationReceipt: "qualification=install-probe; providerWrite=observed; keyId=redacted" });
  assert.equal(healthy.httpStatus, 200);
  assert.equal(healthy.status, "healthy");
  assert.equal(JSON.stringify(healthy).includes("credentialId"), false);
  assert.equal(JSON.stringify(healthy).includes("providerOperationId"), false);
});

test("nonce claims compact expired entries while retaining active replay protection", async () => {
  const values = new Map<string, { expiresAt?: string }>([
    ["nonce:expired", { expiresAt: "2026-08-21T00:00:00.000Z" }],
    ["nonce:active", { expiresAt: "2026-08-23T00:00:00.000Z" }],
  ]);
  const deleted: string[] = [];
  const storage: PromotionNonceStorage = {
    async list() { return new Map(values); },
    async delete(key) { deleted.push(key); values.delete(key); },
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
  };
  const now = () => "2026-08-22T00:00:00.000Z";
  assert.equal(await claimPromotionNonce({ nonce: "fresh", expiresAt: "2026-08-23T00:00:00.000Z", storage, now }), "claimed");
  assert.deepEqual(deleted, ["nonce:expired"]);
  assert.equal(await claimPromotionNonce({ nonce: "active", expiresAt: "2026-08-23T00:00:00.000Z", storage, now }), "duplicate");
  assert.equal(await claimPromotionNonce({ nonce: "fresh", expiresAt: "2026-08-23T00:00:00.000Z", storage, now }), "duplicate");
});
