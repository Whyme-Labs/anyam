import assert from "node:assert/strict";
import test from "node:test";
import { qualifyCredentialStateModel } from "./fixtures/smart-http-state-model.ts";

test("bounded SCM credential states match concrete transitions across restart and detect known-bad traces", async context => {
  const receipt = await qualifyCredentialStateModel();
  assert.equal(receipt.caseCount, 50);
  assert.equal(receipt.mutations.filter(item => item.detected).length, 3);
  context.diagnostic(JSON.stringify({ protocol: receipt.protocol, caseCount: receipt.caseCount, mutations: receipt.mutations, scope: receipt.scope }));
});
