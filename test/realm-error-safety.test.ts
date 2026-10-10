import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containsKnownTextMaterial, scanCredentialMaterial } from "../packages/create-anyam/src/credential-material.ts";
import { RealmAuthorityHttpClient, RealmAuthorityRequestError } from "../packages/create-anyam/src/realm-authority-client.ts";
import * as repositoryScanner from "../src/security/credential-material.ts";

const owner = "opaque-owner:fixture-only-canary";
const fields = ["code", "recoveryAction", "receipt"] as const;
const safe = { code: "fixture_failure", recoveryAction: "inspect the customer Realm receipt", receipt: "credentialMaterialStored=false" };
const materials = [
  "Authorization: Bearer fixture-only-canary",
  `Basic ${Buffer.from("fixture-only:canary").toString("base64")}`,
  "eyJmaXh0dXJlIjoxfQ.cGF5bG9hZA.c2lnbmF0dXJl",
  "-----BEGIN PRIVATE KEY-----\nfixture-only-canary\n-----END PRIVATE KEY-----",
  "ghp_012345678901234567890123456789",
  "api_key=fixture-only-canary",
  "https://fixture-only:canary@example.invalid/",
  encodeURIComponent("Authorization: Bearer fixture-only-canary"),
  Buffer.from("Authorization: Bearer fixture-only-canary").toString("base64"),
  `owner rejected: ${owner}`,
  `owner rejected: ${encodeURIComponent(owner)}`,
  `echo=${Buffer.from(owner).toString("base64")}; received`,
];

test("the published CLI and repository expose the identical scanner implementation", () => {
  assert.equal(repositoryScanner.scanCredentialMaterial, scanCredentialMaterial);
  assert.equal(repositoryScanner.containsKnownTextMaterial, containsKnownTextMaterial);
});

test("HTTP errors replace each unsafe diagnostic field while preserving status and safe neighbours", async () => {
  for (const status of [401, 409, 503]) for (const field of fields) for (const material of materials) {
    let calls = 0;
    const payload = { ...safe, [field]: material };
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: owner,
      fetchImpl: async () => { calls++; return Response.json(payload, { status }); } });
    await assert.rejects(() => client.inspectState(), error => {
      assert.ok(error instanceof RealmAuthorityRequestError);
      assert.equal(error.status, status);
      const fallbacks = {
        code: `http_${status}`,
        recoveryAction: "inspect the customer Realm receipt and retry only the same idempotent request when safe",
        receipt: "receipt=not-returned; credentialMaterialStored=false",
      };
      for (const selected of fields) assert.equal(error[selected], selected === field ? fallbacks[selected] : safe[selected]);
      assert.ok(!error.message.includes(material));
      assert.doesNotMatch(error.message, /fixture-only-canary|opaque-owner/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("forwarded owner cookies, ordinary safe errors and allowed blocked checkpoints retain their contracts", async () => {
  for (const ownerSession of [owner, `anyam_owner_session=${encodeURIComponent(owner)}; ignored=not-forwarded`]) {
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession,
      fetchImpl: async () => Response.json({ ...safe, receipt: `reflected=${encodeURIComponent(owner)}` }, { status: 503 }) });
    await assert.rejects(() => client.inspectState(), error => {
      assert.ok(error instanceof RealmAuthorityRequestError);
      assert.equal(error.receipt, "receipt=not-returned; credentialMaterialStored=false");
      return true;
    });
  }
  const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: owner,
    fetchImpl: async () => Response.json({ ...safe, secret: "PRIVATE ignored extra field" }, { status: 401 }) });
  await assert.rejects(() => client.inspectState(), error => {
    assert.ok(error instanceof RealmAuthorityRequestError);
    assert.equal(error.status, 401);
    for (const field of fields) assert.equal(error[field], safe[field]);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  const checkpoint = { status: "blocked", receipt: "provider=not-run" };
  const blocked = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: owner,
    fetchImpl: async () => Response.json(checkpoint, { status: 409 }) });
  assert.deepEqual(await blocked.syncMirror("mirror:owned", {}, "mirror:owned"), checkpoint);
});

test("allowed HTTP error checkpoints still reject credential-bearing payloads without disclosure or retry", async () => {
  const payloads = [
    ...fields.map(field => ({ status: "blocked", ...safe, [field]: `reflected=${owner}` })),
    { status: "blocked", receipt: "provider=not-run", metadata: { accessToken: "fixture-only-canary" } },
    { status: "blocked", receipt: "Authorization: Bearer fixture-only-canary" },
  ];
  for (const payload of payloads) for (const operation of ["mirror", "command"]) {
    let calls = 0;
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: owner,
      fetchImpl: async () => { calls++; return Response.json(payload, { status: 409 }); } });
    await assert.rejects(() => operation === "mirror"
      ? client.syncMirror("mirror:owned", {}, "mirror:owned")
      : client.command({ command: "promotion.request", payload: {}, idempotencyKey: "command:owned", allowStatuses: [409] }), error => {
      assert.ok(error instanceof RealmAuthorityRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "realm_authority_response_unsafe");
      assert.doesNotMatch(error.message, /opaque-owner|fixture-only-canary/);
      assert.match(error.recoveryAction, /inspect.*Realm/);
      assert.match(error.recoveryAction, /original.*idempotency/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("both actual CLI entrypoints hide unsafe HTTP error fields in terminal and JSON output without retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-error-safety-"));
  let payload = safe, requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/authority/run-details/run%3Aowned");
    assert.equal(request.headers.cookie, `anyam_owner_session=${encodeURIComponent(owner)}`);
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANYAM_|CF_|CLOUDFLARE_|GIT_|NODE_OPTIONS$)/u.test(key)));
    for (const field of fields) for (const json of [false, true]) for (const entry of ["anyam.ts", "create-anyam.ts"]) {
      const before = requests;
      payload = { ...safe, [field]: field === "receipt" ? `owner=${owner}` : materials[0]! };
      const args = ["--import", loader, fileURLToPath(new URL(`../packages/create-anyam/src/${entry}`, import.meta.url)),
        "realm", "run", "detail", "--realm", `http://127.0.0.1:${address.port}`, "--id", "run:owned", "--session-stdin", ...(json ? ["--json"] : [])];
      const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, env: { ...env, TSX_DISABLE_CACHE: "1", ANYAM_STATE_HOME: join(root, "state") } });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", reject); child.once("close", exit => resolve({ exit, stdout, stderr }));
        child.stdin.end(`${owner}\n`);
      });
      assert.equal(result.exit, 1); assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /fixture-only-canary|opaque-owner|Authorization: Bearer/);
      if (json) assert.equal(JSON.parse(result.stderr).status, "error");
      assert.equal(requests, before + 1);
    }
    assert.equal(requests, 12);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
