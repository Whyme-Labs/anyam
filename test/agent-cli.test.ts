import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
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

test("CLI agent exec defaults to the enforceable Workspace lane", async () => {
  if (process.platform !== "darwin") return;
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

test("enforceable Workspace hides unauthorized source, strips ambient credentials, and protects canonical refs", async () => {
  if (process.platform !== "darwin") return;
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

test("run.start uses the enforceable Workspace Runner and allows only declared outputs", async () => {
  if (process.platform !== "darwin") return;
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

test("enforceable Workspace rejects tracked symlink projections", async () => {
  if (process.platform !== "darwin") return;
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

test("Linux enforceable Workspace refuses an unproxied host allowlist", async () => {
  if (process.platform !== "linux") return;
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
    command: "node -e \"setTimeout(() => {}, 10000)\"",
    inputs: ["anyam.json"],
    outputs: [],
  });
  const agentManager = manager(directory);
  const started = await agentManager.startSession({ agent: "cli", mode: "supervised" });
  const running = agentManager.invokeTool("run.start", { actionId: "action:check" });
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  const revoked = await agentManager.revoke(started.session.id);
  assert.equal(revoked.status, "revoked");
  const result = await running;
  assert.notEqual((result.run as Record<string, unknown>).status, "passed");
});

test("a separate broker process can revoke an enforceable run and clean its Workspace", async () => {
  if (process.platform !== "darwin") return;
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

test("revoking an enforceable Workspace terminates the running agent and removes its disposable Workspace", async () => {
  if (process.platform !== "darwin") return;
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
