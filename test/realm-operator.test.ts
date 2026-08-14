import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamRealmOwnerRequest } from "../apps/realm-worker/src/passkey-owner.ts";
import type { AnyamRealmOAuthEnv } from "../apps/realm-worker/src/oauth-provider.ts";
import {
  customerRealmOperatorPreflight,
  customerRealmInstallationManifestDigest,
  inspectCustomerRealmOperatorStatus,
  type CustomerRealmOperatorEnv,
} from "../src/cloudflare/realm-operator.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);
const DIGEST_C = "sha256:" + "c".repeat(64);
const DIGEST_D = "sha256:" + "d".repeat(64);
const MANIFEST_DIGEST = await customerRealmInstallationManifestDigest();

function configuredEnv(overrides: Partial<CustomerRealmOperatorEnv> = {}): CustomerRealmOperatorEnv {
  return {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "installation:operator-test",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm.example",
    ANYAM_BUILD_REVISION: "commit:operator-test",
    REALM_COORDINATOR: {},
    OAUTH_KV: {},
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
    ANYAM_RELEASE_DIGEST: DIGEST_A,
    ANYAM_INSTALLATION_MANIFEST_DIGEST: MANIFEST_DIGEST,
    ANYAM_SCHEMA_DIGEST: DIGEST_B,
    ANYAM_MIGRATION_DIGEST: DIGEST_C,
    ANYAM_CONFIGURATION_DIGEST: DIGEST_D,
    ANYAM_PROVIDER_ACCOUNT_ID: "account:operator-test",
    ANYAM_PROVIDER_STATE: "healthy",
    ANYAM_PROVIDER_AUTHORIZATION_STATE: "verified",
    ANYAM_RELEASE_STATE: "compatible",
    ANYAM_MIGRATION_STATE: "current",
    ANYAM_DOMAIN_POLICY_STATE: "verified",
    ANYAM_RESIDENCY_POLICY_STATE: "verified",
    ANYAM_EXPORT_DESTINATION: "r2:operator-exports",
    ANYAM_LAST_EXPORT_DIGEST: DIGEST_A,
    ANYAM_LAST_CHECKPOINT_DIGEST: DIGEST_B,
    ANYAM_RESTORE_DRILL_STATE: "verified",
    ANYAM_PENDING_OPERATIONS_STATE: "none",
    ...overrides,
  };
}

const healthyIdentity = {
  realmId: "realm:installation:operator-test",
  recoveryStatus: "active",
  authorizationEpoch: 2,
  activeOwnerCount: 1,
  passkeyCount: 1,
  credentialFree: true,
  ownerSessionValidated: true,
};

test("operator status is healthy only when release, migration, policy, export, and provider receipts are observed", async () => {
  const result = await inspectCustomerRealmOperatorStatus(configuredEnv(), healthyIdentity);
  assert.equal(result.status, "healthy");
  assert.equal(result.credentialFree, true);
  assert.equal(result.canonicalWrite, false);
  assert.equal(result.credentialMinted, false);
  assert.equal(result.targetPromotion, "not-performed");
  assert.equal(result.checks.every((item) => item.state === "healthy"), true);
  assert.match(result.manifest.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.digests.release, DIGEST_A);
});

test("operator status is blocked by a missing binding or stale migration and names recovery", async () => {
  const result = await inspectCustomerRealmOperatorStatus(configuredEnv({ ANYAM_EXPORTS: undefined, ANYAM_MIGRATION_STATE: "stale" }), healthyIdentity);
  assert.equal(result.status, "blocked");
  assert.equal(result.bindings.missing.includes("ANYAM_EXPORTS"), true);
  assert.equal(result.checks.find((item) => item.id === "schema-migration")?.state, "blocked");
  assert.equal(result.nextActions.some((action) => action.includes("migration")), true);
});

test("operator status reports provider outage and failed restore as degraded without claiming readiness", async () => {
  const result = await inspectCustomerRealmOperatorStatus(configuredEnv({ ANYAM_PROVIDER_STATE: "outage", ANYAM_RESTORE_DRILL_STATE: "failed" }), healthyIdentity);
  assert.equal(result.status, "degraded");
  assert.equal(result.checks.find((item) => item.id === "binding-provider-reconciliation")?.state, "degraded");
  assert.equal(result.checks.find((item) => item.id === "export-checkpoint")?.state, "degraded");
  assert.equal(result.canonicalWrite, false);
});

test("operator status remains indeterminate when provider, identity, release, and recovery receipts are not observed", async () => {
  const result = await inspectCustomerRealmOperatorStatus({
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "installation:operator-indeterminate",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    REALM_COORDINATOR: {},
    OAUTH_KV: {},
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.checks.some((item) => item.state === "indeterminate"), true);
  assert.equal(result.digests.release, null);
  assert.equal(result.exportCheckpoint.destinationConfigured, false);
});

test("read-only preflight exposes no mutation authority or credential material", async () => {
  const result = await customerRealmOperatorPreflight(configuredEnv({ ANYAM_EXPORT_DESTINATION: "cfat-secret-token" }), healthyIdentity);
  assert.equal(result.protocol, "anyam.customer-realm-preflight/v1");
  assert.equal(result.operation, "read-only-preflight");
  assert.deepEqual(result.sideEffects, { resourcesCreated: 0, secretsCreated: 0, canonicalWrite: false, credentialMinted: false, targetPromotion: "not-performed" });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("cfat-secret-token"), false);
  assert.equal(encoded.includes("accessToken"), false);
  assert.equal(encoded.includes("credentialMaterial"), false);
});

class MemoryKV {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("operator status is owner-authenticated while health remains the public readiness surface", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:operator-test";
  const kernelSessionId = "session:operator-test";
  oauthKv.put(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:installation:operator-test",
    userId: "owner:operator-test",
    displayName: "Operator Test Owner",
    credentialId: "credential:operator-test",
    kernelSessionId,
    actorId: "actor:operator-test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
  const namespace = {
    idFromName: (_name: string): string => "operator-test-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        assert.equal(request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER), REALM_COORDINATOR_INTERNAL_VALUE);
        const body = await request.json() as Record<string, unknown>;
        if (new URL(request.url).pathname !== "/identity/session/validate" || body.sessionId !== kernelSessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
        return new Response(JSON.stringify({
          protocol: "anyam.realm-coordinator/v1",
          status: "session-valid",
          session: { id: kernelSessionId, actorId: "actor:operator-test", principalId: "owner:operator-test" },
          identity: { ...healthyIdentity },
          recoveryStatus: "active",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  const env = { ...configuredEnv(), OAUTH_KV: oauthKv, REALM_COORDINATOR: namespace } as unknown as AnyamRealmOAuthEnv;
  const unauthenticated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/operator/status"), env);
  assert.equal(unauthenticated?.status, 401);
  const authenticated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/operator/status", { headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` } }), env);
  assert.equal(authenticated?.status, 200);
  const body = await authenticated!.json() as Record<string, unknown>;
  assert.equal(body.protocol, "anyam.customer-realm-operator/v1");
  assert.equal(body.canonicalWrite, false);
  assert.equal(JSON.stringify(body).includes(kernelSessionId), false);
});
