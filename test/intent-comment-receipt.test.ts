import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RealmAuthorityHttpClient, RealmAuthorityRequestError } from "../packages/create-anyam/src/realm-authority-client.ts";

const incomplete = [
  { name: "missing", payload: { unexpected: "PRIVATE incomplete reply" } },
  { name: "null", payload: { receipt: null } },
  { name: "number", payload: { receipt: 17 } },
  { name: "object", payload: { receipt: { value: "PRIVATE incomplete reply" } } },
  { name: "array", payload: { receipt: ["PRIVATE incomplete reply"] } },
  { name: "boolean", payload: { receipt: true } },
  { name: "empty", payload: { receipt: "" } },
  { name: "blank", payload: { receipt: " \n\t" } },
];

for (const item of incomplete) test(`Intent comment rejects a ${item.name} receipt as an unconfirmed write`, async () => {
  for (const status of [200, 201, 202]) {
    let calls = 0;
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-owner",
      fetchImpl: async () => { calls++; return Response.json(item.payload, { status }); } });
    await assert.rejects(() => client.commentIntent("intent:owned", { body: "PRIVATE selected draft" }, "comment:owned"), error => {
      assert.ok(error instanceof RealmAuthorityRequestError);
      assert.equal(error.status, status);
      assert.equal(error.code, "realm_authority_response_invalid");
      assert.match(error.receipt, /response=invalid-success-receipt; outcome=unconfirmed/);
      assert.match(error.recoveryAction, /inspect.*Realm/);
      assert.match(error.recoveryAction, /original.*idempotency key/);
      assert.doesNotMatch(error.message, /PRIVATE|synthetic-owner/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("valid Intent comment replies and unrelated readable Realm objects retain their exact contracts", async () => {
  for (const payload of [
    { receipt: "intent=commented" },
    { receipt: " intent=commented; replay=true ", comment: { id: "comment:owned" }, status: "succeeded" },
  ]) {
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-owner",
      fetchImpl: async () => Response.json(payload, { status: 201 }) });
    assert.deepEqual(await client.commentIntent("intent:owned", { body: "Note" }, "comment:owned"), payload);
  }
  const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-owner", fetchImpl: async () => Response.json({}) });
  assert.deepEqual(await client.inspectState(), {});
});

async function cli(args: string[], root: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANYAM_|CF_|CLOUDFLARE_|GIT_|NODE_OPTIONS$)/u.test(key)));
  const argv = ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../packages/create-anyam/src/anyam.ts", import.meta.url)), ...args];
  try {
    return { exit: 0, ...await promisify(callback)(process.execPath, argv, { cwd: root, env: { ...env, TSX_DISABLE_CACHE: "1", ANYAM_STATE_HOME: join(root, "state") } }) };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    if (typeof result.code !== "number") throw error;
    return { exit: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

test("actual Intent CLI rejects incomplete successful replies in both modes and retains draft bytes and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-comment-receipt-"));
  let payload: unknown, requests = 0;
  const note = "PRIVATE selected multiline note\n确认\n";
  const draft = join(root, "draft.md");
  const server = createServer(async (request, response) => {
    requests++;
    let body = ""; for await (const part of request) body += part;
    assert.equal(request.method, "POST"); assert.equal(request.url, "/api/intents/intent%3Aowned/comment");
    assert.equal(JSON.parse(body).body, note);
    assert.equal(request.headers["idempotency-key"], `comment:explicit:${requests}`);
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
  });
  try {
    await writeFile(draft, note, { mode: 0o600 }); const before = await stat(draft);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    for (const item of incomplete) for (const json of [false, true]) {
      payload = item.payload; const expected = requests + 1;
      const result = await cli(["intent", "comment", "intent:owned", "--body-file", draft,
        "--idempotency-key", `comment:explicit:${expected}`, "--realm", `http://127.0.0.1:${address.port}`,
        "--owner-session", "synthetic-owner", ...(json ? ["--json"] : [])], root);
      assert.equal(result.exit, 1); assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /PRIVATE|synthetic-owner/);
      assert.match(result.stderr, /realm_authority_response_invalid/);
      assert.match(result.stderr, /httpStatus=201; response=invalid-success-receipt; outcome=unconfirmed/);
      if (json) assert.equal(JSON.parse(result.stderr).status, "error");
      assert.equal(requests, expected, "one explicit invocation sends exactly one request");
      assert.equal(await readFile(draft, "utf8"), note);
      const after = await stat(draft);
      assert.equal(after.size, before.size); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
    }
    assert.equal(requests, 16);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("an admitted comment with an incomplete reply is inspected and retried only by an explicit same-key invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-comment-replay-"));
  const draft = join(root, "draft.md"), note = "Retained note\n确认\n", key = "comment:original";
  const admitted = new Map<string, string>();
  const writes: { key: string; body: string }[] = [];
  let reads = 0;
  const server = createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "GET") {
      reads++; assert.equal(request.url, "/api/intents/intent%3Aowned");
      response.end(JSON.stringify({ intent: { id: "intent:owned" }, comments: [{ id: "comment:original" }] })); return;
    }
    let body = ""; for await (const part of request) body += part;
    const requestKey = String(request.headers["idempotency-key"]);
    writes.push({ key: requestKey, body });
    if (!admitted.has(requestKey)) {
      admitted.set(requestKey, body); response.end("{}"); return;
    }
    assert.equal(admitted.get(requestKey), body);
    response.end(JSON.stringify({ receipt: "intent=commented; replay=true", comment: { id: "comment:original" } }));
  });
  try {
    await writeFile(draft, note, { mode: 0o600 }); const before = await stat(draft);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const connection = ["--realm", `http://127.0.0.1:${address.port}`, "--owner-session", "synthetic-owner", "--json"];
    const command = ["intent", "comment", "intent:owned", "--body-file", draft, "--idempotency-key", key, ...connection];
    const initial = await cli(command, root);
    assert.equal(initial.exit, 1); assert.equal(initial.stdout, ""); assert.match(initial.stderr, /outcome=unconfirmed/);
    assert.equal(writes.length, 1); assert.equal(reads, 0); assert.equal(admitted.size, 1);
    assert.equal(await readFile(draft, "utf8"), note);
    const inspected = await cli(["intent", "inspect", "intent:owned", ...connection], root);
    assert.equal(inspected.exit, 0); assert.equal(JSON.parse(inspected.stdout).comments[0].id, "comment:original");
    assert.equal(reads, 1); assert.equal(writes.length, 1);
    const retry = await cli(command, root);
    assert.equal(retry.exit, 0); assert.equal(JSON.parse(retry.stdout).comment.id, "comment:original");
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(admitted.size, 1);
    assert.equal(await readFile(draft, "utf8"), note);
    const after = await stat(draft);
    assert.equal(after.size, before.size); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
