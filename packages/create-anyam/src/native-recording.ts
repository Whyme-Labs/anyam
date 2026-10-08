import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { changedGitPaths, inspectGitSource, isGitAncestor } from "./git-source.js";

type Blocker = { code: string; line?: number };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inspect one recorded Codex exec turn. Recorded claims are not execution attestations. */
export function inspectCodexRecording(bytes: Uint8Array, input: { threadId: string; recordingRoot: string }) {
  const blockers: Blocker[] = [];
  const reject = (code: string, line?: number) => blockers.push({ code, ...(line === undefined ? {} : { line }) });
  let source = "";
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { reject("recording.utf8_invalid"); }
  let threadId: string | null = null;
  let threads = 0;
  let turns = 0;
  let terminal: "completed" | "failed" | null = null;
  let active = false;
  let eventCount = 0;
  let warningCount = 0;
  let failedToolCount = 0;
  const pending = new Set<string>();
  const completed = new Set<string>();
  const changedPaths = new Set<string>();
  const reportedUsage: Record<string, number> = {};
  const root = resolve(input.recordingRoot);
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    const position = index + 1;
    let event: unknown;
    try { event = JSON.parse(line) as unknown; }
    catch { reject("recording.json_invalid", position); continue; }
    if (!record(event) || typeof event.type !== "string") { reject("recording.event_invalid", position); continue; }
    eventCount += 1;
    if (event.type === "thread.started") {
      threads += 1;
      if (threads !== 1 || turns !== 0 || typeof event.thread_id !== "string" || !event.thread_id.trim()) reject("recording.thread_invalid", position);
      else threadId = event.thread_id;
    } else if (event.type === "turn.started") {
      turns += 1;
      if (!threadId || active || turns !== 1 || terminal !== null) reject("recording.turn_invalid", position);
      active = true;
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      if (!active || terminal !== null) reject("recording.terminal_invalid", position);
      terminal = event.type === "turn.completed" ? "completed" : "failed";
      active = false;
      if (terminal === "failed") reject("recording.turn_failed", position);
      if (event.usage !== undefined) {
        if (!record(event.usage)) reject("recording.usage_invalid", position);
        else for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
          const value = event.usage[key];
          if (value === undefined) continue;
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) reject("recording.usage_invalid", position);
          else reportedUsage[key] = value;
        }
      }
    } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item;
      if (!active || !record(item) || typeof item.id !== "string" || !item.id || typeof item.type !== "string") {
        reject("recording.item_invalid", position); continue;
      }
      if (completed.has(item.id)) { reject("recording.item_replayed", position); continue; }
      if (event.type !== "item.completed") {
        if (event.type === "item.started" && pending.has(item.id)) reject("recording.item_replayed", position);
        pending.add(item.id); continue;
      }
      pending.delete(item.id);
      completed.add(item.id);
      if (item.type === "error") warningCount += 1; // An item warning does not mean the turn failed.
      if (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)) failedToolCount += 1;
      if (item.type === "file_change") {
        if (item.status !== "completed" || !Array.isArray(item.changes)) { reject("recording.file_change_incomplete", position); continue; }
        for (const change of item.changes) {
          if (!record(change) || typeof change.path !== "string" || !change.path || change.path.includes("\0")
            || !["add", "update", "delete"].includes(String(change.kind))) { reject("recording.file_change_invalid", position); continue; }
          const path = relative(root, isAbsolute(change.path) ? resolve(change.path) : resolve(root, change.path));
          if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) reject("recording.path_outside_workspace", position);
          else changedPaths.add(path.split(sep).join("/"));
        }
      }
    } else if (event.type === "error") reject("recording.error", position);
    else reject("recording.event_unsupported", position);
  }
  if (threads !== 1 || turns !== 1 || terminal === null || active || pending.size > 0) reject("recording.incomplete");
  if (threadId !== input.threadId) reject("recording.thread_mismatch");
  return {
    adapter: "codex-exec-jsonl" as const,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    expectedThreadDigest: `sha256:${createHash("sha256").update(input.threadId).digest("hex")}`,
    observedThreadDigest: threadId === null ? null : `sha256:${createHash("sha256").update(threadId).digest("hex")}`,
    bytes: bytes.byteLength, eventCount, terminal, warningCount, failedToolCount,
    changedPaths: [...changedPaths].sort(), reportedUsage, blockers,
  };
}

export async function evaluateNativeRecording(input: {
  directory: string; recordingFile: string; recordingRoot?: string;
  threadId: string; baseCommit: string; candidateCommit: string;
}) {
  if (!input.threadId.trim() || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.baseCommit)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.candidateCommit)) {
    throw new Error("Native recording evaluation requires a thread ID and full base/candidate Git commit IDs; no session was started.");
  }
  const before = await inspectGitSource(input.directory);
  const recording = inspectCodexRecording(await readFile(input.recordingFile), {
    threadId: input.threadId, recordingRoot: input.recordingRoot ?? before.repositoryRoot,
  });
  const { blockers: recordingBlockers, ...recordingSummary } = recording;
  const blockers: Blocker[] = [...recordingBlockers];
  if (!before.clean) blockers.push({ code: "candidate.source_dirty" });
  if (before.commitId !== input.candidateCommit) blockers.push({ code: "candidate.head_mismatch" });
  const ancestry = await isGitAncestor(before.repositoryRoot, input.baseCommit, input.candidateCommit);
  if (!ancestry) blockers.push({ code: "candidate.base_not_ancestor" });
  const paths = ancestry ? await changedGitPaths(before.repositoryRoot, input.baseCommit, input.candidateCommit) : [];
  const unrecordedPaths = paths.filter(path => !recording.changedPaths.includes(path));
  // Extra logged paths can reflect intermediate edits reverted before commit.
  if (unrecordedPaths.length) blockers.push({ code: "candidate.change_unrecorded" });
  const after = await inspectGitSource(input.directory);
  if (!after.clean || before.commitId !== after.commitId || before.treeId !== after.treeId) blockers.push({ code: "candidate.changed_during_inspection" });
  return {
    protocol: "anyam.native-recording-evaluation/v1" as const,
    status: blockers.length ? "blocked" as const : "matched" as const,
    scope: "recorded-session-and-local-git-inspection" as const,
    recording: recordingSummary,
    candidate: { repositoryId: before.repositoryId, objectFormat: before.objectFormat,
      baseCommit: input.baseCommit, commit: input.candidateCommit, observedCommit: before.commitId,
      tree: before.commitId === input.candidateCommit ? before.treeId : null,
      observedTree: before.treeId, clean: before.clean, changedPaths: paths, unrecordedPaths },
    blockers,
    limits: ["Recording contents and claimed thread identity are not authenticated.",
      "Matching file paths does not prove that the harness produced the candidate bytes.",
      "No model, verifier, Evidence-validity, Landing or real-team readiness evaluation was performed.",
      "Git state was observed at inspection boundaries; concurrent filesystem changes are not isolated."],
    nativeHarnessInvoked: false, canonicalWrite: false,
  };
}
