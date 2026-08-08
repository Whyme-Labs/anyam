import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomerRealmControlPlane,
  createCustomerRealmControlRoute,
  type CustomerRealmControlAuthorizationResult,
  type CustomerRealmControlOperation,
  type CustomerRealmDeploymentReadinessAdapter,
  type CustomerRealmOwnerAuthenticationAdapter,
} from "../src/installation/customer-realm-control.ts";
import {
  CustomerRealmInstallation,
  InMemoryCustomerRealmCloudflareAdapter,
  InMemoryCustomerRealmInstallationStore,
  InMemoryCustomerRealmProjectImporter,
} from "../src/installation/customer-realm.ts";
import { handleCustomerRealmRequest, type CustomerRealmWorkerEnv } from "../src/cloudflare/realm-worker.ts";

const now = () => new Date("2026-08-03T00:00:00.000Z");
const providerAuthorization = {
  provider: "cloudflare" as const,
  accountId: "account:customer",
  audience: "cloudflare-api" as const,
  authorizationDigest: `sha256:${"a".repeat(64)}`,
  expiresAt: "2026-08-04T00:00:00.000Z",
  receipt: "customer-oauth-session=external; credentialStoredByAnyam=false",
};

class TestOwnerAuthenticationAdapter implements CustomerRealmOwnerAuthenticationAdapter {
  readonly proofs: string[] = [];

  async verifyPasskey(input: { installationId: string; realmId: string; proof: string; displayName?: string }) {
    this.proofs.push(input.proof);
    if (input.proof !== "passkey-proof") return { status: "failed" as const, code: "owner.passkey.invalid", recoveryAction: "complete a fresh WebAuthn assertion through the customer-controlled adapter", receipt: `installation=${input.installationId}; adapterVerified=false` };
    return { status: "verified" as const, method: "passkey" as const, displayName: input.displayName ?? "Customer Owner", credentialId: "passkey:customer-owner", verificationReceipt: `adapter=webauthn-fixture; realm=${input.realmId}; verified=true` };
  }

  async verifyOidc(input: { installationId: string; realmId: string; proof: string; displayName?: string }) {
    this.proofs.push(input.proof);
    if (input.proof !== "oidc-proof") return { status: "retryable" as const, code: "owner.oidc.pending", recoveryAction: "complete the configured OIDC authorization and retry", receipt: `installation=${input.installationId}; adapterVerified=pending` };
    return { status: "verified" as const, method: "oidc" as const, displayName: input.displayName ?? "OIDC Owner", issuer: "https://issuer.example", subject: "subject:owner", clientId: "anyam-client", verificationReceipt: `adapter=oidc-fixture; realm=${input.realmId}; verified=true` };
  }
}

class ScriptedReadinessAdapter implements CustomerRealmDeploymentReadinessAdapter {
  readonly authorizations: unknown[] = [];
  private attempt = 0;

  async inspect(input: Parameters<CustomerRealmDeploymentReadinessAdapter["inspect"]>[0]) {
    this.authorizations.push(input.authorization);
    this.attempt += 1;
    if (this.attempt === 1) return { status: "retryable" as const, operationId: input.operationId, errorCode: "cloudflare.propagation_pending", receipt: "provider=cloudflare; deployment=propagation-pending; retryable=true", recoveryAction: "probe the same deployment operation again after provider propagation" };
    return { status: "ready" as const, operationId: input.operationId, providerOperationId: "cf-operation:ready", receipt: "provider=cloudflare; deployment=ready; bindings=verified", recoveryAction: "No action required for provider deployment readiness." };
  }
}

function env(): CustomerRealmWorkerEnv {
  return {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "installation:control",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    REALM_COORDINATOR: {},
    OAUTH_KV: {},
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  };
}

function authorizer(): (input: { request: Request; operation: CustomerRealmControlOperation; installationId: string }) => Promise<CustomerRealmControlAuthorizationResult> {
  return async ({ request, operation }) => {
    if (request.headers.get("authorization") !== "Bearer customer-session") return { status: "denied", code: "unauthorized", recoveryAction: "authenticate the customer actor and retry the installation command", receipt: "customer-session=missing-or-invalid; mutation=not-performed" };
    const capability = operation === "installation.status" ? "installation.read" : operation === "installation.owner-claim" ? "owner.claim" : operation === "installation.recovery-activate" || operation === "installation.recovery-restore" ? "recovery.activate" : "installation.manage";
    return { status: "authorized", authorization: { actorId: "actor:customer-cli", capability, receipt: "customer-oidc-session=verified; grant=installation-control" } };
  };
}

function route(): { route: ReturnType<typeof createCustomerRealmControlRoute>; readiness: ScriptedReadinessAdapter; owner: TestOwnerAuthenticationAdapter; store: InMemoryCustomerRealmInstallationStore } {
  const store = new InMemoryCustomerRealmInstallationStore();
  const readiness = new ScriptedReadinessAdapter();
  const owner = new TestOwnerAuthenticationAdapter();
  const plane = new CustomerRealmControlPlane({
    store,
    cloudflare: new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]),
    importer: new InMemoryCustomerRealmProjectImporter({ projectRevisionId: "project-revision:unused", sourceSpaceIds: [], exportDigest: "sha256:unused", checkpointId: "checkpoint:unused", state: "verified", partialEffects: [], receipt: "unused" }),
    ownerAuthentication: owner,
    readiness,
    now,
  });
  return { route: createCustomerRealmControlRoute({ plane, authorize: authorizer() }), readiness, owner, store };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("customer installation control route is authenticated, receipt-backed, and credential-free", async () => {
  const { route: controlRoute, readiness, owner, store } = route();
  const unauthorized = await controlRoute.handle(new Request("https://realm.example/api/install", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  assert.equal(unauthorized.status, 401);

  const installResponse = await controlRoute.handle(new Request("https://realm.example/api/install", {
    method: "POST",
    body: JSON.stringify({ installationId: "installation:control", accountId: "account:customer", requestedResourceTypes: ["d1", "r2"], ownerConfirmed: true, operationId: "operation:control-install", idempotencyKey: "idempotency:control-install", providerAuthorization }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(installResponse.status, 200);
  const installed = await jsonResponse(installResponse);
  assert.equal(installed.protocol, "anyam.customer-realm-control/v1");
  assert.equal((installed.state as Record<string, unknown>).phase, "realm-ready");
  assert.equal(JSON.stringify(installed.state).includes("customer-session"), false);
  assert.equal(JSON.stringify(installed.state).includes("authorizationDigest"), false);

  const firstReadiness = await controlRoute.handle(new Request("https://realm.example/api/install/installation:control/readiness", {
    method: "POST",
    body: JSON.stringify({ operationId: "operation:deployment-ready", providerAuthorization }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(firstReadiness.status, 409);
  const retryable = await jsonResponse(firstReadiness);
  assert.equal(retryable.status, "retryable");
  assert.match(String(retryable.receipt), /propagation-pending/);
  assert.equal((retryable.state as Record<string, unknown>).phase, "degraded");
  assert.equal(((retryable.state as Record<string, unknown>).pendingCommands as Array<Record<string, unknown>>).some((command) => command.operation === "deployment.readiness" && command.status === "degraded"), true);

  const ready = await controlRoute.handle(new Request("https://realm.example/api/install/installation:control/readiness", {
    method: "POST",
    body: JSON.stringify({ operationId: "operation:deployment-ready", providerAuthorization }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(ready.status, 200);
  const readyBody = await jsonResponse(ready);
  assert.equal((readyBody.state as Record<string, unknown>).phase, "realm-ready");
  assert.equal(((readyBody.state as Record<string, unknown>).pendingCommands as Array<Record<string, unknown>>).some((command) => command.operation === "deployment.readiness" && command.status === "succeeded"), true);
  assert.equal(readiness.authorizations.length, 2);
  assert.equal(JSON.stringify(readiness.authorizations).includes("token"), false);

  const claim = await controlRoute.handle(new Request("https://realm.example/api/install/installation:control/owner-claim", {
    method: "POST",
    body: JSON.stringify({ method: "passkey", proof: "passkey-proof", displayName: "Customer Owner", recovery: { method: "external-recovery-codes", enrollmentReceipt: "external-recovery:control", materialDigest: "sha256:external-only" } }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(claim.status, 200);
  const claimed = await jsonResponse(claim);
  assert.equal((claimed.state as Record<string, unknown>).phase, "owner-ready");
  assert.equal((claimed.state as Record<string, unknown>).owner && ((claimed.state as Record<string, unknown>).owner as Record<string, unknown>).authenticationMethod, "passkey");
  assert.equal(JSON.stringify(claimed).includes("passkey-proof"), false);
  assert.deepEqual(owner.proofs, ["passkey-proof"]);

  const persisted = await store.load("installation:control");
  assert.equal(persisted?.phase, "owner-ready");
  assert.equal(persisted?.pendingCommands.find((command) => command.operation === "deployment.readiness")?.operationId, "operation:deployment-ready");
});

test("adapter-verified OIDC owner claim registers the Realm identity without a default password", async () => {
  const { route: controlRoute } = route();
  const installResponse = await controlRoute.handle(new Request("https://realm.example/api/install", {
    method: "POST",
    body: JSON.stringify({ installationId: "installation:oidc", accountId: "account:customer", requestedResourceTypes: ["d1"], ownerConfirmed: true, providerAuthorization }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(installResponse.status, 200);
  const claim = await controlRoute.handle(new Request("https://realm.example/api/install/installation:oidc/owner-claim", {
    method: "POST",
    body: JSON.stringify({ method: "oidc", proof: "oidc-proof", recovery: { method: "enterprise-oidc", enrollmentReceipt: "external-oidc-recovery" } }),
    headers: { authorization: "Bearer customer-session", "content-type": "application/json" },
  }));
  assert.equal(claim.status, 200);
  const body = await jsonResponse(claim);
  const state = body.state as Record<string, unknown>;
  assert.equal(state.phase, "owner-ready");
  assert.equal((state.owner as Record<string, unknown>).authenticationMethod, "oidc");
  assert.equal(JSON.stringify(body).includes("password"), false);
  assert.equal(JSON.stringify(body).includes("oidc-proof"), false);
});

test("the Worker keeps mutation routes absent until a qualified control adapter is bound", async () => {
  const response = await handleCustomerRealmRequest(new Request("https://realm.example/api/install", { method: "POST", body: "{}" }), {
    ...env(),
  });
  assert.equal(response.status, 404);
  const body = await jsonResponse(response);
  assert.equal(body.code, "not_found");
  assert.match(String(body.recoveryAction), /control adapter/);
});

test("recovery restore through the control boundary remains quarantined", async () => {
  const store = new InMemoryCustomerRealmInstallationStore();
  const cloudflare = new InMemoryCustomerRealmCloudflareAdapter(["account:customer"]);
  const importer = new InMemoryCustomerRealmProjectImporter({ projectRevisionId: "project-revision:unused", sourceSpaceIds: [], exportDigest: "sha256:unused", checkpointId: "checkpoint:unused", state: "verified", partialEffects: [], receipt: "unused" });
  const source = new CustomerRealmInstallation({ installationId: "installation:restore", cloudflare, importer, now });
  await source.install({ accountId: "account:customer", requestedResourceTypes: ["d1"], ownerConfirmed: true });
  const bundle = await source.exportRecovery({});
  const plane = new CustomerRealmControlPlane({ store, cloudflare, importer, ownerAuthentication: new TestOwnerAuthenticationAdapter(), readiness: new ScriptedReadinessAdapter(), now });
  const result = await plane.restoreRecovery({ installationId: "installation:restore", bundle, authorization: { actorId: "actor:customer-cli", capability: "recovery.activate", receipt: "customer-recovery-grant" } });
  assert.equal(result.status, "succeeded");
  assert.equal(result.state?.phase, "recovery-pending");
  assert.equal(result.state?.account?.credentialsStored, false);
  assert.equal(result.state?.realmSnapshot?.sessions && Object.values(result.state.realmSnapshot.sessions).every((session) => session.status === "revoked"), true);
});
