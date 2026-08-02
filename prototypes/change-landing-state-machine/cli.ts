/**
 * THROWAWAY PROTOTYPE — thin terminal shell for model.ts.
 *
 * Run with:
 *   node --experimental-strip-types prototypes/change-landing-state-machine/cli.ts
 */

import readline from "node:readline";
import { createInitialState, reduce } from "./model.ts";
import type { Action, State } from "./model.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const red = (value: string) => `\x1b[31m${value}\x1b[0m`;
const yellow = (value: string) => `\x1b[33m${value}\x1b[0m`;
const green = (value: string) => `\x1b[32m${value}\x1b[0m`;

function render(state: State): void {
  const lines: string[] = [];
  lines.push(bold("ANYAM — CHANGE / LANDING STATE MACHINE"));
  lines.push(dim("THROWAWAY LOGIC PROTOTYPE — state is in memory; no production code is used."));
  lines.push("");
  lines.push(`${bold("Question")}: ${state.question}`);
  lines.push(`${bold("Project")}: ${state.project.name}`);
  lines.push(`${bold("Canonical Project Revision")}: ${state.project.canonical.id}`);
  lines.push(dim(`  parent=${state.project.canonical.parentId ?? "none"} landed=${state.project.canonical.landedChangeIds.join(", ") || "none"}`));
  for (const [space, snapshot] of Object.entries(state.project.canonical.snapshots)) {
    lines.push(dim(`  ${space}: ${snapshot}`));
  }
  lines.push("");

  lines.push(bold("Intents and stable Changes"));
  const changes = Object.values(state.changes);
  if (changes.length === 0) lines.push(dim("  none"));
  for (const change of changes) {
    const intent = state.intents[change.intentId];
    const latest = change.latestRevisionId ? state.revisions[change.latestRevisionId] : null;
    const status = change.status === "landed" ? green(change.status) : change.status === "needs-changes" ? red(change.status) : change.status;
    lines.push(`  ${change.id.padEnd(24)} ${status.padEnd(20)} approvals=${change.approvals.join(",") || "none"}`);
    lines.push(dim(`    intent=${intent.title} workspace=${change.workspaceId ?? "none"} latest=${latest?.id ?? "none"}`));
    for (const revisionId of change.revisionIds) {
      const revision = state.revisions[revisionId];
      lines.push(dim(`      ${revision.id} kind=${revision.kind} base=${revision.baseProjectRevision} state=${revision.state} effects=${revision.effects.join(",")}`));
    }
  }
  lines.push("");

  lines.push(bold("Workspaces and claims"));
  for (const workspace of Object.values(state.workspaces)) {
    lines.push(`  ${workspace.id} change=${workspace.changeId} actor=${workspace.actor} base=${workspace.baseProjectRevision}`);
    const claims = state.claims.filter((claim) => claim.changeId === workspace.changeId && claim.active);
    for (const claim of claims) lines.push(dim(`    ${claim.id} ${claim.actor} claims ${claim.scope}`));
  }
  if (Object.values(state.workspaces).length === 0) lines.push(dim("  none"));
  lines.push("");

  lines.push(bold("Integration Cohorts"));
  if (Object.values(state.cohorts).length === 0) lines.push(dim("  none"));
  for (const cohort of Object.values(state.cohorts)) {
    const status = cohort.status === "landed" ? green(cohort.status) : cohort.status === "blocked" ? red(cohort.status) : cohort.status;
    lines.push(`  ${cohort.id} ${status} base=${cohort.baseProjectRevision} changes=${cohort.changeIds.join(",")}`);
    lines.push(dim(`    revisions=${cohort.revisionIds.join(",")} landed=${cohort.landedProjectRevisionId ?? "none"}`));
    for (const conflictId of cohort.conflictIds) {
      const conflict = state.conflicts[conflictId];
      const marker = conflict.blocking && !conflict.resolved ? red("BLOCK") : yellow("WARN");
      lines.push(`    ${marker} ${conflict.id} ${conflict.kind}: ${conflict.message}`);
    }
  }
  lines.push("");

  lines.push(bold("Reviews"));
  if (state.reviews.length === 0) lines.push(dim("  none"));
  for (const review of state.reviews) lines.push(`  ${review.id} ${review.changeId} ${review.reviewer} ${review.decision} at ${review.revisionId}`);
  lines.push("");

  lines.push(bold("Last operation"));
  const operation = state.operations.at(-1);
  lines.push(`  ${operation?.id ?? "none"}: ${operation?.kind ?? "none"}`);
  lines.push(`  ${state.lastError ? red(state.lastError) : state.lastMessage}`);
  lines.push("");
  lines.push(bold("Commands"));
  lines.push(`  ${bold("intent <change> <title>")}  create an Intent and stable Change`);
  lines.push(`  ${bold("workspace <change> <actor>")}  create an isolated Workspace from canonical state`);
  lines.push(`  ${bold("claim <change> <actor> <scope>")}  add a soft scope claim`);
  lines.push(`  ${bold("revise <change> <actor> <effect,...>")}  publish an immutable Change Revision`);
  lines.push(`  ${bold("review <change> <reviewer> approve|changes")}  record review for latest revision`);
  lines.push(`  ${bold("cohort <change,...>")}  compose revisions and detect conflicts`);
  lines.push(`  ${bold("land <cohort>")}  atomically advance canonical Project Revision if policy allows`);
  lines.push(`  ${bold("rebase <change> <actor>")}  create a new revision on current canonical state`);
  lines.push(`  ${bold("revert <landed-change> <actor>")}  create a new revert Change; history is untouched`);
  lines.push(`  ${bold("reset")}  restart the in-memory scenario; ${bold("help")}  examples; ${bold("q")}  quit`);
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
    if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else word += character;
  }
  if (escaped) word += "\\";
  if (word) words.push(word);
  return words;
}

function parseAction(input: string): Action | "help" | "quit" | "state" | null {
  const [command, ...args] = shellWords(input);
  if (!command || command === "state" || command === "status") return "state";
  if (command === "q" || command === "quit" || command === "exit") return "quit";
  if (command === "help" || command === "?") return "help";
  if (command === "reset") return { type: "reset" };
  if (command === "intent" && args.length >= 2) return { type: "intent", changeId: args[0], title: args.slice(1).join(" ") };
  if (command === "workspace" && args.length === 2) return { type: "workspace", changeId: args[0], actor: args[1] };
  if (command === "claim" && args.length >= 3) return { type: "claim", changeId: args[0], actor: args[1], scope: args.slice(2).join(" ") };
  if (command === "revise" && args.length === 3) return { type: "revise", changeId: args[0], actor: args[1], effects: args[2].split(",").filter(Boolean) };
  if (command === "review" && args.length === 3 && (args[2] === "approve" || args[2] === "changes")) return { type: "review", changeId: args[0], reviewer: args[1], decision: args[2] === "approve" ? "approved" : "changes-requested" };
  if (command === "cohort" && args.length === 1) return { type: "cohort", changeIds: args[0].split(",").filter(Boolean) };
  if (command === "land" && args.length === 1) return { type: "land", cohortId: args[0] };
  if (command === "rebase" && args.length === 2) return { type: "rebase", changeId: args[0], actor: args[1] };
  if (command === "revert" && args.length === 2) return { type: "revert", changeId: args[0], actor: args[1] };
  return null;
}

function printHelp(): void {
  process.stdout.write(`\nExample concurrency walk:\n\n  intent change-player "Add player controls"\n  workspace change-player alice\n  claim change-player alice src/player\n  intent change-codec "Improve codec"\n  workspace change-codec bob\n  claim change-codec bob src/player\n  revise change-player alice community:player\n  revise change-codec bob community:player\n  review change-player reviewer-a approve\n  review change-codec reviewer-b approve\n  cohort change-player,change-codec\n  cohort change-player\n  land cohort-02\n  cohort change-codec\n  land cohort-03\n  rebase change-codec bob\n  review change-codec reviewer-b approve\n  cohort change-codec\n  land cohort-04\n  revert change-player alice\n  review change-revert-change-player reviewer-c approve\n  cohort change-revert-change-player\n  land cohort-05\n\nA claim overlap is a warning; stale bases and effect overlaps block Landing.\n`);
}

let state = createInitialState();
const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
render(state);
readlineInterface.setPrompt("\nanyam state prototype> ");
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
  } else {
    state = reduce(state, parsed ?? { type: "invalid", message: "Unknown or malformed command. Type help." });
    render(state);
  }
  readlineInterface.prompt();
});
readlineInterface.on("close", () => process.stdout.write("\nPrototype ended.\n"));
