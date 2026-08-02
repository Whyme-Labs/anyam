import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function projectDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anyam-agent-"));
  const directory = join(root, "demo");
  await scaffoldProject({ directory, name: "demo", kind: "worker" });
  await startChange(directory, "Add the first agent change");
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
  const revisionResult = (revision?.result as { structuredContent?: { canonicalWrite?: boolean } }).structuredContent;
  assert.equal(revisionResult?.canonicalWrite, false);
  await access(join(directory, ".anyam", "change.json"));
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
