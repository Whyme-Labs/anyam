import { proposedManifest, runLocalCheck, scaffoldProject, startChange, type ProjectTemplateKind } from "./scaffold.js";
import { gitCredentialGet, LocalAgentManager, runMcpStdio, setupAgent } from "./agent.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function kindFrom(args: readonly string[]): ProjectTemplateKind {
  const value = valueAfter(args, "--type");
  if (!args.includes("--type") || value === "worker") return "worker";
  if (value === "library") return "library";
  throw new Error(`--type must be worker or library; asked=${value ?? "missing"}; fix the option and rerun anyam init.`);
}

function positionalArgs(args: readonly string[], command: string): readonly string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--type", "--name", "--agent", "--directory"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") && argument !== command) values.push(argument);
  }
  return values;
}

function subcommandPositionals(args: readonly string[]): readonly string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--type", "--name", "--agent", "--directory"]);
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) values.push(argument);
  }
  return values;
}

function printHelp(): void {
  console.log(`Anyam local CLI\n\nCommands:\n  init [directory]                 create a local TypeScript Project\n  check [directory]                inspect manifest and source locally\n  change start <title>             start a local Change\n  agent setup <agent>              configure the local MCP broker and instructions\n  agent start [agent]              start or resume a local agent session\n  agent handoff <agent>            revoke the current session and start another\n  agent status                     inspect the current local session\n  agent revoke                     revoke the current local session\n  mcp serve --stdio                serve the semantic MCP tools over stdio\n  auth revoke                      revoke the current local session\n  git-credential-anyam get         issue a memory-only Workspace Git credential\n\nOptions:\n  --type worker|library             choose the template (default: worker)\n  --name <name>                     choose the Project name\n  --agent codex|claude|cursor|cli   choose the local coding agent\n  --directory <path>               choose a Project directory\n  --json                            print machine-readable output\n  --dry-run                         print the proposed manifest without writing\n\nThe local broker never stores bearer credentials, writes canonical Git refs, reads secret values, approves Changes, or promotes production.`);
}

function agentValue(args: readonly string[], fallback?: string): string {
  return valueAfter(args, "--agent") ?? subcommandPositionals(args)[0] ?? fallback ?? "";
}

function agentDirectory(args: readonly string[], cwd: string): string {
  return valueAfter(args, "--directory") ?? subcommandPositionals(args)[1] ?? cwd;
}

function printResult(result: unknown, json: boolean, human: string): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(human);
}

async function runGitCredentialHelper(action: string | undefined, cwd: string): Promise<number> {
  if (action !== "get") return 0;
  const result = await gitCredentialGet({ directory: cwd, agent: "cli" });
  process.stdout.write(`username=${result.username}\npassword=${result.password}\n\n`);
  return 0;
}

export async function main(args: readonly string[], cwd = process.cwd()): Promise<number> {
  const [command, subcommand] = args;
  const json = args.includes("--json");
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const directory = positionalArgs(args, "init")[0] ?? cwd;
    const name = valueAfter(args, "--name");
    if (args.includes("--name") && !name) throw new Error("--name requires a Project name; fix the option and rerun anyam init.");
    const scaffoldInput = {
      directory,
      kind: kindFrom(args),
      ...(name ? { name } : {}),
    };
    if (args.includes("--dry-run")) {
      const result = proposedManifest(scaffoldInput);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const result = await scaffoldProject({
      ...scaffoldInput,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.status === "created" ? "Created" : "Already initialized"} local Project at ${result.directory}\nNext: cd ${result.directory} && npx create-anyam check && npx create-anyam change start "Describe the next Change"`);
    return 0;
  }

  if (command === "check") {
    const directory = positionalArgs(args, "check")[0] ?? cwd;
    const result = await runLocalCheck(directory);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const receipt of result.receipts) console.log(`PASS ${receipt.name}: ${receipt.receipt}`);
      for (const item of result.blockers) console.error(`BLOCKED ${item.code}: ${item.message}`);
      console.log(result.status === "passed" ? "Local check passed." : "Local check blocked; fix the named receipt and rerun anyam check.");
    }
    return result.status === "passed" ? 0 : 1;
  }

  if (command === "change" && subcommand === "start") {
    const title = positionalArgs(args, "start").join(" ");
    const changeDirectory = valueAfter(args, "--directory") ?? cwd;
    const result = await startChange(changeDirectory, title);
    const requestedAgent = valueAfter(args, "--agent");
    const session = requestedAgent ? await new LocalAgentManager({ directory: changeDirectory }).startSession({ agent: requestedAgent }) : undefined;
    printResult({ ...result, ...(session ? { agentSession: session } : {}) }, json, `${result.status === "created" ? "Started" : "Using existing"} Change ${result.changeId}: ${result.title}\n${session ? `Agent session ${session.session.id} active for ${session.session.agent}.` : "Local only: no Realm or remote credentials were used."}`);
    return 0;
  }

  if (command === "agent" && subcommand === "setup") {
    const agent = agentValue(args, "cli");
    const setupPositionals = subcommandPositionals(args);
    const directory = valueAfter(args, "--directory") ?? setupPositionals[1] ?? cwd;
    const result = await setupAgent({ directory, agent });
    printResult(result, json, `${result.agent} agent setup is ready in ${result.directory}.\nBroker: anyam mcp serve --stdio --agent ${result.agent}\nCredentials: memory-only; canonical write: denied\n${result.files.length > 0 ? `Created:\n${result.files.map((file) => `  ${file}`).join("\n")}` : "No files changed."}`);
    return 0;
  }

  if (command === "agent" && subcommand === "start") {
    const agent = agentValue(args, "cli");
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).startSession({ agent });
    printResult(result, json, `Agent session ${result.session.id} active for ${result.session.agent}.\nWorkspace: ${result.session.workspaceId}\nGrant: ${result.grant.id}\nCanonical write: denied`);
    return 0;
  }

  if (command === "agent" && subcommand === "handoff") {
    const agent = agentValue(args);
    if (!agent) throw new Error("agent handoff requires an agent; run anyam agent handoff <codex|claude|cursor|cli>.");
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).handoff({ agent });
    printResult(result, json, `Handoff complete. Previous session: ${result.previousSessionId ?? "none"}\nNew session: ${result.next.session.id} (${result.next.session.agent})\nPrior credentials are revoked.`);
    return 0;
  }

  if (command === "agent" && subcommand === "status") {
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).status();
    printResult(result, json, result.session ? `Active ${result.session.agent} session ${result.session.id}\nWorkspace: ${result.session.workspaceId}\nCredentials: ${result.activeCredentialCount}\nAudit events: ${result.auditCount}` : "No active local agent session.");
    return 0;
  }

  if ((command === "agent" && subcommand === "revoke") || (command === "auth" && subcommand === "revoke")) {
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).revoke(positionalArgs(args, subcommand ?? "revoke")[0]);
    printResult(result, json, result.status === "revoked" ? `Revoked agent session ${result.sessionId} and Grant ${result.grantId}.` : "No local agent session was active.");
    return 0;
  }

  if (command === "mcp" && subcommand === "serve") {
    if (!args.includes("--stdio")) throw new Error("mcp serve currently requires --stdio; use anyam mcp serve --stdio --agent <agent>.");
    const agent = agentValue(args, "cli");
    await runMcpStdio({ directory: valueAfter(args, "--directory") ?? cwd, agent, input: process.stdin, output: process.stdout });
    return 0;
  }

  if (command === "git-credential-anyam") {
    return runGitCredentialHelper(subcommand, cwd);
  }

  printHelp();
  return 1;
}
