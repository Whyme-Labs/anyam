import { proposedManifest, runLocalCheck, scaffoldProject, startChange, type ProjectTemplateKind } from "./scaffold.js";
import { gitCredentialGet, LocalAgentManager, readGitCredentialContext, runMcpStdio, setupAgent } from "./agent.js";
import { loginAnyam } from "./auth.js";
import { connectGitHubActions } from "./github-actions-bridge.js";
import { realmDestroy, realmDoctor, realmExport, realmInstall, realmPlan, realmRestore, realmUpgrade } from "./realm.js";
import type { WorkspaceBoundaryMode } from "./workspace-boundary.js";
import type { Readable } from "node:stream";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  return values;
}

function requiredValue(args: readonly string[], flag: string, command: string): string {
  const value = valueAfter(args, flag);
  if (!value) throw new Error(`${command} requires ${flag} <value>; no credential flow was started.`);
  return value;
}

function kindFrom(args: readonly string[]): ProjectTemplateKind {
  const value = valueAfter(args, "--type");
  if (!args.includes("--type") || value === "worker") return "worker";
  if (value === "library") return "library";
  throw new Error(`--type must be worker or library; asked=${value ?? "missing"}; fix the option and rerun anyam init.`);
}

function positionalArgs(args: readonly string[], command: string): readonly string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--type", "--name", "--agent", "--directory", "--mode", "--session", "--method", "--realm", "--project", "--connection", "--action-ref", "--workflow-path", "--remote", "--schedule", "--account", "--resource", "--domain", "--version", "--path", "--installation"]);
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
  const valueFlags = new Set(["--type", "--name", "--agent", "--directory", "--mode", "--session", "--method", "--realm", "--project", "--connection", "--action-ref", "--workflow-path", "--remote", "--schedule", "--account", "--resource", "--domain", "--version", "--path", "--installation"]);
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
  console.log("connect github --method actions  generate a reviewable GitHub Actions Bridge workflow");
  console.log("Bridge options: --realm <url> --project <id> --connection <id> --action-ref <owner/repo@sha> [--workflow-path <path>] [--remote <name>] [--schedule <cron>]");
  console.log("realm plan|install|upgrade|doctor|export|restore|destroy  customer-operated lifecycle");
  console.log("workspace start|list|inspect|exec  explicit concurrent local Workspace controls (use --session for selection)");
  console.log(`Anyam local CLI\n\nCommands:\n  init [directory]                 create a local TypeScript Project\n  doctor [directory]               inspect manifest and source metadata locally\n  check [directory]                compatibility alias for doctor\n  change start <title>             start a local Change\n  workspace list                   list all active local Workspaces\n  workspace inspect --session <id> inspect one explicit Workspace session\n  workspace exec --session <id> -- <command>  run in one existing Workspace\n  agent setup <agent>              configure the local MCP broker and instructions\n  agent start [agent]              start or resume an agent session\n  agent exec <agent> -- <command>  launch an agent through the Workspace boundary\n  agent handoff <agent>            revoke one selected session and start another\n  agent status [--session <id>]    inspect one selected or current session\n  agent revoke [--session <id>]    revoke one selected session\n  mcp serve --stdio                serve the semantic MCP tools over stdio\n  auth login --realm <url>         authenticate through OAuth PKCE and the OS keychain\n  auth revoke                      revoke the current local session\n  git-credential-anyam get         issue a context-bound memory-only Workspace Git credential\n\nOptions:\n  --type worker|library             choose the template (default: worker)\n  --name <name>                     choose the Project name\n  --agent codex|claude|cursor|cli   choose the local coding agent\n  --mode enforceable|supervised     choose the Workspace boundary mode\n  --session <id>                    select one explicit local Workspace/session\n  --directory <path>               choose a Project directory\n  --json                            print machine-readable output\n  --dry-run                         print the proposed manifest without writing\n\nThe local broker never stores bearer credentials, writes canonical Git refs, reads secret values, approves Changes, or promotes production.`);
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

async function runGitCredentialHelper(action: string | undefined, cwd: string, input: Readable): Promise<number> {
  const context = await readGitCredentialContext(input);
  if (action !== "get") {
    process.stderr.write(`git-credential-anyam only supports get; requested=${action ?? "missing"}; host=${context.host}; path=${context.path}\n`);
    return 1;
  }
  const result = await gitCredentialGet({ directory: cwd, agent: "cli", context });
  process.stdout.write(`username=${result.username}\npassword=${result.password}\n\n`);
  return 0;
}

export async function main(args: readonly string[], cwd = process.cwd(), input: Readable = process.stdin): Promise<number> {
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
    else console.log(`${result.status === "created" ? "Created" : "Already initialized"} local Project at ${result.directory}\nNext: cd ${result.directory} && npx create-anyam doctor && npm run typecheck && npm test && npm run build && npx create-anyam change start "Describe the next Change"`);
    return 0;
  }

  if (command === "check" || command === "doctor") {
    const directory = positionalArgs(args, command)[0] ?? cwd;
    const result = await runLocalCheck(directory);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const receipt of result.receipts) console.log(`PASS ${receipt.name}: ${receipt.receipt}`);
      for (const item of result.blockers) console.error(`BLOCKED ${item.code}: ${item.message}`);
      console.log(result.status === "passed" ? "Project doctor passed." : "Project doctor blocked; fix the named receipt and rerun anyam doctor.");
    }
    return result.status === "passed" ? 0 : 1;
  }

  if (command === "realm") {
    const directory = valueAfter(args, "--directory") ?? cwd;
    const installationId = valueAfter(args, "--installation") ?? `installation:local:${directory.replaceAll(/[^A-Za-z0-9._-]+/gu, "-")}`;
    const resources = valuesAfter(args, "--resource").length > 0 ? valuesAfter(args, "--resource") : (process.env.ANYAM_REALM_RESOURCES ?? "d1,r2,queues,workflows").split(",").map((value) => value.trim()).filter(Boolean);
    const domains = valuesAfter(args, "--domain");
    const desiredVersion = valueAfter(args, "--version") ?? "0.0.0";
    const result = subcommand === "plan"
      ? realmPlan({ directory, installationId, accountId: requiredValue(args, "--account", "realm plan"), resources, ...(domains.length > 0 ? { domains } : {}) })
      : subcommand === "install"
        ? await realmInstall({ directory, installationId, accountId: requiredValue(args, "--account", "realm install"), resources, ...(domains.length > 0 ? { domains } : {}), desiredVersion })
        : subcommand === "upgrade"
          ? await realmUpgrade({ directory, desiredVersion })
          : subcommand === "doctor"
            ? await realmDoctor(directory)
            : subcommand === "export"
              ? await realmExport(directory, requiredValue(args, "--path", "realm export"))
              : subcommand === "restore"
                ? await realmRestore(directory, requiredValue(args, "--path", "realm restore"))
                : subcommand === "destroy"
                  ? await realmDestroy(directory)
                  : (() => { throw new Error("realm requires plan, install, upgrade, doctor, export, restore, or destroy"); })();
    printResult(result, json, `${result.status.toUpperCase()} ${result.operation}: ${result.receipt}\nRecovery: ${result.recoveryAction}`);
    return result.status === "blocked" ? 1 : 0;
  }

  if (command === "connect" && subcommand === "github") {
    const method = valueAfter(args, "--method");
    if (method !== "actions") throw new Error(`connect github currently requires --method actions; asked=${method ?? "missing"}; no workflow was written.`);
    const workflowPath = valueAfter(args, "--workflow-path");
    const remoteName = valueAfter(args, "--remote");
    const outboundSchedule = valueAfter(args, "--schedule");
    const result = await connectGitHubActions({
      directory: valueAfter(args, "--directory") ?? cwd,
      realm: requiredValue(args, "--realm", "connect github"),
      project: requiredValue(args, "--project", "connect github"),
      connection: requiredValue(args, "--connection", "connect github"),
      actionRef: requiredValue(args, "--action-ref", "connect github"),
      ...(workflowPath ? { workflowPath } : {}),
      ...(remoteName ? { remoteName } : {}),
      ...(outboundSchedule ? { outboundSchedule } : {}),
      ...(args.includes("--dry-run") ? { dryRun: true } : {}),
    });
    printResult(result, json, result.status === "blocked"
      ? `BLOCKED ${result.code}: ${result.message}\nRecovery: ${result.recoveryAction}\n${result.receipt}`
      : `${result.status === "created" ? "Created" : result.status === "planned" ? "Planned" : "Already present"} ${result.workflowPath} for ${result.repository.owner}/${result.repository.name}.\nNo GitHub credential, token, private key, or push was used.\nNext: review and commit the workflow through your normal GitHub process.\n${result.receipt}`);
    return result.status === "blocked" ? 1 : 0;
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

  if (command === "workspace" && subcommand === "list") {
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).listSessions();
    printResult(result, json, result.length === 0 ? "No active local Workspaces." : result.map((workspace) => `${workspace.session.id} · ${workspace.session.agent} · ${workspace.session.changeId} · ${workspace.session.workspaceId}`).join("\n"));
    return 0;
  }

  if (command === "workspace" && subcommand === "start") {
    const agent = agentValue(args, "cli");
    const mode = valueAfter(args, "--mode") as WorkspaceBoundaryMode | undefined;
    if (mode && mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).startSession({ agent, parallel: true, ...(mode ? { mode } : {}) });
    printResult(result, json, `Workspace ${result.session.workspaceId} started for ${result.session.agent}.\nSession: ${result.session.id}\nChange: ${result.session.changeId}\nCanonical write: denied`);
    return 0;
  }

  if (command === "workspace" && subcommand === "inspect") {
    const sessionId = requiredValue(args, "--session", "workspace inspect");
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).inspectSession(sessionId);
    if (!result) throw new Error(`Workspace session ${sessionId} is not active; run anyam workspace list and select an active session.`);
    printResult(result, json, `${result.session.id} · ${result.session.agent} · ${result.session.changeId} · ${result.session.workspaceId}\nCredentials: ${result.activeCredentialCount}`);
    return 0;
  }

  if (command === "workspace" && subcommand === "exec") {
    const sessionId = requiredValue(args, "--session", "workspace exec");
    const separator = args.indexOf("--");
    const executable = separator >= 0 ? args[separator + 1] : undefined;
    if (!executable) throw new Error("workspace exec requires --session <id> -- <command> [args...]; no process was started.");
    const mode = (valueAfter(args, "--mode") ?? "enforceable") as WorkspaceBoundaryMode;
    if (mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const result = await new LocalAgentManager({ directory: valueAfter(args, "--directory") ?? cwd }).launchAgent({ sessionId, command: executable, args: args.slice(separator + 2), mode });
    printResult(result, json, `Workspace process ${result.command.status} in ${result.boundary.mode} Workspace (${result.boundary.enforcement}).\nWorkspace: ${result.boundary.workspaceDirectory}\nReceipt: ${result.command.receipt}`);
    return result.command.status === "passed" ? 0 : 1;
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
    const mode = valueAfter(args, "--mode") as WorkspaceBoundaryMode | undefined;
    if (mode && mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).startSession({ agent, ...(mode ? { mode } : {}) });
    printResult(result, json, `Agent session ${result.session.id} active for ${result.session.agent}.\nWorkspace: ${result.session.workspaceId}\nGrant: ${result.grant.id}\nCanonical write: denied`);
    return 0;
  }

  if (command === "agent" && subcommand === "exec") {
    const agent = agentValue(args);
    if (!agent) throw new Error("agent exec requires an agent; run anyam agent exec <codex|claude|cursor|cli> -- <command>.");
    const separator = args.indexOf("--");
    const executable = separator >= 0 ? args[separator + 1] : undefined;
    if (!executable) throw new Error("agent exec requires `-- <command> [args...]`; no process was started.");
    const mode = (valueAfter(args, "--mode") ?? "enforceable") as WorkspaceBoundaryMode;
    if (mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const directory = valueAfter(args, "--directory") ?? cwd;
    const result = await new LocalAgentManager({ directory }).launchAgent({ agent, command: executable, args: args.slice(separator + 2), mode });
    printResult(result, json, `Agent process ${result.command.status} in ${result.boundary.mode} Workspace (${result.boundary.enforcement}).\nWorkspace: ${result.boundary.workspaceDirectory}\nReceipt: ${result.command.receipt}`);
    return result.command.status === "passed" ? 0 : 1;
  }

  if (command === "agent" && subcommand === "handoff") {
    const agent = agentValue(args);
    if (!agent) throw new Error("agent handoff requires an agent; run anyam agent handoff <codex|claude|cursor|cli>.");
    const sessionId = valueAfter(args, "--session");
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).handoff({ agent, ...(sessionId ? { sessionId } : {}) });
    printResult(result, json, `Handoff complete. Previous session: ${result.previousSessionId ?? "none"}\nNew session: ${result.next.session.id} (${result.next.session.agent})\nPrior credentials are revoked.`);
    return 0;
  }

  if (command === "agent" && subcommand === "status") {
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).status(valueAfter(args, "--session"));
    printResult(result, json, result.session ? `Active ${result.session.agent} session ${result.session.id}\nWorkspace: ${result.session.workspaceId}\nCredentials: ${result.activeCredentialCount}\nAudit events: ${result.auditCount}` : "No active local agent session.");
    return 0;
  }

  if ((command === "agent" && subcommand === "revoke") || (command === "auth" && subcommand === "revoke")) {
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).revoke(positionalArgs(args, subcommand ?? "revoke")[0]);
    printResult(result, json, result.status === "revoked" ? `Revoked agent session ${result.sessionId} and Grant ${result.grantId}.` : "No local agent session was active.");
    return 0;
  }

  if (command === "auth" && subcommand === "login") {
    const scope = valueAfter(args, "--scope");
    const resource = valueAfter(args, "--resource");
    const result = await loginAnyam({
      realm: requiredValue(args, "--realm", "auth login"),
      clientId: requiredValue(args, "--client-id", "auth login"),
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
    });
    printResult(result, json, `Authenticated to ${result.realm} through OAuth PKCE.\nCredential storage: OS keychain only.\n${result.receipt}`);
    return 0;
  }

  if (command === "mcp" && subcommand === "serve") {
    if (!args.includes("--stdio")) throw new Error("mcp serve currently requires --stdio; use anyam mcp serve --stdio --agent <agent>.");
    const agent = agentValue(args, "cli");
    await runMcpStdio({ directory: valueAfter(args, "--directory") ?? cwd, agent, input: process.stdin, output: process.stdout });
    return 0;
  }

  if (command === "git-credential-anyam") {
    return runGitCredentialHelper(subcommand, cwd, input);
  }

  printHelp();
  return 1;
}
