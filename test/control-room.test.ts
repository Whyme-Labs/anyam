import assert from "node:assert/strict";
import test from "node:test";

import { customerRealmControlRoomResponse, renderCustomerRealmControlRoom } from "../src/cloudflare/control-room.ts";
import { PRODUCTION_OPERATIONS_REQUIRED_DRILLS, ProductionOperationsLedger } from "../src/operations/production-operations.ts";
import type { CustomerRealmOperatorStatus } from "../src/cloudflare/realm-operator.ts";

function status(): CustomerRealmOperatorStatus {
  const operations = new ProductionOperationsLedger().evaluate();
  return {
    protocol: "anyam.customer-realm-operator/v1",
    status: "indeterminate",
    manifest: { protocol: "anyam.customer-realm-installation/v1", version: "v1", digest: `sha256:${"a".repeat(64)}`, configuredDigest: null, requiredBindings: [], requiredConfiguration: [] },
    installation: { installationId: "installation:test", realmId: "realm:test", hostingMode: "customer-operated", protocolVersion: "anyam.customer-realm-worker/v1", buildRevision: "commit:test", ownerState: "verified", recoveryState: "verified", authorizationEpoch: 1 },
    digests: { release: `sha256:${"b".repeat(64)}`, schema: null, migration: null, configuration: null },
    bindings: { required: [], configured: [], missing: [], providerState: "verified" },
    provider: { accountConfigured: true, authorizationState: "verified", state: "verified" },
    pendingOperations: { state: "none" },
    exportCheckpoint: { destinationConfigured: false, lastVerifiedExportDigest: null, lastVerifiedCheckpointDigest: null, restoreDrillState: "not-observed" },
    operations,
    checks: [{ id: "production-operations", state: "indeterminate", observed: {}, receipt: "operations=indeterminate", recoveryAction: "Record the required production-operation receipts." }],
    nextActions: ["Record the required production-operation receipts."],
    credentialFree: true,
    canonicalWrite: false,
    credentialMinted: false,
    targetPromotion: "not-performed",
    receipt: "status=indeterminate; credentialFree=true; canonicalWrite=false",
  };
}

test("control room renders the state-first delivery chain and operations blocker", () => {
  const html = renderCustomerRealmControlRoom({ status: status(), operations: new ProductionOperationsLedger().evaluate() });
  for (const heading of ["Change", "Evidence", "Landing", "Release", "Target", "Deployment", "Health", "Production operations"]) assert.match(html, new RegExp(heading));
  assert.match(html, /indeterminate/);
  assert.match(html, /credential-free/);
  assert.match(html, /anyam-lockup-inverse/);
  assert.match(html, /--anyam-color-accent-blue/);
  assert.match(html, /data:image\/png;base64/);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<token"), false);
});

test("control room CSP permits only the inline brand mark asset", async () => {
  const response = customerRealmControlRoomResponse({ status: status(), operations: new ProductionOperationsLedger().evaluate() });
  assert.match(response.headers.get("content-security-policy") ?? "", /img-src data:/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
