import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RealmAuthorityHttpClient, RealmAuthorityRequestError } from "../packages/create-anyam/src/realm-authority-client.ts";

const execFile = promisify(execFileCallback);
const malformed = ["PRIVATE not JSON", '{"receipt":"PRIVATE truncated', "null", '["PRIVATE array"]', "true", "7", ""];
const clientFor = (body: string, status: number, called: () => void) => new RealmAuthorityHttpClient({
  baseUrl: "https://realm.example", ownerSession: "synthetic-owner",
  fetchImpl: async () => { called(); return new Response(body, { status }); },
});
function typed(error: unknown, status: number, code: string): boolean {
  assert.ok(error instanceof RealmAuthorityRequestError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /PRIVATE/);
  assert.match(error.recoveryAction, /inspect.*Realm/i);
  assert.match(error.recoveryAction, /same.*idempotent|original.*idempotency/i);
  return true;
}

test("Realm client rejects every malformed successful response without retry or body disclosure", async () => {
  for (const body of malformed) {
    let calls = 0;
    const client = clientFor(body, 200, () => { calls += 1; });
    await assert.rejects(() => client.commentIntent("intent:owned", { body: "Saved note" }, "comment:owned"),
      error => typed(error, 200, "realm_authority_response_invalid"));
    assert.equal(calls, 1);
  }
  const empty = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-owner", fetchImpl: async () => new Response(null, { status: 204 }) });
  await assert.rejects(() => empty.inspectState(), error => typed(error, 204, "realm_authority_response_invalid"));
});

test("Realm client preserves HTTP failure status for unreadable or non-object error responses", async () => {
  for (const status of [401, 409, 503]) for (const body of malformed) {
    let calls = 0;
    const client = clientFor(body, status, () => { calls += 1; });
    await assert.rejects(() => client.inspectState(), error => typed(error, status, `http_${status}`));
    assert.equal(calls, 1);
  }
});

test("an explicitly allowed HTTP status still requires a readable Realm object", async () => {
  for (const body of malformed) {
    let calls = 0;
    const client = clientFor(body, 409, () => { calls += 1; });
    await assert.rejects(() => client.command({ command: "promotion.request", payload: {}, idempotencyKey: "command:owned", allowStatuses: [409] }),
      error => typed(error, 409, "http_409"));
    assert.equal(calls, 1);
  }
});

test("valid Realm success, typed errors and explicitly allowed blocked checkpoints retain their contracts", async () => {
  const result = { receipt: "intent=commented", comment: { id: "comment:owned" } };
  const success = clientFor(JSON.stringify(result), 200, () => undefined);
  assert.deepEqual(await success.commentIntent("intent:owned", { body: "Note" }, "comment:owned"), result);
  const failure = clientFor(JSON.stringify({ code: "owner_session_rejected", recoveryAction: "authenticate again", receipt: "credentialMaterialStored=false", secret: "PRIVATE omitted" }), 401, () => undefined);
  await assert.rejects(() => failure.inspectState(), error => {
    assert.ok(error instanceof RealmAuthorityRequestError);
    assert.equal(error.status, 401); assert.equal(error.code, "owner_session_rejected");
    assert.equal(error.recoveryAction, "authenticate again"); assert.equal(error.receipt, "credentialMaterialStored=false");
    assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
  const checkpoint = { status: "blocked", receipt: "provider=not-run" };
  const blocked = clientFor(JSON.stringify(checkpoint), 409, () => undefined);
  assert.deepEqual(await blocked.syncMirror("mirror:owned", {}, "mirror:owned"), checkpoint);
});

test("the actual Intent CLI fails a malformed received reply and preserves the selected draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-realm-response-"));
  const note = "PRIVATE saved note\n确认\n";
  const requests: { url: string; method: string; body: string; key: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url ?? "", method: request.method ?? "", body, key: String(request.headers["idempotency-key"]) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"receipt":"PRIVATE truncated response');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const realm = `http://127.0.0.1:${address.port}`;
    const path = join(root, "draft.md"); await writeFile(path, note, { mode: 0o600 });
    const before = await stat(path);
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANYAM_|CLOUDFLARE_|CF_|GIT_|NODE_OPTIONS$)/u.test(key)));
    for (const json of [false, true]) {
      const key = `comment:${requests.length}`;
      const argv = ["--import", loader, fileURLToPath(new URL("../packages/create-anyam/src/anyam.ts", import.meta.url)),
        "intent", "comment", "intent:owned", "--body-file", path, "--idempotency-key", key,
        "--realm", realm, "--owner-session", "synthetic-owner", ...(json ? ["--json"] : [])];
      let failure: unknown;
      try { await execFile(process.execPath, argv, { cwd: root, env: { ...env, TSX_DISABLE_CACHE: "1", ANYAM_STATE_HOME: join(root, "state") } }); }
      catch (error) { failure = error; }
      assert.ok(failure && typeof failure === "object");
      const result = failure as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /PRIVATE/);
      if (json) { assert.equal(JSON.parse(result.stderr).status, "error"); assert.match(JSON.parse(result.stderr).message, /realm_authority_response_invalid/); }
      else assert.match(result.stderr, /^realm_authority_response_invalid/);
      assert.equal(requests.length, Number(key.split(":")[1]) + 1, "one explicit invocation sends one request");
      assert.deepEqual(requests.at(-1), { url: "/api/intents/intent%3Aowned/comment", method: "POST", body: JSON.stringify({ body: note }), key });
      assert.equal(await readFile(path, "utf8"), note);
      const after = await stat(path);
      assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.mode, before.mode);
    }
    assert.equal(requests.length, 2);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("both actual CLI entrypoints reject malformed owner reads through their supported Realm command", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-realm-read-response-"));
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/authority/run-details/run%3Aowned");
    assert.equal(request.headers.cookie, "anyam_owner_session=synthetic-owner");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('["PRIVATE unexpected response"]');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANYAM_|CLOUDFLARE_|CF_|GIT_|NODE_OPTIONS$)/u.test(key)));
    for (const entrypoint of ["anyam.ts", "create-anyam.ts"]) {
      const argv = ["--import", loader, fileURLToPath(new URL(`../packages/create-anyam/src/${entrypoint}`, import.meta.url)),
        "realm", "run", "detail", "--realm", `http://127.0.0.1:${address.port}`, "--id", "run:owned", "--session-stdin", "--json"];
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, argv, { cwd: root, env: { ...env, TSX_DISABLE_CACHE: "1", ANYAM_STATE_HOME: join(root, "state") } });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
        child.stdin.end("synthetic-owner\n");
      });
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /PRIVATE|synthetic-owner/);
      assert.equal(JSON.parse(result.stderr).status, "error");
      assert.match(JSON.parse(result.stderr).message, /realm_authority_response_invalid/);
    }
    assert.equal(requests, 2);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
