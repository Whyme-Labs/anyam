import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_REALM_REQUIRED_BINDINGS,
  CustomerRealmWorkerConfigurationError,
  assertCustomerRealmWorkerConfiguration,
  handleCustomerRealmRequest,
  inspectCustomerRealmWorkerConfiguration,
  type CustomerRealmWorkerEnv,
} from "../src/cloudflare/realm-worker.ts";

function configuredEnv(overrides: Partial<CustomerRealmWorkerEnv> = {}): CustomerRealmWorkerEnv {
  return {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "installation:test",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_BUILD_REVISION: "commit:test",
    REALM_COORDINATOR: {},
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
    ...overrides,
  };
}

test("customer-operated Worker configuration names every required binding", () => {
  const configuration = inspectCustomerRealmWorkerConfiguration(configuredEnv());
  assert.deepEqual(configuration.missingBindings, []);
  assert.deepEqual(configuration.missingConfiguration, []);
  assert.deepEqual(configuration.bindings.map((binding) => binding.name), CUSTOMER_REALM_REQUIRED_BINDINGS);
  assert.equal(assertCustomerRealmWorkerConfiguration(configuredEnv()).hostingMode, "customer-operated");
});

test("missing binding produces an actionable configuration error", () => {
  const env = configuredEnv({ ANYAM_EXPORTS: undefined });
  const configuration = inspectCustomerRealmWorkerConfiguration(env);
  assert.deepEqual(configuration.missingBindings, ["ANYAM_EXPORTS"]);
  assert.throws(
    () => assertCustomerRealmWorkerConfiguration(env),
    (error: unknown) => error instanceof CustomerRealmWorkerConfigurationError
      && error.message.includes("ANYAM_EXPORTS")
      && error.recoveryAction.includes("customer-owned bindings")
      && error.receipt.includes("missing=ANYAM_EXPORTS"),
  );
});

test("a mismatched protocol version is an explicit configuration failure", () => {
  const env = configuredEnv({ ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v0" });
  assert.throws(
    () => assertCustomerRealmWorkerConfiguration(env),
    (error: unknown) => error instanceof CustomerRealmWorkerConfigurationError
      && error.missingConfiguration.includes("ANYAM_PROTOCOL_VERSION")
      && error.message.includes("ANYAM_PROTOCOL_VERSION"),
  );
});

test("health reports blocked configuration without exposing binding values", async () => {
  const secretLikeBinding = { token: "must-never-be-serialized" };
  const response = await handleCustomerRealmRequest(new Request("https://realm.example/health"), configuredEnv({ ANYAM_EXPORTS: secretLikeBinding }));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.credentialFree, true);
  assert.equal(body.authority, "customer-owned");
  assert.equal(JSON.stringify(body).includes("must-never-be-serialized"), false);
  assert.deepEqual(body.missingConfiguration, []);
});

test("health fails closed and lists missing mode/input without minting authority", async () => {
  const response = await handleCustomerRealmRequest(new Request("https://realm.example/health"), {
    REALM_COORDINATOR: {},
  });
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, "blocked");
  assert.equal(body.credentialFree, true);
  assert.deepEqual(body.missingConfiguration, [
    "ANYAM_METADATA_DB",
    "ANYAM_EXPORTS",
    "ANYAM_EVENTS",
    "ANYAM_WORKFLOW",
    "ANYAM_HOSTING_MODE",
    "ANYAM_INSTALLATION_ID",
  ]);
  assert.equal("accessToken" in body, false);
  assert.equal("secret" in body, false);
});

test("foundation only serves the documented read-only surfaces", async () => {
  const notFound = await handleCustomerRealmRequest(new Request("https://realm.example/api/bootstrap"), configuredEnv());
  assert.equal(notFound.status, 404);
  const methodNotAllowed = await handleCustomerRealmRequest(new Request("https://realm.example/health", { method: "POST" }), configuredEnv());
  assert.equal(methodNotAllowed.status, 405);
});
