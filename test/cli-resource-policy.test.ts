import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { LOCAL_ACTION_POLICY, LocalAgentManager, localAgentStatePath } from "../packages/create-anyam/src/agent.ts";
import { scaffoldProject, startChange } from "../packages/create-anyam/src/scaffold.ts";
import { parseWorkspaceResourceLimits } from "../packages/create-anyam/src/workspace-boundary.ts";

const execFile = promisify(execFileCallback);
const entrypoint = resolve("packages/create-anyam/src/anyam.ts");
// Synthetic request values from workspace-resource.test.ts; no host sizing claim.
const policy = { maxProcesses: 256, maxAddressSpaceBytes: 1_000_000_000, maxCpuSeconds: 30, maxOpenFiles: 1024, maxFileBytes: 64_000_000, maxWorkspaceBytes: 128_000_000, monitorIntervalMs: 250, receipt: "measurement=cli-resource-policy-fixture; source=synthetic-test" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-cli-resource-policy-"));
  const directory = join(root, "project"); const stateDirectory = join(root, "state"); const policyPath = join(root, "policy.json");
  await scaffoldProject({ directory, name: "resource-policy", kind: "worker" });
  await startChange(directory, "Explicit measured policy");
  await writeFile(policyPath, JSON.stringify(policy));
  const environment = { ...process.env, ANYAM_STATE_HOME: stateDirectory };
  const run = (args: readonly string[], input?: string) => {
    const command = execFile(process.execPath, ["--import", "tsx", entrypoint, ...args.slice(0, 2), "--directory", directory, ...args.slice(2)], { cwd: process.cwd(), env: environment, timeout: LOCAL_ACTION_POLICY.timeoutMs });
    if (input !== undefined) command.child.stdin?.end(input);
    return command;
  };
  const cleanup = async () => {
    try {
      const state = JSON.parse(await readFile(localAgentStatePath(directory, stateDirectory), "utf8")) as { sessions: Record<string, { id: string }> };
      const manager = new LocalAgentManager({ directory, stateDirectory });
      for (const session of Object.values(state.sessions)) await manager.revoke(session.id);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { await rm(root, { recursive: true, force: true }); }
  };
  return { root, directory, stateDirectory, policyPath, run, cleanup };
}

test("CLI resource policy refuses supervised execution before starting the workload", async () => {
  const f = await fixture();
  const marker = join(f.root, "workload-started");
  try {
    await assert.rejects(f.run(["agent", "exec", "cli", "--mode", "supervised", "--resource-policy", f.policyPath, "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]), /resource.*(?:unsupported|cannot be enforced)/iu);
    await assert.rejects(access(marker));
  } finally { await f.cleanup(); }
});

test("MCP startup carries the requested resource policy into boundary enforcement", async () => {
  const f = await fixture();
  try {
    const result = await f.run(["mcp", "serve", "--stdio", "--agent", "cli", "--mode", "supervised", "--resource-policy", f.policyPath], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const response = JSON.parse(result.stdout) as { error?: { message: string } };
    assert.match(response.error?.message ?? "", /resource.*cannot be enforced/iu);
    const state = await readFile(localAgentStatePath(f.directory, f.stateDirectory), "utf8").then(value => JSON.parse(value) as { sessions: object }, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: {} }; throw error; });
    assert.deepEqual(state.sessions, {}, "unsupported policy must not start a Session");
  } finally { await f.cleanup(); }
});

test("explicit CLI session startup cannot ignore a requested resource policy", async () => {
  for (const command of ["agent", "workspace"] as const) {
    const f = await fixture();
    try {
      await assert.rejects(f.run([command, "start", "--agent", "cli", "--mode", "supervised", "--resource-policy", f.policyPath]), /resource.*cannot be enforced/iu);
    } finally { await f.cleanup(); }
  }
});

test("resource policy cannot replace an existing session or revoke it through another command", async () => {
  const f = await fixture();
  try {
    const manager = new LocalAgentManager({ directory: f.directory, stateDirectory: f.stateDirectory });
    const active = await manager.startSession({ agent: "cli", mode: "supervised" });
    const statePath = localAgentStatePath(f.directory, f.stateDirectory); const before = await readFile(statePath, "utf8");
    for (const args of [
      ["workspace", "exec", "--session", active.session.id, "--resource-policy", join(f.root, "absent.json"), "--", process.execPath, "-e", "process.exit(0)"],
      ["agent", "handoff", "cli", "--session", active.session.id, "--resource-policy", f.policyPath],
    ]) {
      await assert.rejects(f.run(args), /--resource-policy.*new-session/iu);
      assert.equal(await readFile(statePath, "utf8"), before, "rejected policy must preserve selected Session and Grant");
    }
    await assert.rejects(f.run(["mcp", "serve", "--stdio", "--agent", "cli", "--session", active.session.id, "--resource-policy", join(f.root, "absent.json")]), /--session cannot be combined with new-session scope options/);
    assert.equal(await readFile(statePath, "utf8"), before);
  } finally { await f.cleanup(); }
});

test("CLI rejects malformed or unmeasured policies without creating a Session", async () => {
  const f = await fixture();
  try {
    for (const [value, message] of [
      ["{", /valid JSON/],
      ["null", /JSON object/],
      ["[]", /JSON object/],
      [JSON.stringify({ resourceLimits: policy }), /maxProcesses/],
      [JSON.stringify({ ...policy, maxOpenFiles: 0 }), /maxOpenFiles.*positive safe integer.*asked=0/],
      [JSON.stringify({ ...policy, maxCpuSeconds: "30" }), /maxCpuSeconds.*positive safe integer/],
      [JSON.stringify({ ...policy, receipt: "" }), /measurement receipt/],
    ] as const) {
      await writeFile(f.policyPath, value);
      await assert.rejects(f.run(["agent", "start", "--agent", "cli", "--resource-policy", f.policyPath]), message);
    }
    await assert.rejects(access(localAgentStatePath(f.directory, f.stateDirectory)), "invalid requests must not persist Session authority");
  } finally { await f.cleanup(); }
});

test("resource policy file options require one explicit value", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["agent", "start", "--agent", "cli", "--resource-policy"],
      ["workspace", "start", "--agent", "cli", "--resource-policy", "--mode", "enforceable"],
      ["agent", "exec", "cli", "--resource-policy", f.policyPath, "--resource-policy", f.policyPath, "--", process.execPath],
    ]) await assert.rejects(f.run(args), /--resource-policy requires one explicit JSON file/);
    await assert.rejects(access(localAgentStatePath(f.directory, f.stateDirectory)));
  } finally { await f.cleanup(); }
});

test("policy parsing retains measured fields without copying unrelated file content", () => {
  assert.deepEqual(parseWorkspaceResourceLimits({ ...policy, environment: { token: "synthetic-unrelated-value" }, extra: "synthetic" }), policy);
});

test("macOS enforceable startup refuses a Linux resource policy", { skip: process.platform !== "darwin" ? "requires macOS; this case does not qualify Linux resource enforcement" : false }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run(["workspace", "start", "--agent", "cli", "--mode", "enforceable", "--resource-policy", f.policyPath]), /resource.*cannot be enforced.*darwin/iu);
    await assert.rejects(access(localAgentStatePath(f.directory, f.stateDirectory)));
  } finally { await f.cleanup(); }
});
