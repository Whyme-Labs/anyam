import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectCodexRecording, evaluateNativeRecording } from "../packages/create-anyam/src/native-recording.ts";
import { main } from "../packages/create-anyam/src/cli.ts";

const execFile = promisify(execFileCallback);
const threadId = "thread:owned-fixture";
const recordingRoot = "/original/owned-workspace";
const events = [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "warning", type: "error", message: "private warning must not be disclosed" } },
  { type: "item.started", item: { id: "command", type: "command_execution", status: "in_progress" } },
  { type: "item.completed", item: { id: "command", type: "command_execution", status: "completed", exit_code: 0, command: "private command", aggregated_output: "private output" } },
  { type: "item.started", item: { id: "edit", type: "file_change", status: "in_progress" } },
  { type: "item.completed", item: { id: "edit", type: "file_change", status: "completed", changes: [{ path: recordingRoot + "/src/value.mjs", kind: "update" }] } },
  { type: "item.completed", item: { id: "message", type: "agent_message", text: "private reasoning or answer" } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
];
const bytes = (value: readonly unknown[]) => Buffer.from(value.map(event => JSON.stringify(event)).join("\n") + "\n");
const inspect = (value: readonly unknown[]) => inspectCodexRecording(bytes(value), { threadId, recordingRoot });

test("recorded Codex inspection binds exact bytes, thread and completed file claims without disclosing text", () => {
  const source = bytes(events);
  const result = inspect(events);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.terminal, "completed");
  assert.equal(result.digest, "sha256:" + createHash("sha256").update(source).digest("hex"));
  assert.equal(result.expectedThreadDigest, result.observedThreadDigest);
  assert.deepEqual(result.changedPaths, ["src/value.mjs"]);
  assert.equal(result.warningCount, 1);
  assert.equal(result.failedToolCount, 0);
  assert.deepEqual(result.reportedUsage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("a peer recording, appended second session or replayed completion cannot match the selected invocation", () => {
  const peer = inspectCodexRecording(bytes(events), { threadId: "thread:peer", recordingRoot });
  assert.ok(peer.blockers.some(b => b.code === "recording.thread_mismatch"));
  for (const tail of [[events[0]], [events.at(-1)], [events[6]]]) {
    assert.ok(inspect([...events, ...tail]).blockers.length);
  }
});

test("truncated, failed and pending-item recordings remain blocked even with a completed-turn claim", () => {
  assert.ok(inspect(events.slice(0, -1)).blockers.some(b => b.code === "recording.incomplete"));
  const failed = inspect([...events.slice(0, -1), { type: "turn.failed", error: { message: "private failure" } }]);
  assert.equal(failed.terminal, "failed");
  assert.ok(failed.blockers.some(b => b.code === "recording.turn_failed"));
  const pending = inspect(events.filter((_, index) => index !== 6));
  assert.ok(pending.blockers.some(b => b.code === "recording.incomplete"));
});

test("malformed or unsupported events never expose their body or become a complete receipt", () => {
  for (const source of [Buffer.from('{"private":"secret"\n'), Buffer.from([0xff]), bytes([...events, { type: "unrecognized", secret: "private" }])]) {
    const result = inspectCodexRecording(source, { threadId, recordingRoot });
    assert.ok(result.blockers.length);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("outside or failed file claims cannot cover committed candidate paths", () => {
  const fileEvent = events[6]!;
  for (const path of ["../outside.mjs", "/elsewhere/value.mjs", recordingRoot]) {
    const result = inspect(events.map((e, i) => i === 6 ? { ...fileEvent, item: { id: "edit", type: "file_change", status: "completed", changes: [{ path, kind: "update" }] } } : e));
    assert.ok(result.blockers.some(b => b.code === "recording.path_outside_workspace"));
    assert.deepEqual(result.changedPaths, []);
  }
  const failed = inspect(events.map((e, i) => i === 6 ? { ...fileEvent, item: { id: "edit", type: "file_change", status: "failed", changes: [{ path: "src/value.mjs", kind: "update" }] } } : e));
  assert.equal(failed.failedToolCount, 1);
  assert.ok(failed.blockers.some(b => b.code === "recording.file_change_incomplete"));
  assert.deepEqual(failed.changedPaths, []);
});

test("invalid usage is blocked while failed commands remain explicit observations", () => {
  const invalid = inspect([...events.slice(0, -1), { type: "turn.completed", usage: { input_tokens: -1 } }]);
  assert.ok(invalid.blockers.some(b => b.code === "recording.usage_invalid"));
  const failedCommand = inspect(events.map((e, i) => i === 4 ? { type: "item.completed", item: { id: "command", type: "command_execution", status: "completed", exit_code: 1 } } : e));
  assert.equal(failedCommand.failedToolCount, 1);
  assert.equal(failedCommand.terminal, "completed");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anyam-recording-"));
  const directory = join(root, "candidate");
  const git = async (...args: string[]) => (await execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Anyam Fixture", "-c", "user.email=fixture@anyam.invalid", ...args], { cwd: directory })).stdout.trim();
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/value.mjs"), "export const value = 0;\n");
  await git("init", "--quiet"); await git("add", "."); await git("commit", "--quiet", "-m", "Owned baseline");
  const baseCommit = await git("rev-parse", "HEAD");
  await writeFile(join(directory, "src/value.mjs"), "export const value = 1;\n");
  await git("add", "."); await git("commit", "--quiet", "-m", "Owned candidate");
  const candidateCommit = await git("rev-parse", "HEAD");
  const recordingFile = join(root, "recording.jsonl");
  await writeFile(recordingFile, bytes(events));
  return { root, directory, git, input: { directory, recordingFile, recordingRoot, threadId, baseCommit, candidateCommit } };
}

test("local evaluation matches a real committed diff and keeps all source and metadata unchanged", async () => {
  const f = await fixture();
  try {
    const before = await f.git("status", "--porcelain=v1");
    const config = await readFile(join(f.directory, ".git/config"));
    const index = await readFile(join(f.directory, ".git/index"));
    // Identical bytes with changed stat data normally cause `git status` to refresh the index.
    await utimes(join(f.directory, "src/value.mjs"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const result = await evaluateNativeRecording(f.input);
    assert.equal(result.status, "matched");
    assert.equal(result.candidate.commit, f.input.candidateCommit);
    assert.equal(result.candidate.tree, await f.git("rev-parse", "HEAD^{tree}"));
    assert.deepEqual(result.candidate.changedPaths, ["src/value.mjs"]);
    assert.equal(result.nativeHarnessInvoked, false); assert.equal(result.canonicalWrite, false);
    assert.deepEqual(await readFile(join(f.directory, ".git/index")), index);
    assert.equal(await f.git("status", "--porcelain=v1"), before);
    assert.deepEqual(await readFile(join(f.directory, ".git/config")), config);
    assert.deepEqual((await readdir(f.directory)).sort(), [".git", "src"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("dirty source, wrong HEAD, unrecorded changes and missing ancestry cannot produce a matched candidate", async () => {
  const f = await fixture();
  try {
    const wrong = await evaluateNativeRecording({ ...f.input, candidateCommit: f.input.baseCommit });
    assert.equal(wrong.status, "blocked"); assert.equal(wrong.candidate.tree, null);
    assert.ok(wrong.blockers.some(b => b.code === "candidate.head_mismatch"));
    const ancestry = await evaluateNativeRecording({ ...f.input, baseCommit: "f".repeat(40) });
    assert.ok(ancestry.blockers.some(b => b.code === "candidate.base_not_ancestor"));
    await writeFile(join(f.directory, "unrecorded.mjs"), "export const unrecorded = true;\n");
    const dirty = await evaluateNativeRecording(f.input);
    assert.ok(dirty.blockers.some(b => b.code === "candidate.source_dirty"));
    await f.git("add", "."); await f.git("commit", "--quiet", "-m", "Unrecorded peer edit");
    const candidateCommit = await f.git("rev-parse", "HEAD");
    const unrecorded = await evaluateNativeRecording({ ...f.input, candidateCommit });
    assert.equal(unrecorded.status, "blocked");
    assert.deepEqual(unrecorded.candidate.unrecordedPaths, ["unrecorded.mjs"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("CLI evaluates the selected recording with machine status and creates no agent session", async () => {
  const f = await fixture();
  const original = console.log;
  const printed: string[] = [];
  console.log = (value: unknown) => { printed.push(String(value)); };
  try {
    const args = ["agent", "evaluate-recording", "--recording", f.input.recordingFile, "--thread", threadId,
      "--base-commit", f.input.baseCommit, "--candidate-commit", f.input.candidateCommit,
      "--recording-root", recordingRoot, "--directory", f.directory, "--json"];
    assert.equal(await main(args), 0);
    assert.equal(JSON.parse(printed[0]!).status, "matched");
    args[args.indexOf(threadId)] = "thread:peer";
    assert.equal(await main(args), 1);
    assert.equal(JSON.parse(printed[1]!).status, "blocked");
    await assert.rejects(main(["agent", "evaluate-recording", "--recording", "--json"]), /requires one --recording/);
    assert.deepEqual((await readdir(f.directory)).sort(), [".git", "src"]);
  } finally { console.log = original; await rm(f.root, { recursive: true, force: true }); }
});
