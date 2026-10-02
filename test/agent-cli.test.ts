import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import {
  gitCredentialGet,
  LocalAgentError,
  LocalAgentManager,
  LOCAL_AGENT_POLICY,
  localAgentStatePath,
  LocalMcpBroker,
  readGitCredentialContext,
  setupAgent,
  type LocalAgentManagerOptions,
} from "../packages/create-anyam/src/agent.ts";
import { main } from "../packages/create-anyam/src/cli.ts";
import { inspectGitSource } from "../packages/create-anyam/src/git-source.ts";
import { scaffoldProject, startChange } from "../packages/create-anyam/src/scaffold.ts";

const execFile = promisify(execFileCallback);

function agentStateDirectory(directory: string): string {
  return join(directory, "..", "agent-state");
}

function manager(directory: string, options: Omit<LocalAgentManagerOptions, "directory" | "stateDirectory"> = {}): LocalAgentManager {
  return new LocalAgentManager({ ...options, directory, stateDirectory: agentStateDirectory(directory) });
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd: directory, encoding: "utf8" });
  return result.stdout.trim();
}

async function seedGit(directory: string): Promise<void> {
  await git(directory, ["config", "user.email", "test@anyam.dev"]);
  await git(directory, ["config", "user.name", "Anyam Test"]);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "--quiet", "-m", "Initial project"]);
}

async function projectDirectory(options: { startChange?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anyam-agent-"));
  const directory = join(root, "demo");
  await scaffoldProject({ directory, name: "demo", kind: "worker" });
  await seedGit(directory);
  if (options.startChange !== false) await startChange(directory, "Add the first agent change");
  return directory;
}

async function replaceCheckAction(directory: string, action: Record<string, unknown>): Promise<void> {
  const path = join(directory, "anyam.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as { modules: Array<{ actions: Array<Record<string, unknown>> }> };
  manifest.modules[0]!.actions[0] = { ...manifest.modules[0]!.actions[0], ...action };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await git(directory, ["add", "anyam.json"]);
  await git(directory, ["commit", "--quiet", "-m", "Update declared Action"]);
}

test("agent setup writes portable instructions and stdio configuration without secrets", async () => {
  const directory = await projectDirectory();
  const result = await setupAgent({ directory, agent: "codex" });

  assert.equal(result.canonicalWrite, false);
  assert.equal(result.credentialStorage, "memory-only");
  assert.equal(result.broker.transport, "stdio");
  assert.match(await readFile(join(directory, ".anyam", "agents", "AGENTS.md"), "utf8"), /^# Anyam local agent contract/);
  assert.match(await readFile(join(directory, ".anyam", "agents", "skills", "anyam-change", "SKILL.md"), "utf8"), /name: anyam-change/);
  assert.match(await readFile(join(directory, ".codex", "config.toml"), "utf8"), /mcp_servers\.anyam/);
  const setupManifest = await readFile(join(directory, ".anyam", "agents", "manifest.json"), "utf8");
  assert.doesNotMatch(setupManifest, /token|secret|password/i);
  assert.equal((await setupAgent({ directory, agent: "codex" })).files.includes(".anyam/agents/manifest.json"), false);
});

test("CLI auth login requires explicit Realm and client identity before opening OAuth", async () => {
  await assert.rejects(() => main(["auth", "login"], process.cwd()), /auth login requires --realm/);
});

test("CLI documents the hosted Intent lifecycle without implying local credential storage", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map((value) => String(value)).join(" "));
  try {
    assert.equal(await main(["--help"], process.cwd()), 0);
  } finally {
    console.log = originalLog;
  }
  const help = output.join("\n");
  assert.match(help, /intent list\|inspect\|create\|assign\|comment\|close\|reopen/);
  assert.match(help, /pr list\|inspect\|open\|update\|review\|close\|reopen\|block\|merge/);
  assert.match(help, /--owner-session or ANYAM_OWNER_SESSION/);
  assert.match(help, /never stores bearer credentials/);
});

test("local agent session is bound to one Change Workspace and revocation invalidates credentials", async () => {
  const directory = await projectDirectory();
  let clock = Date.parse("2026-08-03T00:00:00.000Z");
  const agentManager = manager(directory, { now: () => new Date(clock), credentialLifetimeMs: 5_000, sessionLifetimeMs: 60_000 });
  const started = await agentManager.startSession({ agent: "codex" });
  const credential = await agentManager.issueWorkspaceCredential();
  assert.equal(credential.canonicalWrite, false);
  assert.deepEqual(await agentManager.validateWorkspaceCredential(credential), { valid: true, sessionId: started.session.id, workspaceId: started.session.workspaceId });
  clock += 6_000;
  assert.deepEqual(await agentManager.validateWorkspaceCredential(credential), { valid: false, code: "credential.expired" });
  const nextCredential = await agentManager.issueWorkspaceCredential();
  const revoked = await agentManager.revoke();
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(await agentManager.validateWorkspaceCredential(nextCredential), { valid: false, code: "credential.session_inactive" });
  await assert.rejects(agentManager.invokeTool("repository.write"), (error: unknown) => error instanceof LocalAgentError && error.code === "agent.session.missing");
});

test("concurrent local Workspaces are explicit and revoking one leaves the other active", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory, { sessionLifetimeMs: 60_000 });
  const first = await agentManager.startSession({ agent: "codex" });
  const second = await agentManager.startSession({ agent: "claude", parallel: true });
  assert.notEqual(first.session.id, second.session.id);
  const listed = await agentManager.listSessions();
  assert.deepEqual(new Set(listed.map((item) => item.session.id)), new Set([first.session.id, second.session.id]));
  assert.equal((await agentManager.status(first.session.id)).session?.id, first.session.id);
  assert.equal((await agentManager.status(second.session.id)).session?.id, second.session.id);
  assert.equal((await agentManager.revoke(first.session.id)).status, "revoked");
  assert.equal((await agentManager.status(second.session.id)).session?.id, second.session.id);
  assert.equal((await agentManager.status(first.session.id)).session, null);
});

test("MCP exposes semantic Change tools and keeps canonical writes outside the broker", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory, { credentialLifetimeMs: 10_000, sessionLifetimeMs: 60_000 });
  const broker = new LocalMcpBroker({ manager: agentManager, agent: "claude" });
  const initialized = await broker.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal((initialized?.result as { serverInfo?: { name?: string } }).serverInfo?.name, "anyam");
  const listed = await broker.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = ((listed?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
  assert.ok(names.includes("change.publish_revision"));
  assert.equal(names.includes("repository.write"), false);
  assert.equal(names.includes("secret.read"), false);
  const project = await broker.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project.inspect", arguments: {} } });
  assert.equal((project?.result as { isError?: boolean }).isError, false);
  const denied = await broker.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "target.promote:production", arguments: {} } });
  assert.equal((denied?.result as { isError?: boolean }).isError, true);
  const revision = await broker.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "change.publish_revision", arguments: { declaredEffects: ["source.modify"] } } });
  const revisionResult = (revision?.result as { structuredContent?: { canonicalWrite?: boolean; revision?: Record<string, unknown> } }).structuredContent;
  assert.equal(revisionResult?.canonicalWrite, false);
  assert.equal(revisionResult?.revision?.sourceKind, "git");
  assert.match(String(revisionResult?.revision?.sourceRevision), /^git:commit:[0-9a-f]{40,64}$/);
  assert.match(String(revisionResult?.revision?.baseProjectRevisionId), /^git:project-revision:[0-9a-f]{40,64}$/);
  assert.match(String(revisionResult?.revision?.treeDigest), /^git-tree:[0-9a-f]{40,64}$/);
  assert.match(String(revisionResult?.revision?.gitRef), /^refs\/heads\//);
  assert.ok(revisionResult?.revision?.gitObjectFormat === "sha1" || revisionResult?.revision?.gitObjectFormat === "sha256");
  await access(join(directory, ".anyam", "change.json"));
});

async function brokerCall(broker: LocalMcpBroker, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; structuredContent: Record<string, unknown> }> {
  const response = await broker.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.ok(response);
  return response.result as { isError: boolean; structuredContent: Record<string, unknown> };
}

async function waitForActionFile(directory: string, filename: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await access(join(directory, ".anyam", filename));
      return;
    } catch {
      assert.ok(Date.now() < deadline, "fixture Action did not signal startup");
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
}

test("interleaved MCP brokers retain their initialized session, context, finding actor, and audit identity", async () => {
  const directory = await projectDirectory();
  try {
    const agentManager = manager(directory);
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = await agentManager.status();
    assert.ok(first.session);
    const second = await agentManager.startSession({ agent: "claude", parallel: true });
    const claude = new LocalMcpBroker({ manager: agentManager, agent: "claude" });
    await claude.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });

    for (const [broker, session] of [[codex, first.session], [claude, second.session], [codex, first.session]] as const) {
      const inspected = await brokerCall(broker, "workspace.inspect", { sessionId: second.session.id });
      assert.equal(inspected.isError, false);
      assert.equal(inspected.structuredContent.sessionId, session.id);
      assert.equal(inspected.structuredContent.contextId, `context:${session.id}`);
      const result = await brokerCall(broker, "review.submit_finding", { severity: "warning", summary: session.agent });
      assert.equal(result.isError, false);
      assert.equal((result.structuredContent.finding as Record<string, unknown>).actorId, session.actorId);
    }
    const state = JSON.parse(await readFile(agentManager.statePathname, "utf8")) as { audit: Array<{ operation: string; sessionId: string; actorId: string; grantId: string; taskId: string; details: { tool?: string } }> };
    const findings = state.audit.filter((event) => event.operation === "tool.invoked" && event.details.tool === "review.submit_finding");
    assert.deepEqual(findings.map((event) => [event.sessionId, event.actorId, event.grantId, event.taskId]), [first.session, second.session, first.session].map((session) => [session.id, session.actorId, session.grantId, session.taskId]));
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("a revoked MCP broker cannot use another active session for inspection or mutations", async () => {
  const directory = await projectDirectory();
  try {
    const agentManager = manager(directory);
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = (await agentManager.status()).session;
    assert.ok(first);
    const second = await agentManager.startSession({ agent: "claude", parallel: true });
    const claude = new LocalMcpBroker({ manager: agentManager, agent: "claude" });
    await claude.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });
    await agentManager.revoke(first.id);

    for (const name of ["workspace.inspect", "review.submit_finding", "run.start", "change.publish_revision"]) {
      const denied = await brokerCall(codex, name, { severity: "warning", summary: "revoked", actionId: "action:check", declaredEffects: ["source.modify"], sessionId: second.session.id });
      assert.equal(denied.isError, true, name);
      assert.equal((denied.structuredContent.error as Record<string, unknown>).code, "agent.session.expired", name);
    }
    const allowed = await brokerCall(claude, "review.submit_finding", { severity: "info", summary: "still active" });
    assert.equal(allowed.isError, false);
    assert.equal((allowed.structuredContent.finding as Record<string, unknown>).actorId, second.session.actorId);
    const state = JSON.parse(await readFile(agentManager.statePathname, "utf8")) as { findings: Record<string, unknown>; runs: Record<string, unknown>; revisions: Record<string, unknown> };
    assert.equal(Object.keys(state.findings).length, 1);
    assert.equal(Object.keys(state.runs).length, 0);
    assert.equal(Object.keys(state.revisions).length, 0);
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("expiry of a broker-bound session does not deselect a newer active session", async () => {
  const directory = await projectDirectory();
  try {
    let clock = Date.parse("2026-08-03T00:00:00.000Z");
    const agentManager = manager(directory, { now: () => new Date(clock), sessionLifetimeMs: 60_000 });
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    clock += 30_000;
    const second = await agentManager.startSession({ agent: "claude", parallel: true });
    clock += 30_001;
    const denied = await brokerCall(codex, "workspace.inspect");
    assert.equal(denied.isError, true);
    assert.equal((denied.structuredContent.error as Record<string, unknown>).code, "agent.session.expired");
    const current = await agentManager.invokeTool("workspace.inspect");
    assert.equal(current.sessionId, second.session.id);
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("MCP run and Change publication use the bound actor after a second session starts", async () => {
  const directory = await projectDirectory();
  try {
    await replaceCheckAction(directory, { command: "node -e \"process.stdout.write('session-bound action')\"", inputs: ["anyam.json"], outputs: [] });
    const agentManager = manager(directory);
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = (await agentManager.status()).session;
    assert.ok(first);
    await agentManager.startSession({ agent: "claude", parallel: true });
    const executed = await brokerCall(codex, "run.start", { actionId: "action:check" });
    assert.equal(executed.isError, false);
    const run = executed.structuredContent.run as Record<string, unknown>;
    const evidence = executed.structuredContent.evidence as Record<string, unknown>;
    assert.equal(run.status, "passed");
    assert.equal(run.actorId, first.actorId);
    assert.equal(run.taskId, first.taskId);
    assert.equal(evidence.actorId, first.actorId);
    assert.equal(evidence.grantId, first.grantId);
    const published = await brokerCall(codex, "change.publish_revision", { declaredEffects: ["source.modify"] });
    assert.equal(published.isError, false);
    const state = JSON.parse(await readFile(agentManager.statePathname, "utf8")) as { audit: Array<{ operation: string; sessionId: string; actorId: string }> };
    assert.ok(state.audit.some((event) => event.operation === "tool.invoked" && event.sessionId === first.id));
    assert.ok(state.audit.filter((event) => event.operation === "tool.invoked" || event.operation === "run.completed").every((event) => event.sessionId === first.id && event.actorId === first.actorId));
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("revoking a broker during its Action keeps blocked Evidence bound to it and leaves the other broker active", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  let sessionId: string | undefined;
  try {
    await replaceCheckAction(directory, { command: "node -e \"require('node:fs').writeFileSync('.anyam/action-started', 'ready'); setTimeout(() => {}, 10000)\"", inputs: ["anyam.json"], outputs: [] });
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = (await agentManager.status()).session;
    assert.ok(first);
    sessionId = first.id;
    const running = brokerCall(codex, "run.start", { actionId: "action:check" });
    await waitForActionFile(directory, "action-started");
    const second = await agentManager.startSession({ agent: "claude", parallel: true });
    const claude = new LocalMcpBroker({ manager: agentManager, agent: "claude" });
    await claude.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });
    await agentManager.revoke(first.id);
    const completed = await running;
    assert.equal(completed.isError, false);
    const run = completed.structuredContent.run as Record<string, unknown>;
    const evidence = completed.structuredContent.evidence as Record<string, unknown>;
    assert.equal(run.status, "blocked");
    assert.equal(run.actorId, first.actorId);
    assert.equal(run.taskId, first.taskId);
    assert.equal(evidence.status, "blocked");
    assert.equal(evidence.actorId, first.actorId);
    assert.equal(evidence.grantId, first.grantId);
    const allowed = await brokerCall(claude, "workspace.inspect");
    assert.equal(allowed.isError, false);
    assert.equal(allowed.structuredContent.sessionId, second.session.id);
  } finally {
    if (sessionId) await agentManager.revoke(sessionId);
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("a revoked MCP broker cannot reinitialize into a newer session of the same agent", async () => {
  const directory = await projectDirectory();
  try {
    const agentManager = manager(directory);
    const firstBroker = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await firstBroker.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = (await agentManager.status()).session;
    assert.ok(first);
    const second = await agentManager.startSession({ agent: "codex", parallel: true });
    const secondBroker = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await secondBroker.handle({ jsonrpc: "2.0", id: 2, method: "initialize" });
    await agentManager.revoke(first.id);
    const initializedAgain = await firstBroker.handle({ jsonrpc: "2.0", id: 3, method: "initialize" });
    assert.equal((initializedAgain?.error as Record<string, unknown> | undefined)?.code, -32600);
    const denied = await brokerCall(firstBroker, "workspace.inspect");
    assert.equal(denied.isError, true);
    const allowed = await brokerCall(secondBroker, "workspace.inspect");
    assert.equal(allowed.isError, false);
    assert.equal(allowed.structuredContent.sessionId, second.session.id);
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("an Action completing after its bound session expires records blocked Evidence without expiring a newer session", async () => {
  const directory = await projectDirectory();
  let clock = Date.parse("2026-08-03T00:00:00.000Z");
  const agentManager = manager(directory, { now: () => new Date(clock), sessionLifetimeMs: 60_000 });
  let sessionId: string | undefined;
  try {
    await replaceCheckAction(directory, { command: "node -e \"const fs=require('node:fs');fs.writeFileSync('.anyam/action-started','ready');const timer=setInterval(()=>{if(fs.existsSync('.anyam/action-finish'))clearInterval(timer)},20)\"", inputs: ["anyam.json"], outputs: [] });
    const codex = new LocalMcpBroker({ manager: agentManager, agent: "codex" });
    await codex.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const first = (await agentManager.status()).session;
    assert.ok(first);
    sessionId = first.id;
    const running = brokerCall(codex, "run.start", { actionId: "action:check" });
    await waitForActionFile(directory, "action-started");
    clock += 30_000;
    const second = await agentManager.startSession({ agent: "claude", parallel: true });
    clock += 30_001;
    await writeFile(join(directory, ".anyam", "action-finish"), "finish");
    const completed = await running;
    assert.equal(completed.isError, false);
    const run = completed.structuredContent.run as Record<string, unknown>;
    const evidence = completed.structuredContent.evidence as Record<string, unknown>;
    assert.equal(run.status, "blocked");
    assert.equal(run.actorId, first.actorId);
    assert.equal(run.taskId, first.taskId);
    assert.equal(evidence.status, "blocked");
    assert.equal(evidence.actorId, first.actorId);
    assert.equal(evidence.grantId, first.grantId);
    assert.match(String(evidence.receipt), /session-expired-during-run/);
    assert.ok(Date.parse(String(run.completedAt)) > Date.parse(first.expiresAt));
    const state = JSON.parse(await readFile(agentManager.statePathname, "utf8")) as { sessions: Record<string, { status: string }>; grants: Record<string, { status: string }> };
    assert.equal(state.sessions[first.id]?.status, "expired");
    assert.equal(state.grants[first.grantId]?.status, "expired");
    assert.equal((await agentManager.invokeTool("workspace.inspect")).sessionId, second.session.id);
    assert.equal((await brokerCall(codex, "workspace.inspect")).isError, true);
  } finally {
    if (sessionId) await agentManager.revoke(sessionId);
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("Change revisions use stable Git identities and reject dirty source", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory, { credentialLifetimeMs: 10_000, sessionLifetimeMs: 60_000 });
  await agentManager.startSession({ agent: "codex" });

  const first = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const firstRevision = first.revision as { sourceRevision: string; treeDigest: string };
  const repeated = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const repeatedRevision = repeated.revision as { sourceRevision: string; treeDigest: string };
  assert.equal(repeatedRevision.sourceRevision, firstRevision.sourceRevision);
  assert.equal(repeatedRevision.treeDigest, firstRevision.treeDigest);

  await git(directory, ["config", "user.email", "test@anyam.dev"]);
  await git(directory, ["config", "user.name", "Anyam Test"]);
  await writeFile(join(directory, "src", "index.ts"), "export const changed = true;\n", "utf8");
  await assert.rejects(
    agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "change.source_dirty" && /asked=1 changed paths/.test(error.message),
  );

  await git(directory, ["add", "src/index.ts"]);
  await git(directory, ["commit", "--quiet", "-m", "Change source"]);
  const changed = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const changedRevision = changed.revision as { sourceRevision: string; treeDigest: string };
  assert.notEqual(changedRevision.sourceRevision, firstRevision.sourceRevision);
  assert.notEqual(changedRevision.treeDigest, firstRevision.treeDigest);
});

test("trusted Git inspection disables repository fsmonitor execution", async () => {
  const directory = await projectDirectory();
  const marker = join(directory, "fsmonitor-ran");
  const hook = join(directory, "fsmonitor-hook.sh");
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  await git(directory, ["config", "core.fsmonitor", hook]);

  await inspectGitSource(directory);
  await assert.rejects(access(marker));
});

test("agent Change publication inspects an isolated Git metadata copy after a hostile agent mutates .git", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const marker = join(directory, "host-git-executed");
  const agentManager = manager(directory);
  const script = [
    "const fs=require('node:fs');",
    "const hook=process.cwd()+'/.git/fsmonitor-hook.sh';",
    `fs.writeFileSync(hook, ${JSON.stringify(`#!/bin/sh\nprintf host > ${marker}\n`)}, {mode:0o755});`,
    "fs.appendFileSync('.git/config', '\\n[core]\\n\\tfsmonitor = '+hook+'\\n');",
    "fs.writeFileSync('.git/index', 'hostile-index-replacement');",
  ].join(" ");
  const launched = await agentManager.launchAgent({ agent: "codex", mode: "enforceable", command: process.execPath, args: ["-e", script] });
  assert.equal(launched.command.status, "passed", launched.command.stderr);
  const published = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  assert.equal((published.revision as Record<string, unknown>).sourceKind, "git");
  assert.match(String(published.trustedGitMetadata), /trustedGitMetadata=isolated-copy;.*index=rebuilt/);
  await assert.rejects(access(marker));
  await agentManager.revoke(launched.session.id);
});

test("agent Change publication rebuilds the trusted index instead of trusting skip-worktree metadata", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  const script = [
    "const fs=require('node:fs');",
    "fs.writeFileSync('src/index.ts', 'export const hiddenMutation = true;\\n');",
    "require('node:child_process').execFileSync('git',['update-index','--skip-worktree','src/index.ts']);",
  ].join(" ");
  const launched = await agentManager.launchAgent({ agent: "codex", mode: "enforceable", command: process.execPath, args: ["-e", script] });
  assert.equal(launched.command.status, "passed", launched.command.stderr);
  await assert.rejects(
    agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "change.source_dirty" && /asked=1 changed paths/.test(error.message),
  );
  await agentManager.revoke(launched.session.id);
});

test("Git repository identity survives a moved checkout and a fresh clone", async () => {
  const directory = await projectDirectory({ startChange: false });
  const moved = join(directory, "..", "moved-demo");
  const cloned = join(directory, "..", "cloned-demo");
  await cp(directory, moved, { recursive: true });
  await execFile("git", ["clone", "--quiet", directory, cloned], { encoding: "utf8" });
  const original = await inspectGitSource(directory);
  const movedState = await inspectGitSource(moved);
  const clonedState = await inspectGitSource(cloned);
  assert.equal(original.repositoryIdentityBasis, "manifest");
  assert.equal(movedState.repositoryId, original.repositoryId);
  assert.equal(clonedState.repositoryId, original.repositoryId);
  assert.notEqual(movedState.repositoryRoot, original.repositoryRoot);
  assert.notEqual(clonedState.repositoryRoot, original.repositoryRoot);
  assert.match(original.repositoryIdentityReceipt, /pathIndependent=true/u);
});

test("Change revision names missing Git metadata and stale bases", async () => {
  const missingGitDirectory = await projectDirectory();
  const missingGitManager = manager(missingGitDirectory);
  await missingGitManager.startSession({ agent: "codex" });
  await rm(join(missingGitDirectory, ".git"), { recursive: true, force: true });
  await assert.rejects(
    missingGitManager.invokeTool("change.publish_revision", { declaredEffects: [] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.metadata_missing" && /recoveryAction/.test(JSON.stringify(error.toJSON())),
  );

  const staleDirectory = await projectDirectory({ startChange: false });
  const initialCommit = await git(staleDirectory, ["rev-parse", "HEAD"]);
  await writeFile(join(staleDirectory, "src", "index.ts"), "export const baseline = 1;\n", "utf8");
  await git(staleDirectory, ["add", "src/index.ts"]);
  await git(staleDirectory, ["commit", "--quiet", "-m", "Base change"]);
  await startChange(staleDirectory, "Stale base change");
  const baseCommit = await git(staleDirectory, ["rev-parse", "HEAD"]);
  assert.notEqual(baseCommit, initialCommit);
  await git(staleDirectory, ["checkout", "--quiet", "-b", "divergent", initialCommit]);
  await writeFile(join(staleDirectory, "src", "index.ts"), "export const divergent = true;\n", "utf8");
  await git(staleDirectory, ["add", "src/index.ts"]);
  await git(staleDirectory, ["commit", "--quiet", "-m", "Divergent change"]);
  const staleManager = manager(staleDirectory);
  await staleManager.startSession({ agent: "codex" });
  await assert.rejects(
    staleManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "change.base_stale" && /ancestor=false/.test(error.receipt ?? ""),
  );
});

test("agent run.start executes the declared Action and binds passed Evidence to Git and actor state", async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, {
    command: "node -e \"require('node:fs').writeFileSync('artifact.txt', 'passed')\"",
    inputs: ["anyam.json"],
    outputs: ["artifact.txt"],
  });
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "codex" });
  const result = await agentManager.invokeTool("run.start", { actionId: "action:check" });
  const run = result.run as Record<string, unknown>;
  const evidence = result.evidence as Record<string, unknown>;
  assert.equal(run.status, "passed");
  assert.equal(run.exitCode, 0);
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.actorId, started.session.actorId);
  assert.equal(evidence.grantId, started.grant.id);
  assert.match(String(run.sourceRevision), /^git:commit:[0-9a-f]{40,64}$/);
  assert.match(String(run.actionContractDigest), /^sha256:/);
  assert.match(String(run.stdoutDigest), /^sha256:/);
  assert.match(String(run.stderrDigest), /^sha256:/);
  assert.match(String(run.outputDigest), /^sha256:/);
  assert.match(String(run.toolchainDigest), /^sha256:/);
  assert.match(String(run.environmentDigest), /^sha256:/);
  assert.match(String(evidence.receipt), /action=action:check; verifier=verifier:local-check/);
});

test("agent run.start records failed Actions and never reports passed Evidence", async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, { command: "node -e \"process.stderr.write('failure'); process.exit(7)\"", inputs: ["anyam.json"], outputs: [] });
  const agentManager = manager(directory);
  await agentManager.startSession({ agent: "codex" });
  const result = await agentManager.invokeTool("run.start", { actionId: "action:check" });
  const run = result.run as Record<string, unknown>;
  const evidence = result.evidence as Record<string, unknown>;
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 7);
  assert.equal(evidence.status, "failed");
  assert.match(String(evidence.receipt), /exit-code=7/);
});

test("agent run.start fails closed for missing inputs and outputs", async () => {
  const missingInputDirectory = await projectDirectory();
  await replaceCheckAction(missingInputDirectory, { command: "node -e \"process.exit(0)\"", inputs: ["missing-input.txt"], outputs: [] });
  const missingInputManager = manager(missingInputDirectory);
  await missingInputManager.startSession({ agent: "codex" });
  const missingInput = await missingInputManager.invokeTool("run.start", { actionId: "action:check" });
  assert.equal((missingInput.run as Record<string, unknown>).status, "failed");
  assert.match(String((missingInput.evidence as Record<string, unknown>).receipt), /missing-input-patterns=missing-input.txt/);

  const missingOutputDirectory = await projectDirectory();
  await replaceCheckAction(missingOutputDirectory, { command: "node -e \"process.exit(0)\"", inputs: ["anyam.json"], outputs: ["missing-output.txt"] });
  const missingOutputManager = manager(missingOutputDirectory);
  await missingOutputManager.startSession({ agent: "codex" });
  const missingOutput = await missingOutputManager.invokeTool("run.start", { actionId: "action:check" });
  assert.equal((missingOutput.run as Record<string, unknown>).status, "failed");
  assert.match(String((missingOutput.evidence as Record<string, unknown>).receipt), /missing-output-paths=missing-output.txt/);
});

test("agent run.start rejects malformed Action declarations before execution", async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, { inputs: "not-an-array" });
  const agentManager = manager(directory);
  await assert.rejects(
    agentManager.startSession({ agent: "codex" }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "run.manifest_invalid" && /inputs/.test(error.message),
  );
});

test("CLI configures and starts an agent without creating Realm credentials", async () => {
  const directory = await projectDirectory();
  const previousStateHome = process.env.ANYAM_STATE_HOME;
  process.env.ANYAM_STATE_HOME = agentStateDirectory(directory);
  try {
    assert.equal(await main(["agent", "setup", "codex", directory, "--json"], directory), 0);
    assert.equal(await main(["agent", "start", "codex", "--json"], directory), 0);
    assert.equal(await main(["agent", "status", "--json"], directory), 0);
  } finally {
    if (previousStateHome === undefined) delete process.env.ANYAM_STATE_HOME;
    else process.env.ANYAM_STATE_HOME = previousStateHome;
  }
  const state = await readFile(localAgentStatePath(directory, agentStateDirectory(directory)), "utf8");
  assert.doesNotMatch(state, /"token"\s*:/);
  assert.doesNotMatch(state, /password/i);
});

test("CLI agent exec defaults to the enforceable Workspace lane", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const previousStateHome = process.env.ANYAM_STATE_HOME;
  process.env.ANYAM_STATE_HOME = agentStateDirectory(directory);
  try {
    const exitCode = await main(["agent", "exec", "cli", "--", process.execPath, "-e", "if (process.env.ANYAM_WORKSPACE_MODE !== 'enforceable') process.exit(7)"], directory);
    assert.equal(exitCode, 0);
    await manager(directory).revoke();
  } finally {
    if (previousStateHome === undefined) delete process.env.ANYAM_STATE_HOME;
    else process.env.ANYAM_STATE_HOME = previousStateHome;
  }
});

test("local agent authority state is outside the Project and concurrent brokers preserve credentials and audit events", async () => {
  const directory = await projectDirectory();
  const stateDirectory = agentStateDirectory(directory);
  const first = manager(directory);
  const second = manager(directory);
  const started = await first.startSession({ agent: "codex" });
  const [firstCredential, secondCredential] = await Promise.all([
    first.issueWorkspaceCredential(started.session.id),
    second.issueWorkspaceCredential(started.session.id),
  ]);
  assert.notEqual(firstCredential.token, secondCredential.token);
  const statePath = localAgentStatePath(directory, stateDirectory);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { credentials: Record<string, unknown>; audit: unknown[] };
  assert.equal(Object.keys(state.credentials).length, 2);
  assert.ok(state.audit.length >= 3);
  await assert.rejects(access(join(directory, ".anyam", "agents", "state.json")));
  assert.equal(first.statePathname, statePath);
  assert.equal(second.statePathname, statePath);
});

test("Git credential helper consumes a matching HTTPS remote context and refuses unrelated repositories", async () => {
  const directory = await projectDirectory();
  const stateDirectory = agentStateDirectory(directory);
  await git(directory, ["remote", "add", "origin", "https://git.anyam.dev/acme/demo.git"]);
  const context = await readGitCredentialContext(Readable.from("protocol=https\nhost=git.anyam.dev\npath=acme/demo.git\noperation=get\n\n"));
  assert.deepEqual(context, { protocol: "https", host: "git.anyam.dev", path: "acme/demo.git", operation: "get" });
  await assert.rejects(
    gitCredentialGet({ directory, stateDirectory, context: { ...context, path: "other/demo.git" } }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.credential.context_mismatch",
  );
  const result = await gitCredentialGet({ directory, stateDirectory, context });
  assert.equal(result.username, "x-anyam-token");
  assert.ok(result.password.length > 0);
  const state = await readFile(localAgentStatePath(directory, stateDirectory), "utf8");
  assert.doesNotMatch(state, new RegExp(result.password));
  await assert.rejects(
    gitCredentialGet({ directory, stateDirectory, context: { ...context, protocol: "ssh" } }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.credential.protocol_denied",
  );
});

test("Git credential protocol rejects malformed, duplicate, and write operations", async () => {
  await assert.rejects(
    readGitCredentialContext(Readable.from("protocol=https\nhost=git.anyam.dev\n")),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.credential.context_missing",
  );
  await assert.rejects(
    readGitCredentialContext(Readable.from("protocol=https\nprotocol=https\nhost=git.anyam.dev\npath=acme/demo.git\n\n")),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.credential.protocol_duplicate",
  );
  await assert.rejects(
    readGitCredentialContext(Readable.from("protocol=https\nhost=git.anyam.dev\npath=acme/demo.git\noperation=store\n\n")),
    (error: unknown) => error instanceof LocalAgentError && error.code === "git.credential.operation_denied",
  );
});

test("enforceable Workspace hides unauthorized source, strips ambient credentials, and protects canonical refs", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  await mkdir(join(directory, "private"), { recursive: true });
  await writeFile(join(directory, "private", "codec.ts"), "export const privateCodec = true;\n", "utf8");
  await git(directory, ["add", "private/codec.ts"]);
  await git(directory, ["commit", "--quiet", "-m", "Add private codec"]);
  const originalHead = await git(directory, ["rev-parse", "HEAD"]);
  const agentManager = manager(directory);
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "let sourceBlocked=false; try { fs.readFileSync(path.join(process.env.ANYAM_WORKSPACE_SOURCE_DIRECTORY, 'private/codec.ts')); } catch { sourceBlocked=true; }",
    "const hidden=!fs.existsSync(path.join(process.cwd(), 'private/codec.ts'));",
    "const ambient=!process.env.CLOUDFLARE_API_TOKEN && !process.env.SSH_AUTH_SOCK;",
    "let authorityBlocked=false; try { fs.writeFileSync(process.env.ANYAM_WORKSPACE_STATE_PATH, 'tamper'); } catch { authorityBlocked=true; }",
    "const branch=require('node:child_process').execFileSync('git',['symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim(); require('node:child_process').execFileSync('git',['update-ref','refs/heads/'+branch,require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);",
    "fs.writeFileSync('agent-output.txt', JSON.stringify({sourceBlocked,hidden,ambient,authorityBlocked,mode:process.env.ANYAM_WORKSPACE_MODE}));",
    "if (!sourceBlocked || !hidden || !ambient || !authorityBlocked || process.env.ANYAM_WORKSPACE_MODE !== 'enforceable') process.exit(9);",
  ].join(" ");
  const result = await agentManager.launchAgent({ agent: "cli", mode: "enforceable", authorizedPaths: ["anyam.json", "src"], command: process.execPath, args: ["-e", script] });
  assert.equal(result.command.status, "passed", `${result.command.stderr}\n${result.command.stdout}\n${result.command.receipt}`);
  assert.equal(result.boundary.mode, "enforceable");
  assert.equal(result.boundary.enforcement, "macos-sandbox-exec");
  assert.match(result.boundary.receipt, /ambientCredentials=blocked/);
  assert.match(result.boundary.profile ?? "", /deny default/);
  assert.deepEqual(JSON.parse(await readFile(join(result.boundary.workspaceDirectory, "agent-output.txt"), "utf8")), { sourceBlocked: true, hidden: true, ambient: true, authorityBlocked: true, mode: "enforceable" });
  assert.equal(await git(directory, ["rev-parse", "HEAD"]), originalHead);
  await agentManager.revoke(result.session.id);
  await assert.rejects(access(result.boundary.workspaceDirectory));
});

test("run.start uses the enforceable Workspace Runner and allows only declared outputs", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, {
    command: [
      "node -e",
      JSON.stringify([
        "const fs=require('node:fs');",
        "let stateBlocked=false; try { fs.readFileSync(process.env.ANYAM_WORKSPACE_STATE_PATH); } catch { stateBlocked=true; }",
        "fs.writeFileSync('artifact.txt', JSON.stringify({stateBlocked}));",
        "if (!stateBlocked) process.exit(9);",
      ].join(" ")),
    ].join(" "),
    inputs: ["anyam.json"],
    outputs: ["artifact.txt"],
  });
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "cli", mode: "enforceable", authorizedPaths: ["anyam.json", "src"], network: [] });
  const result = await agentManager.invokeTool("run.start", { actionId: "action:check" });
  const run = result.run as Record<string, unknown>;
  assert.equal(run.status, "passed", String(run.receipt));
  assert.match(String(run.receipt), /enforcement=macos-sandbox-exec; networkEnforcement=deny-all/u);
  assert.deepEqual(JSON.parse(await readFile(join(started.session.workspaceDirectory!, "artifact.txt"), "utf8")), { stateBlocked: true });
  await assert.rejects(access(join(directory, "artifact.txt")));
  await agentManager.revoke(started.session.id);
});

test("run.start rejects Action outputs that overlap tracked source or trusted metadata", async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, {
    command: "node -e \"require('node:fs').writeFileSync('anyam.json','tamper')\"",
    outputs: ["anyam.json"],
  });
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "cli", mode: "supervised" });
  await assert.rejects(
    agentManager.invokeTool("run.start", { actionId: "action:check" }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "run.output_source_overlap" && /anyam\.json/u.test(error.message),
  );
  await agentManager.revoke(started.session.id);
});

test("enforceable Workspace rejects tracked symlink projections", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const outside = join(directory, "..", "outside-secret.txt");
  await writeFile(outside, "not source", "utf8");
  await symlink(outside, join(directory, "src", "linked-secret.txt"));
  await git(directory, ["add", "src/linked-secret.txt"]);
  await git(directory, ["commit", "--quiet", "-m", "Add linked fixture"]);
  const agentManager = manager(directory);
  await assert.rejects(
    agentManager.startSession({ agent: "cli", mode: "enforceable", authorizedPaths: ["anyam.json", "src"], network: [] }),
    (error: unknown) => error instanceof Error && /symlink|non-regular|regular-file=false/u.test(`${error.message} ${"receipt" in error ? String(error.receipt) : ""}`),
  );
  await rm(outside, { force: true });
});

test("Linux enforceable Workspace refuses an unproxied host allowlist", { skip: process.platform !== "linux" ? "requires Linux enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  await assert.rejects(
    agentManager.startSession({ agent: "cli", mode: "enforceable", network: ["registry.example"] }),
    (error: unknown) => error instanceof Error && /allowlist|egress proxy/u.test(error.message),
  );
});

test("revoking a running run.start prevents a successful result", async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, {
    command: "node -e \"console.log('Action is running'); setTimeout(() => {}, 10000)\"",
    inputs: ["anyam.json"],
    outputs: [],
  });
  let signalRunning!: () => void;
  const processRunning = new Promise<void>((resolveRunning) => { signalRunning = resolveRunning; });
  class RunningProcessManager extends LocalAgentManager {
    protected override async registerWorkspaceProcess(sessionId: string, child: ChildProcess): Promise<void> {
      assert.ok(child.stdout);
      let output = "";
      let registered = false;
      const observeRunning = () => { if (registered && output.includes("Action is running")) signalRunning(); };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        observeRunning();
      });
      await super.registerWorkspaceProcess(sessionId, child);
      registered = true;
      observeRunning();
    }
  }
  const agentManager = new RunningProcessManager({ directory, stateDirectory: agentStateDirectory(directory) });
  const started = await agentManager.startSession({ agent: "cli", mode: "supervised" });
  const running = agentManager.invokeTool("run.start", { actionId: "action:check" });
  await Promise.race([processRunning, running.then(() => { throw new Error("Action completed before its running marker was observed."); })]);
  const revoked = await agentManager.revoke(started.session.id);
  assert.equal(revoked.status, "revoked");
  const result = await running;
  assert.notEqual((result.run as Record<string, unknown>).status, "passed");
});

test("a separate broker process can revoke an enforceable run and clean its Workspace", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  await replaceCheckAction(directory, { command: "node -e \"setTimeout(() => {}, 10000)\"", inputs: ["anyam.json"], outputs: [] });
  const stateDirectory = agentStateDirectory(directory);
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "cli", mode: "enforceable", authorizedPaths: ["anyam.json", "src"], network: [] });
  const running = agentManager.invokeTool("run.start", { actionId: "action:check" });
  const statePath = localAgentStatePath(directory, stateDirectory);
  const deadline = Date.now() + LOCAL_AGENT_POLICY.stateLockTimeoutMs;
  let processGroupObserved = false;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as { sessions?: Record<string, { processGroupId?: number }> };
      processGroupObserved = typeof state.sessions?.[started.session.id]?.processGroupId === "number";
    } catch {
      // The runner has not persisted its process group yet.
    }
    if (processGroupObserved) break;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCAL_AGENT_POLICY.stateLockRetryDelayMs));
  }
  assert.equal(processGroupObserved, true, "run.start did not persist a process group before the revocation attempt");
  const revokeScript = `import { LocalAgentManager } from ${JSON.stringify(new URL("../packages/create-anyam/src/agent.ts", import.meta.url).href)}; const [directory, stateDirectory, sessionId] = process.argv.slice(1); const manager = new LocalAgentManager({ directory, stateDirectory }); console.log(JSON.stringify(await manager.revoke(sessionId)));`;
  await execFile(process.execPath, ["--import", "tsx", "--eval", revokeScript, directory, stateDirectory, started.session.id], { cwd: process.cwd(), encoding: "utf8" });
  const result = await running;
  assert.notEqual((result.run as Record<string, unknown>).status, "passed");
  await assert.rejects(access(started.session.workspaceDirectory!));
});

test("supervised local Workspace is labelled non-enforcing", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "codex", mode: "supervised" });
  assert.equal(started.session.workspaceMode, "supervised");
  assert.equal(started.session.workspaceEnforcement, "none");
  assert.equal(started.context.workspaceMode, "supervised");
  assert.equal(started.context.workspaceEnforcement, "none");
  assert.match(started.context.receipt, /credentials=ambient-host-not-enforced/);
});

test("revoking an enforceable Workspace terminates the running agent and removes its disposable Workspace", { skip: process.platform !== "darwin" ? "requires macOS enforceable Workspace support" : false }, async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  const running = agentManager.launchAgent({ agent: "cli", mode: "enforceable", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] });
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
  const status = await agentManager.status();
  assert.ok(status.session);
  const sessionId = status.session!.id;
  const workspace = status.session!.workspaceDirectory;
  assert.ok(workspace);
  const revoked = await agentManager.revoke(sessionId);
  assert.equal(revoked.status, "revoked");
  const result = await running;
  assert.equal(result.command.status, "failed");
  await assert.rejects(access(workspace!));
});

test("change.inspect summarizes exact local candidate Evidence and exposes unknown review inputs", async () => {
  const directory = await projectDirectory();
  const agentManager = manager(directory);
  try {
    await replaceCheckAction(directory, { command: "node -e \"process.exit(0)\"", inputs: ["anyam.json"], outputs: [] });
    const first = await agentManager.startSession({ agent: "codex" });
    type Packet = ReturnType<typeof import("../packages/create-anyam/src/review-packet.ts").localReviewPacket>;
    const inspect = async () => (await agentManager.invokeTool("change.inspect", {}, first.session.id)).reviewPacket as Packet;
    let packet = await inspect();
    assert.equal(packet.candidate, null);
    assert.equal(packet.checks.find((check) => check.actionId === "action:check")?.status, "missing");
    assert.equal(packet.rationale.status, "unknown");
    assert.equal(packet.behaviorExample.status, "unknown");
    assert.equal(packet.decisionsRequired.status, "unknown");
    const published = await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }, first.session.id);
    const result = await agentManager.invokeTool("run.start", { actionId: "action:check" }, first.session.id);
    const run = result.run as { id: string; evidenceId: string; sourceRevision: string };
    packet = await inspect();
    assert.equal(packet.candidate?.id, (published.revision as { id: string }).id);
    const check = packet.checks.find((record) => record.actionId === "action:check")!;
    assert.equal(check.status, "passed");
    assert.equal(check.runId, run.id);
    assert.equal(check.evidenceId, run.evidenceId);
    assert.equal(check.testedSourceRevision, packet.candidate?.sourceRevision);
    assert.equal(check.changeRevisionBinding, "not-recorded");
    assert.equal(packet.diff.status, "not-recorded");
    assert.equal(packet.canonicalWrite, false);
    await replaceCheckAction(directory, { command: "node -e \"process.exit(1)\"" });
    await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }, first.session.id);
    const stalePacket = await inspect();
    assert.equal(stalePacket.checks.find((record) => record.actionId === "action:check")?.status, "stale");
    assert.equal(stalePacket.checks.find((record) => record.actionId === "action:check")?.sourceMismatch, true);
    assert.ok(stalePacket.nextSteps.some((step) => step.reason.includes("Reconcile the intended source")));
    await agentManager.invokeTool("run.start", { actionId: "action:check" }, first.session.id);
    assert.equal((await inspect()).checks.find((record) => record.actionId === "action:check")?.status, "failed");
    const peer = await agentManager.startSession({ agent: "claude", parallel: true });
    await agentManager.invokeTool("review.submit_finding", { severity: "error", summary: "peer fixture note" }, peer.session.id);
    await agentManager.invokeTool("change.publish_revision", { declaredEffects: ["peer.modify"] }, peer.session.id);
    packet = await inspect();
    assert.equal(packet.findings.some((finding) => finding.summary === "peer fixture note"), false);
    assert.deepEqual(packet.candidate?.declaredEffects, ["source.modify"]);
    const before = await readFile(localAgentStatePath(directory, agentStateDirectory(directory)), "utf8");
    await inspect();
    const after = await readFile(localAgentStatePath(directory, agentStateDirectory(directory)), "utf8");
    const beforeState = JSON.parse(before) as { revisions: unknown; runs: unknown; findings: unknown };
    const afterState = JSON.parse(after) as typeof beforeState;
    assert.deepEqual(afterState.revisions, beforeState.revisions);
    assert.deepEqual(afterState.runs, beforeState.runs);
    assert.deepEqual(afterState.findings, beforeState.findings);
  } finally {
    for (const item of await agentManager.listSessions()) await agentManager.revoke(item.session.id);
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});
