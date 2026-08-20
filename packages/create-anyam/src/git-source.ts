import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFile = promisify(execFileCallback);

const GIT_OID = /^[0-9a-f]{40,64}$/;
const SOURCE_METADATA_EXCLUDES = [":(exclude).anyam/**"] as const;

export type LocalGitSourceState = {
  repositoryId: string;
  repositoryIdentityBasis: "manifest" | "root-lineage";
  repositoryIdentityReceipt: string;
  repositoryRoot: string;
  objectFormat: "sha1" | "sha256";
  commitId: string;
  treeId: string;
  gitRef: string;
  changedPaths: readonly string[];
  clean: boolean;
};

export class LocalGitSourceError extends Error {
  readonly code: "git.metadata_missing" | "git.revision_missing" | "git.command_failed";
  readonly directory: string;
  readonly recoveryAction: string;

  constructor(input: {
    code: LocalGitSourceError["code"];
    message: string;
    directory: string;
    recoveryAction: string;
  }) {
    super(input.message);
    this.name = "LocalGitSourceError";
    this.code = input.code;
    this.directory = input.directory;
    this.recoveryAction = input.recoveryAction;
  }
}

function digestIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oid(value: string, field: string, directory: string): string {
  const trimmed = value.trim();
  if (!GIT_OID.test(trimmed)) {
    throw new LocalGitSourceError({
      code: "git.command_failed",
      message: `Git returned an invalid ${field} for ${directory}; asked=Git object identity; received=${trimmed || "empty"}.`,
      directory,
      recoveryAction: "verify the repository metadata and rerun the Change operation",
    });
  }
  return trimmed;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(directory, args)).trim();
}

async function gitRaw(directory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile("git", [...args], { cwd: directory, encoding: "utf8" });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalGitSourceError({
      code: "git.command_failed",
      message: `Git ${args[0] ?? "command"} could not inspect ${directory}; ${detail}.`,
      directory,
      recoveryAction: "verify Git is installed, the workspace exists, and its metadata is readable",
    });
  }
}

async function optionalGit(directory: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(directory, args);
  } catch {
    return null;
  }
}

async function manifestRepositoryId(repositoryRoot: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(repositoryRoot, "anyam.json"), "utf8")) as { repositoryId?: unknown };
    if (typeof value.repositoryId !== "string" || !/^repository:[A-Za-z0-9._:-]+$/u.test(value.repositoryId.trim())) return undefined;
    return value.repositoryId.trim();
  } catch {
    return undefined;
  }
}

async function rootLineage(directory: string): Promise<readonly string[]> {
  const roots = (await git(directory, ["rev-list", "--max-parents=0", "--all"]))
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => oid(value, "root commit id", directory));
  if (roots.length === 0) throw new LocalGitSourceError({ code: "git.revision_missing", message: `Git repository ${directory} has no root commit; a stable Repository identity cannot be derived.`, directory, recoveryAction: "create a committed Git baseline before starting a Change" });
  return [...new Set(roots)].sort();
}

function statusPaths(value: string): string[] {
  const records = value.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const path = record.length >= 4 ? record.slice(3) : "";
    if (path) paths.push(path);
    const status = record.slice(0, 2);
    if ((status.startsWith("R") || status.startsWith("C")) && records[index + 1]) {
      paths.push(records[index + 1]!);
      index += 1;
    }
  }
  return paths;
}

export async function inspectGitSource(directoryInput: string): Promise<LocalGitSourceState> {
  const directory = resolve(directoryInput);
  let repositoryRoot: string;
  try {
    repositoryRoot = resolve(await git(directory, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (error instanceof LocalGitSourceError) {
      throw new LocalGitSourceError({
        code: "git.metadata_missing",
        message: `Git metadata is unavailable for ${directory}; no source revision was inspected.`,
        directory,
        recoveryAction: "run git init or open the agent in a Git workspace before publishing a Change Revision",
      });
    }
    throw error;
  }

  let commitId: string;
  try {
    commitId = oid(await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]), "commit id", directory);
  } catch (error) {
    if (error instanceof LocalGitSourceError) {
      throw new LocalGitSourceError({
        code: "git.revision_missing",
        message: `Git repository ${repositoryRoot} has no committed HEAD; a Change Revision cannot be called Git-bound.`,
        directory,
        recoveryAction: "create a Git commit for the workspace baseline, then start or rebase the Change before publishing",
      });
    }
    throw error;
  }

  const treeId = oid(await git(directory, ["rev-parse", "--verify", "HEAD^{tree}"]), "tree id", directory);
  const objectFormat = (await optionalGit(directory, ["rev-parse", "--show-object-format=storage"])) === "sha256" ? "sha256" : "sha1";
  const gitRef = (await optionalGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || "HEAD";
  const status = await gitRaw(directory, ["status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ".", ...SOURCE_METADATA_EXCLUDES]);
  const changedPaths = statusPaths(status);
  const manifestId = await manifestRepositoryId(repositoryRoot);
  const roots = manifestId ? [] : await rootLineage(directory);
  const repositoryId = manifestId
    ? `git-repository:v2:${manifestId}`
    : `git-repository:v2:sha256:${digestIdentity(JSON.stringify({ objectFormat, roots }))}`;
  const repositoryIdentityBasis = manifestId ? "manifest" : "root-lineage";

  return {
    repositoryId,
    repositoryIdentityBasis,
    repositoryIdentityReceipt: manifestId
      ? `identity=v2; basis=manifest; repositoryId=${repositoryId}; pathIndependent=true`
      : `identity=v2; basis=root-lineage; roots=${roots.length}; objectFormat=${objectFormat}; pathIndependent=true`,
    repositoryRoot,
    objectFormat,
    commitId,
    treeId,
    gitRef: gitRef === "HEAD" ? "HEAD" : `refs/heads/${gitRef}`,
    changedPaths,
    clean: changedPaths.length === 0,
  };
}

export async function isGitAncestor(directoryInput: string, baseCommit: string, currentCommit: string): Promise<boolean> {
  const directory = resolve(directoryInput);
  if (!GIT_OID.test(baseCommit) || !GIT_OID.test(currentCommit)) return false;
  try {
    await execFile("git", ["merge-base", "--is-ancestor", baseCommit, currentCommit], { cwd: directory, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export function gitProjectRevisionId(commitId: string): string {
  if (!GIT_OID.test(commitId)) throw new Error(`Invalid Git commit id: ${commitId}`);
  return `git:project-revision:${commitId}`;
}

export function gitCommitIdentity(commitId: string): string {
  if (!GIT_OID.test(commitId)) throw new Error(`Invalid Git commit id: ${commitId}`);
  return `git:commit:${commitId}`;
}

export function gitTreeIdentity(treeId: string): string {
  if (!GIT_OID.test(treeId)) throw new Error(`Invalid Git tree id: ${treeId}`);
  return `git-tree:${treeId}`;
}
