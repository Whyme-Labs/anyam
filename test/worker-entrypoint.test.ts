import assert from "node:assert/strict";
import test from "node:test";

import providerTarget from "../apps/provider-qualification-target/src/index.ts";
import replayArchiveWorker, { type Env as ReplayArchiveEnv } from "../apps/replay-archive-workload-qualification/src/index.ts";

type StoredObject = { arrayBuffer(): Promise<ArrayBuffer> };

function memoryR2(): { bucket: Record<string, unknown>; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string): Promise<void> {
      objects.set(key, value);
    },
    async get(key: string): Promise<StoredObject | null> {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
    },
    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async head(key: string): Promise<object | null> {
      return objects.has(key) ? {} : null;
    },
    async list(input: { prefix?: string }): Promise<{ objects: readonly { key: string }[]; truncated: false }> {
      return { objects: [...objects.keys()].filter((key) => !input.prefix || key.startsWith(input.prefix)).map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, objects };
}

test("provider Target entrypoint accepts the declared operation envelope and rejects malformed input", async () => {
  const invalid = await providerTarget.fetch(new Request("https://target.example/", { method: "POST", body: JSON.stringify({}) }));
  assert.equal(invalid.status, 422);

  const operationId = "operation:worker-entrypoint-test";
  const accepted = await providerTarget.fetch(new Request("https://target.example/", { method: "POST", body: JSON.stringify({ protocol: "anyam.customer-provider-operation/v1", operationId }) }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { protocol: "anyam.customer-provider-operation/v1", operationId, status: "accepted", target: "disposable-worker" });

  const readBack = await providerTarget.fetch(new Request(`https://target.example/?operationId=${encodeURIComponent(operationId)}`));
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json() as { operationId: string }).operationId, operationId);
});

test("replay archive qualification entrypoint enforces its binding-shaped credential boundary and exact cleanup", async () => {
  const { bucket, objects } = memoryR2();
  const env = { PUBLIC_GATEWAY_REPLAY_ARCHIVE: bucket, PROJECT_ID: "project:entrypoint-test", QUALIFICATION_TOKEN: "qualification-secret" } as unknown as ReplayArchiveEnv;
  const sample = {
    category: "terminal-denial",
    tombstone: {
      requestId: "request:entrypoint-test",
      payloadDigest: "sha256:payload-entrypoint-test",
      contributionId: "contribution:entrypoint-test",
      originalStatus: "denied",
      recordedAt: "2026-08-11T00:00:00.000Z",
      compactedAt: "2026-08-11T00:30:00.000Z",
      exportDigest: "sha256:export-entrypoint-test",
      receipt: "entrypoint=fixture; exact=true",
    },
  };
  const body = JSON.stringify({ samples: [sample] });
  const unauthenticated = await replayArchiveWorker.fetch(new Request("https://replay.example/measure", { method: "POST", body }), env);
  assert.equal(unauthenticated.status, 401);

  const headers = { authorization: "Bearer qualification-secret", "content-type": "application/json" };
  const measured = await replayArchiveWorker.fetch(new Request("https://replay.example/measure", { method: "POST", headers, body }), env);
  assert.equal(measured.status, 200);
  assert.equal((await measured.json() as { status: string }).status, "succeeded");
  assert.equal(objects.size, 1);

  const cleaned = await replayArchiveWorker.fetch(new Request("https://replay.example/cleanup", { method: "POST", headers, body }), env);
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json() as { status: string }).status, "succeeded");
  assert.equal(objects.size, 0);
});
