/** Bounded loopback benchmark. Synthetic source, credentials and Git fixtures;
 * no deployment/provider calls, no OS cache flushing, no persistent cache. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { handleSmartHttpRequest, SmartHttpCredentialAuthority } from "../../src/portability/smart-http.ts";
import { changedPaths, handleExactRevisionQuery } from "./exact-revision-query.ts";
import { isolatedGitEnvironment } from "./git-environment.ts";

type Meter = { requestBodyBytes: number; responseBodyBytes: number; gitCpuMs: number; gitCalls: number };
const freshMeter = (): Meter => ({ requestBodyBytes: 0, responseBodyBytes: 0, gitCpuMs: 0, gitCalls: 0 });
const env = { ...isolatedGitEnvironment(), GIT_AUTHOR_NAME: "Query benchmark", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Query benchmark", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-10-13T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-13T00:00:00Z" };

async function timedGit(directory: string, args: readonly string[], meter: Meter, input?: Uint8Array, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = await new Promise<{ code: number; stdout: Buffer; timing: string }>((done, reject) => {
    const p = spawn("/usr/bin/time", ["-p", "git", ...args], { cwd: directory, env: { ...env, ...extraEnv } });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b)); p.stderr.on("data", (b: Buffer) => err.push(b)); p.once("error", reject); p.stdin.on("error", reject);
    p.once("close", code => done({ code: code ?? 1, stdout: Buffer.concat(out), timing: Buffer.concat(err).toString() })); p.stdin.end(input);
  });
  const user = /^user\s+([\d.]+)$/m.exec(r.timing)?.[1], sys = /^sys\s+([\d.]+)$/m.exec(r.timing)?.[1];
  assert.ok(user !== undefined && sys !== undefined, "time -p must report child CPU");
  meter.gitCpuMs += (Number(user) + Number(sys)) * 1000; meter.gitCalls++;
  return { code: r.code, stdout: r.stdout };
}
async function body(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const b of request) chunks.push(Buffer.from(b)); return Buffer.concat(chunks); }
function headers(request: IncomingMessage) { const result = new Headers(); for (const [k, v] of Object.entries(request.headers)) if (v !== undefined) result.set(k, Array.isArray(v) ? v.join(",") : v); return result; }
async function reply(response: ServerResponse, result: Response) { response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); }
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); return `http://127.0.0.1:${address.port}`;
}
async function close(server: ReturnType<typeof createServer>) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }

export async function benchmarkExactRevisionQuery() {
  const root = await mkdtemp(join(tmpdir(), "anyam-exact-query-benchmark-"));
  const upstream = createServer(), gateway = createServer(); let serverMeter = freshMeter();
  try {
    const setup = freshMeter(), repository = join(root, "fixture.git"); await mkdir(repository);
    const git = async (args: readonly string[]) => { const r = await timedGit(repository, args, setup); assert.equal(r.code, 0); return r.stdout.toString().trim(); };
    await git(["init", "--initial-branch=main"]);
    // 64*4096 unique synthetic bytes: a small bounded Git workload, not a
    // representative monorepo. Digests avoid highly compressible filler.
    for (let file = 0; file < 64; file++) {
      const content = Array.from({ length: 64 }, (_, line) => createHash("sha256").update(`fixture:${file}:${line}`).digest("hex")).join("");
      await writeFile(join(repository, `file-${file}.txt`), content);
    }
    await git(["add", "."]); await git(["commit", "-m", "synthetic base"]); const base = await git(["rev-parse", "HEAD"]);
    for (let commit = 0; commit < 8; commit++) {
      await writeFile(join(repository, `file-${commit}.txt`), `changed ${commit}\n`);
      await git(["add", "."]); await git(["commit", "-m", `synthetic change ${commit}`]);
    }
    const head = await git(["rev-parse", "HEAD"]), tree = await git(["rev-parse", "HEAD^{tree}"]);
    const authority = new SmartHttpCredentialAuthority({ now: () => Date.parse("2026-10-13T00:00:00Z") });
    const credential = await authority.issue({ repositoryId: "fixture", sourceSpaceId: "source:fixture", operation: "read", expiresAt: "2026-10-14T00:00:00Z" });
    upstream.on("request", (req, res) => { void (async () => {
      const payload = await body(req), url = new URL(req.url ?? "/", "http://127.0.0.1");
      const r = await timedGit(root, ["http-backend"], serverMeter, payload, { GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? "GET", CONTENT_LENGTH: String(payload.length), CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_GIT_PROTOCOL: typeof req.headers["git-protocol"] === "string" ? req.headers["git-protocol"] : "", REMOTE_ADDR: "127.0.0.1", SERVER_PROTOCOL: "HTTP/1.1" });
      assert.equal(r.code, 0); const split = r.stdout.indexOf("\r\n\r\n"); assert.ok(split >= 0);
      let status = 200; const h = new Headers();
      for (const line of r.stdout.subarray(0, split).toString().split("\r\n")) { const colon = line.indexOf(":"); if (colon < 0) continue; const key = line.slice(0, colon), value = line.slice(colon + 1).trim(); if (key.toLowerCase() === "status") status = Number.parseInt(value); else h.set(key, value); }
      res.writeHead(status, Object.fromEntries(h)); res.end(r.stdout.subarray(split + 4));
    })().catch(() => { res.writeHead(500); res.end("fixture backend failed"); }); });
    const upstreamUrl = await listen(upstream);
    gateway.on("request", (req, res) => { void (async () => {
      const payload = await body(req); serverMeter.requestBodyBytes += payload.length;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const request = new Request(url, { method, headers: headers(req), ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(payload) }) });
      const result = url.pathname === "/changed-paths" ? await handleExactRevisionQuery(request, { repositories: [{ repositoryId: "fixture", sourceSpaceId: "source:fixture", directory: repository }], credentials: authority, authorizeCurrentRead: async () => true, runGit: (d, a) => timedGit(d, a, serverMeter) }) : await handleSmartHttpRequest(request, { upstreamBase: upstreamUrl, credentials: authority, sourceSpaceIdForRepository: () => "source:fixture", allowInsecureUpstream: true });
      assert.ok(result); const bytes = Buffer.from(await result.arrayBuffer()); serverMeter.responseBodyBytes += bytes.length;
      await reply(res, new Response(bytes, { status: result.status, headers: result.headers }));
    })().catch(() => { res.writeHead(500); res.end("fixture gateway failed"); }); });
    const url = await listen(gateway), rows: unknown[] = [];
    const authEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.token}` };
    const expected = await changedPaths(repository, base, head); assert.ok(expected);
    // Alternate which method runs first. OS and server filesystem caches are
    // explicitly uncontrolled; only local clone presence is cold/warm.
    for (let repeat = 0; repeat < 3; repeat++) {
      const clone = join(root, `client-${repeat}`);
      for (const state of ["fresh-client", "existing-clone"] as const) {
        const methods = state === "fresh-client" ? ["clone-local-diff", "server-query"] : ["fetch-local-diff", "local-only-diff", "server-query"];
        for (const method of repeat % 2 === 0 ? methods : [...methods].reverse()) {
          serverMeter = freshMeter(); const clientMeter = freshMeter(), cpu = process.cpuUsage(), start = performance.now();
          if (method !== "server-query") {
            if (method !== "local-only-diff") {
              const transfer = state === "fresh-client" ? await timedGit(root, ["clone", "--quiet", `${url}/git/fixture.git`, clone], clientMeter, undefined, authEnv) : await timedGit(clone, ["fetch", "--quiet", "origin"], clientMeter, undefined, authEnv);
              assert.equal(transfer.code, 0);
            }
            const actual = await changedPaths(clone, base, head, (d, a) => timedGit(d, a, clientMeter)); assert.deepEqual(actual, expected);
          } else {
            const result = await fetch(`${url}/changed-paths`, { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ repositoryId: "fixture", base, head }) });
            assert.equal(result.status, 200); const actual = await result.json(); assert.deepEqual(actual.changedPaths, expected); assert.equal(actual.base, base); assert.equal(actual.head, head);
          }
          const nodeCpu = process.cpuUsage(cpu);
          rows.push({ repeat, state, method, latencyMs: performance.now() - start, nodeCombinedClientAndServerCpuMs: (nodeCpu.user + nodeCpu.system) / 1000, clientGitCpuMs: clientMeter.gitCpuMs, serverGitCpuMs: serverMeter.gitCpuMs, clientGitCalls: clientMeter.gitCalls, serverGitCalls: serverMeter.gitCalls, requestBodyBytes: serverMeter.requestBodyBytes, responseBodyBytes: serverMeter.responseBodyBytes });
        }
      }
    }
    await authority.revoke(credential.token);
    const revoked = await fetch(`${url}/changed-paths`, { method: "POST", headers: { authorization: `Bearer ${credential.token}` }, body: JSON.stringify({ repositoryId: "fixture", base, head }) }); assert.equal(revoked.status, 404);
    const benchmarkSourceSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
    const querySourceSha256 = createHash("sha256").update(await readFile(new URL("./exact-revision-query.ts", import.meta.url))).digest("hex");
    const gitEnvironmentSourceSha256 = createHash("sha256").update(await readFile(new URL("./git-environment.ts", import.meta.url))).digest("hex");
    return { protocol: "anyam.experiment.exact-query-benchmark/v1", measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, git: await git(["--version"]), benchmarkSourceSha256, querySourceSha256, gitEnvironmentSourceSha256, base, head, tree, sourceFiles: 64, initialSourceBytes: 262144, commits: 9, changedPathsBase64: expected, rows, conditions: { transport: "HTTP loopback through actual Smart HTTP gateway and Git http-backend", networkLatencyInjection: false, coldMeaning: "fresh client clone only; OS/server caches uncontrolled and likely warm after fixture construction", warmMeaning: "same client clone: fetch plus local diff AND local-only immutable diff; repeated query without result caching", cpu: "Node client/server share one process, measured together; Git child CPU separately via time -p at centisecond resolution", bytes: "HTTP entity bodies only; excludes headers, TCP/TLS overhead and local checkout size", order: "alternating method order across three repeats", authority: "synthetic revocable credential and current Source callback; not live Realm or provider qualification; already-disclosed clone data remains locally readable after revocation", readOnly: true } };
  } finally { if (gateway.listening) await close(gateway); if (upstream.listening) await close(upstream); await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2]; if (!output) throw new Error("pass an owned local JSON output path");
  const receipt = await benchmarkExactRevisionQuery(); await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
}
