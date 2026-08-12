import assert from "node:assert/strict";
import test from "node:test";

import { runPrivateAlphaJourneyQualification } from "../src/qualification/private-alpha-journey.ts";

test("private-alpha journey proves customer Realm through Git, agent, Landing, Release, rollback, and recovery", async () => {
  const receipt = await runPrivateAlphaJourneyQualification();
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.hostingMode, "customer-operated-fixture");
  assert.equal(receipt.providerQualification, "fixture-bound; live-provider-qualification-separate");
  assert.equal(receipt.canonicalWrite, "landing-only");
  assert.equal(receipt.credentialFree, true);
  assert.equal(receipt.git.canonicalPush, "denied");
  assert.equal(receipt.git.workspacePush, "succeeded");
  assert.equal(receipt.agent.canonicalWrite, false);
  assert.equal(receipt.agent.mode, "enforceable");
  assert.equal(receipt.change.canonicalWrite, false);
  assert.equal(receipt.execution.evidenceOutcome, "passed");
  assert.equal(receipt.landing.sourceWrite, "landing-only");
  assert.equal(receipt.delivery.healthyPromotion, "healthy");
  assert.equal(receipt.delivery.failingPromotion, "rolled-back");
  assert.equal(receipt.delivery.rollbackHealth, "healthy");
  assert.equal(receipt.delivery.healthBoundToRelease, true);
  assert.equal(receipt.recovery.verification, "verified");
  assert.equal(receipt.recovery.activatedPhase, "active");
  assert.equal(JSON.stringify(receipt).includes("token"), false);
  assert.equal(JSON.stringify(receipt).includes("password"), false);
});
