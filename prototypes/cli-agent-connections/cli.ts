/** THROWAWAY PROTOTYPE — a terminal shell for the pure model in model.ts. */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  demoActions,
  initialState,
  reduce,
  type Action,
  type AgentName,
  type State,
} from "./model.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const green = (value: string) => `\x1b[32m${value}\x1b[0m`;
const red = (value: string) => `\x1b[31m${value}\x1b[0m`;

const agents: AgentName[] = ["codex", "claude", "cursor", "cli"];

function render(state: State, clear = true): void {
  if (clear && output.isTTY) output.write("\x1b[2J\x1b[H");

  console.log(bold("ANYAM CLI / GIT / MCP / AGENT CONNECTION PROTOTYPE"));
  console.log(dim("THROWAWAY — validates credential and session boundaries; no real credentials are used."));
  console.log();

  console.log(bold("Context"));
  console.log(`  Realm:        ${state.realm}`);
  console.log(`  Repository:   ${state.repository}`);
  console.log(`  Project View: ${state.view}`);
  console.log();

  console.log(bold("Authentication"));
  console.log(`  Principal:          ${state.auth.principal}`);
  console.log(`  Browser session:    ${state.auth.browserSession}`);
  console.log(`  API credential:     ${state.auth.accessToken}`);
  console.log(`  Refresh credential: ${state.auth.refreshToken}`);
  console.log(`  Auth epoch:         ${state.auth.authorizationEpoch}`);
  console.log();

  console.log(bold("Git data plane"));
  console.log(`  Cloned:             ${state.git.cloned}`);
  console.log(`  Helper:             ${state.git.helper}`);
  console.log(`  Credential:         ${state.git.credentialStatus}`);
  console.log(`  Audience:           ${state.git.credentialAudience ?? "none"}`);
  console.log(`  Canonical write:    ${state.git.canonicalWrite}`);
  console.log();

  console.log(bold("Agent setup"));
  if (state.setups.length === 0) {
    console.log("  none");
  } else {
    for (const setup of state.setups) {
      console.log(`  ${setup.agent}: ${setup.transport} via ${setup.configPath} (${setup.credentialSource})`);
    }
  }
  console.log();

  console.log(bold("Change"));
  console.log(`  ID / intent:        ${state.change.id} / ${state.change.intent}`);
  console.log(`  Status:              ${state.change.status}`);
  console.log(`  Workspace:           ${state.change.workspace}`);
  console.log(`  Base revision:       ${state.change.baseRevision}`);
  console.log(`  Latest revision:     ${state.change.latestRevision}`);
  console.log(`  Revision count:      ${state.change.revisionCount}`);
  console.log(`  Active agent:        ${state.change.activeAgent ?? "none"}`);
  console.log();

  console.log(bold("Sessions and grants"));
  if (state.change.sessions.length === 0) {
    console.log("  none");
  } else {
    for (const session of state.change.sessions) {
      console.log(`  ${session.id}: ${session.agent} / ${session.status}`);
      console.log(`    MCP audience:      ${session.mcpAudience}`);
      console.log(`    Git audience:      ${session.gitAudience}`);
      console.log(`    Grant:             ${session.grant}`);
      console.log(`    Canonical write:   ${session.canonicalWrite}`);
    }
  }
  console.log();

  console.log(bold("Security invariants visible in this prototype"));
  console.log("  - refresh credential is represented only as an OS-keychain reference");
  console.log("  - MCP and Git audiences are separate");
  console.log("  - Workspace Git credentials never grant canonical write");
  console.log("  - handoff revokes the old session before creating the next grant");
  console.log("  - revocation increments the authorization epoch");
  console.log();

  if (state.lastError) console.log(`${red("Blocked:")} ${state.lastError}\n`);

  console.log(bold("Event timeline"));
  if (state.events.length === 0) {
    console.log("  none");
  } else {
    for (const item of state.events) {
      const marker = item.result === "ok" ? green("ok") : red("blocked");
      console.log(`  ${String(item.step).padStart(2, "0")} ${marker} ${item.action}: ${item.message}`);
    }
  }
  console.log();

  console.log(bold("Commands"));
  console.log(dim("  login | clone | setup <codex|claude|cursor|cli> | launch <agent>"));
  console.log(dim("  publish | expire-git | reauth | handoff <agent> | revoke | demo | reset | quit"));
}

function parse(line: string): Action | "help" | "demo" | "quit" | undefined {
  const [command, argument] = line.trim().split(/\s+/, 2);
  if (!command) return undefined;
  if (command === "help") return "help";
  if (command === "demo") return "demo";
  if (command === "quit" || command === "q" || command === "exit") return "quit";
  if (command === "login") return { type: "login" };
  if (command === "clone") return { type: "clone" };
  if (command === "publish") return { type: "publish" };
  if (command === "expire-git") return { type: "expire-git" };
  if (command === "reauth") return { type: "reauth" };
  if (command === "revoke") return { type: "revoke" };
  if (command === "reset") return { type: "reset" };
  if (command === "setup-agent" || command === "setup") {
    if (agents.includes(argument as AgentName)) return { type: "setup-agent", agent: argument as AgentName };
  }
  if (command === "launch") {
    if (agents.includes(argument as AgentName)) return { type: "launch", agent: argument as AgentName };
  }
  if (command === "handoff") {
    if (agents.includes(argument as AgentName)) return { type: "handoff", agent: argument as AgentName };
  }
  return undefined;
}

function help(): void {
  console.log("\nTry: login → clone → setup codex → launch codex → publish");
  console.log("Then: setup claude → handoff claude → expire-git → publish → reauth → publish → revoke");
}

function runDemo(): void {
  let state = initialState();
  render(state, false);
  for (const action of demoActions()) {
    state = reduce(state, action);
    render(state, false);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    runDemo();
    return;
  }

  let state = initialState();
  render(state);
  const rl = readline.createInterface({ input, output, prompt: "\nanyam> " });
  rl.prompt();

  for await (const line of rl) {
    const parsed = parse(line);
    if (parsed === "quit") break;
    if (parsed === "help") {
      help();
    } else if (parsed === "demo") {
      runDemo();
    } else if (parsed) {
      state = reduce(state, parsed);
      render(state);
    } else {
      console.log("Unknown command. Type help.");
    }
    rl.prompt();
  }
  rl.close();
}

await main();
