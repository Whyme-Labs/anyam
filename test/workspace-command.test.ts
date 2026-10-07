import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createWorkspaceBoundary, removeWorkspaceBoundary, runWorkspaceCommand, terminateWorkspaceProcess, WORKSPACE_BOUNDARY_POLICY, WorkspaceBoundaryError, type WorkspaceBoundary } from "../packages/create-anyam/src/workspace-boundary.ts";

const execFile = promisify(execFileCallback);

async function supervised(run: (root: string, boundary: WorkspaceBoundary) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  try {
    const boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "supervised" });
    await run(root, boundary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("supervised direct execution preserves literal arguments without shell expansion", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  try {
    const boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "supervised" });
    const canary = join(root, "must-not-exist");
    const expected = ["", "with spaces", "'single'", '"double"', "back\\slash", "$HOME", `$(touch ${canary})`, `\`touch ${canary}\``, "a;b", "a&&b", "a|b", "a>b", "*", "line\nbreak", "snowman ☃", "--leading-option"];
    const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...expected];
    const result = await runWorkspaceCommand({ boundary, command: process.execPath, args });
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, args);
    assert.equal(result.shell, false);
    assert.match(result.receipt, /commandMode=direct;/u);
    assert.ok(result.receipt.includes(`invocationDigest=${sha256(JSON.stringify({ args, command: process.execPath, shell: false }))};`));
    await assert.rejects(access(canary), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised cancellation removes the owned descendant process", { skip: process.platform === "win32" ? "requires POSIX process groups" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  let descendantPid: number | undefined;
  let cancellation: Promise<void> | undefined;
  try {
    const boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "supervised" });
    const script = "const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e',\"process.send('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore','ipc']});descendant.once('message',()=>process.stdout.write(JSON.stringify({pid:descendant.pid})+'\\n'));setInterval(()=>{},1000);";
    const result = await runWorkspaceCommand({ boundary, command: process.execPath, args: ["-e", script], onProcess: child => {
      child.stdout!.once("data", (chunk: Buffer) => {
        descendantPid = (JSON.parse(chunk.toString()) as { pid: number }).pid;
        cancellation = terminateWorkspaceProcess({ process: child });
      });
    } });
    await cancellation;
    assert.equal(result.status, "failed");
    assert.ok(descendantPid);
    assert.throws(() => process.kill(descendantPid!, 0), { code: "ESRCH" });
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("enforced direct execution selects the requested qualified executable rather than the first path", { skip: process.platform !== "darwin" ? "requires macOS sandbox-exec; Linux has its own boundary qualification" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  let boundary;
  try {
    for (const args of [["init", "--quiet"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Synthetic command baseline"]]) await execFile("git", args, { cwd: root });
    boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "enforceable", executablePaths: ["/usr/bin/false", process.execPath] });
    const args = ["-e", "console.log(process.execPath)"];
    const result = await runWorkspaceCommand({ boundary, command: process.execPath, args });
    assert.equal(result.stdout, `${process.execPath}\n`);
    assert.equal(result.status, "passed");
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, args);
    let unqualifiedStarted = false;
    await assert.rejects(runWorkspaceCommand({ boundary, command: "/bin/echo", args: ["must-not-run"], onProcess: () => { unqualifiedStarted = true; } }), (error: unknown) => error instanceof WorkspaceBoundaryError && error.code === "workspace.executable_unqualified");
    assert.equal(unqualifiedStarted, false);
  } finally {
    if (boundary) await removeWorkspaceBoundary(boundary);
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit shell execution rejects separate arguments before starting a child", async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  try {
    const boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "supervised" });
    let started = false;
    await assert.rejects(runWorkspaceCommand({ boundary, command: "echo unexpected", args: ["separate argument"], shell: true, onProcess: () => { started = true; } }), (error: unknown) => error instanceof WorkspaceBoundaryError && error.code === "workspace.shell_arguments_unsupported");
    assert.equal(started, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit shell execution reports the interpreter and actual shell arguments", { skip: process.platform === "win32" ? "requires POSIX shell" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "anyam-command-"));
  try {
    const boundary = await createWorkspaceBoundary({ sourceDirectory: root, stateDirectory: join(root, "state"), projectId: "project:argv", changeId: "change:argv", workspaceId: "workspace:argv", mode: "supervised" });
    const command = "printf '%s' 'literal shell value'";
    const result = await runWorkspaceCommand({ boundary, command, shell: true });
    assert.equal(result.stdout, "literal shell value");
    assert.equal(result.command, "/bin/sh");
    assert.deepEqual(result.args, ["-c", command]);
    assert.equal(result.shell, true);
    assert.match(result.receipt, /commandMode=shell;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised direct executable paths with spaces and metacharacters remain one executable", { skip: process.platform === "win32" ? "requires an unprivileged executable symlink" : false }, () => supervised(async (root, boundary) => {
  const executable = join(root, "node ; quoted ' executable");
  await symlink(process.execPath, executable);
  const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "", "literal | value"];
  const result = await runWorkspaceCommand({ boundary, command: executable, args });
  assert.equal(result.status, "passed");
  assert.equal(result.command, executable);
  assert.deepEqual(result.args, args);
  assert.equal(result.stdout, '["","literal | value"]\n');
}));

test("direct executable text is never interpreted as a shell program", () => supervised(async (root, boundary) => {
  const canary = join(root, "must-not-exist");
  const command = `${process.execPath} -e 'require("node:fs").writeFileSync("${canary}", "unexpected")'`;
  const result = await runWorkspaceCommand({ boundary, command });
  assert.equal(result.status, "failed");
  assert.equal(result.command, command);
  assert.deepEqual(result.args, []);
  assert.equal(result.shell, false);
  await assert.rejects(access(canary), { code: "ENOENT" });
}));

test("supervised direct execution reports actual failed exit and stream digests", () => supervised(async (_root, boundary) => {
  const args = ["-e", "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exitCode=7"];
  const result = await runWorkspaceCommand({ boundary, command: process.execPath, args });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, undefined);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  // Existing boundary stream fingerprints hash the JSON string representation.
  assert.equal(result.stdoutDigest, sha256(JSON.stringify("out\n")));
  assert.equal(result.stderrDigest, sha256(JSON.stringify("err\n")));
  assert.deepEqual(result.args, args);
}));

test("supervised timeout names the bound and cancels only its own group", { skip: process.platform === "win32" ? "requires POSIX process groups" : false }, () => supervised(async (_root, boundary) => {
  const peer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const closed = once(peer, "close");
  try {
    // A deliberately short failure-injection deadline, not a workload sizing claim.
    const timeoutMs = 50;
    const result = await runWorkspaceCommand({ boundary, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs });
    assert.equal(result.status, "failed");
    assert.equal(result.timedOut, true);
    assert.ok(result.receipt.includes(`budget=workspace.command; limit=${timeoutMs}ms; asked=timeout;`));
    assert.ok(result.processGroupId);
    assert.equal(result.processGroupId, result.processId);
    assert.ok(peer.pid);
    assert.doesNotThrow(() => process.kill(peer.pid!, 0));
  } finally {
    peer.kill("SIGTERM");
    await closed;
  }
}));

test("supervised combined stream overflow fails with the existing output budget", () => supervised(async (_root, boundary) => {
  const result = await runWorkspaceCommand({ boundary, command: process.execPath, args: ["-e", `process.stdout.write('x'.repeat(${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes + 1}));setInterval(()=>{},1000)`] });
  assert.equal(result.status, "failed");
  assert.ok(result.receipt.includes(`budget=workspace.output; limit=${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes}bytes; asked=output-exceeded;`));
  assert.ok(Buffer.byteLength(result.stdout) <= WORKSPACE_BOUNDARY_POLICY.maxOutputBytes);
}));

test("supervised registration failure never releases the workload", { skip: process.platform === "win32" ? "requires POSIX custodian registration gate" : false }, () => supervised(async (root, boundary) => {
  const canary = join(root, "must-not-exist");
  const failure = new Error("synthetic registration failure");
  await assert.rejects(runWorkspaceCommand({ boundary, command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", canary], onProcess: () => { throw failure; } }), error => error === failure);
  await assert.rejects(access(canary), { code: "ENOENT" });
}));

test("failed process creation never invokes durable registration", () => supervised(async (root, boundary) => {
  let registered = false;
  await assert.rejects(runWorkspaceCommand({ boundary: { ...boundary, workspaceDirectory: join(root, "missing-workspace") }, command: process.execPath, args: ["-e", "process.exit(0)"], onProcess: () => { registered = true; } }), (error: unknown) => error instanceof WorkspaceBoundaryError && error.code === "workspace.command_failed");
  await new Promise<void>(resolveTick => setImmediate(resolveTick));
  assert.equal(registered, false);
}));

test("supervised arguments are snapshotted before the process callback can mutate caller input", () => supervised(async (_root, boundary) => {
  const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "original"];
  const expectedArgs = [...args];
  const result = await runWorkspaceCommand({ boundary, command: process.execPath, args, onProcess: () => { args[3] = "changed"; } });
  assert.equal(result.stdout, '["original"]\n');
  assert.deepEqual(result.args, expectedArgs);
  assert.ok(result.receipt.includes(`invocationDigest=${sha256(JSON.stringify({ args: expectedArgs, command: process.execPath, shell: false }))};`));
}));
