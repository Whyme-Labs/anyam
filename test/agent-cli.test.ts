import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalAgentError,
  LocalAgentManager,
  LocalMcpBroker,
  setupAgent,
} from "../packages/create-anyam/src/agent.ts";
import { main } from "../packages/create-anyam/src/cli.ts";
import { scaffoldProject, startChange } from "../packages/create-anyam/src/scaffold.ts";

const execFile = promisify(execFileCallback);

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

test("local agent session is bound to one Change Workspace and revocation invalidates credentials", async () => {
  const directory = await projectDirectory();
  let clock = Date.parse("2026-08-03T00:00:00.000Z");
  const manager = new LocalAgentManager({ directory, now: () => new Date(clock), credentialLifetimeMs: 5_000, sessionLifetimeMs: 60_000 });
  const started = await manager.startSession({ agent: "codex" });
  const credential = await manager.issueWorkspaceCredential();
  assert.equal(credential.canonicalWrite, false);
  assert.deepEqual(await manager.validateWorkspaceCredential(credential), { valid: true, sessionId: started.session.id, workspaceId: started.session.workspaceId });
  clock += 6_000;
  assert.deepEqual(await manager.validateWorkspaceCredential(credential), { valid: false, code: "credential.expired" });
  const nextCredential = await manager.issueWorkspaceCredential();
  const revoked = await manager.revoke();
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(await manager.validateWorkspaceCredential(nextCredential), { valid: false, code: "credential.session_inactive" });
  await assert.rejects(manager.invokeTool("repository.write"), (error: unknown) => error instanceof LocalAgentError && error.code === "agent.session.missing");
});

test("MCP exposes semantic Change tools and keeps canonical writes outside the broker", async () => {
  const directory = await projectDirectory();
  const manager = new LocalAgentManager({ directory, credentialLifetimeMs: 10_000, sessionLifetimeMs: 60_000 });
  const broker = new LocalMcpBroker({ manager, agent: "claude" });
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

test("Change revisions use stable Git identities and reject dirty source", async () => {
  const directory = await projectDirectory();
  const manager = new LocalAgentManager({ directory, credentialLifetimeMs: 10_000, sessionLifetimeMs: 60_000 });
  await manager.startSession({ agent: "codex" });

  const first = await manager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const firstRevision = first.revision as { sourceRevision: string; treeDigest: string };
  const repeated = await manager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const repeatedRevision = repeated.revision as { sourceRevision: string; treeDigest: string };
  assert.equal(repeatedRevision.sourceRevision, firstRevision.sourceRevision);
  assert.equal(repeatedRevision.treeDigest, firstRevision.treeDigest);

  await git(directory, ["config", "user.email", "test@anyam.dev"]);
  await git(directory, ["config", "user.name", "Anyam Test"]);
  await writeFile(join(directory, "src", "index.ts"), "export const changed = true;\n", "utf8");
  await assert.rejects(
    manager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "change.source_dirty" && /asked=1 changed paths/.test(error.message),
  );

  await git(directory, ["add", "src/index.ts"]);
  await git(directory, ["commit", "--quiet", "-m", "Change source"]);
  const changed = await manager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] });
  const changedRevision = changed.revision as { sourceRevision: string; treeDigest: string };
  assert.notEqual(changedRevision.sourceRevision, firstRevision.sourceRevision);
  assert.notEqual(changedRevision.treeDigest, firstRevision.treeDigest);
});

test("Change revision names missing Git metadata and stale bases", async () => {
  const missingGitDirectory = await projectDirectory();
  const missingGitManager = new LocalAgentManager({ directory: missingGitDirectory });
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
  const staleManager = new LocalAgentManager({ directory: staleDirectory });
  await staleManager.startSession({ agent: "codex" });
  await assert.rejects(
    staleManager.invokeTool("change.publish_revision", { declaredEffects: ["source.modify"] }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "change.base_stale" && /ancestor=false/.test(error.receipt ?? ""),
  );
});

test("CLI configures and starts an agent without creating Realm credentials", async () => {
  const directory = await projectDirectory();
  assert.equal(await main(["agent", "setup", "codex", directory, "--json"], directory), 0);
  assert.equal(await main(["agent", "start", "codex", "--json"], directory), 0);
  assert.equal(await main(["agent", "status", "--json"], directory), 0);
  const state = await readFile(join(directory, ".anyam", "agents", "state.json"), "utf8");
  assert.doesNotMatch(state, /"token"\s*:/);
  assert.doesNotMatch(state, /password/i);
});
