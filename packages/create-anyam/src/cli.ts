import { proposedManifest, runLocalCheck, scaffoldProject, startChange, type ProjectTemplateKind } from "./scaffold.js";
import { gitCredentialGet, LocalAgentManager, readGitCredentialContext, runMcpStdio, setupAgent, type AgentLaunchResult } from "./agent.js";
import { loginAnyam, logoutAnyam } from "./auth.js";
import { connectGitHubActions } from "./github-actions-bridge.js";
import { realmDestroy, realmDoctor, realmExport, realmInstall, realmPlan, realmRestore, realmUpgrade } from "./realm.js";
import { randomUUID } from "node:crypto";
import { RealmAuthorityHttpClient } from "./realm-authority-client.js";
import { parseWorkspaceResourceLimits, type WorkspaceBoundaryMode, type WorkspaceResourceLimits } from "./workspace-boundary.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { runRealmSourceCommand } from "./realm-source-command.js";
import { executeThroughWorkspaceBroker, removeWorkspaceBrokerLocator, startWorkspaceCommandBroker } from "./workspace-broker.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function disclosedAgentLaunch(result: AgentLaunchResult) {
  // The trusted runtime retains this environment; CLI output must not copy
  // ambient host credentials from the supervised boundary into a receipt.
  const { environment, ...boundary } = result.boundary;
  return { ...result, boundary };
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

async function resourcePolicyOptions(args: readonly string[], cwd: string): Promise<{ resourceLimits?: WorkspaceResourceLimits }> {
  if (!args.includes("--resource-policy")) return {};
  const path = valueAfter(args, "--resource-policy");
  if (!path?.trim() || path.startsWith("--") || args.filter(value => value === "--resource-policy").length !== 1) throw new Error("--resource-policy requires one explicit JSON file; no session or process was started.");
  const source = await readFile(resolve(cwd, path), "utf8");
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new Error("--resource-policy must contain valid JSON; no session or process was started."); }
  return { resourceLimits: parseWorkspaceResourceLimits(value) };
}

function kindFrom(args: readonly string[]): ProjectTemplateKind {
  const value = valueAfter(args, "--type");
  if (!args.includes("--type") || value === "worker") return "worker";
  if (value === "library") return "library";
  throw new Error(`--type must be worker or library; asked=${value ?? "missing"}; fix the option and rerun anyam init.`);
}

function positionalArgs(args: readonly string[], command: string): readonly string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--resource-policy", "--allow-path", "--allow-action", "--type", "--name", "--agent", "--directory", "--mode", "--session", "--method", "--realm", "--project", "--change", "--connection", "--action-ref", "--workflow-path", "--remote", "--schedule", "--account", "--resource", "--domain", "--version", "--path", "--installation", "--owner-session", "--idempotency-key", "--title", "--description", "--body", "--assignee", "--disclosure", "--label", "--pull-request", "--head-ref", "--base-ref", "--head-commit", "--base-commit", "--provider", "--external-key", "--remote-repository", "--review-state", "--review-digest", "--revision"]);
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
  const valueFlags = new Set(["--resource-policy", "--allow-path", "--allow-action", "--type", "--name", "--agent", "--directory", "--mode", "--session", "--method", "--realm", "--project", "--change", "--connection", "--action-ref", "--workflow-path", "--remote", "--schedule", "--account", "--resource", "--domain", "--version", "--path", "--installation", "--owner-session", "--idempotency-key", "--title", "--description", "--body", "--assignee", "--disclosure", "--label", "--pull-request", "--head-ref", "--base-ref", "--head-commit", "--base-commit", "--provider", "--external-key", "--remote-repository", "--review-state", "--review-digest", "--revision"]);
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
  console.log("realm project|workspace|change|revision|run inspect --realm <url> --id <id> --session-stdin [--json]  disclosed hosted reads");
  console.log("realm run detail --realm <url> --id <run-id> --session-stdin [--json]  accepted signed detail for a current Realm owner");
  console.log("realm workspace create|change create|revision publish|run request --realm <url> --input <json-file> --idempotency-key <key> --session-stdin [--json]  disclosed hosted writes");
  console.log("intent list|inspect|create|assign|comment|close|reopen  hosted Realm Intent lifecycle (--realm, --owner-session or ANYAM_OWNER_SESSION)");
  console.log("pr list|inspect|open|update|review|close|reopen|block|merge  hosted Pull Request compatibility projection (--realm, --owner-session or ANYAM_OWNER_SESSION)");
  console.log("workspace start|list|inspect|exec  explicit concurrent local Workspace controls (use --session for selection)");
  console.log("--resource-policy <json-file>  measured Linux limits and receipt for workspace start, agent start|exec, or fresh mcp serve; requires enforceable Linux execution");
  console.log(`Anyam local CLI\n\nCommands:\n  init [directory]                 create a local TypeScript Project\n  doctor [directory]               inspect manifest and source metadata locally\n  check [directory]                compatibility alias for doctor\n  change start <title>             start a local Change\n  workspace list                   list all active local Workspaces\n  workspace inspect --session <id> inspect one explicit Workspace session\n  workspace exec --session <id> -- <command>  run in one existing Workspace\n  agent setup <agent>              configure the local MCP broker and instructions\n  agent start [agent]              start or resume an agent session\n  agent exec <agent> -- <command>  launch an agent through the Workspace boundary\n  agent handoff <agent>            revoke one selected session and start another\n  agent status [--session <id>]    inspect one selected or current session\n  agent revoke [--session <id>]    revoke one selected session\n  mcp serve --stdio                serve the semantic MCP tools over stdio\n  auth login --realm <url>         authenticate through OAuth PKCE and the OS keychain\n  auth logout --realm <url>        remove the Realm OAuth credential from the OS keychain\n  auth revoke                      revoke the current local session\n  git-credential-anyam get         issue a context-bound memory-only Workspace Git credential\n\nOptions:\n  --type worker|library             choose the template (default: worker)\n  --name <name>                     choose the Project name\n  --agent codex|claude|cursor|cli   choose the local coding agent\n  --mode enforceable|supervised     choose the Workspace boundary mode\n  --session <id>                    select one explicit local Workspace/session\n  --directory <path>               choose a Project directory\n  --json                            print machine-readable output\n  --dry-run                         print the proposed manifest without writing\n\nThe local broker never stores bearer credentials, writes canonical Git refs, reads secret values, approves Changes, or promotes production.`);
}

function intentClient(args: readonly string[]): RealmAuthorityHttpClient {
  const realm = requiredValue(args, "--realm", "intent");
  const ownerSession = valueAfter(args, "--owner-session") ?? process.env.ANYAM_OWNER_SESSION;
  if (!ownerSession?.trim()) throw new Error("intent requires --owner-session or ANYAM_OWNER_SESSION; no credential was read from disk");
  return new RealmAuthorityHttpClient({ baseUrl: realm, ownerSession });
}

function intentIdentifier(args: readonly string[]): string {
  const id = valueAfter(args, "--id") ?? subcommandPositionals(args)[0];
  if (!id?.trim()) throw new Error("intent requires an Intent ID as a positional argument or --id");
  return id.trim();
}

function intentIdempotency(args: readonly string[], operation: string, id: string): string {
  return valueAfter(args, "--idempotency-key") ?? `cli:intent:${operation}:${id}:${randomUUID()}`;
}

function pullRequestIdentifier(args: readonly string[]): string {
  const id = valueAfter(args, "--pull-request") ?? valueAfter(args, "--id") ?? subcommandPositionals(args)[0];
  if (!id?.trim()) throw new Error("pr requires a Pull Request ID as a positional argument, --pull-request, or --id");
  return id.trim();
}

function pullRequestIdempotency(args: readonly string[], operation: string, id: string): string {
  return valueAfter(args, "--idempotency-key") ?? `cli:pull-request:${operation}:${id}:${randomUUID()}`;
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

export async function main(inputArgs: readonly string[], cwd = process.cwd(), input: Readable = process.stdin): Promise<number> {
  const [command, subcommand] = inputArgs;
  const separator = inputArgs.indexOf("--");
  const executionCommand = (command === "agent" || command === "workspace") && subcommand === "exec";
  const args = executionCommand && separator >= 0 ? inputArgs.slice(0, separator) : inputArgs;
  const executableArgs = executionCommand && separator >= 0 ? inputArgs.slice(separator + 1) : [];
  const json = args.includes("--json");
  if (args.includes("--resource-policy") && !((command === "agent" && (subcommand === "start" || subcommand === "exec")) || (command === "workspace" && subcommand === "start") || (command === "mcp" && subcommand === "serve"))) throw new Error("--resource-policy is a new-session option for workspace start, agent start|exec, or fresh mcp serve; no session was changed or process started.");
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
    if (["project", "workspace", "change", "revision", "run"].includes(subcommand ?? "")) {
      const result = await runRealmSourceCommand(args, input);
      printResult(result, json, JSON.stringify(result, null, 2));
      return 0;
    }
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

  if (command === "intent") {
    const client = intentClient(args);
    const operation = subcommand ?? "";
    const id = operation === "inspect" || operation === "assign" || operation === "comment" || operation === "close" || operation === "reopen" ? intentIdentifier(args) : "collection";
    const idempotencyKey = intentIdempotency(args, operation, id);
    const result = operation === "list"
      ? await client.listIntents(valueAfter(args, "--project"))
      : operation === "inspect"
        ? await client.inspectIntent(id)
        : operation === "create"
          ? await client.createIntent({ projectId: requiredValue(args, "--project", "intent create"), title: requiredValue(args, "--title", "intent create"), ...(valueAfter(args, "--id") ? { intentId: valueAfter(args, "--id") } : {}), ...(valueAfter(args, "--description") ? { description: valueAfter(args, "--description") } : {}), ...(valueAfter(args, "--disclosure") ? { disclosure: valueAfter(args, "--disclosure") } : {}), ...(valuesAfter(args, "--assignee").length > 0 ? { assigneePrincipalIds: valuesAfter(args, "--assignee") } : {}), ...(valuesAfter(args, "--label").length > 0 ? { labels: valuesAfter(args, "--label") } : {}) }, idempotencyKey)
          : operation === "assign"
            ? await client.assignIntent(id, { assigneePrincipalIds: valuesAfter(args, "--assignee") }, idempotencyKey)
            : operation === "comment"
              ? await client.commentIntent(id, { body: requiredValue(args, "--body", "intent comment"), ...(valueAfter(args, "--disclosure") ? { disclosure: valueAfter(args, "--disclosure") } : {}) }, idempotencyKey)
              : operation === "close"
                ? await client.closeIntent(id, idempotencyKey)
                : operation === "reopen"
                  ? await client.reopenIntent(id, idempotencyKey)
                  : (() => { throw new Error("intent requires list, inspect, create, assign, comment, close, or reopen"); })();
    printResult(result, json, `${operation.toUpperCase()} Intent: ${String(result.receipt ?? "receipt=not-returned")}`);
    return 0;
  }

  if (command === "pr" || command === "pull-request") {
    const client = intentClient(args);
    const operation = subcommand ?? "";
    const id = operation === "inspect" || operation === "update" || operation === "review" || operation === "close" || operation === "reopen" || operation === "block" || operation === "merge" ? pullRequestIdentifier(args) : "collection";
    const idempotencyKey = pullRequestIdempotency(args, operation, id);
    const result = operation === "list"
      ? await client.listPullRequests(valueAfter(args, "--project"))
      : operation === "inspect"
        ? await client.inspectPullRequest(id)
        : operation === "open"
          ? await client.openPullRequest({ projectId: requiredValue(args, "--project", "pr open"), changeId: requiredValue(args, "--change", "pr open"), pullRequestId: valueAfter(args, "--pull-request") ?? valueAfter(args, "--id"), provider: valueAfter(args, "--provider") ?? "local", headRef: requiredValue(args, "--head-ref", "pr open"), baseRef: requiredValue(args, "--base-ref", "pr open"), headCommit: requiredValue(args, "--head-commit", "pr open"), baseCommit: requiredValue(args, "--base-commit", "pr open"), title: requiredValue(args, "--title", "pr open"), ...(valueAfter(args, "--description") ? { description: valueAfter(args, "--description") } : {}), ...(valueAfter(args, "--disclosure") ? { disclosure: valueAfter(args, "--disclosure") } : {}), ...(valueAfter(args, "--external-key") ? { externalKey: valueAfter(args, "--external-key") } : {}), ...(valueAfter(args, "--remote-repository") ? { remoteRepository: valueAfter(args, "--remote-repository") } : {}), ...(valueAfter(args, "--revision") ? { revisionIds: [valueAfter(args, "--revision")] } : {}) }, idempotencyKey)
          : operation === "update"
            ? await client.updatePullRequest(id, { ...(valueAfter(args, "--head-ref") ? { headRef: valueAfter(args, "--head-ref") } : {}), ...(valueAfter(args, "--base-ref") ? { baseRef: valueAfter(args, "--base-ref") } : {}), ...(valueAfter(args, "--head-commit") ? { headCommit: valueAfter(args, "--head-commit") } : {}), ...(valueAfter(args, "--base-commit") ? { baseCommit: valueAfter(args, "--base-commit") } : {}), ...(valueAfter(args, "--title") ? { title: valueAfter(args, "--title") } : {}), ...(valueAfter(args, "--description") ? { description: valueAfter(args, "--description") } : {}), ...(valueAfter(args, "--revision") ? { revisionId: valueAfter(args, "--revision") } : {}) }, idempotencyKey)
            : operation === "review"
              ? await client.reviewPullRequest(id, { reviewState: requiredValue(args, "--review-state", "pr review"), reviewDigest: requiredValue(args, "--review-digest", "pr review") }, idempotencyKey)
              : operation === "close"
                ? await client.closePullRequest(id, idempotencyKey)
                : operation === "reopen"
                  ? await client.reopenPullRequest(id, idempotencyKey)
                  : operation === "block"
                    ? await client.blockPullRequest(id, idempotencyKey)
                    : operation === "merge"
                      ? await client.mergePullRequest(id, idempotencyKey)
                      : (() => { throw new Error("pr requires list, inspect, open, update, review, close, reopen, block, or merge"); })();
    printResult(result, json, `${operation.toUpperCase()} Pull Request: ${String(result.receipt ?? "receipt=not-returned")}`);
    return 0;
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
    const title = subcommandPositionals(args).join(" ");
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
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).startSession({ agent, parallel: true, ...(mode ? { mode } : {}), ...await resourcePolicyOptions(args, cwd) });
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
    const executable = executableArgs[0];
    if (!executable) throw new Error("workspace exec requires --session <id> -- <command> [args...]; no process was started.");
    const mode = valueAfter(args, "--mode") as WorkspaceBoundaryMode | undefined;
    if (mode !== undefined && mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const result = await executeThroughWorkspaceBroker({ manager: new LocalAgentManager({ directory: valueAfter(args, "--directory") ?? cwd }), sessionId, command: executable, args: executableArgs.slice(1), ...(mode ? { mode } : {}) });
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
    const result = await new LocalAgentManager({ directory: agentDirectory(args, cwd) }).startSession({ agent, ...(mode ? { mode } : {}), ...await resourcePolicyOptions(args, cwd) });
    printResult(result, json, `Agent session ${result.session.id} active for ${result.session.agent}.\nWorkspace: ${result.session.workspaceId}\nGrant: ${result.grant.id}\nCanonical write: denied`);
    return 0;
  }

  if (command === "agent" && subcommand === "exec") {
    const agent = agentValue(args);
    if (!agent) throw new Error("agent exec requires an agent; run anyam agent exec <codex|claude|cursor|cli> -- <command>.");
    const executable = executableArgs[0];
    if (!executable) throw new Error("agent exec requires `-- <command> [args...]`; no process was started.");
    const mode = (valueAfter(args, "--mode") ?? "enforceable") as WorkspaceBoundaryMode;
    if (mode !== "enforceable" && mode !== "supervised") throw new Error(`--mode must be enforceable or supervised; asked=${mode}.`);
    const directory = valueAfter(args, "--directory") ?? cwd;
    const result = await new LocalAgentManager({ directory }).launchAgent({ agent, command: executable, args: executableArgs.slice(1), mode, ...await resourcePolicyOptions(args, cwd) });
    printResult(disclosedAgentLaunch(result), json, `Agent process ${result.command.status} in ${result.boundary.mode} Workspace (${result.boundary.enforcement}).\nWorkspace: ${result.boundary.workspaceDirectory}\nReceipt: ${result.command.receipt}`);
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
    const selectedSession = valueAfter(args, "--session");
    if (args.includes("--session") && (!selectedSession?.trim() || selectedSession.startsWith("--"))) throw new Error("revoke --session requires an explicit session ID; no session was revoked.");
    const manager = new LocalAgentManager({ directory: valueAfter(args, "--directory") ?? cwd });
    const selected = selectedSession ?? subcommandPositionals(args)[0];
    const result = await manager.revoke(selected);
    if (result.status === "revoked") await removeWorkspaceBrokerLocator(manager.statePathname, result.sessionId);
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

  if (command === "auth" && subcommand === "logout") {
    const result = await logoutAnyam({ realm: requiredValue(args, "--realm", "auth logout") });
    printResult(result, json, `Logged out of ${result.realm}.\nCredential storage: OS keychain.\n${result.receipt}`);
    return 0;
  }

  if (command === "mcp" && subcommand === "serve") {
    if (!args.includes("--stdio")) throw new Error("mcp serve currently requires --stdio; use anyam mcp serve --stdio --agent <agent>.");
    for (let index = 0; index < args.length; index += 1) {
      if (["--session", "--mode", "--allow-path", "--allow-action"].includes(args[index] ?? "")) {
        const value = args[index + 1];
        if (!value?.trim() || value.startsWith("--")) throw new Error(`MCP ${args[index]} requires an explicit value; no session was selected or started.`);
      }
    }
    const agent = agentValue(args, "cli");
    const selectedSessionId = valueAfter(args, "--session");
    const mode = valueAfter(args, "--mode") ?? "supervised";
    if (mode !== "enforceable" && mode !== "supervised") throw new Error("MCP --mode must be enforceable or supervised.");
    const authorizedPaths = valuesAfter(args, "--allow-path");
    const authorizedActionIds = valuesAfter(args, "--allow-action");
    if (selectedSessionId && (valueAfter(args, "--mode") || authorizedPaths.length || authorizedActionIds.length || args.includes("--resource-policy"))) throw new Error("MCP --session cannot be combined with new-session scope options.");
    if (authorizedPaths.length && mode !== "enforceable") throw new Error("MCP path restrictions require --mode enforceable; supervised mode cannot claim source isolation.");
    const directory = valueAfter(args, "--directory") ?? cwd;
    const resourceOptions = await resourcePolicyOptions(args, cwd);
    const manager = new LocalAgentManager({ directory });
    const handoff: { current: Awaited<ReturnType<typeof startWorkspaceCommandBroker>> } = { current: undefined };
    try { await runMcpStdio({ directory, manager, agent, input: process.stdin, output: process.stdout,
      ...(selectedSessionId ? { sessionId: selectedSessionId } : { sessionOptions: { mode, ...resourceOptions, ...(authorizedPaths.length ? { authorizedPaths } : {}), ...(authorizedActionIds.length ? { authorizedActionIds } : {}) } }),
      onBound: async sessionId => { handoff.current = await startWorkspaceCommandBroker({ manager, sessionId, agent }); },
    }); } finally { await handoff.current?.close(); }
    return 0;
  }

  if (command === "git-credential-anyam") {
    return runGitCredentialHelper(subcommand, cwd, input);
  }

  printHelp();
  return 1;
}
