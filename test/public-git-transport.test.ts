import assert from "node:assert/strict";
import test from "node:test";

import { handlePublicGitRequest } from "../src/cloudflare/public-git-transport.ts";
import { SmartHttpBudgetTracker } from "../src/portability/smart-http.ts";
import { DurableSmartHttpBudgetCoordinator, emptySmartHttpBudgetCoordinatorState, handleSmartHttpBudgetCoordinatorRequest } from "../src/cloudflare/smart-http-budget-coordinator.ts";

function budget(overrides: Partial<Parameters<typeof handlePublicGitRequest>[1]["budget"]> = {}): Parameters<typeof handlePublicGitRequest>[1]["budget"] {
  return {
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    maxDurationMs: 500,
    maxConcurrentRequests: 2,
    receipt: "measurement=public-git-fixture; workload=bounded-read; source=test",
    ...overrides,
  };
}

test("public Git uses the shared Smart HTTP transport and never forwards Anyam credentials", async () => {
  const originalFetch = globalThis.fetch;
  let seen: Request | undefined;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response("001e# service=git-upload-pack\n", { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    }) as typeof fetch;
    const response = await handlePublicGitRequest(new Request("https://public.invalid/projects/public/source.git/info/refs?service=git-upload-pack", { headers: { authorization: "Bearer should-never-forward" } }), {
      upstreamBase: "https://provider.invalid/public-driver.git",
      publicSourceSpaceId: "source:public",
      budget: budget(),
      budgetTracker: new SmartHttpBudgetTracker("measurement=public-git-fixture; scope=worker-isolate"),
    });
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-anyam-public-projection"), "true");
    assert.equal(response.headers.get("x-anyam-canonical-write"), "false");
    assert.ok(seen);
    if (seen) {
      assert.equal(new URL(seen.url).pathname, "/public-driver.git/info/refs");
      assert.equal(new URL(seen.url).search, "?service=git-upload-pack");
      assert.equal(seen.headers.get("authorization"), null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public Git denies receive-pack advertisement before contacting the upstream", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  try {
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return new Response("unexpected", { status: 200 });
    }) as typeof fetch;
    const response = await handlePublicGitRequest(new Request("https://public.invalid/projects/public/source.git/info/refs?service=git-receive-pack"), {
      upstreamBase: "https://provider.invalid/public-driver.git",
      publicSourceSpaceId: "source:public",
      budget: budget(),
    });
    assert.ok(response);
    assert.equal(response.status, 403);
    const body = await response.json() as { code: string; canonicalWrite: boolean; receipt: string };
    assert.equal(body.code, "canonical_write_denied");
    assert.equal(body.canonicalWrite, false);
    assert.match(body.receipt, /receive-advertisement/);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public Git enforces the shared response stream budget on chunked upstream bodies", async () => {
  const originalFetch = globalThis.fetch;
  const tracker = new SmartHttpBudgetTracker("measurement=public-git-fixture; scope=worker-isolate");
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    const response = await handlePublicGitRequest(new Request("https://public.invalid/projects/public/source.git/info/refs?service=git-upload-pack"), {
      upstreamBase: "https://provider.invalid/public-driver.git",
      publicSourceSpaceId: "source:public",
      budget: budget({ maxResponseBytes: 4, maxConcurrentRequests: 1 }),
      budgetTracker: tracker,
    });
    assert.ok(response);
    assert.equal(response.status, 200);
    await assert.rejects(() => response.arrayBuffer(), /budget=responseBytes; limit=4; asked=6/);
    assert.equal(tracker.current(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public Git releases its durable concurrency lease only after the response stream closes", async () => {
  const originalFetch = globalThis.fetch;
  let coordinatorState = emptySmartHttpBudgetCoordinatorState();
  const coordinator = new DurableSmartHttpBudgetCoordinator({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const result = await handleSmartHttpBudgetCoordinatorRequest({ request, state: coordinatorState, now: () => 1_000 });
      coordinatorState = result.state;
      return result.response;
    },
  });
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    const response = await handlePublicGitRequest(new Request("https://public.invalid/projects/public/source.git/info/refs?service=git-upload-pack"), {
      upstreamBase: "https://provider.invalid/public-driver.git",
      publicSourceSpaceId: "source:public",
      budget: budget({ maxConcurrentRequests: 1 }),
      budgetCoordinator: coordinator,
    });
    assert.ok(response);
    assert.equal(Object.keys(coordinatorState.leases).length, 1);
    await response.arrayBuffer();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(Object.keys(coordinatorState.leases).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
