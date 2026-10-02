import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("packages/create-anyam/dist/anyam.js");
const temporary = await mkdtemp(join(tmpdir(), "anyam-doc-commands-"));
const guide = await readFile("docs/guides/customer-realm.md", "utf8");
const quickstart = await readFile("docs/guides/quickstart.md", "utf8");
const execute = (args, status = 0) => {
  const result = spawnSync(process.execPath, [cli, ...args, "--directory", temporary, "--json"], { encoding: "utf8" });
  assert.equal(result.status, status, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
try {
  // Extract and run only these credential-free local commands from the guide.
  // Provider deploy/secret and OAuth commands are never executed by this gate.
  const planCommand = guide.match(/^anyam realm plan --account ([\w-]+)$/m);
  const installCommand = guide.match(/^anyam realm install --account ([\w-]+)$/m);
  assert.ok(planCommand, "Realm plan must declare the account argument");
  assert.ok(installCommand, "Realm install must declare the account argument");
  assert.match(guide, /^anyam realm export --path \S+$/m);
  assert.match(guide, /^anyam realm restore --path \S+$/m);
  assert.match(guide, /provider-pending/);
  assert.match(quickstart, /^anyam auth login --realm https:\/\/\S+ --client-id \S+$/m);
  const plan = execute(["realm", "plan", "--account", planCommand[1]]);
  assert.equal(plan.status, "planned");
  assert.match(plan.receipt, /providerMutation=false/);
  const install = execute(["realm", "install", "--account", installCommand[1]], 1);
  assert.equal(install.status, "blocked");
  assert.equal(install.state.phase, "provider-pending");
  assert.equal(install.state.providerMutation, false);
  const checkpoint = join(temporary, "export.json");
  const exported = execute(["realm", "export", "--path", checkpoint]);
  assert.equal(exported.status, "succeeded");
  const restored = execute(["realm", "restore", "--path", checkpoint]);
  assert.equal(restored.state.phase, "recovery-pending");
  assert.equal(restored.state.providerMutation, false);
  console.log(JSON.stringify({ protocol: "anyam.docs-command-smoke/v1", status: "succeeded", commands: ["realm plan", "realm install (blocked/provider-pending)", "realm export", "realm restore (recovery-pending)"], oauth: "arguments-checked; not-executed", provider: "not-invoked", fixtures: "isolated-and-removed" }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
