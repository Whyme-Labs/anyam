import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_OPERATIONS_REQUIRED_DRILLS,
  ProductionOperationsLedger,
} from "../src/operations/production-operations.ts";

const startedAt = "2026-08-23T00:00:00.000Z";
const finishedAt = "2026-08-23T00:01:00.000Z";

function receipt(kind: (typeof PRODUCTION_OPERATIONS_REQUIRED_DRILLS)[number], status: "verified" | "failed" | "indeterminate" = "verified") {
  return {
    id: `drill:${kind}`,
    kind,
    status,
    startedAt,
    finishedAt,
    observations: {
      workload: "qualification-fixture",
      measuredRequests: 12,
    },
    evidenceRefs: [`evidence:${kind}`],
    recoveryAction: status === "verified" ? "No recovery action is currently required." : `Repeat the ${kind} drill after reconciling the failure.`,
    receipt: `drill=${kind}; status=${status}; measurement=fixture; credentialFree=true`,
  };
}

test("production operations readiness stays indeterminate until every required drill is verified", async () => {
  const ledger = new ProductionOperationsLedger();
  const first = await ledger.record(receipt(PRODUCTION_OPERATIONS_REQUIRED_DRILLS[0]));
  assert.equal(first.credentialFree, true);
  assert.equal(ledger.evaluate().status, "indeterminate");
  assert.equal(ledger.evaluate().missingKinds.length, PRODUCTION_OPERATIONS_REQUIRED_DRILLS.length - 1);
});

test("production operations readiness is ready only after all required drills are verified", async () => {
  const ledger = new ProductionOperationsLedger();
  for (const kind of PRODUCTION_OPERATIONS_REQUIRED_DRILLS) await ledger.record(receipt(kind));
  const readiness = ledger.evaluate();
  assert.equal(readiness.status, "ready");
  assert.deepEqual(readiness.missingKinds, []);
  assert.deepEqual(readiness.failedKinds, []);
  assert.deepEqual(readiness.indeterminateKinds, []);
  assert.equal(readiness.credentialFree, true);
});

test("a failed or indeterminate drill blocks readiness and names recovery", async () => {
  const ledger = new ProductionOperationsLedger();
  for (const kind of PRODUCTION_OPERATIONS_REQUIRED_DRILLS) {
    await ledger.record(receipt(kind, kind === "backup-restore" ? "failed" : kind === "key-rotation" ? "indeterminate" : "verified"));
  }
  const readiness = ledger.evaluate();
  assert.equal(readiness.status, "blocked");
  assert.deepEqual(readiness.failedKinds, ["backup-restore"]);
  assert.deepEqual(readiness.indeterminateKinds, ["key-rotation"]);
  assert.match(readiness.recoveryAction, /backup-restore/);
  assert.match(readiness.recoveryAction, /key-rotation/);
});

test("duplicate records are idempotent but conflicting records are rejected", async () => {
  const ledger = new ProductionOperationsLedger();
  const input = receipt("sustained-load");
  const first = await ledger.record(input);
  const duplicate = await ledger.record(input);
  assert.deepEqual(duplicate, first);
  await assert.rejects(() => ledger.record({ ...input, status: "failed" }), /production_operations_receipt_conflict/);
});

test("credential-like fields are rejected before a receipt enters the ledger", async () => {
  const ledger = new ProductionOperationsLedger();
  await assert.rejects(
    () => ledger.record({ ...receipt("queue-recovery"), observations: { accessToken: "should-not-enter" } }),
    /credential_material_forbidden/,
  );
});
