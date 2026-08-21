import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  connectGitHubActions,
  generateGitHubActionsBridgeWorkflow,
} from "../packages/create-anyam/src/github-actions-bridge.ts";
import { main } from "../packages/create-anyam/src/cli.ts";

const execFile = promisify(execFileCallback);
const actionRef = `acme/anyam-bridge-action@${"a".repeat(40)}`;

async function git(directory: string, args: readonly string[]): Promise<void> {
  await execFile("git", [...args], { cwd: directory, encoding: "utf8" });
}

async function repository(remote: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anyam-github-bridge-cli-"));
  await git(root, ["init", "--quiet"]);
  await git(root, ["checkout", "-b", "main"]);
  await git(root, ["remote", "add", "origin", remote]);
  return root;
}

const input = (directory: string) => ({
  directory,
  realm: "https://source.acme.com",
  project: "project:atlas",
  connection: "github-bridge:pending",
  actionRef,
});

test("GitHub Actions workflow generation is deterministic, pinned, and credential-free", () => {
  const workflow = generateGitHubActionsBridgeWorkflow({
    ...input("/tmp/atlas"),
    repository: { owner: "acme", name: "private-platform" },
    branch: "main",
  });
  assert.match(workflow, /name: Anyam Bridge/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, new RegExp(actionRef.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(workflow, /private.?key|webhook.?secret|password|bearer/iu);
  assert.equal(workflow, generateGitHubActionsBridgeWorkflow({
    ...input("/tmp/other"),
    repository: { owner: "acme", name: "private-platform" },
    branch: "main",
  }));
});

test("connectGitHubActions detects the remote, writes only the generated workflow, and refuses overwrite", async () => {
  const directory = await repository("git@github.com:acme/private-platform.git");
  try {
    const planned = await connectGitHubActions({ ...input(directory), dryRun: true });
    assert.equal(planned.status, "planned");
    if (planned.status !== "planned") return;
    assert.equal(planned.repository.owner, "acme");
    assert.equal(planned.repository.name, "private-platform");
    assert.equal(planned.branch, "main");
    assert.equal(planned.workflowPath, ".github/workflows/anyam-bridge.yml");
    assert.equal(await readFile(join(directory, ".github/workflows/anyam-bridge.yml"), "utf8").catch(() => undefined), undefined);

    const created = await connectGitHubActions(input(directory));
    assert.equal(created.status, "created");
    assert.equal(await readFile(join(directory, ".github/workflows/anyam-bridge.yml"), "utf8"), planned.workflow);

    const unchanged = await connectGitHubActions(input(directory));
    assert.equal(unchanged.status, "unchanged");

    await git(directory, ["config", "user.email", "test@anyam.dev"]);
    await git(directory, ["config", "user.name", "Anyam Test"]);
    await execFile("sh", ["-c", "printf '\n# changed\n' >> .github/workflows/anyam-bridge.yml"], { cwd: directory, encoding: "utf8" });
    const conflict = await connectGitHubActions(input(directory));
    assert.equal(conflict.status, "blocked");
    if (conflict.status === "blocked") assert.equal(conflict.code, "workflow_exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connectGitHubActions rejects non-GitHub remotes and mutable action references", async () => {
  const directory = await repository("https://gitlab.com/acme/private-platform.git");
  try {
    const wrongProvider = await connectGitHubActions(input(directory));
    assert.equal(wrongProvider.status, "blocked");
    if (wrongProvider.status === "blocked") assert.equal(wrongProvider.code, "remote_provider_unsupported");
    const githubDirectory = await repository("https://github.com/acme/private-platform.git");
    const invalidAction = await connectGitHubActions({ ...input(githubDirectory), actionRef: "acme/anyam-bridge-action@main" });
    assert.equal(invalidAction.status, "blocked");
    if (invalidAction.status === "blocked") assert.equal(invalidAction.code, "action_ref_unpinned");
    await rm(githubDirectory, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the public CLI routes connect github through the Actions Bridge generator", async () => {
  const directory = await repository("https://github.com/acme/private-platform.git");
  try {
    const exitCode = await main([
      "connect", "github", "--method", "actions",
      "--realm", "https://source.acme.com",
      "--project", "project:atlas",
      "--connection", "github-bridge:pending",
      "--action-ref", actionRef,
    ], directory);
    assert.equal(exitCode, 0);
    assert.match(await readFile(join(directory, ".github/workflows/anyam-bridge.yml"), "utf8"), /direction: inbound/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
