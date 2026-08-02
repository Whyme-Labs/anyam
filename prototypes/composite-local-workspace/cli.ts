/**
 * THROWAWAY PROTOTYPE — thin terminal shell for model.ts.
 *
 * Run with:
 *   node --experimental-strip-types prototypes/composite-local-workspace/cli.ts
 */

import readline from "node:readline";
import { createInitialState, fileStatus, reduce, shortContent } from "./model.ts";
import type { Action, AnyamState, SourceSpaceName } from "./model.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const red = (value: string) => `\x1b[31m${value}\x1b[0m`;
const green = (value: string) => `\x1b[32m${value}\x1b[0m`;

function render(state: AnyamState): void {
  const lines: string[] = [];
  lines.push(`${bold("ANYAM — COMPOSITE LOCAL WORKSPACE")}`);
  lines.push(dim("THROWAWAY LOGIC PROTOTYPE — state is in memory; no production code is used."));
  lines.push("");
  lines.push(`${bold("Question")}: ${state.question}`);
  lines.push(`${bold("Project")}: ${state.project.name}`);
  lines.push(`${bold("Project View")}: ${state.project.view} (only authorized Source Spaces are materialized)`);
  lines.push(`${bold("Workspace")}: ${state.project.workspaceId}`);
  lines.push(`${bold("Change")}: ${state.project.changeId}`);
  lines.push(`${bold("Base Project Revision")}: ${state.workspace.baseProjectRevision}`);
  lines.push("");

  lines.push(bold("Materialized Source Spaces"));
  for (const space of state.view.spaces) {
    const source = state.sourceSpaces[space.name];
    const synced = source.remoteSnapshot === state.workspace.baseSnapshots[space.name];
    lines.push(
      `  ${space.name.padEnd(16)} mount=${space.mount.padEnd(14)} visibility=${space.visibility.padEnd(7)} remote=${synced ? green("synced") : red("ahead")}`,
    );
    lines.push(dim(`    base=${state.workspace.baseSnapshots[space.name]} remote=${source.remoteSnapshot}`));
  }
  lines.push("");

  lines.push(bold("Unified Workspace status"));
  for (const file of Object.values(state.files).sort((left, right) => left.path.localeCompare(right.path))) {
    const status = fileStatus(file, state.conflicts);
    const marker = status.includes("conflict") ? red("!") : status.startsWith("modified") ? "M" : " ";
    lines.push(`  ${marker} ${file.path.padEnd(30)} ${file.sourceSpace.padEnd(16)} ${status}`);
    if (status !== "clean/synced/clear") {
      lines.push(dim(`      base:   ${shortContent(file.baseContent)}`));
      lines.push(dim(`      local:  ${shortContent(file.content)}`));
      lines.push(dim(`      remote: ${shortContent(file.remoteContent)}`));
    }
  }
  lines.push("");

  lines.push(bold("Conflicts"));
  if (state.conflicts.length === 0) {
    lines.push(dim("  none"));
  } else {
    for (const conflict of state.conflicts) {
      lines.push(`  ${red(conflict.id)} ${conflict.kind} ${conflict.path} (${conflict.sourceSpace})`);
      lines.push(dim(`      resolve ${conflict.path} local|remote`));
    }
  }
  lines.push("");

  lines.push(bold("Automatic Snapshots"));
  for (const snapshot of state.snapshots.slice(-6)) {
    lines.push(`  ${snapshot.id.padEnd(9)} ${snapshot.kind.padEnd(7)} ${snapshot.note}`);
  }
  lines.push(dim(`  undo frames available: ${state.undoStack.length}`));
  lines.push("");

  lines.push(bold("Published Change Revisions"));
  if (state.publishedRevisions.length === 0) {
    lines.push(dim("  none — publish creates a Change Revision; it never writes canonical repositories"));
  } else {
    for (const revision of state.publishedRevisions) {
      lines.push(`  ${revision.id} ${revision.changeId} paths=${revision.changedPaths.join(", ")}`);
      for (const [space, snapshot] of Object.entries(revision.sourceSnapshots)) {
        lines.push(dim(`      ${space}: ${snapshot}`));
      }
    }
  }
  lines.push("");

  lines.push(bold("Last operation"));
  const lastOperation = state.operations.at(-1);
  lines.push(`  ${lastOperation?.id ?? "none"}: ${lastOperation?.kind ?? "none"}`);
  lines.push(`  ${state.lastError ? red(state.lastError) : state.lastMessage}`);
  lines.push("");
  lines.push(bold("Commands"));
  lines.push(`  ${bold("edit <path> <content>")}  edit a mounted file; an automatic Snapshot follows`);
  lines.push(`  ${bold("remote-edit <space> <path> <content>")}  simulate another commit outside this Workspace`);
  lines.push(`  ${bold("sync")}  reconcile remote Snapshots; divergent local/remote edits become Conflicts`);
  lines.push(`  ${bold("resolve <path> local|remote")}  explicitly resolve a Conflict`);
  lines.push(`  ${bold("undo")}  restore the previous local state by creating a new Snapshot`);
  lines.push(`  ${bold("publish")}  publish a Change Revision only when no Conflict remains`);
  lines.push(`  ${bold("check-mount <space> <mount>")}  test collision-free materialization`);
  lines.push(`  ${bold("reset")}  restart the in-memory scenario`);
  lines.push(`  ${bold("help")}  print examples; ${bold("q")}  quit`);

  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (escaped) word += "\\";
  if (word) words.push(word);
  return words;
}

function isSourceSpace(value: string | undefined): value is SourceSpaceName {
  return value === "community" || value === "commercial-core";
}

function parseAction(input: string): Action | "help" | "quit" | "state" | null {
  const [command, ...args] = shellWords(input);
  if (!command) return "state";
  if (command === "q" || command === "quit" || command === "exit") return "quit";
  if (command === "help" || command === "?") return "help";
  if (command === "state" || command === "status") return "state";
  if (command === "reset") return { type: "reset" };
  if (command === "undo") return { type: "undo" };
  if (command === "sync") return { type: "sync" };
  if (command === "publish") return { type: "publish" };
  if (command === "edit" && args.length >= 2) {
    return { type: "edit", path: args[0], content: args.slice(1).join(" ") };
  }
  if (command === "remote-edit" && args.length >= 3 && isSourceSpace(args[0])) {
    return {
      type: "remote-edit",
      sourceSpace: args[0],
      path: args[1],
      content: args.slice(2).join(" "),
    };
  }
  if (command === "resolve" && args.length === 2 && (args[1] === "local" || args[1] === "remote")) {
    return { type: "resolve", path: args[0], choice: args[1] };
  }
  if (command === "check-mount" && args.length === 2 && isSourceSpace(args[0])) {
    return { type: "check-mount", sourceSpace: args[0], mount: args[1] };
  }
  return null;
}

function printHelp(): void {
  process.stdout.write(`\nExamples:\n\n  edit src/player/index.ts "export function play(source: string) { return source.trim(); }"\n  undo\n  remote-edit community src/player/index.ts "export function play(source: string) { return source.toLowerCase(); }"\n  edit src/player/index.ts "export function play(source: string) { return source.trim(); }"\n  sync\n  resolve src/player/index.ts local\n  publish\n  check-mount commercial-core src/player\n\nQuoted content is treated as one argument. Every command re-renders the full state.\n`);
}

let state = createInitialState();
const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });

render(state);
readlineInterface.setPrompt("\nanyam prototype> ");
readlineInterface.prompt();
readlineInterface.on("line", (line) => {
  const parsed = parseAction(line);
  if (parsed === "quit") {
    readlineInterface.close();
    return;
  }
  if (parsed === "help") {
    printHelp();
    render(state);
  } else if (parsed === "state") {
    render(state);
  } else if (parsed) {
    state = reduce(state, parsed);
    render(state);
  } else {
    state = reduce(state, {
      type: "invalid",
      message: "Unknown or malformed command. Type help to see the available actions.",
    });
    render(state);
  }
  readlineInterface.prompt();
});
readlineInterface.on("close", () => process.stdout.write("\nPrototype ended.\n"));
