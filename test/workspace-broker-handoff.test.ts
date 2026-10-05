import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";
import { LocalAgentManager, LOCAL_ACTION_POLICY, localAgentStatePath, type LocalAgentSession } from "../packages/create-anyam/src/agent.ts";
import { scaffoldProject, startChange } from "../packages/create-anyam/src/scaffold.ts";
import { WORKSPACE_BOUNDARY_POLICY } from "../packages/create-anyam/src/workspace-boundary.ts";

const execFile = promisify(execFileCallback);
const entrypoint = resolve("packages/create-anyam/src/anyam.ts");
const platform = { skip: process.platform === "win32" ? "local socket ownership is POSIX-only; Windows handoff is not qualified" : false, timeout: LOCAL_ACTION_POLICY.timeoutMs };
type Json = Record<string, unknown>;

class Broker {
  readonly process: ChildProcessWithoutNullStreams;
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  constructor(readonly directory: string, readonly environment: NodeJS.ProcessEnv, sessionId?: string) {
    this.process = spawn(process.execPath, ["--import", "tsx", entrypoint, "mcp", "serve", "--stdio", "--agent", "cli", "--directory", directory,
      ...(sessionId ? ["--session", sessionId] : ["--mode", "supervised"])], { cwd: process.cwd(), env: environment, stdio: "pipe" });
    createInterface({ input: this.process.stdout }).on("line", line => {
      const value = JSON.parse(line) as Json; const pending = this.pending.get(Number(value.id));
      if (pending) { this.pending.delete(Number(value.id)); pending.resolve(value); }
    });
    this.process.on("error", error => this.reject(error));
    this.process.on("exit", () => this.reject(new Error("fixture broker exited")));
    this.process.stderr.resume();
  }
  private reject(error: Error) { for (const value of this.pending.values()) value.reject(error); this.pending.clear(); }
  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.id;
    return new Promise((resolveResponse, reject) => { this.pending.set(id, { resolve: resolveResponse, reject }); this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async session(): Promise<LocalAgentSession> {
    const initialized = await this.request("initialize"); assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    const inspected = await this.request("tools/call", { name: "workspace.inspect" });
    const id = String(((inspected.result as Json).structuredContent as Json).sessionId);
    const state = JSON.parse(await readFile(localAgentStatePath(this.directory, this.environment.ANYAM_STATE_HOME), "utf8")) as { sessions: Record<string, LocalAgentSession> };
    return state.sessions[id]!;
  }
  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>(resolveExit => this.process.once("exit", () => resolveExit())); this.process.kill("SIGKILL"); await exited;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-handoff-")); const directory = join(root, "project"); const stateDirectory = join(root, "state");
  await scaffoldProject({ directory, name: "handoff-fixture", kind: "worker" });
  for (const args of [["config", "user.name", "Anyam fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "--quiet", "-m", "Synthetic baseline"]]) await execFile("git", args, { cwd: directory });
  await startChange(directory, "Synthetic selected Workspace");
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C", TERM: "dumb", TMPDIR: root, ANYAM_STATE_HOME: stateDirectory };
  const manager = new LocalAgentManager({ directory, stateDirectory }); const brokers: Broker[] = [];
  const open = (id?: string) => { const broker = new Broker(directory, environment, id); brokers.push(broker); return broker; };
  const execute = (sessionId: string, script: string, extra: string[] = []) => execFile(process.execPath, ["--import", "tsx", entrypoint, "workspace", "exec", "--directory", directory, "--session", sessionId, "--json", "--", process.execPath, "-e", script, ...extra], { cwd: process.cwd(), env: environment });
  return { root, directory, stateDirectory, environment, manager, open, execute, async cleanup() { for (const broker of brokers) await broker.stop(); for (const item of await manager.listSessions()) await manager.revoke(item.session.id); await rm(root, { recursive: true, force: true }); } };
}

test("fresh CLI executes in its selected live broker without returning runtime credentials", platform, async () => {
  const f = await fixture();
  try {
    const selected = await f.open().session(); const before = (await execFile("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout;
    const executed = await f.execute(selected.id, "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ["literal argument", "--session", "child-only-session", "--mode", "child-only-mode"]);
    const result = JSON.parse(executed.stdout) as { session: LocalAgentSession; boundary: Json; command: { status: string; args: string[]; stdout: string } };
    assert.equal(result.session.id, selected.id); assert.equal(result.session.grantId, selected.grantId); assert.equal(result.boundary.mode, "supervised");
    assert.equal(result.command.status, "passed"); assert.deepEqual(JSON.parse(result.command.stdout), ["literal argument", "--session", "child-only-session", "--mode", "child-only-mode"]);
    assert.equal(Object.hasOwn(result.boundary, "environment"), false);
    assert.equal((await execFile("git", ["rev-parse", "HEAD"], { cwd: f.directory })).stdout, before);
    assert.equal((await f.manager.inspectSession(selected.id))?.session?.id, selected.id, "handoff does not mint replacement authority");
  } finally { await f.cleanup(); }
});

test("a sibling's broker locator cannot supply the selected session's authority", platform, async () => {
  const f = await fixture();
  try {
    const a = await f.open().session(); const b = await f.open().session();
    const { workspaceBrokerLocatorPath } = await import("../packages/create-anyam/src/workspace-broker.js");
    const aPath = workspaceBrokerLocatorPath(f.manager.statePathname, a.id); const bPath = workspaceBrokerLocatorPath(f.manager.statePathname, b.id);
    const original = await readFile(bPath, "utf8"); const aLocator = JSON.parse(await readFile(aPath, "utf8")) as Json;
    // Bind the peer endpoint to B's otherwise valid identity. A must use its
    // own in-memory binding, rather than accepting the caller's metadata.
    const bLocator = JSON.parse(original) as Json; bLocator.endpoint = aLocator.endpoint; bLocator.instanceId = aLocator.instanceId;
    await writeFile(bPath, JSON.stringify(bLocator));
    const marker = join(f.root, "peer-workload");
    try { await assert.rejects(f.execute(b.id, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`), /workspace\.broker\.binding_mismatch/u); await assert.rejects(access(marker)); }
    finally { await writeFile(bPath, original); }
    assert.equal(JSON.parse((await f.execute(a.id, "process.stdout.write('selected-a')")).stdout).command.stdout, "selected-a");
    assert.equal(JSON.parse((await f.execute(b.id, "process.stdout.write('selected-b')")).stdout).command.stdout, "selected-b");
    await writeFile(bPath, JSON.stringify(bLocator));
    try {
      await assert.rejects(execFile(process.execPath, ["--import", "tsx", entrypoint, "agent", "revoke", "--session", b.id, "--directory", f.directory, "--json"], { cwd: process.cwd(), env: f.environment }), /workspace\.broker\.binding_mismatch/u);
      assert.equal(JSON.parse((await f.execute(a.id, "process.stdout.write('peer-endpoint-preserved')")).stdout).command.stdout, "peer-endpoint-preserved");
    } finally {
      await writeFile(bPath, original);
      await execFile(process.execPath, ["--import", "tsx", entrypoint, "agent", "revoke", "--session", b.id, "--directory", f.directory, "--json"], { cwd: process.cwd(), env: f.environment });
    }
  } finally { await f.cleanup(); }
});

test("broker request overflow returns its budget denial without losing the selected session", platform, async () => {
  const f = await fixture();
  try {
    const selected = await f.open().session();
    const { workspaceBrokerLocatorPath } = await import("../packages/create-anyam/src/workspace-broker.ts");
    const locator = JSON.parse(await readFile(workspaceBrokerLocatorPath(f.manager.statePathname, selected.id), "utf8")) as { endpoint: string };
    const asked = WORKSPACE_BOUNDARY_POLICY.maxOutputBytes + 1;
    const { response, socket } = await new Promise<{ response: Json; socket: ReturnType<typeof createConnection> }>((resolveResponse, reject) => {
      const chunks: Buffer[] = [];
      // Keep the caller's writing half open. The broker must close its own
      // descriptor after returning the denial instead of relying on caller FIN.
      const socket = createConnection({ path: locator.endpoint, allowHalfOpen: true }, () => socket.write(Buffer.alloc(asked, " ")));
      socket.on("data", chunk => chunks.push(chunk)); socket.once("error", reject);
      socket.once("close", () => reject(new Error("fixture connection closed before a budget receipt")));
      socket.once("end", () => { try { resolveResponse({ response: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json, socket }); } catch (error) { socket.destroy(); reject(error); } });
    });
    try {
      await new Promise<void>((resolveClosed, reject) => {
        let done = false;
        const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolveClosed(); };
        const observe = (error: NodeJS.ErrnoException) => finish(error.code === "EPIPE" || error.code === "ECONNRESET" ? undefined : error);
        // A first write can enter the local buffer before peer closure arrives.
        // Observe eventual peer closure within the inherited fixture deadline.
        const timer = setTimeout(() => finish(new Error("broker retained the rejected connection")), LOCAL_ACTION_POLICY.timeoutMs);
        socket.once("error", observe);
        const probe = () => { if (!done) socket.write("caller-still-open", error => { if (error) observe(error); else setImmediate(probe); }); };
        probe();
      });
    } finally { socket.destroy(); }
    const error = response.error as Json;
    assert.equal(error.code, "workspace.broker.request_budget");
    assert.match(String(error.message), /budget=workspace-broker\.request/u);
    assert.match(String(error.message), new RegExp(`limit=${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes}bytes; asked=${asked}bytes`, "u"));
    assert.ok(String(error.message).includes(WORKSPACE_BOUNDARY_POLICY.receipt));
    assert.equal(JSON.parse((await f.execute(selected.id, "process.stdout.write('budget-recovery')")).stdout).command.stdout, "budget-recovery");
  } finally { await f.cleanup(); }
});

test("revoked and expired sessions cannot execute through a still-live broker", platform, async () => {
  const f = await fixture();
  try {
    const revoked = await f.open().session(); const expired = await f.open().session(); const grantExpired = await f.open().session(); const peer = await f.open().session();
    await f.manager.revoke(revoked.id);
    const path = localAgentStatePath(f.directory, f.stateDirectory); const state = JSON.parse(await readFile(path, "utf8")) as { sessions: Record<string, LocalAgentSession>; grants: Record<string, { expiresAt: string }> };
    state.sessions[expired.id]!.expiresAt = "2000-01-01T00:00:00Z"; state.grants[grantExpired.grantId]!.expiresAt = "2000-01-01T00:00:00Z"; await writeFile(path, JSON.stringify(state));
    const marker = join(f.root, "unstarted-workload"); const workload = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`;
    await assert.rejects(f.execute(revoked.id, workload)); await assert.rejects(f.execute(expired.id, workload)); await assert.rejects(f.execute(grantExpired.id, workload)); await assert.rejects(access(marker));
    const { workspaceBrokerLocatorPath } = await import("../packages/create-anyam/src/workspace-broker.ts");
    for (const selected of [revoked, expired, grantExpired]) {
      await execFile(process.execPath, ["--import", "tsx", entrypoint, "agent", "revoke", "--session", selected.id, "--directory", f.directory, "--json"], { cwd: process.cwd(), env: f.environment });
      await assert.rejects(access(workspaceBrokerLocatorPath(f.manager.statePathname, selected.id)), "revocation cleans the selected locator even after expiry");
    }
    assert.equal(JSON.parse((await f.execute(peer.id, "process.stdout.write('peer-alive')")).stdout).command.stdout, "peer-alive");
  } finally { await f.cleanup(); }
});

test("broker death cannot restore persisted authority; explicit fresh scoped recovery works", platform, async () => {
  const f = await fixture();
  try {
    const broker = f.open(); const interrupted = await broker.session(); await broker.stop();
    const marker = join(f.root, "unstarted-after-restart");
    await assert.rejects(f.execute(interrupted.id, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`), /workspace\.broker\.unavailable/u);
    await assert.rejects(access(marker));
    const stale = f.open(interrupted.id); const denied = await stale.request("initialize");
    assert.equal(((denied.error as Json).data as Json).code, "workspace.boundary_missing");
    await execFile(process.execPath, ["--import", "tsx", entrypoint, "agent", "revoke", "--session", interrupted.id, "--directory", f.directory, "--json"], { cwd: process.cwd(), env: f.environment });
    const { workspaceBrokerLocatorPath } = await import("../packages/create-anyam/src/workspace-broker.ts");
    await assert.rejects(access(workspaceBrokerLocatorPath(f.manager.statePathname, interrupted.id)), "explicit revocation removes only that stale locator");
    const replacement = await f.open().session(); assert.notEqual(replacement.id, interrupted.id); assert.notEqual(replacement.grantId, interrupted.grantId);
    assert.equal(JSON.parse((await f.execute(replacement.id, "process.stdout.write('fresh-scoped')")).stdout).command.stdout, "fresh-scoped");
  } finally { await f.cleanup(); }
});

test("a handoff cannot overwrite process custody while the selected Workspace is executing", platform, async () => {
  const f = await fixture(); let execution: Promise<unknown> | undefined;
  try {
    const broker = f.open(); const selected = await broker.session(); const started = join(f.root, "started"); const finish = join(f.root, "finish");
    execution = f.execute(selected.id, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.stdout.write('first-command');}},20);`);
    await new Promise<void>((resolveReady, reject) => {
      const poll = setInterval(() => { void access(started).then(() => { clearInterval(poll); resolveReady(); }, error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { clearInterval(poll); reject(error); } }); }, 20);
      void execution!.catch(error => { clearInterval(poll); reject(error); });
    });
    const before = await f.manager.inspectSession(selected.id); assert.ok(before?.session.processGroupId);
    await assert.rejects(f.execute(selected.id, "process.stdout.write('must-not-start')"), /workspace\.process_active/u);
    const manifest = JSON.parse(await readFile(join(f.directory, "anyam.json"), "utf8")) as { modules: { actions: { id: string }[] }[] };
    const denied = (await broker.request("tools/call", { name: "run.start", arguments: { actionId: manifest.modules[0]!.actions[0]!.id } })).result as Json;
    assert.equal(denied.isError, true); assert.equal(((denied.structuredContent as Json).error as Json).code, "workspace.process_active");
    assert.equal((await f.manager.inspectSession(selected.id))?.session.processGroupId, before.session.processGroupId);
    await writeFile(finish, "finish"); await execution;
  } finally {
    if (execution) await f.manager.revoke((await f.manager.status()).session?.id);
    await execution?.catch(() => undefined); await f.cleanup();
  }
});
