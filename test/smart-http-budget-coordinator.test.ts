import assert from "node:assert/strict";
import test from "node:test";

import { DurableSmartHttpBudgetCoordinator, emptySmartHttpBudgetCoordinatorState, handleSmartHttpBudgetCoordinatorRequest } from "../src/cloudflare/smart-http-budget-coordinator.ts";

test("Durable Smart HTTP coordinator serializes leases, releases idempotently, and expires abandoned leases", async () => {
  let now = 1_000;
  let state = emptySmartHttpBudgetCoordinatorState();
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const result = await handleSmartHttpBudgetCoordinatorRequest({ request, state, now: () => now });
      state = result.state;
      return result.response;
    },
  };
  const coordinator = new DurableSmartHttpBudgetCoordinator(fetcher);
  const receipt = "measurement=smart-http-global-fixture; workload=stream; source=test";
  const first = await coordinator.acquire({ operation: "read", limit: 1, leaseTtlMs: 100, receipt });
  assert.ok(first);
  const blocked = await coordinator.acquire({ operation: "read", limit: 1, leaseTtlMs: 100, receipt });
  assert.equal(blocked, undefined);
  first?.release();
  const released = await coordinator.acquire({ operation: "read", limit: 1, leaseTtlMs: 100, receipt });
  assert.ok(released);
  now = 1_101;
  const expired = await coordinator.acquire({ operation: "read", limit: 1, leaseTtlMs: 100, receipt });
  assert.ok(expired);
  released?.release();
  expired?.release();
});
