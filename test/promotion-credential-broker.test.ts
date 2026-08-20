import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareApiTokenCredentialBroker,
  type CloudflareApiTokenMaterial,
  PromotionCredentialBrokerError,
} from "../src/cloudflare/promotion-credential-broker.ts";
import type {
  CloudflareWorkerApiRequest,
  CloudflareWorkerApiResponse,
  CloudflareWorkerTargetOperation,
} from "../src/cloudflare/worker-target.ts";

type Verification = { id: string; status: "active" | "disabled"; expires_on: string };

class CredentialProviderFixture {
  verification: Verification = { id: "provider-credential:v1", status: "active", expires_on: "2099-01-01T00:00:00.000Z" };
  targetAuthorized = true;
  loseNextProbe = false;
  readonly requests: CloudflareWorkerApiRequest[] = [];

  async request<T>(request: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>> {
    this.requests.push(request);
    if (this.loseNextProbe) {
      this.loseNextProbe = false;
      throw new Error("simulated provider response loss");
    }
    if (request.path.endsWith("/tokens/verify")) return { status: 200, ok: true, result: this.verification as T, errors: [], messages: [] };
    if (request.path.includes("/workers/scripts/") && request.path.includes("/versions?")) {
      return this.targetAuthorized
        ? { status: 200, ok: true, result: { items: [] } as T, errors: [], messages: [] }
        : { status: 403, ok: false, errors: [{ code: 10000, message: "not authorized" }], messages: [] };
    }
    return { status: 404, ok: false, errors: [{ code: 10007, message: "unknown fixture route" }], messages: [] };
  }
}

function broker(fixture: CredentialProviderFixture, source: () => CloudflareApiTokenMaterial = () => ({ token: "opaque-provider-token", sourceId: "secret-version:v1", scopes: ["workers:read", "workers:write"] })) {
  return new CloudflareApiTokenCredentialBroker({
    accountId: "account:broker-test",
    scriptName: "worker-broker-test",
    targetId: "target:broker-test",
    tokenSource: async () => source(),
    transport: fixture,
    now: () => "2026-08-21T00:00:00.000Z",
  });
}

test("credential broker observes provider expiry and Target authorization without serializing secret material", async () => {
  const fixture = new CredentialProviderFixture();
  const result = await broker(fixture).issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "apply", audience: "aud:anyam:promotion" });
  assert.equal(result.providerAuthorization, "observed");
  assert.equal(result.credentialId, "provider-credential:v1");
  assert.deepEqual(result.scopes, ["workers:read", "workers:write"]);
  assert.match(result.receipt, /providerCredentialExpiresAt=2099-01-01T00:00:00.000Z/);
  assert.equal(result.receipt.includes("opaque-provider-token"), false);
  assert.equal(JSON.stringify(result).includes("opaque-provider-token"), true, "token remains only in the in-memory request credential, never in its receipt");
});

test("credential rotation is observed on the next issue without restarting the broker", async () => {
  const fixture = new CredentialProviderFixture();
  let material: CloudflareApiTokenMaterial = { token: "token-v1", sourceId: "secret-version:v1", scopes: ["workers:read", "workers:write"] };
  const instance = broker(fixture, () => material);
  const first = await instance.issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "preview", audience: "aud:anyam:deployment" });
  fixture.verification = { ...fixture.verification, id: "provider-credential:v2" };
  material = { token: "token-v2", sourceId: "secret-version:v2", scopes: ["workers:read", "workers:write"] };
  const second = await instance.issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "preview", audience: "aud:anyam:deployment" });
  assert.equal(first.credentialId, "provider-credential:v1");
  assert.equal(second.credentialId, "provider-credential:v2");
  assert.match(second.receipt, /credentialRotation=observed/);
  assert.equal(fixture.requests.at(-1)?.token, "token-v2");
  assert.equal(second.receipt.includes("token-v2"), false);
});

test("revoked or expired provider credentials fail before Target authorization or mutation", async () => {
  const fixture = new CredentialProviderFixture();
  fixture.verification = { id: "provider-credential:revoked", status: "disabled", expires_on: "2099-01-01T00:00:00.000Z" };
  await assert.rejects(
    broker(fixture).issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "apply", audience: "aud:anyam:promotion" }),
    (error: unknown) => error instanceof PromotionCredentialBrokerError && error.code === "provider-revoked" && /providerAuthorization=revoked/.test(error.receipt),
  );
  assert.equal(fixture.requests.length, 1, "revocation stops before the Target authorization read");
  fixture.verification = { id: "provider-credential:expired", status: "active", expires_on: "2020-01-01T00:00:00.000Z" };
  await assert.rejects(
    broker(fixture).issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "apply", audience: "aud:anyam:promotion" }),
    (error: unknown) => error instanceof PromotionCredentialBrokerError && error.code === "provider-expired" && /providerAuthorization=expired/.test(error.receipt),
  );
  assert.equal(fixture.requests.length, 2, "expiry stops before the Target authorization read");
});

test("provider response loss and target scope rejection remain actionable and credential-free", async () => {
  const fixture = new CredentialProviderFixture();
  fixture.loseNextProbe = true;
  await assert.rejects(
    broker(fixture).probe({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test" }),
    (error: unknown) => error instanceof PromotionCredentialBrokerError && error.code === "source-unavailable" && /providerAuthorization=indeterminate/.test(error.receipt) && !error.receipt.includes("opaque-provider-token"),
  );
  fixture.targetAuthorized = false;
  await assert.rejects(
    broker(fixture).issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "apply", audience: "aud:anyam:promotion" }),
    (error: unknown) => error instanceof PromotionCredentialBrokerError && error.code === "provider-unauthorized" && /target=target:broker-test/.test(error.receipt),
  );
});

test("operation-specific source can narrow credentials when the provider supports it", async () => {
  const fixture = new CredentialProviderFixture();
  const sources: Record<string, CloudflareApiTokenMaterial> = {
    preview: { token: "read-token", sourceId: "secret:read", scopes: ["workers:read"] },
    apply: { token: "write-token", sourceId: "secret:write", scopes: ["workers:write"] },
  };
  const instance = new CloudflareApiTokenCredentialBroker({
    accountId: "account:broker-test",
    scriptName: "worker-broker-test",
    targetId: "target:broker-test",
    tokenSource: async () => ({ token: "fallback", sourceId: "secret:fallback", scopes: ["workers:read", "workers:write"] }),
    operationTokenSource: {
      preview: async () => sources.preview!,
      apply: async () => sources.apply!,
    },
    transport: fixture,
    now: () => "2026-08-21T00:00:00.000Z",
  });
  const preview = await instance.issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "preview", audience: "aud:anyam:deployment" });
  const apply = await instance.issue({ accountId: "account:broker-test", scriptName: "worker-broker-test", targetId: "target:broker-test", operation: "apply", audience: "aud:anyam:promotion" });
  assert.equal(fixture.requests[1]?.token, "read-token");
  assert.equal(fixture.requests[3]?.token, "write-token");
  assert.match(preview.receipt, /credentialSource=secret:read/);
  assert.match(apply.receipt, /credentialSource=secret:write/);
});
