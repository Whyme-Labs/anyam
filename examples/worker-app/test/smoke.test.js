import test from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/index.js";

test("health returns the example release identity", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: "anyam-example-worker", status: "ok" });
});

test("the root route is useful to a first-time visitor", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Anyam example Worker/);
});
