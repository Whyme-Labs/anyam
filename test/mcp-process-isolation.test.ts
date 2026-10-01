import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";
import { localAgentStatePath, LocalAgentManager, LocalMcpBroker, type LocalAgentSession, type LocalCapabilityGrant } from "../packages/create-anyam/src/agent.ts";
import { scaffoldProject, startChange } from "../packages/create-anyam/src/scaffold.ts";

const execFile = promisify(execFileCallback);
const entrypoint = resolve("packages/create-anyam/src/anyam.ts");
const platform = { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support; Linux execution is separately unqualified" : false };
type Json = Record<string, unknown>;
type ToolResult = { isError: boolean; structuredContent: Json };
type State = { currentSessionId: string | null; sessions: Record<string, LocalAgentSession>; grants: Record<string, LocalCapabilityGrant>; runs: Record<string, Json>; findings: Record<string, Json>; audit: Json[] };

class Broker {
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = "";
  constructor(readonly fixture: Fixture, agent: string, side: string, sessionId?: string, driver?: string) {
    const args = ["--import", "tsx", driver ?? entrypoint, "mcp", "serve", "--stdio", "--agent", agent, "--directory", fixture.directory,
      ...(sessionId ? ["--session", sessionId] : ["--mode", "enforceable", "--allow-path", side, "--allow-path", "package.json", "--allow-action", `action:${side}`])];
    this.process = spawn(process.execPath, args, { cwd: process.cwd(), env: fixture.environment, stdio: "pipe" });
    this.process.stderr.on("data", chunk => { this.stderr += String(chunk); });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", line => {
      try { const response = JSON.parse(line) as Json; const id = Number(response.id); const pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(response); } }
      catch (error) { this.rejectAll(new Error(`invalid MCP output: ${String(error)}`)); }
    });
    this.process.on("error", error => this.rejectAll(error));
    this.process.on("exit", (code, signal) => this.rejectAll(new Error(`broker exited ${code}/${signal}: ${this.stderr}`)));
    fixture.brokers.push(this);
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.sequence;
    return new Promise((resolveResponse, reject) => {
      // Fixture deadline only; not a production performance/capacity claim.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP fixture timeout for ${method}: ${this.stderr}`)); }, 15_000);
      this.pending.set(id, { resolve: resolveResponse, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async call(name: string, args: Json = {}): Promise<ToolResult> { return (await this.request("tools/call", { name, arguments: args })).result as ToolResult; }
  async initialize(): Promise<void> { const response = await this.request("initialize"); assert.equal(response.error, undefined, JSON.stringify(response)); }
  async stop(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>(resolveExit => this.process.once("exit", () => resolveExit()));
    this.process.kill("SIGKILL");
    await exited;
  }
}

class Fixture {
  readonly brokers: Broker[] = [];
  constructor(readonly root: string, readonly directory: string, readonly stateDirectory: string, readonly environment: NodeJS.ProcessEnv) {}
  get statePath(): string { return localAgentStatePath(this.directory, this.stateDirectory); }
  async state(): Promise<State> { return JSON.parse(await readFile(this.statePath, "utf8")) as State; }
  async session(broker: Broker): Promise<LocalAgentSession> {
    const inspect = await broker.call("workspace.inspect");
    assert.equal(inspect.isError, false, JSON.stringify(inspect));
    const session = (await this.state()).sessions[String(inspect.structuredContent.sessionId)]; assert.ok(session); if (session.workspaceDirectory) {
      await mkdir(join(session.workspaceDirectory, ".anyam"), { recursive: true });
      await writeFile(join(session.workspaceDirectory, ".anyam/canonical-path"), join(this.directory, "a/input.txt"));
    }
    return session;
  }
  async revoke(sessionId: string): Promise<void> {
    const result = await execFile(process.execPath, ["--import", "tsx", entrypoint, "agent", "revoke", "--session", sessionId, "--directory", this.directory, "--json"], { cwd: process.cwd(), env: this.environment });
    const revoked = JSON.parse(result.stdout) as Json;
    assert.equal(revoked.status, "revoked"); assert.equal(revoked.sessionId, sessionId);
  }
  async cleanup(): Promise<void> {
    for (const broker of this.brokers) await broker.stop();
    let state: State | undefined;
    try { state = await this.state(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const failures: string[] = [];
    for (const session of Object.values(state?.sessions ?? {})) {
      if (session.status !== "revoked") { try { await this.revoke(session.id); } catch (error) { failures.push(String(error)); } }
    }
    await rm(this.root, { recursive: true, force: true });
    assert.deepEqual(failures, [], "fixture revocation/cleanup must succeed");
  }
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "anyam-process-e2e-"));
  const directory = join(root, "project"); const stateDirectory = join(root, "state");
  await scaffoldProject({ directory, name: "process-isolation", kind: "worker" });
  const environment: NodeJS.ProcessEnv = { ...process.env, ANYAM_STATE_HOME: stateDirectory };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) delete environment[key];
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8"));
  manifest.modules[0].actions = [];
  for (const side of ["a", "b"]) {
    await mkdir(join(directory, side));
    await writeFile(join(directory, side, "input.txt"), `synthetic-${side}`);
    await writeFile(join(directory, side, "action.cjs"), `const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.readFileSync('${side}/input.txt','utf8'),'synthetic-${side}');assert.throws(()=>fs.readFileSync('${side === "a" ? "b" : "a"}/input.txt'));if(fs.existsSync('.anyam/peer-path'))assert.throws(()=>fs.readFileSync(fs.readFileSync('.anyam/peer-path','utf8')));if(fs.existsSync('.anyam/canonical-path'))assert.throws(()=>fs.readFileSync(fs.readFileSync('.anyam/canonical-path','utf8')));fs.writeFileSync('.anyam/started','ready');const finish=()=>fs.writeFileSync('${side}/result.txt','result-${side}');if(fs.existsSync('.anyam/wait')){const timer=setInterval(()=>{if(fs.existsSync('.anyam/finish')){clearInterval(timer);finish()}},20)}else finish();`);
    manifest.modules[0].actions.push({ id: `action:${side}`, command: `node ${side}/action.cjs`, inputs: [`${side}/input.txt`, `${side}/action.cjs`], outputs: [`${side}/result.txt`], network: [], resources: {} });
  }
  manifest.verifiers = ["a", "b"].map(side => ({ id: `verifier:${side}`, actionId: `action:${side}`, disclosure: "full", requiredFor: ["release"] }));
  await writeFile(join(directory, "anyam.json"), JSON.stringify(manifest, null, 2));
  for (const args of [["init", "--quiet"], ["config", "user.name", "Anyam fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "--quiet", "-m", "Synthetic scoped Actions"]]) await execFile("git", args, { cwd: directory });
  await startChange(directory, "Synthetic parallel process isolation");
  return new Fixture(root, directory, stateDirectory, environment);
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) { try { await access(path); return; } catch { assert.ok(Date.now() < deadline, `fixture Action never signalled ${path}`); await new Promise<void>(r => setTimeout(r, 20)); } }
}

function assertAttribution(result: ToolResult, session: LocalAgentSession, status: string): void {
  assert.equal(result.isError, false, JSON.stringify(result));
  const run = result.structuredContent.run as Json; const evidence = result.structuredContent.evidence as Json;
  assert.equal(run.status, status, JSON.stringify(result)); assert.equal(evidence.status, status);
  assert.equal(run.actorId, session.actorId); assert.equal(run.taskId, session.taskId);
  assert.equal(evidence.actorId, session.actorId); assert.equal(evidence.grantId, session.grantId);
}

test("separate CLI MCP processes interleave scoped work without borrowing paths, Actions or attribution", platform, async () => {
  const f = await fixture();
  try {
    const a = new Broker(f, "codex", "a"); await a.initialize(); const sa = await f.session(a);
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    assert.notEqual(a.process.pid, b.process.pid); assert.notEqual(sa.id, sb.id); assert.notEqual(sa.workspaceDirectory, sb.workspaceDirectory);
    assert.equal(sa.workspaceEnforcement, "macos-sandbox-exec"); assert.equal(sb.workspaceEnforcement, "macos-sandbox-exec");
    await assert.rejects(access(join(sa.workspaceDirectory!, "b/input.txt"))); await assert.rejects(access(join(sb.workspaceDirectory!, "a/input.txt")));
    await writeFile(join(sa.workspaceDirectory!, ".anyam/peer-path"), join(sb.workspaceDirectory!, "b/input.txt"));
    const deniedA = await a.call("run.start", { actionId: "action:b" }); const deniedB = await b.call("run.start", { actionId: "action:a" });
    assert.equal(deniedA.isError, true); assert.equal(deniedB.isError, true);
    assert.equal((deniedA.structuredContent.error as Json).code, "run.action_denied");
    assert.equal((deniedB.structuredContent.error as Json).code, "run.action_denied");
    const scopedState = await f.state();
    assert.deepEqual(scopedState.grants[sa.grantId]!.authorizedActionIds, ["action:a"]);
    assert.deepEqual(scopedState.grants[sb.grantId]!.authorizedActionIds, ["action:b"]);
    assert.equal(Object.keys(scopedState.runs).length, 0, "denied Actions must not execute or create Runs");
    const runs = await Promise.all([a.call("run.start", { actionId: "action:a" }), b.call("run.start", { actionId: "action:b" })]);
    assertAttribution(runs[0]!, sa, "passed"); assertAttribution(runs[1]!, sb, "passed");
    const findings = await Promise.all([a.call("review.submit_finding", { severity: "info", summary: "A finding", details: "synthetic A" }), b.call("review.submit_finding", { severity: "info", summary: "B finding", details: "synthetic B" })]);
    assert.equal((findings[0]!.structuredContent.finding as Json).actorId, sa.actorId); assert.equal((findings[1]!.structuredContent.finding as Json).actorId, sb.actorId);
    const state = await f.state(); assert.equal(state.sessions[sa.id]!.status, "active"); assert.equal(state.sessions[sb.id]!.status, "active");
    const events = state.audit.filter(event => event.operation === "run.completed");
    assert.ok(events.some(event => event.sessionId === sa.id && event.actorId === sa.actorId && event.grantId === sa.grantId));
    assert.ok(events.some(event => event.sessionId === sb.id && event.actorId === sb.actorId && event.grantId === sb.grantId));
    assert.equal((await execFile("git", ["status", "--porcelain"], { cwd: f.directory })).stdout, "");
  } finally { await f.cleanup(); }
});

test("cross-process revocation blocks an in-flight scoped Action while the peer broker remains usable", platform, async () => {
  const f = await fixture();
  try {
    const a = new Broker(f, "codex", "a"); await a.initialize(); const sa = await f.session(a);
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    await writeFile(join(sa.workspaceDirectory!, ".anyam/wait"), "fixture barrier");
    const running = a.call("run.start", { actionId: "action:a" }); await waitFor(join(sa.workspaceDirectory!, ".anyam/started"));
    await f.revoke(sa.id); const completed = await running; assertAttribution(completed, sa, "blocked");
    assert.match(String((completed.structuredContent.evidence as Json).receipt), /session-revoked-during-run/);
    assert.equal((await a.call("workspace.inspect")).isError, true);
    assertAttribution(await b.call("run.start", { actionId: "action:b" }), sb, "passed");
    await assert.rejects(access(sa.workspaceDirectory!));
  } finally { await f.cleanup(); }
});

test("completion revalidates fixture expiry across CLI broker processes without expiring the peer", platform, async () => {
  const f = await fixture();
  try {
    const a = new Broker(f, "codex", "a"); await a.initialize(); const sa = await f.session(a);
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    await writeFile(join(sa.workspaceDirectory!, ".anyam/wait"), "fixture barrier");
    const running = a.call("run.start", { actionId: "action:a" }); await waitFor(join(sa.workspaceDirectory!, ".anyam/started"));
    // Owner-controlled isolated fixture only: establish past expiry behind an
    // Action barrier. No production expiry policy or credentials are changed.
    const state = await f.state(); state.sessions[sa.id]!.expiresAt = "2000-01-01T00:00:00.000Z"; state.grants[sa.grantId]!.expiresAt = "2000-01-01T00:00:00.000Z";
    const temporary = `${f.statePath}.fixture`; await writeFile(temporary, JSON.stringify(state)); await rename(temporary, f.statePath);
    await writeFile(join(sa.workspaceDirectory!, ".anyam/finish"), "finish");
    const completed = await running; assertAttribution(completed, sa, "blocked");
    assert.match(String((completed.structuredContent.evidence as Json).receipt), /session-expired-during-run/);
    assert.equal((await a.call("workspace.inspect")).isError, true);
    assertAttribution(await b.call("run.start", { actionId: "action:b" }), sb, "passed");
    assert.equal((await f.state()).sessions[sb.id]!.status, "active");
  } finally { await f.cleanup(); }
});

test("interrupted broker restart fails closed for the old boundary and starts fresh only with explicit scopes", platform, async () => {
  const f = await fixture();
  try {
    const a = new Broker(f, "codex", "a"); await a.initialize(); const sa = await f.session(a);
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    await writeFile(join(sa.workspaceDirectory!, ".anyam/wait"), "fixture barrier");
    const interrupted = a.call("run.start", { actionId: "action:a" });
    const interruptedOutcome = interrupted.then(() => ({ interrupted: false }), error => ({ interrupted: /broker exited/.test(String(error)) }));
    await waitFor(join(sa.workspaceDirectory!, ".anyam/started"));
    const registrationDeadline = Date.now() + 10_000;
    while (!(await f.state()).sessions[sa.id]!.processGroupId) {
      assert.ok(Date.now() < registrationDeadline, "fixture runner process group was not persisted");
      await new Promise<void>(r => setTimeout(r, 20));
    }
    await a.stop();
    assert.equal((await interruptedOutcome).interrupted, true);
    const restarted = new Broker(f, "codex", "a", sa.id);
    const denied = await restarted.request("initialize"); assert.ok(denied.error, "restart must not borrow B or recreate A's lost boundary");
    assert.equal(((denied.error as Json).data as Json).code, "workspace.boundary_missing");
    assert.equal((await restarted.call("workspace.inspect")).isError, true);
    const before = await f.state(); assert.equal(Object.keys(before.sessions).length, 2);
    await f.revoke(sa.id);
    assert.equal(Object.values((await f.state()).runs).some(run => run.actorId === sa.actorId && run.status === "passed"), false, "interruption must not synthesize passed Evidence");
    const replacement = new Broker(f, "codex", "a"); await replacement.initialize(); const replacementSession = await f.session(replacement);
    assert.notEqual(replacementSession.id, sa.id); assert.notEqual(replacementSession.workspaceDirectory, sa.workspaceDirectory);
    assertAttribution(await replacement.call("run.start", { actionId: "action:a" }), replacementSession, "passed");
    assertAttribution(await b.call("run.start", { actionId: "action:b" }), sb, "passed");
  } finally { await f.cleanup(); }
});

async function groupMembers(groupId: number): Promise<number[]> {
  const listing = await execFile("ps", ["-axo", "pid=,pgid="]);
  return listing.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === groupId).map(([pid]) => pid!);
}

async function cleanupFixtureGroup(groupId: number, workspace: string): Promise<void> {
  // No broad process search or unvalidated group signal: verify each remaining
  // member's group and exact disposable cwd immediately before signalling it.
  for (const pid of await groupMembers(groupId)) {
    let cwd: string;
    try { cwd = (await execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).stdout; }
    catch { continue; }
    assert.ok(cwd.split("\n").includes(`n${workspace}`), `refuse cleanup of process ${pid} outside fixture Workspace`);
    if (!(await groupMembers(groupId)).includes(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function registrationFaultDriver(f: Fixture): Promise<{ driver: string; spawnedPath: string }> {
    const driver = join(f.root, "registration-fault.mts");
    const spawnedPath = join(f.root, "spawned.json");
    await writeFile(driver, `import {writeFileSync} from 'node:fs';
import {LocalAgentManager,runMcpStdio} from ${JSON.stringify(new URL("../packages/create-anyam/src/agent.ts", import.meta.url).href)};
class FaultManager extends LocalAgentManager {
  async registerWorkspaceProcess(sessionId, child) {
    writeFileSync(${JSON.stringify(spawnedPath)}, JSON.stringify({sessionId,pid:child.pid}));
    process.kill(process.pid,'SIGSTOP');
    return super.registerWorkspaceProcess(sessionId,child);
  }
}
await runMcpStdio({manager:new FaultManager({directory:${JSON.stringify(f.directory)},stateDirectory:${JSON.stringify(f.stateDirectory)}}),directory:${JSON.stringify(f.directory)},agent:'codex',sessionOptions:{mode:'enforceable',authorizedPaths:['a','package.json'],authorizedActionIds:['action:a']},input:process.stdin,output:process.stdout});
`);
    return { driver, spawnedPath };
}

test("broker death before durable registration leaves no live process and restart remains fail closed", platform, async () => {
  const f = await fixture();
  let groupId: number | undefined; let workspace: string | undefined;
  try {
    const { driver, spawnedPath } = await registrationFaultDriver(f);
    const a = new Broker(f, "codex", "a", undefined, driver); await a.initialize(); const sa = await f.session(a); workspace = sa.workspaceDirectory!;
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    await writeFile(join(workspace, ".anyam/wait"), "fixture barrier");
    const running = a.call("run.start", { actionId: "action:a" });
    const outcome = running.then(() => false, error => /broker exited/.test(String(error)));
    await waitFor(spawnedPath);
    const spawned = JSON.parse(await readFile(spawnedPath, "utf8")) as { sessionId: string; pid: number };
    assert.equal(spawned.sessionId, sa.id); groupId = spawned.pid;
    assert.equal((await f.state()).sessions[sa.id]!.processGroupId, undefined, "fault must occur before durable registration");
    await a.stop(); assert.equal(await outcome, true);
    const deadline = Date.now() + 2_000; // Isolated cleanup assertion deadline.
    while ((await groupMembers(groupId)).length && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 20));
    assert.deepEqual(await groupMembers(groupId), [], "spawned group survived broker death before durable registration");
    const restarted = new Broker(f, "codex", "a", sa.id);
    const denied = await restarted.request("initialize");
    assert.equal(((denied.error as Json).data as Json).code, "workspace.boundary_missing");
    await f.revoke(sa.id);
    assert.equal(Object.values((await f.state()).runs).some(run => run.actorId === sa.actorId && run.status === "passed"), false);
    const fresh = new Broker(f, "codex", "a"); await fresh.initialize(); const replacement = await f.session(fresh);
    assert.notEqual(replacement.id, sa.id);
    assertAttribution(await fresh.call("run.start", { actionId: "action:a" }), replacement, "passed");
    assertAttribution(await b.call("run.start", { actionId: "action:b" }), sb, "passed");
  } finally {
    for (const broker of f.brokers) await broker.stop();
    if (groupId && workspace) await cleanupFixtureGroup(groupId, workspace);
    await f.cleanup();
  }
});

test("revocation before durable registration refuses command release and leaves its peer usable", platform, async () => {
  const f = await fixture();
  let groupId: number | undefined; let workspace: string | undefined;
  try {
    const { driver, spawnedPath } = await registrationFaultDriver(f);
    const a = new Broker(f, "codex", "a", undefined, driver); await a.initialize(); const sa = await f.session(a); workspace = sa.workspaceDirectory!;
    const b = new Broker(f, "claude", "b"); await b.initialize(); const sb = await f.session(b);
    const running = a.call("run.start", { actionId: "action:a" });
    await waitFor(spawnedPath); groupId = (JSON.parse(await readFile(spawnedPath, "utf8")) as { pid: number }).pid;
    assert.equal((await f.state()).sessions[sa.id]!.processGroupId, undefined);
    await assert.rejects(access(join(workspace, ".anyam/started")), "workload must wait for durable registration");
    await f.revoke(sa.id);
    a.process.kill("SIGCONT"); // Resume only this known fixture-owned broker.
    assert.equal((await running).isError, true, "revoked registration cannot release the command");
    assert.equal((await f.state()).sessions[sa.id]!.processGroupId, undefined, "revocation cannot acquire a stale process registration");
    assert.deepEqual(await groupMembers(groupId), []);
    assert.equal(Object.values((await f.state()).runs).some(run => run.actorId === sa.actorId && run.status === "passed"), false);
    assertAttribution(await b.call("run.start", { actionId: "action:b" }), sb, "passed");
  } finally {
    for (const broker of f.brokers) await broker.stop();
    if (groupId && workspace) await cleanupFixtureGroup(groupId, workspace);
    await f.cleanup();
  }
});


test("CLI MCP refuses incomplete or conflicting scope arguments before creating a session", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["--session"],
      ["--allow-action"],
      ["--allow-path", "--agent", "codex"],
      ["--mode", "supervised", "--allow-path", "a"],
      ["--session", "fixture-session", "--mode", "enforceable"],
    ]) {
      await assert.rejects(execFile(process.execPath, ["--import", "tsx", entrypoint, "mcp", "serve", "--stdio", "--directory", f.directory, ...args], { cwd: process.cwd(), env: f.environment }), /explicit value|require.*enforceable|cannot be combined/);
    }
    await assert.rejects(access(f.statePath));
  } finally { await f.cleanup(); }
});


test("CLI revoke selects the named session and keeps its peer active", async () => {
  const f = await fixture();
  try {
    const manager = new LocalAgentManager({ directory: f.directory, stateDirectory: f.stateDirectory });
    const first = await manager.startSession({ agent: "codex" });
    const peer = await manager.startSession({ agent: "claude", parallel: true });
    await f.revoke(first.session.id);
    const state = await f.state();
    assert.equal(state.sessions[first.session.id]!.status, "revoked");
    assert.equal(state.sessions[peer.session.id]!.status, "active");
    assert.equal(state.currentSessionId, peer.session.id);
  } finally { await f.cleanup(); }
});

test("manager reuse rejects a differing explicit Action scope without returning a wider Grant", async () => {
  const f = await fixture();
  try {
    const manager = new LocalAgentManager({ directory: f.directory, stateDirectory: f.stateDirectory });
    const original = await manager.startSession({ agent: "codex" });
    assert.deepEqual(original.grant.authorizedActionIds, ["action:a", "action:b"]);
    await assert.rejects(manager.startSession({ agent: "codex", authorizedActionIds: ["action:a"] }), /scope.*cannot be reused/);
    assert.equal(Object.keys((await f.state()).sessions).length, 1);
    const reused = await manager.startSession({ agent: "codex", authorizedActionIds: ["action:b", "action:a", "action:a"] });
    assert.equal(reused.session.id, original.session.id);
    const fresh = await manager.startSession({ agent: "codex", authorizedActionIds: ["action:a"], parallel: true });
    assert.notEqual(fresh.session.id, original.session.id);
    assert.deepEqual(fresh.grant.authorizedActionIds, ["action:a"]);
    await f.revoke(fresh.session.id);
    await f.revoke(original.session.id);
    const restricted = await manager.startSession({ agent: "codex", authorizedActionIds: ["action:a"] });
    assert.equal((await manager.startSession({ agent: "codex" })).session.id, restricted.session.id);
    await assert.rejects(manager.startSession({ agent: "codex", authorizedActionIds: ["action:a", "action:b"] }), /scope.*cannot be reused/);
    await assert.rejects(manager.invokeTool("run.start", { actionId: "action:b" }, restricted.session.id), /outside this session's granted scope/);
    assert.equal(Object.keys((await f.state()).runs).length, 0);
    await assert.rejects(manager.startSession({ agent: "codex", mode: "enforceable" }), /cannot be reused/);
    // Legacy metadata cannot prove an explicit scope matches live authority.
    const legacy = await f.state(); delete legacy.grants[restricted.grant.id]!.authorizedActionIds;
    await writeFile(f.statePath, JSON.stringify(legacy));
    await assert.rejects(manager.startSession({ agent: "codex", authorizedActionIds: ["action:a"] }), /scope.*cannot be reused/);
  } finally { await f.cleanup(); }
});

test("manager reuse requires matching explicit Workspace scope options", platform, async () => {
  const f = await fixture();
  try {
    const manager = new LocalAgentManager({ directory: f.directory, stateDirectory: f.stateDirectory });
    const original = await manager.startSession({ agent: "codex", mode: "enforceable", authorizedPaths: ["a", "package.json"], network: [] });
    const reused = await manager.startSession({ agent: "codex", mode: "enforceable", authorizedPaths: ["package.json", "a", "a"], network: [] });
    assert.equal(reused.session.id, original.session.id);
    for (const options of [{ authorizedPaths: ["b"] }, { authorizedPaths: [] }, { network: ["example.invalid"] }, { executablePaths: ["/bin/sh"] }, { workspaceDirectory: join(f.root, "other") }]) {
      await assert.rejects(manager.startSession({ agent: "codex", mode: "enforceable", ...options }), /scope.*cannot be reused/);
    }
    assert.equal(Object.keys((await f.state()).sessions).length, 1);
    await assert.rejects(access(join(original.session.workspaceDirectory!, "b/input.txt")));
    const legacy = await f.state(); delete legacy.sessions[original.session.id]!.workspaceScope;
    await writeFile(f.statePath, JSON.stringify(legacy));
    await assert.rejects(manager.startSession({ agent: "codex", mode: "enforceable", authorizedPaths: ["a", "package.json"] }), /scope.*cannot be reused/);
  } finally { await f.cleanup(); }
});

test("concurrent initialization and implicit calls create only one fresh scoped binding", async () => {
  const f = await fixture();
  try {
    const manager = new LocalAgentManager({ directory: f.directory, stateDirectory: f.stateDirectory });
    const broker = new LocalMcpBroker({ manager, agent: "codex", sessionOptions: { mode: "supervised", authorizedActionIds: ["action:a"] } });
    const responses = await Promise.all([
      broker.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      broker.handle({ jsonrpc: "2.0", id: 2, method: "initialize" }),
      broker.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace.inspect" } }),
    ]);
    assert.equal(responses[0]?.error, undefined);
    assert.equal((responses[1]?.error as Json).code, -32600);
    assert.equal((responses[2]?.result as ToolResult).isError, false);
    const state = await f.state();
    assert.equal(Object.keys(state.sessions).length, 1);
    const session = Object.values(state.sessions)[0]!;
    assert.deepEqual(state.grants[session.grantId]!.authorizedActionIds, ["action:a"]);
  } finally { await f.cleanup(); }
});
