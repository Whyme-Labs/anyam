import { env } from "node:process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Git options for broker-side inspection; repository-controlled hooks/config must not execute. */
export const TRUSTED_GIT_OPTIONS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  "-c", "core.sshCommand=false",
] as const;

export function trustedGitArgs(args: readonly string[]): readonly string[] {
  return [...TRUSTED_GIT_OPTIONS, ...args];
}

export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  delete safeEnvironment.GIT_CONFIG_COUNT;
  delete safeEnvironment.GIT_CONFIG_PARAMETERS;
  delete safeEnvironment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete safeEnvironment.GIT_OBJECT_DIRECTORY;
  return safeEnvironment;
}

export type TrustedGitMetadata = {
  directory: string;
  indexFile: string;
  receipt: string;
  cleanup: () => Promise<void>;
};

async function copyRegularTree(sourcePath: string, destinationPath: string): Promise<number> {
  const entry = await lstat(sourcePath);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`trusted Git metadata contains a non-regular entry: ${sourcePath}`);
  if (entry.isDirectory()) {
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    let copied = 0;
    for (const child of await readdir(sourcePath)) copied += await copyRegularTree(join(sourcePath, child), join(destinationPath, child));
    return copied;
  }
  await copyFile(sourcePath, destinationPath);
  return 1;
}

/**
 * Freeze an agent-controlled `.git` directory into an inaccessible temporary
 * copy and rebuild a clean index. Trusted Git can then inspect the agent's
 * committed state without executing or trusting mutable config, hooks, refs,
 * or index flags in the live Workspace.
 */
export async function createTrustedGitMetadata(worktreeDirectory: string): Promise<TrustedGitMetadata> {
  const sourceMetadata = join(worktreeDirectory, ".git");
  const sourceStat = await lstat(sourceMetadata);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`trusted Git metadata requires a regular .git directory: ${sourceMetadata}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "anyam-trusted-git-"));
  const metadataDirectory = join(temporaryRoot, ".git");
  try {
    const copiedEntries = await copyRegularTree(sourceMetadata, metadataDirectory);
    // The metadata copy is for object/ref/index inspection only. Never carry
    // repository-local config or hooks into a trusted subprocess; command-line
    // options are the only policy source at this boundary.
    await rm(join(metadataDirectory, "config"), { force: true });
    await rm(join(metadataDirectory, "config.worktree"), { force: true });
    await rm(join(metadataDirectory, "hooks"), { recursive: true, force: true });
    const indexFile = join(temporaryRoot, "index.clean");
    const environment = trustedGitEnvironment();
    environment.GIT_DIR = metadataDirectory;
    environment.GIT_WORK_TREE = worktreeDirectory;
    environment.GIT_INDEX_FILE = indexFile;
    await execFile("git", trustedGitArgs(["read-tree", "HEAD"]), { cwd: worktreeDirectory, encoding: "utf8", env: environment });
    return {
      directory: metadataDirectory,
      indexFile,
      receipt: `trustedGitMetadata=isolated-copy; source=.git; copiedEntries=${copiedEntries}; localConfig=discarded; hooks=discarded; index=rebuilt; replaceRefs=disabled; cleanup=required`,
      cleanup: async () => { await rm(temporaryRoot, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
