import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer as createSecureServer } from "node:https";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  SMART_HTTP_GIT_AUDIENCE,
  MemorySmartHttpCredentialStore,
  SmartHttpBudgetTracker,
  SmartHttpCredentialAuthority,
  handleSmartHttpRequest,
  smartHttpQualificationReceipt,
} from "../src/portability/smart-http.ts";
import { SmartHttpRepositoryDriver } from "../src/portability/smart-http-driver.ts";

const execFile = promisify(execFileCallback);

async function git(directory: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd: directory });
  return result.stdout.trim();
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function runGitHttpBackend(request: IncomingMessage, response: ServerResponse, projectRoot: string): Promise<void> {
  const body = await readBody(request);
  const requestUrl = new URL(request.url ?? "/", "http://upstream.invalid");
  const contentType = headerValue(request.headers["content-type"]);
  const gitProtocol = headerValue(request.headers["git-protocol"]);
  const child = await new Promise<{ stdout: Buffer; stderr: string; code: number }>((resolveChild, rejectChild) => {
    const chunks: Buffer[] = [];
    const errorChunks: string[] = [];
    const childProcess = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_LENGTH: String(body.byteLength),
        ...(contentType ? { CONTENT_TYPE: contentType } : {}),
        ...(gitProtocol ? { HTTP_GIT_PROTOCOL: gitProtocol } : {}),
        GATEWAY_INTERFACE: "CGI/1.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        SERVER_NAME: "upstream.invalid",
        SERVER_PORT: "80",
        SERVER_SOFTWARE: "anyam-smart-http-fixture",
        REMOTE_ADDR: "127.0.0.1",
        SCRIPT_NAME: "",
        REQUEST_URI: request.url ?? "/",
      },
    });
    childProcess.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    childProcess.stderr.on("data", (chunk: Buffer | string) => errorChunks.push(chunk.toString()));
    childProcess.once("error", rejectChild);
    childProcess.once("close", (code) => resolveChild({ stdout: Buffer.concat(chunks), stderr: errorChunks.join(""), code: code ?? 1 }));
    childProcess.stdin.end(body);
  });
  if (child.code !== 0) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(child.stderr || "git http-backend failed");
    return;
  }
  const crlf = child.stdout.indexOf(Buffer.from("\r\n\r\n"));
  const lf = child.stdout.indexOf(Buffer.from("\n\n"));
  const separator = crlf >= 0 ? crlf : lf;
  const separatorBytes = crlf >= 0 ? 4 : 2;
  if (separator < 0) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("git http-backend returned no CGI headers");
    return;
  }
  const headerLines = child.stdout.subarray(0, separator).toString("utf8").split(/\r?\n/);
  let status = 200;
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value.split(" ", 1)[0] ?? "200", 10) || 200;
    } else {
      headers.append(name, value);
    }
  }
  response.writeHead(status, Object.fromEntries(headers.entries()));
  response.end(child.stdout.subarray(separator + separatorBytes));
}

function listen(server: Server, protocol: "http" | "https" = "http"): Promise<string> {
  return new Promise((resolveAddress, rejectAddress) => {
    server.once("error", rejectAddress);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectAddress(new Error("fixture server did not expose an address"));
        return;
      }
      resolveAddress(`${protocol}://127.0.0.1:${address.port}`);
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function createGatewayServer(config: Parameters<typeof handleSmartHttpRequest>[1], tls: { key: Buffer; cert: Buffer }): Promise<{ server: Server; origin: string }> {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        const text = headerValue(value);
        if (text !== undefined) headers.set(name, text);
      }
      const upstreamRequest = body === undefined
        ? new Request(`http://gateway.invalid${request.url ?? "/"}`, { method, headers })
        : new Request(`http://gateway.invalid${request.url ?? "/"}`, { method, headers, body: new Uint8Array(body) as unknown as BodyInit });
      const result = await handleSmartHttpRequest(upstreamRequest, config);
      if (!result) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not a Git route");
        return;
      }
      const output = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(output);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "gateway fixture failed");
    }
  };
  const server = createSecureServer(tls, handler);
  return { server, origin: await listen(server, "https") };
}

async function seedRepository(root: string): Promise<{ canonical: string; workspace: string }> {
  const canonical = join(root, "canonical.git");
  const workspace = join(root, "workspace.git");
  const seed = join(root, "seed");
  await git(undefined, ["init", "--bare", "--initial-branch=main", canonical]);
  await git(undefined, ["--git-dir", canonical, "config", "http.receivepack", "true"]);
  await git(undefined, ["init", "--initial-branch=main", seed]);
  await git(seed, ["config", "user.name", "Anyam Smart HTTP Fixture"]);
  await git(seed, ["config", "user.email", "smart-http-fixture@anyam.invalid"]);
  await writeFile(join(seed, "README.md"), "initial\n", "utf8");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "Initial fixture commit"]);
  await git(seed, ["remote", "add", "origin", canonical]);
  await git(seed, ["push", "origin", "main"]);
  await git(undefined, ["--git-dir", canonical, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(undefined, ["clone", "--bare", canonical, workspace]);
  await git(undefined, ["--git-dir", workspace, "config", "http.receivepack", "true"]);
  return { canonical, workspace };
}

test("Smart HTTP qualifies real Git clone, fetch, Workspace push, CAS, export/restore, and recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-smart-http-"));
  let upstream: Server | undefined;
  let gateway: Server | undefined;
  try {
    const repositories = await seedRepository(root);
    upstream = createServer((request, response) => { void runGitHttpBackend(request, response, root); });
    const upstreamOrigin = await listen(upstream);
    const certificateDirectory = join(root, "tls");
    await mkdir(certificateDirectory, { recursive: true });
    await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certificateDirectory, "key.pem"), "-out", join(certificateDirectory, "cert.pem"), "-days", "1", "-subj", "/CN=anyam-smart-http-fixture"]);
    const tls = { key: await readFile(join(certificateDirectory, "key.pem")), cert: await readFile(join(certificateDirectory, "cert.pem")) };
    const store = new MemorySmartHttpCredentialStore();
    const authority = new SmartHttpCredentialAuthority({ store });
    await authority.ready();
    const expiry = () => new Date(Date.now() + 60_000).toISOString();
    const restartCredential = await authority.issue({ repositoryId: "canonical", sourceSpaceId: "source:test", operation: "read", expiresAt: expiry() });
    const restarted = new SmartHttpCredentialAuthority({ store });
    await restarted.ready();
    assert.equal((await restarted.validate(restartCredential.token, { repositoryId: "canonical", sourceSpaceId: "source:test", operation: "read" })).valid, true);
    assert.equal(await restarted.revoke(restartCredential.token), true);
    const replacement = new SmartHttpCredentialAuthority({ store });
    await replacement.ready();
    const revokedAfterRestart = await replacement.validate(restartCredential.token, { repositoryId: "canonical", sourceSpaceId: "source:test", operation: "read" });
    assert.equal(!revokedAfterRestart.valid && revokedAfterRestart.code === "revoked", true);
    const gatewayConfig = {
      upstreamBase: `${upstreamOrigin}/`,
      credentials: authority,
      allowInsecureUpstream: true,
      sourceSpaceIdForRepository: ({ repositoryId }: { repositoryId: string }) => repositoryId === "canonical" || repositoryId === "workspace" ? "source:test" : undefined,
      workspaceIdForRepository: ({ repositoryId }: { repositoryId: string }) => repositoryId === "workspace" ? "workspace:test" : undefined,
    };
    const publicGatewayConfig = {
      ...gatewayConfig,
      anonymousReadForRepository: ({ repositoryId, sourceSpaceId }: { repositoryId: string; sourceSpaceId: string }) => repositoryId === "canonical" && sourceSpaceId === "source:test",
    };
    const receiveAdvertisement = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/canonical.git/info/refs?service=git-receive-pack", { method: "GET" }), publicGatewayConfig);
    assert.ok(receiveAdvertisement);
    if (receiveAdvertisement) assert.equal(receiveAdvertisement.status, 401);
    const publicReadAdvertisement = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/canonical.git/info/refs?service=git-upload-pack", { method: "GET" }), publicGatewayConfig);
    assert.ok(publicReadAdvertisement);
    if (publicReadAdvertisement) assert.equal(publicReadAdvertisement.status, 200);
    const unboundRoute = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/unknown.git/info/refs?service=git-upload-pack", { method: "GET" }), gatewayConfig);
    assert.ok(unboundRoute);
    if (unboundRoute) assert.equal(unboundRoute.status, 403);
    const gatewayFixture = await createGatewayServer(gatewayConfig, tls);
    gateway = gatewayFixture.server;
    const driver = new SmartHttpRepositoryDriver({
      workspaceRoot: join(root, "driver"),
      credentials: authority,
      credentialExpiresAt: expiry,
      allowInsecureTlsForQualification: true,
      workspaceIdForRepository: (repositoryId) => repositoryId === "workspace" ? "workspace:test" : undefined,
    });

    const canonicalSource = `${gatewayFixture.origin}/git/canonical.git`;
    const canonical = await driver.cloneRepository({ sourceSpaceId: "source:test", source: canonicalSource, destination: join(root, "canonical-checkout"), idempotencyKey: "clone:canonical" });
    assert.equal(canonical.status, "succeeded");
    if (canonical.status !== "succeeded") return;
    const fetched = await driver.fetchRepository({ repository: canonical.value, idempotencyKey: "fetch:canonical" });
    assert.equal(fetched.status, "succeeded");
    const canonicalPush = await driver.pushRepository({ repository: canonical.value, idempotencyKey: "push:canonical" });
    assert.equal(canonicalPush.status, "failed");
    if (canonicalPush.status === "failed") assert.equal(canonicalPush.errorCode, "canonical_write_denied");

    const wrongSourceCredential = await authority.issue({ repositoryId: "canonical", sourceSpaceId: "source:other", operation: "read", expiresAt: expiry() });
    const wrongSourceResponse = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/canonical.git/git-upload-pack", { method: "POST", headers: { authorization: `Bearer ${wrongSourceCredential.token}`, "content-type": "application/x-git-upload-pack-request" }, body: new Uint8Array() }), gatewayConfig);
    assert.ok(wrongSourceResponse);
    if (wrongSourceResponse) assert.equal(wrongSourceResponse.status, 403);

    const directWrite = await authority.issue({ repositoryId: "canonical", sourceSpaceId: "source:test", workspaceId: "workspace:test", operation: "write", expiresAt: expiry() });
    const deniedResponse = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/canonical.git/git-receive-pack", { method: "POST", headers: { authorization: `Bearer ${directWrite.token}`, "content-type": "application/x-git-receive-pack-request" }, body: new Uint8Array() }), gatewayConfig);
    assert.ok(deniedResponse);
    if (!deniedResponse) return;
    assert.equal(deniedResponse.status, 403);
    assert.equal((await deniedResponse.json() as { code: string }).code, "canonical_write_denied");

    const workspaceSource = `${gatewayFixture.origin}/git/workspace.git`;
    const workspace = await driver.cloneRepository({ sourceSpaceId: "source:test", source: workspaceSource, destination: join(root, "workspace-checkout"), idempotencyKey: "clone:workspace" });
    assert.equal(workspace.status, "succeeded");
    if (workspace.status !== "succeeded") return;
    await writeFile(join(root, "workspace-checkout", "README.md"), "initial\nworkspace change\n", "utf8");
    const firstCommit = await driver.commitRepository({ repository: workspace.value, message: "Workspace change" });
    assert.equal(firstCommit.status, "succeeded");
    if (firstCommit.status !== "succeeded") return;
    const workspacePush = await driver.pushRepository({ repository: workspace.value, refs: ["refs/heads/main"], idempotencyKey: "push:workspace" });
    assert.equal(workspacePush.status, "succeeded");

    await writeFile(join(root, "workspace-checkout", "README.md"), "initial\nworkspace change\nCAS change\n", "utf8");
    const secondCommit = await driver.commitRepository({ repository: workspace.value, message: "CAS change" });
    assert.equal(secondCommit.status, "succeeded");
    if (secondCommit.status !== "succeeded") return;
    const cas = await driver.compareAndSwapRefs({
      repository: workspace.value,
      expected: { "refs/heads/main": firstCommit.value.commitId },
      desired: { "refs/heads/main": secondCommit.value.commitId },
      idempotencyKey: "cas:workspace:current",
    });
    assert.equal(cas.status, "succeeded");
    await writeFile(join(root, "workspace-checkout", "README.md"), "initial\nworkspace change\nCAS change\nconflict candidate\n", "utf8");
    const thirdCommit = await driver.commitRepository({ repository: workspace.value, message: "Conflict candidate" });
    assert.equal(thirdCommit.status, "succeeded");
    if (thirdCommit.status !== "succeeded") return;
    const stale = await driver.compareAndSwapRefs({
      repository: workspace.value,
      expected: { "refs/heads/main": firstCommit.value.commitId },
      desired: { "refs/heads/main": thirdCommit.value.commitId },
      idempotencyKey: "cas:workspace:stale",
    });
    assert.equal(stale.status, "failed");
    if (stale.status === "failed") assert.equal(stale.errorCode, "repository.stale_ref");
    const casAfterStale = await driver.compareAndSwapRefs({
      repository: workspace.value,
      expected: { "refs/heads/main": secondCommit.value.commitId },
      desired: { "refs/heads/main": thirdCommit.value.commitId },
      idempotencyKey: "cas:workspace:recovered",
    });
    assert.equal(casAfterStale.status, "succeeded");

    const exportDirectory = join(root, "export");
    const exported = await driver.exportRepository({ repository: workspace.value, destination: exportDirectory, checkpointId: "checkpoint:smart-http-export" });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    const verified = await driver.verifyRepository({ repository: workspace.value, expected: exported.value.repository, bundlePath: exported.value.bundlePath });
    assert.equal(verified.status, "succeeded");
    if (verified.status !== "succeeded") return;
    assert.equal(verified.value.refsMatch, true);
    assert.equal(verified.value.bundleVerified, true);
    assert.equal(verified.value.fsckPassed, true);
    const restored = await driver.restoreRepository({ sourceSpaceId: "source:test", bundlePath: exported.value.bundlePath, destination: join(root, "restored"), expectedDigest: exported.value.repository.bundle.digest, refs: exported.value.repository.refs, defaultBranch: exported.value.repository.defaultBranch });
    assert.equal(restored.status, "succeeded");
    if (restored.status !== "succeeded") return;
    const restoredVerification = await driver.verifyRepository({ repository: restored.value.repository, expected: exported.value.repository, bundlePath: exported.value.bundlePath });
    assert.equal(restoredVerification.status, "succeeded");
    if (restoredVerification.status !== "succeeded") return;
    assert.equal(restoredVerification.value.refsMatch, true);
    assert.equal(restoredVerification.value.bundleVerified, true);

    const failedFirst = await driver.cloneRepository({ sourceSpaceId: "source:test", source: "https://127.0.0.1:1/git/unavailable.git", destination: join(root, "failed-first"), idempotencyKey: "clone:provider-outage" });
    const failedSecond = await driver.cloneRepository({ sourceSpaceId: "source:test", source: "https://127.0.0.1:1/git/unavailable.git", destination: join(root, "failed-second"), idempotencyKey: "clone:provider-outage" });
    assert.equal(failedFirst.status, "failed");
    assert.equal(failedSecond.status, "failed");
    if (failedFirst.status === "failed" && failedSecond.status === "failed") {
      assert.equal(failedFirst.retryable, true);
      assert.equal(failedFirst.checkpointId, failedSecond.checkpointId);
      assert.match(failedFirst.recoveryAction ?? "", /retry/i);
    }

    const qualification = smartHttpQualificationReceipt({
      endpoint: gatewayFixture.origin,
      clone: "passed",
      fetch: "passed",
      workspacePush: "passed",
      canonicalPush: "passed",
      cas: "passed",
      exportRestore: "passed",
      providerFailureRecovery: "passed",
      providerFacts: {
        transport: "git-smart-http-over-https",
        upstream: "customer-controlled-http-fixture; qualification-only",
        credentialStore: "digest-only",
        sourceSnapshot: "real-Git-pack-transfer",
      },
    });
    assert.equal(qualification.status, "succeeded");
    assert.equal((qualification.anyamPolicy as { canonicalWrite: string }).canonicalWrite, "landing-only");
    assert.equal(qualification.providerFactsAreNotAnyamLimits, undefined);
    assert.equal((qualification.anyamPolicy as { providerFactsAreNotAnyamLimits: boolean }).providerFactsAreNotAnyamLimits, true);
    assert.equal(authority.snapshot().credentialMaterialStored, false);
    assert.equal(JSON.stringify(authority.snapshot()).includes("token"), false);
    assert.equal(SMART_HTTP_GIT_AUDIENCE, "aud:anyam:git");
  } finally {
    if (gateway) await close(gateway);
    if (upstream) await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("Smart HTTP budget tripwires reject measured request and concurrency asks with receipts", async () => {
  const authority = new SmartHttpCredentialAuthority();
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const credential = await authority.issue({ repositoryId: "workspace", sourceSpaceId: "source:test", workspaceId: "workspace:test", operation: "write", expiresAt: expiry });
  const tracker = new SmartHttpBudgetTracker("measurement=smart-http-fixture; workload=write-pack; source=bounded-test");
  const config = {
    upstreamBase: "https://upstream.invalid/",
    credentials: authority,
    sourceSpaceIdForRepository: ({ repositoryId }: { repositoryId: string }) => repositoryId === "workspace" ? "source:test" : undefined,
    workspaceIdForRepository: ({ repositoryId }: { repositoryId: string }) => repositoryId === "workspace" ? "workspace:test" : undefined,
    budgetTracker: tracker,
    budgets: { write: { maxRequestBytes: 4, maxConcurrentRequests: 2, receipt: "measurement=smart-http-fixture; workload=write-pack; source=bounded-test" } },
  };
  const oversized = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/workspace.git/git-receive-pack", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/x-git-receive-pack-request", "content-length": "8" }, body: new Uint8Array(8) }), config);
  assert.ok(oversized);
  if (oversized) {
    assert.equal(oversized.status, 413);
    const body = await oversized.json() as { code: string; receipt: string };
    assert.equal(body.code, "git_budget_exceeded");
    assert.match(body.receipt, /budget=packBytes; limit=4; asked=8/);
  }
  assert.equal(tracker.acquire(1), true);
  const concurrent = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/workspace.git/info/refs?service=git-upload-pack", { method: "GET", headers: { authorization: `Bearer ${credential.token}` } }), { ...config, budgets: { read: { maxConcurrentRequests: 1, receipt: "measurement=smart-http-fixture; workload=read; source=bounded-test" } } });
  assert.ok(concurrent);
  if (concurrent) assert.equal(concurrent.status, 429);
  tracker.release();
});

test("Smart HTTP counts chunked bodies and holds concurrency until response close", async () => {
  const authority = new SmartHttpCredentialAuthority();
  const credential = await authority.issue({ repositoryId: "workspace", sourceSpaceId: "source:test", workspaceId: "workspace:test", operation: "write", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const tracker = new SmartHttpBudgetTracker("measurement=smart-http-stream-fixture; workload=chunked-pack; source=bounded-test");
  const config = {
    upstreamBase: "https://upstream.invalid/",
    credentials: authority,
    sourceSpaceIdForRepository: () => "source:test",
    workspaceIdForRepository: () => "workspace:test",
    budgetTracker: tracker,
    budgets: { write: { maxRequestBytes: 4, maxResponseBytes: 4, maxDurationMs: 500, maxConcurrentRequests: 1, receipt: "measurement=smart-http-stream-fixture; workload=chunked-pack; source=bounded-test" } },
  };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as ReadableStream<Uint8Array> | null | undefined;
      if (body) {
        const reader = body.getReader();
        while (!(await reader.read()).done) { /* consume the counted request stream */ }
      }
      return new Response("upstream", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch;
    const oversized = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/workspace.git/git-receive-pack", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/x-git-receive-pack-request" }, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); controller.close(); } }), duplex: "half" } as RequestInit & { duplex: "half" }), config);
    assert.ok(oversized);
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.json() as { receipt: string };
    assert.match(oversizedBody.receipt, /budget=packBytes; limit=4; asked=6/);

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2)); setTimeout(() => { controller.enqueue(new Uint8Array(2)); controller.close(); }, 20); } }), { status: 200, headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    const response = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/workspace.git/git-receive-pack", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/x-git-receive-pack-request" }, body: new Uint8Array(0) }), { ...config, budgets: { write: { maxResponseBytes: 4, maxDurationMs: 500, maxConcurrentRequests: 1, receipt: "measurement=smart-http-stream-fixture; workload=chunked-response; source=bounded-test" } } });
    assert.ok(response);
    assert.equal(tracker.current(), 1, "the concurrency slot remains held after response headers");
    assert.equal(new Uint8Array(await response.arrayBuffer()).byteLength, 4);
    assert.equal(tracker.current(), 0, "the concurrency slot is released after response close");

    globalThis.fetch = (async () => {
      let slowTimer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          slowTimer = setTimeout(() => { controller.enqueue(new Uint8Array(1)); controller.close(); }, 50);
        },
        cancel() {
          if (slowTimer) clearTimeout(slowTimer);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch;
    const slow = await handleSmartHttpRequest(new Request("https://gateway.invalid/git/workspace.git/git-receive-pack", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/x-git-receive-pack-request" }, body: new Uint8Array(0) }), { ...config, budgets: { write: { maxResponseBytes: 4, maxDurationMs: 10, maxConcurrentRequests: 1, receipt: "measurement=smart-http-stream-fixture; workload=slow-response; source=bounded-test" } } });
    assert.ok(slow);
    await assert.rejects(() => slow.arrayBuffer());
    assert.equal(tracker.current(), 0, "the duration timeout releases the slot after cancelling the slow body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
