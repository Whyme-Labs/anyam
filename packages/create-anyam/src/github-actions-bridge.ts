import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { trustedGitArgs, trustedGitEnvironment } from "./trusted-git.js";

const execFile = promisify(execFileCallback);
const DEFAULT_WORKFLOW_PATH = ".github/workflows/anyam-bridge.yml";
const CHECKOUT_ACTION_REF = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const PINNED_ACTION_REF = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[0-9a-f]{40,64}$/u;

export type GitHubRepositoryIdentity = {
  owner: string;
  name: string;
  remote: string;
};

export type GitHubActionsBridgeWorkflowInput = {
  realm: string;
  project: string;
  connection: string;
  actionRef: string;
  repository: Pick<GitHubRepositoryIdentity, "owner" | "name">;
  branch: string;
  workflowPath?: string;
  outboundSchedule?: string;
};

export type GitHubActionsConnectInput = {
  directory: string;
  realm: string;
  project: string;
  connection: string;
  actionRef: string;
  workflowPath?: string;
  remoteName?: string;
  outboundSchedule?: string;
  dryRun?: boolean;
};

type GitHubActionsConnectBase = {
  directory: string;
  repository: GitHubRepositoryIdentity;
  branch: string;
  workflowPath: string;
  workflow: string;
  contentDigest: string;
  receipt: string;
};

export type GitHubActionsConnectResult =
  | (GitHubActionsConnectBase & { status: "created" | "unchanged" | "planned" })
  | { status: "blocked"; code: string; message: string; recoveryAction: string; receipt: string };

class GitHubActionsBridgeCliError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "GitHubActionsBridgeCliError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function blocked(error: GitHubActionsBridgeCliError): GitHubActionsConnectResult {
  return { status: "blocked", code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt };
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/u.test(value)) throw new GitHubActionsBridgeCliError({ code: "input_invalid", message: `${field} must be a non-empty single-line value.`, recoveryAction: `provide a valid ${field} and rerun anyam connect github --method actions`, receipt: `${field}=required; workflow=not-written` });
  return value.trim();
}

function realmUrl(value: unknown): string {
  const text = required(value, "realm");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new GitHubActionsBridgeCliError({ code: "realm_invalid", message: `Realm ${text} is not a valid URL.`, recoveryAction: "provide the deployed customer Realm HTTPS URL", receipt: "realm=url-invalid; workflow=not-written" });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new GitHubActionsBridgeCliError({ code: "realm_invalid", message: "The GitHub Actions Bridge Realm must be an HTTPS URL without credentials or query state.", recoveryAction: "provide the customer Realm origin, for example https://source.acme.com", receipt: `realm=${parsed.origin}; https=true-required; workflow=not-written` });
  return parsed.origin;
}

function yaml(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function workflowPath(value: string | undefined): string {
  const path = value === undefined ? DEFAULT_WORKFLOW_PATH : required(value, "workflowPath");
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".") || !/^\.github\/workflows\/[A-Za-z0-9._-]+\.(?:yml|yaml)$/u.test(path)) throw new GitHubActionsBridgeCliError({ code: "workflow_path_invalid", message: `Workflow path ${path} is not a safe .github/workflows YAML path.`, recoveryAction: "use a repository-relative .github/workflows/*.yml or *.yaml path", receipt: `workflowPath=${path}; safe=false; workflow=not-written` });
  return path;
}

function actionRef(value: unknown): string {
  const ref = required(value, "actionRef");
  if (!PINNED_ACTION_REF.test(ref)) throw new GitHubActionsBridgeCliError({ code: "action_ref_unpinned", message: `Bridge action ${ref} is not pinned to an immutable commit SHA.`, recoveryAction: "provide an owner/repository[/path]@40-to-64-hex-commit reference; mutable tags are not accepted", receipt: `actionRef=${ref}; immutable=false; workflow=not-written` });
  return ref;
}

function branchName(value: string): string {
  const branch = required(value, "branch");
  if (branch.startsWith("-") || branch.includes("..") || branch.includes("@") || branch.includes(" ") || branch.startsWith("/") || branch.endsWith("/")) throw new GitHubActionsBridgeCliError({ code: "branch_invalid", message: `Branch ${branch} is not safe for a generated workflow trigger.`, recoveryAction: "use a normal Git branch name such as main or release/v1", receipt: `branch=${branch}; safe=false; workflow=not-written` });
  return branch;
}

function repositoryPath(value: string): { owner: string; name: string } | undefined {
  const normalized = value.trim().replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) return undefined;
  const owner = parts[0];
  const name = parts[1];
  if (!owner || !name) return undefined;
  return { owner, name };
}

export function parseGitHubRemote(remote: string): Pick<GitHubRepositoryIdentity, "owner" | "name"> | undefined {
  const value = remote.trim();
  const scp = /^git@github\.com:(.+)$/u.exec(value)?.[1];
  if (scp) return repositoryPath(scp);
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== "github.com" || (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")) return undefined;
    return repositoryPath(parsed.pathname);
  } catch {
    return undefined;
  }
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile("git", trustedGitArgs(args), { cwd: directory, encoding: "utf8", env: trustedGitEnvironment() });
    return result.stdout.trim();
  } catch {
    throw new GitHubActionsBridgeCliError({ code: "git_command_failed", message: `Git could not inspect ${directory}; no workflow was written.`, recoveryAction: "run the command inside a Git checkout with a readable remote and branch", receipt: `git=${args[0] ?? "command"}; workflow=not-written` });
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function schedule(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = required(value, "outboundSchedule");
  if (text.length > 120) throw new GitHubActionsBridgeCliError({ code: "schedule_invalid", message: "The outbound schedule is too long to place in the generated workflow.", recoveryAction: "provide a concise cron expression or omit the schedule and use workflow_dispatch", receipt: "outboundSchedule=too-long; workflow=not-written" });
  return text;
}

export function generateGitHubActionsBridgeWorkflow(input: GitHubActionsBridgeWorkflowInput): string {
  const realm = realmUrl(input.realm);
  const project = required(input.project, "project");
  const connection = required(input.connection, "connection");
  const action = actionRef(input.actionRef);
  const owner = required(input.repository.owner, "repository.owner");
  const name = required(input.repository.name, "repository.name");
  const branch = branchName(input.branch);
  const path = workflowPath(input.workflowPath);
  const outbound = schedule(input.outboundSchedule);
  const scheduleBlock = outbound === undefined ? "" : `  schedule:\n    - cron: ${yaml(outbound)}\n`;
  return `name: Anyam Bridge

on:
  push:
    branches:
      - ${yaml(branch)}
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
${scheduleBlock}  workflow_dispatch:

# The Realm binds this workflow path and SHA through GitHub OIDC. Do not use
# pull_request_target or replace the pinned bridge action with a mutable tag.
permissions: {}

jobs:
  inbound:
    if: github.event_name == 'push' || github.event_name == 'pull_request'
    permissions:
      id-token: write
      contents: read
      pull-requests: read
    steps:
      - uses: ${CHECKOUT_ACTION_REF}
      - uses: ${action}
        with:
          direction: inbound
          realm: ${yaml(realm)}
          project: ${yaml(project)}
          connection: ${yaml(connection)}
          repository: ${yaml(`${owner}/${name}`)}
          workflow: ${yaml(path)}

  outbound:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    permissions:
      id-token: write
      contents: write
    steps:
      - uses: ${action}
        with:
          direction: outbound
          realm: ${yaml(realm)}
          project: ${yaml(project)}
          connection: ${yaml(connection)}
          repository: ${yaml(`${owner}/${name}`)}
          workflow: ${yaml(path)}
`;
}

export async function connectGitHubActions(input: GitHubActionsConnectInput): Promise<GitHubActionsConnectResult> {
  try {
    const directory = resolve(required(input.directory, "directory"));
    const remoteName = input.remoteName === undefined ? "origin" : required(input.remoteName, "remoteName");
    const remote = await git(directory, ["config", "--get", `remote.${remoteName}.url`]);
    const parsed = parseGitHubRemote(remote);
    if (!parsed) return { status: "blocked", code: "remote_provider_unsupported", message: `Remote ${remote} is not a GitHub repository; no workflow was written.`, recoveryAction: "set the selected Git remote to github.com/OWNER/REPOSITORY or choose a different integration method", receipt: `remoteProvider=github; observed=false; workflow=not-written` };
    const branch = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const path = workflowPath(input.workflowPath);
    const workflow = generateGitHubActionsBridgeWorkflow({ ...input, repository: parsed, branch, workflowPath: path });
    const contentDigest = digest(workflow);
    const destination = join(directory, path);
    let existing: string | undefined;
    try {
      await access(destination, constants.F_OK);
      existing = await readFile(destination, "utf8");
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const base = { directory, repository: { ...parsed, remote }, branch, workflowPath: path, workflow, contentDigest, receipt: `provider=github-actions; repository=${parsed.owner}/${parsed.name}; branch=${branch}; workflowPath=${path}; contentDigest=${contentDigest}; credentials=none; push=not-performed` };
    if (existing !== undefined && existing !== workflow) return { status: "blocked", code: "workflow_exists", message: `Workflow ${path} already exists with different content; it was not overwritten.`, recoveryAction: "review the existing workflow, remove it intentionally, or choose another workflow path before rerunning", receipt: `${base.receipt}; existing=conflict; workflow=not-written` };
    if (existing === workflow) return { status: "unchanged", ...base, receipt: `${base.receipt}; status=unchanged; write=not-performed` };
    if (input.dryRun === true) return { status: "planned", ...base, receipt: `${base.receipt}; status=planned; write=not-performed` };
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, workflow, "utf8");
    return { status: "created", ...base, receipt: `${base.receipt}; status=created; gitCommit=not-performed; gitPush=not-performed` };
  } catch (error) {
    if (error instanceof GitHubActionsBridgeCliError) return blocked(error);
    return { status: "blocked", code: "connect_failed", message: "The GitHub Actions Bridge workflow was not generated.", recoveryAction: "inspect the local Git checkout and rerun the same command without changing existing workflow state", receipt: "workflow=not-written; credentials=none" };
  }
}
